/**
 * data.quality.completeness.rdbms -- Phase 5d.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the completeness algo.
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
	type QualityCompletenessOutput,
	COMPLETENESS_COL_CAP,
	COMPLETENESS_OUTPUT_SCHEMA,
	buildCompleteness,
	completenessAggregationsFor,
	emptyCompleteness,
	isAggregateResult,
} from './data.quality.completeness.algo.js';
import { isDescribeResult } from './data.correlation.numeric-pairwise.algo.js';

interface QualityCompletenessInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<QualityCompletenessInput, QualityCompletenessOutput> = {
	id: 'data.quality.completeness.rdbms',
	name: 'Quality: completeness (RDBMS)',
	description: 'Per-column null rate plus overall table null rate. Up to 31 columns per call.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 31 },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: COMPLETENESS_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_describe', 'db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_describe', 'db_sql_aggregate'], reason: 'describe gives column list; aggregate gives counts' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<QualityCompletenessOutput>> {
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
			return { value: emptyCompleteness(input.target), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		const truncated = cols.length > COMPLETENESS_COL_CAP;
		const usedCols = truncated ? cols.slice(0, COMPLETENESS_COL_CAP) : cols;
		if (truncated) notes.push(`completeness truncated: ${cols.length} columns -> profiling first ${COMPLETENESS_COL_CAP}.`);

		const aggResult = await deps.runTool({
			id: `${callBase}-agg`,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: completenessAggregationsFor(usedCols),
			},
		});
		if (aggResult.isError) {
			return { value: emptyCompleteness(input.target), confidence: 'low', notes: [...notes, `db_sql_aggregate error: ${aggResult.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isAggregateResult(aggResult.data)) {
			return {
				value: emptyCompleteness(input.target),
				confidence: 'low',
				notes: [...notes, 'db_sql_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const out = buildCompleteness(aggResult.data.target, usedCols, truncated, aggResult.data.values);
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

async function resolveColumns(input: QualityCompletenessInput, deps: SkillDeps, callBase: string): Promise<readonly string[] | string> {
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

const OWNER_ID: OwnerId = 'skill:data.quality.completeness.rdbms';
const NAMESPACE = 'completeness-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: QualityCompletenessInput): string {
	const cols = (input.columns ?? []).slice().sort().join(',');
	return `${input.connectionId}::${input.target}::${cols}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-report',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as QualityCompletenessInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'QualityCompletenessOutput',
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

function readCachedReport(input: QualityCompletenessInput, deps: SkillDeps): QualityCompletenessOutput | undefined {
	const slot = deps.context?.slots.get('cached-report');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<QualityCompletenessOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReport(input: QualityCompletenessInput, value: QualityCompletenessOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_aggregate' },
		payload: value,
		claims:  [`completeness:${cacheKey(input)}`],
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

export function registerDataQualityCompletenessRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
