/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-slot context fetchers. One function per `ContextRequest['kind']`. Each function
 * compose-only -- the real work lives in `db/search.ts`, `db/entities.ts`,
 * `db/conversations.ts`, the LMDB graph layer, and git CLI. The fetcher's job is
 *
 *   (a) decide whether the request is too broad to fulfill cleanly (-> emit
 *       `status: 'needs-narrowing'` with a structured `narrowingHint`), and
 *   (b) honor the hard `byteCap` when fulfilling, emitting `status: 'partial'`
 *       when the cloud LLM has opted into truncation (topK / cap acceptance).
 *
 * Plan ref: [`plans/meta-tasks.md`](../../../plans/meta-tasks.md) M1.4.
 *
 * Implementation choice: one file instead of one-per-slot. The eight fetchers share
 * meaningful helpers (chunk builders, byte-cap accounting); separate files would
 * push that into a `common.ts` and add eight one-function modules without buying
 * anything. We can split later if any single fetcher grows past its section.
 */

import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';
import minimatch from 'minimatch';

import { getDb } from '../db/client.js';
import {
	findCallees,
	findCallers,
	findDefinedIn,
	findImports,
	searchEntities,
} from '../db/search.js';
import {
	findEntitiesByName,
	listEntitiesByKind,
	listEntitiesForRepo,
} from '../db/entities.js';
import { searchTurnsByRepo } from '../db/conversations.js';

import { getLogger } from '../shared/logger.js';

import type {
	ContextChunk,
	ContextRequest,
	ContextRequestDeliverable,
	ContextRequestEntities,
	ContextRequestFiles,
	ContextRequestGit,
	ContextRequestGraph,
	ContextRequestMemory,
	ContextRequestSemantic,
	ContextRequestTrace,
	DeliverableCatalog,
	NarrowingHint,
	ScopeManifest,
} from './types.js';

const log = getLogger('meta-task:fetchers');


// ---------------------------------------------------------------------------
// Shared inputs + helpers.
// ---------------------------------------------------------------------------

export interface FetchInputs {
	readonly scope:    ScopeManifest;
	readonly byteCap:  number;
	readonly catalog:  DeliverableCatalog;
	/**
	 * Embed a query string to a vector. Provided by the orchestrator so fetchers
	 * stay free of provider plumbing. Returns `[]` when embeddings are unavailable;
	 * the semantic / memory fetchers degrade gracefully when this happens
	 * (matching the existing `searchEntities` / `searchTurnsByRepo` behavior).
	 */
	readonly embed: (text: string) => Promise<number[]>;
}

function ok(request: ContextRequest, payload: unknown, note?: string): ContextChunk {
	return note !== undefined
		? { request, status: 'ok', payload, note }
		: { request, status: 'ok', payload };
}

function empty(request: ContextRequest, note?: string): ContextChunk {
	return note !== undefined
		? { request, status: 'empty', payload: null, note }
		: { request, status: 'empty', payload: null };
}

function partial(request: ContextRequest, payload: unknown, note: string): ContextChunk {
	return { request, status: 'partial', payload, note };
}

function needsNarrowing(request: ContextRequest, hint: NarrowingHint, note?: string): ContextChunk {
	return note !== undefined
		? { request, status: 'needs-narrowing', payload: null, narrowingHint: hint, note }
		: { request, status: 'needs-narrowing', payload: null, narrowingHint: hint };
}

function error(request: ContextRequest, err: Error): ContextChunk {
	return {
		request,
		status:  'error',
		payload: { message: err.message },
		note:    `fetch failed: ${err.message}`,
	};
}

/** Estimate the byte cost of a payload by JSON-stringifying it. Coarse but
 *  consistent across slot kinds; the byte cap is itself a soft contract. */
function jsonBytes(x: unknown): number {
	try { return Buffer.byteLength(JSON.stringify(x), 'utf8'); }
	catch { return 0; }
}


// ---------------------------------------------------------------------------
// kind: 'entities'
//
// Calls into db/entities.ts. Three filter axes: names, kinds, repos. The
// schema already requires at least one filter; we additionally guard against
// matches > 100 (the "too-broad" threshold from the design).
// ---------------------------------------------------------------------------

const ENTITIES_HARD_LIMIT = 100;

export async function fetchEntities(req: ContextRequestEntities, inputs: FetchInputs): Promise<ContextChunk> {
	try {
		const db = await getDb();
		const seen = new Map<string, unknown>();
		// Names filter -> exact lookups via findEntitiesByName.
		if (req.names !== undefined) {
			const hits = await findEntitiesByName(db, req.names);
			for (const h of hits) { seen.set(h.id, h); }
		}
		// Kinds filter -> listEntitiesByKind per kind.
		if (req.kinds !== undefined) {
			for (const k of req.kinds) {
				const hits = await listEntitiesByKind(db, k);
				for (const h of hits) { seen.set(h.id, h); }
			}
		}
		// Repos filter -> listEntitiesForRepo per repo.
		if (req.repos !== undefined) {
			for (const r of req.repos) {
				const hits = await listEntitiesForRepo(db, r);
				for (const h of hits) { seen.set(h.id, h); }
			}
		}
		const all = [...seen.values()];
		if (all.length === 0) {
			return empty(req);
		}
		if (all.length > ENTITIES_HARD_LIMIT && req.repos === undefined) {
			return needsNarrowing(req, {
				matched: all.length,
				suggestedFilters: ['add `repos` filter restricting to the scope repo'],
				note: `entities filter matched ${all.length} (> ${ENTITIES_HARD_LIMIT}); add a 'repos' filter or pick specific names.`,
			});
		}
		// Cap by bytes.
		const payload: unknown[] = [];
		let bytes = 0;
		for (const e of all) {
			const cost = jsonBytes(e);
			if (bytes + cost > inputs.byteCap) {
				return partial(req, payload, `byte cap reached at ${payload.length}/${all.length}`);
			}
			payload.push(e); bytes += cost;
		}
		return ok(req, payload);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'fetchEntities failed');
		return error(req, err as Error);
	}
}


// ---------------------------------------------------------------------------
// kind: 'files'
//
// Reads files under scope.repoPath matching the requested globs. Honors the
// per-fetcher byte cap (and `request.maxBytes` if it's tighter). Emits
// needs-narrowing when matches > 10x cap or > 3 top-level dirs without filter.
// ---------------------------------------------------------------------------

const FILES_TOO_BROAD_MULTIPLIER = 10;
const FILES_MAX_TOP_DIRS = 3;

export async function fetchFiles(req: ContextRequestFiles, inputs: FetchInputs): Promise<ContextChunk> {
	const effectiveCap = req.maxBytes !== undefined ? Math.min(req.maxBytes, inputs.byteCap) : inputs.byteCap;
	try {
		const matches = await walkAndMatch(inputs.scope.repoPath, req.globs);
		const filtered = matches.filter(m => !isOutOfScope(m.relPath, inputs.scope));
		if (filtered.length === 0) {
			return empty(req, `no files matched ${req.globs.join(', ')}`);
		}

		const totalBytes = filtered.reduce((s, f) => s + f.size, 0);
		// "Too broad" heuristics.
		const topDirs = new Set(filtered.map(f => f.relPath.split(path.sep)[0] ?? ''));
		if (totalBytes > effectiveCap * FILES_TOO_BROAD_MULTIPLIER || topDirs.size > FILES_MAX_TOP_DIRS) {
			return needsNarrowing(req, {
				matched: filtered.length,
				suggestedFilters: [
					`narrow by directory (top-level dirs hit: ${[...topDirs].join(', ')})`,
					`narrow by extension`,
				],
				suggestedAlternativeKinds: ['semantic', 'entities'],
				note:
					`files matched ${filtered.length} entries / ${humanBytes(totalBytes)} ` +
					`(cap ${humanBytes(effectiveCap)}); too broad to pick safely. Refine or use 'semantic' / 'entities'.`,
			});
		}

		const payload: { path: string; content: string; bytes: number }[] = [];
		let bytes = 0;
		for (const m of filtered) {
			if (bytes + m.size > effectiveCap) {
				return partial(req, payload, `byte cap reached at ${payload.length}/${filtered.length} files (${humanBytes(bytes)}/${humanBytes(totalBytes)})`);
			}
			try {
				const content = await fs.readFile(m.absPath, 'utf8');
				payload.push({ path: m.relPath, content, bytes: m.size });
				bytes += m.size;
			} catch {
				// Skip unreadable files; not fatal.
			}
		}
		return ok(req, payload);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'fetchFiles failed');
		return error(req, err as Error);
	}
}

interface FileMatch { readonly relPath: string; readonly absPath: string; readonly size: number; }

async function walkAndMatch(root: string, globs: readonly string[]): Promise<FileMatch[]> {
	const out: FileMatch[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries;
		try { entries = await fs.readdir(dir, { withFileTypes: true }); }
		catch { continue; }
		for (const ent of entries) {
			if (ent.name.startsWith('.')) { continue; }                   // skip dotfiles + .git
			if (ent.name === 'node_modules') { continue; }                // standard exclude
			const abs = path.join(dir, ent.name);
			if (ent.isDirectory()) { stack.push(abs); continue; }
			if (!ent.isFile()) { continue; }
			const rel = path.relative(root, abs);
			if (globs.some(g => minimatch(rel, g, { dot: false }))) {
				try { const st = await fs.stat(abs); out.push({ relPath: rel, absPath: abs, size: st.size }); }
				catch { /* unreadable; skip */ }
			}
		}
	}
	return out;
}

function isOutOfScope(relPath: string, scope: ScopeManifest): boolean {
	return scope.outOfScopePaths.some(p => relPath === p || relPath.startsWith(p + path.sep));
}

function humanBytes(n: number): string {
	if (n < 1024) { return `${n}B`; }
	if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)}KB`; }
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}


// ---------------------------------------------------------------------------
// kind: 'deliverable'
//
// Look up a deliverable by id in the catalog. Optionally slice to a heading
// section. The catalog only carries metadata; this fetcher reads the body
// from `catalog[i].absPath` lazily.
// ---------------------------------------------------------------------------

export async function fetchDeliverable(req: ContextRequestDeliverable, inputs: FetchInputs): Promise<ContextChunk> {
	const entry = inputs.catalog.find(e => e.id === req.specId);
	if (entry === undefined) {
		return needsNarrowing(req, {
			matched: 0,
			suggestedFilters: [
				`available specIds in catalog: ${inputs.catalog.map(e => e.id).join(', ') || '(none yet)'}`,
			],
			note: `deliverable specId='${req.specId}' not in catalog`,
		});
	}
	try {
		const body = await fs.readFile(entry.absPath, 'utf8');
		const slice = req.heading !== undefined ? sliceByHeading(body, req.heading) : body;
		if (slice === undefined) {
			return needsNarrowing(req, {
				matched: 0,
				suggestedFilters: [
					`available headings: ${entry.headings.join(', ') || '(none)'}`,
				],
				note: `deliverable '${req.specId}' has no heading matching '${req.heading}'`,
			});
		}
		if (Buffer.byteLength(slice, 'utf8') > inputs.byteCap) {
			return partial(req, { specId: req.specId, body: slice.slice(0, inputs.byteCap) },
				`deliverable body exceeds cap (${humanBytes(Buffer.byteLength(slice, 'utf8'))} > ${humanBytes(inputs.byteCap)}); truncated.`);
		}
		return ok(req, { specId: req.specId, heading: req.heading, body: slice });
	} catch (err) {
		log.warn({ err: (err as Error).message, specId: req.specId }, 'fetchDeliverable read failed');
		return error(req, err as Error);
	}
}

function sliceByHeading(body: string, heading: string): string | undefined {
	const lines = body.split('\n');
	// Match `# heading`, `## heading`, etc. Case-insensitive prefix match.
	const headerRe = /^(#{1,6})\s+(.+)$/;
	let startIdx = -1;
	let startLevel = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = headerRe.exec(lines[i]!);
		if (m !== null && m[2]!.trim().toLowerCase() === heading.trim().toLowerCase()) {
			startIdx = i; startLevel = m[1]!.length; break;
		}
	}
	if (startIdx === -1) { return undefined; }
	// Slice through to the next heading at the same level or shallower.
	let endIdx = lines.length;
	for (let i = startIdx + 1; i < lines.length; i++) {
		const m = headerRe.exec(lines[i]!);
		if (m !== null && m[1]!.length <= startLevel) { endIdx = i; break; }
	}
	return lines.slice(startIdx, endIdx).join('\n');
}


// ---------------------------------------------------------------------------
// kind: 'semantic'
//
// ANN over entity / deliverable vectors. Needs an embedding -- when none is
// available (no local Ollama) returns an empty chunk with a note. needs-
// narrowing fires when topK is absent and the corpus is large.
// ---------------------------------------------------------------------------

const SEMANTIC_LARGE_CORPUS = 1000;

export async function fetchSemantic(req: ContextRequestSemantic, inputs: FetchInputs): Promise<ContextChunk> {
	const vec = await inputs.embed(req.query);
	if (vec.length === 0) {
		return empty(req, 'embedding unavailable (local provider returns []); skipping semantic search');
	}
	if (req.topK === undefined) {
		// Coarse corpus-size proxy: count of entities in the scope repo.
		try {
			const db = await getDb();
			const corpus = await listEntitiesForRepo(db, inputs.scope.repoPath);
			if (corpus.length > SEMANTIC_LARGE_CORPUS) {
				return needsNarrowing(req, {
					matched: corpus.length,
					suggestedFilters: ['set topK (e.g. topK: 10)'],
					note: `semantic query against corpus of ${corpus.length} entities without topK; set topK to control result size.`,
				});
			}
		} catch { /* fall through to the search with default limit */ }
	}
	const limit = req.topK ?? 10;
	try {
		const db = await getDb();
		const hits = await searchEntities(db, vec, [inputs.scope.repoPath], limit);
		if (hits.length === 0) { return empty(req); }
		// Cap by bytes.
		const payload: unknown[] = [];
		let bytes = 0;
		for (const h of hits) {
			const cost = jsonBytes(h);
			if (bytes + cost > inputs.byteCap) {
				return partial(req, payload, `byte cap reached at ${payload.length}/${hits.length}`);
			}
			payload.push(h); bytes += cost;
		}
		return ok(req, payload);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'fetchSemantic failed');
		return error(req, err as Error);
	}
}


// ---------------------------------------------------------------------------
// kind: 'graph'
//
// Dispatches by `op` to the corresponding db/search.ts primitive. Depth-bounded
// closure operations get a needs-narrowing when depth is omitted on a large
// result set.
// ---------------------------------------------------------------------------

export async function fetchGraph(req: ContextRequestGraph, inputs: FetchInputs): Promise<ContextChunk> {
	try {
		const db = await getDb();
		const all: unknown[] = [];
		for (const target of req.targets) {
			let hits;
			switch (req.op) {
				case 'callers':   hits = await findCallers(db, target);   break;
				case 'callees':   hits = await findCallees(db, target);   break;
				case 'imports':   hits = await findImports(db, target);   break;
				case 'importers': hits = await findDefinedIn(db, target); break;  // file-defined-in is the inverse of import
				case 'closure': {
					// Closure of imports starting at `target`, limited by depth.
					if (req.depth === undefined) {
						return needsNarrowing(req, {
							matched: 0,
							suggestedFilters: ['set depth (e.g. depth: 2)'],
							note: `graph closure without depth is rejected -- depths > 3 frequently blow the cap. Pick an explicit depth.`,
						});
					}
					// Iterative BFS over imports for `depth` levels.
					const visited = new Set<string>([target]);
					let frontier = [target];
					for (let d = 0; d < req.depth; d++) {
						const next: string[] = [];
						for (const t of frontier) {
							const imports = await findImports(db, t);
							for (const i of imports) {
								if (!visited.has(i.id)) { visited.add(i.id); next.push(i.id); }
							}
						}
						frontier = next;
						if (frontier.length === 0) { break; }
					}
					hits = [...visited].map(id => ({ id }));
					break;
				}
				default:
					return error(req, new Error(`unknown graph op: ${req.op}`));
			}
			for (const h of hits) { all.push(h); }
		}
		if (all.length === 0) { return empty(req); }
		// Cap by bytes.
		const payload: unknown[] = [];
		let bytes = 0;
		for (const h of all) {
			const cost = jsonBytes(h);
			if (bytes + cost > inputs.byteCap) {
				return partial(req, payload, `byte cap reached at ${payload.length}/${all.length}`);
			}
			payload.push(h); bytes += cost;
		}
		return ok(req, payload);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'fetchGraph failed');
		return error(req, err as Error);
	}
}


// ---------------------------------------------------------------------------
// kind: 'git'
//
// Shells out to `git log`. Bounded by maxCommits (default 20) and paths.
// ---------------------------------------------------------------------------

const GIT_DEFAULT_MAX_COMMITS = 20;

export async function fetchGit(req: ContextRequestGit, inputs: FetchInputs): Promise<ContextChunk> {
	const maxCommits = req.maxCommits ?? GIT_DEFAULT_MAX_COMMITS;
	const args: string[] = ['log', `-${maxCommits}`, '--pretty=format:%H%x09%aI%x09%an%x09%s'];
	if (req.since !== undefined) { args.push(`--since=${req.since}`); }
	if (req.paths !== undefined && req.paths.length > 0) {
		args.push('--');
		for (const p of req.paths) { args.push(p); }
	}
	try {
		const { stdout } = await runGit(inputs.scope.repoPath, args);
		const lines = stdout.split('\n').filter(l => l.length > 0);
		if (lines.length === 0) { return empty(req); }
		const commits = lines.map(l => {
			const [hash, date, author, ...subj] = l.split('\t');
			return { hash, date, author, subject: subj.join('\t') };
		});
		if (jsonBytes(commits) > inputs.byteCap) {
			// Trim from the tail (oldest first).
			const trimmed: typeof commits = [];
			let bytes = 0;
			for (const c of commits) {
				const cost = jsonBytes(c);
				if (bytes + cost > inputs.byteCap) { break; }
				trimmed.push(c); bytes += cost;
			}
			return partial(req, trimmed, `byte cap reached at ${trimmed.length}/${commits.length} commits`);
		}
		return ok(req, commits);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'fetchGit failed');
		return error(req, err as Error);
	}
}

function runGit(cwd: string, args: readonly string[]): Promise<{ stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', [...args], { cwd });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
		child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
		child.on('error', err => reject(err));
		child.on('close', code => {
			if (code !== 0) { reject(new Error(`git exited ${code}: ${stderr.trim()}`)); }
			else            { resolve({ stdout }); }
		});
	});
}


// ---------------------------------------------------------------------------
// kind: 'trace'
//
// Read a handoff (or meta-task step) trace file. The catalog tells us where
// it lives, but trace files aren't in the catalog -- they're addressed by
// specId. Looks under both ~/.insrc/handoffs/<sessionId>/<specId>.trace.jsonl
// and ~/.insrc/meta/<id>/step-*.phase{1,2}.jsonl.
// ---------------------------------------------------------------------------

export async function fetchTrace(req: ContextRequestTrace, _inputs: FetchInputs): Promise<ContextChunk> {
	const candidates = await resolveTracePath(req.specId);
	if (candidates.length === 0) {
		return needsNarrowing(req, {
			matched: 0,
			note: `no trace file found for specId='${req.specId}' under ~/.insrc/handoffs or ~/.insrc/meta`,
		});
	}
	try {
		const merged: unknown[] = [];
		for (const p of candidates) {
			const body = await fs.readFile(p, 'utf8');
			for (const line of body.split('\n')) {
				if (line.length === 0) { continue; }
				try { merged.push(JSON.parse(line) as unknown); } catch { /* skip malformed */ }
			}
		}
		if (merged.length === 0) { return empty(req); }
		if (jsonBytes(merged) > _inputs.byteCap) {
			// Keep the tail (most recent events).
			const trimmed: unknown[] = [];
			let bytes = 0;
			for (let i = merged.length - 1; i >= 0; i--) {
				const cost = jsonBytes(merged[i]);
				if (bytes + cost > _inputs.byteCap) { break; }
				trimmed.unshift(merged[i]); bytes += cost;
			}
			return partial(req, trimmed, `byte cap reached; kept tail ${trimmed.length}/${merged.length} events`);
		}
		return ok(req, merged);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'fetchTrace failed');
		return error(req, err as Error);
	}
}

async function resolveTracePath(specId: string): Promise<string[]> {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (home === undefined) { return []; }
	const candidates: string[] = [];
	// Handoff layout: ~/.insrc/handoffs/<sessionId>/<specId>.trace.jsonl
	const handoffRoot = path.join(home, '.insrc', 'handoffs');
	try {
		const sessions = await fs.readdir(handoffRoot);
		for (const s of sessions) {
			const traceFile = path.join(handoffRoot, s, `${specId}.trace.jsonl`);
			try { await fs.access(traceFile); candidates.push(traceFile); } catch { /* not here */ }
		}
	} catch { /* handoffs dir doesn't exist; skip */ }
	return candidates;
}


// ---------------------------------------------------------------------------
// kind: 'memory'
//
// ANN over the user's conversation history (turn_vec). When no query is
// supplied, returns the most-recent turns for the scope repo as a recency
// fallback.
// ---------------------------------------------------------------------------

export async function fetchMemory(req: ContextRequestMemory, inputs: FetchInputs): Promise<ContextChunk> {
	try {
		const db = await getDb();
		if (req.query !== undefined && req.query.length > 0) {
			const vec = await inputs.embed(req.query);
			if (vec.length === 0) {
				return empty(req, 'embedding unavailable; memory recall returns empty');
			}
			const hits = await searchTurnsByRepo(db, inputs.scope.repoPath, vec, 10);
			if (hits.length === 0) { return empty(req); }
			const payload = hits.map(h => ({ user: h.user, assistant: h.assistant, ts: h.createdAt }));
			if (jsonBytes(payload) > inputs.byteCap) {
				const trimmed: typeof payload = [];
				let bytes = 0;
				for (const m of payload) {
					const cost = jsonBytes(m);
					if (bytes + cost > inputs.byteCap) { break; }
					trimmed.push(m); bytes += cost;
				}
				return partial(req, trimmed, `byte cap reached at ${trimmed.length}/${payload.length} turns`);
			}
			return ok(req, payload);
		}
		// No query: empty -- recency-based recall isn't a primitive yet.
		// The cloud LLM should ask with a query for now.
		return empty(req, 'memory recall without `query` is not supported in M1; pass a query string');
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'fetchMemory failed');
		return error(req, err as Error);
	}
}


// ---------------------------------------------------------------------------
// Dispatch -- single entrypoint the orchestrator's driver calls. Routes by
// kind to the per-slot function. New slot kinds extend this switch + add a
// fetch function above.
// ---------------------------------------------------------------------------

export async function dispatchFetch(req: ContextRequest, inputs: FetchInputs): Promise<ContextChunk> {
	switch (req.kind) {
		case 'entities':    return fetchEntities(req, inputs);
		case 'files':       return fetchFiles(req, inputs);
		case 'deliverable': return fetchDeliverable(req, inputs);
		case 'semantic':    return fetchSemantic(req, inputs);
		case 'graph':       return fetchGraph(req, inputs);
		case 'git':         return fetchGit(req, inputs);
		case 'trace':       return fetchTrace(req, inputs);
		case 'memory':      return fetchMemory(req, inputs);
	}
}
