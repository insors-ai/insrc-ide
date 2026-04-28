/**
 * CodeAnalyzerOrchestratorController -- the Code Analyzer family's
 * task-controller entry point.
 *
 * Phase 1.2 of plans/analyzers/code-analyzer.md. State machine:
 *
 *   planning            -> [plan LLM task]
 *   plan-approval       -> [plan-size gate]   (only when |tasks| > 16)
 *   analyzing           -> runAnalyzer() (inline in next()) +
 *                          [review LLM task]
 *   reviewing           -> apply decision; loop or jump to synthesise
 *   synthesising        -> [synthesise LLM task]
 *   done                  (writes list.body; the workbench-side
 *                          CodeAnalyzerFlowContribution opens the
 *                          Report Pane on the listUpdated event;
 *                          plan §2.1)
 *
 * Plan task runs on the cloud-default provider; review tasks on the
 * cloud-default provider; synthesise on the local model. The
 * per-task analyzer tool loop runs on the local model via
 * runAnalyzer (agent/tasks/code-analyzer/analyzer/runner.ts).
 *
 * Soft cap = 16 planned tasks; hard cap = 24; follow-ups capped at 8
 * across the whole run. Caps in `caps.ts` (imported below).
 */

import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { getLogger } from '../../shared/logger.js';
import { runAnalyzer } from '../../agent/tasks/code-analyzer/analyzer/runner.js';
import { sanitizeMarkdownReport } from '../../agent/tasks/code-analyzer/analyzer/sanitize.js';
import { readCachedResult, writeCachedResult } from '../../agent/tasks/code-analyzer/cache.js';
import { buildPlanPrompt, buildPlanSystemPrompt } from '../../agent/tasks/code-analyzer/prompts/plan.js';
import { buildReviewPrompt, REVIEW_SYSTEM } from '../../agent/tasks/code-analyzer/prompts/review.js';
import { buildSynthesisPrompt, buildSynthesiseSystemPrompt } from '../../agent/tasks/code-analyzer/prompts/synthesise.js';
import type { ScopeSize } from '../../shared/classify.js';
import type {
  AnalysisTask,
  AnalysisTaskSeed,
  AnalyzerResult,
  CodeAnalysisState,
  ReviewerDecision,
  RepoSummary,
} from '../../agent/tasks/code-analyzer/types.js';
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

const log = getLogger('code-analyzer:orchestrator');

// ---------------------------------------------------------------------------
// Caps -- per scope tier (Phase 5.A)
// ---------------------------------------------------------------------------

interface TierCaps {
  /** Soft cap: above this, we fire the plan-size approval gate. */
  readonly softTaskCap: number;
  /** Hard cap: planner output is silently trimmed to this length. */
  readonly hardTaskCap: number;
  /** Per-task wall-clock budget for the analyzer runner. */
  readonly perTaskWallClockMs: number;
}

/**
 * Scope-tier-driven caps for the code-analyzer orchestrator. The
 * Phase 1 single-cap policy (16 soft / 24 hard for every prompt
 * regardless of scope) over-served narrow questions and under-served
 * sweeping audits. Phase 5.A introduces tier-aware caps so:
 *
 *   - "what does foo() do?" (S)        runs 1-3 focused tasks, ~30 s each
 *   - "summarise the auth flow" (M)    runs 5-8 tasks at the legacy budget
 *   - "describe the framework" (L)     runs 10-16 tasks
 *   - "compare brainstorm + designer" (XL) runs up to 24 tasks
 *   - "audit the entire repo" (XXL+)   runs 6-10 BROAD tasks (each
 *                                       broader / slower; per-tier
 *                                       playbook in Phase 5.B will
 *                                       produce structural summaries
 *                                       instead of per-entity findings)
 *
 * Scope ladder (`ScopeSize`): S, M, L, XL, XXL, XXXL, XXXXL. The XXL+
 * tiers all collapse into the "broad / structural" cap shape; the
 * planner playbook differentiates them by output level (XXXL spans
 * the dependency graph; XXXXL produces the architectural overview).
 *
 * `M` matches the pre-Phase-5 constants exactly (16 soft / 24 hard /
 * 60 s) so existing /code-analyze runs that default to `M` see no
 * behavioural change.
 */
const TIER_CAPS: Readonly<Record<ScopeSize, TierCaps>> = {
  S:     { softTaskCap: 3,  hardTaskCap: 5,  perTaskWallClockMs: 30_000 },
  M:     { softTaskCap: 16, hardTaskCap: 24, perTaskWallClockMs: 60_000 },
  L:     { softTaskCap: 10, hardTaskCap: 16, perTaskWallClockMs: 60_000 },
  XL:    { softTaskCap: 16, hardTaskCap: 24, perTaskWallClockMs: 60_000 },
  XXL:   { softTaskCap: 6,  hardTaskCap: 10, perTaskWallClockMs: 90_000 },
  XXXL:  { softTaskCap: 6,  hardTaskCap: 10, perTaskWallClockMs: 90_000 },
  XXXXL: { softTaskCap: 6,  hardTaskCap: 10, perTaskWallClockMs: 90_000 },
};

function capsForTier(tier: ScopeSize | undefined): TierCaps {
  return TIER_CAPS[tier ?? 'M'];
}

const MAX_FOLLOWUPS = 8;
const MAX_RETRIES_PER_TASK = 2;
const PLAN_GATE_TIMEOUT_MS = 5 * 60 * 1000; void PLAN_GATE_TIMEOUT_MS;
const PRESENT_GATE_TIMEOUT_MS = 60 * 60 * 1000; void PRESENT_GATE_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// State keys (kept here so the rest of the file uses string constants)
// ---------------------------------------------------------------------------

const K_STATE          = 'caState';
const K_PLAN_RESULT    = 'planResult';            // raw plan-task LLM output
const K_PLAN_TASKS     = 'plannedTasks';          // AnalysisTask[]
const K_TASK_QUEUE     = 'taskQueue';             // itemId[] still pending
const K_CURRENT_TASK   = 'currentTask';           // AnalysisTask in flight
const K_ACCEPTED       = 'acceptedResults';       // {task, result}[]
const K_HISTORY        = 'reviewHistory';         // AnalyzerResult[] pre-history
const K_RETRIES        = 'retryCounts';           // Record<itemId, number>
const K_FOLLOWUP_COUNT = 'followUpsCount';
const K_PHASE          = 'phase';
const K_REVIEW_RESULT  = 'reviewResult';          // raw review-task output
const K_LAST_RUNNER    = 'lastRunner';            // last RunAnalyzerOutcome
const K_SYNTH_RESULT   = 'synthResult';           // final markdown
const K_LIST_ID        = 'listId';

type Phase =
  | 'planning'
  | 'plan-approval'
  | 'analyzing'
  | 'reviewing'
  | 'synthesising'
  | 'done';

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class CodeAnalyzerOrchestratorController implements TaskController {
  readonly id = 'code-analyzer';

  private deps?: TaskOrchestratorDeps;
  /** Stashed in buildInitialTasks; consumed by ensureStateInitialized
   *  on the first next() call when the state store is actually visible
   *  to the controller. attachDeps fires before buildInitialTasks but
   *  deps.stateStore is the ORIGINAL caller-passed value (often
   *  undefined when the chat-handler builds deps inline) -- the
   *  framework constructs the real stateStore locally and uses it for
   *  next() calls without writing it back to deps. */
  private _request?: string;
  private _repoSummary?: RepoSummary;
  /**
   * Scope tier for this run -- captured from
   * `ControllerInput.classification.scope` in buildInitialTasks. Drives
   * the per-tier cap lookup at every site that used to reference the
   * old `SOFT_TASK_CAP` / `HARD_TASK_CAP` constants. Defaults to `'M'`
   * (pre-Phase-5.A behaviour) when the caller didn't supply a tier.
   */
  private _tier: ScopeSize = 'M';
  /**
   * Parent list id for drill-down runs (Phase 5.D). Captured from
   * `ControllerInput.parentListId`; passed into `createList` so the
   * todos framework records the parent-child edge. Undefined for
   * top-level / non-drill runs. Declared `string | undefined`
   * (rather than `?: string`) so `exactOptionalPropertyTypes` lets us
   * assign through from `input.parentListId` cleanly.
   */
  private _parentListId: string | undefined = undefined;

  attachDeps(deps: TaskOrchestratorDeps): void {
    this.deps = deps;
  }

  // -- start ----------------------------------------------------------------

  buildInitialTasks(input: ControllerInput): Task[] {
    this._request = input.message;
    this._repoSummary = this.buildRepoSummary(input);
    this._tier = input.classification?.scope ?? 'M';
    this._parentListId = input.parentListId;
    log.info(
      { tier: this._tier, caps: capsForTier(this._tier), parentListId: this._parentListId ?? null },
      'code-analyzer scope tier captured',
    );

    return [{
      index: 0,
      description: `Code Analyzer: planning tasks (tier ${this._tier})...`,
      kind: 'llm',
      intent: 'code-analysis',
      systemPrompt: buildPlanSystemPrompt(this._tier),
      userMessage: this.renderPlanUserMessage(this._request, this._repoSummary),
      resolverAgent: 'code-analyzer',
      resolverStep: 'plan',
      providerHint: 'claude',
      temperature: 0,
      maxTokens: 2500,
      stateKey: K_PLAN_RESULT,
      persisted: true,
    }];
  }

  /**
   * Lazy-initialise controller state on the first next() call. The
   * framework's runControlledPipeline creates the real stateStore
   * locally (`stateStore = deps.stateStore ?? createTaskStateStore()`)
   * but does not write it back to the deps it handed to attachDeps,
   * so this.deps.stateStore is still undefined here. The state
   * parameter passed to next() IS the right store -- seed it once.
   */
  private ensureStateInitialized(state: TaskStateStore): void {
    if (state.has(K_STATE)) return;
    if (this._request === undefined || this._repoSummary === undefined) {
      log.error('ensureStateInitialized: instance fields missing (resume without buildInitialTasks?)');
      return;
    }
    const initialState: CodeAnalysisState = {
      request:      this._request,
      repoSummary:  this._repoSummary,
      tier:         this._tier,
      listId:       '',
      childListIds: [],
      truncated:    false,
      cancelled:    false,
      approvedDirs: [],
    };
    state.set(K_STATE, initialState);
    state.set(K_PHASE, 'planning' as Phase);
    state.set(K_RETRIES, {} as Record<string, number>);
    state.set(K_FOLLOWUP_COUNT, 0);
    state.set(K_ACCEPTED, [] as Array<{ task: AnalysisTask; result: AnalyzerResult }>);
    state.set(K_HISTORY, [] as AnalyzerResult[]);
  }

  // -- main state machine ---------------------------------------------------

  async next(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Promise<Task[] | null> {
    this.ensureStateInitialized(state);
    const phase = state.get<Phase>(K_PHASE) ?? 'planning';
    log.info({ phase, completed: completed.description, gateAction: gateReply?.action }, 'next()');

    switch (phase) {
      case 'planning':
        return this.afterPlan(completed, state);

      case 'plan-approval':
        return this.afterPlanApprovalGate(gateReply, state);

      case 'analyzing':
        // The "analyzing" phase queues a review LLM task; that task's
        // completion brings us back to next() in the 'reviewing' phase.
        log.warn({ phase }, 'unexpected next() call in analyzing phase');
        return null;

      case 'reviewing':
        return this.afterReview(completed, state);

      case 'synthesising':
        return this.afterSynthesise(completed, state);

      case 'done':
        return null;
    }
  }

  finalize(state: TaskStateStore): FinalizeResult {
    const synthResult = state.get<string>(K_SYNTH_RESULT) ?? '';
    if (synthResult.length === 0) {
      // Pipeline aborted before synthesise -- best-effort summary.
      const accepted = state.get<Array<{ task: AnalysisTask; result: AnalyzerResult }>>(K_ACCEPTED) ?? [];
      const fallback = accepted.length === 0
        ? '_Code analysis aborted before any task completed._'
        : `_Code analysis aborted partway through (${accepted.length} task(s) completed). See the todos pane for details._`;
      return { output: fallback, format: 'markdown' };
    }
    // Plan §2.1 hard requirement 1: the chat panel MUST NOT render
    // the synthesised markdown -- it lives in the Code Analysis
    // Report Pane (workbench) and in `list.body` (durable). The
    // afterSynthesise step already emits a one-line "report ready"
    // delta to the transcript. Returning a duplicate one-liner here
    // would just double-print; an empty FinalizeResult lets the
    // framework render nothing extra.
    return { output: '', format: 'markdown' };
  }

  // -------------------------------------------------------------------------
  // Phase handlers
  // -------------------------------------------------------------------------

  private async afterPlan(completed: TaskResult, state: TaskStateStore): Promise<Task[] | null> {
    const planText = completed.output;
    const planned = parsePlannedTasks(planText);
    if (planned.length === 0) {
      log.warn({ planText: planText.slice(0, 200) }, 'planner returned no tasks');
      state.set(K_PHASE, 'done' as Phase);
      state.set(K_SYNTH_RESULT, '_Planner returned no tasks. Try rephrasing the request._');
      state.markSessionComplete();
      return null;
    }

    // Phase 5.A: tier-aware caps. Tier was captured in
    // buildInitialTasks; default 'M' matches the pre-Phase-5 caps.
    const caps = capsForTier(this._tier);

    // Apply hard cap silently (the planner prompt asks for <= softCap
    // already; anything past hardCap is dropped before the user even
    // sees it).
    const trimmedHard = planned.slice(0, caps.hardTaskCap);
    state.set(K_PLAN_TASKS, trimmedHard);

    if (trimmedHard.length > caps.softTaskCap) {
      // Plan-size approval gate. Surface the plan to the user so they
      // can approve / trim-to-soft-cap / cancel before we pay the
      // cloud cost of N reviews.
      state.set(K_PHASE, 'plan-approval' as Phase);
      const summary = renderPlanSummary(trimmedHard, caps);
      return [{
        index: 1,
        description: `Plan has ${trimmedHard.length} tasks (tier ${this._tier}; soft cap ${caps.softTaskCap}). Approve, trim, or cancel?`,
        kind: 'transform',
        intent: 'code-analysis',
        passThrough: true,
        userMessage: summary,
        outputFormat: 'markdown',
        requiresGate: true,
        gateTitle: `Code Analyzer plan size approval (tier ${this._tier})`,
        gateActions: [
          { name: 'approve', label: 'Approve all' },
          { name: 'trim-to-soft', label: `Trim to first ${caps.softTaskCap}` },
          { name: 'cancel', label: 'Cancel run' },
        ],
        persisted: true,
      }];
    }

    return await this.beginAnalysis(trimmedHard, state);
  }

  private async afterPlanApprovalGate(gateReply: GateReply | undefined, state: TaskStateStore): Promise<Task[] | null> {
    const action = gateReply?.action ?? 'cancel';
    let planned = state.get<AnalysisTask[]>(K_PLAN_TASKS) ?? [];
    const caps = capsForTier(this._tier);
    log.info({ action, plannedCount: planned.length, tier: this._tier }, 'plan-size-approval gate fired');

    if (action === 'cancel') {
      const ca = state.get<CodeAnalysisState>(K_STATE);
      if (ca) state.set(K_STATE, { ...ca, cancelled: true });
      state.set(K_PHASE, 'done' as Phase);
      state.set(K_SYNTH_RESULT, '_Code analysis cancelled at the plan-size gate._');
      state.markSessionComplete();
      return null;
    }
    // 'trim-to-soft' is the new action name; keep accepting the legacy
    // 'trim-to-16' so any in-flight runs from before this commit don't
    // mis-route on the gate reply.
    if (action === 'trim-to-soft' || action === 'trim-to-16') {
      planned = planned.slice(0, caps.softTaskCap);
      state.set(K_PLAN_TASKS, planned);
      const ca = state.get<CodeAnalysisState>(K_STATE);
      if (ca) state.set(K_STATE, { ...ca, truncated: true });
    }
    return await this.beginAnalysis(planned, state);
  }

  private async beginAnalysis(planned: AnalysisTask[], state: TaskStateStore): Promise<Task[] | null> {
    if (this.deps === undefined || this.deps.todos === undefined) {
      // Should never happen -- runControlledPipeline auto-builds
      // deps.todos for registered families. Fail closed.
      log.error('beginAnalysis: deps.todos is undefined; cannot create TodoList');
      state.set(K_PHASE, 'done' as Phase);
      state.set(K_SYNTH_RESULT, '_Internal error: TODO framework unavailable._');
      state.markSessionComplete();
      return null;
    }

    // Create the TodoList + items the user sees in the todos pane.
    const ca = state.get<CodeAnalysisState>(K_STATE);
    if (ca === undefined) {
      log.error('beginAnalysis: state missing');
      return null;
    }
    const list = await this.deps.todos.createList({
      sessionId: this.deps.session.id,
      title: `Code Analysis: ${truncateTitle(ca.request)}`,
      description: ca.request,
      // Phase 5.D: when this run was kicked off as a drill-down from
      // an existing report's footer, stamp the parent edge so the
      // todos framework + Report Pane can render the parent-child
      // thread (kebab "Open report" can climb back up; the pane can
      // show breadcrumbs).
      ...(this._parentListId !== undefined ? { parentListId: this._parentListId } : {}),
    });
    const taskWithIds: AnalysisTask[] = [];
    const queue: string[] = [];
    for (const t of planned) {
      const item = await this.deps.todos.addItem(list.id, {
        title: shortTitleFor(t),
        description: t.question,
        meta: {
          kind: t.kind,
          scope: t.scope,
          origin: t.origin,
          retryCount: t.retryCount,
        },
      });
      taskWithIds.push({ ...t, itemId: item.id });
      queue.push(item.id);
    }
    state.set(K_PLAN_TASKS, taskWithIds);
    state.set(K_TASK_QUEUE, queue);
    state.set(K_STATE, { ...ca, listId: list.id });
    state.set(K_LIST_ID, list.id);

    return await this.runNextAnalyzerTask(state);
  }

  /**
   * Pop the next item from the queue, run the analyzer for it inline,
   * stash the result on the item's meta, and queue the corresponding
   * review LLM task. Returns null when the queue is empty (caller
   * advances to synthesise).
   */
  private async runNextAnalyzerTask(state: TaskStateStore): Promise<Task[] | null> {
    if (this.deps === undefined) return null;
    const queue = state.get<string[]>(K_TASK_QUEUE) ?? [];
    if (queue.length === 0) {
      // No more pending items -- jump to synthesise.
      return this.queueSynthesise(state);
    }
    const itemId = queue[0]!;
    const planned = state.get<AnalysisTask[]>(K_PLAN_TASKS) ?? [];
    const taskBase = planned.find(t => t.itemId === itemId);
    if (taskBase === undefined) {
      log.error({ itemId }, 'runNextAnalyzerTask: task not found in plan');
      // Drop and recurse.
      state.set(K_TASK_QUEUE, queue.slice(1));
      return this.runNextAnalyzerTask(state);
    }
    // Apply per-item retry count + hint from prior reviewer decision.
    const retries = state.get<Record<string, number>>(K_RETRIES) ?? {};
    const retryCount = retries[itemId] ?? 0;
    const hint = state.get<string>(`${K_RETRIES}:hint:${itemId}`);
    const task: AnalysisTask = {
      ...taskBase,
      retryCount,
      ...(hint !== undefined ? { hint } : {}),
    };
    state.set(K_CURRENT_TASK, task);

    if (this.deps.todos !== undefined) {
      try {
        await this.deps.todos.markInProgress(itemId);
      } catch (err) {
        log.warn({ err, itemId }, 'markInProgress failed (continuing)');
      }
    }

    // Phase 2.5: per-task cache. Look up before paying analyzer +
    // reviewer cost. Tier is part of the key (different tiers produce
    // different per-task playbook output for the same question --
    // Phase 5.B). Hits short-circuit straight to accepted-with-original
    // -confidence; the reviewer LLM task is skipped entirely.
    const ca = state.get<CodeAnalysisState>(K_STATE);
    const repoSnapshotId = ca?.repoSummary.repoSnapshotId ?? '';
    const cached = await readCachedResult({
      question: task.question,
      scope: task.scope,
      repoSnapshotId,
      tier: this._tier,
    });
    if (cached !== null) {
      log.info({ itemId, kind: task.kind, tier: this._tier }, 'analyzer cache hit; skipping analyzer + reviewer');
      this.deps.send({
        id: this.deps.requestId,
        stream: 'progress',
        data: { message: `[code-analyzer] cache hit: ${task.kind} -- ${shortTitleFor(task)}` },
      });
      // Mirror runNextAnalyzerTask's accept-path side-effects: meta,
      // markComplete, accepted/history, queue advance.
      if (this.deps.todos !== undefined) {
        try {
          await this.deps.todos.updateItemMeta(itemId, {
            kind: task.kind,
            scope: task.scope,
            origin: task.origin,
            retryCount: task.retryCount,
            ...(task.hint !== undefined ? { hint: task.hint } : {}),
            answer: cached.answer,
            findings: cached.findings,
            citations: cached.citations,
            confidence: cached.confidence,
            toolCalls: cached.toolCalls,
            ...(cached.truncated ? { truncated: true } : {}),
            cacheHit: true,
          });
          await this.deps.todos.markComplete(itemId);
        } catch (err) {
          log.warn({ err, itemId }, 'cache-hit todos update failed (continuing)');
        }
      }
      const accepted = state.get<Array<{ task: AnalysisTask; result: AnalyzerResult }>>(K_ACCEPTED) ?? [];
      const history = state.get<AnalyzerResult[]>(K_HISTORY) ?? [];
      accepted.push({ task, result: cached });
      history.push(cached);
      state.set(K_ACCEPTED, accepted);
      state.set(K_HISTORY, history);
      state.set(K_TASK_QUEUE, queue.slice(1));
      return this.runNextAnalyzerTask(state);
    }

    // Progress to the user -- the analyzer awaits below for up to 60s,
    // and the framework only emits progress between tasks; we manually
    // emit so the user sees something happening.
    this.deps.send({
      id: this.deps.requestId,
      stream: 'progress',
      data: { message: `[code-analyzer] running task: ${task.kind} -- ${shortTitleFor(task)}` },
    });

    const provider = this.resolveAnalyzerProvider();
    const outcome = await runAnalyzer(task, {
      provider,
      session: this.deps.session,
      onProgress: (msg) => this.deps?.send({
        id: this.deps.requestId,
        stream: 'progress',
        data: { message: `[code-analyzer] ${msg}` },
      }),
      ...(this.deps.abortController?.signal ? { signal: this.deps.abortController.signal } : {}),
      checkPathAccess: (path) => this.checkPathAccess(path, state),
      // Phase 5.A: per-tier wall-clock budget. S=30s, M=60s, L=60s,
      // XL=60s, XXL+=90s. Default tier is 'M' (60s -- the
      // pre-Phase-5 budget) so existing callers don't change shape.
      wallClockMs: capsForTier(this._tier).perTaskWallClockMs,
      // Phase 5.B: tier threaded into the analyzer system prompt so
      // tierAnalyzerGuidance shifts the analytical altitude
      // (per-line citations / signature-level / structural).
      tier: this._tier,
    });
    state.set(K_LAST_RUNNER, outcome);

    // Stash the runner result on item.meta so the todos pane / future
    // resume can render it without rerunning.
    if (this.deps.todos !== undefined) {
      try {
        await this.deps.todos.updateItemMeta(itemId, {
          kind: task.kind,
          scope: task.scope,
          origin: task.origin,
          retryCount: task.retryCount,
          ...(task.hint !== undefined ? { hint: task.hint } : {}),
          answer: outcome.result.answer,
          findings: outcome.result.findings,
          citations: outcome.result.citations,
          confidence: outcome.result.confidence,
          toolCalls: outcome.result.toolCalls,
          ...(outcome.result.truncated ? { truncated: true } : {}),
          ...(outcome.warning !== undefined ? { warning: outcome.warning } : {}),
        });
      } catch (err) {
        log.warn({ err, itemId }, 'updateItemMeta failed (continuing)');
      }
    }

    state.set(K_PHASE, 'reviewing' as Phase);

    // Queue the review LLM task.
    const history = state.get<AnalyzerResult[]>(K_HISTORY) ?? [];
    const reviewMessages = buildReviewPrompt(task, outcome.result, history);
    const userMessage = reviewMessages
      .filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content : '[complex content]')
      .join('\n\n');

    return [{
      index: 100, // sentinel; framework only uses this for ordering within a sub-pipeline
      description: `Code Analyzer: reviewing task "${shortTitleFor(task)}"...`,
      kind: 'llm',
      intent: 'code-analysis',
      systemPrompt: REVIEW_SYSTEM,
      userMessage,
      resolverAgent: 'code-analyzer',
      resolverStep: 'review',
      providerHint: 'claude',
      temperature: 0,
      maxTokens: 1200,
      stateKey: K_REVIEW_RESULT,
      persisted: true,
    }];
  }

  private async afterReview(completed: TaskResult, state: TaskStateStore): Promise<Task[] | null> {
    const decision = parseReviewerDecision(completed.output);
    const currentTask = state.get<AnalysisTask>(K_CURRENT_TASK);
    const outcome = state.get<{ result: AnalyzerResult; warning?: string; truncated: boolean; proseOnlyFallback?: boolean }>(K_LAST_RUNNER);
    if (currentTask === undefined || outcome === undefined) {
      log.error('afterReview: missing currentTask or last runner outcome');
      return this.queueSynthesise(state);
    }

    const queue = state.get<string[]>(K_TASK_QUEUE) ?? [];
    const retries = { ...(state.get<Record<string, number>>(K_RETRIES) ?? {}) };
    const followUpsSoFar = state.get<number>(K_FOLLOWUP_COUNT) ?? 0;
    const accepted = state.get<Array<{ task: AnalysisTask; result: AnalyzerResult }>>(K_ACCEPTED) ?? [];
    const history = state.get<AnalyzerResult[]>(K_HISTORY) ?? [];

    log.info(
      { itemId: currentTask.itemId, decision: decision.decision, retryCount: currentTask.retryCount, queueRemaining: queue.length, proseOnlyFallback: outcome.proseOnlyFallback === true },
      'reviewer decision',
    );

    // F4 guard: when the previous analyzer pass fell back to prose-only
    // (the local model couldn't produce valid JSON across the strict-
    // JSON retry), a reviewer-driven retry-with-hint is dead air. The
    // model's blocked on JSON formatting, not on the question. Force
    // accept-with-low-confidence so the run doesn't burn another ~60s
    // per item to reach the same fallback.
    if (decision.decision === 'retry-with-hint' && outcome.proseOnlyFallback === true) {
      log.info(
        { itemId: currentTask.itemId },
        'F4: skipping retry-with-hint because previous outcome was prose-only fallback; accepting with low confidence',
      );
      if (this.deps?.todos !== undefined) {
        try {
          await this.deps.todos.markComplete(currentTask.itemId);
        } catch (err) {
          log.warn({ err, itemId: currentTask.itemId }, 'markComplete failed');
        }
      }
      const downgraded: AnalyzerResult = { ...outcome.result, confidence: 'low' };
      accepted.push({ task: currentTask, result: downgraded });
      history.push(downgraded);
      state.set(K_ACCEPTED, accepted);
      state.set(K_HISTORY, history);
      state.set(K_TASK_QUEUE, queue.slice(1));
      return this.runNextAnalyzerTask(state);
    }

    switch (decision.decision) {
      case 'accept': {
        // Phase 2.5: write to per-task cache BEFORE markComplete --
        // every reviewer-accepted result is reusable on the next run
        // (same question + scope + tier within the same git revision).
        // Cache write is fire-and-forget defensively inside the helper
        // (write errors are logged but never thrown), so an unexpected
        // failure here can't sink the analyze run.
        const caForCache = state.get<CodeAnalysisState>(K_STATE);
        const snapshotId = caForCache?.repoSummary.repoSnapshotId ?? '';
        await writeCachedResult(
          {
            question: currentTask.question,
            scope: currentTask.scope,
            repoSnapshotId: snapshotId,
            tier: this._tier,
          },
          outcome.result,
        );
        // Mark item complete + capture for synthesise.
        if (this.deps?.todos !== undefined) {
          try {
            await this.deps.todos.markComplete(currentTask.itemId);
          } catch (err) {
            log.warn({ err, itemId: currentTask.itemId }, 'markComplete failed');
          }
        }
        accepted.push({ task: currentTask, result: outcome.result });
        history.push(outcome.result);
        state.set(K_ACCEPTED, accepted);
        state.set(K_HISTORY, history);
        state.set(K_TASK_QUEUE, queue.slice(1));
        return this.runNextAnalyzerTask(state);
      }

      case 'retry-with-hint': {
        const newCount = (retries[currentTask.itemId] ?? 0) + 1;
        if (newCount > MAX_RETRIES_PER_TASK) {
          // Cap reached -- accept-with-low-confidence per design section 6.4.2.
          log.info({ itemId: currentTask.itemId, newCount }, 'retry cap reached; accepting with low confidence');
          if (this.deps?.todos !== undefined) {
            try {
              await this.deps.todos.markComplete(currentTask.itemId);
            } catch (err) {
              log.warn({ err, itemId: currentTask.itemId }, 'markComplete failed');
            }
          }
          const downgraded: AnalyzerResult = { ...outcome.result, confidence: 'low' };
          accepted.push({ task: currentTask, result: downgraded });
          history.push(downgraded);
          state.set(K_ACCEPTED, accepted);
          state.set(K_HISTORY, history);
          state.set(K_TASK_QUEUE, queue.slice(1));
          return this.runNextAnalyzerTask(state);
        }
        retries[currentTask.itemId] = newCount;
        state.set(K_RETRIES, retries);
        state.set(`${K_RETRIES}:hint:${currentTask.itemId}`, decision.retryHint);
        // Re-run the same item -- queue head stays.
        return this.runNextAnalyzerTask(state);
      }

      case 'add-follow-up': {
        // Accept the current item first.
        if (this.deps?.todos !== undefined) {
          try {
            await this.deps.todos.markComplete(currentTask.itemId);
          } catch (err) {
            log.warn({ err, itemId: currentTask.itemId }, 'markComplete failed');
          }
        }
        accepted.push({ task: currentTask, result: outcome.result });
        history.push(outcome.result);
        state.set(K_ACCEPTED, accepted);
        state.set(K_HISTORY, history);

        // Add up to 2 follow-ups -- but respect the global cap. Phase
        // 5.A: hard cap is now tier-driven.
        const slotsLeft = MAX_FOLLOWUPS - followUpsSoFar;
        const totalPlanned = (state.get<AnalysisTask[]>(K_PLAN_TASKS) ?? []).length;
        const slotsBudget = Math.min(slotsLeft, capsForTier(this._tier).hardTaskCap - totalPlanned);
        const newSeeds: AnalysisTaskSeed[] = decision.followUps.slice(0, Math.min(2, Math.max(0, slotsBudget)));
        if (newSeeds.length > 0 && this.deps?.todos !== undefined) {
          const planned = state.get<AnalysisTask[]>(K_PLAN_TASKS) ?? [];
          const newQueue = [...queue.slice(1)];
          for (const seed of newSeeds) {
            const item = await this.deps.todos.addItem(state.get<string>(K_LIST_ID) ?? '', {
              title: shortTitleFor(seed),
              description: seed.question,
              meta: { kind: seed.kind, scope: seed.scope, origin: 'follow-up', retryCount: 0 },
            });
            const fullTask: AnalysisTask = { ...seed, itemId: item.id, origin: 'follow-up', retryCount: 0 };
            planned.push(fullTask);
            newQueue.push(item.id);
          }
          state.set(K_PLAN_TASKS, planned);
          state.set(K_TASK_QUEUE, newQueue);
          state.set(K_FOLLOWUP_COUNT, followUpsSoFar + newSeeds.length);
        } else {
          state.set(K_TASK_QUEUE, queue.slice(1));
        }
        return this.runNextAnalyzerTask(state);
      }

      case 'done': {
        // Accept the current item, then cancel everything pending and
        // jump straight to synthesise.
        if (this.deps?.todos !== undefined) {
          try {
            await this.deps.todos.markComplete(currentTask.itemId);
          } catch (err) {
            log.warn({ err, itemId: currentTask.itemId }, 'markComplete failed');
          }
        }
        accepted.push({ task: currentTask, result: outcome.result });
        state.set(K_ACCEPTED, accepted);
        // Cancel remaining items.
        const remaining = queue.slice(1);
        if (this.deps?.todos !== undefined) {
          for (const id of remaining) {
            try { await this.deps.todos.markCancelled(id); }
            catch (err) { log.warn({ err, id }, 'markCancelled failed'); }
          }
        }
        state.set(K_TASK_QUEUE, []);
        return this.queueSynthesise(state);
      }
    }
  }

  private queueSynthesise(state: TaskStateStore): Task[] | null {
    state.set(K_PHASE, 'synthesising' as Phase);
    const ca = state.get<CodeAnalysisState>(K_STATE);
    const planned = state.get<AnalysisTask[]>(K_PLAN_TASKS) ?? [];
    const accepted = state.get<Array<{ task: AnalysisTask; result: AnalyzerResult }>>(K_ACCEPTED) ?? [];
    // Phase 5.C: thread the run's tier into both the system prompt
    // (tierSynthesiseGuidance picks the report shape) and the user
    // block (so the model sees an explicit "Run tier: X" reminder).
    // Tier defaults to 'M' when missing -- the pre-Phase-5 shape.
    const tier = this._tier;
    const messages = buildSynthesisPrompt(ca?.request ?? '', accepted, planned, tier);
    const userMessage = messages
      .filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content : '[complex content]')
      .join('\n\n');
    return [{
      index: 200,
      description: `Code Analyzer: composing report (tier ${tier})...`,
      kind: 'llm',
      intent: 'code-analysis',
      systemPrompt: buildSynthesiseSystemPrompt(tier),
      userMessage,
      resolverAgent: 'code-analyzer',
      resolverStep: 'synthesise',
      providerHint: 'local',
      temperature: 0.2,
      maxTokens: 4000,
      stateKey: K_SYNTH_RESULT,
      persisted: true,
    }];
  }

  private async afterSynthesise(completed: TaskResult, state: TaskStateStore): Promise<Task[] | null> {
    // F11: local synthesis models occasionally prefix the report with
    // a stray quote / backtick / wrapping fence that the Report Pane
    // then renders as literal text, breaking the first heading. Strip
    // the known prefixes BEFORE the body lands in list.body so every
    // downstream surface (Report Pane, todos pane preview, save-to-
    // file) sees the clean markdown. Idempotent.
    const report = sanitizeMarkdownReport(completed.output);
    state.set(K_SYNTH_RESULT, report);
    const listId = state.get<string>(K_LIST_ID);
    if (listId && this.deps?.todos !== undefined) {
      try {
        await this.deps.todos.updateListBody(listId, report);
      } catch (err) {
        log.warn({ err, listId }, 'updateListBody failed (continuing)');
      }
    }

    // Phase 2.1: the synthesised markdown renders in the dedicated
    // Code Analyzer Report Pane (workbench-side flow contribution
    // listens for `listUpdated` on a code-analyzer list with a
    // non-empty body and opens the pane). Plan §2.1 hard requirement
    // 1: the report MUST NOT be rendered in the chat panel. We drop
    // the previous `transform { passThrough, userMessage: report }`
    // gate -- it was the temporary state from Phase 1 -- and emit a
    // single-line "report ready" delta so the chat transcript still
    // captures that the analysis finished.
    if (this.deps !== undefined) {
      this.deps.send({
        id: this.deps.requestId,
        stream: 'delta',
        data: {
          text: '\n_Code Analysis report ready -- see the **Code Analysis Report** pane._\n',
          format: 'markdown',
        },
      });
    }
    state.set(K_PHASE, 'done' as Phase);
    state.markSessionComplete();
    return null;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildRepoSummary(input: ControllerInput): RepoSummary {
    const session = input.session;
    const rootPath = session?.repoPath ?? '';
    const closureSize = session?.closureRepos.length ?? 0;
    return {
      name: rootPath.split('/').filter(Boolean).pop() ?? '(unknown)',
      rootPath,
      primaryLanguages: [],
      topLevelPackages: [],
      closureSize,
      // Phase 2.5: stable repo snapshot id keyed on git HEAD. The
      // per-task cache uses this as part of the entry key; a new commit
      // on this repo flips the snapshot id and naturally invalidates
      // every cached entry. Synchronous read is fine -- `.git/HEAD` is
      // tiny and on the local fs. Falls back to a per-process timestamp
      // when there's no git checkout (manual rootPath, fresh dir, ...).
      repoSnapshotId: readGitHeadSnapshotId(rootPath),
    };
  }

  private renderPlanUserMessage(request: string, repo: RepoSummary): string {
    const messages = buildPlanPrompt(request, repo, this._tier);
    return messages
      .filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content : '[complex content]')
      .join('\n\n');
  }

  private resolveAnalyzerProvider() {
    if (this.deps === undefined) {
      throw new Error('resolveAnalyzerProvider: deps not attached');
    }
    return this.deps.session.resolver.resolve('code-analyzer', 'analyzer');
  }

  // -------------------------------------------------------------------------
  // fs-access gate (Phase 1.6)
  // -------------------------------------------------------------------------

  /**
   * Path-access check the analyzer runner consults before fs-class
   * tool calls. In-repo paths are implicit allow; out-of-repo paths
   * are matched against the session's approvedDirs, and unapproved
   * paths fire an interactive gate. On approve the parent directory
   * is added to approvedDirs (cascades to descendants for the rest
   * of the chat session).
   */
  private async checkPathAccess(
    requestedPathRaw: string,
    state: TaskStateStore,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (this.deps === undefined) return { allowed: false, reason: 'deps not attached' };
    const ca = state.get<CodeAnalysisState>(K_STATE);
    if (ca === undefined) return { allowed: true };
    const { resolve: pathResolve, dirname, sep } = await import('node:path');

    const requestedAbs = pathResolve(this.deps.session.repoPath || process.cwd(), requestedPathRaw);
    const repoRoot = ca.repoSummary.rootPath;

    if (repoRoot.length > 0 && (requestedAbs === repoRoot || requestedAbs.startsWith(repoRoot + sep))) {
      return { allowed: true };
    }
    for (const approved of ca.approvedDirs) {
      if (requestedAbs === approved || requestedAbs.startsWith(approved + sep)) {
        return { allowed: true };
      }
    }
    // Out-of-repo + unapproved -- fire the gate. Grant the parent
    // directory so descendants are covered for the rest of the session.
    const grantPath = dirname(requestedAbs);
    log.info({ requestedAbs, grantPath }, 'fs-access gate: firing for out-of-repo path');
    const action = await this.fireFsAccessGate(requestedAbs, grantPath);
    if (action === 'approve') {
      const updated: CodeAnalysisState = {
        ...ca,
        approvedDirs: [...ca.approvedDirs, grantPath],
      };
      state.set(K_STATE, updated);
      log.info({ grantPath, total: updated.approvedDirs.length }, 'fs-access gate: approved');
      return { allowed: true };
    }
    log.info({ grantPath }, 'fs-access gate: denied');
    return { allowed: false, reason: `user denied access to ${grantPath}` };
  }

  /**
   * Fire the fs-access gate via the daemon's external-gate channel.
   * Awaits the user's reply (no timeout in Phase 1; matches
   * gateTaskResult's behaviour).
   */
  private async fireFsAccessGate(requestedPath: string, grantPath: string): Promise<string> {
    if (this.deps === undefined) {
      throw new Error('fireFsAccessGate: deps not attached');
    }
    const gateId = `code-analyzer-fs-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const content = [
      'The Code Analyzer wants to read a path **outside the active repo**:',
      '',
      `**Requested:** \`${requestedPath}\``,
      `**Grant scope:** \`${grantPath}\` (covers all descendants for the rest of this chat session)`,
      '',
      'Approving once covers every file under the grant scope -- the analyzer will not re-prompt for further reads inside it. A new chat session re-asks.',
    ].join('\n');
    this.deps.send({
      id: this.deps.requestId,
      stream: 'gate',
      data: {
        gateId,
        title: 'Code Analyzer: out-of-repo path',
        content,
        format: 'markdown',
        actions: [
          { name: 'approve', label: `Approve \`${grantPath}\`` },
          { name: 'deny', label: 'Deny' },
        ],
      },
    });

    const channel = this.deps.channel;
    return await new Promise<string>((resolve, reject) => {
      channel.registerExternalGate(
        gateId,
        (reply) => resolve(reply.action),
        reject,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Plan / review parsing
// ---------------------------------------------------------------------------

interface PlannedTaskRaw {
  kind?: unknown;
  title?: unknown;
  question?: unknown;
  scope?: unknown;
}

function parsePlannedTasks(raw: string): AnalysisTask[] {
  const cleaned = stripFences(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const tasksRaw = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasksRaw)) return [];
  const out: AnalysisTask[] = [];
  for (const t of tasksRaw) {
    if (!isObject(t)) continue;
    const r = t as PlannedTaskRaw;
    const kind = typeof r.kind === 'string' ? r.kind : '';
    if (!isAnalysisKind(kind)) continue;
    const question = typeof r.question === 'string' ? r.question.trim() : '';
    if (question.length === 0) continue;
    out.push({
      itemId: '', // assigned at addItem time
      kind,
      question,
      ...(isObject(r.scope) ? { scope: parseScope(r.scope as Record<string, unknown>) } : {}),
      origin: 'plan',
      retryCount: 0,
    });
  }
  return out;
}

function parseScope(raw: Record<string, unknown>): AnalysisTask['scope'] {
  const entityIds = Array.isArray(raw['entityIds'])
    ? raw['entityIds'].filter((x): x is string => typeof x === 'string')
    : undefined;
  const paths = Array.isArray(raw['paths'])
    ? raw['paths'].filter((x): x is string => typeof x === 'string')
    : undefined;
  const packages = Array.isArray(raw['packages'])
    ? raw['packages'].filter((x): x is string => typeof x === 'string')
    : undefined;
  const direction =
    raw['direction'] === 'callers' || raw['direction'] === 'callees' || raw['direction'] === 'both'
      ? raw['direction']
      : undefined;
  const targets =
    Array.isArray(raw['targets']) &&
    raw['targets'].length === 2 &&
    raw['targets'].every(x => typeof x === 'string')
      ? ([raw['targets'][0] as string, raw['targets'][1] as string] as const)
      : undefined;
  return {
    ...(entityIds !== undefined ? { entityIds } : {}),
    ...(paths !== undefined ? { paths } : {}),
    ...(packages !== undefined ? { packages } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(targets !== undefined ? { targets } : {}),
  };
}

function parseReviewerDecision(raw: string): ReviewerDecision {
  const cleaned = stripFences(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { decision: 'accept', rationale: 'reviewer JSON unparseable; defaulting to accept' };
  }
  if (!isObject(parsed)) {
    return { decision: 'accept', rationale: 'reviewer payload not an object; defaulting to accept' };
  }
  const obj = parsed;
  const decision = obj['decision'];
  const rationale = typeof obj['rationale'] === 'string' ? obj['rationale'] : '';
  if (decision === 'accept' || decision === 'done') {
    return { decision, rationale };
  }
  if (decision === 'retry-with-hint') {
    const hint = typeof obj['retryHint'] === 'string' ? obj['retryHint'] : '';
    if (hint.length === 0) {
      return { decision: 'accept', rationale: 'retry-with-hint with empty hint; treating as accept' };
    }
    return { decision: 'retry-with-hint', rationale, retryHint: hint };
  }
  if (decision === 'add-follow-up') {
    const followUpsRaw = Array.isArray(obj['followUps']) ? obj['followUps'] : [];
    const followUps: AnalysisTaskSeed[] = [];
    for (const f of followUpsRaw) {
      if (!isObject(f)) continue;
      const r = f as PlannedTaskRaw;
      const kind = typeof r.kind === 'string' ? r.kind : '';
      if (!isAnalysisKind(kind)) continue;
      const question = typeof r.question === 'string' ? r.question.trim() : '';
      if (question.length === 0) continue;
      followUps.push({
        kind,
        question,
        ...(isObject(r.scope) ? { scope: parseScope(r.scope as Record<string, unknown>) } : {}),
      });
    }
    return { decision: 'add-follow-up', rationale, followUps };
  }
  return { decision: 'accept', rationale: `unknown decision "${String(decision)}"; defaulting to accept` };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function shortTitleFor(t: AnalysisTaskSeed | AnalysisTask): string {
  // Prefer the planner-provided title when present; otherwise derive from question.
  const seed = (t as { title?: unknown }).title;
  if (typeof seed === 'string' && seed.trim().length > 0) {
    return seed.trim().slice(0, 80);
  }
  return truncateTitle(t.question);
}

function truncateTitle(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed;
}

function renderPlanSummary(tasks: readonly AnalysisTask[], caps: TierCaps): string {
  const lines: string[] = [`# Code Analyzer plan (${tasks.length} tasks)`, ''];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    lines.push(`${i + 1}. [${t.kind}] ${shortTitleFor(t)}`);
  }
  lines.push('');
  lines.push(`Soft cap is ${caps.softTaskCap}. Trim drops items past the first ${caps.softTaskCap}.`);
  return lines.join('\n');
}

function isAnalysisKind(s: string): s is AnalysisTask['kind'] {
  return s === 'locate' || s === 'describe' || s === 'trace' || s === 'compare' || s === 'free-form';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stripFences(text: string): string {
  let out = text;
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  return out.trim();
}

/**
 * Compute a stable repo snapshot id from the active repo's git HEAD.
 *
 * Handles two HEAD shapes:
 *   1. `ref: refs/heads/<branch>` -- normal branch checkout. Read the
 *      branch ref for the actual SHA; fall back to the literal `ref:`
 *      string if the ref file is missing (just-created branch with no
 *      commit yet).
 *   2. Bare 40-hex SHA -- detached HEAD. Return it directly.
 *
 * On any failure (no `.git/`, unreadable file, unknown shape, empty
 * rootPath) falls back to a per-process timestamp so cache lookups
 * still work, but every controller instance ends up in its own private
 * key-space (no cross-run reuse). That's acceptable -- the cache stays
 * correct, just empty.
 *
 * Sync I/O is intentional: `buildRepoSummary` is called from the
 * synchronous `buildInitialTasks` path. `.git/HEAD` and the ref file
 * are tiny (<100 bytes) and on the local fs; the read is negligible.
 */
function readGitHeadSnapshotId(rootPath: string): string {
  if (rootPath.length === 0) {
    return `t-${Date.now()}`;
  }
  try {
    const headPath = pathJoin(rootPath, '.git', 'HEAD');
    const head = readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      try {
        const refPath = pathJoin(rootPath, '.git', ref);
        return readFileSync(refPath, 'utf8').trim();
      } catch {
        return head;
      }
    }
    // Detached HEAD: bare SHA.
    return head;
  } catch {
    return `t-${Date.now()}`;
  }
}
