import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from 'apache-arrow';
import type { Table } from '@lancedb/lancedb';
import type { DbClient } from './client.js';
import { loadConfig } from '../agent/config.js';

// ---------------------------------------------------------------------------
// LanceDB tables for conversation persistence.
//
// conversation_sessions — one row per closed session, retained for cross-
//   session seeding. Pruned by 30-day TTL and 20-per-repo cap.
//
// conversation_turns — persistent turn store. Turns survive session close
//   and are compacted over time via tiered compression.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Entry types and tiers for compaction
// ---------------------------------------------------------------------------

export type ConversationEntryType = 'turn' | 'directive' | 'summary' | 'merged';
export type ConversationTier = 'hot' | 'warm' | 'cold' | 'archive';

const EMBEDDING_DIM = loadConfig().models.providers.local.embeddingDim;
const ZERO_VEC = new Array<number>(EMBEDDING_DIM).fill(0);

const SESSIONS_SCHEMA = new Schema([
  new Field('id',             new Utf8(), false),
  new Field('repo',           new Utf8(), false),
  new Field('summary',        new Utf8(), false),
  new Field('seenEntities',   new Utf8(), false), // JSON-encoded string[]
  new Field('createdAt',      new Utf8(), false),
  new Field('expiresAt',      new Utf8(), false),
  // Session lifecycle metadata (plans/session-lifecycle.md Phase 1).
  // `agent` + `category` identify which controller owns the session
  // so Resume + Runs sidebar don't need to parse checkpoint state.
  // `status` transitions active -> paused (checkpoint written) ->
  // completed (pipeline finished) or discarded (explicit user action).
  // `lastActivityAt` bumps on every checkpoint / turn so the sidebar
  // can sort by recency.
  new Field('agent',          new Utf8(), false),
  new Field('category',       new Utf8(), false),
  new Field('status',         new Utf8(), false),
  new Field('lastActivityAt', new Utf8(), false),
  new Field('vector', new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32(), true)), false),
]);

const TURNS_SCHEMA = new Schema([
  new Field('id',          new Utf8(),  false), // sessionId:idx
  new Field('sessionId',   new Utf8(),  false),
  new Field('idx',         new Int32(), false),
  new Field('user',        new Utf8(),  false),
  new Field('assistant',   new Utf8(),  false),
  new Field('entities',    new Utf8(),  false), // JSON-encoded string[]
  new Field('createdAt',   new Utf8(),  false),
  new Field('repo',        new Utf8(),  false), // repo path for per-repo queries
  new Field('type',        new Utf8(),  false), // 'turn' | 'directive' | 'summary' | 'merged'
  new Field('tier',        new Utf8(),  false), // 'hot' | 'warm' | 'cold' | 'archive'
  new Field('compactedAt', new Utf8(),  false), // ISO timestamp, empty if not compacted
  new Field('sourceIds',   new Utf8(),  false), // JSON string[] of merged source turn IDs
  new Field('format',      new Utf8(),  false), // 'text' | 'markdown' | 'html' | 'code' | 'diff'
  new Field('vector', new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32(), true)), false),
]);

// ---------------------------------------------------------------------------
// Table accessors (module-level cache)
// ---------------------------------------------------------------------------

let _sessionsTable: Table | null = null;
let _turnsTable: Table | null = null;

async function getSessionsTable(db: DbClient): Promise<Table> {
  if (_sessionsTable !== null) return _sessionsTable;
  const names = await db.lance.tableNames();
  if (names.includes('conversation_sessions')) {
    _sessionsTable = await db.lance.openTable('conversation_sessions');
    // Migrate: add session-lifecycle columns if absent (matches the
    // `format` migration on the turns table). Safe on repeat startup --
    // addColumns no-ops when the column already exists.
    const schema = await _sessionsTable.schema();
    const have = new Set(schema.fields.map((f: { name: string }) => f.name));
    const additions: Array<{ name: string; valueSql: string }> = [];
    if (!have.has('agent'))          additions.push({ name: 'agent',          valueSql: "''" });
    if (!have.has('category'))       additions.push({ name: 'category',       valueSql: "''" });
    if (!have.has('status'))         additions.push({ name: 'status',         valueSql: "'completed'" });
    if (!have.has('lastActivityAt')) additions.push({ name: 'lastActivityAt', valueSql: "''" });
    if (additions.length > 0) {
      await _sessionsTable.addColumns(additions);
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _sessionsTable = await (db.lance as any).createEmptyTable('conversation_sessions', SESSIONS_SCHEMA);
  }
  return _sessionsTable!;
}

async function getTurnsTable(db: DbClient): Promise<Table> {
  if (_turnsTable !== null) return _turnsTable;
  const names = await db.lance.tableNames();
  if (names.includes('conversation_turns')) {
    _turnsTable = await db.lance.openTable('conversation_turns');
    // Migrate: add 'format' column if missing (added after initial schema)
    const schema = await _turnsTable.schema();
    const hasFormat = schema.fields.some((f: { name: string }) => f.name === 'format');
    if (!hasFormat) {
      await _turnsTable.addColumns([{ name: 'format', valueSql: "'text'" }]);
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _turnsTable = await (db.lance as any).createEmptyTable('conversation_turns', TURNS_SCHEMA);
  }
  return _turnsTable!;
}

// ---------------------------------------------------------------------------
// Session record type
// ---------------------------------------------------------------------------

/** Lifecycle states for `sessions.status`. */
export type SessionStatus = 'active' | 'paused' | 'completed' | 'discarded';

export interface SessionRecord {
  id: string;
  repo: string;
  summary: string;
  seenEntities: string[];
  createdAt: string;
  expiresAt: string;
  /** Controller that owns this session (brainstorm / designer / planner / chat). */
  agent: string;
  /** Sub-category for agents that have them (design / requirements / ...). */
  category: string;
  /** Lifecycle status. */
  status: SessionStatus;
  /** ISO timestamp -- last time state was bumped (checkpoint write, turn save). */
  lastActivityAt: string;
  vector: number[];
}

// ---------------------------------------------------------------------------
// Turn persistence
// ---------------------------------------------------------------------------

export interface TurnRecord {
  sessionId: string;
  idx: number;
  user: string;
  assistant: string;
  entities: string[];
  vector: number[];
  repo: string;
  type?: ConversationEntryType | undefined;
  tier?: ConversationTier | undefined;
  compactedAt?: string | undefined;
  sourceIds?: string[] | undefined;
  createdAt?: string | undefined;
  format?: string | undefined;
}

/**
 * Save a single turn to the conversation_turns table.
 * Called after each recordTurn() via daemon RPC (fire-and-forget).
 */
export async function saveTurn(db: DbClient, turn: TurnRecord): Promise<void> {
  const table = await getTurnsTable(db);
  await table.add([{
    id:          `${turn.sessionId}:${turn.idx}`,
    sessionId:   turn.sessionId,
    idx:         turn.idx,
    user:        turn.user,
    assistant:   turn.assistant,
    entities:    JSON.stringify(turn.entities),
    createdAt:   new Date().toISOString(),
    repo:        turn.repo,
    type:        turn.type ?? 'turn',
    tier:        turn.tier ?? 'hot',
    compactedAt: turn.compactedAt ?? '',
    sourceIds:   JSON.stringify(turn.sourceIds ?? []),
    format:      turn.format ?? 'text',
    vector:      turn.vector.length === EMBEDDING_DIM ? turn.vector : ZERO_VEC,
  }]);

  // Bump the session's lastActivityAt so the Runs sidebar sorts live
  // chat sessions to the top even when they haven't checkpointed
  // (plans/session-lifecycle.md Phase 1). Best-effort -- missing
  // session row just means this is a legacy pre-Phase-1 turn write.
  try {
    await bumpSessionActivity(db, turn.sessionId);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Session close — promote summary, retain raw turns
// ---------------------------------------------------------------------------

/**
 * Close a session: persist the final summary to conversation_sessions.
 * Raw turns are retained for compaction and cross-session L3b hydration.
 */
export async function closeSession(
  db: DbClient,
  session: { id: string; repo: string; summary: string; seenEntities: string[] },
  summaryVector: number[],
): Promise<void> {
  const sessionsTable = await getSessionsTable(db);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString(); // 30 days

  // Upsert semantics -- the session row was likely written at chat.start
  // (plans/session-lifecycle.md Phase 1), so we need to update summary +
  // seenEntities + vector + status rather than add a duplicate.
  const existing = await sessionsTable.query()
    .filter(`id = '${session.id.replace(/'/g, "''")}'`)
    .toArray();
  if (existing.length > 0) {
    await sessionsTable.update(
      {
        summary:        session.summary,
        seenEntities:   JSON.stringify(session.seenEntities),
        expiresAt,
        status:         'completed',
        lastActivityAt: now,
      },
      { where: `id = '${session.id.replace(/'/g, "''")}'` },
    );
  } else {
    await sessionsTable.add([{
      id:             session.id,
      repo:           session.repo,
      summary:        session.summary,
      seenEntities:   JSON.stringify(session.seenEntities),
      createdAt:      now,
      expiresAt:      expiresAt,
      agent:          'chat',
      category:       '',
      status:         'completed',
      lastActivityAt: now,
      vector:         summaryVector.length === EMBEDDING_DIM ? summaryVector : ZERO_VEC,
    }]);
  }

  // Raw turns are retained — compaction manages lifecycle
}

/**
 * Save or update a session record (upsert).
 * Called on first turn to create the record, and on title generation to update summary.
 */
export async function saveSession(
  db: DbClient,
  session: {
    id: string;
    repo: string;
    summary: string;
    agent?: string;
    category?: string;
    status?: SessionStatus;
  },
  vector?: number[] | undefined,
): Promise<void> {
  const sessionsTable = await getSessionsTable(db);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();

  // Check if session already exists
  const existing = await sessionsTable.query()
    .filter(`id = '${session.id}'`)
    .toArray();

  if (existing.length > 0) {
    // Update summary (callers that pass agent/category/status update
    // them too; the dedicated setters below are the preferred entry
    // for those fields so a no-op callsite doesn't accidentally wipe).
    const updates: Record<string, string> = {
      summary:        session.summary,
      lastActivityAt: now,
    };
    if (session.agent !== undefined)    updates['agent']    = session.agent;
    if (session.category !== undefined) updates['category'] = session.category;
    if (session.status !== undefined)   updates['status']   = session.status;
    await sessionsTable.update(updates, { where: `id = '${session.id}'` });
  } else {
    // Create new
    await sessionsTable.add([{
      id:             session.id,
      repo:           session.repo,
      summary:        session.summary,
      seenEntities:   '[]',
      createdAt:      now,
      expiresAt,
      agent:          session.agent ?? 'chat',
      category:       session.category ?? '',
      status:         session.status ?? 'active',
      lastActivityAt: now,
      vector:         vector && vector.length === EMBEDDING_DIM ? vector : ZERO_VEC,
    }]);
  }
}

/**
 * Stamp the session's controller id and sub-category. Called after
 * classifier + sub-classifier resolve (e.g. from `resolveController`
 * when brainstorm is picked). No-op if the row doesn't exist yet.
 */
export async function setSessionAgent(
  db: DbClient,
  id: string,
  agent: string,
  category?: string,
): Promise<void> {
  const sessionsTable = await getSessionsTable(db);
  const updates: Record<string, string> = {
    agent,
    lastActivityAt: new Date().toISOString(),
  };
  if (category !== undefined) updates['category'] = category;
  await sessionsTable.update(updates, { where: `id = '${id}'` });
}

/**
 * Update the session's lifecycle status. Emitted from:
 *  - Pipeline: `paused` on checkpoint write, `completed` on clean exit.
 *  - Discard: `discarded` before the row is removed.
 *  - Resume: `active` when the pipeline restarts.
 */
export async function setSessionStatus(
  db: DbClient,
  id: string,
  status: SessionStatus,
): Promise<void> {
  const sessionsTable = await getSessionsTable(db);
  await sessionsTable.update(
    { status, lastActivityAt: new Date().toISOString() },
    { where: `id = '${id}'` },
  );
}

/** Bump `lastActivityAt` without touching other fields. */
export async function bumpSessionActivity(db: DbClient, id: string): Promise<void> {
  const sessionsTable = await getSessionsTable(db);
  await sessionsTable.update(
    { lastActivityAt: new Date().toISOString() },
    { where: `id = '${id}'` },
  );
}

/**
 * Phase 4 hard delete (plans/session-lifecycle.md). Removes the
 * session row, all turns with the matching sessionId, and returns
 * counts so `agent.discard` can log what was cleaned up.
 *
 * Kept separate from `setSessionStatus('discarded', id)` because
 * discard is permanent -- the caller should only reach here after
 * the user confirmed "permanently delete this run" in the UI.
 */
export async function deleteSession(
  db: DbClient,
  sessionId: string,
): Promise<{ sessionRows: number; turnRows: number }> {
  const safeId = sessionId.replace(/'/g, "''");
  const sessionsTable = await getSessionsTable(db);
  const turnsTable = await getTurnsTable(db);

  const sessionRows = (await sessionsTable.query().filter(`id = '${safeId}'`).toArray()).length;
  if (sessionRows > 0) {
    await sessionsTable.delete(`id = '${safeId}'`);
  }

  const turnRows = (await turnsTable.query().filter(`sessionId = '${safeId}'`).toArray()).length;
  if (turnRows > 0) {
    await turnsTable.delete(`sessionId = '${safeId}'`);
  }

  return { sessionRows, turnRows };
}

// ---------------------------------------------------------------------------
// Cross-session seeding
// ---------------------------------------------------------------------------

/**
 * Search prior session summaries for the same repo, ordered by vector
 * similarity to the opening message embedding. Returns top-3 non-expired
 * summaries sorted by recency.
 */
export async function seedFromPrior(
  db: DbClient,
  repo: string,
  queryVector: number[],
  limit = 3,
): Promise<SessionRecord[]> {
  const table = await getSessionsTable(db);
  const now = new Date().toISOString();
  const safeRepo = repo.replace(/'/g, "''");

  try {
    const rows = await table
      .search(queryVector)
      .where(`repo = '${safeRepo}' AND expiresAt > '${now}'`)
      .limit(limit)
      .toArray();

    const records = rows.map(rowToSessionRecord);
    // Sort by recency (vector search returns by similarity)
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deletion helpers
// ---------------------------------------------------------------------------

/** Delete all raw turns for a session. */
export async function deleteTurnsForSession(db: DbClient, sessionId: string): Promise<void> {
  const table = await getTurnsTable(db);
  const safeId = sessionId.replace(/'/g, "''");
  try {
    await table.delete(`sessionId = '${safeId}'`);
  } catch {
    // Table may be empty — ignore
  }
}

/** Delete a session summary by ID. */
export async function deleteSessionRecord(db: DbClient, sessionId: string): Promise<void> {
  const table = await getSessionsTable(db);
  const safeId = sessionId.replace(/'/g, "''");
  try {
    await table.delete(`id = '${safeId}'`);
  } catch {
    // Ignore if not found
  }
}

/** Delete all session summaries for a repo (for /forget). */
export async function deleteSessionsForRepo(db: DbClient, repo: string): Promise<void> {
  const table = await getSessionsTable(db);
  const safeRepo = repo.replace(/'/g, "''");
  try {
    await table.delete(`repo = '${safeRepo}'`);
  } catch {
    // Ignore if not found
  }
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Delete expired session summaries and enforce per-repo cap of 20.
 * Plan/PlanStep nodes are NOT affected — they live in Kuzu only.
 */
export async function pruneConversations(db: DbClient): Promise<{ expired: number; capped: number }> {
  const table = await getSessionsTable(db);
  let expired = 0;
  let capped = 0;

  // 1. Delete expired summaries
  const now = new Date().toISOString();
  try {
    const expiredRows = await table.query().where(`expiresAt < '${now}'`).select(['id']).toArray();
    expired = expiredRows.length;
    if (expired > 0) {
      await table.delete(`expiresAt < '${now}'`);
    }
  } catch {
    // Table may be empty
  }

  // 2. Cap at 20 summaries per repo
  try {
    const allSessions = await table.query().toArray();
    const byRepo = new Map<string, Array<Record<string, unknown>>>();
    for (const row of allSessions) {
      const repo = row['repo'] as string;
      if (!byRepo.has(repo)) byRepo.set(repo, []);
      byRepo.get(repo)!.push(row as Record<string, unknown>);
    }

    for (const [, sessions] of byRepo) {
      if (sessions.length <= 20) continue;
      sessions.sort((a, b) =>
        (b['createdAt'] as string).localeCompare(a['createdAt'] as string),
      );
      const toDelete = sessions.slice(20);
      for (const row of toDelete) {
        const safeId = (row['id'] as string).replace(/'/g, "''");
        await table.delete(`id = '${safeId}'`);
        capped++;
      }
    }
  } catch {
    // Ignore errors during cap enforcement
  }

  return { expired, capped };
}

// ---------------------------------------------------------------------------
// Turn search (for L3b hydration and compaction)
// ---------------------------------------------------------------------------

/**
 * Search turns by repo using vector similarity.
 * Returns turns ordered by relevance to the query vector.
 */
export async function searchTurnsByRepo(
  db: DbClient,
  repo: string,
  queryVector: number[],
  limit = 20,
): Promise<TurnRecord[]> {
  const table = await getTurnsTable(db);
  const safeRepo = repo.replace(/'/g, "''");

  try {
    const rows = await table
      .search(queryVector)
      .where(`repo = '${safeRepo}' AND type IN ('turn', 'directive', 'merged')`)
      .limit(limit)
      .toArray();

    return rows.map(rowToTurnRecord);
  } catch {
    return [];
  }
}

/**
 * Get all turns for a repo (for compaction). No vector search — returns all.
 */
export async function getAllTurnsForRepo(
  db: DbClient,
  repo: string,
): Promise<TurnRecord[]> {
  const table = await getTurnsTable(db);
  const safeRepo = repo.replace(/'/g, "''");

  try {
    const rows = await table.query().where(`repo = '${safeRepo}'`).toArray();
    return rows.map(rowToTurnRecord);
  } catch {
    return [];
  }
}

/**
 * Get all turns across all repos (for compaction without repo filter).
 */
export async function getAllTurns(db: DbClient): Promise<TurnRecord[]> {
  const table = await getTurnsTable(db);
  try {
    const rows = await table.query().toArray();
    return rows.map(rowToTurnRecord);
  } catch {
    return [];
  }
}

/**
 * Delete specific turns by ID.
 */
export async function deleteTurnsByIds(db: DbClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const table = await getTurnsTable(db);
  const idList = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
  try {
    await table.delete(`id IN (${idList})`);
  } catch {
    // Ignore errors
  }
}

/**
 * Add compacted turn entries (for compaction output).
 */
export async function addCompactedTurns(db: DbClient, turns: TurnRecord[]): Promise<void> {
  if (turns.length === 0) return;
  const table = await getTurnsTable(db);
  await table.add(turns.map(t => ({
    id:          `${t.sessionId}:${t.idx}`,
    sessionId:   t.sessionId,
    idx:         t.idx,
    user:        t.user,
    assistant:   t.assistant,
    entities:    JSON.stringify(t.entities),
    createdAt:   new Date().toISOString(),
    repo:        t.repo,
    type:        t.type ?? 'merged',
    tier:        t.tier ?? 'cold',
    compactedAt: new Date().toISOString(),
    sourceIds:   JSON.stringify(t.sourceIds ?? []),
    vector:      t.vector.length === EMBEDDING_DIM ? t.vector : ZERO_VEC,
  })));
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface ConversationStats {
  totalTurns: number;
  byType: Record<string, number>;
  byTier: Record<string, number>;
  byRepo: Record<string, number>;
  sessions: number;
}

/**
 * Get conversation storage statistics for monitoring.
 */
export async function getConversationStats(
  db: DbClient,
  repo?: string,
): Promise<ConversationStats> {
  const turns = repo ? await getAllTurnsForRepo(db, repo) : await getAllTurns(db);

  const byType: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const byRepo: Record<string, number> = {};

  for (const t of turns) {
    const type = t.type ?? 'turn';
    const tier = t.tier ?? 'hot';
    byType[type] = (byType[type] ?? 0) + 1;
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    byRepo[t.repo] = (byRepo[t.repo] ?? 0) + 1;
  }

  const sessionsTable = await getSessionsTable(db);
  let sessions = 0;
  try {
    const allSessions = await sessionsTable.query().toArray();
    sessions = repo
      ? allSessions.filter(s => (s['repo'] as string) === repo).length
      : allSessions.length;
  } catch { /* ignore */ }

  return { totalTurns: turns.length, byType, byTier, byRepo, sessions };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToTurnRecord(row: Record<string, unknown>): TurnRecord {
  let entities: string[] = [];
  try {
    const raw = row['entities'] as string;
    if (raw) entities = JSON.parse(raw) as string[];
  } catch { /* ignore */ }

  let sourceIds: string[] = [];
  try {
    const raw = row['sourceIds'] as string;
    if (raw) sourceIds = JSON.parse(raw) as string[];
  } catch { /* ignore */ }

  return {
    sessionId:   (row['sessionId']   as string) ?? '',
    idx:         (row['idx']         as number) ?? 0,
    user:        (row['user']        as string) ?? '',
    assistant:   (row['assistant']   as string) ?? '',
    entities,
    vector:      (row['vector']      as number[]) ?? [],
    repo:        (row['repo']        as string) ?? '',
    type:        ((row['type']       as string) ?? 'turn') as ConversationEntryType,
    tier:        ((row['tier']       as string) ?? 'hot') as ConversationTier,
    compactedAt: (row['compactedAt'] as string) ?? '',
    sourceIds,
    createdAt:   (row['createdAt']   as string) ?? '',
    format:      (row['format']      as string) ?? undefined,
  };
}

function rowToSessionRecord(row: Record<string, unknown>): SessionRecord {
  let seenEntities: string[] = [];
  try {
    const raw = row['seenEntities'] as string;
    if (raw) seenEntities = JSON.parse(raw) as string[];
  } catch { /* ignore */ }

  return {
    id:             row['id']             as string,
    repo:           row['repo']           as string,
    summary:        row['summary']        as string,
    seenEntities,
    createdAt:      row['createdAt']      as string,
    expiresAt:      row['expiresAt']      as string,
    agent:          (row['agent']          as string | undefined) ?? 'chat',
    category:       (row['category']       as string | undefined) ?? '',
    status:         ((row['status']        as string | undefined) ?? 'completed') as SessionStatus,
    lastActivityAt: (row['lastActivityAt'] as string | undefined) ?? (row['createdAt'] as string),
    vector:         (row['vector']         as number[]) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Session listing (for TreeView)
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  repo: string;
  summary: string;
  createdAt: string;
}

/**
 * List all sessions, optionally filtered by repo.
 * Returns newest-first, with only the fields needed for display.
 */
// ---------------------------------------------------------------------------
// Session restore queries
// ---------------------------------------------------------------------------

/** Get a single session record by ID. Returns null if not found. */
export async function getSessionById(
  db: DbClient,
  sessionId: string,
): Promise<SessionRecord | null> {
  const table = await getSessionsTable(db);
  const rows = await table.query()
    .where(`id = '${sessionId.replace(/'/g, "''")}'`)
    .toArray();
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    id: row['id'] as string,
    repo: row['repo'] as string,
    summary: row['summary'] as string,
    seenEntities: JSON.parse((row['seenEntities'] as string) || '[]') as string[],
    createdAt: row['createdAt'] as string,
    expiresAt: row['expiresAt'] as string,
    agent:          (row['agent']          as string | undefined) ?? 'chat',
    category:       (row['category']       as string | undefined) ?? '',
    status:         ((row['status']        as string | undefined) ?? 'completed') as SessionStatus,
    lastActivityAt: (row['lastActivityAt'] as string | undefined) ?? (row['createdAt'] as string),
    vector: row['vector'] as number[],
  };
}

/** Get all turns for a specific session, ordered by idx. */
export async function getTurnsForSession(
  db: DbClient,
  sessionId: string,
): Promise<TurnRecord[]> {
  const table = await getTurnsTable(db);
  const rows = await table.query()
    .where(`sessionId = '${sessionId.replace(/'/g, "''")}'`)
    .toArray();
  return rows
    .map(row => ({
      sessionId: row['sessionId'] as string,
      idx: row['idx'] as number,
      user: row['user'] as string,
      assistant: row['assistant'] as string,
      entities: JSON.parse((row['entities'] as string) || '[]') as string[],
      vector: row['vector'] as number[],
      repo: row['repo'] as string,
      type: (row['type'] as ConversationEntryType) || 'turn',
      tier: (row['tier'] as ConversationTier) || 'hot',
      format: (row['format'] as string) || 'text',
    }))
    .filter(t => t.type === 'turn')
    .sort((a, b) => a.idx - b.idx);
}

export async function listSessions(
  db: DbClient,
  repo?: string | undefined,
): Promise<SessionSummary[]> {
  const table = await getSessionsTable(db);
  const rows = await table.query().toArray();
  const sessions: SessionSummary[] = rows
    .filter(row => !repo || (row['repo'] as string) === repo)
    .map(row => ({
      id: row['id'] as string,
      repo: row['repo'] as string,
      summary: row['summary'] as string,
      createdAt: row['createdAt'] as string,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return sessions;
}

/**
 * Return full SessionRecord rows, optionally filtered by repo and/or
 * status. Used by `agent.list` (plans/session-lifecycle.md Phase 2)
 * so the Runs sidebar can key on the DB-authoritative agent + status
 * + lastActivityAt fields without parsing checkpoint files.
 */
export async function listSessionRecords(
  db: DbClient,
  opts?: { repo?: string; statuses?: SessionStatus[] },
): Promise<SessionRecord[]> {
  const table = await getSessionsTable(db);
  const rows = await table.query().toArray();
  const statusSet = opts?.statuses ? new Set<string>(opts.statuses) : undefined;
  const out = rows
    .filter(row => !opts?.repo || (row['repo'] as string) === opts.repo)
    .filter(row => {
      if (!statusSet) return true;
      const rowStatus = (row['status'] as string | undefined) ?? 'completed';
      return statusSet.has(rowStatus);
    })
    .map(row => rowToSessionRecord(row))
    .sort((a, b) => (b.lastActivityAt || b.createdAt).localeCompare(a.lastActivityAt || a.createdAt));
  return out;
}

/** Reset module-level table caches (for testing). */
export function resetTableCaches(): void {
  _sessionsTable = null;
  _turnsTable = null;
}
