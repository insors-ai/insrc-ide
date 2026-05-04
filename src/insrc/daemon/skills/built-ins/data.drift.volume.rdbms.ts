/**
 * data.drift.volume.rdbms -- Phase 5f.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic drift skill: row-volume comparison between two windows.
 * Math + verdict in `data.drift.volume.algo.ts`.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type DriftVolumeOutput,
	type DriftVolumeWhereClauseIn,
	DRIFT_VOLUME_OUTPUT_SCHEMA,
	DRIFT_VOLUME_WHERE_SCHEMA,
	buildDriftVolume,
	emptyDriftVolume,
	pickCountColumn,
} from './data.drift.volume.algo.js';
import { collectToolErrors } from './data.drift.distribution.algo.js';
import { isAggregateResult } from './data.quality.completeness.algo.js';

interface DriftVolumeRdbmsInput {
	readonly connectionId: string;
	readonly target: string;
	readonly windowAWhere: readonly DriftVolumeWhereClauseIn[];
	readonly windowBWhere: readonly DriftVolumeWhereClauseIn[];
	readonly countColumn?: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<DriftVolumeRdbmsInput, DriftVolumeOutput> = {
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
			windowAWhere: DRIFT_VOLUME_WHERE_SCHEMA,
			windowBWhere: DRIFT_VOLUME_WHERE_SCHEMA,
			countColumn:  { type: 'string', description: 'Column to count via count_non_null. Auto-detected from PK / first non-nullable column if omitted.' },
		},
		required: ['connectionId', 'target', 'windowAWhere', 'windowBWhere'],
		additionalProperties: false,
	},
	outputs: DRIFT_VOLUME_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_describe'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_aggregate', 'db_sql_describe'], reason: 'aggregate counts rows per window; describe is used to auto-detect countColumn when omitted' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<DriftVolumeOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

		const resolved = await resolveCountColumn(input, deps, callBase);
		if (!resolved.ok) {
			return { value: emptyDriftVolume(input.target, ''), confidence: 'low', notes: [resolved.error], toolCalls: [] };
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
			return { value: emptyDriftVolume(input.target, countColumn), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggA.data) || !isAggregateResult(aggB.data)) {
			return {
				value: emptyDriftVolume(input.target, countColumn),
				confidence: 'low',
				notes: ['drift.volume: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const key = `${countColumn}__count_non_null`;
		const countA = aggA.data.values[key] ?? null;
		const countB = aggB.data.values[key] ?? null;
		const built = buildDriftVolume(aggA.data.target, countColumn, countA, countB);
		if (built.degradedConfidence !== null) {
			return { value: built.output, confidence: built.degradedConfidence, toolCalls: [] };
		}
		return { value: built.output, confidence: 'high', toolCalls: [] };
	},
};

type ColumnResolved = { ok: true; column: string } | { ok: false; error: string };

async function resolveCountColumn(input: DriftVolumeRdbmsInput, deps: SkillDeps, callBase: string): Promise<ColumnResolved> {
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
	const picked = pickCountColumn(cols);
	if (picked === null) return { ok: false, error: `target '${input.target}' has no primary-key or non-nullable column; pass countColumn explicitly` };
	return { ok: true, column: picked };
}

export function registerDataDriftVolumeRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
