/**
 * Web search step — search the web and extract relevant information.
 *
 * Formulates search queries, fetches results, extracts relevant content.
 */

import type { AgentStep, StepResult, StepContext } from '../../../framework/types.js';
import type { ResearchState } from '../agent-state.js';
import { executeTool } from '../../../tools/executor.js';
import { getLogger } from '../../../../shared/logger.js';

const log = getLogger('research-web');

export const webSearchStep: AgentStep<ResearchState> = {
  name: 'web-search',
  async run(state: ResearchState, ctx: StepContext): Promise<StepResult<ResearchState>> {

    // Find web-search plan steps
    const webSteps = state.plan.steps.filter(s => s.action === 'web-search' && s.status === 'pending');
    if (webSteps.length === 0) {
      return { state, next: 'evaluate' };
    }

    for (const step of webSteps) {
      ctx.progress(`Web search: ${step.target.slice(0, 50)}`);

      try {
        // Search
        const toolResult = await executeTool({
          id: 'tc_web',
          name: 'WebSearch',
          input: { query: step.target, limit: 5 },
        });
        const searchResult = toolResult.content;

        log.info({ query: step.target, resultLen: searchResult.length }, 'web search complete');

        // Extract relevant content
        if (searchResult && searchResult.length > 100) {
          state.findings.push({
            source: `web: ${step.target}`,
            content: searchResult.slice(0, 4000),
            relevance: 'Web search results for research goal',
          });
        }

        step.status = 'done';
        step.result = `${searchResult.length} chars retrieved`;
      } catch (err) {
        log.warn({ query: step.target, error: (err as Error).message }, 'web search failed');
        step.status = 'failed';
        step.result = (err as Error).message;
      }
    }

    return {
      state: { ...state },
      next: 'investigate', // continue with remaining plan steps
    };
  },
};
