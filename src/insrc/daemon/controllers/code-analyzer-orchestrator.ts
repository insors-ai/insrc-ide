/**
 * CodeAnalyzerOrchestratorController -- the Code Analyzer family's
 * task-controller entry point.
 *
 * State machine:
 *
 *   synthesising        -> [plan-expand-review-synthesise]
 *   done                  (writes list.body; the workbench-side
 *                          CodeAnalyzerFlowContribution opens the
 *                          Report Pane on the listUpdated event)
 *
 * Bootstrap markers (synthesis / re-run / resume) drive entry.
 * Free-form questions go through the planner -> per-section tool-loop
 * pipeline (`runPlanExpandReviewSynthesise`); re-runs of older lists
 * route through the legacy `analysisTaskToSkillPlan` shim.
 */

import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { getLogger } from '../../shared/logger.js';
import { planActions, type PlannedAction, type PlanExecution } from '../../agent/content-gen/plan-actions.js';
import { formatRepoSizeSummary } from '../repo-summary.js';
import { analysisTaskToSkillPlan } from '../../agent/tasks/code-analyzer/legacy-shim.js';
import { PRIOR_CONTEXT_TAG_CURRENT, summarizePriorContext } from '../../agent/intent/retriever.js';
import { makeSpillHandler } from '../../agent/artifacts/spill-writer.js';
import { runSkill, type SkillRunnerDeps } from '../skills/invoke.js';
import type { LLMProvider } from '../../shared/types.js';
import type { ProviderAffinity, SkillResult } from '../skills/types.js';
import type { ScopeSize } from '../../shared/classify.js';
import type {
  AnalysisTask,
  AnalyzerResult,
  CodeAnalysisState,
  Confidence,
  RepoSummary,
} from '../../agent/tasks/code-analyzer/types.js';
import {
  pipelineResultToAcceptedTasks,
  type PerSkillExecution,
  type PriorFactsForSkills,
  type SkillsPipelineResult,
} from '../../agent/tasks/code-analyzer/skills-pipeline.js';
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

/**
 * Sentinel emitted by `buildInitialTasks`'s pass-through transform
 * when the run is in re-run mode. `next()` recognises this exact
 * string and routes to `afterRerunBootstrap` instead of the regular
 * synthesis path.
 */
const RERUN_BOOTSTRAP_MARKER = '__rerun-bootstrap__';

/**
 * Sentinel emitted by `buildResumeTask`'s transform on a checkpoint
 * resume. `next()` recognises this and dispatches to the resume
 * bootstrap handler.
 */
const RESUME_BOOTSTRAP_MARKER = '__resume-bootstrap__';

// ---------------------------------------------------------------------------
// State keys
// ---------------------------------------------------------------------------

const K_STATE          = 'caState';
const K_PLAN_RESULT    = 'planResult';            // raw bootstrap pass-through output
const K_PLAN_TASKS     = 'plannedTasks';          // AnalysisTask[]
const K_ACCEPTED       = 'acceptedResults';       // {task, result}[]
const K_HISTORY        = 'reviewHistory';         // AnalyzerResult[] pre-history

/**
 * Pass-through marker emitted by `buildInitialTasks` for the
 * standard (non-rerun) entry path. The framework runs the
 * pass-through, calls `next()` with the marker, and we transition
 * straight into `queueSynthesise`. Phase F (2026-05-11) replaces
 * the old `SKILLS_ROUTING_BOOTSTRAP_MARKER` which kicked off a
 * legacy classify-question / select-scope / execute pipeline.
 */
const SYNTHESIS_BOOTSTRAP_MARKER = '__synthesis-bootstrap__';
const K_PHASE          = 'phase';
const K_SYNTH_RESULT   = 'synthResult';           // final markdown
const K_LIST_ID        = 'listId';

type Phase = 'synthesising' | 'done';

// Subset of CapturedSkillCall the reviewer + TodoList stamping read.
// Both writeSectionWithTools and patchSectionWithTools emit values
// shaped this way, so the per-round loop can accumulate them across
// rounds without importing both interfaces.
//
// Phase M.2: the orchestrator tags each entry with the round it came
// from so the reviewer-evidence builder can compress older rounds for
// round-2/3 reviews (cumulative evidence routinely blew the reviewer's
// input budget in run #2).
interface CapturedSkillCallLike {
  readonly skillId:          string;
  readonly args:             Record<string, unknown>;
  readonly resultText:       string;
  readonly errored:          boolean;
  readonly rejectionReason?: string | undefined;
}
interface TaggedSkillCall extends CapturedSkillCallLike {
  readonly round: 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class CodeAnalyzerOrchestratorController implements TaskController {
  readonly id = 'code-analyzer';

  private deps?: TaskOrchestratorDeps;
  private _request?: string;
  private _repoSummary?: RepoSummary;
  /**
   * Phase E.1b: full repo size + shape summary (file count, top
   * modules, language breakdown). Pre-computed by the chat-handler
   * before this controller boots so the scope classifier and the
   * planner share the same ground truth. Replaces the previous
   * one-line "closure size: N" repo descriptor that left the
   * planner emitting generic section titles.
   */
  private _repoSizeSummary?: import('../repo-summary.js').RepoSizeSummary | undefined;
  /**
   * Scope tier for this run -- captured from
   * `ControllerInput.classification.scope` in buildInitialTasks. Drives
   * the per-tier synthesis playbook. Defaults to `'M'` when the caller
   * didn't supply a tier.
   */
  private _tier: ScopeSize = 'M';
  /**
   * Parent list id for drill-down runs. Captured from
   * `ControllerInput.parentListId`; passed into `createList` so the
   * todos framework records the parent-child edge. Undefined for
   * top-level / non-drill runs.
   */
  private _parentListId: string | undefined = undefined;
  /**
   * Re-run mode. Set from `ControllerInput.rerunFromListId`. When
   * non-undefined the orchestrator queues a pass-through transform
   * task whose handler reconstructs `AnalysisTask[]` from the prior
   * list's items and replays them through the legacy-shim path.
   */
  private _rerunFromListId: string | undefined = undefined;

  attachDeps(deps: TaskOrchestratorDeps): void {
    this.deps = deps;
  }

  // -- start ----------------------------------------------------------------

  buildInitialTasks(input: ControllerInput): Task[] {
    this._request = input.message;
    this._repoSummary = this.buildRepoSummary(input);
    this._repoSizeSummary = input.repoSizeSummary;
    this._tier = input.classification?.scope ?? 'M';
    this._parentListId = input.parentListId;
    this._rerunFromListId = input.rerunFromListId;
    log.info(
      {
        tier:             this._tier,
        parentListId:     this._parentListId ?? null,
        rerunFromListId:  this._rerunFromListId ?? null,
      },
      'code-analyzer scope tier captured',
    );

    // Phase 6 of plans/intent-classification-consolidation.md:
    // the [intent:current] tag write moved to resolveIntent. Every
    // entry path into this orchestrator (regular slash, drill-down
    // from the report footer, parent-list re-run, programmatic
    // dispatch from a workbench RPC) now goes through resolveIntent
    // with `{ slashForced: 'code-analysis' }`, which stamps the
    // tag exactly once. The belt-and-suspenders write that used to
    // live here would re-stamp the tag and silently overwrite any
    // attached-action resolution that landed in the same turn.

    if (this._rerunFromListId !== undefined) {
      return [{
        index: 0,
        description: `Code Analyzer: re-running from prior list ${this._rerunFromListId.slice(0, 8)}...`,
        kind: 'transform',
        intent: 'code-analysis',
        passThrough: true,
        userMessage: RERUN_BOOTSTRAP_MARKER,
        outputFormat: 'text',
        stateKey: K_PLAN_RESULT,
        persisted: true,
      }];
    }

    // Phase F of plans/intent-funnel-followups.md: the bootstrap
    // skills-routing pipeline (classify-question -> select-scope ->
    // execute) is gone. The orchestrator emits a one-shot
    // pass-through to land in `next()`, which calls queueSynthesise
    // directly. The planner reads the repo summary (E.1b) and
    // emits N section actions; the tool-loop section writer
    // (write-section.ts) gathers evidence per section via
    // `skill_invoke`; the TodoList is created from the planner's
    // sections (no longer from bootstrap skill executions).
    return [{
      index: 0,
      description: 'Code Analyzer: planning sections...',
      kind: 'transform',
      intent: 'code-analysis',
      passThrough: true,
      userMessage: SYNTHESIS_BOOTSTRAP_MARKER,
      outputFormat: 'text',
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
    state.set(K_PHASE, 'synthesising' as Phase);
    state.set(K_ACCEPTED, [] as Array<{ task: AnalysisTask; result: AnalyzerResult }>);
    state.set(K_HISTORY, [] as AnalyzerResult[]);

    this.seedAccessFromState(initialState);
  }

  /**
   * Seed Session.access with the analyzer's pre-approved fs scopes
   * (Phase 4 of plans/access-gate.md).
   */
  private seedAccessFromState(ca: CodeAnalysisState): void {
    if (this.deps === undefined) return;
    const access = this.deps.session.access;
    if (ca.repoSummary.rootPath.length > 0) {
      access.approvePrefix('fs-path', ca.repoSummary.rootPath);
    }
    for (const dir of ca.approvedDirs) {
      access.approvePrefix('fs-path', dir);
    }
  }

  // -- main state machine ---------------------------------------------------

  async next(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Promise<Task[] | null> {
    this.ensureStateInitialized(state);
    const phase = state.get<Phase>(K_PHASE) ?? 'synthesising';
    log.info({ phase, completed: completed.description, gateAction: gateReply?.action }, 'next()');

    if (completed.output.trim() === RESUME_BOOTSTRAP_MARKER) {
      return this.afterResumeBootstrap(state, phase);
    }

    if (completed.output.trim() === SYNTHESIS_BOOTSTRAP_MARKER) {
      // Phase F: go straight to synthesise. No skills-routing
      // pipeline upstream. The planner reads the repo summary
      // (E.1b) and emits sections; the tool-loop writer (Phase F.2)
      // gathers per-section evidence via skill_invoke.
      return this.queueSynthesise(state);
    }

    if (completed.output.trim() === RERUN_BOOTSTRAP_MARKER) {
      return this.afterRerunBootstrap(state);
    }

    switch (phase) {
      case 'synthesising':
        return this.afterSynthesise(completed, state);

      case 'done':
        return null;
    }
  }

  finalize(state: TaskStateStore): FinalizeResult {
    const synthResult = state.get<string>(K_SYNTH_RESULT) ?? '';
    if (synthResult.length === 0) {
      const accepted = state.get<Array<{ task: AnalysisTask; result: AnalyzerResult }>>(K_ACCEPTED) ?? [];
      const fallback = accepted.length === 0
        ? '_Code analysis aborted before any task completed._'
        : `_Code analysis aborted partway through (${accepted.length} task(s) completed). See the todos pane for details._`;
      // Aborted run -- short fallback string IS the chat-panel
      // render too (nothing was streamed to the Report Pane).
      return { output: fallback, format: 'markdown' };
    }
    // Phase B.2 of plans/intent-funnel-followups.md: persist the
    // FULL synthesised markdown as `output` so the chat-handler's
    // persistTurn writes it to LMDB and the Phase-2 segment
    // indexer can chunk it. Use `chatRender: ''` to suppress the
    // chat-panel re-render -- the report lives in the Code
    // Analysis Report Pane (workbench) and in `list.body`
    // (durable); the afterSynthesise step already emitted the
    // "report ready" one-liner to the transcript, so re-emitting
    // here would double-print.
    //
    // Plan §2.1 hard requirement 1 (chat panel MUST NOT render the
    // synthesised markdown) stays intact: `chatRender: ''` blocks
    // the delta. `output` is for downstream persistence ONLY.
    return {
      output:     synthResult,
      chatRender: '',
      format:     'markdown',
    };
  }

  // -------------------------------------------------------------------------
  // Checkpoint resume (project_code_analyzer_checkpoint_recovery.md)
  // -------------------------------------------------------------------------

  /**
   * Restore controller instance fields from a persisted state store
   * before `next()` resumes the pipeline.
   */
  restoreState(state: TaskStateStore): void {
    const ca = state.get<CodeAnalysisState>(K_STATE);
    if (ca === undefined) {
      log.warn('restoreState: K_STATE missing; resume will run with default tier and no parent edge');
      return;
    }
    this._request     = ca.request;
    this._repoSummary = ca.repoSummary;
    this._tier        = ca.tier;
    this.seedAccessFromState(ca);
  }

  /**
   * Build the first task to run when resuming from a checkpoint.
   * Returned as a single pass-through transform carrying the
   * `RESUME_BOOTSTRAP_MARKER`; `next()`'s phase handler recognises
   * the marker and dispatches based on the persisted `K_PHASE`:
   *
   *   - synthesising  -> re-fire synthesise (single-pass) or re-run
   *                      multipass.
   *   - done          -> error out; nothing to resume.
   */
  buildResumeTask(state: TaskStateStore): Task {
    const phase = state.get<Phase>(K_PHASE) ?? 'synthesising';
    log.info({ phase }, 'resume: building bootstrap task');
    return {
      index: 0,
      description: `Code Analyzer: resuming from checkpoint (phase ${phase})...`,
      kind: 'transform',
      intent: 'code-analysis',
      passThrough: true,
      userMessage: RESUME_BOOTSTRAP_MARKER,
      outputFormat: 'text',
      stateKey: K_PLAN_RESULT,
      persisted: true,
    };
  }

  // -------------------------------------------------------------------------
  // Phase handlers
  // -------------------------------------------------------------------------

  /**
   * Re-run bootstrap. Loads the prior list, reconstructs
   * `AnalysisTask[]` from its items, maps each through
   * `analysisTaskToSkillPlan` and runs the resulting skill steps
   * inline. Tasks where the shim returns null (`free-form`) are
   * skipped with a logged warning. Persists a fresh TodoList
   * (parent-edged to the prior list) and queues synthesise.
   */
  private async afterRerunBootstrap(state: TaskStateStore): Promise<Task[] | null> {
    if (this.deps === undefined || this.deps.todos === undefined || this._rerunFromListId === undefined) {
      log.error('afterRerunBootstrap: deps.todos or rerunFromListId missing');
      state.set(K_PHASE, 'done' as Phase);
      state.set(K_SYNTH_RESULT, '_Re-run bootstrap failed: internal state missing._');
      state.markSessionComplete();
      return null;
    }
    if (this._repoSummary === undefined) {
      log.error('afterRerunBootstrap: repoSummary missing');
      state.set(K_PHASE, 'done' as Phase);
      state.set(K_SYNTH_RESULT, '_Re-run bootstrap failed: repo summary missing._');
      state.markSessionComplete();
      return null;
    }
    const priorListId = this._rerunFromListId;
    const priorList = await this.deps.todos.getList(priorListId);
    const reconstructed: AnalysisTask[] = [];
    if (priorList !== null) {
      const priorItems = priorList.items ?? [];
      for (const item of priorItems) {
        const task = reconstructTaskFromItem(item);
        if (task !== null) reconstructed.push(task);
      }
      log.info(
        { priorListId, priorItemCount: priorItems.length, reconstructed: reconstructed.length },
        'afterRerunBootstrap: reconstructed task list',
      );
    } else {
      log.warn({ priorListId }, 'afterRerunBootstrap: prior list not found; using fallback task');
    }
    if (reconstructed.length === 0) {
      const fallback = buildFallbackTaskFromRequest(state.get<CodeAnalysisState>(K_STATE)?.request ?? '');
      reconstructed.push(...fallback);
    }
    if (this._parentListId === undefined) {
      this._parentListId = priorListId;
    }

    const repoPath = this._repoSummary.rootPath;
    const accepted: Array<{ task: AnalysisTask; result: AnalyzerResult }> = [];
    const itemPrefix = `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const runnerDeps = this.buildSkillRunnerDeps();

    for (let i = 0; i < reconstructed.length; i++) {
      const task = reconstructed[i]!;
      const itemId = `${itemPrefix}-rerun-${i}`;
      const plan = analysisTaskToSkillPlan(task, { repoPath });
      if (plan === null) {
        log.warn(
          { kind: task.kind, question: task.question.slice(0, 80) },
          'afterRerunBootstrap: legacy shim returned null; skipping task',
        );
        continue;
      }

      const executions: PerSkillExecution[] = [];
      for (const step of plan.steps) {
        try {
          const result = await runSkill<Record<string, unknown>, unknown>(
            step.skillId,
            step.args,
            runnerDeps,
          );
          executions.push(executionFromSkillResult(step.skillId, step.args, result, false));
        } catch (err) {
          executions.push({
            skillId:       step.skillId,
            args:          step.args,
            resolvedScope: { repoPath },
            value:         null,
            confidence:    'low',
            notes:         [`skill execution threw: ${(err as Error).message}`],
            toolCalls:     [],
            errored:       true,
          });
        }
      }
      const merged = mergeExecutionsToAnalyzerResult({ ...task, itemId }, executions);
      accepted.push(merged);
    }

    const ca = state.get<CodeAnalysisState>(K_STATE);
    state.set(K_PLAN_TASKS, accepted.map(a => a.task));
    state.set(K_ACCEPTED, accepted);
    state.set(K_HISTORY, accepted.map(a => a.result));

    if (this.deps.todos !== undefined && ca !== undefined) {
      const list = await this.deps.todos.createList({
        sessionId: this.deps.session.id,
        title: `Code Analysis: ${truncateTitle(ca.request)}`,
        description: ca.request,
        ...(this._parentListId !== undefined ? { parentListId: this._parentListId } : {}),
      });
      const stamped: Array<{ task: AnalysisTask; result: AnalyzerResult }> = [];
      for (const { task, result } of accepted) {
        const item = await this.deps.todos.addItem(list.id, {
          title: shortTitleFor(task),
          description: task.question,
          meta: {
            kind: task.kind,
            ...(task.scope !== undefined ? { scope: task.scope } : {}),
            origin: task.origin,
            retryCount: task.retryCount,
          },
        });
        try {
          await this.deps.todos.updateItemMeta(item.id, {
            kind: task.kind,
            ...(task.scope !== undefined ? { scope: task.scope } : {}),
            origin: task.origin,
            retryCount: 0,
            answer:     result.answer,
            findings:   result.findings,
            citations:  result.citations,
            confidence: result.confidence,
            toolCalls:  result.toolCalls,
          });
          // Item state machine requires pending -> in_progress -> completed.
          // markComplete() called on a pending item throws "illegal
          // item-status transition 'pending' -> 'completed'".
          await this.deps.todos.markInProgress(item.id);
          await this.deps.todos.markComplete(item.id);
        } catch (err) {
          log.warn(
            { err: (err as Error).message, itemId: item.id },
            'afterRerunBootstrap: failed to stamp item meta',
          );
        }
        stamped.push({
          task:   { ...task, itemId: item.id },
          result: { ...result, itemId: item.id },
        });
      }
      state.set(K_PLAN_TASKS, stamped.map(a => a.task));
      state.set(K_ACCEPTED, stamped);
      state.set(K_HISTORY, stamped.map(a => a.result));
      state.set(K_STATE, { ...ca, listId: list.id });
      state.set(K_LIST_ID, list.id);
    }

    return this.queueSynthesise(state);
  }

  /**
   * Dispatch the resume-bootstrap transform's completion based on
   * the persisted `phase`. With the legacy plan / analyse / review
   * paths gone, only `synthesising` and `done` remain.
   */
  private async afterResumeBootstrap(state: TaskStateStore, phase: Phase): Promise<Task[] | null> {
    log.info({ phase }, 'resume: dispatching from bootstrap');
    if (phase === 'done') {
      log.warn('resume: phase is done; nothing to resume');
      state.set(K_PHASE, 'done' as Phase);
      state.markSessionComplete();
      return null;
    }
    return this.queueSynthesise(state);
  }

  // -- (removed) skills-routing bootstrap ---------------------------------
  //
  // The legacy `afterSkillsRoutingBootstrap` ran a
  // classify-question / select-scope / execute / calibrate
  // pipeline ONCE before the planner, ostensibly to populate the
  // workbench TodoList with one item per skill execution. Phase F
  // (2026-05-11) removed it -- the planner now reads the repo
  // summary directly (E.1b) and the tool-loop section writer
  // (Phase F.2) gathers per-section evidence via `skill_invoke`.
  // TodoList items are created from the planner's section actions
  // inside `runPlanExpandReviewSynthesise`.


  /**
   * Build a `SkillRunnerDeps` for inline skill execution. Mirrors the
   * cross-agent shim's helper so both call sites use the same
   * provider-affinity contract and tool-exec context plumbing.
   */
  private buildSkillRunnerDeps(): SkillRunnerDeps {
    if (this.deps === undefined) {
      throw new Error('buildSkillRunnerDeps: deps not attached');
    }
    const session = this.deps.session;
    const resolveProvider = (affinity: ProviderAffinity): LLMProvider => {
      switch (affinity) {
        case 'local': return session.ollamaProvider;
        case 'cloud': return session.claudeProvider ?? session.ollamaProvider;
        case 'auto':  return session.resolver.resolve('skill', 'default');
      }
    };
    const toolExecCtx = {
      ...(this.deps.send !== undefined ? { send: this.deps.send } : {}),
      ...(this.deps.channel !== undefined ? { channel: this.deps.channel } : {}),
      ...(this.deps.requestId !== undefined ? { requestId: this.deps.requestId } : {}),
    };
    return {
      session,
      resolveProvider,
      toolExecCtx,
      // conversation-flow-refinement.md Phase 2: every successful
      // skill body returns through this callback into the
      // spill-writer (disk JSON + artifact_vec Lance row). Errors in
      // the writer are swallowed; the runner never blocks on spill.
      onSkillEnd: makeSpillHandler(session),
      ...(this.deps.abortController?.signal !== undefined ? { signal: this.deps.abortController.signal } : {}),
    };
  }

  /**
   * Plan -> per-action [expand+review] -> stitch synthesis flow per
   * plans/analyzers/cloud-plan-local-expand-cloud-review.md (Phase 4).
   *
   * Replaces the legacy tier-based fork (S/M -> local single-pass /
   * L+ -> cloud multipass). Every prompt now goes through:
   *   1. plan(cloud)   -> N action-cards
   *   2. per action: expand(local) -> review(cloud) [-> expand(local) -> review(cloud)]
   *   3. stitch        -> no overall review
   *
   * Tier still drives the action-budget cap (S=2 ... XXXXL=32).
   * Re-run / resume paths reuse this entry too -- they pass the
   * raw executions they reconstructed from the prior list.
   */
  private async queueSynthesise(state: TaskStateStore): Promise<Task[] | null> {
    state.set(K_PHASE, 'synthesising' as Phase);
    const ca = state.get<CodeAnalysisState>(K_STATE);
    const tier = this._tier;

    if (this.deps === undefined) {
      log.error('queueSynthesise: deps missing -- cannot run plan stage');
      // No legacy fallbacks remain (Phase F). Emit a placeholder and
      // mark the run complete so the framework doesn't hang.
      state.set(K_SYNTH_RESULT, '_Code analysis aborted: orchestrator deps missing._');
      await this.finalizeSynthesisedReport(state);
      return null;
    }

    try {
      const markdown = await this.runPlanExpandReviewSynthesise(ca, tier, state);
      state.set(K_SYNTH_RESULT, markdown);
      await this.finalizeSynthesisedReport(state);
      return null;
    } catch (err) {
      log.warn(
        { tier, err: (err as Error).message },
        'plan/expand/review synthesis failed; emitting fallback report',
      );
      state.set(
        K_SYNTH_RESULT,
        `_Code analysis aborted: ${(err as Error).message}._`,
      );
      await this.finalizeSynthesisedReport(state);
      return null;
    }
  }

  /**
   * Phase F synthesis driver. Cloud plans the sections (planActions);
   * local drafts each one inside a `skill_invoke` tool loop
   * (writeSectionWithTools); cloud reviews the draft (reviewAction);
   * we stitch with no overall review. TodoList items track sections
   * 1:1 -- pending while waiting, in-progress while drafting,
   * complete on review accept.
   *
   * No legacy fallbacks: if planActions returns empty actions we
   * fall through to `synthesiseFallbackAction` (one generic
   * section); any other error bubbles up to `queueSynthesise` which
   * emits an aborted-run placeholder.
   */
  private async runPlanExpandReviewSynthesise(
    ca: CodeAnalysisState | undefined,
    tier: ScopeSize,
    state: TaskStateStore,
  ): Promise<string> {
    if (this.deps === undefined) {
      throw new Error('runPlanExpandReviewSynthesise: deps not attached');
    }
    // accepted is empty under Phase F (no bootstrap pipeline) but the
    // fallback helper accepts it for type-compat with the legacy
    // shape.
    const accepted: readonly { task: AnalysisTask; result: AnalyzerResult }[] = [];
    const session = this.deps.session;
    const cloud = session.resolver.resolve('code-analyzer', 'plan');
    const local = session.ollamaProvider;
    const reviewer = session.resolver.resolve('code-analyzer', 'review');
    const request = ca?.request ?? '';

    // Lean summary context: repo descriptor + memory line.
    const summaryContext = this.buildSummaryContext(tier);

    const synthBubble = 'synthesise';
    this.emitLiveStep(synthBubble, '');

    // ----- Stage 1: plan (cloud, lean input) ----------------------------
    this.emitMilestone(synthBubble, 'planning report sections...');

    const plan = await planActions(
      {
        intent:         'code-analysis',
        request,
        summaryContext,
        tier,
        analyzerLabel: 'code-analyzer',
      },
      cloud,
    );

    const actions: readonly PlannedAction[] = plan.degraded || plan.actions.length === 0
      ? [synthesiseFallbackAction(ca, accepted)]
      : plan.actions;

    this.emitMilestone(
      synthBubble,
      `planned ${actions.length} section${actions.length === 1 ? '' : 's'}${plan.degraded ? ' (fallback)' : ''}`,
    );

    // Phase F: create the workbench TodoList from the PLANNER's
    // sections (one item per planned action). Previously the
    // bootstrap routing pipeline created items per skill execution
    // -- that pipeline is gone, so TodoList sourcing moved here.
    // Items start pending, transition to in-progress as each
    // section's tool loop fires, and complete when its draft
    // returns from the reviewer.
    const todoItemIds: (string | undefined)[] = new Array(actions.length).fill(undefined);
    if (this.deps.todos !== undefined && ca !== undefined) {
      try {
        const list = await this.deps.todos.createList({
          sessionId: this.deps.session.id,
          title:     `Code Analysis: ${truncateTitle(ca.request)}`,
          description: ca.request,
          ...(this._parentListId !== undefined ? { parentListId: this._parentListId } : {}),
        });
        for (let i = 0; i < actions.length; i++) {
          const a = actions[i]!;
          const item = await this.deps.todos.addItem(list.id, {
            title:       a.title,
            description: a.objective,
            meta:        { kind: 'plan-action', origin: 'planner', retryCount: 0 },
          });
          todoItemIds[i] = item.id;
        }
        // Surface listId via state so finalizeSynthesisedReport can
        // stamp the rendered report onto the TodoList body when
        // synthesis completes.
        state.set(K_LIST_ID, list.id);
        if (ca !== undefined) state.set(K_STATE, { ...ca, listId: list.id });
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'TodoList creation failed (sections will still ship)');
      }
    }

    // ----- Stage 2+3: per-action tool-loop draft + cloud review ---------
    //
    // Phase F of plans/intent-funnel-followups.md. The LOCAL LLM
    // drives a tool-calling loop with `skill_invoke` per section --
    // it picks skills + args itself, iterating until it has enough
    // evidence to satisfy the review criteria. The cloud reviewer
    // then judges + may polish the draft.
    //
    // The previous "classify-question -> select-scope -> pre-fetch
    // evidence -> expand-action" cloud-orchestrated pipeline was
    // removed (2026-05-11) along with the env-var gate that fenced
    // it off. The failure mode the live test surfaced: select-scope
    // ignored the section title's module path and defaulted to
    // `<repo>/src` against repos that don't follow that layout,
    // producing "no-files-in-module" evidence for indexed modules
    // and forcing the writer to hedge ("appears to lack indexed
    // files"). The tool loop avoids that by giving the writer the
    // section title + tool catalog directly.
    const { writeSectionWithTools, patchSectionWithTools } = await import('../../agent/tasks/code-analyzer/write-section.js');
    const { reviewAction } = await import('../../agent/content-gen/review-action.js');
    const { pickBestRound, buildSectionFooter } = await import('../../agent/tasks/code-analyzer/pick-best-draft.js');
    type RoundCandidate = import('../../agent/tasks/code-analyzer/pick-best-draft.js').RoundCandidate;
    log.info({ sections: actions.length }, 'per-action tool-loop writer starting');

    const sections: { id: string; title: string; markdown: string }[] = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      const itemId = todoItemIds[i];

      // Transition the TodoList item to in-progress so the
      // workbench shows a spinner / live indicator for the section
      // we're currently working on.
      if (itemId !== undefined && this.deps.todos !== undefined) {
        try { await this.deps.todos.markInProgress(itemId); }
        catch (err) { log.debug({ err: (err as Error).message, itemId }, 'todos.markInProgress failed (best-effort)'); }
      }

      this.emitMilestone(synthBubble, `[${i + 1}/${actions.length}] drafting "${action.title}" via tool loop...`);

      // repoContext drives the skill-catalog filter (ORM / migration
      // family gates). RepoSummary doesn't currently surface ORM
      // detection -- pass an empty repoContext so those families
      // get filtered out by default. Future: thread ORM detection
      // through the indexer + RepoSummary so the section writer can
      // see code.orm.* and code.migration.* when applicable.
      // Two-round contract: draft -> review -> [if refine, redraft with hint -> review].
      // Mirrors the legacy `expandThenReview` shape from
      // agent/content-gen/review-action.ts so reviewer hints actually
      // drive a retry instead of being silently dropped.
      // Phase F.5 of plans/code-analyzer-structured-review.md: replace
      // the 2-round write+redraft loop with a 3-round write+patch loop.
      // Round 1: writeSectionWithTools (initial investigation).
      // Round 2/3: patchSectionWithTools (iterate over reviewer's
      //            workItems and patch the prior draft).
      // F.4 escape hatch: if the patch loop emits zero patch/skip
      //            blocks (protocol non-compliance), fall back to a
      //            redraft via writeSectionWithTools with the work-item
      //            list collapsed into a hint string.
      // The ship policy below (Phase G next) currently ships the last
      // round's draft; Phase G adds the best-of-rounds picker + footer.
      type DraftLike = Awaited<ReturnType<typeof writeSectionWithTools>>;
      let draft: DraftLike = await writeSectionWithTools({
        provider:    local,
        session,
        action,
        request,
        repoContext: {},
        ...(this._repoSizeSummary !== undefined ? { repoSizeSummary: this._repoSizeSummary } : {}),
        onProgress: (msg) => {
          this.emitLiveStep(synthBubble, this.formatProgress(msg) + '\n');
        },
      });

      const reviewDraft = async (
        d:               DraftLike,
        cumulativeCalls: readonly TaggedSkillCall[],
        currentRound:    1 | 2 | 3,
        priorReviews:    readonly { round: 1 | 2; verdict: 'accept' | 'needs-work'; workItems: readonly import('../../agent/content-gen/review-action.js').ReviewWorkItem[] }[] = [],
      ) => {
        // Fix 11.8: partition the captured calls into successful
        // evidence (used for scoring) and failed calls (CONTEXT
        // only -- so the reviewer doesn't refine just because the
        // writer's first invocation got rejected on schema).
        //
        // Phase M.2: prune older rounds' evidence for round-2/3
        // reviews. Round-1 calls remain verbatim only for the round-1
        // review; rounds 2 and 3 see round-1 calls compressed to
        // one-line summaries (skillId + arg keys), with the most
        // recent round's calls verbatim.
        const reviewerEvidence: PlanExecution[] = [];
        const failedCalls: import('../../agent/content-gen/review-action.js').FailedToolCall[] = [];
        for (const c of cumulativeCalls) {
          if (c.errored) {
            failedCalls.push({
              skillId:           c.skillId,
              args:              c.args,
              output:            c.resultText,
              ...(c.rejectionReason !== undefined ? { rejectionReason: c.rejectionReason } : {}),
            });
            continue;
          }
          const compressForReview = currentRound > 1 && c.round < currentRound;
          if (compressForReview) {
            // Older round in a 2nd/3rd review -- replace the full
            // resultText with a brief summary so the reviewer still
            // sees what was investigated without paying the full
            // token cost.
            const argKeys = Object.keys(c.args).slice(0, 4).join(', ');
            const resultLen = c.resultText.length;
            reviewerEvidence.push({
              skillId:    c.skillId,
              value:      {
                args:           c.args,
                output:         `_(round ${c.round} evidence summarised: ${resultLen} chars, args: { ${argKeys} })_`,
                evidenceRound:  c.round,
                summarised:     true,
              } as unknown,
              confidence: 'high',
              notes:      [],
            });
          } else {
            reviewerEvidence.push({
              skillId:    c.skillId,
              value:      { args: c.args, output: c.resultText } as unknown,
              confidence: 'high',
              notes:      [],
            });
          }
        }
        return reviewAction(
          {
            action,
            draft: {
              actionId:      action.id,
              markdown:      d.markdown,
              tokenEstimate: Math.ceil(d.markdown.length / 4),
              truncated:     false,
              degraded:      false,
            },
            evidence:      reviewerEvidence,
            ...(failedCalls.length > 0 ? { failedCalls } : {}),
            ...(priorReviews.length > 0 ? { priorReviews } : {}),
            analyzerLabel: 'code-analyzer',
          },
          reviewer,
        );
      };

      let cumulativeCalls: TaggedSkillCall[] = draft.skillCalls.map(c => ({ ...c, round: 1 as const }));
      let review = await reviewDraft(draft, cumulativeCalls, 1);

      // Track each round's candidate -- the picker (Phase G) reads
      // these and chooses best-of-rounds when no round verdicts accept.
      const candidates: RoundCandidate[] = [
        { round: 1, markdown: draft.markdown, review },
      ];

      // Phase I instrumentation: per-round patch-protocol + escape-hatch
      // signals. Indexed by round number (2 or 3); absent for round 1.
      const patchSignals: { round: 2 | 3; protocolFollowed: boolean; redraftFallback: boolean; itemsAddressed: number }[] = [];

      for (let r: 2 | 3 = 2; r <= 3 && review.verdict === 'needs-work'; r = (r + 1) as 2 | 3) {
        const priorWorkItems = review.workItems;   // captured BEFORE the patch
        const hintFromItems  = priorWorkItems.map(w => w.action).join('; ');

        log.info(
          { actionId: action.id, round: r, workItems: priorWorkItems.length },
          `reviewer requested needs-work; running round ${r}`,
        );
        this.emitMilestone(
          synthBubble,
          `[${i + 1}/${actions.length}] "${action.title}" -- patch (round ${r}, ${priorWorkItems.length} work item${priorWorkItems.length === 1 ? '' : 's'})`,
        );

        const patched = await patchSectionWithTools({
          provider:             local,
          session,
          action,
          request,
          repoContext:          {},
          draftMarkdown:        draft.markdown,
          workItems:            priorWorkItems,
          priorDescribedSkills: draft.describedSkills,
          priorSkillCalls:      cumulativeCalls,
          round:                r,
          ...(this._repoSizeSummary !== undefined ? { repoSizeSummary: this._repoSizeSummary } : {}),
          onProgress: (msg) => {
            this.emitLiveStep(synthBubble, this.formatProgress(msg) + '\n');
          },
        });

        let nextDraft: DraftLike;
        let patchInfo: { priorWorkItems: typeof priorWorkItems; itemStatuses: typeof patched.itemStatuses } | undefined;
        if (!patched.patchProtocolFollowed) {
          // F.4 escape hatch: model didn't follow the patch protocol.
          // Fall back to a fresh writeSectionWithTools with the
          // work-item list collapsed into a hint string. The redraft
          // doesn't emit per-item statuses, so we omit `patch` from
          // the candidate -- the picker treats it like a round-1-style
          // fresh draft (no fix-items-addressed credit).
          //
          // Phase M.1: pass recoveryContext so the redraft uses the
          // recovery-mode preamble + soft-targets from the prior draft.
          // The 2026-05-16 run #2 showed F.4 redrafts consistently
          // producing much shorter / weaker output than round 1; the
          // recovery mode tells the model to match the prior scope.
          log.warn(
            { actionId: action.id, round: r },
            'patch loop emitted no patch/skip blocks; falling back to redraft',
          );
          // Use draft's signals (round 1 if r=2, round 2 if r=3) as
          // the recovery target. Round-1 signals are the most reliable
          // baseline so we use them for any round's recovery.
          const baseline = candidates[0]!;
          const baselineCitationCount = (baseline.markdown.match(/\[[^\]]+\]\(path:[^)]+\)/g) ?? []).length;
          const baselineParagraphCount = baseline.markdown.trim().split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
          nextDraft = await writeSectionWithTools({
            provider:    local,
            session,
            action,
            request,
            repoContext: {},
            refineHint:           hintFromItems,
            priorDescribedSkills: patched.describedSkills,
            recoveryContext: {
              priorDraftLength:    baseline.markdown.length,
              priorParagraphCount: baselineParagraphCount,
              priorCitationCount:  baselineCitationCount,
            },
            ...(this._repoSizeSummary !== undefined ? { repoSizeSummary: this._repoSizeSummary } : {}),
            onProgress: (msg) => {
              this.emitLiveStep(synthBubble, this.formatProgress(msg) + '\n');
            },
          });
          patchInfo = undefined;
        } else {
          // Strip the patch-specific fields; the orchestrator works
          // against the WriteSectionOutput-shaped subset.
          nextDraft = {
            markdown:        patched.markdown,
            toolCallCount:   patched.toolCallCount,
            hitLimit:        patched.hitLimit,
            skillsCalled:    patched.skillsCalled,
            skillCalls:      patched.skillCalls,
            describedSkills: patched.describedSkills,
          };
          patchInfo = { priorWorkItems, itemStatuses: patched.itemStatuses };
        }

        cumulativeCalls = [
          ...cumulativeCalls,
          ...nextDraft.skillCalls.map(c => ({ ...c, round: r })),
        ];
        draft  = nextDraft;
        // Phase N.2: surface prior rounds' work-item lists to the
        // reviewer so it can judge whether the new draft addressed
        // earlier flags. We only carry round-1 and (for r=3) round-2.
        const priorReviewsForR: { round: 1 | 2; verdict: 'accept' | 'needs-work'; workItems: readonly import('../../agent/content-gen/review-action.js').ReviewWorkItem[] }[] = [
          { round: 1, verdict: candidates[0]!.review.verdict, workItems: candidates[0]!.review.workItems },
        ];
        if (r === 3 && candidates[1] !== undefined) {
          priorReviewsForR.push({ round: 2, verdict: candidates[1]!.review.verdict, workItems: candidates[1]!.review.workItems });
        }
        review = await reviewDraft(draft, cumulativeCalls, r, priorReviewsForR);

        candidates.push(
          patchInfo !== undefined
            ? { round: r, markdown: draft.markdown, review, patch: patchInfo }
            : { round: r, markdown: draft.markdown, review },
        );
        patchSignals.push({
          round:            r,
          protocolFollowed: patched.patchProtocolFollowed,
          redraftFallback:  !patched.patchProtocolFollowed,
          itemsAddressed:   patched.itemStatuses.filter(s => s.status === 'addressed').length,
        });
      }

      // -----------------------------------------------------------------
      // Phase G: ship policy.
      //   1. Short-circuit on the FIRST round that verdicted accept.
      //   2. Otherwise pick the best draft by the lexicographic signal
      //      order (fix-items-addressed, citations, paragraphs, length)
      //      and append a footer listing the winning round's still-
      //      unaddressed reviewer work-items.
      // -----------------------------------------------------------------
      let final: string;
      let shippedRound: 1 | 2 | 3;
      let shipDecisionReason: string;
      let confidenceBasis:
        | 'accept-r1'
        | 'accept-r2-or-r3'
        | 'degraded-accept'
        | 'needs-work-no-fix'
        | 'needs-work-fix-pending';

      // Phase K.1: ONLY a non-degraded accept short-circuits the
      // picker. A degraded soft-accept (reviewer JSON malformed twice
      // -> review-action.ts soft-accepts with workItems=[]) carries
      // `review.degraded === true`; treating it as a real accept
      // ships the round's draft without ever scoring it against the
      // other rounds. Run #2 (2026-05-16) had sections 5 and 7 ship a
      // weaker round-2 redraft over a stronger round-1 draft because
      // of this. The picker now runs on the candidates set whenever
      // there is NO non-degraded accept; degraded candidates can
      // still win on length / citations.
      const acceptIdx = candidates.findIndex(
        c => c.review.verdict === 'accept' && c.review.degraded === false,
      );
      const hasDegradedAccept = candidates.some(
        c => c.review.verdict === 'accept' && c.review.degraded === true,
      );

      if (acceptIdx >= 0) {
        const accepted = candidates[acceptIdx]!;
        final = accepted.review.accepted?.markdown ?? accepted.markdown;
        shippedRound = accepted.round;
        shipDecisionReason = `accept@round${accepted.round}`;
        confidenceBasis = accepted.round === 1 ? 'accept-r1' : 'accept-r2-or-r3';
      } else {
        const pick = pickBestRound(candidates);
        const winner = pick.winner;
        // Footer lists the WINNING round's reviewer work-items so the
        // user sees what's still pending against the shipped draft.
        const footer = buildSectionFooter(winner.review.workItems);
        // Phase K.5: when ANY review on the shipping path was degraded,
        // append a one-line honesty note above the footer so the user
        // knows the reviewer didn't actually approve the draft.
        const degradedNote = hasDegradedAccept || winner.review.degraded
          ? '\n\n_Note: the reviewer\'s structured response was malformed on this section. The draft shipped without a verified accept._'
          : '';
        final = winner.markdown + degradedNote + footer;
        shippedRound = winner.round;
        shipDecisionReason = winner.review.degraded || hasDegradedAccept
          ? `${pick.reason} (degraded review)`
          : pick.reason;
        const fixUnaddressed = winner.review.workItems.filter(w => w.kind === 'fix').length;
        if (winner.review.degraded || hasDegradedAccept) {
          confidenceBasis = 'degraded-accept';
        } else if (fixUnaddressed > 0) {
          confidenceBasis = 'needs-work-fix-pending';
        } else {
          confidenceBasis = 'needs-work-no-fix';
        }
      }

      // Phase K.4 confidence semantics:
      //  - real accept @ round 1                -> high
      //  - real accept @ round 2/3              -> medium
      //  - degraded accept anywhere on the path -> medium (NOT high; reviewer crashed)
      //  - all needs-work, no `fix` pending     -> medium
      //  - all needs-work, `fix` items pending  -> low
      const itemConfidence: 'high' | 'medium' | 'low' =
        confidenceBasis === 'accept-r1' ? 'high' :
        confidenceBasis === 'needs-work-fix-pending' ? 'low' :
        'medium';

      // ---- Phase G.4: TodoList persistence with per-round trace ------
      // failureReason now reflects what the WINNING round did NOT
      // address; the per-round trace is stamped on the item meta for
      // the workbench to render as a checklist.
      const winnerCandidate = acceptIdx >= 0 ? candidates[acceptIdx]! : candidates.find(c => c.round === shippedRound)!;
      const failureReason = acceptIdx < 0 && winnerCandidate.review.workItems.length > 0
        ? winnerCandidate.review.workItems.map(w => `${w.kind}: ${w.action}`).join('\n')
        : undefined;

      // Phase G.4: per-round trace persisted on the TodoList item so
      // the workbench can render the reviewer's punch list + the
      // writer's per-item statuses as a checklist alongside the
      // section body. Fields are typed as Record<string, unknown> by
      // the updateItemMeta API; the workbench will type-narrow these
      // when it consumes them.
      const reviewRoundsTrace = candidates.map(c => ({
        round:        c.round,
        verdict:      c.review.verdict,
        // Phase K.4: surface degraded soft-accept so the workbench can
        // render a "review crashed" icon next to that round.
        degraded:     c.review.degraded,
        workItems:    c.review.workItems.map(w => ({
          id:     w.id,
          kind:   w.kind,
          where:  w.where,
          issue:  w.issue,
          action: w.action,
        })),
        itemStatuses: c.patch?.itemStatuses ?? [],
      }));

      if (itemId !== undefined && this.deps.todos !== undefined) {
        try {
          await this.deps.todos.updateItemMeta(itemId, {
            kind:       'plan-action',
            origin:     'planner',
            retryCount: shippedRound - 1,
            answer:     final,
            findings:   [],
            citations:  [],
            confidence: itemConfidence,
            toolCalls:  cumulativeCalls.map(c => ({
              kind:     'skill',
              skillId:  c.skillId,
              args:     c.args,
              durationMs: 0,
              status:   c.errored ? 'failed' : 'ok',
            })),
            // Phase G.4 per-round trace.
            rounds:             shippedRound,
            shippedDraft:       `round${shippedRound}`,
            shipDecisionReason,
            reviewRounds:       reviewRoundsTrace,
            ...(failureReason !== undefined ? { failureReason } : {}),
          });
          await this.deps.todos.markComplete(itemId);
        } catch (err) {
          log.debug({ err: (err as Error).message, itemId }, 'todos.markComplete failed (best-effort)');
        }
      }

      // Phase I.1: flat per-section instrumentation. Fields here are
      // mined by scripts/analyzer-metrics.ts -- keep names stable.
      const r2signal = patchSignals.find(s => s.round === 2);
      const r3signal = patchSignals.find(s => s.round === 3);
      const fixItemsUnaddressedFinal = winnerCandidate.review.workItems.filter(w => w.kind === 'fix').length;
      const redraftFallbackFired = patchSignals.some(s => s.redraftFallback);
      // Phase K.4: degradedReviews counts the rounds whose review
      // came back via the soft-accept fallback. A high rate means
      // the cloud reviewer is hitting its output budget; combined
      // with patchProtocolFollowed=false it's the leading indicator
      // for the "broke before it tried" failure mode.
      const degradedReviews = candidates.filter(c => c.review.degraded).length;
      log.info(
        {
          actionId:                action.id,
          roundsRun:               candidates.length,
          shippedRound,
          shippedDraft:            `round${shippedRound}`,
          shipDecisionReason,
          confidence:              itemConfidence,
          workItemsR1:             candidates[0]!.review.workItems.length,
          workItemsR2:             candidates[1]?.review.workItems.length ?? 0,
          itemsAddressedR2:        r2signal?.itemsAddressed ?? 0,
          itemsAddressedR3:        r3signal?.itemsAddressed ?? 0,
          patchProtocolFollowedR2: r2signal?.protocolFollowed,
          patchProtocolFollowedR3: r3signal?.protocolFollowed,
          redraftFallbackFired,
          redraftFallbackReason:   redraftFallbackFired ? 'protocol' : undefined,
          fixItemsUnaddressedFinal,
          degradedReviews,
          traces: candidates.map(c => ({
            round:        c.round,
            verdict:      c.review.verdict,
            degraded:     c.review.degraded,
            markdownLen:  c.markdown.length,
            workItems:    c.review.workItems.length,
            itemStatuses: c.patch?.itemStatuses.length ?? 0,
          })),
        },
        'section drafting complete',
      );
      const verdictLabel = `${shipDecisionReason}@round${shippedRound}`;
      this.emitMilestone(
        synthBubble,
        `[${i + 1}/${actions.length}] "${action.title}" -- ${verdictLabel} (${cumulativeCalls.length} cumulative skill call${cumulativeCalls.length === 1 ? '' : 's'})`,
      );
      sections.push({ id: action.id, title: action.title, markdown: final });
    }

    this.emitMilestone(synthBubble, 'stitching final report...');

    // ----- Stage 4: stitch (no further LLM work) ------------------------
    const md = stitchPlanSections(plan.intentBrief, actions, sections, this._parentListId);

    this.emitLiveStep(synthBubble, this.formatProgress(`report ready (${sections.length} section${sections.length === 1 ? '' : 's'})`) + '\n');
    this.emitLiveStep(synthBubble, '', true);

    return md;
  }

  /**
   * Build the lean summary context the cloud planner sees:
   *   line 1: active repo descriptor (path, languages, scope tier)
   *   line 2 (optional): memory of what prior turns covered, mined
   *           from the [priorContext:current] tag the chat-handler
   *           stamps via the conversation-flow-refinement helpers.
   */
  private buildSummaryContext(tier: ScopeSize): string {
    const parts: string[] = [];

    // Phase E.1b: lead with the detailed repo size + shape summary
    // when available. Pre-E.1b the planner saw a single line ("Active
    // repo: <path> -- closure size: 1 -- scope tier: M") which gave
    // it zero signal about subsystems / languages / module sizes,
    // and it emitted generic section titles like "Architecture &
    // Entry Points". With the detailed block the planner can write
    // subsystem-specific titles ("OCR Subsystem", "Legal Extraction
    // Pipeline", "Stirling PDF Integration").
    if (this._repoSizeSummary !== undefined && !this._repoSizeSummary.empty) {
      parts.push('## Repo summary');
      parts.push(formatRepoSizeSummary(this._repoSizeSummary, 'detailed'));
      parts.push('');
      parts.push(`Scope tier: ${tier}.`);
    } else {
      // Fallback to the legacy one-line shape when no E.1b summary
      // was threaded through (cold-path callers, future re-runs).
      const repoLine = this.formatRepoSummaryLine();
      parts.push(`Active repo: ${repoLine.length > 0 ? repoLine : '(none)'} -- scope tier: ${tier}.`);
    }

    if (this.deps !== undefined) {
      try {
        const session = this.deps.session;
        const raw = session.contextManager.getTag(PRIOR_CONTEXT_TAG_CURRENT);
        if (raw.length > 0) {
          const parsed = JSON.parse(raw) as {
            currentIntent?: string;
            intentChanged?: boolean;
            previousIntent?: string;
            facts?: import('../../agent/intent/retriever.js').PriorFacts;
            artifactCount?: number;
          };
          const memory = summarizePriorContext({
            currentIntent: parsed.currentIntent ?? 'code-analysis',
            intentChanged: parsed.intentChanged ?? false,
            ...(parsed.previousIntent !== undefined ? { previousIntent: parsed.previousIntent } : {}),
            artifacts:     [],
            facts:         parsed.facts ?? {},
          });
          if (memory.length > 0) {
            parts.push('');
            parts.push('## Prior conversation context');
            parts.push(memory);
          }
        }
      } catch (err) {
        log.debug({ err: (err as Error).message }, 'buildSummaryContext: priorContext read failed (continuing)');
      }
    }

    return parts.join('\n');
  }

  /**
   * Shared post-processing: list.body update + chat delta + done
   * state. Used by both the multi-pass branch (calls directly after
   * `runMultipassSynthesise`) and the single-pass branch (called from
   * `afterSynthesise`).
   */
  private async finalizeSynthesisedReport(state: TaskStateStore): Promise<void> {
    const report = (state.get<string>(K_SYNTH_RESULT) ?? '').trim();
    state.set(K_SYNTH_RESULT, report);
    const listId = state.get<string>(K_LIST_ID);
    if (listId && this.deps?.todos !== undefined) {
      try {
        await this.deps.todos.updateListBody(listId, report);
      } catch (err) {
        log.warn({ err, listId }, 'updateListBody failed (continuing)');
      }
    }
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
  }

  private async afterSynthesise(completed: TaskResult, state: TaskStateStore): Promise<Task[] | null> {
    state.set(K_SYNTH_RESULT, completed.output);
    await this.finalizeSynthesisedReport(state);
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
      repoSnapshotId: readGitHeadSnapshotId(rootPath),
    };
  }

  /**
   * Format a progress message with the run's tier + drill-down
   * breadcrumb. Used by the multipass live-console bubble.
   */
  private formatProgress(message: string): string {
    const parts: string[] = ['code-analyzer', `tier=${this._tier}`, 'synthesis'];
    if (this._parentListId !== undefined) {
      parts.push('drill-down');
    }
    return `[${parts.join(' | ')}] ${message}`;
  }

  /**
   * Emit a brainstorm-style `liveStep` event so the chat panel
   * renders progress / token chunks inside a boxed monospace
   * "live console" bubble.
   */
  private emitLiveStep(step: string, text: string, done = false): void {
    if (this.deps === undefined) {
      log.warn({ step, text: text.slice(0, 60), done }, 'emitLiveStep: deps undefined -- chat panel will not see this');
      return;
    }
    if (this.deps.send === undefined) {
      log.warn({ step, text: text.slice(0, 60), done }, 'emitLiveStep: deps.send undefined -- chat panel will not see this');
      return;
    }
    log.info({
      step,
      textLen: text.length,
      done,
      requestId: this.deps.requestId,
    }, 'emitLiveStep: dispatching to chat panel');
    try {
      this.deps.send({
        id: this.deps.requestId,
        stream: 'liveStep',
        data: {
          agent: 'code-analyzer',
          step,
          text,
          ...(done ? { done: true } : {}),
        },
      });
    } catch (err) {
      log.warn({ step, err: (err as Error).message }, 'emitLiveStep: send threw');
    }
  }

  /**
   * Emit a top-bar `progress` event in addition to the liveStep
   * bubble. Belt-and-suspenders: liveStep bubbles are persistent
   * but only visible if the chat-panel rendering picks them up;
   * progress events update the always-on top progress bar so the
   * user sees at least the latest milestone regardless of the
   * bubble path. (The bar overwrites itself per event, by design.)
   */
  private emitChatProgress(message: string): void {
    if (this.deps === undefined) {
      log.warn({ message }, 'emitChatProgress: deps undefined');
      return;
    }
    log.info({ message, requestId: this.deps.requestId }, 'emitChatProgress: dispatching');
    try {
      this.deps.send({
        id: this.deps.requestId,
        stream: 'progress',
        data: { message: `Code Analyzer: ${message}` },
      });
    } catch (err) {
      log.warn({ message, err: (err as Error).message }, 'emitChatProgress: send threw');
    }
  }

  /**
   * Emit BOTH a top-bar progress event and a liveStep bubble line
   * for the same milestone. Use this for major milestones the user
   * really should see; use emitLiveStep alone for sub-events that
   * only need to show up in the bubble's running narrative.
   */
  private emitMilestone(step: string, message: string): void {
    this.emitChatProgress(message);
    this.emitLiveStep(step, this.formatProgress(message) + '\n');
  }

  /**
   * Build a one-line repo descriptor for the planActions helper.
   * The planner echoes this verbatim as `## Repository` context.
   */
  private formatRepoSummaryLine(): string {
    if (this._repoSummary === undefined) return '';
    const r = this._repoSummary;
    const parts = [r.rootPath];
    if (r.primaryLanguages.length > 0) parts.push(`languages: ${r.primaryLanguages.join(', ')}`);
    if (r.topLevelPackages.length > 0) parts.push(`top-level packages: ${r.topLevelPackages.slice(0, 6).join(', ')}`);
    parts.push(`closure size: ${r.closureSize}`);
    return parts.join(' -- ');
  }
}

// ---------------------------------------------------------------------------
// Prior-context tag reader
// ---------------------------------------------------------------------------

/**
 * Read the `[priorContext:current]` tag the chat-handler stamps and
 * extract just the typed `facts` half. Returns `undefined` for a
 * missing / empty / unparseable tag, or when no fact bucket is
 * populated (so the pipeline doesn't waste a `priorFacts: {}` payload
 * on the wire).
 */
function readPriorFactsTag(
  session: TaskOrchestratorDeps['session'],
): PriorFactsForSkills | undefined {
  const ctx = session.contextManager;
  const raw = ctx.getTag(PRIOR_CONTEXT_TAG_CURRENT);
  if (raw.length === 0) return undefined;

  let parsed: { facts?: PriorFactsForSkills };
  try {
    parsed = JSON.parse(raw) as { facts?: PriorFactsForSkills };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) },
      'priorContext tag JSON parse failed -- ignoring');
    return undefined;
  }

  const facts = parsed.facts;
  if (facts === undefined) return undefined;

  const total =
    (facts.modules?.length   ?? 0) +
    (facts.entities?.length  ?? 0) +
    (facts.tables?.length    ?? 0) +
    (facts.ormModels?.length ?? 0);
  if (total === 0) return undefined;

  log.info(
    {
      modules:   facts.modules?.length   ?? 0,
      entities:  facts.entities?.length  ?? 0,
      tables:    facts.tables?.length    ?? 0,
      ormModels: facts.ormModels?.length ?? 0,
    },
    'orchestrator: priorFacts loaded from tag',
  );
  return facts;
}

export const _readPriorFactsTagForTest = readPriorFactsTag;


// ---------------------------------------------------------------------------
// Plan / expand / review synthesis helpers (Phase 4 of
// plans/analyzers/cloud-plan-local-expand-cloud-review.md)
// ---------------------------------------------------------------------------

/**
 * Synthesise a single fallback action when the planner returns a
 * degraded / empty plan. The fallback drives the per-step skills
 * pipeline against the user's request directly so the report still
 * produces something useful.
 */
function synthesiseFallbackAction(
  ca: CodeAnalysisState | undefined,
  accepted: readonly { task: AnalysisTask; result: AnalyzerResult }[],
): PlannedAction {
  const requestSnippet = (ca?.request ?? 'analysis request').slice(0, 80);
  return {
    id:        'fallback-summary',
    title:     `Summary: ${requestSnippet}`,
    objective: `Address the user request "${ca?.request ?? '(unknown)'}" by running whatever code-analysis skills best fit it and summarising the findings.`,
    maxBudgetTokens: 2000,
    reviewCriteria: [
      'Addresses the user request directly',
      'Cites the skills the local model invoked',
      `Notes that the planner did not propose a structured plan (${accepted.length} prior task${accepted.length === 1 ? '' : 's'} accepted)`,
    ],
  };
}


/**
 * Stitch the planner's intent brief + per-action sections into the
 * final markdown. No further LLM work happens here -- per the spec
 * the cloud reviewer's per-action verdict is the final quality
 * gate, NOT a global review pass.
 *
 * The drill-down footer (Report Pane parser depends on it) is
 * appended verbatim. It is not a planned action.
 */
function stitchPlanSections(
  intentBrief: string,
  actions: readonly PlannedAction[],
  sections: readonly { id: string; title: string; markdown: string }[],
  parentListId: string | undefined,
): string {
  const lines: string[] = [];
  if (intentBrief.trim().length > 0) {
    lines.push(intentBrief.trim());
    lines.push('');
  }

  // Maintain the planner's order even if expandThenReview returned
  // sections in a different sequence (it doesn't today, but defend).
  // Empty sections (writer produced no usable content) get a degraded
  // placeholder so the stitched report's section count matches what
  // the milestones promised the user.
  const byId = new Map(sections.map(s => [s.id, s]));
  for (const action of actions) {
    const s = byId.get(action.id);
    lines.push(`## ${action.title}`);
    lines.push('');
    if (s === undefined || s.markdown.trim().length === 0) {
      lines.push('_Section unavailable -- the writer produced no usable content. See the TodoList item for the writer\'s trace and the reviewer\'s hint._');
      lines.push('');
      continue;
    }
    lines.push(s.markdown.trim());
    lines.push('');
  }

  // Drill-down footer -- the Report Pane parser looks for a `## Drill
  // down` heading to surface "run sub-analysis" actions. Skip on
  // drill-down child runs (parentListId set) since they're already
  // children. The planner is encouraged but not required to produce
  // its own bullets; if it didn't include them, this footer is the
  // minimal anchor the pane needs to render the empty-state.
  if (parentListId === undefined) {
    const haveDrillDown = sections.some(s => /^##\s+Drill\s+down/im.test(s.markdown));
    if (!haveDrillDown) {
      lines.push('## Drill down');
      lines.push('');
      lines.push('_The planner did not propose drill-down bullets for this run. Click an action in the Report Pane footer or open the todos pane to launch a follow-up._');
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// Skill-execution → AnalyzerResult adapters (re-run path)
// ---------------------------------------------------------------------------

/**
 * Build a `PerSkillExecution` from a `SkillResult`. Used by the
 * re-run path (`afterRerunBootstrap`) to feed
 * `pipelineResultToAcceptedTasks` for legacy task replays.
 */
function executionFromSkillResult(
  skillId: string,
  args: Record<string, unknown>,
  result: SkillResult<unknown>,
  errored: boolean,
): PerSkillExecution {
  const repoPath = typeof args['repoPath'] === 'string' ? args['repoPath'] : '';
  return {
    skillId,
    args,
    resolvedScope: { repoPath },
    value:         result.value,
    confidence:    result.confidence,
    notes:         result.notes ?? [],
    toolCalls:     result.toolCalls.map(tc => ({
      toolId:     tc.toolId,
      durationMs: tc.durationMs,
      ...(tc.error !== undefined ? { error: tc.error } : {}),
    })),
    errored,
  };
}

/**
 * Roll up multiple `PerSkillExecution`s for a single legacy
 * `AnalysisTask` into one `AnalyzerResult`. Re-uses
 * `pipelineResultToAcceptedTasks` per execution to get findings /
 * answers / citations, then aggregates: answers concatenated,
 * findings + citations unioned, confidence = min, toolCalls
 * concatenated.
 */
function mergeExecutionsToAnalyzerResult(
  task: AnalysisTask,
  executions: readonly PerSkillExecution[],
): { task: AnalysisTask; result: AnalyzerResult } {
  if (executions.length === 0) {
    return {
      task,
      result: {
        itemId:     task.itemId,
        answer:     `Skill plan for \`${task.kind}\` produced no executions.`,
        findings:   [],
        citations:  [],
        confidence: 'low',
        toolCalls:  [],
      },
    };
  }
  const synthetic: SkillsPipelineResult = {
    classify:   { questionType: 'free-form', candidates: [], fallbacks: [], uncertaintyNotes: [] },
    select:     { scoped: [], notes: [] },
    executions,
    finalConfidence: 'low',
    notes: [],
    aborted: false,
  };
  const pairs = pipelineResultToAcceptedTasks(synthetic, task.itemId);
  const answers: string[] = [];
  const findings: AnalyzerResult['findings'][number][] = [];
  const citationsSeen = new Set<string>();
  const citations: AnalyzerResult['citations'][number][] = [];
  const toolCalls: AnalyzerResult['toolCalls'][number][] = [];
  let lowest: Confidence = 'high';
  const rank: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };
  for (const { result } of pairs) {
    answers.push(result.answer);
    for (const f of result.findings) findings.push(f);
    for (const c of result.citations) {
      const key = JSON.stringify(c);
      if (citationsSeen.has(key)) continue;
      citationsSeen.add(key);
      citations.push(c);
    }
    for (const tc of result.toolCalls) toolCalls.push(tc);
    if (rank[result.confidence] < rank[lowest]) lowest = result.confidence;
  }
  return {
    task,
    result: {
      itemId:     task.itemId,
      answer:     answers.join('\n\n'),
      findings,
      citations,
      confidence: lowest,
      toolCalls,
    },
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function shortTitleFor(t: AnalysisTask): string {
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

function isAnalysisKind(s: string): s is AnalysisTask['kind'] {
  return s === 'locate' || s === 'describe' || s === 'trace' || s === 'compare' || s === 'free-form';
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

// ---------------------------------------------------------------------------
// Re-run helpers
// ---------------------------------------------------------------------------

/**
 * Build an `AnalysisTask` from a prior run's `TodoItem`. Reads the
 * question from `description` and `kind` / `scope` / `hint` from
 * `meta`. Returns null when the item lacks the minimal fields.
 */
function reconstructTaskFromItem(item: {
  readonly id: string;
  readonly description?: string | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}): AnalysisTask | null {
  const question = (item.description ?? '').trim();
  if (question.length === 0) {
    return null;
  }
  const meta = item.meta ?? {};
  const kindRaw = meta['kind'];
  if (typeof kindRaw !== 'string' || !isAnalysisKind(kindRaw)) {
    return null;
  }
  const scopeRaw = meta['scope'];
  const hintRaw = meta['hint'];
  const task: AnalysisTask = {
    itemId: '',
    kind: kindRaw,
    question,
    origin: 'plan',
    retryCount: 0,
    ...(scopeRaw !== null && typeof scopeRaw === 'object' && !Array.isArray(scopeRaw)
      ? { scope: parseScope(scopeRaw as Record<string, unknown>) }
      : {}),
    ...(typeof hintRaw === 'string' && hintRaw.length > 0 ? { hint: hintRaw } : {}),
  };
  return task;
}

/**
 * Last-resort fallback when the prior list is gone or has no
 * parseable items. Produces a single free-form task carrying the
 * original request as the question.
 */
function buildFallbackTaskFromRequest(request: string): AnalysisTask[] {
  const trimmed = request.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return [{
    itemId: '',
    kind: 'free-form',
    question: trimmed,
    origin: 'plan',
    retryCount: 0,
  }];
}

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
    return head;
  } catch {
    return `t-${Date.now()}`;
  }
}
