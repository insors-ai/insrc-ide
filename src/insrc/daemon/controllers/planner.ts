/**
 * PlannerController — TaskController implementation for the planner agent flow.
 *
 * Maps the planner's 8-step state machine to the task pipeline:
 *
 * Flow:
 *   analyze-request (llm: local — infer plan type)
 *   → gather-context (rpc: search + expand entities, load config)
 *   → draft-plan (llm: local, optional claude enhance)
 *   → validate-plan (gate: approve/edit/reject, cyclic max 3)
 *   → resolve-deps (transform: cycle detection, blocked step analysis)
 *   → detail-steps (llm: local — enrich with domain-specific data)
 *   → validate-details (gate: approve/edit/skip, cyclic max 3)
 *   → serialize (transform: markdown + artifact save gate)
 *
 * Reuses existing pure functions from planner/ modules.
 */

import type {
  TaskController, ControllerInput, GateReply, FinalizeResult,
  Task, TaskResult, TaskStateStore, TaskFormat,
} from '../task.js';

// ---------------------------------------------------------------------------
// State keys
// ---------------------------------------------------------------------------

const K = {
  ANALYSIS:          'analysis',
  INFERRED_TYPE:     'inferredPlanType',
  CODEBASE_FINDINGS: 'codebaseFindings',
  CONFIG_CONTEXT:    'configContext',
  DRAFT_STEPS:       'draftSteps',
  PLAN:              'plan',
  DEPENDENCY_ISSUES: 'dependencyIssues',
  SERIALIZED_OUTPUT: 'serializedOutput',
  EDIT_ROUNDS:       'editRounds',
  LAST_STEP:         'lastStep',
} as const;

const MAX_EDIT_ROUNDS = 3;

// ---------------------------------------------------------------------------
// Task factories
// ---------------------------------------------------------------------------

function makeAnalyzeTask(): Task {
  return {
    index: 0,
    description: 'Analyzing request and inferring plan type...',
    kind: 'llm',
    intent: 'plan',
    stateKey: K.ANALYSIS,
    systemPrompt: 'analyze-request',
  };
}

function makeGatherContextTask(index: number): Task {
  return {
    index,
    description: 'Gathering codebase context...',
    kind: 'llm', // uses RPC internally but driven by LLM search planning
    intent: 'plan',
    stateKey: K.CODEBASE_FINDINGS,
    systemPrompt: 'gather-context',
  };
}

function makeDraftTask(index: number): Task {
  return {
    index,
    description: 'Drafting plan...',
    kind: 'llm',
    intent: 'plan',
    stateKey: K.DRAFT_STEPS,
    persisted: true,
    systemPrompt: 'draft-plan',
  };
}

function makeValidatePlanTask(index: number): Task {
  return {
    index,
    description: 'Plan Validation',
    kind: 'llm',
    intent: 'plan',
    requiresGate: true,
    stateKey: K.PLAN,
    cyclic: {
      maxRounds: MAX_EDIT_ROUNDS,
      retryActions: ['edit', 'reject'],
      skipActions: [],
    },
  };
}

function makeResolveDepsTask(index: number): Task {
  return {
    index,
    description: 'Validating plan dependencies...',
    kind: 'transform',
    intent: 'plan',
    stateKey: K.DEPENDENCY_ISSUES,
  };
}

function makeDetailStepsTask(index: number): Task {
  return {
    index,
    description: 'Enriching steps with domain-specific details...',
    kind: 'llm',
    intent: 'plan',
    stateKey: K.PLAN,
    persisted: true,
    systemPrompt: 'detail-steps',
  };
}

function makeValidateDetailsTask(index: number): Task {
  return {
    index,
    description: 'Detailed Plan Review',
    kind: 'llm',
    intent: 'plan',
    requiresGate: true,
    stateKey: K.PLAN,
    cyclic: {
      maxRounds: MAX_EDIT_ROUNDS,
      retryActions: ['edit'],
      skipActions: ['skip'],
    },
  };
}

function makeSerializeTask(index: number): Task {
  return {
    index,
    description: 'Serializing plan to markdown...',
    kind: 'transform',
    intent: 'plan',
    stateKey: K.SERIALIZED_OUTPUT,
    outputFormat: 'markdown' as TaskFormat,
    requiresGate: true, // save gate
    persisted: true,
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class PlannerController implements TaskController {
  readonly id = 'planner';

  private taskCounter = 0;

  buildInitialTasks(_input: ControllerInput): Task[] {
    this.taskCounter = 1;
    return [makeAnalyzeTask()];
  }

  next(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Task[] | null {
    const lastStep = state.get<string>(K.LAST_STEP) ?? 'analyze';
    const step = this.resolveStep(lastStep);

    switch (step) {
      case 'analyze': {
        state.set(K.LAST_STEP, 'gather-context');
        return [makeGatherContextTask(this.taskCounter++)];
      }

      case 'gather-context': {
        state.set(K.LAST_STEP, 'draft');
        return [makeDraftTask(this.taskCounter++)];
      }

      case 'draft': {
        state.set(K.LAST_STEP, 'validate-plan');
        return [makeValidatePlanTask(this.taskCounter++)];
      }

      case 'validate-plan': {
        if (!gateReply || gateReply.action === 'approve') {
          state.set(K.LAST_STEP, 'resolve-deps');
          return [makeResolveDepsTask(this.taskCounter++)];
        }
        // Edit/reject: cyclic retry handled by orchestrator.
        // On retry exhaustion, controller.next is called again with the
        // last result — force forward.
        state.set(K.LAST_STEP, 'resolve-deps');
        return [makeResolveDepsTask(this.taskCounter++)];
      }

      case 'resolve-deps': {
        const issues = state.get<string[]>(K.DEPENDENCY_ISSUES) ?? [];
        if (issues.length > 0) {
          // Issues found — loop back to validate-plan for user to fix
          state.set(K.LAST_STEP, 'validate-plan');
          return [makeValidatePlanTask(this.taskCounter++)];
        }
        // Clean — check if plan type needs enrichment
        const planType = state.get<string>(K.INFERRED_TYPE) ?? 'generic';
        if (planType === 'generic') {
          // Skip detail enrichment for generic plans
          state.set(K.LAST_STEP, 'validate-details');
          return [makeValidateDetailsTask(this.taskCounter++)];
        }
        state.set(K.LAST_STEP, 'detail-steps');
        return [makeDetailStepsTask(this.taskCounter++)];
      }

      case 'detail-steps': {
        state.set(K.LAST_STEP, 'validate-details');
        return [makeValidateDetailsTask(this.taskCounter++)];
      }

      case 'validate-details': {
        if (!gateReply || gateReply.action === 'approve' || gateReply.action === 'skip') {
          state.set(K.LAST_STEP, 'serialize');
          return [makeSerializeTask(this.taskCounter++)];
        }
        // Edit: cyclic retry, on exhaustion force forward
        state.set(K.LAST_STEP, 'serialize');
        return [makeSerializeTask(this.taskCounter++)];
      }

      case 'serialize': {
        // Pipeline complete
        return null;
      }

      default:
        return null;
    }
  }

  finalize(state: TaskStateStore): FinalizeResult {
    const output = state.get<string>(K.SERIALIZED_OUTPUT) ?? '';
    const planType = state.get<string>(K.INFERRED_TYPE) ?? 'generic';

    return {
      output,
      format: 'markdown',
      artifacts: [
        { name: `plan.md`, content: output },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resolveStep(lastStep: string): string {
    const valid = [
      'analyze', 'gather-context', 'draft', 'validate-plan',
      'resolve-deps', 'detail-steps', 'validate-details', 'serialize',
    ];
    return valid.includes(lastStep) ? lastStep : 'analyze';
  }
}
