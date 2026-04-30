# Plan: Data Analyzer Agent

Implementation plan for the **Data Analyzer** family described in
[design/analyzers/data-analyzer.html](../../design/analyzers/data-analyzer.html).

This plan deliberately *bakes in* the lessons learned shipping the Code
Analyzer (see [code-analyzer.md](./code-analyzer.md)) -- features that were
added late or rediscovered as bugs there are landed up-front here.

## Related plans

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

## Status

Pre-implementation. No code, no controller, no pane.

The data-driver shipped earlier (see [plans/data-driver.md](../data-driver.md))
and exposes a stable `db:*` tool surface registered as built-in tools:

| Shipped tool id | Maps to design's name | Notes |
|---|---|---|
| `db:list_connections` | `data:list-connections` | enumerates registered connections |
| `db:sql:describe` | `data:describe-table` | RDBMS introspection (Prisma fast-path when present) |
| `db:sql:sample` | `data:sample` (RDBMS branch) | structured `where` only; row cap 50 |
| `db:sql:explain` | `data:explain` | per-dialect EXPLAIN |
| `db:kv:scan` | `data:scan` | namespace.allow-aware; cap 500 |
| `db:kv:get` | `data:get` | per-key fetch |
| `db:kv:sample_shape` | `data:sample-shape` (KV branch) | merges via `inferShape` from `shape-common.ts` |
| `db:file:describe` / `db:file:sample` / `db:file:sample_shape` | `data:*` (file branch) | csv / parquet / jsonl / etc. |

**Naming convention for this plan.** Where the analyzer's *internal*
tool list is meant, the plan uses the shipped `db:*` ids. Where the
*cross-agent* surface is meant (Phase 4 -- the namespace other
analyzers see), the plan uses the design's `data:*` names. The
cross-agent layer (Phase 4.1) wraps the `db:*` builtins behind
`data:*` aliases plus adds analyzer-native tools like `data:lineage`
and `data:schema-drift` that don't have driver-level equivalents.

**One small data-driver gap** that this plan needs to close (Phase
2.4): there is no centralised `getSchemaFingerprint(connectionId)`
helper today. Each driver's `describe()` returns a `SchemaDescription`,
but no shared pipeline hashes it for cache invalidation. The
analyzer's per-task cache key needs that hash. Phase 2.4 adds a small
helper to `daemon/db/index.ts` that wraps per-driver introspection +
hash; ~30 lines, no new tool surface.

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

## Prerequisites

| Prereq | Status |
|---|---|
| TODO framework with `meta` extensibility | shipped |
| Data driver (connections, drivers, `db:*` tools, sample-shape, Prisma fast-path) | shipped |
| `getSchemaFingerprint(connectionId)` helper for cache keying | **NOT shipped** -- Phase 2.4 adds it (~30 lines in `daemon/db/index.ts`) |
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

12. **Daemon restart picks up Stage 1 / 2 fixes for free.** No special
    work; Node 22 / tree-sitter@0.25 are framework-level.

## File structure (target)

```
src/insrc/
  shared/
    slash-commands.ts                     # add /data-analyze entry
  daemon/
    controllers/
      data-analyzer-orchestrator.ts       # main controller; mirrors code-analyzer-orchestrator
    cross-agent/
      data-tools.ts                       # data:* registrations (mirror of code-tools.ts)
    db/
      index.ts                            # +getSchemaFingerprint helper (Phase 2.4 ~30 lines)
  agent/
    tasks/
      _shared/
        json-extract.ts                   # stripFences extracted from code-analyzer (Phase 1.4)
      data-analyzer/
        types.ts                          # DataAnalysisTask, DataAnalyzerResult, citation kinds
        prompts/
          plan.ts                         # buildPlanSystemPrompt + renderPlanUserMessage
          analyzer-system.ts              # HARD_RULES + per-kind playbook + tool list
          synthesise-multipass.ts         # outline + section + stitch (rides content-gen)
          review.ts                       # cloud reviewer system prompt
        analyzer/
          runner.ts                       # tool loop (mirrors code-analyzer/analyzer/runner.ts)
          result-parser.ts                # uses _shared/json-extract
          citations.ts                    # citation invariant validator
        lineage.ts                        # data:lineage tool implementation
        drift.ts                          # data:schema-drift tool implementation
        access-gate.ts                    # connection-approval + sample-review gates
        cache.ts                          # per-task cache keyed on connection-version
        scope.ts                          # sizing classifier (single-table .. multi-conn audit)

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

`~/.insrc/data-analyzer/` (user-overridable prompts) and
`~/.insrc/cache/data-analysis/` are created on first run by the controller.

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

### 1.4 Analyzer tool loop -- `analyzer/runner.ts`

Mirror code-analyzer's runner. Differences:

- **Tool inventory uses the shipped `db:*` builtins**, not the design's
  `data:*` names. The full list:
  - `db:list_connections` -- enumerate registered connections
  - `db:sql:describe` -- RDBMS introspection (uses Prisma fast-path
    when a Prisma schema is present per `daemon/db/drivers/rdbms-prisma.ts`)
  - `db:sql:sample` -- row sample with structured `where` (no raw SQL)
  - `db:sql:explain` -- per-dialect query plan
  - `db:kv:scan` -- key scan with namespace allow-list
  - `db:kv:get` -- per-key fetch
  - `db:kv:sample_shape` -- value-shape inference via `inferShape`
  - `db:file:describe` / `db:file:sample` / `db:file:sample_shape` --
    file-driver introspection
  - `submit_analysis` -- the analyzer's finishing tool (mirror of the
    code-analyzer's, returns a `DataAnalyzerResult`)
- Cross-agent `code:*` (and future `deploy:*`) are added in Phase 4 --
  not part of Phase 1's inventory.
- The connection-approval gate fires inline -- before the first tool call
  that targets a connection not yet approved in the session.
- Sample-review gate fires inline before any `db:sql:sample` /
  `db:kv:get` / `db:file:sample` call against a connection flagged
  `prod` whose result contains unmasked PII columns.
- Result parser uses the SAME `stripFences` helper as code-analyzer
  (extract `{...}` span, ignore preamble). Factor the helper out to
  `agent/tasks/_shared/json-extract.ts` so both analyzers consume it.

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

### 2.4 Per-task caching -- `cache.ts` + driver helper

On-disk cache at `~/.insrc/cache/data-analysis/`.

Cache key (per design §14):

```
SHA256(task.question + normalize(scope) + connection-version)
```

Where `connection-version` is a small fingerprint per connection:
- **RDBMS**: hash of the `db:sql:describe` result for the cited
  table(s). Stable across queries; changes only when the table's
  introspection differs (column added / removed, type changed).
- **KV**: hash of the `db:kv:sample_shape` result merged from a fixed
  sample size (e.g. 50 values). Stable when the document shape is
  stable.
- **File**: hash of the `db:file:describe` result.

**Driver gap**: today there's no centralised
`getSchemaFingerprint(connectionId, target)` helper on the data-driver
-- per-driver `describe()` returns a `SchemaDescription`, but no
shared pipeline canonicalises + hashes it. This slice adds that
helper to `daemon/db/index.ts` (~30 lines):

```ts
export async function getSchemaFingerprint(
  connectionId: string,
  target: string,
): Promise<string> {
  const desc = await describeAny(connectionId, target);
  // Canonicalise: sort columns by name, drop ordinals, drop
  // database-version metadata. Stable across DB engine restarts.
  const canonical = canonicaliseDescription(desc);
  return sha256(JSON.stringify(canonical));
}
```

The cache layer calls it lazily on first cache lookup per (connection,
target) and memoises the result for the session. Recomputed when the
session's `db:list_connections` reports a connection-changed event
(driver already emits this when a connection's pool is reset).

LRU at 200 entries (matches code-analyzer's policy).
`dataAnalyzer.clearCache` command + IPC handler. `data-conn:<id>` URIs
in the rendered report do NOT invalidate the cache (they're navigation
anchors).

### Phase 2 acceptance

- Report renders in `DataAnalysisReportPane` after synthesise.
- Save... writes a self-contained markdown file under `docs/data-analysis/<slug>.md` with `path:` and `data-conn:` URIs rewritten so links work in stock VS Code markdown preview.
- Cache hit when re-running the same query against an unchanged connection.
- Cancel mid-run via Stop button cleanly stops the orchestrator without daemon restart.

## Phase 3 -- Lineage + drift (data-specific)

The first Data-Analyzer-distinctive phase. Lineage = cross-link DB
target to code that reads/writes it; drift = expected (Prisma / ORM /
static analysis) vs live introspection.

### 3.1 `data:lineage` tool

Implementation:

1. Take a `(connectionId, table)` pair.
2. Look up the connection's expected schema (Prisma fast-path / ORM model /
   none).
3. Query the Code Knowledge Graph for `CALLS` edges that mention the table
   name as a string literal or as a typed identifier (when ORM types are
   known).
4. Return `{ readers, writers, ambiguous }` -- each entry is a code
   citation (path / line) plus a confidence based on match precision
   (typed > literal > heuristic).

Lineage findings emit BOTH `DataCitation` (the table) AND code-style
`path:` citations (the call sites). Renderer shows both kinds inline.

### 3.2 `data:schema-drift` tool

1. Resolve the expected shape for `(connectionId, table)`:
   - Prisma schema (when present) -- preferred.
   - ORM model file (TypeORM / Sequelize / Mongoose) -- second choice.
   - Static analysis of query-builder usage in the code -- last resort.
2. Resolve the live shape via `data:describe-table` (RDBMS) or
   `data:sample-shape` over many values (KV).
3. Diff: missing-column, extra-column, type-mismatch, nullable-mismatch,
   pk-changed, fk-changed.
4. Return findings with `concern: 'schema-drift'`, severity by drift kind
   (extra-column = info; missing-column = error; type-mismatch = warn).

When the expected shape can't be resolved (no Prisma, no ORM, no static
hits), drift task downgrades to `confidence: 'low'` and answer "no static
schema source found; emit `inspect-schema` for live snapshot".

### 3.3 ER artifact integration

Lineage findings can render an ER diagram for the affected tables. The
`artifacts/kinds/er.ts` is shipped; the data-analyzer's controller
generates an ER-artifact alongside the report when `kind === 'er'` is in
the plan, embedding the artifact link in the report's relevant section.

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

### 4.1 Register `data:*` cross-agent tools

New file `daemon/cross-agent/data-tools.ts` (mirroring the shipped
`daemon/cross-agent/code-tools.ts`). Exports
`registerDataAnalyzerCrossAgentTools()` that registers:

- `data:list-connections`  -- thin wrapper over `db:list_connections`
- `data:describe-table`    -- routes RDBMS / KV / file family on the
                              fly via the connection's family
- `data:sample`            -- routes to `db:sql:sample` /
                              `db:kv:get` / `db:file:sample`
- `data:scan`              -- thin wrapper over `db:kv:scan`
- `data:get`               -- thin wrapper over `db:kv:get`
- `data:sample-shape`      -- routes to `db:kv:sample_shape` /
                              `db:file:sample_shape`
- `data:explain`           -- thin wrapper over `db:sql:explain`
- `data:lineage`           -- the analyzer's own (Phase 3.1)
- `data:schema-drift`      -- the analyzer's own (Phase 3.2)
- `data:analyze`           -- Flow 2 entry (Phase 4.3)

The wrappers exist because (a) the design's documented cross-agent
namespace is `data:*` not `db:*`, (b) some calls dispatch over the
connection family at the cross-agent layer so callers don't need to
know whether a target is RDBMS / KV / file, and (c) the analyzer
adds tools (`lineage`, `schema-drift`, `analyze`) that have no
driver-side equivalent.

Registration is wired into `daemon/index.ts` alongside the existing
`registerCodeAnalyzerCrossAgentTools()` call, gated on
`insrc.analyzers.enabled`.

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

### 5.5 PII pattern library overrides

Per-repo PII pattern overrides land in `<repo>/.insrc/data-analyzer/pii.json`. Format:

```jsonc
{
  "patterns": [
    { "name": "internal-employee-id", "regex": "^E\\d{6}$", "severity": "warn" }
  ]
}
```

Loaded at controller init alongside the bundled pattern library.

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

- Tier-aware playbook (the equivalent of code-analyzer Phase 5.A-C).
  Data analyses' altitude doesn't span the same range -- "single column"
  through "multi-connection audit" is narrower than code's S/M/L/XL/XXL.
  Add it later if real usage shows the need.
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

```
Phase 0  ──>  Phase 1  ──>  Phase 2  ──>  Phase 3  ──>  Phase 4  ──>  Phase 5
(family       (orchestrator (pane +       (lineage     (cross-agent  (polish:
 + slash)      + analyzer    cache)        + drift)     bidirectional) re-run,
                + report                                                drill-
                draft)                                                  down,
                                                                        PII
                                                                        overrides)
```

**Don't** try to ship Phase 3 (lineage + drift) before Phase 2 -- the
report pane is the only meaningful surface to validate lineage findings
in. The Code Analyzer's experience showed that tier-conditional
behaviour rediscovered as bugs costs more than landing the surface
first.

**Do** land Phase 0 + slash entry + family registration as a single
small commit before Phase 1 begins, so the slash typo guard works for
users running `/data-analyze` while Phase 1 is in flight (it'll emit a
"command not yet registered" message instead of mis-routing).

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
- **Bring-your-own-LLM for the analyzer.** Today the analyzer is local-
  only (matching code-analyzer). For air-gapped users with cloud-only
  LLM access, route the analyzer to cloud with stricter sample-data
  redaction.
