/**
 * `provider:code-kg` -- P4.4 of plans/skills/substrate-implementation-status.md.
 *
 * Day-one context provider per substrate doc §D5a. Exposes the
 * LMDB-backed code knowledge graph as queryable context.
 *
 * Query semantics:
 *   - byKey('<name>')              entity lookup by name across the closure;
 *                                   returns one entry per match (capped at
 *                                   the slot's `limit`).
 *   - prefix('<name-prefix>')      not supported at the LMDB API level for
 *                                   substring scans; we emit an empty result
 *                                   and a debug log so consumers fall back to
 *                                   byKey or a tool. (The graph's name index
 *                                   is exact-match; adding a prefix-scan API
 *                                   to db/entities is its own scope.)
 *   - filter(predicate)             not supported -- the graph has no whole-
 *                                   entity walk by design (millions of rows).
 *                                   Consumers should byKey + filter
 *                                   client-side.
 *   - byEmbedding                   defer to the entity-vec ANN path (P2+
 *                                   already lands a substrate-vec table for
 *                                   memory; code-kg vector search is its own
 *                                   helper, not surfaced through this
 *                                   provider yet).
 *
 * Scoping: the provider needs the session's `closureRepos` to scope
 * name lookups. The assembler passes the session via `ProviderDeps`;
 * absent or non-Session shapes degrade gracefully to no results.
 *
 * Entry shape:
 *   - key       = entity name (slot.query.byKey input)
 *   - value     = the Entity row from db/entities (id, kind, file,
 *                 startLine, body, etc.)
 *   - kind      = 'fact' -- derived from indexed code, recomputable
 *   - confidence = 1.0
 *   - writtenAt = Date.now() (entity row carries `indexedAt`; mapping
 *                 to unix-ms is best-effort)
 *
 * Why this provider exists:
 *   Skills like `code.class.extract-fields` currently call the
 *   `code_class_locate` tool then resolve to fields. Routing that
 *   first hop through `provider:code-kg` lets the context-slot
 *   declaration speak the substrate's language without changing the
 *   tool. The skill body keeps the tool calls; the provider is an
 *   additional read path for contexts that want the entity ahead of
 *   the execute() body.
 */

import { getLogger } from '../../../shared/logger.js';
import { getDb } from '../../../db/client.js';
import { findEntitiesByName } from '../../../db/entities.js';

import type {
	ContextProvider,
	ContextQuery,
	ContextSlotRequest,
	MemoryEntry,
	ProviderDeps,
} from '../types.js';

const log = getLogger('substrate:provider:code-kg');

// ---------------------------------------------------------------------------

export const CODE_KG_PROVIDER_ID = 'code-kg';

export function createCodeKgProvider(): ContextProvider {
	return {
		id:            CODE_KG_PROVIDER_ID,
		schemaVersion: 1,
		async read(slot: ContextSlotRequest, deps: ProviderDeps): Promise<readonly MemoryEntry<unknown>[]> {
			const query: ContextQuery = typeof slot.query === 'function'
				? slot.query({ owner: slot.fromOwner } as Parameters<typeof slot.query>[0])
				: slot.query;

			// Only byKey is meaningful against the graph's exact-match
			// name index. Everything else returns empty + logs.
			if (query.kind !== 'byKey') {
				log.debug(
					{ slot: slot.name, queryKind: query.kind },
					'code-kg: only byKey is supported -- empty',
				);
				return [];
			}

			const closureRepos = extractClosureRepos(deps.session);
			if (closureRepos.length === 0) {
				log.debug({ slot: slot.name }, 'code-kg: empty closure -- no scope to query');
				return [];
			}

			const db = await getDb();
			const limit = slot.limit ?? 10;
			const entities = await findEntitiesByName(db, [query.key], {
				repos: closureRepos,
				limit,
			});

			const writtenAt = Date.now();
			return entities.map(entity => ({
				key:        query.key,
				value:      entity,
				kind:       'fact' as const,
				source:     { kind: 'test' as const, note: 'unstamped-provider-entry' },
				confidence: 1.0,
				writtenAt,
			}));
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractClosureRepos(session: unknown): readonly string[] {
	if (session === undefined || session === null || typeof session !== 'object') {
		return [];
	}
	const obj = session as Record<string, unknown>;
	const closure = obj['closureRepos'];
	if (Array.isArray(closure)) {
		return closure.filter((s): s is string => typeof s === 'string');
	}
	// Fallback: derive a singleton closure from repoPath.
	const repoPath = obj['repoPath'];
	if (typeof repoPath === 'string') {
		return [repoPath];
	}
	return [];
}
