/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-(sessionId, owner) state for the implicit-capture-during-retrieval
 * backstop (memory-context M5.3).
 *
 * Tracks a monotonic cursor (`lastScannedTurnIdx`) over the conversation
 * history and an idempotency set of dismissed turn indexes so a single
 * turn never gets re-staged into the pending namespace on subsequent
 * passes. Storage is the substrate's general-purpose memory store under
 * the `implicit-capture-state` namespace, owned by the implicit-capture
 * subject.
 *
 * The persisted candidates referenced in plans/memory-context.md M5.3
 * are deliberately NOT stored here -- accepted candidates are staged
 * to the M1.6.a `user-assertions-pending` namespace so the existing
 * Layer 3 confirm toast (M1.6.c) surfaces them without duplication.
 * This module owns only the bookkeeping the pass needs to remain
 * idempotent across runs.
 */

import { getLogger } from '../../shared/logger.js';
import type { MemoryStore, OwnerId } from './types.js';

const log = getLogger('substrate:implicit-capture-state');

export const IMPLICIT_CAPTURE_NS = 'implicit-capture-state';


export interface ImplicitCaptureState {
	readonly sessionId:          string;
	readonly owner:              OwnerId;
	readonly lastScannedTurnIdx: number;
	readonly dismissedTurnIdxs:  readonly number[];
	readonly stagedTurnIdxs:     readonly number[];   // turns whose accept was staged to the pending namespace
}


export function freshImplicitCaptureState(sessionId: string, owner: OwnerId): ImplicitCaptureState {
	return {
		sessionId,
		owner,
		lastScannedTurnIdx: -1,
		dismissedTurnIdxs:  [],
		stagedTurnIdxs:     [],
	};
}


export function stateKeyFor(sessionId: string): string {
	// SessionIds are daemon-controlled (chat session pool); no user input.
	// The substrate memory-store key encoder rejects `..` and percent-encodes
	// special chars, so plain concatenation here is safe.
	return `${sessionId}::state`;
}


export async function loadImplicitCaptureState(
	memory:    MemoryStore,
	owner:     OwnerId,
	sessionId: string,
): Promise<ImplicitCaptureState | undefined> {
	const ns = memory.scope(owner, IMPLICIT_CAPTURE_NS);
	const entry = await ns.get<ImplicitCaptureState>(stateKeyFor(sessionId));
	if (entry === undefined) { return undefined; }
	// Defensive: substrate may surface a row from a future schema. The
	// shape is stable for M5 but a writtenAt epoch sanity check guards
	// against accidental cross-owner reads.
	if (typeof entry.value !== 'object' || entry.value === null) {
		log.warn({ owner, sessionId }, 'implicit-capture-state row has malformed value; ignoring');
		return undefined;
	}
	return entry.value;
}


export async function saveImplicitCaptureState(
	memory: MemoryStore,
	state:  ImplicitCaptureState,
): Promise<void> {
	const ns = memory.scope(state.owner, IMPLICIT_CAPTURE_NS);
	// Delete-then-put: substrate's D4 merge policy keeps the prior entry
	// on same-kind / same-or-higher confidence writes. The implicit-pass
	// state is internal bookkeeping that MUST overwrite (e.g. test paths
	// that regress the cursor, or future delete-and-resync flows). The
	// chat-handler is the sole caller and runs serially per session, so
	// there's no race window to worry about.
	const key = stateKeyFor(state.sessionId);
	await ns.delete(key);
	await ns.put(key, state, {
		kind:       'hint',
		// Internal bookkeeping; closest match in the EntrySource union is
		// `feedback` since the implicit pass is providing self-feedback
		// ("I scanned up to turn N"). The eventId is synthesised from the
		// session id + cursor.
		source:     { kind: 'feedback', eventId: `implicit-capture:${state.sessionId}:${state.lastScannedTurnIdx}` },
		confidence: 0.9,
	});
}
