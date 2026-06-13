/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Internal IPC registry.
 *
 * Aggregates all `internal.*` handlers into a single typed map and
 * exposes invariant assertions. The aggregator is the single point
 * of truth for "what local-LLM capabilities exist".
 *
 * Why a typed map rather than a string-keyed dispatch loop: these
 * handlers are called from in-process TypeScript code with full
 * type knowledge; routing through string dispatch would lose the
 * input/output types at every call site. Callers import the typed
 * handler directly (e.g. `import { intentResolve } from
 * 'internal-ipc/handlers/intent.js'`) and the registry is used only
 * for the invariant check + future cross-cutting concerns
 * (instrumentation, telemetry).
 */

import type { InternalIpcHandler } from './types.js';
import { intentResolve }              from './handlers/intent.js';
import { memoryRecall }               from './handlers/memory.js';
import { sessionAppendTurn }          from './handlers/session.js';
import {
	reviewCitationVerify,
	reviewSectionReview,
} from './handlers/review.js';
import { handoffSpawn, handoffReturn } from './handlers/handoff.js';
import { gatingEvaluate }              from './handlers/gating.js';

/**
 * Every registered handler keyed by IPC name. The value type is
 * intentionally `InternalIpcHandler<unknown, unknown>` for the
 * invariant-check loop; typed callers import the per-handler
 * exports directly with full I/O types.
 */
export const INTERNAL_IPCS = {
	'internal.intent.resolve':         intentResolve         as InternalIpcHandler<unknown, unknown>,
	'internal.memory.recall':          memoryRecall          as InternalIpcHandler<unknown, unknown>,
	'internal.session.append-turn':    sessionAppendTurn     as InternalIpcHandler<unknown, unknown>,
	'internal.review.citation-verify': reviewCitationVerify  as InternalIpcHandler<unknown, unknown>,
	'internal.review.section-review':  reviewSectionReview   as InternalIpcHandler<unknown, unknown>,
	'internal.handoff.spawn':          handoffSpawn          as InternalIpcHandler<unknown, unknown>,
	'internal.handoff.return':         handoffReturn         as InternalIpcHandler<unknown, unknown>,
	'internal.gating.evaluate':        gatingEvaluate        as InternalIpcHandler<unknown, unknown>,
} as const satisfies Record<string, InternalIpcHandler<unknown, unknown>>;

export type InternalIpcName = keyof typeof INTERNAL_IPCS;

/**
 * Phase 1 sealing invariants:
 *
 *   1. Every key is `internal.<family>.<verb>` dot-separated.
 *   2. The map's key equals the handler's `name` field. Drift would
 *      mean the named-import path (which callers use) diverges from
 *      what the registry advertises.
 *   3. The full set of handler names is exactly the 8 IPCs the
 *      design enumerates -- adding a new one is a deliberate act
 *      that this assert forces us to update.
 */
export function assertInternalIpcInvariants(): void {
	const expected = new Set([
		'internal.intent.resolve',
		'internal.memory.recall',
		'internal.session.append-turn',
		'internal.review.citation-verify',
		'internal.review.section-review',
		'internal.handoff.spawn',
		'internal.handoff.return',
		'internal.gating.evaluate',
	]);
	const actual = new Set(Object.keys(INTERNAL_IPCS));
	for (const k of actual) {
		if (!expected.has(k)) {
			throw new Error(`Internal IPC '${k}' registered but not in the expected v1 surface. Update registry.assertInternalIpcInvariants() if you intend to extend the surface.`);
		}
	}
	for (const k of expected) {
		if (!actual.has(k)) {
			throw new Error(`Internal IPC '${k}' is in the v1 surface but missing from the registry.`);
		}
	}
	for (const [key, handler] of Object.entries(INTERNAL_IPCS)) {
		if (!key.startsWith('internal.')) {
			throw new Error(`Internal IPC '${key}' is missing the 'internal.' prefix.`);
		}
		if (key !== handler.name) {
			throw new Error(`Internal IPC key '${key}' does not match handler.name '${handler.name}'.`);
		}
	}
}
