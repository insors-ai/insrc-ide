/**
 * Persisted state shape for the Data Analyzer orchestrator.
 *
 * Mirrors `daemon/controllers/code-analyzer-orchestrator.ts`'s state
 * pattern (every K_* key is a separate slot in TaskStateStore so the
 * framework persists them between tasks). Defined as a separate
 * module so the controller, the resume RPC, and the test harness
 * all see one source of truth.
 *
 * See plans/analyzers/data-analyzer.md slice 1.9 (Checkpoint /
 * resume foundation) for the full state-key catalog and rationale.
 */

import type { ScopeSize } from '../../../shared/classify.js';
import type {
  ConnectionSummary,
  DataAnalysisTask,
  DataAnalyzerResult,
} from './types.js';

/**
 * Phase the orchestrator is currently in. Persisted in K_PHASE so
 * resume's `afterResumeBootstrap` dispatches into the right branch.
 */
export type DataAnalyzerPhase =
  | 'planning'
  | 'plan-approval'
  | 'analyzing'
  | 'reviewing'
  | 'synthesising'
  | 'present'
  | 'done';

/**
 * Top-level run state. Carries the request, scope, the resolved
 * connection list, and the controller-managed list id. Connection
 * approvals are NOT persisted here -- they live in session memory
 * only and re-prompt on resume per design §14.
 */
export interface DataAnalysisState {
  readonly request: string;
  readonly tier: ScopeSize;
  readonly connections: readonly ConnectionSummary[];
  readonly listId: string;
  readonly childListIds: readonly string[];
  readonly truncated: boolean;
  readonly cancelled: boolean;
}

// ---------------------------------------------------------------------------
// State keys (named constants -- avoid magic strings in the controller)
// ---------------------------------------------------------------------------

export const K_STATE          = 'state';            // DataAnalysisState
export const K_PHASE          = 'phase';            // DataAnalyzerPhase
export const K_RETRIES        = 'retries';          // Record<itemId, number>
export const K_FOLLOWUP_COUNT = 'followup-count';   // total follow-ups added
export const K_PLAN_RESULT    = 'plan-result';      // raw plan LLM output
export const K_PLAN_TASKS     = 'plan-tasks';       // parsed DataAnalysisTask[]
export const K_REVIEW_RESULT  = 'review-result';    // raw review output
export const K_SYNTH_RESULT   = 'synth-result';     // raw synthesise output
export const K_ACCEPTED       = 'accepted';         // Array<{task, result}>
export const K_HISTORY        = 'history';          // DataAnalyzerResult[]
export const K_RAW_EXECUTIONS = 'rawExecutions';    // PerSkillExecution[] from skills pipeline (for plan-actions synthesis)

/**
 * Sentinel emitted by `buildResumeTask` and detected in the
 * orchestrator's `next()` so the resume entry path dispatches based on
 * the persisted K_PHASE rather than the bootstrap task's pseudo-phase.
 */
export const RESUME_BOOTSTRAP_MARKER = '__data_analyzer_resume_bootstrap__';

/**
 * Sentinel emitted by `buildInitialTasks` (data-analyzer-skills.md
 * step 4b). The orchestrator's `next()` detects this marker and
 * dispatches into the skills-routing pipeline (`runSkillsPipeline`
 * → adapter → synthesise). Skills-routing is now the only path; the
 * legacy plan + per-task analyzer flow has been removed.
 */
export const SKILLS_ROUTING_BOOTSTRAP_MARKER = '__data_analyzer_skills_routing_bootstrap__';

// ---------------------------------------------------------------------------
// Accepted-task pair (stashed in K_ACCEPTED for the synthesise step)
// ---------------------------------------------------------------------------

export interface AcceptedTask {
  readonly task: DataAnalysisTask;
  readonly result: DataAnalyzerResult;
}
