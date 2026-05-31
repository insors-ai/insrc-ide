/**
 * data.drift.volume.file -- Phase 5f.2 (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';
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

interface DriftVolumeFileInput {
	readonly connectionId: string;
	readonly windowAWhere: readonly DriftVolumeWhereClauseIn[];
	readonly windowBWhere: readonly DriftVolumeWhereClauseIn[];
	readonly countColumn?: string;
	readonly target?: string;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<DriftVolumeFileInput, DriftVolumeOutput> = {
	id: 'data.drift.volume.file',
	name: 'Drift: row volume between windows (file)',
	description:
		'Row-volume drift between two windows of a file connection. Caller supplies two WhereClause filters; ' +
		'skill counts rows in each via db_file_aggregate. countColumn is auto-detected from PK / first ' +
		'non-nullable column if not supplied. Same shape as the RDBMS variant.',
	family: 'drift',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			windowAWhere: DRIFT_VOLUME_WHERE_SCHEMA,
			windowBWhere: DRIFT_VOLUME_WHERE_SCHEMA,
			countColumn:  { type: 'string', description: 'Column to count via count_non_null. Auto-detected from PK / first non-nullable column if omitted.' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
		},
		required: ['connectionId', 'windowAWhere', 'windowBWhere'],
		additionalProperties: false,
	},
	outputs: DRIFT_VOLUME_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_describe'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_aggregate', 'db_file_describe'], reason: 'aggregate counts rows per window; describe is used to auto-detect countColumn when omitted' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<DriftVolumeOutput>> {
		const cached = readCachedDriftVolume(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const resolved = await resolveCountColumn(input, deps, callBase, sheet);
		if (!resolved.ok) {
			return { value: emptyDriftVolume(input.target ?? '', ''), confidence: 'low', notes: [resolved.error], toolCalls: [] };
		}
		const countColumn = resolved.column;

		// db_file_aggregate uses `path` (not `target`) for xlsx sheets;
		// align with that here.
		const buildAggInput = (where: readonly DriftVolumeWhereClauseIn[]): Record<string, unknown> => {
			const base: Record<string, unknown> = {
				connectionId: input.connectionId,
				aggregations: [{ column: countColumn, function: 'count_non_null' }],
				where,
			};
			if (sheet !== undefined) base['path'] = sheet;
			return base;
		};

		const [aggA, aggB] = await Promise.all([
			deps.runTool({ id: `${callBase}-a`, name: 'db_file_aggregate', input: buildAggInput(input.windowAWhere) }),
			deps.runTool({ id: `${callBase}-b`, name: 'db_file_aggregate', input: buildAggInput(input.windowBWhere) }),
		]);

		const errors = collectToolErrors([['db_file_aggregate(A)', aggA], ['db_file_aggregate(B)', aggB]]);
		if (errors.length > 0) {
			return { value: emptyDriftVolume(input.target ?? '', countColumn), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggA.data) || !isAggregateResult(aggB.data)) {
			return {
				value: emptyDriftVolume(input.target ?? '', countColumn),
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
		pinDriftVolume(input, built.output, deps);
		return { value: built.output, confidence: 'high', toolCalls: [] };
	},
};

type ColumnResolved = { ok: true; column: string } | { ok: false; error: string };

async function resolveCountColumn(input: DriftVolumeFileInput, deps: SkillDeps, callBase: string, sheet: string | undefined): Promise<ColumnResolved> {
	if (input.countColumn !== undefined && input.countColumn.length > 0) {
		return { ok: true, column: input.countColumn };
	}
	const describeInput: Record<string, unknown> = { connectionId: input.connectionId };
	if (sheet !== undefined) describeInput['target'] = sheet;
	const describe = await deps.runTool({
		id: `${callBase}-desc`,
		name: 'db_file_describe',
		input: describeInput,
	});
	if (describe.isError) {
		return { ok: false, error: `db_file_describe error: ${describe.content.slice(0, 200)}` };
	}
	const data = describe.data;
	if (typeof data !== 'object' || data === null || !Array.isArray((data as { columns?: unknown }).columns)) {
		return { ok: false, error: 'db_file_describe returned a result without the expected structured data shape' };
	}
	const cols = (data as { columns: { name: string; nullable?: boolean; primaryKey?: boolean }[] }).columns;
	const picked = pickCountColumn(cols);
	if (picked === null) return { ok: false, error: `connection '${input.connectionId}' has no primary-key or non-nullable column; pass countColumn explicitly` };
	return { ok: true, column: picked };
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.drift.volume.file';
const NAMESPACE = 'drift-volume-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: DriftVolumeFileInput): string {
	const cc = input.countColumn ?? '';
	const tgt = input.target ?? '';
	return `${input.connectionId}::${tgt}::${cc}::${JSON.stringify(input.windowAWhere)}::${JSON.stringify(input.windowBWhere)}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-drift-volume',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as DriftVolumeFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'DriftVolumeOutput',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '24h',
	},
];

const substrateExtension: SubstrateSkillExtension = {
	ownerId:            OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	contextSlots:       CONTEXT_SLOTS,
	memorySchema:       MEMORY_SCHEMA,
	assertionInterests: [],
};

function readCachedDriftVolume(input: DriftVolumeFileInput, deps: SkillDeps): DriftVolumeOutput | undefined {
	const slot = deps.context?.slots.get('cached-drift-volume');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<DriftVolumeOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDriftVolume(input: DriftVolumeFileInput, value: DriftVolumeOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_aggregate' },
		payload: value,
		claims:  [`drift-volume:${cacheKey(input)}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: NAMESPACE,
		key:       cacheKey(input),
		kind:      'fact',
		ttlMs:     TTL_MS,
	});
}

const skillWithSubstrate = { ...skill, ...substrateExtension };

export function registerDataDriftVolumeFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
