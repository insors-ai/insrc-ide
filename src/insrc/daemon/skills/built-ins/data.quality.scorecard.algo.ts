/**
 * Shared math + IO contract for `data.quality.scorecard.{rdbms,file}`
 * (Phase 5d.6 of plans/analyzers/data-analyzer-skills.md).
 *
 * The scorecard is a composite skill that rolls up the 5d atomic
 * dimensions into a per-column / table-level scorecard. This module
 * holds the family-agnostic math: weight tables, composite math,
 * top-issues digest, sub-skill output shape guards, and the JSON
 * schema. The rdbms / file variants only carry transport concerns
 * (which connection family to target + which sub-skill IDs to call).
 *
 * Per-column composite weights:
 *   base                     completeness=0.6, uniqueness=0.4
 *   + validity              completeness=0.5, uniqueness=0.3, validity=0.2
 *   + conformity            completeness=0.5, uniqueness=0.3,                  conformity=0.2
 *   + validity + conformity completeness=0.4, uniqueness=0.25, validity=0.175, conformity=0.175
 */

export interface DimensionWeights {
	readonly completeness: number;
	readonly uniqueness:   number;
	readonly validity:     number;
	readonly conformity:   number;
}

export const WEIGHTS_BASE:      DimensionWeights = { completeness: 0.6,  uniqueness: 0.4,  validity: 0.0,   conformity: 0.0   };
export const WEIGHTS_VAL:       DimensionWeights = { completeness: 0.5,  uniqueness: 0.3,  validity: 0.2,   conformity: 0.0   };
export const WEIGHTS_CONF:      DimensionWeights = { completeness: 0.5,  uniqueness: 0.3,  validity: 0.0,   conformity: 0.2   };
export const WEIGHTS_VAL_CONF:  DimensionWeights = { completeness: 0.4,  uniqueness: 0.25, validity: 0.175, conformity: 0.175 };

export function pickWeights(includeValidity: boolean, includeConformity: boolean): DimensionWeights {
	if (includeValidity && includeConformity) return WEIGHTS_VAL_CONF;
	if (includeValidity)                       return WEIGHTS_VAL;
	if (includeConformity)                     return WEIGHTS_CONF;
	return WEIGHTS_BASE;
}

export const TOP_ISSUE_THRESHOLD = 0.7;
export const TOP_ISSUE_LIMIT = 5;

export interface ConsistencyRuleIn {
	readonly name: string;
	readonly leftColumn: string;
	readonly op: '<' | '<=' | '=' | '!=' | '>=' | '>' | 'and-not-null' | 'xor-null';
	readonly rightColumn: string;
}

export interface DimensionStats {
	readonly score: number | null;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly nullRate: number | null;
}

export interface UniquenessStats {
	readonly score: number | null;
	readonly distinctCount: number | null;
	readonly uniquenessRatio: number | null;
	readonly isPrimaryKeyCandidate: boolean;
}

export interface ValidityStats {
	readonly score: number | null;
	readonly pattern: string | null;
	readonly matchCount: number | null;
	readonly mismatchCount: number | null;
	readonly sampleSize: number | null;
}

export interface ConformityStats {
	readonly score: number | null;
	readonly format: string | null;
	readonly bestFormat: string | null;
	readonly sampleSize: number | null;
}

export interface ColumnScorecard {
	readonly name: string;
	readonly completeness: DimensionStats;
	readonly uniqueness: UniquenessStats;
	readonly validity: ValidityStats;
	readonly conformity: ConformityStats;
	readonly compositeScore: number | null;
}

export interface ScorecardIssue {
	readonly column: string;
	readonly dimension: 'completeness' | 'uniqueness' | 'validity' | 'conformity' | 'consistency' | 'composite';
	readonly score: number;
	readonly detail: string;
}

export interface ConsistencyRuleSummary {
	readonly name: string;
	readonly leftColumn: string;
	readonly op: string;
	readonly rightColumn: string;
	readonly satisfactionRate: number | null;
	readonly satisfied: number;
	readonly violated: number;
	readonly inapplicable: number;
}

export interface ConsistencyBlock {
	readonly rules: readonly ConsistencyRuleSummary[];
	readonly overallScore: number | null;
	readonly verdict: 'consistent' | 'mostly-consistent' | 'mixed' | 'broken' | 'inconclusive' | 'not-checked';
}

export const EMPTY_CONSISTENCY_BLOCK: ConsistencyBlock = {
	rules: [],
	overallScore: null,
	verdict: 'not-checked',
};

export interface QualityScorecardOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly weights: DimensionWeights;
	readonly columns: readonly ColumnScorecard[];
	readonly primaryKeyCandidates: readonly string[];
	readonly overallScore: number | null;
	readonly topIssues: readonly ScorecardIssue[];
	readonly consistency: ConsistencyBlock;
	readonly truncated: boolean;
}

export function emptyScorecard(target: string): QualityScorecardOutput {
	return {
		target, totalRows: null, weights: WEIGHTS_BASE,
		columns: [], primaryKeyCandidates: [],
		overallScore: null, topIssues: [], consistency: EMPTY_CONSISTENCY_BLOCK, truncated: false,
	};
}

export function emptyValidityStats(pattern: string | null): ValidityStats {
	return { score: null, pattern, matchCount: null, mismatchCount: null, sampleSize: null };
}

export function emptyConformityStats(format: string | null): ConformityStats {
	return { score: null, format, bestFormat: null, sampleSize: null };
}

export function compositeScore(
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

export function pickTopIssues(
	columns: readonly ColumnScorecard[],
	consistency: ConsistencyBlock,
): ScorecardIssue[] {
	const candidates: ScorecardIssue[] = [];
	for (const c of columns) {
		if (c.compositeScore === null || c.compositeScore >= TOP_ISSUE_THRESHOLD) continue;
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

export interface CompletenessOutputRaw {
	readonly target: string;
	readonly totalRows: number | null;
	readonly columns: readonly { name: string; nonNullCount: number | null; nullCount: number | null; nullRate: number | null }[];
	readonly truncated: boolean;
}

export interface UniquenessOutputRaw {
	readonly target: string;
	readonly totalRows: number | null;
	readonly columns: readonly { name: string; distinctCount: number | null; uniquenessRatio: number | null; isPrimaryKeyCandidate: boolean }[];
	readonly primaryKeyCandidates: readonly string[];
	readonly truncated: boolean;
}

export interface ValidityOutputRaw {
	readonly target: string;
	readonly column: string;
	readonly pattern: string;
	readonly sampleSize: number;
	readonly matchCount: number;
	readonly mismatchCount: number;
	readonly matchRate: number | null;
	readonly score: number | null;
}

interface ConformityFormatMatchRaw {
	readonly format: string;
	readonly hitCount: number;
	readonly hitRate: number;
}

export interface ConformityOutputRaw {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly matches: readonly ConformityFormatMatchRaw[];
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

export interface ConsistencyOutputRaw {
	readonly target: string;
	readonly sampleSize: number;
	readonly rules: readonly ConsistencyRuleResultRaw[];
	readonly verdict: 'consistent' | 'mostly-consistent' | 'mixed' | 'broken' | 'inconclusive';
	readonly interpretation: string;
}

export function isCompletenessOutput(v: unknown): v is CompletenessOutputRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && Array.isArray(o['columns']) && typeof o['truncated'] === 'boolean';
}

export function isUniquenessOutput(v: unknown): v is UniquenessOutputRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['primaryKeyCandidates'])
		&& typeof o['truncated'] === 'boolean';
}

export function isValidityOutput(v: unknown): v is ValidityOutputRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& typeof o['pattern'] === 'string'
		&& typeof o['sampleSize'] === 'number';
}

export function isConformityOutput(v: unknown): v is ConformityOutputRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& Array.isArray(o['matches']);
}

export function isConsistencyOutput(v: unknown): v is ConsistencyOutputRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['rules'])
		&& typeof o['verdict'] === 'string';
}

export function buildConsistencyBlockFromOutput(out: ConsistencyOutputRaw): ConsistencyBlock {
	const rules: ConsistencyRuleSummary[] = out.rules.map(r => ({
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
	const overallScore = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
	return {
		rules,
		overallScore,
		verdict: out.verdict,
	};
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

export const CONSISTENCY_BLOCK_SCHEMA = {
	type: 'object',
	properties: {
		rules:        { type: 'array', items: CONSISTENCY_RULE_SUMMARY_SCHEMA },
		overallScore: { type: ['number', 'null'] },
		verdict:      { type: 'string', enum: ['consistent', 'mostly-consistent', 'mixed', 'broken', 'inconclusive', 'not-checked'] },
	},
	required: ['rules', 'overallScore', 'verdict'],
	additionalProperties: false,
} as const;

export const CONSISTENCY_RULE_INPUT_SCHEMA = {
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

export const SCORECARD_OUTPUT_SCHEMA: Record<string, unknown> = {
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
};
