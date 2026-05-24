# Tool-loop substrate

## Motivation

The codebase has at least **three independently-maintained tool-call
retry loops**, each with its own corrective-prompt template, its own
retry budget, and its own failure-mode handling:

| Site | Function | Purpose |
|---|---|---|
| `agent/tasks/code-analyzer/execute-step.ts:219-276` | `callPerTask` | Per-task analyzer skill call: handles empty-tool-calls + isError, retries with correction |
| `agent/intent/select-scope.ts` | One-shot scope classifier with retry on schema violation | Tier classification |
| `agent/intent/classify-question.ts` | One-shot intent classifier with retry on schema violation | Question routing |

A fourth consumer is pending: the planner-discovery loop
(`plans/code-analyzer-planner-discovery-loop.md`) needs a multi-turn
loop with a typed termination signal — neither the existing analyzer
loop nor the one-shot classifiers fit its shape.

Today's situation:

- Each retry implementation reinvents the corrective-prompt format.
- Each implementation has its own subset of failure-mode handling
  (the analyzer's is most sophisticated; the classifiers' are
  minimal). Adding a new failure mode means touching N files.
- The planner-discovery loop cannot be cleanly built without a
  fourth ad-hoc implementation, OR adopting a shared substrate.

This plan defines the shared substrate.

## Scope

This plan covers **the multi-turn loop mechanics + termination
protocol**. It does NOT cover:

- Pre-dispatch validation / coercion of local-LLM tool calls. That
  is the dominant failure source and lives in a separate plan
  (`plans/tool-call-guard-layer.md`). The substrate's `dispatchTool`
  callback can wrap that guard at the call site; the substrate
  itself is provider-agnostic.
- Provider-side tool-call shape conversion. Each provider
  (`agent/providers/{anthropic,openai,gemini,mistral,ollama}.ts`)
  continues to own its wire-format adapter. The substrate consumes
  the normalized `LLMResponse.toolCalls` shape from
  `shared/types.ts`.
- Skill registry, dispatch implementation, or evidence
  summarization. Those continue to live in their current homes.

## Design

A single module `agent/tool-loop.ts` exposing one function and a
small type surface.

```ts
export async function runToolLoop<T = unknown>(
  input: ToolLoopInput<T>,
): Promise<ToolLoopResult<T>>;

export interface ToolLoopInput<T> {
  readonly provider:     LLMProvider;
  readonly messages:     LLMMessage[];
  readonly tools:        ToolDefinition[];
  /**
   * Caller-supplied dispatcher. The substrate passes the raw
   * ToolCall here; the caller decides how to execute it
   * (skill runner, in-process function, IPC roundtrip, etc.).
   * This is also the hook point for pre-dispatch guards
   * (see plans/tool-call-guard-layer.md).
   */
  readonly dispatchTool: (call: ToolCall) => Promise<ToolResult>;
  readonly policy:       ToolLoopPolicy<T>;
  /** Logger label for telemetry context. */
  readonly label?:       string;
}

export interface ToolLoopPolicy<T> {
  readonly maxTurns:     number;
  /**
   * 'auto'        -- model decides whether to use a tool
   * 'required'    -- model MUST use some tool (any in the catalog)
   * { name: '…' } -- model MUST use this SPECIFIC tool (strict on
   *                  cloud providers; best-effort on local Ollama
   *                  where compliance is per-model-family).
   * Used in escalation paths (force `submit_plan` on the final
   * turn; force-commit on degenerate-repeat) — see "Failure
   * recovery with specific-tool forcing" below.
   */
  readonly toolChoice:   'auto' | 'required' | { readonly name: string };
  readonly maxTokens?:   number;
  readonly temperature?: number;
  /**
   * Pseudo-tool the substrate intercepts as the loop's terminal
   * signal. When the model emits a tool-call with this name, the
   * substrate validates its input against `outputSchema` and
   * returns `{ kind: 'terminated', payload }` instead of
   * dispatching. Optional — flows that just want
   * call-and-collect (no typed terminal) omit this.
   */
  readonly terminationTool?: {
    readonly name:         string;
    readonly description:  string;
    readonly inputSchema:  Record<string, unknown>;
    readonly validate:     (input: unknown) => T | string;   // string = error message
  };
  /** Failure-mode handlers; all default to sensible behaviors. */
  readonly onEmptyToolCalls?:       'retry-with-correction' | 'terminate';
  readonly onUnknownTool?:          'feed-error-back' | 'terminate';
  readonly onDispatchError?:        'feed-error-back' | 'terminate';
  readonly onMixedTermination?:     'reject' | 'accept-termination-discard-others';
  readonly onSchemaViolation?:      'retry-with-correction' | 'terminate';
  /**
   * Dispatch policy: substrate is SERIAL by default — exactly one
   * tool dispatched per turn. If the model emits >1 tool in a
   * single turn, the batch is rejected and the model is retried
   * with a corrective prompt instructing it to emit one tool per
   * turn. Default: 'retry-with-correction'.
   */
  readonly onMultipleToolsPerTurn?: 'retry-with-correction' | 'terminate';
  /**
   * Stop the loop early if the model emits the same tool-call
   * (name + serialized args) twice in a row. Default true.
   * Prevents degenerate tight loops without bounding turn budget.
   */
  readonly stopOnDegenerateRepeat?: boolean;
}

export type ToolLoopResult<T> =
  | { kind: 'terminated';     payload: T;             turnCount: number; transcript: LLMMessage[] }
  | { kind: 'no-tools';       finalText: string;      turnCount: number; transcript: LLMMessage[] }
  | { kind: 'exhausted';      reason: string;         turnCount: number; transcript: LLMMessage[]; lastError?: string }
  | { kind: 'provider-error'; err:    Error;          turnCount: number; transcript: LLMMessage[] };
```

### Loop pseudocode

```
turnCount = 0
transcript = [...messages]

while turnCount < policy.maxTurns:
    response = await provider.complete(transcript, {
        tools:       [...tools, ...(terminationTool ? [terminationTool] : [])],
        toolChoice:  policy.toolChoice,
        maxTokens, temperature,
    })

    turnCount++
    transcript.push(toAssistantMessage(response))

    if response.toolCalls?.length:
        # Termination check first
        terminationCall = findTerminationCall(response.toolCalls, policy.terminationTool)
        if terminationCall:
            payload = policy.terminationTool.validate(terminationCall.input)
            if typeof payload === 'string':
                # schema violation
                applyHandler(policy.onSchemaViolation, transcript, /*errMsg=*/ payload)
                continue
            if response.toolCalls.length > 1:
                applyHandler(policy.onMixedTermination, transcript, terminationCall, response.toolCalls)
                if 'reject' -> continue (retry); if 'accept-termination-discard-others' -> proceed
            return { kind: 'terminated', payload, ... }

        # Regular dispatch path — SERIAL ONLY (one tool per turn)
        # If the model emitted more than one tool in this turn,
        # reject the whole batch and retry with a corrective prompt
        # ("emit exactly one tool per turn"). The substrate does NOT
        # silently pick the first tool — that would lose work the
        # model wanted to do.
        if response.toolCalls.length > 1:
            applyHandler(policy.onMultipleToolsPerTurn, transcript)
            continue   # retry with correction

        call = response.toolCalls[0]
        if !knownToolName(call.name):
            applyHandler(policy.onUnknownTool, ...)
            continue
        try:
            result = await dispatchTool(call)
        catch err:
            applyHandler(policy.onDispatchError, ...)
            continue
        transcript.push(toToolResultMessage([result]))

        if degenerateRepeat(call, lastTurn.toolCall):
            return { kind: 'exhausted', reason: 'degenerate-repeat', ... }

    else:
        # No tools requested
        if policy.toolChoice === 'required':
            applyHandler(policy.onEmptyToolCalls, transcript)
            continue
        return { kind: 'no-tools', finalText: response.text, ... }

return { kind: 'exhausted', reason: 'turn-cap', ... }
```

### Standard corrective-prompt templates

The substrate owns one template per failure mode. Each is a function
of the failure context; the resulting message is appended to the
transcript as a `user` turn before the next provider call.

| Failure mode | Template gist |
|---|---|
| Empty toolCalls when `required` | "Your previous response had no tool_use block. You MUST emit at least one tool call this turn." |
| Unknown tool name | "Your call to `<name>` failed: that tool is not in the catalog. Available tools: `<top-N suggestions by Levenshtein>`. Re-emit with a valid tool name." |
| Dispatch error | "Your call to `<name>` failed during execution: `<error>`. The tool exists but rejected your arguments. Re-emit with corrected arguments." |
| Schema violation on terminationTool | "Your `<terminationTool.name>` payload was rejected: `<validate-error>`. Re-emit with a payload matching the schema." |
| Mixed termination | "Do not combine `<terminationTool.name>` with other tool calls in the same turn. If you have more discovery to do, omit `<terminationTool.name>`. If you are ready to commit, emit ONLY `<terminationTool.name>`." |
| Multiple tools per turn | "Your previous turn emitted N tool calls (`<comma-separated-names>`). The substrate dispatches one tool per turn — emit exactly ONE tool_use this turn and you'll see its result before the next turn." |

The substrate emits the template; the caller does not need to format
corrective prose.

### Telemetry

One log shape per turn (`tool-loop:turn-complete`) and one per
terminal outcome (`tool-loop:complete`):

```json
{
  "module":          "tool-loop",
  "label":           "<caller-supplied label>",
  "turn":            3,
  "responseShape":   "tool-calls" | "termination" | "no-tools" | "error",
  "toolsCalled":     ["planner_list_subdir", "planner_describe_module"],
  "outcome":         "in-flight" | "terminated" | "exhausted" | "provider-error",
  "tokenUsage":      { "input": 1234, "output": 56 }
}
```

Aggregating these gives per-flow observability — which loops are
hitting their cap, which are terminating cleanly, which are
degenerating.

## Tool-choice across providers (specific-tool forcing)

The `toolChoice` policy field accepts `'auto' | 'required' | { name }`.
The third form forces a specific tool by name — useful in
escalation paths (force `submit_plan` on the final turn; force-
commit on degenerate-repeat retry) and for hardening the
mixed-termination retry into a guaranteed fix.

This requires plumbing across all cloud providers in a single
substrate-phase change. Adding it piecemeal would create capability
drift where the substrate's published failure-recovery semantics
work on some providers and not others. **All five providers ship
the specific-tool form together in Phase 1.**

| Provider | Native API surface | Adapter delta |
|---|---|---|
| Anthropic (`agent/providers/anthropic.ts`) | `{ type: 'tool', name: '...' }` | Extend `toAnthropicToolChoice()` (today at lines 379-390); ~5 lines |
| OpenAI (`agent/providers/openai.ts`) | `{ type: 'function', function: { name } }` | Shape rewrite in tool-choice mapper; ~10 lines |
| Mistral (`agent/providers/mistral.ts`) | `{ type: 'function', function: { name } }` | Same shape as OpenAI; ~10 lines |
| Gemini (`agent/providers/gemini.ts`) | `mode: 'ANY'` + `allowed_function_names: [name]` | Different shape; the `name` value is the single allowed function; ~10 lines |
| Ollama (`agent/providers/ollama.ts`) | Per-model — qwen ignores, devstral/mistral-family honor | Pass through the `tool_choice` field with the specific name; gated on the existing `wantsToolChoice` quirk check. Best-effort by family. ~10 lines + a per-family note in the quirks table |

Total: type widening + ~45 lines across 5 adapters. The shared-
types update lives in `shared/types.ts`:

```ts
type ToolChoice = 'auto' | 'required' | 'none' | { readonly name: string };
```

Semantic guarantees:
- **Cloud providers** (Anthropic, OpenAI, Mistral, Gemini): strict —
  the response MUST contain a tool-call to the named tool (or the
  provider raises an error / returns an empty tool-calls array,
  which the substrate handles as `onEmptyToolCalls`).
- **Ollama (local)**: best-effort — the API forwards the constraint
  but the local model may ignore it. The substrate treats a local
  failure to comply as a regular corrective-prompt cycle.

Substrate consumers should rely on the strict guarantee ONLY when
the active provider is cloud. For the substrate's planned consumers:
- `planner-discovery` (cloud) — can rely on strict
- `callPerTask` (local) — uses `'required'` not `{ name }`; no
  strict-guarantee dependency
- Classifiers (cloud) — can rely on strict if they want, though
  none of the v1 classifiers need it

## Phase breakdown

| Phase | Scope | Ship gate |
|---|---|---|
| **1a. `ToolChoice` widening + provider adapters** | Widen `ToolChoice` in `shared/types.ts` to `'auto' \| 'required' \| 'none' \| { name }`. Update all 5 providers (Anthropic, OpenAI, Mistral, Gemini, Ollama) per the table above. Cross-provider unit tests confirm each adapter maps the new form correctly. | All providers compile + pass adapter tests; no consumer change yet |
| **1b. Substrate skeleton + termination protocol** | `agent/tool-loop.ts` with the loop, default handlers, telemetry. Unit tests against a fake provider that scripts a sequence of canned `LLMResponse` shapes. All four `ToolLoopResult` kinds covered. Includes the specific-tool forcing path on escalation. | Fake-provider test matrix passes; substrate has no consumers yet |
| **2. Migrate `callPerTask` to substrate** | Rewrite `agent/tasks/code-analyzer/execute-step.ts` `callPerTask` as a thin wrapper over `runToolLoop` with `toolChoice: 'required'`, `maxTurns: 2`, no terminationTool, `dispatchTool` = current `executeTool`. Same outward contract; same retry budget; same corrective behavior. | Existing analyzer tests + integration tests pass unchanged; live run on a known-prompt produces equivalent output |
| **3. Migrate the classifiers (`select-scope`, `classify-question`)** | Each classifier becomes a `runToolLoop` call with `toolChoice: 'required'`, `maxTurns: 2`, `terminationTool` = the classifier's own typed-output tool. Ad-hoc retry loops deleted. | Classifier tests pass; live test against the question batches in the existing snapshot tests |
| **4. Aggregator telemetry script** | `scripts/audit-tool-loop.ts` reads a daemon log file and produces a per-flow report: turn counts, termination outcomes, degenerate-repeat hits, exhaustion rates. | Script runs against a sample log; output matches manual inspection |

The planner-discovery loop is a fifth consumer, but its plan is
separate (`plans/code-analyzer-planner-discovery-loop.md`) because
its prompt design, tool surface, and validation are analyzer-
specific concerns.

## Test coverage

| File | Coverage |
|---|---|
| `tool-loop.test.ts` (new) | All four `ToolLoopResult.kind` paths; each failure-mode handler (default + override); termination protocol (clean / schema-violation / mixed-batch); turn-cap exhaustion; degenerate-repeat detection; provider-error bubble-up. |
| `execute-step.test.ts` (extend) | After Phase 2: confirm equivalent behavior to the pre-migration path for the existing test cases. |
| `select-scope.test.ts`, `classify-question.test.ts` (extend) | After Phase 3: confirm equivalent behavior. |

## Out of scope

- **Pre-dispatch validation/coercion of tool calls.** Plan
  `plans/tool-call-guard-layer.md`. Wired at the call site by
  composing the guard into the `dispatchTool` callback the
  substrate consumes.
- **Provider-side tool-call wire-format adapters.** Continue to
  live in `agent/providers/*.ts`.
- **The planner-discovery flow.** Plan
  `plans/code-analyzer-planner-discovery-loop.md` consumes this
  substrate as its fifth migration target.
- **A general-purpose "agent" abstraction.** This is a typed loop
  with explicit termination, not a generic agent runtime. Future
  work that wants a broader agent shape can build on top.

## Transcript token cost

The substrate accumulates the full transcript across turns. **No
explicit token-budget bound** is enforced — consumers control cost
via `maxTurns`. Rough sizing for typical bounded-tool-output flows:

| `maxTurns` | Approx peak transcript | Approx input tokens on final turn |
|---|---|---|
| 4 | ~15 KB | ~4-5K tokens |
| 8 | ~40 KB | ~10-13K tokens |
| 12 | ~80 KB | ~20-25K tokens |

All v1 consumers (`callPerTask: maxTurns=2`, classifiers:
`maxTurns=2`, planner-discovery: `maxTurns=4`) stay well below
provider input-token limits. A future consumer that legitimately
needs `maxTurns ≥ 10` should reconsider the loop shape rather than
expecting the substrate to bound cost — at that scale, the
intermediate transcript itself becomes a context-engineering
problem worth solving deliberately.

## Open questions

(none — all settled in plan body)

## Rollback

Each phase is independently rollback-able by reverting the
migration commit; the substrate itself stays in tree, just unused
by the rolled-back call site.

A global `INSRC_TOOL_LOOP=off` flag is **not** in scope: the
substrate is the only retry implementation post-migration, so a
flag-off path would mean keeping the legacy ad-hoc loops indefinitely.
Migration is intended to be a one-way ratchet per call site.
