/**
 * Research agent definition — goal-oriented investigation with adaptive planning.
 *
 * Steps: plan → investigate ⟲ clarify → evaluate → report
 */

import type { AgentDefinition } from '../../framework/types.js';
import type { ResearchState } from './agent-state.js';
import type { ResearchInput } from './types.js';
import { planStep } from './steps/plan.js';
import { investigateStep } from './steps/investigate.js';
import { clarifyStep } from './steps/clarify.js';
import { webSearchStep } from './steps/web-search.js';
import { evaluateStep } from './steps/evaluate.js';
import { reportStep } from './steps/report.js';

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

export const researchAgent: AgentDefinition<ResearchState> = {
  id: 'research',
  version: 1,
  configNamespace: 'research',
  firstStep: 'plan',

  steps: {
    'plan': planStep,
    'investigate': investigateStep,
    'clarify': clarifyStep,
    'web-search': webSearchStep,
    'evaluate': evaluateStep,
    'report': reportStep,
  },

  initialState(input: unknown): ResearchState {
    const ri = input as ResearchInput;
    return {
      input: ri,

      plan: { goal: '', approach: '', steps: [] },
      currentPlanStep: 0,

      findings: [],
      clarifications: [],

      activeSubflow: null,
      subflowIterations: 0,

      goalMet: false,
      confidence: 0,
      missingInfo: [],

      maxInvestigateIterations: 20,
      investigateIterations: 0,
    };
  },
};
