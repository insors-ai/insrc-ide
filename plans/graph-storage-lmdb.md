# Plan: Graph Storage Re-split -- Custom LMDB Layer + LanceDB Restore

Reverse the DuckDB consolidation from
[plans/storage-migration-duckdb.md](storage-migration-duckdb.md). End state:
**three substrates**, each doing what it's built for, instead of one substrate
fighting three workloads.

- **LMDB** -- code knowledge graph + repo metadata + plans + conversations +
  todos + config-store, via a thin custom Node/TypeScript layer purpose-built
  for our access pattern (point lookup + 1-hop neighbor + full transitive
  closure).
- **LanceDB** -- entity embeddings + vector search. Same library we used pre-
  consolidation; it was healthy.
- **DuckDB** -- *demoted* to the in-memory query-engine pool only (data-driver
  CSV / Parquet / JSONL attaches via `db_file_*` tools). The file-backed
  storage pool is removed.

## Why

### The DuckDB consolidation failed in production

- **148 GiB bloat.** `~/.insrc/duckdb.db` grew to 148 GiB on a single dev
  machine indexing `hadoop` (12.8k files). DuckDB has no online compaction --
  the only way to reclaim space is `EXPORT DATABASE` → `IMPORT DATABASE` into
  a fresh file, which needs another 148 GiB free to run.
- **Fatal checkpoint OOM at 2 GiB pool.** Even with `preserve_insertion_order
  = false` and periodic `CHECKPOINT` (every 100 files in
  `indexer/index.ts`), the storage pool wedged with `Failed to create
  checkpoint: Out of Memory Error: could not allocate block of size 256.0
  KiB (1.9 GiB/1.9 GiB used)`. Once invalidated, the database returned
  fatal errors on every subsequent RPC -- *not recoverable* without
  restarting the daemon. The user reports having seen this failure mode
  multiple times.
- **HNSW persistence is `experimental_persistence`.** The flag we set at
  init (`SET GLOBAL hnsw_enable_experimental_persistence = true`) is
  flagged experimental in DuckDB's own docs. Every checkpoint has to
  rewrite the in-memory HNSW search graph against the columnar pages.
  Combined with 2560-dim qwen3-embedding vectors (~10 KiB raw per vector
  + ~1.5-2x HNSW overhead), the working set blows past any reasonable
  pool cap.
- **Columnar storage is the wrong shape for graph workload.** Graph
  queries are point lookups + small writes + frequent joins (OLTP-ish).
  DuckDB is optimized for analytical scans (OLAP). Every checkpoint has
  to merge small inserts into row-group blocks AND rewrite vector index
  state -- compounding pressure on the same buffer pool.
- **No native graph storage.** The "graph" in DuckDB was just `entity` +
  `relation` tables with recursive CTEs for traversal. There's no
  variable-length path operator, no CSR / adjacency-list layout, no
  graph-aware optimizer. Multi-hop queries (transitive `DEPENDS_ON`,
  k-hop neighborhood, dead-code reachability) become N self-joins in a
  columnar engine that wasn't designed for that pattern.

### Embedded graph DB market is hostile

The natural escape hatch -- "just use a real embedded graph DB" -- doesn't
exist in any acceptable form:

| Option | Status | Blocker |
|---|---|---|
| **Kuzu** | Archived 2025-10-10 (per existing plan) | No upstream fixes; same buffer-pool incidents we tried to escape |
| **Cozo** | Last release 2023-12-11 (~2.5 years stale); pre-1.0 | Same "experimental" risk class as DuckDB-HNSW |
| **Memgraph** | Server architecture; BSL 1.1 license as of 2026-01-01 | Not embeddable; license forbids distributing it in our product |
| **Neo4j** | Server architecture; GPL/commercial dual-license | Same |
| **GraphLite / Grafeo / IndraDB / SQLiteGraph / CQLite** | All young, single-author or small-team | Same trap we just escaped |
| **pglite + Apache AGE** | pglite single-threaded; AGE-on-pglite isn't a packaged option | Two integrations at once, both us as early adopters |

The pattern: graph DBs commercialize toward server architecture and
source-available licensing; the embedded permissively-licensed open-source
space is mostly hobby projects.

### Why custom-on-LMDB is the right answer

1. **Our schema is small and fixed.** ~10 entity kinds (function, class,
   module, repo, …) + ~20 relation kinds (CALLS, IMPORTS, EXTENDS,
   IMPLEMENTS, REFERENCES, DEPENDS_ON, …). No flexible schema, no user-
   defined types. A purpose-built layer is a smaller problem than a
   general-purpose graph DB.
2. **Workload is narrow.** Point lookup by ID, 1-hop neighbor lookup,
   bulk write on re-index, full transitive closure for dead-code analysis.
   No streaming graph analytics, no distributed query, no multi-tenant.
3. **LMDB is the most boring possible substrate.** Memory-mapped, ACID,
   single-writer multi-reader (matches our daemon model exactly), used by
   OpenLDAP / Bitcoin Core / Monero / Postfix / Memgraph (yes, ironically)
   in production for ~15 years. No buffer pool to tune (OS handles paging),
   no checkpoints, no compaction. The failure modes that bit DuckDB and
   Kuzu structurally cannot happen with LMDB.
4. **Performance ceiling is much higher than SQLite.** mmap + cursor
   range-scan over packed `(from_id, kind, to_id)` keys runs at memory
   speed once warm. A 10M-edge BFS finishes in ~100ms-1s in
   well-written Node code; SQLite recursive CTEs over the same data
   would take seconds-to-minutes. Matters for the planned dead-code
   analyzer (transitive closure from entry points).
5. **Total custom code is bounded.** ~1000-1500 LOC for the storage +
   traversal layer. The algorithms (BFS, DFS, transitive closure, SCC
   for cycle detection) are textbook. The bug surface is something we
   can review end-to-end.

## Related plans

- [plans/storage-migration-duckdb.md](storage-migration-duckdb.md) -- the
  consolidation this plan reverses. Phase B (LanceDB → DuckDB) is fully
  rolled back; Phase A (Kuzu → DuckDB) is *partially* rolled back -- we
  don't go back to Kuzu (deprecated), we land on LMDB instead.
- [plans/data-driver-duckdb-files.md](data-driver-duckdb-files.md) --
  unaffected. The in-memory DuckDB query-engine pool stays as-is; this
  plan only removes the *file-backed storage pool* (`duckdb-storage-pool.ts`).
- [plans/data-driver.md](data-driver.md) -- unaffected. Data-driver tool
  surface (`db_*` tools) doesn't change.
- [plans/cross-file-references.md](cross-file-references.md) -- the
  cross-file resolver was rewritten in Phase A.8 to issue DuckDB SQL.
  This plan rewrites it again to use the LMDB graph API.
- [plans/analyzers/data-analyzer-skills.md](analyzers/data-analyzer-skills.md)
  -- unaffected at the skill level. Skills hit the data-driver pool, not
  the storage pool. End-to-end smoke runs are *gated* on this plan
  landing.

## Status

Pre-implementation. The on-disk DuckDB store has been wiped (`~/.insrc/`
cleaned up by user 2026-05-05). No production data to migrate -- this is a
greenfield rebuild on a fresh substrate.

| Phase | Slice | State | Notes |
|---|---|---|---|
| 0.1 | Pick LMDB binding + version | pending | `lmdb-js` (Kris Zyp). Pin a version; verify it builds on macOS arm64 + linux x64 + linux arm64 |
| 0.2 | Vendor decision: msgpack codec | pending | Use `msgpackr` (default in `lmdb-js`); typed decoder for entity values |
| 1.1 | LMDB env + sub-DB schema scaffolding | pending | `db/graph/store.ts` -- env open, sub-DB handles, txn helpers, key codecs |
| 1.2 | ID allocator | pending | u64 sequential entity ID, u32 sequential repo ID, atomic counter in `meta` sub-DB |
| 1.3 | Entity CRUD | pending | `db/graph/entities.ts` -- get/put/delete by id; name-index lookups |
| 1.4 | Edge CRUD | pending | `db/graph/edges.ts` -- out_edges, in_edges, addEdge, removeEdge; cursor-based range scans |
| 1.5 | Re-index transaction helper | pending | `db/graph/bulk.ts` -- "replace all entities/edges originating from file F" pattern; tombstone unseen + insert new in one LMDB txn |
| 2.1 | Traversal primitives | pending | `db/graph/traversal.ts` -- BFS, DFS, transitiveClosure, SCC; reachability cache (invalidated per-file) |
| 2.2 | Search / 1-hop neighbor API parity with current | pending | `findCallers / findCallees / findDefinedIn / findImports / resolveClosure` re-implemented on LMDB; same surface as current `db/search.ts` |
| 3.1 | LanceDB restore | pending | Re-add `@lancedb/lancedb` dep; restore `db/entities.ts` Lance write path; restore `db/search.ts` vector-search path; restore `~/.insrc/lance/` directory |
| 3.2 | Conversations / config-store / todos restore | pending | Decision per table: stay on LMDB (no vectors) or restore to Lance (if vectors used). Per Phase B audit: conversations + config-store *do* use vector search; todos do not |
| 3.3 | DuckDB storage-pool removal | pending | Delete `db/duckdb-storage-pool.ts`, `db/duckdb-graph-schema.ts`, `db/duckdb-graph-client.ts`. Daemon shutdown handler drops the storage-pool close. In-memory query pool (`duckdb-pool.ts`) stays |
| 4.1 | Indexer integration | pending | `indexer/index.ts` -- replace `withStorageConnection` calls with LMDB graph-API calls. Periodic CHECKPOINT calls go away (LMDB doesn't have them) |
| 4.2 | cross-file-resolver rewrite | pending | `indexer/cross-file-resolver.ts` Pass 1 + Pass 2 -- DuckDB SQL → LMDB graph API. Unresolved-relation table moves to LMDB |
| 4.3 | plan-store rewrite | pending | `agent/tasks/plan-store.ts` -- ~25 SQL queries → LMDB calls |
| 4.4 | LLM-facing graph tool | pending | `graph_sql` tool (DuckDB SQL) → `graph_query` (LMDB API). Decide: expose narrow find/closure API, or expose a Datalog-ish query DSL |
| 5.1 | Dead-code analyzer skill | pending | `data.code.dead-code` skill on top of `transitiveClosure(roots, [CALLS, IMPORTS, EXTENDS, IMPLEMENTS, REFERENCES])` -- the headline new feature this plan unblocks |
| 5.2 | Hot backup CLI | pending | `insrc daemon backup <path>` -- copy LMDB file under a snapshot read txn |
| 5.3 | Schema-version field + migration scaffold | pending | `meta.schema_version` u32; pre-flight check at env open; one-way migration runner |
| 6.1 | Benchmark suite | pending | Synthetic graphs at 100k / 1M / 10M edges; measure point-lookup, 1-hop, transitive-closure latency. Regression gate for v1 |
| 6.2 | CLAUDE.md + design-doc updates | pending | Re-document the storage stack; archive the DuckDB-storage post-mortem |

## Goals

1. **No more "experimental" DB tech in the storage stack.** Every persistent
   substrate is a battle-tested project: LMDB (~15y), LanceDB (actively
   maintained, healthy in our previous use), DuckDB (in-memory only -- no
   experimental persistence flags).
2. **No more "buffer pool too small" incidents.** LMDB has no buffer pool;
   the OS page cache handles working-set residency. The class of failure
   that bit Kuzu and DuckDB structurally cannot recur.
3. **Dead-code analysis becomes feasible.** Transitive closure over the
   full graph runs in seconds, not minutes. Unblocks the 5.1 dead-code
   skill and other reachability-style analyses.
4. **Operational simplicity.** No CHECKPOINT, no VACUUM, no preserve-
   insertion-order tuning. Backup is `cp` under a snapshot. Crash recovery
   is "restart the daemon."
5. **Storage and traversal stay decoupled.** Storage is LMDB; traversal is
   JS code we own. If we ever want to swap storage (e.g. SQLite for a
   smaller dependency footprint, or a real graph DB if one matures),
   only `db/graph/store.ts` changes; `db/graph/traversal.ts` is portable.

## Non-goals

- **Cypher / GQL query language.** Our internal callers use a typed JS API
  (find / closure / traversal). If we ever expose graph queries to end
  users we revisit; we don't today.
- **Cluster / replication / HA.** Single-process daemon. LMDB is single-
  writer-multi-reader; that's the limit and it's fine.
- **Schema evolution beyond a forward-only migration runner.** No
  back-compat, no downgrade, no online schema change. We pin
  `schema_version` at env open and refuse to run on an unknown version.
- **Cross-process concurrent writers.** The daemon owns the LMDB env. The
  CLI / agent never opens it directly (already the rule for the current
  storage; doesn't change).
- **Graph-DB-style transactions across multiple files.** Re-indexing one
  file is one LMDB txn. Multi-file re-index is sequential single-file
  txns. (LMDB is single-writer; serializing is correct *and* removes a
  whole class of concurrency bugs.)

## Schema design

### Sub-DB layout

LMDB exposes "sub-databases" (named keyspaces) within a single env. The
graph layer uses six:

| Sub-DB | Key | Value | Purpose |
|---|---|---|---|
| `meta` | utf8 string | varies | Schema version, ID counters, build metadata |
| `repo` | u32 repo_id (BE) | msgpack(Repo) | Registered repo records |
| `entity` | u64 entity_id (BE) | msgpack(Entity) | Entity bodies (name, kind, file path, range, language, summary, …) |
| `name_index` | (u32 repo, u8 kind, utf8 fqn) | u64 entity_id | "What's the ID of this entity by name?" -- used by re-index lookup |
| `out_edge` | (u64 from, u8 kind, u64 to) | msgpack(EdgeProps) or empty | Outgoing edges; range-scan by `(from, kind)` gives all neighbors |
| `in_edge` | (u64 to, u8 kind, u64 from) | empty | Incoming edges; mirror of `out_edge` for in-degree queries |

Big-endian u64 / u32 in keys ensures LMDB's lexicographic ordering matches
numeric ordering -- critical for sequential ID inserts to land at the right
edge of the B+ tree.

The `out_edge` and `in_edge` sub-DBs duplicate the edge data. The cost is
~2x edge keyspace; the benefit is symmetric O(degree) range-scan in either
direction without a secondary index lookup. Worth it -- in-edge queries
(who calls this function? who imports this module?) are common.

### Entity schema

```ts
interface Entity {
  // Identity (also encoded in name_index key)
  repoId: number;           // u32
  kind: EntityKind;         // enum: function, class, module, …
  name: string;             // fully-qualified

  // Provenance
  filePath: string;         // repo-relative
  startLine: number;
  endLine: number;
  language: Language;       // enum: typescript, python, go, java, scala

  // Optional fields (present on some kinds)
  signature?: string;       // for functions / classes
  summary?: string;         // LLM-generated; populated lazily
  importedFrom?: string;    // for module entities

  // Bookkeeping
  contentHash: string;      // hex(SHA256(source-text-of-entity)) -- used to short-circuit
                            // re-indexing when the entity body hasn't changed
  lastIndexedAt: number;    // unix ms
}

type EntityKind =
  | 'function' | 'class' | 'method' | 'interface'
  | 'module'   | 'type'  | 'enum'   | 'variable'
  | 'repo'     | 'file';

type Language = 'typescript' | 'python' | 'go' | 'java' | 'scala' | 'unknown';
```

`Entity` is msgpack-encoded by `lmdb-js` (default codec). Typed decoder
gates the read so callers get the right shape.

### Relation kinds

```ts
type RelationKind =
  // Code structure
  | 'CONTAINS'          // module → function, class → method
  | 'EXTENDS'           // class → class, interface → interface
  | 'IMPLEMENTS'        // class → interface
  // Call graph
  | 'CALLS'             // function → function
  | 'OVERRIDES'         // method → method
  // Imports + dependencies
  | 'IMPORTS'           // module → module
  | 'DEPENDS_ON'        // repo → repo (via package manifest)
  | 'REFERENCES'        // function/class → type/variable (general use)
  // Data
  | 'READS'             // function → table/column (data lineage)
  | 'WRITES'            // function → table/column
  // Test
  | 'TESTS';            // test-function → function
```

Encoded as a u8 in keys. The enum is fixed at v1; adding a kind requires
a `schema_version` bump but is otherwise additive (existing keys don't
move).

### Edge properties

Most edges have no payload (empty value). A few do:

- `CALLS` edge value: `{ siteCount: u32 }` -- how many call sites in the source span
- `READS` / `WRITES` edge value: `{ columns: string[] }` -- which columns are touched
- All other edges: empty value

Payload is msgpack when present; empty `Buffer.alloc(0)` otherwise.
`lmdb-js` handles empty values cleanly.

### Key encoding

All composite keys are concatenations of fixed-width binary fields:

```
out_edge key: [u64 from BE][u8 kind][u64 to BE]   // 17 bytes
in_edge  key: [u64 to   BE][u8 kind][u64 from BE] // 17 bytes
name_index:   [u32 repo BE][u8 kind][utf8 name]   // variable
entity:       [u64 id BE]                          // 8 bytes
repo:         [u32 id BE]                          // 4 bytes
meta:         [utf8 string]                        // variable
```

Helper: `db/graph/keys.ts` exports `encodeOutEdgeKey(from, kind, to)`,
`decodeOutEdgeKey(buf)`, etc. All key encoding goes through these helpers
-- no ad-hoc concatenation in callers.

## API surface

### Storage primitives (`db/graph/store.ts`)

```ts
interface GraphStore {
  // Lifecycle
  close(): void;
  backup(targetPath: string): Promise<void>;

  // ID allocation
  allocateEntityId(): bigint;
  allocateRepoId(): number;

  // Repo
  getRepo(id: number): Repo | undefined;
  putRepo(repo: Repo): void;
  listRepos(): Repo[];
  deleteRepo(id: number): void;        // cascades to entities + edges

  // Entity
  getEntity(id: bigint): Entity | undefined;
  putEntity(id: bigint, entity: Entity): void;
  deleteEntity(id: bigint): void;       // cascades to edges + name-index
  lookupEntityId(repoId: number, kind: EntityKind, name: string): bigint | undefined;
  listEntitiesInRepo(repoId: number, kind?: EntityKind): IterableIterator<bigint>;

  // Edges
  addEdge(from: bigint, kind: RelationKind, to: bigint, props?: EdgeProps): void;
  removeEdge(from: bigint, kind: RelationKind, to: bigint): void;
  outEdges(from: bigint, kind?: RelationKind): IterableIterator<EdgeRow>;
  inEdges(to: bigint, kind?: RelationKind): IterableIterator<EdgeRow>;

  // Bulk write (re-index)
  reindexFile(repoId: number, filePath: string, parsedEntities: ParsedEntity[]): void;
}
```

Single-writer constraint: `addEdge` / `putEntity` / `reindexFile` all
acquire the LMDB write txn. Concurrent writers serialize at the LMDB level
-- callers don't manage txns directly.

### Traversal layer (`db/graph/traversal.ts`)

```ts
interface GraphTraversal {
  // 1-hop convenience (replaces current db/search.ts)
  findCallers(id: bigint): bigint[];
  findCallees(id: bigint): bigint[];
  findDefinedIn(id: bigint): bigint | undefined;   // CONTAINS in-edge
  findImports(moduleId: bigint): bigint[];

  // Multi-hop
  bfs(roots: bigint[], opts?: TraversalOpts): IterableIterator<bigint>;
  dfs(roots: bigint[], opts?: TraversalOpts): IterableIterator<bigint>;
  transitiveClosure(roots: bigint[], opts?: TraversalOpts): Set<bigint>;
  scc(rootSet: Set<bigint>, opts?: TraversalOpts): bigint[][];

  // Reachability for dead-code (= entities NOT in closure of roots)
  unreachable(
    roots: bigint[],
    candidateKinds: EntityKind[],
    opts?: TraversalOpts,
  ): IterableIterator<bigint>;
}

interface TraversalOpts {
  kindFilter?: RelationKind[];     // default: all relation kinds
  direction?: 'out' | 'in';        // default: 'out'
  maxDepth?: number;               // default: unbounded
  visitor?: (id: bigint, depth: number) => boolean;  // return false to prune
}
```

All traversal returns `IterableIterator<bigint>` where possible -- callers
stream and short-circuit. Materializes to a `Set` only when the caller
actually needs it (transitive closure, dead-code).

### Re-index transaction model

The re-index loop for a single file:

```ts
function reindexFile(repoId: number, filePath: string, parsed: ParsedEntity[]): void {
  txn(() => {
    // 1. Snapshot existing entities for this file (by repo + filePath)
    const existing = listEntitiesInFile(repoId, filePath);
    const seen = new Set<bigint>();

    // 2. Upsert each parsed entity
    for (const e of parsed) {
      let id = lookupEntityId(repoId, e.kind, e.name);
      if (id === undefined) {
        id = allocateEntityId();
        // name-index entry inserted alongside entity put
      }
      // Skip body-write if contentHash hasn't changed
      const prev = id !== undefined ? getEntity(id) : undefined;
      if (prev?.contentHash !== e.contentHash) {
        putEntity(id, e);
      }
      seen.add(id);
    }

    // 3. Tombstone unseen (= deleted from file)
    for (const id of existing) {
      if (!seen.has(id)) {
        deleteEntity(id);   // cascades to edges + name-index
      }
    }
  });
}
```

Edge writes happen in a separate pass (`indexer/cross-file-resolver.ts`)
because edges need both endpoints to exist -- can't resolve until all
files in the changeset are indexed.

LMDB write txns are serial (single-writer). On a re-index storm (e.g.
git-checkout switching branches), files are re-indexed one at a time. This
is fine -- the parser is the bottleneck, not the storage.

## Vector layer (LanceDB restore)

Per the Phase B.0 audit in `storage-migration-duckdb.md`:

- **Vector search USED:** entities, conversations, config-store
- **Vector search NOT USED:** todos (always written `ZERO_VEC`)
- **FTS / BM25:** zero callers anywhere

So the restore is:

1. Re-add `@lancedb/lancedb` dep
2. Restore `~/.insrc/lance/` directory init
3. Restore `db/entities.ts` Lance write path (entity body + embedding)
4. Restore `db/search.ts` Lance vector-search path (`searchSimilar`,
   `searchEntities`)
5. Restore `db/conversations.ts` and `db/config-store.ts` Lance paths
6. **Don't** restore the FTS/BM25 helper -- not needed
7. **Don't** restore Lance for todos -- they live in LMDB now

Vector dim is unchanged (qwen3-embedding = 2560). HNSW index params
unchanged from the previous Lance config.

The `DbClients` shape becomes: `{ graph: GraphStore; lance: lancedb.Connection }`.

## DuckDB demotion

Keep `db/duckdb-pool.ts` (in-memory query engine). Used by:
- `db_file_*` data-driver tools (CSV / Parquet / JSONL attaches)
- All Track-A file-side analyzer skills (`data.profile.numeric.file`, etc.)

Delete:
- `db/duckdb-storage-pool.ts`
- `db/duckdb-graph-schema.ts`
- `db/duckdb-graph-client.ts`
- `~/.insrc/duckdb.db` boot-time creation (already wiped)
- The `vss` extension load (no vectors in DuckDB)
- The `arrow` extension load *if no remaining caller needs it* -- audit
  during 3.3

## Migration plan

There is **no data to migrate**. The DuckDB store has been wiped; users
will re-index their repos against the new substrate on first daemon boot
post-deploy.

Daemon boot sequence post-deploy:

```
1. Open LMDB env at ~/.insrc/graph.lmdb (created on first boot)
2. Apply schema: meta.schema_version = 1, ID counters initialized
3. Open LanceDB at ~/.insrc/lance/ (re-created on first boot)
4. If ~/.insrc/duckdb.db exists, log "leftover DuckDB store; safe to delete"
   (don't auto-delete; user already cleaned up)
5. Begin normal startup
```

For users who had repos registered against the DuckDB build:
- `~/.insrc/config.json` has the repo registry
- On first boot, log "repo X needs re-indexing" for each registered repo
- User runs `insrc repo reindex <path>` (or it auto-runs in the background
  -- decide in 4.1)

## Sized work

Total estimate: **~5 weeks of focused work** for a production-ready v1
that lands the dead-code skill.

| Track | Work | Estimate |
|---|---|---|
| **Foundation** (1.x + 2.x) | LMDB env, schema, entity/edge CRUD, traversal layer, search-API parity | 2 weeks |
| **Vector restore** (3.x) | LanceDB re-add, entities/conversations/config-store rewire, DuckDB storage-pool removal | 1 week |
| **Indexer integration** (4.x) | indexer/index.ts, cross-file-resolver, plan-store, LLM graph tool | 1 week |
| **Dead-code skill + polish** (5.x + 6.x) | Dead-code analyzer, backup CLI, schema-version, benchmarks, doc updates | 1 week |

Phasing favors *correctness* of the foundation before any new feature
work. The dead-code skill (5.1) is the headline new capability this plan
unblocks but it's last -- everything before it is required for the
daemon to come back up at all.

## Risk register

| Risk | Mitigation |
|---|---|
| `lmdb-js` is essentially single-maintainer (Kris Zyp) | He's also the author of `msgpackr` and `cbor-x`, works on this stuff full-time at HarperDB which uses it in production. The C library underneath is rock-solid even if the Node binding stalled. Worst case: pin a version, the on-disk format is stable across LMDB versions for ~15 years |
| LMDB max DB size set at env open | Set generously (e.g. 1 TiB). Sparse on disk -- doesn't actually allocate. macOS / Linux handle the VM range trivially on 64-bit |
| LMDB single-writer serializes re-indexing | Already the case (parser is the bottleneck). For large monorepo first-index, pre-parse N files in worker_threads, then drain into single LMDB write loop |
| Custom code = our bugs forever | Bounded: ~1500 LOC. Comprehensive test suite (6.1 benchmark gate). The algorithms are textbook; the schema is simple. Compare to debugging Kuzu segfaults or DuckDB checkpoint OOMs in C++ we don't own |
| Migration friction (users re-index everything) | Acceptable: users already had to wipe their store. Communicate via release notes |
| Performance regression vs DuckDB-graph | Unlikely (LMDB cursor scans are mmap-fast vs DuckDB B-tree walks), but 6.1 benchmark suite catches it |
| LMDB max key size (511 bytes by default; configurable to 1024 in `lmdb-js`) | Our keys are bounded: out_edge / in_edge = 17 bytes, name_index ≤ ~256 bytes (long FQNs). Set MDB_MAXKEYSIZE = 1024 at env open to be safe |

## Open questions

| Question | Default | Needs decision before |
|---|---|---|
| Should the LLM-facing graph tool expose a query DSL or a narrow find/closure API? | Narrow API (matches today's caller pattern; easier to validate; no SQL injection class) | Phase 4.4 |
| Auto-reindex registered repos on first post-migration boot, or wait for user command? | Wait (avoid surprise CPU on daemon start) | Phase 4.1 |
| Single LMDB env, or one env per repo? | Single env (simpler; cross-repo queries trivial; LMDB scales to TiB) | Phase 1.1 |
| Embedding column on entity, or separate Lance table keyed by entity_id? | Separate Lance table (current design pre-consolidation; entity row stays compact) | Phase 3.1 |
| Edge props for CALLS (siteCount) -- store on the edge, or aggregate later? | Store on edge (cheap; useful for ranking call sites) | Phase 1.4 |
| Should we keep `~/.insrc/duckdb.db` boot-time delete logic? | Log-and-leave (user already cleaned up; auto-delete adds destructive code path with no upside) | Phase 3.3 |

## Out-of-scope follow-ups

- **Streaming graph updates to the IDE.** Today the IDE re-fetches; could
  push deltas. Out of scope for v1.
- **Cross-repo dead-code.** Today the closure is per-repo. Cross-repo
  reachability would need a federated entry-point set. Plausible v2.
- **Persistent reachability cache.** The reachability set is recomputed
  per query. Caching it (and invalidating per-file) is a 2-3 day project
  worth doing once the basic capability ships and we measure actual
  query frequency.
- **GQL / Cypher-ish query DSL.** If we ever expose graph queries to end
  users (vs internal callers + LLM via narrow tools), we revisit. Not
  today.
