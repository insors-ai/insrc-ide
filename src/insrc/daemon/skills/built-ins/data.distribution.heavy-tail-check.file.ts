/**
 * data.distribution.heavy-tail-check.file -- Phase 5b.6 of
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
	type HeavyTailOutput,
	HEAVY_TAIL_OUTPUT_SCHEMA,
	HEAVY_TAIL_SAMPLE_SIZE,
	buildHeavyTailCheck,
	clampHeavyTailThreshold,
	emptyHeavyTailCheck,
	heavyTailAggregationsFor,
} from './data.distribution.heavy-tail-check.algo.js';
import {
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface HeavyTailFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly threshold?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<HeavyTailFileInput, HeavyTailOutput> = {
	id: 'data.distribution.heavy-tail-check.file',
	name: 'Distribution: heavy-tail check (file)',
	description: 'Binary verdict on tail heaviness from sample kurtosis. Same shape as the RDBMS variant.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			threshold:    { type: 'number', minimum: 0.1, maximum: 10 },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: HEAVY_TAIL_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_aggregate', 'db_file_sample'], reason: 'aggregate gives mean/stddev; sample gives values for kurtosis' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<HeavyTailOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const threshold = clampHeavyTailThreshold(input.threshold);
		const normalized: HeavyTailFileInput = { ...input, threshold };
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

		const aggInput: Record<string, unknown> = { connectionId: input.connectionId, aggregations: heavyTailAggregationsFor(input.column) };
		if (sheet !== undefined) aggInput['path'] = sheet;
		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: HEAVY_TAIL_SAMPLE_SIZE };
		if (sheet !== undefined) sampleInput['target'] = sheet;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-agg`,    name: 'db_file_aggregate', input: aggInput }),
			deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample',    input: sampleInput }),
		]);

		const errors = collectToolErrors([['db_file_aggregate', aggTool], ['db_file_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyHeavyTailCheck(input.target ?? '', input.column, threshold), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyHeavyTailCheck(input.target ?? '', input.column, threshold),
				confidence: 'low',
				notes: ['heavy-tail-check: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildHeavyTailCheck(
			aggTool.data.target,
			input.column,
			threshold,
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

const OWNER_ID: OwnerId = 'skill:data.distribution.heavy-tail-check.file';
const NAMESPACE = 'heavy-tail-distributions';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: HeavyTailFileInput): string {
	return `${input.connectionId}::${input.target ?? ''}::${input.column}::${input.threshold ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-distribution',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as HeavyTailFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'HeavyTailOutput',
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

function readCachedDistribution(input: HeavyTailFileInput, deps: SkillDeps): HeavyTailOutput | undefined {
	const slot = deps.context?.slots.get('cached-distribution');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<HeavyTailOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDistribution(input: HeavyTailFileInput, value: HeavyTailOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_aggregate' },
		payload: value,
		claims:  [`heavy-tail:${cacheKey(input)}`],
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

export function registerDataDistributionHeavyTailCheckFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
