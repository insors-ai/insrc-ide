/**
 * data.profile.text.rdbms -- Phase 5a.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over `db_sql_aggregate`
 * (count + non-null + distinct) and `db_sql_sample` (rows for length
 * stats). Math + sample-based length computation in
 * `data.profile.text.algo`. The `.file` sibling shares the same
 * algo module.
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

interface ProfileTextInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ProfileTextInput, ProfileTextOutput> = {
	id: 'data.profile.text.rdbms',
	name: 'Profile: text column (RDBMS)',
	description:
		'Server-side cardinality + null rate plus sample-based length statistics (min / max / avg / median) ' +
		'for one text column. Sample size capped at 50; default 50.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: TEXT_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives counts; sample gives values for length stats',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only; file connections route through `data.profile.text.file`',
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

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: textAggregationsFor(input.column),
				},
			}),
			deps.runTool({
				id: `${callBase}-sample`,
				name: 'db_sql_sample',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					limit: sampleSize,
				},
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate', aggTool], ['db_sql_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyTextProfile(input.target, input.column), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyTextProfile(input.target, input.column),
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
// We use clampTextSample on the value so distinct user-supplied values
// that clamp to the same effective sample collide on the same cache
// entry.

const OWNER_ID: OwnerId = 'skill:data.profile.text.rdbms';
const NAMESPACE = 'text-profiles';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ProfileTextInput): string {
	return `${input.connectionId}::${input.target}::${input.column}::sample=${clampTextSample(input.sampleSize)}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-profile',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ProfileTextInput;
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

function readCachedProfile(input: ProfileTextInput, deps: SkillDeps): ProfileTextOutput | undefined {
	const slot = deps.context?.slots.get('cached-profile');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ProfileTextOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinProfile(input: ProfileTextInput, value: ProfileTextOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_aggregate' },
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

export function registerDataProfileTextRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
