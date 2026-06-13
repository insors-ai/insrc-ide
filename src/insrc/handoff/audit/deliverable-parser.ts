/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deliverable parser -- splits the agent's returned markdown into
 * section bodies and reports which required sections are missing or
 * empty / placeholder.
 *
 * Phase 2a Day 4. The judge (judge.ts) consumes this to map deliverable
 * shape onto an audit verdict.
 *
 * Section headers must be ATX-style `## <title>` (case-insensitive
 * match against the required title). The body is everything between
 * the header and the next `##`/`#` header or EOF, trimmed.
 *
 * "Empty or placeholder" detection covers:
 *   - empty body (whitespace only)
 *   - body == '<TODO>' (the deliverable-stub literal -- agent didn't
 *     fill the slot)
 *   - body == 'TODO' or 'TBD' alone
 */

export interface DeliverableParseResult {
	/** Map of normalised section title -> body text. */
	readonly sections:            Readonly<Record<string, string>>;
	/** Required section titles that didn't appear at all. */
	readonly missing:             readonly string[];
	/** Required section titles that appeared but have no real content. */
	readonly emptyOrPlaceholder:  readonly string[];
	/** All required sections present and non-empty. */
	readonly allRequiredFilled:   boolean;
}

const PLACEHOLDER_BODIES = new Set(['<TODO>', 'TODO', 'TBD']);

/**
 * Parse `deliverable` markdown and validate it against the required
 * section titles. Header matching is case-insensitive; the parser
 * normalises both required titles and discovered headers to lowercase
 * for comparison but reports MISSING with the caller-supplied casing.
 */
export function parseDeliverableMarkdown(
	deliverable:     string,
	requiredSections: readonly string[],
): DeliverableParseResult {
	const sections = extractSections(deliverable);
	const missing: string[] = [];
	const emptyOrPlaceholder: string[] = [];

	for (const required of requiredSections) {
		const body = sections[required.toLowerCase()];
		if (body === undefined) {
			missing.push(required);
			continue;
		}
		if (isPlaceholder(body)) {
			emptyOrPlaceholder.push(required);
		}
	}

	return {
		sections,
		missing,
		emptyOrPlaceholder,
		allRequiredFilled: missing.length === 0 && emptyOrPlaceholder.length === 0,
	};
}

function extractSections(md: string): Record<string, string> {
	const out: Record<string, string> = {};
	const lines = md.split('\n');
	let currentTitle: string | undefined;
	let buffer: string[] = [];

	for (const line of lines) {
		// Match `## Title` (NOT `#` or `###`+); the deliverable's section
		// headers are always level 2 per template stub.
		const m = /^##\s+(.+?)\s*$/.exec(line);
		if (m !== null) {
			if (currentTitle !== undefined) {
				out[currentTitle.toLowerCase()] = buffer.join('\n').trim();
			}
			currentTitle = m[1]!;
			buffer = [];
			continue;
		}
		if (currentTitle !== undefined) {
			buffer.push(line);
		}
	}
	if (currentTitle !== undefined) {
		out[currentTitle.toLowerCase()] = buffer.join('\n').trim();
	}
	return out;
}

function isPlaceholder(body: string): boolean {
	const trimmed = body.trim();
	if (trimmed.length === 0) return true;
	if (PLACEHOLDER_BODIES.has(trimmed)) return true;
	return false;
}
