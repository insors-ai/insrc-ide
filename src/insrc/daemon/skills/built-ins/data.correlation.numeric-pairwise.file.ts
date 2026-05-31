/**
 * data.correlation.numeric-pairwise.file -- Phase 5c.1 of
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
	type CorrelationOutput,
	CORRELATION_MAX_COLUMNS,
	CORRELATION_OUTPUT_SCHEMA,
	buildCorrelationFromMatrix,
	buildCorrelationOutput,
	clampCorrelationSample,
	emptyCorrelationOutput,
	isCorrelationSampleResult,
	isDescribeResult,
	pickNumericColumns,
} from './data.correlation.numeric-pairwise.algo.js';

interface CorrelationFileInput {
	readonly connectionId: string;
	readonly columns?: readonly string[];
	readonly target?: string;
	readonly sampleSize?: number;
	readonly mode?: 'sample' | 'full-table';
}

interface CorrelationMatrixToolResult {
	readonly target: string;
	readonly columns: readonly string[];
	readonly method: 'pearson' | 'spearman';
	readonly nonNullCount: number;
	readonly matrix: readonly (readonly (number | null)[])[];
}

function isCorrelationMatrixToolResult(v: unknown): v is CorrelationMatrixToolResult {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['matrix']);
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<CorrelationFileInput, CorrelationOutput> = {
	id: 'data.correlation.numeric-pairwise.file',
	name: 'Correlation: numeric pairwise (file)',
	description: 'Pairwise Pearson + Spearman correlation across numeric columns from a file connection. Same shape as the RDBMS variant.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' } },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			mode:         { type: 'string', enum: ['sample', 'full-table'], description: 'Default sample. full-table delegates to db_file_correlation_matrix.' },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: CORRELATION_OUTPUT_SCHEMA,
	toolDeps: ['db_file_describe', 'db_file_sample', 'db_file_correlation_matrix'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_describe', 'db_file_sample', 'db_file_correlation_matrix'], reason: 'sample mode: describe + sample. full-table mode: db_file_correlation_matrix' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<CorrelationOutput>> {
		const cached = readCachedCorrelationNum(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampCorrelationSample(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const colsOrErr = await resolveColumns(input, deps, callBase, sheet);
		if (typeof colsOrErr === 'string') {
			return { value: emptyCorrelationOutput(input.target ?? ''), confidence: 'low', notes: [colsOrErr], toolCalls: [] };
		}
		const allCols = colsOrErr;
		const truncatedColumns = allCols.length > CORRELATION_MAX_COLUMNS;
		const evaluatedColumns = allCols.slice(0, CORRELATION_MAX_COLUMNS);
		if (evaluatedColumns.length < 2) {
			return {
				value: { ...emptyCorrelationOutput(input.target ?? ''), evaluatedColumns, interpretation: `need >= 2 numeric columns to compute pairwise correlations; found ${evaluatedColumns.length}` },
				confidence: 'medium',
				toolCalls: [],
			};
		}

		if (input.mode === 'full-table') {
			const matrixCols = evaluatedColumns.slice(0, 10);
			const truncatedHere = evaluatedColumns.length > 10 || truncatedColumns;
			const buildMatrixInput = (method: 'pearson' | 'spearman'): Record<string, unknown> => {
				const base: Record<string, unknown> = {
					connectionId: input.connectionId,
					columns: matrixCols,
					method,
				};
				if (sheet !== undefined) base['target'] = sheet;
				return base;
			};
			const [pearsonRes, spearmanRes] = await Promise.all([
				deps.runTool({ id: `${callBase}-corr-pearson`,  name: 'db_file_correlation_matrix', input: buildMatrixInput('pearson') }),
				deps.runTool({ id: `${callBase}-corr-spearman`, name: 'db_file_correlation_matrix', input: buildMatrixInput('spearman') }),
			]);
			if (pearsonRes.isError) {
				return { value: emptyCorrelationOutput(input.target ?? ''), confidence: 'low', notes: [`db_file_correlation_matrix(pearson) error: ${pearsonRes.content.slice(0, 200)}`], toolCalls: [] };
			}
			if (!isCorrelationMatrixToolResult(pearsonRes.data)) {
				return { value: emptyCorrelationOutput(input.target ?? ''), confidence: 'low', notes: ['db_file_correlation_matrix(pearson) returned a result without the expected structured data shape'], toolCalls: [] };
			}
			const spearmanMatrix = !spearmanRes.isError && isCorrelationMatrixToolResult(spearmanRes.data)
				? spearmanRes.data.matrix
				: null;
			const out = buildCorrelationFromMatrix(
				pearsonRes.data.target,
				matrixCols,
				truncatedHere,
				pearsonRes.data.nonNullCount,
				pearsonRes.data.matrix,
				spearmanMatrix,
			);
			pinCorrelationNum(input, out, deps);
			return { value: out, confidence: 'high', toolCalls: [] };
		}

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const sampleTool = await deps.runTool({
			id: `${callBase}-sample`,
			name: 'db_file_sample',
			input: sampleInput,
		});
		if (sampleTool.isError) {
			return { value: emptyCorrelationOutput(input.target ?? ''), confidence: 'low', notes: [`db_file_sample error: ${sampleTool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleTool.data)) {
			return {
				value: emptyCorrelationOutput(input.target ?? ''),
				confidence: 'low',
				notes: ['db_file_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		const out = buildCorrelationOutput(sampleTool.data.target, evaluatedColumns, truncatedColumns, sampleTool.data.rows);
		pinCorrelationNum(input, out, deps);
		return {
			value: out,
			confidence: 'high',
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: CorrelationFileInput, deps: SkillDeps, callBase: string, sheet: string | undefined): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describeInput: Record<string, unknown> = { connectionId: input.connectionId };
	if (sheet !== undefined) describeInput['target'] = sheet;
	const describe = await deps.runTool({ id: `${callBase}-desc`, name: 'db_file_describe', input: describeInput });
	if (describe.isError) return `db_file_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) {
		return 'db_file_describe returned a result without the expected structured data shape';
	}
	const numeric = pickNumericColumns(describe.data.columns);
	if (numeric.length === 0) return `connection '${input.connectionId}' has no numeric columns`;
	return numeric;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.correlation.numeric-pairwise.file';
const NAMESPACE = 'correlation-num-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: CorrelationFileInput): string {
	const cols = input.columns ? JSON.stringify(input.columns) : '';
	const ss = input.sampleSize ?? '';
	const m = input.mode ?? 'sample';
	const tgt = input.target ?? '';
	return `${input.connectionId}::${tgt}::${m}::${cols}::${ss}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-correlation-num',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as CorrelationFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'CorrelationOutput',
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

function readCachedCorrelationNum(input: CorrelationFileInput, deps: SkillDeps): CorrelationOutput | undefined {
	const slot = deps.context?.slots.get('cached-correlation-num');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<CorrelationOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinCorrelationNum(input: CorrelationFileInput, value: CorrelationOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_correlation_matrix' },
		payload: value,
		claims:  [`correlation-num:${cacheKey(input)}`],
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

export function registerDataCorrelationNumericPairwiseFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
