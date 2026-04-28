/**
 * Sanitize a synthesised markdown report before it lands in
 * `TodoList.body` / the Code Analysis Report Pane.
 *
 * Background (F11 in plans/analyzers/code-analyzer.md):
 *   The local synthesis model occasionally prefixes its output with a
 *   stray apostrophe / backtick / fence ("'# Title", "```markdown\n#
 *   Title\n```", etc.) even when the synthesise prompt forbids it.
 *   Pre-fix `afterSynthesise` wrote `completed.output` straight to
 *   `list.body` -- the Report Pane then failed to render the first
 *   heading because line 1 started with a literal apostrophe before
 *   the `#`.
 *
 * The sanitizer is intentionally narrow:
 *   1. Trim leading / trailing whitespace.
 *   2. If the entire body is wrapped in a triple-backtick fence
 *      (optionally tagged `markdown` / `md`), unwrap it.
 *   3. If the very first non-whitespace character is one of `'` /
 *      `` ` `` / `"` AND it precedes a heading marker (`#`), drop
 *      it. Doesn't touch quote characters that legitimately appear
 *      mid-prose.
 *
 * Doesn't:
 *   - Lint the markdown structure.
 *   - Strip every quote / backtick (those have legitimate uses).
 *   - Try to "fix" malformed sections beyond the first-line case.
 *
 * Idempotent: sanitize(sanitize(x)) === sanitize(x).
 */

const FENCE_OPEN = /^```(?:markdown|md)?\s*\r?\n/;
const FENCE_CLOSE = /\r?\n\s*```\s*$/;
const STRAY_HEADING_PREFIX = /^[`'"]+(?=#)/;

export function sanitizeMarkdownReport(raw: string): string {
	let out = raw.trim();
	if (out.length === 0) {
		return '';
	}
	if (FENCE_OPEN.test(out) && FENCE_CLOSE.test(out)) {
		out = out.replace(FENCE_OPEN, '').replace(FENCE_CLOSE, '');
		out = out.trim();
	}
	out = out.replace(STRAY_HEADING_PREFIX, '');
	return out.trim();
}
