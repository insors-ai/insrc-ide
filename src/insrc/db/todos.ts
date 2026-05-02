/**
 * DuckDB persistence for the session-scoped TODO framework.
 *
 * See plans/todo-framework.md (Phase 1) and plans/storage-migration-
 * duckdb.md Phase B.5. Three tables on the storage pool:
 *
 *   todo_list    -- one row per list, keyed by id. Owns `session_id` +
 *                   optional `parent_list_id` (tree within a session).
 *                   Items are stored separately; populated on read.
 *   todo_item    -- one row per item, keyed by id. Foreign key `list_id`.
 *   todo_comment -- one row per comment, keyed by id. Foreign key
 *                   `item_id`.
 *
 * No vector / embedding columns: the B.0 audit confirmed every Lance
 * write zero-filled the vector column and no caller ever queried it,
 * so the migration drops the column entirely.
 *
 * SQL hygiene: every write goes through parameterized statements
 * (`?` positional binding) so we don't need to maintain a sqlStr
 * helper or worry about the LanceDB `values:` vs `valuesSql:`
 * gotcha that bit us repeatedly during the Lance era.
 */

import type { DbClient } from './client.js';
import type {
  TodoComment, TodoItem, TodoItemStatus, TodoList, TodoListStatus, TodoOwner,
  TodoTransfer,
} from '../shared/todos.js';
import { canTransitionItem, canTransitionList } from '../shared/todos.js';
import { isValidTodoOwner } from '../shared/todos.js';

/**
 * Called once at daemon startup. The schema apply already provisions
 * the three tables in `initDb`, so this is just a no-op kept for
 * back-compat with daemon/index.ts. Removing the call sites is a
 * follow-up in Phase B.10 cleanup.
 */
export async function initTodosTables(_db: DbClient): Promise<void> {
  // schema apply happens in db/client.ts initDb -- nothing to do here
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

function listRowToDomain(row: Record<string, unknown>, items: readonly TodoItem[]): TodoList {
  const transfers = parseJsonArrayAs<TodoTransfer>(row['transfers_json'] as string);
  const parent = row['parent_list_id'] as string;
  const description = row['description'] as string;
  const body = row['body'] as string;
  return {
    id:           row['id']         as string,
    sessionId:    row['session_id'] as string,
    parentListId: parent.length > 0 ? parent : undefined,
    title:        row['title']      as string,
    description:  description.length > 0 ? description : undefined,
    status:       row['status']     as TodoListStatus,
    owner:        row['owner']      as TodoOwner,
    source:       row['source']     as TodoOwner,
    transfers,
    body:         body.length > 0 ? body : undefined,
    createdAt:    row['created_at'] as string,
    updatedAt:    row['updated_at'] as string,
    items,
  };
}

function itemRowToDomain(
  row: Record<string, unknown>,
  comments: readonly TodoComment[] | undefined,
): TodoItem {
  const description = row['description'] as string;
  const completedAt = row['completed_at'] as string;
  const blockedReason = row['blocked_reason'] as string;
  const tags = parseJsonArrayAs<string>(row['tags_json'] as string);
  const meta = parseJsonObject(row['meta_json'] as string);
  return {
    id:            row['id']            as string,
    listId:        row['list_id']       as string,
    title:         row['title']         as string,
    description:   description.length > 0 ? description : undefined,
    status:        row['status']        as TodoItemStatus,
    order:         Number(row['order_key']),
    createdAt:     row['created_at']    as string,
    updatedAt:     row['updated_at']    as string,
    completedAt:   completedAt.length > 0 ? completedAt : undefined,
    blockedReason: blockedReason.length > 0 ? blockedReason : undefined,
    tags:          tags.length > 0 ? tags : undefined,
    meta:          meta !== undefined ? meta : undefined,
    comments,
  };
}

function commentRowToDomain(row: Record<string, unknown>): TodoComment {
  const editedAt = row['edited_at'] as string;
  return {
    id:                 row['id']                 as string,
    itemId:             row['item_id']            as string,
    author:             row['author']             as TodoOwner | 'user',
    body:               row['body']               as string,
    createdAt:          row['created_at']         as string,
    editedAt:           editedAt.length > 0 ? editedAt : undefined,
    agentAcknowledged:  row['agent_acknowledged'] as boolean,
  };
}

function parseJsonArrayAs<T>(raw: string): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Insert helpers
// ---------------------------------------------------------------------------

export interface InsertListOpts {
  readonly id:            string;
  readonly sessionId:     string;
  readonly parentListId?: string | undefined;
  readonly title:         string;
  readonly description?:  string | undefined;
  readonly owner:         TodoOwner;
  readonly source:        TodoOwner;
  readonly body?:         string | undefined;
  readonly createdAt:     string;
}

/**
 * Create a new list row. Seeds `status = 'active'`, `transfers` with
 * a single entry recording the creator, and `updated_at = created_at`.
 * Validates owner / source against the family registry; rejects
 * parent cycles (caller is responsible for passing a valid parent
 * that already exists in the same session).
 */
export async function insertList(db: DbClient, opts: InsertListOpts): Promise<TodoList> {
  if (!isValidTodoOwner(opts.owner)) {
    throw new Error(`insertList: unknown owner '${opts.owner}'`);
  }
  if (!isValidTodoOwner(opts.source)) {
    throw new Error(`insertList: unknown source '${opts.source}'`);
  }

  if (opts.parentListId !== undefined) {
    await assertParentAllowed(db, opts.parentListId, opts.id, opts.sessionId);
  }

  const seedTransfer: TodoTransfer = {
    from: opts.source,
    to: opts.owner,
    reason: 'created',
    at: opts.createdAt,
    initiator: opts.source,
  };

  await db.duck.exec(
    `INSERT INTO todo_list
       (id, session_id, parent_list_id, title, description, status, owner, source,
        transfers_json, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.sessionId,
      opts.parentListId ?? '',
      opts.title,
      opts.description ?? '',
      opts.owner,
      opts.source,
      JSON.stringify([seedTransfer]),
      opts.body ?? '',
      opts.createdAt,
      opts.createdAt,
    ],
  );

  const list = await getList(db, opts.id);
  if (list === null) {
    throw new Error(`insertList: failed to read back list '${opts.id}' after insert`);
  }
  return list;
}

export interface InsertItemOpts {
  readonly id:             string;
  readonly listId:         string;
  readonly title:          string;
  readonly description?:   string | undefined;
  readonly orderKey:       number;
  readonly tags?:          readonly string[] | undefined;
  readonly meta?:          Readonly<Record<string, unknown>> | undefined;
  readonly createdAt:      string;
}

/**
 * Create a new item row under an existing list. Seeds
 * `status = 'pending'` and `updated_at = created_at`. Caller picks
 * `order_key` (use `betweenOrderKeys` from `shared/todos.ts` for
 * insert-between placement).
 */
export async function insertItem(db: DbClient, opts: InsertItemOpts): Promise<TodoItem> {
  const list = await getList(db, opts.listId, { withItems: false });
  if (list === null) {
    throw new Error(`insertItem: list '${opts.listId}' does not exist`);
  }

  await db.duck.exec(
    `INSERT INTO todo_item
       (id, list_id, title, description, status, order_key, created_at, updated_at,
        completed_at, blocked_reason, tags_json, meta_json)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, '', '', ?, ?)`,
    [
      opts.id,
      opts.listId,
      opts.title,
      opts.description ?? '',
      opts.orderKey,
      opts.createdAt,
      opts.createdAt,
      JSON.stringify(opts.tags ?? []),
      JSON.stringify(opts.meta ?? {}),
    ],
  );

  const item = await getItem(db, opts.id);
  if (item === null) {
    throw new Error(`insertItem: failed to read back item '${opts.id}' after insert`);
  }
  return item;
}

export interface InsertCommentOpts {
  readonly id:         string;
  readonly itemId:     string;
  readonly author:     TodoOwner | 'user';
  readonly body:       string;
  readonly createdAt:  string;
}

export async function insertComment(db: DbClient, opts: InsertCommentOpts): Promise<TodoComment> {
  await db.duck.exec(
    `INSERT INTO todo_comment
       (id, item_id, author, body, created_at, edited_at, agent_acknowledged)
     VALUES (?, ?, ?, ?, ?, '', FALSE)`,
    [opts.id, opts.itemId, opts.author, opts.body, opts.createdAt],
  );

  const comment = await getComment(db, opts.id);
  if (comment === null) {
    throw new Error(`insertComment: failed to read back comment '${opts.id}' after insert`);
  }
  return comment;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export interface GetListOpts {
  /** Include items on the returned list. Default true. */
  readonly withItems?: boolean;
  /** Include comments on each included item. Default true -- the RPC
   *  layer + browser UI always want comments attached, and the cost is
   *  low (typically 0 rows). Pass `false` explicitly when only the
   *  list shape is needed (e.g. ownership checks). */
  readonly withComments?: boolean;
}

export async function getList(
  db: DbClient,
  listId: string,
  opts: GetListOpts = {},
): Promise<TodoList | null> {
  const rows = await db.duck.query(
    'SELECT * FROM todo_list WHERE id = ?',
    [listId],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;

  const includeComments = opts.withComments !== false;
  const items = opts.withItems === false
    ? []
    : await listItems(db, listId, includeComments);
  return listRowToDomain(row, items);
}

export async function getItem(db: DbClient, itemId: string): Promise<TodoItem | null> {
  const rows = await db.duck.query('SELECT * FROM todo_item WHERE id = ?', [itemId]);
  if (rows.length === 0) return null;
  return itemRowToDomain(rows[0]!, undefined);
}

export async function getComment(db: DbClient, commentId: string): Promise<TodoComment | null> {
  const rows = await db.duck.query('SELECT * FROM todo_comment WHERE id = ?', [commentId]);
  if (rows.length === 0) return null;
  return commentRowToDomain(rows[0]!);
}

/** List all items belonging to a list, ordered by fractional `order_key`. */
export async function listItems(
  db: DbClient,
  listId: string,
  withComments: boolean,
): Promise<readonly TodoItem[]> {
  const rows = await db.duck.query(
    'SELECT * FROM todo_item WHERE list_id = ? ORDER BY order_key',
    [listId],
  );

  if (!withComments) {
    return rows.map(r => itemRowToDomain(r, undefined));
  }

  const itemIds = rows.map(r => r['id'] as string);
  const commentsByItem = await listCommentsByItems(db, itemIds);
  return rows.map(r => {
    const id = r['id'] as string;
    return itemRowToDomain(r, commentsByItem.get(id) ?? []);
  });
}

async function listCommentsByItems(
  db: DbClient,
  itemIds: readonly string[],
): Promise<Map<string, TodoComment[]>> {
  const by = new Map<string, TodoComment[]>();
  if (itemIds.length === 0) return by;

  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = await db.duck.query(
    `SELECT * FROM todo_comment
     WHERE item_id IN (${placeholders})
     ORDER BY created_at`,
    [...itemIds],
  );
  for (const row of rows) {
    const comment = commentRowToDomain(row);
    const bucket = by.get(comment.itemId) ?? [];
    bucket.push(comment);
    by.set(comment.itemId, bucket);
  }
  return by;
}

/**
 * List every list across all sessions, optionally filtered by status /
 * source / updated_at cutoff. Used by the retention sweep + any other
 * daemon-side maintenance that walks the full table. Prefer
 * `listListsBySession` when you can -- this one table-scans.
 */
export async function listAllLists(
  db: DbClient,
  filter: {
    readonly statuses?: readonly TodoListStatus[];
    readonly sources?: readonly TodoOwner[];
    /** ISO timestamp -- return lists whose `updated_at < updatedBefore`. */
    readonly updatedBefore?: string;
  } = {},
): Promise<readonly TodoList[]> {
  const whereParts: string[] = [];
  const params: unknown[] = [];

  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    const placeholders = filter.statuses.map(() => '?').join(', ');
    whereParts.push(`status IN (${placeholders})`);
    params.push(...filter.statuses);
  }
  if (filter.sources !== undefined && filter.sources.length > 0) {
    const placeholders = filter.sources.map(() => '?').join(', ');
    whereParts.push(`source IN (${placeholders})`);
    params.push(...filter.sources);
  }
  if (filter.updatedBefore !== undefined) {
    whereParts.push('updated_at < ?');
    params.push(filter.updatedBefore);
  }

  const where = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
  const rows = await db.duck.query(`SELECT * FROM todo_list ${where}`, params as never[]);

  const out: TodoList[] = [];
  for (const row of rows) {
    const items = await listItems(db, row['id'] as string, true);
    out.push(listRowToDomain(row, items));
  }
  return out;
}

/** List every list in a session, ordered root-first then by creation time. */
export async function listListsBySession(
  db: DbClient,
  sessionId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<readonly TodoList[]> {
  const archivedClause = opts.includeArchived === true
    ? ''
    : "AND status != 'archived'";

  // ORDER BY puts roots (parent_list_id == '') ahead of children, then
  // by createdAt for stable ordering within each level.
  const rows = await db.duck.query(
    `SELECT * FROM todo_list
     WHERE session_id = ? ${archivedClause}
     ORDER BY CASE WHEN parent_list_id = '' THEN 0 ELSE 1 END, created_at`,
    [sessionId],
  );

  const out: TodoList[] = [];
  for (const row of rows) {
    const items = await listItems(db, row['id'] as string, true);
    out.push(listRowToDomain(row, items));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cycle detection for parent-child hierarchy
// ---------------------------------------------------------------------------

/**
 * Walk up from `proposedParentId` following `parent_list_id` and reject if
 * the walk reaches `childId` (would form a cycle). Also rejects if
 * `proposedParentId` doesn't exist or sits in a different session than
 * `childSessionId`. Idempotent: safe to call before every reparent /
 * insert-with-parent op.
 *
 * Throws on any violation. Returns silently on success.
 */
export async function assertParentAllowed(
  db: DbClient,
  proposedParentId: string,
  childId: string,
  childSessionId: string,
): Promise<void> {
  const seen = new Set<string>();
  let cursor: string | null = proposedParentId;
  let depth = 0;
  const MAX_DEPTH = 1024;

  while (cursor !== null) {
    if (cursor === childId) {
      throw new Error(
        `parent-cycle: list '${proposedParentId}' is a descendant of '${childId}'`,
      );
    }
    if (seen.has(cursor)) {
      throw new Error(`parent-cycle: pre-existing cycle detected at '${cursor}'`);
    }
    if (depth++ > MAX_DEPTH) {
      throw new Error(`parent-depth-exceeded: walking '${proposedParentId}' reached max depth`);
    }
    seen.add(cursor);

    const rows: Array<{ session_id: string; parent_list_id: string }> =
      await db.duck.query<{ session_id: string; parent_list_id: string }>(
        'SELECT session_id, parent_list_id FROM todo_list WHERE id = ?',
        [cursor],
      );
    if (rows.length === 0) {
      throw new Error(`parent-missing: list '${cursor}' does not exist`);
    }
    const row = rows[0]!;
    if (row.session_id !== childSessionId) {
      throw new Error(
        `parent-session-mismatch: parent '${cursor}' is in a different session`,
      );
    }
    cursor = row.parent_list_id.length > 0 ? row.parent_list_id : null;
  }
}

// ---------------------------------------------------------------------------
// Update helpers
// ---------------------------------------------------------------------------

export interface UpdateListFields {
  readonly title?:       string | undefined;
  readonly description?: string | undefined;
  readonly status?:      TodoListStatus | undefined;
  readonly body?:        string | undefined;
}

/**
 * Patch a list. Validates status transitions against the list-status
 * state machine; rejects illegal arcs. Bumps `updated_at`.
 */
export async function updateList(
  db: DbClient,
  listId: string,
  fields: UpdateListFields,
  now: string,
): Promise<TodoList> {
  const existing = await getList(db, listId, { withItems: false });
  if (existing === null) {
    throw new Error(`updateList: list '${listId}' does not exist`);
  }

  if (fields.status !== undefined && !canTransitionList(existing.status, fields.status)) {
    throw new Error(
      `updateList: illegal list-status transition '${existing.status}' -> '${fields.status}'`,
    );
  }

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];
  if (fields.title       !== undefined) { sets.push('title = ?');       params.push(fields.title); }
  if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
  if (fields.status      !== undefined) { sets.push('status = ?');      params.push(fields.status); }
  if (fields.body        !== undefined) { sets.push('body = ?');        params.push(fields.body); }
  params.push(listId);

  await db.duck.exec(
    `UPDATE todo_list SET ${sets.join(', ')} WHERE id = ?`,
    params as never[],
  );

  const updated = await getList(db, listId);
  if (updated === null) throw new Error(`updateList: list '${listId}' vanished during update`);
  return updated;
}

export interface UpdateItemFields {
  readonly title?:         string | undefined;
  readonly description?:   string | undefined;
  readonly status?:        TodoItemStatus | undefined;
  readonly blockedReason?: string | undefined;
  readonly tags?:          readonly string[] | undefined;
  readonly meta?:          Readonly<Record<string, unknown>> | undefined;
  readonly orderKey?:      number | undefined;
}

/**
 * Patch an item. Enforces item status transitions, the
 * blocked-requires-reason rule, and sets `completed_at` automatically
 * when status moves to `completed`.
 */
export async function updateItem(
  db: DbClient,
  itemId: string,
  fields: UpdateItemFields,
  now: string,
): Promise<TodoItem> {
  const existing = await getItem(db, itemId);
  if (existing === null) {
    throw new Error(`updateItem: item '${itemId}' does not exist`);
  }

  if (fields.status !== undefined && !canTransitionItem(existing.status, fields.status)) {
    throw new Error(
      `updateItem: illegal item-status transition '${existing.status}' -> '${fields.status}'`,
    );
  }

  if (fields.status === 'blocked') {
    const reason = fields.blockedReason ?? existing.blockedReason ?? '';
    if (reason.trim().length === 0) {
      throw new Error(`updateItem: transition to 'blocked' requires a non-empty blockedReason`);
    }
  }

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];
  if (fields.title         !== undefined) { sets.push('title = ?');          params.push(fields.title); }
  if (fields.description   !== undefined) { sets.push('description = ?');    params.push(fields.description); }
  if (fields.status        !== undefined) { sets.push('status = ?');         params.push(fields.status); }
  if (fields.blockedReason !== undefined) { sets.push('blocked_reason = ?'); params.push(fields.blockedReason); }
  if (fields.tags          !== undefined) { sets.push('tags_json = ?');      params.push(JSON.stringify(fields.tags)); }
  if (fields.meta          !== undefined) { sets.push('meta_json = ?');      params.push(JSON.stringify(fields.meta)); }
  if (fields.orderKey      !== undefined) { sets.push('order_key = ?');      params.push(fields.orderKey); }
  if (fields.status === 'completed') { sets.push('completed_at = ?'); params.push(now); }
  params.push(itemId);

  await db.duck.exec(
    `UPDATE todo_item SET ${sets.join(', ')} WHERE id = ?`,
    params as never[],
  );

  const updated = await getItem(db, itemId);
  if (updated === null) throw new Error(`updateItem: item '${itemId}' vanished during update`);
  return updated;
}

/**
 * Transfer a list to a new owner family. Caller-authorization happens
 * at the RPC boundary (Phase 2); this helper just applies the change,
 * appends a transfer history entry, and bumps `updated_at`.
 */
export async function transferList(
  db: DbClient,
  listId: string,
  to: TodoOwner,
  reason: string,
  now: string,
  initiator?: TodoOwner,
): Promise<TodoList> {
  if (!isValidTodoOwner(to)) {
    throw new Error(`transferList: unknown target owner '${to}'`);
  }
  const existing = await getList(db, listId, { withItems: false });
  if (existing === null) {
    throw new Error(`transferList: list '${listId}' does not exist`);
  }

  const entry: TodoTransfer = {
    from: existing.owner,
    to,
    reason,
    at: now,
    initiator: initiator ?? existing.owner,
  };
  const transfers = [...existing.transfers, entry];

  await db.duck.exec(
    `UPDATE todo_list
     SET owner = ?, transfers_json = ?, updated_at = ?
     WHERE id = ?`,
    [to, JSON.stringify(transfers), now, listId],
  );

  const updated = await getList(db, listId);
  if (updated === null) throw new Error(`transferList: list '${listId}' vanished during transfer`);
  return updated;
}

/**
 * Reparent a list. Pass `null` as `newParentListId` to promote the
 * list to a root. Validates session match + cycle freedom via
 * `assertParentAllowed`.
 */
export async function reparentList(
  db: DbClient,
  listId: string,
  newParentListId: string | null,
  now: string,
): Promise<TodoList> {
  const existing = await getList(db, listId, { withItems: false });
  if (existing === null) {
    throw new Error(`reparentList: list '${listId}' does not exist`);
  }
  if (newParentListId !== null) {
    await assertParentAllowed(db, newParentListId, listId, existing.sessionId);
  }

  await db.duck.exec(
    'UPDATE todo_list SET parent_list_id = ?, updated_at = ? WHERE id = ?',
    [newParentListId ?? '', now, listId],
  );

  const updated = await getList(db, listId);
  if (updated === null) throw new Error(`reparentList: list '${listId}' vanished during reparent`);
  return updated;
}

// ---------------------------------------------------------------------------
// Comment helpers (Phase 5d)
// ---------------------------------------------------------------------------

export interface UpdateCommentFields {
  readonly body?: string | undefined;
  readonly agentAcknowledged?: boolean | undefined;
  /** Caller supplies the editedAt timestamp (bumped on body change). */
  readonly editedAt?: string | undefined;
}

/** Update a comment row. Returns the refreshed comment. */
export async function updateComment(
  db: DbClient,
  commentId: string,
  fields: UpdateCommentFields,
): Promise<TodoComment> {
  const existing = await getComment(db, commentId);
  if (existing === null) {
    throw new Error(`updateComment: comment '${commentId}' does not exist`);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.body              !== undefined) { sets.push('body = ?');               params.push(fields.body); }
  if (fields.editedAt          !== undefined) { sets.push('edited_at = ?');          params.push(fields.editedAt); }
  if (fields.agentAcknowledged !== undefined) { sets.push('agent_acknowledged = ?'); params.push(fields.agentAcknowledged); }
  if (sets.length === 0) return existing;
  params.push(commentId);

  await db.duck.exec(
    `UPDATE todo_comment SET ${sets.join(', ')} WHERE id = ?`,
    params as never[],
  );

  const refreshed = await getComment(db, commentId);
  if (refreshed === null) {
    throw new Error(`updateComment: comment '${commentId}' vanished during update`);
  }
  return refreshed;
}

export async function deleteComment(db: DbClient, commentId: string): Promise<void> {
  await db.duck.exec('DELETE FROM todo_comment WHERE id = ?', [commentId]);
}

/** List every comment on a given item, sorted by created_at ascending. */
export async function listCommentsForItem(
  db: DbClient,
  itemId: string,
): Promise<readonly TodoComment[]> {
  const rows = await db.duck.query(
    'SELECT * FROM todo_comment WHERE item_id = ? ORDER BY created_at',
    [itemId],
  );
  return rows.map(commentRowToDomain);
}

// ---------------------------------------------------------------------------
// Delete helpers
// ---------------------------------------------------------------------------

export async function deleteItem(db: DbClient, itemId: string): Promise<void> {
  await db.duck.exec('DELETE FROM todo_comment WHERE item_id = ?', [itemId]);
  await db.duck.exec('DELETE FROM todo_item WHERE id = ?', [itemId]);
}

export async function deleteList(db: DbClient, listId: string): Promise<void> {
  // Delete comments on items in this list, then items, then the list.
  // No FK constraints in DuckDB tables; ordering matters for atomicity
  // expectations of callers (they don't see dangling rows).
  await db.duck.exec(
    `DELETE FROM todo_comment
     WHERE item_id IN (SELECT id FROM todo_item WHERE list_id = ?)`,
    [listId],
  );
  await db.duck.exec('DELETE FROM todo_item WHERE list_id = ?', [listId]);
  await db.duck.exec('DELETE FROM todo_list WHERE id = ?', [listId]);
}

export async function deleteListsBySession(db: DbClient, sessionId: string): Promise<number> {
  const lists = await listListsBySession(db, sessionId, { includeArchived: true });
  for (const list of lists) {
    await deleteList(db, list.id);
  }
  return lists.length;
}
