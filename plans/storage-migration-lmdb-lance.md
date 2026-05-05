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
| 0.1 | `lmdb-js` version pin + darwin-arm64 build verification | done | `lmdb@3.5.4` pinned in [src/insrc/package.json](src/insrc/package.json); 8-test smoke suite at [src/insrc/db/__tests__/lmdb-smoke.test.ts](src/insrc/db/__tests__/lmdb-smoke.test.ts) green on darwin-arm64 (binding load, key/value round-trip, binary keys, cursor range scans, named sub-DBs, msgpack codec, transaction atomicity, file-backed persistence across reopen). New `npm run test:lmdb-smoke` script wires it. **Linux x64 / linux arm64 verification deferred** by explicit user decision (2026-05-05) -- `lmdb-js` ships prebuilt binaries via `node-gyp-build` for both architectures and is widely used on Linux; revisit when a Linux daemon distribution is in scope or CI is set up |
| 0.2 | **Embedding dim downshift to 1024** (qwen3-embedding 4B → 0.6B) | done | Defaults flipped: [agent/config.ts:25-26](src/insrc/agent/config.ts) (`DEFAULT_LOCAL_EMBED = 'qwen3-embedding:0.6b'`, `DEFAULT_LOCAL_EMBED_DIM = 1024`); [daemon/index.ts:150-151](src/insrc/daemon/index.ts) boot-time config seed flipped to match. tsc clean. Fresh-install verification: empty `~/.insrc/` → `loadConfig()` returns `embeddingModel: 'qwen3-embedding:0.6b'`, `embeddingDim: 1024`. **Existing user configs preserved** (existing `~/.insrc/config.json` keeps whatever values it has -- the migration logic in `agent/config.ts:450-538` only fills in defaults for *missing* fields). Per-config opt-in for the higher-fidelity 4b/2560 still works via Model Providers pane |
| 0.3 | LanceDB version pin (re-add the dep at current latest stable) | done | `@lancedb/lancedb@0.27.2` pinned exact in [src/insrc/package.json](src/insrc/package.json) (no historical pin found in git history; previous pin was likely squashed). 6-test smoke suite at [src/insrc/db/__tests__/lancedb-smoke.test.ts](src/insrc/db/__tests__/lancedb-smoke.test.ts) green on darwin-arm64: binding load, table CRUD, ANN-by-distance ordering, **1024-dim vectors round-trip cleanly** (post-0.2 default), file-backed persistence across reopen, where-clause filter alongside vector search. New `npm run test:lance-smoke` script |
| **0.4** | **Substrate scale-validation spike** -- LMDB write/read/closure throughput at 10M edges + Lance ANN at 1M vectors + full Hadoop YARN realistic run | **GATE PASSED** | 7 tests in [scripts/storage-spike/](src/insrc/scripts/storage-spike/) (synthetic 24-hour sustained-write test dropped per user decision: "the problem is not the time, but the size; hence the full hadoop test"). All green on darwin-arm64 (2026-05-05). Headline numbers vs prior DuckDB run on the *same* Hadoop YARN workload: **DuckDB → 148 GiB / fatal checkpoint OOM at 2 GiB pool / daemon restart required** vs **LMDB+Lance → 1.7 GiB total (111 MiB LMDB + 1,586 MiB Lance), peak RSS 1.12 GiB, 38.4 s end-to-end, 11,996 files parsed → 401,993 entities + 389,998 edges**. Synthetic-throughput tests landed 33x-1400x under plan thresholds (e.g. 10M-edge BFS p99 1.5 ms vs 1 ms target; HNSW rebuild peak RSS 2.61 GiB vs 4 GiB budget). See [scripts/storage-spike/README.md](src/insrc/scripts/storage-spike/README.md) for the per-test result table. Substrate validated; migration unblocked |
| 1.1 | LMDB env + 19 sub-DB scaffolding | done | [src/insrc/db/graph/store.ts](src/insrc/db/graph/store.ts) -- lazy-init module singleton, all 19 sub-DBs (8 graph + 2 plans + 3 conversations + 4 todos + 2 config), `withWriteTxn` / `withWriteTxnSync` helpers, lifecycle (`getGraphStore` / `closeGraphStore`). Key encoders / decoders in [src/insrc/db/graph/keys.ts](src/insrc/db/graph/keys.ts) -- u64/u32 BE primary keys, composite keys with `\0` delimiters, prefix scan helpers, RelationKind / EntityKind enum byte mapping (12 / 10 kinds). [PATHS.lmdb](src/insrc/shared/paths.ts) added at `~/.insrc/graph.lmdb`. 20-test smoke suite ([store.test.ts](src/insrc/db/graph/__tests__/store.test.ts)) green: encoders round-trip, key ordering matches numeric, prefix scans bracket cleanly, all 19 sub-DBs accept put/get, lifecycle close/reopen, concurrent first-callers share init, txn atomicity, cursor range scan returns kind-scoped neighbors. New `npm run test:graph-store` script |
| 1.2 | ID allocator (u64 entity, u32 repo) + atomic counter in `meta` sub-DB | done | [src/insrc/db/graph/ids.ts](src/insrc/db/graph/ids.ts) -- read-modify-write under LMDB write txn (concurrent callers serialize at txn level). u64 entity counter at `meta.next_entity_id`, u32 repo counter at `meta.next_repo_id`. Both reserve 0 as the no-ID sentinel; first allocation returns 1. Block-allocate variant (`allocateEntityIdBlock(n)`) for re-index loops; in-txn variants (`allocateEntityIdInTxn(s)` / `allocateRepoIdInTxn(s)`) for use inside a `withWriteTxnSync`. `peekIdCounters()` reads without mutating. 12-test suite at [ids.test.ts](src/insrc/db/graph/__tests__/ids.test.ts) green: monotonic increase, block contiguity, close+reopen persistence, concurrent allocations distinct, in-txn alongside other writes, large-block u64-scale arithmetic correctness. New `npm run test:graph-ids` script |
| 1.3 | Codec (msgpack via `msgpackr`; typed encoder/decoder per record type) | done | [src/insrc/db/graph/codec.ts](src/insrc/db/graph/codec.ts) -- typed `encode*Row` / `decode*Row` pairs for: RepoRow, EntityRow, EdgeProps (CALLS/READS/WRITES/IMPORTS shapes + empty), UnresolvedRow, PlanRow, PlanStepRow, SessionRow, TurnRow, TodoListRow, TodoItemRow, TodoCommentRow, ConfigEntryRow. Empty payload (most edges) encodes as zero-byte buffer. msgpackr (same lib lmdb-js uses internally; ~5-10x faster than JSON). 18-test suite at [codec.test.ts](src/insrc/db/graph/__tests__/codec.test.ts) green: round-trip every record type, sentinel-default preservation, empty edge payload, msgpack-vs-JSON compactness, 50k-byte body round-trip. New `npm run test:graph-codec` script |
| 1.4 | Test path injection (`setGraphStorePath()` to tmpdir) | done | Landed alongside Phase 1.1 since the 1.1 tests structurally require it. `setGraphStorePath(path)` exported from [store.ts](src/insrc/db/graph/store.ts); test setup uses tmpdir per-test for isolation. Mirrors `setStorageDuckDBPath()`'s shape |
| **1.5** | **LMDB env operational config** -- sync flags (full durability, no `MDB_NOSYNC`), `mapsize` 1 TiB sparse, env-open error paths, schema-version pre-flight | done | [src/insrc/db/graph/store.ts](src/insrc/db/graph/store.ts) -- typed error classes (`LmdbStoreError` base + `LmdbStoreLockConflict` / `LmdbStoreCorrupted` / `LmdbStoreMapsizeTooSmall` / `LmdbStoreSchemaVersionMismatch`); `classifyOpenError()` maps raw lmdb-js errors onto these. `SCHEMA_VERSION = 1` constant + `meta.schema_version` pre-flight check at env-open: missing → write on first boot; matching → proceed; stored > expected → hard-fail (never silently downgrade). `INSRC_LMDB_MAPSIZE_GIB` override honored, invalid value falls back to default. `MDB_MAXKEYSIZE` per design doc note: lmdb-js compiles LMDB with `=0` (unlimited at compile time) so explicit option not needed. 8-test suite at [operational.test.ts](src/insrc/db/graph/__tests__/operational.test.ts) green. New `npm run test:graph-ops` script |
| 2.1 | `db/repos.ts` -- repo sub-DB CRUD; surface unchanged | done | [src/insrc/db/repos.ts](src/insrc/db/repos.ts) -- `addRepo / removeRepo / listRepos / updateRepoStatus` re-implemented on LMDB with identical signatures (the `db: DbClient` param stays vestigial; Phase 5.x removes it from callers). Internal: linear scan of `repo` sub-DB for path → u32 id translation (O(N) on a registry of ~hundreds; fine). Timestamp mapping: ISO string ↔ unix ms (via `Date.parse / new Date(ms).toISOString()`); `lastIndexed=0` and `errorMsg=''` are absent on the prior surface (preserved). Path-keyed upsert; status-update-on-unknown-path is a silent no-op (matches prior DuckDB behaviour where the UPDATE matched zero rows). 16-test suite at [db/__tests__/repos-lmdb.test.ts](src/insrc/db/__tests__/repos-lmdb.test.ts) green: round-trip, basename-from-empty-name, upsert preserves single row, multiple repos, removeRepo, no-op deletes, all four status enum values, lastIndexed sentinel, close+reopen persistence. New `npm run test:repos-lmdb` script |
| 2.2 | `db/entities.ts` (LMDB side) -- entity sub-DB + name-index; module-stub `ensure` mode | done | [src/insrc/db/entities.ts](src/insrc/db/entities.ts) -- full surface preserved (`upsertEntities / getEntity / getEntitiesByIds / findEntitiesByName / listEntitiesForRepo / findEntitiesByFile / listUnembeddedEntities / updateEmbedding / deleteEntitiesForFile / deleteEntitiesForRepo`). Internal: 20th sub-DB `entity_id_by_string` (utf8 SHA-32 → u64) preserves the daemon's `Entity.id: string` caller contract while edges use u64. Module-stub upsert is "ensure exists" (no overwrite); other kinds upsert. Repo IDs auto-allocated on first sighting of a path. Embedding vectors don't live in LMDB -- `updateEmbedding()` records only the model name; vector goes to Lance in Phase 3.2. Cascade-on-delete: incident edges (forward + reverse mirror) cleaned up via prefix scan -- Phase 2.10 will hoist this into a shared cascade helper using the Phase 2.3 edge API. EntityKind enum aligned across `keys.ts` u8 codec and `shared/types.ts` domain (12 values: repo, file, module, function, method, class, interface, type, variable, document, section, config). Domain Entity's `embeddingModel` `signature` `hash` `rootPath` `isExported` `isAsync` `isAbstract` `artifact` optionals all round-trip via empty/false sentinel. 26-test suite at [db/__tests__/entities-lmdb.test.ts](src/insrc/db/__tests__/entities-lmdb.test.ts) green. Legacy `rowToEntity` / `unwrapEmbedding` exports kept (deprecated) for `db/search.ts` back-compat until Phase 4.2. New `npm run test:entities-lmdb` script |
| 2.3 + 2.4 | `db/relations.ts` (resolved edges) + cross-file-resolver queue (unresolved + by-file index) | done | Landed together since callers import the unresolved + resolved APIs from the same module ([src/insrc/db/relations.ts](src/insrc/db/relations.ts)). Full surface preserved: `upsertRelation / upsertRelations / deleteRelationsForFile / deleteRelationsForRepo` (no-ops; entity cascade handles incident edges) plus `UnresolvedRelation` type + `makeUnresolvedRelationId` + `listUnresolvedRelations / deleteUnresolvedForFile / deleteUnresolvedForRepo / promoteToResolved / promoteResolvedBatch / updateUnresolvedMeta / updateUnresolvedMetaBatch`. Resolved edges write to `out_edge` + `in_edge` mirrors via u64 lookups (`entity_id_by_string`); skipped with debug log when endpoints missing or kind unknown. Unresolved keyed by string SHA in the `unresolved` sub-DB (matches the public `UnresolvedRelation.id`); secondary `unresolved_by_file` dupsort index keyed by `(repoId, fromFile)` -> id for O(matches) per-file scope. `UnresolvedRow` codec updated from u64 to string IDs with rationale (low row count makes u64 compactness moot here). 24-test suite at [db/__tests__/relations-lmdb.test.ts](src/insrc/db/__tests__/relations-lmdb.test.ts) green: resolved-edge mirrors, intra-batch dedupe, idempotent re-upsert, missing-endpoint skip, no-op edge cases, multi-kind coexistence, unresolved insert/list/scope-by-file, missing-meta drop, promoteToResolved + promoteResolvedBatch, updateUnresolvedMeta + batch, deleteUnresolvedForFile/Repo isolation, makeUnresolvedRelationId determinism, close+reopen persistence. New `npm run test:relations-lmdb` script |
| 2.5 | `agent/tasks/plan-store.ts` on LMDB -- plan + plan_step sub-DBs | done | [src/insrc/agent/tasks/plan-store.ts](src/insrc/agent/tasks/plan-store.ts) -- full surface preserved (`savePlan / getPlan / getActivePlan / updateStepState / getNextStep / deletePlan / deletePlansForRepo / resetStaleLocks / isValidTransition`). **Plan-graph edges live ON the row, not in the unified out_edge / in_edge sub-DBs**: CONTAINS is implicit in the `plan_step` composite key `(utf8 plan_id, \0, u32 idx BE)` -- a prefix scan returns steps in idx order; STEP_DEPENDS_ON is the `dependsOn: string[]` array stored on the PlanStepRow itself. This avoids conflating plan/step utf8 IDs with the entity layer's u64 IDs. Design doc updated with the rationale. State-machine validation, side-effects (maybeCompletePlan / reactivatePlan), crash-recovery (resetStaleLocks) all preserved. **Bug fix in store.ts**: utf8-string-keyed primary sub-DBs (`plan`, `conversation_session`, `todo_list`, `config_entry`) now use `ordered-binary` keyEncoding -- they were using `binary` and string keys silently collapsed to a `<00 00>` byte sequence, causing all rows to overwrite each other. Caught by the new plan-store test suite. Codec PlanStepStatus / PlanStepComplexity / PlanStatus aligned to shared/types.ts (was a parallel definition with different enum values). 29-test suite at [agent/tasks/__tests__/plan-store-lmdb.test.ts](src/insrc/agent/tasks/__tests__/plan-store-lmdb.test.ts) green. New `npm run test:plan-store-lmdb` script |
| 2.6 | `db/conversations.ts` (LMDB structured side) -- session + turn + by_repo index | done | [src/insrc/db/conversations.ts](src/insrc/db/conversations.ts) -- full surface preserved (saveTurn / addCompactedTurns / saveSession / closeSession / setSessionAgent / setSessionStatus / bumpSessionActivity / deleteSession / deleteTurnsForSession / deleteSessionRecord / deleteSessionsForRepo / deleteTurnsForRepo / deleteTurnsByIds / pruneConversations / searchTurnsByRepo / seedFromPrior / getAllTurnsForRepo / getAllTurns / getConversationStats / getSessionById / getTurnsForSession / listSessions / listSessionRecords / resetTableCaches). Storage: `conversation_session` (utf8 id), `conversation_turn` (composite (sessionId, idx)), `conversation_turn_by_repo` (dupsort secondary index). 30-day TTL + 20-per-repo cap pruning preserved. **Vector ops stubbed**: `searchTurnsByRepo` and `seedFromPrior` return [] until Phase 3.3 wires Lance; saveTurn / saveSession / closeSession accept `vector` param but don't persist it. Public SessionStatus / TurnType enums round-trip via codec mapping (codec is the LMDB-side enum; public is the daemon's chat-flow enum). 32-test suite at [db/__tests__/conversations-lmdb.test.ts](src/insrc/db/__tests__/conversations-lmdb.test.ts) green: session CRUD, turn CRUD with idx-ordering + filter on type='turn', upsert semantics, lastActivityAt bump on save, all delete operations cascade correctly (session+turns, by_repo, by_id), repo-scoped queries via the dupsort index, status filter, stats, vector-stub returns, close+reopen persistence. New `npm run test:conversations-lmdb` script |
| 2.7 | `db/todos.ts` -- 3 sub-DBs + by_session index; **no Lance** | done | [src/insrc/db/todos.ts](src/insrc/db/todos.ts) -- full surface preserved (initTodosTables / insertList / insertItem / insertComment / getList / getItem / getComment / listItems / listAllLists / listListsBySession / assertParentAllowed / updateList / updateItem / transferList / reparentList / updateComment / deleteComment / listCommentsForItem / deleteItem / deleteList / deleteListsBySession). Storage: `todo_list` utf8 list_id keyed; `todo_list_by_session` dupsort (session_id) -> list_id; `todo_item` utf8 item_id keyed (per-list listing scans + sorts by `order` in memory; small N per list); `todo_comment` composite (item_id, comment_id) for per-item range scans. Codec aligned with shared/todos.ts: TodoItemRow.order is now a number (was `orderKey: string`); transfers is now `TodoTransfer[]` (was `string[]`); TodoListStatus / TodoItemStatus / TodoOwner re-export the domain enums. State-machine validation, transfer history, parent-cycle detection, cascade deletes (item -> comments; list -> items + comments) all preserved. **No Lance involvement** -- the prior B.0 audit confirmed the todos vector column was always zero-filled and never queried. 27-test suite at [db/__tests__/todos-lmdb.test.ts](src/insrc/db/__tests__/todos-lmdb.test.ts) green: list/item/comment CRUD with state-machine + ordering + transfer history; parent-cycle detection (rejects self + ancestor cycles, validates session match); listListsBySession (roots first, archived filter); listAllLists with status/source filters; cascade deletes through items + comments; close+reopen persistence. New `npm run test:todos-lmdb` script |
| 2.8 | `config/store.ts` (LMDB structured side) -- config_entry + by_scope index | done | [src/insrc/config/store.ts](src/insrc/config/store.ts) -- ConfigStore class with full surface preserved (constructor takes `db: DbClient` vestigially; methods `upsertEntry / deleteEntry / deleteByScope / getEntry / listEntries / vectorSearch`). Storage: `config_entry` utf8 entry_id keyed; `config_by_scope` dupsort secondary index keyed by composite (scope, namespace, category, entry_id). Hierarchical prefix scans support filtering by scope alone, scope+namespace, or scope+namespace+category. Upsert keeps the by_scope index in sync (removes old composite key when scope/namespace/category changes). **Vector ops stubbed**: `vectorSearch` returns []; `upsertEntry` accepts `embedding` but doesn't persist it. Phase 3.4 wires Lance. 16-test suite at [config/__tests__/store-lmdb.test.ts](src/insrc/config/__tests__/store-lmdb.test.ts) green: upsert + getEntry round-trip; project / global scope round-trip; deleteEntry + deleteByScope (only matching scope); listEntries with namespace / category / scope filters and combinations; upsert that changes scope cleans up the old by_scope index entry; vectorSearch stub; close+reopen persistence. New `npm run test:config-store-lmdb` script |
| 2.9 | `reindexFile()` bulk transaction helper | done | Exported from [src/insrc/db/entities.ts](src/insrc/db/entities.ts) (kept in entities.ts since all the helpers it composes already live there; the design doc's `db/graph/bulk.ts` would have been a forwarding-only file). Atomic re-index in one LMDB txn: snapshot existing entities for `(repoId, filePath)`, upsert each parsed entity (auto-allocate u64 IDs as needed), tombstone any that disappeared with full edge cascade. Body-write short-circuit: rows whose `contentHash` + `body` + line range + signature + embeddingModel all match the prior parse are skipped (typical re-index hits this for unchanged entities). Module-stub semantics preserved (existing module entities never overwritten). Auto-allocates a u32 repoId for unknown repos. Refactored `detachDeleteEntities` to expose `detachDeleteEntitiesInTxn(s, u64s)` so the cascade runs inside the same txn as the upsert. 14-test suite at [db/__tests__/reindex-file-lmdb.test.ts](src/insrc/db/__tests__/reindex-file-lmdb.test.ts) green: first-time index, identical re-parse no-op, add/remove/replace entities, body change updates row, edge cascade on tombstone (out + in mirrors), module-stub preservation, idempotence + body-write short-circuit, auto-repo allocation, file-scope isolation, close+reopen persistence. Full LMDB suite (242 tests across 12 files) all green. New `npm run test:reindex-file-lmdb` script |
| 2.10 | Cascade rules (per design doc) enforced in store layer | done | Three functional gaps closed: (1) `removeRepo` in [db/repos.ts](src/insrc/db/repos.ts) now cascades to entities + edges + name-index + entity_id_by_string + unresolved relations + conversation sessions + turns + plans (was a repo-row-only delete; Phase 2.1 left this for 2.10). (2) `deleteSessionsForRepo` in [db/conversations.ts](src/insrc/db/conversations.ts) now cascades to turns + by_repo index entries (the bulk variant was leaving orphan turns; only the single-session `deleteSession` cascaded). (3) `deleteEntitiesForFile` in [db/entities.ts](src/insrc/db/entities.ts) now also wipes unresolved relations from that file (per design-doc cascade matrix; previously the indexer had to call `deleteUnresolvedForFile` separately). Cross-module imports done lazily at the cascade callsite to avoid circular imports between entities / relations / conversations / repos / plans. **Per-module cascades (entity → edges, list → items+comments, etc.) intentionally kept inline** -- the design doc's `db/graph/cascade.ts` would have been a forwarding-only refactor with no functional gain; the centralization can be a follow-up if it ever proves needed. 13-test dedicated cascade-rules suite at [db/__tests__/cascade-rules-lmdb.test.ts](src/insrc/db/__tests__/cascade-rules-lmdb.test.ts) -- one test per row of the design doc's cascade matrix: removeRepo full cascade + repo-isolation; deleteEntity entity_id_by_string cleanup; deleteEntitiesForFile + unresolved cleanup; deleteSession cascade to turns + by_repo index; deleteSessionsForRepo bulk cascade; deletePlan cascade to plan_step rows; deleteList cascade to items+comments; deleteItem cascade to comments; deleteByScope cascade to config_by_scope index; plus 3 cross-cutting no-op tests. Full LMDB suite (255 tests across 13 files) all green together. **Phase 2 complete.** New `npm run test:cascade-rules-lmdb` script |
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
| **5.5** | **Daemon-startup `mdb_reader_check()`** + periodic re-check timer (5 min) | pending | clears stale reader slots from killed processes |
| 6.1 | Delete `db/duckdb-storage-pool.ts`, `db/duckdb-graph-client.ts`, `db/duckdb-graph-schema.ts`, `db/graph-comparison.ts`, `db/__tests__/todos-duckdb.test.ts` | pending | |
| 6.2 | Remove DuckDB `vss` extension load (storage pool gone); audit `arrow` extension load on remaining in-memory pool | pending | |
| 6.3 | Source-file header comments updated -- drop dangling `plans/storage-migration-duckdb.md` references | pending | 10 files per audit |
| 6.4 | CLAUDE.md + design-doc updates (drop "in-transition" banner once landed) | pending | |
| 7.1 | Hot-backup CLI -- `insrc daemon backup <path>` | pending | LMDB file copy under snapshot read txn |
| 7.2 | Forward-migration runner -- runs registered migrations when stored schema_version < expected | pending | The schema-version *field* + *pre-flight check* portion of this slice already landed in Phase 1.5. What remains: a registry of migration functions keyed by (from_version, to_version), a sequential runner, and idempotence guarantees. v1 has no migrations; this runner stays empty until we ever bump SCHEMA_VERSION |
| 7.3 | Benchmark suite (CI-resident regression gate) -- parameterised across 100k / 1M / 10M edges + 100k / 1M / 10M vectors; latency p50/p99 + RSS + file-size; fails CI on > 30% regression | pending | promotes the Phase 0.4 spike from throw-away to permanent gate; baselines refreshed quarterly with reviewer sign-off |
| **7.4** | **Offline-compact CLI** -- `insrc daemon compact` runs `mdb_env_copy2(MDB_CP_COMPACT)`; surfaces file-size delta in `daemon status` so user knows when to run it | pending | manual op; not scheduled; needed after large delete bursts (e.g. `deleteRepo` on a 100k-entity repo) |
| **7.5** | **Operations playbook docs** -- env-open error matrix (corrupted meta, mapsize-too-small, schema-version mismatch), recovery procedures, backup-restore flow, page-corruption mitigation guidance (recommend ZFS / btrfs / APFS) | pending | docs-only |
| 8.1 | `data.code.dead-code` skill on top of `unreachable()` | pending | the new feature this migration unblocks |

## Phase intent (skeleton -- expand per phase as work starts)

- **Phase 0 -- Decisions before code.** Pin versions, take the embedding-
  dim downshift, lock in the substrate. **Phase 0.4 is a HARD GATE** --
  scale-validation spike before any caller code is touched. The lesson
  from the DuckDB consolidation is that "looks fine on small repos" is
  not a substrate validation; we must measure at realistic monorepo
  scale (10M edges, Hadoop YARN class) before committing.
- **Phase 1 -- LMDB foundation.** Env, sub-DBs, codec, ID allocator,
  test injection, **operational config** (sync flags, mapsize, env-open
  error paths). No domain logic yet.
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
  + RPC handlers + LLM tools rewired. Daemon-startup adds
  `mdb_reader_check()` to clear stale reader slots from any
  killed-process predecessors. The daemon comes back up.
- **Phase 6 -- Cleanup.** Delete dead DuckDB-storage code, source-file
  comments, in-transition CLAUDE.md banner.
- **Phase 7 -- Polish.** Backup CLI, schema-version pre-flight,
  benchmark suite as a regression gate (promotes the Phase 0.4 spike
  to permanent CI), offline-compact CLI, operations playbook docs.
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
