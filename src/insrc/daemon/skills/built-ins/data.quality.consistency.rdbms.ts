/**
 * data.quality.consistency.rdbms -- Phase 5d.5 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic quality skill: cross-column consistency rule checks.
 * Sample-based; precise full-table consistency would need per-rule
 * SQL of the form `SELECT COUNT(*) WHERE NOT (rule)`, which the
 * current `db_sql_aggregate` doesn't expose.
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
	type ConsistencyOutput,
	type ConsistencyRule,
	type ConsistencySource,
	CONSISTENCY_OUTPUT_SCHEMA,
	CONSISTENCY_RULE_SCHEMA,
	buildConsistency,
	buildConsistencyFromCounts,
	clampConsistencySample,
	consistencyRuleAggregations,
	emptyConsistency,
} from './data.quality.consistency.algo.js';
import { isCorrelationSampleResult as isSampleResult } from './data.correlation.numeric-pairwise.algo.js';
import { isAggregateResult } from './data.quality.completeness.algo.js';

interface ConsistencyRdbmsInput {
	readonly connectionId: string;
	readonly target: string;
	readonly rules: readonly ConsistencyRule[];
	readonly sampleSize?: number;
	readonly mode?: ConsistencySource;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ConsistencyRdbmsInput, ConsistencyOutput> = {
	id: 'data.quality.consistency.rdbms',
	name: 'Quality: cross-column consistency (RDBMS)',
	description:
		'Evaluates caller-supplied cross-column rules over a 50-row sample. Operators: comparison ' +
		'(< <= = != >= >) with null-aware inapplicable handling, plus and-not-null (both must be filled) ' +
		'and xor-null (exactly one must be null). Returns per-rule satisfied/violated/inapplicable counts + ' +
		'satisfaction rate + up to 3 violation examples. Verdict: consistent / mostly-consistent / mixed / ' +
		'broken / inconclusive. Sample-based; precise per-rule full-table counts need a count-where ' +
		'aggregate not yet shipped.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			rules:        { type: 'array', items: CONSISTENCY_RULE_SCHEMA, minItems: 1, maxItems: 20 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			mode:         { type: 'string', enum: ['sample', 'full-table'], description: 'Default sample. full-table issues count_where aggregates per rule.' },
		},
		required: ['connectionId', 'target', 'rules'],
		additionalProperties: false,
	},
	outputs: CONSISTENCY_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_sample', 'db_sql_aggregate'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_sample', 'db_sql_aggregate'], reason: 'sample (mode=sample) or aggregate (mode=full-table) supplies the per-rule counts' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<ConsistencyOutput>> {
		const cached = readCachedReport(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.verdict === 'inconclusive' ? 'medium' : 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampConsistencySample(input.sampleSize);

		if (input.mode === 'full-table') {
			const fullResult = await runFullTable(input, deps, callId);
			if (typeof fullResult === 'string') {
				return { value: emptyConsistency(input.target, input.rules), confidence: 'low', notes: [fullResult], toolCalls: [] };
			}
			const fullConfidence: 'high' | 'medium' = fullResult.verdict === 'inconclusive' ? 'medium' : 'high';
			if (fullConfidence === 'high') {
				pinReport(input, fullResult, deps);
			}
			return {
				value: fullResult,
				confidence: fullConfidence,
				toolCalls: [],
			};
		}

		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (tool.isError) {
			return { value: emptyConsistency(input.target, input.rules), confidence: 'low', notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isSampleResult(tool.data)) {
			return {
				value: emptyConsistency(input.target, input.rules),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const built = buildConsistency(tool.data.target, input.rules, { columns: tool.data.columns, rows: tool.data.rows });
		if (built.missingColumns.length > 0) {
			return {
				value: built.output,
				confidence: 'low',
				notes: [`columns missing from sample: ${built.missingColumns.join(', ')}; available: ${tool.data.columns.join(', ')}`],
				toolCalls: [],
			};
		}
		const sampleConfidence: 'high' | 'medium' = built.output.verdict === 'inconclusive' ? 'medium' : 'high';
		if (sampleConfidence === 'high') {
			pinReport(input, built.output, deps);
		}
		return {
			value: built.output,
			confidence: sampleConfidence,
			toolCalls: [],
		};
	},
};

async function runFullTable(
	input: ConsistencyRdbmsInput,
	deps: SkillDeps,
	callId: string,
): Promise<ConsistencyOutput | string> {
	const totalRes = await deps.runTool({
		id: `${callId}-total`,
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

	// One aggregate call per rule (each rule fits in 3-4 specs).
	const perRuleCounts: number[][] = [];
	for (let i = 0; i < input.rules.length; i++) {
		const rule = input.rules[i]!;
		const aggregations = consistencyRuleAggregations(rule);
		const aggRes = await deps.runTool({
			id: `${callId}-rule-${i}`,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations,
			},
		});
		if (aggRes.isError) return `db_sql_aggregate(rule '${rule.name}') error: ${aggRes.content.slice(0, 200)}`;
		if (!isAggregateResult(aggRes.data)) return `db_sql_aggregate rule '${rule.name}' returned a result without the expected structured data shape`;
		const counts: number[] = [];
		for (const spec of aggregations) {
			const sigParts = spec.args!.predicate!.map(c => `${c.column}_${c.op.replace(/[^a-z0-9]/gi, '')}`);
			const key = `${spec.column}__count_where_${sigParts.join('__')}`;
			counts.push(Number(aggRes.data.values[key] ?? 0));
		}
		perRuleCounts.push(counts);
	}

	return buildConsistencyFromCounts(input.target, input.rules, totalRows, perRuleCounts);
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.quality.consistency.rdbms';
const NAMESPACE = 'consistency-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ConsistencyRdbmsInput): string {
	const mode = input.mode ?? 'sample';
	const sampleSize = input.sampleSize ?? '';
	// Rules are structured -- JSON-stringify a normalized copy for stable hashing.
	const rulesKey = JSON.stringify(input.rules);
	return `${input.connectionId}::${input.target}::${mode}::${sampleSize}::${rulesKey}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-report',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ConsistencyRdbmsInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'ConsistencyOutput',
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

function readCachedReport(input: ConsistencyRdbmsInput, deps: SkillDeps): ConsistencyOutput | undefined {
	const slot = deps.context?.slots.get('cached-report');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ConsistencyOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReport(input: ConsistencyRdbmsInput, value: ConsistencyOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: input.mode === 'full-table' ? 'db_sql_aggregate' : 'db_sql_sample' },
		payload: value,
		claims:  [`consistency:${input.connectionId}::${input.target}`],
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

export function registerDataQualityConsistencyRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
