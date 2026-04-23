/**
 * Session-scoped TODO framework -- shared types.
 *
 * See plans/todo-framework.md. Zero runtime dependencies beyond the
 * agent-family registry so this module can be imported by both the
 * daemon and the browser side.
 *
 * Ownership is at the agent FAMILY level (AgentFamily from
 * shared/agent-registry.ts). Variants (pair / delegate under
 * 'implementation'; brainstorm sub-categories) never surface here --
 * they are private runtime detail inside their family's controller.
 *
 * Lists, items, and comments are all identified by globally-unique
 * hex-32 ids (`randomBytes(16).toString('hex')`, matching the
 * existing repo convention). Items live inside a list; comments live
 * on an item. Lists are always keyed to a session id and die with
 * the session (see session-lifecycle.md Phase 4 discard path).
 */

import type { AgentFamily } from './agent-registry.js';

// ---------------------------------------------------------------------------
// Status enums + transition tables
// ---------------------------------------------------------------------------

export type TodoItemStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export type TodoListStatus =
  | 'active'
  | 'completed'
  | 'archived';

/** Terminal item states -- no further transitions allowed. */
export const TERMINAL_ITEM_STATUSES: ReadonlySet<TodoItemStatus> =
  new Set(['completed', 'cancelled']);

/**
 * Legal item status transitions. A status may always transition to
 * `cancelled` (forced terminal) from any non-terminal state. All
 * other arcs are enumerated here.
 */
const ITEM_TRANSITIONS: Readonly<Record<TodoItemStatus, readonly TodoItemStatus[]>> = {
  pending:     ['in_progress', 'cancelled'],
  in_progress: ['blocked', 'completed', 'cancelled', 'pending'],
  blocked:     ['in_progress', 'pending', 'cancelled'],
  completed:   [],
  cancelled:   [],
};

/** True if `from -> to` is a legal item-status transition. */
export function canTransitionItem(from: TodoItemStatus, to: TodoItemStatus): boolean {
  if (from === to) return true;  // no-op updates always allowed
  return ITEM_TRANSITIONS[from].includes(to);
}

/**
 * Legal list status transitions. `active` auto-flips to `completed`
 * when every item reaches a terminal state (handled in the RPC layer);
 * the arc below is the explicit one callers may invoke.
 */
const LIST_TRANSITIONS: Readonly<Record<TodoListStatus, readonly TodoListStatus[]>> = {
  active:    ['completed', 'archived'],
  completed: ['active', 'archived'],
  archived:  ['active'],
};

/** True if `from -> to` is a legal list-status transition. */
export function canTransitionList(from: TodoListStatus, to: TodoListStatus): boolean {
  if (from === to) return true;
  return LIST_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Owner type
// ---------------------------------------------------------------------------

/**
 * Owner of a TODO list. Equals `AgentFamily` from the registry -- no
 * variant names are legal owners. See plans/todo-framework.md for
 * the authorization rules.
 */
export type TodoOwner = AgentFamily;

// ---------------------------------------------------------------------------
// Comment (Phase 5d; type declared now for stable item shape)
// ---------------------------------------------------------------------------

export interface TodoComment {
  readonly id: string;            // hex-32 id
  readonly itemId: string;        // parent item id
  /** Author. Currently `'user'` for user-authored comments; a future
   *  reviewer-agent phase may set this to an `AgentFamily` value. */
  readonly author: TodoOwner | 'user';
  readonly body: string;          // free-text, markdown-rendered in UI
  readonly createdAt: string;     // ISO
  readonly editedAt?: string | undefined;
  /** True once the owning agent has read the comment in one of its
   *  turns. UI renders unacked comments with an "unread" affordance. */
  readonly agentAcknowledged?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

export interface TodoItem {
  readonly id: string;            // hex-32 id, globally unique (randomBytes(16).toString('hex'))
  readonly listId: string;        // parent list
  readonly title: string;         // one-line imperative
  readonly description?: string | undefined;
  readonly status: TodoItemStatus;
  /** Fractional index for insert-between reordering. Rebalance when
   *  step size drops below epsilon. */
  readonly order: number;
  readonly createdAt: string;
  readonly updatedAt: string;     // bumped on any mutation
  readonly completedAt?: string | undefined;
  /** Required when `status === 'blocked'`; empty string rejected. */
  readonly blockedReason?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  /** Agent-opaque structured metadata. JSON-serialisable. The framework
   *  never interprets this -- creating agent owns the shape. */
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  /** Append-only user comments on this item. Populated by the RPC
   *  layer on read -- storage is a separate table. */
  readonly comments?: readonly TodoComment[] | undefined;
}

// ---------------------------------------------------------------------------
// Transfer history
// ---------------------------------------------------------------------------

export interface TodoTransfer {
  readonly from: TodoOwner;
  readonly to: TodoOwner;
  readonly reason: string;
  readonly at: string;            // ISO timestamp
  /** If the handoff was triggered by a handler (e.g. brainstorm's
   *  post-save handoff-proposal flow), `initiator` records that.
   *  Defaults to `from`. */
  readonly initiator?: TodoOwner | undefined;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface TodoList {
  readonly id: string;
  readonly sessionId: string;
  /** Parent in the list tree. Must share sessionId; must not form a
   *  cycle. `null` / undefined means root. */
  readonly parentListId?: string | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: TodoListStatus;
  /** Current owner family -- the only family allowed to mutate the
   *  list right now. */
  readonly owner: TodoOwner;
  /** Original creator. Preserved across transfers so the audit
   *  trail survives. */
  readonly source: TodoOwner;
  /** Ownership history, oldest first. Every `transfer` call appends
   *  one entry; create seeds the first entry. */
  readonly transfers: readonly TodoTransfer[];
  /** Optional agent-authored narrative above the items. Rendered
   *  read-only in the UI. */
  readonly body?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly TodoItem[];
}

// ---------------------------------------------------------------------------
// Cleanup filter (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Structured filter for `todos.cleanup`. Filters AND together; at
 * least one filter must be non-empty (no unbounded delete-everything).
 * See plans/todo-framework.md for safety rails around age-only
 * queries.
 */
export interface TodoCleanupQuery {
  readonly sessionIds?: readonly string[];
  readonly updatedBefore?: string;        // ISO
  readonly olderThanDays?: number;
  readonly statuses?: readonly TodoListStatus[];
  readonly sources?: readonly TodoOwner[];
  readonly dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Size caps (Phase 2 RPC validation) -- shared so browser can prevalidate
// before an RPC round-trip.
// ---------------------------------------------------------------------------

export const TODO_LIMITS = {
  /** Maximum items per list. */
  MAX_ITEMS_PER_LIST: 200,
  /** Maximum lists per session. */
  MAX_LISTS_PER_SESSION: 50,
  /** Maximum byte length of `TodoList.body`. */
  MAX_LIST_BODY_BYTES: 32 * 1024,
  /** Maximum byte length of `TodoItem.description`. */
  MAX_ITEM_DESCRIPTION_BYTES: 8 * 1024,
  /** Maximum byte length of `TodoComment.body`. */
  MAX_COMMENT_BODY_BYTES: 8 * 1024,
} as const;

// ---------------------------------------------------------------------------
// Fractional ordering helpers
// ---------------------------------------------------------------------------

/**
 * Return a fractional key strictly between `prev` and `next`.
 * - If `prev` and `next` are both defined, returns their midpoint.
 * - If only `prev` is defined (append), returns `prev + 1`.
 * - If only `next` is defined (prepend), returns `next - 1`.
 * - If neither is defined (first item), returns `0`.
 *
 * Callers that hit numeric precision limits (difference below a
 * small epsilon) must issue a rebalance of the entire list's order
 * keys; this helper does not do that implicitly.
 */
export function betweenOrderKeys(prev: number | undefined, next: number | undefined): number {
  if (prev !== undefined && next !== undefined) {
    return (prev + next) / 2;
  }
  if (prev !== undefined) return prev + 1;
  if (next !== undefined) return next - 1;
  return 0;
}

/** Precision threshold at which `betweenOrderKeys` callers must rebalance. */
export const ORDER_KEY_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Stream-event shape (Phase 2 -- declared here so browser + daemon share)
// ---------------------------------------------------------------------------

export type TodoStreamEventKind =
  | 'listCreated' | 'listUpdated' | 'listArchived' | 'listDeleted'
  | 'itemCreated' | 'itemUpdated' | 'itemRemoved'
  | 'commentAdded' | 'commentUpdated' | 'commentRemoved';

export interface TodoStreamEvent {
  readonly kind: TodoStreamEventKind;
  /** Full list snapshot accompanying the event. Always present; the
   *  event is "here is the current state" so subscribers can mutate
   *  their cache without a round-trip. */
  readonly list: TodoList;
}

// ---------------------------------------------------------------------------
// TodosApi -- interface only, declared here so the agent framework
// (under agent/framework/) can reference it without importing
// daemon-side modules. The concrete implementation lives in
// `daemon/todos-api.ts` and emits stream events on the in-process bus.
// ---------------------------------------------------------------------------

export interface CreateTodoListOpts {
  readonly sessionId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly body?: string | undefined;
  readonly parentListId?: string | undefined;
}

export interface AddTodoItemOpts {
  readonly title: string;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  /** If set, inserts immediately after the given item. Defaults to append. */
  readonly insertAfterItemId?: string | undefined;
}

export interface TodosApi {
  /** The family that mutations through this instance are attributed to. */
  readonly caller: TodoOwner;

  // -- Reads ----
  listForSession(sessionId: string, opts?: { includeArchived?: boolean }): Promise<readonly TodoList[]>;
  getList(listId: string): Promise<TodoList | null>;
  getItem(itemId: string): Promise<TodoItem | null>;
  listCommentsForItem(itemId: string): Promise<readonly TodoComment[]>;

  // -- List writes ----
  createList(opts: CreateTodoListOpts): Promise<TodoList>;
  updateListTitle(listId: string, title: string): Promise<TodoList>;
  updateListBody(listId: string, body: string): Promise<TodoList>;
  archive(listId: string): Promise<TodoList>;
  unarchive(listId: string): Promise<TodoList>;
  transfer(listId: string, to: TodoOwner, reason: string): Promise<TodoList>;
  reparent(listId: string, newParentListId: string | null): Promise<TodoList>;

  // -- Item writes ----
  addItem(listId: string, opts: AddTodoItemOpts): Promise<TodoItem>;
  markInProgress(itemId: string): Promise<TodoItem>;
  markComplete(itemId: string): Promise<TodoItem>;
  markBlocked(itemId: string, reason: string): Promise<TodoItem>;
  markCancelled(itemId: string): Promise<TodoItem>;
  updateItemTitle(itemId: string, title: string): Promise<TodoItem>;
  updateItemDescription(itemId: string, description: string): Promise<TodoItem>;
  removeItem(itemId: string): Promise<void>;

  // -- Comments ----
  ackComment(commentId: string): Promise<TodoComment>;
}
