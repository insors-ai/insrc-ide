/**
 * CodeAnalyzerOrchestratorController -- the Code Analyzer family's
 * task-controller entry point.
 *
 * State machine:
 *
 *   synthesising        -> [synthesise LLM task]
 *   done                  (writes list.body; the workbench-side
 *                          CodeAnalyzerFlowContribution opens the
 *                          Report Pane on the listUpdated event;
 *                          plan §2.1)
 *
 * Bootstrap markers (skills-routing / re-run / resume) drive entry;
 * synthesis is the only remaining LLM step the orchestrator owns.
 * Per-skill execution is handled by the meta-skills pipeline
 * (`runSkillsPipeline`) for free-form questions and by the legacy
 * `analysisTaskToSkillPlan` shim for re-runs of older lists.
 */

import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { getLogger } from '../../shared/logger.js';
import { buildSynthesisPrompt, buildSynthesiseSystemPrompt } from '../../agent/tasks/code-analyzer/prompts/synthesise.js';
import {
  buildMultipassOutlineInput,
  makeSectionBuilder,
  DRILL_DOWN_FALLBACK_SECTION,
} from '../../agent/tasks/code-analyzer/prompts/synthesise-multipass.js';
import {
  generateMultiPass,
  makeDiskContentCache,
  type SectionResult,
} from '../../agent/content-gen/index.js';
import { PATHS } from '../../shared/paths.js';
import { analysisTaskToSkillPlan } from '../../agent/tasks/code-analyzer/legacy-shim.js';
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
  SKILLS_ROUTING_BOOTSTRAP_MARKER,
  pipelineResultToAcceptedTasks,
  repoContextFromSummary,
  runSkillsPipeline,
  type PerSkillExecution,
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
const K_PHASE          = 'phase';
const K_SYNTH_RESULT   = 'synthResult';           // final markdown
const K_LIST_ID        = 'listId';

type Phase = 'synthesising' | 'done';

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class CodeAnalyzerOrchestratorController implements TaskController {
  readonly id = 'code-analyzer';

  private deps?: TaskOrchestratorDeps;
  private _request?: string;
  private _repoSummary?: RepoSummary;
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

    return [{
      index: 0,
      description: 'Code Analyzer: routing question through skills pipeline...',
      kind: 'transform',
      intent: 'code-analysis',
      passThrough: true,
      userMessage: SKILLS_ROUTING_BOOTSTRAP_MARKER,
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

    if (completed.output.trim() === SKILLS_ROUTING_BOOTSTRAP_MARKER) {
      return this.afterSkillsRoutingBootstrap(state);
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

  // -- skills-routing bootstrap (code-analyzer-skills.md Phase 8) ----------

  /**
   * Skills-routing path. The bootstrap pass-through emitted by
   * `buildInitialTasks` lands here; we run `runSkillsPipeline`
   * inline (classify-question -> select-scope -> runSkill per scoped
   * -> calibrate-confidence), adapt the result via
   * `pipelineResultToAcceptedTasks`, persist the TodoList, and queue
   * the synthesise step.
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
    if (this._repoSummary === undefined) {
      log.error('afterSkillsRoutingBootstrap: repoSummary missing');
      return null;
    }

    const ca = state.get<CodeAnalysisState>(K_STATE);
    log.info(
      { repo: this._repoSummary.rootPath, tier: this._tier },
      'afterSkillsRoutingBootstrap: running meta-skills pipeline',
    );

    const session = this.deps.session;
    const pipelineResult = await runSkillsPipeline(
      {
        question: this._request,
        repo:     repoContextFromSummary(this._repoSummary),
      },
      {
        session,
        resolveProvider: (affinity) => {
          if (affinity === 'local') return session.ollamaProvider;
          if (affinity === 'cloud') return session.claudeProvider ?? session.ollamaProvider;
          return session.resolver.resolve('code-analyzer', 'plan');
        },
        ...(this.deps.abortController?.signal ? { signal: this.deps.abortController.signal } : {}),
      },
    );

    log.info(
      {
        aborted:         pipelineResult.aborted,
        executions:      pipelineResult.executions.length,
        finalConfidence: pipelineResult.finalConfidence,
        notes:           pipelineResult.notes.slice(0, 3),
      },
      'afterSkillsRoutingBootstrap: pipeline complete',
    );

    if (pipelineResult.aborted) {
      if (ca !== undefined) state.set(K_STATE, { ...ca, cancelled: false });
      state.set(K_PLAN_TASKS, [] as AnalysisTask[]);
      state.set(K_ACCEPTED, [] as Array<{ task: AnalysisTask; result: AnalyzerResult }>);
      state.set(K_HISTORY, [] as AnalyzerResult[]);
      return this.queueSynthesise(state);
    }

    const itemPrefix = `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const accepted = pipelineResultToAcceptedTasks(pipelineResult, itemPrefix);
    const planned: AnalysisTask[] = accepted.map(a => a.task);
    const history: AnalyzerResult[] = accepted.map(a => a.result);

    state.set(K_PLAN_TASKS, planned);
    state.set(K_ACCEPTED, accepted);
    state.set(K_HISTORY, history);

    if (this.deps.todos !== undefined && ca !== undefined) {
      const list = await this.deps.todos.createList({
        sessionId: this.deps.session.id,
        title: `Code Analysis: ${truncateTitle(ca.request)}`,
        description: ca.request,
        ...(this._parentListId !== undefined ? { parentListId: this._parentListId } : {}),
      });
      const stamped: AnalysisTask[] = [];
      for (let i = 0; i < planned.length; i++) {
        const t = planned[i]!;
        const item = await this.deps.todos.addItem(list.id, {
          title: shortTitleFor(t),
          description: t.question,
          meta: {
            kind: t.kind,
            ...(t.scope !== undefined ? { scope: t.scope } : {}),
            origin: t.origin,
            retryCount: t.retryCount,
          },
        });
        try {
          const r = accepted[i]!.result;
          await this.deps.todos.updateItemMeta(item.id, {
            kind: t.kind,
            ...(t.scope !== undefined ? { scope: t.scope } : {}),
            origin: t.origin,
            retryCount: 0,
            answer:     r.answer,
            findings:   r.findings,
            citations:  r.citations,
            confidence: r.confidence,
            toolCalls:  r.toolCalls,
          });
          await this.deps.todos.markComplete(item.id);
        } catch (err) {
          log.warn(
            { err: (err as Error).message, itemId: item.id },
            'afterSkillsRoutingBootstrap: failed to stamp item meta',
          );
        }
        stamped.push({ ...t, itemId: item.id });
      }
      state.set(K_PLAN_TASKS, stamped);
      const stampedAccepted = stamped.map((task, i) => ({
        task,
        result: { ...accepted[i]!.result, itemId: task.itemId },
      }));
      state.set(K_ACCEPTED, stampedAccepted);
      state.set(K_HISTORY, stampedAccepted.map(a => a.result));
      state.set(K_STATE, { ...ca, listId: list.id });
      state.set(K_LIST_ID, list.id);
    }

    return this.queueSynthesise(state);
  }

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
      ...(this.deps.abortController?.signal !== undefined ? { signal: this.deps.abortController.signal } : {}),
    };
  }

  private async queueSynthesise(state: TaskStateStore): Promise<Task[] | null> {
    state.set(K_PHASE, 'synthesising' as Phase);
    const ca = state.get<CodeAnalysisState>(K_STATE);
    const planned = state.get<AnalysisTask[]>(K_PLAN_TASKS) ?? [];
    const accepted = state.get<Array<{ task: AnalysisTask; result: AnalyzerResult }>>(K_ACCEPTED) ?? [];
    const tier = this._tier;

    if (tier === 'S' || tier === 'M') {
      return this.queueSinglePassSynthesise(ca, planned, accepted, tier);
    }

    try {
      const markdown = await this.runMultipassSynthesise(ca, planned, accepted, tier);
      state.set(K_SYNTH_RESULT, markdown);
      await this.finalizeSynthesisedReport(state);
      return null;
    } catch (err) {
      log.warn(
        { tier, err: (err as Error).message },
        'multipass synthesis failed; falling back to single-pass',
      );
      return this.queueSinglePassSynthesise(ca, planned, accepted, tier);
    }
  }

  private queueSinglePassSynthesise(
    ca: CodeAnalysisState | undefined,
    planned: readonly AnalysisTask[],
    accepted: readonly { task: AnalysisTask; result: AnalyzerResult }[],
    tier: ScopeSize,
  ): Task[] {
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

  /**
   * Multi-pass synthesis (Phase 5.C / content-gen consumer). Outline
   * pass plans the section list; pass-2 drafts each section body
   * within a bounded token budget; the stitcher assembles the final
   * markdown. The drill-down footer is added synthetically when the
   * outline LLM omits it -- the Report Pane footer parser depends
   * on it.
   */
  private async runMultipassSynthesise(
    ca: CodeAnalysisState | undefined,
    planned: readonly AnalysisTask[],
    accepted: readonly { task: AnalysisTask; result: AnalyzerResult }[],
    tier: ScopeSize,
  ): Promise<string> {
    if (this.deps === undefined) {
      throw new Error('runMultipassSynthesise: deps not attached');
    }
    const provider = this.deps.session.resolver.resolve('code-analyzer', 'synthesise');
    const request = ca?.request ?? '';
    const repoSnapshotId = ca?.repoSummary.repoSnapshotId ?? '';

    const outlineInput = buildMultipassOutlineInput(request, accepted, planned, tier);
    const sectionBuild = makeSectionBuilder(request, accepted, tier);

    const synthStep = 'synthesise (multi-pass)';
    this.emitLiveStep(synthStep, '');
    this.emitLiveStep(synthStep, this.formatProgress('multi-pass synthesis: planning sections...') + '\n');

    const result = await generateMultiPass(
      {
        outline: {
          system: outlineInput.system,
          user:   outlineInput.user,
          maxSections: outlineInput.maxSections,
          maxTokens:   outlineInput.maxTokens,
        },
        section: {
          build: sectionBuild,
          defaultBudgetTokens: 4000,
        },
        parallel: true,
        cache: makeDiskContentCache({
          dir: pathJoin(PATHS.codeAnalyzerCache, '..', 'code-analyzer-sections'),
        }),
        cacheContext: repoSnapshotId,
        onSectionComplete: (s: SectionResult) => {
          const note = s.note ? ` (${s.note})` : '';
          const status = s.fallback ? 'degraded' : 'ok';
          this.emitLiveStep(synthStep, this.formatProgress(`section "${s.id}" ${status}${note}`) + '\n');
        },
        ...(this.deps.abortController?.signal ? { signal: this.deps.abortController.signal } : {}),
      },
      provider,
    );

    if (result.degraded) {
      log.info(
        { tier, sections: result.sections.length, anyFallback: result.sections.some(s => s.fallback) },
        'multipass synthesis: degraded result accepted',
      );
    }
    this.emitLiveStep(synthStep, '', true);

    const hasDrillDown = result.outline.sections.some(s =>
      s.id === DRILL_DOWN_FALLBACK_SECTION.id || /drill[-\s]?down/i.test(s.title),
    );
    if (!hasDrillDown) {
      log.info({ tier }, 'multipass: outline missing drill-down section; appending synthetic footer');
      return appendSyntheticDrillDown(result.markdown, request, accepted);
    }
    return result.markdown;
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
      return;
    }
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
  }
}

// ---------------------------------------------------------------------------
// Skill-execution → AnalyzerResult adapters (re-run path)
// ---------------------------------------------------------------------------

/**
 * Build a `PerSkillExecution` from a `SkillResult`. Mirrors the
 * adapter shape used by `runSkillsPipeline` so both code paths feed
 * `pipelineResultToAcceptedTasks` with identical entries.
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

/**
 * Tail-append a synthetic `## Drill down` section to a stitched
 * multipass report when the outline LLM didn't plan one.
 */
function appendSyntheticDrillDown(
  markdown: string,
  request: string,
  accepted: readonly { task: AnalysisTask; result: AnalyzerResult }[],
): string {
  const lines: string[] = [markdown.replace(/\s+$/, ''), '', '## Drill down', ''];
  const candidates = pickDrillDownCandidates(request, accepted);
  if (candidates.length === 0) {
    lines.push('_No drill-down candidates available; rephrase the original prompt to dig deeper._');
  } else {
    for (const c of candidates) {
      const scope = c.scope.length > 0 ? ` -- scope: \`${c.scope}\`` : '';
      lines.push(`- **${c.question}**${scope}`);
    }
  }
  return lines.join('\n') + '\n';
}

function pickDrillDownCandidates(
  _request: string,
  accepted: readonly { task: AnalysisTask; result: AnalyzerResult }[],
): Array<{ question: string; scope: string }> {
  const out: Array<{ question: string; scope: string }> = [];
  const seen = new Set<string>();
  for (const { task, result } of accepted) {
    if (out.length >= 3) {
      break;
    }
    const firstCitation = result.citations[0];
    const scope = firstCitation && typeof firstCitation === 'object' && 'path' in firstCitation
      ? String((firstCitation as { path: string }).path)
      : '';
    const question = `Dig deeper on ${task.kind}: ${task.question}`;
    if (seen.has(question)) {
      continue;
    }
    seen.add(question);
    out.push({ question, scope });
  }
  return out;
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
