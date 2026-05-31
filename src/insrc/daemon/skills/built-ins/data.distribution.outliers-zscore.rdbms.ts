/**
 * data.distribution.outliers-zscore.rdbms -- Phase 5b.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the shared zscore algo.
 * The `.file` sibling at `data.distribution.outliers-zscore.file`
 * shares the same algo module.
 *
 * Z-score outlier detection is parametric -- assumes roughly normal
 * data; for skewed columns prefer the IQR (5b.2) or MAD (5b.4)
 * variants.
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
	type OutliersSource,
	type OutliersZScoreOutput,
	OUTLIERS_ZSCORE_OUTPUT_SCHEMA,
	buildOutliersZScore,
	buildOutliersZScoreFromOutlierTool,
	clampZScoreThreshold,
	emptyOutliersZScore,
	outliersZScoreAggregationsFor,
} from './data.distribution.outliers-zscore.algo.js';
import {
	clampSampleSize,
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface OutliersZScoreInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly threshold?: number;
	readonly sampleSize?: number;
	readonly mode?: OutliersSource;
}

interface OutlierToolResultRaw {
	readonly target: string;
	readonly column: string;
	readonly threshold: number;
	readonly nonNullCount: number;
	readonly lowerBound: number | null;
	readonly upperBound: number | null;
	readonly belowCount: number;
	readonly aboveCount: number;
	readonly center: number | null;
	readonly spread: number | null;
	readonly examples: readonly { value: number; side: 'below' | 'above' }[];
}

function isOutlierToolResult(v: unknown): v is OutlierToolResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& Array.isArray(o['examples']);
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<OutliersZScoreInput, OutliersZScoreOutput> = {
	id: 'data.distribution.outliers-zscore.rdbms',
	name: 'Distribution: Z-score outliers (RDBMS)',
	description:
		'Z-score outlier detection on a numeric column. Bounds = mean ± threshold·stddev. Default threshold ' +
		'3.0. Parametric -- assumes roughly normal data; pair with profile.numeric.rdbms to check before ' +
		'using on skewed columns.',
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
			mode:         { type: 'string', enum: ['sample', 'full-table'], description: 'Default sample. full-table delegates to db_sql_outliers.' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: OUTLIERS_ZSCORE_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_sample', 'db_sql_outliers'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_aggregate', 'db_sql_sample', 'db_sql_outliers'], reason: 'sample mode: aggregate + sample. full-table mode: db_sql_outliers' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<OutliersZScoreOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const threshold = clampZScoreThreshold(input.threshold);
		const sampleSize = clampSampleSize(input.sampleSize);
		const normalized: OutliersZScoreInput = { ...input, threshold, sampleSize };

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

		if (input.mode === 'full-table') {
			const tool = await deps.runTool({
				id: `${callBase}-outliers`,
				name: 'db_sql_outliers',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					column: input.column,
					method: 'zscore',
					threshold,
				},
			});
			if (tool.isError) {
				return { value: emptyOutliersZScore(input.target, input.column, threshold), confidence: 'low', notes: [`db_sql_outliers error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
			}
			if (!isOutlierToolResult(tool.data)) {
				return {
					value: emptyOutliersZScore(input.target, input.column, threshold),
					confidence: 'low',
					notes: ['db_sql_outliers returned a result without the expected structured data shape'],
					toolCalls: [],
				};
			}
			const out = buildOutliersZScoreFromOutlierTool(tool.data);
			const confidence = out.lowerBound !== null && out.upperBound !== null ? 'high' : 'medium';
			if (confidence === 'high') {
				pinDistribution(normalized, out, deps);
			}
			return {
				value: out,
				confidence,
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
					aggregations: outliersZScoreAggregationsFor(input.column),
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
			return { value: emptyOutliersZScore(input.target, input.column, threshold), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyOutliersZScore(input.target, input.column, threshold),
				confidence: 'low',
				notes: ['outliers-zscore: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildOutliersZScore(
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

const OWNER_ID: OwnerId = 'skill:data.distribution.outliers-zscore.rdbms';
const NAMESPACE = 'outliers-zscore-distributions';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: OutliersZScoreInput): string {
	return `${input.connectionId}::${input.target}::${input.column}::${input.threshold ?? ''}::${input.sampleSize ?? ''}::${input.mode ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-distribution',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as OutliersZScoreInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'OutliersZScoreOutput',
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

function readCachedDistribution(input: OutliersZScoreInput, deps: SkillDeps): OutliersZScoreOutput | undefined {
	const slot = deps.context?.slots.get('cached-distribution');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<OutliersZScoreOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDistribution(input: OutliersZScoreInput, value: OutliersZScoreOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_aggregate' },
		payload: value,
		claims:  [`outliers-zscore:${cacheKey(input)}`],
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

export function registerDataDistributionOutliersZScoreRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
