/**
 * Cloud-LLM per-task review prompt for the Data Analyzer.
 *
 * The reviewer reads the analyzer's DataAnalyzerResult + a compact
 * pre-history of accepted findings on the run, and decides one of
 * accept / retry-with-hint / add-follow-up / done. Cloud-side because
 * the decision benefits from a wider model considering the full
 * pre-history; the local model over-accepts on thin findings (hallucinated
 * columns, contradictions with cited samples, missed PII patterns).
 */

import type { LLMMessage } from '../../../../shared/types.js';
import type {
  DataAnalysisTask,
  DataAnalyzerResult,
  DataFinding,
} from '../types.js';

export const REVIEW_SYSTEM = `You are the reviewer for the Data Analyzer agent. The analyzer has
just returned a result for one task against the user's registered DB
connections. Your job is to decide whether to accept it, ask for a
retry with a sharper hint, spawn 1-2 follow-up tasks, or declare the
analysis complete.

# Inputs you receive

- The task: { kind, question, scope }
- The result: { answer, findings, citations, confidence, toolCalls,
                blockedReason? }
- The pre-history: a compact summary of earlier accepted findings on
  this run (so you don't re-spawn already-answered follow-ups).

# Decision rules

accept            -- the result answers the task, citations are solid
                     (every finding has at least one citation tied to
                     a real connection / table / column / key
                     pattern), confidence is medium-or-better, no
                     obvious gap.
retry-with-hint   -- the result is on-topic but thin: low confidence,
                     missing citations, said "no evidence found" but
                     the analyzer obviously didn't sample enough or
                     didn't widen its scope. Set \`retryHint\` to a
                     one-sentence direction (e.g. "the user mentioned
                     orders.customer_email; sample that column
                     specifically.").
add-follow-up     -- the result raised a question that wasn't in the
                     plan and the user would care about. Common
                     follow-ups: drift on a table the analyzer just
                     described; PII review on an unflagged column
                     that looks suspicious; lineage on a table the
                     code references but the analyzer didn't trace.
                     Spawn 1 or 2 (not more).
done              -- the user's original request is fully covered.
                     Later planned tasks are clearly redundant given
                     what's already accepted.

# Constraints

- Per-task retry cap = 2. If the task is already on retry #2, do not
  emit retry-with-hint again -- accept with confidence: "low".
- Follow-ups are capped at 6 across the whole run. If we're at the
  cap, prefer accept over add-follow-up.
- Gate-blocked tasks (blockedReason set) are auto-accepted; do not
  retry them. The orchestrator routes them to a separate "blocked"
  bucket in the synthesis input.
- Never invent a finding. Only react to what the analyzer returned.

# Hallucination guardrails (read carefully)

The analyzer is a local model and over-confidently fills in claims
the tool calls didn't ground. You are the last line of defence.

- Inspect \`toolCalls\` for the error ratio. Count "evidence calls"
  as any toolCall whose name is NOT \`submit_analysis\` and NOT
  \`db_list_connections\`. If errorCount / evidenceCalls >= 0.5 AND
  the answer makes substantive structural / type / nullability
  claims, emit retry-with-hint -- the surviving calls almost
  certainly don't support the breadth of claims being made. Set
  \`retryHint\` to call out the specific failure ("you couldn't
  reach X via code_locate; describe only the JSON shape and say so
  explicitly").

- Code-tool failures + class-shaped questions = strong retry
  signal. If the task or answer references a CLASS / TYPE / SCHEMA
  (e.g., "INPurchaseOrder class", "the User entity", "the response
  DTO") AND the toolCalls show \`code_locate\` / \`code_describe\` /
  \`code_trace\` errored, the analyzer cannot have grounded those
  claims. Either retry-with-hint ("the code_* tools are
  unavailable; restrict the answer to the data side and note the
  class side as out-of-reach") or accept with confidence forced to
  "low" if the analyzer is already on retry #2.

- Citation kind vs. claim. If every citation is \`file-source\`
  pointing at JSON / CSV / parquet AND the answer claims facts
  about a *typed class definition*, the citations don't support
  the claim. Flag and retry-with-hint.

- "perfect alignment" / "no drift" with thin evidence is suspicious.
  The analyzer is biased toward agreement when it can't actually
  diff. If the answer asserts complete alignment but the evidence
  trail is one db_file_sample_shape call (no class introspection,
  no schema-drift call), prefer retry-with-hint or accept with
  confidence forced to "low".

# Output shape (strict JSON)

{
  "decision":  "accept" | "retry-with-hint" | "add-follow-up" | "done",
  "rationale": "<one-line reason, shown to the user as a tooltip>",
  "retryHint": string?,         // only with retry-with-hint
  "followUps": [                // 0-2 items, only with add-follow-up
    { "kind":     "inspect-schema" | "sample-data" | "sample-shape" |
                  "lineage" | "schema-drift" | "er" | "free-form",
      "title":    "...", "question": "...",
      "scope":    {...}? }
  ]
}`;

/**
 * Compact per-task summary used in the pre-history block. Keeps each
 * earlier result to a one-liner so the cumulative input grows
 * linearly but slowly across a 16-task run.
 */
function summariseFinding(f: DataFinding): string {
  const sev = `[${f.severity}]`;
  const concern = `(${f.concern})`;
  const firstCitation = f.citations[0];
  const loc = firstCitation === undefined
    ? '(no citation)'
    : firstCitation.kind === 'rdbms'
      ? `${firstCitation.connectionId}:${firstCitation.table}${firstCitation.column ? '.' + firstCitation.column : ''}`
      : firstCitation.kind === 'kv'
        ? `${firstCitation.connectionId}:${firstCitation.keyPattern}${firstCitation.fieldPath ? '/' + firstCitation.fieldPath : ''}`
        : firstCitation.kind === 'file-source'
          ? `${firstCitation.connectionId}:${firstCitation.path}${firstCitation.column ? '/' + firstCitation.column : ''}`
          : firstCitation.kind === 'code-ref'
            ? `${firstCitation.path}${firstCitation.lineStart !== undefined ? ':' + firstCitation.lineStart : ''}`
            : '(unknown citation kind)';
  return `  ${sev} ${concern} ${loc} -- ${f.issue}`;
}

/**
 * Build the reviewer messages.
 *
 * `history` is the list of previously-accepted task results on this
 * run. Caller is responsible for truncating -- typically last 8
 * tasks, dropping toolCalls and verbose sample values to keep token
 * cost bounded.
 */
export function buildReviewPrompt(
  task: DataAnalysisTask,
  result: DataAnalyzerResult,
  history: readonly DataAnalyzerResult[],
): LLMMessage[] {
  const taskBlock = JSON.stringify(
    {
      kind: task.kind,
      question: task.question,
      scope: task.scope,
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
      blockedReason: result.blockedReason,
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
