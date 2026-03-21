/**
 * Research agent state — tracks plan, findings, and goal progress.
 */

import type { ResearchInput, ResearchPlan, Finding, Clarification } from './types.js';

export interface ResearchState {
  [key: string]: unknown;
  input: ResearchInput;

  // Plan
  plan: ResearchPlan;
  currentPlanStep: number;

  // Findings
  findings: Finding[];
  clarifications: Clarification[];

  // Subflow tracking
  activeSubflow: 'local' | 'web' | 'file' | null;
  subflowIterations: number;

  // Goal evaluation
  goalMet: boolean;
  confidence: number;
  missingInfo: string[];

  // Limits
  maxInvestigateIterations: number;
  investigateIterations: number;
}
