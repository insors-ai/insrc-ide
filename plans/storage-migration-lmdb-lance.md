# Plan: Storage Migration -- DuckDB → LMDB + LanceDB

Execution plan for the storage substrate re-split. **Design** (schema,
API, alternatives considered, why LMDB) lives in
[plans/graph-storage-lmdb.md](graph-storage-lmdb.md). This document is
the *how* and *when*: phased work, gates, and sequencing.

## Why (one paragraph)

Prior DuckDB consolidation hit fatal operational issues (148 GiB bloat,
checkpoint OOM, columnar/graph workload mismatch, experimental HNSW
persistence). Embedded graph-DB market is hostile (Kuzu archived, Cozo
stale, Memgraph BSL + server-arch). Decision: thin custom graph layer on
LMDB + LanceDB restored for vectors + DuckDB demoted to in-memory
query-engine pool only. Full rationale in the design doc.

## Status

Pre-implementation. The on-disk DuckDB store has been wiped
(`~/.insrc/` cleaned 2026-05-05). No production data to migrate.

| Phase | Slice | State | Notes |
|---|---|---|---|
| 0.1 | `lmdb-js` version pin + macOS arm64 / linux x64 / linux arm64 build verification | pending | |
| 0.2 | **Embedding dim downshift to 1024** (qwen3-embedding 4B → 0.6B) | pending | See dedicated section below |
| 0.3 | LanceDB version pin (re-add the dep at the version we last shipped on) | pending | |
| 1.1 | LMDB env + 13 sub-DB scaffolding | pending | per design doc Schema section |
| 1.2 | ID allocator (u64 entity, u32 repo) + atomic counter in `meta` sub-DB | pending | |
| 1.3 | Codec (msgpack via `msgpackr`; typed encoder/decoder per record type) | pending | |
| 1.4 | Test path injection (`setGraphStorePath()` to tmpdir) | pending | parity with current `setStorageDuckDBPath()` |
| 2.1 | `db/repos.ts` -- repo sub-DB CRUD; surface unchanged | pending | |
| 2.2 | `db/entities.ts` (LMDB side) -- entity sub-DB + name-index; module-stub `ensure` mode | pending | |
| 2.3 | Edges -- `out_edge` / `in_edge` sub-DBs; `addEdge` / `removeEdge` / `outEdges` / `inEdges` | pending | |
| 2.4 | `db/unresolved.ts` -- unresolved sub-DB + `unresolved_by_file` secondary index | pending | matches current cross-file-resolver queue semantics |
| 2.5 | `agent/tasks/plan-store.ts` -- plan + plan_step sub-DBs; STEP_DEPENDS_ON via graph edges | pending | |
| 2.6 | `db/conversations.ts` (LMDB structured side) -- session + turn + by_repo index | pending | embedding column removed; goes to Lance in 3.3 |
| 2.7 | `db/todos.ts` -- 3 sub-DBs + by_session index; **no Lance** | pending | |
| 2.8 | `config/store.ts` (LMDB structured side) -- config_entry + by_scope index | pending | embedding column removed; goes to Lance in 3.4 |
| 2.9 | `reindexFile()` bulk transaction helper | pending | tombstone-unseen + insert-new in single LMDB txn |
| 2.10 | Cascade rules (per design doc) enforced in store layer | pending | one test per cascade rule |
| 3.1 | Re-add `@lancedb/lancedb`; `~/.insrc/lance/` init; **switch embedder to qwen3-embedding 0.6B (1024 dim)** | pending | |
| 3.2 | `entity_vec` table (Lance) + `db/entities.ts` Lance write path + `db/search.ts` ANN | pending | |
| 3.3 | `session_vec` + `turn_vec` tables (Lance) + `db/conversations.ts` Lance write path + `searchTurnsByRepo` | pending | |
| 3.4 | `config_vec` table (Lance) + `config/store.ts` Lance write path + `search()` | pending | |
| 3.5 | Conversation compaction (`db/compaction.ts`) verified end-to-end on new substrate | pending | no structural change; just rewires through new modules |
| 4.1 | `db/graph/traversal.ts` -- BFS / DFS / transitiveClosure / SCC | pending | |
| 4.2 | 1-hop neighbor parity (`findCallers` / `findCallees` / `findDefinedIn` / `findImports` / `resolveClosure`) on LMDB | pending | |
| 4.3 | `unreachable()` primitive | pending | dead-code precondition |
| 5.1 | `indexer/index.ts` rewire -- `withStorageConnection` calls → LMDB graph-API; CHECKPOINT calls deleted | pending | |
| 5.2 | `indexer/cross-file-resolver.ts` rewrite -- Pass 1 + Pass 2 on LMDB unresolved sub-DB | pending | |
| 5.3 | All RPC handlers + LLM-facing tools rewired (`db-rpc`, `todos-rpc`, `chat-sessions`, `tools/builtins/graph/`, etc.) | pending | broad caller sweep |
| 5.4 | LLM-facing graph tool: `graph_sql` (DuckDB) → `graph_query` (typed API) | pending | decision in design doc open-questions |
| 6.1 | Delete `db/duckdb-storage-pool.ts`, `db/duckdb-graph-client.ts`, `db/duckdb-graph-schema.ts`, `db/graph-comparison.ts`, `db/__tests__/todos-duckdb.test.ts` | pending | |
| 6.2 | Remove DuckDB `vss` extension load (storage pool gone); audit `arrow` extension load on remaining in-memory pool | pending | |
| 6.3 | Source-file header comments updated -- drop dangling `plans/storage-migration-duckdb.md` references | pending | 10 files per audit |
| 6.4 | CLAUDE.md + design-doc updates (drop "in-transition" banner once landed) | pending | |
| 7.1 | Hot-backup CLI -- `insrc daemon backup <path>` | pending | LMDB file copy under snapshot read txn |
| 7.2 | Schema-version field in `meta` sub-DB + pre-flight version check at env open | pending | |
| 7.3 | Benchmark suite (synthetic 100k / 1M / 10M edges; point-lookup + 1-hop + transitive-closure latency) | pending | regression gate |
| 8.1 | `data.code.dead-code` skill on top of `unreachable()` | pending | the new feature this migration unblocks |

## Phase intent (skeleton -- expand per phase as work starts)

- **Phase 0 -- Decisions before code.** Pin versions, take the embedding-
  dim downshift, lock in the substrate.
- **Phase 1 -- LMDB foundation.** Env, sub-DBs, codec, ID allocator,
  test injection. No domain logic yet.
- **Phase 2 -- Subsystem migration.** Each persistent module
  (entities / edges / unresolved / repos / plans / conversations /
  todos / config) gets a LMDB-backed implementation behind its
  existing public surface. Caller layer untouched in this phase.
- **Phase 3 -- LanceDB restore.** Lance dep back, four vector tables
  created, embedder dim flipped, write paths restored, ANN searches
  re-wired. Compaction verified.
- **Phase 4 -- Traversal layer.** Pure-JS BFS / DFS / closure / SCC /
  unreachable on top of the LMDB cursor API. The new capability ceiling.
- **Phase 5 -- Indexer + caller wiring.** indexer + cross-file-resolver
  + RPC handlers + LLM tools rewired. The daemon comes back up.
- **Phase 6 -- Cleanup.** Delete dead DuckDB-storage code, source-file
  comments, in-transition CLAUDE.md banner.
- **Phase 7 -- Polish.** Backup CLI, schema-version pre-flight,
  benchmark suite as a regression gate.
- **Phase 8 -- Dead-code skill.** The first new feature on the new
  substrate; demonstrates the traversal layer end-to-end.

## Embedding dim downshift (Phase 0.2)

**Decision: drop default embedding dim from 2560 to 1024.**

The current substrate uses qwen3-embedding-4B (2560 dim). Switching to
qwen3-embedding-0.6B (1024 dim) at the same time as the storage migration
is the right call:

- **Storage win.** ~2.5x reduction in LanceDB footprint (10.24 KiB →
  4 KiB raw per vector; ~17 KiB → ~7 KiB with HNSW overhead). For a
  Hadoop-scale repo (~100k entities) Lance drops from ~1.7 GiB →
  ~700 MiB. For a 1M-entity monorepo: ~17 GiB → ~7 GiB.
- **Latency win.** HNSW comparison cost is linear in dim; 1024-dim ANN
  is ~40% the latency of 2560-dim at the same recall.
- **Quality essentially neutral for our task.** Code retrieval is a
  constrained domain (recurring API patterns, identifiers, syntax).
  Most code-retrieval benchmarks show 768-1024 dim models within 1-2%
  of larger ones at top-K retrieval. Voyage-code-3 (1024), nomic-embed-
  code (768), BGE-base (768) all dominate code-search leaderboards
  near the top.
- **Same model family.** Staying on qwen3-embedding (just the smaller
  variant) preserves tokenizer + training-distribution compatibility
  with the rest of the qwen3 stack.
- **Local-first preserved.** Ollama hosts qwen3-embedding-0.6B; no
  external dependency.
- **Configurable.** `embedder.ts` reads model + dim from config; users
  who want the 4B variant for higher fidelity can opt in. Default ships
  at 1024.

Doing this now (before Lance writes any vectors) avoids a re-embed
migration later. Doing it later means re-embedding every entity in the
graph -- a multi-hour operation on large repos.

**Migration touch points for the dim change:**

- `agent/providers/ollama.ts` -- default embedding model name
- `embedder.ts` (or wherever embedding-model config is read) -- default dim
- LanceDB schema for the four vector tables -- `FLOAT[1024]` not `FLOAT[2560]`
- Tests that hard-code the dim
- Documentation (CLAUDE.md model-providers section, etc.)

If we ever want to revisit the dim later, it's a one-line config change
plus a re-embed -- not an architecture change.

## Open questions

To be filled in as work starts. Initial seeds (carried over from the
design doc):

- Auto-reindex registered repos on first post-migration boot, or wait
  for user command? Default: wait.
- Should the LLM-facing graph tool expose a query DSL or a narrow
  find/closure API? Default: narrow API.
- Single LMDB env, or one env per repo? Default: single env.
- Embedding column on entity, or separate Lance table keyed by
  entity_id? Default: separate table.
- Should we keep the `~/.insrc/duckdb.db` boot-time delete logic, or
  log-and-leave? Default: log-and-leave.

## Out of scope

- Cross-repo dead-code analysis (single-repo for v1; cross-repo a
  plausible v2)
- Streaming graph-update push to the IDE (today the IDE re-fetches)
- Persistent reachability cache (recompute per query for v1; cache
  once we measure query frequency)
- GQL / Cypher-ish DSL for end users (internal callers + LLM go through
  the typed API; revisit if we ever expose to end users)
