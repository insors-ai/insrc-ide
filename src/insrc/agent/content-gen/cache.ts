/**
 * Section-level cache for the multi-pass content generator
 * (plans/content-generator.md commit 3).
 *
 * The cache stores generated section bodies keyed on
 * `SHA256(outline.title + section.id + section.intent +
 * dependsOn-bodies-hash + cacheContext)`. Dependencies' bodies are
 * folded into the key so a stale dependency invalidates the
 * dependent section automatically.
 *
 * Two surfaces:
 *
 *   1. `ContentCache` -- the abstract interface the module's
 *      section runner consults. Caller supplies; opaque to the
 *      module (caller decides on-disk vs in-memory vs no-op).
 *
 *   2. `makeDiskContentCache(opts)` -- a ready-made disk LRU that
 *      mirrors the Phase 2.5 code-analyzer cache layout:
 *      one JSON file per entry, atomic write via tmp+rename,
 *      mtime-based LRU eviction.
 *
 * Keying helpers (`computeSectionCacheKey`, `hashPriorBodies`) are
 * exported so callers building bespoke caches can reuse the same
 * derivation -- two different cache stores with the same key
 * derivation share entries.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../../shared/logger.js';
import type { SectionPlan, SectionResult } from './types.js';

const log = getLogger('content-gen:cache');

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ContentCache {
	/** Lookup. Returns undefined on miss. Errors are logged + treated as miss. */
	get(key: string): Promise<string | undefined>;
	/** Write. Errors are logged, not thrown. */
	put(key: string, value: string): Promise<void>;
}

export interface DiskContentCacheOpts {
	/** Directory to store entries under. Created on demand. */
	readonly dir: string;
	/** Cap on cached entries. Default 200, matching the code-analyzer cache. */
	readonly maxEntries?: number;
	/** Cap on a single entry's serialized JSON in bytes. Default 256 KB. */
	readonly maxEntryBytes?: number;
}

const DEFAULT_MAX_ENTRIES    = 200;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;

/**
 * Disk LRU implementation. One JSON file per entry under `opts.dir`,
 * named by the SHA-256 of the cache key. mtime touched on hit so
 * eviction sees the entry as recent. Eviction sweeps when the entry
 * count crosses `maxEntries`.
 *
 * Mirror of the Phase 2.5 code-analyzer per-task cache layout --
 * reuse the same shape so operators see one cache footprint per
 * agent family.
 */
export function makeDiskContentCache(opts: DiskContentCacheOpts): ContentCache {
	const dir          = opts.dir;
	const maxEntries   = opts.maxEntries   ?? DEFAULT_MAX_ENTRIES;
	const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;

	const entryPath = (key: string): string => join(dir, `${key}.json`);

	return {
		async get(key: string): Promise<string | undefined> {
			const path = entryPath(key);
			let raw: string;
			try {
				raw = await fs.readFile(path, 'utf8');
			} catch {
				return undefined;
			}
			let parsed: { version?: number; body?: string };
			try {
				parsed = JSON.parse(raw) as { version?: number; body?: string };
			} catch (err) {
				log.warn({ key, err: (err as Error).message }, 'cache entry malformed; ignoring');
				return undefined;
			}
			if (parsed.version !== 1 || typeof parsed.body !== 'string') {
				return undefined;
			}
			// Touch mtime on hit so LRU sees this as recent.
			const now = new Date();
			void fs.utimes(path, now, now).catch(() => { /* nothing */ });
			return parsed.body;
		},

		async put(key: string, value: string): Promise<void> {
			const entry = { version: 1, body: value, writtenAt: new Date().toISOString() };
			const serialized = JSON.stringify(entry);
			if (serialized.length > maxEntryBytes) {
				log.warn({ key, size: serialized.length, cap: maxEntryBytes }, 'cache entry exceeds size cap; skipping write');
				return;
			}
			try {
				await fs.mkdir(dir, { recursive: true });
				const path = entryPath(key);
				const tmp = `${path}.tmp`;
				await fs.writeFile(tmp, serialized, 'utf8');
				await fs.rename(tmp, path);
			} catch (err) {
				log.warn({ key, err: (err as Error).message }, 'cache write failed (non-fatal)');
				return;
			}
			void evictLruIfNeeded(dir, maxEntries).catch(err => {
				log.warn({ err: (err as Error).message }, 'cache LRU eviction failed (non-fatal)');
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Key derivation helpers
// ---------------------------------------------------------------------------

export interface SectionCacheKeyInput {
	readonly outlineTitle: string;
	readonly section: SectionPlan;
	/** Bodies of the sections this one depends on. Must be passed in
	 *  the same order as `section.dependsOn` for the hash to be
	 *  stable; helpers below use sorted-by-id order regardless. */
	readonly priorBodies: readonly { readonly id: string; readonly body: string }[];
	/**
	 * Caller-supplied context salt -- e.g. the repo's git HEAD SHA.
	 * Bumping this invalidates every cached entry for the run.
	 * Optional but strongly recommended.
	 */
	readonly cacheContext?: string | undefined;
}

/**
 * Compute the section cache key. Stable across orderings of
 * `priorBodies` (we sort by id).
 */
export function computeSectionCacheKey(input: SectionCacheKeyInput): string {
	const priorHash = hashPriorBodies(input.priorBodies);
	const canonical = JSON.stringify({
		t: input.outlineTitle,
		i: input.section.id,
		n: input.section.intent,
		p: priorHash,
		c: input.cacheContext ?? '',
	});
	return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Hash the dependsOn bodies into a single stable digest. Sorting
 * by id keeps the hash invariant under prior-body order.
 */
export function hashPriorBodies(
	priorBodies: readonly { readonly id: string; readonly body: string }[],
): string {
	if (priorBodies.length === 0) {
		return '';
	}
	const sorted = [...priorBodies].sort((a, b) => a.id.localeCompare(b.id));
	const hash = createHash('sha256');
	for (const entry of sorted) {
		hash.update(entry.id).update('\0').update(entry.body).update('\0');
	}
	return hash.digest('hex');
}

/**
 * Convenience -- given a section's `dependsOn` plus the runtime
 * `prior` map (`Map<id, SectionResult>`), produce the prior-bodies
 * array `computeSectionCacheKey` expects. Skips deps that aren't
 * in the map (the runner already detects unresolved deps and
 * surfaces a warning; missing-dep here just means "treat as no
 * prior body").
 */
export function priorBodiesFromMap(
	dependsOn: readonly string[] | undefined,
	prior: ReadonlyMap<string, SectionResult>,
): { readonly id: string; readonly body: string }[] {
	if (dependsOn === undefined || dependsOn.length === 0) {
		return [];
	}
	const out: { id: string; body: string }[] = [];
	for (const id of dependsOn) {
		const r = prior.get(id);
		if (r === undefined) {
			continue;
		}
		out.push({ id, body: r.body });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Disk-cache LRU eviction
// ---------------------------------------------------------------------------

async function evictLruIfNeeded(dir: string, maxEntries: number): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return;
	}
	const jsonEntries = entries.filter(n => n.endsWith('.json'));
	if (jsonEntries.length <= maxEntries) {
		return;
	}
	const stats: Array<{ name: string; mtimeMs: number }> = [];
	for (const name of jsonEntries) {
		try {
			const s = await fs.stat(join(dir, name));
			stats.push({ name, mtimeMs: s.mtimeMs });
		} catch {
			// stat failure: ignore.
		}
	}
	stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
	const toRemove = stats.slice(0, stats.length - maxEntries);
	for (const { name } of toRemove) {
		try {
			await fs.unlink(join(dir, name));
		} catch {
			// best-effort
		}
	}
	log.info({ dir, evicted: toRemove.length, kept: stats.length - toRemove.length }, 'cache LRU sweep complete');
}
