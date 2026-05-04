/**
 * data.drift.volume.rdbms -- Phase 5f.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic drift skill: row-volume comparison between two windows.
 * Caller defines windows A and B via WhereClause arrays (typically
 * filtering on a timestamp column); skill counts rows in each via
 * `db_sql_aggregate(count_non_null)` and reports absolute / relative
 * change + a verdict ladder.
 *
 * Pairs with `data.drift.distribution.rdbms` (5f.1): distribution
 * drift catches "shape changed" between windows; volume drift catches
 * "how much got produced" -- a sudden volume drop on an event table
 * is a different signal than a distribution shift on the same table.
 *
 * Counting strategy
 *   `db_sql_aggregate` requires a column for `count_non_null`. The
 *   caller supplies `countColumn`; if omitted the skill auto-detects
 *   via `db_sql_describe` -- prefers a primary-key column, falls
 *   back to the first non-nullable column. Errors out if neither is
 *   available so the caller is forced to be explicit.
 *
 * Verdict ladder (abs(percentChange)):
 *   stable             < 10%
 *   minor-change       10% .. 25%
 *   significant-drop   <= -25%
 *   significant-spike  >= +25%
 *   inconclusive       countA = 0 (no baseline to compare against)
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';

interface WhereClauseIn {
	readonly column: string;
	readonly op: '=' | '!=' | 'in' | 'is null';
	readonly value?: unknown;
}

interface DriftVolumeInput {
	readonly connectionId: string;
	readonly target: string;
	readonly windowAWhere: readonly WhereClauseIn[];
	readonly windowBWhere: readonly WhereClauseIn[];
	readonly countColumn?: string;
}

type Verdict = 'stable' | 'minor-change' | 'significant-drop' | 'significant-spike' | 'inconclusive';

interface DriftVolumeOutput {
	readonly target: string;
	readonly countColumn: string;
	readonly windowA: { readonly count: number | null };
	readonly windowB: { readonly count: number | null };
	readonly absoluteChange: number | null;       // countB - countA
	readonly relativeChange: number | null;       // (countB - countA) / countA
	readonly percentChange: number | null;        // relativeChange * 100
	readonly ratio: number | null;                // countB / countA
	readonly verdict: Verdict;
	readonly interpretation: string;
}

const WHERE_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			column: { type: 'string' },
			op:     { type: 'string', enum: ['=', '!=', 'in', 'is null'] },
			value:  {},
		},
		required: ['column', 'op'],
		additionalProperties: false,
	},
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<DriftVolumeInput, DriftVolumeOutput> = {
	id: 'data.drift.volume.rdbms',
	name: 'Drift: row volume between windows (RDBMS)',
	description:
		'Row-volume drift between two windows. Caller supplies two WhereClause filters (typically on ' +
		'a timestamp column) defining the windows; skill counts rows in each via db_sql_aggregate and ' +
		'reports absolute / relative change + a verdict (stable / minor-change / significant-drop / ' +
		'significant-spike / inconclusive). countColumn is auto-detected from PK / first non-nullable ' +
		'column if not supplied. Pairs with `data.drift.distribution.rdbms` (5f.1) -- volume drift = ' +
		'how much got produced; distribution drift = whether the shape of values changed.',
	family: 'drift',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			windowAWhere: WHERE_SCHEMA,
			windowBWhere: WHERE_SCHEMA,
			countColumn:  { type: 'string', description: 'Column to count via count_non_null. Auto-detected from PK / first non-nullable column if omitted.' },
		},
		required: ['connectionId', 'target', 'windowAWhere', 'windowBWhere'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:      { type: 'string' },
			countColumn: { type: 'string' },
			windowA: {
				type: 'object',
				properties: { count: { type: ['number', 'null'] } },
				required: ['count'],
				additionalProperties: false,
			},
			windowB: {
				type: 'object',
				properties: { count: { type: ['number', 'null'] } },
				required: ['count'],
				additionalProperties: false,
			},
			absoluteChange: { type: ['number', 'null'] },
			relativeChange: { type: ['number', 'null'] },
			percentChange:  { type: ['number', 'null'] },
			ratio:          { type: ['number', 'null'] },
			verdict:        { type: 'string', enum: ['stable', 'minor-change', 'significant-drop', 'significant-spike', 'inconclusive'] },
			interpretation: { type: 'string' },
		},
		required: ['target', 'countColumn', 'windowA', 'windowB',
		           'absoluteChange', 'relativeChange', 'percentChange', 'ratio',
		           'verdict', 'interpretation'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_describe'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_describe'],
			reason: 'aggregate counts rows per window; describe is used to auto-detect countColumn when omitted',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<DriftVolumeOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

		const resolved = await resolveCountColumn(input, deps, callBase);
		if (!resolved.ok) {
			return { value: empty(input.target, ''), confidence: 'low', notes: [resolved.error], toolCalls: [] };
		}
		const countColumn = resolved.column;

		const [aggA, aggB] = await Promise.all([
			deps.runTool({
				id: `${callBase}-a`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: [{ column: countColumn, function: 'count_non_null' }],
					where: input.windowAWhere,
				},
			}),
			deps.runTool({
				id: `${callBase}-b`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: [{ column: countColumn, function: 'count_non_null' }],
					where: input.windowBWhere,
				},
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate(A)', aggA], ['db_sql_aggregate(B)', aggB]]);
		if (errors.length > 0) {
			return { value: empty(input.target, countColumn), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggA.data) || !isAggregateResult(aggB.data)) {
			return {
				value: empty(input.target, countColumn),
				confidence: 'low',
				notes: ['drift.volume: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const key = `${countColumn}__count_non_null`;
		const countA = aggA.data.values[key] ?? null;
		const countB = aggB.data.values[key] ?? null;

		if (countA === null || countB === null) {
			return {
				value: { ...empty(input.target, countColumn), windowA: { count: countA }, windowB: { count: countB }, interpretation: 'count_non_null returned null for one or both windows; cannot compute drift' },
				confidence: 'medium',
				toolCalls: [],
			};
		}

		const absoluteChange = countB - countA;
		let relativeChange: number | null;
		let percentChange:  number | null;
		let ratio:          number | null;
		let verdict: Verdict;

		if (countA === 0) {
			// No baseline; can't form a ratio. If countB is also 0
			// the windows are both empty -- verdict 'stable' (no
			// production, no change). Otherwise it's a "from-zero"
			// spike that the relative-change formula can't express.
			relativeChange = null;
			percentChange  = null;
			ratio          = null;
			verdict = countB === 0 ? 'stable' : 'inconclusive';
		} else {
			relativeChange = (countB - countA) / countA;
			percentChange  = relativeChange * 100;
			ratio          = countB / countA;
			const absPct = Math.abs(percentChange);
			if (absPct < 10) verdict = 'stable';
			else if (absPct < 25) verdict = 'minor-change';
			else if (percentChange < 0) verdict = 'significant-drop';
			else verdict = 'significant-spike';
		}

		const interpretation = describe(verdict, countA, countB, percentChange);

		return {
			value: {
				target: aggA.data.target,
				countColumn,
				windowA: { count: countA },
				windowB: { count: countB },
				absoluteChange, relativeChange, percentChange, ratio,
				verdict,
				interpretation,
			},
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function describe(verdict: Verdict, a: number, b: number, pct: number | null): string {
	if (verdict === 'stable' && a === 0 && b === 0) {
		return 'both windows empty (0 rows each); no production to compare';
	}
	if (verdict === 'inconclusive') {
		return `window A is empty (0 rows) but window B has ${b}; cannot compute relative change from zero baseline (treat as 'from-zero spike' qualitatively)`;
	}
	const dir = (pct ?? 0) >= 0 ? '+' : '';
	const pctStr = pct === null ? 'n/a' : `${dir}${pct.toFixed(1)}%`;
	switch (verdict) {
		case 'stable':            return `stable: ${a} -> ${b} rows (${pctStr})`;
		case 'minor-change':      return `minor change: ${a} -> ${b} rows (${pctStr})`;
		case 'significant-drop':  return `significant drop: ${a} -> ${b} rows (${pctStr}); investigate for outage / pipeline failure / filter regression`;
		case 'significant-spike': return `significant spike: ${a} -> ${b} rows (${pctStr}); investigate for surge / replay / duplicate ingestion`;
		default:                  return '';
	}
}

type ColumnResolved = { ok: true; column: string } | { ok: false; error: string };

async function resolveCountColumn(
	input: DriftVolumeInput,
	deps: SkillDeps,
	callBase: string,
): Promise<ColumnResolved> {
	if (input.countColumn !== undefined && input.countColumn.length > 0) {
		return { ok: true, column: input.countColumn };
	}
	const describe = await deps.runTool({
		id: `${callBase}-desc`,
		name: 'db_sql_describe',
		input: { connectionId: input.connectionId, target: input.target },
	});
	if (describe.isError) {
		return { ok: false, error: `db_sql_describe error: ${describe.content.slice(0, 200)}` };
	}
	const data = describe.data;
	if (typeof data !== 'object' || data === null || !Array.isArray((data as { columns?: unknown }).columns)) {
		return { ok: false, error: 'db_sql_describe returned a result without the expected structured data shape' };
	}
	const cols = (data as { columns: { name: string; nullable?: boolean; primaryKey?: boolean }[] }).columns;
	const pk = cols.find(c => c.primaryKey === true);
	if (pk) return { ok: true, column: pk.name };
	const nonNullable = cols.find(c => c.nullable === false);
	if (nonNullable) return { ok: true, column: nonNullable.name };
	return { ok: false, error: `target '${input.target}' has no primary-key or non-nullable column; pass countColumn explicitly` };
}

function empty(target: string, countColumn: string): DriftVolumeOutput {
	return {
		target,
		countColumn,
		windowA: { count: null },
		windowB: { count: null },
		absoluteChange: null,
		relativeChange: null,
		percentChange:  null,
		ratio:          null,
		verdict: 'inconclusive',
		interpretation: '',
	};
}

function collectToolErrors(
	pairs: readonly (readonly [string, SkillToolResult])[],
): string[] {
	const out: string[] = [];
	for (const [name, res] of pairs) {
		if (res.isError) out.push(`${name} error: ${res.content.slice(0, 200)}`);
	}
	return out;
}

interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

export function registerDataDriftVolumeRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
