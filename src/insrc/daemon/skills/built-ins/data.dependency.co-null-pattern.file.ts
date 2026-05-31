/**
 * data.dependency.co-null-pattern.file -- Phase 5c.4 of
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
	type CoNullOutput,
	type CoNullSource,
	CO_NULL_COL_CAP,
	CO_NULL_OUTPUT_SCHEMA,
	CO_NULL_PAIRS_PER_BATCH,
	buildCoNullOutput,
	buildCoNullOutputFromCounts,
	clampCoNullSample,
	coNullPairAggregations,
	emptyCoNullOutput,
} from './data.dependency.co-null-pattern.algo.js';
import { isAggregateResult } from './data.quality.completeness.algo.js';
import {
	isCorrelationSampleResult,
	isDescribeResult,
} from './data.correlation.numeric-pairwise.algo.js';

interface CoNullFileInput {
	readonly connectionId: string;
	readonly columns?: readonly string[];
	readonly target?: string;
	readonly sampleSize?: number;
	readonly mode?: CoNullSource;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<CoNullFileInput, CoNullOutput> = {
	id: 'data.dependency.co-null-pattern.file',
	name: 'Dependency: pairwise null co-occurrence (file)',
	description: 'Pairwise null co-occurrence over a sample of a file connection. Same shape as the RDBMS variant.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 15 },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			mode:         { type: 'string', enum: ['sample', 'full-table'], description: 'Default sample. full-table uses count_where aggregates.' },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: CO_NULL_OUTPUT_SCHEMA,
	toolDeps: ['db_file_describe', 'db_file_sample', 'db_file_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_describe', 'db_file_sample', 'db_file_aggregate'], reason: 'describe gives the column list; sample (mode=sample) or aggregate (mode=full-table) supplies the counts' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<CoNullOutput>> {
		const cached = readCachedCoNull(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampCoNullSample(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;
		const notes: string[] = [];

		const cols = await resolveColumns(input, deps, callBase, sheet);
		if (typeof cols === 'string') {
			return { value: emptyCoNullOutput(input.target ?? ''), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		if (cols.length < 2) {
			return {
				value: { target: input.target ?? '', sampleSize: 0, columns: cols, pairs: [], truncated: false, source: 'sample', totalRows: null },
				confidence: 'medium',
				notes: ['co-null-pattern needs at least 2 columns; nothing to compare'],
				toolCalls: [],
			};
		}

		const truncated = cols.length > CO_NULL_COL_CAP;
		const usedCols = truncated ? cols.slice(0, CO_NULL_COL_CAP) : cols;
		if (truncated) {
			notes.push(`co-null-pattern truncated: ${cols.length} columns -> profiling first ${CO_NULL_COL_CAP}.`);
		}

		if (input.mode === 'full-table') {
			const fullResult = await runFullTable(input, deps, callBase, sheet, usedCols, truncated);
			if (typeof fullResult === 'string') {
				return { value: emptyCoNullOutput(input.target ?? ''), confidence: 'low', notes: [...notes, fullResult], toolCalls: [] };
			}
			const allNotes = [...notes, ...fullResult.notes];
			const confidence: 'high' | 'medium' = fullResult.anyNull ? 'high' : 'medium';
			if (confidence === 'high') {
				pinCoNull(input, fullResult.output, deps);
			}
			return {
				value: fullResult.output,
				confidence,
				...(allNotes.length > 0 ? { notes: allNotes } : {}),
				toolCalls: [],
			};
		}

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const sampleResult = await deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample', input: sampleInput });
		if (sampleResult.isError) {
			return { value: emptyCoNullOutput(input.target ?? ''), confidence: 'low', notes: [...notes, `db_file_sample error: ${sampleResult.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleResult.data)) {
			return {
				value: emptyCoNullOutput(input.target ?? ''),
				confidence: 'low',
				notes: [...notes, 'db_file_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const built = buildCoNullOutput(sampleResult.data.target, usedCols, sampleResult.data.rows, sampleResult.data.columns, truncated);
		const allNotes = [...notes, ...built.notes];
		const confidence: 'high' | 'medium' = built.anyNull ? 'high' : 'medium';
		if (confidence === 'high') {
			pinCoNull(input, built.output, deps);
		}
		return {
			value: built.output,
			confidence,
			...(allNotes.length > 0 ? { notes: allNotes } : {}),
			toolCalls: [],
		};
	},
};

async function runFullTable(
	input: CoNullFileInput,
	deps: SkillDeps,
	callBase: string,
	sheet: string | undefined,
	usedCols: readonly string[],
	truncated: boolean,
): Promise<{ output: CoNullOutput; notes: readonly string[]; anyNull: boolean } | string> {
	const totalInput: Record<string, unknown> = {
		connectionId: input.connectionId,
		aggregations: [{ column: '*', function: 'count' }],
	};
	if (sheet !== undefined) totalInput['path'] = sheet;
	const totalRes = await deps.runTool({ id: `${callBase}-total`, name: 'db_file_aggregate', input: totalInput });
	if (totalRes.isError) return `db_file_aggregate(count) error: ${totalRes.content.slice(0, 200)}`;
	if (!isAggregateResult(totalRes.data)) return 'db_file_aggregate count returned a result without the expected structured data shape';
	const totalRows = Number(totalRes.data.values['*__count'] ?? 0);

	const pairs: { a: string; b: string }[] = [];
	for (let i = 0; i < usedCols.length; i++) {
		for (let j = i + 1; j < usedCols.length; j++) {
			pairs.push({ a: usedCols[i]!, b: usedCols[j]! });
		}
	}

	const counts: { columnA: string; columnB: string; bothNull: number; aNullOnly: number; bNullOnly: number; neitherNull: number }[] = [];
	for (let off = 0; off < pairs.length; off += CO_NULL_PAIRS_PER_BATCH) {
		const batch = pairs.slice(off, off + CO_NULL_PAIRS_PER_BATCH);
		const aggregations = batch.flatMap(p => coNullPairAggregations(p.a, p.b));
		const aggInput: Record<string, unknown> = { connectionId: input.connectionId, aggregations };
		if (sheet !== undefined) aggInput['path'] = sheet;
		const aggRes = await deps.runTool({ id: `${callBase}-pairs-${off}`, name: 'db_file_aggregate', input: aggInput });
		if (aggRes.isError) return `db_file_aggregate(pairs) error: ${aggRes.content.slice(0, 200)}`;
		if (!isAggregateResult(aggRes.data)) return 'db_file_aggregate pairs returned a result without the expected structured data shape';
		for (const p of batch) {
			const keys = coNullPairAggregations(p.a, p.b).map(spec => `${spec.column}__count_where_${[
				...spec.args.predicate.map(c => `${c.column}_${c.op.replace(/[^a-z0-9]/gi, '')}`),
			].join('__')}`);
			const v = aggRes.data.values;
			counts.push({
				columnA: p.a, columnB: p.b,
				bothNull:    Number(v[keys[0]!] ?? 0),
				aNullOnly:   Number(v[keys[1]!] ?? 0),
				bNullOnly:   Number(v[keys[2]!] ?? 0),
				neitherNull: Number(v[keys[3]!] ?? 0),
			});
		}
	}

	return buildCoNullOutputFromCounts(input.target ?? '', usedCols, counts, totalRows, truncated);
}

async function resolveColumns(input: CoNullFileInput, deps: SkillDeps, callBase: string, sheet: string | undefined): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describeInput: Record<string, unknown> = { connectionId: input.connectionId };
	if (sheet !== undefined) describeInput['target'] = sheet;
	const describe = await deps.runTool({ id: `${callBase}-desc`, name: 'db_file_describe', input: describeInput });
	if (describe.isError) return `db_file_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) return 'db_file_describe returned a result without the expected structured data shape';
	const cols = describe.data.columns.map(c => c.name).filter(n => typeof n === 'string' && n.length > 0);
	if (cols.length === 0) return `connection '${input.connectionId}' has no columns`;
	return cols;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.dependency.co-null-pattern.file';
const NAMESPACE = 'co-null-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: CoNullFileInput): string {
	const cols = input.columns ? JSON.stringify(input.columns) : '';
	const ss = input.sampleSize ?? '';
	const m = input.mode ?? 'sample';
	const tgt = input.target ?? '';
	return `${input.connectionId}::${tgt}::${m}::${cols}::${ss}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-co-null',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as CoNullFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'CoNullOutput',
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

function readCachedCoNull(input: CoNullFileInput, deps: SkillDeps): CoNullOutput | undefined {
	const slot = deps.context?.slots.get('cached-co-null');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<CoNullOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinCoNull(input: CoNullFileInput, value: CoNullOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_aggregate' },
		payload: value,
		claims:  [`co-null:${cacheKey(input)}`],
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

export function registerDataDependencyCoNullPatternFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
