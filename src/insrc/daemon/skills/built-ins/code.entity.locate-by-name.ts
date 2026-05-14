/**
 * code.entity.locate-by-name -- find entities by exact name across
 * any kind (code-analyzer-skills.md Phase 2.1).
 *
 * Generalisation of `code.class.extract-fields`'s locate step:
 * walks the LMDB name_index without the class-kind filter, so
 * functions / methods / variables / interfaces / etc. all
 * resolve.
 *
 * Output: `{ matches: [...] }` -- always a list (could be empty,
 * could be many). The richer typed-refusal contract lives on the
 * domain skills (extract-fields, locate-references, resolve-model);
 * the entity lookup is plain by design so a downstream skill can
 * decide what counts as ambiguous.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { findEntitiesByName } from '../../../db/entities.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';

// Phase B.1: removed DEFAULT_LIMIT / MAX_LIMIT / `limit` parameter.
// Skill returns ALL matches; the renderer pages for the LLM.

const ALL_KINDS: readonly EntityKind[] = [
	'function', 'method', 'class', 'interface', 'type', 'variable',
	'module', 'document', 'section', 'config', 'file', 'repo',
];

interface LocateInput {
	readonly name:     string;
	readonly kinds?:   readonly EntityKind[];
	readonly repoPath?: string;
	readonly language?: Language;
}

interface MatchEntity {
	readonly id:         string;
	readonly name:       string;
	readonly kind:       EntityKind;
	readonly language:   Language;
	readonly file:       string;
	readonly startLine:  number;
	readonly endLine:    number;
	readonly signature?: string;
	readonly isExported?: boolean;
}

interface LocateOutput {
	readonly name:    string;
	readonly matches: readonly MatchEntity[];
}

const codeEntityLocateByNameSkill: Skill<LocateInput, LocateOutput> = {
	id: 'code.entity.locate-by-name',
	name: 'Code: locate entities by exact name',
	description:
		'Find every entity matching an exact name across the requested kinds. Optional repo / ' +
		'language filters narrow the scope. Returns the COMPLETE set of matches.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			name:     { type: 'string', description: 'Exact name to match.' },
			kinds: {
				type: 'array',
				items: { type: 'string' },
				description: 'Subset of EntityKinds to consider. Default: all kinds.',
				uniqueItems: true,
				minItems: 1,
			},
			repoPath: { type: 'string', description: 'Optional repo root absolute path.' },
			language: {
				type: 'string',
				enum: ['typescript', 'javascript', 'python', 'go', 'java', 'scala'],
				description: 'Optional language filter.',
			},
		},
		required: ['name'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			name:    { type: 'string' },
			matches: { type: 'array' },
		},
		required: ['name', 'matches'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: LocateInput, _deps: SkillDeps): Promise<SkillResult<LocateOutput>> {
		const kinds = input.kinds !== undefined && input.kinds.length > 0
			? input.kinds
			: ALL_KINDS;

		// Pass an effectively-unlimited cap so the graph primitive doesn't
		// truncate. The renderer pages for the LLM (Phase B.5).
		const baseOpts = { kinds, limit: Number.MAX_SAFE_INTEGER } as const;
		const opts = input.repoPath !== undefined
			? { ...baseOpts, repo: input.repoPath }
			: baseOpts;

		const raw = await findEntitiesByName(null, [input.name], opts);
		const filtered = input.language !== undefined
			? raw.filter(e => e.language === input.language)
			: raw;

		const matches = filtered.map(toMatch);

		return {
			value: { name: input.name, matches },
			confidence: matches.length > 0 ? 'high' : 'medium',
			notes: matches.length === 0
				? [`No entity named '${input.name}' found in the index.`]
				: [],
			toolCalls: [],
		};
	},
};

function toMatch(e: Entity): MatchEntity {
	let m: MatchEntity = {
		id:        e.id,
		name:      e.name,
		kind:      e.kind,
		language:  e.language,
		file:      e.file,
		startLine: e.startLine,
		endLine:   e.endLine,
	};
	if (e.signature !== undefined && e.signature.length > 0) m = { ...m, signature: e.signature };
	if (e.isExported === true) m = { ...m, isExported: true };
	return m;
}

export function registerCodeEntityLocateByNameSkill(): void {
	registerSkill(codeEntityLocateByNameSkill as unknown as Skill);
}
