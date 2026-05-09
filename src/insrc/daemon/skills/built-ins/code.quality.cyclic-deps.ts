/**
 * code.quality.cyclic-deps -- find import cycles between files
 * (code-analyzer-skills.md Phase 5.5).
 *
 * Wraps the shipped `sccEntities` traversal primitive with the
 * IMPORTS edge filter. Each strongly-connected component of size
 * >= 2 is a cycle; size-1 SCCs are non-cycles by definition (Tarjan
 * yields every node as a singleton SCC even when it has no edge
 * back to itself).
 *
 * No-tool skill; pure graph computation over LMDB.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { listEntitiesForRepo } from '../../../db/entities.js';
import { sccEntities } from '../../../db/search.js';
import type { Entity } from '../../../shared/types.js';

const DEFAULT_MAX_CYCLES = 50;

interface CyclicDepsInput {
	readonly repoPath:   string;
	readonly maxCycles?: number;
}

interface CycleNode {
	readonly id:   string;
	readonly file: string;
}

interface Cycle {
	readonly size:  number;
	readonly nodes: readonly CycleNode[];
}

interface CyclicDepsOutput {
	readonly repoPath:    string;
	readonly fileCount:   number;
	readonly cycleCount:  number;
	readonly cycles:      readonly Cycle[];
}

const codeQualityCyclicDepsSkill: Skill<CyclicDepsInput, CyclicDepsOutput> = {
	id: 'code.quality.cyclic-deps',
	name: 'Code: detect file-level import cycles',
	description:
		'Find strongly-connected components of size >= 2 over the file-level IMPORTS graph. ' +
		'Each SCC is a cycle the team should resolve. Returns the capped list plus the full count.',
	family: 'quality-profile',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repoPath:  { type: 'string', description: 'Repo root absolute path.' },
			maxCycles: { type: 'number', minimum: 1, maximum: 500, description: `Max cycles returned. Default: ${DEFAULT_MAX_CYCLES}.` },
		},
		required: ['repoPath'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			repoPath:    { type: 'string' },
			fileCount:   { type: 'number' },
			cycleCount:  { type: 'number' },
			cycles:      { type: 'array' },
		},
		required: ['repoPath', 'fileCount', 'cycleCount', 'cycles'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: CyclicDepsInput, _deps: SkillDeps): Promise<SkillResult<CyclicDepsOutput>> {
		const maxCycles = Math.max(1, Math.min(500, input.maxCycles ?? DEFAULT_MAX_CYCLES));

		const all = await listEntitiesForRepo(null, input.repoPath);
		const files = all.filter(e => e.kind === 'file');
		if (files.length === 0) {
			return {
				value: { repoPath: input.repoPath, fileCount: 0, cycleCount: 0, cycles: [] },
				confidence: 'low',
				notes: [`No file entities found in '${input.repoPath}'. Either the repo isn't indexed yet or the path is wrong.`],
				toolCalls: [],
			};
		}

		const components = await sccEntities(
			null,
			files.map(f => f.id),
			{ kindFilter: ['IMPORTS'], direction: 'out' },
		);

		// Filter to non-trivial SCCs (size >= 2) -- single-node SCCs are
		// just "this file is reachable from itself" via Tarjan's
		// definition, not an actual cycle.
		const cycles = components.filter(c => c.length >= 2);

		const truncated = cycles.length > maxCycles;
		const ranked = cycles
			.slice()
			.sort((a, b) => b.length - a.length)
			.slice(0, maxCycles)
			.map(toCycle);

		const out: CyclicDepsOutput = {
			repoPath:   input.repoPath,
			fileCount:  files.length,
			cycleCount: cycles.length,
			cycles:     ranked,
		};

		const result: SkillResult<CyclicDepsOutput> = {
			value: out,
			confidence: 'high',
			notes: cycles.length === 0
				? ['No import cycles detected.']
				: [`Found ${cycles.length} import cycle(s) across ${files.length} files.`],
			toolCalls: [],
		};
		return truncated ? { ...result, truncated: true } : result;
	},
};

function toCycle(component: Entity[]): Cycle {
	return {
		size:  component.length,
		nodes: component.map(e => ({ id: e.id, file: e.file })),
	};
}

export function registerCodeQualityCyclicDepsSkill(): void {
	registerSkill(codeQualityCyclicDepsSkill as unknown as Skill);
}
