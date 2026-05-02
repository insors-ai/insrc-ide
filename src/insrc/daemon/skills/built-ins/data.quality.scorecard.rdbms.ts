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
import type { Skill, SkillDeps, SkillResult } from '../types.js';

const WEIGHTS = { completeness: 0.6, uniqueness: 0.4 } as const;
const TOP_ISSUE_THRESHOLD = 0.7;
const TOP_ISSUE_LIMIT = 5;

interface QualityScorecardInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
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

interface ColumnScorecard {
	readonly name: string;
	readonly completeness: DimensionStats;
	readonly uniqueness: UniquenessStats;
	readonly compositeScore: number | null;
}

interface ScorecardIssue {
	readonly column: string;
	readonly dimension: 'completeness' | 'uniqueness' | 'composite';
	readonly score: number;
	readonly detail: string;
}

interface QualityScorecardOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly weights: typeof WEIGHTS;
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
		compositeScore: { type: ['number', 'null'] },
	},
	required: ['name', 'completeness', 'uniqueness', 'compositeScore'],
	additionalProperties: false,
} as const;

const ISSUE_SCHEMA = {
	type: 'object',
	properties: {
		column:    { type: 'string' },
		dimension: { type: 'string', enum: ['completeness', 'uniqueness', 'composite'] },
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
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 15 },
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
				},
				required: ['completeness', 'uniqueness'],
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
	skillDeps: ['data.quality.completeness.rdbms', 'data.quality.uniqueness.rdbms'],
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

		// Merge column entries by name. The two atomics may have run on
		// different column slices when the cap (31 vs 15) bit; we use
		// the intersection (uniqueness has the tighter cap).
		const compByName = new Map(completeness.columns.map(c => [c.name, c]));
		const merged: ColumnScorecard[] = [];
		for (const u of uniqueness.columns) {
			const c = compByName.get(u.name);
			const cScore = c !== undefined && c.nullRate !== null ? 1 - c.nullRate : null;
			const uScore = u.uniquenessRatio;
			const composite = compositeScore(cScore, uScore);
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
				weights: WEIGHTS,
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

function compositeScore(cScore: number | null, uScore: number | null): number | null {
	if (cScore === null && uScore === null) return null;
	if (cScore !== null && uScore !== null) {
		return WEIGHTS.completeness * cScore + WEIGHTS.uniqueness * uScore;
	}
	// Fall back to single-dimension when only one is available.
	return cScore ?? uScore;
}

function pickTopIssues(columns: readonly ColumnScorecard[]): ScorecardIssue[] {
	const candidates: ScorecardIssue[] = [];
	for (const c of columns) {
		if (c.compositeScore !== null && c.compositeScore < TOP_ISSUE_THRESHOLD) {
			// Pick the dominant failing dimension for the detail line.
			const cScore = c.completeness.score;
			const uScore = c.uniqueness.score;
			let dimension: ScorecardIssue['dimension'] = 'composite';
			let detail = `composite score ${c.compositeScore.toFixed(2)} below threshold ${TOP_ISSUE_THRESHOLD}`;
			if (cScore !== null && (uScore === null || cScore < uScore)) {
				dimension = 'completeness';
				detail = `null rate ${formatPct(c.completeness.nullRate)} (completeness score ${cScore.toFixed(2)})`;
			} else if (uScore !== null && (cScore === null || uScore < cScore)) {
				dimension = 'uniqueness';
				detail = `uniqueness ratio ${uScore.toFixed(3)} (low cardinality relative to row count)`;
			}
			candidates.push({ column: c.name, dimension, score: c.compositeScore, detail });
		}
	}
	candidates.sort((a, b) => a.score - b.score);
	return candidates.slice(0, TOP_ISSUE_LIMIT);
}

function formatPct(v: number | null): string {
	return v !== null ? `${(v * 100).toFixed(1)}%` : 'n/a';
}

function empty(target: string): QualityScorecardOutput {
	return {
		target, totalRows: null, weights: WEIGHTS,
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

export function registerDataQualityScorecardRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
