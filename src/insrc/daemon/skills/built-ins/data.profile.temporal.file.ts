/**
 * data.profile.temporal.file -- Phase 5a.3 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 *
 * Mirrors `data.profile.temporal.rdbms`; same algo module, same
 * deferred-math caveat. Calls `db_file_aggregate`. `target` is
 * optional (xlsx sheet name; ignored elsewhere).
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

interface ProfileTemporalFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<ProfileTemporalFileInput, ProfileTemporalOutput> = {
	id: 'data.profile.temporal.file',
	name: 'Profile: temporal column (file)',
	description:
		'Server-side temporal-column profile for a file connection: count + null rate + distinct cardinality. ' +
		'Min / max range and gap / period inference are deferred (same caveat as the RDBMS variant).',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: TEMPORAL_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_aggregate'],
			reason: 'count + non-null + distinct via the DuckDB-backed file driver',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file-only; RDBMS connections route through `data.profile.temporal.rdbms`',
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
		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			aggregations: temporalAggregationsFor(input.column),
		};
		if (input.target !== undefined && input.target.length > 0) {
			toolInput['path'] = input.target;
		}

		const tool = await deps.runTool({
			id: callId,
			name: 'db_file_aggregate',
			input: toolInput,
		});

		if (tool.isError) {
			return {
				value: emptyTemporalProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: [`db_file_aggregate error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isAggregateResult(tool.data)) {
			return {
				value: emptyTemporalProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['db_file_aggregate returned a result without the expected structured data shape'],
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

const OWNER_ID: OwnerId = 'skill:data.profile.temporal.file';
const NAMESPACE = 'temporal-profiles';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ProfileTemporalFileInput): string {
	return `${input.connectionId}::${input.target ?? ''}::${input.column}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-profile',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ProfileTemporalFileInput;
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

function readCachedProfile(input: ProfileTemporalFileInput, deps: SkillDeps): ProfileTemporalOutput | undefined {
	const slot = deps.context?.slots.get('cached-profile');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ProfileTemporalOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinProfile(input: ProfileTemporalFileInput, value: ProfileTemporalOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_aggregate' },
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

export function registerDataProfileTemporalFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
