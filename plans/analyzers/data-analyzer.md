# Plan: Data Analyzer Agent

Implementation plan for the **Data Analyzer** family described in
[design/analyzers/data-analyzer.html](../../design/analyzers/data-analyzer.html).

This plan deliberately *bakes in* the lessons learned shipping the Code
Analyzer (see [code-analyzer.md](./code-analyzer.md)) -- features that were
added late or rediscovered as bugs there are landed up-front here.

## Related plans

- [plans/analyzers/data-analyzer-skills.md](./data-analyzer-skills.md) --
  **the analyzer-logic layer.** This plan owns the operational surface
  (orchestrator, pane, slash, checkpoint, save / re-run / drill-down,
  cache layering, cross-agent entrypoints); the skills plan owns the
  per-task analyzer logic (atomic + composite skills, the meta-skills
  that route questions, the registry, the per-skill cache and smoke
  gate). See "Relationship to data-analyzer-skills.md" below for the
  per-section split.
- [plans/analyzers/skills-core.md](./skills-core.md) -- registry +
  `runSkill` + feasibility infrastructure the analyzer-logic plan
  depends on. Shipped.
- [plans/analyzers/code-analyzer.md](./code-analyzer.md) -- sibling family;
  shares orchestrator-pipeline skeleton, citation invariant, gate widget,
  and per-task cache pattern.
- [plans/todo-framework.md](../todo-framework.md) -- TODO backbone; data-
  analyzer follows the same `TodoList` per run / `TodoItem` per task model.
- [plans/data-driver.md](../data-driver.md) -- shipped; provides the
  connection registry, secrets, drivers, sample-shape inference, and Prisma
  fast-path that this analyzer consumes.
- [plans/content-generator.md](../content-generator.md) -- shipped;
  multi-pass synthesis infrastructure the data-analyzer's `synthesise` step
  rides on (no new content-gen code needed).

## Relationship to data-analyzer-skills.md

This plan was written when the analyzer was a single per-kind tool
loop. The **skills** plan replaces that inline logic with composed
skill invocations. Both plans now coexist; this plan owns the
**substrate** and **product surface**; the skills plan owns the
**analyzer logic**.

Concretely:

| Layer | Owned by | Lives in |
|---|---|---|
| Slash command + family + intent registration | this plan §0 | shared/agent-registry, slash-commands |
| Orchestrator controller (run lifecycle, plan/review/synthesise dispatch) | this plan §1.2 / §1.3 | `daemon/controllers/data-analyzer-orchestrator.ts` |
| Per-task runner (the loop body) | **skills plan §8.2** | `runSkill()` dispatch via `invoke_skill` |
| Routing decisions (which skill(s) for this question) | **skills plan §7.1 / §7.2** | `meta.classify-question`, `meta.select-scope` |
| Atomic + composite analyzer skills (introspection, sampling, profiling, lineage, drift, PII, drift-windows, timeseries) | **skills plan §1-§5** | `daemon/skills/built-ins/data.*.ts` |
| Synthesis renderers (markdown templates per output shape) | **skills plan §6** | `daemon/skills/built-ins/data.synth.*.ts` |
| Confidence calibration + feasibility | **skills plan §7.3 / §7.4** | `data.meta.feasibility-check`, `data.meta.calibrate-confidence` |
| Citations invariant | this plan §1.5 | `agent/tasks/data-analyzer/analyzer/citations.ts` |
| Checkpoint / resume | this plan §1.9 | orchestrator state machine |
| Report pane + save + drill-down + diff + rerun | this plan §2 / §5 | workbench `data-analyzer/*.ts` |
| Per-task cache (outer) | this plan §2.4 | `~/.insrc/cache/data-analysis/` |
| Per-skill cache (inner) | **skills plan §10.2** | `~/.insrc/cache/skills/` |
| Cross-agent entrypoint (`data:analyze`) | this plan §4.3 | `daemon/cross-agent/data-analyze.ts` |
| Cross-agent tool surface (`data:*` legacy wrappers) | this plan §4.1 → migrating to **skills plan §9.2** | `daemon/cross-agent/data-tools.ts` |

**What "refactored to use skills" means in practice:** the plan
sections that used to describe inline analyzer logic
(§1.4 analyzer runner, §1.10 scope-tier classifier, §3.1 lineage,
§3.2 schema-drift, §3.3 ER, §4.1 cross-agent `data:*`,
§5.5 PII overrides) now describe **the skill that owns that logic +
the integration point** -- they no longer re-spec the inline code.
The shipped inline code stays where it is until the skills-plan
cutover lands; this plan tracks the cutover as a slice rather than
hiding it.

## Status

Phases 0, 1, 2 shipped. Phases 3, 4, 5 partly shipped (with skills-
plan supersessions noted per row).

| Phase | Slice | State | Notes |
|---|---|---|---|
| 0 | Family + slash | shipped | `/data-analyze` registered; `/data-analyzer` typo guard in place |
| 1.1 | types.ts | shipped | |
| 1.2 | orchestrator | shipped | `daemon/controllers/data-analyzer-orchestrator.ts` |
| 1.3 | prompts | shipped | plan / analyzer-system / synthesise-multipass / review |
| 1.4 | analyzer runner (per-task tool loop) | shipped (legacy) -- skills-plan §8.2 supersedes | `agent/tasks/data-analyzer/analyzer/runner.ts` runs the inline 8-call tool loop with per-kind playbooks. **Cutover planned**: when skills-plan §7.1 / §7.2 / §8.1 land, the runner becomes a thin `runSkill(invocation.skillId, invocation.args, deps)` dispatcher. The inline tool list, per-kind playbook nudges, and JSON-parse-retry move into the skill-registry's `runSkill` machinery (skills-core 3.1 / 3.7). The legacy runner stays compiled until skills-plan §9.1 maps every `DataAnalysisKind` to a default skill invocation |
| 1.5 | citations invariant | shipped | one retry, then downgrade-to-low |
| 1.6 | connection-approval gate | superseded | replaced by the universal access gate (plans/access-gate.md Phases 4-5); the orchestrator seeds `Session.access` for ephemeral connections at task start, the dispatcher in `agent/tools/executor.ts` handles UI gating uniformly. `agent/tasks/data-analyzer/access-gate.ts` is now an orphan reserved for future PII / schema-drift gate types per its docstring. |
| 1.7 | `data-conn:` URI scheme | shape only | types.ts emits the scheme; click-handler wiring is Phase 5.6 |
| 1.8 | slash dispatch | shipped | |
| 1.9 | checkpoint / resume | shipped | restoreState + buildResumeTask + afterResumeBootstrap |
| 1.10 | scope-tier classification | shipped (legacy) -- skills-plan §7.1 / §7.2 supersede | `agent/tasks/data-analyzer/scope.ts` ships per-tier (`single-table` / `multi-table` / `cross-conn` / `audit`) prompt addenda + a plan-size approval gate. **Cutover planned**: replaced by the meta-skills `meta.classify-question` (returns the structured `questionType` enum the orchestrator routes on) + `meta.select-scope` (resolves connection / target / columns from question text). The plan-size approval gate stays here -- it's a UX gate, not a routing decision -- but reads off the post-classify candidate count instead of the legacy tier label |
| 1.H | ephemeral connections from prompt | shipped | `_registerEphemeralFromPrompt` registers JSON / CSV paths typed by the user; auto-approved via `Session.access` seeding |
| 2.1 | DataAnalysisReportPane | shipped | flow contribution auto-opens on `list.body` write; Save... uses shared `rewriteCustomUrisForSave` helper. Drill-down footer rendering deferred to 5.3. |
| 2.2 | annotation manager | deferred | existing `InsrcAnnotationContribution` already covers code-citation annotation through `path:` link → source-file open. Pane-internal "highlight finding → batch to chat" needs a separate UI surface (DOM text-selection + report-anchored annotation kind); not a "reuse" of the existing manager. |
| 2.3 | mid-flight cancel | shipped | `deps.abortController.signal` plumbed through runner + multipass; framework's pipeline already breaks on `signal.aborted`. No analyzer-specific gate is required. |
| 2.4 | per-task on-disk cache (outer) | shipped (with deferred fingerprint) | `~/.insrc/cache/data-analysis/`, 200-entry LRU, mtime eviction, atomic writes; `dataAnalyzer.clearCache` RPC + palette command. Outer cache layer; the inner per-skill cache (skills-plan §10.2, deferred) sits below this. Lookup order: per-task cache first (cheap), per-skill cache second (per-invocation). **`connection-fingerprint` is currently a roster-level hash** -- schema drift on an unchanged connection is NOT detected. The proper `getSchemaFingerprint(connectionId, target)` driver helper called out in the "Driver gap" section is deferred -- it's shared by both cache layers, so landing it once benefits both. Workaround: `insrc.dataAnalyzer.clearCache`. |
| 3.1 | data_lineage tool | shipped; skills-plan §3.4 owns the analyzer-facing surface | `daemon/tools/builtins/data/lineage.ts` (the tool) is wrapped by `data.lineage.read-write-callsites` (the skill, registered in `daemon/skills/built-ins/data-lineage.ts`). The skill is what callers should invoke; the tool stays as the implementation primitive. Tool v1 uses literal-name matching + keyword-near-literal classification (insert/select/etc.); ORM-typed-identifier matching deferred. |
| 3.2 | data_schema-drift tool | shipped (Prisma fast-path only); skills-plan §4.1-§4.3 supersede when ready | `daemon/tools/builtins/data/schema-drift.ts` ships a Prisma-vs-live RDBMS diff. **Skills-plan §4.1 / 4.2 / 4.3** (`drift.prisma-vs-live` / `drift.typeorm-vs-live` / `drift.sqlalchemy-vs-live`) are the comprehensive replacement; they're currently deferred on Phase 3 code-binding skills (`code.orm.resolve-model`). Until those land, `data_schema-drift` stays as the only drift surface; `confidence: 'low'` for non-Prisma connections. |
| 3.3 | ER artifact integration | shipped; skills-plan §6.4 owns the renderer rewrite | Orchestrator's `_appendErArtifactSection` walks accepted tasks for `kind === 'er'`, invokes `artifact_er` per (connection, tables) group, appends "## ER Diagrams" to the report. **Skills-plan §6.4** `synth.er-diagram` is the planned skill replacement (deferred -- transitive on Phase 4 since it composes Phase 4's drift output for cross-table topology). The current inline integration stays until §6.4 ships. |
| 4.1 | data_* cross-agent wrappers | shipped; skills-plan §9.2 owns the cutover | `daemon/cross-agent/data-tools.ts`: pure-namespace forwarders (data_list_connections / data_scan / data_get / data_explain) + family-dispatch wrappers (data_describe / data_sample / data_sample_shape). All depth-check via `_crossAgentDepth`. `data_lineage` + `data_schema-drift` gained inline depth checks. **Cutover planned (skills-plan §9.2)**: cross-agent calls migrate to direct `runSkill('data.X', ...)` invocations under the cross-owner depth cap; `data:*` wrappers become legacy shims that forward to the matching skill. Stays on this layer until skills-plan §8 + §9 land; deletion gated on telemetry showing zero non-shim callers. |
| 4.2 | bidirectional cross-agent inventory | shipped | data-analyzer's runner advertises `code_locate` / `code_trace` / `code_describe`; code-analyzer's runner advertises `data_lineage` / `data_schema-drift`. Both directions respect the single-hop depth cap. |
| 4.3 | data_analyze Flow-2 dispatch | shipped | `daemon/cross-agent/data-analyze.ts` mirrors `code_analyze`: 16-task soft cap, 60s envelope, 45s per-task; runs through the data-analyzer's tool loop; returns stitched markdown + findings + citations. |
| 4.4 | @data-analyzer mention routing | shipped (Phase 1) | Already wired in `chat-handler.ts:parseAnalyzerMention` -- routes through `runDataAnalyzerSlash`. |
| 5.1 | insrc.dataAnalyzer.rerun command | shipped | Daemon-side: `RERUN_BOOTSTRAP_MARKER` + `afterRerunBootstrap` reconstructs DataAnalysisTask[] from the prior list's TodoItem.meta. Workbench: palette command resolves listId then `chatService.sendMessage(..., rerunFromListId)`. Cache-friendly: when the connection roster hasn't changed, every task hits the Phase 2.4 cache. |
| 5.2 | insrc.dataAnalyzer.diffWithPrevious | shipped | `daemon/data-analyzer-diff.ts` matches findings across two completed lists by primary citation (rdbms / kv / file-source / code-ref) with concern+issue fallback. `dataAnalyzer.diffRuns` RPC + workbench command + tmp-file editor open. |
| 5.3 | drill-down chain | shipped | `parseDrillDownFooter` factored to `browser/shared/`; data-analyzer pane gains clickable footer buttons; `insrc.dataAnalyzer.drillDown` command threads parentListId through chat.send to `runDataAnalyzerSlash` -> orchestrator's createList. |
| 5.4 | save discoverability + lastSavedAt | deferred | Save... button already shipped in Phase 2.1. Palette discoverability (`insrc.dataAnalyzer.saveReport` is in the palette) suffices. The `lastSavedAt` annotation on list.meta is genuinely optional and can land if usage data justifies it. |
| 5.5 | PII pattern overrides | superseded by skills-plan §5e | The bundled pattern-library + override file approach is replaced by the shipped 5e skills: `data.pii.detect-patterns.{rdbms,file,kv}` (anchored regex catalog), `data.pii.column-classifier.rdbms` (composite returning `pii / likely-pii / not-pii`), and `data.sensitivity.policy-check.rdbms` (cross-references caller-supplied `declaredPiiColumns` against detected). Repo-level pattern overrides come back as a future input to `data.pii.detect-patterns.*` (caller passes `extraPatterns: [{ name, regex, severity }]`); tracked under skills-plan as a follow-up to 5e.1 if a real user case lands. |
| 5.6 | data-conn: URI opener | shipped (v1) | `dataConnUriOpener.ts` + `DataConnUriOpenerContribution`. Parses `data-conn:<conn>(/<schema>)?/<table>(?col=&pk=)?`, opens Data Sources pane, surfaces citation as info notification. Auto-expand of the cited connection + pk-driven row fetch are deferred until dbDriversPane exposes a reveal API. |

The data-driver shipped earlier (see [plans/data-driver.md](../data-driver.md))
and exposes a stable `db_*` tool surface registered as built-in tools.
Tool ids were renamed from colon-form (e.g. `db:sql:describe`) to
underscore-form (`db_sql_describe`) on 2026-04-30 for Anthropic API
regex compatibility (`^[a-zA-Z0-9_-]{1,128}$`); see
[plans/access-gate.md](../access-gate.md) for the full rename context.

| Shipped tool id | Maps to design's name | Notes |
|---|---|---|
| `db_list_connections` | `data:list-connections` | enumerates registered connections |
| `db_sql_describe` | `data:describe-table` | RDBMS introspection (Prisma fast-path when present) |
| `db_sql_sample` | `data:sample` (RDBMS branch) | structured `where` only; row cap 50 |
| `db_sql_explain` | `data:explain` | per-dialect EXPLAIN |
| `db_kv_scan` | `data:scan` | namespace.allow-aware; cap 500 |
| `db_kv_get` | `data:get` | per-key fetch |
| `db_kv_sample_shape` | `data:sample-shape` (KV branch) | merges via `inferShape` from `shape-common.ts` |
| `db_file_describe` / `db_file_sample` / `db_file_sample_shape` | `data:*` (file branch) | csv / parquet / jsonl / etc. |

**Naming convention for this plan.** Where the analyzer's *internal*
tool list is meant, the plan uses the shipped `db_*` ids. Where the
*cross-agent* surface is meant (Phase 4 -- the namespace other
analyzers see), the plan uses the design's `data:*` names. The
cross-agent layer (Phase 4.1) wraps the `db_*` builtins behind
`data:*` aliases plus adds analyzer-native tools like `data:lineage`
and `data:schema-drift` that don't have driver-level equivalents.

**Open driver gap** -- carried over from the original Phase 2.4
write-up. There is still no centralised `getSchemaFingerprint(connectionId, target)`
helper. Each driver's `describe()` returns a `SchemaDescription`, but
no shared pipeline canonicalises + hashes it for cache invalidation.
The shipped Phase 2.4 cache uses a connection-roster fingerprint as
a stand-in (catches roster changes but not live-schema drift). The
proper helper is a ~30-line addition to `daemon/db/index.ts` that
dispatches by family and canonicalises the description; left for a
follow-up slice when usage data justifies the precision bump.

## Goals (short)

1. `/data-analyze <question>` produces a structured, cited Markdown report
   answering questions about live DB schema, sample-data shape, lineage,
   drift, and ER topology against the user's registered connections.
2. **Read-only.** The analyzer never writes to a DB. Driver-side enforcement
   + analyzer-side prompt enforcement.
3. **Independent of Code Analyzer.** The data-analyzer must work even with
   `code-analyzer` uninstalled. Cross-agent enrichment (via `code:*` /
   `deploy:*` tools) is opt-in via §13 of the design.
4. **Standalone artifacts.** Distinct file structure, dedicated REPL entry
   (`/data-analyze`), distinct prompt asset directory (`~/.insrc/data-analyzer/`),
   own cache directory (`~/.insrc/cache/data-analysis/`), own report pane.
5. **Bake in Code Analyzer learnings on day one** (see Lessons from CA below).

## Non-goals (in this plan)

- **Writing to databases.** Even safe writes (DDL dry-runs) are out.
- **Replacing the data-driver's setup UI.** When connections aren't
  registered the analyzer emits an empty-state with a "Configure DB
  connection" CTA invoking the data-driver's existing flow; it does not
  duplicate that flow.
- **PII detection beyond the design's pattern library.** Email / password /
  ssn / tax_id detection is in scope; statistical inference of PII (e.g.
  "this column looks 70% like SSNs") is not.
- **Long-form data exploration.** This is an *analyst* agent (cited
  findings); it is not a data-querying chat agent. Use the dbDrivers
  surface for free-form queries.
- **Cross-database joins.** A finding can cite multiple connections, but
  the analyzer doesn't synthesise data *from* one connection *into* a
  query on another.

## LLM routing -- local vs cloud per step

Mirrors the code-analyzer split: cloud reasons, local writes + tool-loops.
Cloud token cost is concentrated on the decision steps (plan + per-task
review); the local model handles the long-tail workloads (tool-driven
analysis + final markdown composition) where its slowness is fine and
its lower per-token cost matters.

| Step | Default provider | What it does | Why this side |
|---|---|---|---|
| `plan` | **cloud** (`providerHint: 'claude'`) | Decompose the user's free-form question into a `DataAnalysisTask[]` from the request + the resolved connection list. Single LLM call, ≤2.5K output tokens. | One-shot reasoning; needs a model strong enough to factor an audit-style question into discrete tasks. Cloud is right because the cost is bounded (one call per analysis). |
| `analyzer` (run-task / tool-loop) | **local** (Ollama) | The N-call tool loop per task. Calls `db_list_connections`, `db_sql_describe`, `db_sql_sample`, `db_kv_scan`, etc. Up to 8 tool calls / 10 min per task. Emits a `DataAnalyzerResult` via `submit_analysis`. | Cost-driven: a 10-task XL audit could be 80 LLM calls. Cloud would be expensive for what is mostly schema-driven structured-output work. Local model with `/no_think` + tool-call structured output is sufficient and free. |
| `review` | **cloud** (`providerHint: 'claude'`) | Per-task reviewer. Decides `accept` / `retry-with-hint` / `add-follow-up` / `done`. One LLM call per accepted task; ≤1.2K output tokens. | Quality-control gate at every task boundary. Cloud catches subtle problems (hallucinated columns, contradictions with cited samples) that the local model misses. Bounded by the plan size (≤10 calls). |
| `synthesise` | **local** (Ollama) | Multi-pass content-gen: outline → per-section writers → stitch. Composes the final markdown from accepted findings + citations. Hot path under the per-section continuation cap. | The cloud already did the reasoning work in plan + review; the local model just composes prose from inputs it has in hand. Keeps cloud cost focused on decisions, not prose generation. |
| `embedding` | **local-only** | Used by L4 code-relevance lookups when lineage findings cross into code. | Embedding model is local-only by framework policy (every cloud provider's `embed()` returns `[]` per CLAUDE.md). |

**Bring-your-own-LLM is in scope for v1.** The framework's
per-step resolver (`session.resolver.resolve('data-analyzer', '<step>')`)
already lets users override any step via the Model Providers pane. In
the orchestrator, every LLM task ships with:

```ts
resolverAgent: 'data-analyzer',
resolverStep:  'plan' | 'analyzer' | 'review' | 'synthesise',
providerHint:  'claude' | 'local',          // default
```

The hint is the fallback; the resolver picks `models.agents.data-analyzer.<step>` from config first when set. A user can:

- Pin `synthesise` to Claude/OpenAI/Gemini for higher-quality reports
  (e.g. `models.agents.data-analyzer.synthesise = "openai:gpt-4o"`).
- Pin `analyzer` to a different local model (e.g. a deepseek-coder
  variant) -- just point the local Ollama config at the new model.
- Air-gapped: keep `plan` and `review` on a self-hosted cloud-shaped
  endpoint (any OpenAI-compatible URL works via `models.local.url`).
- Cost-conscious: rebind `review` to local; quality drops but token
  cost goes to zero.

**Step-binding seeding.** The Model Providers pane's
`buildDefaultAgentBindings(activeCloud)` already seeds bindings for
shipped families. Phase 0.1 adds `data-analyzer` to that helper so
the four step keys (`plan`, `analyzer`, `review`, `synthesise`) appear
in the pane on first load with the defaults from the table above.
Users with no cloud key configured: `plan` and `review` fall back to
local automatically (the resolver's fallback chain is hint → step
binding → active cloud default → local).

**Failure mode.** If a cloud step is bound to a provider whose key is
missing or invalid, the orchestrator emits `provenance: 'local-only'`
on the final report and a warning banner. Per design §15: cloud-
unavailable downgrades plan + review to local; synthesise is
unaffected since it's already local. The acceptance criteria for
Phase 1 include this fall-back path.

## Prerequisites

| Prereq | Status |
|---|---|
| TODO framework with `meta` extensibility | shipped |
| Data driver (connections, drivers, `db_*` tools, sample-shape, Prisma fast-path) | shipped |
| `getSchemaFingerprint(connectionId, target)` helper for cache keying | **deferred** -- Phase 2.4 ships the cache layer with a roster-level fingerprint stand-in (`buildConnectionFingerprint` in `agent/tasks/data-analyzer/cache.ts`); the proper schema-aware helper waits for a follow-up slice |
| Cross-agent tool registry framework (`daemon/cross-agent/`) | shipped |
| `code:*` cross-agent tools (`code:locate`, `code:trace`, `code:describe`, `code:analyze`) | shipped (`registerCodeAnalyzerCrossAgentTools` wired at daemon startup) |
| `data:*` cross-agent tools | **NOT shipped** -- Phase 4.1 adds `daemon/cross-agent/data-tools.ts` |
| `deploy:*` cross-agent tools | future (Deployment Analyzer plan) |
| ER artifact (`artifacts/kinds/er.ts`) | shipped |
| Markdown rendering + theme variables | shipped |
| `path:` URI opener (clickable citation links) | shipped (commit 3d1643c0062) |
| `saveReport` path-rewrite helper | shipped (commit a889fbce357) |
| Slash autocomplete + typo guard | shipped (slice B) |
| Intent slash dispatcher | shipped (commit f0fb6fd18a1) |
| Tolerant analyzer JSON parser (`stripFences` extracts `{...}` span) | shipped (commit 2f0b5505b43) |
| Context history-bleed framing | shipped (commit 9e099803c27) |
| Daemon spawn under system Node 22 (matches build ABI) | shipped (commit f81bd5a0c64) |
| Multi-pass content-gen for synthesis | shipped |

## Lessons from Code Analyzer -- bake these in from day one

These items shipped late or got rediscovered as bugs during the Code
Analyzer rollout. Hard-wire them into the Data Analyzer's first commits.

1. **Pane uses VS Code theme variables, not hard-coded colours.**
   `feedback_pane_rendering` memo. Every colour in
   `media/dataAnalysisReport.css` resolves through `var(--vscode-*)`.

2. **Code segments are clickable.** The `path:` IOpener already exists
   workbench-wide. Citation links emitted by the data-analyzer (`path:src/...#L<n>`
   for code-cross-references via lineage; `data-conn:<id>/...` for DB-
   target citations -- see §5.1 below) need to use the same conventions
   so they dispatch through the registered openers.

3. **`saveReport` rewrites custom URIs to `file://`.** The Code Analyzer's
   save command rewrites `path:` -> absolute `file://`. The Data
   Analyzer's saveReport must do the same for any path-style URIs in the
   saved markdown (lineage refs cite code).

4. **Slash autocomplete entry from day one.** Add `/data-analyze` to the
   slash registry (`shared/slash-commands.ts` + workbench mirror) in the
   first commit, NOT after the orchestrator ships. `/data-analyzer`
   (typo) is auto-handled by the existing fuzzy guard.

5. **Forced intent via slash override.** The intent slash dispatcher
   already routes `/<intent> <prompt>` through the classified-intent
   override path. Add `data-analysis` to the intent-shortcut set so
   `/data-analyze` works; users typing `/data-analysis` (the intent
   name) gets handled too via the typo guard.

6. **No per-task wall-clock caps.** The Code Analyzer originally had
   tier-conditional caps; live use revealed that local Ollama is slow on
   description-heavy tasks. Drop tier caps; keep only a generous safety
   upper bound (~10 min per task). Data analyzer connections can be
   slow too (production reads with row caps); same policy.

7. **Tolerant JSON parser.** Reuse the `stripFences` helper from
   `code-analyzer/analyzer/result-parser.ts` (extracts the first `{...}`
   span, ignores prose preamble). Don't write a fresh strict parser --
   the local model emits `"Let me read..."` preambles regardless of how
   strict the prompt is.

8. **Inline-citation directive in synthesise prompt.** When a tool
   surfaces an entity (table, column, key pattern), the synthesise prompt
   must instruct the writer to wrap the entity name as a clickable link
   when a citation exists, not just backticks.

9. **Checkpoint / resume.** Run-task / review / synthesise are framework
   Tasks running through `runControlledPipeline`; state is persisted via
   `TaskStateStore` so daemon restart resumes mid-run. Ensure the data-
   analyzer's controller threads `restoreState` / `buildResumeTask` /
   `afterResumeBootstrap` (mirroring the Code Analyzer's slice C).

10. **Connection-approval gates are session-scoped, not persisted.** Per
    design §7.3 -- and matches Code Analyzer's `fs-access` gate pattern.
    Track approvals in the session pool, not in any on-disk store.

11. **Plan task uses `kind: 'transform'` to avoid history bleed.** Per
    `project_context_history_framing` memo: the plan task's user prompt is
    self-contained (request + connection list); using `kind: 'llm'` would
    pull session L3a/L3b into the preamble. Today the framework-level
    framing fix (commit 9e099803c27) handles this for every consumer, but
    the data-analyzer's plan should still emit a self-contained prompt
    (no implicit reliance on session memory).

12. **Scope-tier classifier baked in from day one** (NOT deferred to a
    "Phase 5" the way it was for the Code Analyzer). The shipped
    `classifyScope` (`agent/classify/scope.ts`) is generic and ready to
    reuse; the cost of pre-wiring per-tier caps + prompt addenda in
    Phase 1 is far less than retrofitting them after broad-scope
    queries hit pain. See Phase 1.10 for the data-tier mapping.

12. **Daemon restart picks up Stage 1 / 2 fixes for free.** No special
    work; Node 22 / tree-sitter@0.25 are framework-level.

## File structure (target)

Files marked `[skills]` are owned by [data-analyzer-skills.md](./data-analyzer-skills.md);
files marked `[legacy]` stay until the skills-plan cutover lands.

```
src/insrc/
  shared/
    slash-commands.ts                     # /data-analyze entry
  daemon/
    controllers/
      data-analyzer-orchestrator.ts       # main controller; mirrors code-analyzer-orchestrator
    cross-agent/
      data-tools.ts                       # data:* registrations [legacy → skills-plan §9.2]
    db/
      index.ts                            # (deferred) +getSchemaFingerprint helper -- shared by both cache layers
    skills/
      built-ins/
        data.*.ts                         # [skills] every analytical skill (~80 files); see data-analyzer-skills.md
        data.synth.*.ts                   # [skills] synthesis renderers
        data.meta.*.ts                    # [skills] classify-question / select-scope / feasibility / calibrate
      registry.ts / index.ts              # [skills-core] registerSkill, runSkill, listSkills
    tools/
      builtins/
        data/
          lineage.ts                      # data_lineage tool (skill-wrapped via data.lineage.read-write-callsites)
          schema-drift.ts                 # data_schema-drift tool [legacy fast-path → skills-plan §4.1-§4.3]
        meta/
          describe-skill.ts               # [planned, skills-plan §7.1] catalog-detail tool for classify-question
        db/
          index.ts                        # registerDbTools (db_sql_* / db_kv_* / db_file_*; ~31 tools)
  agent/
    tasks/
      _shared/
        json-extract.ts                   # stripFences (shared with code-analyzer)
      data-analyzer/
        types.ts                          # DataAnalysisTask, DataAnalyzerResult, citation kinds
        prompts/
          plan.ts                         # buildPlanSystemPrompt + renderPlanUserMessage
          analyzer-system.ts              # HARD_RULES + tool list  [legacy: per-kind playbook strips at cutover]
          synthesise-multipass.ts         # outline + section + stitch
          review.ts                       # cloud reviewer system prompt
        analyzer/
          runner.ts                       # [legacy] inline tool loop → skills-plan §8.2 dispatcher rewrites
          result-parser.ts                # uses _shared/json-extract
          citations.ts                    # citation invariant validator [stays here post-cutover]
        access-gate.ts                    # connection-approval + sample-review gates
        cache.ts                          # per-task cache (outer); per-skill cache (inner) lands separately
        scope.ts                          # [legacy] sizing classifier → deletable when skills-plan §7.1/§7.2 land

src/vs/workbench/contrib/insrc/browser/
  data-analyzer/
    dataAnalysisReportPane.ts             # ephemeral pane (mirrors AnalysisReportPane)
    dataAnalysisReportInput.ts            # editor input
    dataAnalysisReportFlowContribution.ts # auto-open on first non-empty body
    dataAnalysisReportCommands.ts         # save / rerun / drillDown / clearCache / openReport
    dataCitationRenderer.ts               # RdbmsCitation / KvCitation / FileCitation visuals
    media/
      dataAnalysisReport.css              # theme-variable-only styles
  common/
    slashCommands.ts                      # workbench mirror of /data-analyze entry
  insrc.contribution.ts                   # register pane + flow contribution
```

`~/.insrc/data-analyzer/` (user-overridable prompts),
`~/.insrc/cache/data-analysis/` (per-task cache outer layer), and
`~/.insrc/cache/skills/` (per-skill cache inner layer; deferred per
skills-plan §10.2) are created on first run by the controller.

## Phase 0 -- Family registration + slash entry

**Smaller than CA's Phase 0.** Most of the framework wiring (todos
suppression, `updateItem(meta)`, ownership stamps) is now generic.

### 0.1 Register the `data-analyzer` family

- `src/insrc/shared/agent-registry.ts`: add `data-analyzer` to
  `AGENT_FAMILIES`. Mirror the entries the Code Analyzer added.
- `src/insrc/shared/types.ts`: ensure the `Intent` union already includes
  `data-analysis`. (It does; no change.)
- `src/insrc/daemon/todos-api.ts`: nothing to add -- `makeTodosApi(db, family)`
  is family-scoped; passing `'data-analyzer'` is enough.
- `src/insrc/agent/config.ts`: extend `buildDefaultAgentBindings(activeCloud)`
  to seed the four `data-analyzer` step keys
  (`plan` -> activeCloud, `analyzer` -> local, `review` -> activeCloud,
  `synthesise` -> local). Users see all four entries pre-populated in
  the Model Providers pane on first load and can rebind any of them
  per the LLM-routing table above.

### 0.2 Slash registry

- `src/insrc/shared/slash-commands.ts`: add `data-analyze` entry alongside
  `code-analyze`.
- `src/vs/workbench/contrib/insrc/common/slashCommands.ts`: mirror.
- The intent dispatcher (commit f0fb6fd18a1) already handles `/data-analyze`
  if `data-analysis` is in the `INTENT_SLASH_NAMES` set -- but slug
  conversion `data-analyze` -> `data-analysis` needs a `slashIdToIntent`
  branch.

### 0.3 Suppress comment affordance for data-analyzer-owned lists

Mirror code-analyzer Phase 0.3: the todos pane reads
`list.meta.suppressComments: true` to hide the per-item comment
affordance. Set this when the controller creates the list.

### Phase 0 acceptance

- `/data-analyze` appears in the chat input's `/` autocomplete.
- `/data-analyzer` (typo) emits "did you mean `/data-analyze`".
- Typing `/data-analyze foo` reaches a stub controller that logs and exits
  cleanly (the controller doesn't have to do real work yet).

## Phase 1 -- Core orchestrator + analyzer loop (Flow 1 only)

The bulk of the implementation. Mirrors code-analyzer Phase 1 + 5.B
(per-tier playbook from the start, since we know we'll need it).

### 1.1 Types -- `agent/tasks/data-analyzer/types.ts`

```ts
export type DataAnalysisKind =
  | 'inspect-schema'   // describe a table / collection / key pattern
  | 'sample-data'      // pull rows / values for shape + content review
  | 'sample-shape'     // KV / document inferShape over many values
  | 'lineage'          // cross-link table to code that reads / writes it
  | 'schema-drift'     // expected (code / Prisma) vs live shape
  | 'er'               // ER topology over a set of tables
  | 'free-form';

export interface DataAnalysisTask {
  itemId: string;
  kind: DataAnalysisKind;
  question: string;
  scope?: {
    connections?: string[];
    targets?: string[];
  };
  hint?: string;
  origin: 'plan' | 'follow-up';
}

// Citation kinds. The synthesise prompt and renderer branch on `kind`.
export type DataCitation =
  | RdbmsCitation
  | KvCitation
  | FileCitation;

export interface RdbmsCitation {
  kind: 'rdbms';
  connectionId: string;
  schema?: string;
  table: string;
  column?: string;
  sampleValue?: string;   // truncated to 1KB
  introspectionVersion?: string;
}

export interface KvCitation {
  kind: 'kv';
  connectionId: string;
  keyPattern: string;
  fieldPath?: string;     // for document stores
  sampleValue?: string;
}

export interface FileCitation {
  kind: 'file';
  // For Prisma schema / ORM model citations. Lineage findings
  // also produce path: code-citations -- those use the code-analyzer's
  // CodeCitation shape; renderer dispatches on a discriminator.
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface DataFinding {
  concern: 'schema-drift' | 'pii-exposure' | 'lineage-gap' | 'consistency' | 'capacity-risk';
  severity: 'info' | 'warn' | 'error';
  issue: string;
  citations: DataCitation[];
}

export interface DataAnalyzerResult {
  itemId: string;
  answer: string;
  findings: DataFinding[];
  citations: DataCitation[];
  confidence: 'high' | 'medium' | 'low';
  toolCalls: ToolCallSummary[];
  truncated: boolean;
  // Set when the task was blocked by a gate decision.
  blockedReason?: 'connection-denied' | 'pii-gate-denied' | 'no-connections';
}
```

### 1.2 Orchestrator controller -- `daemon/controllers/data-analyzer-orchestrator.ts`

Mirror `code-analyzer-orchestrator.ts`. Key differences:

- Phase enum: `'planning' | 'plan-approval' | 'analyzing' | 'reviewing' | 'synthesising' | 'present' | 'done'`.
- `K_STATE` carries the user request, the scope tier, the resolved
  `connections` list (from `data:list-connections` at startup), and the
  per-session `approvedConnections: Set<string>`.
- `buildInitialTasks` returns the plan LLM task. **Use `kind: 'llm'`** with
  the framework-level history-framing fix; the plan prompt still must be
  self-contained (request + connection list summary in the userMessage).
- `restoreState`, `buildResumeTask`, `afterResumeBootstrap` mirror
  code-analyzer's slice-C resume pattern. Connection approvals are
  cleared on resume per design §14.

### 1.3 Prompts (bundled defaults, user-overridable)

- `prompts/plan.ts`: `buildPlanSystemPrompt(tier)` + `renderPlanUserMessage(request, connections, tier)`. The plan instructs the cloud LLM to emit `DataAnalysisTask[]` from the user's free-form question and the available connections.
- `prompts/analyzer-system.ts`: `HARD_RULES` + per-kind playbook + tool list + `DataAnalyzerResult` schema. Mirror code-analyzer rule structure: vector / graph / sample are pointers, not answers; every claim resolves to a citation; closed tool list; bounded loop (8 calls / 10 min); SUBMIT VIA TOOL CALL not text.
- `prompts/synthesise-multipass.ts`: outline + per-section + stitch using `agent/content-gen/`. Citation format directive: `[<short label>](path:src/foo.ts#L42-L58)` for code-cross-refs (lineage findings), `[<connection>:<table>](data-conn:<connectionId>/<schema>/<table>)` for DB targets (see 1.7 below). Inline-citation directive: when an entity has a citation, wrap the name as a clickable link.
- `prompts/review.ts`: cloud reviewer system prompt. Decisions: `accept` / `retry-with-hint` / `add-follow-up` / `done`.

User overrides land in `~/.insrc/data-analyzer/<name>.md`; the loader
(`agent/tasks/data-analyzer/prompts/index.ts`) merges with the bundled
defaults the same way the Code Analyzer does.

### 1.4 Per-task runner -- `analyzer/runner.ts`

> **This section describes the shipped legacy runner (the inline tool
> loop) AND the planned cutover to skill dispatch.** The legacy runner
> stays compiled until skills-plan §8.2 lands; both code paths
> coexist during the transition. See skills-plan §8 for the full
> contract.

#### 1.4-legacy: shipped per-kind tool loop (current state)

`agent/tasks/data-analyzer/analyzer/runner.ts` runs an 8-call tool
loop per task with per-kind playbook nudges. Tool inventory uses the
shipped `db_*` builtins:

- `db_list_connections` -- enumerate registered connections
- `db_sql_describe` / `db_sql_sample` / `db_sql_explain` -- RDBMS
  (Prisma fast-path on describe when present per
  `daemon/db/drivers/rdbms-prisma.ts`)
- `db_kv_scan` / `db_kv_get` / `db_kv_sample_shape` -- KV
- `db_file_describe` / `db_file_sample` / `db_file_sample_shape` --
  file
- `submit_analysis` -- finishing tool returning a `DataAnalyzerResult`

Cross-agent `code:*` (and future `deploy:*`) are added in Phase 4 --
not part of Phase 1's inventory. Inline gates: connection-approval
before the first tool call against a not-yet-approved connection;
sample-review before `db_sql_sample` / `db_kv_get` / `db_file_sample`
on a `prod`-flagged connection whose result contains unmasked PII.
Result parser uses `stripFences` shared with code-analyzer via
`agent/tasks/_shared/json-extract.ts`.

This per-kind tool loop is the structural failure mode the skills
plan exists to fix (see "Why decompose?" in skills-plan): one
prompt switching behaviour by `task.kind` ends up with behaviour
leaking across kinds and an ever-growing tool list.

#### 1.4-skills: planned skill-dispatch runner (skills-plan §8.2)

Replaces the inline 8-call loop with a thin skill dispatcher:

```ts
// pseudocode -- full contract in skills-plan §8.2
async function runDataAnalyzerTask(
  task: DataAnalysisTask,
  session: Session,
  deps: RunnerDeps,
): Promise<DataAnalyzerResult> {
  // Routing already happened upstream:
  //   plan step → meta.classify-question → meta.select-scope → meta.feasibility-check
  // task.skillInvocation is the concrete (skillId, args) the planner emitted.
  const result = await runSkill(task.skillInvocation.skillId,
                                task.skillInvocation.args, deps);

  // Stream the resulting toolCalls as liveStep events (same transcript
  // pattern as today, sourced from the SkillResult).
  for (const tc of result.toolCalls) deps.liveStep(tc);

  // The existing JSON-parse retry / citations-invariant retry / runner-
  // confidence-downgrade now live in the registry's runSkill machinery
  // (skills-core 3.1 / 3.7) -- they apply to every skill, not just
  // data-analyzer skills.
  return adaptSkillResultToDataAnalyzerResult(result, task);
}
```

What stays here vs moves to skills:

| Concern | Where it lives after cutover |
|---|---|
| Tool inventory + per-kind playbooks | **gone** -- skills own their own preconditions + tool-call sequences |
| `submit_analysis` finishing tool | **gone** -- the skill's `SkillResult.value` is the typed answer |
| Connection-approval gate | stays here (inline before `runSkill`) -- it's a UX gate, not analyzer logic |
| Sample-review gate (PII on prod) | partly stays, partly skills-side -- the gate trigger lives in the runner; the PII detection moves into skills-plan §5e (`data.pii.detect-patterns.*`) which the gate consults |
| `stripFences` JSON parsing | moves into `runSkill` -- shared across every skill |
| Citations invariant | stays here (post-skill validation against `result.citations`); the skill fills citations into the `SkillResult` |
| Tool-error gate (Continue / Abort prompt) | moves into `runSkill` per skills-core 3.7 |

The legacy runner stays alongside until skills-plan §9.1 ships the
`DataAnalysisTask kind → default skill invocation` shim that
unifies cached-plan replay across the cutover.

### 1.5 Citations invariant -- `analyzer/citations.ts`

Mirror code-analyzer. Reject `findings.length > 0 && finding.citations.length === 0`. One retry, then accept-as-is with `confidence: 'low'`.

### 1.6 Connection-approval gate -- `access-gate.ts`

Reuse the code-analyzer's `AnalysisGateWidget` rendering (with `data-analyzer`-specific labels). Gate id: `connection-approval`. Per-connection approval cached in `session.approvedConnections`. Approve cascades; deny marks the task `blocked` with `meta.blockedReason: 'connection-denied'`.

### 1.7 Citation URI scheme -- `data-conn:`

DB-target citations need a click-to-navigate target. The `data-conn:` URI shape:

```
data-conn:<connectionId>/<schema?>/<table>?col=<column>&pk=<primaryKey>
```

A new opener (`dataAnalyzerConnUriOpener.ts`, mirrors `pathUriOpener.ts`) routes clicks to:

- Open the dbDrivers pane focused on the cited connection.
- Pre-populate the table query view with the cited row (when `pk` is known) or column.

For now, Phase 1 emits the URI but the opener clicks land on the dbDrivers pane top-level (table-focus is Phase 5 polish). The link is still useful as a navigation anchor.

### 1.8 Slash command -- direct dispatch

Mirror code-analyzer 1.8.a. `tryFamilyDirectSlash` already routes `/code-analyze`; add a `/data-analyze` branch that constructs `DataAnalyzerOrchestratorController`. The intent slash dispatcher (commit f0fb6fd18a1) handles `/data-analysis` (intent name) via the override path.

### 1.9 Checkpoint / resume foundation

Long XL+ data analyses (multi-table audits, lineage walks across many
modules) routinely run 5-15 min. A daemon restart, IDE reload, or
crash mid-run today would lose every accepted finding and re-fire all
the gates. The Code Analyzer hit this in production and added slice C
late (commits b230bcb94df + 1444234abe2); for the Data Analyzer we
land it in Phase 1 alongside the orchestrator -- the API surface is
small if you build it in from the start, and prohibitively expensive
to retrofit.

The pattern is the brainstorm-/code-analyzer-style **resume-bootstrap
marker**: after a daemon restart, the workbench re-issues the run
through a dedicated RPC; the daemon's controller receives a synthetic
"bootstrap" task whose output is a sentinel string; `next()` detects
the sentinel and dispatches into the right phase based on the
persisted `K_PHASE` instead of the bootstrap's own pseudo-phase.

#### 1.9.a Persisted state shape (orchestrator)

The controller writes the following keys into `TaskStateStore` as it
advances; the framework's `runControlledPipeline` persists the store
between tasks. Define them as named constants in the orchestrator:

```ts
const K_STATE         = 'state';            // CodeAnalysisState-equivalent
const K_PHASE         = 'phase';            // 'planning' | 'plan-approval' | ...
const K_RETRIES       = 'retries';          // Record<itemId, number>
const K_FOLLOWUP_COUNT= 'followup-count';   // total follow-ups added
const K_PLAN_RESULT   = 'plan-result';      // raw plan LLM output
const K_PLAN_TASKS    = 'plan-tasks';       // parsed DataAnalysisTask[]
const K_REVIEW_RESULT = 'review-result';    // raw review output
const K_SYNTH_RESULT  = 'synth-result';     // raw synthesise output
const K_ACCEPTED      = 'accepted';         // Array<{task, result}>
const K_HISTORY       = 'history';          // DataAnalyzerResult[]
const RESUME_BOOTSTRAP_MARKER = '__data_analyzer_resume_bootstrap__';
```

`K_STATE` carries the user request, scope tier, the resolved
connections list, and the listId. **It does NOT carry
`approvedConnections`** -- per design §14 those are session memory
only, re-prompted on resume. Persisting them would surprise users who
restart the IDE expecting the gate to re-confirm.

#### 1.9.b `restoreState(state: TaskStateStore)`

Hydrates the controller's instance fields from `K_STATE`. Mirrors
[code-analyzer-orchestrator.ts](../../src/insrc/daemon/controllers/code-analyzer-orchestrator.ts).
Called by the framework once at controller construction when
`deps.initialTasks` is non-empty (the resume entry path).

```ts
restoreState(state: TaskStateStore): void {
  const persisted = state.get<DataAnalysisState>(K_STATE);
  if (!persisted) return;
  this._request    = persisted.request;
  this._tier       = persisted.tier;
  this._listId     = persisted.listId;
  this._connections = persisted.connections;
  // approvedConnections deliberately NOT restored -- re-prompt on first use.
  this._approvedConnections = new Set();
}
```

#### 1.9.c `buildResumeTask(state)`

Returns a single pass-through transform task whose output is the
bootstrap marker. The framework runs this task before any real work,
giving `next()` a checkpoint to dispatch from.

```ts
buildResumeTask(state: TaskStateStore): Task {
  const phase = state.get<Phase>(K_PHASE) ?? 'planning';
  return {
    index: 0,
    description: `Resuming data analysis (phase: ${phase})...`,
    kind: 'transform',
    intent: 'data-analysis',
    passThrough: true,
    userMessage: RESUME_BOOTSTRAP_MARKER,
    outputFormat: 'text',
    persisted: false,
  };
}
```

#### 1.9.d `afterResumeBootstrap(state, phase)`

The orchestrator's `next()` checks the completed task's output for
`RESUME_BOOTSTRAP_MARKER` BEFORE the regular phase routing. If
matched, dispatch on the persisted `K_PHASE`:

| Phase at crash | Resume behaviour |
|---|---|
| `planning` | Re-fire the plan LLM task. The cloud reasoner sees the same request + connections; should produce an equivalent task list. |
| `plan-approval` | Re-render the plan-approval gate from `K_PLAN_TASKS`. User sees the same plan; can approve / trim / cancel. |
| `analyzing` | The current item (whichever `meta.status === 'in_progress'`) is reset to `pending`; the orchestrator re-enqueues it. Cache (Phase 2.4) absorbs the re-execution cost when the connection is unchanged. |
| `reviewing` | Re-fire the review for the most-recent in-progress finding. Reviewer sees the same finding, same history; deterministic re-decision. |
| `synthesising` | Re-fire synthesise from `K_ACCEPTED`. Multi-pass content-gen may regenerate sections; the section cache (`agent/content-gen/section.ts`) absorbs that cost when nothing changed. |
| `present` | Re-render the present gate from the synthesised body. |
| `done` | Finalise immediately -- emit done, no re-work. |

Every branch logs `{ phase, listId, action }` so post-crash forensics
have a clear signal.

#### 1.9.e `chat.resumeDataAnalysis` RPC handler (daemon)

Mirror `chatResumeCodeAnalysis` in `daemon/chat-handler.ts`:

```ts
export const chatResumeDataAnalysis: StreamHandler = async (params, send, signal) => {
  const { sessionId, repoPath } = params as { sessionId: string; repoPath: string };
  // 1. Resolve the session, find the most-recent active data-analyzer list.
  // 2. Construct DataAnalyzerOrchestratorController in resume mode.
  // 3. Call runControlledPipeline with deps.initialTasks = [buildResumeTask(state)].
  // 4. Pipe events back through `send` until done.
};
```

Register on the RPC server alongside `chat.resumeCodeAnalysis`. Same
streaming surface as the initial run path.

#### 1.9.f Workbench-side wiring

Two small additions:

1. `chatServiceImpl.ts` (electron-sandbox): add
   `resumeDataAnalysis(sessionId, repoPath)` opening the new RPC
   stream. Mirror of `resumeCodeAnalysis` from slice C.

2. `agentRunServiceImpl.ts` (electron-sandbox): the existing
   `resumeRun(controllerId, sessionId, repoPath)` already branches on
   `controllerId === 'code-analyzer'`. Add a parallel
   `'data-analyzer'` branch that calls `chatService.resumeDataAnalysis`
   instead of the generic `resumeFromCheckpoint`.

The Runs sidebar (already shipped) automatically lists data-analyzer
runs once the orchestrator stamps `controllerId: 'data-analyzer'` on
its TaskState. No new sidebar UI.

#### 1.9.g In-progress item reset

When the orchestrator advances a task to `in_progress` and the daemon
crashes before the result lands, the persisted item is left in
`in_progress`. On resume, scan `list.items` and reset any
`in_progress` items to `pending`. The runner then re-executes them;
the per-task cache (Phase 2.4) makes this cheap when the connection
is unchanged. Connection-approval gates re-fire because the session's
`approvedConnections` is empty after restoreState.

The reset happens once at resume entry, in `afterResumeBootstrap`'s
`analyzing` branch -- not on every `next()` call, to avoid trampling
items the controller is mid-transition on.

### 1.10 Question routing + sizing

> **This section describes the shipped legacy scope-tier classifier
> AND the planned cutover to skill-based routing.** The legacy
> classifier (`scope.ts` + per-tier prompt addenda) stays compiled
> until skills-plan §7.1 / §7.2 land; both code paths coexist during
> the transition.

#### 1.10-legacy: shipped scope-tier classifier (current state)

`agent/tasks/data-analyzer/scope.ts` runs `classifyScope` (the
shipped generic classifier in `agent/classify/scope.ts`) and clamps
the result to the data-altitude S/M/L/XL band. Each tier injects
prompt addenda into `plan.ts`, `analyzer-system.ts`, and
`synthesise-multipass.ts` to push the LLM toward the right altitude
of detail (per-column at S → connection-level at XL). Per-tier
soft/hard task caps gate plan approval + follow-up generation.

This shipped today and works for the existing per-kind tool-loop
runner; it's the routing layer the legacy runner consumes. The
mechanism leaks the same per-kind playbook problem the skills plan
exists to fix -- routing happens via prompt-string concatenation,
not via a typed contract -- so the cutover replaces it wholesale.

#### 1.10-skills: planned classify-question + select-scope (skills-plan §7.1 / §7.2)

`meta.classify-question` (skills-plan §7.1, design landed) replaces
the entire scope-tier classifier. Concretely:

| Legacy concept | Skill-based replacement |
|---|---|
| `ScopeSize` enum (S / M / L / XL) | `questionType` enum (`describe-schema` / `sample-data` / `profile-quality` / `compare-shapes` / `drift-analysis` / `lineage` / `sensitivity` / `timeseries` / `free-form`) |
| Per-tier prompt addenda in `plan.ts` / `analyzer-system.ts` / `synthesise-multipass.ts` | The catalog the LLM sees is already pre-feasibility-filtered + scoped to the question type; per-altitude prompt addenda are gone |
| `capsForTier(tier)` (soft / hard task caps) | `candidates.length` from classify-question is the natural plan-size signal; the gate stays here as a UX gate but reads off candidate count instead of tier label |
| `agent/tasks/data-analyzer/scope.ts` (`clampToDataAltitude`) | **deletable** when 7.1 lands; no tier label survives the cutover |
| `agent/classify/scope.ts` (the generic classifier) | Stays for code-analyzer's use; data-analyzer stops calling it |

`meta.select-scope` (skills-plan §7.2) takes the candidate list and
fills in concrete `(connectionId, target?, columns?)` per
invocation, codifying the 2026-04-30 lesson that ambiguous question
scope must surface to the user instead of being silently defaulted.

#### Cutover plan

When skills-plan §7.1 + §7.2 ship:

1. **Replace, don't coexist.** The plan recommendation is to delete
   `scope.ts` + the per-tier prompt addenda outright once the new
   routing path is wired through the orchestrator. Keeping two
   routing paths during the §8 cutover risks divergence (the legacy
   path would have to learn the new `questionType` enum to keep
   prompts consistent across runs).
2. **Keep the plan-size approval gate**, but reading off
   `candidates.length` from classify-question's output instead of
   `capsForTier(tier)`. UX is identical; signal is cleaner.
3. **The four prompts** (`plan.ts`, `analyzer-system.ts`,
   `synthesise-multipass.ts`, `review.ts`) keep their non-tier
   bodies. The `tier`-conditional addenda at the bottom of each get
   deleted; the catalog the planner sees comes from
   classify-question's output.

### Phase 1 acceptance

- `/data-analyze list pii columns in production` runs end-to-end.
- Connection-approval gate fires once per connection per session, then no further blocking on the same connection.
- Plan task names appear in the todos pane.
- Each task's result is cached (Phase 1 cache is in-memory only; on-disk is Phase 2.4).
- Final report renders to a stub pane (Phase 2 ships the real one). For Phase 1 the report can dump to chat as markdown.
- Re-running the same query in the same session hits the in-memory cache (instantly returns).
- **Resume from each phase boundary works.** Kill the IDE during planning / analyzing / reviewing / synthesising / present; reopen; daemon picks up where it left off. No phase double-executes; no completed task re-runs (cache absorbs in-progress reruns when connections are unchanged).
- **Connection approvals re-prompt cleanly on resume.** Approving a connection in the original run does NOT carry over -- the gate fires again on first connection use after restart.
- **Cancellation persists.** Cancelling mid-run leaves `cancelled: true` in `K_STATE`; resume sees the cancel and finalises immediately rather than re-running.
- **Per-step provider rebind works.** Rebinding `data-analyzer.synthesise` to a cloud provider in the Model Providers pane causes synthesise to issue against that cloud on the next run. Rebinding `data-analyzer.analyzer` to local is a no-op (default). Bindings persist across daemon restart.
- **Cloud-unavailable fall-back.** With the cloud provider key cleared, `/data-analyze` still completes -- plan + review fall back to local with a warning banner; the final report carries `provenance: 'local-only'` in its metadata.
- **Scope tier classifies correctly + caps apply.** "describe the `email` column on `users`" classifies as S; "audit primary for drift" classifies as L; "find drift across all connections" classifies as XL. The plan-approval gate offers a "trim to softTaskCap" action when the planner emits more tasks than the soft cap. XXL+ classification is clamped to XL.
- **Per-tier prompt addenda land.** Plan output for an S query is 1-2 tasks; for XL it's connection-level rather than table-level. The same query at different tiers produces different plans (verifiable in the daemon log's plan task list).

## Phase 2 -- Analysis Report Pane + feedback + caching

Mirror code-analyzer Phase 2.

### 2.1 `DataAnalysisReportPane`

Ephemeral, single tab per session. `media/dataAnalysisReport.css` uses
only theme variables. The pane reuses `InsrcEditorPaneBase` and
`MarkdownRenderer` -- the standard MarkdownRenderer's actionHandler
already routes through `IOpenerService`, which picks up our `path:`
opener (already shipped) and the new `data-conn:` opener (1.7) for
free.

Save... button reuses the code-analyzer's `saveReport` path-rewrite logic.
Factor out a shared `rewriteCustomUrisForSave(body, repoRoot)` helper so
the data-analyzer benefits from the same `path:` -> `file://` rewrite
the code-analyzer has.

### 2.2 Annotation manager -- `annotationManager.ts`

If reused (the code-analyzer's annotation manager is generic). For data-
analyzer, "annotate then send-to-chat" means the user can highlight a
finding in the report pane and the workflow batches the highlights into a
chat message.

### 2.3 Mid-flight cancel gate

Reuse the code-analyzer's `mid-flight-cancel` gate verbatim. Wires through
the orchestrator's `abortController`.

### 2.4 Per-task caching (outer layer) -- `cache.ts`

On-disk cache at `~/.insrc/cache/data-analysis/`. **Outer cache
layer** -- sits above the per-skill cache (skills-plan §10.2,
deferred) which lives at `~/.insrc/cache/skills/`. Both layers
coexist by design once §10.2 lands:

```
runDataAnalyzerTask(task) →
   per-task cache lookup (this layer, key = question + scope + roster fingerprint)
   ├─ HIT  → return cached SkillResult; no skill execution
   └─ MISS → runSkill(task.skillInvocation) →
                per-skill cache lookup (skills-plan §10.2,
                  key = skill.id + skill.version + canonicalised args)
                ├─ HIT  → return cached SkillResult; no tool calls
                └─ MISS → execute skill tool calls; populate both layers
```

Per-task cache key (per design §14):

```
SHA256(task.question + normalize(scope) + connection-version)
```

Where `connection-version` is a small fingerprint per connection:

- **RDBMS**: hash of the `db_sql_describe` result for the cited
  table(s).
- **KV**: hash of the `db_kv_sample_shape` result merged from a fixed
  sample size (50 values).
- **File**: hash of the `db_file_describe` result.

**Driver gap (still open)**: there is no centralised
`getSchemaFingerprint(connectionId, target)` helper. Per-driver
`describe()` returns a `SchemaDescription`, but no shared pipeline
canonicalises + hashes it. The shipped cache module
(`agent/tasks/data-analyzer/cache.ts`) uses a roster-level stand-in
via `buildConnectionFingerprint` -- the cache invalidates on roster
changes but NOT on schema drift against an unchanged connection.
**This gap is now shared with the per-skill cache** (skills-plan
§10.2 needs the same helper to detect schema drift in skill input
fingerprints), so the proper helper benefits both layers when
landed:

```ts
// ~30 lines in daemon/db/index.ts -- shared between both cache layers
export async function getSchemaFingerprint(
  connectionId: string,
  target: string,
): Promise<string> {
  const desc = await describeAny(connectionId, target);
  // Canonicalise: sort columns by name, drop ordinals, drop
  // database-version metadata. Stable across DB engine restarts.
  return sha256(JSON.stringify(canonicaliseDescription(desc)));
}
```

When wired, the per-task cache + per-skill cache both call it lazily
on first lookup per (connection, target) and memoise per session;
recomputed when the session's `db_list_connections` emits a
connection-changed event.

**Invalidation scope**:

| Layer | Invalidates on |
|---|---|
| Per-task (this layer) | Question text change, scope change, roster change. With `getSchemaFingerprint` wired: also schema drift |
| Per-skill (skills-plan §10.2) | Skill version bump, skill arg change, connection-version change |

LRU at 200 entries on the per-task layer (matches code-analyzer's
policy). `dataAnalyzer.clearCache` clears both layers.
`data-conn:<id>` URIs in the rendered report do NOT invalidate
either layer (they're navigation anchors).

### Phase 2 acceptance

- Report renders in `DataAnalysisReportPane` after synthesise.
- Save... writes a self-contained markdown file under `docs/data-analysis/<slug>.md` with `path:` and `data-conn:` URIs rewritten so links work in stock VS Code markdown preview.
- Cache hit when re-running the same query against an unchanged connection.
- Cancel mid-run via Stop button cleanly stops the orchestrator without daemon restart.

## Phase 3 -- Lineage + drift (data-specific)

The first Data-Analyzer-distinctive phase. Lineage = cross-link DB
target to code that reads/writes it; drift = expected (Prisma / ORM /
static analysis) vs live introspection.

### 3.1 Lineage -- `data.lineage.read-write-callsites` skill

The shipped `daemon/tools/builtins/data/lineage.ts` tool stays as
the primitive; analyzer-facing logic lives in the
**`data.lineage.read-write-callsites` skill** (skills-plan §3.4,
shipped). The skill wraps the tool with a typed contract:

```
Input:  { connectionId, table }
Output: { readers: CodeCitation[], writers: CodeCitation[], ambiguous: CodeCitation[] }
```

Tool implementation (under the skill):

1. Take a `(connectionId, table)` pair.
2. Look up the connection's expected schema (Prisma fast-path /
   ORM model / none).
3. Query the LMDB Code Knowledge Graph for `CALLS` edges that
   mention the table name as a string literal or a typed
   identifier. v1 uses literal-name matching + keyword-near-literal
   classification (`insert` / `select` / `update` / `delete`
   tokens within 200 chars of the literal); ORM-write precedence
   when both write + read patterns match.
4. Return `{ readers, writers, ambiguous }`. Each entry is a code
   citation (path / line) plus per-match confidence
   (typed > literal > heuristic).

Lineage findings emit BOTH `DataCitation` (the table) AND code-
style `path:` citations (the call sites). Renderer shows both kinds
inline.

**ORM-typed identifier matching** (Prisma / TypeORM / Sequelize /
SQLAlchemy / Hibernate / ActiveRecord) is shipped at the tool layer
via call-pattern recognition (`.create(`, `.findOne(`, `.update_all(`,
etc.). The complementary type-resolved path (Prisma schema → model →
table mapping) is a follow-up that lands with skills-plan §3.3
(`data.code.orm.resolve-model`) when code-analyzer prerequisites
ship.

### 3.2 Schema drift -- `data:schema-drift` tool (legacy) → skills-plan §4.1-§4.3

`daemon/tools/builtins/data/schema-drift.ts` is the shipped legacy
tool (Prisma fast-path only). It diffs Prisma vs live RDBMS:

1. Resolve the expected shape for `(connectionId, table)` via the
   nearest `schema.prisma` to the file referencing the connection.
2. Resolve the live shape via `db_sql_describe`.
3. Diff: missing-column / extra-column / type-mismatch /
   nullable-mismatch / pk-changed / fk-changed.
4. Severity: extra-column = info; missing-column = error;
   type-mismatch = warn.

When the expected shape can't be resolved (non-Prisma connection,
or no schema.prisma found): the tool returns
`confidence: 'low'` with a "no static schema source found" note.

**Replacement (skills-plan §4.1 / §4.2 / §4.3)**: comprehensive
drift composites land as skills:

| Skill | ORM dialect |
|---|---|
| `data.drift.prisma-vs-live` | Prisma |
| `data.drift.typeorm-vs-live` | TypeORM |
| `data.drift.sqlalchemy-vs-live` | SQLAlchemy |

All three are deferred on Phase 3 code-binding skills
(`code.orm.resolve-model`, blocked on code-analyzer prerequisites).
Until those land:

- The shipped `data:schema-drift` tool stays as the only drift
  surface for Prisma users.
- Non-Prisma users see `confidence: 'low'` and a "drift detection
  for <orm> not yet shipped" note.

When the §4 composites land, `data:schema-drift` becomes a thin
shim that forwards to `data.drift.prisma-vs-live` (preserving
cross-agent + cached-plan back-compat per skills-plan §9.1).

### 3.3 ER artifact integration -- `synth.er-diagram` (skills-plan §6.4 deferred)

Currently shipped: orchestrator's `_appendErArtifactSection` walks
accepted tasks for `kind === 'er'`, invokes `artifact_er` per
(connection, tables) group, appends a "## ER Diagrams" section to
the report.

**Replacement (skills-plan §6.4)**: `data.synth.er-diagram` skill
takes the cross-table topology output from §4's drift composites
and renders a Mermaid ER diagram via the existing `artifact_er`
infrastructure. Currently deferred because §6.4 composes §4's
output, which is itself deferred on Phase 3 code-binding.

Until §6.4 lands, the inline integration stays. Cutover plan: when
§6.4 ships, the orchestrator stops calling `_appendErArtifactSection`
inline; the skill's output is rendered into the report by the
generic synth-renderer pipeline (`data.synth.scorecard` + others
already follow this pattern).

### Phase 3 acceptance

- `data:lineage` returns readers / writers for at least the demo project's
  tables.
- `data:schema-drift` reports drift on a deliberately-mismatched
  Prisma-vs-live table (test fixture).
- ER artifact renders alongside a multi-table audit run.
- Lineage findings link both to the table (`data-conn:` URI) and to the
  call site (`path:` URI); both navigate.

## Phase 4 -- Cross-agent integration (Flow 2)

Mirror code-analyzer Phase 3.

### 4.1 Cross-agent surface -- `data:*` (legacy) → skill cross-calls

> **Shipped**: `daemon/cross-agent/data-tools.ts` registers the
> `data:*` wrapper set below. **Cutover planned**: skills-plan §9.2
> migrates cross-agent calls to direct `runSkill('data.X', ...)`
> invocations under the cross-owner depth cap; the wrappers stay as
> legacy shims until telemetry shows zero non-shim callers.

Shipped `data:*` tool registrations (in
`daemon/cross-agent/data-tools.ts`, mirror of the shipped
`daemon/cross-agent/code-tools.ts`):

- `data:list-connections`  -- thin wrapper over `db_list_connections`
- `data:describe-table`    -- routes RDBMS / KV / file family via
                              the connection's family
- `data:sample`            -- routes to `db_sql_sample` /
                              `db_kv_get` / `db_file_sample`
- `data:scan`              -- thin wrapper over `db_kv_scan`
- `data:get`               -- thin wrapper over `db_kv_get`
- `data:sample-shape`      -- routes to `db_kv_sample_shape` /
                              `db_file_sample_shape`
- `data:explain`           -- thin wrapper over `db_sql_explain`
- `data:lineage`           -- analyzer-native (wraps the Phase 3.1
                              `data_lineage` tool / `data.lineage.read-
                              write-callsites` skill)
- `data:schema-drift`      -- analyzer-native (wraps the Phase 3.2
                              tool; will forward to `data.drift.*-vs-
                              live` skills when §4 composites land)
- `data:analyze`           -- Flow 2 entry (Phase 4.3)

Registration is wired into `daemon/index.ts` alongside the
existing `registerCodeAnalyzerCrossAgentTools()` call, gated on
`insrc.analyzers.enabled`.

**Why the wrappers exist (legacy rationale)**: (a) the design's
documented cross-agent namespace is `data:*` not `db_*`; (b) some
calls dispatch over the connection family at the cross-agent layer
so callers don't need to know whether a target is RDBMS / KV /
file; (c) `lineage`, `schema-drift`, and `analyze` have no
driver-level equivalent.

**Cutover plan (skills-plan §9.2)**: code-analyzer + deploy-
analyzer invocations migrate from `data:*` tool calls to
`runSkill('data.X.<variant>', args)` via the cross-owner depth-cap
mechanism the registry already enforces. Each `data:*` wrapper
becomes a back-compat shim that internally forwards to the
matching skill, so existing cross-agent callers keep working.
Deletion gated on telemetry showing zero non-shim callers; until
then, both surfaces coexist.

### 4.2 Wire `code:*` and `deploy:*` into the data-analyzer's tool list

When `code-analyzer` is registered, the data-analyzer's runner gains
`code:locate`, `code:trace`, `code:describe`, `code:analyze` in the tool
inventory. The lineage tool (3.1) implementation can then call
`code:trace` for higher-precision call-site detection. Same gating
(`insrc.analyzers.enabled` config); same `TOOL_UNAVAILABLE` sentinel;
same single-hop depth cap.

When `code-analyzer` is NOT registered, the data-analyzer's lineage tool
falls back to the in-process Code KG Cypher query (still works, just
without the analyzer's deeper signals). The fall-through path matters --
the design's hard requirement is "removing the Code Analyzer doesn't
break the Data Analyzer".

### 4.3 `data:analyze` Flow 2 entry

The orchestrator exposes a `data:analyze(tasks, depth)` cross-agent tool
matching design §13.5. Skips the plan step; runs / reviews / synthesises
the supplied task list; returns the report inline. Connection-approval
gates still fire (Flow 2 doesn't bypass user consent).

### 4.4 `@mention` family routing

The chat-handler's `parseAnalyzerMention` already returns `data-analyzer`
as a recognised family but currently emits a "not yet registered"
message. Wire the `data-analyzer` branch to call `runDataAnalyzerSlash`
the same way `code-analyzer` does.

### Phase 4 acceptance

- A `code-analyze` run that surfaces a query against a table can call
  `data:lineage` and embed the schema-drift finding in its report.
- A `data-analyze` run can call `code:trace` to enrich its lineage
  finding.
- `@data-analyzer` mention routes to the data-analyzer.
- Single-hop depth cap holds: `data:analyze` invoked from a `code:analyze`
  cannot itself invoke `code:analyze` (registry rejects).

## Phase 5 -- Polish

Mirror code-analyzer Phase 4 + Phase 5.D (drill-down).

### 5.1 Re-run with new connection-version

`insrc.dataAnalyzer.rerun` command on a past report. Skips the plan step
and reconstructs the `DataAnalysisTask[]` from the prior list's items.
`parentListId` threads the relationship.

### 5.2 Diff-vs-previous-run

`insrc.dataAnalyzer.diffWithPrevious` -- compare the current report's
findings against the most-recent prior run (from the same query slug).
Ideal for "did the schema change since last audit?" questions.

### 5.3 Drill-down chain

Mirror code-analyzer Phase 5.D. The synthesise prompt's drill-down footer
becomes clickable buttons in the pane; each button fires
`insrc.dataAnalyzer.drillDown` with the parent list id stamped.

### 5.4 Export to file

Already in Phase 2.1's saveReport path; this slice adds discoverability
(palette command + Report Pane button) and a `lastSavedAt` annotation on
the list `meta`.

### 5.5 PII detection -- skills-plan §5e (shipped)

The original §5.5 design (per-repo `<repo>/.insrc/data-analyzer/pii.json`
loader merged with a bundled pattern library) is **superseded by
the shipped §5e skill family**. The replacement surface:

- **`data.pii.detect-patterns.{rdbms, file, kv}`** -- anchored regex
  catalog (email / ssn-us / phone-us / credit-card / jwt / ipv4 /
  iban / aws-access-key / github-token / uuid). Each variant walks
  the connection family's sample surface (rows / files / scanned
  values) and runs the same catalog.

- **`data.pii.column-classifier.rdbms`** -- composite combining
  `detect-patterns` with a 14-rule column-name heuristic to return
  `pii / likely-pii / not-pii` per column with explicit
  `evidence` strings. Surfaces both data-leak (PII values, generic
  name) and missing-data (named-PII column, empty sample) cases
  per the 2026-04-30 lessons-learned fix.

- **`data.sensitivity.policy-check.rdbms`** -- composite over
  `column-classifier` that cross-references caller-supplied
  `declaredPiiColumns` against detected. Verdict ladder:
  `conformant` / `mismatch` / `gaps` (security-relevant signal).

**Per-repo pattern overrides** are deferred as a follow-up to
`data.pii.detect-patterns.*` -- caller passes
`extraPatterns: [{ name, regex, severity }]` per invocation. The
`<repo>/.insrc/data-analyzer/pii.json` file format remains a
plausible config surface if a real user case justifies it; tracked
under skills-plan §5e (open follow-up to 5e.1).

### 5.6 `data-conn:` opener -- table focus

Phase 1 ships the URI scheme; Phase 5 wires the click handler to focus
the dbDrivers pane on the cited table (and if a `pk=` query param is
present, run a single-row fetch).

### Phase 5 acceptance

- "Re-run" on a past audit completes in < 5s when nothing has changed
  (cache hits across the board).
- Diff mode highlights additions / removals between two runs against the
  same query slug.
- Drill-down candidate buttons fire correctly and stamp parent edges.
- `data-conn:` clicks open dbDrivers focused on the table.

## Out of scope

- Recursive cross-agent calls (single-hop only; per design).
- Statistical PII inference. Pattern-based only.
- Real-time schema-change watching. Drift is on-demand.
- Multi-connection joins.

## Test scripts

```
scripts/test-data-analyzer-smoke.sh         # /data-analyze against a sqlite fixture
scripts/test-data-analyzer-pii.sh           # sample-review gate + PII pattern hits
scripts/test-data-analyzer-drift.sh         # Prisma-vs-live mismatch fixture
scripts/test-data-analyzer-lineage.sh       # cross-link demo project's table to code
scripts/test-data-analyzer-cross-agent.sh   # data:analyze Flow 2 from code-analyzer
```

Fixtures live under `scripts/fixtures/data-analyzer/` -- a small sqlite
DB with deliberate Prisma drift, a KV fixture (sqlite as KV via
key/value table) with shape inconsistency, and a Prisma schema referencing
a connection registered in the test config.

## Telemetry / logging

Use existing `getLogger('data-analyzer:orchestrator')`,
`data-analyzer:runner`, `data-analyzer:cache`, `data-analyzer:lineage`,
`data-analyzer:drift` namespaces. Match code-analyzer's level + payload
conventions (item id, decision, queueRemaining, retryCount). Cache
operations log key prefix only (privacy -- connection ids may be
sensitive).

## Build / commit notes

- Build with `bash scripts/build.sh` (heap-pinned, logged) per
  `feedback_build_command` memo.
- Phase commits are atomic per slice (slice = subsection of a Phase).
  Bundling phases together makes review impossible; the Code Analyzer's
  history shows that one-slice-one-commit works.
- After each Phase, push so `~/.insrc/daemon/` picks it up on next IDE
  restart (Stage 1 / 2 deploy mechanism).

## Open risks (revisit at each phase boundary)

- **`data-conn:` URI opener depth.** Phase 1 ships it as a navigation
  anchor only; Phase 5 wires the row-focus. If the dbDrivers pane API
  doesn't expose a "focus this table at this PK" call, Phase 5 may
  require a small dbDrivers extension.
- **Prisma schema discovery.** Repos often have multiple Prisma schemas
  (monorepos). The schema-drift tool needs to pick the right one for a
  given connection. Heuristic: nearest `schema.prisma` to the file that
  references the connection. May need user-side config.
- **Connection-version invalidation cost.** `getSchemaFingerprint` may
  itself be a non-trivial DB call. If it dominates cache-hit latency,
  cache the fingerprint per session and invalidate on user-driven
  refresh-connection events.
- **PII pattern library over-firing.** Production samples with many
  legitimate emails (e.g. an audit log) will trigger sample-review on
  every page. Phase 2 should make the gate's "approve once for this
  table" affordance prominent.
- **Cross-agent fan-out token cost.** Lineage findings often lead to
  three or four `code:trace` calls per table. The single-hop cap
  prevents recursion, but a busy lineage task can still rack up cloud
  token spend. Add per-task tool-call budget (separate from wall-clock)
  if real usage shows runaway costs.

## Sequencing recommendation

The original v1 ladder shipped:

```
Phase 0  ──>  Phase 1  ──>  Phase 2  ──>  Phase 3 (partial)  ──>  Phase 4  ──>  Phase 5
(family       (orchestrator (pane +       (lineage tool +        (cross-agent   (polish:
 + slash)      + legacy      cache,        Prisma drift            bidirectional) re-run,
                runner +     outer         fast-path; skills                       drill-
                report        layer)       wrap)                                    down)
                draft)
```

**Cutover ahead** (after skills-plan §7 + §8 land):

```
[shipped v1]  ──>  skills §7.1/§7.2  ──>  skills §8.1/§8.2/§8.3  ──>  skills §9
                   (classify +              (planner + per-task        (legacy DataAnalysisTask
                    select-scope            runner + reviewer            shim → cross-agent
                    replace                 use SkillResult              data:* shims forward
                    scope.ts)               instead of free-form)        to runSkill)
```

Per-cutover ordering (each step is a separate commit, smallest unit
that keeps the system green):

1. **Land `describe_skill` tool** (skills-plan §7.1 dependency).
2. **Land `meta.classify-question`** -- still wired to legacy
   runner; new path is logged but not consumed.
3. **Land `meta.select-scope`** -- same: logged, not consumed.
4. **Wire orchestrator to consume classify+select output** instead
   of `scope.ts`'s tier label. Delete `scope.ts` + per-tier prompt
   addenda in the same commit (they'd be dead code once the
   orchestrator stops calling them).
5. **Land skills-plan §8.2 per-task runner rewrite** -- runner
   becomes a `runSkill()` dispatcher. Legacy `analyzer/runner.ts`
   stays compiled but unused; gated removal in a follow-up commit
   once telemetry confirms zero callers.
6. **Land skills-plan §9.1 DataAnalysisTask shim** for cached-plan
   replay. Cache entries from before the cutover keep working.
7. **Land skills-plan §10.2 per-skill cache** as the inner layer
   below this plan's §2.4 per-task cache. Both layers active.
8. **Migrate `data:*` cross-agent wrappers** to forward to skill
   cross-calls (skills-plan §9.2). Wrappers stay as back-compat
   shims; deletion gated on telemetry showing zero non-shim
   callers.

**Don't** try to ship the per-task runner rewrite (step 5) before
classify-question + select-scope (steps 2-4) are wired in -- the
runner needs the new routing layer to call into. The order matters
because the plan-step prompt (`prompts/plan.ts`) currently emits
`DataAnalysisKind`-keyed tasks; it transitions to emitting
`SkillInvocation`-shaped tasks at step 4, and the runner has to
already know how to consume both shapes by step 5.

**Do** keep both code paths live during steps 2-3 so a regression
in classify-question doesn't break running flows. A feature flag
(`insrc.dataAnalyzer.skillsRouting`) gates the new path; default
off until step 4 wires it through.

## Future work (post v1)

- **Static query parsing for drift.** When the project has no Prisma /
  ORM, drift detection is weak. A separate plan
  (`plans/static-query-extraction.md`) would build expected shapes from
  SQL string literals and query-builder calls in the code.
- **Read-replica routing.** For prod connections, route `data:sample` /
  `data:scan` to a read replica when configured. Connection registry
  extension.
- **Schema-change watcher.** A daemon-side watcher that re-fingerprints
  registered connections on a schedule and surfaces drift findings as
  notifications.
