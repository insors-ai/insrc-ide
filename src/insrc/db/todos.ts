/**
 * LanceDB persistence for the session-scoped TODO framework.
 *
 * See plans/todo-framework.md (Phase 1). Three tables:
 *
 *   todo_lists    -- one row per list, keyed by id. Owns `sessionId` +
 *                    optional `parentListId` (tree within a session).
 *                    Items are stored separately; populated on read.
 *   todo_items    -- one row per item, keyed by id. Foreign key `listId`.
 *   todo_comments -- one row per comment, keyed by id. Foreign key
 *                    `itemId`. Phase 5d uses these; schema lands now so
 *                    daemon boot creates all three tables idempotently.
 *
 * Mirrors the `conversations.ts` pattern: lazy module-level table cache,
 * idempotent create-or-open on startup, SQL-string helper for
 * `table.update()` calls (LanceDB parses string values as SQL
 * expressions, not bind parameters).
 */

import { Schema, Field, Utf8, Float32, FixedSizeList, Float64, Bool } from 'apache-arrow';
import type { Table } from '@lancedb/lancedb';
import type { DbClient } from './client.js';
import { loadConfig } from '../agent/config.js';
import type {
  TodoComment, TodoItem, TodoItemStatus, TodoList, TodoListStatus, TodoOwner,
  TodoTransfer,
} from '../shared/todos.js';
import { canTransitionItem, canTransitionList } from '../shared/todos.js';
import { isAgentFamily } from '../shared/agent-registry.js';

// ---------------------------------------------------------------------------
// LanceDB SQL quoting helper -- same as conversations.ts. `table.update()`
// treats string values as SQL expressions, so every string column value
// must arrive double-quoted with internal single-quotes escaped.
// ---------------------------------------------------------------------------

function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EMBEDDING_DIM = loadConfig().models.providers.local.embeddingDim;
const ZERO_VEC = new Array<number>(EMBEDDING_DIM).fill(0);

const LISTS_SCHEMA = new Schema([
  new Field('id',             new Utf8(),   false),
  new Field('sessionId',      new Utf8(),   false),
  new Field('parentListId',   new Utf8(),   false),  // '' when no parent (root)
  new Field('title',          new Utf8(),   false),
  new Field('description',    new Utf8(),   false),  // '' when unset
  new Field('status',         new Utf8(),   false),  // TodoListStatus
  new Field('owner',          new Utf8(),   false),  // TodoOwner (AgentFamily)
  new Field('source',         new Utf8(),   false),  // TodoOwner, immutable
  new Field('transfersJson',  new Utf8(),   false),  // JSON TodoTransfer[]
  new Field('body',           new Utf8(),   false),  // '' when unset
  new Field('createdAt',      new Utf8(),   false),
  new Field('updatedAt',      new Utf8(),   false),
  new Field('vector', new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32(), true)), false),
]);

const ITEMS_SCHEMA = new Schema([
  new Field('id',             new Utf8(),    false),
  new Field('listId',         new Utf8(),    false),
  new Field('title',          new Utf8(),    false),
  new Field('description',    new Utf8(),    false),  // '' when unset
  new Field('status',         new Utf8(),    false),
  new Field('orderKey',       new Float64(), false),
  new Field('createdAt',      new Utf8(),    false),
  new Field('updatedAt',      new Utf8(),    false),
  new Field('completedAt',    new Utf8(),    false),  // '' when not completed
  new Field('blockedReason',  new Utf8(),    false),
  new Field('tagsJson',       new Utf8(),    false),  // JSON string[]
  new Field('metaJson',       new Utf8(),    false),  // JSON object
  new Field('vector', new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32(), true)), false),
]);

const COMMENTS_SCHEMA = new Schema([
  new Field('id',                 new Utf8(), false),
  new Field('itemId',             new Utf8(), false),
  new Field('author',             new Utf8(), false),  // TodoOwner | 'user'
  new Field('body',               new Utf8(), false),
  new Field('createdAt',          new Utf8(), false),
  new Field('editedAt',           new Utf8(), false),  // '' when never edited
  new Field('agentAcknowledged',  new Bool(), false),
]);

// ---------------------------------------------------------------------------
// Table accessors (module-level cache, mirrors conversations.ts)
// ---------------------------------------------------------------------------

let _listsTable:    Table | null = null;
let _itemsTable:    Table | null = null;
let _commentsTable: Table | null = null;

async function getListsTable(db: DbClient): Promise<Table> {
  if (_listsTable !== null) return _listsTable;
  const names = await db.lance.tableNames();
  if (names.includes('todo_lists')) {
    _listsTable = await db.lance.openTable('todo_lists');
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _listsTable = await (db.lance as any).createEmptyTable('todo_lists', LISTS_SCHEMA);
  }
  return _listsTable!;
}

async function getItemsTable(db: DbClient): Promise<Table> {
  if (_itemsTable !== null) return _itemsTable;
  const names = await db.lance.tableNames();
  if (names.includes('todo_items')) {
    _itemsTable = await db.lance.openTable('todo_items');
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _itemsTable = await (db.lance as any).createEmptyTable('todo_items', ITEMS_SCHEMA);
  }
  return _itemsTable!;
}

async function getCommentsTable(db: DbClient): Promise<Table> {
  if (_commentsTable !== null) return _commentsTable;
  const names = await db.lance.tableNames();
  if (names.includes('todo_comments')) {
    _commentsTable = await db.lance.openTable('todo_comments');
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _commentsTable = await (db.lance as any).createEmptyTable('todo_comments', COMMENTS_SCHEMA);
  }
  return _commentsTable!;
}

/**
 * Called once at daemon startup (see daemon/index.ts) so all three
 * tables exist before anything tries to read from them. Idempotent:
 * tables that already exist are opened, not recreated.
 */
export async function initTodosTables(db: DbClient): Promise<void> {
  await getListsTable(db);
  await getItemsTable(db);
  await getCommentsTable(db);
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

function listRowToDomain(row: Record<string, unknown>, items: readonly TodoItem[]): TodoList {
  const transfers = parseJsonArrayAs<TodoTransfer>(row['transfersJson'] as string);
  const parent = row['parentListId'] as string;
  const description = row['description'] as string;
  const body = row['body'] as string;
  return {
    id:           row['id']        as string,
    sessionId:    row['sessionId'] as string,
    parentListId: parent.length > 0 ? parent : undefined,
    title:        row['title']     as string,
    description:  description.length > 0 ? description : undefined,
    status:       row['status']    as TodoListStatus,
    owner:        row['owner']     as TodoOwner,
    source:       row['source']    as TodoOwner,
    transfers,
    body:         body.length > 0 ? body : undefined,
    createdAt:    row['createdAt'] as string,
    updatedAt:    row['updatedAt'] as string,
    items,
  };
}

function itemRowToDomain(
  row: Record<string, unknown>,
  comments: readonly TodoComment[] | undefined,
): TodoItem {
  const description = row['description'] as string;
  const completedAt = row['completedAt'] as string;
  const blockedReason = row['blockedReason'] as string;
  const tags = parseJsonArrayAs<string>(row['tagsJson'] as string);
  const meta = parseJsonObject(row['metaJson'] as string);
  return {
    id:            row['id']         as string,
    listId:        row['listId']     as string,
    title:         row['title']      as string,
    description:   description.length > 0 ? description : undefined,
    status:        row['status']     as TodoItemStatus,
    order:         row['orderKey']   as number,
    createdAt:     row['createdAt']  as string,
    updatedAt:     row['updatedAt']  as string,
    completedAt:   completedAt.length > 0 ? completedAt : undefined,
    blockedReason: blockedReason.length > 0 ? blockedReason : undefined,
    tags:          tags.length > 0 ? tags : undefined,
    meta:          meta !== undefined ? meta : undefined,
    comments,
  };
}

function commentRowToDomain(row: Record<string, unknown>): TodoComment {
  const editedAt = row['editedAt'] as string;
  return {
    id:                 row['id']                as string,
    itemId:             row['itemId']            as string,
    author:             row['author']            as TodoOwner | 'user',
    body:               row['body']              as string,
    createdAt:          row['createdAt']         as string,
    editedAt:           editedAt.length > 0 ? editedAt : undefined,
    agentAcknowledged:  row['agentAcknowledged'] as boolean,
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
 * a single entry recording the creator, and `updatedAt = createdAt`.
 * Validates owner / source against the family registry; rejects
 * parent cycles (caller is responsible for passing a valid parent
 * that already exists in the same session).
 */
export async function insertList(db: DbClient, opts: InsertListOpts): Promise<TodoList> {
  if (!isAgentFamily(opts.owner)) {
    throw new Error(`insertList: unknown owner family '${opts.owner}'`);
  }
  if (!isAgentFamily(opts.source)) {
    throw new Error(`insertList: unknown source family '${opts.source}'`);
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

  const table = await getListsTable(db);
  await table.add([{
    id:            opts.id,
    sessionId:     opts.sessionId,
    parentListId:  opts.parentListId ?? '',
    title:         opts.title,
    description:   opts.description ?? '',
    status:        'active' satisfies TodoListStatus,
    owner:         opts.owner,
    source:        opts.source,
    transfersJson: JSON.stringify([seedTransfer]),
    body:          opts.body ?? '',
    createdAt:     opts.createdAt,
    updatedAt:     opts.createdAt,
    vector:        ZERO_VEC,
  }]);

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
 * `status = 'pending'` and `updatedAt = createdAt`. Caller picks
 * `orderKey` (use `betweenOrderKeys` from `shared/todos.ts` for
 * insert-between placement).
 */
export async function insertItem(db: DbClient, opts: InsertItemOpts): Promise<TodoItem> {
  const list = await getList(db, opts.listId, { withItems: false });
  if (list === null) {
    throw new Error(`insertItem: list '${opts.listId}' does not exist`);
  }

  const table = await getItemsTable(db);
  await table.add([{
    id:            opts.id,
    listId:        opts.listId,
    title:         opts.title,
    description:   opts.description ?? '',
    status:        'pending' satisfies TodoItemStatus,
    orderKey:      opts.orderKey,
    createdAt:     opts.createdAt,
    updatedAt:     opts.createdAt,
    completedAt:   '',
    blockedReason: '',
    tagsJson:      JSON.stringify(opts.tags ?? []),
    metaJson:      JSON.stringify(opts.meta ?? {}),
    vector:        ZERO_VEC,
  }]);

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
  const table = await getCommentsTable(db);
  await table.add([{
    id:                 opts.id,
    itemId:             opts.itemId,
    author:             opts.author,
    body:               opts.body,
    createdAt:          opts.createdAt,
    editedAt:           '',
    agentAcknowledged:  false,
  }]);

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
  /** Include comments on each included item. Default false. */
  readonly withComments?: boolean;
}

export async function getList(
  db: DbClient,
  listId: string,
  opts: GetListOpts = {},
): Promise<TodoList | null> {
  const table = await getListsTable(db);
  const rows = await table.query().where(`id = ${sqlStr(listId)}`).toArray();
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;

  const items = opts.withItems === false
    ? []
    : await listItems(db, listId, opts.withComments === true);
  return listRowToDomain(row, items);
}

export async function getItem(db: DbClient, itemId: string): Promise<TodoItem | null> {
  const table = await getItemsTable(db);
  const rows = await table.query().where(`id = ${sqlStr(itemId)}`).toArray();
  if (rows.length === 0) return null;
  return itemRowToDomain(rows[0] as Record<string, unknown>, undefined);
}

export async function getComment(db: DbClient, commentId: string): Promise<TodoComment | null> {
  const table = await getCommentsTable(db);
  const rows = await table.query().where(`id = ${sqlStr(commentId)}`).toArray();
  if (rows.length === 0) return null;
  return commentRowToDomain(rows[0] as Record<string, unknown>);
}

/** List all items belonging to a list, ordered by fractional `orderKey`. */
export async function listItems(
  db: DbClient,
  listId: string,
  withComments: boolean,
): Promise<readonly TodoItem[]> {
  const table = await getItemsTable(db);
  const rows = await table.query().where(`listId = ${sqlStr(listId)}`).toArray();
  const typed = (rows as Record<string, unknown>[]).slice().sort((a, b) => {
    const av = a['orderKey'] as number;
    const bv = b['orderKey'] as number;
    return av - bv;
  });

  if (!withComments) {
    return typed.map(r => itemRowToDomain(r, undefined));
  }

  // Batch-load comments for the set of item ids.
  const itemIds = typed.map(r => r['id'] as string);
  const commentsByItem = await listCommentsByItems(db, itemIds);
  return typed.map(r => {
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

  const table = await getCommentsTable(db);
  const inList = itemIds.map(sqlStr).join(', ');
  const rows = await table.query().where(`itemId IN (${inList})`).toArray();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const comment = commentRowToDomain(row);
    const bucket = by.get(comment.itemId) ?? [];
    bucket.push(comment);
    by.set(comment.itemId, bucket);
  }
  // Sort each bucket by createdAt for stable ordering.
  for (const bucket of by.values()) {
    bucket.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return by;
}

/**
 * List every list across all sessions, optionally filtered by status /
 * source / updatedAt cutoff. Used by the retention sweep + any other
 * daemon-side maintenance that walks the full table. Prefer
 * `listListsBySession` when you can -- this one table-scans.
 */
export async function listAllLists(
  db: DbClient,
  filter: {
    readonly statuses?: readonly TodoListStatus[];
    readonly sources?: readonly TodoOwner[];
    /** ISO timestamp -- return lists whose `updatedAt < updatedBefore`. */
    readonly updatedBefore?: string;
  } = {},
): Promise<readonly TodoList[]> {
  const table = await getListsTable(db);

  // Push status / source filters into the WHERE clause; filter by
  // updatedBefore in-memory (LanceDB string comparison on ISO works,
  // but staying in-memory is simpler + covers the '' sentinel edge
  // cases if we ever add them).
  const whereParts: string[] = [];
  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    whereParts.push(`status IN (${filter.statuses.map(sqlStr).join(', ')})`);
  }
  if (filter.sources !== undefined && filter.sources.length > 0) {
    whereParts.push(`source IN (${filter.sources.map(sqlStr).join(', ')})`);
  }
  const query = whereParts.length > 0
    ? table.query().where(whereParts.join(' AND '))
    : table.query();
  const rows = await query.toArray();
  const typed = (rows as Record<string, unknown>[]).filter(r => {
    if (filter.updatedBefore !== undefined && (r['updatedAt'] as string) >= filter.updatedBefore) {
      return false;
    }
    return true;
  });

  const out: TodoList[] = [];
  for (const row of typed) {
    const items = await listItems(db, row['id'] as string, false);
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
  const table = await getListsTable(db);
  const rows = await table.query().where(`sessionId = ${sqlStr(sessionId)}`).toArray();

  const typed = (rows as Record<string, unknown>[]).filter(r => {
    if (opts.includeArchived === true) return true;
    return (r['status'] as string) !== 'archived';
  });

  // Sort: roots first (parentListId == ''), then children, all by createdAt within.
  typed.sort((a, b) => {
    const ar = (a['parentListId'] as string).length === 0 ? 0 : 1;
    const br = (b['parentListId'] as string).length === 0 ? 0 : 1;
    if (ar !== br) return ar - br;
    return (a['createdAt'] as string).localeCompare(b['createdAt'] as string);
  });

  const out: TodoList[] = [];
  for (const row of typed) {
    const items = await listItems(db, row['id'] as string, false);
    out.push(listRowToDomain(row, items));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cycle detection for parent-child hierarchy
// ---------------------------------------------------------------------------

/**
 * Walk up from `proposedParentId` following `parentListId` and reject if
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
  const table = await getListsTable(db);
  const seen = new Set<string>();
  let cursor: string | null = proposedParentId;
  let depth = 0;
  const MAX_DEPTH = 1024;  // guard against pathological data

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

    const rows = await table.query().where(`id = ${sqlStr(cursor)}`).toArray();
    if (rows.length === 0) {
      throw new Error(`parent-missing: list '${cursor}' does not exist`);
    }
    const row = rows[0] as Record<string, unknown>;
    if ((row['sessionId'] as string) !== childSessionId) {
      throw new Error(
        `parent-session-mismatch: parent '${cursor}' is in a different session`,
      );
    }
    const next = row['parentListId'] as string;
    cursor = next.length > 0 ? next : null;
  }
}

// ---------------------------------------------------------------------------
// Update helpers (minimal Phase 1 set; RPC layer in Phase 2 builds on these)
// ---------------------------------------------------------------------------

export interface UpdateListFields {
  readonly title?:       string | undefined;
  readonly description?: string | undefined;
  readonly status?:      TodoListStatus | undefined;
  readonly body?:        string | undefined;
}

/**
 * Patch a list. Validates status transitions against the list-status
 * state machine; rejects illegal arcs. Bumps `updatedAt`.
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

  const updates: Record<string, string> = { updatedAt: sqlStr(now) };
  if (fields.title       !== undefined) updates['title']       = sqlStr(fields.title);
  if (fields.description !== undefined) updates['description'] = sqlStr(fields.description);
  if (fields.status      !== undefined) updates['status']      = sqlStr(fields.status);
  if (fields.body        !== undefined) updates['body']        = sqlStr(fields.body);

  const table = await getListsTable(db);
  await table.update({ where: `id = ${sqlStr(listId)}`, values: updates });

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
 * blocked-requires-reason rule, and sets `completedAt` automatically
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

  const updates: Record<string, string> = { updatedAt: sqlStr(now) };
  if (fields.title         !== undefined) updates['title']         = sqlStr(fields.title);
  if (fields.description   !== undefined) updates['description']   = sqlStr(fields.description);
  if (fields.status        !== undefined) updates['status']        = sqlStr(fields.status);
  if (fields.blockedReason !== undefined) updates['blockedReason'] = sqlStr(fields.blockedReason);
  if (fields.tags          !== undefined) updates['tagsJson']      = sqlStr(JSON.stringify(fields.tags));
  if (fields.meta          !== undefined) updates['metaJson']      = sqlStr(JSON.stringify(fields.meta));
  if (fields.orderKey      !== undefined) updates['orderKey']      = String(fields.orderKey);
  if (fields.status === 'completed') updates['completedAt'] = sqlStr(now);

  const table = await getItemsTable(db);
  await table.update({ where: `id = ${sqlStr(itemId)}`, values: updates });

  const updated = await getItem(db, itemId);
  if (updated === null) throw new Error(`updateItem: item '${itemId}' vanished during update`);
  return updated;
}

/**
 * Transfer a list to a new owner family. Caller-authorization happens
 * at the RPC boundary (Phase 2); this helper just applies the change,
 * appends a transfer history entry, and bumps `updatedAt`.
 */
export async function transferList(
  db: DbClient,
  listId: string,
  to: TodoOwner,
  reason: string,
  now: string,
  initiator?: TodoOwner,
): Promise<TodoList> {
  if (!isAgentFamily(to)) {
    throw new Error(`transferList: unknown target family '${to}'`);
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

  const table = await getListsTable(db);
  await table.update({
    where: `id = ${sqlStr(listId)}`,
    values: {
      owner:         sqlStr(to),
      transfersJson: sqlStr(JSON.stringify(transfers)),
      updatedAt:     sqlStr(now),
    },
  });

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

  const table = await getListsTable(db);
  await table.update({
    where: `id = ${sqlStr(listId)}`,
    values: {
      parentListId: sqlStr(newParentListId ?? ''),
      updatedAt:    sqlStr(now),
    },
  });

  const updated = await getList(db, listId);
  if (updated === null) throw new Error(`reparentList: list '${listId}' vanished during reparent`);
  return updated;
}

// ---------------------------------------------------------------------------
// Delete helpers (used by cleanup + agent.discard -- see Phase 2 / 2b)
// ---------------------------------------------------------------------------

export async function deleteItem(db: DbClient, itemId: string): Promise<void> {
  const table = await getItemsTable(db);
  await table.delete(`id = ${sqlStr(itemId)}`);
  const commentsTable = await getCommentsTable(db);
  await commentsTable.delete(`itemId = ${sqlStr(itemId)}`);
}

export async function deleteList(db: DbClient, listId: string): Promise<void> {
  // Delete all comments on items in this list first.
  const items = await listItems(db, listId, false);
  const commentsTable = await getCommentsTable(db);
  for (const item of items) {
    await commentsTable.delete(`itemId = ${sqlStr(item.id)}`);
  }
  // Delete items, then the list itself.
  const itemsTable = await getItemsTable(db);
  await itemsTable.delete(`listId = ${sqlStr(listId)}`);
  const listsTable = await getListsTable(db);
  await listsTable.delete(`id = ${sqlStr(listId)}`);
}

export async function deleteListsBySession(db: DbClient, sessionId: string): Promise<number> {
  const lists = await listListsBySession(db, sessionId, { includeArchived: true });
  for (const list of lists) {
    await deleteList(db, list.id);
  }
  return lists.length;
}
