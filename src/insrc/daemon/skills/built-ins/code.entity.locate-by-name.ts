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

const DEFAULT_LIMIT = 25;
const MAX_LIMIT     = 100;

const ALL_KINDS: readonly EntityKind[] = [
	'function', 'method', 'class', 'interface', 'type', 'variable',
	'module', 'document', 'section', 'config', 'file', 'repo',
];

interface LocateInput {
	readonly name:     string;
	readonly kinds?:   readonly EntityKind[];
	readonly repoPath?: string;
	readonly language?: Language;
	readonly limit?:    number;
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
	readonly truncated: boolean;
}

const codeEntityLocateByNameSkill: Skill<LocateInput, LocateOutput> = {
	id: 'code.entity.locate-by-name',
	name: 'Code: locate entities by exact name',
	description:
		'Find every entity matching an exact name across the requested kinds. Optional repo / ' +
		'language filters narrow the scope. Returns `{ matches: [...] }` -- empty when nothing ' +
		'matches; truncated:true when the cap is hit.',
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
			limit: { type: 'number', minimum: 1, maximum: MAX_LIMIT, description: `Max matches to return. Default: ${DEFAULT_LIMIT}.` },
		},
		required: ['name'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			name:      { type: 'string' },
			matches:   { type: 'array' },
			truncated: { type: 'boolean' },
		},
		required: ['name', 'matches', 'truncated'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: LocateInput, _deps: SkillDeps): Promise<SkillResult<LocateOutput>> {
		const limit = Math.max(1, Math.min(MAX_LIMIT, input.limit ?? DEFAULT_LIMIT));
		const kinds = input.kinds !== undefined && input.kinds.length > 0
			? input.kinds
			: ALL_KINDS;

		const baseOpts = {
			kinds,
			limit: limit + 1, // probe one extra to detect truncation
		} as const;
		const opts = input.repoPath !== undefined
			? { ...baseOpts, repo: input.repoPath }
			: baseOpts;

		const raw = await findEntitiesByName(null, [input.name], opts);
		const filtered = input.language !== undefined
			? raw.filter(e => e.language === input.language)
			: raw;

		const truncated = filtered.length > limit;
		const matches = filtered.slice(0, limit).map(toMatch);

		const result: SkillResult<LocateOutput> = {
			value: { name: input.name, matches, truncated },
			confidence: matches.length > 0 ? 'high' : 'medium',
			notes: matches.length === 0
				? [`No entity named '${input.name}' found in the index.`]
				: [],
			toolCalls: [],
		};
		return truncated ? { ...result, truncated: true } : result;
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
