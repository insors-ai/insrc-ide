/**
 * Relevance scorer for prior-turn artefacts
 * (conversation-flow-refinement.md Phase 3.1).
 *
 * Pure function: takes Lance ANN hits + the current resolved intent
 * + a clock + weights, returns the same hits sorted desc by a
 * weighted relevance score:
 *
 *     score = w_intent   * intentMatch
 *           + w_semantic * (1 - normalisedDistance)
 *           + w_recency  * exp(-ageSeconds / TAU)
 *
 * The intent term is *graded*, not boolean: same-intent gets 1.0,
 * a known-correlated cross-intent pair gets 0.5, unrelated gets 0.
 * Cross-intent correlation is the Phase 5 piece -- it lives in this
 * file as the data is co-located with the math.
 *
 * Defaults are tunable but not session-specific (per-session weight
 * overrides aren't useful -- the user can't reason about them).
 */

import type { ArtifactVecHit } from '../../db/lance/artifact-vec.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export interface RelevanceWeights {
	readonly intent:   number;   // 0..1; unweighted contribution if =1
	readonly semantic: number;
	readonly recency:  number;
}

/**
 * Half-life-style decay for the recency term:
 *   exp(-age_seconds / TAU)
 * - age 0     -> 1.0
 * - age TAU   -> ~0.37
 * - age 2*TAU -> ~0.14
 * 30 minutes is a comfortable default for chat sessions: a turn
 * 30 min ago decays to ~0.37 contribution; an hour ago to ~0.14.
 */
export const DEFAULT_TAU_SECONDS = 60 * 30;

export const DEFAULT_WEIGHTS: RelevanceWeights = {
	intent:   0.3,
	semantic: 0.5,
	recency:  0.2,
};

/**
 * Lance L2 distances are unbounded above. We normalise to [0, 1]
 * via 1/(1+d) -- monotonic, smooth, and behaves well for small d
 * (0 -> 1, 0.5 -> 0.667, 1 -> 0.5, 2 -> 0.333). The semantic term
 * uses the normalised similarity = 1 - normalisedDistance =
 * d / (1+d), which is also in [0, 1]. The literal cosine isn't
 * available without un-normalising the embedding metric, but for
 * relative ranking the monotonic transform is sufficient.
 */
function normalisedSimilarity(distance: number): number {
	if (!Number.isFinite(distance) || distance < 0) return 0;
	return 1 / (1 + distance);
}

// ---------------------------------------------------------------------------
// Cross-intent correlation table (also Phase 5)
// ---------------------------------------------------------------------------

const CORRELATED_INTENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
	// Code <-> Data: schemas in code reference DB tables; data analyses
	// often need code-side ORM context.
	['code-analysis', 'data-analysis'],

	// Code <-> Debug: a debug session usually drills into prior
	// code-analysis findings.
	['code-analysis', 'debug'],

	// Code <-> Test: tests cite the entities code-analysis surfaced.
	['code-analysis', 'test'],

	// Code <-> Document / Review: same dependency direction.
	['code-analysis', 'document'],
	['code-analysis', 'review'],

	// Data <-> Debug: debugging a data-pipeline error.
	['data-analysis', 'debug'],

	// Implementation tasks build on prior plan / design.
	['plan',         'implement'],
	['design',       'implement'],
	['requirements', 'design'],
	['design',       'plan'],
];

const CORRELATED_INTENT_INDEX: ReadonlyMap<string, ReadonlySet<string>> = (() => {
	const out = new Map<string, Set<string>>();
	for (const [a, b] of CORRELATED_INTENT_PAIRS) {
		(out.get(a) ?? out.set(a, new Set()).get(a))!.add(b);
		(out.get(b) ?? out.set(b, new Set()).get(b))!.add(a);
	}
	return out;
})();

export function intentMatchScore(artifactIntent: string, currentIntent: string): number {
	if (artifactIntent === currentIntent) return 1;
	const correlated = CORRELATED_INTENT_INDEX.get(currentIntent);
	if (correlated !== undefined && correlated.has(artifactIntent)) return 0.5;
	return 0;
}

// ---------------------------------------------------------------------------
// Recency
// ---------------------------------------------------------------------------

export function recencyScore(artifactTimestampMs: bigint, nowMs: number, tauSeconds: number = DEFAULT_TAU_SECONDS): number {
	const ts = Number(artifactTimestampMs);
	if (!Number.isFinite(ts) || ts <= 0) return 0;
	const ageSeconds = Math.max(0, (nowMs - ts) / 1000);
	return Math.exp(-ageSeconds / tauSeconds);
}

// ---------------------------------------------------------------------------
// Public scoring API
// ---------------------------------------------------------------------------

export interface ScoredArtifact extends ArtifactVecHit {
	/** 0 (unrelated) | 0.5 (correlated cross-intent) | 1 (same intent). */
	readonly intentMatch: number;
	/** 0..1; 1 - normalised(distance). */
	readonly semantic:    number;
	/** 0..1; exp(-age / TAU). */
	readonly recency:     number;
	/** Weighted sum, 0..1 (clamped). */
	readonly score:       number;
}

/**
 * Score + sort artefacts by relevance to the current intent.
 *
 * Inputs:
 *   - `hits`            -- the raw Lance ANN result set (already
 *                          sorted by distance ascending; this
 *                          function re-sorts by composite score).
 *   - `currentIntent`   -- the intent the resolver returned for
 *                          this turn.
 *   - `nowMs`           -- clock injection (testability; production
 *                          callers pass `Date.now()`).
 *   - `weights`         -- override the defaults if you want.
 *   - `tauSeconds`      -- override the recency half-life.
 *
 * Returns: same hits, scored, sorted desc by `score`. Never mutates.
 */
export function scoreArtifacts(
	hits: readonly ArtifactVecHit[],
	currentIntent: string,
	nowMs: number,
	weights: RelevanceWeights = DEFAULT_WEIGHTS,
	tauSeconds: number = DEFAULT_TAU_SECONDS,
): ScoredArtifact[] {
	const out: ScoredArtifact[] = [];
	for (const h of hits) {
		const intentMatch = intentMatchScore(h.intent, currentIntent);
		const semantic    = normalisedSimilarity(h.distance);
		const recency     = recencyScore(h.timestamp, nowMs, tauSeconds);
		const raw         = weights.intent * intentMatch
		                  + weights.semantic * semantic
		                  + weights.recency  * recency;
		const score       = clamp01(raw);
		out.push({ ...h, intentMatch, semantic, recency, score });
	}
	out.sort((a, b) => b.score - a.score);
	return out;
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _normalisedSimilarityForTest = normalisedSimilarity;
export const _CORRELATED_INTENT_PAIRS_FOR_TEST = CORRELATED_INTENT_PAIRS;
