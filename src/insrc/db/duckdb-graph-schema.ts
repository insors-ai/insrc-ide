/**
 * DuckDB graph schema -- DDL for the Kuzu replacement.
 *
 * plans/storage-migration-duckdb.md Phase A.1.
 *
 * Translates the Kuzu schema in [schema.ts](./schema.ts) to DuckDB
 * SQL. Naming convention shifts from Kuzu's PascalCase nodes
 * (`Entity`, `PlanStep`) to SQL convention (`entity`, `plan_step`)
 * with snake_case columns (`startedAt` → `started_at`); the daemon's
 * existing Kuzu queries that used PascalCase / camelCase are
 * rewritten as part of A.3-A.6 to use these names.
 *
 * Architectural decisions:
 *
 * 1. **Single `relation` edge table.** Kuzu has eight typed
 *    Entity↔Entity relation tables (`CALLS`, `IMPORTS`, ...) plus
 *    plan-graph edges (`CONTAINS`, `STEP_DEPENDS_ON`). All of these
 *    share the same shape -- directed labeled edges between strings.
 *    Collapsing them into one `relation(src, dst, kind)` table
 *    simplifies the code (adding a new relation kind is a constant,
 *    not a DDL change) and gives DuckDB more freedom to plan
 *    cross-kind queries. We lose Kuzu's type enforcement (a
 *    `CONTAINS` edge from an entity to a plan-step would now type-
 *    check at the DB layer); the application layer is the only
 *    writer and enforces correctness.
 *
 * 2. **Two indexes on `relation`** -- one forward (`src, kind`) for
 *    "what does X point at" traversal, one reverse (`dst, kind`)
 *    for "what points at X" traversal. DuckDB doesn't auto-build
 *    these the way Kuzu does; we declare them explicitly so 1-hop
 *    queries hit indexed lookup.
 *
 * 3. **No CHECKPOINT.** DuckDB's storage model is transactional
 *    MVCC; there's no equivalent to Kuzu's WAL+buffer-pool tuning.
 *    The periodic-CHECKPOINT scaffolding currently in
 *    [indexer/index.ts](../indexer/index.ts) is removed in Phase A.7.
 *
 * 4. **`IF NOT EXISTS` everywhere** -- mirrors Kuzu's pattern; DDL
 *    is idempotent so daemon restart applies it cleanly whether
 *    tables already exist or this is a cold start.
 */
export const DUCKDB_GRAPH_STATEMENTS: string[] = [
  // -------------------------------------------------------------------
  // Code knowledge graph
  // -------------------------------------------------------------------

  // Entity stub. Full entity data (body, embeddings, etc.) lives in
  // LanceDB through Phase A; moves into this table in Phase B.3 when
  // the embedding column + HNSW index land. For now: id + kind only,
  // matching the current Kuzu Entity stub.
  `CREATE TABLE IF NOT EXISTS entity (
    id   VARCHAR PRIMARY KEY,
    kind VARCHAR
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
  //
  //   Entity-to-Entity: DEFINES | IMPORTS | CALLS | INHERITS |
  //                     IMPLEMENTS | DEPENDS_ON | EXPORTS | REFERENCES
  //   Plan→PlanStep:    CONTAINS
  //   Step→Step:        STEP_DEPENDS_ON
  //
  // src and dst are application-managed FKs into entity / plan /
  // plan_step (the relation table doesn't enforce them; cross-kind
  // joins handle integrity).
  `CREATE TABLE IF NOT EXISTS relation (
    src  VARCHAR NOT NULL,
    dst  VARCHAR NOT NULL,
    kind VARCHAR NOT NULL,
    PRIMARY KEY (src, dst, kind)
  )`,

  // Forward + reverse indexes on (src/dst, kind) so 1-hop traversal
  // in either direction is index-served. Kuzu auto-builds these on
  // the typed REL TABLEs; DuckDB needs them explicit.
  'CREATE INDEX IF NOT EXISTS idx_relation_fwd ON relation(src, kind)',
  'CREATE INDEX IF NOT EXISTS idx_relation_rev ON relation(dst, kind)',

  // Cross-file resolver queue. Per-file parser leaves edges needing
  // cross-file lookup (INHERITS / IMPLEMENTS / cross-file CALLS /
  // Python relative IMPORTS) in this table; the resolver pass
  // promotes resolved edges into `relation` after each indexing
  // settle window. See plans/cross-file-references.md §0.1.
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

  // Index on (repo, from_file) -- the resolver's primary lookup
  // pattern is "what unresolved edges does this file have left?"
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

  // Index on (plan_id, idx) so listing a plan's steps in order is
  // O(log n) instead of a full table scan.
  'CREATE INDEX IF NOT EXISTS idx_plan_step_plan ON plan_step(plan_id, idx)',
];

/**
 * Apply the schema to a DuckDB connection. Idempotent.
 *
 * Called from the dual-write phase (A.8) on daemon startup after
 * the DuckDB singleton initialises but before any writes are
 * issued. Each statement runs sequentially; a failure in one
 * doesn't continue past that point (DDL errors are programmer
 * errors, not user-recoverable).
 */
export async function applyDuckDBGraphSchema(
  conn: { run(sql: string): Promise<unknown> },
): Promise<void> {
  for (const stmt of DUCKDB_GRAPH_STATEMENTS) {
    await conn.run(stmt);
  }
}
