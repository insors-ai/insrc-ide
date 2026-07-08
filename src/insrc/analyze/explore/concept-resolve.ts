/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * concept.resolve exploration runner.
 *
 * plans/exploration-based-context-build.md Phase 1. Given a
 * natural-language query (typically `intent.focus`), rank
 * directories, files, and entities in the repo by how well they
 * match the query TOKENS. Deterministic + explainable + cheap --
 * no LLM.
 *
 * This is the exploration that FIXES the Test 3 failure. When
 * asked "map the payable extraction module", the LLM shaper
 * memory-matched `payable` to `insors/core/model/invoice/`. This
 * runner ranks `insors/extraction/payable/` #1 because the path
 * literally contains BOTH tokens (`extraction` + `payable`) --
 * an objective 2-token path match beats the LLM's 1-token
 * memory pattern.
 *
 * Ranking = weighted sum of:
 *   - Path-token match: unique query tokens that appear in the
 *     entity's absolute path, normalised by query token count
 *   - Name-token match: unique query tokens that appear in the
 *     entity's name (identifier or filename), same normalisation
 *   - Path-depth penalty: shallower paths score marginally higher
 *     (a directory is more meaningful than a deep-nested file
 *     when both share the same token match)
 *   - Directory bonus: kind='dir' hits get a small boost when the
 *     query implies "module" / "package" / "framework" (structural
 *     queries) -- expressed via the STRUCTURAL_TOKENS list
 *
 * NOT included in v1:
 *   - Graph in-degree (deferred; adds complexity without proven
 *     ranking benefit for structural-map queries)
 *   - Vector similarity fallback (deferred; the tokenizer covers
 *     the common cases; vector kicks in for prose-retrieval
 *     answer types in a later phase)
 */

import { readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { getDb } from '../../db/client.js';
import { listEntitiesForRepo } from '../../db/entities.js';
import { getLogger } from '../../shared/logger.js';
import type { Entity } from '../../shared/types.js';

import type {
	ConceptHit,
	ConceptResolveOutput,
	Exploration,
	ExplorationRunnerContext,
} from './types.js';

const log = getLogger('analyze:explore:concept-resolve');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_HITS = 20;

/** Stopwords to drop from queries -- common English filler + generic
 *  code-jargon that would false-match everywhere. */
const STOPWORDS = new Set([
	'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in',
	'on', 'at', 'for', 'with', 'from', 'by', 'as', 'and', 'or', 'not',
	'this', 'that', 'it', 'its', 'we', 'you', 'i', 'me', 'my', 'our',
	'what', 'when', 'where', 'why', 'how', 'do', 'does', 'did', 'have',
	'has', 'had', 'can', 'will', 'would', 'should', 'could',
	// code-jargon fillers
	'code', 'file', 'system', 'framework', 'library', 'source',
	'thing', 'stuff', 'about', 'like', 'some', 'any', 'all',
]);

/** Query tokens that hint the user is asking about a MODULE, not a
 *  single symbol. Presence boosts kind='dir' hits. */
const STRUCTURAL_TOKENS = new Set([
	'module', 'package', 'subsystem', 'framework', 'component',
	'service', 'layer', 'pipeline', 'infrastructure',
]);

/** Score weights (sum to ~1.0 before bonuses). */
const W_PATH_TOKENS = 0.55;
const W_NAME_TOKENS = 0.35;
const W_DEPTH       = 0.10;

/** Small additive bonuses. */
const DIR_STRUCTURAL_BONUS = 0.10;

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

/** Split a query on non-alphanumeric boundaries + lower-case. */
function tokenise(query: string): string[] {
	return query.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Split a code identifier or path segment into tokens. Handles
 * snake_case, camelCase, kebab-case, dot.separated, and file
 * extensions in one pass.
 */
function splitIdentifier(name: string): string[] {
	// First collapse extension separators + slashes to spaces, then
	// split camelCase: any lowercase-to-uppercase or letter-to-digit
	// transition becomes a boundary.
	const collapsed = name
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
		.replace(/([a-zA-Z])(\d)/g, '$1 $2')
		.replace(/(\d)([a-zA-Z])/g, '$1 $2');
	return collapsed
		.split(/[^a-zA-Z0-9]+/g)
		.filter(t => t.length >= 2)
		.map(t => t.toLowerCase());
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface Candidate {
	readonly kind:  'dir' | 'file' | 'entity';
	readonly path:  string;
	readonly name:  string;
	readonly entityId?: string;
}

interface ScoredCandidate extends Candidate {
	readonly score: number;
	readonly diagnostics: {
		tokenMatch?: number;
		pathDepth?:  number;
	};
}

function scoreCandidate(
	c:      Candidate,
	tokens: readonly string[],
	repoPath: string,
	structuralBoost: boolean,
): ScoredCandidate | null {
	if (tokens.length === 0) return null;

	// Tokenise the path (walk every path segment, split each on
	// identifier boundaries). Same for the name.
	const relPath = c.path.startsWith(repoPath) ? c.path.slice(repoPath.length + 1) : c.path;
	const pathTokens = new Set<string>();
	for (const seg of relPath.split(/[\\/]+/g)) {
		for (const t of splitIdentifier(seg)) pathTokens.add(t);
	}
	const nameTokens = new Set(splitIdentifier(c.name));

	// Count query tokens that appear in path / name.
	let pathHits = 0;
	let nameHits = 0;
	for (const t of tokens) {
		if (pathTokens.has(t)) pathHits += 1;
		if (nameTokens.has(t)) nameHits += 1;
	}

	// No hits at all -> drop.
	if (pathHits === 0 && nameHits === 0) return null;

	const pathMatchNorm = pathHits / tokens.length;
	const nameMatchNorm = nameHits / tokens.length;

	// Depth score: fewer path segments = higher. Repo root = 0
	// segments (max). Each extra segment costs a small linear amount
	// (cap ~6 levels).
	const depthSegments = relPath.split(/[\\/]+/g).filter(x => x.length > 0).length;
	const depthScore = Math.max(0, 1 - depthSegments / 6);

	let score =
		W_PATH_TOKENS * pathMatchNorm +
		W_NAME_TOKENS * nameMatchNorm +
		W_DEPTH       * depthScore;

	if (structuralBoost && c.kind === 'dir') {
		score += DIR_STRUCTURAL_BONUS;
	}

	// Clamp to [0, 1] after bonuses.
	if (score > 1) score = 1;
	if (score < 0) score = 0;

	return {
		...c,
		score,
		diagnostics: {
			tokenMatch: (pathMatchNorm + nameMatchNorm) / 2,
			pathDepth:  depthSegments,
		},
	};
}

// ---------------------------------------------------------------------------
// Candidate enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate directories under the repo, up to a depth cap. Skip
 * common noise directories (node_modules, .git, __pycache__, ...).
 *
 * We SCAN the filesystem for directories rather than relying on the
 * indexer's entity table because:
 *   - Directories don't get entities by themselves (only files do)
 *   - We want ALL directories, not just those with code
 *   - Filesystem walk is fast (thousands of dirs in <100ms)
 */
const IGNORE_DIRS = new Set([
	'node_modules', '.git', '__pycache__', '.venv', 'venv',
	'.tox', 'dist', 'build', '.next', '.cache', 'target',
	'.mypy_cache', '.pytest_cache', '.ruff_cache',
	'.DS_Store', 'coverage', '.idea', '.vscode',
]);

const MAX_DIR_DEPTH = 8;

function enumerateDirs(repoPath: string): Candidate[] {
	const out: Candidate[] = [];
	function walk(dir: string, depth: number): void {
		if (depth > MAX_DIR_DEPTH) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (IGNORE_DIRS.has(name)) continue;
			if (name.startsWith('.') && depth === 0) continue;   // skip .git-like at root
			const full = join(dir, name);
			let s;
			try { s = statSync(full); }
			catch { continue; }
			if (!s.isDirectory()) continue;
			out.push({ kind: 'dir', path: full, name });
			walk(full, depth + 1);
		}
	}
	walk(repoPath, 0);
	return out;
}

/**
 * Enumerate `file` entities in the repo. Every source-code file gets
 * a kind='file' entity from the parser layer.
 */
function fileCandidatesFromEntities(entities: readonly Entity[]): Candidate[] {
	const out: Candidate[] = [];
	for (const e of entities) {
		if (e.kind !== 'file') continue;
		out.push({
			kind: 'file',
			path: e.file,
			name: basename(e.file),
		});
	}
	return out;
}

/**
 * Enumerate the "structural" entities: functions / classes /
 * methods / types / modules. Excludes files (already covered) and
 * artefacts (docs / config -- have their own retrieval path).
 */
const STRUCTURAL_ENTITY_KINDS = new Set([
	'function', 'class', 'method', 'interface', 'type', 'module',
]);

function structuralEntityCandidates(entities: readonly Entity[]): Candidate[] {
	const out: Candidate[] = [];
	for (const e of entities) {
		if (!STRUCTURAL_ENTITY_KINDS.has(e.kind)) continue;
		if (e.artifact === true) continue;
		out.push({
			kind:     'entity',
			path:     e.file,
			name:     e.name,
			entityId: e.id,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Params + runner
// ---------------------------------------------------------------------------

interface ConceptResolveParams {
	readonly query:       string;
	readonly limit?:      number;
	/** Bias to include/exclude kinds. Default: include all. */
	readonly includeKinds?: readonly ('dir' | 'file' | 'entity')[];
}

function parseParams(exp: Exploration): ConceptResolveParams {
	const p = exp.params as Record<string, unknown>;
	const query = typeof p['query'] === 'string' ? (p['query'] as string).trim() : '';
	if (query.length === 0) {
		throw new Error(`concept.resolve: params.query is required (non-empty string)`);
	}
	const limit = typeof p['limit'] === 'number' && p['limit']! > 0
		? Math.min(MAX_HITS, Math.floor(p['limit'] as number))
		: MAX_HITS;
	const includeKindsRaw = p['includeKinds'];
	const includeKinds = Array.isArray(includeKindsRaw)
		? includeKindsRaw.filter(k => k === 'dir' || k === 'file' || k === 'entity') as ('dir' | 'file' | 'entity')[]
		: undefined;
	return {
		query,
		limit,
		...(includeKinds !== undefined ? { includeKinds } : {}),
	};
}

export async function runConceptResolve(
	exp: Exploration,
	ctx: ExplorationRunnerContext,
): Promise<ConceptResolveOutput> {
	const params = parseParams(exp);
	const tokens = tokenise(params.query);
	if (tokens.length === 0) {
		log.debug({ query: params.query }, 'concept.resolve: no salient tokens');
		return { type: 'concept.resolve', query: params.query, hits: [] };
	}

	const structuralBoost = tokens.some(t => STRUCTURAL_TOKENS.has(t));
	const includeKinds = params.includeKinds ?? ['dir', 'file', 'entity'];

	const db = await getDb();
	const entities = await listEntitiesForRepo(db, ctx.repoPath);

	// Assemble the candidate pool.
	const candidates: Candidate[] = [];
	if (includeKinds.includes('dir'))    candidates.push(...enumerateDirs(ctx.repoPath));
	if (includeKinds.includes('file'))   candidates.push(...fileCandidatesFromEntities(entities));
	if (includeKinds.includes('entity')) candidates.push(...structuralEntityCandidates(entities));

	// Score every candidate. Drop zero-hit candidates inline.
	const scored: ScoredCandidate[] = [];
	for (const c of candidates) {
		const s = scoreCandidate(c, tokens, ctx.repoPath, structuralBoost);
		if (s !== null) scored.push(s);
	}

	// Dedup by (kind, path) preferring the higher score. Rare edge
	// case where the same path is enumerated via multiple candidate
	// paths.
	const byKey = new Map<string, ScoredCandidate>();
	for (const s of scored) {
		const k = `${s.kind}:${s.path}`;
		const prev = byKey.get(k);
		if (prev === undefined || s.score > prev.score) byKey.set(k, s);
	}

	const ranked = Array.from(byKey.values())
		.sort((a, b) => b.score - a.score)
		.slice(0, params.limit ?? MAX_HITS);

	const hits: ConceptHit[] = ranked.map(r => ({
		kind:  r.kind,
		path:  r.path,
		name:  r.name,
		...(r.entityId !== undefined ? { entityId: r.entityId } : {}),
		score: Math.round(r.score * 1000) / 1000,
		diagnostics: {
			...(r.diagnostics.tokenMatch !== undefined ? { tokenMatch: Math.round(r.diagnostics.tokenMatch * 1000) / 1000 } : {}),
			...(r.diagnostics.pathDepth !== undefined ? { pathDepth:  r.diagnostics.pathDepth } : {}),
		},
	}));

	log.info(
		{
			runId:   ctx.runId,
			query:   params.query,
			tokens,
			candidateCount: candidates.length,
			scoredCount:    scored.length,
			returnedCount:  hits.length,
			topPath: hits[0]?.path,
		},
		'concept.resolve: complete',
	);

	return { type: 'concept.resolve', query: params.query, hits };
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export const _tokeniseForTest = tokenise;
export const _splitIdentifierForTest = splitIdentifier;
export const _scoreCandidateForTest = scoreCandidate;

// silence unused import when this file is later refactored
void relative;
