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

interface ConformityStats {
	readonly score: number | null;
	readonly format: string | null;
	readonly bestFormat?: string | null;
	readonly sampleSize?: number | null;
}

interface ColumnScorecard {
	readonly name: string;
	readonly completeness: DimensionStats;
	readonly uniqueness: UniquenessStats;
	readonly validity?: ValidityStats;
	readonly conformity?: ConformityStats;
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
	readonly overallScore: number | null;
	readonly verdict: 'consistent' | 'mostly-consistent' | 'mixed' | 'broken' | 'inconclusive' | 'not-checked';
}

interface ScorecardInput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly weights: { readonly completeness: number; readonly uniqueness: number; readonly validity?: number; readonly conformity?: number };
	readonly columns: readonly ColumnScorecard[];
	readonly primaryKeyCandidates: readonly string[];
	readonly overallScore: number | null;
	readonly topIssues: readonly ScorecardIssue[];
	readonly consistency?: ConsistencyBlock;       // optional for back-compat with pre-Track-B inputs
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
					conformity:   { type: 'number' },
				},
				required: ['completeness', 'uniqueness'],
				additionalProperties: false,
			},
			columns:              { type: 'array' },
			primaryKeyCandidates: { type: 'array', items: { type: 'string' } },
			overallScore:         { type: ['number', 'null'] },
			topIssues:            { type: 'array' },
			consistency:          { type: 'object' },
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
		const validityWeight   = input.weights.validity   ?? 0;
		const conformityWeight = input.weights.conformity ?? 0;
		const validityIncluded   = validityWeight > 0;
		const conformityIncluded = conformityWeight > 0;
		const consistencyChecked = input.consistency !== undefined && input.consistency.verdict !== 'not-checked';

		const weightLine = renderWeightLine(input.weights, validityIncluded, conformityIncluded, consistencyChecked);

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
		} else {
			renderColumnTable(input.columns, validityIncluded, conformityIncluded, lines);
		}

		// Cross-column consistency block (rendered only when the caller
		// supplied rules; the `not-checked` verdict suppresses output).
		if (consistencyChecked && input.consistency !== undefined) {
			lines.push('', '### Cross-column consistency', '');
			const c = input.consistency;
			const headerScore = c.overallScore !== null ? `${(c.overallScore * 100).toFixed(1)}%` : '_(no applicable rows)_';
			lines.push(`verdict: **${c.verdict}** -- mean satisfaction ${headerScore}`, '');
			if (c.rules.length === 0) {
				lines.push('_(no rule results)_');
			} else {
				lines.push(
					'| rule | left | op | right | satisfaction | satisfied / violated / inapplicable |',
					'|---|---|---|---|---|---|',
				);
				for (const r of c.rules) {
					const sat = r.satisfactionRate !== null ? `${(r.satisfactionRate * 100).toFixed(1)}%` : '_n/a_';
					lines.push(
						`| ${escapePipes(r.name)} | \`${r.leftColumn}\` | ${r.op} | \`${r.rightColumn}\` | ${sat} | ${r.satisfied} / ${r.violated} / ${r.inapplicable} |`,
					);
				}
			}
		}

		return {
			value: { markdown: lines.join('\n') },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function renderWeightLine(
	weights: ScorecardInput['weights'],
	validityIncluded: boolean,
	conformityIncluded: boolean,
	consistencyChecked: boolean,
): string {
	const parts = [
		`completeness ${formatWeight(weights.completeness)}`,
		`uniqueness ${formatWeight(weights.uniqueness)}`,
	];
	if (validityIncluded)   parts.push(`validity ${formatWeight(weights.validity!)}`);
	if (conformityIncluded) parts.push(`conformity ${formatWeight(weights.conformity!)}`);

	const pendingHints: string[] = [];
	if (!validityIncluded)   pendingHints.push('validity (supply `validityPatterns`)');
	if (!conformityIncluded) pendingHints.push('conformity (supply `conformityRules`)');
	if (!consistencyChecked) pendingHints.push('consistency (supply `consistencyRules`)');

	const hint = pendingHints.length === 0
		? ''
		: ` _(opt-in: ${pendingHints.join(', ')})_`;
	return `weights: ${parts.join(', ')}${hint}`;
}

function renderColumnTable(
	columns: readonly ColumnScorecard[],
	validityIncluded: boolean,
	conformityIncluded: boolean,
	out: string[],
): void {
	const header: string[] = ['column', 'composite', 'completeness', 'null rate', 'uniqueness', 'distinct'];
	if (validityIncluded)   header.push('validity');
	if (conformityIncluded) header.push('conformity');
	header.push('PK?');
	out.push(`| ${header.join(' | ')} |`);
	out.push(`|${header.map(() => '---').join('|')}|`);

	for (const c of columns) {
		const composite = formatScore(c.compositeScore);
		const cScore    = formatScore(c.completeness.score);
		const nullPct   = formatPct(c.completeness.nullRate);
		const uScore    = formatScore(c.uniqueness.score);
		const distinct  = c.uniqueness.distinctCount !== null
			? c.uniqueness.distinctCount.toLocaleString('en-US')
			: '_null_';
		const cells: string[] = [`\`${c.name}\``, composite, cScore, nullPct, uScore, distinct];
		if (validityIncluded) {
			const validity = c.validity !== undefined && c.validity.score !== null
				? `${formatScore(c.validity.score)} (\`${c.validity.pattern ?? '?'}\`)`
				: '_n/a_';
			cells.push(validity);
		}
		if (conformityIncluded) {
			const conformity = c.conformity !== undefined && c.conformity.score !== null
				? `${formatScore(c.conformity.score)} (\`${c.conformity.format ?? '?'}\`)`
				: '_n/a_';
			cells.push(conformity);
		}
		cells.push(c.uniqueness.isPrimaryKeyCandidate ? 'yes' : '');
		out.push(`| ${cells.join(' | ')} |`);
	}
}

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
