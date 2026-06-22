# Implementation plan — Analyze Context Builder

Design: [`design/analyze-context-builder.md`](../design/analyze-context-builder.md)

## Scope

Build the **LLM-driven context shaper** that every analyze LLM call consumes. Three invocation modes (classification → run → task), five shapers (classification / generic / code / data / infra), one shared TS driver + one prompt per shaper.

Out of scope: the classifier itself, the planner, leaf templates. The shaper exposes a stable interface; everything downstream depends on it.

## Architecture summary

Each shaper is a **prompt file + a TS factory entry** pointing the shared driver at the right prompt + bundle schema. The shared driver:
1. Loads the prompt + bundle schema.
2. Prepares the inputs (scope ref, intent, upstream tasks, etc.) as the human turn.
3. Invokes the local Ollama provider with the read-only tool registry and the bundle schema as the structured-output target.
4. Ollama runs a tool-loop (graph traversal, DB describe, file read / glob, manifest parse) and emits the final `AnalyzeContextBundle` via `completeStructured`.
5. The driver caches the bundle to disk, assembles Markdown for downstream prompts in the fixed render order, and returns both.

No token budget, no `summarizeDown`, no PII redaction, no approval gate, no `--no-cache` flag. Shaper is hard-fail on local Ollama unavailability.

## Module layout (greenfield)

```
src/insrc/analyze/
  index.ts                       barrel
  contract.ts                    framework-level contract reminder footer
                                 (single-sourced; planner imports from here too)
  context/
    index.ts                     shaperFor(mode, target?) factory
    types.ts                     AnalyzeContextBundle, ShapeOpts, *Input
    schema.ts                    Ajv JSON schema for AnalyzeContextBundle
    driver.ts                    shared LLM-driven shaper: load prompt, prep
                                 inputs, invoke Ollama+tools+schema, cache
    tool-surface.ts              read-only filter over the built-in tool registry
    bundle.ts                    assembleMarkdown(bundle): render order + footer
    cache.ts                     run + task bundle caches (no per-layer cache)
    invariants.ts                empty-graph detector + auto-reindex trigger
    __tests__/
      driver.test.ts             fake-Ollama unit tests
      tool-surface.test.ts
      bundle.test.ts
      cache.test.ts
      driver.live.test.ts        gated behind INSRC_LIVE_TESTS=1

prompts/analyze/
  classification.system.md       target-agnostic, kind-counts only
  generic.system.md              cross-cutting; target=generic
  code.system.md                 run + task
  data.system.md                 run + task
  infra.system.md                run + task

shared/
  analyze-types.ts               ClassifiedIntent / PlannedTask /
                                 AnalyzeTaskTemplate -- structural stubs until
                                 the classifier + planner + template registry
                                 land

config/
  local.ts                       add models.analyze.shaperModel +
                                 models.analyze.shaper.{maxToolTurns,
                                 structuredOutputRetries, ollamaNumCtx}

daemon/
  analyze-rpc.ts                 analyze.context.{buildClassification,
                                 buildRun, buildTask} IPC handlers (Phase 6)
```

## Phasing

### Phase 0 — Skeleton + types + stubs

- Create the `src/insrc/analyze/` tree above; barrels + empty file stubs.
- Land `AnalyzeContextBundle`, `ShapeOpts`, `ClassificationShapeInput`, `RunShapeInput`, `TaskShapeInput`, `Shaper`, `Mode`, `Target` in `context/types.ts` verbatim from the design doc.
- Land the framework-level `contract.ts` with the contract-reminder footer constant. Planner will later import from here too.
- `shared/analyze-types.ts` with structural-only stubs for `ClassifiedIntent` / `PlannedTask` / `AnalyzeTaskTemplate`. Header points at the framework doc.
- `context/index.ts` exports a `shaperFor(mode, target?)` factory. The five prompts return a no-op `Shaper` that throws `"P0 stub"` on call.

Acceptance: `tsc` is green from a fresh checkout; factory dispatch works structurally; the contract footer string round-trips through `assembleMarkdown` (Phase 1's task).

### Phase 1 — Bundle assembler + contract footer

- Implement `context/bundle.ts`:
  - `assembleMarkdown(bundle: AnalyzeContextBundle): string` renders Markdown in the fixed order `system → focus → summary → structure → surface → artefacts → upstream` and appends the contract footer from `analyze/contract.ts`.
  - Empty layers (LLM declared blank, listed in `bundle.meta.emptyLayers`) are omitted from the rendered Markdown.
  - Helper `omitEmpty(label, body)` so empty layers don't leave dangling headers.
- Implement `context/schema.ts`:
  - Ajv JSON schema for `AnalyzeContextBundle`. Critical arrays / fields get `minLength` / `minItems` where applicable. Versioned (`schemaVersion: 1`); the version goes into cache keys.
- Unit tests: layer order, empty-layer omission, contract footer appended exactly once, Ajv schema accepts a hand-built bundle.

Acceptance: rendering a hand-built bundle produces expected Markdown; schema validation works both ways.

### Phase 2 — Read-only tool surface

- Implement `context/tool-surface.ts`:
  - Reads the built-in tool registry (`src/insrc/daemon/tools/builtins/`).
  - Filters to read-only families: `graph.*`, `db.list_*` + `db.describe` + `db.sample`, `db_file_*` read-only family, `file.read*` + `file.glob` + `file.list_dir` + `file.stat`, `code.list_manifests` + `code.parse_manifest`, `repo.list` + `repo.get_closure`.
  - Explicitly excludes: `file.write`, `file.delete`, `shell.*`, network mutation tools, `db_sql_execute` (mutating), `repo.add` / `repo.remove` / `repo.reindex`, k8s mutation tools, pkg install tools, ssh.
  - Exposes `getReadOnlyTools(): ToolDefinition[]` for the driver to pass into `OllamaProvider.complete`.
- Unit tests: assert known-mutating tool ids are excluded; assert known-read-only tools are present; a snapshot test pins the read-only tool list (so accidentally exposing a mutation tool breaks CI).

Acceptance: unit tests pass; snapshot test reviewed manually for the initial baseline.

### Phase 3 — Shared driver (the heart of the shaper)

- Implement `context/driver.ts`:
  ```ts
  async function runShaper(args: {
    promptPath:       string;                  // resolved per shaper
    bundleSchema:     JSONSchema;
    inputs:           ClassificationShapeInput
                     | RunShapeInput
                     | TaskShapeInput;
    invocationMode:   'classification' | 'run' | 'task';
    shaperId:         'classification' | 'generic' | 'code' | 'data' | 'infra';
    opts:             ShapeOpts;
  }): Promise<AnalyzeContextBundle>
  ```
- Steps:
  1. Resolve cache key = `sha256(promptHash + schemaVersion + inputsHash)`. Check disk cache (run-id-scoped for run/task, run-id-scoped for classification — classification is per-run, not cross-run).
  2. Cache miss → load prompt file. If missing, throw `ShaperPromptMissingError` (boot-time validator catches this too, see Phase 5).
  3. Build the message list:
     - system message = loaded prompt content + contract reminder footer (so the LLM sees the contract while building the bundle, in addition to the user-facing footer in the assembled Markdown).
     - user message = serialized inputs (scope ref, intent, upstream tasks if task-mode) as JSON inside a fenced block.
  4. `OllamaProvider.complete(messages, { tools: getReadOnlyTools(), toolLoop: true, maxToolTurns: config.maxToolTurns })` → drives the tool-loop until the model decides it has enough.
  5. Final `completeStructured(finalMessages, AnalyzeContextBundle schema, { retries: config.structuredOutputRetries })` → forces structured output.
  6. Stamp `bundle.meta` with `{ mode, shaper, toolCalls, modelId, emptyLayers }`.
  7. Persist to disk + return.
- Caps:
  - `maxToolTurns` from config (default 40). Overshoot → throw `ShaperToolLoopExhausted`.
  - Structured-output retries from config (default 3). Exhaustion → throw `ShaperSchemaUnrecoverable`.
  - Local Ollama connection error at any step → throw `ShaperLlmUnavailableError`. No fallback path.

Acceptance: driver round-trips a synthetic prompt through a hand-mocked Ollama provider, asserts cache hit on second call, asserts each named error fires when its trigger condition is forced.

### Phase 4 — Caching

- Implement `context/cache.ts`:
  - `~/.insrc/analyze/<run-id>/context/run-bundle.json` — single per-run.
  - `~/.insrc/analyze/<run-id>/context/<task-id>.bundle.json` — one per task.
  - `~/.insrc/analyze/<run-id>/context/classification.json` — single per-run.
  - **No** per-layer cross-run cache. (Was killed when summarize-down was dropped.)
- Invalidation:
  - Cache key includes prompt content hash + schema version + invocation inputs hash, so prompt edits / schema bumps / input changes auto-invalidate.
  - Additionally, the cached bundle records `repoLastIndexedAt` from `db/repos.ts`. On read, if the registry's current `lastIndexedAt` exceeds the cached value, the entry is stale and discarded.
- No `--no-cache` flag. `opts.bypassCache: boolean` exists on the driver API for tests only; not exposed via CLI.

Acceptance: two consecutive identical invocations → second hits cache; bumping the indexer mtime on the registry → next invocation rebuilds; the bypass flag forces a rebuild.

### Phase 5 — Prompt files + boot-time validator

- Write the five system prompt files under `prompts/analyze/`:
  - `classification.system.md` — target-agnostic, kind-counts only, no source-body reads. Tool-use restricted to repo list + kind-count + connection list + IaC dir glob.
  - `generic.system.md` — cross-cutting; instructs the LLM to inventory all detected target surfaces and produce a high-level bundle.
  - `code.system.md` — run + task modes via prompt branching on the input's `mode` field. Lossless-within-closure instruction. Mandatory citation references in `artefacts`.
  - `data.system.md` — run + task modes; enumerate every connection / object / column; sample rows allowed un-redacted.
  - `infra.system.md` — run + task modes; detect every IaC family; emit per-family resource listings + topology + one representative excerpt.
- Each prompt closes with the loaded contract reminder content (the prompt file itself does not duplicate the contract reminder — the driver injects it from `contract.ts` at message-build time).
- Boot-time validator in `daemon/index.ts` (Phase 5.a):
  - On daemon start, assert each of the five prompt files exists + is non-empty. Missing → daemon refuses to start with a clear log line pointing at the missing path.
- Initial model choice in `config/local.ts`: `models.analyze.shaperModel = "qwen3-coder:14b"`. Open question for live-test phase: does qwen3-coder tool-loop well at this size, or do we need a different model? Tunable via config.

Acceptance: each prompt file exists; daemon-boot smoke test catches a deleted prompt; live tests against `src/insrc` (eat our own indexer) produce structurally valid bundles from each shaper.

### Phase 6 — Failure modes

Implement and test the failure-mode set from the design doc:

| Mode | Implementation |
|---|---|
| `ShaperLlmUnavailableError` | Catch Ollama connection errors anywhere in the driver; rethrow as this typed error; the run-orchestrator aborts on it. |
| `ShaperToolLoopExhausted` | Tool-loop turn counter; threshold from config; throw on overshoot. |
| `ShaperSchemaUnrecoverable` | `completeStructured` retry budget exhausted; rethrow as this typed error. |
| Missing upstream output | Task-mode driver detects `upstreamTasks.get(id) === null`; renders `[unavailable: <taskId>]` placeholder into the user message; instructs the LLM to surface in `upstream` layer. |
| Empty closure → auto-reindex | `context/invariants.ts` runs before the LLM call when `mode='run'`. If `repo.get_closure()` returns empty for any target repo in `intent.scopeRef`, the wrapper invokes `repo.reindex` IPC directly. After reindex, retry the closure check. Still empty → throw `ScopeNotIndexedError`. |
| Prompt file missing | Boot-time validator (Phase 5.a) catches this before any run starts. |

Acceptance: each failure mode has a deterministic unit test (mocked Ollama / mocked registry); an integration test forces an empty closure on a fresh-but-unindexed repo and verifies auto-reindex fires.

### Phase 7 — Daemon IPC

- Implement `daemon/analyze-rpc.ts`:
  - `analyze.context.buildClassification(runId, scopeRef, userPrompt)` → returns the bundle.
  - `analyze.context.buildRun(runId, intent)` → returns the bundle.
  - `analyze.context.buildTask(runId, intent, task, template, upstream)` → returns the bundle.
- Register handlers in `daemon/index.ts`. Each handler is a thin transport wrapper around the driver.
- No IDE / CLI surface yet — the framework's outer-loop RPC (in a separate plan) is the eventual caller.

Acceptance: end-to-end test invokes each RPC over the daemon socket, second call hits the cache, on-disk artifacts present under `~/.insrc/analyze/<run-id>/context/`.

## Risk register

- **qwen3-coder tool-loop reliability.** The default shaper model is qwen3-coder. Tool-loop behavior at the target scale (40+ turns over a real repo's graph) is unverified. Mitigation: live tests during Phase 5 against the insrc-ide repo itself; if reliability is poor, swap to a different Ollama model via config. The `maxToolTurns` cap protects the runtime regardless.
- **Cache invalidation lag.** The shaper trusts the indexer's `lastIndexedAt`. If a user edits a file and runs analyze before the indexer's file-watcher fires, the cache returns stale content. Acceptable for v1; the file-watcher is fast in practice. Mitigation if it bites: targeted stat on cited files (hybrid approach from earlier discussion, now deferred).
- **Bundle size for XL scope.** No truncation → bundles can balloon. Specific worry: a generic-target run on a giant monorepo. Mitigation: the L/XL warning at run-start is the user's signal to expect this; framework-level monitoring of bundle sizes during testing will tell us whether any model truly can't accept the largest realistic bundle.
- **LLM emitting un-cited claims in `artefacts`.** The schema enforces a `citations[]` array per claim. Mitigation: schema with `minItems: 1` on the citations field where it's required; the structured-output corrective retry catches the LLM emitting zero-citation claims.

## Out of scope

- Bundle streaming (Phase 2 of the design doc).
- Cross-run dedup beyond identity-keyed cache.
- Adaptive shaper model selection (XL → bigger model auto-route).
- The classifier itself — we accept a `ClassifiedIntent` and stub the type until the classifier ships.
- The framework outer-loop's `analyze.run.start` IPC + the L/XL warning surface — design doc lives in `analyze-framework.md`, implementation lands with the framework outer-loop plan.

## Dependencies

- Indexer + repo registry: stable, in tree.
- `OllamaProvider` + `completeStructured`: stable, in tree.
- Built-in tool registry (`daemon/tools/builtins/`): stable, in tree.
- `db/search.ts` + LMDB graph layer: stable, in tree. (Consumed indirectly through the read-only tool surface.)
- DB drivers (`daemon/db/`, `daemon/tools/builtins/db/`, `daemon/tools/builtins/data/`): stable, in tree.
- `ClassifiedIntent` / `PlannedTask` / `AnalyzeTaskTemplate`: **not yet built**, stubbed structurally; tightened when the classifier + planner + template registry land.

## Out-of-band open items to revisit during Phase 5

These are intentionally not blocking the implementation:

1. **Tool-loop model choice.** Confirm qwen3-coder:14b vs an alternative once live tests are running.
2. **`numCtx` sizing for XL runs.** Default `models.analyze.shaper.ollamaNumCtx = 32768`. May need to grow for XL bundles; revisit when bundle sizes are measurable.
3. **Per-shaper prompt iteration.** First-cut prompts are scaffolding; expect 2-3 rounds of tuning against live runs in Phase 5 + 6.
