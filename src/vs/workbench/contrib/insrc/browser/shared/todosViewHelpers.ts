/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import type { TodoItemStatus, TodoList, TodoOwner } from '../../common/todosService.js';

/**
 * Shared rendering helpers for todos surfaces (plans/todo-framework.md
 * Phase 8 -- consolidate what's genuinely duplicated between the
 * read-only todos pane, the unified notepad pane, and the inline chat
 * widget).
 *
 * Deliberately narrow: just small pure helpers. Full shared rendering
 * widgets would over-abstract the three panes' substantively
 * different interaction models (read-only cards vs editable inputs
 * vs compact transcript card). A single widget config-driven enough
 * to cover all three would be harder to read than the three local
 * implementations that delegate to these helpers.
 */

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/** Codicon corresponding to each TodoItem status. */
export function iconForItemStatus(status: TodoItemStatus): ThemeIcon {
	switch (status) {
		case 'pending': return Codicon.circleLargeOutline;
		case 'in_progress': return Codicon.play;
		case 'blocked': return Codicon.warning;
		case 'completed': return Codicon.check;
		case 'cancelled': return Codicon.close;
	}
}

// ---------------------------------------------------------------------------
// Status predicates + transitions
// ---------------------------------------------------------------------------

/** True when the item's status is terminal (no further transitions). */
export function isTerminalItem(status: TodoItemStatus): boolean {
	return status === 'completed' || status === 'cancelled';
}

/**
 * Cycle an item through the most useful statuses on a click:
 * `pending` -> `in_progress` -> `completed` -> `pending`. `blocked`
 * and `cancelled` cycle back to `in_progress` / `pending`. Used by
 * editable surfaces (notepad pane). Read-only surfaces (todos pane)
 * don't invoke this.
 */
export function nextStatus(current: TodoItemStatus): TodoItemStatus {
	switch (current) {
		case 'pending': return 'in_progress';
		case 'in_progress': return 'completed';
		case 'completed': return 'pending';
		case 'blocked': return 'in_progress';
		case 'cancelled': return 'pending';
	}
}

// ---------------------------------------------------------------------------
// List presentation
// ---------------------------------------------------------------------------

/**
 * Default collapse choice for a list card. System-owned lists and
 * lists whose items are all terminal start collapsed; everything
 * else starts expanded. Read-only panes use this as the initial
 * state; user toggles override per-session via storage.
 */
export function defaultCollapsedForList(list: TodoList): boolean {
	if (list.owner === 'system') {
		return true;
	}
	if (list.items.length === 0) {
		return false;
	}
	return list.items.every(it => isTerminalItem(it.status));
}

/**
 * Single-line "N items · K pending · archived/complete" meta label
 * used by the card header across all three surfaces. Terminology
 * stays consistent regardless of surface.
 */
export function formatListMeta(list: TodoList): string {
	const total = list.items.length;
	const pending = list.items.filter(it => !isTerminalItem(it.status)).length;
	const parts: string[] = [`${total} item${total === 1 ? '' : 's'}`];
	if (pending > 0) {
		parts.push(`${pending} pending`);
	}
	if (list.status === 'archived') {
		parts.push('archived');
	} else if (list.status === 'completed') {
		parts.push('complete');
	}
	return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Forward targets
// ---------------------------------------------------------------------------

/**
 * Agent families the user can forward TODO snapshots to via
 * `withTodo` (plans/todo-framework.md Phase 9). Excludes `'user'`
 * (can't forward to yourself) and `'system'` (daemon-reserved).
 * Presented in the notepad's per-card target dropdown.
 */
export const FORWARD_TARGET_FAMILIES: readonly TodoOwner[] = [
	'chat', 'implementation', 'brainstorm', 'designer',
	'planner', 'tester', 'research', 'debugging', 'deployment',
];
