/**
 * data.quality.uniqueness.rdbms -- Phase 5d.2 of
 * plans/analyzers/data-analyzer-skills.md.
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
	type QualityUniquenessOutput,
	UNIQUENESS_COL_CAP,
	UNIQUENESS_OUTPUT_SCHEMA,
	buildUniqueness,
	compositePkAggregationsFor,
	emptyUniqueness,
	uniquenessAggregationsFor,
} from './data.quality.uniqueness.algo.js';
import { isAggregateResult } from './data.quality.completeness.algo.js';
import { isDescribeResult } from './data.correlation.numeric-pairwise.algo.js';

interface QualityUniquenessInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
	/** Optional list of candidate composite PK tuples. Each entry must
	 *  have >= 2 column names. Each tuple consumes one aggregation
	 *  spec; up to 16 candidates fit alongside a 15-column single-PK
	 *  scan. */
	readonly compositePkCandidates?: readonly (readonly string[])[];
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<QualityUniquenessInput, QualityUniquenessOutput> = {
	id: 'data.quality.uniqueness.rdbms',
	name: 'Quality: uniqueness (RDBMS)',
	description: 'Per-column uniqueness ratio + single-column PK candidate detection. Up to 15 columns per call.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 15 },
			compositePkCandidates: {
				type: 'array',
				items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
				minItems: 1,
				maxItems: 16,
				description: 'Candidate composite PK tuples; each runs one composite_distinct_count aggregate.',
			},
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: UNIQUENESS_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_describe', 'db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_describe', 'db_sql_aggregate'], reason: 'describe gives column list; aggregate gives counts' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<QualityUniquenessOutput>> {
		const cached = readCachedReport(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.totalRows !== null && cached.totalRows > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const notes: string[] = [];

		const cols = await resolveColumns(input, deps, callBase);
		if (typeof cols === 'string') {
			return { value: emptyUniqueness(input.target), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		const truncated = cols.length > UNIQUENESS_COL_CAP;
		const usedCols = truncated ? cols.slice(0, UNIQUENESS_COL_CAP) : cols;
		if (truncated) notes.push(`uniqueness truncated: ${cols.length} columns -> profiling first ${UNIQUENESS_COL_CAP}.`);

		const compositeCandidates = (input.compositePkCandidates ?? []).filter(t => t.length >= 2);
		const aggregations = [
			...uniquenessAggregationsFor(usedCols),
			...compositePkAggregationsFor(compositeCandidates),
		];
		const aggResult = await deps.runTool({
			id: `${callBase}-agg`,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations,
			},
		});
		if (aggResult.isError) {
			return { value: emptyUniqueness(input.target), confidence: 'low', notes: [...notes, `db_sql_aggregate error: ${aggResult.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isAggregateResult(aggResult.data)) {
			return {
				value: emptyUniqueness(input.target),
				confidence: 'low',
				notes: [...notes, 'db_sql_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const out = buildUniqueness(aggResult.data.target, usedCols, truncated, aggResult.data.values, compositeCandidates);
		const confidence: 'high' | 'medium' = out.totalRows !== null && out.totalRows > 0 ? 'high' : 'medium';
		if (confidence === 'high') {
			pinReport(input, out, deps);
		}
		return {
			value: out,
			confidence,
			...(notes.length > 0 ? { notes } : {}),
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: QualityUniquenessInput, deps: SkillDeps, callBase: string): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describe = await deps.runTool({ id: `${callBase}-desc`, name: 'db_sql_describe', input: { connectionId: input.connectionId, target: input.target } });
	if (describe.isError) return `db_sql_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) return 'db_sql_describe returned a result without the expected structured data shape';
	const cols = describe.data.columns.map(c => c.name).filter(n => typeof n === 'string' && n.length > 0);
	if (cols.length === 0) return `target '${input.target}' has no columns`;
	return cols;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.quality.uniqueness.rdbms';
const NAMESPACE = 'uniqueness-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: QualityUniquenessInput): string {
	const cols = (input.columns ?? []).slice().sort().join(',');
	const composites = (input.compositePkCandidates ?? [])
		.map(t => t.slice().sort().join('+'))
		.sort()
		.join('|');
	return `${input.connectionId}::${input.target}::${cols}::${composites}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-report',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as QualityUniquenessInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'QualityUniquenessOutput',
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

function readCachedReport(input: QualityUniquenessInput, deps: SkillDeps): QualityUniquenessOutput | undefined {
	const slot = deps.context?.slots.get('cached-report');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<QualityUniquenessOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReport(input: QualityUniquenessInput, value: QualityUniquenessOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_aggregate' },
		payload: value,
		claims:  [`uniqueness:${cacheKey(input)}`],
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

export function registerDataQualityUniquenessRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
