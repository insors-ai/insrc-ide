/**
 * data.correlation.categorical-pairwise.file -- Phase 5c.2 of
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
	type CorrelationCatOutput,
	CORR_CAT_MAX_COLUMNS,
	CORRELATION_CAT_OUTPUT_SCHEMA,
	buildCorrelationCatOutput,
	clampCorrCatSample,
	clampMaxDistinct,
	emptyCorrelationCatOutput,
	filterByCardinality,
	pickCategoricalColumns,
} from './data.correlation.categorical-pairwise.algo.js';
import {
	isCorrelationSampleResult,
	isDescribeResult,
} from './data.correlation.numeric-pairwise.algo.js';

interface CorrelationCatFileInput {
	readonly connectionId: string;
	readonly columns?: readonly string[];
	readonly target?: string;
	readonly sampleSize?: number;
	readonly maxDistinctPerColumn?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<CorrelationCatFileInput, CorrelationCatOutput> = {
	id: 'data.correlation.categorical-pairwise.file',
	name: 'Correlation: categorical pairwise (file)',
	description: 'Pairwise Cramér\'s V across categorical columns from a file connection. Same shape as the RDBMS variant.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:         { type: 'string' },
			columns:              { type: 'array', items: { type: 'string' } },
			target:               { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:           { type: 'integer', minimum: 1, maximum: 50 },
			maxDistinctPerColumn: { type: 'integer', minimum: 2, maximum: 50 },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: CORRELATION_CAT_OUTPUT_SCHEMA,
	toolDeps: ['db_file_describe', 'db_file_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_describe', 'db_file_sample'], reason: 'describe gives the categorical column list; sample gives the rows we tabulate' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<CorrelationCatOutput>> {
		const cached = readCachedCorrelationCat(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampCorrCatSample(input.sampleSize);
		const maxDistinct = clampMaxDistinct(input.maxDistinctPerColumn);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const colsOrErr = await resolveColumns(input, deps, callBase, sheet);
		if (typeof colsOrErr === 'string') {
			return { value: emptyCorrelationCatOutput(input.target ?? ''), confidence: 'low', notes: [colsOrErr], toolCalls: [] };
		}

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const sampleTool = await deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample', input: sampleInput });
		if (sampleTool.isError) {
			return { value: emptyCorrelationCatOutput(input.target ?? ''), confidence: 'low', notes: [`db_file_sample error: ${sampleTool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleTool.data)) {
			return {
				value: emptyCorrelationCatOutput(input.target ?? ''),
				confidence: 'low',
				notes: ['db_file_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		const rows = sampleTool.data.rows;

		const { evaluatedColumns: filtered, droppedHighCardinality } = filterByCardinality(colsOrErr, rows, maxDistinct);
		const truncatedColumns = filtered.length > CORR_CAT_MAX_COLUMNS;
		const evaluatedColumns = filtered.slice(0, CORR_CAT_MAX_COLUMNS);
		if (evaluatedColumns.length < 2) {
			return {
				value: {
					...emptyCorrelationCatOutput(input.target ?? ''),
					sampleSize: rows.length,
					evaluatedColumns,
					droppedHighCardinality,
					interpretation: `need >= 2 categorical columns (post-cardinality filter) to compute V; found ${evaluatedColumns.length}. Dropped ${droppedHighCardinality.length} high-cardinality column(s).`,
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		const value = buildCorrelationCatOutput(sampleTool.data.target, evaluatedColumns, droppedHighCardinality, truncatedColumns, rows);
		pinCorrelationCat(input, value, deps);
		return {
			value,
			confidence: 'high',
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: CorrelationCatFileInput, deps: SkillDeps, callBase: string, sheet: string | undefined): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describeInput: Record<string, unknown> = { connectionId: input.connectionId };
	if (sheet !== undefined) describeInput['target'] = sheet;
	const describe = await deps.runTool({ id: `${callBase}-desc`, name: 'db_file_describe', input: describeInput });
	if (describe.isError) return `db_file_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) return 'db_file_describe returned a result without the expected structured data shape';
	const categorical = pickCategoricalColumns(describe.data.columns);
	if (categorical.length === 0) return `connection '${input.connectionId}' has no categorical columns`;
	return categorical;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.correlation.categorical-pairwise.file';
const NAMESPACE = 'correlation-cat-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: CorrelationCatFileInput): string {
	const cols = input.columns ? JSON.stringify(input.columns) : '';
	const ss = input.sampleSize ?? '';
	const md = input.maxDistinctPerColumn ?? '';
	const tgt = input.target ?? '';
	return `${input.connectionId}::${tgt}::${cols}::${ss}::${md}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-correlation-cat',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as CorrelationCatFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'CorrelationCatOutput',
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

function readCachedCorrelationCat(input: CorrelationCatFileInput, deps: SkillDeps): CorrelationCatOutput | undefined {
	const slot = deps.context?.slots.get('cached-correlation-cat');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<CorrelationCatOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinCorrelationCat(input: CorrelationCatFileInput, value: CorrelationCatOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_sample' },
		payload: value,
		claims:  [`correlation-cat:${cacheKey(input)}`],
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

export function registerDataCorrelationCategoricalPairwiseFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
