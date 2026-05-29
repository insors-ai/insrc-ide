/**
 * In-process working-state ledger -- P0.2 of plans/skills/substrate-implementation-status.md.
 *
 * Per substrate doc §"Working state ledger": mutable, per-execution
 * scratch space owned by the running consumer. Distilled into memory
 * on successful return; discarded on crash.
 *
 * P0 implementation:
 *   - Array-backed, in-process. No crash-resume (D12 explicitly defers
 *     within-execution durability to the agent-framework checkpoint
 *     for long-running multi-turn agents -- separate concern).
 *   - Soft warn + hard cap enforced per D12.
 *   - Per-entry byte estimation via JSON.stringify length (rough but
 *     stable; precision tightens in later phases).
 *   - pins() returns the pinned-target list; the substrate's
 *     distillation engine (P1.3) consumes it on successful return.
 */

import { randomUUID } from 'node:crypto';

import type {
	DistillTarget,
	LedgerEntry,
	LedgerFilter,
	LedgerRef,
	WorkingStateCap,
	WorkingStateLedger,
} from './types.js';
import {
	DEFAULT_WORKING_STATE_HARD_CAP,
	DEFAULT_WORKING_STATE_SOFT_WARN,
	WorkingStateHardCapError,
} from './types.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateWorkingStateOpts {
	/**
	 * Per-skill override of the soft warn threshold. Substrate emits a
	 * `working-state:soft-warn` telemetry event on threshold crossing;
	 * skill body can also query `size()` and react.
	 */
	readonly softWarn?: WorkingStateCap;

	/**
	 * Per-skill override of the hard cap. `append()` throws
	 * WorkingStateHardCapError beyond this; the skill body must handle
	 * (typically by distilling + pinning what matters then returning
	 * early with a degraded result).
	 */
	readonly hardCap?: WorkingStateCap;

	/**
	 * Optional sink for telemetry events. Tests inject a recorder;
	 * production wires this to the existing pino logger.
	 */
	readonly onEvent?: (event: WorkingStateEvent) => void;
}

export type WorkingStateEvent =
	| { readonly kind: 'soft-warn'; readonly entries: number; readonly bytes: number; readonly at: number }
	| { readonly kind: 'hard-cap';  readonly entries: number; readonly bytes: number; readonly at: number };

export function createWorkingStateLedger(opts: CreateWorkingStateOpts = {}): WorkingStateLedger {
	const softWarn = opts.softWarn ?? DEFAULT_WORKING_STATE_SOFT_WARN;
	const hardCap  = opts.hardCap  ?? DEFAULT_WORKING_STATE_HARD_CAP;
	const onEvent  = opts.onEvent;

	const entries: LedgerEntry<unknown>[] = [];
	const byRef = new Map<LedgerRef, LedgerEntry<unknown>>();
	const pinList: { ref: LedgerRef; target: DistillTarget }[] = [];
	let bytes = 0;
	let softWarned = false;

	return {
		append(entry) {
			const ref: LedgerRef = `ledger-${randomUUID()}`;
			const at = Date.now();

			const full: LedgerEntry<unknown> = {
				ref,
				source:     entry.source,
				payload:    entry.payload,
				claims:     entry.claims,
				confidence: entry.confidence,
				at,
			};

			const entryBytes = estimateBytes(full);
			if (entries.length + 1 > hardCap.maxEntries || bytes + entryBytes > hardCap.maxBytes) {
				onEvent?.({ kind: 'hard-cap', entries: entries.length, bytes, at });
				throw new WorkingStateHardCapError(entries.length, bytes, hardCap);
			}

			entries.push(full);
			byRef.set(ref, full);
			bytes += entryBytes;

			if (!softWarned && (entries.length >= softWarn.maxEntries || bytes >= softWarn.maxBytes)) {
				softWarned = true;
				onEvent?.({ kind: 'soft-warn', entries: entries.length, bytes, at });
			}

			return ref;
		},

		list(filter?: LedgerFilter): readonly LedgerEntry<unknown>[] {
			if (filter === undefined) { return entries.slice(); }
			return entries.filter(filter);
		},

		get(ref: LedgerRef): LedgerEntry<unknown> | undefined {
			return byRef.get(ref);
		},

		pin(ref: LedgerRef, target: DistillTarget): void {
			if (!byRef.has(ref)) {
				throw new Error(`working-state.pin: unknown ledger ref '${ref}'`);
			}
			pinList.push({ ref, target });
		},

		pins() {
			return pinList.slice();
		},

		size() {
			return { entries: entries.length, bytes };
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rough byte estimation. JSON.stringify is stable + cheap enough for
 * P0; precision can tighten in later phases (e.g., per-character
 * accounting for UTF-8). Throws on circular payloads -- caller must
 * pre-flatten.
 */
function estimateBytes(entry: LedgerEntry<unknown>): number {
	try {
		return Buffer.byteLength(JSON.stringify(entry), 'utf8');
	} catch {
		// Circular or unserializable payload -- charge a token cost.
		return 1024;
	}
}
