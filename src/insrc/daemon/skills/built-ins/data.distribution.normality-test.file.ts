/**
 * data.distribution.normality-test.file -- Phase 5b.5 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
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
	type NormalityTestOutput,
	NORMALITY_TEST_OUTPUT_SCHEMA,
	NORMALITY_TEST_SAMPLE_SIZE,
	buildNormalityTest,
	clampAlpha,
	emptyNormalityTest,
	normalityTestAggregationsFor,
} from './data.distribution.normality-test.algo.js';
import {
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface NormalityTestFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly sampleSize?: number;
	readonly alpha?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<NormalityTestFileInput, NormalityTestOutput> = {
	id: 'data.distribution.normality-test.file',
	name: 'Distribution: Jarque-Bera normality test (file)',
	description: 'Jarque-Bera normality test on a numeric column from a file connection. Same shape as the RDBMS variant.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 50, maximum: 50 },
			alpha:        { type: 'number',  minimum: 0.001, maximum: 0.5 },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: NORMALITY_TEST_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_aggregate', 'db_file_sample'], reason: 'aggregate gives mean/stddev; sample gives values for skewness + kurtosis' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<NormalityTestOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const alpha = clampAlpha(input.alpha);
		const normalized: NormalityTestFileInput = { ...input, alpha };
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		// Substrate: cache hit short-circuits the tool calls.
		const cached = readCachedDistribution(normalized, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.verdict === 'inconclusive' ? 'medium' : 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const aggInput: Record<string, unknown> = { connectionId: input.connectionId, aggregations: normalityTestAggregationsFor(input.column) };
		if (sheet !== undefined) aggInput['path'] = sheet;
		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: NORMALITY_TEST_SAMPLE_SIZE };
		if (sheet !== undefined) sampleInput['target'] = sheet;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-agg`,    name: 'db_file_aggregate', input: aggInput }),
			deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample',    input: sampleInput }),
		]);

		const errors = collectToolErrors([['db_file_aggregate', aggTool], ['db_file_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyNormalityTest(input.target ?? '', input.column, alpha), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyNormalityTest(input.target ?? '', input.column, alpha),
				confidence: 'low',
				notes: ['normality-test: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildNormalityTest(
			aggTool.data.target,
			input.column,
			alpha,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		const confidence = out.verdict === 'inconclusive' ? 'medium' : 'high';
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

const OWNER_ID: OwnerId = 'skill:data.distribution.normality-test.file';
const NAMESPACE = 'normality-distributions';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: NormalityTestFileInput): string {
	return `${input.connectionId}::${input.target ?? ''}::${input.column}::${input.sampleSize ?? ''}::${input.alpha ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-distribution',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as NormalityTestFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'NormalityTestOutput',
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

function readCachedDistribution(input: NormalityTestFileInput, deps: SkillDeps): NormalityTestOutput | undefined {
	const slot = deps.context?.slots.get('cached-distribution');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<NormalityTestOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDistribution(input: NormalityTestFileInput, value: NormalityTestOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_aggregate' },
		payload: value,
		claims:  [`normality:${cacheKey(input)}`],
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

export function registerDataDistributionNormalityTestFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
