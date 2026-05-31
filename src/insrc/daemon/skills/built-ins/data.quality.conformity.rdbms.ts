/**
 * data.quality.conformity.rdbms -- Phase 5d.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic quality skill: checks one column's sampled values against
 * a built-in catalog of canonical formats (dates, currencies,
 * country codes, postal codes, phone numbers). Returns the per-
 * format match rate, the best-fitting format, and a conformity
 * verdict.
 *
 * Companion to `data.quality.validity.rdbms`:
 *   - validity.rdbms takes a caller-supplied regex (free-form
 *     domain check)
 *   - conformity.rdbms uses a built-in format catalog (matches
 *     known real-world shapes without the caller knowing the regex)
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

interface ConformityRdbmsInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
	readonly formats?: readonly string[];
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ConformityRdbmsInput, QualityConformityOutput> = {
	id: 'data.quality.conformity.rdbms',
	name: 'Quality: format conformity (RDBMS)',
	description:
		'Checks one column against a catalog of canonical formats: iso-date, iso-datetime, us-date, ' +
		'eu-date, usd-currency, eur-currency, iso-currency, iso-country-2/3, us-zip, uk-postal, ca-postal, ' +
		'e164-phone. Returns per-format hit rates + the best-fitting format + a conformity verdict ' +
		'(conformant / mostly-conformant / mixed / unrecognized / inconclusive). Pairs with ' +
		'`data.quality.validity.rdbms` -- this skill picks a known format; validity validates a custom regex.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			formats:      { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Optional allowlist of format names; default = all 13 built-ins.' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: CONFORMITY_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_sample'], reason: 'sole tool that supplies the value sample we regex over' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
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

		const formats = resolveFormats(input.formats);
		if ('error' in formats) {
			return { value: emptyConformity(input.target, input.column), confidence: 'low', notes: [formats.error], toolCalls: [] };
		}

		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (tool.isError) {
			return { value: emptyConformity(input.target, input.column), confidence: 'low', notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isSampleResult(tool.data)) {
			return {
				value: emptyConformity(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
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

const OWNER_ID: OwnerId = 'skill:data.quality.conformity.rdbms';
const NAMESPACE = 'conformity-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ConformityRdbmsInput): string {
	const formats = (input.formats ?? []).slice().sort().join(',');
	const sampleSize = input.sampleSize ?? '';
	return `${input.connectionId}::${input.target}::${input.column}::${sampleSize}::${formats}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-report',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ConformityRdbmsInput;
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

function readCachedReport(input: ConformityRdbmsInput, deps: SkillDeps): QualityConformityOutput | undefined {
	const slot = deps.context?.slots.get('cached-report');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<QualityConformityOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReport(input: ConformityRdbmsInput, value: QualityConformityOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_sample' },
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

export function registerDataQualityConformityRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
