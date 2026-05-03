/**
 * data.quality.scorecard.rdbms -- Phase 5d.6 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Composite skill: rolls up the two shipped 5d atomic dimensions
 * (`quality.completeness.rdbms` + `quality.uniqueness.rdbms`) into
 * a single typed scorecard with weighted scores. Per-column
 * composite quality + table overall + a top-issues digest.
 *
 * Weights are hard-coded in v1 (completeness=0.6, uniqueness=0.4).
 * Per the plan's open-question table, repo-overridable weights via
 * `~/.insrc/data-analyzer/scorecard.json` are a follow-up once a
 * real user has a non-default rubric in mind.
 *
 * The composite ships **before** validity / conformity / consistency
 * (5d.3-5.5) -- those will weight in later. The plan's row 5d.6
 * acknowledges this; the synth renderer's "weights" line is
 * authoritative about which dimensions are currently included.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

/**
 * Two weight tables: one when validity isn't supplied, one when it
 * is. Both rebalance proportionally so completeness stays the
 * dominant signal. Validity weight (0.2) is small in v1 because it
 * only fires for columns the caller explicitly supplied a regex
 * for; treating it as equally weighted with completeness would
 * over-penalise columns the caller forgot to pattern-validate.
 */
const WEIGHTS_BASE      = { completeness: 0.6, uniqueness: 0.4, validity: 0.0 } as const;
const WEIGHTS_WITH_VALID = { completeness: 0.5, uniqueness: 0.3, validity: 0.2 } as const;
const TOP_ISSUE_THRESHOLD = 0.7;
const TOP_ISSUE_LIMIT = 5;

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

interface ColumnScorecard {
	readonly name: string;
	readonly completeness: DimensionStats;
	readonly uniqueness: UniquenessStats;
	readonly validity: ValidityStats;
	readonly compositeScore: number | null;
}

interface ScorecardIssue {
	readonly column: string;
	readonly dimension: 'completeness' | 'uniqueness' | 'validity' | 'composite';
	readonly score: number;
	readonly detail: string;
}

type ScorecardWeights = typeof WEIGHTS_BASE | typeof WEIGHTS_WITH_VALID;

interface QualityScorecardOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly weights: ScorecardWeights;
	readonly columns: readonly ColumnScorecard[];
	readonly primaryKeyCandidates: readonly string[];
	readonly overallScore: number | null;
	readonly topIssues: readonly ScorecardIssue[];
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
		compositeScore: { type: ['number', 'null'] },
	},
	required: ['name', 'completeness', 'uniqueness', 'validity', 'compositeScore'],
	additionalProperties: false,
} as const;

const ISSUE_SCHEMA = {
	type: 'object',
	properties: {
		column:    { type: 'string' },
		dimension: { type: 'string', enum: ['completeness', 'uniqueness', 'validity', 'composite'] },
		score:     { type: 'number' },
		detail:    { type: 'string' },
	},
	required: ['column', 'dimension', 'score', 'detail'],
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
		'Composite skill: rolls up completeness + uniqueness atomics into a per-column / table-level quality ' +
		'scorecard with weighted composite scores (completeness=0.6, uniqueness=0.4 in v1). Surfaces top ' +
		'issues (composite score < 0.7) + primary-key candidates. Validity / conformity / consistency are ' +
		'not yet weighted in -- 5d.3-5d.5 are pending.',
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
				},
				required: ['completeness', 'uniqueness', 'validity'],
				additionalProperties: false,
			},
			columns:              { type: 'array', items: COLUMN_SCHEMA },
			primaryKeyCandidates: { type: 'array', items: { type: 'string' } },
			overallScore:         { type: ['number', 'null'] },
			topIssues:            { type: 'array', items: ISSUE_SCHEMA },
			truncated:            { type: 'boolean' },
		},
		required: ['target', 'totalRows', 'weights', 'columns', 'primaryKeyCandidates',
		           'overallScore', 'topIssues', 'truncated'],
		additionalProperties: false,
	},
	toolDeps: [],
	skillDeps: ['data.quality.completeness.rdbms', 'data.quality.uniqueness.rdbms', 'data.quality.validity.rdbms'],
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
		const weights = includeValidity ? WEIGHTS_WITH_VALID : WEIGHTS_BASE;

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
			const composite = compositeScore(cScore, uScore, validity.score, weights);
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
				compositeScore: composite,
			});
		}

		const observed = merged.map(c => c.compositeScore).filter((s): s is number => s !== null);
		const overallScore = observed.length > 0
			? observed.reduce((a, b) => a + b, 0) / observed.length
			: null;

		const topIssues = pickTopIssues(merged);

		return {
			value: {
				target: completeness.target,
				totalRows,
				weights,
				columns: merged,
				primaryKeyCandidates: uniqueness.primaryKeyCandidates,
				overallScore,
				topIssues,
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
 * column without a validity score doesn't get penalized for the
 * absent dimension.
 */
function compositeScore(
	cScore: number | null,
	uScore: number | null,
	vScore: number | null,
	weights: ScorecardWeights,
): number | null {
	const parts: { weight: number; score: number }[] = [];
	if (cScore !== null) parts.push({ weight: weights.completeness, score: cScore });
	if (uScore !== null) parts.push({ weight: weights.uniqueness,   score: uScore });
	if (vScore !== null) parts.push({ weight: weights.validity,     score: vScore });
	if (parts.length === 0) return null;
	const sumW = parts.reduce((a, p) => a + p.weight, 0);
	if (sumW === 0) return null;
	return parts.reduce((a, p) => a + p.weight * p.score, 0) / sumW;
}

function emptyValidity(pattern: string | null): ValidityStats {
	return { score: null, pattern, matchCount: null, mismatchCount: null, sampleSize: null };
}

function pickTopIssues(columns: readonly ColumnScorecard[]): ScorecardIssue[] {
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
		overallScore: null, topIssues: [], truncated: false,
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

export function registerDataQualityScorecardRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
