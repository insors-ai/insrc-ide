/**
 * CodingController — TaskController for both Pair and Delegate coding agents.
 *
 * A single controller with two flow modes determined by scope detection:
 *
 * Pair mode (single scope — implement/refactor/debug/explore):
 *   check-context → analyze (optional) → propose → review-gate ↔ (edit loop)
 *   → apply → validate (optional, Claude) → (next todo or back to review-gate)
 *   → summarize
 *
 * Delegate mode (batch scope — plan-driven autonomous):
 *   invoke-planner → approve-plan (gate) → execute-step → advance
 *   → [failure-gate on error] → (next step or report)
 *
 * Shared characteristics:
 * - Both support provider @mention overrides
 * - Both use investigate() for code exploration
 * - Both use generateAndValidate() for codegen
 * - Both persist via TaskStateStore for crash recovery
 */

import type {
  TaskController, ControllerInput, GateReply, FinalizeResult,
  Task, TaskResult, TaskStateStore, TaskFormat,
} from '../task.js';
import { classify } from '../../agent/classify/index.js';
import { resolveClassifierProvider } from '../../agent/classify/provider.js';
import { SCOPE_CLASSES, type Scope } from '../../shared/scope-classes.js';

// ---------------------------------------------------------------------------
// State keys
// ---------------------------------------------------------------------------

const K = {
  // Common
  MODE:                'codingMode',         // 'pair' | 'delegate'
  PAIR_MODE:           'pairMode',           // 'implement' | 'refactor' | 'debug' | 'explore'
  INVESTIGATION:       'investigationSummary',
  FILES_CHANGED:       'filesChanged',
  CONFIG_CONTEXT:      'configContext',
  EDIT_ROUNDS:         'editRounds',
  LAST_STEP:           'lastStep',

  // Pair
  HAS_DESIGN_CONTEXT:  'hasDesignContext',
  PENDING_PROPOSAL:    'pendingProposal',
  ACTIVE_TODOS:        'activeTodos',
  CURRENT_TODO_INDEX:  'currentTodoIndex',
  CHANGES_APPLIED:     'changesApplied',
  ITERATION_COUNT:     'iterationCount',
  CURRENT_FOCUS:       'currentFocus',
  CONVERSATION_SUMMARY: 'conversationSummary',
  FILES_IN_SCOPE:      'filesInScope',

  // Delegate
  PLAN:                'delegatePlan',
  CURRENT_STEP_INDEX:  'currentStepIndex',
  STEP_RESULTS:        'stepResults',
  GATE_LEVEL:          'gateLevel',
  COMMIT_STRATEGY:     'commitStrategy',
  PENDING_COMMIT_FILES: 'pendingCommitFiles',
  COMMITS:             'commits',
  REPORT:              'report',
} as const;

const MAX_EDIT_ROUNDS_PAIR = 5;
const MAX_EDIT_ROUNDS_DELEGATE = 3;
const MAX_STEP_RETRIES = 2;

// ---------------------------------------------------------------------------
// Task factories — Pair mode
// ---------------------------------------------------------------------------

function makePairCheckContextTask(): Task {
  return {
    index: 0,
    description: 'Checking design context...',
    kind: 'transform',
    intent: 'implement',
    stateKey: K.HAS_DESIGN_CONTEXT,
  };
}

function makePairAnalyzeTask(index: number, mode: string): Task {
  return {
    index,
    description: mode === 'debug'
      ? 'Investigating: identifying root causes, checking recent changes...'
      : 'Analyzing codebase...',
    kind: 'llm',
    intent: mode,
    stateKey: K.INVESTIGATION,
    systemPrompt: 'pair-analyze',
  };
}

function makePairProposeTask(index: number, mode: string): Task {
  return {
    index,
    description: mode === 'explore'
      ? 'Investigating...'
      : `Generating ${mode} proposal...`,
    kind: 'llm',
    intent: mode,
    stateKey: K.PENDING_PROPOSAL,
    persisted: true,
    systemPrompt: `pair-propose-${mode}`,
  };
}

function makePairReviewGateTask(index: number, mode: string): Task {
  return {
    index,
    description: mode === 'explore' ? 'Review Findings' : 'Review Proposal',
    kind: 'llm',
    intent: mode,
    requiresGate: true,
    stateKey: K.PENDING_PROPOSAL,
    cyclic: {
      maxRounds: MAX_EDIT_ROUNDS_PAIR,
      retryActions: ['edit', 'reject', 'expand'],
      skipActions: ['done'],
    },
  };
}

function makePairApplyTask(index: number): Task {
  return {
    index,
    description: 'Applying changes...',
    kind: 'transform',
    intent: 'implement',
    stateKey: K.CHANGES_APPLIED,
    persisted: true,
  };
}

function makePairValidateTask(index: number): Task {
  return {
    index,
    description: 'Validating changes (Claude review)...',
    kind: 'llm',
    intent: 'implement',
    stateKey: 'validationResult',
    systemPrompt: 'pair-validate',
  };
}

function makePairSummarizeTask(index: number): Task {
  return {
    index,
    description: 'Generating session summary...',
    kind: 'llm',
    intent: 'implement',
    stateKey: K.CONVERSATION_SUMMARY,
    outputFormat: 'markdown' as TaskFormat,
    systemPrompt: 'pair-summarize',
  };
}

// ---------------------------------------------------------------------------
// Task factories — Delegate mode
// ---------------------------------------------------------------------------

function makeDelegateInvokePlannerTask(): Task {
  return {
    index: 0,
    description: 'Running planner to create implementation plan...',
    kind: 'agent',
    intent: 'implement',
    stateKey: K.PLAN,
    agentId: 'planner',
    persisted: true,
  };
}

function makeDelegateApprovePlanTask(index: number): Task {
  return {
    index,
    description: 'Plan Approval',
    kind: 'llm',
    intent: 'implement',
    requiresGate: true,
    stateKey: K.PLAN,
    cyclic: {
      maxRounds: MAX_EDIT_ROUNDS_DELEGATE,
      retryActions: ['edit'],
      skipActions: ['abort'],
    },
  };
}

function makeDelegateExecuteStepTask(index: number, stepIndex: number, stepTitle: string): Task {
  return {
    index,
    description: `Step ${stepIndex + 1}: ${stepTitle}`,
    kind: 'llm',
    intent: 'implement',
    stateKey: `step-result-${stepIndex}`,
    persisted: true,
    systemPrompt: 'delegate-execute',
  };
}

function makeDelegateAdvanceTask(index: number): Task {
  return {
    index,
    description: 'Advancing to next step...',
    kind: 'transform',
    intent: 'implement',
    stateKey: K.CURRENT_STEP_INDEX,
  };
}

function makeDelegateFailureGateTask(index: number, stepTitle: string): Task {
  return {
    index,
    description: `Step failed: ${stepTitle}`,
    kind: 'llm',
    intent: 'implement',
    requiresGate: true,
    stateKey: 'failureAction',
    cyclic: {
      maxRounds: MAX_STEP_RETRIES,
      retryActions: ['retry', 'edit'],
      skipActions: ['skip', 'abort'],
    },
  };
}

function makeDelegateReportTask(index: number): Task {
  return {
    index,
    description: 'Generating execution report...',
    kind: 'llm',
    intent: 'implement',
    stateKey: K.REPORT,
    outputFormat: 'markdown' as TaskFormat,
    persisted: true,
    systemPrompt: 'delegate-report',
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class CodingController implements TaskController {
  // Family id from shared/agent-registry.ts. The controller dispatches
  // between pair (single scope) and delegate (batch scope) variants
  // internally; ownership stays at the family level.
  readonly id = 'implementation';

  private taskCounter = 0;

  async buildInitialTasks(input: ControllerInput): Promise<Task[]> {
    this.taskCounter = 1;

    // Classify scope: single (pair) vs batch (delegate). Uses the
    // shared classifier module; no keyword heuristics.
    let scope: Scope = 'single';
    if (input.session) {
      const result = await classify(
        { role: 'coding scope classifier', classes: SCOPE_CLASSES, text: input.message },
        resolveClassifierProvider(input.session, 'scope'),
      );
      scope = result.id as Scope;
    }

    if (scope === 'batch') {
      // Delegate mode — start with planner
      return [makeDelegateInvokePlannerTask()];
    }

    // Pair mode — start with context check
    return [makePairCheckContextTask()];
  }

  next(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Task[] | null {
    const mode = state.get<string>(K.MODE) ?? 'pair';

    if (mode === 'delegate') {
      return this.nextDelegate(completed, gateReply, state);
    }
    return this.nextPair(completed, gateReply, state);
  }

  finalize(state: TaskStateStore): FinalizeResult {
    const mode = state.get<string>(K.MODE) ?? 'pair';

    if (mode === 'delegate') {
      return {
        output: state.get<string>(K.REPORT) ?? '',
        format: 'markdown',
        artifacts: [{ name: 'delegate-report.md', content: state.get<string>(K.REPORT) ?? '' }],
      };
    }

    return {
      output: state.get<string>(K.CONVERSATION_SUMMARY) ?? '',
      format: 'markdown',
      artifacts: [{ name: 'pair-summary.md', content: state.get<string>(K.CONVERSATION_SUMMARY) ?? '' }],
    };
  }

  // ---------------------------------------------------------------------------
  // Pair mode flow
  // ---------------------------------------------------------------------------

  private nextPair(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Task[] | null {
    const lastStep = state.get<string>(K.LAST_STEP) ?? 'check-context';
    const pairMode = state.get<string>(K.PAIR_MODE) ?? 'implement';

    switch (lastStep) {
      case 'check-context': {
        const hasDesign = state.get<boolean>(K.HAS_DESIGN_CONTEXT) ?? false;
        if (hasDesign && (pairMode === 'implement' || pairMode === 'refactor')) {
          // Skip analyze, go directly to propose
          state.set(K.LAST_STEP, 'propose');
          return [makePairProposeTask(this.taskCounter++, pairMode)];
        }
        state.set(K.LAST_STEP, 'analyze');
        return [makePairAnalyzeTask(this.taskCounter++, pairMode)];
      }

      case 'analyze': {
        state.set(K.LAST_STEP, 'propose');
        return [makePairProposeTask(this.taskCounter++, pairMode)];
      }

      case 'propose': {
        state.set(K.LAST_STEP, 'review-gate');
        return [makePairReviewGateTask(this.taskCounter++, pairMode)];
      }

      case 'review-gate': {
        if (!gateReply || gateReply.action === 'approve') {
          // Check if proposal has a diff to apply
          const hasDiff = state.get<boolean>('proposalHasDiff') ?? false;
          if (hasDiff) {
            state.set(K.LAST_STEP, 'apply');
            return [makePairApplyTask(this.taskCounter++)];
          }
          // No diff (explore mode or question) — back to review
          state.set(K.LAST_STEP, 'propose');
          return [makePairProposeTask(this.taskCounter++, pairMode)];
        }

        if (gateReply.action === 'done') {
          state.set(K.LAST_STEP, 'summarize');
          return [makePairSummarizeTask(this.taskCounter++)];
        }

        if (gateReply.action === 'edit' || gateReply.action === 'reject' || gateReply.action === 'expand') {
          // Cyclic retry → re-propose with feedback
          if (gateReply.feedback) {
            state.set(K.CURRENT_FOCUS, gateReply.feedback);
          }
          // Handled by orchestrator cyclic config (retryActions)
          return null;
        }

        // Fallback
        state.set(K.LAST_STEP, 'summarize');
        return [makePairSummarizeTask(this.taskCounter++)];
      }

      case 'apply': {
        // Check if Claude validation is available
        const hasClaudeValidation = state.get<boolean>('hasClaudeValidation') ?? false;
        if (hasClaudeValidation) {
          state.set(K.LAST_STEP, 'validate');
          return [makePairValidateTask(this.taskCounter++)];
        }
        return this.afterPairValidation(state, pairMode);
      }

      case 'validate': {
        return this.afterPairValidation(state, pairMode);
      }

      case 'summarize': {
        return null; // Pipeline complete
      }

      default:
        return null;
    }
  }

  private afterPairValidation(state: TaskStateStore, pairMode: string): Task[] | null {
    // Check if there are more TODOs to work through
    const todos = state.get<Array<{ status: string }>>(K.ACTIVE_TODOS) ?? [];
    const todoIdx = state.get<number>(K.CURRENT_TODO_INDEX) ?? 0;
    const pendingTodo = todos.slice(todoIdx).find(t => t.status === 'pending');

    if (pendingTodo) {
      // More TODOs — propose next one
      state.set(K.LAST_STEP, 'propose');
      return [makePairProposeTask(this.taskCounter++, pairMode)];
    }

    // No more TODOs — back to review gate (user decides: more or done)
    state.set(K.LAST_STEP, 'review-gate');
    return [makePairReviewGateTask(this.taskCounter++, pairMode)];
  }

  // ---------------------------------------------------------------------------
  // Delegate mode flow
  // ---------------------------------------------------------------------------

  private nextDelegate(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Task[] | null {
    const lastStep = state.get<string>(K.LAST_STEP) ?? 'invoke-planner';

    switch (lastStep) {
      case 'invoke-planner': {
        state.set(K.LAST_STEP, 'approve-plan');
        return [makeDelegateApprovePlanTask(this.taskCounter++)];
      }

      case 'approve-plan': {
        if (!gateReply || gateReply.action === 'approve') {
          // Parse commit/gate settings from feedback if present
          if (gateReply?.feedback) {
            this.parseDelegateSettings(gateReply.feedback, state);
          }
          state.set(K.CURRENT_STEP_INDEX, 0);
          return this.nextDelegateStep(state);
        }
        if (gateReply.action === 'abort') {
          state.set(K.LAST_STEP, 'report');
          return [makeDelegateReportTask(this.taskCounter++)];
        }
        // Edit: cyclic retry handles it
        return null;
      }

      case 'execute-step': {
        if (completed.success) {
          state.set(K.LAST_STEP, 'advance');
          return [makeDelegateAdvanceTask(this.taskCounter++)];
        }
        // Step failed
        const stepIdx = state.get<number>(K.CURRENT_STEP_INDEX) ?? 0;
        const gateLevel = state.get<string>(K.GATE_LEVEL) ?? 'normal';

        // Minimal gate level: auto-retry first
        if (gateLevel === 'minimal') {
          const retries = state.get<number>(`step-retries-${stepIdx}`) ?? 0;
          if (retries < MAX_STEP_RETRIES) {
            state.set(`step-retries-${stepIdx}`, retries + 1);
            return this.nextDelegateStep(state);
          }
        }

        // Show failure gate
        const stepTitle = completed.description;
        state.set(K.LAST_STEP, 'failure-gate');
        return [makeDelegateFailureGateTask(this.taskCounter++, stepTitle)];
      }

      case 'advance': {
        return this.nextDelegateStep(state);
      }

      case 'failure-gate': {
        if (!gateReply) return null;

        const stepIdx = state.get<number>(K.CURRENT_STEP_INDEX) ?? 0;

        if (gateReply.action === 'retry' || gateReply.action === 'edit') {
          if (gateReply.feedback) {
            state.set(K.CURRENT_FOCUS, gateReply.feedback);
          }
          state.set(K.LAST_STEP, 'execute-step');
          return this.nextDelegateStep(state);
        }
        if (gateReply.action === 'skip') {
          // Mark step as skipped, advance
          const results = state.get<Array<{ status: string }>>(K.STEP_RESULTS) ?? [];
          if (results[stepIdx]) results[stepIdx]!.status = 'skipped';
          state.set(K.STEP_RESULTS, results);

          const nextIdx = stepIdx + 1;
          state.set(K.CURRENT_STEP_INDEX, nextIdx);
          state.set(K.LAST_STEP, 'advance');
          return this.nextDelegateStep(state);
        }
        if (gateReply.action === 'abort') {
          state.set(K.LAST_STEP, 'report');
          return [makeDelegateReportTask(this.taskCounter++)];
        }
        return null;
      }

      case 'report': {
        return null; // Pipeline complete
      }

      default:
        return null;
    }
  }

  private nextDelegateStep(state: TaskStateStore): Task[] {
    const stepIdx = state.get<number>(K.CURRENT_STEP_INDEX) ?? 0;
    const totalSteps = state.get<number>('totalPlanSteps') ?? 0;

    if (stepIdx >= totalSteps) {
      state.set(K.LAST_STEP, 'report');
      return [makeDelegateReportTask(this.taskCounter++)];
    }

    const stepTitle = state.get<string>(`planStep-${stepIdx}-title`) ?? `Step ${stepIdx + 1}`;
    state.set(K.LAST_STEP, 'execute-step');
    return [makeDelegateExecuteStepTask(this.taskCounter++, stepIdx, stepTitle)];
  }

  private parseDelegateSettings(feedback: string, state: TaskStateStore): void {
    const commitMatch = feedback.match(/commit:\s*(per-step|at-end|at-points)/i);
    if (commitMatch) {
      state.set(K.COMMIT_STRATEGY, commitMatch[1]!.toLowerCase());
    }
    const gateMatch = feedback.match(/gate:\s*(minimal|normal|cautious)/i);
    if (gateMatch) {
      state.set(K.GATE_LEVEL, gateMatch[1]!.toLowerCase());
    }
  }
}

