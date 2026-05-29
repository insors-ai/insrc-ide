/**
 * `provider:user-config` -- P4.3 of plans/skills/substrate-implementation-status.md.
 *
 * Day-one context provider per substrate doc §D5a. Exposes the
 * on-disk AgentConfig (`~/.insrc/config.json`) as queryable context.
 *
 * Query semantics:
 *   - byKey('models.activeProvider')       returns one entry, key=path, value=resolved
 *   - prefix('models.providers.local.')    returns every leaf under that path
 *   - filter(predicate)                     returns all leaves matching the predicate
 *   - byEmbedding                           empty (config is small + structured;
 *                                            ANN is the wrong tool)
 *
 * Path resolution is dot-segmented. A path may resolve to a primitive
 * (string / number / boolean / null) or to a sub-object; both shapes
 * are returned as the entry's `value`. Consumers byKey('models')
 * therefore get the whole models sub-tree as a single entry.
 *
 * Entry tagging:
 *   - kind:       'constraint' -- user-set config is authoritative.
 *   - confidence: 1.0
 *   - writtenAt:  file mtime (best-effort) so consumers can detect
 *                 changes across calls.
 *   - source:     filled by the provider-registry stamper.
 *
 * Read freshness: this provider re-reads the config on every call.
 * AgentConfig parsing is cheap and config edits are infrequent, so
 * caching adds complexity without a measurable win. If a slow path
 * shows up, add an mtime-keyed cache here.
 */

import { existsSync, statSync } from 'node:fs';

import { loadConfig } from '../../../agent/config.js';
import { PATHS } from '../../../shared/paths.js';

import type {
	ContextProvider,
	ContextQuery,
	ContextSlotRequest,
	EntryPredicate,
	MemoryEntry,
} from '../types.js';

// ---------------------------------------------------------------------------

export const USER_CONFIG_PROVIDER_ID = 'user-config';

export function createUserConfigProvider(): ContextProvider {
	return {
		id:            USER_CONFIG_PROVIDER_ID,
		schemaVersion: 1,
		async read(slot: ContextSlotRequest): Promise<readonly MemoryEntry<unknown>[]> {
			const config   = loadConfig() as unknown;
			const writtenAt = configMtime();
			const query: ContextQuery = typeof slot.query === 'function'
				? slot.query({ owner: slot.fromOwner } as Parameters<typeof slot.query>[0])
				: slot.query;

			switch (query.kind) {
				case 'byKey': {
					const v = resolvePath(config, query.key);
					if (v === undefined) { return []; }
					return [buildEntry(query.key, v, writtenAt)];
				}
				case 'prefix': {
					return walkLeaves(config, '').filter(([k]) => k.startsWith(query.prefix))
						.map(([k, v]) => buildEntry(k, v, writtenAt));
				}
				case 'filter': {
					return walkLeaves(config, '')
						.map(([k, v]) => buildEntry(k, v, writtenAt))
						.filter((e: MemoryEntry<unknown>) => (query.predicate as EntryPredicate)(e));
				}
				case 'byEmbedding': {
					// Config is small + structured; ANN is the wrong tool.
					return [];
				}
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEntry(key: string, value: unknown, writtenAt: number): MemoryEntry<unknown> {
	return {
		key,
		value,
		kind:       'constraint',
		// Stamped by the provider-registry; placeholder shape here.
		source:     { kind: 'test', note: 'unstamped-provider-entry' },
		confidence: 1.0,
		writtenAt,
	};
}

function configMtime(): number {
	try {
		if (!existsSync(PATHS.config)) { return 0; }
		return statSync(PATHS.config).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Dot-path lookup. Supports nested object traversal; array indexing via
 * numeric segments (e.g. 'workspaces.0.path'). Returns `undefined` if
 * any segment is missing.
 */
function resolvePath(root: unknown, path: string): unknown {
	if (path === '') { return root; }
	const segments = path.split('.');
	let cur: unknown = root;
	for (const seg of segments) {
		if (cur === null || cur === undefined) { return undefined; }
		if (typeof cur !== 'object') { return undefined; }
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

/**
 * Flatten an object into [dotPath, value] leaves. Arrays + primitives
 * stop recursion (the whole array / primitive is the leaf value).
 * Plain objects recurse. Empty objects emit a single [path, {}] leaf
 * so prefix scans can still detect them.
 */
function walkLeaves(root: unknown, prefix: string): [string, unknown][] {
	if (root === null || typeof root !== 'object' || Array.isArray(root)) {
		return prefix === '' ? [] : [[prefix, root]];
	}
	const obj = root as Record<string, unknown>;
	const keys = Object.keys(obj);
	if (keys.length === 0) {
		return prefix === '' ? [] : [[prefix, root]];
	}
	const out: [string, unknown][] = [];
	for (const k of keys) {
		const childPath = prefix === '' ? k : `${prefix}.${k}`;
		out.push(...walkLeaves(obj[k], childPath));
	}
	return out;
}
