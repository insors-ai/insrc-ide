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

const TARGET_KINDS: ReadonlySet<EntityKind> = new Set(['function', 'method']);

const DEFAULT_LIMIT = 200;
const MAX_LIMIT     = 1000;

interface ComplexityInput {
	readonly repoPath: string;
	readonly file?:    string;
	readonly limit?:   number;
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
	readonly top:         readonly ComplexityEntry[];
}

const codeQualityComplexitySkill: Skill<ComplexityInput, ComplexityOutput> = {
	id: 'code.quality.complexity',
	name: 'Code: cyclomatic complexity per function / method',
	description:
		'Compute cyclomatic complexity for every function / method in the requested scope ' +
		'(repo-wide or single file). Returns the top-N entries by score plus a histogram of ' +
		'severity buckets (low / medium / high / critical).',
	family: 'quality-profile',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repoPath: { type: 'string', description: 'Repo root absolute path.' },
			file:     { type: 'string', description: 'Optional: scope to one file.' },
			limit:    { type: 'number', minimum: 1, maximum: MAX_LIMIT, description: `Top-N entries returned. Default: ${DEFAULT_LIMIT}.` },
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
			top:        { type: 'array' },
		},
		required: ['repoPath', 'entryCount', 'histogram', 'top'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: ComplexityInput, _deps: SkillDeps): Promise<SkillResult<ComplexityOutput>> {
		const limit = Math.max(1, Math.min(MAX_LIMIT, input.limit ?? DEFAULT_LIMIT));

		const all = input.file !== undefined
			? await findEntitiesByFile(null, input.file)
			: await listEntitiesForRepo(null, input.repoPath);

		const targets = all.filter(e => TARGET_KINDS.has(e.kind) && e.body.length > 0);
		const entries: ComplexityEntry[] = targets.map(toEntry);

		const histogram: Record<ComplexityLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };
		for (const e of entries) histogram[e.level]++;

		entries.sort((a, b) => b.cyclomatic - a.cyclomatic);
		const truncated = entries.length > limit;
		const top = entries.slice(0, limit);

		const out: ComplexityOutput = {
			repoPath:   input.repoPath,
			...(input.file !== undefined ? { file: input.file } : {}),
			entryCount: entries.length,
			histogram,
			top,
		};
		const result: SkillResult<ComplexityOutput> = {
			value: out,
			confidence: targets.length > 0 ? 'high' : 'low',
			notes: targets.length === 0
				? [`No function / method bodies found in scope.`]
				: [],
			toolCalls: [],
		};
		return truncated ? { ...result, truncated: true } : result;
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

export function registerCodeQualityComplexitySkill(): void {
	registerSkill(codeQualityComplexitySkill as unknown as Skill);
}
