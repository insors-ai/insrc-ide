/**
 * data.quality.scorecard.file -- Phase 5d.6 (file-side variant).
 *
 * Same composite contract as the RDBMS variant -- delegates to
 * the file-side atomics (`completeness.file`, `uniqueness.file`,
 * `validity.file`, `conformity.file`, `consistency.file`). Math
 * is shared via `data.quality.scorecard.algo`.
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
	type ColumnScorecard,
	type ConformityStats,
	type ConsistencyBlock,
	type ConsistencyRuleIn,
	type QualityScorecardOutput,
	type ValidityStats,
	CONSISTENCY_RULE_INPUT_SCHEMA,
	EMPTY_CONSISTENCY_BLOCK,
	SCORECARD_OUTPUT_SCHEMA,
	buildConsistencyBlockFromOutput,
	compositeScore,
	emptyConformityStats,
	emptyScorecard,
	emptyValidityStats,
	isCompletenessOutput,
	isConformityOutput,
	isConsistencyOutput,
	isUniquenessOutput,
	isValidityOutput,
	pickTopIssues,
	pickWeights,
} from './data.quality.scorecard.algo.js';

interface QualityScorecardFileInput {
	readonly connectionId: string;
	readonly target?: string;
	readonly columns?: readonly string[];
	readonly validityPatterns?: Readonly<Record<string, string>>;
	readonly conformityRules?: Readonly<Record<string, string>>;
	readonly consistencyRules?: readonly ConsistencyRuleIn[];
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<QualityScorecardFileInput, QualityScorecardOutput> = {
	id: 'data.quality.scorecard.file',
	name: 'Quality: scorecard (file)',
	description:
		'Composite scorecard for a file connection: rolls up the 5d quality atomics into a per-column / ' +
		'table-level scorecard. Same shape and weight rules as the RDBMS variant. Always includes ' +
		'completeness + uniqueness; validity / conformity fold in per-column when the caller supplies ' +
		'`validityPatterns` / `conformityRules`; consistency reports as a separate block when ' +
		'`consistencyRules` is supplied.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:     { type: 'string' },
			target:           { type: 'string', description: 'Optional. xlsx: sheet name.' },
			columns:          { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 15 },
			validityPatterns: {
				type: 'object',
				additionalProperties: { type: 'string', minLength: 1 },
				description: 'Map of column name -> JS regex pattern. When supplied, validity.file runs on those columns and folds into the composite.',
			},
			conformityRules: {
				type: 'object',
				additionalProperties: { type: 'string', minLength: 1 },
				description: 'Map of column name -> format slug. When supplied, conformity.file runs on those columns and folds into the composite.',
			},
			consistencyRules: {
				type: 'array',
				items: CONSISTENCY_RULE_INPUT_SCHEMA,
				description: 'Cross-column consistency rules. When supplied, consistency.file runs once with the rule list and reports per-rule satisfaction in the top-level `consistency` block.',
			},
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: SCORECARD_OUTPUT_SCHEMA,
	toolDeps: [],
	skillDeps: [
		'data.quality.completeness.file',
		'data.quality.uniqueness.file',
		'data.quality.validity.file',
		'data.quality.conformity.file',
		'data.quality.consistency.file',
	],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only -- inherits from sub-skills' },
	],

	async execute(input, deps): Promise<SkillResult<QualityScorecardOutput>> {
		const cached = readCachedReport(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.overallScore !== null ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;
		const buildSubInput = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
			const base: Record<string, unknown> = { connectionId: input.connectionId, ...extra };
			if (sheet !== undefined) base['target'] = sheet;
			return base;
		};

		const baseInput = buildSubInput(input.columns !== undefined ? { columns: input.columns } : {});

		const [compSub, uniqSub] = await Promise.all([
			deps.runSkill<unknown, unknown>('data.quality.completeness.file', baseInput),
			deps.runSkill<unknown, unknown>('data.quality.uniqueness.file', baseInput),
		]);

		if (!isCompletenessOutput(compSub.value) || !isUniquenessOutput(uniqSub.value)) {
			return {
				value: emptyScorecard(input.target ?? ''),
				confidence: 'low',
				notes: ['scorecard: sub-skill returned a shape we could not parse'],
				toolCalls: [],
			};
		}

		const completeness = compSub.value;
		const uniqueness = uniqSub.value;
		const totalRows = completeness.totalRows ?? uniqueness.totalRows;

		const patterns = input.validityPatterns ?? {};
		const patternedCols = Object.keys(patterns).filter(c => patterns[c] !== undefined && patterns[c]!.length > 0);
		const includeValidity = patternedCols.length > 0;

		const formats = input.conformityRules ?? {};
		const formattedCols = Object.keys(formats).filter(c => formats[c] !== undefined && formats[c]!.length > 0);
		const includeConformity = formattedCols.length > 0;

		const weights = pickWeights(includeValidity, includeConformity);

		const validityByName = new Map<string, ValidityStats>();
		if (includeValidity) {
			const validitySubs = await Promise.all(
				patternedCols.map(c => deps.runSkill<unknown, unknown>(
					'data.quality.validity.file',
					buildSubInput({ column: c, pattern: patterns[c]! }),
				)),
			);
			for (let i = 0; i < patternedCols.length; i++) {
				const col = patternedCols[i]!;
				const sub = validitySubs[i]!;
				if (!isValidityOutput(sub.value)) {
					validityByName.set(col, emptyValidityStats(patterns[col]!));
					continue;
				}
				validityByName.set(col, {
					score:         sub.value.score,
					pattern:       sub.value.pattern,
					matchCount:    sub.value.matchCount,
					mismatchCount: sub.value.mismatchCount,
					sampleSize:    sub.value.sampleSize,
				});
			}
		}

		const conformityByName = new Map<string, ConformityStats>();
		if (includeConformity) {
			const conformitySubs = await Promise.all(
				formattedCols.map(c => deps.runSkill<unknown, unknown>(
					'data.quality.conformity.file',
					buildSubInput({ column: c }),
				)),
			);
			for (let i = 0; i < formattedCols.length; i++) {
				const col = formattedCols[i]!;
				const requestedFormat = formats[col]!;
				const sub = conformitySubs[i]!;
				if (!isConformityOutput(sub.value)) {
					conformityByName.set(col, emptyConformityStats(requestedFormat));
					continue;
				}
				const requestedMatch = sub.value.matches.find(m => m.format === requestedFormat);
				const requestedScore = requestedMatch?.hitRate ?? sub.value.conformityScore;
				conformityByName.set(col, {
					score:      requestedScore,
					format:     requestedFormat,
					bestFormat: sub.value.bestFormat,
					sampleSize: sub.value.sampleSize,
				});
			}
		}

		const compByName = new Map(completeness.columns.map(c => [c.name, c]));
		const merged: ColumnScorecard[] = [];
		for (const u of uniqueness.columns) {
			const c = compByName.get(u.name);
			const cScore = c !== undefined && c.nullRate !== null ? 1 - c.nullRate : null;
			const uScore = u.uniquenessRatio;
			const validity = validityByName.get(u.name) ?? emptyValidityStats(null);
			const conformity = conformityByName.get(u.name) ?? emptyConformityStats(null);
			const composite = compositeScore(cScore, uScore, validity.score, conformity.score, weights);
			merged.push({
				name: u.name,
				completeness: {
					score:         cScore,
					nonNullCount:  c?.nonNullCount ?? null,
					nullCount:     c?.nullCount    ?? null,
					nullRate:      c?.nullRate     ?? null,
				},
				uniqueness: {
					score:                 uScore,
					distinctCount:         u.distinctCount,
					uniquenessRatio:       u.uniquenessRatio,
					isPrimaryKeyCandidate: u.isPrimaryKeyCandidate,
				},
				validity,
				conformity,
				compositeScore: composite,
			});
		}

		const observed = merged.map(c => c.compositeScore).filter((s): s is number => s !== null);
		const overallScore = observed.length > 0
			? observed.reduce((a, b) => a + b, 0) / observed.length
			: null;

		const consistencyRules = input.consistencyRules ?? [];
		let consistency: ConsistencyBlock = EMPTY_CONSISTENCY_BLOCK;
		if (consistencyRules.length > 0) {
			const sub = await deps.runSkill<unknown, unknown>(
				'data.quality.consistency.file',
				buildSubInput({ rules: consistencyRules }),
			);
			if (isConsistencyOutput(sub.value)) {
				consistency = buildConsistencyBlockFromOutput(sub.value);
			} else {
				consistency = { rules: [], overallScore: null, verdict: 'inconclusive' };
			}
		}

		const topIssues = pickTopIssues(merged, consistency);

		const value: QualityScorecardOutput = {
			target: completeness.target,
			totalRows,
			weights,
			columns: merged,
			primaryKeyCandidates: uniqueness.primaryKeyCandidates,
			overallScore,
			topIssues,
			consistency,
			truncated: completeness.truncated || uniqueness.truncated,
		};
		const confidence: 'high' | 'medium' = overallScore !== null ? 'high' : 'medium';
		if (confidence === 'high') {
			pinReport(input, value, deps);
		}
		return {
			value,
			confidence,
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Composite scorecard: rule maps + consistency rules dominate the output.
// We cache the FULL rolled-up output; sub-skill caches still kick in on cold
// path automatically.

const OWNER_ID: OwnerId = 'skill:data.quality.scorecard.file';
const NAMESPACE = 'scorecard-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: QualityScorecardFileInput): string {
	const cols = (input.columns ?? []).slice().sort().join(',');
	const validity = stringifySortedMap(input.validityPatterns);
	const conformity = stringifySortedMap(input.conformityRules);
	const consistencyKey = JSON.stringify(input.consistencyRules ?? []);
	return `${input.connectionId}::${input.target ?? ''}::${cols}::${validity}::${conformity}::${consistencyKey}`;
}

function stringifySortedMap(m: Readonly<Record<string, string>> | undefined): string {
	if (m === undefined) { return ''; }
	const keys = Object.keys(m).sort();
	return keys.map(k => `${k}=${m[k]}`).join(',');
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-report',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as QualityScorecardFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'QualityScorecardOutput',
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

function readCachedReport(input: QualityScorecardFileInput, deps: SkillDeps): QualityScorecardOutput | undefined {
	const slot = deps.context?.slots.get('cached-report');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<QualityScorecardOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReport(input: QualityScorecardFileInput, value: QualityScorecardOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'internal', note: 'data.quality.scorecard.file (composite rollup)' },
		payload: value,
		claims:  [`scorecard:${input.connectionId}::${input.target ?? ''}`],
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

export function registerDataQualityScorecardFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
