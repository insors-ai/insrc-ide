/**
 * Slot-value sanitiser.
 *
 * Every substitutable slot in an artifact template except the raw
 * diagram source (`@@SOURCE@@` for Mermaid kinds) and the pre-trusted
 * renderer script (`@@RENDERER_SCRIPT@@`) passes through here before
 * binding.
 *
 * Scope:
 *   - Escape the six HTML-significant characters so LLM-produced
 *     titles / metadata / provenance / legend strings can never inject
 *     new tags or attribute boundaries.
 *   - Remove anything that looks like a `javascript:` URL (paranoid
 *     belt over the templates' lint).
 *   - Strip ASCII control characters other than tab / newline.
 *
 * Mermaid source values get a narrower pass (`escapeMermaidSource`):
 * only `&`, `<`, `>` are escaped so the Mermaid runtime parses the raw
 * diagram text without HTML re-interpretation, while angle brackets
 * still can't break out of the <pre class="mermaid"> element. The
 * wireframe source (an SVG fragment produced by our own deterministic
 * generator) is trusted as-is.
 */

// ---------------------------------------------------------------------------
// Slot values (titles, metadata, provenance, legend HTML, etc.)
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Readonly<Record<string, string>> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
	'/': '&#47;',
};

const HTML_ESCAPE_RE = /[&<>"'/]/g;
const JS_URL_RE = /\bjavascript\s*:/gi;

/**
 * Control characters we strip before output: U+0000..U+0008, U+000B,
 * U+000C, U+000E..U+001F. TAB (U+0009) and LF (U+000A) are kept so
 * multi-line metadata values render readably. Regex built from a
 * string to keep the source ASCII-safe (no raw control bytes in the
 * file).
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = new RegExp(
	'[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]',
	'g',
);

/**
 * Escape a string for safe substitution into an HTML body or
 * attribute-value position. Strips control chars and neuters
 * javascript: URLs. Used for every slot except `@@SOURCE@@` (handled
 * by escapeMermaidSource below) and `@@RENDERER_SCRIPT@@` (trusted
 * bundled file, not user input).
 */
export function sanitiseSlotValue(value: string): string {
	return value
		.replace(CONTROL_CHAR_RE, '')
		.replace(JS_URL_RE, '')
		.replace(HTML_ESCAPE_RE, ch => HTML_ESCAPES[ch] ?? ch);
}

// ---------------------------------------------------------------------------
// Mermaid source -- narrow escape so the runtime reads the raw text.
// ---------------------------------------------------------------------------

const MERMAID_ESCAPES: Readonly<Record<string, string>> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
};
const MERMAID_ESCAPE_RE = /[&<>]/g;

/**
 * Escape Mermaid source for safe placement inside
 * `<pre class="mermaid">…</pre>`. Only `&`, `<`, `>` are touched so
 * Mermaid's parser sees the original diagram text; the three
 * replacements are enough to prevent angle-bracket breakout.
 */
export function escapeMermaidSource(source: string): string {
	return source.replace(MERMAID_ESCAPE_RE, ch => MERMAID_ESCAPES[ch] ?? ch);
}
