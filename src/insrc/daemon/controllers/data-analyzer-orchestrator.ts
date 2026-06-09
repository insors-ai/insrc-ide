/**
 * DataAnalyzerOrchestratorController -- the Data Analyzer family's
 * task-controller entry point.
 *
 * Post-cutover (planner-section-task-separation P5.b). State machine:
 *
 *   planning  -> [bootstrap pass-through]
 *                The bootstrap task fires `runSectionFlow`
 *                (Scope -> Investigation Plan -> per-TODO orchestrator
 *                -> report assembler + review) inline. The final
 *                markdown lands in K_SYNTH_RESULT.
 *   present   -> [present gate; reserved]
 *   done      (writes list.body)
 *
 * The legacy phases (`plan-approval` / `analyzing` / `reviewing` /
 * `synthesising`) remain in the `DataAnalyzerPhase` enum but are
 * unreachable; the `restoreState` shim normalises any persisted
 * legacy phase to `done` with a partial-report annotation per Q10's
 * migration note.
 *
 * Per-TODO skill execution: `buildSkillExecutor` resolves
 * `inputs.{node, literal, question, context}` bindings and invokes
 * `runSkill(leaf.skill, resolvedInput, runnerDeps)`. The L2 fallback
 * (Q10) calls `data.answer-question` when a TODO's section tree
 * cannot produce a coherent result.
 *
 * Resume: restoreState + buildResumeTask + afterResumeBootstrap drive
 * the rehydration path. Connection approvals are NOT persisted --
 * they re-prompt on resume per design §14.
 */

import { getLogger } from '../../shared/logger.js';
import { loadActiveConnections } from '../../agent/tasks/data-analyzer/load-connections.js';
import {
  K_STATE,
  K_PHASE,
  K_PLAN_RESULT,
  K_PLAN_TASKS,
  K_SYNTH_RESULT,
  RESUME_BOOTSTRAP_MARKER,
  SKILLS_ROUTING_BOOTSTRAP_MARKER,
  type DataAnalysisState,
  type DataAnalyzerPhase,
} from '../../agent/tasks/data-analyzer/state.js';
import type {
  ConnectionSummary,
  DataAnalysisTask,
} from '../../agent/tasks/data-analyzer/types.js';
import type { ScopeSize } from '../../shared/classify.js';
import type {
  ControllerInput,
  FinalizeResult,
  GateReply,
  Task,
  TaskController,
  TaskOrchestratorDeps,
  TaskResult,
  TaskStateStore,
} from '../task.js';
import { detectFilePaths } from '../../agent/tasks/data-analyzer/file-detect.js';
import { acquirePool } from '../db/pool-cache.js';
// planner-section-task-separation P5.b.1 cutover: section-flow pipeline.
import {
  runSectionFlow,
  buildSkillExecutor,
  type RunSectionFlowResult,
  type L2Fallback,
} from '../../agent/section-flow/index.js';
import { buildCatalogFromRegistry } from '../../agent/content-gen/plan-tree-helpers.js';
import { runSkill, type SkillRunnerDeps } from '../skills/invoke.js';
import { runAnswerQuestionTask } from '../../agent/tasks/data-analyzer/answer-question-section.js';
import { PATHS } from '../../shared/paths.js';

const log = getLogger('data-analyzer:orchestrator');

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class DataAnalyzerOrchestratorController implements TaskController {
  readonly id = 'data-analyzer';

  private deps?: TaskOrchestratorDeps;
  private _request?: string;
  private _connections: readonly ConnectionSummary[] = [];
  /** Scope tier for this run. Captured from input.classification.scope. */
  private _tier: ScopeSize = 'M';
  private _listId: string | undefined;
  /**
   * Parent list id for drill-down runs (Phase 5.3 of
   * plans/analyzers/data-analyzer.md). Captured from
   * `ControllerInput.parentListId` (drill-down click in the report
   * pane → chat.send carries it through). Stamped on the new
   * TodoList in `createList` so the todos pane + Report Pane can
   * render the parent edge.
   */
  private _parentListId: string | undefined = undefined;

  attachDeps(deps: TaskOrchestratorDeps): void {
    this.deps = deps;
  }

  // -- start ----------------------------------------------------------------

  async buildInitialTasks(input: ControllerInput): Promise<Task[]> {
    this._request = input.message;
    this._tier = clampToDataAltitude(input.classification?.scope ?? 'M');
    this._parentListId = input.parentListId;

    // Phase 1.H: register ephemeral connections for any local file
    // paths the user typed in their prompt (e.g.
    // `/data-analyze find pii in /tmp/customers.json`). The user
    // shouldn't need to register every one-off file in the Data
    // Sources pane just to ask about it. Ephemerals live in the
    // pool's in-memory entries only -- not written to
    // db-connections.json -- and are auto-approved (the user just
    // typed the path; explicit consent).
    await this._registerEphemeralFromPrompt(input);

    this._connections = await this._loadConnections(input);

    log.info(
      {
        tier:        this._tier,
        connections: this._connections.length,
      },
      'data-analyzer scope tier captured',
    );

    // planner-section-task-separation P5.b.2: emit the bootstrap
    // pass-through; the orchestrator's `next()` detects the marker
    // and runs the section-flow pipeline. The pre-cutover rerun
    // branch (afterRerunBootstrap + reconstruct prior task list) was
    // deleted -- rerun semantics no longer apply now that per-task
    // items don't exist; users re-issue the request to get a fresh
    // section-flow report (parentListId is still threaded via
    // `_parentListId` so the workbench can thread the new list under
    // the prior one).
    return [{
      index: 0,
      description: 'Data Analyzer: starting section-flow pipeline...',
      kind: 'transform',
      intent: 'data-analysis',
      passThrough: true,
      userMessage: SKILLS_ROUTING_BOOTSTRAP_MARKER,
      outputFormat: 'text',
      stateKey: K_PLAN_RESULT,
      persisted: true,
    }];
  }

  /**
   * Detect file paths in the prompt and register them as ephemeral
   * connections in the data-driver pool. Auto-approves each so the
   * connection-approval gate doesn't fire on the analyzer's first
   * tool call against them (the user explicitly typed the path).
   *
   * Best-effort: a failure here just means the user doesn't get the
   * one-off ephemeral; they can still register manually in the
   * Data Sources pane.
   */
  private async _registerEphemeralFromPrompt(input: ControllerInput): Promise<void> {
    if (this.deps === undefined) return;
    const repoPath = this.deps.session.repoPath;
    if (!repoPath) return;
    const detected = detectFilePaths(input.message, repoPath);
    if (detected.length === 0) return;
    let pool;
    try {
      pool = await acquirePool(repoPath);
    } catch (err) {
      log.warn({ err: (err as Error).message }, '_registerEphemeralFromPrompt: acquirePool failed');
      return;
    }
    for (const f of detected) {
      try {
        await pool.registerEphemeral({
          id:    f.connectionId,
          kind:  f.kind,
          family: 'file',
          label: f.typed,
          path:  f.absPath,
        });
        // Auto-approve so the analyzer's first tool call against
        // this connection doesn't trigger the user gate (Phase 4 of
        // plans/access-gate.md). The user already gave consent by
        // typing the path. Seed both kinds: db_sql/db_kv tools key on
        // 'connection', db_file_* tools resolve the connection-id to
        // the file path and key on 'fs-path'.
        const access = this.deps?.session.access;
        if (access !== undefined) {
          access.approve('connection', f.connectionId);
          access.approve('fs-path', f.absPath);
        }
        log.info(
          { id: f.connectionId, kind: f.kind, path: f.absPath },
          'data-analyzer: registered ephemeral connection from prompt',
        );
      } catch (err) {
        log.warn(
          { err: (err as Error).message, path: f.absPath },
          '_registerEphemeralFromPrompt: registerEphemeral failed',
        );
      }
    }
  }

  private async _loadConnections(input: ControllerInput): Promise<readonly ConnectionSummary[]> {
    if (this.deps === undefined) return [];
    void input;
    return loadActiveConnections(this.deps.session);
  }

  // -- state init ----------------------------------------------------------

  private ensureStateInitialized(state: TaskStateStore): void {
    if (state.has(K_STATE)) return;
    if (this._request === undefined) {
      log.error('ensureStateInitialized: instance fields missing (resume without buildInitialTasks?)');
      return;
    }
    const initial: DataAnalysisState = {
      request:      this._request,
      tier:         this._tier,
      connections:  this._connections,
      listId:       '',
      childListIds: [],
      truncated:    false,
      cancelled:    false,
    };
    state.set(K_STATE, initial);
    state.set(K_PHASE, 'planning' as DataAnalyzerPhase);
  }

  // -- main router ---------------------------------------------------------

  async next(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Promise<Task[] | null> {
    this.ensureStateInitialized(state);
    const phase = state.get<DataAnalyzerPhase>(K_PHASE) ?? 'planning';
    log.info({ phase, completed: completed.description, gateAction: gateReply?.action }, 'next()');

    // Resume entry: a buildResumeTask transform fires first; detect
    // by output marker and dispatch on persisted phase.
    if (completed.output.trim() === RESUME_BOOTSTRAP_MARKER) {
      return this.afterResumeBootstrap(state, phase);
    }

    // Post-cutover bootstrap. buildInitialTasks emits a single
    // pass-through transform carrying SKILLS_ROUTING_BOOTSTRAP_MARKER;
    // we detect the marker and invoke `afterSkillsRoutingBootstrap`
    // which runs the new section-flow pipeline end-to-end.
    if (completed.output.trim() === SKILLS_ROUTING_BOOTSTRAP_MARKER) {
      return this.afterSkillsRoutingBootstrap(state);
    }

    // Post-cutover (P5.b.2): the only live dispatch is 'planning' ->
    // afterSkillsRoutingBootstrap (which runs the new section-flow
    // pipeline). Legacy phases ('plan-approval' / 'analyzing' /
    // 'reviewing' / 'synthesising') are normalised to 'done' by the
    // restoreState shim, so they should never reach this switch.
    switch (phase) {
      case 'planning':       return this.afterSkillsRoutingBootstrap(state);
      case 'present':        return null;
      case 'done':           return null;
      default:               return null;
    }
  }

  // -- section-flow entrypoint (planner-section-task-separation P5.b) -----

  /**
   * Section-flow path. The bootstrap pass-through emitted by
   * `buildInitialTasks` lands here; we run `runSectionFlow`
   * (Scope -> Investigation Plan -> per-TODO orchestrator ->
   * report assembly + review) end-to-end and stash the final
   * markdown in K_SYNTH_RESULT for `finalize()` to surface.
   *
   * The method name is preserved post-cutover for state-machine
   * dispatch compatibility (case 'planning' -> this method); the
   * body is the new pipeline, not the legacy meta-skills route.
   */
  private async afterSkillsRoutingBootstrap(state: TaskStateStore): Promise<Task[] | null> {
    if (this.deps === undefined) {
      log.error('afterSkillsRoutingBootstrap: deps missing');
      return null;
    }
    if (this._request === undefined || this._request.length === 0) {
      log.error('afterSkillsRoutingBootstrap: request missing');
      return null;
    }

    // ----- planner-section-task-separation P5.b.1 cutover ------------------
    //
    // Replaces the meta-skills pipeline body with `runSectionFlow`. The new
    // pipeline runs Scope (Step 1) -> Investigation Plan (Step 2) ->
    // per-TODO orchestrator (P3) -> final report (P4) end-to-end and
    // returns the assembled markdown. Per-TODO skill execution flows
    // through `buildSkillExecutor`, which resolves `inputs.{node, literal,
    // question, context}` bindings against prior outputs and invokes
    // `runSkill(leaf.skill, resolvedInput, runnerDeps)`. The L2 fallback
    // (Q10) calls `data.answer-question` when a TODO's section tree
    // cannot produce a coherent result.
    //
    // Legacy paths kept as unreachable code in this commit so revert is
    // one click; P5.b.2 deletes them.
    const ca = state.get<DataAnalysisState>(K_STATE)!;
    const session = this.deps.session;
    const runId = `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const workingMemoryDir = PATHS.workingMemoryRun(session.id, runId);

    const resolveProvider = (affinity: 'local' | 'cloud' | 'auto') => {
      if (affinity === 'local') { return session.ollamaProvider; }
      if (affinity === 'cloud') { return session.claudeProvider ?? session.ollamaProvider; }
      return session.resolver.resolve('data-analyzer', 'meta');
    };

    const runnerDeps: SkillRunnerDeps = {
      session,
      resolveProvider,
      ...(this.deps.abortController?.signal ? { signal: this.deps.abortController.signal } : {}),
    };

    // Section-flow's planner / shape / review calls use the highest-
    // quality provider available. Defaults to the active cloud provider
    // when one is configured (matches the prior synthesise step's
    // resolver choice); falls back to local Ollama otherwise.
    const sectionFlowProvider = session.claudeProvider ?? session.ollamaProvider;

    const executeLeaf = buildSkillExecutor({
      runnerDeps,
      userQuestion: this._request,
      contextBag: {
        sessionId:    session.id,
        codeRepoPath: session.repoPath ?? '',
        primaryConnection: this._connections[0]?.id ?? '',
      },
      // Per-leaf shape resolution (Stage 2a of the 2-step executor)
      // takes the leaf objective + skill schema + prior outputs and
      // emits a validated args dict. That is a small structured-
      // output role -- well-suited to the local Ollama tier, same
      // family as the LOCAL CONTEXT-ASSEMBLY memory ops. Routing it
      // here saves the cloud quota for actual reasoning work
      // (planner / reviewer / synthesis). Skill body execution still
      // honours each skill's declared `providerAffinity` via
      // `runnerDeps.resolveProvider` -- this field only controls
      // shape-resolve.
      provider: session.ollamaProvider,
    });

    const l2Fallback: L2Fallback = async ({ todo, reason }) => {
      // Route through `runAnswerQuestionTask`, which wraps the L2
      // `data.answer-question` skill with the right input shape
      // (`question` + `connections` + `priorContext`) and runs it via
      // `runL2Skill`. The previous implementation used `runSkill`,
      // which only sees the L1 registry -- `data.answer-question` is
      // L2-only, so every fallback bounced with `unknown-skill`.
      try {
        const outcome = await runAnswerQuestionTask({
          session,
          task: {
            itemId:   todo.id,
            kind:     'free-form',
            question: todo.objective,
            origin:   'plan',
          },
          connections: this._connections,
          ...(this.deps?.abortController?.signal !== undefined
            ? { signal: this.deps.abortController.signal }
            : {}),
        });
        const answer = outcome.result.answer.trim();
        return answer.length > 0
          ? answer
          : `_(L2 fallback returned no content for "${todo.objective}"; reason: ${reason})_`;
      } catch (err) {
        log.warn({ err: (err as Error).message, todoId: todo.id }, 'L2 fallback failed');
        return `_(L2 fallback failed for "${todo.objective}": ${(err as Error).message})_`;
      }
    };

    // Create the workbench TodoList up front so `updateListBody` has
    // somewhere to write the final report. Items per TODO (Q8 two-level
    // visibility) are added in P6; v1 ships with just the list-level
    // body write.
    if (this.deps.todos !== undefined && this._listId === undefined) {
      try {
        const list = await this.deps.todos.createList({
          sessionId:   session.id,
          title:       `Data Analysis: ${this._request.slice(0, 60)}`,
          description: this._request,
          ...(this._parentListId !== undefined ? { parentListId: this._parentListId } : {}),
        });
        this._listId = list.id;
        state.set(K_STATE, { ...ca, listId: list.id });
      } catch (err) {
        log.warn({ err }, 'afterSkillsRoutingBootstrap: createList failed; proceeding without workbench list');
      }
    }

    this.emitLiveStep('section-flow', `[data-analyzer | tier=${this._tier}] running section-flow pipeline...\n`);

    // Q8 TodoList wiring: as section-flow emits progress events, we
    // mirror them to the workbench list -- one TodoItem per TODO,
    // with reviewable-root sub-items + status text living in
    // meta.sectionFlow.* (the framework treats meta as agent-opaque,
    // so we own the shape).
    const todosApi = this.deps.todos;
    const listId   = this._listId;
    const todoIdToItemId = new Map<string, string>();

    const onProgress = async (event: { readonly phase: string; readonly message: string; readonly meta?: Record<string, unknown> }) => {
      // Chat-stream mirror (existing behavior).
      this.emitLiveStep('section-flow', `[${event.phase}] ${event.message}\n`);
      if (todosApi === undefined || listId === undefined) {
        return;
      }
      try {
        await this._wireProgressToTodos(todosApi, listId, todoIdToItemId, event);
      } catch (err) {
        log.warn({ err: (err as Error).message, phase: event.phase }, 'onProgress: TodoList wiring failed (swallowed)');
      }
    };

    // Skill catalog the section planner composes from. Without this the
    // planner has no ground-truth signal about which skill ids exist and
    // pattern-matches on the worked example's placeholder ids (root cause
    // of the P7 live-test failure). Owners:
    //   - `data-analyzer` for primary data skills (profile / sample / etc.)
    //   - `code-analyzer` for code-side skills the planner needs when the
    //     question crosses domains (e.g. mapping JSON test data against a
    //     Pydantic class definition needs both `data.*` profiling AND
    //     `code.class.extract-fields` to read the actual class source --
    //     omitting code-side made the planner default to data-only skills
    //     and infer the "class" from JSON shape, giving tautological 1:1
    //     mappings that don't actually reflect the class definition)
    //   - `shared` for cross-domain synthesis helpers
    // `includeL2Fallback: true` keeps the L2 dispatch skill visible to
    // the planner if it chooses to lean on it directly.
    const sectionFlowCatalog = buildCatalogFromRegistry({
      owners:            ['data-analyzer', 'code-analyzer', 'shared'],
      includeL2Fallback: true,
    });
    log.info({ catalogSize: sectionFlowCatalog.length }, 'section-flow catalog assembled');

    let result: RunSectionFlowResult;
    try {
      result = await runSectionFlow({
        question:         this._request,
        provider:         sectionFlowProvider,
        // Local-tier provider: working-memory ops (shape /
        // incremental / bullets) + embeddings (bullet cache +
        // semantic ANN). The memory prompts declare themselves
        // "LOCAL CONTEXT-ASSEMBLY model"; this is the wiring that
        // makes that real. Cloud providers return [] from embed()
        // per CLAUDE.md and burn quota on what are supposed to be
        // cheap local-tier ops.
        localProvider:    session.ollamaProvider,
        executeLeaf,
        l2Fallback,
        runId,
        workingMemoryDir,
        catalog:          sectionFlowCatalog,
        onProgress,
      });
    } catch (err) {
      const errMsg = (err as Error).message;
      log.error({ err: errMsg }, 'runSectionFlow threw; emitting error report');
      const fallbackMd = `# Data Analysis Report\n\n_Section-flow pipeline failed: ${errMsg}_\n\nSee the chat trace for details.`;
      state.set(K_SYNTH_RESULT, fallbackMd);
      state.set(K_PHASE, 'done' as DataAnalyzerPhase);
      if (this.deps.todos !== undefined && this._listId !== undefined) {
        try { await this.deps.todos.updateListBody(this._listId, fallbackMd); } catch { /* swallow */ }
      }
      this.emitLiveStep('section-flow', '', true);
      return null;
    }

    log.info(
      {
        entryCount:           result.entries.length,
        l2FallbackUsed:       result.trace.perTodo.some(t => t.l2FallbackUsed),
        reportExhausted:      result.trace.reportReview.exhausted,
        structuralReviseUsed: result.trace.reportReview.structuralReviseUsed,
        addedScopeGapTodos:   result.trace.reportReview.addedScopeGapTodos.length,
      },
      'section-flow run complete',
    );

    state.set(K_SYNTH_RESULT, result.finalReport);
    state.set(K_PHASE, 'done' as DataAnalyzerPhase);
    state.set(K_PLAN_TASKS, [] as DataAnalysisTask[]);

    if (this.deps.todos !== undefined && this._listId !== undefined) {
      try {
        await this.deps.todos.updateListBody(this._listId, result.finalReport);
      } catch (err) {
        log.warn({ err }, 'afterSkillsRoutingBootstrap: updateListBody failed');
      }
    }

    this.emitLiveStep('section-flow', '', true);
    return null;
  }

  /**
   * Q8 wire-up. Routes a section-flow ProgressEvent to the TodosApi:
   *   - 'plan'                : addItem per TODO; populate
   *                             todoIdToItemId map.
   *   - 'todo-start'          : markInProgress.
   *   - 'todo-complete'       : updateItemMeta with sub-items + the
   *                             L2 / exhausted bits; markComplete.
   *   - 'scope-gap-todo-added': addItem with origin badge in meta.
   *   - other phases          : no-op (chat-stream mirror in caller
   *                             already covers them).
   */
  private async _wireProgressToTodos(
    todos:           NonNullable<TaskOrchestratorDeps['todos']>,
    listId:          string,
    todoIdToItemId:  Map<string, string>,
    event:           { readonly phase: string; readonly message: string; readonly meta?: Record<string, unknown> },
  ): Promise<void> {
    const meta = event.meta ?? {};
    switch (event.phase) {
      case 'plan': {
        const todos_ = meta['todos'];
        if (!Array.isArray(todos_)) {
          return;
        }
        for (const t of todos_) {
          if (t === null || typeof t !== 'object' || Array.isArray(t)) { continue; }
          const todoSpec = t as Record<string, unknown>;
          const todoId    = typeof todoSpec['id']        === 'string' ? todoSpec['id']        : '';
          const objective = typeof todoSpec['objective'] === 'string' ? todoSpec['objective'] : '';
          const origin    = typeof todoSpec['origin']    === 'string' ? todoSpec['origin']    : 'initial';
          if (todoId === '' || objective === '') { continue; }
          const item = await todos.addItem(listId, {
            title:       objective.length > 80 ? `${objective.slice(0, 77)}...` : objective,
            description: objective,
            meta: {
              sectionFlow: {
                todoId,
                origin,
                subItems: [] as readonly unknown[],
              },
            },
          });
          todoIdToItemId.set(todoId, item.id);
        }
        return;
      }
      case 'todo-start': {
        const todoId = typeof meta['todoId'] === 'string' ? meta['todoId'] : '';
        const itemId = todoIdToItemId.get(todoId);
        if (itemId === undefined) { return; }
        try { await todos.markInProgress(itemId); } catch { /* state machine may reject; swallow */ }
        return;
      }
      case 'todo-complete': {
        const todoId = typeof meta['todoId'] === 'string' ? meta['todoId'] : '';
        const itemId = todoIdToItemId.get(todoId);
        if (itemId === undefined) { return; }
        await todos.updateItemMeta(itemId, {
          sectionFlow: {
            todoId,
            l2:        meta['l2']       ?? false,
            replans:   meta['replans']  ?? 0,
            fallback:  meta['fallback'],
            subItems:  meta['subItems'] ?? [],
          },
        });
        try { await todos.markComplete(itemId); } catch { /* swallow */ }
        return;
      }
      case 'scope-gap-todo-added': {
        const todoId    = typeof meta['todoId']    === 'string' ? meta['todoId']    : '';
        const objective = typeof meta['objective'] === 'string' ? meta['objective'] : '';
        if (todoId === '' || objective === '') { return; }
        const item = await todos.addItem(listId, {
          title:       `+ scope gap: ${objective.length > 60 ? objective.slice(0, 57) + '...' : objective}`,
          description: objective,
          meta: {
            sectionFlow: {
              todoId,
              origin: 'report-review-escalation',
              subItems: [] as readonly unknown[],
            },
          },
        });
        todoIdToItemId.set(todoId, item.id);
        try { await todos.markInProgress(item.id); } catch { /* swallow */ }
        return;
      }
      default:
        return;
    }
  }

  /** Emit a brainstorm-style `liveStep` event. Mirrors the
   *  code-analyzer's emitter. */
  private emitLiveStep(step: string, text: string, done = false): void {
    if (this.deps === undefined) { return; }
    try {
      this.deps.send({
        id: this.deps.requestId,
        stream: 'liveStep',
        data: {
          agent: 'data-analyzer',
          step,
          text,
          ...(done ? { done: true } : {}),
        },
      });
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'emitLiveStep: send failed (swallowed)');
    }
  }

  // -- finalize ------------------------------------------------------------

  finalize(state: TaskStateStore): FinalizeResult {
    const md = state.get<string>(K_SYNTH_RESULT) ?? '_(no synthesis output)_';
    return { output: md, format: 'markdown' };
  }

  // -- resume hooks --------------------------------------------------------

  restoreState(state: TaskStateStore): void {
    const persisted = state.get<DataAnalysisState>(K_STATE);
    if (!persisted) return;
    this._request = persisted.request;
    this._tier = persisted.tier;
    this._connections = persisted.connections;
    this._listId = persisted.listId.length > 0 ? persisted.listId : undefined;
    // Per design §14, connection approvals do not persist across
    // sessions. On resume the new Session has an empty AccessStore;
    // the analyzer's first call against any connection will re-fire
    // the universal access gate (Phase 4 of plans/access-gate.md).

    // planner-section-task-separation P5.b.1 resume shim (Q10
    // migration note). Phases that the legacy per-task state machine
    // produced are unreachable after the cutover -- if a session was
    // mid-orchestration when the rollout happened, treat it as
    // cancelled with a partial-report annotation. The user sees their
    // prior body via finalize(); the new run won't try to drive the
    // dead state machine into a phase that no longer exists.
    const phase = state.get<DataAnalyzerPhase>(K_PHASE);
    if (phase === 'planning' || phase === 'plan-approval' || phase === 'analyzing' || phase === 'reviewing' || phase === 'synthesising') {
      log.warn({ phase }, 'restoreState: legacy phase encountered; marking as done with partial-report annotation');
      const prior = state.get<string>(K_SYNTH_RESULT) ?? '';
      const annotated = prior.length > 0
        ? `${prior}\n\n<!-- section-flow: resumed-from-legacy-phase=${phase}; pipeline pre-cutover -->\n`
        : `# Data Analysis Report\n\n_(Resumed from a pre-cutover phase ("${phase}"); the legacy per-task state machine no longer drives. Re-run the request to get a section-flow report.)_\n`;
      state.set(K_SYNTH_RESULT, annotated);
      state.set(K_PHASE, 'done' as DataAnalyzerPhase);
    }
  }

  buildResumeTask(state: TaskStateStore): Task {
    const phase = state.get<DataAnalyzerPhase>(K_PHASE) ?? 'planning';
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

  private async afterResumeBootstrap(
    _state: TaskStateStore,
    phase: DataAnalyzerPhase,
  ): Promise<Task[] | null> {
    log.info({ phase, listId: this._listId }, 'data-analyzer resume entry');
    if (this._request === undefined) {
      return null;
    }
    // Post-cutover (P5.b.2): the restoreState shim normalises every
    // legacy phase ('plan-approval' / 'analyzing' / 'reviewing' /
    // 'synthesising') to 'done' with a partial-report annotation.
    // Resume from 'done' / 'present' is a no-op; resume from 'planning'
    // re-runs the bootstrap. Any other value is treated as 'planning'
    // for forward-compat.
    if (phase === 'done' || phase === 'present') {
      return null;
    }
    return [{
      index: 0,
      description: `Data Analyzer: resuming section-flow pipeline (tier ${this._tier})...`,
      kind: 'transform',
      intent: 'data-analysis',
      passThrough: true,
      userMessage: SKILLS_ROUTING_BOOTSTRAP_MARKER,
      outputFormat: 'text',
      stateKey: K_PLAN_RESULT,
      persisted: true,
    }];
  }

  // Connection-approval gating moved to the universal access
  // dispatcher (Phase 4 of plans/access-gate.md). The orchestrator's
  // role is now just to seed Session.access for ephemeral
  // connections (auto-approved on registration); the dispatcher in
  // agent/tools/executor.ts handles the gate UI for any connection
  // the analyzer asks about that hasn't been approved.

  /**
   * Phase 3.3 of plans/analyzers/data-analyzer.md: when the planner
   * emits a `kind: 'er'` task, generate an ER artifact via the
   * shipped `artifact_er` tool and append a reference section to the
   * report. The artifact itself persists as a TodoItem (the
   * artifact tool routes through `persistArtifact`); we just
   * surface the existence so the user can pivot from report -> ER
   * pane.
   *
   * Connection / tables resolution: each ER task's `scope` carries
   * `connections[]` and `targets[]`. We invoke one artifact per
   * connection, with the union of that connection's targets as the
   * `tables` payload. When scope.connections is unset, we fall
   * through to the artifact's prisma / graph fallback (no `connection`
   * arg) -- the tool itself decides the source priority.
   */
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampToDataAltitude(tier: ScopeSize): ScopeSize {
  switch (tier) {
    case 'XXL':
    case 'XXXL':
    case 'XXXXL':
      return 'XL';
    default:
      return tier;
  }
}

