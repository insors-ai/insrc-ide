/**
 * Config vector store — DuckDB-backed wrapper for config entries.
 *
 * plans/storage-migration-duckdb.md Phase B.6.
 *
 * Backed by the `config_entry` table on the daemon's storage pool.
 * Vector search uses `array_distance(embedding, ?)` against the
 * cosine HNSW index from B.3. The class shape is preserved so
 * config/search.ts and daemon/index.ts callsites continue to use the
 * same API; only the constructor changes -- callers now pass a
 * `DbClient` instead of a `lancedb.Connection`. The Lance store
 * directory at `~/.insrc/config-store/` is no longer created
 * (B.10 cleanup will remove the path constant).
 */

import { arrayValue } from '@duckdb/node-api';
import type {
  ConfigCategory,
  ConfigEntry,
  ConfigNamespace,
  Language,
} from '../shared/types.js';
import type { DbClient } from '../db/client.js';
import { loadConfig } from '../agent/config.js';
import { formatScope, parseScope } from './paths.js';

const EMBEDDING_DIM = loadConfig().models.providers.local.embeddingDim;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function unwrapEmbedding(raw: unknown): number[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw as number[];
  const inner = (raw as { items?: unknown }).items;
  return Array.isArray(inner) ? (inner as number[]) : [];
}

function rowToConfigEntry(row: Record<string, unknown>): ConfigEntry {
  const tagsRaw = (row['tags'] as string) ?? '';
  return {
    id:          row['id']           as string,
    scope:       parseScope(row['scope'] as string),
    namespace:   row['namespace']    as ConfigNamespace,
    category:    row['category']     as ConfigCategory,
    language:    row['language']     as Language | 'all',
    name:        row['name']         as string,
    filePath:    (row['file_path']    as string) ?? '',
    body:        (row['body']         as string) ?? '',
    tags:        tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
    updatedAt:   (row['updated_at']   as string) ?? '',
    contentHash: (row['content_hash'] as string) ?? '',
    embedding:   unwrapEmbedding(row['embedding']),
  };
}

// ---------------------------------------------------------------------------
// ConfigStore class
// ---------------------------------------------------------------------------

export class ConfigStore {
  private readonly _db: DbClient;

  constructor(db: DbClient) {
    this._db = db;
  }

  /** Upsert a config entry (delete existing by id, then add). */
  async upsertEntry(entry: ConfigEntry): Promise<void> {
    await this._db.duck.exec(
      `INSERT INTO config_entry (
         id, scope, namespace, category, language, name, file_path,
         body, tags, updated_at, content_hash, embedding
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         scope        = excluded.scope,
         namespace    = excluded.namespace,
         category     = excluded.category,
         language     = excluded.language,
         name         = excluded.name,
         file_path    = excluded.file_path,
         body         = excluded.body,
         tags         = excluded.tags,
         updated_at   = excluded.updated_at,
         content_hash = excluded.content_hash,
         embedding    = excluded.embedding`,
      [
        entry.id,
        formatScope(entry.scope),
        entry.namespace,
        entry.category,
        entry.language,
        entry.name,
        entry.filePath,
        entry.body,
        entry.tags.join(','),
        entry.updatedAt,
        entry.contentHash,
        entry.embedding.length === EMBEDDING_DIM ? arrayValue(entry.embedding) : null,
      ],
    );
  }

  /** Delete a config entry by id. */
  async deleteEntry(id: string): Promise<void> {
    await this._db.duck.exec('DELETE FROM config_entry WHERE id = ?', [id]);
  }

  /** Delete all entries matching a scope string ('global' or 'project:/path'). */
  async deleteByScope(scope: string): Promise<void> {
    await this._db.duck.exec('DELETE FROM config_entry WHERE scope = ?', [scope]);
  }

  /** Fetch a single entry by id. */
  async getEntry(id: string): Promise<ConfigEntry | null> {
    const rows = await this._db.duck.query(
      'SELECT * FROM config_entry WHERE id = ?',
      [id],
    );
    if (rows.length === 0) return null;
    return rowToConfigEntry(rows[0]!);
  }

  /** List entries with optional filters. */
  async listEntries(opts?: {
    namespace?: string | undefined;
    category?: string | undefined;
    scope?: string | undefined;
  }): Promise<ConfigEntry[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts?.namespace) { conds.push('namespace = ?'); params.push(opts.namespace); }
    if (opts?.category)  { conds.push('category = ?');  params.push(opts.category); }
    if (opts?.scope)     { conds.push('scope = ?');     params.push(opts.scope); }

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await this._db.duck.query(
      `SELECT * FROM config_entry ${where}`,
      params as never[],
    );
    return rows.map(rowToConfigEntry);
  }

  /**
   * Vector search on config entries.
   * Returns rows with cosine-distance scores -- caller handles ranking
   * / boosting. The optional `where` is a raw SQL fragment built by
   * `config/search.ts` (already escapes its inputs); we splice it
   * straight in so the existing query-construction code stays
   * unchanged.
   */
  async vectorSearch(
    queryVec: number[],
    where?: string | undefined,
    limit = 10,
  ): Promise<Array<{ entry: ConfigEntry; distance: number }>> {
    if (queryVec.length === 0) return [];

    const conditions: string[] = ['embedding IS NOT NULL'];
    if (where) conditions.push(`(${where})`);
    const sql =
      `SELECT *, array_distance(embedding, ?::FLOAT[${queryVec.length}]) AS _distance
       FROM config_entry
       WHERE ${conditions.join(' AND ')}
       ORDER BY _distance
       LIMIT ?`;
    const rows = await this._db.duck.query(
      sql,
      [arrayValue(queryVec), limit] as never[],
    );
    return rows.map(r => ({
      entry: rowToConfigEntry(r),
      distance: Number(r['_distance']),
    }));
  }
}
