/**
 * data.quality.validity.rdbms -- Phase 5d.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Default `mode: 'sample'` (50-row JS-side regex check). Opt-in
 * `mode: 'full-table'` runs three aggregates (count + count_non_null
 * + count_where(regex)) for an exact match-rate over the entire
 * non-null population. Phase 5d.3 Gap 1.
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
	type QualityValidityOutput,
	type ValiditySource,
	VALIDITY_OUTPUT_SCHEMA,
	buildValidity,
	buildValidityFromAggregate,
	clampValiditySample,
	emptyValidity,
	isAggregateResult,
	validityAggregationsFor,
} from './data.quality.validity.algo.js';
import { isCorrelationSampleResult as isSampleResult } from './data.correlation.numeric-pairwise.algo.js';

interface QualityValidityInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly pattern: string;
	readonly sampleSize?: number;
	readonly mode?: ValiditySource;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<QualityValidityInput, QualityValidityOutput> = {
	id: 'data.quality.validity.rdbms',
	name: 'Quality: regex validity (RDBMS)',
	description:
		'Caller-supplied regex validity check. Default `mode: sample` evaluates the regex in JS over a 50-row ' +
		'sample. Opt-in `mode: full-table` issues count + count_non_null + count_where(regex) aggregates for ' +
		'an exact match-rate over the full non-null population (mssql not supported -- no native regex).',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			pattern:      { type: 'string', minLength: 1 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			mode: {
				type: 'string',
				enum: ['sample', 'full-table'],
				description: 'Default sample. full-table issues server-side regex match counts.',
			},
		},
		required: ['connectionId', 'target', 'column', 'pattern'],
		additionalProperties: false,
	},
	outputs: VALIDITY_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_sample', 'db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_sample', 'db_sql_aggregate'],
			reason: 'sample mode: db_sql_sample. full-table mode: db_sql_aggregate (count_where + regex)',
		},
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<QualityValidityOutput>> {
		const cached = readCachedReport(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.matchRate !== null && (cached.nonNullCount ?? cached.sampleSize) > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		// Validate the pattern up-front (fails fast for both modes).
		let re: RegExp;
		try {
			re = new RegExp(input.pattern);
		} catch (err) {
			return {
				value: emptyValidity(input.target, input.column, input.pattern),
				confidence: 'low',
				notes: [`pattern '${input.pattern}' is not a valid JS regex: ${(err as Error).message}`],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

		if (input.mode === 'full-table') {
			const tool = await deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: validityAggregationsFor(input.column, input.pattern),
				},
			});
			if (tool.isError) {
				return {
					value: { ...emptyValidity(input.target, input.column, input.pattern), source: 'full-table' },
					confidence: 'low',
					notes: [`db_sql_aggregate error (full-table mode): ${tool.content.slice(0, 200)}`],
					toolCalls: [],
				};
			}
			if (!isAggregateResult(tool.data)) {
				return {
					value: { ...emptyValidity(input.target, input.column, input.pattern), source: 'full-table' },
					confidence: 'low',
					notes: ['db_sql_aggregate returned a result without the expected structured data shape'],
					toolCalls: [],
				};
			}
			const out = buildValidityFromAggregate(tool.data.target, input.column, input.pattern, tool.data.values);
			const confidence: 'high' | 'medium' = out.matchRate !== null && (out.nonNullCount ?? 0) > 0 ? 'high' : 'medium';
			if (confidence === 'high') {
				pinReport(input, out, deps);
			}
			return {
				value: out,
				confidence,
				toolCalls: [],
			};
		}

		// sample mode (default + back-compat)
		const sampleSize = clampValiditySample(input.sampleSize);
		const tool = await deps.runTool({
			id: `${callBase}-sample`,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (tool.isError) {
			return {
				value: emptyValidity(input.target, input.column, input.pattern),
				confidence: 'low',
				notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isSampleResult(tool.data)) {
			return {
				value: emptyValidity(input.target, input.column, input.pattern),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const built = buildValidity(tool.data.target, input.column, input.pattern, re, { columns: tool.data.columns, rows: tool.data.rows });
		if (built.missingColumn) {
			return {
				value: built.output,
				confidence: 'low',
				notes: [`column '${input.column}' not present in sample (available: ${tool.data.columns.join(', ')})`],
				toolCalls: [],
			};
		}
		const sampleConfidence: 'high' | 'medium' = built.output.sampleSize > 0 ? 'high' : 'medium';
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

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.quality.validity.rdbms';
const NAMESPACE = 'validity-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: QualityValidityInput): string {
	const mode = input.mode ?? 'sample';
	const sampleSize = input.sampleSize ?? '';
	return `${input.connectionId}::${input.target}::${input.column}::${input.pattern}::${mode}::${sampleSize}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-report',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as QualityValidityInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'QualityValidityOutput',
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

function readCachedReport(input: QualityValidityInput, deps: SkillDeps): QualityValidityOutput | undefined {
	const slot = deps.context?.slots.get('cached-report');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<QualityValidityOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReport(input: QualityValidityInput, value: QualityValidityOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: input.mode === 'full-table' ? 'db_sql_aggregate' : 'db_sql_sample' },
		payload: value,
		claims:  [`validity:${cacheKey(input)}`],
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

export function registerDataQualityValidityRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
