/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

/**
 * Browser-side interface + types for the session-scoped TODO framework
 * (plans/todo-framework.md Phase 4).
 *
 * Types here mirror the shapes defined in the daemon's
 * `insors-ai/insrc:src/shared/todos.ts`. They are intentionally duplicated
 * (not imported across the project boundary) because the workbench
 * contrib and the daemon are compiled with separate tsconfigs; the
 * wire format is the contract.
 *
 * The service is **read-only from the UI side**. Agents own all
 * list / item mutations through the daemon's in-process TodosApi
 * (Phase 3) or the `todos.*` RPCs with agent-family caller identity
 * (never exposed to the browser). The one write channel the user
 * has is comments (Phase 5d) -- those methods are added in a
 * follow-up phase, not here.
 */

// ---------------------------------------------------------------------------
// Status + owner types (mirror shared/todos.ts)
// ---------------------------------------------------------------------------

export type TodoItemStatus =
	| 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';

export type TodoListStatus =
	| 'active' | 'completed' | 'archived';

/**
 * Agent family id -- mirror of the `AgentFamily` union in
 * `insors-ai/insrc:src/shared/agent-registry.ts`. Kept loose (string) so UI
 * code doesn't break when the daemon registry gains a new family;
 * the badge renderer falls back to the raw id string if it doesn't
 * recognise the value.
 */
export type TodoOwner = string;

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------

export type TodoStreamEventKind =
	| 'listCreated' | 'listUpdated' | 'listArchived' | 'listDeleted'
	| 'itemCreated' | 'itemUpdated' | 'itemRemoved'
	| 'commentAdded' | 'commentUpdated' | 'commentRemoved';

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface TodoComment {
	readonly id: string;
	readonly itemId: string;
	readonly author: TodoOwner | 'user';
	readonly body: string;
	readonly createdAt: string;
	readonly editedAt?: string | undefined;
	readonly agentAcknowledged?: boolean | undefined;
}

export interface TodoItem {
	readonly id: string;
	readonly listId: string;
	readonly title: string;
	readonly description?: string | undefined;
	readonly status: TodoItemStatus;
	readonly order: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly completedAt?: string | undefined;
	readonly blockedReason?: string | undefined;
	readonly tags?: readonly string[] | undefined;
	readonly meta?: Readonly<Record<string, unknown>> | undefined;
	readonly comments?: readonly TodoComment[] | undefined;
}

export interface TodoTransfer {
	readonly from: TodoOwner;
	readonly to: TodoOwner;
	readonly reason: string;
	readonly at: string;
	readonly initiator?: TodoOwner | undefined;
}

export interface TodoList {
	readonly id: string;
	readonly sessionId: string;
	readonly parentListId?: string | undefined;
	readonly title: string;
	readonly description?: string | undefined;
	readonly status: TodoListStatus;
	readonly owner: TodoOwner;
	readonly source: TodoOwner;
	readonly transfers: readonly TodoTransfer[];
	readonly body?: string | undefined;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly items: readonly TodoItem[];
}

// ---------------------------------------------------------------------------
// withTodo types (Phase 9d)
// ---------------------------------------------------------------------------

export interface TodoSnapshot {
	readonly sourceRef: string;
	readonly title: string;
	readonly description?: string | undefined;
	readonly tags?: readonly string[] | undefined;
	readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

export interface TodoInvocationResponseItem {
	readonly sourceRef: string;
	readonly status: TodoItemStatus;
	readonly blockedReason?: string | undefined;
	readonly targetListId?: string | undefined;
	readonly targetItemId?: string | undefined;
	readonly note?: string | undefined;
}

export interface TodoInvocationResult {
	readonly items: readonly TodoInvocationResponseItem[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const IInsrcTodosService =
	createDecorator<IInsrcTodosService>('insrcTodosService');

export interface IInsrcTodosService {
	readonly _serviceBrand: undefined;

	/**
	 * All lists owned by the currently-active chat session. Empty array
	 * when no session is active. Seeded on `onDidChangeSession` via a
	 * `todos.listForSession` RPC; kept fresh by the subscribed stream.
	 */
	readonly lists: readonly TodoList[];

	/** Fires whenever the `lists` array changes (any mutation / session flip). */
	readonly onDidChange: Event<void>;

	/**
	 * Granular event: fires for a single list whenever its snapshot is
	 * updated. UI widgets keyed by list id subscribe here so they can
	 * re-render just the affected card instead of rebuilding every
	 * list on every mutation.
	 */
	readonly onDidChangeList: Event<TodoList>;

	/**
	 * Fires when a list is dropped (either via `todos.cleanup` or
	 * `agent.discard`). Subscribers must prune the list id from any
	 * caches they keep -- the list no longer exists.
	 */
	readonly onDidRemoveList: Event<string>;

	/**
	 * Fetch lists for an arbitrary session (not necessarily the active
	 * one). Bypasses the in-memory cache. Used by the Runs sidebar to
	 * show pending-item counts for past / inactive sessions.
	 */
	listsForSession(
		sessionId: string,
		opts?: { includeArchived?: boolean },
	): Promise<readonly TodoList[]>;

	// -- User-owned list / item writes (Phase 9) ---------------------------
	// Used by the prompt notepad's "My TODOs" section. The daemon enforces
	// `owner === 'user'` on every mutation path; the todos pane never
	// invokes these.

	createUserList(opts: {
		sessionId: string;
		title: string;
		description?: string;
		body?: string;
		parentListId?: string;
	}): Promise<TodoList>;

	updateListFields(listId: string, patch: {
		title?: string;
		description?: string;
		body?: string;
		status?: 'active' | 'completed' | 'archived';
	}): Promise<TodoList>;

	archiveList(listId: string): Promise<TodoList>;
	unarchiveList(listId: string): Promise<TodoList>;

	/**
	 * Permanently delete a list and every item + comment it owns.
	 * Caller must own the list. Distinct from `archiveList` which
	 * keeps the list queryable; `deleteList` drops the rows and
	 * emits a `listDeleted` stream event so caches prune cleanly.
	 */
	deleteList(listId: string): Promise<void>;

	addItem(listId: string, opts: {
		title: string;
		description?: string;
		tags?: readonly string[];
		meta?: Readonly<Record<string, unknown>>;
		insertAfterItemId?: string;
	}): Promise<TodoItem>;

	updateItem(itemId: string, patch: {
		title?: string;
		description?: string;
		status?: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
		blockedReason?: string;
		tags?: readonly string[];
		meta?: Readonly<Record<string, unknown>>;
	}): Promise<TodoItem>;

	reorderItem(itemId: string, insertAfterItemId: string | null): Promise<TodoItem>;
	removeItem(itemId: string): Promise<void>;
	clearCompleted(listId: string): Promise<TodoList>;

	/**
	 * Hand the list off to another owner (agent family or `'user'`).
	 * Caller must currently own the list. Permanent ownership flip.
	 */
	transferList(listId: string, to: TodoOwner, reason: string): Promise<TodoList>;

	/** Move a list under a different parent (same session). `null` = root. */
	reparentList(listId: string, newParentListId: string | null): Promise<TodoList>;

	// -- withTodo (Phase 9d) -----------------------------------------------

	/**
	 * Forward a set of user-owned item snapshots to a target agent
	 * family. Kicks off an agent run whose `input.todos` is the
	 * snapshot array; the returned `TodoInvocationResult` reports
	 * per-snapshot disposition using the same `TodoItemStatus`
	 * vocabulary as the framework. The caller is responsible for
	 * applying each response item's `status` to its source item
	 * (typically via `updateItem(sourceId, { status })`).
	 */
	forwardToAgent(opts: {
		targetFamily: TodoOwner;
		sessionId: string;
		items: readonly TodoSnapshot[];
	}): Promise<TodoInvocationResult>;

	// -- Comments (Phase 5d) ----------------------------------------------

	/**
	 * Post a comment on a readable item. Author is always `'user'`
	 * from the browser side. Resolves to the persisted comment on
	 * success; rejects with the daemon's structured error on failure
	 * (e.g. `invalid_ids`, `field_too_large`).
	 */
	addComment(itemId: string, body: string): Promise<TodoComment>;

	/** Edit a previously-authored comment. Author-only; daemon enforces. */
	editComment(commentId: string, body: string): Promise<TodoComment>;

	/** Delete a previously-authored comment. Author-only. */
	deleteComment(commentId: string): Promise<void>;
}
