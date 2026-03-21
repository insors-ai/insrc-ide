/**
 * Report step — synthesize findings into a coherent response.
 *
 * Takes all accumulated findings and produces a structured HTML response
 * streamed to the user.
 */

import type { AgentStep, StepResult, StepContext } from '../../../framework/types.js';
import type { ResearchState } from '../agent-state.js';
import { getLogger } from '../../../../shared/logger.js';

const log = getLogger('research-report');

const REPORT_SYSTEM = `You are writing a research report for a coding assistant.
Given the research goal, findings, and evaluation, write a clear, structured response in Markdown.

Format:
- Use ### for section headers
- Use \`\`\` code fences for code snippets (include file path and line numbers when available)
- Use bullet lists for findings
- Use **bold** for emphasis on key terms
- Reference file paths with \`path/to/file.ts\`
- If findings are partial, note what couldn't be determined and why
- Keep it concise -- answer the question directly, then provide supporting details
- Output Markdown only -- it will be converted to HTML automatically`;

export const reportStep: AgentStep<ResearchState> = {
  name: 'report',
  async run(state: ResearchState, ctx: StepContext): Promise<StepResult<ResearchState>> {

    ctx.progress('Writing research report...');

    const findingsText = state.findings.length > 0
      ? state.findings.map((f, i) =>
          `[${i + 1}] Source: ${f.source}\nContent: ${f.content}\nRelevance: ${f.relevance}`
        ).join('\n\n')
      : 'No findings were collected.';

    const clarificationsText = state.clarifications.length > 0
      ? '\nUser clarifications:\n' + state.clarifications.map(c => `Q: ${c.question}\nA: ${c.answer}`).join('\n')
      : '';

    const confidenceNote = !state.goalMet
      ? '\n\nNote: The research goal was not fully met. The response below is based on partial findings.'
      : '';

    const reportPrompt = `Research goal: ${state.plan.goal}
Approach taken: ${state.plan.approach}
Steps executed: ${state.plan.steps.filter(s => s.status === 'done').length}/${state.plan.steps.length}

Findings:
${findingsText}
${clarificationsText}
${confidenceNote}

Write a clear response that answers the user's original question.`;

    // Stream the report
    let reportText = '';
    const response = await ctx.providers.resolve('research', 'report').complete([
      { role: 'system', content: REPORT_SYSTEM },
      { role: 'user', content: reportPrompt },
    ], {
      maxTokens: 4096,
      onToken: (token: string) => {
        reportText += token;
        ctx.emit(token, true);
      },
    });

    // If no streaming, send the full text
    if (!reportText && response.text) {
      reportText = response.text;
      ctx.emit(response.text, true);
    }

    log.info({
      goalMet: state.goalMet,
      confidence: state.confidence,
      findings: state.findings.length,
      reportLen: reportText.length,
    }, 'research report generated');

    return { state, next: null };
  },
};
