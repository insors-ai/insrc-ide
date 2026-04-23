/**
 * TodosApi -- typed in-process wrapper over the todos DB layer for
 * daemon-side callers (controllers + agent framework steps).
 *
 * Surfaces the same set of mutations as the `todos.*` RPCs in
 * `todos-rpc.ts` but without the RPC hop. Every instance is bound to
 * a single `caller` family id at construction; methods stamp
 * `owner` / `source` automatically so callers can't accidentally
 * write under another family's authority.
 *
 * Stream events from this path land on the same event bus the RPC
 * layer uses, so subscribed clients see every mutation whether it
 * originated from the browser (RPC) or from an agent (this module).
 *
 * Not to be confused with `todos-rpc.ts`:
 *   - `todos-rpc.ts` is the wire surface (JSON-RPC over Unix socket)
 *     that the browser talks to. Every mutation takes an explicit
 *     `caller` param, defaulting to `'user'`.
 *   - `todos-api.ts` (this file) is the in-process surface that
 *     daemon-side code (controllers, agent steps) uses. No RPC hop;
 *     `caller` is baked into the instance at construction.
 */

import { randomBytes } from 'node:crypto';
import type { DbClient } from '../db/client.js';
import type {
  TodoComment, TodoItem, TodoList, TodoOwner, TodoStreamEventKind,
} from '../shared/todos.js';
import { isAgentFamily } from '../shared/agent-registry.js';
import * as todos from '../db/todos.js';
import { emitTodosEvent } from './todos-rpc.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface CreateListOpts {
  readonly sessionId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly body?: string | undefined;
  readonly parentListId?: string | undefined;
}

export interface AddItemOpts {
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

  // -- Reads (no caller restriction) -----------------------------------------
  listForSession(sessionId: string, opts?: { includeArchived?: boolean }): Promise<readonly TodoList[]>;
  getList(listId: string): Promise<TodoList | null>;
  getItem(itemId: string): Promise<TodoItem | null>;

  // -- List writes -----------------------------------------------------------
  createList(opts: CreateListOpts): Promise<TodoList>;
  updateListTitle(listId: string, title: string): Promise<TodoList>;
  updateListBody(listId: string, body: string): Promise<TodoList>;
  archive(listId: string): Promise<TodoList>;
  unarchive(listId: string): Promise<TodoList>;
  /** Hand ownership to another family. Caller must currently own the list. */
  transfer(listId: string, to: TodoOwner, reason: string): Promise<TodoList>;
  /** Move a list under a different parent (or to root with `null`). */
  reparent(listId: string, newParentListId: string | null): Promise<TodoList>;

  // -- Item writes -----------------------------------------------------------
  addItem(listId: string, opts: AddItemOpts): Promise<TodoItem>;
  markInProgress(itemId: string): Promise<TodoItem>;
  markComplete(itemId: string): Promise<TodoItem>;
  markBlocked(itemId: string, reason: string): Promise<TodoItem>;
  markCancelled(itemId: string): Promise<TodoItem>;
  updateItemTitle(itemId: string, title: string): Promise<TodoItem>;
  updateItemDescription(itemId: string, description: string): Promise<TodoItem>;
  removeItem(itemId: string): Promise<void>;

  // -- Comments --
  listCommentsForItem(itemId: string): Promise<readonly TodoComment[]>;
  /**
   * Mark a user-authored comment as acknowledged. Caller must own the
   * parent list. Used by agents to signal "I've processed this comment"
   * after handling it on a turn -- the UI shows unacked comments with
   * a visual cue until this runs.
   */
  ackComment(commentId: string): Promise<TodoComment>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a TodosApi instance bound to a specific caller family. Throws
 * immediately if `caller` is not a recognised family id -- catching
 * bad callers at construction time means every method can assume a
 * valid caller without re-checking.
 *
 * Prefer constructing once per controller run (in the deps assembly
 * point) and reusing the instance across the whole run so stream
 * events always carry the same attribution.
 */
export function makeTodosApi(db: DbClient, caller: TodoOwner): TodosApi {
  if (!isAgentFamily(caller)) {
    throw new Error(`makeTodosApi: caller '${caller}' is not a registered agent family`);
  }
  return new TodosApiImpl(db, caller);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class TodosApiImpl implements TodosApi {
  constructor(
    private readonly db: DbClient,
    public readonly caller: TodoOwner,
  ) {}

  // -- Reads ----------------------------------------------------------------

  listForSession(
    sessionId: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<readonly TodoList[]> {
    const listOpts: { includeArchived?: boolean } = {};
    if (opts.includeArchived !== undefined) listOpts.includeArchived = opts.includeArchived;
    return todos.listListsBySession(this.db, sessionId, listOpts);
  }

  getList(listId: string): Promise<TodoList | null> {
    return todos.getList(this.db, listId);
  }

  getItem(itemId: string): Promise<TodoItem | null> {
    return todos.getItem(this.db, itemId);
  }

  // -- List writes ----------------------------------------------------------

  async createList(opts: CreateListOpts): Promise<TodoList> {
    const insertOpts: todos.InsertListOpts = {
      id: generateId(),
      sessionId: opts.sessionId,
      title: opts.title,
      owner: this.caller,
      source: this.caller,
      createdAt: nowIso(),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.parentListId !== undefined ? { parentListId: opts.parentListId } : {}),
    };
    const list = await todos.insertList(this.db, insertOpts);
    emitTodosEvent('listCreated', list);
    return list;
  }

  async updateListTitle(listId: string, title: string): Promise<TodoList> {
    await this.assertOwnership(listId);
    const updated = await todos.updateList(this.db, listId, { title }, nowIso());
    emitTodosEvent('listUpdated', updated);
    return updated;
  }

  async updateListBody(listId: string, body: string): Promise<TodoList> {
    await this.assertOwnership(listId);
    const updated = await todos.updateList(this.db, listId, { body }, nowIso());
    emitTodosEvent('listUpdated', updated);
    return updated;
  }

  async archive(listId: string): Promise<TodoList> {
    await this.assertOwnership(listId);
    const updated = await todos.updateList(this.db, listId, { status: 'archived' }, nowIso());
    emitTodosEvent('listArchived', updated);
    return updated;
  }

  async unarchive(listId: string): Promise<TodoList> {
    await this.assertOwnership(listId);
    const updated = await todos.updateList(this.db, listId, { status: 'active' }, nowIso());
    emitTodosEvent('listUpdated', updated);
    return updated;
  }

  async transfer(listId: string, to: TodoOwner, reason: string): Promise<TodoList> {
    await this.assertOwnership(listId);
    if (!isAgentFamily(to)) {
      throw new Error(`transfer: unknown target family '${to}'`);
    }
    const updated = await todos.transferList(this.db, listId, to, reason, nowIso(), this.caller);
    emitTodosEvent('listUpdated', updated);
    return updated;
  }

  async reparent(listId: string, newParentListId: string | null): Promise<TodoList> {
    await this.assertOwnership(listId);
    const updated = await todos.reparentList(this.db, listId, newParentListId, nowIso());
    emitTodosEvent('listUpdated', updated);
    return updated;
  }

  // -- Item writes ---------------------------------------------------------

  async addItem(listId: string, opts: AddItemOpts): Promise<TodoItem> {
    await this.assertOwnership(listId);
    const siblings = await todos.listItems(this.db, listId, false);
    const { betweenOrderKeys } = await import('../shared/todos.js');

    let orderKey: number;
    if (opts.insertAfterItemId !== undefined) {
      const idx = siblings.findIndex(s => s.id === opts.insertAfterItemId);
      if (idx < 0) {
        throw new Error(`addItem: insertAfterItemId '${opts.insertAfterItemId}' not found in list`);
      }
      const prev = siblings[idx]!.order;
      const next = idx + 1 < siblings.length ? siblings[idx + 1]!.order : undefined;
      orderKey = betweenOrderKeys(prev, next);
    } else {
      const last = siblings.length > 0 ? siblings[siblings.length - 1]!.order : undefined;
      orderKey = betweenOrderKeys(last, undefined);
    }

    const insertOpts: todos.InsertItemOpts = {
      id: generateId(),
      listId,
      title: opts.title,
      orderKey,
      createdAt: nowIso(),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
      ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    };
    const item = await todos.insertItem(this.db, insertOpts);
    await this.emitItemEvent(listId, 'itemCreated');
    return item;
  }

  markInProgress(itemId: string): Promise<TodoItem> {
    return this.updateItemStatus(itemId, { status: 'in_progress' });
  }

  markComplete(itemId: string): Promise<TodoItem> {
    return this.updateItemStatus(itemId, { status: 'completed' });
  }

  markBlocked(itemId: string, reason: string): Promise<TodoItem> {
    if (reason.trim().length === 0) {
      throw new Error(`markBlocked: reason is required and must be non-empty`);
    }
    return this.updateItemStatus(itemId, { status: 'blocked', blockedReason: reason });
  }

  markCancelled(itemId: string): Promise<TodoItem> {
    return this.updateItemStatus(itemId, { status: 'cancelled' });
  }

  async updateItemTitle(itemId: string, title: string): Promise<TodoItem> {
    const listId = await this.assertItemOwnership(itemId);
    const updated = await todos.updateItem(this.db, itemId, { title }, nowIso());
    await this.emitItemEvent(listId, 'itemUpdated');
    return updated;
  }

  async updateItemDescription(itemId: string, description: string): Promise<TodoItem> {
    const listId = await this.assertItemOwnership(itemId);
    const updated = await todos.updateItem(this.db, itemId, { description }, nowIso());
    await this.emitItemEvent(listId, 'itemUpdated');
    return updated;
  }

  async removeItem(itemId: string): Promise<void> {
    const listId = await this.assertItemOwnership(itemId);
    await todos.deleteItem(this.db, itemId);
    await this.emitItemEvent(listId, 'itemRemoved');
  }

  // -- Comment reads --------------------------------------------------------

  async listCommentsForItem(itemId: string): Promise<readonly TodoComment[]> {
    return todos.listCommentsForItem(this.db, itemId);
  }

  async ackComment(commentId: string): Promise<TodoComment> {
    const existing = await todos.getComment(this.db, commentId);
    if (existing === null) {
      throw new Error(`ackComment: comment '${commentId}' does not exist`);
    }
    const item = await todos.getItem(this.db, existing.itemId);
    if (item === null) {
      throw new Error(`ackComment: parent item '${existing.itemId}' vanished`);
    }
    await this.assertOwnership(item.listId);
    const updated = await todos.updateComment(this.db, commentId, { agentAcknowledged: true });
    await this.emitItemEvent(item.listId, 'commentUpdated');
    return updated;
  }

  // -- Private helpers ------------------------------------------------------

  private async assertOwnership(listId: string): Promise<TodoList> {
    const list = await todos.getList(this.db, listId, { withItems: false });
    if (list === null) {
      throw new Error(`todos: list '${listId}' does not exist`);
    }
    if (list.owner !== this.caller) {
      throw new Error(
        `todos: caller '${this.caller}' cannot mutate list '${listId}' owned by '${list.owner}'`,
      );
    }
    return list;
  }

  private async assertItemOwnership(itemId: string): Promise<string> {
    const item = await todos.getItem(this.db, itemId);
    if (item === null) {
      throw new Error(`todos: item '${itemId}' does not exist`);
    }
    await this.assertOwnership(item.listId);
    return item.listId;
  }

  private async updateItemStatus(
    itemId: string,
    fields: todos.UpdateItemFields,
  ): Promise<TodoItem> {
    const listId = await this.assertItemOwnership(itemId);
    const updated = await todos.updateItem(this.db, itemId, fields, nowIso());
    await this.emitItemEvent(listId, 'itemUpdated');
    return updated;
  }

  private async emitItemEvent(listId: string, kind: TodoStreamEventKind): Promise<void> {
    const list = await todos.getList(this.db, listId);
    if (list !== null) emitTodosEvent(kind, list);
  }
}

// ---------------------------------------------------------------------------
// Helpers (kept module-private)
// ---------------------------------------------------------------------------

function generateId(): string {
  return randomBytes(16).toString('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}
