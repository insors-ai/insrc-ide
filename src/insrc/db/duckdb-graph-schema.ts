/**
 * DuckDB schema -- the consolidated storage layer for code knowledge
 * graph (Phase A) + vector / row state (Phase B).
 *
 * plans/storage-migration-duckdb.md Phase A.1 + B.3.
 *
 * Architectural decisions:
 *
 * 1. **Single `relation` edge table.** Kuzu (now ripped out) had eight
 *    typed Entity↔Entity relation tables (`CALLS`, `IMPORTS`, ...) plus
 *    plan-graph edges (`CONTAINS`, `STEP_DEPENDS_ON`). All share the
 *    same shape -- directed labeled edges between strings. Collapsing
 *    them into one `relation(src, dst, kind)` table simplifies the
 *    code (adding a new relation kind is a constant, not a DDL change)
 *    and lets DuckDB plan cross-kind queries.
 *
 * 2. **Two indexes on `relation`** -- one forward (`src, kind`) for
 *    "what does X point at" traversal, one reverse (`dst, kind`) for
 *    "what points at X". DuckDB doesn't auto-build these the way Kuzu
 *    did; we declare them explicit so 1-hop queries hit indexed
 *    lookup.
 *
 * 3. **`IF NOT EXISTS` everywhere** -- DDL is idempotent so daemon
 *    restart applies it cleanly whether tables already exist or this
 *    is a cold start.
 *
 * 4. **Embedding column dim is parameterised.** Phase B.3 extends the
 *    entity / conversation_session / conversation_turn / config_entry
 *    tables with a `FLOAT[N]` embedding column where N comes from
 *    `loadConfig().models.providers.local.embeddingDim`. The dim is
 *    bound at table-creation time. If the active embedding model
 *    changes the dim, the affected tables must be dropped + recreated
 *    + re-indexed -- same constraint Lance already imposed. The
 *    daemon's startup path passes the dim through `applyDuckDBSchema`.
 *
 * 5. **HNSW indexes on vector columns.** The `vss` extension (loaded
 *    in `daemon/db/duckdb-pool.ts`) provides the HNSW index type;
 *    cosine metric mirrors what Lance's IVF-PQ used. If `vss` failed
 *    to load at startup the CREATE INDEX statements raise
 *    `Unknown index type: HNSW`. The schema apply surfaces that as a
 *    fatal init error -- vector queries don't have a useful brute-
 *    force fallback at our entity counts.
 */

import { loadConfig } from '../agent/config.js';

/**
 * Build the full DDL list, parameterised on embedding dim. Static
 * statements first (graph, plan) then vector tables.
 *
 * Caller controls the dim; we don't hard-code it so tests can apply
 * a smaller dim and the real apply path picks up the configured one.
 */
export function buildDuckDBSchema(embeddingDim: number): string[] {
  return [
    // -------------------------------------------------------------------
    // Code knowledge graph -- entity (full row, not just stub)
    // -------------------------------------------------------------------
    //
    // Phase A had this as a 2-column stub (id, kind). Phase B.3 expands
    // it to the full Lance schema so vector search + row hydration both
    // happen against the same table. Optional fields use sentinel
    // values (empty string / false) to avoid NULL handling -- mirrors
    // the Lance schema convention.
    `CREATE TABLE IF NOT EXISTS entity (
      id              VARCHAR PRIMARY KEY,
      kind            VARCHAR NOT NULL,
      name            VARCHAR DEFAULT '',
      language        VARCHAR DEFAULT '',
      repo            VARCHAR DEFAULT '',
      file            VARCHAR DEFAULT '',
      start_line      INTEGER DEFAULT 0,
      end_line        INTEGER DEFAULT 0,
      body            VARCHAR DEFAULT '',
      indexed_at      VARCHAR DEFAULT '',
      embedding_model VARCHAR DEFAULT '',
      is_exported     BOOLEAN DEFAULT FALSE,
      is_async        BOOLEAN DEFAULT FALSE,
      is_abstract     BOOLEAN DEFAULT FALSE,
      signature       VARCHAR DEFAULT '',
      hash            VARCHAR DEFAULT '',
      root_path       VARCHAR DEFAULT '',
      artifact        BOOLEAN DEFAULT FALSE,
      embedding       FLOAT[${embeddingDim}]
    )`,
    // Pre-filter / hydration indexes. (repo) is the most common
    // pre-filter on vector search; (file) backs deleteEntitiesForFile.
    'CREATE INDEX IF NOT EXISTS idx_entity_repo     ON entity(repo)',
    'CREATE INDEX IF NOT EXISTS idx_entity_file     ON entity(file)',
    'CREATE INDEX IF NOT EXISTS idx_entity_name     ON entity(name)',
    // HNSW vector index. ef_construction / m are reasonable defaults
    // for ~1M-row tables; perf benchmarking in B.6 may revisit.
    `CREATE INDEX IF NOT EXISTS idx_entity_emb ON entity USING HNSW (embedding) WITH (
       metric = 'cosine',
       ef_construction = 128,
       M = 16
     )`,

    // Repo registry. Renamed columns to snake_case; semantics unchanged.
    `CREATE TABLE IF NOT EXISTS repo (
      id           VARCHAR PRIMARY KEY,
      path         VARCHAR,
      name         VARCHAR,
      added_at     VARCHAR,
      last_indexed VARCHAR,
      status       VARCHAR,
      error_msg    VARCHAR
    )`,

    // Single edge table covering every directed labeled edge in the
    // graph. The `kind` column carries the former Kuzu REL TABLE name:
    //   Entity-to-Entity: DEFINES | IMPORTS | CALLS | INHERITS |
    //                     IMPLEMENTS | DEPENDS_ON | EXPORTS | REFERENCES
    //   Plan→PlanStep:    CONTAINS
    //   Step→Step:        STEP_DEPENDS_ON
    `CREATE TABLE IF NOT EXISTS relation (
      src  VARCHAR NOT NULL,
      dst  VARCHAR NOT NULL,
      kind VARCHAR NOT NULL,
      PRIMARY KEY (src, dst, kind)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_relation_fwd ON relation(src, kind)',
    'CREATE INDEX IF NOT EXISTS idx_relation_rev ON relation(dst, kind)',

    // Cross-file resolver queue.
    `CREATE TABLE IF NOT EXISTS unresolved_relation (
      id           VARCHAR PRIMARY KEY,
      repo         VARCHAR,
      from_entity  VARCHAR,
      from_file    VARCHAR,
      kind         VARCHAR,
      raw_to       VARCHAR,
      meta         VARCHAR,
      attempted_at VARCHAR
    )`,
    'CREATE INDEX IF NOT EXISTS idx_unresolved_file ON unresolved_relation(repo, from_file)',

    // -------------------------------------------------------------------
    // Plan graph (persistent across sessions; not subject to TTL)
    // -------------------------------------------------------------------

    `CREATE TABLE IF NOT EXISTS plan (
      id         VARCHAR PRIMARY KEY,
      repo_path  VARCHAR,
      title      VARCHAR,
      status     VARCHAR,
      created_at VARCHAR,
      updated_at VARCHAR
    )`,

    `CREATE TABLE IF NOT EXISTS plan_step (
      id          VARCHAR PRIMARY KEY,
      plan_id     VARCHAR,
      idx         INTEGER,
      title       VARCHAR,
      description VARCHAR,
      checkpoint  BOOLEAN,
      status      VARCHAR,
      complexity  VARCHAR,
      file_hint   VARCHAR,
      notes       VARCHAR,
      created_at  VARCHAR,
      updated_at  VARCHAR,
      started_at  VARCHAR,
      done_at     VARCHAR
    )`,
    'CREATE INDEX IF NOT EXISTS idx_plan_step_plan ON plan_step(plan_id, idx)',

    // -------------------------------------------------------------------
    // Conversation persistence (Phase B.6 -- migrated from Lance)
    // -------------------------------------------------------------------

    `CREATE TABLE IF NOT EXISTS conversation_session (
      id               VARCHAR PRIMARY KEY,
      repo             VARCHAR DEFAULT '',
      summary          VARCHAR DEFAULT '',
      seen_entities    VARCHAR DEFAULT '[]',
      created_at       VARCHAR DEFAULT '',
      expires_at       VARCHAR DEFAULT '',
      agent            VARCHAR DEFAULT 'chat',
      category         VARCHAR DEFAULT '',
      status           VARCHAR DEFAULT 'completed',
      last_activity_at VARCHAR DEFAULT '',
      embedding        FLOAT[${embeddingDim}]
    )`,
    'CREATE INDEX IF NOT EXISTS idx_session_repo            ON conversation_session(repo)',
    'CREATE INDEX IF NOT EXISTS idx_session_status          ON conversation_session(status)',
    'CREATE INDEX IF NOT EXISTS idx_session_last_activity   ON conversation_session(last_activity_at DESC)',
    `CREATE INDEX IF NOT EXISTS idx_session_emb ON conversation_session USING HNSW (embedding) WITH (
       metric = 'cosine', ef_construction = 128, M = 16
     )`,

    `CREATE TABLE IF NOT EXISTS conversation_turn (
      id           VARCHAR PRIMARY KEY,
      session_id   VARCHAR NOT NULL,
      idx          INTEGER NOT NULL,
      user_text    VARCHAR DEFAULT '',
      assistant    VARCHAR DEFAULT '',
      entities     VARCHAR DEFAULT '[]',
      created_at   VARCHAR DEFAULT '',
      repo         VARCHAR DEFAULT '',
      type         VARCHAR DEFAULT 'turn',
      tier         VARCHAR DEFAULT 'hot',
      compacted_at VARCHAR DEFAULT '',
      source_ids   VARCHAR DEFAULT '[]',
      format       VARCHAR DEFAULT 'text',
      embedding    FLOAT[${embeddingDim}]
    )`,
    'CREATE INDEX IF NOT EXISTS idx_turn_session ON conversation_turn(session_id, idx)',
    'CREATE INDEX IF NOT EXISTS idx_turn_repo    ON conversation_turn(repo)',
    `CREATE INDEX IF NOT EXISTS idx_turn_emb ON conversation_turn USING HNSW (embedding) WITH (
       metric = 'cosine', ef_construction = 128, M = 16
     )`,

    // -------------------------------------------------------------------
    // Config entries (Phase B.6 -- migrated from Lance config-store)
    // -------------------------------------------------------------------

    `CREATE TABLE IF NOT EXISTS config_entry (
      id           VARCHAR PRIMARY KEY,
      scope        VARCHAR DEFAULT '',
      namespace    VARCHAR DEFAULT '',
      category     VARCHAR DEFAULT '',
      language     VARCHAR DEFAULT '',
      name         VARCHAR DEFAULT '',
      file_path    VARCHAR DEFAULT '',
      body         VARCHAR DEFAULT '',
      tags         VARCHAR DEFAULT '',
      updated_at   VARCHAR DEFAULT '',
      content_hash VARCHAR DEFAULT '',
      embedding    FLOAT[${embeddingDim}]
    )`,
    'CREATE INDEX IF NOT EXISTS idx_config_scope     ON config_entry(scope)',
    'CREATE INDEX IF NOT EXISTS idx_config_namespace ON config_entry(namespace)',
    'CREATE INDEX IF NOT EXISTS idx_config_category  ON config_entry(category)',
    `CREATE INDEX IF NOT EXISTS idx_config_emb ON config_entry USING HNSW (embedding) WITH (
       metric = 'cosine', ef_construction = 128, M = 16
     )`,

    // -------------------------------------------------------------------
    // TODO framework (Phase B.5 -- migrated from Lance, NO embedding)
    // -------------------------------------------------------------------
    //
    // Audit (B.0) showed every Lance-side todo write zero-fills the
    // vector column and no caller queries it. Drop the column entirely.
    `CREATE TABLE IF NOT EXISTS todo_list (
      id              VARCHAR PRIMARY KEY,
      session_id      VARCHAR NOT NULL,
      parent_list_id  VARCHAR DEFAULT '',
      title           VARCHAR DEFAULT '',
      description     VARCHAR DEFAULT '',
      status          VARCHAR DEFAULT 'active',
      owner           VARCHAR DEFAULT '',
      source          VARCHAR DEFAULT '',
      transfers_json  VARCHAR DEFAULT '[]',
      body            VARCHAR DEFAULT '',
      created_at      VARCHAR DEFAULT '',
      updated_at      VARCHAR DEFAULT ''
    )`,
    'CREATE INDEX IF NOT EXISTS idx_todo_list_session ON todo_list(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_todo_list_parent  ON todo_list(parent_list_id)',

    `CREATE TABLE IF NOT EXISTS todo_item (
      id             VARCHAR PRIMARY KEY,
      list_id        VARCHAR NOT NULL,
      title          VARCHAR DEFAULT '',
      description    VARCHAR DEFAULT '',
      status         VARCHAR DEFAULT 'pending',
      order_key      DOUBLE  DEFAULT 0,
      created_at     VARCHAR DEFAULT '',
      updated_at     VARCHAR DEFAULT '',
      completed_at   VARCHAR DEFAULT '',
      blocked_reason VARCHAR DEFAULT '',
      tags_json      VARCHAR DEFAULT '[]',
      meta_json      VARCHAR DEFAULT '{}'
    )`,
    'CREATE INDEX IF NOT EXISTS idx_todo_item_list ON todo_item(list_id, order_key)',

    `CREATE TABLE IF NOT EXISTS todo_comment (
      id                  VARCHAR PRIMARY KEY,
      item_id             VARCHAR NOT NULL,
      author              VARCHAR DEFAULT '',
      body                VARCHAR DEFAULT '',
      created_at          VARCHAR DEFAULT '',
      edited_at           VARCHAR DEFAULT '',
      agent_acknowledged  BOOLEAN DEFAULT FALSE
    )`,
    'CREATE INDEX IF NOT EXISTS idx_todo_comment_item ON todo_comment(item_id)',
  ];
}

/**
 * Apply the schema to a DuckDB connection. Idempotent (`IF NOT EXISTS`
 * everywhere). Reads the embedding dim from agent config so the
 * vector columns / HNSW indexes match the active embedding model.
 *
 * Called from the daemon's initDb path on startup.
 */
export async function applyDuckDBSchema(
  conn: { run(sql: string): Promise<unknown> },
  embeddingDim?: number,
): Promise<void> {
  const dim = embeddingDim ?? loadConfig().models.providers.local.embeddingDim;
  for (const stmt of buildDuckDBSchema(dim)) {
    await conn.run(stmt);
  }
}

/**
 * Back-compat shim for callers (tests, A.x harness) that still reference
 * the old static export. The default embedding dim comes from agent
 * config; supply your own at apply time if you need a different one.
 */
export const DUCKDB_GRAPH_STATEMENTS: string[] = buildDuckDBSchema(
  loadConfig().models.providers.local.embeddingDim,
);

/** Back-compat alias kept so existing callers compile during the rip-out. */
export const applyDuckDBGraphSchema = applyDuckDBSchema;
