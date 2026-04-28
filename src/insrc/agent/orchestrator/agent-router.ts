import type { Intent, PersonaName } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Intent → Agent Persona routing
//
// From design/agent.html:
//   The orchestrator selects the appropriate persona based on the classified
//   intent. Personas are stateless across turns — they receive a fully
//   assembled context package and return a structured result.
//
// Phase 2.B note: `code-analysis` was historically an orchestrator-direct
// intent (the legacy CodeAnalysisController answered structural queries
// from Kuzu/LanceDB without a persona). The new tier-aware orchestrator
// (CodeAnalyzerOrchestratorController) is its own family controller and
// owns its plan/analyze/review/synthesise pipeline. It still doesn't
// belong to any persona above; the case branch returns persona: null
// and the family-controller dispatch in daemon/task.ts:resolveController
// picks up the new orchestrator.
// ---------------------------------------------------------------------------

/**
 * Route result — which persona handles this intent (if any).
 */
export interface AgentRouteResult {
  /** The persona that handles this intent, or null if orchestrator-handled */
  persona: PersonaName | null;
  /** The intent being routed */
  intent: Intent;
}

/**
 * Map an intent to the agent persona that handles it.
 *
 * From design/agent.html intent taxonomy:
 *   Designer:  requirements, design, review
 *   Planner:   plan
 *   Developer: implement, refactor, debug, research, document
 *   Tester:    test
 *   Deployer:  deploy, release, infra
 *   Family controller (null): code-analysis -- routed through
 *     CodeAnalyzerOrchestratorController via the family-controller
 *     dispatch in daemon/task.ts:resolveController, not through this
 *     persona switch. The case below returns persona: null so the
 *     switch stays exhaustive over the Intent union.
 */
export function selectAgent(intent: Intent): AgentRouteResult {
  switch (intent) {
    // Designer persona — creative & architectural intents
    case 'requirements':
    case 'design':
    case 'review':
    case 'brainstorm':
      return { persona: 'designer', intent };

    // Planner persona — plan generation & management
    case 'plan':
      return { persona: 'planner', intent };

    // Developer persona — code production & exploration intents
    case 'implement':
    case 'refactor':
    case 'debug':
    case 'research':
    case 'document':
      return { persona: 'developer', intent };

    // Tester persona — test generation, execution, fix loop
    case 'test':
      return { persona: 'tester', intent };

    // Deployer persona — deployment, release, infrastructure
    case 'deploy':
    case 'release':
    case 'infra':
      return { persona: 'deployer', intent };

    // Family controller (no persona) -- code-analysis is routed
    // through CodeAnalyzerOrchestratorController via the standard
    // family-controller dispatch (daemon/task.ts:resolveController).
    case 'code-analysis':
      return { persona: null, intent };
  }
}

/**
 * Intents owned by each persona. Useful for building persona-specific
 * tool schemas and system prompts.
 */
export const PERSONA_INTENTS: Record<PersonaName, readonly Intent[]> = {
  designer:  ['requirements', 'design', 'review'],
  planner:   ['plan'],
  developer: ['implement', 'refactor', 'debug', 'research', 'document'],
  tester:    ['test'],
  deployer:  ['deploy', 'release', 'infra'],
} as const;
