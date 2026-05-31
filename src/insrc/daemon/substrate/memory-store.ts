/**
 * File-backed memory store -- P0.1 of plans/skills/substrate-implementation-status.md.
 *
 * Per substrate doc §"Storage substrate": files are canonical, no row
 * store. Each memory entry is a JSON file under
 *   <root>/<workspace-id>/<owner-id>/<namespace>/<key>.json
 *
 * P0 deltas from the eventual substrate design:
 *   - Files are NOT sharded yet (deferred until a namespace approaches
 *     ~10k entries; tracked in substrate-implementation-status.md decision
 *     departures table).
 *   - `byEmbedding` queries return empty (Lance index lands in P2).
 *   - Conflict resolution applies the D4 default policy only -- no
 *     per-namespace merge override.
 *   - No supersession sweeping; superseded entries stay on disk and are
 *     filtered out by query helpers (D7).
 *
 * Atomicity: writes use the POSIX temp+rename pattern -- readers see
 * either the old or the new version, never partial.
 *
 * Key sanitization: keys may contain any character but `/` and `..`.
 * The store URL-encodes the key for the on-disk filename so e.g.
 * `connectionA:User` becomes `connectionA%3AUser.json`. This keeps the
 * 1:1 key <-> file mapping simple while supporting arbitrary keys.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { getLogger } from '../../shared/logger.js';

import type {
	AnnOpts,
	EntryKind,
	EntryPredicate,
	EntrySource,
	MemoryEntry,
	MemoryEntryRef,
	MemoryNamespace,
	MemoryStore,
	OwnerId,
	ScanOpts,
	WriteMeta,
} from './types.js';

const log = getLogger('substrate:memory-store');

// ---------------------------------------------------------------------------
// On-disk shape -- mirrors the substrate doc's JSON entry format
// ---------------------------------------------------------------------------

interface OnDiskMeta {
	readonly kind:           EntryKind;
	readonly source:         EntrySource;
	readonly confidence:     number;
	readonly writtenAt:      number;
	readonly expiresAt?:     number;
	readonly supersedes?:    readonly MemoryEntryRef[];
	readonly supersededBy?:  MemoryEntryRef;
	/**
	 * Original key. Recorded so a directory scan can recover the key
	 * even when the filename is the sha256-prefixed form (used for
	 * keys whose URL-encoded length exceeds the POSIX 255-byte limit).
	 */
	readonly key?:           string;
}

interface OnDiskEntry<T = unknown> {
	readonly _meta: OnDiskMeta;
	readonly value: T;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateMemoryStoreOpts {
	/** Workspace root directory under the substrate's data root. */
	readonly workspaceId: string;
	/**
	 * Substrate data root. In production this is `~/.insrc/context/`;
	 * tests pass a per-test temp dir.
	 */
	readonly rootDir:     string;
}

/**
 * Create a new MemoryStore rooted at `<rootDir>/<workspaceId>/`.
 * Multiple stores against the same root are safe; each scope() returns
 * a fresh MemoryNamespace per call.
 */
export function createMemoryStore(opts: CreateMemoryStoreOpts): MemoryStore {
	const workspaceRoot = join(opts.rootDir, opts.workspaceId);

	return {
		scope(owner: OwnerId, namespace: string): MemoryNamespace {
			const nsDir = join(workspaceRoot, owner, namespace);
			return createMemoryNamespace(nsDir);
		},
	};
}

// ---------------------------------------------------------------------------
// MemoryNamespace impl
// ---------------------------------------------------------------------------

function createMemoryNamespace(nsDir: string): MemoryNamespace {
	return {
		async get<T>(key: string): Promise<MemoryEntry<T> | undefined> {
			const path = entryPath(nsDir, key);
			try {
				const raw = await fs.readFile(path, 'utf8');
				const parsed = JSON.parse(raw) as OnDiskEntry<T>;
				if (isExpired(parsed._meta)) { return undefined; }
				return hydrate<T>(key, path, parsed);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
				throw err;
			}
		},

		async put<T>(key: string, value: T, meta: WriteMeta): Promise<MemoryEntryRef> {
			const path = entryPath(nsDir, key);
			await fs.mkdir(dirname(path), { recursive: true });

			const prior = await safeRead<T>(path);
			const next = applyMergePolicy<T>(prior, value, meta);
			const onDisk: OnDiskEntry<T> = {
				_meta: stripUndefined({
					kind:         next.kind,
					source:       next.source,
					confidence:   next.confidence,
					writtenAt:    next.writtenAt,
					expiresAt:    next.expiresAt,
					supersedes:   next.supersedes,
					// Record the key so directory scans can recover it even
					// when the filename is hash-encoded.
					key,
				}) as unknown as OnDiskMeta,
				value: next.value,
			};

			// Atomic temp+rename. Same dir so rename is atomic on the same FS.
			const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
			await fs.writeFile(tmp, JSON.stringify(onDisk, null, 2), 'utf8');
			await fs.rename(tmp, path);

			log.debug({ path, kind: next.kind, conf: next.confidence }, 'memory:write');
			return path;
		},

		async delete(key: string): Promise<void> {
			const path = entryPath(nsDir, key);
			try { await fs.unlink(path); }
			catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return; }
				throw err;
			}
		},

		scan<T>(prefix: string, opts?: ScanOpts): AsyncIterable<MemoryEntry<T>> {
			return walkNamespace<T>(nsDir, (entry) => entry.key.startsWith(prefix), opts);
		},

		filter<T>(predicate: EntryPredicate, opts?: ScanOpts): AsyncIterable<MemoryEntry<T>> {
			return walkNamespace<T>(nsDir, predicate as (e: MemoryEntry<T>) => boolean, opts);
		},

		async searchByEmbedding<T>(_queryEmbedding: Float32Array, _opts: AnnOpts): Promise<readonly MemoryEntry<T>[]> {
			// P2: Lance integration. For P0+P1 we return empty so callers
			// that opportunistically use this query mode degrade gracefully.
			return [];
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * macOS / Linux POSIX filename limit is 255 bytes. We leave headroom for
 * the temp-file suffix (`.tmp.<pid>.<ts>` = up to ~22 bytes) so atomic
 * writes don't trip ENAMETOOLONG on the rename target. The 200-byte
 * threshold below targets the *encoded* filename including `.json`.
 */
const MAX_ENCODED_FILENAME_BYTES = 200;

/** Prefix marker for hash-encoded long-key files. */
const HASHED_KEY_PREFIX = '__h_';

/**
 * Map a key to its file path. Short keys use the URL-encoded form so the
 * filename is human-readable + reverse-mappable. Long keys (would exceed
 * the POSIX 255-byte limit) fall back to a sha256-prefixed filename;
 * the real key is recovered from the file's `_meta.key` field.
 */
function entryPath(nsDir: string, key: string): string {
	if (key.includes('..')) { throw new Error(`memory-store: invalid key '${key}' (contains '..')`); }
	const encoded = encodeURIComponent(key);
	const filename = (encoded.length + 5 /* .json */) > MAX_ENCODED_FILENAME_BYTES
		? `${HASHED_KEY_PREFIX}${sha256Hex(key)}.json`
		: `${encoded}.json`;
	return join(nsDir, filename);
}

/**
 * Reverse `entryPath` when scanning a directory. Returns `undefined`
 * for hash-encoded filenames -- the caller (`walkNamespace`) recovers
 * the real key from the file's `_meta.key` after reading.
 */
function fileToKey(file: string): string | undefined {
	if (!file.endsWith('.json')) { return undefined; }
	if (file.startsWith(HASHED_KEY_PREFIX)) { return undefined; }
	return decodeURIComponent(file.slice(0, -5));
}

function sha256Hex(s: string): string {
	return createHash('sha256').update(s).digest('hex');
}

function isExpired(meta: OnDiskMeta): boolean {
	return meta.expiresAt !== undefined && meta.expiresAt <= Date.now();
}

function hydrate<T>(key: string, path: string, parsed: OnDiskEntry<T>): MemoryEntry<T> {
	return stripUndefined({
		key,
		value:        parsed.value,
		kind:         parsed._meta.kind,
		source:       parsed._meta.source,
		confidence:   parsed._meta.confidence,
		writtenAt:    parsed._meta.writtenAt,
		expiresAt:    parsed._meta.expiresAt,
		supersedes:   parsed._meta.supersedes,
		supersededBy: parsed._meta.supersededBy,
		// Path-as-ref for the substrate's internal tracking.
		_ref:         path,
	}) as MemoryEntry<T>;
}

async function safeRead<T>(path: string): Promise<MemoryEntry<T> | undefined> {
	try {
		const raw = await fs.readFile(path, 'utf8');
		const parsed = JSON.parse(raw) as OnDiskEntry<T>;
		return hydrate<T>('', path, parsed);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
		throw err;
	}
}

/**
 * D4 default conflict resolution:
 *   1. trichotomy: constraint > fact > hint
 *   2. confidence: higher wins
 *   3. recency: more recent writtenAt wins
 *   4. tie: existing entry kept
 *
 * For P0 we apply this as a read-before-write check on `put`.
 */
function applyMergePolicy<T>(
	prior: MemoryEntry<T> | undefined,
	value: T,
	meta: WriteMeta,
): {
	value: T;
	kind: EntryKind;
	source: EntrySource;
	confidence: number;
	writtenAt: number;
	expiresAt?: number | undefined;
	supersedes?: readonly MemoryEntryRef[] | undefined;
} {
	const writtenAt = Date.now();
	const expiresAt = meta.ttlMs !== undefined ? writtenAt + meta.ttlMs : undefined;
	const incoming = {
		value,
		kind:       meta.kind,
		source:     meta.source,
		confidence: meta.confidence,
		writtenAt,
		expiresAt,
		supersedes: meta.supersedes,
	};

	if (prior === undefined) { return incoming; }

	// Kind precedence.
	const priorRank = kindRank(prior.kind);
	const nextRank  = kindRank(meta.kind);
	if (nextRank > priorRank) { return incoming; }
	if (nextRank < priorRank) { return packPrior(prior); }

	// Confidence precedence.
	if (meta.confidence > prior.confidence) { return incoming; }
	if (meta.confidence < prior.confidence) { return packPrior(prior); }

	// Recency precedence.
	if (writtenAt > prior.writtenAt) { return incoming; }
	return packPrior(prior);
}

function kindRank(k: EntryKind): number {
	switch (k) {
		case 'constraint': return 3;
		case 'fact':       return 2;
		case 'hint':       return 1;
	}
}

function packPrior<T>(prior: MemoryEntry<T>) {
	return {
		value:      prior.value,
		kind:       prior.kind,
		source:     prior.source,
		confidence: prior.confidence,
		writtenAt:  prior.writtenAt,
		expiresAt:  prior.expiresAt,
		supersedes: prior.supersedes,
	};
}

/** Helper: omit undefined fields so we don't write `"expiresAt": undefined` etc. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) { out[k] = v; }
	}
	return out as Partial<T>;
}

/**
 * Directory walk shared by scan() and filter(). Yields non-expired,
 * non-superseded entries that pass the predicate. Insertion order is
 * file-system order; we don't currently sort.
 */
async function* walkNamespace<T>(
	nsDir: string,
	predicate: (entry: MemoryEntry<T>) => boolean,
	opts?: ScanOpts,
): AsyncIterable<MemoryEntry<T>> {
	let files: string[];
	try { files = await fs.readdir(nsDir); }
	catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return; }
		throw err;
	}

	files.sort((a, b) => opts?.ascending === false ? b.localeCompare(a) : a.localeCompare(b));

	let yielded = 0;
	const limit = opts?.limit ?? Infinity;
	const includeSuperseded = opts?.includeSuperseded === true;

	for (const file of files) {
		if (!file.endsWith('.json')) { continue; }
		const decodedKey = fileToKey(file);
		// `fileToKey` returns undefined for hash-encoded filenames; for
		// those we recover the original key from `_meta.key` after reading.
		const path = join(nsDir, file);

		let entry: MemoryEntry<T>;
		try {
			const raw = await fs.readFile(path, 'utf8');
			const parsed = JSON.parse(raw) as OnDiskEntry<T>;
			if (isExpired(parsed._meta)) { continue; }
			if (!includeSuperseded && parsed._meta.supersededBy !== undefined) { continue; }
			const key = decodedKey ?? parsed._meta.key;
			if (key === undefined) {
				log.warn({ path }, 'memory:walk skip-keyless-file');
				continue;
			}
			entry = hydrate<T>(key, path, parsed);
		} catch (err) {
			log.warn({ path, err: (err as Error).message }, 'memory:walk skip-bad-file');
			continue;
		}

		if (!predicate(entry)) { continue; }
		yield entry;
		yielded++;
		if (yielded >= limit) { return; }
	}
}
