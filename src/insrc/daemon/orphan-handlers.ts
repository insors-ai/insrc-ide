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
