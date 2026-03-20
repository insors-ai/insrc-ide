/**
 * DesignerController — TaskController implementation for the designer agent flow.
 *
 * Maps the designer's step-based state machine to the task pipeline:
 *
 * Flow:
 *   extract-requirements (llm: local + claude)
 *   → validate-requirements (gate: approve/edit/reject, cyclic max 3)
 *   → parse-requirements (transform: parse structured list)
 *   → [per-requirement loop]:
 *       sketch (llm: local + claude review)
 *       → validate-sketch (gate: approve/edit/reject/skip, cyclic max 3)
 *       → detail (llm: local)
 *       → validate-detail (gate: approve/edit/reject/skip, cyclic max 3)
 *       → pick-next-requirement
 *   → assemble (transform: merge all into final doc)
 *   → save-gate (gate: format/location selection)
 *
 * Reuses existing pure functions from designer/requirements.ts, sketch.ts,
 * detail.ts, assembly.ts — the controller only handles flow control.
 */

import type {
  TaskController, ControllerInput, GateReply, FinalizeResult,
  Task, TaskResult, TaskStateStore, TaskFormat,
} from '../task.js';
import type { RequirementTodo, ParsedRequirement } from '../../agent/tasks/designer/types.js';

// ---------------------------------------------------------------------------
// State keys
// ---------------------------------------------------------------------------

const K = {
  RAW_REQUIREMENTS:      'rawRequirements',
  ENHANCED_REQUIREMENTS: 'enhancedRequirements',
  CONFIG_CONTEXT:        'configContext',
  PARSED_REQUIREMENTS:   'parsedRequirements',
  TODOS:                 'todos',
  CURRENT_TODO_INDEX:    'currentTodoIndex',
  EDIT_ROUNDS:           'editRounds',
  ASSEMBLED_OUTPUT:      'assembledOutput',
  LAST_STEP:             'lastStep',
} as const;

const MAX_EDIT_ROUNDS = 3;

// ---------------------------------------------------------------------------
// Task factories
// ---------------------------------------------------------------------------

function makeExtractTask(): Task {
  return {
    index: 0,
    description: 'Extracting requirements...',
    kind: 'llm',
    intent: 'design',
    stateKey: K.ENHANCED_REQUIREMENTS,
    persisted: true,
    systemPrompt: 'extract-requirements', // signal to executeLlmTask to call extractRequirements()
  };
}

function makeValidateRequirementsTask(index: number): Task {
  return {
    index,
    description: 'Requirements Validation',
    kind: 'llm', // placeholder — gate handled by controller
    intent: 'design',
    requiresGate: true,
    stateKey: K.ENHANCED_REQUIREMENTS,
    cyclic: {
      maxRounds: MAX_EDIT_ROUNDS,
      retryActions: ['edit', 'reject'],
      skipActions: [],
    },
  };
}

function makeParseTask(index: number): Task {
  return {
    index,
    description: 'Parsing requirements into structured list...',
    kind: 'transform',
    intent: 'design',
    stateKey: K.PARSED_REQUIREMENTS,
    persisted: true,
  };
}

function makeSketchTask(index: number, reqIndex: number, reqStatement: string): Task {
  return {
    index,
    description: `Sketching requirement ${reqIndex}: ${reqStatement.slice(0, 60)}...`,
    kind: 'llm',
    intent: 'design',
    stateKey: `sketch-${reqIndex}`,
    persisted: true,
    systemPrompt: 'sketch', // signal to use writeSketch + reviewSketch
  };
}

function makeValidateSketchTask(index: number, reqIndex: number): Task {
  return {
    index,
    description: `Sketch Validation (Requirement ${reqIndex})`,
    kind: 'llm',
    intent: 'design',
    requiresGate: true,
    stateKey: `sketch-${reqIndex}`,
    cyclic: {
      maxRounds: MAX_EDIT_ROUNDS,
      retryActions: ['edit'],
      skipActions: ['skip', 'reject'],
    },
  };
}

function makeDetailTask(index: number, reqIndex: number, reqStatement: string): Task {
  return {
    index,
    description: `Detailing requirement ${reqIndex}: ${reqStatement.slice(0, 60)}...`,
    kind: 'llm',
    intent: 'design',
    stateKey: `detail-${reqIndex}`,
    persisted: true,
    systemPrompt: 'detail', // signal to use writeDetail
  };
}

function makeValidateDetailTask(index: number, reqIndex: number): Task {
  return {
    index,
    description: `Detail Validation (Requirement ${reqIndex})`,
    kind: 'llm',
    intent: 'design',
    requiresGate: true,
    stateKey: `detail-${reqIndex}`,
    cyclic: {
      maxRounds: MAX_EDIT_ROUNDS,
      retryActions: ['edit'],
      skipActions: ['skip'],
    },
  };
}

function makeAssembleTask(index: number): Task {
  return {
    index,
    description: 'Assembling final document...',
    kind: 'transform',
    intent: 'design',
    stateKey: K.ASSEMBLED_OUTPUT,
    outputFormat: 'markdown' as TaskFormat,
    requiresGate: true, // save gate
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class DesignerController implements TaskController {
  readonly id = 'designer';

  private taskCounter = 0;

  buildInitialTasks(_input: ControllerInput): Task[] {
    this.taskCounter = 1;
    return [makeExtractTask()];
  }

  next(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Task[] | null {
    const lastStep = state.get<string>(K.LAST_STEP) ?? 'extract';

    // Determine which step just completed based on description/stateKey pattern
    const step = this.resolveStep(completed, lastStep);

    switch (step) {
      case 'extract': {
        state.set(K.LAST_STEP, 'validate-requirements');
        return [makeValidateRequirementsTask(this.taskCounter++)];
      }

      case 'validate-requirements': {
        if (!gateReply || gateReply.action === 'approve') {
          // Parse requirements
          state.set(K.LAST_STEP, 'parse');
          return [makeParseTask(this.taskCounter++)];
        }
        // Edit/reject handled by cyclic retry in orchestrator
        return null;
      }

      case 'parse': {
        // Initialize todos from parsed requirements
        const parsed = state.get<ParsedRequirement[]>(K.PARSED_REQUIREMENTS) ?? [];
        const actionable = parsed.filter(r => r.type !== 'clarification');
        const todos: RequirementTodo[] = actionable.map(r => ({
          index: r.index,
          statement: r.statement,
          type: r.type,
          references: r.references,
          state: 'pending' as const,
        }));
        state.set(K.TODOS, todos);
        state.set(K.CURRENT_TODO_INDEX, 0);
        state.set(K.LAST_STEP, 'pick-next');
        return this.pickNext(state);
      }

      case 'sketch': {
        const idx = state.get<number>(K.CURRENT_TODO_INDEX) ?? 0;
        state.set(K.LAST_STEP, 'validate-sketch');
        return [makeValidateSketchTask(this.taskCounter++, idx + 1)];
      }

      case 'validate-sketch': {
        if (!gateReply || gateReply.action === 'approve') {
          // Proceed to detail
          const idx = state.get<number>(K.CURRENT_TODO_INDEX) ?? 0;
          const todos = state.get<RequirementTodo[]>(K.TODOS) ?? [];
          const todo = todos[idx];
          if (todo) {
            todo.state = 'sketch-validated';
            state.set(K.TODOS, todos);
          }
          state.set(K.LAST_STEP, 'detail');
          return [makeDetailTask(this.taskCounter++, idx + 1, todo?.statement ?? '')];
        }
        if (gateReply.action === 'skip' || gateReply.action === 'reject') {
          // Mark as skipped, pick next
          const idx = state.get<number>(K.CURRENT_TODO_INDEX) ?? 0;
          const todos = state.get<RequirementTodo[]>(K.TODOS) ?? [];
          if (todos[idx]) {
            todos[idx]!.state = 'skipped';
            state.set(K.TODOS, todos);
          }
          state.set(K.LAST_STEP, 'pick-next');
          return this.pickNext(state);
        }
        return null; // edit handled by cyclic
      }

      case 'detail': {
        const idx = state.get<number>(K.CURRENT_TODO_INDEX) ?? 0;
        state.set(K.LAST_STEP, 'validate-detail');
        return [makeValidateDetailTask(this.taskCounter++, idx + 1)];
      }

      case 'validate-detail': {
        const idx = state.get<number>(K.CURRENT_TODO_INDEX) ?? 0;
        const todos = state.get<RequirementTodo[]>(K.TODOS) ?? [];

        if (!gateReply || gateReply.action === 'approve') {
          if (todos[idx]) {
            todos[idx]!.state = 'done';
            state.set(K.TODOS, todos);
          }
          state.set(K.LAST_STEP, 'pick-next');
          return this.pickNext(state);
        }
        if (gateReply.action === 'skip') {
          if (todos[idx]) {
            todos[idx]!.state = 'skipped';
            state.set(K.TODOS, todos);
          }
          state.set(K.LAST_STEP, 'pick-next');
          return this.pickNext(state);
        }
        if (gateReply.action === 'reject') {
          // Reset to pending — will re-sketch
          if (todos[idx]) {
            todos[idx]!.state = 'pending';
            todos[idx]!.sketch = undefined;
            todos[idx]!.detail = undefined;
            state.set(K.TODOS, todos);
          }
          state.set(K.LAST_STEP, 'pick-next');
          return this.pickNext(state);
        }
        return null; // edit handled by cyclic
      }

      case 'assemble': {
        // Pipeline complete
        return null;
      }

      default:
        return null;
    }
  }

  finalize(state: TaskStateStore): FinalizeResult {
    const output = state.get<string>(K.ASSEMBLED_OUTPUT) ?? '';

    return {
      output,
      format: 'markdown',
      artifacts: [
        { name: 'design-document.md', content: output },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private pickNext(state: TaskStateStore): Task[] | null {
    const todos = state.get<RequirementTodo[]>(K.TODOS) ?? [];
    const nextIdx = todos.findIndex(t => t.state === 'pending');

    if (nextIdx < 0) {
      // All done — assemble
      state.set(K.LAST_STEP, 'assemble');
      return [makeAssembleTask(this.taskCounter++)];
    }

    state.set(K.CURRENT_TODO_INDEX, nextIdx);
    const todo = todos[nextIdx]!;
    state.set(K.LAST_STEP, 'sketch');
    return [makeSketchTask(this.taskCounter++, todo.index, todo.statement)];
  }

  private resolveStep(completed: TaskResult, lastStep: string): string {
    // Use the lastStep tracking — more reliable than parsing descriptions
    if (lastStep === 'extract') return 'extract';
    if (lastStep === 'validate-requirements') return 'validate-requirements';
    if (lastStep === 'parse') return 'parse';
    if (lastStep === 'sketch') return 'sketch';
    if (lastStep === 'validate-sketch') return 'validate-sketch';
    if (lastStep === 'detail') return 'detail';
    if (lastStep === 'validate-detail') return 'validate-detail';
    if (lastStep === 'assemble') return 'assemble';
    if (lastStep === 'pick-next') return 'parse'; // pick-next re-enters the loop
    return 'extract';
  }
}
