/**
 * JSON extraction helpers shared across analyzer-style result parsers.
 *
 * Extracted from agent/tasks/code-analyzer/analyzer/result-parser.ts
 * (commit 2f0b5505b43) so the data-analyzer's per-task result parser
 * gets the same prose-preamble tolerance without copy-pasting the
 * helper.
 */

/**
 * Normalise the model's raw output into something `JSON.parse` will accept.
 *
 * Two cleanups, in order:
 * 1. Strip a leading/trailing markdown fence (```json ... ```), which
 *    qwen3-coder occasionally wraps even when told not to.
 * 2. Strip prose preamble + suffix by extracting the first `{` ... last
 *    `}` span. Live runs 2026-04-29 showed every analyzer call leading
 *    with conversational filler ("Let me read...", "Now let me...",
 *    "Excellent.") despite the system prompt's "no preamble" directive,
 *    falling into the unparseable -> retry path and doubling per-task
 *    latency. The model usually still emitted valid JSON immediately
 *    after the preamble; anchoring on outermost braces lets the first
 *    parse succeed instead of waiting for the retry.
 *
 * Caveat: this is naive about braces inside string literals -- e.g. an
 * `answer` field containing a literal `}` would extend the span past
 * the real end. JSON.parse catches the mismatch and the retry path
 * kicks in, same as before. The common case (preamble + clean JSON)
 * gets fixed; the pathological case is no worse than today.
 */
export function stripFences(text: string): string {
  let out = text;
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  const firstBrace = out.indexOf('{');
  const lastBrace = out.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    out = out.slice(firstBrace, lastBrace + 1);
  } else if (firstBrace > 0) {
    out = out.slice(firstBrace);
  }
  return out.trim();
}
