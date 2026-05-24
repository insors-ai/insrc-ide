# Tool-call guard layer (pre-dispatch validation + coercion for local LLM)

## Motivation

Log audit across recent code-analyzer runs surfaced **~830 invalid
tool-call responses** across the dataset:

| Failure category | Count | Source |
|---|---|---|
| `tool dispatch returned isError; will retry with corrective schema` | 596 | `callPerTask` retry loop |
| `runSkill: invalid-input` (args fail skill schema) | 130 | `invoke.ts` schema validator |
| `provider returned no toolCalls; will retry` | 70 | `callPerTask` retry loop |
| `executeStep: per-task call returned no toolCalls after retry; skipping` | 25 | Retry exhausted → work dropped |
| `runSkill: unknown-skill` | 6 | Hallucinated skill id |

**100% of attributed failures came from `provider: local`.** Cloud
(Anthropic / OpenAI / Gemini / Mistral) does not show this pattern
because cloud providers enforce the tool-input JSON schema
server-side before the response returns.

### Root cause

`agent/providers/ollama.ts:79` sets the qwen family quirk to
`formatWithTools: false`. The wrapper drops the `responseFormat` JSON
schema constraint whenever `tools` are provided to qwen, because the
combination causes qwen to emit blank `tool_calls`. The cost is that
**qwen's tool emission is structurally unconstrained on the wire** —
arg names, types, required fields are policed only by the skill
runner downstream, after the round-trip.

The dominant failure shape, sampled from the logs, is identical
across hundreds of events:

```
"errors":["<root>: missing required property 'entityId'"]
"errors":["<root>: missing required property 'entityId'"]
"errors":["<root>: missing required property 'entityId'"]
```

qwen routinely calls `code.entity.summary` / `code.entity.callers`
without the required `entityId` argument. The current
recovery — surface the error in a corrective prompt, retry the
local LLM — works ~95% of the time but burns an extra round-trip per
failure (~2-5s of local-LLM latency × 596 events = **20-50 minutes
of recoverable time per XL run**).

## What this plan addresses (and what it does not)

This plan is about **defensive recovery** at the dispatcher boundary.
It does not change the local LLM, the qwen quirk, or the skill
registry. It adds a pre-dispatch pipeline that catches recurring
qwen hallucination patterns without a round-trip and converts the
unrecoverable ones into precise corrective prompts.

A complementary direction — outside this plan's scope — is the
**"different path" for local LLMs**:

| Option | What it changes | Why it's not in this plan |
|---|---|---|
| Switch default local model to devstral / codestral | `formatWithTools: true` for these families → wire-level schema enforcement → most failures structurally impossible | Requires re-validating the entire analyzer pipeline against a new model; large surface; separate decision |
| Wait for qwen to fix the format+tools bug | Same as above, no code change | External dependency, unbounded timeline |
| Two-stage emission: stage 1 picks the skill with format constraint (no tools), stage 2 dispatches with tools | Decouples skill choice from arg synthesis; each stage gets schema enforcement | Doubles per-call latency for every step; non-trivial loop refactor |
| Local LLM as a constrained-decoding agent (LlamaCPP grammars / Outlines / etc.) | Per-token constraint on tool emission | Requires runtime swap; ecosystem fragmentation |

Any of these is a stronger structural fix than the guard layer. The
guard layer is what we can ship **now**, against the **current**
model, while a longer-term model-strategy decision plays out.

## Layer design

A single new module `agent/tool-call-guard.ts` exposing one function:

```ts
guardLocalToolCall(
  call: ToolCall,
  skillRegistry: SkillRegistry,
): Promise<GuardOutcome>

type GuardOutcome =
  | { kind: 'pass';     call: ToolCall }                    // unchanged, dispatch as-is
  | { kind: 'coerced';  call: ToolCall, notes: string[] }   // rewritten silently, dispatch the coerced shape
  | { kind: 'rejected'; correctiveResult: ToolResult }      // do NOT dispatch; return the error directly to the LLM
```

The pipeline runs four stages in order; the first to produce a
non-`pass` outcome wins:

| Stage | Coerces | Rejects |
|---|---|---|
| **1. Tool-name fuzzy match** | `code_describe_file` → `code.source.file.describe` when separator-normalized name is in the registry | An unknown name with no close match (Levenshtein > threshold) |
| **2. Per-skill arg-rename map** | `path` → `file` for `code.source.file.describe`; `class_name` → `className`; etc. Curated from observed log failures | (never rejects — purely additive) |
| **3. Type coercions** | `kinds: "class"` → `["class"]` (scalar → array for array-typed args); strip leading/trailing whitespace on string args | Wrong type that can't be coerced (e.g. number where string required) |
| **4. Pre-dispatch input-schema check** | (never coerces at this stage — only validates) | Missing required arg, malformed args — builds a **specific** corrective prompt naming the skill, the missing/wrong arg, and a one-line example from the skill's schema |

When stage 4 rejects, the corrective prompt is more useful than what
the current `callPerTask` retry produces, because it can name the
specific arg + its expected shape *without* the skill-runner round-
trip:

```
Your previous skill_invoke call to `code.entity.summary` was rejected:
the required argument `entityId` is missing. The schema requires a
32-character hex string (e.g. `entityId: "a1b2c3..."`); you typically
get this from a prior `code.entity.locate-by-name` or
`code.source.file.describe` call's return value.
```

vs. today's prompt which gets the same error text but only after
paying the round-trip.

### Per-skill rename map

Lives next to the skills as a static module
`agent/tool-call-guard-rules.ts`. Format:

```ts
export const SKILL_ARG_RENAMES: Record<string, Record<string, string>> = {
  'code.source.file.describe':   { path: 'file' },
  'code.source.module.describe': { path: 'modulePath', module_path: 'modulePath' },
  'code.entity.summary':         { id: 'entityId', entity_id: 'entityId' },
  'code.entity.callers':         { id: 'entityId', entity_id: 'entityId' },
  // ... seeded from the log audit
};
```

Maintenance plan: each new failure pattern observed in production
logs gets a one-line PR addition. The map is data, not code; cheap
to extend.

### Telemetry

Every coercion and rejection logs at `info` level with a stable shape:

```json
{
  "module": "tool-call-guard",
  "skillId": "code.entity.summary",
  "outcome": "coerced" | "rejected",
  "stage": "fuzzy-name" | "arg-rename" | "type-coerce" | "schema-check",
  "before": { "id": "abc..." },
  "after":  { "entityId": "abc..." },
  "saved":  "round-trip"           // when coerced, indicating we avoided the LLM retry
}
```

Aggregating these gives a real-time view of which patterns the local
LLM is hitting most, so the rename map can be updated based on
evidence.

## Wiring

The guard hooks in at `executeStep.callPerTask` between the provider
response and the `executeTool` dispatch. Single integration point:

```ts
// agent/tasks/code-analyzer/execute-step.ts:252 (current)
const result = await executeTool(toolCall, { session: input.session });

// becomes:
const guarded = await guardLocalToolCall(toolCall, skillRegistry);
if (guarded.kind === 'rejected') {
  // skip dispatch, treat as if the skill runner had rejected it
  lastErrorFeedback = formatCorrectiveFeedback(guarded.correctiveResult);
  continue;
}
const dispatchCall = guarded.kind === 'coerced' ? guarded.call : toolCall;
const result = await executeTool(dispatchCall, { session: input.session });
```

Two-line change at the integration point. The guard's coercion +
rejection logic is testable in isolation.

The guard is **opt-in per call site** via a config flag. The
classifier and per-task analyzer paths default to ON (where local
LLM does the work). The cloud planner path defaults to OFF (cloud
doesn't hallucinate at this rate; the guard would be dead weight).

## Phase breakdown

| Phase | Scope | Ship gate |
|---|---|---|
| **1. Pipeline skeleton + name-fuzzy + type-coerce** | `agent/tool-call-guard.ts` with `guardLocalToolCall`, stages 1+3 wired. Unit tests against synthetic ToolCall fixtures. | All synthetic fixtures pass; integration not wired yet |
| **2. Arg-rename map seeded from logs** | `agent/tool-call-guard-rules.ts` populated with the renames extracted from log audit (top 5-10 patterns covering ~80% of observed failures). Unit tests for each entry. | All entries have tests; coverage report shows >80% of historical failures would coerce or reject without round-trip |
| **3. Pre-dispatch schema check + corrective-prompt builder** | Stage 4 implementation: skill-schema lookup, missing-arg detection, prompt-format function. Tests for each error class. | Each error class produces a deterministic corrective prompt; round-trip count in test fixtures matches expectation |
| **4. Integration into `callPerTask`** | Two-line wiring at `execute-step.ts:252`. Existing analyzer tests pass unchanged (guard defaults preserve behavior on inputs that already pass). | Existing test suite green; new integration test confirms a known-bad qwen-shaped call now coerces or rejects without dispatch |
| **5. Telemetry + log aggregation** | Stable log shape emitted on every guard outcome; a small `scripts/audit-guard-events.ts` aggregates a run's guard activity into a table | Log-format snapshot test; aggregator script runs against a sample log |
| **6. Live validation + rename-map iteration** | Run the analyzer on a known-failing prompt; measure round-trip reduction. Update the rename map based on new patterns surfaced in the logs. | ≥40% reduction in `callPerTask` retry events on a comparable run; rename map gets at least 2 evidence-driven additions |

## Test coverage

| File | Coverage |
|---|---|
| `tool-call-guard.test.ts` (new) | Each stage: pass-through, coerced, rejected. Realistic ToolCall fixtures derived from log samples. |
| `tool-call-guard-rules.test.ts` (new) | One test per entry in `SKILL_ARG_RENAMES`. Pins the curated set against regression. |
| `execute-step.test.ts` (extend) | Integration: a known-bad qwen-shaped call (missing `entityId`) is rejected pre-dispatch with the precise corrective prompt; the retry succeeds without a dispatch round-trip. |

## Out of scope

- **Cloud-side validation.** Cloud providers already enforce
  tool-input schema server-side; the guard would be dead weight.
  Future: per-provider opt-in if a specific cloud model proves to
  hallucinate at scale.
- **The tool-loop substrate.** Separate plan
  (`plans/tool-loop-substrate.md`). The guard layer is a defensive
  shim; the substrate is the structural reorganization.
- **Local-model substitution.** Switching default local from qwen
  to devstral / codestral would structurally eliminate this entire
  problem (those families have `formatWithTools: true` per
  `ollama.ts:80-84`) and is the strongest fix, but is a separate
  decision involving end-to-end re-validation.
- **Grammar-constrained decoding.** A different runtime path
  (LlamaCPP grammars, Outlines) that constrains tool emission at
  the token level. Not addressed here.
- **Skill-schema improvements.** Some skill schemas have ambiguous
  required-arg structures that may contribute to hallucination
  rates. Addressing skill-side ergonomics is a separate effort.

## Rollback

Feature flag `INSRC_TOOL_GUARD=off` disables the guard at the
`callPerTask` integration point. The two-line wiring becomes a
pass-through. Legacy behavior restored without code change.
