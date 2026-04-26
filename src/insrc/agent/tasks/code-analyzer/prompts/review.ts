/**
 * Cloud-LLM per-task review prompt.
 *
 * The reviewer reads the analyzer's AnalyzerResult + a compact
 * pre-history of accepted findings on the run, and decides one of
 * accept / retry-with-hint / add-follow-up / done. Cloud LLM because
 * the decision benefits from a wider model considering the full
 * pre-history; the local model can over-accept on thin findings.
 *
 * See `design/analyzers/code-analyzer.html` section 6.4.2.
 */

import type { LLMMessage } from '../../../../shared/types.js';
import type { AnalysisTask, AnalyzerResult, Finding } from '../types.js';

export const REVIEW_SYSTEM = `You are the reviewer for the Code Analyzer agent. The analyzer has just
returned a result for one task. Your job is to decide whether to accept
it, ask for a retry with a sharper hint, spawn 1-2 follow-up tasks, or
declare the analysis complete.

# Inputs you receive

- The task: { kind, question, scope }
- The result: { answer, findings, citations, confidence, toolCalls }
- The pre-history: a compact summary of earlier accepted findings on
  this run (so you don't re-spawn already-answered follow-ups).

# Decision rules

accept            -- the result answers the task, citations are solid,
                     confidence is medium-or-better, no obvious gap.
retry-with-hint   -- the result is on-topic but thin (low confidence,
                     missing citations, said "no evidence found" but the
                     analyzer obviously didn't widen its search). Set
                     \`retryHint\` to a one-sentence direction the analyzer
                     should follow.
add-follow-up     -- the result raised a question that wasn't in the
                     plan and the user would care about. Spawn 1 or 2
                     follow-up tasks (not more) with \`kind\` + \`question\`.
done              -- the user's original request is fully covered. Use
                     this when later planned tasks are clearly redundant
                     given what's already accepted.

# Constraints

- Per-task retry cap = 2. If the task is already on retry #2, do not
  emit retry-with-hint again -- accept with confidence: "low".
- Follow-ups are capped at 8 across the whole run. If we're at the cap,
  prefer accept over add-follow-up.
- Never invent a finding. Only react to what the analyzer returned.

# Output shape (strict JSON)

{
  "decision": "accept" | "retry-with-hint" | "add-follow-up" | "done",
  "rationale": "<one-line reason, shown to the user as a tooltip>",
  "retryHint": string?,         // only with retry-with-hint
  "followUps": [                // 0-2 items, only with add-follow-up
    { "kind": "...", "title": "...", "question": "...", "scope": {...}? }
  ]
}`;

/**
 * Compact per-task summary used in the pre-history block. Keeps each
 * earlier result to a one-liner so the cumulative input grows
 * linearly but slowly across a 16-task run.
 */
function summariseFinding(f: Finding): string {
  const sev = `[${f.severity}]`;
  const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
  return `  ${sev} ${loc} -- ${f.issue}`;
}

/**
 * Build the reviewer messages.
 *
 * `history` is the list of previously-accepted task results on this
 * run. Caller is responsible for truncating it -- typically last 8
 * tasks, dropping toolCalls and snippets to keep token cost bounded.
 */
export function buildReviewPrompt(
  task: AnalysisTask,
  result: AnalyzerResult,
  history: readonly AnalyzerResult[],
): LLMMessage[] {
  const taskBlock = JSON.stringify(
    {
      kind: task.kind,
      question: task.question,
      scope: task.scope,
      retryCount: task.retryCount,
      hint: task.hint,
    },
    null,
    2,
  );

  const resultBlock = JSON.stringify(
    {
      answer: result.answer,
      findings: result.findings,
      citations: result.citations,
      confidence: result.confidence,
      toolCalls: result.toolCalls.map(t => ({
        name: t.name,
        durationMs: t.durationMs,
        resultRows: t.resultRows,
        error: t.error,
      })),
      truncated: result.truncated,
    },
    null,
    2,
  );

  const historyBlock = history.length === 0
    ? '(no earlier findings on this run)'
    : history
        .flatMap((r, i) => {
          const head = `[earlier task ${i + 1}] confidence=${r.confidence}`;
          const lines = r.findings.map(summariseFinding);
          return [head, ...lines, ''];
        })
        .join('\n');

  const userBody = [
    '# Task',
    taskBlock,
    '',
    '# Analyzer result',
    resultBlock,
    '',
    '# Pre-history',
    historyBlock,
    '',
    '# Output',
    'Reply with the strict-JSON decision shape only. No prose, no fences.',
  ].join('\n');

  return [
    { role: 'system', content: REVIEW_SYSTEM },
    { role: 'user', content: userBody },
  ];
}
