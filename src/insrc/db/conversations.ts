/**
 * DuckDB persistence for conversation sessions + turns
 * (plans/storage-migration-duckdb.md Phase B.6).
 *
 * Two tables on the storage pool:
 *
 *   conversation_session — one row per session. Owned by chat / agent
 *     controllers; lifecycle status (active / paused / completed /
 *     discarded). 30-day TTL + 20-per-repo cap enforced by
 *     `pruneConversations`.
 *   conversation_turn — persistent turn store. Turns survive session
 *     close and are compacted over time via tiered compression
 *     (`tier`, `type`, `compacted_at`, `source_ids`).
 *
 * Both tables carry an `embedding FLOAT[N]` column with an HNSW
 * cosine index (B.3 schema); `seedFromPrior` and `searchTurnsByRepo`
 * route through it.
 *
 * Surface preserved verbatim from the LanceDB era so callers
 * (daemon/index.ts, daemon/chat-sessions.ts, db/compaction.ts,
 * cli/commands/conversation.ts) require no changes. The
 * `resetTableCaches` no-op is kept for back-compat -- table-handle
 * caching is an artifact of the LanceDB layer.
 */

import { arrayValue, type DuckDBArrayValue } from '@duckdb/node-api';
import type { DbClient } from './client.js';
import { loadConfig } from '../agent/config.js';

const EMBEDDING_DIM = loadConfig().models.providers.local.embeddingDim;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConversationEntryType = 'turn' | 'directive' | 'summary' | 'merged';
export type ConversationTier = 'hot' | 'warm' | 'cold' | 'archive';
export type SessionStatus = 'active' | 'paused' | 'completed' | 'discarded';

export interface SessionRecord {
  id: string;
  repo: string;
  summary: string;
  seenEntities: string[];
  createdAt: string;
  expiresAt: string;
  agent: string;
  category: string;
  status: SessionStatus;
  lastActivityAt: string;
  vector: number[];
}

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

export interface ConversationStats {
  totalTurns: number;
  byType: Record<string, number>;
  byTier: Record<string, number>;
  byRepo: Record<string, number>;
  sessions: number;
}

export interface SessionSummary {
  id: string;
  repo: string;
  summary: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * DuckDB returns FLOAT[N] columns as `{ items: number[] }` (the
 * DuckDBArrayValue runtime shape). Unwrap to plain number[]; null
 * becomes [] (rows without an embedding).
 */
function unwrapEmbedding(raw: unknown): number[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw as number[];
  const inner = (raw as { items?: unknown }).items;
  return Array.isArray(inner) ? (inner as number[]) : [];
}

function bindEmbedding(vec: number[]): DuckDBArrayValue | null {
  return vec.length === EMBEDDING_DIM ? arrayValue(vec) : null;
}

function parseJsonStringArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function rowToSessionRecord(row: Record<string, unknown>): SessionRecord {
  return {
    id:             row['id']               as string,
    repo:           (row['repo']            as string) ?? '',
    summary:        (row['summary']         as string) ?? '',
    seenEntities:   parseJsonStringArray(row['seen_entities'] as string),
    createdAt:      (row['created_at']      as string) ?? '',
    expiresAt:      (row['expires_at']      as string) ?? '',
    agent:          (row['agent']           as string) ?? 'chat',
    category:       (row['category']        as string) ?? '',
    status:         (row['status']          as SessionStatus) ?? 'completed',
    lastActivityAt: (row['last_activity_at'] as string) ?? (row['created_at'] as string) ?? '',
    vector:         unwrapEmbedding(row['embedding']),
  };
}

function rowToTurnRecord(row: Record<string, unknown>): TurnRecord {
  return {
    sessionId:   (row['session_id']  as string) ?? '',
    idx:         Number(row['idx']   ?? 0),
    user:        (row['user_text']   as string) ?? '',
    assistant:   (row['assistant']   as string) ?? '',
    entities:    parseJsonStringArray(row['entities'] as string),
    vector:      unwrapEmbedding(row['embedding']),
    repo:        (row['repo']        as string) ?? '',
    type:        ((row['type']       as string) ?? 'turn') as ConversationEntryType,
    tier:        ((row['tier']       as string) ?? 'hot') as ConversationTier,
    compactedAt: (row['compacted_at'] as string) ?? '',
    sourceIds:   parseJsonStringArray(row['source_ids'] as string),
    createdAt:   (row['created_at'] as string) ?? '',
    format:      (row['format'] as string | undefined) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Turn writes
// ---------------------------------------------------------------------------

/**
 * Save a single turn. Called fire-and-forget from the daemon after
 * each recordTurn(). Bumps the session's lastActivityAt so the Runs
 * sidebar can sort live chat sessions to the top even when they
 * haven't checkpointed yet (plans/session-lifecycle.md Phase 1).
 */
export async function saveTurn(db: DbClient, turn: TurnRecord): Promise<void> {
  const id = `${turn.sessionId}:${turn.idx}`;
  await db.duck.exec(
    `INSERT INTO conversation_turn
       (id, session_id, idx, user_text, assistant, entities, created_at, repo,
        type, tier, compacted_at, source_ids, format, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       user_text    = excluded.user_text,
       assistant    = excluded.assistant,
       entities     = excluded.entities,
       compacted_at = excluded.compacted_at,
       source_ids   = excluded.source_ids,
       format       = excluded.format,
       embedding    = excluded.embedding`,
    [
      id,
      turn.sessionId,
      turn.idx,
      turn.user,
      turn.assistant,
      JSON.stringify(turn.entities),
      new Date().toISOString(),
      turn.repo,
      turn.type ?? 'turn',
      turn.tier ?? 'hot',
      turn.compactedAt ?? '',
      JSON.stringify(turn.sourceIds ?? []),
      turn.format ?? 'text',
      bindEmbedding(turn.vector),
    ],
  );

  try {
    await bumpSessionActivity(db, turn.sessionId);
  } catch {
    // ignore -- legacy turn write without a session row
  }
}

/**
 * Add compacted turn entries (output of the compaction pass).
 * Same row shape as `saveTurn` but with sensible defaults that
 * differentiate compacted entries (`type: 'merged'`, `tier: 'cold'`,
 * `compacted_at: now`).
 */
export async function addCompactedTurns(db: DbClient, turns: TurnRecord[]): Promise<void> {
  if (turns.length === 0) return;
  const now = new Date().toISOString();
  for (const t of turns) {
    const id = `${t.sessionId}:${t.idx}`;
    await db.duck.exec(
      `INSERT INTO conversation_turn
         (id, session_id, idx, user_text, assistant, entities, created_at, repo,
          type, tier, compacted_at, source_ids, format, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_text = excluded.user_text, assistant = excluded.assistant,
         entities = excluded.entities, type = excluded.type,
         tier = excluded.tier, compacted_at = excluded.compacted_at,
         source_ids = excluded.source_ids, embedding = excluded.embedding`,
      [
        id, t.sessionId, t.idx, t.user, t.assistant,
        JSON.stringify(t.entities),
        now, t.repo,
        t.type ?? 'merged',
        t.tier ?? 'cold',
        now,
        JSON.stringify(t.sourceIds ?? []),
        t.format ?? 'text',
        bindEmbedding(t.vector),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Session writes
// ---------------------------------------------------------------------------

/**
 * Close a session: persist the final summary. Raw turns are retained
 * for compaction and cross-session L3b hydration. Upsert because the
 * session row may have been created at chat.start.
 */
export async function closeSession(
  db: DbClient,
  session: { id: string; repo: string; summary: string; seenEntities: string[] },
  summaryVector: number[],
): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();

  const existing = await db.duck.query<{ id: string }>(
    'SELECT id FROM conversation_session WHERE id = ?',
    [session.id],
  );
  if (existing.length > 0) {
    await db.duck.exec(
      `UPDATE conversation_session
         SET summary = ?, seen_entities = ?, expires_at = ?,
             status = 'completed', last_activity_at = ?
       WHERE id = ?`,
      [session.summary, JSON.stringify(session.seenEntities), expiresAt, now, session.id],
    );
  } else {
    await db.duck.exec(
      `INSERT INTO conversation_session
         (id, repo, summary, seen_entities, created_at, expires_at,
          agent, category, status, last_activity_at, embedding)
       VALUES (?, ?, ?, ?, ?, ?, 'chat', '', 'completed', ?, ?)`,
      [
        session.id, session.repo, session.summary,
        JSON.stringify(session.seenEntities),
        now, expiresAt, now,
        bindEmbedding(summaryVector),
      ],
    );
  }
}

/**
 * Upsert a session record. Called on first turn (create) and on
 * title generation (update summary). Optional vector lets callers
 * stamp the embedding alongside the create path.
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
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();

  const existing = await db.duck.query<{ id: string }>(
    'SELECT id FROM conversation_session WHERE id = ?',
    [session.id],
  );

  if (existing.length > 0) {
    const sets: string[] = ['summary = ?', 'last_activity_at = ?'];
    const params: unknown[] = [session.summary, now];
    if (session.agent    !== undefined) { sets.push('agent = ?');    params.push(session.agent); }
    if (session.category !== undefined) { sets.push('category = ?'); params.push(session.category); }
    if (session.status   !== undefined) { sets.push('status = ?');   params.push(session.status); }
    params.push(session.id);
    await db.duck.exec(
      `UPDATE conversation_session SET ${sets.join(', ')} WHERE id = ?`,
      params as never[],
    );
  } else {
    await db.duck.exec(
      `INSERT INTO conversation_session
         (id, repo, summary, seen_entities, created_at, expires_at,
          agent, category, status, last_activity_at, embedding)
       VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id, session.repo, session.summary,
        now, expiresAt,
        session.agent ?? 'chat',
        session.category ?? '',
        session.status ?? 'active',
        now,
        vector !== undefined ? bindEmbedding(vector) : null,
      ],
    );
  }
}

/**
 * Stamp the session's controller id and sub-category. Called after
 * classifier + sub-classifier resolve. No-op if the row doesn't
 * exist yet.
 */
export async function setSessionAgent(
  db: DbClient,
  id: string,
  agent: string,
  category?: string,
): Promise<void> {
  if (category !== undefined) {
    await db.duck.exec(
      'UPDATE conversation_session SET agent = ?, category = ?, last_activity_at = ? WHERE id = ?',
      [agent, category, new Date().toISOString(), id],
    );
  } else {
    await db.duck.exec(
      'UPDATE conversation_session SET agent = ?, last_activity_at = ? WHERE id = ?',
      [agent, new Date().toISOString(), id],
    );
  }
}

/** Update the session's lifecycle status. */
export async function setSessionStatus(
  db: DbClient,
  id: string,
  status: SessionStatus,
): Promise<void> {
  await db.duck.exec(
    'UPDATE conversation_session SET status = ?, last_activity_at = ? WHERE id = ?',
    [status, new Date().toISOString(), id],
  );
}

/** Bump `last_activity_at` without touching other fields. */
export async function bumpSessionActivity(db: DbClient, id: string): Promise<void> {
  await db.duck.exec(
    'UPDATE conversation_session SET last_activity_at = ? WHERE id = ?',
    [new Date().toISOString(), id],
  );
}

/**
 * Hard-delete a session row + all its turns. Returns counts so
 * `agent.discard` can log what was cleaned up.
 */
export async function deleteSession(
  db: DbClient,
  sessionId: string,
): Promise<{ sessionRows: number; turnRows: number }> {
  const sessionsRows = await db.duck.query<{ count: number }>(
    'SELECT COUNT(*)::INTEGER AS count FROM conversation_session WHERE id = ?',
    [sessionId],
  );
  const sessionRows = Number(sessionsRows[0]?.count ?? 0);
  if (sessionRows > 0) {
    await db.duck.exec('DELETE FROM conversation_session WHERE id = ?', [sessionId]);
  }

  const turnsRows = await db.duck.query<{ count: number }>(
    'SELECT COUNT(*)::INTEGER AS count FROM conversation_turn WHERE session_id = ?',
    [sessionId],
  );
  const turnRows = Number(turnsRows[0]?.count ?? 0);
  if (turnRows > 0) {
    await db.duck.exec('DELETE FROM conversation_turn WHERE session_id = ?', [sessionId]);
  }

  return { sessionRows, turnRows };
}

// ---------------------------------------------------------------------------
// Cross-session seeding
// ---------------------------------------------------------------------------

/**
 * Top-K prior session summaries for the same repo, ranked by cosine
 * distance to the opening message embedding, then re-sorted by
 * recency. Drops expired summaries.
 */
export async function seedFromPrior(
  db: DbClient,
  repo: string,
  queryVector: number[],
  limit = 3,
): Promise<SessionRecord[]> {
  if (queryVector.length === 0) return [];
  const now = new Date().toISOString();
  try {
    const rows = await db.duck.query(
      `SELECT * FROM conversation_session
       WHERE repo = ? AND expires_at > ? AND embedding IS NOT NULL
       ORDER BY array_distance(embedding, ?::FLOAT[${queryVector.length}])
       LIMIT ?`,
      [repo, now, arrayValue(queryVector), limit],
    );
    const records = rows.map(rowToSessionRecord);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deletion helpers
// ---------------------------------------------------------------------------

export async function deleteTurnsForSession(db: DbClient, sessionId: string): Promise<void> {
  await db.duck.exec('DELETE FROM conversation_turn WHERE session_id = ?', [sessionId]);
}

export async function deleteSessionRecord(db: DbClient, sessionId: string): Promise<void> {
  await db.duck.exec('DELETE FROM conversation_session WHERE id = ?', [sessionId]);
}

export async function deleteSessionsForRepo(db: DbClient, repo: string): Promise<void> {
  await db.duck.exec('DELETE FROM conversation_session WHERE repo = ?', [repo]);
}

export async function deleteTurnsForRepo(db: DbClient, repo: string): Promise<void> {
  await db.duck.exec('DELETE FROM conversation_turn WHERE repo = ?', [repo]);
}

export async function deleteTurnsByIds(db: DbClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  await db.duck.exec(
    `DELETE FROM conversation_turn WHERE id IN (${placeholders})`,
    [...ids],
  );
}

// ---------------------------------------------------------------------------
// Pruning -- expired + per-repo cap
// ---------------------------------------------------------------------------

const PER_REPO_CAP = 20;

export async function pruneConversations(
  db: DbClient,
): Promise<{ expired: number; capped: number }> {
  const now = new Date().toISOString();

  const expiredRow = await db.duck.query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM conversation_session WHERE expires_at < ?",
    [now],
  );
  const expired = Number(expiredRow[0]?.count ?? 0);
  if (expired > 0) {
    await db.duck.exec('DELETE FROM conversation_session WHERE expires_at < ?', [now]);
  }

  // Per-repo cap. A window function picks the rows that go beyond
  // the cap (oldest first), then we delete by id.
  const overflow = await db.duck.query<{ id: string }>(
    `WITH ranked AS (
       SELECT id,
              ROW_NUMBER() OVER (PARTITION BY repo ORDER BY created_at DESC) AS rn
       FROM conversation_session
     )
     SELECT id FROM ranked WHERE rn > ?`,
    [PER_REPO_CAP],
  );
  let capped = 0;
  if (overflow.length > 0) {
    const placeholders = overflow.map(() => '?').join(', ');
    await db.duck.exec(
      `DELETE FROM conversation_session WHERE id IN (${placeholders})`,
      overflow.map(r => r.id),
    );
    capped = overflow.length;
  }
  return { expired, capped };
}

// ---------------------------------------------------------------------------
// Reads -- turns + sessions
// ---------------------------------------------------------------------------

export async function searchTurnsByRepo(
  db: DbClient,
  repo: string,
  queryVector: number[],
  limit = 20,
): Promise<TurnRecord[]> {
  if (queryVector.length === 0) return [];
  try {
    const rows = await db.duck.query(
      `SELECT * FROM conversation_turn
       WHERE repo = ? AND type IN ('turn', 'directive', 'merged') AND embedding IS NOT NULL
       ORDER BY array_distance(embedding, ?::FLOAT[${queryVector.length}])
       LIMIT ?`,
      [repo, arrayValue(queryVector), limit],
    );
    return rows.map(rowToTurnRecord);
  } catch {
    return [];
  }
}

export async function getAllTurnsForRepo(
  db: DbClient,
  repo: string,
): Promise<TurnRecord[]> {
  const rows = await db.duck.query(
    'SELECT * FROM conversation_turn WHERE repo = ?',
    [repo],
  );
  return rows.map(rowToTurnRecord);
}

export async function getAllTurns(db: DbClient): Promise<TurnRecord[]> {
  const rows = await db.duck.query('SELECT * FROM conversation_turn');
  return rows.map(rowToTurnRecord);
}

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

  const sessionsRow = repo
    ? await db.duck.query<{ count: number }>(
        'SELECT COUNT(*)::INTEGER AS count FROM conversation_session WHERE repo = ?',
        [repo],
      )
    : await db.duck.query<{ count: number }>(
        'SELECT COUNT(*)::INTEGER AS count FROM conversation_session',
      );
  const sessions = Number(sessionsRow[0]?.count ?? 0);

  return { totalTurns: turns.length, byType, byTier, byRepo, sessions };
}

// ---------------------------------------------------------------------------
// Session restore queries
// ---------------------------------------------------------------------------

export async function getSessionById(
  db: DbClient,
  sessionId: string,
): Promise<SessionRecord | null> {
  const rows = await db.duck.query(
    'SELECT * FROM conversation_session WHERE id = ?',
    [sessionId],
  );
  if (rows.length === 0) return null;
  return rowToSessionRecord(rows[0]!);
}

export async function getTurnsForSession(
  db: DbClient,
  sessionId: string,
): Promise<TurnRecord[]> {
  const rows = await db.duck.query(
    `SELECT * FROM conversation_turn
     WHERE session_id = ? AND type = 'turn'
     ORDER BY idx`,
    [sessionId],
  );
  return rows.map(rowToTurnRecord);
}

export async function listSessions(
  db: DbClient,
  repo?: string | undefined,
): Promise<SessionSummary[]> {
  const rows = repo !== undefined
    ? await db.duck.query(
        `SELECT id, repo, summary, created_at FROM conversation_session
         WHERE repo = ? ORDER BY created_at DESC`,
        [repo],
      )
    : await db.duck.query(
        `SELECT id, repo, summary, created_at FROM conversation_session
         ORDER BY created_at DESC`,
      );
  return rows.map(r => ({
    id:        r['id']         as string,
    repo:      r['repo']       as string,
    summary:   r['summary']    as string,
    createdAt: r['created_at'] as string,
  }));
}

/**
 * Return full SessionRecord rows, optionally filtered by repo and/or
 * status. Used by `agent.list` so the Runs sidebar can key on the
 * DB-authoritative agent + status + last_activity_at fields without
 * parsing checkpoint files.
 */
export async function listSessionRecords(
  db: DbClient,
  opts?: { repo?: string; statuses?: SessionStatus[] },
): Promise<SessionRecord[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts?.repo !== undefined) {
    conds.push('repo = ?');
    params.push(opts.repo);
  }
  if (opts?.statuses && opts.statuses.length > 0) {
    const placeholders = opts.statuses.map(() => '?').join(', ');
    conds.push(`status IN (${placeholders})`);
    params.push(...opts.statuses);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = await db.duck.query(
    `SELECT * FROM conversation_session
     ${where}
     ORDER BY COALESCE(NULLIF(last_activity_at, ''), created_at) DESC`,
    params as never[],
  );
  return rows.map(rowToSessionRecord);
}

/**
 * Reset module-level table caches. No-op in the DuckDB era -- table
 * handles aren't cached. Kept for back-compat with daemon test
 * harnesses that called the Lance version.
 */
export function resetTableCaches(): void {
  // intentionally empty
}
