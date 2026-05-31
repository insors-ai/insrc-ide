/**
 * data.pii.detect-patterns.file -- Phase 5e.1 (file-side variant).
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

interface PiiDetectPatternsFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly sampleSize?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<PiiDetectPatternsFileInput, PiiDetectPatternsOutput> = {
	id: 'data.pii.detect-patterns.file',
	name: 'PII: detect patterns (file)',
	description:
		'Sample values from one file-connection column and apply a built-in set of PII regex patterns: email / ssn-us / ' +
		'phone-us / credit-card / jwt / ipv4 / iban / aws-access-key / github-token / uuid. Returns per-pattern ' +
		'hit count + rate + examples.',
	family: 'sensitivity',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50, description: 'Default 50 (the tool cap).' },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: PII_OUTPUT_SCHEMA,
	toolDeps: ['db_file_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_sample'], reason: 'sole tool that supplies the value sample we regex over' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
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
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const tool = await deps.runTool({ id: callId, name: 'db_file_sample', input: sampleInput });
		if (tool.isError) {
			return { value: emptyPii(input.target ?? '', input.column, sampleSize), confidence: 'low', notes: [`db_file_sample error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isSampleResult(tool.data)) {
			return {
				value: emptyPii(input.target ?? '', input.column, sampleSize),
				confidence: 'low',
				notes: ['db_file_sample returned a result without the expected structured data shape'],
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

const OWNER_ID: OwnerId = 'skill:data.pii.detect-patterns.file';
const NAMESPACE = 'pii-classifications';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: PiiDetectPatternsFileInput): string {
	const ss = input.sampleSize ?? '';
	const tgt = input.target ?? '';
	return `${input.connectionId}::${tgt}::${input.column}::${ss}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-pii-patterns',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as PiiDetectPatternsFileInput;
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

function readCachedPiiPatterns(input: PiiDetectPatternsFileInput, deps: SkillDeps): PiiDetectPatternsOutput | undefined {
	const slot = deps.context?.slots.get('cached-pii-patterns');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<PiiDetectPatternsOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinPiiPatterns(input: PiiDetectPatternsFileInput, value: PiiDetectPatternsOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_sample' },
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

export function registerDataPiiDetectPatternsFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
