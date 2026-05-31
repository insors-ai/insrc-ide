/**
 * data.distribution.outliers-mad.rdbms -- Phase 5b.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the shared MAD algo. The
 * `.file` sibling shares the algo module.
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
	type OutliersMadOutput,
	OUTLIERS_MAD_OUTPUT_SCHEMA,
	buildOutliersMad,
	clampMadThreshold,
	emptyOutliersMad,
	outliersMadAggregationsFor,
} from './data.distribution.outliers-mad.algo.js';
import {
	clampSampleSize,
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface OutliersMadInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly threshold?: number;
	readonly sampleSize?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<OutliersMadInput, OutliersMadOutput> = {
	id: 'data.distribution.outliers-mad.rdbms',
	name: 'Distribution: MAD outliers (RDBMS)',
	description:
		'Modified Z-score outlier detection via MAD (median absolute deviation). Best fit for heavy-tailed ' +
		'columns where Z-score / IQR under-detect. Default threshold 3.5; v1 computes MAD over a 50-row ' +
		'sample.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			threshold:    { type: 'number', minimum: 0.5, maximum: 10 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: OUTLIERS_MAD_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_aggregate', 'db_sql_sample'], reason: 'aggregate gives the median; sample lets us compute MAD + examples' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<OutliersMadOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const threshold = clampMadThreshold(input.threshold);
		const sampleSize = clampSampleSize(input.sampleSize);
		const normalized: OutliersMadInput = { ...input, threshold, sampleSize };

		// Substrate: cache hit short-circuits the tool calls.
		const cached = readCachedDistribution(normalized, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.lowerBound !== null && cached.upperBound !== null && cached.sampleSize > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: outliersMadAggregationsFor(input.column),
				},
			}),
			deps.runTool({
				id: `${callBase}-sample`,
				name: 'db_sql_sample',
				input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate', aggTool], ['db_sql_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyOutliersMad(input.target, input.column, threshold), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyOutliersMad(input.target, input.column, threshold),
				confidence: 'low',
				notes: ['outliers-mad: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildOutliersMad(
			aggTool.data.target,
			input.column,
			threshold,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		const confidence = out.lowerBound !== null && out.upperBound !== null && out.sampleSize > 0 ? 'high' : 'medium';
		if (confidence === 'high') {
			pinDistribution(normalized, out, deps);
		}
		return {
			value: out,
			confidence,
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.distribution.outliers-mad.rdbms';
const NAMESPACE = 'outliers-mad-distributions';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: OutliersMadInput): string {
	return `${input.connectionId}::${input.target}::${input.column}::${input.threshold ?? ''}::${input.sampleSize ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-distribution',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as OutliersMadInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'OutliersMadOutput',
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

function readCachedDistribution(input: OutliersMadInput, deps: SkillDeps): OutliersMadOutput | undefined {
	const slot = deps.context?.slots.get('cached-distribution');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<OutliersMadOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDistribution(input: OutliersMadInput, value: OutliersMadOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_aggregate' },
		payload: value,
		claims:  [`outliers-mad:${cacheKey(input)}`],
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

export function registerDataDistributionOutliersMadRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
