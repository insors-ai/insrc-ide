# Structured LLM output — provider abstraction + callsite sweep

## Status

Pre-implementation. Triggered by the M4.a `/plan` smoke
(2026-06-19, daemon log
[a24cdc0a538 + bee00c9634a](https://github.com/insors-ai/insrc-ide/commit/bee00c9634a)):
the cloud provider returned `\`\`\`json {...} \`\`\`` instead of bare JSON for the
orchestrator's Phase1Ask call, the parser threw on the leading backtick, the meta-task
aborted on step 1. Root cause is structural — **none of the four cloud providers
(anthropic, openai, gemini, mistral) implement `opts.responseFormat`**; only
ollama does. Every "I expect JSON" callsite across the codebase relies on
prompt-level instruction ("Respond with ONLY a JSON object") and a hand-rolled
JSON.parse + fence-strip fallback. The audit (this plan, §"Callsite inventory")
surfaced **~40 callsites with this pattern** across meta-task, memory-context,
substrate, section-flow, working-memory, content-gen, designer, planner, tester,
research, code-analyzer, and brainstorm modules.

## Related plans + design

- **Reference architecture**: `insors-extraction` project's `insors/core/LLM/`
  module (Python). Two-method provider surface
  (`chat_completion` + `structured_completion`), capability declaration,
  `Instructor` library for Pydantic-typed Anthropic/OpenAI/Gemini structured
  output, `OpenAISchemaProcessor` for strict-mode pre-flighting.
  Location: `/Users/subhagho/work/projects/insors-ai/insors-extraction/insors/core/LLM/`.
- [`plans/meta-task-plan.md`](./meta-task-plan.md) — Phase 4's `/plan` template
  is the immediate consumer that's blocked on this.
- [`plans/memory-context.md`](./memory-context.md) — the M1.8 L1 preferences
  curator + M1.4 substrate classifier hook are both structured-output callsites
  that currently fall back to fence-stripping on cloud and rely on Ollama's
  `format` for the local Layer 2.
- [`plans/meta-tasks.md`](./meta-tasks.md) — the orchestrator's Phase1Ask +
  Phase2Out contracts are the load-bearing schemas that need to ship as JSON
  Schema definitions.

## Project principle

Accuracy primary, cost least. Per `CLAUDE.md` / `AGENTS.md`: any "cheap" path
(fence-strip + JSON.parse + retry-with-text-prompt) that the LLM can still bypass
(by emitting prose, malformed JSON, or fenced JSON inside fenced JSON) is the
wrong path. The right path forces the provider's native structured-output API
to honour the schema at the wire layer; the parser becomes a backstop, not the
primary contract.

## Scope

- **Provider-abstraction layer**: a new `LLMProvider.completeStructured<T>(messages, schema, opts): Promise<T>`
  method + `ProviderCapabilities` declaration on every provider.
- **Per-provider implementations** of `completeStructured` for anthropic,
  openai, gemini, mistral, ollama. Each uses the provider's native
  structured-output mechanism (forced tool, response_format json_schema,
  responseSchema, format schema).
- **Validation backstop** via ajv with Instructor-style retry (on schema
  validation failure, append the errors to the conversation + re-issue, up to
  `maxAttempts`).
- **OpenAI strict-mode preprocessor** ported from
  `insors-extraction`'s `OpenAISchemaProcessor` (adds
  `additionalProperties: false`, ensures non-dict properties land in
  `required`).
- **Schema authoring**: introduce `@sinclair/typebox` so every structured
  callsite authors a schema once and gets both the TypeScript type +
  the runtime JSON Schema. Avoids the schema-vs-type-drift class of bugs.
- **Sweep all current callsites** from the inventory below to the new
  primitive. Retire `extractJson` + `stripFences` + per-callsite
  `JSON.parse(rawText)` paths once their consumers migrate.

## Non-goals

- **Free-form text completions stay on `complete`.** The new
  `completeStructured` is a parallel surface; tool-calling chats,
  liveStep streaming, and assistant-text responses keep using the
  existing path.
- **No new validation library beyond ajv + typebox.** Both are tiny,
  well-established, and cover JSON Schema draft 2020-12.
- **No protocol changes** to existing wire shapes — `Phase1Ask`,
  `Phase2Out`, etc. stay the same union types; we just author them
  via typebox so the JSON Schema falls out automatically.
- **No agent-framework redesign.** The framework's existing
  `AgentDefinition` / `AgentStep` machinery keeps using
  `provider.complete`; only steps that demand structured JSON migrate.
- **No telemetry overhaul.** Existing `llm-io` log lines stay; we
  add `method: 'completeStructured'` to the event but no new
  collector.

## Phasing principle

**Each phase commits, pushes, and is independently testable.** Each file
is touched at most once per phase. Earlier phases land the contract +
ajv backstop; the provider implementations are independent (one per
phase) so a failure on one provider doesn't block the others. Callsite
sweeps come after the abstraction is proven on at least one provider
end-to-end.

The sequencing keeps the daemon buildable + functional at every commit:
- **A (contract)** — additive type + capability declaration. Existing
  `complete` path unchanged. Daemon builds + runs.
- **B.x (per provider)** — each provider implementation lands without
  any callsite using it. Daemon builds + runs.
- **C.1 (orchestrator)** — first consumer of `completeStructured`.
  Unblocks `/plan`. Daemon builds + runs.
- **C.2+** — sweeps. Each commit retires fence-stripping in one
  module. Daemon builds + runs throughout.

---

## Phase A — Contract + ajv backstop + typebox

End state: `LLMProvider.completeStructured<T>` + `ProviderCapabilities`
exist as type definitions; `completeStructured` throws "not implemented"
by default for every provider. ajv + typebox land as dependencies.
`withStructuredRetry` helper + `processSchemaForOpenAIStrict` port land
as standalone utilities. No callsite uses any of it yet.

**File touches:**
```
src/insrc/shared/types.ts                                            MODIFY (+ completeStructured + ProviderCapabilities)
src/insrc/agent/providers/structured-output.ts                       NEW (withStructuredRetry, processSchemaForOpenAIStrict, ajv singleton)
src/insrc/agent/providers/__tests__/structured-output.test.ts        NEW
src/insrc/package.json                                               MODIFY (+ @sinclair/typebox, + ajv)
```

### A.1 `LLMProvider` interface

```ts
// shared/types.ts

/** Provider's native structured-output API. Throws on validation failure
 *  after maxAttempts (default 3). The provider's wire layer enforces the
 *  schema; ajv is a defensive backstop. */
interface LLMProvider {
  // ...existing fields...
  completeStructured<T>(
    messages: LLMMessage[],
    schema: TSchema,                 // typebox Schema; JSON Schema draft 2020-12 compatible
    opts?: CompletionOpts & { maxAttempts?: number },
  ): Promise<T>;
  readonly capabilities: ProviderCapabilities;
}

interface ProviderCapabilities {
  readonly structuredOutput:  boolean;   // wire-layer schema enforcement
  readonly toolCalling:       boolean;
  readonly vision:            boolean;
  readonly webSearch:         boolean;
  readonly streaming:         boolean;
  readonly embeddings:        boolean;
}
```

### A.2 Default "not implemented" base

A small abstract `BaseLLMProvider` (the existing providers don't extend
a base today — they all implement `LLMProvider` directly). Phase A keeps
the structure: each provider gets a `completeStructured` that throws
`new Error('structured output not implemented on provider <id>')`. The
real implementations land in phase B.

### A.3 Shared helpers (`structured-output.ts`)

```ts
import Ajv from 'ajv';
import type { TSchema, Static } from '@sinclair/typebox';

const ajv = new Ajv({ allErrors: true, useDefaults: false, removeAdditional: false });

export type ValidationResult<T> =
  | { ok: true;  value: T }
  | { ok: false; errors: string[] };

export function validateAgainstSchema<S extends TSchema>(
  schema: S,
  raw:    unknown,
): ValidationResult<Static<S>> {
  const validate = ajv.compile(schema);
  if (validate(raw)) { return { ok: true, value: raw as Static<S> }; }
  const errors = (validate.errors ?? []).map(e => `${e.instancePath || '/'}: ${e.message}`);
  return { ok: false, errors };
}

/** Instructor-style retry: on schema-validation failure, append the
 *  errors back to the conversation and re-issue. Up to maxAttempts. */
export async function withStructuredRetry<T>(
  call:          (extraSystemNote: string | undefined) => Promise<unknown>,
  validate:      (raw: unknown) => ValidationResult<T>,
  maxAttempts:   number,
): Promise<T> {
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const note = attempt === 0
      ? undefined
      : `Your previous response failed schema validation:\n  - ${lastErrors.join('\n  - ')}\nReturn valid JSON conforming to the schema.`;
    const raw = await call(note);
    const v = validate(raw);
    if (v.ok) { return v.value; }
    lastErrors = v.errors;
  }
  throw new Error(`structured-output: validation failed after ${maxAttempts} attempts: ${lastErrors.join('; ')}`);
}

/** OpenAI strict-mode pre-flight. Mirrors insors-extraction's
 *  OpenAISchemaProcessor. Walks the schema in place, sets
 *  additionalProperties:false on every object, fills `required`
 *  with every non-dict property. Idempotent. */
export function processSchemaForOpenAIStrict(schema: TSchema): TSchema { /* port */ }
```

### A.4 Tests

`structured-output.test.ts` (~12 tests):
- `validateAgainstSchema`: accepts well-formed, rejects with informative errors.
- `withStructuredRetry`: succeeds on first attempt; succeeds on second
  (validation-feedback message contains the prior errors); throws after
  exhausting attempts.
- `processSchemaForOpenAIStrict`: nested objects all get
  `additionalProperties:false`; required arrays cover non-dict
  properties; preserved dictionary types stay unchanged; idempotent
  (run twice = run once).

### Acceptance

- Type-check clean.
- ajv + typebox install cleanly into the workspace.
- All 12 structured-output unit tests green.
- No daemon-side build regression (every provider still has a
  `completeStructured` stub that throws; nothing calls it yet).

---

## Phase B — Per-provider implementations

Each provider implementation is independent and testable in isolation
against the provider's mock-response fixture. We sequence them so the
provider used by the active daemon config lands first (Anthropic →
unblocks the Haiku Phase1Ask failure).

### Phase B.1 — Anthropic

End state: `anthropic.ts` `completeStructured` issues a forced
single-tool request and parses the tool input as `T`. ajv backstop +
retry wrapper.

**File touches:**
```
src/insrc/agent/providers/anthropic.ts                      MODIFY
src/insrc/agent/providers/__tests__/anthropic-structured.test.ts   NEW
```

```ts
async completeStructured<T>(messages, schema, opts) {
  // 1. Build the forced tool: { name: '_emit', description: '...', input_schema: schema }
  // 2. messages.create({ tools: [tool], tool_choice: { type: 'tool', name: '_emit' }, ... })
  // 3. Extract first tool_use block's input.
  // 4. withStructuredRetry: validate via ajv; on failure, append validation errors
  //    as a user message and re-issue.
  return withStructuredRetry(
    async (extraNote) => {
      const messagesWithNote = extraNote
        ? [...messages, { role: 'user', content: extraNote }]
        : messages;
      const response = await this.client.messages.create({...});
      const toolBlock = response.content.find(b => b.type === 'tool_use');
      if (!toolBlock) { throw new Error('anthropic: no tool_use block; structured output failed'); }
      return toolBlock.input;
    },
    raw => validateAgainstSchema(schema, raw),
    opts?.maxAttempts ?? 3,
  );
}

readonly capabilities = {
  structuredOutput: true, toolCalling: true, vision: true,
  webSearch: false, streaming: true, embeddings: false,
};
```

**Tests** (~6, scripted Anthropic mock):
- Happy path: scripted tool_use response parses + validates.
- Retry path: first response is malformed; second is good.
- Final failure: 3 malformed responses throw with all errors.
- Schema with discriminated union (mirrors Phase1Ask).
- Schema with nested arrays.
- Capability is `structuredOutput: true`.

### Phase B.2 — OpenAI

```ts
async completeStructured<T>(messages, schema, opts) {
  const strict = processSchemaForOpenAIStrict(structuredClone(schema));
  return withStructuredRetry(
    async (extraNote) => {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [...messages, ...(extraNote ? [{role:'user',content:extraNote}] : [])],
        response_format: { type: 'json_schema', json_schema: { name: '_emit', schema: strict, strict: true } },
      });
      return JSON.parse(response.choices[0].message.content);
    },
    raw => validateAgainstSchema(schema, raw),
    opts?.maxAttempts ?? 3,
  );
}
```

**File touches:**
```
src/insrc/agent/providers/openai.ts                          MODIFY
src/insrc/agent/providers/__tests__/openai-structured.test.ts NEW
```

### Phase B.3 — Gemini

Uses `responseMimeType: 'application/json'` + `responseSchema`. Gemini's
schema dialect is OpenAPI 3.0, NOT JSON Schema draft 2020-12 — needs a
small adapter (`typeboxToGeminiSchema`) that strips/translates the
differences (`$ref`, `oneOf`, `additionalProperties`).

```
src/insrc/agent/providers/gemini.ts                          MODIFY
src/insrc/agent/providers/__tests__/gemini-structured.test.ts NEW
src/insrc/agent/providers/gemini-schema-adapter.ts           NEW
```

### Phase B.4 — Mistral

Newer Mistral models (`mistral-large-2407+`) support
`response_format: { type: 'json_schema', json_schema }`. Older models
fall back to `{ type: 'json_object' }` (no schema, just JSON guarantee).
Capability flag MUST distinguish (`structuredOutput: true` even on the
JSON-object-only path — the typebox + ajv backstop catches structural
drift either way).

```
src/insrc/agent/providers/mistral.ts                          MODIFY
src/insrc/agent/providers/__tests__/mistral-structured.test.ts NEW
```

### Phase B.5 — Ollama

Lift the existing `_resolveOllamaFormat` from `complete` into
`completeStructured`. The wire shape (`format: schemaObject`) is
already correct; only the dispatch needs to change so the schema is
guaranteed (not optional).

```
src/insrc/agent/providers/ollama.ts                           MODIFY
src/insrc/agent/providers/__tests__/ollama-structured.test.ts NEW
```

Ollama already passes structured output to qwen3-coder / qwen3-embedding
via `format`. After this phase, the existing
`responseFormat: { schema }` paths in callsites can be deprecated
(they'll still work during the C-phase sweeps; eventually all callers
flip to `completeStructured`).

### Per-B-phase acceptance

- Provider unit tests green (mock-based, no real cloud).
- One live-LLM smoke (gated on `INSRC_LIVE_LLM=1`) per provider that
  proves the structured-output path against the real wire format.
- `capabilities.structuredOutput === true` for every provider after
  its phase lands.

---

## Phase C — Callsite sweeps

Each sweep phase migrates one cohesive module from
`provider.complete(... + responseFormat + JSON.parse + extractJson)` to
`provider.completeStructured(messages, Schema)`. The migration pattern
is uniform:

1. Author the schema via typebox in a co-located `*-schemas.ts` file
   (or add to an existing one).
2. Replace the `provider.complete(...)` + `JSON.parse(extractJson(...))`
   block with `provider.completeStructured(messages, Schema)`.
3. Delete the per-callsite fence-stripping + fallback logic.
4. Update the callsite's test fixtures to script the structured-output
   path.

Sweeps are sequenced by **operational impact** — the orchestrator
unblocks `/plan` immediately; the substrate classifier unblocks
chat-side preference capture across cloud providers; the rest are
quality-of-life improvements.

### Phase C.1 — Meta-task orchestrator (unblocks /plan)

**Files:**
```
src/insrc/meta-task/schema.ts                                MODIFY (+ typebox schemas for Phase1Ask, Phase2Out)
src/insrc/meta-task/orchestrator.ts                          MODIFY (callForPhase1Ask, callForPhase2, callForSynthesis)
src/insrc/meta-task/__tests__/orchestrator-structured.test.ts NEW
```

Replaces the JSON.parse blocks at the three orchestrator callsites:

| Callsite | Schema |
|----------|--------|
| `callForPhase1Ask` (line ~503) | `Phase1AskSchema` (discriminated union: `sufficient \| context-needed`) |
| `callForPhase2` (line ~615) | `Phase2OutSchema` (discriminated union: `deliverable \| context-needed \| abort`) |
| `runSynthesis` (line ~700) | `Phase2OutSchema` (same; synth uses the deliverable branch) |

Existing `validatePhase1Ask` + `validatePhase2Out` hand-rolled
validators become wrappers around `validateAgainstSchema(...)` so the
JSON-Schema-versioned errors flow consistently.

**Acceptance**:
- `npm run build` clean.
- 5 existing orchestrator tests + 4 orchestrator-preferences + 8
  Phase2Runner + 6 plan-template + 4 sub-meta-task tests still green.
- 8 new orchestrator-structured tests cover happy + retry +
  exhaust-retries paths.
- Manual `/plan add a /healthz endpoint` smoke succeeds against
  the daemon's configured Anthropic provider (the failure mode this
  whole plan is fixing).

### Phase C.2 — Meta-task fetchers + preferences curator

**Files:**
```
src/insrc/meta-task/fetchers.ts                              MODIFY (curatePreferencesViaLlm)
src/insrc/meta-task/__tests__/fetchers-preferences.test.ts   MODIFY (12 tests → use structured path)
```

The G5-style relevance curator in `fetchPreferences` (lines ~720-725
per the audit) currently does `JSON.parse` + array filter. Migrate
to `completeStructured` with a `{ relevant_indices: number[] }`
schema. The 12 existing fetcher tests stay green (their scripted
provider gets a tiny wrapper to also handle `completeStructured`).

### Phase C.3 — Memory-context curators + L1 system extension

**Files:**
```
src/insrc/agent/context/preferences.ts                       MODIFY (curateByRelevance)
src/insrc/agent/context/__tests__/preferences.test.ts        MODIFY
```

Same pattern as C.2 — the L1 system preferences curator's
`{ relevant_indices: number[] }` shape. 9 existing tests stay green;
one updated to use the structured-output mock.

### Phase C.4 — Substrate classifier Layer 2

**Files:**
```
src/insrc/daemon/substrate/classifier/ollama-hook.ts         MODIFY (Layer 2 verdict)
src/insrc/daemon/substrate/classifier/user-assertion.ts      MODIFY (verdict type used as schema source-of-truth)
src/insrc/daemon/substrate/__tests__/ollama-hook.test.ts     MODIFY
```

The Layer 2 hook today calls Ollama with `format: schema` directly.
After C.4 it goes through `provider.completeStructured`. Local
behaviour is identical (Ollama's wire shape unchanged); the API surface
becomes uniform with cloud providers. Cloud-equivalent Layer 2 hooks
(future memory-context M2.x?) now Just Work.

### Phase C.5 — Section-flow steps (largest sweep)

**Files (one commit per file group):**

```
src/insrc/agent/section-flow/step-build-context.ts           MODIFY
src/insrc/agent/section-flow/step-fact-gap-analysis.ts       MODIFY
src/insrc/agent/section-flow/step-sketch.ts                  MODIFY
src/insrc/agent/section-flow/step-summarize-step.ts          MODIFY
src/insrc/agent/section-flow/step-decide-next-step.ts        MODIFY
src/insrc/agent/section-flow/step-investigation-plan.ts      MODIFY
src/insrc/agent/section-flow/step-report-review.ts           MODIFY
src/insrc/agent/section-flow/__tests__/*                     MODIFY (where scripted-provider)
src/insrc/agent/section-flow/schemas.ts                      NEW (typebox schemas shared across steps)
```

Each step currently has its own `JSON.parse + validate` block.
The cleanest sweep is per-step commits, but to honour
"one phase = one commit", we ship the whole section-flow sweep as
one Phase C.5 commit (8 files + 1 new schemas file). Tests are
already scripted; updates are mechanical.

### Phase C.6 — Working-memory module

**Files:**
```
src/insrc/agent/working-memory/bullet-extractor.ts           MODIFY
src/insrc/agent/working-memory/shaper.ts                     MODIFY
src/insrc/agent/working-memory/updater.ts                    MODIFY
src/insrc/agent/working-memory/__tests__/*                   MODIFY
src/insrc/agent/working-memory/schemas.ts                    NEW
```

### Phase C.7 — Remaining agents (designer, planner, tester, brainstorm, research, code-analyzer, content-gen)

This is the cleanup sweep. After C.1-C.6, every load-bearing path is
migrated. The remaining callsites are:

| Module | Callsites |
|--------|-----------|
| `agent/content-gen/outline.ts` | `tryOutline` |
| `agent/tasks/designer/{concepts,search-planner}.ts` | 2 |
| `agent/tasks/tester/classify.ts` | `classifyFailure` |
| `agent/tasks/brainstorm/spec-builder.ts` | (verify in inventory) |
| `agent/tasks/research/steps/*.ts` | several |
| `agent/tasks/code-analyzer/analyzer/result-parser.ts` | `parseAnalyzerResult` |
| `agent/planner/steps.ts` lines 60, 101, 430 | 3 (legacy; will be deleted in M4.b) |

Each cluster gets a co-located `schemas.ts` and a `MODIFY`-only commit.

The legacy `agent/planner/steps.ts` callsites are deliberately migrated
even though M4.b deletes the whole directory shortly. Reason: while
they coexist with the new `/plan` template, both consumers benefit from
the same wire-layer guarantee; migrating prevents the legacy planner
from regressing while M4.b lands.

### Phase C.8 — Retire shared fallback utilities

**Files:**
```
src/insrc/shared/json-fences.ts                              DELETE
src/insrc/agent/tasks/_shared/json-extract.ts                DELETE
```

Once every consumer has migrated, the fence-strip + extract-json
utilities have zero callers. Delete them. A grep gate (commit message
checklist) verifies zero references remain.

---

## Callsite inventory (full)

This is the complete audit output, ordered by the sweep phase that
will migrate each callsite. Generated 2026-06-19 from the Explore
agent's pass over the codebase. Schema shapes are described in TS-type
form; the actual typebox declarations land per-phase.

### To be migrated in C.1 (meta-task orchestrator)

| File:Line | Module | Output Shape | Current Parser |
|-----------|--------|-------------|-----------------|
| `meta-task/orchestrator.ts:603` | `callForPhase1Ask` | `Phase1Ask` (discriminated union: `sufficient \| context-needed { requests: ContextRequest[] }`) | `JSON.parse` + hand-rolled `validatePhase1Ask` |
| `meta-task/orchestrator.ts:615` | `callForPhase2` | `Phase2Out` (discriminated union: `deliverable \| context-needed \| abort`) | `JSON.parse` + `validatePhase2Out` |
| `meta-task/orchestrator.ts:716` | `runSynthesis` | `Phase2Out` (deliverable branch) | `JSON.parse` (cast to obj) |

### To be migrated in C.2 (meta-task fetchers)

| File:Line | Module | Output Shape | Current Parser |
|-----------|--------|-------------|-----------------|
| `meta-task/fetchers.ts:720` | `curatePreferencesViaLlm` | `{ relevant_indices: number[] }` | `JSON.parse` + array filter; catch → return unfiltered |

### To be migrated in C.3 (memory-context)

| File:Line | Module | Output Shape | Current Parser |
|-----------|--------|-------------|-----------------|
| `agent/context/preferences.ts:150` | `curateByRelevance` | `{ relevant_indices: number[] }` | `JSON.parse` + array filter; catch → return unfiltered |

### To be migrated in C.4 (substrate classifier)

| File:Line | Module | Output Shape | Current Parser |
|-----------|--------|-------------|-----------------|
| `daemon/substrate/classifier/ollama-hook.ts:88-93` | Layer 2 `classifyAssertion` | `{ verdict: 'accept'\|'reject'\|'defer', confidence: number, rationale: string, subject?: string, canonicalText?: string, categories?: string[], repoPaths?: string[], relationship?: AssertionRelationship }` | Ollama `format: schema` (works); fence-strip + regex recovery as fallback |

### To be migrated in C.5 (section-flow)

| File:Line | Module | Output Shape | Current Parser |
|-----------|--------|-------------|-----------------|
| `agent/section-flow/step-build-context.ts:208` | `buildContext` | `{ fetch: string[], ... }` (schema constrained) | `JSON.parse` + `stripFences` + hand-rolled validation; throw |
| `agent/section-flow/step-fact-gap-analysis.ts:132` | `factGapAnalysis` | `FACT_GAP_ANALYSIS_SCHEMA` | `JSON.parse` + validation; throw |
| `agent/section-flow/step-sketch.ts:128` | `sketch` | (schema constrained) | `JSON.parse` + validation; throw |
| `agent/section-flow/step-summarize-step.ts:200` | `summarizeStep` | `{ summary: string, ... }` | `JSON.parse` + validation; throw |
| `agent/section-flow/step-decide-next-step.ts:140` | `decideNextStep` | `{ nextStep: string }` | `JSON.parse` + validation; throw |
| `agent/section-flow/step-investigation-plan.ts:133` | `investigationPlan` | (schema constrained) | `JSON.parse` + validation; throw |
| `agent/section-flow/step-report-review.ts:287` | `reportReview` | (schema constrained) | `JSON.parse` + validation; throw |

### To be migrated in C.6 (working-memory)

| File:Line | Module | Output Shape | Current Parser |
|-----------|--------|-------------|-----------------|
| `agent/working-memory/bullet-extractor.ts:119-140` | `extractBullets` | `{ bullets: string[] }` | `stripFences` + `JSON.parse`; catch → return empty |
| `agent/working-memory/shaper.ts:244` | shaper call 1 | (shape per fixture) | `JSON.parse` + `stripFences`; catch → fallback |
| `agent/working-memory/shaper.ts:312` | shaper call 2 | (shape per fixture) | `JSON.parse` + `stripFences`; catch → fallback |
| `agent/working-memory/updater.ts:278` | `updateMemory` | `{ ops: Object[] }` | `JSON.parse` + schema check; catch → skip |
| `agent/working-memory/updater.ts:295` | (second update path) | same | same |

### To be migrated in C.7 (remaining agents)

| File:Line | Module | Output Shape | Current Parser |
|-----------|--------|-------------|-----------------|
| `agent/content-gen/outline.ts:124-134` | `tryOutline` | `OutlineResult = { sections: [{ title, subsections }] }` | `JSON.parse` + `stripFences` + retry-with-correction; fallback single-section |
| `agent/tasks/designer/concepts.ts:118` | designer concepts | (schema constrained) | `JSON.parse(extractJson(...))`; throw |
| `agent/tasks/designer/search-planner.ts:62-67` | designer search-planner | (schema constrained) | `JSON.parse` + fence recovery + regex fallback |
| `agent/tasks/tester/classify.ts:87` | `classifyFailure` | structured verdict | `JSON.parse(extractJson(...))`; throw |
| `agent/tasks/code-analyzer/analyzer/result-parser.ts:72` | `parseAnalyzerResult` | `AnalyzerResult = { findings, tools, answer }` | `JSON.parse(stripFences(...))`; return `{ok:false}` |
| `agent/planner/steps.ts:60` | `inferPlanType` (legacy) | `{ planType?: string }` | `JSON.parse(extractJson(...))`; catch → keep default |
| `agent/planner/steps.ts:101` | `planGatherContext` (legacy) | structured plan | `JSON.parse(extractJson(...))`; catch → fallback |
| `agent/planner/steps.ts:430` | `planEnrichContext` (legacy) | `[{ ...enrichments... }]` | `JSON.parse(extractJson(...))`; catch → fallback |
| `agent/tasks/brainstorm/spec-builder.ts` | (verify shape during sweep) | (TBD) | (TBD) |
| `agent/tasks/research/steps/*.ts` | varied | varied | `JSON.parse` direct; catch → fallback |

---

## Exit criteria

- [ ] `LLMProvider.completeStructured` + `ProviderCapabilities` exported
      from `shared/types.ts`.
- [ ] All five providers (anthropic, openai, gemini, mistral, ollama)
      implement `completeStructured` with their native structured-output API.
- [ ] `withStructuredRetry` + `processSchemaForOpenAIStrict` + ajv-based
      `validateAgainstSchema` shipped + unit-tested.
- [ ] All Phase C callsites migrated. Zero remaining
      `JSON.parse(rawText)` calls on `provider.complete` output.
- [ ] `extractJson` + `stripFences` shared utilities deleted.
- [ ] `/plan add a /healthz endpoint` manual smoke succeeds against
      the active daemon's Anthropic provider.
- [ ] Existing test suites stay green at every phase boundary:
  - Substrate: 116 tests
  - Meta-task: 128 tests (after C.1; ~135 after C.2)
  - Memory-context (prefs + context): 54 tests
  - Section-flow (existing): TBD
  - Working-memory: TBD
- [ ] Each phase = one commit + one push.
- [ ] No file revisited across phases except the (deliberately
      documented) revisits called out in this plan.

## Risks + mitigations

- **Risk**: Anthropic's tool-use structured output disagrees with the
  forced-tool pattern under stream mode (Phase B.1's first cut may not
  support `onToken` callbacks).
  - **Mitigation**: `completeStructured` is deliberately a separate
    surface. It doesn't have to support streaming in the first cut;
    callsites that need streaming (none in the structured path today)
    can be revisited later.

- **Risk**: Gemini's `responseSchema` rejects JSON Schema features we
  use freely (`$ref`, complex `oneOf`, `additionalProperties`).
  - **Mitigation**: Phase B.3 ships a `gemini-schema-adapter.ts` that
    transforms typebox-generated schemas into Gemini's OpenAPI 3.0
    flavour. Round-trip tests confirm the adapter is lossless for the
    feature set Phase1Ask + Phase2Out + the curators use.

- **Risk**: ajv compilation time bloats startup on the daemon.
  - **Mitigation**: ajv compiles each schema once and caches. Even with
    ~50 schemas the total compile time is ~30ms on cold start.

- **Risk**: Migrating section-flow's 7 steps in one commit produces a
  huge diff.
  - **Mitigation**: The diff is mechanical and uniform per step. Split
    into 7 commits per-step IF review feedback says so during PR.

- **Risk**: OpenAI strict mode rejects `oneOf` (it does — strict mode
  requires single concrete schemas).
  - **Mitigation**: `processSchemaForOpenAIStrict` includes a
    `oneOf`-rewrite that converts to an explicit union via `anyOf` +
    `additionalProperties: false` per branch. This is what
    `insors-extraction`'s `OpenAISchemaProcessor` does too.

- **Risk**: Legacy planner callsites get migrated in C.7 but the whole
  directory deletes in M4.b shortly after.
  - **Mitigation**: Trivial migration (~30 LOC); the value is keeping
    both planners on the same wire contract until M4.b lands.

## Timeline estimate (rough)

| Phase | Effort (single dev) |
|-------|--------------------|
| A — contract + helpers + typebox + ajv | ~1.5 days |
| B.1 — Anthropic | ~1 day |
| B.2 — OpenAI | ~0.5 day |
| B.3 — Gemini (schema adapter) | ~1 day |
| B.4 — Mistral | ~0.5 day |
| B.5 — Ollama (lift existing) | ~0.25 day |
| C.1 — orchestrator | ~0.5 day |
| C.2 — fetchers | ~0.25 day |
| C.3 — memory-context | ~0.25 day |
| C.4 — substrate classifier | ~0.5 day |
| C.5 — section-flow (7 steps) | ~1 day |
| C.6 — working-memory | ~0.5 day |
| C.7 — remaining agents | ~1 day |
| C.8 — retire shared utils | ~0.25 day |

**Total**: ~9.25 days for one dev. Phases A and B unblock C.1 (which
unblocks `/plan`); C.2-C.8 are independent cleanup sweeps that can
run in any order after the abstraction is proven.

## File-touch summary

| File | Phase(s) |
|------|---------|
| `shared/types.ts` | A |
| `agent/providers/structured-output.ts` | A (NEW) |
| `agent/providers/anthropic.ts` | B.1 |
| `agent/providers/openai.ts` | B.2 |
| `agent/providers/gemini.ts` | B.3 |
| `agent/providers/gemini-schema-adapter.ts` | B.3 (NEW) |
| `agent/providers/mistral.ts` | B.4 |
| `agent/providers/ollama.ts` | B.5 |
| `meta-task/schema.ts` | C.1 |
| `meta-task/orchestrator.ts` | C.1 |
| `meta-task/fetchers.ts` | C.2 |
| `agent/context/preferences.ts` | C.3 |
| `daemon/substrate/classifier/ollama-hook.ts` | C.4 |
| `daemon/substrate/classifier/user-assertion.ts` | C.4 |
| `agent/section-flow/step-*.ts` (7) | C.5 |
| `agent/section-flow/schemas.ts` | C.5 (NEW) |
| `agent/working-memory/*.ts` | C.6 |
| `agent/working-memory/schemas.ts` | C.6 (NEW) |
| `agent/content-gen/outline.ts` | C.7 |
| `agent/tasks/designer/*.ts` | C.7 |
| `agent/tasks/tester/classify.ts` | C.7 |
| `agent/tasks/code-analyzer/analyzer/result-parser.ts` | C.7 |
| `agent/planner/steps.ts` (legacy) | C.7 |
| `agent/tasks/brainstorm/*.ts` | C.7 |
| `agent/tasks/research/steps/*.ts` | C.7 |
| `shared/json-fences.ts` | C.8 (DELETE) |
| `agent/tasks/_shared/json-extract.ts` | C.8 (DELETE) |

No file is touched in more than one phase. (Tests next to each file
get updated in the same phase as their target.)
