/**
 * data.profile.temporal.rdbms -- Phase 5a.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper around `db_sql_aggregate`.
 * Math + output shape live in `data.profile.temporal.algo`; the
 * `.file` sibling at `data.profile.temporal.file` shares the same
 * algo module so both wrappers stay in lock-step.
 *
 * Min/max range + gap detection + period inference remain deferred
 * (see algo file's header) -- gated on a type-aware aggregation
 * tool.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type ProfileTemporalOutput,
	TEMPORAL_DEFERRED_NOTE,
	TEMPORAL_PROFILE_OUTPUT_SCHEMA,
	buildTemporalProfile,
	emptyTemporalProfile,
	isAggregateResult,
	temporalAggregationsFor,
} from './data.profile.temporal.algo.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

interface ProfileTemporalInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ProfileTemporalInput, ProfileTemporalOutput> = {
	id: 'data.profile.temporal.rdbms',
	name: 'Profile: temporal column (RDBMS)',
	description:
		'Server-side temporal-column profile: count + null rate + distinct cardinality. Min / max range and ' +
		'gap / period inference are follow-ups gated on a type-aware aggregation tool.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: TEMPORAL_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate'],
			reason: 'count + non-null + distinct count via the standard aggregate path',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only; file connections route through `data.profile.temporal.file`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileTemporalOutput>> {
		// Substrate: cache hit short-circuits the tool call.
		const cached = readCachedProfile(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: (cached.nonNullCount ?? 0) > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)', TEMPORAL_DEFERRED_NOTE],
				toolCalls: [],
			};
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: temporalAggregationsFor(input.column),
			},
		});

		if (tool.isError) {
			return {
				value: emptyTemporalProfile(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_aggregate error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isAggregateResult(tool.data)) {
			return {
				value: emptyTemporalProfile(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const profile = buildTemporalProfile(tool.data.target, input.column, tool.data.values);
		const confidence = (profile.nonNullCount ?? 0) > 0 ? 'high' : 'medium';
		if (confidence === 'high') {
			pinProfile(input, profile, deps);
		}
		return {
			value: profile,
			confidence,
			notes: [TEMPORAL_DEFERRED_NOTE],
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Temporal profile drifts with the underlying data; 24h TTL is the
// standard for every data.profile.* skill.

const OWNER_ID: OwnerId = 'skill:data.profile.temporal.rdbms';
const NAMESPACE = 'temporal-profiles';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ProfileTemporalInput): string {
	return `${input.connectionId}::${input.target}::${input.column}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-profile',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ProfileTemporalInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'ProfileTemporalOutput',
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

function readCachedProfile(input: ProfileTemporalInput, deps: SkillDeps): ProfileTemporalOutput | undefined {
	const slot = deps.context?.slots.get('cached-profile');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ProfileTemporalOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinProfile(input: ProfileTemporalInput, value: ProfileTemporalOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_aggregate' },
		payload: value,
		claims:  [`temporal-profile:${cacheKey(input)}`],
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

export function registerDataProfileTemporalRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
