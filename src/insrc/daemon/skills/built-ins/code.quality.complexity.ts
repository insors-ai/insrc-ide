/**
 * code.quality.complexity -- per-entity cyclomatic complexity
 * (code-analyzer-skills.md Phase 5.1).
 *
 * Computes cyclomatic over the body of every function / method in
 * the requested scope (repo or single file). Returns the per-entity
 * scores plus a histogram of severity buckets.
 *
 * Math lives in `code.quality.complexity.algo.ts`; this file is the
 * skill envelope.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { listEntitiesForRepo, findEntitiesByFile } from '../../../db/entities.js';
import type { Entity, EntityKind } from '../../../shared/types.js';
import {
	computeCyclomaticComplexity,
	type ComplexityLevel,
} from './code.quality.complexity.algo.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

const TARGET_KINDS: ReadonlySet<EntityKind> = new Set(['function', 'method']);

// Phase B.1: removed limit. Skill returns the FULL sorted entries list;
// renderer pages for the LLM.

interface ComplexityInput {
	readonly repoPath: string;
	readonly file?:    string;
}

interface ComplexityEntry {
	readonly id:         string;
	readonly name:       string;
	readonly kind:       EntityKind;
	readonly file:       string;
	readonly startLine:  number;
	readonly cyclomatic: number;
	readonly level:      ComplexityLevel;
}

interface ComplexityOutput {
	readonly repoPath:    string;
	readonly file?:       string;
	readonly entryCount:  number;
	readonly histogram:   Readonly<Record<ComplexityLevel, number>>;
	readonly entries:     readonly ComplexityEntry[];
}

const codeQualityComplexitySkill: Skill<ComplexityInput, ComplexityOutput> = {
	id: 'code.quality.complexity',
	name: 'Code: cyclomatic complexity per function / method',
	description:
		'Compute cyclomatic complexity for every function / method in the requested scope ' +
		'(repo-wide or single file). Returns the COMPLETE sorted entries list (highest first) ' +
		'plus a histogram of severity buckets (low / medium / high / critical).',
	family: 'quality-profile',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repoPath: { type: 'string', description: 'Repo root absolute path.' },
			file:     { type: 'string', description: 'Optional: scope to one file.' },
		},
		required: ['repoPath'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			repoPath:   { type: 'string' },
			file:       { type: 'string' },
			entryCount: { type: 'number' },
			histogram:  { type: 'object' },
			entries:    { type: 'array' },
		},
		required: ['repoPath', 'entryCount', 'histogram', 'entries'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: ComplexityInput, deps: SkillDeps): Promise<SkillResult<ComplexityOutput>> {
		// Substrate: cache hit short-circuits the per-body complexity walk.
		const cached = readCachedReport(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.entryCount > 0 ? 'high' : 'low',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const all = input.file !== undefined
			? await findEntitiesByFile(null, input.file)
			: await listEntitiesForRepo(null, input.repoPath);

		const targets = all.filter(e => TARGET_KINDS.has(e.kind) && e.body.length > 0);
		const entries: ComplexityEntry[] = targets.map(toEntry);

		const histogram: Record<ComplexityLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };
		for (const e of entries) histogram[e.level]++;

		entries.sort((a, b) => b.cyclomatic - a.cyclomatic);

		const out: ComplexityOutput = {
			repoPath:   input.repoPath,
			...(input.file !== undefined ? { file: input.file } : {}),
			entryCount: entries.length,
			histogram,
			entries,
		};
		pinReport(input, out, deps);
		return {
			value: out,
			confidence: targets.length > 0 ? 'high' : 'low',
			notes: targets.length === 0
				? [`No function / method bodies found in scope.`]
				: [],
			toolCalls: [],
		};
	},
};

function toEntry(e: Entity): ComplexityEntry {
	const c = computeCyclomaticComplexity(e.body, e.language);
	return {
		id:         e.id,
		name:       e.name,
		kind:       e.kind,
		file:       e.file,
		startLine:  e.startLine,
		cyclomatic: c.cyclomatic,
		level:      c.level,
	};
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (per plans/skills/code/code.quality.suite.md)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.quality.complexity';
const NAMESPACE = 'complexity-reports';
const TTL_MS = 24 * 60 * 60 * 1000;

const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function cacheKey(input: ComplexityInput): string {
	return `${input.repoPath}::${input.file ?? '*'}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-report',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ComplexityInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'ComplexityOutput',
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

function readCachedReport(input: ComplexityInput, deps: SkillDeps): ComplexityOutput | undefined {
	const slot = deps.context?.slots.get('cached-report');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ComplexityOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReport(input: ComplexityInput, value: ComplexityOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'listEntitiesForRepo' },
		payload: value,
		claims:  [`complexity:${input.repoPath}::${input.file ?? '*'}`],
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

const codeQualityComplexitySkillWithSubstrate = {
	...codeQualityComplexitySkill,
	...substrateExtension,
};

export function registerCodeQualityComplexitySkill(): void {
	registerSkill(codeQualityComplexitySkillWithSubstrate as unknown as Skill);
}
