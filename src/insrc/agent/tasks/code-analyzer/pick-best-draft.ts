/**
 * Best-of-rounds picker for the 3-round write+patch loop
 * (Phase G of plans/code-analyzer-structured-review.md).
 *
 * Used ONLY when every round verdicted `needs-work`. When any round
 * verdicted `accept`, the orchestrator short-circuits to that round
 * before invoking the picker.
 *
 * Scoring is lexicographic. For each candidate we compute four
 * signals, in order of preference:
 *
 *   1. fixItemsAddressed -- how many `fix` work items from the
 *      PRECEDING round's review did this round's patch address?
 *      Correctness wins. Round 1 has no preceding round, so its
 *      fixItemsAddressed is always 0.
 *   2. citationCount -- inline `[label](path:...)` clickable links.
 *      More citations = denser concrete evidence.
 *   3. paragraphCount -- prose paragraphs (blank-line separated).
 *      More paragraphs = more coverage.
 *   4. textLength -- final tie-breaker.
 *
 * If a later round regressed on every signal (zero fix items
 * addressed, fewer citations, fewer paragraphs, shorter), it loses
 * to the earlier round even though the loop ran. This is what
 * defends against the "round 2 makes things worse" pattern observed
 * in the 2026-05-16 Hadoop run.
 */

import type { ReviewActionResult, ReviewWorkItem, WorkItemKind } from '../../content-gen/review-action.js';
import type { WorkItemStatus } from './apply-patches.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RoundCandidate {
	readonly round:    1 | 2 | 3;
	readonly markdown: string;
	readonly review:   ReviewActionResult;
	/** Present for patch rounds (2, 3). Carries the prior round's
	 *  work-items + how the patch loop scored them. Round 1 omits this. */
	readonly patch?:   {
		readonly priorWorkItems: readonly ReviewWorkItem[];
		readonly itemStatuses:   readonly WorkItemStatus[];
	};
}

export interface RoundScore {
	readonly round:               1 | 2 | 3;
	readonly fixItemsAddressed:   number;
	readonly citationCount:       number;
	readonly paragraphCount:      number;
	readonly textLength:          number;
}

export type ShipDecisionReason =
	| 'sole-candidate'
	| 'fix-items-addressed'
	| 'citation-count'
	| 'paragraph-count'
	| 'text-length';

export interface PickResult {
	readonly winnerIdx:           number;
	readonly winner:              RoundCandidate;
	readonly reason:              ShipDecisionReason;
	readonly scores:              readonly RoundScore[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function pickBestRound(candidates: readonly RoundCandidate[]): PickResult {
	if (candidates.length === 0) {
		throw new Error('pickBestRound: candidates must be non-empty');
	}

	const scores: RoundScore[] = candidates.map(scoreOne);
	if (candidates.length === 1) {
		return {
			winnerIdx: 0,
			winner:    candidates[0]!,
			reason:    'sole-candidate',
			scores,
		};
	}

	// Walk in order; for each later candidate, compare to running best.
	// Track which signal drove the choice so we can log it. We update
	// `reason` on every NON-tied comparison, whether the winner stays
	// or changes -- the reason explains why the current bestIdx beats
	// the candidate it was last compared against.
	let bestIdx: number = 0;
	let reason:  ShipDecisionReason = 'sole-candidate';
	for (let i = 1; i < candidates.length; i++) {
		const cmp = compareSignals(scores[i]!, scores[bestIdx]!);
		if (cmp.cmp < 0) {
			bestIdx = i;
			reason  = cmp.reason;
		} else if (cmp.cmp > 0) {
			reason  = cmp.reason;
		}
		// cmp === 0: full tie -- keep prior `reason`.
	}

	return {
		winnerIdx: bestIdx,
		winner:    candidates[bestIdx]!,
		reason,
		scores,
	};
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreOne(c: RoundCandidate): RoundScore {
	return {
		round:               c.round,
		fixItemsAddressed:   countFixItemsAddressed(c),
		citationCount:       countCitations(c.markdown),
		paragraphCount:      countParagraphs(c.markdown),
		textLength:          c.markdown.length,
	};
}

function countFixItemsAddressed(c: RoundCandidate): number {
	if (c.patch === undefined) return 0;
	let n = 0;
	for (const status of c.patch.itemStatuses) {
		if (status.status !== 'addressed') continue;
		const item = c.patch.priorWorkItems.find(w => w.id === status.id);
		if (item !== undefined && (item.kind as WorkItemKind) === 'fix') {
			n++;
		}
	}
	return n;
}

function countCitations(markdown: string): number {
	const matches = markdown.match(/\[[^\]]+\]\(path:[^)]+\)/g);
	return matches === null ? 0 : matches.length;
}

function countParagraphs(markdown: string): number {
	const trimmed = markdown.trim();
	if (trimmed.length === 0) return 0;
	return trimmed.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
}

// ---------------------------------------------------------------------------
// Lexicographic comparator
// ---------------------------------------------------------------------------

/**
 * Returns a negative number when `a` is strictly better than `b` along
 * the first signal that differs. Positive when worse. Zero on full tie.
 * `reason` names the signal that drove the result; meaningful only
 * when the comparison is not zero.
 */
function compareSignals(a: RoundScore, b: RoundScore): { cmp: number; reason: ShipDecisionReason } {
	if (a.fixItemsAddressed !== b.fixItemsAddressed) {
		return { cmp: b.fixItemsAddressed - a.fixItemsAddressed, reason: 'fix-items-addressed' };
	}
	if (a.citationCount !== b.citationCount) {
		return { cmp: b.citationCount - a.citationCount, reason: 'citation-count' };
	}
	if (a.paragraphCount !== b.paragraphCount) {
		return { cmp: b.paragraphCount - a.paragraphCount, reason: 'paragraph-count' };
	}
	return { cmp: b.textLength - a.textLength, reason: 'text-length' };
}

// G.3 buildSectionFooter was removed after run #3: reviewer misses
// (unaddressed work items, degraded reviews) are now only logged --
// not appended to the section markdown. The per-section log line +
// TodoList reviewRounds[] trace + chat-panel milestone carry the
// same info without polluting the report body.

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _scoreOneForTest         = scoreOne;
export const _compareSignalsForTest   = compareSignals;
export const _countCitationsForTest   = countCitations;
export const _countParagraphsForTest  = countParagraphs;
