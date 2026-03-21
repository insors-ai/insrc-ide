/**
 * Evaluate step — assess whether the research goal has been met.
 *
 * Reviews all findings against the original goal. Routes to:
 * - report: if goal is met with sufficient confidence
 * - investigate: if more steps are needed (adds them to the plan)
 * - clarify: if stuck and needs user direction
 */

import type { AgentStep, StepResult, StepContext } from '../../../framework/types.js';
import type { ResearchState } from '../agent-state.js';
import type { PlanStep, EvaluationResult } from '../types.js';
import { getLogger } from '../../../../shared/logger.js';

const log = getLogger('research-evaluate');

const EVAL_SYSTEM = `You are evaluating whether a research goal has been met.
Given the goal, findings, and any user clarifications, assess progress.

Output ONLY valid JSON:
{
  "goalMet": <true if the question can be answered from the findings>,
  "confidence": <0.0-1.0, how confident you are>,
  "missingInfo": ["<what's still needed>"],
  "additionalSteps": [
    { "id": 0, "action": "<action>", "target": "<target>", "reason": "<why>" }
  ],
  "reasoning": "<1-2 sentences explaining your assessment>"
}

Rules:
- goalMet=true if we have enough information to write a useful answer, even if not exhaustive
- confidence > 0.7 means we can report
- Only add additionalSteps if they would meaningfully improve the answer
- Empty additionalSteps array if no more investigation needed
- missingInfo should list specific gaps, not vague descriptions`;

export const evaluateStep: AgentStep<ResearchState> = {
  name: 'evaluate',
  async run(state: ResearchState, ctx: StepContext): Promise<StepResult<ResearchState>> {

    ctx.progress('Evaluating research progress...');

    // Build evaluation context
    const findingsSummary = state.findings.length > 0
      ? state.findings.map((f, i) => `[${i + 1}] Source: ${f.source}\n  ${f.content.slice(0, 500)}\n  Relevance: ${f.relevance}`).join('\n\n')
      : 'No findings yet.';

    const clarificationsSummary = state.clarifications.length > 0
      ? state.clarifications.map(c => `Q: ${c.question}\nA: ${c.answer}`).join('\n')
      : '';

    const completedSteps = state.plan.steps
      .filter(s => s.status !== 'pending')
      .map(s => `[${s.status}] ${s.action}: ${s.target}`)
      .join('\n');

    const evalPrompt = `Research goal: ${state.plan.goal}

Completed steps:
${completedSteps}

Findings:
${findingsSummary}
${clarificationsSummary ? `\nUser clarifications:\n${clarificationsSummary}` : ''}

Assess whether the goal has been met.`;

    let evalResult: EvaluationResult;

    try {
      const response = await ctx.providers.resolve('research', 'evaluate').complete([
        { role: 'system', content: EVAL_SYSTEM },
        { role: 'user', content: evalPrompt },
      ], { maxTokens: 800, temperature: 0 });

      const text = response.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      evalResult = JSON.parse(text) as EvaluationResult;
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'failed to parse evaluation, assuming goal met');
      evalResult = {
        goalMet: state.findings.length > 0,
        confidence: state.findings.length > 0 ? 0.6 : 0.2,
        missingInfo: [],
        additionalSteps: [],
        reasoning: 'Evaluation parsing failed, proceeding with available findings.',
      };
    }

    log.info({
      goalMet: evalResult.goalMet,
      confidence: evalResult.confidence,
      findings: state.findings.length,
      additionalSteps: evalResult.additionalSteps.length,
    }, 'evaluation complete');

    ctx.progress(`Evaluation: ${evalResult.goalMet ? 'goal met' : 'more investigation needed'} (confidence: ${(evalResult.confidence * 100).toFixed(0)}%)`);

    // Route based on evaluation
    if (evalResult.goalMet && evalResult.confidence >= 0.5) {
      return {
        state: {
          ...state,
          goalMet: true,
          confidence: evalResult.confidence,
          missingInfo: evalResult.missingInfo,
        },
        next: 'report',
      };
    }

    // Need more investigation
    if (evalResult.additionalSteps.length > 0 && state.investigateIterations < state.maxInvestigateIterations) {
      const newSteps: PlanStep[] = evalResult.additionalSteps.map((s, i) => ({
        id: state.plan.steps.length + i,
        action: s.action as PlanStep['action'],
        target: s.target,
        reason: s.reason,
        status: 'pending' as const,
      }));

      log.info({ newSteps: newSteps.length }, 'adding steps from evaluation');

      return {
        state: {
          ...state,
          plan: {
            ...state.plan,
            steps: [...state.plan.steps, ...newSteps],
          },
          missingInfo: evalResult.missingInfo,
          confidence: evalResult.confidence,
        },
        next: 'investigate',
      };
    }

    // Stuck — either ask user or report partial findings
    if (state.findings.length === 0) {
      // No findings at all — ask user for help
      return {
        state: {
          ...state,
          missingInfo: evalResult.missingInfo.length > 0
            ? evalResult.missingInfo
            : ['Could not find relevant information. Please provide more specific details.'],
        },
        next: 'clarify',
      };
    }

    // Have some findings but not fully confident — report what we have
    return {
      state: {
        ...state,
        goalMet: false,
        confidence: evalResult.confidence,
        missingInfo: evalResult.missingInfo,
      },
      next: 'report',
    };
  },
};
