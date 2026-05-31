/**
 * data.pii.detect-patterns.rdbms -- Phase 5e.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: samples values from one RDBMS column and applies a
 * built-in set of PII regex patterns. Math + catalog live in
 * `data.pii.detect-patterns.algo.ts`.
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
	type PiiDetectPatternsOutput,
	PII_OUTPUT_SCHEMA,
	buildPiiDetections,
	clampPiiSample,
	emptyPii,
} from './data.pii.detect-patterns.algo.js';
import { isCorrelationSampleResult as isSampleResult } from './data.correlation.numeric-pairwise.algo.js';

interface PiiDetectPatternsRdbmsInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<PiiDetectPatternsRdbmsInput, PiiDetectPatternsOutput> = {
	id: 'data.pii.detect-patterns.rdbms',
	name: 'PII: detect patterns (RDBMS)',
	description:
		'Sample values from one RDBMS column and apply a built-in set of PII regex patterns: email / ssn-us / ' +
		'phone-us / credit-card / jwt / ipv4 / iban / aws-access-key / github-token / uuid. Returns per-pattern ' +
		'hit count + rate + examples. Anchored regex (single-token columns); false positives surface as examples ' +
		'for the caller to verify.',
	family: 'sensitivity',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50, description: 'Default 50 (the tool cap).' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: PII_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_sample'], reason: 'sole tool that supplies the value sample we regex over' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only; file / kv variants ship as separate skills' },
	],

	async execute(input, deps): Promise<SkillResult<PiiDetectPatternsOutput>> {
		const cached = readCachedPiiPatterns(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.detections.length > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampPiiSample(input.sampleSize);

		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (tool.isError) {
			return { value: emptyPii(input.target, input.column, sampleSize), confidence: 'low', notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isSampleResult(tool.data)) {
			return {
				value: emptyPii(input.target, input.column, sampleSize),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const built = buildPiiDetections(tool.data.target, input.column, { columns: tool.data.columns, rows: tool.data.rows });
		if (built.missingColumn) {
			return {
				value: built.output,
				confidence: 'low',
				notes: [`column '${input.column}' not present in sample (available: ${tool.data.columns.join(', ')})`],
				toolCalls: [],
			};
		}
		const hasMatches = built.output.detections.length > 0;
		const confidence: 'high' | 'medium' | 'low' = hasMatches ? 'high' : (built.output.sampleSize > 0 ? 'medium' : 'low');
		if (confidence === 'high') {
			pinPiiPatterns(input, built.output, deps);
		}
		return {
			value: built.output,
			confidence,
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.pii.detect-patterns.rdbms';
const NAMESPACE = 'pii-classifications';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: PiiDetectPatternsRdbmsInput): string {
	const ss = input.sampleSize ?? '';
	return `${input.connectionId}::${input.target}::${input.column}::${ss}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-pii-patterns',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as PiiDetectPatternsRdbmsInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'PiiDetectPatternsOutput',
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

function readCachedPiiPatterns(input: PiiDetectPatternsRdbmsInput, deps: SkillDeps): PiiDetectPatternsOutput | undefined {
	const slot = deps.context?.slots.get('cached-pii-patterns');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<PiiDetectPatternsOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinPiiPatterns(input: PiiDetectPatternsRdbmsInput, value: PiiDetectPatternsOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_sample' },
		payload: value,
		claims:  [`pii-patterns:${cacheKey(input)}`],
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

export function registerDataPiiDetectPatternsRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
