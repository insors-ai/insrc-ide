/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Render a stored `artifact_vec.summary` row into prompt-ready text for
 * the synth + section-review stages.
 *
 * Two formats coexist in the column:
 *   - JSON-encoded `CitedStepSummary` (citation contract). Renders as
 *     a structured block: narrative, claims with cited spans, gap
 *     closures with verdict.
 *   - Plain-string legacy summaries (pre-citation contract). Returned
 *     as-is.
 *
 * Empty / unparseable rows fall back to a `(no summary)` placeholder
 * so downstream prompts never see undefined.
 */

import type { CitedStepSummary, CitedClaim, GapClosureClaim } from './citation-types.js';

const CLAIM_PER_LINE_CAP   = 6;     // most material per call -- avoid prompt bloat
const SPAN_PREVIEW_CHARS   = 160;   // truncate verbatim cite spans in prompt rendering

/**
 * Attempt to parse `row.summary` as JSON CitedStepSummary. Returns
 * undefined on any parse / shape mismatch -- callers should treat
 * the row.summary string as legacy plain text.
 */
export function tryParseCitedSummary(raw: string): CitedStepSummary | undefined {
	const trimmed = raw.trim();
	if (trimmed.length === 0)         { return undefined; }
	if (!trimmed.startsWith('{'))     { return undefined; }
	let parsed: unknown;
	try { parsed = JSON.parse(trimmed); } catch { return undefined; }
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { return undefined; }
	const obj = parsed as Record<string, unknown>;
	if (typeof obj['callId']     !== 'string') { return undefined; }
	if (typeof obj['artifactId'] !== 'string') { return undefined; }
	if (typeof obj['summary']    !== 'string') { return undefined; }
	if (!Array.isArray(obj['claims']))         { return undefined; }
	if (!Array.isArray(obj['gapClosures']))    { return undefined; }
	return obj as unknown as CitedStepSummary;
}

/**
 * Render a CitedStepSummary as prompt-ready text. Claims appear as
 * bulleted lines with their cited spans truncated to keep prompts
 * lean. Gap closures get their verdict + supporting claim.
 *
 * Used by `resolveStepSummaries` in the orchestrator before handing
 * to synth + section-review.
 */
export function renderCitedSummaryForPrompt(s: CitedStepSummary): string {
	const lines: string[] = [];
	lines.push(s.summary);
	if (s.claims.length > 0) {
		lines.push('  claims:');
		for (const c of s.claims.slice(0, CLAIM_PER_LINE_CAP)) {
			lines.push(`    - ${renderClaimLine(c)}`);
		}
		if (s.claims.length > CLAIM_PER_LINE_CAP) {
			lines.push(`    - ...(+ ${s.claims.length - CLAIM_PER_LINE_CAP} more cited claims)`);
		}
	}
	if (s.gapClosures.length > 0) {
		lines.push('  closures:');
		for (const c of s.gapClosures) {
			lines.push(`    - ${renderGapClosureLine(c)}`);
		}
	}
	return lines.join('\n');
}

function renderClaimLine(c: CitedClaim): string {
	const head = c.claim;
	const evidence = c.evidence === 'confirmed-null' ? '[confirmed-null]' : '[cited]';
	const countTag = c.countAssertion !== undefined ? ` (count=${c.countAssertion})` : '';
	const spans: string[] = [];
	for (const cit of c.citations.slice(0, 3)) {
		if (c.evidence === 'confirmed-null') { spans.push(`empty:${cit.artifactId.slice(-24)}`); }
		else {
			const span = cit.span.length > SPAN_PREVIEW_CHARS
				? `${cit.span.slice(0, SPAN_PREVIEW_CHARS - 3)}...`
				: cit.span;
			spans.push(`"${span.replace(/\s+/g, ' ').trim()}"`);
		}
	}
	const trailing = c.citations.length > 3 ? `, +${c.citations.length - 3} more` : '';
	return `${head} ${evidence}${countTag} <- ${spans.join('; ')}${trailing}`;
}

function renderGapClosureLine(c: GapClosureClaim): string {
	const verdictTag = c.verdict === 'closes'    ? 'CLOSES'
	                 : c.verdict === 'partially' ? 'PARTIALLY'
	                 : 'OFF-TOPIC';
	return `${verdictTag} ${c.gapId} -- ${c.claim}`;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _renderClaimLineForTest       = renderClaimLine;
export const _renderGapClosureLineForTest  = renderGapClosureLine;
