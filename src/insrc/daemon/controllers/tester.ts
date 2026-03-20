/**
 * TesterController — TaskController implementation for the tester agent flow.
 *
 * Maps the tester's 8-step state machine to the task pipeline:
 *
 * Flow:
 *   analyze (llm: local — investigate code, detect framework)
 *   → generate-test-plan (llm: local + optional claude validate)
 *   → review-test-plan (gate: approve/approve-review/edit/reject, cyclic max 3)
 *   → [per-entry loop]:
 *       write-tests (llm: local + claude validate → generateAndValidate)
 *       → review-tests (gate: conditional on approve-review flag)
 *       → execute-tests (shell: run tests → classify failure → fix loop)
 *   → impl-bug-gate (gate: auto-fix via Pair agent or skip)
 *   → report (llm: local → markdown report + save gate)
 *
 * The fix loop inside execute-tests uses sub-tasks:
 *   classify-failure → fix (local, max 3) → claude-escalation (max 2)
 */

import type {
  TaskController, ControllerInput, GateReply, FinalizeResult,
  Task, TaskResult, TaskStateStore, TaskFormat,
} from '../task.js';

// ---------------------------------------------------------------------------
// State keys
// ---------------------------------------------------------------------------

const K = {
  INVESTIGATION:       'investigationSummary',
  FRAMEWORK:           'detectedFramework',
  SOURCE_FILES:        'sourceFiles',
  EXISTING_TESTS:      'existingTests',
  CONFIG_CONTEXT:      'configContext',
  TEST_PLAN:           'testPlan',
  CURRENT_ENTRY_INDEX: 'currentEntryIndex',
  FILE_RESULTS:        'fileResults',
  REVIEW_TESTS:        'reviewTests',
  IMPL_BUGS:           'implementationBugs',
  FILES_CHANGED:       'filesChanged',
  REPORT:              'report',
  EDIT_ROUNDS:         'editRounds',
  LAST_STEP:           'lastStep',
  TOTAL_ENTRIES:       'totalEntries',
} as const;

const MAX_EDIT_ROUNDS = 3;
const MAX_FIX_ATTEMPTS = 3;
const MAX_CLAUDE_ROUNDS = 2;

// ---------------------------------------------------------------------------
// File result tracking (mirrors TesterState.fileResults)
// ---------------------------------------------------------------------------

interface FileResult {
  entryIndex: number;
  targetFile: string;
  testFile: string;
  status: 'pending' | 'written' | 'codegen-failed' | 'passing' | 'impl-bug' | 'setup-skipped' | 'fix-exhausted' | 'skipped';
  fixAttempts: number;
  claudeRounds: number;
}

// ---------------------------------------------------------------------------
// Task factories
// ---------------------------------------------------------------------------

function makeAnalyzeTask(): Task {
  return {
    index: 0,
    description: 'Analyzing code and detecting test framework...',
    kind: 'llm',
    intent: 'test',
    stateKey: K.INVESTIGATION,
    systemPrompt: 'analyze',
  };
}

function makeGeneratePlanTask(index: number): Task {
  return {
    index,
    description: 'Generating test plan...',
    kind: 'llm',
    intent: 'test',
    stateKey: K.TEST_PLAN,
    persisted: true,
    systemPrompt: 'generate-test-plan',
  };
}

function makeReviewPlanTask(index: number): Task {
  return {
    index,
    description: 'Test Plan Review',
    kind: 'llm',
    intent: 'test',
    requiresGate: true,
    stateKey: K.TEST_PLAN,
    cyclic: {
      maxRounds: MAX_EDIT_ROUNDS,
      retryActions: ['edit'],
      skipActions: ['reject'],
    },
  };
}

function makeWriteTestsTask(index: number, entryIdx: number, targetFile: string): Task {
  return {
    index,
    description: `Writing tests for ${targetFile.split('/').pop() ?? targetFile}...`,
    kind: 'llm',
    intent: 'test',
    stateKey: `test-code-${entryIdx}`,
    persisted: true,
    systemPrompt: 'write-tests',
  };
}

function makeReviewTestsTask(index: number, entryIdx: number): Task {
  return {
    index,
    description: `Review tests (entry ${entryIdx + 1})`,
    kind: 'llm',
    intent: 'test',
    requiresGate: true,
    stateKey: `test-review-${entryIdx}`,
    cyclic: {
      maxRounds: MAX_EDIT_ROUNDS,
      retryActions: ['edit'],
      skipActions: ['skip'],
    },
  };
}

function makeExecuteTestsTask(index: number, entryIdx: number, testFile: string): Task {
  return {
    index,
    description: `Executing tests: ${testFile.split('/').pop() ?? testFile}`,
    kind: 'shell',
    intent: 'test',
    stateKey: `test-result-${entryIdx}`,
    // Command will be set dynamically by the controller based on framework
    command: undefined,
    // Don't gate test execution — just run it
    requiresGate: false,
    risk: 'low',
    // Fix loop handled via sub-tasks
    subTasks: makeFixSubTasks(index, entryIdx),
  };
}

function makeFixSubTasks(parentIndex: number, entryIdx: number): Task[] {
  // The fix loop is modeled as a sequence of potential sub-tasks.
  // The controller dynamically decides whether to add more fix rounds
  // based on test results and classification.
  // For now, we create the initial execute task only — the controller
  // adds fix tasks dynamically via next().
  return [];
}

function makeImplBugGateTask(index: number): Task {
  return {
    index,
    description: 'Implementation bugs detected',
    kind: 'llm',
    intent: 'test',
    requiresGate: true,
    stateKey: K.IMPL_BUGS,
  };
}

function makeReportTask(index: number): Task {
  return {
    index,
    description: 'Generating test report...',
    kind: 'llm',
    intent: 'test',
    stateKey: K.REPORT,
    outputFormat: 'markdown' as TaskFormat,
    requiresGate: true, // save gate
    persisted: true,
    systemPrompt: 'report',
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class TesterController implements TaskController {
  readonly id = 'tester';

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
        state.set(K.LAST_STEP, 'generate-plan');
        return [makeGeneratePlanTask(this.taskCounter++)];
      }

      case 'generate-plan': {
        state.set(K.LAST_STEP, 'review-plan');
        return [makeReviewPlanTask(this.taskCounter++)];
      }

      case 'review-plan': {
        if (!gateReply || gateReply.action === 'approve' || gateReply.action === 'approve-review') {
          // Initialize file results from test plan
          if (gateReply?.action === 'approve-review') {
            state.set(K.REVIEW_TESTS, true);
          }
          this.initFileResults(state);
          state.set(K.LAST_STEP, 'write-tests');
          return this.nextWriteTest(state);
        }
        if (gateReply.action === 'reject') {
          // Go back to analyze
          state.set(K.LAST_STEP, 'analyze');
          return [makeAnalyzeTask()];
        }
        // Edit: cyclic retry handled by orchestrator
        // On exhaustion, force forward
        this.initFileResults(state);
        state.set(K.LAST_STEP, 'write-tests');
        return this.nextWriteTest(state);
      }

      case 'write-tests': {
        const entryIdx = state.get<number>(K.CURRENT_ENTRY_INDEX) ?? 0;
        const reviewTests = state.get<boolean>(K.REVIEW_TESTS) ?? false;

        if (reviewTests) {
          state.set(K.LAST_STEP, 'review-tests');
          return [makeReviewTestsTask(this.taskCounter++, entryIdx)];
        }
        // Skip review, go to execute
        state.set(K.LAST_STEP, 'execute-tests');
        return this.makeExecuteForCurrentEntry(state);
      }

      case 'review-tests': {
        if (!gateReply || gateReply.action === 'approve') {
          state.set(K.LAST_STEP, 'execute-tests');
          return this.makeExecuteForCurrentEntry(state);
        }
        if (gateReply.action === 'skip') {
          // Mark skipped, advance
          this.markEntryStatus(state, 'skipped');
          return this.advanceEntry(state);
        }
        // Edit: cyclic retry, on exhaustion execute anyway
        state.set(K.LAST_STEP, 'execute-tests');
        return this.makeExecuteForCurrentEntry(state);
      }

      case 'execute-tests': {
        // Check test result from completed task
        const entryIdx = state.get<number>(K.CURRENT_ENTRY_INDEX) ?? 0;

        if (completed.success) {
          // Tests passed
          this.markEntryStatus(state, 'passing');
          return this.advanceEntry(state);
        }

        // Tests failed — classification and fix logic
        // For now, mark based on output analysis
        const output = completed.output.toLowerCase();
        if (output.includes('impl-bug') || output.includes('implementation')) {
          this.markEntryStatus(state, 'impl-bug');
          this.addImplBug(state, entryIdx, completed.output);
          return this.advanceEntry(state);
        }

        // Check fix attempts
        const results = state.get<FileResult[]>(K.FILE_RESULTS) ?? [];
        const entry = results[entryIdx];
        if (entry) {
          if (entry.fixAttempts >= MAX_FIX_ATTEMPTS) {
            if (entry.claudeRounds >= MAX_CLAUDE_ROUNDS) {
              this.markEntryStatus(state, 'fix-exhausted');
              return this.advanceEntry(state);
            }
            // Claude escalation round
            entry.claudeRounds++;
            entry.fixAttempts = 0;
            state.set(K.FILE_RESULTS, results);
          } else {
            entry.fixAttempts++;
            state.set(K.FILE_RESULTS, results);
          }
        }

        // Retry test execution (fix loop continues)
        state.set(K.LAST_STEP, 'execute-tests');
        return this.makeExecuteForCurrentEntry(state);
      }

      case 'impl-bug-gate': {
        if (!gateReply || gateReply.action === 'skip') {
          state.set(K.LAST_STEP, 'report');
          return [makeReportTask(this.taskCounter++)];
        }
        if (gateReply.action === 'auto-fix') {
          // Pair agent handoff would happen here
          // For now, proceed to report
          state.set(K.LAST_STEP, 'report');
          return [makeReportTask(this.taskCounter++)];
        }
        state.set(K.LAST_STEP, 'report');
        return [makeReportTask(this.taskCounter++)];
      }

      case 'report': {
        return null; // Pipeline complete
      }

      default:
        return null;
    }
  }

  finalize(state: TaskStateStore): FinalizeResult {
    const report = state.get<string>(K.REPORT) ?? '';

    return {
      output: report,
      format: 'markdown',
      artifacts: [
        { name: 'test-report.md', content: report },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private initFileResults(state: TaskStateStore): void {
    // Initialize file results from plan entries count
    const totalEntries = state.get<number>(K.TOTAL_ENTRIES) ?? 0;
    const results: FileResult[] = [];
    for (let i = 0; i < totalEntries; i++) {
      results.push({
        entryIndex: i,
        targetFile: '',
        testFile: '',
        status: 'pending',
        fixAttempts: 0,
        claudeRounds: 0,
      });
    }
    state.set(K.FILE_RESULTS, results);
    state.set(K.CURRENT_ENTRY_INDEX, 0);
    state.set(K.IMPL_BUGS, []);
  }

  private nextWriteTest(state: TaskStateStore): Task[] | null {
    const entryIdx = state.get<number>(K.CURRENT_ENTRY_INDEX) ?? 0;
    const total = state.get<number>(K.TOTAL_ENTRIES) ?? 0;

    if (entryIdx >= total) {
      return this.afterAllEntries(state);
    }

    const targetFile = `entry-${entryIdx}`; // placeholder — actual file from plan
    return [makeWriteTestsTask(this.taskCounter++, entryIdx, targetFile)];
  }

  private makeExecuteForCurrentEntry(state: TaskStateStore): Task[] {
    const entryIdx = state.get<number>(K.CURRENT_ENTRY_INDEX) ?? 0;
    const testFile = `test-${entryIdx}`; // placeholder
    return [makeExecuteTestsTask(this.taskCounter++, entryIdx, testFile)];
  }

  private advanceEntry(state: TaskStateStore): Task[] | null {
    const entryIdx = (state.get<number>(K.CURRENT_ENTRY_INDEX) ?? 0) + 1;
    const total = state.get<number>(K.TOTAL_ENTRIES) ?? 0;
    state.set(K.CURRENT_ENTRY_INDEX, entryIdx);

    if (entryIdx >= total) {
      return this.afterAllEntries(state);
    }

    state.set(K.LAST_STEP, 'write-tests');
    return this.nextWriteTest(state);
  }

  private afterAllEntries(state: TaskStateStore): Task[] | null {
    const bugs = state.get<unknown[]>(K.IMPL_BUGS) ?? [];
    if (bugs.length > 0) {
      state.set(K.LAST_STEP, 'impl-bug-gate');
      return [makeImplBugGateTask(this.taskCounter++)];
    }
    state.set(K.LAST_STEP, 'report');
    return [makeReportTask(this.taskCounter++)];
  }

  private markEntryStatus(state: TaskStateStore, status: FileResult['status']): void {
    const entryIdx = state.get<number>(K.CURRENT_ENTRY_INDEX) ?? 0;
    const results = state.get<FileResult[]>(K.FILE_RESULTS) ?? [];
    if (results[entryIdx]) {
      results[entryIdx]!.status = status;
      state.set(K.FILE_RESULTS, results);
    }
  }

  private addImplBug(state: TaskStateStore, entryIdx: number, output: string): void {
    const bugs = state.get<Array<{ entryIndex: number; output: string; status: string }>>(K.IMPL_BUGS) ?? [];
    bugs.push({ entryIndex: entryIdx, output, status: 'detected' });
    state.set(K.IMPL_BUGS, bugs);
  }

  private resolveStep(lastStep: string): string {
    const valid = [
      'analyze', 'generate-plan', 'review-plan', 'write-tests',
      'review-tests', 'execute-tests', 'impl-bug-gate', 'report',
    ];
    return valid.includes(lastStep) ? lastStep : 'analyze';
  }
}
