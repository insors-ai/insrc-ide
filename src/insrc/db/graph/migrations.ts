/**
 * Forward-migration runner for the LMDB graph env.
 *
 * Phase 7.2 of plans/storage-migration-lmdb-lance.md. Scaffolding +
 * empty registry. v1 is the first schema version, so there are no
 * registered migrations yet -- the file ships as a wired-up no-op
 * that activates the moment a v2 (or beyond) migration is added.
 *
 * Design:
 *
 *   - Each migration is `{ from, to, description, run(store) }`. The
 *     `run` body executes inside the calling write txn (callers
 *     control the txn boundary so a multi-step path runs in
 *     individual atomic steps, not one big txn that could blow the
 *     transaction-size limit).
 *
 *   - The runner walks `from -> ... -> target` by repeatedly picking
 *     a migration whose `from === current` (greedy; the registry is
 *     expected to define the canonical path). If the registry has
 *     parallel paths, the runner takes the one with the largest
 *     `to` (longest jump first).
 *
 *   - Each step advances `meta.schema_version` to its `to` BEFORE
 *     the next step runs. A crash mid-migration leaves the env at
 *     a coherent intermediate version; re-open replays remaining
 *     steps.
 *
 *   - Empty registry + stored == expected = no-op (the common path).
 *
 *   - Path-not-found throws `MigrationPathError`. Daemon boot
 *     surfaces this; user must restore from backup or accept
 *     data-loss reset.
 */

import { getLogger } from '../../shared/logger.js';
import {
	encodeEntityKey,
	encodeNameIndexKey,
	ENTITY_KIND_BYTE,
} from './keys.js';
import { decodeEntityRow } from './codec.js';
import type { GraphStore } from './store.js';

const log = getLogger('graph-migrations');

const META_SCHEMA_VERSION = 'schema_version';

export interface Migration {
	readonly from:        number;
	readonly to:          number;
	readonly description: string;
	run(store: GraphStore): Promise<void> | void;
}

export class MigrationPathError extends Error {
	constructor(stored: number, target: number, lastReached: number) {
		super(
			`No registered migration from schema_version=${lastReached} ` +
			`(starting at ${stored}, target ${target}). ` +
			`Restore from backup or wipe the env to re-index from source.`,
		);
		this.name = 'MigrationPathError';
	}
}

// (Migration registry constant defined further down, after the
// individual Migration values.)
/**
 * v1 → v2: backfill the derived indices that v1 didn't populate.
 *
 *   - `entity_string_by_u64` -- reverse of `entity_id_by_string`.
 *     v1 stored only the forward direction, forcing every reverse
 *     lookup to do a full cursor scan (O(N)). v2 maintains the
 *     mirror on every write; this migration walks the forward
 *     sub-DB once and seeds the reverse one.
 *
 *   - `name_index` -- (repoId, kindByte, name) → u64. Sub-DB
 *     existed in v1 but was never written to, so
 *     `findEntitiesByName` did a full `entity` table scan. This
 *     migration walks `entity` and seeds the index.
 *
 * Both writes are idempotent (re-running the migration would
 * overwrite the same key→value pairs). The migration runs inside
 * a single write txn -- safe at our table sizes (≤ a few million
 * rows; LMDB has no inherent txn-size cap, just the env mapsize).
 */
const MIGRATION_V1_TO_V2: Migration = {
	from: 1,
	to:   2,
	description: 'backfill entity_string_by_u64 + name_index from existing entity rows',
	async run(store: GraphStore): Promise<void> {
		// 1. Backfill the reverse u64→string index from the forward
		//    string→u64 sub-DB. Single cursor pass.
		let reverseSeeded = 0;
		for (const { key, value } of store.entityIdByString.getRange()) {
			const stringId = key as string;
			const v = value as bigint | number;
			const u64 = typeof v === 'bigint' ? v : BigInt(v);
			store.entityStringByU64.put(encodeEntityKey(u64), stringId);
			reverseSeeded++;
		}

		// 2. Backfill name_index from the entity table.
		let nameSeeded = 0;
		for (const { key, value } of store.entity.getRange()) {
			const u64 = (key as Buffer).readBigUInt64BE(0);
			const row = decodeEntityRow(value as Buffer);
			const kindByte = ENTITY_KIND_BYTE[row.kind];
			if (kindByte === undefined) continue;
			store.nameIndex.put(encodeNameIndexKey(row.repoId, kindByte, row.name), encodeEntityKey(u64));
			nameSeeded++;
		}

		log.info(
			{ reverseSeeded, nameSeeded },
			'v1->v2: derived-index backfill done',
		);
	},
};

/**
 * Production migration registry. Add new entries here as new
 * SCHEMA_VERSION bumps land; never edit or remove an
 * already-shipped entry.
 *
 * Convention: contiguous `from = N`, `to = N+1` per step. Multi-jump
 * migrations (e.g. 1→3 fast path) are allowed but should always have
 * a corresponding 1→2 + 2→3 chain so older clients can step through.
 */
export const MIGRATIONS: readonly Migration[] = [
	MIGRATION_V1_TO_V2,
];

/**
 * Apply registered migrations to advance `stored` → `target`. Each
 * step runs inside its own write txn (`store.root.transaction`) so a
 * multi-step path doesn't pile into one giant txn.
 *
 * Returns the count of migrations applied (0 when stored == target).
 *
 * `registry` defaults to `MIGRATIONS`; tests inject synthetic chains.
 */
export async function runMigrations(
	store:    GraphStore,
	stored:   number,
	target:   number,
	registry: readonly Migration[] = MIGRATIONS,
): Promise<number> {
	if (stored === target) return 0;
	if (stored > target) {
		throw new MigrationPathError(stored, target, stored);
	}

	let current = stored;
	let applied = 0;

	while (current < target) {
		const step = pickStep(registry, current, target);
		if (step === null) {
			throw new MigrationPathError(stored, target, current);
		}

		const t0 = Date.now();
		await store.root.transaction(async () => {
			await step.run(store);
			// Advance the version IN THE SAME TXN so a crash either
			// rolls everything (including the version write) back, or
			// commits everything atomically.
			await store.meta.put(META_SCHEMA_VERSION, step.to);
		});
		applied++;

		log.info(
			{
				from:        step.from,
				to:          step.to,
				description: step.description,
				elapsedMs:   Date.now() - t0,
			},
			'graph migration applied',
		);

		current = step.to;
	}

	return applied;
}

/**
 * Pick the next migration step from `current`, preferring the
 * largest jump that doesn't overshoot `target`. Returns null when no
 * applicable step exists.
 */
function pickStep(
	registry: readonly Migration[],
	current:  number,
	target:   number,
): Migration | null {
	let best: Migration | null = null;
	for (const m of registry) {
		if (m.from !== current) continue;
		if (m.to <= current)    continue; // never go backwards
		if (m.to > target)      continue; // don't overshoot
		if (best === null || m.to > best.to) best = m;
	}
	return best;
}
