/**
 * data.quality.scorecard.rdbms -- Phase 5d.6 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Composite skill: rolls up the 5d atomic dimensions
 * (`quality.completeness.rdbms` + `quality.uniqueness.rdbms` + the
 * opt-in `quality.validity.rdbms` / `quality.conformity.rdbms` /
 * `quality.consistency.rdbms`) into a single typed scorecard.
 * Per-column composite quality + table overall + a top-issues digest;
 * cross-column consistency reported alongside as its own block.
 *
 * Weights are picked dynamically based on which dimensions the
 * caller opted into. Per-column composite weights:
 *
 *   base                     completeness=0.6, uniqueness=0.4
 *   + validity              completeness=0.5, uniqueness=0.3, validity=0.2
 *   + conformity            completeness=0.5, uniqueness=0.3,                  conformity=0.2
 *   + validity + conformity completeness=0.4, uniqueness=0.25, validity=0.175, conformity=0.175
 *
 * Repo-overridable weights via `~/.insrc/data-analyzer/scorecard.json`
 * remain a follow-up (per the plan's open-question table) once a real
 * user has a non-default rubric in mind.
 *
 * Consistency is cross-column by nature -- it doesn't sit in a
 * per-column composite. When `consistencyRules` is supplied, the skill
 * runs `quality.consistency.rdbms` once with the rule list and reports
 * per-rule satisfaction + an aggregate consistency score on the table-
 * level `consistency` block. Overall scorecard score still comes from
 * the mean of column composites; the consistency block is rendered
 * alongside.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface DimensionWeights {
	readonly completeness: number;
	readonly uniqueness:   number;
	readonly validity:     number;
	readonly conformity:   number;
}

// Four weight tables; pickWeights() selects by enabled dimensions.
const WEIGHTS_BASE:      DimensionWeights = { completeness: 0.6,  uniqueness: 0.4,  validity: 0.0,   conformity: 0.0   };
const WEIGHTS_VAL:       DimensionWeights = { completeness: 0.5,  uniqueness: 0.3,  validity: 0.2,   conformity: 0.0   };
const WEIGHTS_CONF:      DimensionWeights = { completeness: 0.5,  uniqueness: 0.3,  validity: 0.0,   conformity: 0.2   };
const WEIGHTS_VAL_CONF:  DimensionWeights = { completeness: 0.4,  uniqueness: 0.25, validity: 0.175, conformity: 0.175 };

function pickWeights(includeValidity: boolean, includeConformity: boolean): DimensionWeights {
	if (includeValidity && includeConformity) return WEIGHTS_VAL_CONF;
	if (includeValidity)                       return WEIGHTS_VAL;
	if (includeConformity)                     return WEIGHTS_CONF;
	return WEIGHTS_BASE;
}

const TOP_ISSUE_THRESHOLD = 0.7;
const TOP_ISSUE_LIMIT = 5;

interface ConsistencyRuleIn {
	readonly name: string;
	readonly leftColumn: string;
	readonly op: '<' | '<=' | '=' | '!=' | '>=' | '>' | 'and-not-null' | 'xor-null';
	readonly rightColumn: string;
}

interface QualityScorecardInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
	/**
	 * Optional regex map. When the caller supplies a pattern for a
	 * column, the scorecard runs `data.quality.validity.rdbms` on
	 * that column and folds the score into the composite. Columns
	 * absent from this map don't run validity (validity score
	 * stays null for them).
	 */
	readonly validityPatterns?: Readonly<Record<string, string>>;
	/**
	 * Optional format-slug map. When the caller supplies a format
	 * for a column (e.g. `{ phone: 'e164-phone', country: 'iso-
	 * country-2' }`), the scorecard runs `data.quality.conformity
	 * .rdbms` on that column and folds the conformity score into the
	 * composite. Columns absent from this map don't run conformity
	 * (conformity score stays null for them).
	 */
	readonly conformityRules?: Readonly<Record<string, string>>;
	/**
	 * Optional cross-column consistency rules. When supplied, the
	 * scorecard runs `data.quality.consistency.rdbms` ONCE with the
	 * full rule list and reports per-rule satisfaction in the
	 * top-level `consistency` block. Consistency is cross-column by
	 * nature so it does NOT participate in the per-column composite;
	 * it's reported alongside.
	 */
	readonly consistencyRules?: readonly ConsistencyRuleIn[];
}

interface DimensionStats {
	readonly score: number | null;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly nullRate: number | null;
}

interface UniquenessStats {
	readonly score: number | null;
	readonly distinctCount: number | null;
	readonly uniquenessRatio: number | null;
	readonly isPrimaryKeyCandidate: boolean;
}

interface ValidityStats {
	readonly score: number | null;
	readonly pattern: string | null;
	readonly matchCount: number | null;
	readonly mismatchCount: number | null;
	readonly sampleSize: number | null;
}

interface ConformityStats {
	readonly score: number | null;
	readonly format: string | null;          // best-fit format slug (or the requested one)
	readonly bestFormat: string | null;      // what conformity actually picked as best fit
	readonly sampleSize: number | null;
}

interface ColumnScorecard {
	readonly name: string;
	readonly completeness: DimensionStats;
	readonly uniqueness: UniquenessStats;
	readonly validity: ValidityStats;
	readonly conformity: ConformityStats;
	readonly compositeScore: number | null;
}

interface ScorecardIssue {
	readonly column: string;
	readonly dimension: 'completeness' | 'uniqueness' | 'validity' | 'conformity' | 'consistency' | 'composite';
	readonly score: number;
	readonly detail: string;
}

interface ConsistencyRuleSummary {
	readonly name: string;
	readonly leftColumn: string;
	readonly op: string;
	readonly rightColumn: string;
	readonly satisfactionRate: number | null;
	readonly satisfied: number;
	readonly violated: number;
	readonly inapplicable: number;
}

interface ConsistencyBlock {
	readonly rules: readonly ConsistencyRuleSummary[];
	readonly overallScore: number | null;       // mean of per-rule satisfactionRate (null entries skipped)
	readonly verdict: 'consistent' | 'mostly-consistent' | 'mixed' | 'broken' | 'inconclusive' | 'not-checked';
}

const EMPTY_CONSISTENCY: ConsistencyBlock = {
	rules: [],
	overallScore: null,
	verdict: 'not-checked',
};

interface QualityScorecardOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly weights: DimensionWeights;
	readonly columns: readonly ColumnScorecard[];
	readonly primaryKeyCandidates: readonly string[];
	readonly overallScore: number | null;
	readonly topIssues: readonly ScorecardIssue[];
	readonly consistency: ConsistencyBlock;       // never null; verdict='not-checked' when no rules supplied
	readonly truncated: boolean;
}

const COLUMN_SCHEMA = {
	type: 'object',
	properties: {
		name: { type: 'string' },
		completeness: {
			type: 'object',
			properties: {
				score:         { type: ['number', 'null'] },
				nonNullCount:  { type: ['number', 'null'] },
				nullCount:     { type: ['number', 'null'] },
				nullRate:      { type: ['number', 'null'] },
			},
			required: ['score', 'nonNullCount', 'nullCount', 'nullRate'],
			additionalProperties: false,
		},
		uniqueness: {
			type: 'object',
			properties: {
				score:                 { type: ['number', 'null'] },
				distinctCount:         { type: ['number', 'null'] },
				uniquenessRatio:       { type: ['number', 'null'] },
				isPrimaryKeyCandidate: { type: 'boolean' },
			},
			required: ['score', 'distinctCount', 'uniquenessRatio', 'isPrimaryKeyCandidate'],
			additionalProperties: false,
		},
		validity: {
			type: 'object',
			properties: {
				score:         { type: ['number', 'null'] },
				pattern:       { type: ['string', 'null'] },
				matchCount:    { type: ['number', 'null'] },
				mismatchCount: { type: ['number', 'null'] },
				sampleSize:    { type: ['number', 'null'] },
			},
			required: ['score', 'pattern', 'matchCount', 'mismatchCount', 'sampleSize'],
			additionalProperties: false,
		},
		conformity: {
			type: 'object',
			properties: {
				score:      { type: ['number', 'null'] },
				format:     { type: ['string', 'null'] },
				bestFormat: { type: ['string', 'null'] },
				sampleSize: { type: ['number', 'null'] },
			},
			required: ['score', 'format', 'bestFormat', 'sampleSize'],
			additionalProperties: false,
		},
		compositeScore: { type: ['number', 'null'] },
	},
	required: ['name', 'completeness', 'uniqueness', 'validity', 'conformity', 'compositeScore'],
	additionalProperties: false,
} as const;

const ISSUE_SCHEMA = {
	type: 'object',
	properties: {
		column:    { type: 'string' },
		dimension: { type: 'string', enum: ['completeness', 'uniqueness', 'validity', 'conformity', 'consistency', 'composite'] },
		score:     { type: 'number' },
		detail:    { type: 'string' },
	},
	required: ['column', 'dimension', 'score', 'detail'],
	additionalProperties: false,
} as const;

const CONSISTENCY_RULE_SUMMARY_SCHEMA = {
	type: 'object',
	properties: {
		name:             { type: 'string' },
		leftColumn:       { type: 'string' },
		op:               { type: 'string' },
		rightColumn:      { type: 'string' },
		satisfactionRate: { type: ['number', 'null'] },
		satisfied:        { type: 'number' },
		violated:         { type: 'number' },
		inapplicable:     { type: 'number' },
	},
	required: ['name', 'leftColumn', 'op', 'rightColumn', 'satisfactionRate', 'satisfied', 'violated', 'inapplicable'],
	additionalProperties: false,
} as const;

const CONSISTENCY_BLOCK_SCHEMA = {
	type: 'object',
	properties: {
		rules:        { type: 'array', items: CONSISTENCY_RULE_SUMMARY_SCHEMA },
		overallScore: { type: ['number', 'null'] },
		verdict:      { type: 'string', enum: ['consistent', 'mostly-consistent', 'mixed', 'broken', 'inconclusive', 'not-checked'] },
	},
	required: ['rules', 'overallScore', 'verdict'],
	additionalProperties: false,
} as const;

const CONSISTENCY_RULE_INPUT_SCHEMA = {
	type: 'object',
	properties: {
		name:        { type: 'string' },
		leftColumn:  { type: 'string' },
		op:          { type: 'string', enum: ['<', '<=', '=', '!=', '>=', '>', 'and-not-null', 'xor-null'] },
		rightColumn: { type: 'string' },
	},
	required: ['name', 'leftColumn', 'op', 'rightColumn'],
	additionalProperties: false,
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<QualityScorecardInput, QualityScorecardOutput> = {
	id: 'data.quality.scorecard.rdbms',
	name: 'Quality: scorecard (RDBMS)',
	description:
		'Composite skill: rolls up the 5d quality atomics into a per-column / table-level scorecard. ' +
		'Always includes completeness + uniqueness; validity / conformity fold in per-column when the ' +
		'caller supplies `validityPatterns` / `conformityRules`; consistency reports as a separate block ' +
		'when `consistencyRules` is supplied. Weights pick a profile based on which dimensions are on; ' +
		'missing per-column dimensions are excluded and remaining weights renormalize so a column without ' +
		'a validity pattern isn\'t penalized for the absent dimension. Surfaces top issues (composite < 0.7) ' +
		'+ primary-key candidates.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:     { type: 'string' },
			target:           { type: 'string' },
			columns:          { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 15 },
			validityPatterns: {
				type: 'object',
				additionalProperties: { type: 'string', minLength: 1 },
				description: 'Map of column name -> JS regex pattern. When supplied, validity.rdbms runs on those columns and folds into the composite.',
			},
			conformityRules: {
				type: 'object',
				additionalProperties: { type: 'string', minLength: 1 },
				description: 'Map of column name -> format slug (e.g. iso-date, e164-phone, iso-country-2). When supplied, conformity.rdbms runs on those columns and folds into the composite.',
			},
			consistencyRules: {
				type: 'array',
				items: CONSISTENCY_RULE_INPUT_SCHEMA,
				description: 'Cross-column consistency rules. When supplied, consistency.rdbms runs once with the rule list and reports per-rule satisfaction in the top-level `consistency` block. Cross-column by nature -- does not enter the per-column composite.',
			},
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:               { type: 'string' },
			totalRows:            { type: ['number', 'null'] },
			weights: {
				type: 'object',
				properties: {
					completeness: { type: 'number' },
					uniqueness:   { type: 'number' },
					validity:     { type: 'number' },
					conformity:   { type: 'number' },
				},
				required: ['completeness', 'uniqueness', 'validity', 'conformity'],
				additionalProperties: false,
			},
			columns:              { type: 'array', items: COLUMN_SCHEMA },
			primaryKeyCandidates: { type: 'array', items: { type: 'string' } },
			overallScore:         { type: ['number', 'null'] },
			topIssues:            { type: 'array', items: ISSUE_SCHEMA },
			consistency:          CONSISTENCY_BLOCK_SCHEMA,
			truncated:            { type: 'boolean' },
		},
		required: ['target', 'totalRows', 'weights', 'columns', 'primaryKeyCandidates',
		           'overallScore', 'topIssues', 'consistency', 'truncated'],
		additionalProperties: false,
	},
	toolDeps: [],
	skillDeps: [
		'data.quality.completeness.rdbms',
		'data.quality.uniqueness.rdbms',
		'data.quality.validity.rdbms',
		'data.quality.conformity.rdbms',
		'data.quality.consistency.rdbms',
	],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only -- inherits from sub-skills',
		},
	],

	async execute(input, deps): Promise<SkillResult<QualityScorecardOutput>> {
		const subInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			target:       input.target,
		};
		if (input.columns !== undefined) subInput['columns'] = input.columns;

		const [compSub, uniqSub] = await Promise.all([
			deps.runSkill<unknown, CompletenessOutput>('data.quality.completeness.rdbms', subInput),
			deps.runSkill<unknown, UniquenessOutput>('data.quality.uniqueness.rdbms', subInput),
		]);

		// Validate sub-skill shapes; if either is missing the typed
		// shape we degrade to low confidence with notes.
		if (!isCompletenessOutput(compSub.value) || !isUniquenessOutput(uniqSub.value)) {
			return {
				value: empty(input.target),
				confidence: 'low',
				notes: ['scorecard: sub-skill returned a shape we could not parse'],
				toolCalls: [],
			};
		}

		const completeness = compSub.value;
		const uniqueness = uniqSub.value;
		const totalRows = completeness.totalRows ?? uniqueness.totalRows;

		// Optional validity pass: only the columns the caller patterned
		// run validity. Other columns get a null validity score.
		const patterns = input.validityPatterns ?? {};
		const patternedCols = Object.keys(patterns).filter(c => patterns[c] !== undefined && patterns[c]!.length > 0);
		const includeValidity = patternedCols.length > 0;

		// Optional conformity pass: same per-column opt-in pattern.
		const formats = input.conformityRules ?? {};
		const formattedCols = Object.keys(formats).filter(c => formats[c] !== undefined && formats[c]!.length > 0);
		const includeConformity = formattedCols.length > 0;

		const weights = pickWeights(includeValidity, includeConformity);

		// Validity sub-runs (per-column).
		const validityByName = new Map<string, ValidityStats>();
		if (includeValidity) {
			const validitySubs = await Promise.all(
				patternedCols.map(c => deps.runSkill<unknown, ValidityOutput>(
					'data.quality.validity.rdbms',
					{
						connectionId: input.connectionId,
						target:       input.target,
						column:       c,
						pattern:      patterns[c]!,
					},
				)),
			);
			for (let i = 0; i < patternedCols.length; i++) {
				const col = patternedCols[i]!;
				const sub = validitySubs[i]!;
				if (!isValidityOutput(sub.value)) {
					validityByName.set(col, emptyValidity(patterns[col]!));
					continue;
				}
				validityByName.set(col, {
					score:         sub.value.score,
					pattern:       sub.value.pattern,
					matchCount:    sub.value.matchCount,
					mismatchCount: sub.value.mismatchCount,
					sampleSize:    sub.value.sampleSize,
				});
			}
		}

		// Conformity sub-runs (per-column). One call per opted-in column;
		// each runs the full format catalog and reports the best fit.
		// `conformityRules` lets the caller name a specific format; we
		// pass it as `formatHint` so the sub-skill returns it as the
		// "expected" format alongside its own best fit. (The current
		// 5d.4 conformity skill always evaluates every catalog format
		// and returns bestFormat + per-format hits; we don't pass a hint
		// because the skill doesn't accept one. Caller's chosen format
		// is preserved on the column-level `format` field for rendering.)
		const conformityByName = new Map<string, ConformityStats>();
		if (includeConformity) {
			const conformitySubs = await Promise.all(
				formattedCols.map(c => deps.runSkill<unknown, ConformityOutput>(
					'data.quality.conformity.rdbms',
					{
						connectionId: input.connectionId,
						target:       input.target,
						column:       c,
					},
				)),
			);
			for (let i = 0; i < formattedCols.length; i++) {
				const col = formattedCols[i]!;
				const requestedFormat = formats[col]!;
				const sub = conformitySubs[i]!;
				if (!isConformityOutput(sub.value)) {
					conformityByName.set(col, emptyConformity(requestedFormat));
					continue;
				}
				// Score is the requested format's hit-rate when it appears
				// in the catalog matches; otherwise fall back to the
				// best-fit conformityScore (which may differ if the data
				// doesn't actually match the requested format).
				const requestedMatch = sub.value.matches.find(m => m.format === requestedFormat);
				const requestedScore = requestedMatch?.hitRate ?? sub.value.conformityScore;
				conformityByName.set(col, {
					score:      requestedScore,
					format:     requestedFormat,
					bestFormat: sub.value.bestFormat,
					sampleSize: sub.value.sampleSize,
				});
			}
		}

		// Merge column entries by name. The two atomics may have run on
		// different column slices when the cap (31 vs 15) bit; we use
		// the intersection (uniqueness has the tighter cap).
		const compByName = new Map(completeness.columns.map(c => [c.name, c]));
		const merged: ColumnScorecard[] = [];
		for (const u of uniqueness.columns) {
			const c = compByName.get(u.name);
			const cScore = c !== undefined && c.nullRate !== null ? 1 - c.nullRate : null;
			const uScore = u.uniquenessRatio;
			const validity = validityByName.get(u.name) ?? emptyValidity(null);
			const conformity = conformityByName.get(u.name) ?? emptyConformity(null);
			const composite = compositeScore(cScore, uScore, validity.score, conformity.score, weights);
			merged.push({
				name: u.name,
				completeness: {
					score:         cScore,
					nonNullCount:  c?.nonNullCount ?? null,
					nullCount:     c?.nullCount    ?? null,
					nullRate:      c?.nullRate     ?? null,
				},
				uniqueness: {
					score:                 uScore,
					distinctCount:         u.distinctCount,
					uniquenessRatio:       u.uniquenessRatio,
					isPrimaryKeyCandidate: u.isPrimaryKeyCandidate,
				},
				validity,
				conformity,
				compositeScore: composite,
			});
		}

		const observed = merged.map(c => c.compositeScore).filter((s): s is number => s !== null);
		const overallScore = observed.length > 0
			? observed.reduce((a, b) => a + b, 0) / observed.length
			: null;

		// Optional consistency pass: single sub-call covers the whole
		// rule list. Reported as a separate top-level block (cross-
		// column by nature; doesn't enter the per-column composite).
		const consistencyRules = input.consistencyRules ?? [];
		let consistency: ConsistencyBlock = EMPTY_CONSISTENCY;
		if (consistencyRules.length > 0) {
			const sub = await deps.runSkill<unknown, ConsistencyOutput>(
				'data.quality.consistency.rdbms',
				{
					connectionId: input.connectionId,
					target:       input.target,
					rules:        consistencyRules,
				},
			);
			if (isConsistencyOutput(sub.value)) {
				const rules: ConsistencyRuleSummary[] = sub.value.rules.map(r => ({
					name:             r.name,
					leftColumn:       r.leftColumn,
					op:               r.op,
					rightColumn:      r.rightColumn,
					satisfactionRate: r.satisfactionRate,
					satisfied:        r.satisfied,
					violated:         r.violated,
					inapplicable:     r.inapplicable,
				}));
				const rates = rules.map(r => r.satisfactionRate).filter((s): s is number => s !== null);
				const overallScoreCons = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
				consistency = {
					rules,
					overallScore: overallScoreCons,
					verdict:      sub.value.verdict,
				};
			} else {
				// Sub-skill failed; record the verdict as inconclusive
				// rather than not-checked so the caller knows we tried.
				consistency = { rules: [], overallScore: null, verdict: 'inconclusive' };
			}
		}

		const topIssues = pickTopIssues(merged, consistency);

		return {
			value: {
				target: completeness.target,
				totalRows,
				weights,
				columns: merged,
				primaryKeyCandidates: uniqueness.primaryKeyCandidates,
				overallScore,
				topIssues,
				consistency,
				truncated: completeness.truncated || uniqueness.truncated,
			},
			// Composite is at most each sub-skill's confidence (registry
			// floors via runSkill); we don't claim higher than 'high'.
			confidence: overallScore !== null ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

/**
 * Weighted average of the present dimensions. Missing dimensions
 * are excluded and the remaining weights are renormalized so a
 * column without a validity / conformity score doesn't get
 * penalized for the absent dimension.
 */
function compositeScore(
	cScore: number | null,
	uScore: number | null,
	vScore: number | null,
	fScore: number | null,
	weights: DimensionWeights,
): number | null {
	const parts: { weight: number; score: number }[] = [];
	if (cScore !== null) parts.push({ weight: weights.completeness, score: cScore });
	if (uScore !== null) parts.push({ weight: weights.uniqueness,   score: uScore });
	if (vScore !== null) parts.push({ weight: weights.validity,     score: vScore });
	if (fScore !== null) parts.push({ weight: weights.conformity,   score: fScore });
	if (parts.length === 0) return null;
	const sumW = parts.reduce((a, p) => a + p.weight, 0);
	if (sumW === 0) return null;
	return parts.reduce((a, p) => a + p.weight * p.score, 0) / sumW;
}

function emptyValidity(pattern: string | null): ValidityStats {
	return { score: null, pattern, matchCount: null, mismatchCount: null, sampleSize: null };
}

function emptyConformity(format: string | null): ConformityStats {
	return { score: null, format, bestFormat: null, sampleSize: null };
}

function pickTopIssues(
	columns: readonly ColumnScorecard[],
	consistency: ConsistencyBlock,
): ScorecardIssue[] {
	const candidates: ScorecardIssue[] = [];
	for (const c of columns) {
		if (c.compositeScore === null || c.compositeScore >= TOP_ISSUE_THRESHOLD) continue;
		// Pick the lowest-scoring present dimension for the detail line.
		const dimScores: { dim: ScorecardIssue['dimension']; score: number; detail: string }[] = [];
		if (c.completeness.score !== null) {
			dimScores.push({
				dim: 'completeness',
				score: c.completeness.score,
				detail: `null rate ${formatPct(c.completeness.nullRate)} (completeness score ${c.completeness.score.toFixed(2)})`,
			});
		}
		if (c.uniqueness.score !== null) {
			dimScores.push({
				dim: 'uniqueness',
				score: c.uniqueness.score,
				detail: `uniqueness ratio ${c.uniqueness.score.toFixed(3)} (low cardinality relative to row count)`,
			});
		}
		if (c.validity.score !== null) {
			const total = (c.validity.matchCount ?? 0) + (c.validity.mismatchCount ?? 0);
			dimScores.push({
				dim: 'validity',
				score: c.validity.score,
				detail: `${c.validity.mismatchCount ?? 0}/${total} sampled values fail pattern \`${c.validity.pattern ?? '?'}\``,
			});
		}
		if (c.conformity.score !== null) {
			dimScores.push({
				dim: 'conformity',
				score: c.conformity.score,
				detail: `${(c.conformity.score * 100).toFixed(1)}% match against format \`${c.conformity.format ?? '?'}\``
					+ (c.conformity.bestFormat !== null && c.conformity.bestFormat !== c.conformity.format
						? ` (best fit: \`${c.conformity.bestFormat}\`)`
						: ''),
			});
		}
		dimScores.sort((a, b) => a.score - b.score);
		const worst = dimScores[0];
		const issue: ScorecardIssue = worst !== undefined
			? { column: c.name, dimension: worst.dim, score: c.compositeScore, detail: worst.detail }
			: {
				column: c.name,
				dimension: 'composite',
				score: c.compositeScore,
				detail: `composite score ${c.compositeScore.toFixed(2)} below threshold ${TOP_ISSUE_THRESHOLD}`,
			};
		candidates.push(issue);
	}
	// Promote consistency rules whose satisfaction is below the
	// threshold into the top-issues list so a broken cross-column
	// invariant surfaces alongside per-column problems.
	for (const r of consistency.rules) {
		if (r.satisfactionRate === null || r.satisfactionRate >= TOP_ISSUE_THRESHOLD) continue;
		candidates.push({
			column:    `${r.leftColumn} ${r.op} ${r.rightColumn}`,
			dimension: 'consistency',
			score:     r.satisfactionRate,
			detail:    `rule '${r.name}' satisfied ${r.satisfied}/${r.satisfied + r.violated} applicable rows (${(r.satisfactionRate * 100).toFixed(1)}%)`,
		});
	}
	candidates.sort((a, b) => a.score - b.score);
	return candidates.slice(0, TOP_ISSUE_LIMIT);
}

function formatPct(v: number | null): string {
	return v !== null ? `${(v * 100).toFixed(1)}%` : 'n/a';
}

function empty(target: string): QualityScorecardOutput {
	return {
		target, totalRows: null, weights: WEIGHTS_BASE,
		columns: [], primaryKeyCandidates: [],
		overallScore: null, topIssues: [], consistency: EMPTY_CONSISTENCY, truncated: false,
	};
}

interface CompletenessOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly columns: readonly { name: string; nonNullCount: number | null; nullCount: number | null; nullRate: number | null }[];
	readonly truncated: boolean;
}

interface UniquenessOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly columns: readonly { name: string; distinctCount: number | null; uniquenessRatio: number | null; isPrimaryKeyCandidate: boolean }[];
	readonly primaryKeyCandidates: readonly string[];
	readonly truncated: boolean;
}

interface ValidityOutput {
	readonly target: string;
	readonly column: string;
	readonly pattern: string;
	readonly sampleSize: number;
	readonly matchCount: number;
	readonly mismatchCount: number;
	readonly matchRate: number | null;
	readonly score: number | null;
}

interface ConformityFormatMatch {
	readonly format: string;
	readonly hitCount: number;
	readonly hitRate: number;
}

interface ConformityOutput {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly matches: readonly ConformityFormatMatch[];
	readonly bestFormat: string | null;
	readonly conformityScore: number | null;
	readonly verdict: string;
	readonly interpretation: string;
}

interface ConsistencyRuleResultRaw {
	readonly name: string;
	readonly leftColumn: string;
	readonly op: string;
	readonly rightColumn: string;
	readonly satisfied: number;
	readonly violated: number;
	readonly inapplicable: number;
	readonly satisfactionRate: number | null;
}

interface ConsistencyOutput {
	readonly target: string;
	readonly sampleSize: number;
	readonly rules: readonly ConsistencyRuleResultRaw[];
	readonly verdict: 'consistent' | 'mostly-consistent' | 'mixed' | 'broken' | 'inconclusive';
	readonly interpretation: string;
}

function isCompletenessOutput(v: unknown): v is CompletenessOutput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && Array.isArray(o['columns']) && typeof o['truncated'] === 'boolean';
}

function isUniquenessOutput(v: unknown): v is UniquenessOutput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['primaryKeyCandidates'])
		&& typeof o['truncated'] === 'boolean';
}

function isValidityOutput(v: unknown): v is ValidityOutput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& typeof o['pattern'] === 'string'
		&& typeof o['sampleSize'] === 'number';
}

function isConformityOutput(v: unknown): v is ConformityOutput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& Array.isArray(o['matches']);
}

function isConsistencyOutput(v: unknown): v is ConsistencyOutput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['rules'])
		&& typeof o['verdict'] === 'string';
}

export function registerDataQualityScorecardRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
