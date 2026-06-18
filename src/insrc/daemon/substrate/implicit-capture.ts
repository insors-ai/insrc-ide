/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Implicit-capture-during-retrieval backstop (memory-context M5.4 / G8).
 *
 * Catches preferences the foreground classifier may have missed (Ollama
 * down, ambiguous phrasing, classifier deferred but content was in fact
 * assertion-shaped). Runs at preference-slot fulfillment time so it
 * doesn't add per-turn latency; surfaces newly-discovered candidates
 * asynchronously on the user's next chat interaction via the existing
 * Layer 3 confirm toast (M1.6.c).
 *
 * Cost-bound design:
 *   - Per-(sessionId, owner) cursor; the pass only ever sees turns it
 *     hasn't scanned yet.
 *   - Dismissed turns are tracked so the classifier doesn't re-fire on
 *     content that's already been judged.
 *   - Already-staged turns are tracked so an accepted candidate doesn't
 *     re-stage on a follow-up pass.
 *
 * Off by default. The chat-handler integration (M5.5) gates the
 * invocation on `insrc.memory.implicitCapture.enabled`; this module
 * itself stays callable for tests + future opt-in surfaces.
 */

import { getLogger } from '../../shared/logger.js';
import {
	freshImplicitCaptureState,
	loadImplicitCaptureState,
	saveImplicitCaptureState,
	type ImplicitCaptureState,
} from './implicit-capture-state.js';
import type { UserAssertionClassifier } from './classifier/user-assertion.js';
import type { MemoryStore, OwnerId } from './types.js';

const log = getLogger('substrate:implicit-capture');

/** The pending namespace the M1.6.a Layer 3 hook also writes to. */
export const PENDING_NS = 'user-assertions-pending';


export interface ImplicitTurnInput {
	readonly idx:  number;
	readonly text: string;
}


export interface ImplicitDeps {
	readonly memory:     MemoryStore;
	readonly classifier: UserAssertionClassifier;
	readonly getTurnsForSession: (sessionId: string) => Promise<readonly ImplicitTurnInput[]>;
	/** Best-effort notifier so the chat-handler can fire IDE-side toasts.
	 *  Optional -- tests can omit this; production wires it to the
	 *  prefs-confirm bus emitter. */
	readonly onCandidateStaged?: ((evt: StagedCandidateEvent) => void) | undefined;
	/** Wall-clock for `proposedAt`. Override in tests. */
	readonly now?: (() => number) | undefined;
}


export interface StagedCandidateEvent {
	readonly sessionId:     string;
	readonly owner:         OwnerId;
	readonly turnIdx:       number;
	readonly key:           string;
	readonly subject:       string;
	readonly canonicalText: string;
	readonly confidence:    number;
}


export interface RunImplicitPassResult {
	readonly state:         ImplicitCaptureState;
	readonly scannedTurns:  number;
	readonly stagedCount:   number;
	readonly dismissedCount: number;
}


export async function runImplicitPass(
	sessionId: string,
	owner:     OwnerId,
	deps:      ImplicitDeps,
): Promise<RunImplicitPassResult> {
	const now = deps.now ?? (() => Date.now());
	const existing = await loadImplicitCaptureState(deps.memory, owner, sessionId)
		?? freshImplicitCaptureState(sessionId, owner);

	const allTurns   = await deps.getTurnsForSession(sessionId);
	const candidates = allTurns.filter(t => t.idx > existing.lastScannedTurnIdx);
	if (candidates.length === 0) {
		return { state: existing, scannedTurns: 0, stagedCount: 0, dismissedCount: 0 };
	}

	const dismissed = new Set(existing.dismissedTurnIdxs);
	const staged    = new Set(existing.stagedTurnIdxs);
	let stagedCount    = 0;
	let dismissedCount = 0;
	let maxScannedIdx  = existing.lastScannedTurnIdx;

	for (const turn of candidates) {
		maxScannedIdx = Math.max(maxScannedIdx, turn.idx);
		if (dismissed.has(turn.idx) || staged.has(turn.idx)) {
			// Already-judged turn from a prior pass. Defensive -- the
			// cursor filter above usually means we never see it twice,
			// but a partial save + crash could leave a hole.
			continue;
		}
		const turnId = `${sessionId}:implicit:${turn.idx}`;
		try {
			const result = await deps.classifier.classify({ turnId, text: turn.text });
			if (result.accepted.length === 0) {
				dismissed.add(turn.idx);
				dismissedCount += 1;
				continue;
			}
			// Stage each accepted payload into the pending namespace so the
			// existing Layer 3 toast (M1.6.c) handles the user's verdict.
			// We DON'T persist to user-assertions here -- the user must
			// confirm via the toast (the whole point of M5 being a backstop
			// the user can reject).
			const ns = deps.memory.scope(owner, PENDING_NS);
			let stagedAny = false;
			for (const payload of result.accepted) {
				const subject = payload.preferenceSubject ?? payload.subject;
				const key = `${turnId}::${subject}`;
				try {
					await ns.put(key, {
						...payload,
						implicit:     true,
						proposedAt:   now(),
						userDiscarded: false,
					}, {
						kind:       'hint',
						source:     { kind: 'user-asserted', turnId },
						confidence: payload.confidence,
					});
					stagedAny = true;
					deps.onCandidateStaged?.({
						sessionId,
						owner,
						turnIdx:       turn.idx,
						key,
						subject,
						canonicalText: payload.canonicalText ?? payload.text,
						confidence:    payload.confidence,
					});
				} catch (err) {
					log.warn({ turnId, key, err: (err as Error).message }, 'implicit-capture: stage failed');
				}
			}
			if (stagedAny) {
				staged.add(turn.idx);
				stagedCount += 1;
			} else {
				// Classifier accepted but staging failed for every payload --
				// dismiss the turn so the pass doesn't retry forever.
				dismissed.add(turn.idx);
				dismissedCount += 1;
			}
		} catch (err) {
			// Classifier failed. Dismiss the turn rather than retry forever;
			// the user can re-state the preference in chat to re-trigger
			// the foreground path.
			log.warn({ turnId, err: (err as Error).message }, 'implicit-capture: classify failed');
			dismissed.add(turn.idx);
			dismissedCount += 1;
		}
	}

	const next: ImplicitCaptureState = {
		sessionId,
		owner,
		lastScannedTurnIdx: maxScannedIdx,
		dismissedTurnIdxs:  [...dismissed].sort((a, b) => a - b),
		stagedTurnIdxs:     [...staged].sort((a, b) => a - b),
	};
	await saveImplicitCaptureState(deps.memory, next);

	return {
		state:         next,
		scannedTurns:  candidates.length,
		stagedCount,
		dismissedCount,
	};
}
