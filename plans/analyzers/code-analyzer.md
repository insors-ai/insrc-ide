# Plan: Code Analyzer Agent

Tracks implementation of the [Code Analyzer design](../../design/analyzers/code-analyzer.html). The Code Analyzer is the first of three sibling analyzer families (Code / Data / Deployment); this plan covers only Code. Sibling plans (`plans/analyzers/data-analyzer.md`, `plans/analyzers/deployment-analyzer.md`) will land alongside this one and inherit Phase 0's family-registry pattern.

The plan is structured to match the design doc's §16 phasing. Phase 0 lands shared framework prerequisites; phase 1 ships the new Code Analyzer family alongside the legacy `CodeAnalysisController` (legacy is a rollback safety net, not a long-term coexistence); phase 2 cuts routing over to the new family **and deletes the legacy controller**; phase 3 wires cross-agent integration; phase 4 adds polish.

## Related plans

- [todo-framework.md](../todo-framework.md) — load-bearing infrastructure. The analyzer rides on `TodoList` / `TodoItem` for plan storage, lifecycle, persistence, and live-progress UI. The two `TodosApi` extensions originally proposed for Phase 0 (`updateItem(meta)`, `cancel`) already shipped with the framework as `updateItemMeta` / `markCancelled` — see §0.2 below.
- [research/research-agent.md](../research/research-agent.md) — reminder of the boundary: `research` is the web/external-info family. The Code Analyzer is a separate top-level family, **not** a variant under `research`. Once phase 2 lands, the legacy `CodeAnalysisController` (currently classed under `research`) is deleted.
- [brainstorm/category-implementation.md](../brainstorm/category-implementation.md) — controller-pattern reference. The new orchestrator implements the same `TaskController` interface (`buildInitialTasks` / `next` / `finalize`) that brainstorm controllers use.
- [chat-implementation.md](../chat-implementation.md) — classifier intent + router touchpoints that need updating to point at the new family.

## Status

| Phase | Scope                                                                        | Status |
|-------|------------------------------------------------------------------------------|--------|
| 0     | Framework prerequisites — register family + pane widget (TodosApi already covers updateItemMeta/markCancelled) | done (0.1 `822b0348e2e` + 0.3 `2f0652c3440`; 0.2 no-op) |
| 1     | Core orchestrator + analyzer loop; gates; classifier routing (legacy kept)   | done (1.1 `a6fb4756b1b`, 1.3 `b425be90bcf`, 1.5 `cc615e6942a`, 1.4 `1621a82fcce`, framework `2e69644ed8a`, 1.2 `cc08185b711`, 1.8 `399c6e37bef`, 1.6 `05dd6c2b707`, 1.7 `95c8330df2e`) |
| 2     | Analysis Report Pane + annotate/batch-send + **legacy controller deletion**  | pending |
| 3     | Cross-agent integration (`code:*` registered, `data:*` / `deploy:*` wired)   | pending |
| 4     | Polish — repo-rev re-run, diff-vs-previous, optional `@mention` dispatch     | pending |

Stamp the commit hash next to each phase as it lands.

## Goals (short)

The full goal/non-goal list lives in [design §2](../../design/analyzers/code-analyzer.html#goals). For implementation purposes the load-bearing properties are:

1. **Orchestrator on cloud, Analyzer + synthesise on local.** Per-call routing flows through the existing `agent/router.ts` flat resolver — we register bindings, never invent routing rules.
2. **Citations invariant.** Every claim resolves to a `CodeCitation`; the analyzer's output JSON is rejected and retried (once) if any finding has `citations.length === 0`.
3. **Indexes are pointers, never answers.** Analyzer system prompt enforces this; reviewer rejects findings that lack a corresponding `fs.read` / `entity.summary` call.
4. **Single-hop cross-agent cap.** Strict `crossAgentDepth >= 1` rejection at the registry boundary.
5. **One analysis per session.** Second concurrent request is rejected with a notification, not queued.
6. **Resumable.** Crash mid-run rehydrates from the framework's LanceDB tables; in-flight items reset to `pending`.

## Non-goals (in this plan)

- Sibling analyzers (Data, Deployment). Phase 0 only registers `code-analyzer` in `AgentFamily`; the sibling families land with their own plans.
- Web research. Stays under `research`.
- Multi-repo federation beyond the active repo's `DEPENDS_ON` closure (architectural rule #3).
- A persistent global throttle on cross-agent dispatch tools (deferred per [§13.5](../../design/analyzers/code-analyzer.html#cross-flow2)).

## Prerequisites

| Prereq | State | Notes |
|--------|-------|-------|
| TODO framework Phases 1–8 | done | Already in tree (see [todo-framework.md](../todo-framework.md) status table). |
| `agent/router.ts` flat per-turn resolver | done | We register `codeAnalysis.{planner,reviewer,synthesiser,analyzer}` step bindings into the existing config map. |
| `InsrcEditorPaneBase` + `MarkdownWidget` | done | Reused by the Analysis Report Pane; no new pane base class needed. |
| `agent-registry.ts` exhaustiveness pattern | done | Phase 0 adds one row + one union member following the existing pattern. |

## File structure (target)

After Phase 2 (legacy gone, new family in place):

```
~/.insrc/code-analyzer/                 -- prompt assets (per-user, override-able)
  plan.md                               -- decomposition prompt        (cloud)
  review.md                             -- per-task review prompt      (cloud)
  synthesise.md                         -- final report prompt         (local)
  analyzer.md                           -- analyzer system prompt      (local)

docs/code-analysis/                     -- saved reports (artifact-save target)
  <slug>.md

src/insrc/shared/
  agent-registry.ts                     -- + 'code-analyzer' family row + union

src/insrc/daemon/controllers/
  code-analyzer-orchestrator.ts         -- new TaskController (replaces code-analysis.ts)

src/insrc/agent/tasks/code-analyzer/    -- new family module (renamed from code-analysis/)
  agent.ts                              -- AgentDefinition wiring (if step-based)
  types.ts                              -- AnalysisTask, AnalyzerResult, CodeCitation,
                                           Finding (ported from legacy types.ts +
                                           extended with explicit `citations` field),
                                           AnalysisItemMeta, ReviewerDecision, ...
  state.ts                              -- CodeAnalysisState + persistence helpers
  prompts/
    plan.ts                             -- buildPlanPrompt(request, repoSummary)
    review.ts                           -- buildReviewPrompt(task, result, history)
    synthesise.ts                       -- buildSynthesisPrompt(request, findings, plan)
    analyzer-system.ts                  -- buildAnalyzerSystemPrompt() — the §7.6
                                           hard-rules block injected into every task
  orchestrator/
    plan-step.ts
    plan-size-gate.ts
    review-step.ts
    synthesise-step.ts
    present-gate.ts
    termination.ts                      -- soft/hard cap enforcement (16/24, 8 follow-ups)
  analyzer/
    runner.ts                           -- per-task tool loop (8 calls, 60 s)
    tool-registry.ts                    -- closed tool list + AnalyzerToolContext wrapper
    citations.ts                        -- citation invariant validator + retry adapter
    result-parser.ts                    -- AnalyzerResult JSON parsing + schema check
  access-gate.ts                        -- session-scoped approved-dirs registry
  cache.ts                              -- per-task LRU keyed on (question + scope + repo-rev)
  cross-agent/                          -- Phase 3 only
    register-tools.ts                   -- code:locate / code:trace / code:analyze (Flow 2)
    enrich-handler.ts                   -- handles inbound data:* / deploy:* tool results
    depth-context.ts                    -- crossAgentDepth counter on run-task ctx

src/vs/workbench/contrib/insrc/browser/code-analyzer/
  analysisReportInput.ts                -- EditorInput (one per session)
  analysisReportPane.ts                 -- EditorPane subclass of InsrcEditorPaneBase
  annotationManager.ts                  -- pending-annotation state + send-to-chat composer
  analysisGateWidget.ts                 -- fs-access / mid-flight-cancel / present rendering
  index.ts                              -- registration + workbench contribution
```

Naming convention recap (per [design §3 callout](../../design/analyzers/code-analyzer.html#family)):

| Suffix              | Used for                                                           |
|---------------------|--------------------------------------------------------------------|
| `code-analyzer`     | family id, prompt-asset dir, browser folder, controller filename   |
| `code-analysis`     | classifier intent (kept) + saved-report dir + slug column          |
| `/code-analyze`     | slash command (verb form, sibling to `/data-analyze`/`/deploy-analyze`) |

The `code-analysis` intent name is preserved across the migration so existing classifier prompts keep working; only its routing target changes.

---

## Phase 0 — Framework prerequisites

Three small, self-contained changes that Phase 1 depends on. Each can ship as its own commit; together they're the smallest surface that makes the rest of the plan tractable.

### 0.1 Register the `code-analyzer` family

**File:** `src/insrc/shared/agent-registry.ts`

Add to the `AgentFamily` union, the `AGENT_REGISTRY` map, and the `_exhaustivenessCheck`:

```ts
export type AgentFamily =
  | 'chat'
  | 'implementation'
  | 'brainstorm'
  | 'designer'
  | 'planner'
  | 'tester'
  | 'research'
  | 'debugging'
  | 'deployment'
  | 'code-analyzer'      // NEW
  | 'system';

// inside AGENT_REGISTRY:
'code-analyzer': {
  id: 'code-analyzer',
  displayName: 'Code Analyzer',
  category: 'meta',                  // read-only investigation, no source mutation
  description:
    'Read-only structural / semantic analysis of the active repo. ' +
    'Cloud-orchestrated decomposition, local per-task tool loop, ' +
    'local synthesis. Independent of the research family (web).',
  icon: 'graph',
},

// inside _exhaustivenessCheck literal:
'code-analyzer': true,
```

**Acceptance:** `npm run precommit` passes; `isAgentFamily('code-analyzer')` is true; `AGENT_FAMILIES` includes the new id.

> Sibling families (`data-analyzer`, `deployment-analyzer`) land with their own plans; we deliberately do **not** add them in this phase. Adding one family per plan keeps each landing reviewable and avoids stranding registry rows for unimplemented controllers.

### 0.2 ~~Extend `TodosApi` with `updateItem(meta)` and `cancel`~~ — already in framework

**Status: no work required.** The design doc's §5.2 callout was correct at design time, but `TodosApi` ([shared/todos.ts:334-371](../../src/insrc/shared/todos.ts#L334-L371)) already exposes both methods under their conventional names:

| Plan-proposed name        | Existing framework name                         |
|---------------------------|-------------------------------------------------|
| `updateItem({ meta })`    | `updateItemMeta(itemId, meta)` (line 366)       |
| `cancel(itemId, reason)`  | `markCancelled(itemId)` (line 358)              |

`markCancelled` does **not** accept a reason argument because the `TodoItem` schema has no `cancelledReason` field (only `blockedReason`). Where the analyzer wants the reason persisted, it composes `markCancelled` with `updateItemMeta({ ...current.meta, cancelReason })`. We deliberately do **not** extend the framework signature here — per the project's "no premature abstractions" rule, two atomic primitives compose cleanly enough that a third is unjustified.

**Implications for downstream phases:**
- Phase 1 controller code uses `deps.todos.updateItemMeta(itemId, meta)` and `deps.todos.markCancelled(itemId)` directly.
- The `mid-flight-cancel` gate handler in §2.4 calls `markCancelled` with no reason; if telemetry on cancellation cause is wanted later, stash a `cancelReason: 'user-cancelled' | 'cap-hit' | 'reviewer-done'` field via `updateItemMeta` first.
- The smoke script `scripts/test-code-analyzer-phase0.ts` is no longer needed — the methods are already exercised by existing brainstorm/delegate consumers.

> **Design-doc follow-up:** the §5.2 "Proposed framework addition" callout in [design/analyzers/code-analyzer.html](../../design/analyzers/code-analyzer.html#todo-lifecycle) is now stale. Worth a one-line edit to "Already in framework — uses `updateItemMeta` + `markCancelled` directly" when convenient. Not blocking for implementation.

### 0.3 Suppress comment affordance for `code-analyzer`-owned lists

The Code Analyzer's lists hide the `+ Add comment` affordance because feedback flows through the Report Pane (per [design §5.3](../../design/analyzers/code-analyzer.html#todo-comments)).

**Implementation finding (deviation from design):** the design assumed `list.meta.suppressComments: true`, but `TodoList` has no `meta` field — only `TodoItem` does. Adding one to `TodoList` would touch the schema, DB serialisation, and RPC validators for a one-bit per-family policy. We instead express this as a family-level policy on `AgentFamilyMeta` — the rule is "all code-analyzer lists suppress", never list-by-list, so family-level fits cleanly and lives next to the family definition.

**Files:**
- `src/insrc/shared/agent-registry.ts` — add `suppressTodoComments?: boolean` field to `AgentFamilyMeta`; set `true` on the `code-analyzer` row.
- `src/vs/workbench/contrib/insrc/browser/shared/todosViewHelpers.ts` — add `suppressCommentsForList(list)` helper that mirrors the daemon-side policy (workbench keeps `TodoOwner = string` loose on purpose; doesn't import the daemon-side registry, so the mirror is a small `Set` of owners that need to be kept in sync).
- `src/vs/workbench/contrib/insrc/browser/todos/todosPane.ts` — pass the suppress flag from `_renderListCard` into `_renderItemRow`; gate `_appendAddCommentAffordance` on it. Existing comments still render — only the "+ Add comment" affordance is hidden.

**Acceptance:** brainstorm/delegate/etc lists render unchanged (still get the affordance); code-analyzer-owned lists render existing comments but no "+ Add comment" button. Confirmed visually + by precommit / IDE build green.

### Phase 0 acceptance summary

```
1. AgentFamily union includes 'code-analyzer'; build green.   ✓ (0.1 — 822b0348e2e)
2. TodosApi already exposes updateItemMeta + markCancelled.   ✓ (0.2 — no work needed)
3. todosListWidget honours list.meta.suppressComments: true.
4. Build via scripts/build.sh — heap-pinned; logged to /tmp.
5. Commit each independent piece.
```

---

## Phase 1 — Core orchestrator + analyzer loop (Flow 1 only)

End state: a user typing `/code-analyze <prompt>` (or hitting the classifier's `code-analysis` intent) reaches the new `CodeAnalyzerOrchestratorController`, the orchestrator decomposes via cloud LLM, the analyzer runs each task on the local LLM with the closed tool registry, the cloud reviewer accepts/retries/follows-up, the local synthesiser writes the report into `list.body`, the `present` gate fires and the user can save / copy / send-to-chat. The legacy `CodeAnalysisController` is **kept in tree as a rollback safety net** — Phase 2 deletes it.

### 1.1 Types — `src/insrc/agent/tasks/code-analyzer/types.ts`

Port `Finding` / `FindingSeverity` / `CodeAnalysisConcern` from the legacy `agent/tasks/code-analysis/types.ts` (extending `Finding` with an explicit `citations: CodeCitation[]` field), then add the new types:

```ts
export type AnalysisKind =
  | 'locate'
  | 'describe'
  | 'trace'
  | 'compare'
  | 'free-form';

export interface AnalysisTask {
  itemId:      string;
  kind:        AnalysisKind;
  question:    string;
  scope?:      { entityIds?: string[]; paths?: string[]; packages?: string[] };
  hint?:       string;
  origin:      'plan' | 'follow-up';
  retryCount:  number;
}

export interface CodeCitation {
  entityId?:  string;
  path:       string;
  lineStart?: number;
  lineEnd?:   number;
  snippet?:   string;                 // ≤ 200 chars
}

export interface AnalyzerResult {
  itemId:      string;
  answer:      string;
  findings:    Finding[];
  citations:   CodeCitation[];
  confidence:  'high' | 'medium' | 'low';
  toolCalls:   ToolCallSummary[];
  truncated?:  boolean;
}

export interface AnalysisItemMeta {
  kind:        AnalysisKind;
  scope?:      AnalysisTask['scope'];
  origin:      'plan' | 'follow-up';
  retryCount:  number;
  hint?:       string;
  // populated on completion:
  answer?:     string;
  findings?:   Finding[];
  citations?:  CodeCitation[];
  confidence?: 'high' | 'medium' | 'low';
  toolCalls?:  ToolCallSummary[];
  truncated?:  boolean;
  warning?:    string;                // malformed-JSON fallback (§15)
}

export type ReviewerDecision =
  | { decision: 'accept';          rationale: string }
  | { decision: 'retry-with-hint'; rationale: string; retryHint: string }
  | { decision: 'add-follow-up';   rationale: string; followUps: AnalysisTaskSeed[] }
  | { decision: 'done';            rationale: string };

export type AnalysisTaskSeed = Omit<AnalysisTask, 'itemId' | 'origin' | 'retryCount'>;

export interface CodeAnalysisState {
  request:        string;
  repoSummary:    RepoSummary;
  listId:         string;
  childListIds:   string[];
  currentItemId?: string;
  truncated:      boolean;
  cancelled:      boolean;
  approvedDirs:   string[];           // session-scoped, persisted with state
  finalReport?:   string;
  reportUri?:     string;
  presentedAt?:   number;
}
```

Use `import type` for type-only imports; deterministic ids per the existing `SHA256(repo+file+kind+name)` rule do not apply here (we use ULIDs from the framework).

### 1.2 Orchestrator controller — `src/insrc/daemon/controllers/code-analyzer-orchestrator.ts`

Implements `TaskController` (same shape as brainstorm controllers) with `buildInitialTasks` returning the `plan` step task; `next` driving the state machine; `finalize` returning the `present`-gate output.

Step order (see [design §6.1](../../design/analyzers/code-analyzer.html#orch-flow)):

```
plan → plan-size-approval (conditional) → run-task[i] → review-finding[i]
   ↺ (loop until queue empty / done / caps hit)
   → synthesise → present
```

Per-step `kind` envelope: `'llm' | 'rpc' | 'gate'` — same as brainstorm; daemon's `runControlledPipeline` drives without modification.

**Single-pane invariant:** the controller checks `session.activeAnalysisListId` on entry; if set and the referenced list is still active, reject with `{ error: 'analysis_in_progress', listId }` and the chat-handler surfaces a notification "an analysis is in progress — cancel it first" (per [§10 invariant](../../design/analyzers/code-analyzer.html#surfaces)).

### 1.3 Prompts (bundled defaults, user-overridable)

Each prompt has a build helper in `agent/tasks/code-analyzer/prompts/` and a default asset shipped under `~/.insrc/code-analyzer/`. The build helper resolves the asset (override → bundled), applies templating, and returns the message blob.

| Prompt asset       | Helper                                                  | Routing default                  |
|--------------------|---------------------------------------------------------|----------------------------------|
| `plan.md`          | `buildPlanPrompt(request, repoSummary)`                 | cloud (active provider default)  |
| `review.md`        | `buildReviewPrompt(task, result, history)`              | cloud                            |
| `synthesise.md`    | `buildSynthesisPrompt(request, findings, plan)`         | local (Ollama qwen3-coder)       |
| `analyzer.md`      | `buildAnalyzerSystemPrompt()`                           | local (re-injected per task)     |

The four prompt bodies are taken verbatim from [design §6.4](../../design/analyzers/code-analyzer.html#orch-prompts) and [§7.6](../../design/analyzers/code-analyzer.html#analyzer-system-prompt). Asset packaging follows the same install path the brainstorm prompt assets use (`~/.insrc/<family>/`); a one-shot install routine drops the bundled defaults if the directory is empty.

The four "hard rules" in `analyzer.md` are re-injected by `buildAnalyzerSystemPrompt` regardless of whether the user overrode the asset, per [design §7.6 closing paragraph](../../design/analyzers/code-analyzer.html#analyzer-system-prompt). Implementation: split `analyzer.md` into a `HARD_RULES` constant in code + a user-overridable per-kind playbook section read from the file.

### 1.4 Analyzer tool loop — `src/insrc/agent/tasks/code-analyzer/analyzer/runner.ts`

Reuses the existing investigate-style tool loop (the daemon's tool registry + executor + validator) wrapped by a new `AnalyzerToolContext` that:

1. Restricts the tool list to a closed set (per [design §7.2](../../design/analyzers/code-analyzer.html#analyzer-tools)):
   `graph.search`, `graph.neighbours`, `vector.search`, `text.grep`, `fs.read`, `fs.list`, `entity.summary`. (Cross-agent tools register in Phase 3.)
2. Enforces per-tool caps:
   - `fs.read` 512 KB / call, 2 MB cumulative / task
   - `text.grep` 200 lines
   - `graph.search` 50 entities
   - `graph.neighbours` depth ≤ 2 default
3. Prepends `/no_think` to the system prompt (qwen3-coder structured-tool-call requirement, per CLAUDE.md).
4. Hard-caps the loop at 8 tool calls and 60 s wall clock.

Returns the parsed `AnalyzerResult`. Result parsing (`result-parser.ts`) validates against the JSON schema in [design §7.6](../../design/analyzers/code-analyzer.html#analyzer-system-prompt); malformed JSON triggers one strict-JSON retry, then accept-with-`confidence: 'low'` per [§15](../../design/analyzers/code-analyzer.html#failure).

### 1.5 Citations invariant — `analyzer/citations.ts`

```ts
function validateCitations(result: AnalyzerResult):
  { ok: true; result: AnalyzerResult }
  | { ok: false; reason: 'no_citation_for_finding' }
{
  for (const finding of result.findings) {
    if (finding.citations.length === 0) return { ok: false, reason: 'no_citation_for_finding' };
  }
  return { ok: true, result };
}
```

Wired into `runner.ts`: invalid result → one retry with the prompt suffix "every finding must include at least one citation"; second invalid → accept with `confidence: 'low'` (per [§7.5 invariant](../../design/analyzers/code-analyzer.html#analyzer-citations)).

### 1.6 `fs-access` gate — `agent/tasks/code-analyzer/access-gate.ts`

Tracks an approved-directory set on `CodeAnalysisState.approvedDirs`. The active repo root and every directory under it are implicitly approved — checked via `path.resolve` + ancestor walk, no need to enumerate.

When a `fs.read` / `fs.list` / `text.grep` call carries a path not covered by any existing grant, the tool handler:

1. Computes the narrowest sensible parent directory (analyzer is prompted to pass `grant_path` explicitly; if missing, fall back to the path's `dirname`).
2. Suspends the tool call.
3. Fires `fs-access` gate on the chat panel + todos pane row with the requesting item id, the directory, and the analyzer's reason.
4. Actions: `approve` (cascade-add `grant_path` to `approvedDirs`), `approve-broader` (user-prompted ancestor; same cascade), `deny` (return `PermissionDenied` to the analyzer).
5. 5-min timeout defaults to `deny`.

While the gate is open, the todo item stays `in_progress` and the row shows a `⏸ waiting for directory approval` sub-row. `approvedDirs` is part of the persisted controller state, so a daemon crash mid-gate rehydrates the grant — the gate doesn't re-fire on resume (per [design §7.3 clarification](../../design/analyzers/code-analyzer.html#analyzer-scope)).

### 1.7 `present` gate

After `synthesise` writes `list.body`, `present` fires with actions `save` / `copy` / `send-to-chat` / `discard`. `save` writes `docs/code-analysis/<slug>.md` via the existing `artifact-save.ts`; `discard` calls `list.transfer('system')` for audit retention.

### 1.8 Routing the classifier intent + slash command

**Two-step rollout** so the legacy controller stays callable until Phase 2 deletes it:

#### 1.8.a Slash command — direct dispatch to new family

**Files:**
- `src/vs/workbench/contrib/insrc/browser/chat/slashCommands.ts` (or wherever slash commands register)
- Add `/code-analyze` → dispatches to `CodeAnalyzerOrchestratorController`, bypasses the classifier entirely.

This is the primary surface; the classifier path (1.8.b) is a fallback for unstructured chat.

#### 1.8.b Classifier intent — gated cutover

Default routing for the `code-analysis` intent:

- **Phase 1:** classifier still routes `code-analysis` intent to the legacy `CodeAnalysisController`; only `/code-analyze` reaches the new orchestrator. This gives us a one-phase soak before flipping the default.
- **Phase 2:** routing flips; `code-analysis` intent reaches the new orchestrator and the legacy controller is deleted.

This split lets us ship Phase 1 without forcing every existing `code-analysis` chat through brand-new code on day one.

**Files touched in Phase 1 (intent-routing only, no deletion):**
- `src/insrc/daemon/task.ts:1724-1726` — keep the existing `case 'code-analysis'` branch as is.
- `src/insrc/agent/router.ts:26,80` — `code-analysis` is currently in `NO_LLM`. Phase 1 introduces a new intent dispatch path for the slash command only; classifier routing is untouched.
- `src/insrc/agent/orchestrator/agent-router.ts:34,68,88` — `ORCHESTRATOR_INTENTS` still contains `'code-analysis'`; same as above, untouched in this phase.

### Phase 1 acceptance

```
1. /code-analyze <prompt> reaches the new orchestrator.
2. Plan step produces an AnalysisTask[] visible as TodoItems in the todos pane.
3. Plans ≤ 16 auto-proceed; > 16 fires plan-size-approval gate (approve / trim-to-16 / cancel).
4. Each task runs the analyzer tool loop; closed tool list enforced (hallucinated names error).
5. Citations invariant enforced + one retry on miss; second miss → confidence: 'low'.
6. Reviewer decisions (accept/retry/follow-up/done) drive the queue + meta updates correctly.
7. Synthesise produces Markdown into list.body.
8. present gate offers save/copy/send-to-chat/discard; save writes docs/code-analysis/<slug>.md.
9. fs-access gate fires once per out-of-repo parent; cascades to descendants in same session.
10. Crash mid-run + restart: in-progress item resets to pending; analysis resumes from there.
11. Single-pane invariant: starting a second analysis while one is active is rejected.
12. Legacy /code-analysis intent still works via the legacy controller (rollback path).
13. Smoke script: scripts/test-code-analyzer-flow1.ts (see "Test scripts" below).
14. scripts/build.sh green; npm run precommit green.
```

### Phase 1 follow-ups (validation findings)

Issues observed live during the first end-to-end `/code-analyze` exercise on the `insrc` repo (concurrent with an in-flight indexer cross-file-resolver pass). None are run-blocking — orchestrator's defensive try/catch + analyzer's fallback paths kept the run going — but each is worth a small follow-up commit. Not blocking Phase 2; track here so they don't get lost.

| # | Issue | Symptom | Fix sketch | Where |
|---|---|---|---|---|
| F1 | Local LLM produces prose, not strict JSON | Multiple `analyzer JSON parse failed; retrying once` warnings (level 40) on every analyzer task. Retry also fails. Fallback to prose-only result + `confidence: 'low'`. Observed prose openings: `"The src/cl..."`, `"Now let me..."`, `"Perfect! N..."` — all conversational. | Tighten the strict-JSON requirement in `prompts/analyzer-system.ts` (HARD_RULES section). Consider Ollama's structured-output / JSON-mode flag if available in the installed binding. As a backstop, the citations-invariant retry already adds a hint — do the same on parse failure. | **DONE in `c1ba017173a`** (HARD_RULES rule 5 = explicit strict-JSON; new `CompletionOpts.responseFormat: 'json'` plumbed through to Ollama's `format: 'json'` mode on both retry calls; retry hint names the three observed failure modes). Validate live: run `/code-analyze` and confirm the parse-failure warning rate drops. |
| F2 | 60s wall-clock cap fires under indexer-Kuzu contention | `analyzer hit wall-clock cap` at `iter: 5` (= ~12s/tool-call). Single shared Kuzu connection means tool calls (`graph_search` etc.) queue serially behind the indexer's resolver pass. | Either (a) raise the cap when the indexer queue is non-empty, (b) gate analyzer launch on indexer-idle, or (c) longer-term: open a second read-only Kuzu connection for analyzer/UI consumers (separate from the writer the indexer uses). | **DONE in `6afbd83d77e`** (option (c)) — `db/search.ts` kuzuQuery now hits `db.graphReader`, so `graph_search` / `graph_callers` / `graph_callees` no longer queue behind the indexer-held writer. F7's reader connection has the 30 s query-timeout guard for free. |
| F3 | `canTransitionItem` TypeError on undefined `from` status | Stack: `TypeError: Cannot read properties of undefined (reading 'includes') at canTransitionItem (shared/todos.js:38)`. Caught by orchestrator's try/catch around `markInProgress` / `markComplete` / `markCancelled`. Run continues but the markX call effectively didn't happen. | Framework hardening: 3-line null-coalesce in `canTransitionItem` — `STATE_TRANSITIONS[from] ?? []` so it returns `false` safely on unknown status. Also worth a defensive `getItem`-then-skip-if-missing wrapper in the orchestrator. | **DONE in `9dd5055a893`** (canTransitionItem null-coalesce) + `c9c4911b690` / `764c7877db9` (workbench iconForItemStatus refactored to Record dispatch with `?? Codicon.circleOutline` fallback). |
| F4 | Failure cascade: per-item retry budget × per-task wall clock = ~3 min/item | Same item retried analyzer-internal (1) + orchestrator-level via reviewer's `retry-with-hint` (up to 2 per item). Each retry burns up to 60s. Over a 16-task plan that's a lot of dead air when the local LLM is misbehaving. | After F1 lands this should self-resolve. As a guard: treat "fallback to prose-only" as a terminal signal — orchestrator skips the retry-with-hint path on items the analyzer already gave up on. | **DONE in `836569db170`** (runner stamps `proseOnlyFallback: true`; orchestrator's `afterReview` forces accept-with-low-confidence on `retry-with-hint` decisions when the previous outcome had that flag). F1 should reduce trigger frequency too. |
| F5 | `groupBy from-file` DELETE phase is N round-trips, not one UNWIND | After `c35b36ffa91` MERGE batched, the DELETE side is still 281 sequential queries (one per from-file). Same UNWIND pattern would collapse to ~1 batch. | Mirror the MERGE-side UNWIND batching for the DELETE side. Validated approach. | **DONE in `db104f61cc3`** (resolver rewrite uses UNWIND throughout for both DELETE and MERGE). |
| F6 | Validation environment: analyzer + indexer compete for single Kuzu connection | F2 root cause; surfaces during any concurrent indexer-running `/code-analyze` test. Not a bug per se, but inflates apparent latency for both. | Either run analyzer tests after `full index complete`, or fix the connection-pool architecture (F2(c)) -- which is exactly what F7 below proposes. | **DONE** alongside F2 (`6512d43f106` provisioned `db.graphReader`; `6afbd83d77e` cuts the analyzer's reads over to it). |
| F7 | Kuzu binding tuning (daemon-wide; surfaces during analyzer + resolver runs) | Default Kuzu config: single shared Connection, `numThreads = nproc` (32 here), `autoCheckpoint: true` with default threshold, no read-only side. Result: analyzer queues behind indexer (F2/F6), checkpoints fire mid-resolver causing disk-I/O bursts, intra-query worker contention via `futex_wait_queue`. | Apply at the `db/client.ts:33` construction site: see "Kuzu tuning" subsection below. | **DONE in `6512d43f106`** (autoCheckpoint:false + dual Connection + numThreads cap; explicit CHECKPOINT call in indexer/index.ts). |

All seven follow-ups are now landed (F1 + F2 + F3 + F4 + F5 + F6 + F7 done). The remaining Phase-1-adjacent open work is the Phase 2.1 Report Pane — explicitly out of scope here. Validate F1 / F2 / F4 with a fresh `/code-analyze` run on a non-trivially-indexed repo: parse-failure warnings should be rare, analyzer wall-clock should hold steady when the indexer is also running, and the retry-with-hint cascade should stop firing after a prose-only fallback.

#### Kuzu tuning (F7) -- daemon-wide

Applied at `db/client.ts` Database + Connection construction. Daemon-wide change, not analyzer-specific, but the analyzer's contention with the indexer is what surfaced the need.

**Tier 1 (definite wins, small surface):**

1. **Disable auto-checkpoint during ETL passes.**
   ```ts
   _kuzuDb = new kuzu.Database(PATHS.graph, /* bufferManagerSize */ undefined,
     /* enableCompression */ undefined, /* readOnly */ false,
     /* maxDBSize */ undefined,
     /* autoCheckpoint */ false,
     /* checkpointThreshold */ undefined,
   );
   ```
   Then explicitly run `await db.graph.query('CHECKPOINT')` at the end of an indexer pass (after Pass 1 + Pass 2 of the cross-file resolver complete). Stops mid-pass disk bursts. Optionally a periodic background checkpoint every N minutes when the queue is idle.

2. **Two Connections sharing one Database -- writer + reader.**
   ```ts
   import { cpus } from 'node:os';
   const KUZU_THREADS = Math.min(8, Math.floor(cpus().length / 2));

   const _writer = new kuzu.Connection(_kuzuDb, KUZU_THREADS);
   const _reader = new kuzu.Connection(_kuzuDb, KUZU_THREADS);
   _reader.setQueryTimeout(30_000);   // defensive cap on stuck reads
   ```
   `db.graph` (the existing handle) becomes `_writer` and is what the indexer + cross-file resolver use. A new `db.graphReader` exposes `_reader` and is what the analyzer's tool-call path + UI consumers (todos.subscribe, status RPCs) use. **Eliminates F2/F6 contention.**

   `numThreads` is capped at **`min(8, nproc/2)`** -- on this 32-CPU machine that resolves to 8; on a 4-CPU dev box it's 2. Caps internal worker contention without serialising any single query into uselessness. Default of `nproc` (32) was excessive for our serialized application-side workload and showed up as `futex_wait_queue` activity in the `/proc` thread sample during Pass 1.

**Tier 2 (worth measuring, not certain):**

3. **`enableCompression: false`** for the writer database. Cuts CPU per write. Increases disk size. Worth a smoke if write-heavy passes still feel slow after Tier 1.

**Tier 3 (cosmetic):**

4. **`setQueryTimeout(30_000)`** on the reader connection (above) -- defensive guardrail against runaway analyzer queries.

**What this does NOT replace:** the resolver architectural rewrite proposed during validation (eliminate per-row Kuzu calls, scope every MATCH by repo, use UNWIND batches throughout). Tuning sits on top of correct architecture, not as a substitute. The rewrite is its own plan-doc commit (TBD); F7 ships when the daemon's Database/Connection lifecycle gets a small refactor.

---

## Phase 2 — Analysis Report Pane + feedback + **legacy controller deletion**

### 2.1 `AnalysisReportPane` (ephemeral, single per session) — **DONE**

**Status:** landed.

**Files (as built):**
- `src/vs/workbench/contrib/insrc/browser/code-analyzer/analysisReportInput.ts` — extends the [`EphemeralEditorInput`](../../src/vs/workbench/contrib/insrc/browser/shared/ephemeralEditorInput.ts) base shipped in `17b67803889`. Resource URI is `file:///<userHome>/.insrc/tmp/code-analysis-report-<listId>.md`.
- `src/vs/workbench/contrib/insrc/browser/code-analyzer/analysisReportPane.ts` — renders `list.body` via `MarkdownRenderer`; subscribes to `IInsrcTodosService.onDidChangeList` for live `K/N items` status badge.
- `src/vs/workbench/contrib/insrc/browser/code-analyzer/codeAnalyzerFlowContribution.ts` — auto-opens the pane on `listUpdated` for any `code-analyzer`-owned list whose `body` just became non-empty. Deduplicated per `listId`; resets on chat-session change.
- `src/vs/workbench/contrib/insrc/browser/code-analyzer/codeAnalyzerCommands.ts` — `insrc.codeAnalyzer.openReport` command (palette + invocable from the todos pane kebab when 2.2 wires it up). Takes optional `{ listId }` argument.
- `src/vs/workbench/contrib/insrc/browser/code-analyzer/media/analysisReport.css` — every colour resolves through `var(--vscode-...)` tokens; no hex values.

**Deviations from this section's text (intentional):**

- **Keyed on `listId`, not `sessionId`.** Each `/code-analyze` run creates its own `TodoList`, so `listId` is the proper unit of work — this lets the user have multiple past reports open side-by-side and re-open a specific one via the kebab. `sessionId` is carried as a separate field on the input for surfaces that want to filter by session. (The plan text said "sessionId equality"; the per-analysis list architecture in Phase 1 made that read poorly.)
- **No editor serializer registered** for `AnalysisReportInput` — the pane is intentionally ephemeral per design §10.2. `list.body` survives in LanceDB; restoration goes through the `Open Report` command, not the workbench's standard tab-restorer. The orphan reconciler shipped in `17b67803889` cleans the backing file at next startup.

**Orchestrator changes** (`code-analyzer-orchestrator.ts`): the `presenting` phase + `afterPresentGate` + `emitGateActionFeedback` (the temporary "save / copy / send-to-chat / discard" gate that streamed the full markdown to the chat panel) is removed. `afterSynthesise` now writes `list.body`, emits a single-line "Report ready -- see the **Code Analysis Report** pane" delta, marks the session complete, and returns null. `finalize()` returns an empty string in the success path so the framework doesn't double-print on top of the delta. `Phase` union dropped `'presenting'`.

**Hard requirements (UX, validation feedback from Phase 1):**

1. **The synthesised report must NOT be rendered in the chat panel.** ✅ — `afterSynthesise` no longer streams `userMessage: report`; `finalize` returns `''`. Chat transcript gets only the one-line "Report ready" pointer.
2. **Markdown rendering must respect the active workbench theme.** ✅ — `MarkdownRenderer` handles code-fence syntax highlighting via the workbench tokenizer; surrounding chrome styles are CSS-variable-only in `media/analysisReport.css`.

### 2.2 Annotation manager — `annotationManager.ts`

DOM-state-only (no persistence — annotations don't survive window reload by design):

- Tracks `pendingAnnotations: Annotation[]` per pane instance.
- Each `Annotation` carries the selected text span (heading / paragraph / bullet / finding row), the user's comment text, and an inline 🔖 marker id.
- `Save` adds to the pending list + renders the inline marker.
- `Send all to chat` composes the batched chat message in the format from [design §10.3 step 4](../../design/analyzers/code-analyzer.html#surface-feedback) and posts via `IInsrcChatService.submit(message, { from: 'code-analysis-pane' })`. The `{ from }` field is a non-functional source tag (per [design §10.4 row](../../design/analyzers/code-analyzer.html#surface-infra)) — chat-service signature gains the optional field; no consumer branches on it today.
- `Clear annotations` empties the list + removes all 🔖 markers.

### 2.3 *Quote to chat now* — single-shot path

Floating button anchored to selection alongside *Annotate*; one click composes a single-quote chat message and posts it without opening the composer. No state change to `pendingAnnotations`.

### 2.4 `mid-flight-cancel` gate

A `Stop analysis` button on both the todos pane (when a code-analyzer list is active) and the Report Pane fires the `mid-flight-cancel` gate. Actions: `cancel` (drop remaining pending items via `deps.todos.cancel(itemId, 'user-cancelled')`, then jump to `synthesise` with whatever findings are in hand), `abort` (discard entirely — `list.transfer('system')`).

### 2.5 Per-task caching — `agent/tasks/code-analyzer/cache.ts`

LRU keyed on `SHA256(task.question + normalize(task.scope) + repoSnapshotId)`. Cache lives under `~/.insrc/cache/code-analyzer/`, evicts at 200 entries.

Hit path: `updateItem(meta = cached)` then `markComplete(itemId)`; reviewer is skipped (the cached result was reviewer-accepted at write time).

Miss path: existing analyzer runs; on `accept`, write to cache before `markComplete`.

A manual `codeAnalyzer.clearCache` command is exposed via the command palette.

> Cache pays off **within a single repo revision** only — any commit / re-index invalidates everything. Acknowledged in [design §14](../../design/analyzers/code-analyzer.html#caching). Span-content hashing for cross-rev hits is deferred until usage data shows the cross-rev miss is actually a problem.

### 2.6 **Delete the legacy `CodeAnalysisController`** (load-bearing for this phase)

This is the cleanup the phase exists for. Order matters — flip routing before deletion to avoid a window where the intent has no handler.

#### 2.6.a Cut over classifier routing

Flip `code-analysis` intent dispatch from the legacy controller to the new orchestrator. The intent name **stays** (it's the classifier's vocabulary); only the routing changes.

> **The classifier module itself is untouched.** [`src/insrc/agent/classify/`](../../src/insrc/agent/classify/) (`index.ts` / `intent.ts` / `provider.ts`) is generic and data-driven — it consumes whatever's in `INTENT_CLASSES` and casts the chosen id to `Intent` ([classify/intent.ts:82](../../src/insrc/agent/classify/intent.ts#L82)). The `/intent code-analysis` override at [prefix.ts:9](../../src/insrc/agent/prefix.ts#L9) already accepts the id. All classifier-side work happens in the data file (`intent-classes.ts`), not the module.

| File | Change |
|------|--------|
| `src/insrc/daemon/task.ts:1724-1726` | Replace `import('./controllers/code-analysis.js')` + `new mod.CodeAnalysisController()` with `import('./controllers/code-analyzer-orchestrator.js')` + `new mod.CodeAnalyzerOrchestratorController()`. |
| `src/insrc/agent/router.ts:26,80` | Remove `'code-analysis'` from `NO_LLM`. The new analyzer is LLM-driven; it should not be routed via the no-LLM short-circuit. |
| `src/insrc/agent/orchestrator/agent-router.ts:34,68,88` | Remove `'code-analysis'` from `ORCHESTRATOR_INTENTS` and the orchestrator-direct branch (`case 'code-analysis':` at line 68). The new family registers itself through the standard family-controller path. |
| `src/insrc/agent/decompose.ts:91`, `src/insrc/agent/prefix.ts:9`, `src/insrc/daemon/chat-handler.ts:183,990,1033,1047,1097` | Audit each list. `code-analysis` stays in agent-intent lists (it now IS an agent family). The "info-only intent" branches at chat-handler.ts:1097 and the `agentLabel === 'research'` check at :1047 need updating: `code-analysis` is no longer info-only. |
| `src/insrc/shared/intent-classes.ts:28-29` | **Paired description update** — see "Classifier descriptions" below. Both `research` and `code-analysis` descriptions change in the same commit; they're load-bearing for routing and have to disambiguate from each other. |
| `src/insrc/shared/intent-classes.ts:42` | Keep `'code-analysis': true` — it remains a valid intent. |
| `src/insrc/daemon/task-builder.ts:23` | Keep `'code-analysis'` in `AGENT_INTENTS` — it now is one. |
| `src/insrc/agent/cli.ts:103`, `src/insrc/agent/index.ts:307` | Update comments / log strings to reflect the new family routing. |
| `src/insrc/shared/types.ts:72` | Keep `'code-analysis'` in the `Intent` union. |

##### Classifier descriptions — paired update

The classifier is single-shot zero-shot ([classify/index.ts](../../src/insrc/agent/classify/index.ts)); the only lever for routing accuracy is the per-class `description` strings. The legacy entries split poorly for the new family:

```ts
// CURRENT — line 28
{ id: 'research',     description: 'user wants an explanation, trace, or exploration of how something works (informational questions about existing code / services / endpoints go here)' },
// CURRENT — line 29
{ id: 'code-analysis', description: 'user wants a structural query about code relationships (callers, callees, dependencies — no prose, just data)' },
```

Two problems: (a) `research`'s parenthetical *"informational questions about existing code go here"* directly contradicts the new analyzer's scope and per the locked-in project rule (research = web/external-info only); (b) `code-analysis` describes the legacy "no prose, just data" controller, which actively mis-classifies real users away from the new family that produces a cited Markdown report.

Replace both in the same edit:

```ts
// NEW — line 28
{ id: 'research',     description: 'user wants information that requires looking OUTSIDE the project — web search, package docs, external APIs, library behaviour, framework quirks. In-repo "how does X work" goes to code-analysis.' },
// NEW — line 29
{ id: 'code-analysis', description: 'user wants a read-only analysis of the project\'s own code — locating, tracing callers/callees, summarising a flow, comparing implementations. Output is a cited Markdown report. Spans focused queries ("callers of foo()") and broad audits ("summarise the auth flow").' },
```

Verification at this step: run a few representative prompts past the classifier and confirm routing — see Phase 2 acceptance item 8.

#### 2.6.b Delete legacy files

Once 2.6.a is in and the smoke test passes:

| File | Action |
|------|--------|
| `src/insrc/daemon/controllers/code-analysis.ts` | **Delete.** All routing now goes through `code-analyzer-orchestrator.ts`. |
| `src/insrc/agent/tasks/code-analysis/prompts.ts` | **Delete.** Legacy `buildLocalDraftPrompt` / `buildClaudeReviewPrompt` are unused; new prompts live under `~/.insrc/code-analyzer/`. |
| `src/insrc/agent/tasks/code-analysis/types.ts` | **Delete after porting.** Move `Finding` / `FindingSeverity` / `CodeAnalysisConcern` to `agent/tasks/code-analyzer/types.ts` (extending `Finding` with `citations: CodeCitation[]`). Update every importer. |
| `src/insrc/agent/tasks/code-analysis/` (directory) | **Remove the empty directory** after the three files above are gone. |

#### 2.6.c Verify nothing references the old paths

```bash
grep -rn "controllers/code-analysis\|tasks/code-analysis\b\|CodeAnalysisController" src/insrc/
# expected: no matches
grep -rn "buildLocalDraftPrompt\|buildClaudeReviewPrompt" src/insrc/
# expected: no matches
```

If anything is still referencing the legacy paths, fix it before merging — there is no fallback after this phase.

### Phase 2 acceptance

```
1. AnalysisReportPane opens automatically on synthesise completion in the active session.
2. Reload the workbench → pane is gone; clicking "Open report" from the todos pane re-opens it from list.body.
3. Annotate-flow: select span → "Annotate" → save → 🔖 marker renders inline → "Send all to chat" composes one batched message → chat panel receives it as a normal user turn.
4. Quote-to-chat-now sends a single-span quoted chat message without opening the composer.
5. Stop analysis fires mid-flight-cancel; cancel jumps to synthesise with current findings; abort discards.
6. Per-task cache hits skip the analyzer call; clearCache command empties the LRU.
7. Legacy controller deletion: `grep -rn "CodeAnalysisController" src/insrc/` returns 0 matches.
8. Both `/code-analyze` and the classifier `code-analysis` intent reach the new orchestrator.
9. Classifier disambiguation regression check: representative prompts route correctly post-description-update.
   - "explain how the auth middleware works"               → code-analysis (was: research)
   - "what's the recommended way to use Kuzu's MERGE?"     → research      (unchanged)
   - "where is UserService.refresh called from?"           → code-analysis (unchanged)
   - "compare the v1 and v2 token verifier"                → code-analysis (was: ambiguous)
   - "how does Anthropic's prompt caching work?"           → research      (unchanged)
   Captured via scripts/test-code-analyzer-classifier.ts (5+ prompts, asserts intent id).
10. Smoke: scripts/test-code-analyzer-flow1.ts still passes after cutover.
11. scripts/build.sh green; npm run precommit green.
```

### Phase 2.A follow-ups (validation findings)

Issues observed live during the first end-to-end `/code-analyze` exercise on Phase 2.A code (`devstral-small-2:latest` local executor, `claude-haiku-4-5` cloud reviewer, 11-task plan, ~14 minutes wall-clock). Phase 2.A delivered the Report Pane and the Ollama-native JSON-Schema constraint; this round surfaced the next layer of issues. None are run-blocking — orchestrator's defensive try/catch + F4 guard kept the run going to a synthesised report — but each is worth a follow-up commit before Phase 2.B (legacy-controller deletion) lands.

| # | Issue | Symptom | Fix sketch | Where |
|---|---|---|---|---|
| F8 | Ollama silently drops `format: <schema>` when `tools` are also in the call | Every analyzer task's first-turn output is conversational prose ("Now I have...", "Perfect! N...", "Let me che..."). Schema-bound retry (no tools) succeeds when used. Cost: 2 LLM calls per task instead of 1. Confirmed by Ollama's own docs: the format-with-tools combination is undocumented (no examples). | Either (a) restructure to a "submit tool" pattern (define `submit_analysis(...)` whose input schema IS AnalyzerResult; the model HAS to call it; tool_calls come back structurally regardless of `format` field state — sidesteps F8 by construction), or (b) accept the 2-call overhead and move on. Option (a) is the architectural answer the next pass should take. | `analyzer/runner.ts` main loop; new `prompts/submit-tool.ts` |
| F9 | Status-string corruption: `''in_progress''` (doubled single quotes) reaches `canTransitionItem` | Reproducible on every `markComplete(itemId)` call after a reviewer accept. F3 fix prevents the TypeError crash; the fallback returns `false` and `updateItem` then throws `illegal item-status transition ''in_progress'' -> 'completed'`. Orchestrator catches and logs but the item never advances to `completed` in the DB. The doubled-quote pattern points at a Kuzu / LanceDB string round-trip OR a stray `JSON.stringify(status)` on the read or write path. | Trace the read path from `db/todos.ts:updateItem` back through `TodosApiImpl.updateItemStatus`. Likely either an unwanted `JSON.stringify` on a value that's already a string, or a Kuzu query returning a JSON-encoded string. Fix at the source layer; the F3 fallback should never need to fire on legitimate data. | `db/todos.ts:518`; trace upward to `TodosApiImpl.updateItemStatus` |
| F10 | Schema-bound retry produces JSON that fails the parser's validation (intermittent: ~75% of items in this run) | Even with `format: <AnalyzerResult JSON Schema>` passed, devstral's output occasionally misses required fields, picks invalid enum values, or drops `findings.citations[]` to empty. Logs only `"reason":"schema_violation"` — `parsed.detail` is dropped on the retry-failure path, so we don't know WHICH rule fails. F4 guard catches the cascade so each item completes after one retry pair. | (a) **DIAGNOSTIC FIRST**: log `parsed.detail` on the retry log (`runner.ts` line ~363, currently `{ reason }`, change to `{ reason, detail }`). 1-line fix; gives us actionable data on the actual rule violations. (b) Once we know what's failing: validation-feedback retry (Instructor pattern — assistant: prior bad JSON, user: "field X violated rule Y, fix it") on the schema_violation path. The unparseable path already does this; schema_violation does not. (c) Possibly simplify the schema (drop `minItems: 1` on findings.citations, let citations.invariant retry handle the empty case). | `analyzer/runner.ts` retry log + retry path |
| F11 | Synthesise output prefixed with stray apostrophe / backtick | Rendered Report Pane's first heading (`'# Agent Framework Functionality`) doesn't parse as H1 because the line starts with `'` before `#`. Subsequent headings (`## Summary`, `## Findings`) render fine. `afterSynthesise` writes `completed.output` straight to `list.body` with no sanitization. Local model occasionally prefixes its response with quote characters or wraps in markdown fences. | Add a `sanitizeMarkdownReport()` step in `afterSynthesise` before `updateListBody`: trim whitespace, strip wrapping triple-backtick markdown fences, strip a leading `'` / `` ` `` / `"` if it precedes a heading character. Plus tighten the synthesise prompt to forbid wrapping the output in fences or quotes. | `daemon/controllers/code-analyzer-orchestrator.ts:afterSynthesise`; `prompts/synthesise.ts` |
| F12 | UX disconnect: chat panel sees only terse status messages during the run | Long silent gaps (60-90s per item × 10 items) where the user has no insight into what task is running, which tool is being called, or progress through the queue. The orchestrator emits `progress` stream events from `runNextAnalyzerTask` but the chat-panel rendering for them is sparse / replaced. | Stream richer per-task events: e.g. `Task K/N: <task-title> -- running graph_search... Read... synthesising...`, finding-as-it-lands previews, queue-position updates. Wire the daemon's `onProgress` callback (already in `runAnalyzer` opts) into a per-tool message and ensure the chat panel surfaces them. | `code-analyzer-orchestrator.ts:runNextAnalyzerTask`; chat-panel rendering for `progress` stream events |
| F13 | Progress stream updates disappear from the chat panel before the next one arrives | Even when an update IS streamed, the chat-panel renderer replaces it with the next event or clears it on phase transitions. The user can't see what was just done. | Update the chat-panel rendering for `progress` events to be additive / transcript-style rather than replace-last. Each progress message persists in the transcript until the entire process finishes, with the latest as a live "in-progress" indicator on top. | Chat-panel `progress` event renderer (workbench-side) |
| F14 | NEW FEATURE — scope-aware analysis pipeline (S/M/L/XL/XXL+ tiers + per-tier flows + drill-down) | Today's `/code-analyze` jumps straight from prompt to planner with a single cap policy and a single playbook. "Summarise the auth flow" and "audit the entire repo for X" produce ~10-task plans regardless. Big-scope prompts get under-served (the analyzer drills into individual functions when the user wanted a structural read); small-scope prompts pay reviewer-overhead they don't need; users have no drill-down — a follow-up question means re-prompting from scratch. | Full design in **[Phase 5 — Scope-aware analysis pipeline](#phase-5--scope-aware-analysis-pipeline-f14-expansion)** below. Five tiers; per-tier planner caps + analyzer playbook + synthesise shape; explicit drill-down chain (XXL+ → L/XL → S/M). Sequenced after F8/F10 stabilise the analyzer flow and after the classification rewrite lands the generic `classify()` module the sizing classifier consumes. | Phase 5 sub-phases 5.A/5.B/5.C/5.D — see section. |

These are tracked here rather than as separate plan-doc commits so the validation context stays grouped with Phase 2's acceptance section. F10's diagnostic fix (1-line) should ship first since it's the cheapest and gates intelligent decisions on the rest. F8 and F14 are the architectural items worth a focused design pass before Phase 2.B legacy deletion lands; F9, F11, F12, F13 are smaller polish items that can ride alongside.

---

## Phase 3 — Cross-agent integration (Flow 2)

Lands the cross-agent surface so this analyzer can call sibling analyzers' tools (when present) and accept Flow-2 dispatch from siblings. Sibling analyzers' tools (`data:*`, `deploy:*`) only become callable once those families ship; until then the `TOOL_UNAVAILABLE` fall-through path keeps everything functional.

### 3.1 Register `code:*` tools — `cross-agent/register-tools.ts`

Per-capability tools the Code Analyzer exposes for siblings to call (single-targeted lookups; 5 s cap):

| Tool          | Input                                              | Output                                       |
|---------------|----------------------------------------------------|----------------------------------------------|
| `code:locate` | `{ query, scope?, k? }`                            | `{ entityId, path, lineRange, snippet }[]`   |
| `code:trace`  | `{ entityId, direction, depth? }`                  | `{ neighbours: [{entityId, edge, hop}] }`    |
| `code:describe` | `{ entityId }`                                   | `{ summary, signature, body, neighbours }`   |

Plus the Flow-2 dispatch tool (60 s envelope, see 3.6):

| Tool           | Input                                                          | Output                                       |
|----------------|----------------------------------------------------------------|----------------------------------------------|
| `code:analyze` | `{ tasks: AnalysisTask[]; callerContext?: { agent } }`         | `{ report, findings, citations, confidence, truncated? }` |

All four register through the daemon's existing tool registry. The handlers respect `crossAgentDepth >= 1` (3.4).

### 3.2 Wire `data:*` / `deploy:*` into the Code Analyzer's tool list

When `insrc.analyzers.enabled.data === true` and the Data Analyzer family is registered (sibling plan, not this one), append the following to `AnalyzerToolContext`'s closed list:

`data:list-connections`, `data:describe-table`, `data:lineage`, `data:schema-drift`

Same for `deploy:env-diff`, `deploy:service-deps` when `insrc.analyzers.enabled.deployment === true`.

Until those sibling families exist, the `insrc.analyzers.enabled.*` flags default to `false` and the tool list stays at the Phase-1 native set. No code changes needed in this analyzer when siblings later land — the flag flip alone enables them.

### 3.3 `TOOL_UNAVAILABLE` sentinel + graceful fall-through

Defined in `src/insrc/shared/tools.ts` (or wherever tool-result types live):

```ts
export const TOOL_UNAVAILABLE = {
  status: 'unavailable',
  reason: 'target_analyzer_not_registered',
} as const;
```

When a `data:*` / `deploy:*` call lands but the target family isn't registered (or its handler errors / times out per the per-class envelope from §13.4), the registry returns this sentinel. The analyzer's run-task LLM sees the structured response and continues with what it can produce; the orchestrator's review step categorises the affected task as "external dependency missing" — accepted with reduced confidence. Synthesise emits a single line at the bottom of the report: *"Consider running /data-analyze for richer schema findings"* (or equivalent for deployment).

### 3.4 `crossAgentDepth` enforcement — `cross-agent/depth-context.ts`

Add a counter to the run-task tool context. Increment on every cross-agent dispatch (`data:*`, `deploy:*`, sibling `code:*` calls received from another family); reject with `TOOL_UNAVAILABLE` (reason: `cross_agent_depth_exceeded`) when `crossAgentDepth >= 1` per [design §13.2](../../design/analyzers/code-analyzer.html#cross-contract). Strict cap — no carve-outs.

### 3.5 Citation propagation in synthesise

Update `synthesise.md` and `buildSynthesisPrompt` to render foreign citations in their own subsections — never inline with code citations. Format per [design §13.3](../../design/analyzers/code-analyzer.html#cross-citations):

```
## Schema findings (data-analyzer)
* `users.refresh_token_hash` is the column the code reads
  [(connection: `primary`, table: `users`, column: `refresh_token_hash`)](data-cite:1).
```

`AnalyzerResult` gains an optional `foreignCitations?: { data?: DataCitation[]; deploy?: DeployCitation[] }` field; the orchestrator threads these through `list.body`. `DataCitation` / `DeployCitation` shapes live in their respective sibling family modules (sibling plans define them); this plan declares an opaque `Record<string, unknown>` type until the siblings land, then tightens.

### 3.6 `code:analyze` — Flow 2 entry

Caller hands over a pre-built `AnalysisTask[]`; Code Analyzer skips the plan step, runs tasks, reviews each, synthesises, returns the structured result. No `present` gate (caller decides what to do with it). 60 s envelope per [§13.4 fix](../../design/analyzers/code-analyzer.html#cross-fallthrough).

Caps inside Flow 2: same 16/24 soft/hard cap as Flow 1, but no plan-size-approval gate (no user in the loop) — silent trim to 16, `truncated: true` set in the return value. Caller's review step decides whether to re-dispatch dropped tasks.

`callerContext.agent` flows into the synthesise prompt for citation labelling so the produced report can be folded into the caller's own report under a "Code findings (code-analyzer)" subsection.

### Phase 3 acceptance

```
1. code:locate / code:trace / code:describe / code:analyze are listed in
   the daemon's registered-tools snapshot.
2. crossAgentDepth >= 1 from any cross-agent handler returns TOOL_UNAVAILABLE.
3. data:* / deploy:* calls from inside a Code Analyzer task land successfully
   when sibling families are present (mocked in test); fall-through cleanly when not.
4. Citation propagation: a synthesised report with foreign findings places
   them under their own ## subsection, not inline.
5. code:analyze with a 16-task input completes inside 60 s on a small repo.
6. code:analyze with > 16 tasks silently trims and returns truncated: true.
7. scripts/build.sh green.
```

---

## Phase 4 — Polish

Independent, low-coupling enhancements. Order is flexible.

### 4.1 Re-run with new repo rev

One-click action on a completed analysis. Constructs a new task list from the prior `list.items` (preserving `kind` + `question` + `scope`), invokes the orchestrator at `run-task` (skipping `plan`), and writes results to a new `TodoList` with `parentListId = priorListId`.

### 4.2 Diff-vs-previous-run mode

Compares two runs of the same analysis (same `request`, different `repoSnapshotId`). Highlights findings present in only one side. UI: side-by-side panes or unified diff view in the Report Pane header.

### 4.3 `@mention`-driven cross-agent dispatch

Lets users explicitly target a specific analyzer in chat: *"@data-analyzer describe the users table"*. Hooks into the existing provider-mention parser (`agent/framework/provider-mention.ts`) — adds `@<analyzer-family>` as a recognised target.

### Phase 4 acceptance

```
1. Re-run action visible on completed runs; new run appears as a child list.
2. Diff mode shows added / removed / changed findings.
3. @data-analyzer / @deployment-analyzer mentions route correctly.
4. scripts/build.sh green.
```

---

## Phase 5 — Scope-aware analysis pipeline (F14 expansion)

**Status:** design-only. Not scheduled. Captured here so the Phase 2.A follow-up table (F14) has a single home for the full feature spec instead of an under-scoped table cell.

### Why this exists

Today's `/code-analyze` jumps straight from the user's prompt to the planner with one cap policy (16 soft / 24 hard tasks). The planner's per-task playbook is also one-size: each task is a focused per-entity investigation (locate / describe / trace / compare). Result:

- "summarise the auth flow" (1 module, ~5 entities) and "audit the entire repo for X" (50 modules, 5000+ entities) both produce ~10-task plans because that's what the planner caps fall out at.
- Big-scope prompts get under-served — the analyzer drills into individual functions when the user wanted a structural read.
- Small-scope prompts pay reviewer-cost overhead — 10 cloud reviewer calls for a question that could have been one focused investigation.
- No drill-down — the user gets a flat report; if a bullet sparks a follow-up question they have to re-prompt from scratch.

### The scope tiers + per-tier flows

A pre-planner classifier sizes each request into one of:

| Tier | Indicator | Analysis altitude | Output shape |
|------|-----------|-------------------|--------------|
| **S** | "what does `foo()` do?", single function / handful of lines | Detailed code-level — read the body, callers, callees of one or two specific entities | One-section report; concrete code citations; one or two findings per entity at most |
| **M** | "how does the auth middleware handle expired tokens?" — 1 file or a small group of related entities | Detailed code-level — same as S but plural; cross-entity tracing within a tight scope | Multi-section report grouped by entity; the bulk of citations are line-level |
| **L** | "describe the agent framework" — one module / sub-tree (~10-50 entities) | Endpoints + module-level — public interfaces, exported symbols, top-level call patterns. Bodies only when load-bearing | Module-overview report; per-class / per-export sections; bodies are summarised, not pasted |
| **XL** | "compare the brainstorm and designer agents" — multiple modules; cross-cutting | Endpoints + module-level — same as L but spans subtrees; the comparison/relation IS the finding | Cross-module report; tabular comparisons; selective deep-dives only on the load-bearing differences |
| **XXL+** | "audit the entire repo's error handling" or "give me the architectural overview of insrc" | Design / architecture — module breakup, dependency graph, layering, responsibility map. **Infer** the boundaries the user didn't explicitly draw | High-level structural report; module map + dependency edges + responsibility callouts; almost no code-line citations |

### Drill-down chain

Each report ends with a "next steps" affordance pointing one tier deeper:

- **XXL+** report → user picks one of the inferred modules → re-runs as **L/XL** scoped to that module
- **L/XL** report → user picks one of the per-module sections → re-runs as **S/M** scoped to that section
- **S/M** report → terminal (already at code-line citations)

The user never has to re-prompt from scratch — the drill is "click this section, run a focused analysis on it." The new `/code-analyze` invocation inherits the parent run's context (parent listId, scope path) so the daemon can show the drill-down breadcrumb.

### Component design

#### 5.1 Sizing classifier (`agent/tasks/code-analyzer/scope.ts`)

Runs BEFORE the planner. Inputs:
- The user's prompt text.
- Repo signals: total entity count from the daemon's index, primary-language mix, file count under the active repo + closure.
- Optional context: prior run's scope (when this is a drill-down).

Output: `{ tier: 'S' | 'M' | 'L' | 'XL' | 'XXL', rationale: string, confidence: 0..1 }`.

Implementation: thin wrapper over the generic `classify({ classes: ANALYSIS_SCOPE_CLASSES, text, context }, provider)` from [plans/classification-rewrite.md](../classification-rewrite.md). Cloud-first, local fallback (the standard classifier provider chain). The class descriptions encode the tier indicators above.

`ANALYSIS_SCOPE_CLASSES` lives in `src/insrc/shared/code-analyzer-scope.ts` next to the `AnalysisTier` type alias so TS catches drift.

#### 5.2 Per-tier planner playbook (`prompts/plan.ts`)

The plan prompt today is one block. After Phase 5 it has tier-conditional sections:

- `S`/`M` → "produce 1-3 highly focused tasks; prefer one `describe` and one `trace` over many `locate`s."
- `L`/`XL` → "produce 5-12 tasks at module-level; one summary task per logical sub-module; explicit cross-module comparison tasks for XL."
- `XXL+` → "produce 3-6 tasks each scoped to a major sub-system the model infers from the repo signals; output is a structural map, not per-entity findings; per-task `kind` defaults to `describe` with `paths: <inferred-subtree>`."

The hard-cap numbers also tier:

| Tier | Soft cap | Hard cap | Per-task wall-clock | Cloud reviewer calls (max) |
|------|---------:|---------:|--------------------:|---------------------------:|
| S    | 3        | 5        | 30 s                | 1 per task                 |
| M    | 5        | 8        | 45 s                | 1 per task                 |
| L    | 10       | 16       | 60 s                | 1 per task                 |
| XL   | 16       | 24       | 60 s                | 1 per task                 |
| XXL+ | 6        | 10       | 90 s                | 1 per task                 |

(`XXL+` has FEWER tasks than `XL` because each task is broader and slower. Reviewer count matches task count — no extra review overhead per tier.)

#### 5.3 Per-tier analyzer playbook (`prompts/analyzer-system.ts`)

The hard rules + tool list stay the same (citations invariant is universal). The PER_KIND_PLAYBOOK gets tier-aware sections:

- `S`/`M` → existing playbook (locate / describe / trace / compare with body-level citations).
- `L`/`XL` → "summarise the file's exports + public surface + first-order call relationships. Cite signatures, not bodies. Don't paste >30 lines of code."
- `XXL+` → "describe the sub-system's responsibilities, public boundary, principal types, and the modules it depends on / is depended on by. Output is structural prose + a brief module-edge list. Per-line code citations are NOT required at this tier."

The citation-invariant retry remains universal but the validation is tier-aware: at XXL+, citations may be at file-level (no `lineStart`/`lineEnd`) without triggering the missing-citations downgrade.

#### 5.4 Per-tier synthesise prompt (`prompts/synthesise.ts`)

Tier flag drives the report shape:

- `S`/`M` → existing markdown shape (one section per finding; embedded code blocks).
- `L`/`XL` → tabular summaries; per-module h2 sections; bodies → signatures.
- `XXL+` → module map + responsibility table + dependency-edge list. No `## Findings` section per se — the structure IS the finding.

Plus a footer the synthesise prompt always emits: a "Drill down" section listing 3-5 candidate next-steps the user can run as scoped child analyses. The Report Pane renders these as clickable affordances (Phase 2.B+ work; for now they're plain text).

#### 5.5 Drill-down command + UI (`code-analyzer/codeAnalyzerCommands.ts`)

New command: `insrc.codeAnalyzer.drillDown` taking `{ parentListId, scope: AnalysisScope }`. Behaviour:

1. Look up parent list, capture its `tier` from list.meta.
2. Build a child `/code-analyze` invocation with:
   - Prompt = the chosen drill-down candidate text from the parent's footer.
   - Scope = the user's chosen sub-scope (path / entityIds / module name).
   - `parentListId` threaded so the daemon can show breadcrumbs.
3. Submit to the existing chat path so the Report Pane auto-opens for the child run.

UI affordance: each "Drill down" footer item in the Report Pane becomes a button. Click → invokes the command with the right scope.

The orchestrator stamps `meta.parentListId` on the child list at `createList` time so the todos pane can render parent-child threads (and the kebab "Open report" knows the relationship).

### Data model additions

```ts
// shared/code-analyzer-scope.ts (NEW)
export type AnalysisTier = 'S' | 'M' | 'L' | 'XL' | 'XXL';

export interface AnalysisScopeClass extends ClassChoice {
  readonly id: AnalysisTier;
}

export const ANALYSIS_SCOPE_CLASSES: readonly AnalysisScopeClass[] = [ /* tier descriptions */ ];

export interface ScopedAnalysisRequest {
  readonly tier: AnalysisTier;
  readonly rationale: string;        // classifier's one-line reason
  readonly confidence: number;       // 0..1
  readonly parentListId?: string;    // set when this is a drill-down
  readonly scope?: {                 // tier-specific narrowing
    readonly paths?: readonly string[];
    readonly entityIds?: readonly string[];
    readonly modules?: readonly string[];
  };
}
```

`CodeAnalysisState` (in `agent/tasks/code-analyzer/types.ts`) gains `tier: AnalysisTier` and `parentListId?: string`. The orchestrator stamps both on `createList({ meta: ... })` so the todos pane and the Report Pane see them.

### Acceptance

```
1. Sizing classifier runs once per /code-analyze invocation. Tier is logged + visible in the orchestrator's first progress event.
2. The five tier classes route correctly on a representative prompt set:
   - "what does normalizeArgs() do?"                              -> S
   - "how does the auth middleware handle expired tokens?"        -> M
   - "describe the agent framework"                               -> L
   - "compare the brainstorm and designer agents"                 -> XL
   - "give me an architectural overview of insrc"                 -> XXL
   Captured via scripts/test-code-analyzer-scope-classifier.ts.
3. Per-tier planner caps actually fire: an L request produces a 10-task plan; an XXL request produces a 6-task plan. Verified via plan-task-count assertion in the smoke script.
4. Per-tier analyzer playbook actually shifts behaviour: an XXL task's output is structural prose (no per-line citations); the citation-invariant retry does NOT fire on file-level citations at XXL.
5. Per-tier synthesise output has the right shape (tabular for L/XL; module-map for XXL).
6. Drill-down: click a "Drill down" affordance on an XXL report -> a new L/XL analysis runs scoped to the chosen module -> Report Pane opens with parentListId breadcrumb.
7. scripts/build.sh green; npm run precommit green.
```

### Sequencing

Phase 5 lands after the Phase 2.A follow-ups (F8/F10 in particular — the analyzer flow needs to be reliable before tiers are layered on top) AND after the classification rewrite ([plans/classification-rewrite.md](../classification-rewrite.md)) since the sizing classifier is a consumer of the generic `classify()` module.

Phase 5 itself splits into:

- **5.A** Sizing classifier + tier-aware caps (no playbook changes; just plan a different number of standard tasks based on tier). Smallest useful slice.
- **5.B** Per-tier planner + analyzer playbooks (the meaty change; new prompts).
- **5.C** Per-tier synthesise prompt + Report Pane drill-down footer rendering.
- **5.D** `insrc.codeAnalyzer.drillDown` command + parent-child list threading.

Each sub-phase is a focused commit with its own acceptance subset. Recommend shipping 5.A first to validate the sizing path end-to-end before investing in the per-tier prompt work.

### Out of scope

- Per-tier confidence calibration (the analyzer's `high`/`medium`/`low` bands stay tier-agnostic for now).
- Re-classification on prompt revision (a user's "re-run" with an edited prompt re-invokes the classifier; there's no explicit "you said S, did you mean M?" gate).
- Auto-drill (the user always picks the next-step affordance manually; no orchestrator-driven recursion).
- Cross-tier diff view (comparing an XXL run against an L run for the same prompt — possible future polish; not in this plan).

---

## Test scripts

Each phase ships a smoke script under `scripts/` for manual verification (we don't auto-run tests per the global build rules; print failures + suggest actions).

| Script                                       | Phase | Covers |
|----------------------------------------------|-------|--------|
| `scripts/test-code-analyzer-phase0.ts`       | 0     | Agent-registry exhaustiveness check (`isAgentFamily('code-analyzer')` is true; `AGENT_FAMILIES` includes it). `TodosApi.updateItemMeta` / `markCancelled` are already covered by existing brainstorm/delegate consumers — no script needed for those. |
| `scripts/test-code-analyzer-flow1.ts`        | 1     | End-to-end Flow 1: plan → run-task → review → synthesise → present, against a fixture repo. |
| `scripts/test-code-analyzer-fs-gate.ts`      | 1     | fs-access gate fires on out-of-repo path; cascade approval suppresses subsequent gates. |
| `scripts/test-code-analyzer-citations.ts`    | 1     | Citation invariant retry path; missing-citation → confidence 'low'. |
| `scripts/test-code-analyzer-resume.ts`       | 1     | Crash-resume: in-progress item resets to pending and re-runs. |
| `scripts/test-code-analyzer-report-pane.ts`  | 2     | Pane open / close / reload behaviour; annotate-and-batch-send round-trip. |
| `scripts/test-code-analyzer-legacy-gone.ts`  | 2     | grep returns 0 matches for legacy CodeAnalysisController paths. |
| `scripts/test-code-analyzer-classifier.ts`   | 2     | Disambiguation regression check — 5+ representative prompts route to the expected intent id post-description-update. Asserts both `research` and `code-analysis` route correctly. |
| `scripts/test-code-analyzer-cross-agent.ts`  | 3     | TOOL_UNAVAILABLE fall-through; crossAgentDepth rejection; code:analyze Flow-2 round-trip with mocked tasks. |

All scripts run via `source ~/.insors && npx tsx scripts/<name>.ts` per CLAUDE.md convention. Do not run them without explicit user approval.

---

## Telemetry / logging

- Every step uses `getLogger('code-analyzer:<step>')` from `shared/logger.js`. No `console.log`.
- Per-task: log `{ itemId, kind, durationMs, toolCallCount, confidence, retryCount }` at info level.
- Cross-agent calls: log `{ source, target, tool, durationMs, depth, status }` at info; `TOOL_UNAVAILABLE` at warn.
- Cap hits (soft 16, hard 24, follow-ups 8): log at warn with the dropped-task count.
- `INSRC_LOG_LEVEL=debug` enables per-tool-call dumps inside the analyzer loop.

---

## Build / commit notes

Per project conventions:

- Build via `scripts/build.sh` (heap-pinned, logged) — never `npm run compile` / `tsc` directly.
- `npm run precommit` before every commit; in particular for workbench-contrib changes (curly braces on single-line `if`s, hoisted union types).
- Daemon runs from committed code — `tsc` build alone doesn't deploy. Each phase ends with a commit, then `daemon stop` + `daemon start` to pick up the new code.
- Never auto-run tests; on failure, print the failure reason + suggest actions.

---

## Open risks (to revisit at each phase boundary)

| Risk | Phase | Mitigation |
|------|-------|------------|
| Local synthesise produces lower-quality prose than cloud | 1 | `@anthropic` / `@openai` mention upgrades synthesise per session. If real usage shows local is unusable, reconsider routing default in Phase 4 polish. |
| Cloud reviewer cumulative input grows past comfortable budget on long runs | 1 | Hard cap at 24 tasks (~60–100k cumulative review tokens) is the backstop. Watch reviewer p95 latency in Phase 1; consider compacting `pre-history` summaries if it climbs. |
| `fs-access` gate friction on heavily cross-repo workflows | 1 | Parent-grant cascade should make this rare. If users frequently approve-broader, consider a workspace-folders-implicit grant in Phase 4. |
| Per-rev cache misses too often to be useful | 2 | Acknowledged in [§14](../../design/analyzers/code-analyzer.html#caching). Span-content hashing deferred; revisit if the cache hit rate observed in Phase 2 telemetry is < 10%. |
| Sibling family registration order forces re-rebuild of `crossAgentDepth` ctx | 3 | Tool registry is dynamic; depth ctx is per-task. Adding a sibling family at runtime works without restart. Verify in Phase 3 smoke script. |
| Annotation marker rendering interferes with `MarkdownWidget` selection | 2 | Marker is a separate inline DOM overlay, not embedded in the rendered Markdown text. Coordinate with the `MarkdownWidget` owner before Phase 2 implementation. |
