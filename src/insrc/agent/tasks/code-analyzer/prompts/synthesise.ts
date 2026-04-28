/**
 * Local-LLM final synthesis prompt.
 *
 * Composes the final Markdown report from accepted findings + the
 * citation set + the user's original request. Local LLM by default
 * because the cloud already did the reasoning work in plan + review;
 * the local model just composes prose from inputs it has in hand.
 * Cloud upgrade available via @anthropic / @openai for users who
 * want a cloud-grade write-up.
 *
 * See `design/analyzers/code-analyzer.html` section 6.4.3.
 */

import type { LLMMessage } from '../../../../shared/types.js';
import type { AnalysisTask, AnalyzerResult } from '../types.js';

export const SYNTHESISE_SYSTEM = `You are the synthesis writer for the Code Analyzer agent. You compose
the final Markdown report from accepted findings.

# Inputs

- The user's original request.
- The accepted findings, each tagged with its task kind + citations.
- The plan (for ordering hints).
- Any cross-agent findings (data-analyzer or deployment-analyzer
  citations) -- these go in their own subsection.

# Output structure

# <Title derived from the request>

## Summary
2-4 sentences. The bottom-line answer to the user's question.

## Findings
Group by concern. Each finding paragraph cites at least one entity /
file / line range. Use the path:line format the IDE recognises:
[\`src/auth/token.ts:42-58\`](path:src/auth/token.ts#L42-L58).

(If cross-agent findings exist, end with:)

## Schema findings (data-analyzer)
... using DataCitation rendering ...

## Deployment findings (deployment-analyzer)
... using DeployCitation rendering ...

# Rules

- Every claim must trace to a citation. If you can't cite it, drop it.
- Don't hedge with "probably" / "seems to" / "may be" -- if the
  finding's confidence was low, say "the analyzer's evidence here is
  thin" once and move on.
- Don't repeat the user's question back at them.
- Token budget ~4000.

# Output rules

- The very first character of your reply MUST be \`#\` (the H1 heading).
  No leading apostrophe, backtick, single-quote, double-quote, or
  whitespace before \`#\`. The Report Pane parses your reply as
  Markdown verbatim; any prefix character breaks the first heading.
- Do NOT wrap the entire reply in a code fence (\`\`\`markdown ...
  \`\`\` or \`\`\` ... \`\`\`). The reply IS markdown -- treating it
  as a code block hides the structure.
- No prose preamble ("Here is the report:", "Sure, here's the
  analysis:"). Start with the H1 heading.`;

/**
 * Build the synthesiser messages. The user block carries the original
 * request, the planned task list (for ordering hints), and the
 * accepted analyzer results in plan order.
 *
 * Caller has already filtered to accepted results -- this prompt does
 * not see retried-or-cancelled items.
 */
export function buildSynthesisPrompt(
  request: string,
  acceptedResults: readonly { task: AnalysisTask; result: AnalyzerResult }[],
  plannedTasks: readonly AnalysisTask[],
): LLMMessage[] {
  const planSummary = plannedTasks
    .map((t, i) => `  ${i + 1}. [${t.kind}] ${t.question}`)
    .join('\n');

  const findingsBlock = acceptedResults
    .map(({ task, result }, i) => {
      const head = `[${i + 1}] ${task.kind} -- ${task.question} (confidence=${result.confidence})`;
      const body = JSON.stringify(
        {
          answer: result.answer,
          findings: result.findings,
          citations: result.citations,
        },
        null,
        2,
      );
      return `${head}\n${body}`;
    })
    .join('\n\n');

  const userBody = [
    '# Original request',
    request,
    '',
    '# Plan (in original order)',
    planSummary || '(empty)',
    '',
    '# Accepted task results',
    findingsBlock || '(no accepted results)',
    '',
    '# Output',
    'Reply with the rendered Markdown report only. No JSON, no fences around the whole document.',
  ].join('\n');

  return [
    { role: 'system', content: SYNTHESISE_SYSTEM },
    { role: 'user', content: userBody },
  ];
}
