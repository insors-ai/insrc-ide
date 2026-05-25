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
import { resolveSearchScope, SCOPE_SCHEMA_FRAGMENT, type SearchScope } from '../scope-helpers.js';
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
	/**
	 * Plan SCS Phase 2: search scope. Defaults to `'closure'` so a
	 * call like `locate-by-name({ name: 'X' })` automatically scopes
	 * to the active session repo + its transitive DEPENDS_ON
	 * closure, instead of leaking into every indexed workspace repo
	 * (the pre-Plan-SCS behaviour). `'global'` is opt-in for the
	 * rare case where cross-project name resolution is wanted.
	 *
	 * Ignored when `repoPath` is set -- a single-repo override is
	 * more specific and wins.
	 */
	readonly scope?:   SearchScope;
	readonly language?: Language;
}

interface MatchEntity {
	readonly id:         string;
	readonly name:       string;
	readonly kind:       EntityKind;
	readonly language:   Language;
	readonly file:       string;
	/**
	 * Repo root absolute path of the entity. Added in Plan SCS
	 * Phase 2 so callers using `scope: 'global'` can disambiguate
	 * matches across projects. For default-`closure` callers, every
	 * `repo` is by construction inside the session's closure.
	 */
	readonly repo:       string;
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
		'Find every entity matching an exact name across the requested kinds. Scoped to the ' +
		"active repo's dependency closure by default (`scope: 'closure'`); pass `scope: 'global'` " +
		'to search every indexed repo. A single-repo override is also available via `repoPath`. ' +
		'Returns the COMPLETE set of matches.',
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
			repoPath: { type: 'string', description: 'Optional repo root absolute path. When set, overrides `scope`.' },
			scope:    SCOPE_SCHEMA_FRAGMENT,
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

	async execute(input: LocateInput, deps: SkillDeps): Promise<SkillResult<LocateOutput>> {
		const kinds = input.kinds !== undefined && input.kinds.length > 0
			? input.kinds
			: ALL_KINDS;

		// Pass an effectively-unlimited cap so the graph primitive doesn't
		// truncate. The renderer pages for the LLM (Phase B.5).
		const baseOpts = { kinds, limit: Number.MAX_SAFE_INTEGER };

		// Scope routing (Plan SCS Phase 2):
		//   - explicit `repoPath` wins (single-repo override, no closure)
		//   - else resolve `scope` against the session closure:
		//       'closure' -> { repos: closureRepos } (default)
		//       'global'  -> {} (no repo filter)
		const notes: string[] = [];
		let opts: Parameters<typeof findEntitiesByName>[2];
		if (input.repoPath !== undefined) {
			opts = { ...baseOpts, repo: input.repoPath };
		} else {
			const scope = input.scope ?? 'closure';
			const repos = resolveSearchScope(deps, scope);
			if (repos === null) {
				// 'global' opt-in -- no scope filter
				opts = baseOpts;
				notes.push("scope='global': searched every indexed repo");
			} else {
				opts = { ...baseOpts, repos };
			}
		}

		const raw = await findEntitiesByName(null, [input.name], opts);
		const filtered = input.language !== undefined
			? raw.filter(e => e.language === input.language)
			: raw;

		const matches = filtered.map(toMatch);

		if (matches.length === 0) {
			notes.push(`No entity named '${input.name}' found in the index.`);
		}

		return {
			value: { name: input.name, matches },
			confidence: matches.length > 0 ? 'high' : 'medium',
			notes,
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
		repo:      e.repo,
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
