/**
 * Per-task LRU cache for the Code Analyzer
 * (plans/analyzers/code-analyzer.md Phase 2.5).
 *
 * Cache hit path: orchestrator's `runNextAnalyzerTask` checks the
 * cache before invoking `runAnalyzer`; on hit, it skips the analyzer
 * + reviewer pair entirely and treats the cached result as
 * accepted-with-original-confidence.
 *
 * Cache miss path: existing analyzer + reviewer flow runs; on a
 * reviewer `accept`, the result is written to cache before
 * `markComplete`.
 *
 * Storage: one JSON file per entry under `~/.insrc/cache/code-analyzer/`,
 * named by the SHA-256 of the cache key. Atomic writes via temp +
 * rename. LRU eviction uses mtime ordering -- read-on-hit `touch`es
 * the file to update its mtime, write-on-miss creates it; eviction
 * trims the oldest files past the 200-entry cap.
 *
 * Cross-revision invalidation: the cache key includes
 * `repoSnapshotId`, which the orchestrator derives from the active
 * repo's git HEAD SHA when available. New commit -> different
 * snapshotId -> cache miss. No span-content hashing -- per design
 * §14, full invalidation per-commit is acceptable until usage data
 * shows otherwise.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../../../shared/paths.js';
import { getLogger } from '../../../shared/logger.js';
import type { AnalysisScope, AnalyzerResult } from './types.js';
import type { ScopeSize } from '../../../shared/classify.js';

const log = getLogger('code-analyzer:cache');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Cap on cached entries. Beyond this the oldest (by mtime) get evicted. */
const MAX_ENTRIES = 200;

/**
 * Cap on a single entry's serialized size (bytes). Defensive: a
 * pathological multi-MB analyzer result shouldn't be allowed to fill
 * the cache budget by itself. Entries past this size silently skip
 * the write.
 */
const MAX_ENTRY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

export interface CacheKeyInput {
	readonly question: string;
	readonly scope: AnalysisScope | undefined;
	readonly repoSnapshotId: string;
	readonly tier: ScopeSize;
}

/**
 * SHA-256 over a canonicalised key. JSON.stringify with sorted keys
 * gives a stable hash regardless of property ordering. Tier is part
 * of the key because Phase 5.B's per-tier playbooks produce
 * different per-task analyzer behaviour for the same question.
 */
export function computeCacheKey(input: CacheKeyInput): string {
	const canonical = JSON.stringify({
		q: input.question,
		s: normaliseScope(input.scope),
		r: input.repoSnapshotId,
		t: input.tier,
	});
	return createHash('sha256').update(canonical).digest('hex');
}

function normaliseScope(scope: AnalysisScope | undefined): unknown {
	if (scope === undefined) {
		return null;
	}
	// Sort string-array fields so a re-ordered scope still hits the
	// same key. Numeric / scalar fields stay as-is.
	return {
		entityIds: scope.entityIds ? [...scope.entityIds].sort() : undefined,
		paths:     scope.paths     ? [...scope.paths].sort()     : undefined,
		packages:  scope.packages  ? [...scope.packages].sort()  : undefined,
		direction: scope.direction,
		targets:   scope.targets,
	};
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
	readonly result: AnalyzerResult;
}

function entryPath(key: string): string {
	return join(PATHS.codeAnalyzerCache, `${key}.json`);
}

async function ensureCacheDir(): Promise<void> {
	await fs.mkdir(PATHS.codeAnalyzerCache, { recursive: true });
}

/**
 * Look up a cached AnalyzerResult. Returns null on miss (file
 * doesn't exist, parse error, schema mismatch). Touches the file's
 * mtime on hit so LRU eviction sees it as recent.
 */
export async function readCachedResult(input: CacheKeyInput): Promise<AnalyzerResult | null> {
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

	// Touch mtime so LRU eviction treats this as recently used.
	const now = new Date();
	void fs.utimes(path, now, now).catch(() => {
		// Touch failure is non-fatal; the cached value is still valid.
	});

	log.info({ key, tier: parsed.tier, writtenAt: parsed.writtenAt }, 'cache hit');
	return parsed.result;
}

/**
 * Persist a reviewer-accepted AnalyzerResult to cache. Atomic:
 * writes to `<key>.json.tmp` then renames. Triggers an eviction
 * sweep when the entry count crosses MAX_ENTRIES (cheap: single
 * readdir + sort).
 */
export async function writeCachedResult(
	input: CacheKeyInput,
	result: AnalyzerResult,
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
 * of files removed. Used by the `insrc.codeAnalyzer.clearCache`
 * palette command.
 */
export async function clearCache(): Promise<{ removed: number }> {
	let entries: string[];
	try {
		entries = await fs.readdir(PATHS.codeAnalyzerCache);
	} catch {
		return { removed: 0 };
	}
	let removed = 0;
	for (const name of entries) {
		if (!name.endsWith('.json')) {
			continue;
		}
		try {
			await fs.unlink(join(PATHS.codeAnalyzerCache, name));
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
		entries = await fs.readdir(PATHS.codeAnalyzerCache);
	} catch {
		return;
	}
	const jsonEntries = entries.filter(n => n.endsWith('.json'));
	if (jsonEntries.length <= MAX_ENTRIES) {
		return;
	}

	// Stat each file for mtime; evict oldest. The sort is O(N log N);
	// bounded N (200ish) so it's negligible.
	const stats: Array<{ name: string; mtimeMs: number }> = [];
	for (const name of jsonEntries) {
		try {
			const s = await fs.stat(join(PATHS.codeAnalyzerCache, name));
			stats.push({ name, mtimeMs: s.mtimeMs });
		} catch {
			// Stat failure: ignore; can't evict by mtime.
		}
	}
	stats.sort((a, b) => a.mtimeMs - b.mtimeMs);

	const toRemove = stats.slice(0, stats.length - MAX_ENTRIES);
	for (const { name } of toRemove) {
		try {
			await fs.unlink(join(PATHS.codeAnalyzerCache, name));
		} catch {
			// Best-effort; ignore.
		}
	}
	log.info({ evicted: toRemove.length, kept: stats.length - toRemove.length }, 'cache LRU sweep complete');
}
