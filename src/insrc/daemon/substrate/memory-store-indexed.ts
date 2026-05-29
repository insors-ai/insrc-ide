/**
 * Memory store wrapper that hooks the substrate indexer (P2.3) into
 * put / delete / searchByEmbedding on a base MemoryStore.
 *
 * Behavior:
 *   - put: delegate to base, then read back the freshly-merged entry
 *          (so the indexer sees what actually got written, including
 *          D4 conflict resolution decisions) and hand it to the indexer.
 *   - delete: delegate to base, then drop the Lance row.
 *   - searchByEmbedding: delegate to the indexer's `search()` (Lance
 *          query + file resolve). With no indexer this returns empty
 *          (the base store's P0 stub behavior).
 *
 * Errors are NOT propagated -- per substrate doc §"Indexing framework"
 * the file write is canonical and the index is a best-effort
 * accelerator. The indexer already logs + swallows internally; this
 * wrapper just trusts that contract.
 */

import { getLogger } from '../../shared/logger.js';

import type {
	AnnOpts,
	EntryPredicate,
	Indexer,
	MemoryEntry,
	MemoryEntryRef,
	MemoryNamespace,
	MemoryStore,
	OwnerId,
	ScanOpts,
	WriteMeta,
} from './types.js';

const log = getLogger('substrate:memory-indexed');

// ---------------------------------------------------------------------------

/**
 * Wrap a base MemoryStore so every put / delete also notifies the
 * indexer, and searchByEmbedding routes through the Lance index.
 */
export function withIndexer(base: MemoryStore, indexer: Indexer): MemoryStore {
	return {
		scope(owner: OwnerId, namespace: string): MemoryNamespace {
			const baseNs = base.scope(owner, namespace);
			return {
				async get<T>(key: string): Promise<MemoryEntry<T> | undefined> {
					return baseNs.get<T>(key);
				},

				async put<T>(key: string, value: T, meta: WriteMeta): Promise<MemoryEntryRef> {
					const ref = await baseNs.put(key, value, meta);
					// Read back what was actually written (D4 may have kept the
					// prior entry); index that.
					const written = await baseNs.get<T>(key);
					if (written !== undefined) {
						await indexer.onPut(owner, namespace, written);
					} else {
						log.debug({ owner, namespace, key }, 'memory-indexed:put -- entry vanished post-write');
					}
					return ref;
				},

				async delete(key: string): Promise<void> {
					await baseNs.delete(key);
					await indexer.onDelete(owner, namespace, key);
				},

				scan<T>(prefix: string, opts?: ScanOpts): AsyncIterable<MemoryEntry<T>> {
					return baseNs.scan<T>(prefix, opts);
				},

				filter<T>(predicate: EntryPredicate, opts?: ScanOpts): AsyncIterable<MemoryEntry<T>> {
					return baseNs.filter<T>(predicate, opts);
				},

				async searchByEmbedding<T>(queryEmbedding: Float32Array, opts: AnnOpts): Promise<readonly MemoryEntry<T>[]> {
					return indexer.search<T>(owner, namespace, queryEmbedding, opts);
				},
			};
		},
	};
}
