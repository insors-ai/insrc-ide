/**
 * data.profile.numeric.rdbms -- Phase 5a.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: server-side numeric profile of one RDBMS column. Thin
 * wrapper that builds the aggregations spec via
 * `numericAggregationsFor`, calls `db_sql_aggregate`, and translates
 * the flat values record into a typed `ProfileNumericOutput` via
 * `buildNumericProfile`. The `.file` sibling at
 * `data.profile.numeric.file` shares the same algo module; both
 * wrappers stay in lock-step on the math by construction.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type ProfileNumericOutput,
	NUMERIC_PROFILE_OUTPUT_SCHEMA,
	buildNumericProfile,
	emptyNumericProfile,
	isAggregateResult,
	numericAggregationsFor,
} from './data.profile.numeric.algo.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

interface ProfileNumericInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ProfileNumericInput, ProfileNumericOutput> = {
	id: 'data.profile.numeric.rdbms',
	name: 'Profile: numeric column (RDBMS)',
	description:
		'Server-side numeric profile of one RDBMS column: count + null rate + distinct cardinality + ' +
		'min / max / avg / stddev / variance + p50 / p95 percentiles. Single tool round-trip; the LLM ' +
		'never computes stats from row samples.',
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
	outputs: NUMERIC_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate'],
			reason: 'numeric profile pushes every aggregation server-side',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only; file connections route through `data.profile.numeric.file`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileNumericOutput>> {
		// Substrate: cache hit short-circuits the tool call.
		const cached = readCachedProfile(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: (cached.nonNullCount ?? 0) > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
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
				aggregations: numericAggregationsFor(input.column),
			},
		});

		if (tool.isError) {
			return {
				value: emptyNumericProfile(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_aggregate error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isAggregateResult(tool.data)) {
			return {
				value: emptyNumericProfile(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const profile = buildNumericProfile(tool.data.target, input.column, tool.data.values);
		const confidence = (profile.nonNullCount ?? 0) > 0 ? 'high' : 'medium';
		if (confidence === 'high') {
			pinProfile(input, profile, deps);
		}
		return { value: profile, confidence, toolCalls: [] };
	},
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Numeric profile drifts with the underlying data; 24h TTL is the
// standard for every data.profile.* skill.

const OWNER_ID: OwnerId = 'skill:data.profile.numeric.rdbms';
const NAMESPACE = 'numeric-profiles';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ProfileNumericInput): string {
	return `${input.connectionId}::${input.target}::${input.column}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-profile',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ProfileNumericInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'ProfileNumericOutput',
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

function readCachedProfile(input: ProfileNumericInput, deps: SkillDeps): ProfileNumericOutput | undefined {
	const slot = deps.context?.slots.get('cached-profile');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ProfileNumericOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinProfile(input: ProfileNumericInput, value: ProfileNumericOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_aggregate' },
		payload: value,
		claims:  [`numeric-profile:${cacheKey(input)}`],
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

export function registerDataProfileNumericRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
