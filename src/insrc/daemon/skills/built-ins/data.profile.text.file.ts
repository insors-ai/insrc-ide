/**
 * data.profile.text.file -- Phase 5a.4 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 *
 * Mirrors `data.profile.text.rdbms`; same algo module. Calls
 * `db_file_aggregate` + `db_file_sample`. `target` optional (xlsx
 * sheet selector under tool-side `path`).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';
import {
	type ProfileTextOutput,
	TEXT_PROFILE_OUTPUT_SCHEMA,
	buildTextProfile,
	clampTextSample,
	emptyTextProfile,
	isAggregateResult,
	isSampleResult,
	textAggregationsFor,
} from './data.profile.text.algo.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

interface ProfileTextFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly sampleSize?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<ProfileTextFileInput, ProfileTextOutput> = {
	id: 'data.profile.text.file',
	name: 'Profile: text column (file)',
	description:
		'Server-side cardinality + null rate plus sample-based length statistics for one text column on a ' +
		'file connection. Sample size capped at 50; default 50. xlsx sheet selection via the optional ' +
		'`target` field.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: TEXT_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_aggregate', 'db_file_sample'],
			reason: 'aggregate gives counts; sample gives values for length stats',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file-only; RDBMS connections route through `data.profile.text.rdbms`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileTextOutput>> {
		// Substrate: cache hit short-circuits the two tool calls.
		const cached = readCachedProfile(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: (cached.nonNullCount ?? 0) > 0 && cached.sampleSize > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampTextSample(input.sampleSize);
		const sheetPath = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const aggInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			aggregations: textAggregationsFor(input.column),
		};
		if (sheetPath !== undefined) aggInput['path'] = sheetPath;

		// db_file_sample uses `target` (not `path`) as the sheet selector
		// -- another tool-surface inconsistency tracked in the
		// "Open cleanup work" section. We translate accordingly.
		const sampleInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			limit: sampleSize,
		};
		if (sheetPath !== undefined) sampleInput['target'] = sheetPath;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-agg`,    name: 'db_file_aggregate', input: aggInput }),
			deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample',    input: sampleInput }),
		]);

		const errors = collectToolErrors([['db_file_aggregate', aggTool], ['db_file_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyTextProfile(input.target ?? '', input.column), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyTextProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['text profile: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const profile = buildTextProfile(
			aggTool.data.target,
			input.column,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		const confidence = (profile.nonNullCount ?? 0) > 0 && profile.sampleSize > 0 ? 'high' : 'medium';
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
// Text profile drifts with the underlying data; 24h TTL is the standard
// for every data.profile.* skill. sampleSize is part of the cache key
// because it changes the sample-derived length / encoding statistics.

const OWNER_ID: OwnerId = 'skill:data.profile.text.file';
const NAMESPACE = 'text-profiles';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ProfileTextFileInput): string {
	return `${input.connectionId}::${input.target ?? ''}::${input.column}::sample=${clampTextSample(input.sampleSize)}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-profile',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ProfileTextFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'ProfileTextOutput',
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

function readCachedProfile(input: ProfileTextFileInput, deps: SkillDeps): ProfileTextOutput | undefined {
	const slot = deps.context?.slots.get('cached-profile');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ProfileTextOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinProfile(input: ProfileTextFileInput, value: ProfileTextOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_aggregate' },
		payload: value,
		claims:  [`text-profile:${cacheKey(input)}`],
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

export function registerDataProfileTextFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
