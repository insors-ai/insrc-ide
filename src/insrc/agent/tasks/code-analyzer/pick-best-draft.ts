/**
 * Best-of-rounds picker for the 3-round write+patch loop
 * (Phase G of plans/code-analyzer-structured-review.md;
 *  rewritten under Phase P.9 after run #4 surfaced miscalls
 *  in the original lexicographic comparator).
 *
 * Used ONLY when no round verdicted a non-degraded `accept`. When a
 * round does, the orchestrator short-circuits before invoking the
 * picker.
 *
 * Scoring (P.9) is a weighted sum over four signals, each normalised
 * to [0, 1] against an ABSOLUTE target (not max-across-candidates):
 *
 *   weighted-items-addressed  (weight 4, target 10)
 *   citation-diversity        (weight 3, target 8 unique cited files)
 *   paragraph-count           (weight 2, target 6)
 *   text-length               (weight 1, target 3000 chars)
 *
 *   score = 4 * n(items) + 3 * n(cites) + 2 * n(paras) + 1 * n(len)
 *   // max possible: 10.0
 *
 * Items addressed uses inner weights so the picker can credit any
 * reviewer-flagged item the patch loop actually fixed -- not just
 * `fix` items as the original lexicographic comparator did:
 *
 *   fix     -> weight 3   (factual error; gates correctness)
 *   add     -> weight 2   (missing required topic)
 *   enhance -> weight 2   (correct but thin; most common reviewer ask)
 *   trim    -> weight 1   (mechanical deletion)
 *
 * Absolute normalization (vs max-across-candidates) is the key design
 * call. It means a round that hits "good enough" on a signal stops
 * earning extra credit there, letting the next-priority signal break
 * the tie. Run #4 sections 1 and 3 of the same retest miscalled the
 * picker under max-across-candidates because round 1's 13 citations
 * normalised to 1.0 while rounds 2/3's 8 cites normalised to 0.62 --
 * a 38% gap on a single citation difference. Under absolute targets
 * both 8 and 13 cap at 1.0 on citations, and the comparator falls
 * through to weighted-items-addressed where rounds 2/3 win.
 *
 * The shipDecisionReason is the SINGLE signal that contributed the
 * most points to the winner's total (its `weight * normalised` term).
 */

import type { ReviewActionResult, ReviewWorkItem, WorkItemKind } from '../../content-gen/review-action.js';
import type { WorkItemStatus } from './apply-patches.js';

// ---------------------------------------------------------------------------
// Tunable constants -- all in one place for easy adjustment
// ---------------------------------------------------------------------------

/** Signal weights. Higher = bigger contribution to the total score. */
const WEIGHTS = {
	weightedItemsAddressed: 4,
	citationDiversity:      3,
	paragraphCount:         2,
	textLength:             1,
} as const;

/**
 * Absolute targets. A round's normalised value for a signal =
 * min(raw / target, 1.0). Tuned to "what a healthy section produces"
 * rather than "what's possible". Reaching the target = full credit.
 */
const TARGETS = {
	weightedItemsAddressed: 10,   // ≈ 5 enhances (5*2) or 3 fixes + 1 enhance (3*3 + 2)
	citationDiversity:       8,   // 8 distinct cited files
	paragraphCount:          6,
	textLength:           3000,   // chars
} as const;

/** Inner weights for `weightedItemsAddressed`. */
const KIND_WEIGHTS: Record<WorkItemKind, number> = {
	fix:     3,
	add:     2,
	enhance: 2,
	trim:    1,
};

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
	readonly round:                   1 | 2 | 3;
	// Raw signals
	readonly weightedItemsAddressed:  number;
	readonly citationDiversity:       number;
	readonly paragraphCount:          number;
	readonly textLength:              number;
	// Normalised (0-1, capped at 1.0)
	readonly normalised: {
		readonly weightedItemsAddressed: number;
		readonly citationDiversity:      number;
		readonly paragraphCount:         number;
		readonly textLength:             number;
	};
	// Weighted contribution per signal (normalised * weight)
	readonly contribution: {
		readonly weightedItemsAddressed: number;
		readonly citationDiversity:      number;
		readonly paragraphCount:         number;
		readonly textLength:             number;
	};
	/** Sum of contributions; max possible = sum of WEIGHTS = 10. */
	readonly totalScore: number;
}

export type ShipDecisionReason =
	| 'sole-candidate'
	| 'weighted-items-addressed'
	| 'citation-diversity'
	| 'paragraph-count'
	| 'text-length'
	| 'tied';

export interface PickResult {
	readonly winnerIdx: number;
	readonly winner:    RoundCandidate;
	readonly reason:    ShipDecisionReason;
	readonly scores:    readonly RoundScore[];
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

	// Find the highest totalScore. Ties broken by lowest round number
	// (prefer earlier rounds when truly tied -- earlier rounds are the
	// most-evidenced baseline).
	let bestIdx = 0;
	for (let i = 1; i < scores.length; i++) {
		if (scores[i]!.totalScore > scores[bestIdx]!.totalScore) {
			bestIdx = i;
		}
	}

	// Determine the reason: the signal that contributed the most to
	// the winner's score. When totalScore is tied (full tie across all
	// signals), report 'tied' so the log makes the situation clear.
	const winner = scores[bestIdx]!;
	const allTied = scores.every(s => s.totalScore === winner.totalScore);
	let reason: ShipDecisionReason;
	if (allTied) {
		reason = 'tied';
	} else {
		const contribs = winner.contribution;
		const maxContrib = Math.max(
			contribs.weightedItemsAddressed,
			contribs.citationDiversity,
			contribs.paragraphCount,
			contribs.textLength,
		);
		reason =
			contribs.weightedItemsAddressed === maxContrib ? 'weighted-items-addressed' :
			contribs.citationDiversity      === maxContrib ? 'citation-diversity' :
			contribs.paragraphCount         === maxContrib ? 'paragraph-count' :
			                                                 'text-length';
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
	const weightedItemsAddressed = countWeightedItemsAddressed(c);
	const citationDiversity      = countCitationDiversity(c.markdown);
	const paragraphCount         = countParagraphs(c.markdown);
	const textLength             = c.markdown.length;

	const normalised = {
		weightedItemsAddressed: Math.min(weightedItemsAddressed / TARGETS.weightedItemsAddressed, 1.0),
		citationDiversity:      Math.min(citationDiversity      / TARGETS.citationDiversity,      1.0),
		paragraphCount:         Math.min(paragraphCount         / TARGETS.paragraphCount,         1.0),
		textLength:             Math.min(textLength             / TARGETS.textLength,             1.0),
	};
	const contribution = {
		weightedItemsAddressed: normalised.weightedItemsAddressed * WEIGHTS.weightedItemsAddressed,
		citationDiversity:      normalised.citationDiversity      * WEIGHTS.citationDiversity,
		paragraphCount:         normalised.paragraphCount         * WEIGHTS.paragraphCount,
		textLength:             normalised.textLength             * WEIGHTS.textLength,
	};
	const totalScore =
		contribution.weightedItemsAddressed +
		contribution.citationDiversity +
		contribution.paragraphCount +
		contribution.textLength;

	return {
		round:                  c.round,
		weightedItemsAddressed,
		citationDiversity,
		paragraphCount,
		textLength,
		normalised,
		contribution,
		totalScore,
	};
}

/**
 * Phase P.9: count weighted items addressed (was fixItemsAddressed).
 * Sums KIND_WEIGHTS over every patch-status with status === 'addressed'.
 * Round 1 always scores 0 (no prior round to address).
 */
function countWeightedItemsAddressed(c: RoundCandidate): number {
	if (c.patch === undefined) return 0;
	let n = 0;
	for (const status of c.patch.itemStatuses) {
		if (status.status !== 'addressed') continue;
		const item = c.patch.priorWorkItems.find(w => w.id === status.id);
		if (item === undefined) continue;
		n += KIND_WEIGHTS[item.kind as WorkItemKind] ?? 0;
	}
	return n;
}

/**
 * Phase P.9: citation DIVERSITY (unique cited file paths), not raw
 * count. Two `[X](path:foo.ts#L1)` and `[Y](path:foo.ts#L50)` count
 * as one cited file; only distinct file paths boost the score. This
 * prevents inflating the signal via dense citations to the same trivial
 * file.
 */
function countCitationDiversity(markdown: string): number {
	const re = /\[[^\]]+\]\(path:([^)#]+)(?:#[^)]+)?\)/g;
	const seen = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown)) !== null) {
		seen.add(m[1]!);
	}
	return seen.size;
}

function countParagraphs(markdown: string): number {
	const trimmed = markdown.trim();
	if (trimmed.length === 0) return 0;
	return trimmed.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
}

// G.3 buildSectionFooter was removed after run #3: reviewer misses
// (unaddressed work items, degraded reviews) are now only logged --
// not appended to the section markdown. The per-section log line +
// TodoList reviewRounds[] trace + chat-panel milestone carry the
// same info without polluting the report body.

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _scoreOneForTest                    = scoreOne;
export const _countWeightedItemsAddressedForTest = countWeightedItemsAddressed;
export const _countCitationDiversityForTest      = countCitationDiversity;
export const _countParagraphsForTest             = countParagraphs;
export const _WEIGHTS                            = WEIGHTS;
export const _TARGETS                            = TARGETS;
export const _KIND_WEIGHTS                       = KIND_WEIGHTS;
