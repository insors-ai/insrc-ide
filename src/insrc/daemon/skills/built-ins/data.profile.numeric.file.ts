/**
 * data.profile.numeric.file -- Phase 5a.1 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant of the
 * RDBMS profiler).
 *
 * Atomic skill: server-side numeric profile of one column on a file
 * connection. Mirrors `data.profile.numeric.rdbms` -- same algorithm,
 * same output shape, same single-tool-round-trip cost. Only the
 * transport differs: this wrapper calls `db_file_aggregate` and
 * accepts file-family connections (csv / tsv / jsonl / ndjson / json
 * / parquet / arrow / feather / avro / bson / fixed-width / xlsx --
 * the consolidated DuckDB-backed file driver covers all 12).
 *
 * `target` is OPTIONAL on the file side -- the connection's `path`
 * field already names the file or directory. Caller passes `target`
 * only when selecting an xlsx sheet (which the file-aggregate tool
 * accepts under the `path` parameter name -- a tool-surface
 * inconsistency tracked in plans/analyzers/data-analyzer-skills.md
 * "Open cleanup work" §1).
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

interface ProfileNumericFileInput {
	readonly connectionId: string;
	readonly column: string;
	/** Optional. xlsx: sheet name. Other file kinds usually ignore. */
	readonly target?: string;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<ProfileNumericFileInput, ProfileNumericOutput> = {
	id: 'data.profile.numeric.file',
	name: 'Profile: numeric column (file)',
	description:
		'Server-side numeric profile of one file-connection column. Same shape as the RDBMS variant ' +
		'(count + null rate + distinct cardinality + min / max / avg / stddev / variance + p50 / p95). ' +
		'Single tool round-trip via `db_file_aggregate` (DuckDB-backed). Covers every file kind the ' +
		'consolidated driver supports. xlsx sheet selection via the optional `target` field.',
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
	outputs: NUMERIC_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_aggregate'],
			reason: 'numeric profile pushes every aggregation server-side via the DuckDB-backed file driver',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file-only; RDBMS connections route through `data.profile.numeric.rdbms`',
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
		// db_file_aggregate's `target` semantics live under the `path`
		// field name (xlsx sheet selector for that kind, ignored
		// elsewhere). We translate at the boundary so the skill input
		// stays uniformly named `target` across the .rdbms / .file pair.
		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			aggregations: numericAggregationsFor(input.column),
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
				value: emptyNumericProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: [`db_file_aggregate error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isAggregateResult(tool.data)) {
			return {
				value: emptyNumericProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['db_file_aggregate returned a result without the expected structured data shape'],
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

const OWNER_ID: OwnerId = 'skill:data.profile.numeric.file';
const NAMESPACE = 'numeric-profiles';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ProfileNumericFileInput): string {
	return `${input.connectionId}::${input.target ?? ''}::${input.column}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-profile',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ProfileNumericFileInput;
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

function readCachedProfile(input: ProfileNumericFileInput, deps: SkillDeps): ProfileNumericOutput | undefined {
	const slot = deps.context?.slots.get('cached-profile');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ProfileNumericOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinProfile(input: ProfileNumericFileInput, value: ProfileNumericOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_aggregate' },
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

export function registerDataProfileNumericFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
