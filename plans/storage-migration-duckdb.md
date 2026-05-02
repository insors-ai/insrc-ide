# Plan: Storage Migration -- Kuzu + LanceDB → DuckDB

Consolidate the daemon's storage layer onto DuckDB. **Phase A** moves
the Code Knowledge Graph off Kuzu (urgent: Kuzu was archived Oct 2025;
no upstream fixes). **Phase B** moves embeddings + FTS off LanceDB
later (no urgency: LanceDB is healthy; this is architectural
consolidation, not escape from a dead project). End state: one
storage engine for graph + vector + analytical + structured data.

## Why

### Phase A is urgent

- **Kuzu is archived** (kuzudb/kuzu went read-only on GitHub
  2025-10-10; v0.11.3 is the final upstream release). No bug fixes
  are coming.
- **Recurring buffer-pool incidents.** Through this codebase's
  short life, Kuzu has thrown "Buffer manager exception: Unable to
  allocate memory" at us repeatedly: at 12k-file index runs, after
  WAL recovery, at large-Java-file portions of hadoop. Each time
  we patched it (autoCheckpoint, larger pool, larger threshold,
  periodic explicit CHECKPOINT every 200 → 50 files). The
  recurrence suggests the storage engine isn't a fit for the write
  pattern; we keep tuning around bugs that won't be fixed.
- **DuckDB integration cost is now sunk.**
  [data-driver-duckdb-files.md](data-driver-duckdb-files.md) added
  `@duckdb/node-api`, the lazy-init singleton, the test
  scaffolding, the shutdown integration. Adding the graph layer
  reuses everything.

### Phase B is consolidation, not urgency

- LanceDB (`@lancedb/lancedb`) is actively maintained, ships
  regularly, and our usage is stable.
- DuckDB's VSS extension provides HNSW-indexed vector search;
  combined with the FTS extension it can replace LanceDB at our
  scale (100k-1M embeddings). The win is **one storage engine
  instead of three** -- but only after Phase A proves DuckDB
  handles our graph workload under load.
- Hybrid search (vector + BM25 in one query) is more verbose in
  DuckDB than in LanceDB. The verbosity tax must be factored into
  one helper to be tolerable.

## Related plans

- [plans/data-driver-duckdb-files.md](data-driver-duckdb-files.md)
  -- shipped DuckDB integration (Phase 0) and the consolidated file
  driver. This plan reuses the daemon-wide DuckDB singleton (`getDuckDB`,
  `closeDuckDB`, `withConnection`) defined there.
- [plans/data-driver.md](data-driver.md) -- shipped; this plan
  doesn't change the data-driver tool surface (`db_*` tools); only
  the storage backing the Code Knowledge Graph and embedding store.
- [plans/analyzers/skills-core.md](analyzers/skills-core.md) --
  shipped; the skill audit ring buffer + telemetry stay unchanged.
- [plans/cross-file-references.md](cross-file-references.md) -- the
  cross-file resolver is one of the biggest Kuzu consumers; this
  plan must not regress its semantics.

## Status

Phase A code work complete (A.0-A.7); operational steps A.8-A.10
remain (run dual-write under load → read cutover → single-write
cutover). A.11 cleanup follows the operational cutover. Phase B
audit (B.0) starts now in parallel since it doesn't depend on
A's operational steps.

| Phase | Slice | State | Notes |
|---|---|---|---|
| A.0 | Migration plan + benchmark harness | done (`7bf90d42edb`) | `db/graph-comparison.ts` (snapshot/diff utilities) + `db/__tests__/graph-migration-harness.test.ts` (4-subtest end-to-end harness). Caught a real cross-backend semantic difference on first run (Kuzu silently drops MERGE edges whose endpoints aren't Entity nodes; DuckDB accepts them) -- exactly the validation A.0 is meant to provide. NOT wired to a CI npm script: the test process exits via Kuzu's native-binding segfault (db/client.ts:105-106 known issue; resolves once Kuzu is removed in A.10) |
| A.1 | DuckDB graph schema + DDL | done (`b3f77c514be`) | `db/duckdb-graph-schema.ts` -- 6 tables (entity / repo / relation / unresolved_relation / plan / plan_step) + 4 indexes. Single `relation(src, dst, kind)` table replaces Kuzu's 8 typed REL TABLEs. Idempotent `IF NOT EXISTS` DDL |
| A.2 | `db/client.ts` rewrite | done (`10f4b5776f6`) | `db/duckdb-graph-client.ts` -- GraphClient interface (query/exec, positional or named params), DuckDB impl using the daemon's withConnection. DbClients gains `duck: GraphClient` alongside existing graph/graphReader. initDb applies BOTH schemas during dual-track |
| A.3 | `db/entities.ts` rewrite | done (`414230d001f`) | upsertEntityStub, detachDeleteEntityStubs gated on shouldWriteKuzuGraph/shouldWriteDuckGraph. INSERT ... ON CONFLICT DO UPDATE for MERGE; ordered-DELETE pattern for DETACH DELETE (no transaction wrapping -- GraphClient acquires fresh Connection per call, breaks BEGIN/COMMIT pairing) |
| A.4 | `db/relations.ts` rewrite | done (`54b3a54b4d9`) | All 9 Kuzu writes mirrored: typed-edge upsert (collapses 8 Kuzu REL TABLEs into one INSERT), unresolved upsert/delete/promote/meta, batched promote + meta-update. UNWIND patterns become multi-VALUES INSERTs |
| A.5 | `db/repos.ts` rewrite | done (`1af8b651fb6`) | addRepo, removeRepo, updateRepoStatus -- the simplest of the four. No relation-cleanup needed in removeRepo (Repo has no edges in the schema) |
| A.6 | `db/search.ts` rewrite | done (`72c38bd5891`) | findCallers / findCallees / findDefinedIn / findImports collapsed into one neighborIds(db, id, kind, direction) helper -- four near-identical Cypher patterns become one parameterised SQL pattern. resolveClosure as recursive CTE walking DEPENDS_ON edges, depth ≤ 10, DISTINCT for cycle handling. Reads still gated on shouldReadDuckGraph() (default mode='kuzu') |
| A.7 | Indexer integration | done (`dc47e098226`) | Both periodic CHECKPOINT (every 50 files) and end-of-fullIndex CHECKPOINT calls gated on shouldWriteKuzuGraph(). No behaviour change for current deploys; goes dead under mode='duckdb' (post-A.10); deleted entirely in A.11 |
| A.8 | Side-by-side dual-write phase | pending (operational) | rebuild + restart daemon with INSRC_GRAPH_BACKEND=both; let it index + cross-file-resolve under real load; periodic snapshot/diff check via the A.0 comparison utility. Run for one daemon release; cutover only after diff stays empty for ~1 week. NO further code work needed for this phase |
| A.9 | Read cutover | pending (operational) | flip INSRC_GRAPH_BACKEND=duckdb on a daemon that's been dual-writing. Reads now come from DuckDB; writes still go to both because shouldWriteKuzuGraph() returns true for both 'kuzu' and 'both' modes only -- mode='duckdb' makes Kuzu writes stop. Roll back is one env-var flip. Run for one release |
| A.10 | Single-write cutover + Kuzu removal | pending (operational) | after A.9 stable: stop opening Kuzu in `db/client.ts` (no flag change; code change). Bump a cache-version field; delete `~/.insrc/graph*` on first DuckDB-only daemon boot. From here Kuzu code is dead weight |
| A.11 | Cleanup -- files + deps | pending | delete the `kuzu` import from db/client.ts; remove the `if (shouldWriteKuzuGraph())` gates (they're always false now -- collapse to DuckDB-only branches); delete db/schema.ts (Kuzu DDL); remove `kuzu` from package.json; delete kuzuExec/kuzuQuery helpers in entities.ts/relations.ts/repos.ts/search.ts; trim graph-comparison.ts (drop snapshotKuzu); delete the harness's Kuzu side. Rough scope: ~500 LOC out, 0 LOC in |
| B.0 | LanceDB usage audit | done | findings: 4 Lance call sites today -- entities (vector search YES), conversations (vector search YES on sessions + turns), config-store (vector search YES), todos (vector column always written as ZERO_VEC and never queried, NO real vector search). **No FTS / BM25 usage anywhere in the codebase** -- grep for `bm25 / fts / fullTextSearch / hybridSearch` finds zero callers. This significantly simplifies subsequent B slices: B.2 (FTS extension), B.4 (hybrid-search helper) drop entirely; B.3 schema needs vector + HNSW only |
| B.1 | DuckDB VSS extension wiring | pending | install + load `vss` community extension at daemon startup; alongside `arrow`. Must run before `enable_external_access=false` (extension install needs filesystem access -- same lesson from `arrow` extension). HNSW persistence requires `SET hnsw_enable_experimental_persistence=true` for indexes to survive restart |
| B.2 | ~~DuckDB FTS extension wiring~~ | **dropped** (B.0) | no callers use BM25; no need to install `fts` |
| B.3 | Vector schema | pending | extend the entity table from A.1 with `embedding FLOAT[N]` column + HNSW index. Conversations / config-store gain their own DuckDB tables with the same column shape. No FTS columns / indexes anywhere |
| B.4 | ~~Hybrid-search helper~~ | **dropped** (B.0) | no hybrid search used; pure vector search needs no helper beyond the existing one-liner |
| B.5 | Non-vector Lance usage migration | pending | todos (always ZERO_VEC, never searched) moves to plain DuckDB tables -- drop vector columns entirely. The vector-shaped overhead today (Float32 zero-fill of EMBEDDING_DIM rows) is dead weight |
| B.6 | Vector-search Lance usage migration | pending | entities + conversations + config-store: each gets a DuckDB table with `embedding FLOAT[N]` column + HNSW index. Read paths swap from `table.search(vec)` / `table.vectorSearch(vec)` to `ORDER BY array_distance(embedding, ?) LIMIT k`. Write paths swap from Arrow record batches to plain DuckDB INSERTs |
| B.7 | Side-by-side dual-write phase | pending | mirror A.8 |
| B.8 | Read cutover | pending | mirror A.9 |
| B.9 | Single-write cutover + LanceDB removal | pending | mirror A.10; remove `@lancedb/lancedb` + `apache-arrow` (verify no other users) |
| B.10 | Cleanup -- files + deps | pending | every Lance call site rewired; deps removed |
| C.1 | Daemon resource ledger reclamation | pending | the 1 GB Kuzu pool + Lance-backing-memory free up; revisit DuckDB's 512 MB cap accordingly |
| C.2 | Documentation + post-mortem | pending | update CLAUDE.md, design docs; archive the Kuzu-incident write-ups |

## Goals

1. **Single storage engine end-state.** Graph (entity nodes +
   typed relations), vector embeddings, BM25 full-text search,
   structured tables (config, todos, conversations) all live in
   DuckDB.
2. **Zero correctness regression.** Side-by-side validation runs
   for one full daemon release per phase; a comparison script
   diffs Kuzu / Lance reads against DuckDB reads on every query
   the test suite issues. Cutover only after diff = empty for a
   week of normal use.
3. **No graph-query semantic change.** `graph_callers`,
   `graph_callees`, `graph_closure`, the cross-file resolver's
   queries all return identical results. The wire format (Entity
   shapes, Relation shapes) at the API surface is unchanged.
4. **Reclaim memory.** Removing Kuzu frees the 1 GB pool that
   currently goes to its buffer manager. After full migration,
   DuckDB's cap (currently 512 MB) can absorb the workload that
   was previously split across two engines.
5. **Operational simplicity.** One memory budget to size, one
   shutdown order to maintain, one set of crash-recovery
   semantics, one query language (SQL).

## Non-goals

- **No new graph features.** This plan migrates existing
  capabilities. Adding new graph algorithms, cross-graph queries,
  or property-graph extensions is out of scope.
- **No breaking changes to the analyzer / skills surface.**
  Skills consume the same tool surface (`graph_callers`, etc.)
  before and after migration. The skills-core / data-analyzer-
  skills work continues independently.
- **No DuckDB version bump as part of this plan.** We pin to
  whatever version was landed by data-driver-duckdb-files; if a
  bump is needed for a specific feature, it's a separate change.
- **No exposure of raw SQL to end users.** All queries continue
  to flow through the daemon's typed wrappers (`getEntity`,
  `addRelation`, etc.). DuckDB SQL is an implementation detail.
- **No live data migration tool.** Cutover invalidates the
  on-disk graph + embedding state and triggers a full re-index.
  Reindexing is acceptable; live migration is too much code for
  too little payoff (~2-3 hour reindex on hadoop is the worst
  case).

---

## Phase A -- Kuzu → DuckDB

### A.0 Migration plan + benchmark harness

Before any rewrite, capture **the queries that matter** so the
migration is measurable. The harness:

- Records 30-50 representative queries from a real indexing run +
  `/code-analyze` / `/data-analyze` invocations
- Runs each against the current Kuzu graph + a parallel DuckDB
  graph with the same data
- Reports: latency p50 / p95, row-count parity, result-set parity
- Surfaces any case where DuckDB diverges (semantic difference,
  perf regression beyond 2× Kuzu, memory blowup)

Lives in `daemon/db/__tests__/migration-harness.test.ts`. Uses the
existing test fixtures + a small synthetic graph. CI guards
"DuckDB results equal Kuzu results" as a hard gate from A.1
onward.

### A.1 DuckDB graph schema

Translate `db/schema.ts` from Cypher CREATE NODE / REL TABLE to
SQL CREATE TABLE. The Kuzu schema today defines:

```cypher
CREATE NODE TABLE Entity (
  id STRING PRIMARY KEY,
  kind STRING,
  name STRING,
  file STRING,
  body STRING,
  hash STRING,
  startLine INT64,
  endLine INT64,
  ...
);
CREATE REL TABLE CALLS (FROM Entity TO Entity);
CREATE REL TABLE IMPORTS (FROM Entity TO Entity);
CREATE REL TABLE CONTAINS (FROM Entity TO Entity);
... (one REL TABLE per relation kind)
```

DuckDB equivalent:

```sql
CREATE TABLE entity (
  id VARCHAR PRIMARY KEY,
  kind VARCHAR NOT NULL,
  name VARCHAR,
  file VARCHAR,
  body VARCHAR,
  hash VARCHAR,
  start_line INTEGER,
  end_line INTEGER,
  repo VARCHAR NOT NULL,
  -- ... all Entity fields from shared/types.ts
);

-- Single relation table; relation kind is a column. Two indexes
-- give us forward + reverse traversal at the same speed Kuzu's
-- per-kind tables do.
CREATE TABLE relation (
  src VARCHAR NOT NULL,
  dst VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  PRIMARY KEY (src, dst, kind)
);

CREATE INDEX idx_entity_repo  ON entity(repo);
CREATE INDEX idx_entity_file  ON entity(file);
CREATE INDEX idx_entity_kind  ON entity(kind);
CREATE INDEX idx_relation_fwd ON relation(src, kind);
CREATE INDEX idx_relation_rev ON relation(dst, kind);

-- Repo registry (today's Kuzu Repo node table)
CREATE TABLE repo (
  id VARCHAR PRIMARY KEY,
  path VARCHAR NOT NULL UNIQUE,
  status VARCHAR NOT NULL,
  added_at TIMESTAMP,
  ...
);
```

Decision: **single `relation` table with kind-as-column** vs
per-kind tables. Single table is simpler to maintain (adding a new
relation kind is a constant in the code, not a DDL change), gives
DuckDB more freedom to plan joins, and the index covers both
forward / reverse traversal. Per-kind tables would only win if we
had >100 relation types, which we don't.

### A.2 Connection layer (`db/client.ts`)

Today the file exposes:

```ts
export interface DbClients {
  graph: kuzu.Connection;        // writer
  graphReader: kuzu.Connection;  // reader, 30s timeout
  lance: lancedb.Connection;
}
```

After A.2 it exposes the same interface, but `graph` and
`graphReader` are wrappers over `withConnection` from
[duckdb-pool.ts](../src/insrc/daemon/db/duckdb-pool.ts):

```ts
export interface DbClients {
  graph: GraphClient;        // writer (no special connection; DuckDB MVCC handles concurrency)
  graphReader: GraphClient;  // reader handle; same backing DuckDB instance
  lance: lancedb.Connection; // unchanged in Phase A; replaced in Phase B
}

// New abstraction; the existing tools call `db.graph.query(stmt, params)`
// or `db.graph.execute(prepared, params)`. Both translate to DuckDB SQL.
export interface GraphClient {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(prepared: PreparedStatement, params: unknown[]): Promise<Record<string, unknown>[]>;
  prepare(sql: string): PreparedStatement;
}
```

The same wrapper handles both writer + reader because DuckDB's
MVCC model doesn't need a separate connection. The 30s timeout
that `graphReader` enforces today carries over via DuckDB's query
interrupt mechanism.

`getDb()` keeps its current shape so all callers stay unchanged.

### A.3 `db/entities.ts` rewrite

Today's patterns + their DuckDB equivalents:

| Kuzu Cypher | DuckDB SQL |
|---|---|
| `MERGE (n:Entity {id:$id}) SET n.kind=$k, ...` | `INSERT INTO entity (id, kind, ...) VALUES (?, ?, ...) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, ...` |
| `MATCH (n:Entity {id:$id}) RETURN n` | `SELECT * FROM entity WHERE id = ?` |
| `MATCH (n:Entity) WHERE n.repo=$r RETURN n` | `SELECT * FROM entity WHERE repo = ?` |
| `MATCH (n:Entity {file:$f}) DETACH DELETE n` | `DELETE FROM relation WHERE src IN (SELECT id FROM entity WHERE file = ?) OR dst IN (SELECT id FROM entity WHERE file = ?); DELETE FROM entity WHERE file = ?;` |
| `MATCH (n:Entity {id:$id}) RETURN n.embedding` | -- (stays in Lance through Phase A; moves in Phase B) |

The DETACH DELETE pattern is the trickiest: Kuzu cleans up edges
when nodes are deleted; DuckDB needs an explicit relation cleanup
first. Mechanical rewrite. Wrap in a transaction so partial
failures don't leave dangling edges.

### A.4 `db/relations.ts` rewrite

Same pattern as A.3:

```sql
-- Cypher: MERGE (a)-[:CALLS]->(b) WHERE a.id=$src AND b.id=$dst
INSERT INTO relation (src, dst, kind) VALUES (?, ?, 'CALLS')
ON CONFLICT (src, dst, kind) DO NOTHING;
```

Per-relation-kind upsert helpers stay typed (one TypeScript
function per kind, all dispatching to one SQL template).

### A.5 `db/repos.ts` rewrite

Lightest: the Repo registry is a flat table of (id, path,
status). Almost a 1:1 translation. Status transitions
(`'pending' → 'indexing' → 'ready'` etc.) become straight
UPDATEs.

### A.6 `db/search.ts` rewrite -- the load-bearing one

The graph traversal queries are the highest-risk migration. Three
main shapes:

**graph_callers / graph_callees (1-N hop)**:

```sql
-- Cypher: MATCH (a)-[:CALLS*1..N]->(b) WHERE a.id=$id RETURN b
WITH RECURSIVE callees(id, depth) AS (
  -- Seed: direct children
  SELECT r.dst, 1
  FROM relation r
  WHERE r.src = ? AND r.kind = 'CALLS'

  UNION ALL

  -- Walk: each step extends one more edge
  SELECT r.dst, c.depth + 1
  FROM callees c
  JOIN relation r ON r.src = c.id
  WHERE c.depth < ? AND r.kind = 'CALLS'
)
SELECT DISTINCT e.*
FROM callees c
JOIN entity e ON e.id = c.id;
```

**graph_closure (transitive closure with kind filter)**:

Same shape; the kind filter (`AND r.kind = ?`) restricts which
relation kinds participate. For multi-kind closures (`CALLS` OR
`IMPORTS`), the recursive step uses `r.kind IN (?, ?, ...)`.

**Cross-file resolver**:

The resolver (per [cross-file-references.md](cross-file-references.md))
runs many small lookups. They translate to plain SELECTs; the
performance benchmark in A.0 must keep an eye on this -- it's the
hottest path during a fresh index.

DuckDB's recursive CTE planner uses bottom-up evaluation with
memoization; for typical depths (1-5) and typical insrc graph
sizes (100k-1M edges), it's competitive with Kuzu's native graph
traversal. The benchmark in A.0 confirms; if any query regresses
beyond 2×, we add a materialized reachability table or a
helper-stored-proc fallback.

### A.7 Indexer integration

The indexer today calls `db.graph.query('CHECKPOINT;')` periodically
(every 50 files) + at end of `fullIndex` to bound Kuzu's WAL.
**DuckDB has no equivalent** -- its storage model uses a different
crash-recovery strategy (transactional MVCC, no buffer-pool-pressure
problem). Drop:

- The periodic-checkpoint loop (added in `bf2a2063e73`)
- The end-of-fullIndex CHECKPOINT call
- The `autoCheckpoint` / `checkpointThreshold` knobs in
  [`db/client.ts`](../src/insrc/db/client.ts) (Kuzu-specific)
- The 1 GB Kuzu buffer pool (Kuzu-specific)

Indexer becomes a straight write loop again -- no checkpoint
gymnastics. The DuckDB memory cap (512 MB default) absorbs writes
naturally.

### A.8 Side-by-side dual-write phase

For one daemon release, every entity / relation write goes to
**both** Kuzu and DuckDB. Reads continue from Kuzu (no behaviour
change for users).

A nightly or per-shutdown comparison job:

```ts
async function diffStores(): Promise<DiffReport> {
  const kuzuEntities = await kuzu.query("MATCH (n:Entity) RETURN n.id, n.kind, n.hash");
  const duckEntities = await duck.query("SELECT id, kind, hash FROM entity");
  // ... compare row-count, kind distribution, hash sums per repo
  // ... same for relations
  return { entityDelta, relationDelta, hashMismatches };
}
```

If the diff stays empty for ~1 week of normal use, A.9 is safe.
If it's not, the diff itself tells us which Cypher → SQL pattern
diverged.

### A.9 Read cutover

`getDb().graph` and `getDb().graphReader` switch their backing
implementation from Kuzu to DuckDB. **Writes still go to both** so
we can roll back fast if a perf or correctness issue shows up.

This phase runs for a daemon release. Telemetry: every graph
query logs its DuckDB latency; we watch p95 against the
benchmark baseline from A.0.

### A.10 Single-write cutover + Kuzu removal

After A.9 is stable:

1. Remove the dual-write code path; writes go to DuckDB only.
2. Stop opening the Kuzu Database in `db/client.ts`.
3. Delete `~/.insrc/graph` and `~/.insrc/graph.wal` on next daemon
   start (the DuckDB graph is the source of truth).
4. Bump a cache-version field so older daemons don't accidentally
   try to use the deleted Kuzu data.

### A.11 Cleanup -- files + deps

| File | Action |
|---|---|
| `db/client.ts` | rewrite to drop all `kuzu.*` references; the Kuzu connection / threading / buffer-pool config goes |
| `db/schema.ts` | replace Cypher DDL strings with DuckDB DDL |
| `db/entities.ts` | every `db.graph.query(cypher)` becomes a DuckDB SQL call |
| `db/relations.ts` | same |
| `db/repos.ts` | same |
| `db/search.ts` | recursive CTE versions of graph traversal queries |
| `db/conversations.ts` | (touches Lance for vector lookups -- those parts move in Phase B; Kuzu-side calls are removed here) |
| `indexer/index.ts` | drop the periodic CHECKPOINT loop + end-of-fullIndex CHECKPOINT |
| `daemon/index.ts` | drop the Kuzu-shutdown call (only DuckDB + LanceDB remain in shutdown until B.9) |

| Dependency | Action |
|---|---|
| `kuzu` (currently `^0.11.3`) | remove from `src/insrc/package.json` |

| User-data | Action on cutover |
|---|---|
| `~/.insrc/graph/` (Kuzu DB directory) | delete on first DuckDB-only daemon boot |
| `~/.insrc/graph.wal` | delete |
| `~/.insrc/graph.shadow` (if Kuzu created it) | delete |

---

## Phase B -- LanceDB → DuckDB VSS + FTS

### B.0 LanceDB usage audit -- DONE

The audit landed in commit (this commit). Final findings from
inspecting every Lance call site in the daemon:

| File | Vector search? | FTS / BM25? | Migration target |
|---|---|---|---|
| `db/entities.ts` | YES (`db/search.ts:190` calls `.vectorSearch(vec)` for entity ANN) | NO | DuckDB entity table + VSS HNSW index |
| `db/conversations.ts` | YES (`.search(vec)` x2 -- session summaries via `seedFromPrior`, turns via the search-turns helper) | NO | DuckDB conversations tables + VSS |
| `db/todos.ts` | NO -- `vector` column declared but writes always pass `ZERO_VEC`; no caller queries it | NO | Plain DuckDB tables, **drop the vector column entirely** |
| `config/store.ts` | YES (`.vectorSearch(vec)` in `config/search.ts`) | NO | DuckDB config-store table + VSS |

**Key finding: no FTS / BM25 usage anywhere in the codebase.** A
grep for `bm25 / fts / fullTextSearch / hybridSearch / .search(`
text-string-arg confirms zero callers. The original Phase B plan
assumed we'd need BOTH the VSS extension (for vector ANN) and the
FTS extension (for BM25), plus a hybrid-search helper to combine
them. We need only VSS.

**This drops two slices entirely:**

- B.2 (DuckDB FTS extension wiring) -- no callers
- B.4 (hybrid-search helper) -- no hybrid pattern used

**And reshapes one:**

- B.3 (was "Vector + FTS schema") -> "Vector schema". HNSW index
  on the embedding column; no BM25 index, no FTS-indexed text
  columns.

The original B.5 (non-vector Lance migration) and B.6 (embedding-
write path migration) split cleanly along the audit's vector /
non-vector axis: todos to plain DuckDB tables (B.5); entities,
conversations, config-store to DuckDB + VSS (B.6).

**Side note: dead vector columns in todos.** Today's todos schema
declares three vector columns (todo_lists, todo_items,
todo_comments) sized at EMBEDDING_DIM (typically 768 or 2560
Float32). Every write zero-fills those columns and never reads
them. Migrating todos to plain DuckDB drops that overhead;
storage shrinks by ~10-50 MB on a typical session-history.

### B.1 DuckDB VSS extension wiring

VSS is a **community extension** (not core). To install:

```sql
INSTALL vss FROM community;
LOAD vss;
```

Like `arrow` (per data-driver-duckdb-files Phase 0.4), VSS install
runs **before** `enable_external_access=false`. Updates to
`daemon/db/duckdb-pool.ts`:

```ts
try {
  await conn.run("INSTALL vss FROM community");
  await conn.run("LOAD vss");
} catch (e) { log.warn(...); }
```

VSS adds the `HNSW` index type. DuckDB's docs note experimental
status and require `SET hnsw_enable_experimental_persistence=true`
for indexes that survive across daemon restarts -- we set this
during init alongside the `LOAD vss`.

### B.2 ~~DuckDB FTS extension wiring~~ -- DROPPED

Dropped per the B.0 audit. No callers use BM25 / full-text search;
the daemon's text-side queries are all column predicates (`WHERE
name = ?`) or vector ANN (`.search(vec)`). The `fts` extension
would be dead weight.

### B.3 Vector schema

Extend the entity table from Phase A.1 with the embedding column
and HNSW index. Conversations and config-store get their own
DuckDB tables with the same column shape (no shared `entity` table
-- different row identity, different lifecycle, different
retention).

```sql
ALTER TABLE entity ADD COLUMN embedding FLOAT[?];   -- N = embedding dim, e.g. 768 or 2560
-- Note: dim is fixed per the active embedding model. If the model
-- changes, we re-index from scratch (same as Lance today).

CREATE INDEX idx_entity_emb ON entity USING HNSW (embedding) WITH (
  metric = 'cosine',
  ef_construction = 128,
  m = 16
);
```

HNSW parameters (`ef_construction = 128`, `m = 16`) are reasonable
quality-vs-build-time defaults for our entity counts (100k-1M).
LanceDB uses IVF-PQ rather than HNSW, so the parameter mapping
isn't 1:1; if the harness benchmark in B.6 shows recall regression
we'll tune.

Conversations and config-store schemas mirror the same pattern --
one `embedding FLOAT[?]` column + one HNSW index per table.

No FTS columns / `create_fts_index` PRAGMAs anywhere -- the audit
confirmed the daemon doesn't use BM25.

### B.4 ~~Hybrid-search helper~~ -- DROPPED

Dropped per the B.0 audit. With no FTS, there's no hybrid (vector
+ BM25) score to combine. Pure vector search needs no helper
beyond the one-liner DuckDB query:

```sql
SELECT * FROM entity ORDER BY array_distance(embedding, ?) LIMIT ?
```

Each existing `.vectorSearch(vec)` / `.search(vec)` call site swaps
to that one-liner; no central helper required.

### B.5 Non-vector Lance usage migration -- todos

Per B.0, todos has dead vector columns (always written as
`ZERO_VEC`, never queried). Migration is straightforward:

- Create plain DuckDB tables `todo_lists`, `todo_items`,
  `todo_comments` with the existing column set MINUS the vector
  column.
- Rewrite `db/todos.ts` Lance read/write paths to plain DuckDB
  SQL.
- No HNSW index, no embedding column, no Arrow record-batch
  marshalling.

This slice can ship ahead of B.6 (the vector migration paths) --
todos is independent of VSS readiness.

### B.6 Vector-search Lance usage migration

The three real vector use cases per B.0:

| Caller | Today | After |
|---|---|---|
| `db/entities.ts` + `db/search.ts:190` `.vectorSearch(vec)` | LanceDB Arrow records + IVF-PQ | DuckDB entity table + HNSW |
| `db/conversations.ts` `.search(vec)` x2 (sessions, turns) | Lance tables + ANN | DuckDB conversations tables + HNSW |
| `config/store.ts` `.vectorSearch(vec)` | Lance config-store table | DuckDB config-store table + HNSW |

The pattern for each: create the DuckDB table with the embedding
column (B.3), wire the write path through DuckDB INSERT (drops
the Arrow record-batch construction code), wire the read path
through `ORDER BY array_distance(embedding, ?) LIMIT ?` (drops
the LanceDB `.search()` API call).

Embedding generation (Ollama call + caching) is unchanged; only
the persistence + retrieval sinks change.

### B.7 / B.8 / B.9 -- side-by-side validation, cutover, removal

Mirror A.8 / A.9 / A.10 exactly. Dual-write to both Lance and
DuckDB-VSS for one release; switch reads after diff stays empty
for a week; drop Lance writes; remove dependency.

### B.10 Cleanup -- files + deps

| File | Action |
|---|---|
| `db/client.ts` | drop `lance: lancedb.Connection` from DbClients; remove `lance.connect(...)` |
| `db/entities.ts` | every `lance.*` call replaced by DuckDB equivalents |
| `db/conversations.ts` | rewire to plain DuckDB tables |
| `db/todos.ts` | same |
| `config/store.ts` | same |
| `daemon/index.ts` | drop Lance connect / shutdown |

| Dependency | Action |
|---|---|
| `@lancedb/lancedb` (`^0.26.2`) | remove from `package.json` |
| `apache-arrow` (`^18.1.0`) | **AUDIT FIRST.** Lance pulls Arrow as its data-exchange format. Other daemon code may still need Arrow for data-driver-duckdb-files (Avro → Arrow → Parquet pipeline) or for general result marshalling. If only Lance was using it, remove. If others use it, keep. |

| User-data | Action on cutover |
|---|---|
| `~/.insrc/lance/` | delete on first DuckDB-only daemon boot |
| `~/.insrc/config-store/` | delete (was Lance-backed; data migrates to a DuckDB table) |

---

## Phase C -- Reclamation + documentation

### C.1 Daemon resource ledger

After Kuzu + Lance are gone:

| Source | Today | After cutover |
|---|---|---|
| Kuzu buffer pool | 1 GB cap | 0 (engine removed) |
| Kuzu WAL | up to 512 MB on disk | 0 |
| LanceDB heap | varies; estimated 200-500 MB under load | 0 |
| DuckDB buffer pool | 512 MB cap | bump to 2 GB cap (absorbs both former workloads) |
| Total memory budget | ~2 GB allocated to storage | ~2 GB (consolidated to DuckDB) |

Net: same memory budget, one engine to tune.

### C.2 Documentation

- Update `CLAUDE.md` -- the "Tech stack" section currently lists
  Kuzu + LanceDB; replace with DuckDB
- Archive the Kuzu-incident write-ups + the "kuzu-to-cozo
  migration plan" we briefly considered
- Update design docs that reference Kuzu Cypher to reference
  DuckDB SQL

---

## Complete dependency removal list

After Phase A + B + C cutover, **`src/insrc/package.json`**
should drop:

```diff
   "dependencies": {
     "@anthropic-ai/sdk": "^0.78.0",
     ...
-    "@lancedb/lancedb": "^0.26.2",
     ...
-    "apache-arrow": "^18.1.0",   # IF B.10 audit confirms no other users
     ...
-    "kuzu": "^0.11.3",
     ...
   }
```

Three lines removed. The DuckDB dep added in Phase 0 of
data-driver-duckdb-files (`@duckdb/node-api`) absorbs all three
former roles.

## Open questions

1. **Single relation table vs per-kind tables in DuckDB.** A.1
   picks single-table-with-kind-column for code maintenance + index
   simplicity. Per-kind tables would only win for >100 relation
   types or if specific kinds had wildly different access patterns.
   **Default: single table; revisit if perf benchmark in A.0 shows
   per-kind tables matter.**

2. **HNSW persistence stability.** DuckDB's `hnsw_enable_experimental_persistence`
   pragma is required for indexes to survive restarts. The
   "experimental" tag means upstream may change format / semantics.
   **Default for B: enable persistence; rebuild HNSW index if
   DuckDB upgrade requires it (we already do this on schema
   migrations).**

3. **VSS extension version pinning.** Community extensions are
   versioned independently of DuckDB core. **Default: pin to
   whatever VSS version is current at B.1 implementation time;
   document upgrade ritual in CLAUDE.md.**

4. **Should we keep the dual-write phase shorter than one
   release?** A.8 / B.7 say "one release." If the diff is empty
   after a few days of dogfooding, can we cut over faster?
   **Default: stick to one release.** Storage migrations are
   high-impact; a few days isn't enough to flush out long-tail
   issues.

5. **Cross-file resolver perf at high depth.** The resolver's
   queries are bounded but the bound varies by query. If A.0
   benchmark surfaces a specific resolver query that regresses,
   we either rewrite that one query (often a precomputed
   reachability table makes it trivially fast) or escalate. The
   plan doesn't pre-commit to a fallback because we don't know
   yet which query, if any, hits the wall.

6. **Should A and B run in parallel?** Tempting -- both touch
   `db/entities.ts`. But the dual-write infrastructure for two
   migrations simultaneously is significantly more complex than
   one at a time, and the comparison signal is muddier. **Default:
   sequential. Phase A finishes (cutover stable for one release)
   before Phase B begins.**

## Lessons baked in from prior incidents

1. **Side-by-side dual-write, not big-bang cutover.** Every
   storage migration in our memory has caused a recurring
   incident; the only ones that didn't were the ones that ran
   parallel for long enough. A.8 / B.7 are non-negotiable.
2. **Reindex over live migration.** Writing a "Kuzu → DuckDB live
   migration tool" is a code project of its own. A 2-3 hour
   reindex is acceptable. We don't write the migration tool.
3. **Drop the periodic-checkpoint scaffolding aggressively.**
   The Kuzu period-checkpoint code in `indexer/index.ts` is
   load-bearing TODAY; the moment Kuzu is gone, that code is
   dead weight that obscures the indexer's real responsibilities.
   A.7 deletes it cleanly.
4. **Don't let `apache-arrow` linger as a stealth dependency.**
   B.10 explicitly audits it. If it was only present for Lance,
   it goes. If something else (DuckDB? a converter?) needs it,
   document why so the next reader knows it's intentional.
5. **One memory budget, not three.** C.1 explicitly reclaims
   the Kuzu pool budget into DuckDB rather than freeing it. The
   daemon has one memory ledger; consolidating engines is the
   easy part; resizing the survivor to absorb the previous
   workloads is what makes the consolidation worth it.
