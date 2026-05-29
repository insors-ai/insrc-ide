/**
 * Substrate indexer -- P2.2 of plans/skills/substrate-implementation-status.md.
 *
 * Bridges the file-side memory store to the Lance vector index
 * (`substrate_vec`). Per substrate doc §"Indexing framework":
 *
 *   - Files-as-canonical: the Lance row is a derived accelerator. A
 *     missing / stale Lance row is fine; a missing file is the source
 *     of truth that the row was deleted or never written.
 *   - Per-namespace policy drives whether to embed at all and what
 *     text to feed the embedder.
 *   - Best-effort fire-and-forget: failures are logged and swallowed
 *     so a flaky embedder never breaks a memory write. The user's
 *     stated constraint -- this is embedded into an IDE, not enterprise
 *     grade reliability.
 *
 * P2 deltas from the substrate doc:
 *   - Single embedder per substrate runtime; per-owner embedders are a
 *     future refinement.
 *   - `on-flag` policy is treated as `never` until a caller-flag
 *     mechanism is introduced (D11 hasn't required it yet).
 *
 * Index text resolution:
 *   - 'never'   : skip (no embed call).
 *   - 'always'  : JSON-stringify the entry value.
 *   - 'on-flag' : skip (deferred -- see above).
 *   - 'derived' : call policy.from(entry) and embed the returned text.
 */

import { getLogger } from '../../shared/logger.js';

import {
	deleteSubstrateVecRow,
	deleteSubstrateVecsForNamespace,
	searchSubstrateVec,
	substrateVecId,
	writeSubstrateVecRow,
} from './substrate-vec.js';

import type {
	AnnOpts,
	Embedder,
	IndexingPolicy,
	Indexer,
	MemoryEntry,
	MemoryStore,
	NamespaceSpec,
	OwnerId,
} from './types.js';
import { schemaKeyFor } from './distill.js';

const log = getLogger('substrate:indexer');

// ---------------------------------------------------------------------------

export interface CreateIndexerOpts {
	readonly workspaceId: string;
	readonly embedder:    Embedder;
	/**
	 * (owner::namespace) -> NamespaceSpec. The runtime's live schemas
	 * map; the indexer reads it at write time so newly-registered skills
	 * become indexable without needing to rebuild the indexer.
	 */
	readonly schemas:     ReadonlyMap<string, NamespaceSpec>;
	/**
	 * Hook the indexer back into the file-side memory store to read
	 * search hits. The indexer doesn't hold the store directly to avoid
	 * a circular dep with the wrapper; the runtime injects this.
	 */
	readonly memory:      MemoryStore;
}

export function createSubstrateIndexer(opts: CreateIndexerOpts): Indexer {
	return {
		async onPut<T>(owner: OwnerId, namespace: string, entry: MemoryEntry<T>): Promise<void> {
			const spec = opts.schemas.get(schemaKeyFor(owner, namespace));
			if (spec === undefined) { return; }

			const text = textForIndexing(spec.indexing, entry as MemoryEntry<unknown>);
			if (text === undefined) { return; }

			try {
				const embedding = await opts.embedder.embed(text);
				if (embedding.length === 0) {
					log.warn({ owner, namespace, key: entry.key }, 'indexer:embed returned empty -- skip');
					return;
				}
				await writeSubstrateVecRow({
					id:              substrateVecId(opts.workspaceId, owner, namespace, entry.key),
					embedding,
					workspace_id:    opts.workspaceId,
					owner,
					namespace,
					key:             entry.key,
					kind:            entry.kind,
					confidence_x100: Math.round(entry.confidence * 100),
					written_at:      entry.writtenAt,
					expires_at:      entry.expiresAt ?? 0,
				});
			} catch (err) {
				log.warn({ owner, namespace, key: entry.key, err: (err as Error).message }, 'indexer:onPut failed -- swallow');
			}
		},

		async onDelete(owner: OwnerId, namespace: string, key: string): Promise<void> {
			try {
				await deleteSubstrateVecRow(substrateVecId(opts.workspaceId, owner, namespace, key));
			} catch (err) {
				log.warn({ owner, namespace, key, err: (err as Error).message }, 'indexer:onDelete failed -- swallow');
			}
		},

		async search<T>(
			owner: OwnerId,
			namespace: string,
			queryEmbedding: Float32Array,
			annOpts: AnnOpts,
		): Promise<readonly MemoryEntry<T>[]> {
			const hits = await searchSubstrateVec(queryEmbedding, opts.workspaceId, owner, namespace, {
				topK:           annOpts.topK,
				...(annOpts.minSimilarity !== undefined ? { minSimilarity: annOpts.minSimilarity } : {}),
			});

			// Resolve each hit id -> file entry. Serial reads, per the
			// substrate's "no parallel LLM calls" rule (no LLM here, but
			// keeping the pattern simple). A vanished file just gets
			// skipped -- canonical truth lives on disk.
			const ns = opts.memory.scope(owner, namespace);
			const out: MemoryEntry<T>[] = [];
			for (const hit of hits) {
				const entry = await ns.get<T>(hit.key);
				if (entry === undefined) { continue; }
				out.push(entry);
			}
			return out;
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textForIndexing(policy: IndexingPolicy, entry: MemoryEntry<unknown>): string | undefined {
	switch (policy.kind) {
		case 'never':   return undefined;
		case 'on-flag': return undefined;
		case 'always':  return safeStringify(entry.value);
		case 'derived': return policy.from(entry);
	}
}

function safeStringify(value: unknown): string {
	try { return JSON.stringify(value); }
	catch { return String(value); }
}

// ---------------------------------------------------------------------------
// Re-exports for the runtime wrapper + tests
// ---------------------------------------------------------------------------

export { deleteSubstrateVecsForNamespace };
