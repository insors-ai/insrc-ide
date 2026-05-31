/**
 * data.profile.auto.rdbms -- Phase 5a.6 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Composite skill: looks up the column's declared SQL type via
 * `db_sql_describe`, classifies it into a profile family
 * (numeric / text / boolean / temporal / categorical), then
 * invokes the matching atomic profiler via `deps.runSkill`. The
 * caller gets back the typed profile shape plus the picked `kind`
 * so synthesise renderers can branch without re-classifying.
 *
 * Classification rules (intentionally simple; per-dialect quirks
 * are handled by lowercasing + substring checks against canonical
 * type roots, not full SQL grammar parsing):
 *
 *   numeric    -- integer / smallint / bigint / int / numeric /
 *                 decimal / real / double / float / money
 *   boolean    -- boolean / bool / bit
 *   temporal   -- date / time / timestamp / datetime / interval
 *   text       -- char / text / string / varchar / clob
 *   categorical -- declared enum / declared types we don't
 *                  recognize (catch-all). The caller can override
 *                  by invoking the specific profiler directly.
 *
 * Per registry contract (skills-core 4.3) any sub-skill at `low`
 * confidence floors the composite. Additionally if the describe
 * call itself errors we return `confidence: 'low'` with no profile
 * -- never fabricate a column type.
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

type ProfileKind = 'numeric' | 'text' | 'boolean' | 'temporal' | 'categorical';

interface ProfileAutoInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;  // forwarded to text profiler when applicable
}

interface ProfileAutoOutput {
	readonly target: string;
	readonly column: string;
	readonly declaredType: string | null;
	readonly kind: ProfileKind;
	readonly profile: unknown;        // shape varies by kind; caller branches on kind
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ProfileAutoInput, ProfileAutoOutput> = {
	id: 'data.profile.auto.rdbms',
	name: 'Profile: auto-pick by declared type (RDBMS)',
	description:
		'Look up the column\'s declared SQL type, classify it (numeric / text / boolean / temporal / ' +
		'categorical), invoke the matching atomic profiler. Returns the typed profile + the picked `kind` ' +
		'so synthesise renderers branch without re-classifying.',
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
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:       { type: 'string' },
			column:       { type: 'string' },
			declaredType: { type: ['string', 'null'] },
			kind:         { type: 'string', enum: ['numeric', 'text', 'boolean', 'temporal', 'categorical'] },
			profile:      {},
		},
		required: ['target', 'column', 'declaredType', 'kind', 'profile'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_describe'],
	skillDeps: [
		'data.profile.numeric.rdbms',
		'data.profile.categorical.rdbms',
		'data.profile.boolean.rdbms',
		'data.profile.temporal.rdbms',
		'data.profile.text.rdbms',
	],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_describe'],
			reason: 'describe is needed to classify the column type before dispatch',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileAutoOutput>> {
		// Substrate: cache hit short-circuits the describe call AND the
		// downstream sub-skill dispatch. Sub-skill caches operate
		// independently on cold paths.
		const cached = readCachedProfile(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const describe = await deps.runTool({
			id: callId,
			name: 'db_sql_describe',
			input: { connectionId: input.connectionId, target: input.target },
		});

		if (describe.isError) {
			return {
				value: emptyAuto(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_describe error: ${describe.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const data = describe.data;
		if (!isSchemaDescription(data)) {
			return {
				value: emptyAuto(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_describe returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const colDescr = data.columns.find(c => c.name === input.column);
		if (colDescr === undefined) {
			return {
				value: emptyAuto(input.target, input.column),
				confidence: 'low',
				notes: [`column '${input.column}' not in target '${input.target}' schema`],
				toolCalls: [],
			};
		}
		const declaredType = colDescr.type;
		const kind = classifyType(declaredType);

		const skillId = skillIdFor(kind);
		const subInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			target:       input.target,
			column:       input.column,
		};
		if (kind === 'text' && input.sampleSize !== undefined) subInput['sampleSize'] = input.sampleSize;

		const sub = await deps.runSkill(skillId, subInput);

		// Cross-skill confidence floor: registry already clamps via
		// runSkill but we surface the kind even on degraded paths so
		// the caller knows what we tried.
		const result: ProfileAutoOutput = {
			target: data.target,
			column: input.column,
			declaredType,
			kind,
			profile: sub.value,
		};
		if (sub.confidence === 'high') {
			pinProfile(input, result, deps);
		}
		return {
			value: result,
			confidence: sub.confidence,
			...(sub.notes !== undefined && sub.notes.length > 0 ? { notes: sub.notes } : {}),
			toolCalls: [],
		};
	},
};

function emptyAuto(target: string, column: string): ProfileAutoOutput {
	return { target, column, declaredType: null, kind: 'categorical', profile: null };
}

/**
 * Substring-based type classifier. Lowercases the input, then
 * checks against canonical roots in priority order. The order
 * matters: 'timestamp' contains 'time' so temporal must precede
 * 'time' alone; 'numeric' is checked before 'text' because some
 * dialects use 'character' substrings inside non-text type names.
 */
function classifyType(raw: string): ProfileKind {
	const t = raw.toLowerCase();
	// Boolean first (short tokens; otherwise 'tinyint(1)' falls into numeric).
	if (t === 'boolean' || t === 'bool' || t === 'bit' || t.startsWith('tinyint(1)')) return 'boolean';
	if (t.includes('timestamp') || t.includes('datetime') || t.includes('date')
	    || t.includes('time') || t.includes('interval')) return 'temporal';
	if (t.includes('int') || t.includes('numeric') || t.includes('decimal')
	    || t.includes('real') || t.includes('double') || t.includes('float')
	    || t.includes('money') || t === 'serial' || t === 'bigserial') return 'numeric';
	if (t.includes('char') || t.includes('text') || t.includes('clob')
	    || t === 'string' || t.includes('varchar')) return 'text';
	return 'categorical';
}

function skillIdFor(kind: ProfileKind): string {
	switch (kind) {
		case 'numeric':     return 'data.profile.numeric.rdbms';
		case 'text':        return 'data.profile.text.rdbms';
		case 'boolean':     return 'data.profile.boolean.rdbms';
		case 'temporal':    return 'data.profile.temporal.rdbms';
		case 'categorical': return 'data.profile.categorical.rdbms';
	}
}

interface ColumnDescriptionRaw {
	readonly name: string;
	readonly type: string;
}

interface SchemaDescriptionRaw {
	readonly target: string;
	readonly columns: readonly ColumnDescriptionRaw[];
}

function isSchemaDescription(v: unknown): v is SchemaDescriptionRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && Array.isArray(o['columns']);
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Composite skill caches the FULL output (describe + classified kind +
// sub-skill profile). 24h TTL is the standard for every data.profile.*
// skill. sampleSize forwards to the text sub-profiler, so it affects
// the output when kind classifies as 'text' -- include it in the key.

const OWNER_ID: OwnerId = 'skill:data.profile.auto.rdbms';
const NAMESPACE = 'auto-profiles';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ProfileAutoInput): string {
	return `${input.connectionId}::${input.target}::${input.column}::sample=${input.sampleSize ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-profile',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ProfileAutoInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'ProfileAutoOutput',
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

function readCachedProfile(input: ProfileAutoInput, deps: SkillDeps): ProfileAutoOutput | undefined {
	const slot = deps.context?.slots.get('cached-profile');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ProfileAutoOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinProfile(input: ProfileAutoInput, value: ProfileAutoOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_describe' },
		payload: value,
		claims:  [`auto-profile:${cacheKey(input)}`],
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

export function registerDataProfileAutoRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
