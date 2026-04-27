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

/**
 * Codicon for each TodoItem status. The Record dispatch (rather than a
 * `switch`) lets `?? Codicon.circleOutline` catch a status value that
 * drifts from the union -- data corruption, partial row, replay across
 * a workbench refresh whose schema bumped before the daemon's. With a
 * `switch`, TS proves the switch exhaustive and flags the fallback as
 * unreachable. See plans/analyzers/code-analyzer.md F3.
 */
const ITEM_STATUS_ICON: Readonly<Record<TodoItemStatus, ThemeIcon>> = {
	pending: Codicon.circleLargeOutline,
	in_progress: Codicon.play,
	blocked: Codicon.warning,
	completed: Codicon.check,
	cancelled: Codicon.close,
};

/** Codicon corresponding to each TodoItem status. */
export function iconForItemStatus(status: TodoItemStatus): ThemeIcon {
	return ITEM_STATUS_ICON[status] ?? Codicon.circleOutline;
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
// Per-family policy mirrors
// ---------------------------------------------------------------------------

/**
 * Owners whose lists hide the per-item "+ Add comment" affordance on
 * the todos pane. Mirrors `AgentFamilyMeta.suppressTodoComments` from
 * `src/insrc/shared/agent-registry.ts` -- the workbench keeps the
 * type loose (string) on purpose and doesn't import the daemon-side
 * registry, so any family that sets `suppressTodoComments: true` on
 * its registry row needs to be added here too.
 *
 * Code Analyzer routes user feedback through the Analysis Report
 * Pane (annotate-and-batch-send-to-chat) instead of framework
 * comments -- per design/analyzers/code-analyzer.html section 5.3.
 */
const SUPPRESS_COMMENT_OWNERS: ReadonlySet<TodoOwner> = new Set<TodoOwner>([
	'code-analyzer',
]);

/**
 * True when the todos pane should hide the "+ Add comment" affordance
 * on items of this list.
 */
export function suppressCommentsForList(list: TodoList): boolean {
	return SUPPRESS_COMMENT_OWNERS.has(list.owner);
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
