/**
 * data.profile.categorical.file -- Phase 5a.2 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 *
 * Mirrors `data.profile.categorical.rdbms`; same algo module. Calls
 * `db_file_aggregate` + `db_file_distinct`. `target` optional (xlsx
 * sheet selector under tool-side `path`).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';
import {
	type ProfileCategoricalOutput,
	CATEGORICAL_DEFAULT_TOP_N,
	CATEGORICAL_PROFILE_OUTPUT_SCHEMA,
	buildCategoricalProfile,
	categoricalAggregationsFor,
	emptyCategoricalProfile,
	isAggregateResult,
	isDistinctResult,
} from './data.profile.categorical.algo.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

interface ProfileCategoricalFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly topN?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<ProfileCategoricalFileInput, ProfileCategoricalOutput> = {
	id: 'data.profile.categorical.file',
	name: 'Profile: categorical column (file)',
	description:
		'Server-side categorical profile of one file-connection column: count + null rate + distinct ' +
		'cardinality + top-N values (count + frequency). Default topN=20, max 100. xlsx sheet selection ' +
		'via the optional `target` field.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			topN:         { type: 'integer', minimum: 1, maximum: 100 },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: CATEGORICAL_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_distinct'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_aggregate', 'db_file_distinct'],
			reason: 'aggregate + distinct via the DuckDB-backed file driver',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file-only; RDBMS connections route through `data.profile.categorical.rdbms`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileCategoricalOutput>> {
		// Substrate: cache hit short-circuits the two tool calls.
		const cached = readCachedProfile(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: (cached.nonNullCount ?? 0) > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const topN = input.topN ?? CATEGORICAL_DEFAULT_TOP_N;
		const sheetPath = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const aggInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			aggregations: categoricalAggregationsFor(input.column),
		};
		if (sheetPath !== undefined) aggInput['path'] = sheetPath;

		const distInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			column: input.column,
			topN,
		};
		if (sheetPath !== undefined) distInput['path'] = sheetPath;

		const [aggTool, distTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-agg`,  name: 'db_file_aggregate', input: aggInput }),
			deps.runTool({ id: `${callBase}-dist`, name: 'db_file_distinct',  input: distInput }),
		]);

		const errors = collectToolErrors([['db_file_aggregate', aggTool], ['db_file_distinct', distTool]]);
		if (errors.length > 0) {
			return { value: emptyCategoricalProfile(input.target ?? '', input.column), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isDistinctResult(distTool.data)) {
			return {
				value: emptyCategoricalProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['categorical profile: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const profile = buildCategoricalProfile(
			aggTool.data.target,
			input.column,
			aggTool.data.values,
			distTool.data.distinctCount,
			distTool.data.topValues,
		);
		const confidence = (profile.nonNullCount ?? 0) > 0 ? 'high' : 'medium';
		if (confidence === 'high') {
			pinProfile(input, profile, deps);
		}
		return {
			value: profile,
			confidence,
			toolCalls: [],
		};
	},
};

function collectToolErrors(
	pairs: readonly (readonly [string, SkillToolResult])[],
): string[] {
	const out: string[] = [];
	for (const [name, res] of pairs) {
		if (res.isError) out.push(`${name} error: ${res.content.slice(0, 200)}`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Categorical profile drifts with the underlying data; 24h TTL is the
// standard for every data.profile.* skill. topN affects the output
// (changes the top-N values list), so it's part of the cache key.

const OWNER_ID: OwnerId = 'skill:data.profile.categorical.file';
const NAMESPACE = 'categorical-profiles';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ProfileCategoricalFileInput): string {
	return `${input.connectionId}::${input.target ?? ''}::${input.column}::topN=${input.topN ?? CATEGORICAL_DEFAULT_TOP_N}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-profile',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ProfileCategoricalFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'ProfileCategoricalOutput',
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

function readCachedProfile(input: ProfileCategoricalFileInput, deps: SkillDeps): ProfileCategoricalOutput | undefined {
	const slot = deps.context?.slots.get('cached-profile');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ProfileCategoricalOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinProfile(input: ProfileCategoricalFileInput, value: ProfileCategoricalOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_aggregate' },
		payload: value,
		claims:  [`categorical-profile:${cacheKey(input)}`],
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

export function registerDataProfileCategoricalFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
