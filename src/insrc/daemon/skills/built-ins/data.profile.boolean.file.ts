/**
 * data.profile.boolean.file -- Phase 5a.5 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant of the
 * RDBMS profiler).
 *
 * Atomic skill: thin file-connection wrapper that asks
 * `db_file_distinct` for the column's top-N distinct values and
 * delegates the bucketing + dialect-tolerant boolean normalisation
 * to `data.profile.boolean.algo`. Same algorithm as the .rdbms
 * sibling.
 *
 * `target` is OPTIONAL on the file side (connection.path is the
 * default). When supplied, it maps to the file driver's `path`
 * parameter (xlsx sheet name; ignored for other kinds).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type ProfileBooleanOutput,
	BOOLEAN_DISTINCT_TOP_N,
	BOOLEAN_PROFILE_OUTPUT_SCHEMA,
	buildBooleanProfile,
	emptyBooleanProfile,
	isDistinctResult,
} from './data.profile.boolean.algo.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

interface ProfileBooleanFileInput {
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

const skill: Skill<ProfileBooleanFileInput, ProfileBooleanOutput> = {
	id: 'data.profile.boolean.file',
	name: 'Profile: boolean column (file)',
	description:
		'Server-side boolean profile of one file-connection column. Returns true / false / null / other ' +
		'counts plus the true ratio. Single tool round-trip via `db_file_distinct` (DuckDB-backed). ' +
		'Covers every file kind the consolidated driver supports. xlsx sheet selection via the optional ' +
		'`target` field.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name. Other file kinds usually ignore.' },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: BOOLEAN_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_file_distinct'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_distinct'],
			reason: 'GROUP BY over the column gives us per-bucket counts in one round-trip via the DuckDB-backed file driver',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file-only; RDBMS connections route through `data.profile.boolean.rdbms`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileBooleanOutput>> {
		// Substrate: cache hit short-circuits the tool call.
		const cached = readCachedProfile(input, deps);
		if (cached !== undefined) {
			const nonNullObserved = cached.trueCount + cached.falseCount + cached.otherCount;
			return {
				value: cached,
				confidence: nonNullObserved > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			column: input.column,
			topN: BOOLEAN_DISTINCT_TOP_N,
		};
		if (input.target !== undefined && input.target.length > 0) {
			toolInput['path'] = input.target;
		}

		const tool = await deps.runTool({
			id: callId,
			name: 'db_file_distinct',
			input: toolInput,
		});

		if (tool.isError) {
			return {
				value: emptyBooleanProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: [`db_file_distinct error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isDistinctResult(tool.data)) {
			return {
				value: emptyBooleanProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['db_file_distinct returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const profile = buildBooleanProfile(tool.data.target, input.column, tool.data.topValues);
		const nonNullObserved = profile.trueCount + profile.falseCount + profile.otherCount;
		if (nonNullObserved > 0) {
			pinProfile(input, profile, deps);
		}
		return {
			value: profile,
			confidence: nonNullObserved > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Boolean profile drifts with the underlying data; 24h TTL is the
// standard for every data.profile.* skill.

const OWNER_ID: OwnerId = 'skill:data.profile.boolean.file';
const NAMESPACE = 'boolean-profiles';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ProfileBooleanFileInput): string {
	return `${input.connectionId}::${input.target ?? ''}::${input.column}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-profile',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ProfileBooleanFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'ProfileBooleanOutput',
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

function readCachedProfile(input: ProfileBooleanFileInput, deps: SkillDeps): ProfileBooleanOutput | undefined {
	const slot = deps.context?.slots.get('cached-profile');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ProfileBooleanOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinProfile(input: ProfileBooleanFileInput, value: ProfileBooleanOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_distinct' },
		payload: value,
		claims:  [`boolean-profile:${cacheKey(input)}`],
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

export function registerDataProfileBooleanFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
