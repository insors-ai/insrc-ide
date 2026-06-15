/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Daemon-side IPC handlers for orphan-worktree discovery + cleanup
 * (plans/external-agent-integration.md §5.1).
 *
 * Surface for the workbench:
 *
 *   - `handoff.list-orphans` RPC: returns the current snapshot of
 *     worktree directories under the persist root, each tagged with
 *     its state (`pending` / `interrupted` / `completed`). The IDE
 *     renders them in a sidebar / picker so the user can decide
 *     what to do with each.
 *
 *   - `handoff.discard-orphan` RPC: forcibly removes a worktree by
 *     `sessionId`. Idempotent: discarding a path that's already gone
 *     returns `{ removed: false }`.
 *
 * Path resolution: both RPCs use `PATHS.handoffs` as the persistRoot
 * by default; callers can override per-request for tests / migration
 * tooling.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectOrphans, discardOrphan, type OrphanWorktree } from '../handoff/orphan-cleanup.js';
import { PATHS } from '../shared/paths.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('daemon:orphan');

interface ListOrphansParams {
	readonly persistRoot?: string | undefined;
}

interface ListOrphansResult {
	readonly orphans: readonly OrphanWorktree[];
}

interface DiscardOrphanParams {
	readonly sessionId:    string;
	readonly persistRoot?: string | undefined;
}

interface DiscardOrphanResult {
	readonly removed: boolean;
}

export const handoffListOrphansRpc = async (rawParams: unknown): Promise<ListOrphansResult> => {
	const p = (rawParams as ListOrphansParams | undefined) ?? {};
	const persistRoot = p.persistRoot ?? PATHS.handoffs;
	const orphans = detectOrphans({ persistRoot });
	return { orphans };
};

export const handoffDiscardOrphanRpc = async (rawParams: unknown): Promise<DiscardOrphanResult> => {
	const p = rawParams as DiscardOrphanParams;
	if (typeof p?.sessionId !== 'string' || p.sessionId.length === 0) {
		log.warn({ params: rawParams }, 'handoff.discard-orphan: invalid sessionId; refusing');
		return { removed: false };
	}
	const persistRoot = p.persistRoot ?? PATHS.handoffs;
	// We discard the worktree subdir only -- not the whole session
	// directory, which holds the spec / audit / trace / cost
	// artifacts the user may still want to read. The session dir is
	// safe to leave; it doesn't grow on its own once the worktree is
	// gone.
	const worktreePath = join(persistRoot, p.sessionId, 'worktree');
	const removed = discardOrphan(worktreePath);
	return { removed };
};

// ---------------------------------------------------------------------------
// handoff.cleanup -- user-driven post-audit cleanup (§5.1)
// ---------------------------------------------------------------------------

interface CleanupParams {
	readonly sessionId:    string;
	readonly specId:       string;
	readonly outcome:      'accept' | 'reject' | 'dismissed';
	readonly persistRoot?: string | undefined;
	readonly stopReason?:  string | undefined;
}

interface CleanupResult {
	readonly removed: boolean;
	readonly outcomeRecorded: boolean;
}

/**
 * Post-handoff cleanup RPC. Fired from the IDE when the user
 * acts on a finalized handoff card (accept changes / reject
 * changes / dismiss). Records the outcome to
 * `<sid>/<specId>.outcome.json` for observability and removes
 * the worktree subdir so it doesn't appear on the orphan list
 * next startup.
 *
 * Outcome semantics:
 *
 *   - `accept`    -- user accepted the diff (per-file applies
 *                    have already landed via the codelens flow).
 *   - `reject`    -- user rejected; no changes applied.
 *   - `dismissed` -- user closed the card without explicit
 *                    accept / reject; worktree removed anyway.
 *
 * Idempotent: a second call returns `removed: false` because the
 * worktree is already gone, but still writes the outcome stamp.
 */
export const handoffCleanupRpc = async (rawParams: unknown): Promise<CleanupResult> => {
	const p = rawParams as CleanupParams;
	if (typeof p?.sessionId !== 'string' || typeof p?.specId !== 'string') {
		log.warn({ params: rawParams }, 'handoff.cleanup: invalid params; refusing');
		return { removed: false, outcomeRecorded: false };
	}
	if (p.outcome !== 'accept' && p.outcome !== 'reject' && p.outcome !== 'dismissed') {
		log.warn({ outcome: p.outcome }, 'handoff.cleanup: invalid outcome; refusing');
		return { removed: false, outcomeRecorded: false };
	}
	const persistRoot = p.persistRoot ?? PATHS.handoffs;
	const sessionDir = join(persistRoot, p.sessionId);
	const worktreePath = join(sessionDir, 'worktree');

	let outcomeRecorded = false;
	try {
		mkdirSync(sessionDir, { recursive: true });
		const stamp = {
			outcome:   p.outcome,
			at:        new Date().toISOString(),
			...(p.stopReason !== undefined ? { stopReason: p.stopReason } : {}),
		};
		writeFileSync(
			join(sessionDir, `${p.specId}.outcome.json`),
			JSON.stringify(stamp, null, 2),
		);
		outcomeRecorded = true;
	} catch (err) {
		log.warn({ err: (err as Error).message, sessionId: p.sessionId, specId: p.specId },
			'handoff.cleanup: outcome stamp failed');
	}

	const removed = discardOrphan(worktreePath);
	log.info({ sessionId: p.sessionId, specId: p.specId, outcome: p.outcome, removed },
		'handoff.cleanup applied');
	return { removed, outcomeRecorded };
};
