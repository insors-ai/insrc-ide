/**
 * Per-task LRU cache for the Data Analyzer
 * (plans/analyzers/data-analyzer.md Phase 2.4).
 *
 * Cache hit path: orchestrator's `runNextAnalyzerTask` checks the
 * cache before invoking `runDataDiscoveryPipeline`; on hit, it skips
 * the analyzer + reviewer pair entirely and treats the cached result
 * as accepted-with-original-confidence.
 *
 * Cache miss path: existing analyzer + reviewer flow runs; on a
 * reviewer `accept`, the result is written to cache via
 * `writeCachedResult` before the next task starts.
 *
 * Storage: one JSON file per entry under `~/.insrc/cache/data-analysis/`,
 * named by the SHA-256 of the cache key. Atomic writes via temp +
 * rename. LRU eviction uses mtime ordering -- read-on-hit `touch`es
 * the file to update its mtime, write-on-miss creates it; eviction
 * trims the oldest files past the 200-entry cap. Mirrors the code-
 * analyzer cache module verbatim.
 *
 * Cache key shape (Phase 2.4 simplified):
 *
 *     SHA-256(
 *       question +
 *       normalised(scope) +
 *       tier +
 *       connectionFingerprint
 *     )
 *
 * `connectionFingerprint` is a hash over the connection roster the
 * task touches. It catches the dominant invalidation case (a
 * connection being added / removed / re-registered against a
 * different URL) but does NOT detect schema drift on an unchanged
 * connection. The proper `getSchemaFingerprint(connectionId, target)`
 * driver helper outlined in Phase 2.4's "Driver gap" section
 * remains a follow-up: it'd dispatch by family (RDBMS describe / KV
 * sample-shape / file describe), canonicalise the SchemaDescription,
 * and hash. Until then, callers who want fresh introspection after
 * an out-of-band schema change can clear the cache via
 * `insrc.dataAnalyzer.clearCache`.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../../../shared/paths.js';
import { getLogger } from '../../../shared/logger.js';
import type { DataAnalysisTask, DataAnalyzerResult } from './types.js';
import type { ScopeSize } from '../../../shared/classify.js';

const log = getLogger('data-analyzer:cache');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 200;
const MAX_ENTRY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Inputs the orchestrator hands us to derive a cache key. Everything
 * influencing the analyzer's output must be captured here -- if it's
 * missing the cache will return stale results. `tier` is part of the
 * key because per-tier playbooks (Phase 1.10) produce different
 * analyzer behaviour for the same question. `connectionFingerprint`
 * is precomputed by the orchestrator (see `buildConnectionFingerprint`
 * below) so the cache module stays independent of the driver layer.
 */
export interface CacheKeyInput {
	readonly question: string;
	readonly scope: DataAnalysisTask['scope'];
	readonly tier: ScopeSize;
	readonly connectionFingerprint: string;
}

export function computeCacheKey(input: CacheKeyInput): string {
	const canonical = JSON.stringify({
		q: input.question,
		s: normaliseScope(input.scope),
		t: input.tier,
		c: input.connectionFingerprint,
	});
	return createHash('sha256').update(canonical).digest('hex');
}

function normaliseScope(scope: DataAnalysisTask['scope']): unknown {
	if (scope === undefined) {
		return null;
	}
	return {
		connections: scope.connections ? [...scope.connections].sort() : undefined,
		targets:     scope.targets     ? [...scope.targets].sort()     : undefined,
	};
}

/**
 * Derive a fingerprint over the connection roster a task will touch.
 * The orchestrator computes this once per task and passes it in.
 *
 * Two inputs feed it:
 *   - `taskScope.connections`: connection ids the task explicitly
 *     references (planner-emitted scope).
 *   - `registeredConnections`: every connection registered against
 *     the active session, summarised by id + kind + family. When a
 *     task has no explicit scope (free-form questions) this list
 *     stands in.
 *
 * Schema drift on an unchanged connection is NOT captured here -- a
 * follow-up `getSchemaFingerprint(connectionId, target)` driver
 * helper will tighten that. The roster-level fingerprint catches the
 * dominant change patterns (connection added / removed / re-registered).
 */
export function buildConnectionFingerprint(opts: {
	readonly taskScope: DataAnalysisTask['scope'];
	readonly registeredConnections: ReadonlyArray<{ id: string; kind: string; family: string }>;
}): string {
	const scopeIds = opts.taskScope?.connections ? [...opts.taskScope.connections].sort() : [];
	const rosterSummary = [...opts.registeredConnections]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map(c => `${c.id}:${c.kind}:${c.family}`);
	const canonical = JSON.stringify({ scope: scopeIds, roster: rosterSummary });
	return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Read / write / clear
// ---------------------------------------------------------------------------

interface CacheEntry {
	readonly version: 1;
	readonly key: string;
	readonly question: string;
	readonly tier: ScopeSize;
	readonly writtenAt: string;
	readonly result: DataAnalyzerResult;
}

function entryPath(key: string): string {
	return join(PATHS.dataAnalyzerCache, `${key}.json`);
}

async function ensureCacheDir(): Promise<void> {
	await fs.mkdir(PATHS.dataAnalyzerCache, { recursive: true });
}

/**
 * Look up a cached DataAnalyzerResult. Returns null on miss (file
 * doesn't exist, parse error, schema mismatch). Touches the file's
 * mtime on hit so LRU eviction sees it as recent.
 */
export async function readCachedResult(input: CacheKeyInput): Promise<DataAnalyzerResult | null> {
	const key = computeCacheKey(input);
	const path = entryPath(key);

	let raw: string;
	try {
		raw = await fs.readFile(path, 'utf8');
	} catch {
		return null;
	}

	let parsed: CacheEntry;
	try {
		parsed = JSON.parse(raw) as CacheEntry;
	} catch (err) {
		log.warn({ key, err: (err as Error).message }, 'cache entry malformed; ignoring');
		return null;
	}
	if (parsed.version !== 1 || !parsed.result) {
		log.warn({ key, version: parsed.version }, 'cache entry version mismatch; ignoring');
		return null;
	}

	const now = new Date();
	void fs.utimes(path, now, now).catch(() => {
		// Touch failure is non-fatal; the cached value is still valid.
	});

	log.info({ key, tier: parsed.tier, writtenAt: parsed.writtenAt }, 'cache hit');
	return parsed.result;
}

/**
 * Persist a reviewer-accepted DataAnalyzerResult to cache. Atomic:
 * writes to `<key>.json.tmp` then renames. Triggers an eviction
 * sweep when the entry count crosses MAX_ENTRIES.
 */
export async function writeCachedResult(
	input: CacheKeyInput,
	result: DataAnalyzerResult,
): Promise<void> {
	const key = computeCacheKey(input);
	const entry: CacheEntry = {
		version: 1,
		key,
		question: input.question,
		tier: input.tier,
		writtenAt: new Date().toISOString(),
		result,
	};

	const serialized = JSON.stringify(entry);
	if (serialized.length > MAX_ENTRY_BYTES) {
		log.warn({ key, size: serialized.length, cap: MAX_ENTRY_BYTES }, 'cache entry exceeds size cap; skipping write');
		return;
	}

	await ensureCacheDir();
	const path = entryPath(key);
	const tmp = `${path}.tmp`;
	try {
		await fs.writeFile(tmp, serialized, 'utf8');
		await fs.rename(tmp, path);
	} catch (err) {
		log.warn({ key, err: (err as Error).message }, 'cache write failed (non-fatal)');
		await fs.rm(tmp, { force: true }).catch(() => { /* nothing */ });
		return;
	}

	log.info({ key, tier: input.tier, size: serialized.length }, 'cache write');
	void evictLruIfNeeded().catch(err => {
		log.warn({ err: (err as Error).message }, 'cache LRU eviction failed (non-fatal)');
	});
}

/**
 * Clear every entry under the cache directory. Returns the number
 * of files removed. Backs the `insrc.dataAnalyzer.clearCache`
 * palette command via the matching daemon RPC.
 */
export async function clearCache(): Promise<{ removed: number }> {
	let entries: string[];
	try {
		entries = await fs.readdir(PATHS.dataAnalyzerCache);
	} catch {
		return { removed: 0 };
	}
	let removed = 0;
	for (const name of entries) {
		if (!name.endsWith('.json')) {
			continue;
		}
		try {
			await fs.unlink(join(PATHS.dataAnalyzerCache, name));
			removed++;
		} catch {
			// Skip files we couldn't delete; report best-effort count.
		}
	}
	log.info({ removed }, 'cache cleared');
	return { removed };
}

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

async function evictLruIfNeeded(): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(PATHS.dataAnalyzerCache);
	} catch {
		return;
	}
	const jsonEntries = entries.filter(n => n.endsWith('.json'));
	if (jsonEntries.length <= MAX_ENTRIES) {
		return;
	}

	const stats: Array<{ name: string; mtimeMs: number }> = [];
	for (const name of jsonEntries) {
		try {
			const s = await fs.stat(join(PATHS.dataAnalyzerCache, name));
			stats.push({ name, mtimeMs: s.mtimeMs });
		} catch {
			// Stat failure: ignore; can't evict by mtime.
		}
	}
	stats.sort((a, b) => a.mtimeMs - b.mtimeMs);

	const toRemove = stats.slice(0, stats.length - MAX_ENTRIES);
	for (const { name } of toRemove) {
		try {
			await fs.unlink(join(PATHS.dataAnalyzerCache, name));
		} catch {
			// Best-effort; ignore.
		}
	}
	log.info({ evicted: toRemove.length, kept: stats.length - toRemove.length }, 'cache LRU sweep complete');
}
