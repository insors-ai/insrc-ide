/**
 * Research agent types — goal-oriented investigation with adaptive planning.
 */

import type { DecomposedAction } from '../../classifier/decompose.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ResearchInput {
  question: string;
  codeContext: string;
  repoPath: string;
  closureRepos: string[];
  fileRefs: string[];
  classification: DecomposedAction;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type PlanStepAction =
  | 'read-file'
  | 'grep-search'
  | 'glob-search'
  | 'graph-query'
  | 'graph-search'
  | 'web-search'
  | 'list-dir'
  | 'git-log'
  | 'git-blame'
  | 'ask-user'
  | 'analyze';

export interface PlanStep {
  id: number;
  action: PlanStepAction;
  target: string;
  reason: string;
  status: 'pending' | 'done' | 'skipped' | 'failed';
  result?: string | undefined;
}

export interface ResearchPlan {
  goal: string;
  approach: string;
  steps: PlanStep[];
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface Finding {
  source: string;
  content: string;
  relevance: string;
}

export interface Clarification {
  question: string;
  answer: string;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluationResult {
  goalMet: boolean;
  confidence: number;
  missingInfo: string[];
  additionalSteps: PlanStep[];
  reasoning: string;
}
