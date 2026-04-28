/**
 * Stitcher for the multi-pass content generator
 * (plans/content-generator.md commit 2).
 *
 * Pure function -- no LLM calls. Composes the final markdown by
 * walking the outline in order, prepending each section's
 * `## <title>` heading, then the section's body (or a degraded
 * placeholder when the body is empty). Doc-level `# <title>` is
 * emitted only when the outline supplies one -- the caller's
 * synthesise prompt may already start with its own H1, in which
 * case it stays in `sections[0].body`.
 *
 * Per the plan: section body prompts must be told NOT to emit a
 * leading `# heading` of their own; the stitcher prepends one. If
 * the model ignores the rule and emits its own `## Title` line, we
 * leave it -- the doc will end up with two H2s. The caller's
 * sanitiser (e.g. `sanitizeMarkdownReport` in code-analyzer) can
 * defensively de-dup if needed.
 */

import type { OutlineResult, SectionPlan, SectionResult } from './types.js';

export function stitch(
	outline: OutlineResult,
	results: readonly SectionResult[],
): string {
	const lines: string[] = [];
	const docTitle = outline.title.trim();
	if (docTitle.length > 0) {
		lines.push(`# ${docTitle}`);
		lines.push('');
	}

	const byId = new Map(results.map(r => [r.id, r]));
	for (const section of outline.sections) {
		appendSection(lines, section, byId.get(section.id));
	}

	return lines.join('\n').replace(/\s+$/, '') + '\n';
}

function appendSection(
	lines: string[],
	section: SectionPlan,
	result: SectionResult | undefined,
): void {
	const heading = section.title.trim();
	lines.push(`## ${heading}`);
	lines.push('');

	if (result === undefined) {
		lines.push('_Section unable to render (missing result)._');
		lines.push('');
		return;
	}

	const body = result.body.trim();
	if (body.length === 0) {
		const note = result.note ? ` (${result.note})` : '';
		lines.push(`_Section unable to render${note}._`);
		lines.push('');
		return;
	}

	lines.push(body);
	if (result.fallback && result.note) {
		// Surface the degradation reason inline so the user knows the
		// section is partial. Italic + small visual weight.
		lines.push('');
		lines.push(`_Note: ${result.note}._`);
	}
	lines.push('');
}
