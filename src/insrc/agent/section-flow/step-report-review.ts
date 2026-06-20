/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Final report review loop (planner-section-task-separation P4,
 * part 2 / Q7).
 *
 * Three-verdict structured output (distinct from per-root review in
 * P3.b and section review in P3.c):
 *
 *   accept            -- ship the report.
 *   revise-edits      -- whole-report rewrite, then final review.
 *   revise-structural -- a section contradicts another OR the scope
 *                        has a gap. ONE permitted per report. Caller-
 *                        supplied callback resolves either path
 *                        (re-run section reviews / append new TODOs);
 *                        report regenerates from the modified entries.
 *
 * Cap is 2 review cycles (Q7 sub-Q7c): the initial review + at most
 * one revise+re-review pair. Tighter than section review (cap 3)
 * because each cycle is more expensive (whole-report rewrite) and
 * most issues should already be caught at the section level.
 *
 * After cap, force-accept with a `report-review-exhausted` tail
 * block annotation so users see unresolved concerns rather than
 * silent shipment.
 *
 * Cost ceiling:
 *   Typical                 : 1 generate + 1 review (accept)        = 2 calls
 *   revise-edits path       : +1 rewrite + 1 review                 = 4 calls
 *   revise-structural path  : +structural-action + 1 generate + 1   = variable
 *                              review
 */

import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { WorkingMemoryEntry } from '../working-memory/types.js';
import type { TodoSpec } from './types.js';
import { assembleReport } from './step-report-assemble.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:report-review');

/** Q7 cap: at most 1 revise-and-re-review pair after the initial review. */
const REPORT_REVIEW_CYCLE_CAP = 1;

const MAX_REVIEW_TOKENS  = 1024;
const MAX_REVISE_TOKENS  = 16_384;

/**
 * Hard ceiling on `proposed_todos` the structural reviewer can request.
 * Q7 sub-Q7c: scope-gap payload appends at most 2 TODOs per report.
 */
const MAX_SCOPE_GAP_TODOS = 2;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StructuralReviseSectionContradiction {
	readonly kind:    'section-contradiction';
	readonly sectionIds: readonly string[];
	readonly reasoning:  string;
}

export interface StructuralReviseScopeGap {
	readonly kind:           'scope-gap';
	readonly proposedTodos:  readonly TodoSpec[];
	readonly reasoning:      string;
}

export type StructuralRevise =
	| StructuralReviseSectionContradiction
	| StructuralReviseScopeGap;

/**
 * Caller-supplied resolver for a section-contradiction structural
 * revise. The caller re-runs section reviews for the named sections
 * and returns the (possibly updated) entries. Returning the same
 * entries is allowed (e.g. the re-review accepted as-is).
 */
export type SectionContradictionResolver = (input: {
	readonly sectionIds: readonly string[];
	readonly entries:    readonly WorkingMemoryEntry[];
}) => Promise<readonly WorkingMemoryEntry[]>;

/**
 * Caller-supplied resolver for a scope-gap structural revise. The
 * caller runs the proposed TODOs through the TODO orchestrator
 * (P3.d) and returns NEW entries for them. They are APPENDED to the
 * existing investigation plan -- caller does NOT replace earlier
 * entries.
 */
export type ScopeGapResolver = (input: {
	readonly proposedTodos: readonly TodoSpec[];
}) => Promise<readonly WorkingMemoryEntry[]>;

export interface ReportReviewInput {
	readonly question: string;
	readonly entries:  readonly WorkingMemoryEntry[];
	readonly provider: LLMProvider;
	/**
	 * When omitted, a `section-contradiction` verdict is treated as
	 * "noted, ship as-is" -- the caller probably can't resolve it
	 * structurally.
	 */
	readonly resolveSectionContradiction?: SectionContradictionResolver | undefined;
	/**
	 * When omitted, a `scope-gap` verdict is treated as "noted, ship
	 * as-is".
	 */
	readonly resolveScopeGap?: ScopeGapResolver | undefined;
}

export interface ReportReviewResult {
	readonly finalReport:            string;
	readonly cyclesConsumed:         number;
	readonly exhausted:              boolean;
	readonly structuralReviseUsed:   boolean;
	readonly structuralRevisePayload?: StructuralRevise | undefined;
	readonly addedScopeGapTodos:     readonly TodoSpec[];
	readonly entries:                readonly WorkingMemoryEntry[];
}

// ---------------------------------------------------------------------------
// Orchestrator entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the report assembly + review loop. Returns the final report
 * markdown plus the final entries (which may differ from the input
 * if a scope-gap structural revise appended new TODOs).
 *
 * One structural revise is permitted per report (Q7's "ONE per
 * report" rule). Subsequent structural-revise verdicts force-accept
 * with the exhausted annotation.
 */
export async function runReportReview(input: ReportReviewInput): Promise<ReportReviewResult> {
	let entries = input.entries;
	let assembled = await assembleReport({ question: input.question, entries, provider: input.provider });
	let candidate = assembled.report;
	let cyclesConsumed = 0;
	let structuralReviseUsed = false;
	let structuralRevisePayload: StructuralRevise | undefined;
	const addedScopeGapTodos: TodoSpec[] = [];

	let review = await reviewReportOnce(input, candidate, cyclesConsumed);

	while (true) {
		if (review.verdict === 'accept') {
			log.info({ cyclesConsumed, structuralReviseUsed }, 'report review: accepted');
			return finalize({
				finalReport:            candidate,
				cyclesConsumed,
				exhausted:              false,
				structuralReviseUsed,
				structuralRevisePayload,
				addedScopeGapTodos,
				entries,
			});
		}

		// Beyond the cap -> force-accept with annotation.
		if (cyclesConsumed >= REPORT_REVIEW_CYCLE_CAP) {
			log.warn({ cyclesConsumed, lastVerdict: review.verdict }, 'report review: cap exhausted; force-accepting with annotation');
			return finalize({
				finalReport:            appendExhaustedAnnotation(candidate, review),
				cyclesConsumed,
				exhausted:              true,
				structuralReviseUsed,
				structuralRevisePayload,
				addedScopeGapTodos,
				entries,
			});
		}

		if (review.verdict === 'revise-edits') {
			log.info({ cyclesConsumed: cyclesConsumed + 1, edits: review.edits?.slice(0, 120) ?? '' }, 'report review: revise-edits -> rewriting');
			candidate = await reviseReport(input.question, candidate, review.edits ?? '(no specific edits provided)', input.provider);
			cyclesConsumed += 1;
			review = await reviewReportOnce(input, candidate, cyclesConsumed);
			continue;
		}

		// revise-structural
		if (structuralReviseUsed) {
			// Already used the one allowed structural revise this report.
			// Force-accept with annotation rather than thrashing.
			log.warn({ cyclesConsumed }, 'report review: second revise-structural rejected (one-per-report cap); force-accepting');
			return finalize({
				finalReport:            appendExhaustedAnnotation(candidate, review),
				cyclesConsumed,
				exhausted:              true,
				structuralReviseUsed,
				structuralRevisePayload,
				addedScopeGapTodos,
				entries,
			});
		}

		structuralReviseUsed = true;
		structuralRevisePayload = review.structural;

		if (review.structural?.kind === 'section-contradiction') {
			const ids = review.structural.sectionIds;
			log.info({ sectionIds: ids, reasoning: review.structural.reasoning }, 'report review: revise-structural section-contradiction');
			if (input.resolveSectionContradiction !== undefined) {
				entries = await input.resolveSectionContradiction({ sectionIds: ids, entries });
			} else {
				log.warn('section-contradiction resolver not supplied -> entries unchanged');
			}
		} else if (review.structural?.kind === 'scope-gap') {
			const proposed = review.structural.proposedTodos.slice(0, MAX_SCOPE_GAP_TODOS);
			log.info({ proposedCount: proposed.length, reasoning: review.structural.reasoning }, 'report review: revise-structural scope-gap');
			if (input.resolveScopeGap !== undefined && proposed.length > 0) {
				const newEntries = await input.resolveScopeGap({ proposedTodos: proposed });
				entries = [...entries, ...newEntries];
				addedScopeGapTodos.push(...proposed);
			} else {
				log.warn('scope-gap resolver not supplied or no proposals -> entries unchanged');
			}
		} else {
			log.warn({ payload: review.structural }, 'revise-structural verdict without recognisable payload; skipping');
		}

		// Regenerate after structural change.
		assembled = await assembleReport({ question: input.question, entries, provider: input.provider });
		candidate = assembled.report;
		cyclesConsumed += 1;
		review = await reviewReportOnce(input, candidate, cyclesConsumed);
	}
}

function finalize(result: Omit<ReportReviewResult, 'structuralRevisePayload'> & { structuralRevisePayload?: StructuralRevise | undefined }): ReportReviewResult {
	return result.structuralRevisePayload === undefined
		? { ...result, structuralRevisePayload: undefined }
		: { ...result, structuralRevisePayload: result.structuralRevisePayload };
}

// ---------------------------------------------------------------------------
// Review LLM call
// ---------------------------------------------------------------------------

interface ReviewParsed {
	readonly verdict:    'accept' | 'revise-edits' | 'revise-structural';
	readonly reasoning?: string | undefined;
	readonly edits?:     string | undefined;
	readonly structural?: StructuralRevise | undefined;
}

const REVIEW_ROLE = [
	'You are the FINAL REPORT REVIEWER. You see the user question, the',
	'completed section markdown blocks the report was built from, and',
	'the assembled report markdown. Decide one of three verdicts:',
	'',
	'  accept            -- ship the report. It reads well, covers the',
	'                       question, and the sections are internally',
	'                       consistent.',
	'  revise-edits      -- presentation fixes only (intro, conclusion,',
	'                       transitions, factual citations). You return',
	'                       an `edits` string describing what to change.',
	'                       The orchestrator runs ONE rewrite and re-',
	'                       reviews.',
	'  revise-structural -- a section contradicts another OR the scope',
	'                       has a real gap. ONE permitted per report.',
	'                       Carries one of two payloads:',
	'                         section-contradiction: section IDs to re-',
	'                                                review',
	'                         scope-gap: at most 2 new TODOs to add to',
	'                                    the investigation plan',
	'',
	'Section regeneration alone cannot fix structural issues -- only use',
	'revise-structural when you genuinely cannot fix the problem with edits.',
	'',
	'You emit a SINGLE JSON object. No prose, no markdown fences.',
].join('\n');

async function reviewReportOnce(input: ReportReviewInput, candidate: string, cyclesConsumed: number): Promise<ReviewParsed> {
	const messages: LLMMessage[] = [
		{ role: 'system', content: REVIEW_ROLE },
		{ role: 'user',   content: buildReviewUser(input, candidate, cyclesConsumed) },
	];
	const parsed = await input.provider.completeStructured<unknown>(messages, REPORT_REVIEW_SCHEMA, {
		maxTokens:       MAX_REVIEW_TOKENS,
		temperature:     0,
		disableThinking: true,
	});
	return parseReview(parsed);
}

// plans/structured-output.md Phase C.5. Coarse JSON Schema for the
// wire-layer enforcement of the report-review response. App-level
// invariants (structural sub-shape, section-id membership) stay in
// `parseReview()` / `coerceStructural()`.
const REPORT_REVIEW_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['verdict'],
	additionalProperties: false,
	properties: {
		verdict:    { type: 'string', enum: ['accept', 'revise-edits', 'revise-structural'] },
		reasoning:  { type: 'string', maxLength: 2000 },
		edits:      { type: 'string', maxLength: 4000 },
		structural: { type: 'object' },
	},
};

function buildReviewUser(input: ReportReviewInput, candidate: string, cyclesConsumed: number): string {
	const sectionBlock = input.entries.map((e, i) =>
		`- section ${i + 1} (id: ${e.todoId}): ${e.objective}${e.findings.fallback === 'L2' ? ' [L2-fallback]' : ''}`,
	).join('\n');

	return [
		'## USER QUESTION',
		input.question,
		'',
		'## SECTIONS IN THE REPORT',
		sectionBlock,
		'',
		`## CYCLES CONSUMED: ${cyclesConsumed} / ${REPORT_REVIEW_CYCLE_CAP + 1}  (initial + ${REPORT_REVIEW_CYCLE_CAP} cycles)`,
		'',
		'## CANDIDATE REPORT MARKDOWN',
		candidate,
		'',
		'## OUTPUT SHAPE (emit EXACTLY this object)',
		'',
		'{',
		'  "verdict":   "accept" | "revise-edits" | "revise-structural",',
		'  "reasoning": "<one sentence>",',
		'  "edits":     "<natural-language description, REQUIRED for revise-edits>",',
		'  "structural": {',
		'    "kind":           "section-contradiction" | "scope-gap",',
		'    "sectionIds":     [<section IDs to re-review>],            // section-contradiction',
		'    "proposedTodos":  [{ "id": "...", "objective": "..." }],   // scope-gap, max 2',
		'    "reasoning":      "<one sentence>"',
		'  }',
		'}',
		'',
		'## TASK',
		'Emit the JSON verdict now. Begin with "{" and end with "}".',
	].join('\n');
}

function parseReview(parsed: unknown): ReviewParsed {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { verdict: 'accept', reasoning: 'review shape invalid -> accept' };
	}
	const obj = parsed as Record<string, unknown>;
	const verdictRaw = obj['verdict'];
	const verdict: ReviewParsed['verdict'] =
		verdictRaw === 'revise-edits' || verdictRaw === 'revise-structural' ? verdictRaw : 'accept';
	const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] : undefined;
	const edits     = typeof obj['edits']     === 'string' ? obj['edits']     : undefined;

	let structural: StructuralRevise | undefined;
	const structRaw = obj['structural'];
	if (structRaw !== null && typeof structRaw === 'object' && !Array.isArray(structRaw)) {
		structural = coerceStructural(structRaw as Record<string, unknown>);
	}

	return {
		verdict,
		...(reasoning  !== undefined ? { reasoning }  : {}),
		...(edits      !== undefined ? { edits }      : {}),
		...(structural !== undefined ? { structural } : {}),
	};
}

function coerceStructural(raw: Record<string, unknown>): StructuralRevise | undefined {
	const kindRaw = raw['kind'];
	const reasoning = typeof raw['reasoning'] === 'string' ? raw['reasoning'] : '';
	if (kindRaw === 'section-contradiction') {
		const idsRaw = raw['sectionIds'];
		if (!Array.isArray(idsRaw)) {
			return undefined;
		}
		const sectionIds = idsRaw.filter((s): s is string => typeof s === 'string' && s.length > 0);
		if (sectionIds.length === 0) {
			return undefined;
		}
		return { kind: 'section-contradiction', sectionIds, reasoning };
	}
	if (kindRaw === 'scope-gap') {
		const todosRaw = raw['proposedTodos'];
		if (!Array.isArray(todosRaw)) {
			return undefined;
		}
		const proposedTodos: TodoSpec[] = [];
		for (const t of todosRaw) {
			if (t === null || typeof t !== 'object' || Array.isArray(t)) {
				continue;
			}
			const r = t as Record<string, unknown>;
			const id        = typeof r['id']        === 'string' ? r['id'].trim()        : '';
			const objective = typeof r['objective'] === 'string' ? r['objective'].trim() : '';
			if (id === '' || objective === '') {
				continue;
			}
			proposedTodos.push({ id, objective, origin: 'report-review-escalation' });
		}
		if (proposedTodos.length === 0) {
			return undefined;
		}
		return { kind: 'scope-gap', proposedTodos, reasoning };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Revise LLM call
// ---------------------------------------------------------------------------

const REVISE_ROLE = [
	'You are the FINAL REPORT REVISER. You receive the current report',
	'markdown plus a natural-language `edits` description from the',
	'report reviewer. You emit the FULL revised report markdown -- no',
	'JSON envelope, no preamble, no commentary. Preserve the parts the',
	'edits do not call out.',
].join('\n');

async function reviseReport(
	question: string,
	current: string,
	edits: string,
	provider: LLMProvider,
): Promise<string> {
	const messages: LLMMessage[] = [
		{ role: 'system', content: REVISE_ROLE },
		{ role: 'user',   content: buildReviseUser(question, current, edits) },
	];
	const response = await provider.complete(messages, {
		maxTokens:       MAX_REVISE_TOKENS,
		temperature:     0,
		disableThinking: true,
	});
	const text = response.text.trim();
	if (text.length === 0) {
		log.warn('report revise: empty response; keeping current');
		return current;
	}
	return text;
}

function buildReviseUser(question: string, current: string, edits: string): string {
	return [
		'## USER QUESTION',
		question,
		'',
		'## CURRENT REPORT',
		current,
		'',
		'## REVIEWER EDITS',
		edits,
		'',
		'## TASK',
		'Emit the full revised report markdown now. No JSON envelope, no',
		'preamble, no commentary -- just the markdown.',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Exhausted annotation
// ---------------------------------------------------------------------------

function appendExhaustedAnnotation(report: string, lastReview: ReviewParsed): string {
	const reason = lastReview.reasoning ?? '(no reason supplied)';
	const verdict = lastReview.verdict;
	const tail = [
		'',
		'---',
		'',
		'## Review Notes',
		'',
		`This report shipped with \`report-review-exhausted\`. The final review`,
		`returned \`${verdict}\` after the per-report cycle cap was reached;`,
		`the orchestrator force-accepted with the following reviewer reasoning:`,
		'',
		`> ${reason}`,
		'',
		'<!-- section-flow: report-review-exhausted -->',
	].join('\n');
	return `${report}\n${tail}\n`;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _parseReviewForTest             = parseReview;
export const _coerceStructuralForTest        = coerceStructural;
export const _buildReviewUserForTest         = buildReviewUser;
export const _buildReviseUserForTest         = buildReviseUser;
export const _appendExhaustedAnnotationForTest = appendExhaustedAnnotation;
export const REPORT_REVIEW_CYCLE_CAP_VALUE     = REPORT_REVIEW_CYCLE_CAP;
export const MAX_SCOPE_GAP_TODOS_VALUE         = MAX_SCOPE_GAP_TODOS;
