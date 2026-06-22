# Analyze framework — Context Builder

## Purpose

Build the context bundle that's stamped into every LLM call inside an analyze run. Two invocation modes:

- **Run-level** — called once after classification, before planning. Bigger budget; the planner consumes it to enumerate sub-units and pick templates.
- **Task-level** — called once per task before its `completeStructured` call. Smaller, sharper; carries upstream task outputs the task declared as inputs.

## Lineage from the prior memory shaper

The deleted `agent/working-memory/shaper.ts` introduced a layered, budgeted bundle that the analyze framework extends. The original layers were chat-flow-specific (L1 system, L2 summary, L3a recent, L3b semantic, L4 task, L5 response); the analyze shaper preserves the **layered + budgeted** discipline and the **single-call vs chunked map-reduce** path selection, but redefines what's in each layer per target.

What's lifted unchanged:
- The layered budget model — every layer gets a token allowance and the shaper either fits or summarizes-down
- The single-call vs map-reduce dispatch on `numCtx` headroom
- The `shouldDisableThinking` quirks model on Ollama
- The per-layer schema-conformance retry pattern (`hasRequiredKeys` + corrective retry)
- The `tryParseJson` / fence-recovery defensive layer (the LLM's structured-output guarantee is the wire-level promise; this is the belt-and-suspenders pass)

What's redefined per analyze target:
- **Layer contents** — the names L2/L3a/L3b were chat-specific; analyze uses `system / summary / surface / structure / artefacts / upstream / focus`.
- **The shaper's prompts** — analyze shapers compose against indexer graph snapshots + task outputs, not turn history.
- **Caching policy** — analyze run-level bundles cache to disk under `~/.insrc/analyze/<run-id>/context/run-bundle.json` and on resume the cached bundle is the source of truth (vs the chat shaper, which always rebuilt).

## The bundle

```ts
interface AnalyzeContextBundle {
  readonly system:    string;        // Stable role + task posture
  readonly summary:   string;        // Target-shape summary (1-2 paragraphs)
  readonly surface:   string;        // Discovered surface (APIs / endpoints /
                                     // tables / manifests / cron jobs / ...)
  readonly structure: string;        // Layout / topology / hierarchy
  readonly artefacts: string;        // Concrete excerpts (code / schema / yaml)
                                     // -- limited, with explicit citations
  readonly upstream:  string;        // Outputs from prior tasks the current
                                     // task consumes (task-level only)
  readonly focus:     string;        // The intent block: scope bucket, focused
                                     // question (if any), citation strictness,
                                     // depth policy reminder
}
```

The render order in the prompt is: `system` → `focus` → `summary` → `structure` → `surface` → `artefacts` → `upstream`. **Structural reference goes trailing** per the project's prompt convention (the LLM's attention is recency-weighted; schemas and catalogs land at the tail).

A bundle's footer always carries a fixed contract reminder:

```
## Contract reminder
- Cite every claim. Use { kind: 'source', file, lineStart, lineEnd } for
  source excerpts, { kind: 'entity', entityId } for indexer-known
  entities, { kind: 'doc', url, anchor? } for external references.
- No free text outside the JSON tool call.
```

## Per-target shapers

Three shapers live under `src/insrc/analyze/context/`:

- `code-shaper.ts`
- `data-shaper.ts`
- `infra-shaper.ts`

Each implements:

```ts
export interface AnalyzeShaper {
  buildRunBundle(input: RunShapeInput, opts: ShapeOpts): Promise<AnalyzeContextBundle>;
  buildTaskBundle(input: TaskShapeInput, opts: ShapeOpts): Promise<AnalyzeContextBundle>;
}

interface RunShapeInput {
  readonly intent:     ClassifiedIntent;
  readonly catalog:    TaskTemplateSummary[];   // For planner-context only
  readonly graphTools: GraphQueryDeps;          // closure repos / entity queries /
                                                //   db search
}

interface TaskShapeInput {
  readonly intent:        ClassifiedIntent;
  readonly task:          PlannedTask;
  readonly template:      AnalyzeTaskTemplate;
  readonly upstreamTasks: Map<string, unknown>; // taskId -> output JSON
  readonly graphTools:    GraphQueryDeps;
}
```

### What each layer holds, per target

| Layer       | code-shaper                                              | data-shaper                                                 | infra-shaper                                                |
|-------------|----------------------------------------------------------|-------------------------------------------------------------|-------------------------------------------------------------|
| `system`    | "You are a code-understanding analyst..."                | "You are a data-understanding analyst..."                   | "You are an infrastructure-understanding analyst..."        |
| `summary`   | Repo name, top-level packages, language mix, primary build system | Connection list, table/file count, dominant formats   | IaC families detected (Terraform / k8s / Helm / etc), CI/CD systems |
| `surface`   | Detected functional surface (top exports / public APIs / HTTP endpoints / CLI commands) | Schema preview (table/column listings; file headers) | Manifest listings + resource kinds                          |
| `structure` | Module tree + dependency closure summary                 | ER diagram sketch + connection topology                     | Deployment topology (services, namespaces, environments)    |
| `artefacts` | A handful of representative source excerpts (entry points, central modules) — each carries citations | Schema DDL fragments / sample rows (PII-redacted by default) | Key manifest excerpts (one per family)              |
| `upstream`  | (task-level) JSON from prior tasks the current one declared as `consumes` | same                                                | same                                                        |
| `focus`     | Intent block — same shape across targets                 | same                                                        | same                                                        |

### Budget allocation

Default budget split (configurable per target via `models.analyze.budget.<target>`):

| Layer       | Run-level | Task-level |
|-------------|-----------|------------|
| system      | 5%        | 5%         |
| focus       | 5%        | 5%         |
| summary     | 15%       | 10%        |
| structure   | 25%       | 15%        |
| surface     | 25%       | 15%        |
| artefacts   | 25%       | 25%        |
| upstream    | 0%        | 25%        |

The shaper enforces budgets via the same "summarize-down" Ollama pass the original shaper used: when a layer's raw content exceeds its allowance, the local model emits a budget-conforming summary, with that summary cached against the source's content hash so repeated tasks against the same surface don't repay the cost.

## Bundle-build pipeline

```
                ┌───────────────────────────────────────────────┐
                │ Gather raw content                            │
                │  - graph queries (closure repos, entity rows) │
                │  - tool calls (file read, search, db schema)  │
                │  - upstream task outputs (task-level only)    │
                └───────────────────────────────────────────────┘
                                       │
                                       ▼
                ┌───────────────────────────────────────────────┐
                │ Per-layer staging                             │
                │  emits Markdown for each layer                │
                └───────────────────────────────────────────────┘
                                       │
                                       ▼
                ┌───────────────────────────────────────────────┐
                │ Budget enforcement                            │
                │  for each layer:                              │
                │    if tokenCount(layer) > allowance:          │
                │      summarize via local Ollama call          │
                │      with the lifted shaper retry+validate    │
                └───────────────────────────────────────────────┘
                                       │
                                       ▼
                ┌───────────────────────────────────────────────┐
                │ Assemble + cache                              │
                │  render order + contract reminder footer      │
                │  persist (run-level only)                     │
                └───────────────────────────────────────────────┘
```

## Caching

- **Run-level bundle** caches to `~/.insrc/analyze/<run-id>/context/run-bundle.json`. On resume, the cached file wins — no rebuild.
- **Task-level bundles** cache to `~/.insrc/analyze/<run-id>/context/<task-id>.bundle.json`. On replay (the task re-runs because the user re-ran an aggregate without re-running upstream), the cached bundle is used until any input it depends on changes.
- **Per-layer content cache** keyed on `sha256(raw content + layer name + budget)`; lives in `~/.insrc/analyze/cache/shaper/`. Survives across runs. The summarize-down Ollama call's output lands here so two runs against the same module reuse the same compressed surface description.

Cache invalidation rules:
- Any source file in the run's closure whose `mtime` has changed since the bundle was assembled → invalidate the per-layer cache entries touching that file.
- A new template revision → invalidate all task-level bundles that reference it.
- An explicit `--no-cache` CLI flag bypasses the entire cache for the run.

## Failure modes

| Mode | Cause | Behavior |
|---|---|---|
| Budget overshoot after summarize-down | Source content is exotic (binary embed, huge generated file) | Layer is replaced with a one-line "[layer truncated: <reason>]" + the original content is materialized to `~/.insrc/analyze/<run-id>/context/dropped/<layer>.txt` so the user can inspect. Task proceeds. |
| Upstream task output missing | Earlier task failed | `upstream` layer carries `[unavailable: <taskId> failed; downstream claims may be limited]`. Task proceeds and its prompt is instructed to surface this in its `reasoning` field. |
| Graph query returns nothing | Closure repos empty / scope target not indexed | The shaper emits a structured warning into `summary` and runs the indexer's `repo.reindex` IPC under the hood; if that fails too, the run aborts with `scope-not-indexed`. |
| Local Ollama unavailable | Daemon down / model missing | The shaper falls back to no-summarize-down (raw layers truncated by line-count). Run continues with `degraded: true` stamped in the meta and surfaced in the final report. |

## Extensions points

- **New target** → add a new shaper module + register in `src/insrc/analyze/context/index.ts`. The framework dispatches on `intent.target`.
- **New layer** → add it to `AnalyzeContextBundle`, add a budget allocation entry, add the staging logic to each shaper that needs it. The contract reminder + render order are framework-level.
- **Custom budget profile** → users set `models.analyze.budget.<target>` in config. The shaper reads with the table above as the default.

## What's deliberately deferred

- **Cross-run knowledge transfer** — bundle re-use across analyze runs against the same scope is keyed on `(target, scopeRef, intent)` identity only. A more aggressive content-level dedup across runs (e.g., "I shaped this repo last week; reuse the structure layer verbatim") is Phase 2.
- **Privacy-aware redaction** of artefact excerpts — PII redaction for the `data-shaper`'s sample rows is in scope from day one (default-on); aggressive secret-scanning for `code-shaper` (e.g., spotting accidentally checked-in credentials in source excerpts) is Phase 2.
- **Streaming bundle assembly** — the shaper assembles the full bundle then emits. Streaming partial bundles into the planner is Phase 2 and only matters if XL runs start exceeding 30s of bundle-build time.

## See also

- `design/analyze-framework.md` — the overall framework
- `design/analyze-plan-builder.md` — what consumes the run-level bundle
- `design/analyze-framework-{code,data,infrastructure}.md` — per-target shaper details
