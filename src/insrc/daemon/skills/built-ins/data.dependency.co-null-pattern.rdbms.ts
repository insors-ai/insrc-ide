/**
 * data.dependency.co-null-pattern.rdbms -- Phase 5c.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the shared co-null algo.
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

interface CoNullInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
	readonly sampleSize?: number;
	/** Default 'sample'; 'full-table' uses count_where aggregates per
	 *  pair via Phase 0.1.x. */
	readonly mode?: CoNullSource;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<CoNullInput, CoNullOutput> = {
	id: 'data.dependency.co-null-pattern.rdbms',
	name: 'Dependency: pairwise null co-occurrence (RDBMS)',
	description: 'Pairwise null co-occurrence analysis over a 50-row sample. Cap: 15 columns / 105 pairs per call.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 15 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			mode:         { type: 'string', enum: ['sample', 'full-table'], description: 'Default sample. full-table uses count_where aggregates.' },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: CO_NULL_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_describe', 'db_sql_sample', 'db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_describe', 'db_sql_sample', 'db_sql_aggregate'], reason: 'describe gives the column list; sample (mode=sample) or aggregate (mode=full-table) supplies the counts' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
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
		const notes: string[] = [];

		const cols = await resolveColumns(input, deps, callBase);
		if (typeof cols === 'string') {
			return { value: emptyCoNullOutput(input.target), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		if (cols.length < 2) {
			return {
				value: { target: input.target, sampleSize: 0, columns: cols, pairs: [], truncated: false, source: 'sample', totalRows: null },
				confidence: 'medium',
				notes: ['co-null-pattern needs at least 2 columns; nothing to compare'],
				toolCalls: [],
			};
		}

		const truncated = cols.length > CO_NULL_COL_CAP;
		const usedCols = truncated ? cols.slice(0, CO_NULL_COL_CAP) : cols;
		if (truncated) {
			notes.push(`co-null-pattern truncated: ${cols.length} columns -> profiling first ${CO_NULL_COL_CAP}. Pass explicit \`columns\` to profile a different slice.`);
		}

		if (input.mode === 'full-table') {
			const fullResult = await runFullTable(input, deps, callBase, usedCols, truncated);
			if (typeof fullResult === 'string') {
				return { value: emptyCoNullOutput(input.target), confidence: 'low', notes: [...notes, fullResult], toolCalls: [] };
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

		const sampleResult = await deps.runTool({
			id: `${callBase}-sample`,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (sampleResult.isError) {
			return { value: emptyCoNullOutput(input.target), confidence: 'low', notes: [...notes, `db_sql_sample error: ${sampleResult.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleResult.data)) {
			return {
				value: emptyCoNullOutput(input.target),
				confidence: 'low',
				notes: [...notes, 'db_sql_sample returned a result without the expected structured data shape'],
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
	input: CoNullInput,
	deps: SkillDeps,
	callBase: string,
	usedCols: readonly string[],
	truncated: boolean,
): Promise<{ output: CoNullOutput; notes: readonly string[]; anyNull: boolean } | string> {
	// Total row count via a single COUNT(*) aggregate.
	const totalRes = await deps.runTool({
		id: `${callBase}-total`,
		name: 'db_sql_aggregate',
		input: {
			connectionId: input.connectionId,
			target: input.target,
			aggregations: [{ column: '*', function: 'count' }],
		},
	});
	if (totalRes.isError) return `db_sql_aggregate(count) error: ${totalRes.content.slice(0, 200)}`;
	if (!isAggregateResult(totalRes.data)) return 'db_sql_aggregate count returned a result without the expected structured data shape';
	const totalRows = Number(totalRes.data.values['*__count'] ?? 0);

	// Build all (i, j) pairs.
	const pairs: { a: string; b: string }[] = [];
	for (let i = 0; i < usedCols.length; i++) {
		for (let j = i + 1; j < usedCols.length; j++) {
			pairs.push({ a: usedCols[i]!, b: usedCols[j]! });
		}
	}

	// Batch them so each db_sql_aggregate call stays under the 32-spec budget.
	const counts: { columnA: string; columnB: string; bothNull: number; aNullOnly: number; bNullOnly: number; neitherNull: number }[] = [];
	for (let off = 0; off < pairs.length; off += CO_NULL_PAIRS_PER_BATCH) {
		const batch = pairs.slice(off, off + CO_NULL_PAIRS_PER_BATCH);
		const aggregations = batch.flatMap(p => coNullPairAggregations(p.a, p.b));
		const aggRes = await deps.runTool({
			id: `${callBase}-pairs-${off}`,
			name: 'db_sql_aggregate',
			input: { connectionId: input.connectionId, target: input.target, aggregations },
		});
		if (aggRes.isError) return `db_sql_aggregate(pairs) error: ${aggRes.content.slice(0, 200)}`;
		if (!isAggregateResult(aggRes.data)) return 'db_sql_aggregate pairs returned a result without the expected structured data shape';
		for (const p of batch) {
			const keys = coNullPairAggregations(p.a, p.b).map(spec => `${spec.column}__count_where_${[
				...spec.args.predicate.map(c => `${c.column}_${c.op.replace(/[^a-z0-9]/gi, '')}`),
			].join('__')}`);
			const v = aggRes.data.values;
			counts.push({
				columnA: p.a, columnB: p.b,
				bothNull:    Number(v[keys[0]!] ?? 0),  // a NULL + b NULL
				aNullOnly:   Number(v[keys[1]!] ?? 0),  // a NULL + b NOT NULL
				bNullOnly:   Number(v[keys[2]!] ?? 0),  // a NOT NULL + b NULL
				neitherNull: Number(v[keys[3]!] ?? 0),  // both NOT NULL
			});
		}
	}

	return buildCoNullOutputFromCounts(input.target, usedCols, counts, totalRows, truncated);
}

async function resolveColumns(input: CoNullInput, deps: SkillDeps, callBase: string): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describe = await deps.runTool({
		id: `${callBase}-desc`,
		name: 'db_sql_describe',
		input: { connectionId: input.connectionId, target: input.target },
	});
	if (describe.isError) return `db_sql_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) return 'db_sql_describe returned a result without the expected structured data shape';
	const cols = describe.data.columns
		.map(c => c.name)
		.filter(n => typeof n === 'string' && n.length > 0);
	if (cols.length === 0) return `target '${input.target}' has no columns`;
	return cols;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.dependency.co-null-pattern.rdbms';
const NAMESPACE = 'co-null-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: CoNullInput): string {
	const cols = input.columns ? JSON.stringify(input.columns) : '';
	const ss = input.sampleSize ?? '';
	const m = input.mode ?? 'sample';
	return `${input.connectionId}::${input.target}::${m}::${cols}::${ss}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-co-null',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as CoNullInput;
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

function readCachedCoNull(input: CoNullInput, deps: SkillDeps): CoNullOutput | undefined {
	const slot = deps.context?.slots.get('cached-co-null');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<CoNullOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinCoNull(input: CoNullInput, value: CoNullOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_aggregate' },
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

export function registerDataDependencyCoNullPatternRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
