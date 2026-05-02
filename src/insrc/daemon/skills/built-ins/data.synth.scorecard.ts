/**
 * data.synth.scorecard -- Phase 6.8 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Pure-template renderer: takes a `data.quality.scorecard.rdbms`
 * output and produces a markdown report card. Layout:
 *
 *   - Header line: target + overall score badge
 *   - Summary: weights, total rows, primary-key candidates
 *   - Top issues block (if any)
 *   - Per-column detail table
 *
 * No LLM, no tool calls. The body is a deterministic template; the
 * underlying scorecard composite is responsible for the numbers.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

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
	readonly validity?: ValidityStats;
	readonly compositeScore: number | null;
}

interface ScorecardIssue {
	readonly column: string;
	readonly dimension: 'completeness' | 'uniqueness' | 'validity' | 'composite';
	readonly score: number;
	readonly detail: string;
}

interface ScorecardInput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly weights: { readonly completeness: number; readonly uniqueness: number; readonly validity?: number };
	readonly columns: readonly ColumnScorecard[];
	readonly primaryKeyCandidates: readonly string[];
	readonly overallScore: number | null;
	readonly topIssues: readonly ScorecardIssue[];
	readonly truncated?: boolean;
}

interface ScorecardOutput {
	readonly markdown: string;
}

const skill: Skill<ScorecardInput, ScorecardOutput> = {
	id: 'data.synth.scorecard',
	name: 'Synth: quality scorecard',
	description:
		'Render a quality scorecard (output of data.quality.scorecard.rdbms) as a markdown report card. ' +
		'Header + overall score + weights + PK candidates + top issues + per-column detail. Pure template.',
	family: 'synthesis',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
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
				required: ['completeness', 'uniqueness'],
				additionalProperties: false,
			},
			columns:              { type: 'array' },
			primaryKeyCandidates: { type: 'array', items: { type: 'string' } },
			overallScore:         { type: ['number', 'null'] },
			topIssues:            { type: 'array' },
			truncated:            { type: 'boolean' },
		},
		required: ['target', 'totalRows', 'weights', 'columns', 'primaryKeyCandidates',
		           'overallScore', 'topIssues'],
		additionalProperties: true,
	},
	outputs: {
		type: 'object',
		properties: { markdown: { type: 'string' } },
		required: ['markdown'],
		additionalProperties: false,
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input): Promise<SkillResult<ScorecardOutput>> {
		const overallTag = scoreBadge(input.overallScore);
		const truncTag = input.truncated === true ? ' (truncated)' : '';
		const validityWeight = input.weights.validity ?? 0;
		const validityIncluded = validityWeight > 0;
		const weightLine = validityIncluded
			? `weights: completeness ${formatWeight(input.weights.completeness)}, ` +
			  `uniqueness ${formatWeight(input.weights.uniqueness)}, ` +
			  `validity ${formatWeight(validityWeight)} ` +
			  `_(conformity / consistency dimensions pending)_`
			: `weights: completeness ${formatWeight(input.weights.completeness)}, ` +
			  `uniqueness ${formatWeight(input.weights.uniqueness)} ` +
			  `_(validity / conformity / consistency dimensions pending; supply \`validityPatterns\` to enable validity)_`;
		const lines: string[] = [
			`## Quality scorecard: \`${input.target}\`${truncTag}`,
			'',
			`overall score: ${overallTag}` +
				(input.totalRows !== null ? ` -- ${input.totalRows.toLocaleString('en-US')} rows` : ''),
			'',
			weightLine,
			'',
		];

		if (input.primaryKeyCandidates.length > 0) {
			lines.push(
				`primary-key candidates: ${input.primaryKeyCandidates.map(c => `\`${c}\``).join(', ')}`,
				'',
			);
		} else {
			lines.push('primary-key candidates: _(none -- no fully unique non-null column)_', '');
		}

		if (input.topIssues.length > 0) {
			lines.push('### Top issues', '');
			lines.push('| column | dimension | score | detail |', '|---|---|---|---|');
			for (const issue of input.topIssues) {
				lines.push(
					`| \`${issue.column}\` | ${issue.dimension} | ${issue.score.toFixed(2)} | ${escapePipes(issue.detail)} |`,
				);
			}
			lines.push('');
		}

		lines.push('### Per-column detail', '');
		if (input.columns.length === 0) {
			lines.push('_(no columns)_');
		} else if (validityIncluded) {
			lines.push(
				'| column | composite | completeness | null rate | uniqueness | distinct | validity | PK? |',
				'|---|---|---|---|---|---|---|---|',
			);
			for (const c of input.columns) {
				const composite = formatScore(c.compositeScore);
				const cScore    = formatScore(c.completeness.score);
				const nullPct   = formatPct(c.completeness.nullRate);
				const uScore    = formatScore(c.uniqueness.score);
				const distinct  = c.uniqueness.distinctCount !== null
					? c.uniqueness.distinctCount.toLocaleString('en-US')
					: '_null_';
				const validity  = c.validity !== undefined && c.validity.score !== null
					? `${formatScore(c.validity.score)} (\`${c.validity.pattern ?? '?'}\`)`
					: '_n/a_';
				const pk        = c.uniqueness.isPrimaryKeyCandidate ? 'yes' : '';
				lines.push(`| \`${c.name}\` | ${composite} | ${cScore} | ${nullPct} | ${uScore} | ${distinct} | ${validity} | ${pk} |`);
			}
		} else {
			lines.push(
				'| column | composite | completeness | null rate | uniqueness | distinct | PK? |',
				'|---|---|---|---|---|---|---|',
			);
			for (const c of input.columns) {
				const composite = formatScore(c.compositeScore);
				const cScore    = formatScore(c.completeness.score);
				const nullPct   = formatPct(c.completeness.nullRate);
				const uScore    = formatScore(c.uniqueness.score);
				const distinct  = c.uniqueness.distinctCount !== null
					? c.uniqueness.distinctCount.toLocaleString('en-US')
					: '_null_';
				const pk        = c.uniqueness.isPrimaryKeyCandidate ? 'yes' : '';
				lines.push(`| \`${c.name}\` | ${composite} | ${cScore} | ${nullPct} | ${uScore} | ${distinct} | ${pk} |`);
			}
		}

		return {
			value: { markdown: lines.join('\n') },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function scoreBadge(score: number | null): string {
	if (score === null) return '_(not computed)_';
	const pct = (score * 100).toFixed(1);
	if (score >= 0.9)  return `**${pct}%** (excellent)`;
	if (score >= 0.75) return `**${pct}%** (good)`;
	if (score >= 0.5)  return `**${pct}%** (fair)`;
	return `**${pct}%** (poor)`;
}

function formatScore(score: number | null): string {
	return score !== null ? score.toFixed(2) : '_null_';
}

function formatPct(v: number | null): string {
	return v !== null ? `${(v * 100).toFixed(1)}%` : '_null_';
}

function formatWeight(w: number): string {
	return `${(w * 100).toFixed(0)}%`;
}

function escapePipes(s: string): string {
	return s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function registerDataSynthScorecardSkill(): void {
	registerSkill(skill as unknown as Skill);
}
