/**
 * DataAnalyzerOrchestratorController -- the Data Analyzer family's
 * task-controller entry point.
 *
 * Phase 1.E of plans/analyzers/data-analyzer.md. State machine:
 *
 *   planning            -> [plan LLM task]
 *   plan-approval       -> [plan-size gate]   (only when |tasks| > softCap)
 *   analyzing           -> runDataAnalyzer() (inline in next()) +
 *                          [review LLM task]
 *   reviewing           -> apply decision; loop or jump to synthesise
 *   synthesising        -> generateMultiPass() (inline in next())
 *   present             -> [present gate]
 *   done                  (writes list.body)
 *
 * Cloud LLM defaults: plan + review. Local LLM defaults: analyzer
 * tool loop + synthesise. Per-step rebind via the Model Providers
 * pane (see plans/analyzers/data-analyzer.md "LLM routing" section).
 *
 * Resume: restoreState + buildResumeTask + afterResumeBootstrap mirror
 * the code-analyzer's slice-C pattern. Connection approvals are NOT
 * persisted -- they re-prompt on resume per design §14.
 *
 * Phase 1 deliberately omits per-task on-disk caching (Phase 2.4),
 * drill-down (Phase 5), and re-run (Phase 5).
 */

import { getLogger } from '../../shared/logger.js';
import { runDataAnalyzer } from '../../agent/tasks/data-analyzer/analyzer/runner.js';
import {
  buildPlanSystemPrompt,
  renderPlanUserMessage,
} from '../../agent/tasks/data-analyzer/prompts/plan.js';
import {
  buildReviewPrompt,
  REVIEW_SYSTEM,
} from '../../agent/tasks/data-analyzer/prompts/review.js';
import {
  buildMultipassOutlineInput,
  makeSectionBuilder,
  DRILL_DOWN_FALLBACK_SECTION,
} from '../../agent/tasks/data-analyzer/prompts/synthesise-multipass.js';
import { generateMultiPass } from '../../agent/content-gen/index.js';
import { planActions, type PlannedAction, type PlanExecution } from '../../agent/content-gen/plan-actions.js';
import { expandThenReview } from '../../agent/content-gen/review-action.js';
import {
  buildConnectionFingerprint,
  readCachedResult,
  writeCachedResult,
  type CacheKeyInput,
} from '../../agent/tasks/data-analyzer/cache.js';
import {
  K_STATE,
  K_PHASE,
  K_RETRIES,
  K_FOLLOWUP_COUNT,
  K_PLAN_RESULT,
  K_PLAN_TASKS,
  K_REVIEW_RESULT,
  K_SYNTH_RESULT,
  K_ACCEPTED,
  K_HISTORY,
  K_RAW_EXECUTIONS,
  RESUME_BOOTSTRAP_MARKER,
  SKILLS_ROUTING_BOOTSTRAP_MARKER,
  type DataAnalysisState,
  type DataAnalyzerPhase,
  type AcceptedTask,
} from '../../agent/tasks/data-analyzer/state.js';
import {
  pipelineResultToAcceptedTasks,
  readSkillsRoutingFromEnv,
  runSkillsPipeline,
} from '../../agent/tasks/data-analyzer/skills-pipeline.js';
import type {
  ConnectionSummary,
  DataAnalysisTask,
  DataAnalyzerResult,
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
import { stripFences } from '../../agent/tasks/_shared/json-extract.js';
import { executeTool } from '../../agent/tools/executor.js';
import { detectFilePaths } from '../../agent/tasks/data-analyzer/file-detect.js';
import { acquirePool } from '../db/pool-cache.js';

const log = getLogger('data-analyzer:orchestrator');

// ---------------------------------------------------------------------------
// Per-tier task caps (slice 1.10.c)
// ---------------------------------------------------------------------------

interface TierCaps {
  /** Soft cap: above this, the plan-size approval gate fires. */
  readonly softTaskCap: number;
  /** Hard cap: planner output is silently trimmed to this length. */
  readonly hardTaskCap: number;
}

const TIER_CAPS: Readonly<Record<ScopeSize, TierCaps>> = {
  S:     { softTaskCap: 2,  hardTaskCap: 4  },
  M:     { softTaskCap: 4,  hardTaskCap: 6  },
  L:     { softTaskCap: 6,  hardTaskCap: 10 },
  XL:    { softTaskCap: 8,  hardTaskCap: 12 },
  XXL:   { softTaskCap: 8,  hardTaskCap: 12 },
  XXXL:  { softTaskCap: 8,  hardTaskCap: 12 },
  XXXXL: { softTaskCap: 8,  hardTaskCap: 12 },
};

function capsForTier(tier: ScopeSize | undefined): TierCaps {
  return TIER_CAPS[tier ?? 'M'];
}

const MAX_FOLLOWUPS = 6;

/**
 * Sentinel that buildInitialTasks emits when `rerunFromListId` is
 * set (Phase 5.1 of plans/analyzers/data-analyzer.md). The afterPlan
 * handler detects the sentinel and reconstructs DataAnalysisTask[]
 * from the prior list's items instead of parsing planner output.
 */
const RERUN_BOOTSTRAP_MARKER = '__rerun-bootstrap__';
const MAX_RETRIES_PER_TASK = 2;

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
  /**
   * Re-run mode (Phase 5.1). Reserved -- wired through but not yet
   * acted on; the re-run command will land alongside this slice.
   */
  private _rerunFromListId: string | undefined = undefined;

  attachDeps(deps: TaskOrchestratorDeps): void {
    this.deps = deps;
  }

  // -- start ----------------------------------------------------------------

  async buildInitialTasks(input: ControllerInput): Promise<Task[]> {
    this._request = input.message;
    this._tier = clampToDataAltitude(input.classification?.scope ?? 'M');
    this._parentListId = input.parentListId;
    this._rerunFromListId = input.rerunFromListId;

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
        caps:        capsForTier(this._tier),
        connections: this._connections.length,
      },
      'data-analyzer scope tier captured',
    );

    // Phase 5.1 of plans/analyzers/data-analyzer.md: re-run path
    // skips the plan LLM call entirely and reconstructs the task
    // list from the prior list's items in afterRerunBootstrap.
    if (this._rerunFromListId !== undefined) {
      return [{
        index: 0,
        description: `Data Analyzer: re-running from prior list ${this._rerunFromListId.slice(0, 8)}...`,
        kind: 'transform',
        intent: 'data-analysis',
        passThrough: true,
        userMessage: RERUN_BOOTSTRAP_MARKER,
        outputFormat: 'text',
        stateKey: K_PLAN_RESULT,
        persisted: true,
      }];
    }

    // data-analyzer-skills.md step 4b: skills-routing path -- when
    // the feature flag is on, emit a bootstrap pass-through task; the
    // orchestrator's `next()` detects the marker and runs the skills
    // pipeline (classify → select → runSkill per scoped → calibrate)
    // inline, then queues the legacy synthesise step. The legacy plan
    // LLM call + per-task analyzer runner are bypassed entirely. The
    // flag is also captured in `state.skillsRouting` (via
    // `ensureStateInitialized`) so a resume of an in-flight run
    // dispatches consistently regardless of env-var changes.
    if (readSkillsRoutingFromEnv()) {
      log.info({ }, 'data-analyzer: skills-routing path enabled via env var');
      return [{
        index: 0,
        description: 'Data Analyzer: routing question through skills pipeline...',
        kind: 'transform',
        intent: 'data-analysis',
        passThrough: true,
        userMessage: SKILLS_ROUTING_BOOTSTRAP_MARKER,
        outputFormat: 'text',
        stateKey: K_PLAN_RESULT,
        persisted: true,
      }];
    }

    return [{
      index: 0,
      description: `Data Analyzer: planning tasks (tier ${this._tier})...`,
      kind: 'llm',
      intent: 'data-analysis',
      systemPrompt: buildPlanSystemPrompt(this._tier),
      userMessage: renderPlanUserMessage(this._request, this._connections, this._tier),
      resolverAgent: 'data-analyzer',
      resolverStep: 'plan',
      providerHint: 'claude',
      temperature: 0,
      maxTokens: 2500,
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
    try {
      const r = await executeTool(
        { id: 'discover', name: 'db_list_connections', input: {} },
        { session: this.deps.session },
      );
      if (r.isError) {
        log.warn({ content: r.content.slice(0, 200) }, '_loadConnections: db:list_connections failed');
        return [];
      }
      // The driver returns structured rows alongside the markdown
      // summary in `r.metadata`. Until we tighten the executor's
      // return shape, parse the JSON-ish rows out of metadata when
      // present; fall back to an empty list.
      const rawRows = (r as { metadata?: { rows?: unknown } }).metadata?.rows;
      const rows = Array.isArray(rawRows) ? rawRows : [];
      void input;
      return rows.map((row): ConnectionSummary => {
        const r2 = row as Record<string, unknown>;
        const family = (typeof r2['family'] === 'string' ? r2['family'] : 'other') as ConnectionSummary['family'];
        return {
          id:          typeof r2['id'] === 'string' ? r2['id'] : '',
          family,
          kind:        typeof r2['kind'] === 'string' ? r2['kind'] : '',
          ...(typeof r2['label'] === 'string' ? { label: r2['label'] as string } : {}),
          prod:        r2['prod'] === true,
          hasPiiConfig: r2['hasPiiConfig'] === true,
        };
      }).filter(c => c.id.length > 0);
    } catch (err) {
      log.warn({ err: (err as Error).message }, '_loadConnections: threw');
      return [];
    }
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
      // data-analyzer-skills.md step 4b: capture the routing flag at
      // run start so a re-run / resume keeps the original behaviour
      // even if the env var has flipped in the meantime.
      skillsRouting: readSkillsRoutingFromEnv(),
    };
    state.set(K_STATE, initial);
    state.set(K_PHASE, 'planning' as DataAnalyzerPhase);
    state.set(K_RETRIES, {} as Record<string, number>);
    state.set(K_FOLLOWUP_COUNT, 0);
    state.set(K_ACCEPTED, [] as AcceptedTask[]);
    state.set(K_HISTORY, [] as DataAnalyzerResult[]);
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

    // Phase 5.1: re-run path. buildInitialTasks queued a transform
    // task carrying RERUN_BOOTSTRAP_MARKER instead of the plan LLM
    // task; reconstruct the DataAnalysisTask[] from the prior list's
    // items and skip straight to beginAnalysis.
    if (this._rerunFromListId !== undefined && completed.output.trim() === RERUN_BOOTSTRAP_MARKER) {
      return this.afterRerunBootstrap(state);
    }

    // data-analyzer-skills.md step 4b: skills-routing path.
    // buildInitialTasks emitted SKILLS_ROUTING_BOOTSTRAP_MARKER;
    // run the meta-skills pipeline inline + queue synthesise.
    if (completed.output.trim() === SKILLS_ROUTING_BOOTSTRAP_MARKER) {
      return this.afterSkillsRoutingBootstrap(state);
    }

    switch (phase) {
      case 'planning':       return this.afterPlan(completed, state);
      case 'plan-approval':  return this.afterPlanApprovalGate(gateReply, state);
      case 'analyzing':      return this.runNextAnalyzerTask(state);
      case 'reviewing':      return this.afterReview(completed, state);
      case 'synthesising':   return this.afterSynthesise(completed, state);
      case 'present':        return null;
      case 'done':           return null;
    }
  }

  // -- plan -> approval ----------------------------------------------------

  private async afterPlan(completed: TaskResult, state: TaskStateStore): Promise<Task[] | null> {
    const planRaw = completed.output;
    let parsed: { tasks: unknown[] } | null = null;
    try {
      parsed = JSON.parse(stripFences(planRaw));
    } catch (err) {
      log.error({ err: (err as Error).message }, 'afterPlan: plan output not parseable');
    }
    if (!parsed || !Array.isArray(parsed.tasks)) {
      // Plan failed to parse. Mark cancelled and finalise; subsequent
      // resume sees cancelled=true and exits cleanly.
      const ca = state.get<DataAnalysisState>(K_STATE)!;
      state.set(K_STATE, { ...ca, cancelled: true });
      state.set(K_PHASE, 'done' as DataAnalyzerPhase);
      return null;
    }

    const caps = capsForTier(this._tier);
    const planned: DataAnalysisTask[] = (parsed.tasks as Array<Record<string, unknown>>)
      .slice(0, caps.hardTaskCap)
      .map((raw): DataAnalysisTask => {
        const kind = (typeof raw['kind'] === 'string' ? raw['kind'] : 'free-form') as DataAnalysisTask['kind'];
        const question = typeof raw['question'] === 'string' ? raw['question'] : '';
        const scopeRaw = (raw['scope'] ?? {}) as Record<string, unknown>;
        const scope: DataAnalysisTask['scope'] = {
          ...(Array.isArray(scopeRaw['connections']) ? { connections: scopeRaw['connections'].filter((s): s is string => typeof s === 'string') } : {}),
          ...(Array.isArray(scopeRaw['targets']) ? { targets: scopeRaw['targets'].filter((s): s is string => typeof s === 'string') } : {}),
        };
        // Placeholder itemId; replaced with the framework-assigned
        // id by the addItem block below before the plan lands in
        // K_PLAN_TASKS.
        return {
          itemId: '',
          kind,
          question,
          ...(scope.connections !== undefined || scope.targets !== undefined ? { scope } : {}),
          origin: 'plan',
        };
      });

    state.set(K_PLAN_TASKS, planned);

    // Create TodoList + per-task items. The block is shared with
    // afterRerunBootstrap (Phase 5.1) so both entry points end up
    // with the same persisted-todos shape.
    await this._persistTaskList(planned, state);

    // Plan-approval gate fires when planner emitted more than the soft cap.
    if (planned.length > caps.softTaskCap) {
      state.set(K_PHASE, 'plan-approval' as DataAnalyzerPhase);
      return [{
        index: 1,
        description: `Plan has ${planned.length} tasks (tier ${this._tier}). Approve, trim, or cancel?`,
        kind: 'transform',
        intent: 'data-analysis',
        passThrough: true,
        userMessage: renderPlanSummary(planned, caps),
        outputFormat: 'markdown',
        requiresGate: true,
        gateTitle: `Data Analyzer plan size approval (tier ${this._tier})`,
        gateActions: [
          { name: 'approve', label: 'Approve all' },
          { name: 'trim-to-soft', label: `Trim to first ${caps.softTaskCap}` },
          { name: 'cancel', label: 'Cancel run' },
        ],
        persisted: true,
      }];
    }

    // No gate -- begin analysis directly.
    return this.beginAnalysis(planned, state);
  }

  private async afterPlanApprovalGate(
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Promise<Task[] | null> {
    const action = gateReply?.action ?? 'cancel';
    const planned = state.get<DataAnalysisTask[]>(K_PLAN_TASKS) ?? [];
    if (action === 'cancel') {
      const ca = state.get<DataAnalysisState>(K_STATE)!;
      state.set(K_STATE, { ...ca, cancelled: true });
      state.set(K_PHASE, 'done' as DataAnalyzerPhase);
      return null;
    }
    if (action === 'trim-to-soft') {
      const trimmed = planned.slice(0, capsForTier(this._tier).softTaskCap);
      state.set(K_PLAN_TASKS, trimmed);
      return this.beginAnalysis(trimmed, state);
    }
    // approve
    return this.beginAnalysis(planned, state);
  }

  /**
   * Create the TodoList + addItem rows for a planned task list and
   * stamp the framework-assigned item ids back onto K_PLAN_TASKS.
   * Shared between afterPlan (planner-driven) and afterRerunBootstrap
   * (Phase 5.1, prior-list-driven). Best-effort: a failure here just
   * means the run proceeds without the persisted list (degraded UX
   * but the analyzer still does its job).
   */
  private async _persistTaskList(
    planned: DataAnalysisTask[],
    state: TaskStateStore,
  ): Promise<void> {
    if (this.deps?.todos === undefined) return;
    try {
      const list = await this.deps.todos.createList({
        sessionId:   this.deps.session.id,
        title:       `Data Analysis: ${this._request?.slice(0, 60) ?? '(no request)'}`,
        description: this._request ?? '',
        // Phase 5.3: stamp parent edge for drill-down runs so the
        // todos pane + Report Pane can thread the new list under
        // the prior one.
        ...(this._parentListId !== undefined ? { parentListId: this._parentListId } : {}),
      });
      this._listId = list.id;
      const ca = state.get<DataAnalysisState>(K_STATE)!;
      state.set(K_STATE, { ...ca, listId: list.id });
      const withIds: DataAnalysisTask[] = [];
      for (const t of planned) {
        const item = await this.deps.todos.addItem(list.id, {
          title: shortTitleFor(t),
          description: t.question,
          meta: {
            kind: t.kind,
            ...(t.scope !== undefined ? { scope: t.scope } : {}),
            origin: t.origin,
            retryCount: 0,
          },
        });
        withIds.push({ ...t, itemId: item.id });
      }
      state.set(K_PLAN_TASKS, withIds);
    } catch (err) {
      log.warn({ err }, '_persistTaskList: createList / addItem failed');
    }
  }

  /**
   * Re-run path bootstrap (Phase 5.1 of plans/analyzers/data-analyzer.md).
   * The pass-through transform in buildInitialTasks emitted
   * RERUN_BOOTSTRAP_MARKER instead of running the planner; here we
   * walk the prior list's items, reconstruct DataAnalysisTask[] from
   * their `description` + `meta`, then proceed straight into
   * `beginAnalysis` (which creates a fresh TodoList stamped with
   * `parentListId = priorListId` so the new run threads under it).
   *
   * Defensive paths: if the prior list is gone or yields no
   * parseable items, fall back to a single free-form task carrying
   * the original request -- the user still gets SOMETHING to compare
   * against.
   */
  private async afterRerunBootstrap(state: TaskStateStore): Promise<Task[] | null> {
    if (this.deps?.todos === undefined || this._rerunFromListId === undefined) {
      log.error('afterRerunBootstrap: deps.todos or rerunFromListId missing');
      const ca = state.get<DataAnalysisState>(K_STATE);
      if (ca !== undefined) state.set(K_STATE, { ...ca, cancelled: true });
      state.set(K_PHASE, 'done' as DataAnalyzerPhase);
      return null;
    }
    const priorListId = this._rerunFromListId;
    const priorList = await this.deps.todos.getList(priorListId);
    if (priorList === null) {
      log.warn({ priorListId }, 'afterRerunBootstrap: prior list not found; falling back to single-task plan');
      return this._beginRerunWith(buildFallbackTaskFromRequest(this._request ?? ''), priorListId, state);
    }

    const reconstructed: DataAnalysisTask[] = [];
    for (const item of priorList.items ?? []) {
      const task = reconstructTaskFromItem(item);
      if (task !== null) reconstructed.push(task);
    }
    log.info(
      { priorListId, priorItemCount: priorList.items?.length ?? 0, reconstructed: reconstructed.length },
      'afterRerunBootstrap: reconstructed task list',
    );
    if (reconstructed.length === 0) {
      log.warn({ priorListId }, 'afterRerunBootstrap: no parseable items; falling back to single-task plan');
      return this._beginRerunWith(buildFallbackTaskFromRequest(this._request ?? ''), priorListId, state);
    }
    return this._beginRerunWith(reconstructed, priorListId, state);
  }

  /**
   * Helper for afterRerunBootstrap that persists the reconstructed
   * task list and starts the analysis. Stamps `parentListId` to the
   * prior list when the caller hasn't already supplied a different
   * one (drill-down + re-run could combine in theory).
   */
  private async _beginRerunWith(
    reconstructed: DataAnalysisTask[],
    priorListId: string,
    state: TaskStateStore,
  ): Promise<Task[] | null> {
    if (this._parentListId === undefined) {
      this._parentListId = priorListId;
    }
    state.set(K_PLAN_TASKS, reconstructed);
    await this._persistTaskList(reconstructed, state);
    return this.beginAnalysis(reconstructed, state);
  }

  // -- skills-routing bootstrap (data-analyzer-skills.md step 4b) ----------

  /**
   * Skills-routing path. The bootstrap pass-through emitted by
   * `buildInitialTasks` lands here; we run `runSkillsPipeline`
   * inline (classify-question → select-scope → runSkill per scoped
   * → calibrate-confidence), adapt the result to the legacy
   * `AcceptedTask[]` + `DataAnalyzerResult[]` shape via
   * `pipelineResultToAcceptedTasks`, persist the TodoList, and
   * queue the legacy synthesise step.
   *
   * The legacy plan + per-task analyzer runner are bypassed
   * entirely. Review is also skipped: the per-task review prompt
   * expects an LLM-generated DataAnalyzerResult shape; skill-derived
   * results carry their own confidence + notes that calibrate-
   * confidence already rolled into a final verdict.
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

    const ca = state.get<DataAnalysisState>(K_STATE)!;
    log.info(
      { connections: this._connections.length, tier: this._tier },
      'afterSkillsRoutingBootstrap: running meta-skills pipeline',
    );

    const session = this.deps.session;
    const pipelineResult = await runSkillsPipeline(
      { question: this._request, connections: this._connections },
      {
        session,
        resolveProvider: (affinity) => {
          // Skills-plan §7.1: cloud affinity → active cloud
          // provider's small/fast tier. The session resolver
          // ('skill', 'meta') returns whatever the user has bound
          // for the meta step; falls back to the active provider's
          // default. For local affinity we reach into ollamaProvider
          // directly since the resolver doesn't gate on local.
          if (affinity === 'local') return session.ollamaProvider;
          if (affinity === 'cloud') return session.claudeProvider ?? session.ollamaProvider;
          return session.resolver.resolve('data-analyzer', 'meta');
        },
        ...(this.deps.abortController?.signal ? { signal: this.deps.abortController.signal } : {}),
      },
    );

    log.info(
      {
        aborted: pipelineResult.aborted,
        executions: pipelineResult.executions.length,
        finalConfidence: pipelineResult.finalConfidence,
        notes: pipelineResult.notes.slice(0, 3),
      },
      'afterSkillsRoutingBootstrap: pipeline complete',
    );

    // Aborted run → mark cancelled + finalise. The pipeline's notes
    // surface in the report's empty-state body via the synthesise
    // step (which still runs, producing a minimal report explaining
    // why the pipeline aborted).
    if (pipelineResult.aborted) {
      state.set(K_STATE, { ...ca, cancelled: false });    // not user-cancelled; pipeline declined to proceed
      state.set(K_PLAN_TASKS, []);
      state.set(K_ACCEPTED, [] as AcceptedTask[]);
      state.set(K_HISTORY, [] as DataAnalyzerResult[]);
      // Stash pipeline notes as the synthesise step's input so the
      // report body explains the abort reason instead of being
      // silently empty.
      state.set('skills-pipeline-notes' as string as never, pipelineResult.notes);
      return this.queueSynthesise(state);
    }

    // Adapt pipeline → legacy shapes the synthesise step consumes.
    const itemPrefix = `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const accepted = pipelineResultToAcceptedTasks(pipelineResult, itemPrefix);
    const planned: DataAnalysisTask[] = accepted.map(a => a.task);
    const history: DataAnalyzerResult[] = accepted.map(a => a.result);

    state.set(K_PLAN_TASKS, planned);
    state.set(K_ACCEPTED, accepted);
    state.set(K_HISTORY, history);

    // Persist the raw PerSkillExecution[] for the plan-actions
    // synthesis (Phase 5 of plans/analyzers/cloud-plan-local-expand-
    // cloud-review.md). Same lossy-conversion concern as the code-
    // analyzer side: pipelineResultToAcceptedTasks turns each
    // structured value into an `answer` string.
    state.set(K_RAW_EXECUTIONS, pipelineResult.executions);

    // Create the TodoList + items so the user sees the per-skill
    // runs in the chat panel. `_persistTaskList` walks `planned`,
    // calls addItem per task, and stamps the resulting framework-
    // assigned ids back onto K_PLAN_TASKS. After it returns we
    // re-stamp the matching `AcceptedTask` records so synthesise
    // sees consistent itemIds.
    await this._persistTaskList(planned, state);
    const stampedPlan = state.get<DataAnalysisTask[]>(K_PLAN_TASKS) ?? planned;
    const stampedAccepted: AcceptedTask[] = stampedPlan.map((task, i) => ({
      task,
      result: { ...accepted[i]!.result, itemId: task.itemId },
    }));
    state.set(K_ACCEPTED, stampedAccepted);
    state.set(K_HISTORY, stampedAccepted.map(a => a.result));

    // Stamp per-skill metadata onto each TodoItem so the pane row
    // renderer + drill-down footer have something to show. Mark
    // each item complete since the skill already ran.
    if (this.deps.todos !== undefined) {
      for (const a of stampedAccepted) {
        try {
          await this.deps.todos.updateItemMeta(a.task.itemId, {
            kind: a.task.kind,
            ...(a.task.scope !== undefined ? { scope: a.task.scope } : {}),
            origin: a.task.origin,
            retryCount: 0,
            answer:    a.result.answer,
            findings:  a.result.findings,
            citations: a.result.citations,
            confidence: a.result.confidence,
            toolCalls:  a.result.toolCalls,
            ...(a.result.truncated      ? { truncated: true } : {}),
            ...(a.result.blockedReason !== undefined ? { blockedReason: a.result.blockedReason } : {}),
          });
          // Item state machine requires pending -> in_progress -> completed.
          // markComplete() on pending throws.
          await this.deps.todos.markInProgress(a.task.itemId);
          await this.deps.todos.markComplete(a.task.itemId);
        } catch (err) {
          log.warn({ err, itemId: a.task.itemId }, 'skills-routing: updateItemMeta / markComplete failed');
        }
      }
    }

    // Skills-routing skips the legacy review step (per-task review
    // prompt assumes an LLM-generated analyzer output; skill results
    // come pre-calibrated). Jump straight to synthesise.
    return this.queueSynthesise(state);
  }

  // -- analyze + review ----------------------------------------------------

  private async beginAnalysis(
    planned: DataAnalysisTask[],
    state: TaskStateStore,
  ): Promise<Task[] | null> {
    state.set(K_PHASE, 'analyzing' as DataAnalyzerPhase);
    if (planned.length === 0) {
      // Nothing to analyse -- jump to synthesise (will produce an empty-state report).
      return this.queueSynthesise(state);
    }
    return this.runNextAnalyzerTask(state);
  }

  private async runNextAnalyzerTask(state: TaskStateStore): Promise<Task[] | null> {
    if (this.deps === undefined) return null;
    const planned = state.get<DataAnalysisTask[]>(K_PLAN_TASKS) ?? [];
    const accepted = state.get<AcceptedTask[]>(K_ACCEPTED) ?? [];
    const history = state.get<DataAnalyzerResult[]>(K_HISTORY) ?? [];
    const acceptedIds = new Set(accepted.map(a => a.task.itemId));
    const next = planned.find(t => !acceptedIds.has(t.itemId));

    if (next === undefined) {
      // All planned tasks accepted -> synthesise.
      return this.queueSynthesise(state);
    }

    if (this.deps.todos !== undefined) {
      try { await this.deps.todos.markInProgress(next.itemId); } catch { /* keep going */ }
    }

    // Phase 2.4: cache lookup before we burn any LLM tokens. Cache
    // key includes the connection-roster fingerprint so a registry
    // change (added / removed / re-registered connection) invalidates
    // every entry that touched the affected connection. Note: schema
    // drift on an unchanged connection is NOT detected -- callers
    // wanting fresh introspection clear the cache via
    // `insrc.dataAnalyzer.clearCache`.
    const cacheKeyInput = this._buildCacheKeyInput(next);
    const cachedResult = await readCachedResult(cacheKeyInput);
    if (cachedResult !== null) {
      // Stamp the cached result into K_ACCEPTED + K_HISTORY and mark
      // the todo complete; skip the analyzer + reviewer pair entirely.
      accepted.push({ task: next, result: cachedResult });
      history.push(cachedResult);
      state.set(K_ACCEPTED, accepted);
      state.set(K_HISTORY, history);
      if (this.deps.todos !== undefined) {
        try {
          await this.deps.todos.updateItemMeta(next.itemId, {
            kind: next.kind,
            ...(next.scope !== undefined ? { scope: next.scope } : {}),
            origin: next.origin,
            retryCount: 0,
            answer: cachedResult.answer,
            findings: cachedResult.findings,
            citations: cachedResult.citations,
            confidence: cachedResult.confidence,
            toolCalls: cachedResult.toolCalls,
            cacheHit: true,
            ...(cachedResult.truncated ? { truncated: true } : {}),
          });
          await this.deps.todos.markComplete(next.itemId);
        } catch (err) {
          log.warn({ err, itemId: next.itemId }, 'cache-hit todo update failed (continuing)');
        }
      }
      return this.runNextAnalyzerTask(state);
    }

    // Resolve the analyzer provider via the per-step resolver.
    const provider = this.deps.session.resolver.resolve('data-analyzer', 'analyzer');

    const outcome = await runDataAnalyzer(next, {
      provider,
      session: this.deps.session,
      ...(this.deps.abortController?.signal ? { signal: this.deps.abortController.signal } : {}),
      // Phase 4 of plans/access-gate.md: drop the per-call
      // checkConnectionAccess hook in favour of seeding Session.access
      // at task start (ephemeral connections auto-approved on
      // registration). The dispatcher inside executeTool fires the
      // gate UI on miss using the send / channel / requestId we plumb
      // here.
      send:      this.deps.send,
      channel:   this.deps.channel,
      requestId: this.deps.requestId,
      tier: this._tier,
    });

    const result = outcome.result;

    if (this.deps.todos !== undefined) {
      try {
        await this.deps.todos.updateItemMeta(next.itemId, {
          kind: next.kind,
          ...(next.scope !== undefined ? { scope: next.scope } : {}),
          origin: next.origin,
          retryCount: 0,
          answer: result.answer,
          findings: result.findings,
          citations: result.citations,
          confidence: result.confidence,
          toolCalls: result.toolCalls,
          ...(result.truncated ? { truncated: true } : {}),
          ...(result.blockedReason !== undefined ? { blockedReason: result.blockedReason } : {}),
        });
      } catch (err) {
        log.warn({ err, itemId: next.itemId }, 'updateItemMeta failed (continuing)');
      }
    }

    // Gate-blocked tasks auto-accept and bypass review.
    if (result.blockedReason !== undefined) {
      accepted.push({ task: next, result });
      history.push(result);
      state.set(K_ACCEPTED, accepted);
      state.set(K_HISTORY, history);
      if (this.deps.todos !== undefined) {
        try { await this.deps.todos.markBlocked(next.itemId, result.blockedReason); } catch { /* keep going */ }
      }
      return this.runNextAnalyzerTask(state);
    }

    // Queue the review LLM task.
    state.set(K_PHASE, 'reviewing' as DataAnalyzerPhase);
    state.set('lastResult', result);
    state.set('lastTask', next);
    const reviewMessages = buildReviewPrompt(next, result, history);
    const userMessage = reviewMessages
      .filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content : '[complex content]')
      .join('\n\n');
    return [{
      index: 100,
      description: `Data Analyzer: reviewing task "${shortTitleFor(next)}"...`,
      kind: 'llm',
      intent: 'data-analysis',
      systemPrompt: REVIEW_SYSTEM,
      userMessage,
      resolverAgent: 'data-analyzer',
      resolverStep: 'review',
      providerHint: 'claude',
      temperature: 0,
      maxTokens: 1200,
      stateKey: K_REVIEW_RESULT,
      persisted: true,
    }];
  }

  private async afterReview(completed: TaskResult, state: TaskStateStore): Promise<Task[] | null> {
    if (this.deps === undefined) return null;
    const lastTask = state.get<DataAnalysisTask>('lastTask');
    const lastResult = state.get<DataAnalyzerResult>('lastResult');
    if (lastTask === undefined || lastResult === undefined) {
      log.error('afterReview: missing lastTask or lastResult; skipping');
      return this.runNextAnalyzerTask(state);
    }
    const decision = parseReviewerDecision(completed.output);
    const retries = state.get<Record<string, number>>(K_RETRIES) ?? {};
    const followups = state.get<number>(K_FOLLOWUP_COUNT) ?? 0;
    const accepted = state.get<AcceptedTask[]>(K_ACCEPTED) ?? [];
    const history = state.get<DataAnalyzerResult[]>(K_HISTORY) ?? [];

    if (decision.kind === 'accept' || decision.kind === 'done') {
      accepted.push({ task: lastTask, result: lastResult });
      history.push(lastResult);
      state.set(K_ACCEPTED, accepted);
      state.set(K_HISTORY, history);
      if (this.deps.todos !== undefined) {
        try { await this.deps.todos.markComplete(lastTask.itemId); } catch { /* keep going */ }
      }
      // Phase 2.4: persist the reviewer-accepted result to cache so a
      // re-run against the same task with the same connection roster
      // skips the analyzer + reviewer pair entirely. Best-effort --
      // a write failure shouldn't bubble up.
      void writeCachedResult(this._buildCacheKeyInput(lastTask), lastResult).catch(err => {
        log.warn({ err: (err as Error).message, itemId: lastTask.itemId }, 'cache write failed (non-fatal)');
      });
      if (decision.kind === 'done') {
        return this.queueSynthesise(state);
      }
      state.set(K_PHASE, 'analyzing' as DataAnalyzerPhase);
      return this.runNextAnalyzerTask(state);
    }

    if (decision.kind === 'retry') {
      const count = retries[lastTask.itemId] ?? 0;
      if (count >= MAX_RETRIES_PER_TASK) {
        // Retry cap hit -- accept with downgraded confidence.
        accepted.push({ task: lastTask, result: { ...lastResult, confidence: 'low' } });
        history.push(lastResult);
        state.set(K_ACCEPTED, accepted);
        state.set(K_HISTORY, history);
        if (this.deps.todos !== undefined) {
          try { await this.deps.todos.markComplete(lastTask.itemId); } catch { /* keep going */ }
        }
        state.set(K_PHASE, 'analyzing' as DataAnalyzerPhase);
        return this.runNextAnalyzerTask(state);
      }
      retries[lastTask.itemId] = count + 1;
      state.set(K_RETRIES, retries);
      // Re-queue the SAME task with the reviewer's hint applied.
      const planned = state.get<DataAnalysisTask[]>(K_PLAN_TASKS) ?? [];
      const idx = planned.findIndex(t => t.itemId === lastTask.itemId);
      if (idx >= 0) {
        planned[idx] = {
          ...lastTask,
          ...(decision.retryHint !== undefined ? { hint: decision.retryHint } : {}),
        };
        state.set(K_PLAN_TASKS, planned);
      }
      state.set(K_PHASE, 'analyzing' as DataAnalyzerPhase);
      return this.runNextAnalyzerTask(state);
    }

    // add-follow-up
    if (decision.kind === 'follow-up') {
      // Accept the original task too.
      accepted.push({ task: lastTask, result: lastResult });
      history.push(lastResult);
      state.set(K_ACCEPTED, accepted);
      state.set(K_HISTORY, history);
      if (this.deps.todos !== undefined) {
        try { await this.deps.todos.markComplete(lastTask.itemId); } catch { /* keep going */ }
      }
      const planned = state.get<DataAnalysisTask[]>(K_PLAN_TASKS) ?? [];
      let added = 0;
      for (const fu of decision.followUps.slice(0, 2)) {
        if (followups + added >= MAX_FOLLOWUPS) break;
        // Need the framework-assigned item.id BEFORE the task lands
        // in K_PLAN_TASKS so downstream consumers see one canonical id.
        let itemId: string | undefined;
        if (this.deps.todos !== undefined && this._listId !== undefined) {
          try {
            const item = await this.deps.todos.addItem(this._listId, {
              title: shortTitleFor({ ...fu, itemId: '', origin: 'follow-up' } as DataAnalysisTask),
              description: fu.question,
              meta: { kind: fu.kind, ...(fu.scope !== undefined ? { scope: fu.scope } : {}), origin: 'follow-up', retryCount: 0 },
            });
            itemId = item.id;
          } catch { /* keep going */ }
        }
        const task: DataAnalysisTask = {
          itemId: itemId ?? `pending-${added}-${Date.now()}`,
          kind: fu.kind,
          question: fu.question,
          ...(fu.scope !== undefined ? { scope: fu.scope } : {}),
          origin: 'follow-up',
        };
        planned.push(task);
        added++;
      }
      state.set(K_PLAN_TASKS, planned);
      state.set(K_FOLLOWUP_COUNT, followups + added);
      state.set(K_PHASE, 'analyzing' as DataAnalyzerPhase);
      return this.runNextAnalyzerTask(state);
    }

    return null;
  }

  // -- synthesise ----------------------------------------------------------

  private async queueSynthesise(state: TaskStateStore): Promise<Task[] | null> {
    if (this.deps === undefined) return null;
    state.set(K_PHASE, 'synthesising' as DataAnalyzerPhase);

    const accepted = state.get<AcceptedTask[]>(K_ACCEPTED) ?? [];
    const planned = state.get<DataAnalysisTask[]>(K_PLAN_TASKS) ?? [];
    const rawExecutions = state.get<readonly PlanExecution[]>(K_RAW_EXECUTIONS);

    let markdown = '';
    try {
      markdown = await this.runPlanExpandReviewSynthesise(
        accepted,
        rawExecutions ?? deriveExecutionsFromAcceptedDA(accepted),
      );
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'queueSynthesise: plan/expand/review failed; falling back to legacy multipass',
      );
      try {
        const provider = this.deps.session.resolver.resolve('data-analyzer', 'synthesise');
        const outline = buildMultipassOutlineInput(this._request ?? '', accepted, planned, this._tier);
        const sectionBuild = makeSectionBuilder(this._request ?? '', accepted, this._tier);
        const result = await generateMultiPass(
          {
            outline: { system: outline.system, user: outline.user, maxSections: outline.maxSections, maxTokens: outline.maxTokens },
            section: { build: sectionBuild },
            ...(this.deps.abortController?.signal !== undefined ? { signal: this.deps.abortController.signal } : {}),
          },
          provider,
        );
        markdown = result.markdown;
        const hasDrillDown = result.outline.sections.some(
          s => s.id === DRILL_DOWN_FALLBACK_SECTION.id ||
               /drill[-\s]?down/i.test(s.title),
        );
        if (!hasDrillDown) {
          markdown += `\n\n## ${DRILL_DOWN_FALLBACK_SECTION.title}\n\n_(no drill-down candidates emitted by the synthesise pass)_\n`;
        }
      } catch (err2) {
        log.error({ err: (err2 as Error).message }, 'queueSynthesise: legacy multipass also failed');
        markdown = `# Data Analysis Report\n\n_Synthesis failed: ${(err2 as Error).message}_\n\nSee accepted findings in the todos pane.`;
      }
    }

    // Phase 3.3: ER artifact integration. For every `kind: 'er'`
    // task in the accepted set, generate an ER diagram via the
    // shipped artifact_er tool. Each artifact persists as a TodoItem
    // (visible in the artifacts pane) and lands a one-line reference
    // in the report so readers know which diagrams cover the run.
    // Best-effort: failures append an inline warning rather than
    // bubbling up.
    markdown = await this._appendErArtifactSection(markdown, accepted);

    state.set(K_SYNTH_RESULT, markdown);

    // Persist body on the list so the (future Phase 2) report pane
    // sees it. The TodosApi has no list-level "complete" state -- the
    // workbench-side flow contribution opens the report when the
    // body lands; the list itself stays `active` until the user
    // archives it.
    if (this.deps.todos !== undefined && this._listId !== undefined) {
      try {
        await this.deps.todos.updateListBody(this._listId, markdown);
      } catch (err) {
        log.warn({ err }, 'queueSynthesise: updateListBody failed');
      }
    }

    state.set(K_PHASE, 'done' as DataAnalyzerPhase);
    return null;
  }

  /**
   * Plan / expand / review synthesis driver (Phase 5 of
   * plans/analyzers/cloud-plan-local-expand-cloud-review.md). Mirrors
   * the code-analyzer's runPlanExpandReviewSynthesise; the helpers
   * are analyzer-agnostic so the only differences are the resolver
   * step ids and the analyzerLabel.
   */
  private async runPlanExpandReviewSynthesise(
    accepted: readonly AcceptedTask[],
    executions: readonly PlanExecution[],
  ): Promise<string> {
    if (this.deps === undefined) {
      throw new Error('runPlanExpandReviewSynthesise: deps not attached');
    }
    const session = this.deps.session;
    const cloud = session.resolver.resolve('data-analyzer', 'plan');
    const local = session.ollamaProvider;
    const reviewer = session.resolver.resolve('data-analyzer', 'review');
    const request = this._request ?? '';

    const repoSummary = (() => {
      const path = session.repoPath ?? '';
      const closure = session.closureRepos.length;
      return path.length > 0
        ? `${path} -- closure size: ${closure}`
        : `(no active repo) -- closure size: ${closure}`;
    })();

    // ----- Stage 1: plan ------------------------------------------------
    const planStep = 'synthesise (plan)';
    this.emitLiveStep(planStep, '');
    this.emitLiveStep(planStep, `[data-analyzer | tier=${this._tier}] planning report sections...\n`);

    const plan = await planActions(
      {
        request,
        repoSummary,
        executions,
        tier: this._tier,
        analyzerLabel: 'data-analyzer',
      },
      cloud,
    );

    const actions = plan.degraded || plan.actions.length === 0
      ? [synthesiseFallbackActionDA(request, accepted, executions)]
      : plan.actions;

    this.emitLiveStep(
      planStep,
      `[data-analyzer | tier=${this._tier}] planned ${actions.length} section${actions.length === 1 ? '' : 's'}${plan.degraded ? ' (fallback)' : ''}\n`,
    );
    this.emitLiveStep(planStep, '', true);

    // ----- Stage 2+3: per-action expand+review --------------------------
    const sections: { id: string; title: string; markdown: string }[] = [];
    for (const action of actions) {
      const evidence = pickEvidenceDA(action, executions);
      const stepId = `synthesise (${action.id})`;
      this.emitLiveStep(stepId, '');
      this.emitLiveStep(stepId, `[data-analyzer] expanding "${action.title}"...\n`);

      const out = await expandThenReview(
        {
          action,
          evidence,
          request,
          analyzerLabel: 'data-analyzer',
          onProgress: (phase, payload) => {
            const tag = phase === 'final'
              ? `done (verdict=${payload.kind === 'final' ? payload.verdict : '?'}, rounds=${payload.kind === 'final' ? payload.rounds : '?'})`
              : phase;
            this.emitLiveStep(stepId, `[data-analyzer] ${action.id}: ${tag}\n`);
          },
        },
        local,
        reviewer,
      );

      this.emitLiveStep(stepId, '', true);
      sections.push({ id: action.id, title: action.title, markdown: out.markdown });
    }

    // ----- Stage 4: stitch -----------------------------------------------
    return stitchPlanSectionsDA(plan.intentBrief, actions, sections);
  }

  /** Emit a brainstorm-style `liveStep` event (mirrors the code-
   *  analyzer's emitter; data-analyzer didn't have one before). */
  private emitLiveStep(step: string, text: string, done = false): void {
    if (this.deps === undefined) return;
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

  private async afterSynthesise(_completed: TaskResult, _state: TaskStateStore): Promise<Task[] | null> {
    // Synthesise runs inline in queueSynthesise via generateMultiPass;
    // there's no LLM-task completion to react to here. Reserved for
    // future Phase 2 (present gate). For Phase 1 we just close out.
    return null;
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
    state: TaskStateStore,
    phase: DataAnalyzerPhase,
  ): Promise<Task[] | null> {
    log.info({ phase, listId: this._listId }, 'data-analyzer resume entry');
    switch (phase) {
      case 'planning':
        // Re-fire the plan task verbatim.
        if (this._request === undefined) return null;
        return [{
          index: 0,
          description: `Data Analyzer: re-planning (resume; tier ${this._tier})...`,
          kind: 'llm',
          intent: 'data-analysis',
          systemPrompt: buildPlanSystemPrompt(this._tier),
          userMessage: renderPlanUserMessage(this._request, this._connections, this._tier),
          resolverAgent: 'data-analyzer',
          resolverStep: 'plan',
          providerHint: 'claude',
          temperature: 0,
          maxTokens: 2500,
          stateKey: K_PLAN_RESULT,
          persisted: true,
        }];
      case 'plan-approval': {
        const planned = state.get<DataAnalysisTask[]>(K_PLAN_TASKS) ?? [];
        const caps = capsForTier(this._tier);
        return [{
          index: 1,
          description: `Plan has ${planned.length} tasks (resume; tier ${this._tier}). Approve, trim, or cancel?`,
          kind: 'transform',
          intent: 'data-analysis',
          passThrough: true,
          userMessage: renderPlanSummary(planned, caps),
          outputFormat: 'markdown',
          requiresGate: true,
          gateTitle: `Data Analyzer plan size approval (tier ${this._tier})`,
          gateActions: [
            { name: 'approve', label: 'Approve all' },
            { name: 'trim-to-soft', label: `Trim to first ${caps.softTaskCap}` },
            { name: 'cancel', label: 'Cancel run' },
          ],
          persisted: true,
        }];
      }
      case 'analyzing':
      case 'reviewing':
        // Items left in 'in_progress' at crash time will re-run
        // naturally: runNextAnalyzerTask picks the first task that
        // isn't in K_ACCEPTED, and an in-progress-but-not-accepted
        // item matches that filter. The status badge will read
        // "in_progress" briefly until markComplete fires after the
        // re-execute.
        return this.runNextAnalyzerTask(state);
      case 'synthesising':
        return this.queueSynthesise(state);
      case 'present':
      case 'done':
        return null;
    }
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
  private async _appendErArtifactSection(
    markdown: string,
    accepted: readonly AcceptedTask[],
  ): Promise<string> {
    if (this.deps === undefined) return markdown;
    const erTasks = accepted.filter(a => a.task.kind === 'er');
    if (erTasks.length === 0) return markdown;

    const generated: { title: string; id: string; provenance: string }[] = [];
    const failures: string[] = [];

    for (const { task } of erTasks) {
      const groups = groupTablesByConnection(task);
      // No scope at all -- fall through to artifact_er's free-text
      // / prisma / graph source chain with just the question.
      if (groups.length === 0) {
        groups.push({ connection: undefined, tables: [] });
      }
      for (const group of groups) {
        const result = await this._runErArtifact(task.question, group);
        if ('error' in result) {
          failures.push(`${group.connection ?? '<no connection>'}: ${result.error}`);
        } else {
          generated.push(result);
        }
      }
    }

    if (generated.length === 0 && failures.length === 0) return markdown;

    const lines: string[] = ['', '## ER Diagrams', ''];
    if (generated.length > 0) {
      lines.push(`Generated ${generated.length} ER artifact${generated.length === 1 ? '' : 's'} (open via the Artifacts pane):`);
      lines.push('');
      for (const g of generated) {
        lines.push(`- **${g.title}** -- \`${g.id}\` _(${g.provenance})_`);
      }
    }
    if (failures.length > 0) {
      lines.push('');
      lines.push('_ER generation skipped for the following:_');
      for (const f of failures) {
        lines.push(`- ${f}`);
      }
    }
    return markdown + lines.join('\n');
  }

  /**
   * Invoke `artifact_er` via the unified tool executor. Wraps the
   * call result so the caller gets either a structured success
   * payload or a single-line error string.
   */
  private async _runErArtifact(
    description: string,
    group: { connection: string | undefined; tables: readonly string[] },
  ): Promise<
    | { title: string; id: string; provenance: string }
    | { error: string }
  > {
    if (this.deps === undefined) return { error: 'orchestrator deps missing' };
    const input: Record<string, unknown> = { description };
    if (group.connection !== undefined) { input['connection'] = group.connection; }
    if (group.tables.length > 0)        { input['tables'] = [...group.tables]; }

    const r = await executeTool(
      { id: `er-${Date.now()}-${Math.floor(Math.random() * 1000)}`, name: 'artifact_er', input },
      {
        session: this.deps.session,
        send: this.deps.send,
        channel: this.deps.channel,
        requestId: this.deps.requestId,
      },
    );
    if (r.isError) {
      return { error: r.content.slice(0, 200) };
    }
    // executeTool returns ToolResult; the structured payload from the
    // tool's data field isn't propagated, so parse the summary line
    // for id / title.
    const idMatch = /id=([^,]+)/.exec(r.content);
    const titleMatch = /title="([^"]+)"/.exec(r.content);
    return {
      id: idMatch?.[1] ?? '<unknown>',
      title: titleMatch?.[1] ?? 'ER diagram',
      provenance: group.connection !== undefined
        ? `connection=${group.connection}, ${group.tables.length} table${group.tables.length === 1 ? '' : 's'}`
        : 'prisma / graph fallback',
    };
  }

  /**
   * Build the cache-key input for a task (Phase 2.4). The
   * connection fingerprint combines the task's explicit scope with
   * the active session's full connection roster -- so cache hits
   * stay valid only as long as both inputs are stable. Schema drift
   * on an unchanged connection is not yet detected; see cache.ts for
   * the trade-off and follow-up note.
   */
  private _buildCacheKeyInput(task: DataAnalysisTask): CacheKeyInput {
    const fingerprint = buildConnectionFingerprint({
      taskScope: task.scope,
      registeredConnections: this._connections.map(c => ({
        id: c.id,
        kind: c.kind,
        family: c.family,
      })),
    });
    return {
      question: task.question,
      scope: task.scope,
      tier: this._tier,
      connectionFingerprint: fingerprint,
    };
  }
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

function shortTitleFor(t: DataAnalysisTask): string {
  const head = t.question.split(/\s+/).slice(0, 8).join(' ');
  return head.length > 60 ? head.slice(0, 57) + '...' : head;
}

const VALID_DATA_ANALYSIS_KINDS: ReadonlySet<DataAnalysisTask['kind']> = new Set([
  'inspect-schema',
  'sample-data',
  'sample-shape',
  'lineage',
  'schema-drift',
  'er',
  'free-form',
]);

function isDataAnalysisKind(v: unknown): v is DataAnalysisTask['kind'] {
  return typeof v === 'string' && VALID_DATA_ANALYSIS_KINDS.has(v as DataAnalysisTask['kind']);
}

/**
 * Phase 5.1 helper. Convert a persisted TodoItem from a prior
 * data-analysis run back into a DataAnalysisTask the orchestrator
 * can hand to `beginAnalysis`. Returns null when the item lacks
 * either a usable description (the planner-supplied question) or
 * a recognisable `meta.kind` -- those items get skipped and the
 * caller falls back to its single-task default if nothing parses.
 */
function reconstructTaskFromItem(item: {
  readonly id: string;
  readonly description?: string | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}): DataAnalysisTask | null {
  const question = (item.description ?? '').trim();
  if (question.length === 0) return null;
  const meta = item.meta ?? {};
  const kindRaw = meta['kind'];
  if (!isDataAnalysisKind(kindRaw)) return null;
  const scopeRaw = meta['scope'];
  const hintRaw = meta['hint'];
  const task: DataAnalysisTask = {
    itemId: '', // assigned at addItem time in _persistTaskList
    kind: kindRaw,
    question,
    origin: 'plan',
    ...(scopeRaw !== null && typeof scopeRaw === 'object' && !Array.isArray(scopeRaw)
      ? { scope: parseScopeForRerun(scopeRaw as Record<string, unknown>) }
      : {}),
    ...(typeof hintRaw === 'string' && hintRaw.length > 0 ? { hint: hintRaw } : {}),
  };
  return task;
}

function parseScopeForRerun(raw: Record<string, unknown>): DataAnalysisTask['scope'] {
  const out: { connections?: string[]; targets?: string[] } = {};
  if (Array.isArray(raw['connections'])) {
    const conns = raw['connections'].filter((s): s is string => typeof s === 'string');
    if (conns.length > 0) out.connections = conns;
  }
  if (Array.isArray(raw['targets'])) {
    const targets = raw['targets'].filter((s): s is string => typeof s === 'string');
    if (targets.length > 0) out.targets = targets;
  }
  return out;
}

/**
 * Last-resort fallback when the prior list is gone or has no
 * parseable items. Produces a single free-form task carrying the
 * original request as the question, so the user still gets some
 * analysis they can compare against.
 */
function buildFallbackTaskFromRequest(request: string): DataAnalysisTask[] {
  const trimmed = request.trim();
  if (trimmed.length === 0) return [];
  return [{
    itemId: '',
    kind: 'free-form',
    question: trimmed,
    origin: 'plan',
  }];
}

/**
 * Phase 3.3 helper. Walk a task's scope and produce one
 * (connection, tables[]) group per referenced connection.
 *
 * - When `scope.connections` is set, build one group per connection
 *   id, with `scope.targets` (or [] if absent) repeated. We don't
 *   try to infer which targets belong to which connection -- the
 *   planner is responsible for that pairing in tier-aware scope.
 * - When `scope.connections` is unset OR empty, return [] so the
 *   caller can decide whether to fall back to free-text.
 */
function groupTablesByConnection(t: DataAnalysisTask): Array<{ connection: string | undefined; tables: readonly string[] }> {
  const conns = t.scope?.connections ?? [];
  const tables = t.scope?.targets ?? [];
  if (conns.length === 0) return [];
  return conns.map(c => ({ connection: c, tables }));
}

function renderPlanSummary(planned: readonly DataAnalysisTask[], caps: TierCaps): string {
  const lines: string[] = [
    `Planner emitted **${planned.length} tasks** (soft cap: ${caps.softTaskCap}, hard cap: ${caps.hardTaskCap}).`,
    '',
  ];
  for (let i = 0; i < planned.length; i++) {
    const t = planned[i]!;
    lines.push(`${i + 1}. **[${t.kind}]** ${t.question}`);
  }
  return lines.join('\n');
}

interface ReviewerDecision {
  readonly kind: 'accept' | 'retry' | 'follow-up' | 'done';
  readonly retryHint?: string;
  readonly followUps: readonly { kind: DataAnalysisTask['kind']; question: string; scope?: DataAnalysisTask['scope'] }[];
}

function parseReviewerDecision(rawText: string): ReviewerDecision {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripFences(rawText));
  } catch {
    return { kind: 'accept', followUps: [] };
  }
  const decision = typeof parsed['decision'] === 'string' ? parsed['decision'] : 'accept';
  if (decision === 'retry-with-hint') {
    return {
      kind: 'retry',
      ...(typeof parsed['retryHint'] === 'string' ? { retryHint: parsed['retryHint'] } : {}),
      followUps: [],
    };
  }
  if (decision === 'add-follow-up') {
    const fus = Array.isArray(parsed['followUps']) ? parsed['followUps'] : [];
    const followUps: { kind: DataAnalysisTask['kind']; question: string; scope?: DataAnalysisTask['scope'] }[] = [];
    for (const raw of fus) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const kind = (typeof r['kind'] === 'string' ? r['kind'] : 'free-form') as DataAnalysisTask['kind'];
      const question = typeof r['question'] === 'string' ? r['question'] : '';
      if (question.length === 0) continue;
      const scopeRaw = (r['scope'] ?? {}) as Record<string, unknown>;
      const scope: DataAnalysisTask['scope'] = {
        ...(Array.isArray(scopeRaw['connections']) ? { connections: scopeRaw['connections'].filter((s): s is string => typeof s === 'string') } : {}),
        ...(Array.isArray(scopeRaw['targets']) ? { targets: scopeRaw['targets'].filter((s): s is string => typeof s === 'string') } : {}),
      };
      followUps.push({
        kind,
        question,
        ...(scope.connections !== undefined || scope.targets !== undefined ? { scope } : {}),
      });
    }
    return { kind: 'follow-up', followUps };
  }
  if (decision === 'done') {
    return { kind: 'done', followUps: [] };
  }
  return { kind: 'accept', followUps: [] };
}


// ---------------------------------------------------------------------------
// Plan / expand / review synthesis helpers (Phase 5 of
// plans/analyzers/cloud-plan-local-expand-cloud-review.md). Mirrors
// the code-analyzer helpers; kept analyzer-local instead of shared
// because the AcceptedTask shapes differ enough that lifting to the
// content-gen module isn't worth the coupling.
// ---------------------------------------------------------------------------

function pickEvidenceDA(
  action: PlannedAction,
  executions: readonly PlanExecution[],
): readonly PlanExecution[] {
  const seen = new Set<number>();
  const out: PlanExecution[] = [];
  for (const ref of action.evidence) {
    const idx = ref.executionIdx;
    if (idx < 0 || idx >= executions.length || seen.has(idx)) continue;
    const e = executions[idx];
    if (e === undefined) continue;
    if (e.skillId !== ref.skillId) continue;
    seen.add(idx);
    out.push(e);
  }
  return out;
}

function synthesiseFallbackActionDA(
  request: string,
  accepted: readonly AcceptedTask[],
  executions: readonly PlanExecution[],
): PlannedAction {
  const requestSnippet = request.length > 0 ? request.slice(0, 80) : 'data analysis request';
  const evidence = executions.map((e, i) => ({ skillId: e.skillId, executionIdx: i }));
  const skillCount = executions.length;
  return {
    id:        'fallback-summary',
    title:     `Summary: ${requestSnippet}`,
    objective: `Summarise the ${skillCount} skill execution${skillCount === 1 ? '' : 's'} the data-analyzer ran for this request.`,
    evidence,
    maxBudgetTokens: 2000,
    reviewCriteria: [
      'Touches every skill execution at least once',
      'States the user request verbatim',
      `Notes that ${accepted.length} task${accepted.length === 1 ? '' : 's'} were accepted into the report`,
    ],
  };
}

function deriveExecutionsFromAcceptedDA(
  accepted: readonly AcceptedTask[],
): readonly PlanExecution[] {
  return accepted.map(a => ({
    skillId:    a.task.kind,
    value:      a.result.answer,
    confidence: a.result.confidence,
    notes:      [],
  }));
}

function stitchPlanSectionsDA(
  intentBrief: string,
  actions: readonly PlannedAction[],
  sections: readonly { id: string; title: string; markdown: string }[],
): string {
  const lines: string[] = [];
  if (intentBrief.trim().length > 0) {
    lines.push(intentBrief.trim());
    lines.push('');
  }
  const byId = new Map(sections.map(s => [s.id, s]));
  for (const action of actions) {
    const s = byId.get(action.id);
    if (s === undefined || s.markdown.trim().length === 0) continue;
    lines.push(`## ${action.title}`);
    lines.push('');
    lines.push(s.markdown.trim());
    lines.push('');
  }

  // Drill-down footer (Report Pane parser anchor).
  const haveDrillDown = sections.some(s => /^##\s+Drill\s+down/im.test(s.markdown));
  if (!haveDrillDown) {
    lines.push('## Drill down');
    lines.push('');
    lines.push('_The planner did not propose drill-down bullets for this run. Open the todos pane to launch a follow-up._');
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
