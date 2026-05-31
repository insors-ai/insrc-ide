/**
 * data.profile.boolean.rdbms -- Phase 5a.5 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper that asks `db_sql_distinct` for
 * the column's top-N distinct values and delegates the bucketing +
 * normalisation math to `data.profile.boolean.algo`. The `.file`
 * sibling at `data.profile.boolean.file` shares the same algo
 * module; both wrappers stay in lock-step on the math by construction.
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

interface ProfileBooleanInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ProfileBooleanInput, ProfileBooleanOutput> = {
	id: 'data.profile.boolean.rdbms',
	name: 'Profile: boolean column (RDBMS)',
	description:
		'Server-side boolean profile of one RDBMS column. Returns true / false / null / other counts plus ' +
		'the true ratio (over non-null observations). Normalizes wire-format differences across Postgres / ' +
		'MySQL / MSSQL / SQLite / Oracle / DuckDB.',
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
	outputs: BOOLEAN_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_distinct'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_distinct'],
			reason: 'GROUP BY over the column gives us the per-bucket counts in one round-trip',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only; file connections route through `data.profile.boolean.file`',
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
		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_distinct',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				column: input.column,
				topN: BOOLEAN_DISTINCT_TOP_N,
			},
		});

		if (tool.isError) {
			return {
				value: emptyBooleanProfile(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_distinct error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isDistinctResult(tool.data)) {
			return {
				value: emptyBooleanProfile(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_distinct returned a result without the expected structured data shape'],
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

const OWNER_ID: OwnerId = 'skill:data.profile.boolean.rdbms';
const NAMESPACE = 'boolean-profiles';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ProfileBooleanInput): string {
	return `${input.connectionId}::${input.target}::${input.column}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-profile',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ProfileBooleanInput;
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

function readCachedProfile(input: ProfileBooleanInput, deps: SkillDeps): ProfileBooleanOutput | undefined {
	const slot = deps.context?.slots.get('cached-profile');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ProfileBooleanOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinProfile(input: ProfileBooleanInput, value: ProfileBooleanOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_distinct' },
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

export function registerDataProfileBooleanRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
