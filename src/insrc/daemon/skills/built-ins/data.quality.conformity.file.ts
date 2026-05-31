/**
 * data.quality.conformity.file -- Phase 5d.4 (file-side variant).
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
	type QualityConformityOutput,
	CONFORMITY_OUTPUT_SCHEMA,
	buildConformity,
	clampConformitySample,
	emptyConformity,
	resolveFormats,
} from './data.quality.conformity.algo.js';
import { isCorrelationSampleResult as isSampleResult } from './data.correlation.numeric-pairwise.algo.js';

interface ConformityFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly sampleSize?: number;
	readonly formats?: readonly string[];
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<ConformityFileInput, QualityConformityOutput> = {
	id: 'data.quality.conformity.file',
	name: 'Quality: format conformity (file)',
	description: 'Catalog-driven format conformity check on a file-connection column over a sampled set of values.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			formats:      { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Optional allowlist of format names; default = all 13 built-ins.' },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: CONFORMITY_OUTPUT_SCHEMA,
	toolDeps: ['db_file_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_sample'], reason: 'sole tool that supplies the value sample we regex over' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<QualityConformityOutput>> {
		const cached = readCachedReport(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.verdict === 'mixed' || cached.verdict === 'inconclusive' ? 'medium' : 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampConformitySample(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const formats = resolveFormats(input.formats);
		if ('error' in formats) {
			return { value: emptyConformity(input.target ?? '', input.column), confidence: 'low', notes: [formats.error], toolCalls: [] };
		}

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const tool = await deps.runTool({ id: callId, name: 'db_file_sample', input: sampleInput });
		if (tool.isError) {
			return { value: emptyConformity(input.target ?? '', input.column), confidence: 'low', notes: [`db_file_sample error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isSampleResult(tool.data)) {
			return {
				value: emptyConformity(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['db_file_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const built = buildConformity(tool.data.target, input.column, formats, { columns: tool.data.columns, rows: tool.data.rows });
		if (built.missingColumn) {
			return {
				value: built.output,
				confidence: 'low',
				notes: [`column '${input.column}' not present in sample (available: ${tool.data.columns.join(', ')})`],
				toolCalls: [],
			};
		}
		const confidence: 'high' | 'medium' = built.output.verdict === 'mixed' || built.output.verdict === 'inconclusive' ? 'medium' : 'high';
		if (confidence === 'high') {
			pinReport(input, built.output, deps);
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

const OWNER_ID: OwnerId = 'skill:data.quality.conformity.file';
const NAMESPACE = 'conformity-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ConformityFileInput): string {
	const formats = (input.formats ?? []).slice().sort().join(',');
	const sampleSize = input.sampleSize ?? '';
	return `${input.connectionId}::${input.target ?? ''}::${input.column}::${sampleSize}::${formats}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-report',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ConformityFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'QualityConformityOutput',
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

function readCachedReport(input: ConformityFileInput, deps: SkillDeps): QualityConformityOutput | undefined {
	const slot = deps.context?.slots.get('cached-report');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<QualityConformityOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReport(input: ConformityFileInput, value: QualityConformityOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_sample' },
		payload: value,
		claims:  [`conformity:${cacheKey(input)}`],
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

export function registerDataQualityConformityFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
