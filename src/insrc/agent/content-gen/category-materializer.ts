/**
 * Cross-category resource materializer.
 *
 * Companion to `planActions` -- when the planner tags an action with
 * `requiredCategories: ['code-analyzer', ...]`, the orchestrator's
 * pre-action hook calls the matching materializer to resolve a
 * concrete resource (repo path / data connection) for that category.
 * The resolved resource is then threaded into the L2 dispatch via
 * `invocationContext.crossCategoryResources` (P4).
 *
 * See plans/planner-cross-category-skills.md P3.
 *
 * Three outcomes per materializer:
 *   - resolved   exactly one candidate -> auto-pick, dispatch widens
 *   - ambiguous  multiple candidates  -> auto-pick top, log all, the
 *                user can rerun with a disambiguating hint (a true
 *                interactive gate is a follow-up; see plan P3 note)
 *   - not-found  zero candidates       -> category dropped from this
 *                action's effective requirements, L2 will honestly
 *                say "the X source was not resolvable"
 */

import { getLogger } from '../../shared/logger.js';
import { findEntitiesByName } from '../../db/entities.js';
import { detectFilePaths } from '../tasks/data-analyzer/file-detect.js';
import { acquirePool } from '../../daemon/db/pool-cache.js';

import type { SkillOwner } from '../../daemon/skills/types.js';
import type { Session } from '../session.js';
import type { PlannedAction } from './plan-actions.js';

const log = getLogger('content-gen:category-materializer');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Discriminated resource handle. Shape varies per category. */
export type CategoryResource =
	| {
			readonly category:  'code-analyzer';
			readonly repoPath:  string;
			readonly label:     string;
	  }
	| {
			readonly category:     'data-analyzer';
			readonly connectionId: string;
			readonly family:       string;
			readonly kind:         string;
			readonly label:        string;
			readonly absPath:      string;
	  };

export type MaterializerOutcome =
	| {
			readonly kind:     'resolved';
			readonly resource: CategoryResource;
			readonly notes:    readonly string[];
	  }
	| {
			readonly kind:         'ambiguous';
			readonly chosen:       CategoryResource;
			readonly alternatives: readonly CategoryResource[];
			readonly notes:        readonly string[];
	  }
	| {
			readonly kind:  'not-found';
			readonly notes: readonly string[];
	  };

export interface MaterializerInput {
	readonly action:  PlannedAction;
	readonly request: string;
	readonly session: Session;
}

export type CategoryResourceMaterializer = (input: MaterializerInput) => Promise<MaterializerOutcome>;

// ---------------------------------------------------------------------------
// Identifier / path extraction
// ---------------------------------------------------------------------------

// CamelCase + PascalCase + ALLCAPS (>=2 chars). Catches `INGRN`,
// `PydanticModel`, `INPurchaseOrder`, `GRN`. Drops single letters and
// pure lowercase. Quoted forms (`'GRN'`, `"GRN"`) also matched.
const CAMEL_CASE = /\b([A-Z][A-Za-z0-9_]*[A-Za-z0-9])\b/g;

const STOP_WORDS = new Set<string>([
	'JSON', 'CSV', 'YAML', 'XML', 'HTML', 'TOML',
	'API', 'SDK', 'CLI', 'IDE', 'UI', 'GUI', 'OS',
	'HTTP', 'HTTPS', 'TCP', 'UDP', 'TLS', 'SSL',
	'SQL', 'NoSQL', 'DB', 'KV',
	'CRUD', 'REST', 'RPC', 'GRPC',
	'GST', 'PII', 'PR', 'PRs',
	'NULL', 'TRUE', 'FALSE',
	'GET', 'POST', 'PUT', 'DELETE',
	'TODO', 'FIXME', 'NOTE',
]);

/**
 * Pull CamelCase/PascalCase/ALLCAPS identifiers out of the action's
 * title + objective + request and drop common stop-words (acronyms
 * for things that aren't class names). Result is deduped + capped.
 */
export function extractIdentifierHints(input: MaterializerInput): readonly string[] {
	const text = `${input.action.title}\n${input.action.objective}\n${input.request}`;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of text.matchAll(CAMEL_CASE)) {
		const id = m[1];
		if (id === undefined) continue;
		if (STOP_WORDS.has(id)) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		if (out.length >= 12) break;
	}
	return out;
}

// ---------------------------------------------------------------------------
// materializeCode -- resolve a code repo from action hints
// ---------------------------------------------------------------------------

/**
 * Best-effort code-repo resolution:
 *  1. Extract CamelCase identifiers from action.title + objective + request.
 *  2. Probe every registered workspace repo's `name_index` for class /
 *     interface / module entries matching those identifiers.
 *  3. Group hits by repo path. Resolved if a single repo is hit;
 *     ambiguous if multiple; not-found if no hits and the session
 *     has no repo path to fall back to.
 *  4. Last-resort fallback: when no identifier-driven match is found
 *     but the session has an active `repoPath`, return that as
 *     resolved (with a note). Reason: a section that explicitly tagged
 *     `code-analyzer` likely needs SOME code resource; the active repo
 *     is the most-likely default in single-workspace setups.
 */
export const materializeCode: CategoryResourceMaterializer = async (input) => {
	const hints = extractIdentifierHints(input);
	const notes: string[] = [];

	if (hints.length === 0) {
		notes.push('extracted no class/identifier hints from action; falling back to session.repoPath');
		return fallbackToSessionRepo(input, notes);
	}

	const matches = await findEntitiesByName(null as never, hints, {
		kinds: ['class', 'interface', 'type', 'module', 'function', 'method'],
		limit: 50,
	});

	// Group by repo path.
	const repoToMatches = new Map<string, { hint: string; entity: string }[]>();
	for (const e of matches) {
		const list = repoToMatches.get(e.repo) ?? [];
		list.push({ hint: e.name, entity: e.id });
		repoToMatches.set(e.repo, list);
	}

	if (repoToMatches.size === 0) {
		notes.push(`probed ${hints.length} identifier hint(s); no matches in any registered repo`);
		return fallbackToSessionRepo(input, notes);
	}

	const repoPaths = [...repoToMatches.keys()];
	if (repoPaths.length === 1) {
		const repoPath = repoPaths[0]!;
		const hits = repoToMatches.get(repoPath)!;
		notes.push(`resolved to "${repoPath}" via ${hits.length} hint match(es): ${hits.slice(0, 4).map(h => h.hint).join(', ')}`);
		return {
			kind:     'resolved',
			resource: { category: 'code-analyzer', repoPath, label: labelForRepoPath(repoPath) },
			notes,
		};
	}

	// Ambiguous: pick the repo with the most hint matches; surface the
	// alternatives as notes so the user can rerun with a disambiguating
	// hint (a true interactive gate is a follow-up).
	const ranked = repoPaths
		.map(p => ({ path: p, count: repoToMatches.get(p)!.length }))
		.sort((a, b) => b.count - a.count);
	type CodeResource = Extract<CategoryResource, { category: 'code-analyzer' }>;
	const chosen: CodeResource = {
		category: 'code-analyzer',
		repoPath: ranked[0]!.path,
		label:    labelForRepoPath(ranked[0]!.path),
	};
	const alternatives: CodeResource[] = ranked.slice(1).map(r => ({
		category: 'code-analyzer',
		repoPath: r.path,
		label:    labelForRepoPath(r.path),
	}));
	notes.push(
		`ambiguous: ${ranked.length} repos matched the identifier hints; auto-picked "${chosen.repoPath}" (${ranked[0]!.count} match${ranked[0]!.count === 1 ? '' : 'es'})`,
		`alternatives: ${alternatives.map(a => `"${a.repoPath}"`).join(', ')}`,
		'rerun with a more specific module / class reference to disambiguate',
	);
	log.warn({ chosen: chosen.repoPath, alternatives: alternatives.map(a => a.repoPath), hints }, 'materializeCode: ambiguous repo resolution; auto-picked top');
	return { kind: 'ambiguous', chosen, alternatives, notes };
};

function fallbackToSessionRepo(input: MaterializerInput, notes: string[]): MaterializerOutcome {
	const repoPath = input.session.repoPath ?? '';
	if (repoPath.length === 0) {
		notes.push('session has no active repoPath; cannot resolve code resource');
		return { kind: 'not-found', notes };
	}
	notes.push(`fell back to session.repoPath "${repoPath}"`);
	return {
		kind:     'resolved',
		resource: { category: 'code-analyzer', repoPath, label: labelForRepoPath(repoPath) },
		notes,
	};
}

function labelForRepoPath(p: string): string {
	const idx = p.lastIndexOf('/');
	return idx >= 0 ? p.slice(idx + 1) : p;
}

// ---------------------------------------------------------------------------
// materializeData -- resolve a data file from action hints
// ---------------------------------------------------------------------------

/**
 * Best-effort data-resource resolution:
 *  1. Reuse `detectFilePaths` against action.title + objective + request,
 *     scoped to session.repoPath.
 *  2. If one detected file -> resolved; >1 -> ambiguous (auto-pick first
 *     by detection order); 0 -> not-found.
 *  3. Register the chosen file as an ephemeral connection via
 *     `acquirePool().registerEphemeral`, mirroring the auto-detect
 *     behavior the data orchestrator already runs at intake.
 */
export const materializeData: CategoryResourceMaterializer = async (input) => {
	const notes: string[] = [];
	const repoPath = input.session.repoPath ?? '';
	if (repoPath.length === 0) {
		notes.push('session has no active repoPath; cannot scope file detection');
		return { kind: 'not-found', notes };
	}

	const corpus = `${input.action.title}\n${input.action.objective}\n${input.request}`;
	const detected = detectFilePaths(corpus, repoPath);
	if (detected.length === 0) {
		notes.push('detected no file / directory paths in action context');
		return { kind: 'not-found', notes };
	}

	const pool = await acquirePool(repoPath).catch((err: Error) => {
		notes.push(`acquirePool failed: ${err.message}`);
		return undefined;
	});
	if (pool === undefined) {
		return { kind: 'not-found', notes };
	}

	const toResource = (f: typeof detected[number]): CategoryResource => ({
		category:     'data-analyzer',
		connectionId: f.connectionId,
		family:       'file',
		kind:         f.kind,
		label:        f.typed,
		absPath:      f.absPath,
	});

	const register = async (f: typeof detected[number]): Promise<void> => {
		try {
			await pool.registerEphemeral({
				id:     f.connectionId,
				kind:   f.kind,
				family: 'file',
				label:  f.typed,
				path:   f.absPath,
			});
			// Auto-approve: the planner committed to needing this category
			// and the materializer chose it; the existing access gate
			// pattern (data orchestrator at intake) does the same.
			const access = input.session.access;
			if (access !== undefined) {
				access.approve('connection', f.connectionId);
				access.approve('fs-path', f.absPath);
			}
		} catch (err) {
			notes.push(`registerEphemeral("${f.absPath}") failed: ${(err as Error).message}`);
		}
	};

	if (detected.length === 1) {
		const f = detected[0]!;
		await register(f);
		notes.push(`resolved to "${f.absPath}" (kind=${f.kind})`);
		return { kind: 'resolved', resource: toResource(f), notes };
	}

	const chosen = detected[0]!;
	await register(chosen);
	const alternatives = detected.slice(1).map(toResource);
	notes.push(
		`ambiguous: ${detected.length} candidate paths detected; auto-picked "${chosen.absPath}"`,
		`alternatives: ${alternatives.map(a => (a.category === 'data-analyzer' ? `"${a.absPath}"` : '?')).join(', ')}`,
		'rerun with a more specific file / directory reference to disambiguate',
	);
	log.warn({ chosen: chosen.absPath, alternatives: alternatives.length }, 'materializeData: ambiguous path resolution; auto-picked first');
	return { kind: 'ambiguous', chosen: toResource(chosen), alternatives, notes };
};

// ---------------------------------------------------------------------------
// Registry + orchestrator hook
// ---------------------------------------------------------------------------

// Per-category materializer registry. Type-level `Readonly` enforces
// immutability for production code; the runtime dictionary is left
// mutable so the test suite can install stub materializers under known
// categories without a separate injection seam.
export const CATEGORY_MATERIALIZERS: Readonly<Record<SkillOwner, CategoryResourceMaterializer | undefined>> = {
	'code-analyzer':   materializeCode,
	'data-analyzer':   materializeData,
	'deploy-analyzer': undefined,
	'test-agent':      undefined,
	'shared':          undefined,
};

export interface RunMaterializersInput {
	readonly action:       PlannedAction;
	readonly ownCategory:  SkillOwner;
	readonly request:      string;
	readonly session:      Session;
	/** Streamed to the IDE; surfaces resolution notes / ambiguity warnings. */
	readonly emitNote:     (line: string) => void;
}

export interface RunMaterializersResult {
	/**
	 * The categories that successfully resolved. `not-found` results are
	 * dropped here so the L2 skill's owner-filter widening only includes
	 * categories with a real resource backing them. Always excludes
	 * `ownCategory` (it's implicit; never widens against itself).
	 */
	readonly effectiveCategories: readonly SkillOwner[];
	/** Concrete resource handles, one per effective category. */
	readonly resources:           readonly CategoryResource[];
}

/**
 * Per-action hook: drives every materializer needed by this action,
 * uses the cache to avoid re-resolving across actions, and emits
 * resolution notes to the IDE stream.
 */
export async function runCategoryMaterializers(
	input: RunMaterializersInput,
	cache: Map<SkillOwner, MaterializerOutcome>,
): Promise<RunMaterializersResult> {
	const effective: SkillOwner[] = [];
	const resources: CategoryResource[] = [];

	for (const cat of input.action.requiredCategories) {
		if (cat === input.ownCategory) continue;        // implicit; skip
		let outcome = cache.get(cat);
		if (outcome === undefined) {
			const m = CATEGORY_MATERIALIZERS[cat];
			if (m === undefined) {
				input.emitNote(`[planner] required category "${cat}" has no materializer registered; skipping`);
				cache.set(cat, { kind: 'not-found', notes: ['no materializer registered'] });
				continue;
			}
			try {
				outcome = await m({ action: input.action, request: input.request, session: input.session });
			} catch (err) {
				const msg = (err as Error).message;
				log.warn({ category: cat, err: msg }, 'materializer threw');
				outcome = { kind: 'not-found', notes: [`materializer threw: ${msg}`] };
			}
			cache.set(cat, outcome);
		}

		// Surface notes regardless of outcome (resolved/ambiguous/not-found).
		for (const n of outcome.notes) {
			input.emitNote(`[planner] cross-category "${cat}": ${n}`);
		}

		if (outcome.kind === 'not-found') {
			continue;
		}
		const resource = outcome.kind === 'resolved' ? outcome.resource : outcome.chosen;
		effective.push(cat);
		resources.push(resource);
	}

	return { effectiveCategories: effective, resources };
}
