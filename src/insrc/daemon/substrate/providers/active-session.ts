/**
 * `provider:active-session` -- P4.5 of plans/skills/substrate-implementation-status.md.
 *
 * Day-one context provider per substrate doc §D5a. Exposes the live
 * Session object as queryable context.
 *
 * Session is duck-typed here -- we deliberately don't import the
 * Session class type to avoid coupling the substrate to the agent
 * layer. The provider reads a curated set of fields:
 *
 *   - 'id'              -- session id (string)
 *   - 'repoPath'        -- active repo (string)
 *   - 'closureRepos'    -- list of repos in scope (string[])
 *   - 'turnIndex'       -- current turn count (number)
 *   - 'startedAt'       -- unix ms (number)
 *   - 'permissionMode'  -- 'validate' | 'auto-accept'
 *   - 'intent'          -- intent tag if attached
 *
 * Unknown fields return undefined (i.e. empty result), keeping the
 * provider tolerant to session-shape evolution.
 *
 * Why a curated whitelist? Two reasons:
 *   1. The Session object has many internal fields (provider handles,
 *      cost trackers, audit logs) that shouldn't flow into context.
 *      The whitelist is the substrate's privacy boundary.
 *   2. byKey('x') / prefix('x') stay deterministic across Session
 *      shape changes -- a field added to Session won't accidentally
 *      become public context.
 *
 * Query semantics:
 *   - byKey   -- single field lookup; missing field returns [].
 *   - prefix  -- field-name prefix; returns one entry per match.
 *   - filter  -- walks the whitelisted fields.
 *   - byEmbedding -- empty (small fixed surface).
 */

import { getLogger } from '../../../shared/logger.js';

import type {
	ContextProvider,
	ContextQuery,
	ContextSlotRequest,
	EntryPredicate,
	MemoryEntry,
	ProviderDeps,
} from '../types.js';

const log = getLogger('substrate:provider:active-session');

// ---------------------------------------------------------------------------

export const ACTIVE_SESSION_PROVIDER_ID = 'active-session';

const EXPOSED_FIELDS = [
	'id',
	'repoPath',
	'closureRepos',
	'turnIndex',
	'startedAt',
	'permissionMode',
	'intent',
] as const;

type ExposedField = (typeof EXPOSED_FIELDS)[number];

export function createActiveSessionProvider(): ContextProvider {
	return {
		id:            ACTIVE_SESSION_PROVIDER_ID,
		schemaVersion: 1,
		async read(slot: ContextSlotRequest, deps: ProviderDeps): Promise<readonly MemoryEntry<unknown>[]> {
			const session = deps.session;
			if (session === undefined || session === null || typeof session !== 'object') {
				log.debug({ slot: slot.name }, 'active-session: no session in deps -- empty');
				return [];
			}

			const writtenAt = Date.now();
			const query: ContextQuery = typeof slot.query === 'function'
				? slot.query({ owner: slot.fromOwner } as Parameters<typeof slot.query>[0])
				: slot.query;

			switch (query.kind) {
				case 'byKey': {
					if (!isExposed(query.key)) { return []; }
					const v = (session as Record<string, unknown>)[query.key];
					if (v === undefined) { return []; }
					return [buildEntry(query.key, v, writtenAt)];
				}
				case 'prefix': {
					return EXPOSED_FIELDS
						.filter(f => f.startsWith(query.prefix))
						.map(f => [f, (session as Record<string, unknown>)[f]] as const)
						.filter(([, v]) => v !== undefined)
						.map(([f, v]) => buildEntry(f, v, writtenAt));
				}
				case 'filter': {
					return EXPOSED_FIELDS
						.map(f => [f, (session as Record<string, unknown>)[f]] as const)
						.filter(([, v]) => v !== undefined)
						.map(([f, v]) => buildEntry(f, v, writtenAt))
						.filter((e: MemoryEntry<unknown>) => (query.predicate as EntryPredicate)(e));
				}
				case 'byEmbedding': {
					return [];
				}
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExposed(key: string): key is ExposedField {
	return (EXPOSED_FIELDS as readonly string[]).includes(key);
}

function buildEntry(key: string, value: unknown, writtenAt: number): MemoryEntry<unknown> {
	return {
		key,
		value,
		// Active session state is authoritative for the lifetime of the
		// session -- consumers should treat it as a constraint.
		kind:       'constraint',
		source:     { kind: 'test', note: 'unstamped-provider-entry' },
		confidence: 1.0,
		writtenAt,
	};
}
