/**
 * Distillation engine -- P1.3 of plans/skills/substrate-implementation-status.md.
 *
 * On successful skill return, the substrate distills pinned working-
 * state entries into memory per D3's autoDistill policy.
 *
 * Per-namespace policy (declared in the skill's memorySchema):
 *   - 'on-pin'             : default; only explicit `workingState.pin()` distills.
 *                            This engine consumes ledger.pins().
 *   - 'always-on-success'  : reserved for entries the skill writes intending to
 *                            distill but where the autoDistill machinery promotes
 *                            them without an explicit pin. P1 routes them the
 *                            same as 'on-pin' (pins are still required); the
 *                            difference becomes visible when consumers learn to
 *                            emit auto-distill metadata in P3+.
 *   - 'never'              : namespace is read-only from working state; this
 *                            engine refuses to distill into it.
 *
 * On failed (thrown) skill execution, this engine does nothing --
 * pinned entries are discarded with the working state per substrate
 * doc §"Working state ledger".
 */

import { getLogger } from '../../shared/logger.js';

import type {
	AutoDistillMode,
	MemoryStore,
	NamespaceSpec,
	OwnerId,
	WorkingStateLedger,
	WriteMeta,
} from './types.js';

const log = getLogger('substrate:distill');

// ---------------------------------------------------------------------------

export interface DistillEngine {
	/**
	 * Apply the policy: walk the ledger's pins, for each pin look up the
	 * target namespace's autoDistill mode, write into memory if eligible.
	 *
	 * Returns a DistillReport summarising what was promoted vs skipped.
	 */
	distill(opts: DistillOpts): Promise<DistillReport>;
}

export interface DistillOpts {
	readonly workingState: WorkingStateLedger;
	/**
	 * Map of (owner, namespace) -> NamespaceSpec for every namespace
	 * the skill declared in its memorySchema. The runtime builds this
	 * at skill registration and passes it to the engine on each
	 * execution.
	 */
	readonly schemas: ReadonlyMap<string, NamespaceSpec>;
	/** Optional cancellation. */
	readonly signal?: AbortSignal;
}

export interface DistillReport {
	readonly considered: number;
	readonly written:    number;
	readonly skipped:    readonly { readonly ref: string; readonly reason: string }[];
}

export interface CreateDistillEngineOpts {
	readonly memory: MemoryStore;
}

export function createDistillEngine(opts: CreateDistillEngineOpts): DistillEngine {
	return {
		async distill(distillOpts: DistillOpts): Promise<DistillReport> {
			const pins = distillOpts.workingState.pins();
			const skipped: { ref: string; reason: string }[] = [];
			let written = 0;

			for (const { ref, target } of pins) {
				if (distillOpts.signal?.aborted) { break; }

				const schemaKey = schemaKeyFor(target.owner, target.namespace);
				const spec = distillOpts.schemas.get(schemaKey);

				if (spec === undefined) {
					skipped.push({ ref, reason: `no schema for ${schemaKey}` });
					continue;
				}

				if (!eligibleForDistillation(spec.autoDistill)) {
					skipped.push({ ref, reason: `policy '${spec.autoDistill}' rejects distillation` });
					continue;
				}

				const entry = distillOpts.workingState.get(ref);
				if (entry === undefined) {
					skipped.push({ ref, reason: 'ledger entry vanished' });
					continue;
				}

				const meta: WriteMeta = {
					kind:       target.kind,
					source:     {
						kind:         'observation',
						ledgerRef:    ref,
						executionRef: 'exec-distill',  // P1 lacks a real execution id; lands in P4+
						tier:         'pattern',
					},
					confidence: entry.confidence,
					...(target.ttlMs !== undefined ? { ttlMs: target.ttlMs } : {}),
				};

				try {
					await opts.memory.scope(target.owner, target.namespace).put(target.key, entry.payload, meta);
					written++;
					log.debug({ ref, owner: target.owner, namespace: target.namespace, key: target.key }, 'distill:write');
				} catch (err) {
					skipped.push({ ref, reason: `write failed: ${(err as Error).message}` });
				}
			}

			return { considered: pins.length, written, skipped };
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function schemaKeyFor(owner: OwnerId, namespace: string): string {
	return `${owner}::${namespace}`;
}

function eligibleForDistillation(mode: AutoDistillMode): boolean {
	switch (mode) {
		case 'on-pin':
		case 'always-on-success':
			return true;
		case 'never':
			return false;
	}
}
