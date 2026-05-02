/**
 * Sampling-confidence helper (Phase 0.6 of
 * plans/analyzers/data-analyzer-skills.md).
 *
 * Single source of truth for the question "given that I sampled N
 * rows from a population of P (or unknown), how confident should I
 * be in this <estimator>?" Family-5 skills (quality / distribution /
 * dependency) consult this module so the confidence band on a
 * SkillResult is consistent across skills, not invented per-call.
 *
 * The thresholds below are heuristics, not rigorously-derived
 * statistical bounds. They reflect the "small / medium / large"
 * working rules common in exploratory analysis -- enough for an
 * LLM-driven analyzer to clamp confidence, not enough to claim
 * publication-grade rigour.
 *
 * No external statistical engine. The Family-5 skills push
 * computation to the engine (DuckDB / RDBMS) via the aggregate
 * primitives; this module is purely about reasoning over sample
 * sizes.
 */

export type Estimator =
	| 'mean'           // sample mean / sum / avg-of-numeric
	| 'percentile-p'   // p-th percentile (q1/q3/median/etc.)
	| 'normality'      // Shapiro-Wilk / Anderson-Darling / similar
	| 'correlation';   // Pearson / Spearman pairwise

export type Confidence = 'high' | 'medium' | 'low';

/**
 * Recommended sample size for an estimator + desired confidence
 * interval (in [0, 1], e.g. 0.95). Returns ceil() of the underlying
 * formula; bounded to a sensible floor / ceiling so the answer is
 * always a usable integer.
 *
 * For finite populations, applies the standard finite-population
 * correction (FPC) so populations of 100 don't get told to sample
 * 384 rows.
 */
export function sampleSizeFor(
	estimator: Estimator,
	populationN: number | null,
	desiredCI: number,
): number {
	if (desiredCI <= 0 || desiredCI >= 1) {
		throw new Error(`sampleSizeFor: desiredCI must be in (0, 1), got ${desiredCI}`);
	}
	// Per-estimator base sample sizes (assume ~5% margin of error,
	// 0.5 proportion -- the standard worst-case Cochran target).
	// These map "desiredCI -> infinite-population sample size" via
	// well-known thresholds.
	const baseInfinite = baseSize(estimator, desiredCI);
	if (populationN === null || populationN <= 0) return baseInfinite;
	// Finite-population correction:
	//   n_adj = n / (1 + (n - 1) / N)
	const adjusted = baseInfinite / (1 + (baseInfinite - 1) / populationN);
	return Math.max(MIN_SIZE, Math.min(populationN, Math.ceil(adjusted)));
}

/**
 * Categorise an actual sample size against the recommended size for
 * the same estimator. Returns:
 *   high    -- actualN >= recommended size for desiredCI=0.95
 *   medium  -- actualN >= recommended size for desiredCI=0.80
 *   low     -- below the 0.80 threshold
 *
 * Never throws. Caller passes through to the skill's `confidence`
 * field so the registry can clamp downstream.
 */
export function confidenceFor(
	actualN: number,
	estimator: Estimator,
	populationN: number | null,
): Confidence {
	if (actualN <= 0) return 'low';
	const high   = sampleSizeFor(estimator, populationN, 0.95);
	const medium = sampleSizeFor(estimator, populationN, 0.80);
	if (actualN >= high)   return 'high';
	if (actualN >= medium) return 'medium';
	return 'low';
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Floor for any returned sample size. Even at small populations a
 *  sample of <10 doesn't tell you anything about a distribution. */
const MIN_SIZE = 10;

/**
 * Per-estimator threshold table. Indexed by desiredCI; we interpolate
 * for values between known points. The numbers come from the
 * standard rules:
 *   mean / percentile: Cochran formula at p=0.5 (worst case),
 *     ME = (1 - desiredCI) / 2 -> n = z^2 * 0.25 / ME^2
 *   normality (Shapiro-Wilk): require >=30 for medium, >=200 for high
 *   correlation: require >=30 for medium, >=384 for high (Cohen)
 */
function baseSize(estimator: Estimator, desiredCI: number): number {
	switch (estimator) {
		case 'mean':
		case 'percentile-p': {
			// z-score for two-tailed CI: 0.95 -> 1.96, 0.80 -> 1.28.
			// Margin of error tracks (1 - CI) / 2.
			const z = zForCI(desiredCI);
			const me = (1 - desiredCI) / 2;
			const n = (z * z * 0.25) / (me * me);
			return Math.max(MIN_SIZE, Math.ceil(n));
		}
		case 'normality': {
			// Shapiro-Wilk power is reasonable from ~30 onwards for
			// detecting moderate deviations; needs ~200 for tight CIs.
			if (desiredCI >= 0.95) return 200;
			if (desiredCI >= 0.80) return 30;
			return MIN_SIZE;
		}
		case 'correlation': {
			// Cohen's tables: 0.95 power detecting r=0.3 needs ~384.
			// Lower CIs need fewer samples to reach the same power.
			if (desiredCI >= 0.95) return 384;
			if (desiredCI >= 0.80) return 30;
			return MIN_SIZE;
		}
	}
}

/** Two-tailed z-score lookup. Linear interpolation between known
 *  pairs; out-of-range CIs clamp to the nearest known. */
function zForCI(ci: number): number {
	const TABLE: ReadonlyArray<readonly [number, number]> = [
		[0.50, 0.674],
		[0.80, 1.282],
		[0.90, 1.645],
		[0.95, 1.960],
		[0.99, 2.576],
	];
	if (ci <= TABLE[0]![0]) return TABLE[0]![1];
	if (ci >= TABLE[TABLE.length - 1]![0]) return TABLE[TABLE.length - 1]![1];
	for (let i = 1; i < TABLE.length; i++) {
		const [hi, hz] = TABLE[i]!;
		const [lo, lz] = TABLE[i - 1]!;
		if (ci <= hi) {
			const t = (ci - lo) / (hi - lo);
			return lz + t * (hz - lz);
		}
	}
	return 1.960;
}
