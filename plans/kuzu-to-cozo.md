# Plan: Migrate the graph DB from Kuzu to CozoDB

The daemon's graph layer moves from Kuzu (currently `kuzu@^0.11.3`) to
CozoDB (`@cozodb/cozo-node`) with a RocksDB storage backend. LanceDB
stays exactly where it is -- the entity body / embedding / FTS surface
is unchanged. Only the typed-graph store underneath
[src/insrc/db/](../src/insrc/db/) is replaced.

## Why we're doing this

Three concrete pressures, in priority order:

1. **Kuzu's maintenance situation.** Kuzu Inc. wound down commercial
   development in late 2024; the project is in community-maintenance
   mode and momentum has dropped. The chance of getting fixes for
   issues we hit in production is now low.
2. **Operational pain on large repos.** The current code already
   documents the symptoms: buffer-pool exhaustion on 12k+ file repos
   ([client.ts:65-71](../src/insrc/db/client.ts#L65-L71)), futex
   contention on the resolver pass ([client.ts:9-19](../src/insrc/db/client.ts#L9-L19)),
   segfault on explicit `close()` ([client.ts:103-108](../src/insrc/db/client.ts#L103-L108)).
   Each is a workaround we've layered on; the next class of issues is
   worse, not better.
3. **Write-heavy workload mismatch.** The indexer + cross-file resolver
   pattern is many small UNWIND inserts; Kuzu's column-store-for-graph
   storage fights this. An LSM-tree-backed engine (RocksDB under
   either Cozo or any other modern embedded graph DB) is structurally
   better suited.

CozoDB was picked over the SQLite + recursive-CTE option because the
codebase has genuine graph queries (1-hop CALLS, bounded DEPENDS_ON
closure) that read more naturally as Datalog than as recursive CTEs;
and over SurrealDB / DuckDB+PGQ because Cozo's design (thin Datalog
layer over RocksDB) maps cleanest to the indexer's write-heavy
pattern. The discussion thread that drove this decision is recorded in
the project journal; this plan does not re-litigate it.

The trade-off we're explicitly accepting: Cozo is largely a
single-maintainer project. The mitigation is that Cozo's data-on-disk
is a stock RocksDB store (or SQLite, configurable) -- worst case, a
dormant Cozo wrapper still leaves the data readable via standard
RocksDB tools. We are NOT betting on a custom storage format the way
Kuzu made us.

## Related plans

- [plans/data-driver.md](./data-driver.md) -- shipped; uses
  `better-sqlite3` for the file-driver path. Cozo's optional SQLite
  backing reuses this pattern but the production deployment goes
  through RocksDB instead.
- [plans/analyzers/code-analyzer.md](./analyzers/code-analyzer.md) --
  consumes `db/search.ts` for vector + graph hybrid lookups. Its
  query surface is the validation gate for the migration: every
  search the code-analyzer issues today must produce equivalent
  results post-cutover.
- [plans/analyzers/data-analyzer.md](./analyzers/data-analyzer.md) --
  reads `closureRepos` via `resolveClosure`. Same parity gate.
- [plans/cross-file-references.md](./cross-file-references.md) --
  shipped; the `UnresolvedRelation` table the migration must
  preserve byte-for-byte semantics on.
- [plans/todo-framework.md](./todo-framework.md) -- shipped; the
  Plan / PlanStep tables this migration also relocates.

## Status

All slices pending.

| Phase | Slice | State | Notes |
|---|---|---|---|
| 0.1 | Add `@cozodb/cozo-node` dep + native build smoke test | pending | RocksDB backend, prebuilt for linux/darwin/win |
| 0.2 | `DbGraph` abstraction interface | pending | hides Kuzu vs Cozo; lets phases 1-3 run side by side |
| 0.3 | Cozo connection wrapper | pending | mirrors Kuzu's writer + reader split (single Cozo instance, two query channels) |
| 0.4 | Logger module + telemetry hooks | pending | `cozo:*` log module; per-query timing |
| 1.1 | Schema -- node relations (entities, repos, plans) | pending | `:create` definitions in startup migration |
| 1.2 | Schema -- edge relations (calls, imports, ...) | pending | one stored relation per edge kind |
| 1.3 | Schema -- unresolved relation | pending | direct port of UnresolvedRelation table |
| 1.4 | Schema -- plan + plan_step | pending | direct port |
| 1.5 | Stored procedures for hot writes | pending | `UNWIND $rows -> :put entities` + edges; one round-trip per batch |
| 2.1 | Translate `db/repos.ts` writes | pending | addRepo / updateRepo / removeRepo / listRepos |
| 2.2 | Translate `db/entities.ts` Kuzu side | pending | upsertEntity / deleteEntitiesForRepo (Kuzu stub mirror) |
| 2.3 | Translate `db/relations.ts` writes | pending | upsertRelation / batched UNWIND / unresolved upsert / repo cleanup |
| 2.4 | Translate `db/search.ts` reads | pending | findCallers / findCallees / resolveClosure |
| 2.5 | Translate `agent/tasks/plan-store.ts` | pending | savePlan / getPlan / getActivePlan / updateStepState / getNextStep / deletePlan |
| 2.6 | Translate `db/compaction.ts` | pending | conversation pruning (no Kuzu touches today; verify) |
| 3.1 | Dual-write framework | pending | feature-flagged: writes go to BOTH Kuzu + Cozo |
| 3.2 | Backfill migrator | pending | one-shot script: copy current Kuzu DB into Cozo |
| 3.3 | Backfill validation | pending | row-count + sampled-edge checks vs Kuzu source |
| 4.1 | Shadow-read framework | pending | reads issue against BOTH; assert parity in dev/staging |
| 4.2 | Per-query parity assertions | pending | findCallers / findCallees / resolveClosure / listRepos / etc. |
| 4.3 | Bench harness on real repo | pending | five hot queries vs Kuzu; gates the cutover |
| 5.1 | Cutover toggle (settings flag) | pending | `insrc.graph.backend = 'cozo' \| 'kuzu'`, default kuzu |
| 5.2 | Cutover validation in production | pending | flip flag for one daemon, soak |
| 5.3 | Default to cozo | pending | flip default; kuzu still callable |
| 6.1 | Remove dual-write paths | pending | once cozo has soaked one release |
| 6.2 | Remove kuzu reads | pending | |
| 6.3 | Drop `kuzu` package + `db/schema.ts` Cypher DDL | pending | filesystem cleanup of `~/.insrc/graph/` |
| 6.4 | Plan / status post-mortem in this doc | pending | what did and didn't work |

## Goals (short)

1. **Drop-in semantic replacement.** Every consumer of `db/relations.ts`,
   `db/search.ts`, `db/repos.ts`, `db/entities.ts` keeps its current
   function signatures. The migration changes internals; callers
   compile and run unchanged.
2. **No data loss.** A user with an indexed repo on Kuzu wakes up after
   the cutover with the same indexed repo on Cozo. Backfill is a
   one-shot script that runs once and is verified row-by-row.
3. **No latency regression on the analyzer hot paths** -- findCallers,
   findCallees, resolveClosure must come in within ±20% of Kuzu's P50
   on a representative large repo. Bench gates the cutover; if Cozo
   regresses past this threshold we don't flip the default.
4. **Indexer throughput improves** on 10k+-file repos. The pre-cutover
   bench captures Kuzu's baseline; the gate is "Cozo equals or beats
   it on full-index wall-clock". (We expect a real improvement here;
   the gate is conservative.)
5. **Reversible cutover.** Until Phase 6, both engines run in parallel
   and a single settings flag flips between them. If Cozo proves
   wrong post-launch we roll back without data migration.

## Non-goals (in this plan)

- **Replacing LanceDB.** The vector + entity body store is fine;
  Cozo's vector index does NOT take over the LanceDB role. Hybrid
  search keeps its current LanceDB → entity-id → graph round-trip.
  (This was an option earlier; user explicitly rejected it. See the
  prior discussion thread.)
- **Schema redesign.** Migration is a 1:1 translation. Schema changes
  (e.g. moving from string ids to integer ids; collapsing 8 edge
  relations into one with a `kind` column; representing PlanStep deps
  as a different shape) are out of scope. Cozo gives us cheaper
  experimentation later if we want any of these.
- **Adopting Cozo's vector or FTS index.** We have LanceDB for that.
  Mixing the two for hybrid queries is a future plan if a workload
  shows up that needs it.
- **Migrating the conversation / todos / config tables.** These don't
  live in Kuzu; LanceDB + SQLite (better-sqlite3 via the data-driver
  + the in-house todos store) hold them today. Out of scope.
- **Multi-tenant / multi-host Cozo.** We deploy embedded, in-process,
  single-host. The Cozo HTTP server mode and replication features
  are out of scope.

## Architecture before / after

### Before (current)

```
~/.insrc/graph/      Kuzu DB (entity stubs + edges + Plan/PlanStep + UnresolvedRelation)
~/.insrc/lance/      LanceDB (entity bodies + embeddings + BM25 FTS)

src/insrc/db/
  client.ts          opens both; exposes { graph, graphReader, lance }
  schema.ts          Cypher DDL for Kuzu
  relations.ts       upsert / batch UNWIND / unresolved / cleanup -- Cypher
  search.ts          findCallers / findCallees / resolveClosure -- Cypher
  repos.ts           Repo registry -- Cypher
  entities.ts        entity stub mirror (Kuzu side); body lives in lance
```

### After (cutover complete)

```
~/.insrc/graph-cozo/ Cozo store (RocksDB-backed) -- same logical contents as Kuzu's `graph/`
~/.insrc/lance/      LanceDB unchanged

src/insrc/db/
  client.ts          opens cozo + lance; exposes { graph: CozoClient, lance }
  schema.ts          Cozo `:create` DDL
  cozo-client.ts     wrapper over @cozodb/cozo-node with retry / logging
  relations.ts       same exports, Datalog inside
  search.ts          same exports, Datalog inside
  repos.ts           same exports, Datalog inside
  entities.ts        entity stub mirror, Datalog inside
```

### During (phases 3-5 running side by side)

```
~/.insrc/graph/      Kuzu DB -- being read in shadow mode
~/.insrc/graph-cozo/ Cozo store -- new authority once flag flipped
~/.insrc/lance/      unchanged

src/insrc/db/
  client.ts          opens BOTH; exposes both
  graph-backend.ts   strategy selector (settings flag); routes calls
                     to kuzu OR cozo OR both (dual-write / shadow-read)
```

The strategy selector is the lever that lets phases 3-5 ship
incrementally. Phase 6 collapses it back to one backend.

## Schema mapping

### Entity stub (was `Entity` NODE TABLE)

Kuzu:

```cypher
CREATE NODE TABLE Entity(id STRING, kind STRING, PRIMARY KEY(id))
```

Cozo:

```
:create entities {
  id: String
  =>
  kind: String
}
```

In Cozo's `:create`, columns left of `=>` are the primary key, columns
right are non-key. `entities` becomes a stored relation indexed on
`id`. Reads by id are O(log n) RocksDB seeks.

### Repo registry (was `Repo` NODE TABLE)

Kuzu:

```cypher
CREATE NODE TABLE Repo(
  id STRING, path STRING, name STRING,
  addedAt STRING, lastIndexed STRING,
  status STRING, errorMsg STRING,
  PRIMARY KEY(id)
)
```

Cozo:

```
:create repos {
  id: String
  =>
  path: String,
  name: String,
  addedAt: String,
  lastIndexed: String,
  status: String,
  errorMsg: String,
}
```

`errorMsg` keeps its current "" sentinel for "no error" (Cozo's typed
relations don't admit NULL on non-Maybe fields; we'd need
`errorMsg: String?` with explicit None handling otherwise. The
current code already uses "" for empty, so we keep that.)

### Edges (was `CALLS`, `IMPORTS`, ... REL TABLES)

Kuzu used one REL TABLE per edge kind. Cozo can do the same -- one
stored relation per kind -- or unify into one with a `kind` column.

**Decision: keep one stored relation per kind.** Reasons:

- Mirrors the current schema 1:1 -- migration is mechanical
- Per-kind queries (`findCallers` only walks CALLS) are direct lookups
  on a single relation, no `kind = 'CALLS'` filter
- The 8 kinds are stable (we haven't added one in 6 months)

Cozo:

```
:create calls      { from: String, to: String }
:create imports    { from: String, to: String }
:create inherits   { from: String, to: String }
:create implements { from: String, to: String }
:create depends_on { from: String, to: String }
:create exports    { from: String, to: String }
:create references { from: String, to: String }
:create defines    { from: String, to: String }
```

The composite key is `(from, to)`. Cozo allows multi-column primary
keys natively. Duplicate edges are absorbed by `:put` (upsert
semantics); Kuzu's MERGE behaviour translates verbatim.

### Unresolved relations (was `UnresolvedRelation` NODE TABLE)

Kuzu:

```cypher
CREATE NODE TABLE UnresolvedRelation(
  id STRING, repo STRING,
  fromEntity STRING, fromFile STRING,
  kind STRING, rawTo STRING, meta STRING,
  attemptedAt STRING,
  PRIMARY KEY(id)
)
```

Cozo:

```
:create unresolved_relations {
  id: String
  =>
  repo: String,
  from_entity: String,
  from_file: String,
  kind: String,
  raw_to: String,
  meta: String,
  attempted_at: String,
}
```

Field names switch from camelCase to snake_case to match Cozo's
convention; the typed wrapper in `db/relations.ts` keeps the camelCase
TS interface.

### Plans (was `Plan` + `PlanStep` NODE TABLE + edges)

Kuzu had `CONTAINS(Plan -> PlanStep)` and
`STEP_DEPENDS_ON(PlanStep -> PlanStep)` edges. In Cozo:

```
:create plans {
  id: String
  =>
  repo_path: String,
  title: String,
  status: String,
  created_at: String,
  updated_at: String,
}

:create plan_steps {
  id: String
  =>
  plan_id: String,
  idx: Int,
  title: String,
  description: String,
  checkpoint: Bool,
  status: String,
  complexity: String,
  file_hint: String,
  notes: String,
  created_at: String,
  updated_at: String,
  started_at: String,
  done_at: String,
}

:create plan_step_deps {
  step_id: String,
  depends_on_step_id: String,
}
```

`CONTAINS` collapses into the `plan_id` foreign key on `plan_steps` --
no separate edge relation. `STEP_DEPENDS_ON` becomes the
`plan_step_deps` relation.

## Query mapping

The translation table for the queries that exist today. Each row maps
to a function in [src/insrc/db/](../src/insrc/db/).

| Function | Today (Cypher) | After (Datalog) |
|---|---|---|
| `addRepo` | `MERGE (r:Repo {id: $path}) SET r.path = ..., ...` | `?[id, path, name, ...] <- [[$id, $path, $name, ...]] :put repos { id => path, name, ... }` |
| `removeRepo` | `MATCH (r:Repo {id: $path}) DETACH DELETE r` | `?[id] <- [[$id]] :rm repos { id }` -- separate cleanup of `entities` / edges keyed on repo |
| `listRepos` | `MATCH (r:Repo) RETURN r` | `?[id, path, name, ...] := *repos{id, path, name, ...}` |
| `upsertEntity` | `MERGE (e:Entity {id: $id}) SET e.kind = $kind` | `?[id, kind] <- [[$id, $kind]] :put entities { id => kind }` |
| `deleteEntitiesForRepo` | `MATCH (e:Entity) WHERE ... DETACH DELETE e` | needs entity→repo metadata; lives in LanceDB today, so the delete is keyed on the entity ids LanceDB returns first |
| `upsertRelation` (single) | `MATCH (a),(b) MERGE (a)-[:CALLS]->(b)` | `?[from, to] <- [[$from, $to]] :put calls { from, to }` |
| `upsertRelations` (UNWIND batched) | `UNWIND $rows AS r MATCH ... MERGE (a)-[:CALLS]->(b)` | one Datalog query per kind: `?[from, to] <- $rows :put calls { from, to }`. Cozo handles 500-row batches without ceremony |
| `findCallers` | `MATCH (a)-[:CALLS]->(b) WHERE b.id = $id RETURN a` | `?[a_id] := *calls{from: a_id, to: $id}` |
| `findCallees` | `MATCH (a)-[:CALLS]->(b) WHERE a.id = $id RETURN b` | `?[b_id] := *calls{from: $id, to: b_id}` |
| `resolveClosure` (DEPENDS_ON multi-hop) | recursive Cypher pattern | Datalog recursive rule: `closure[a, b] := *depends_on{from: a, to: b}; closure[a, c] := closure[a, b], *depends_on{from: b, to: c}; ?[r] := closure[$root, r]` |
| `listUnresolvedForRepo` | `MATCH (u:UnresolvedRelation {repo: $repo}) RETURN u` | `?[id, from_entity, ...] := *unresolved_relations{id, repo: $repo, from_entity, ...}` |
| `deleteUnresolvedForRepo` | `MATCH (u) WHERE u.repo = $repo DELETE u` | `?[id] := *unresolved_relations{id, repo: $repo}; :rm unresolved_relations { id }` |
| `savePlan` | `MERGE (p:Plan {id: $id}) SET ...` | `:put plans { id => ... }` |
| `getPlan` | `MATCH (p:Plan {id: $id})-[:CONTAINS]->(s:PlanStep) RETURN p, s` | two queries: `*plans{...}` and `*plan_steps{plan_id: $id, ...}`, joined in TS |
| `getActivePlan` | `MATCH (p:Plan {repoPath: $repo, status: 'active'}) RETURN p` | `?[id, ...] := *plans{id, repo_path: $repo, status: 'active', ...}` |
| `updateStepState` | `MATCH (s:PlanStep {id: $id}) SET s.status = ...` | `:put plan_steps { id => ... }` (Cozo `:put` is upsert; the tuple replaces the existing one) |
| `getNextStep` | walks `STEP_DEPENDS_ON` looking for next ready step | recursive Datalog over `plan_step_deps` filtered by `status = 'pending'` |
| `deletePlan` | `MATCH (p:Plan {id: $id}) DETACH DELETE p` | `:rm` from `plans` + cascading rm from `plan_steps` + `plan_step_deps` |

The full call-site count is **~31 Cypher queries** across 5 files
(`db/relations.ts` 12, `db/search.ts` 7, `db/repos.ts` 7, `db/entities.ts`
4, `db/client.ts` 1). Each maps to the corresponding cell above. Phase
2 is therefore mechanical, not architectural.

## Phase 0 -- substrate

### 0.1 Add `@cozodb/cozo-node` dep

```bash
cd src/insrc && npm install @cozodb/cozo-node
```

The package ships prebuilt RocksDB binaries for linux-x64,
linux-arm64, darwin-x64, darwin-arm64, win32-x64. The IDE bundle's
build pipeline already handles native modules (better-sqlite3, kuzu,
lancedb, parcel/watcher), so adding one more is uneventful. We pin
the version exactly (`@cozodb/cozo-node@x.y.z`, not `^`) until the
substrate has soaked one release; semver-pinned native modules are
how the rest of `package.json` already treats them.

Smoke test:

```ts
// scripts/test-cozo-bootstrap.ts
import { CozoDb } from '@cozodb/cozo-node';
const db = new CozoDb('rocksdb', '/tmp/cozo-smoke');
await db.run(':create test { id: String => v: Int }');
await db.run('?[id, v] <- [["a", 1]] :put test { id => v }');
const r = await db.run('?[id, v] := *test{id, v}');
console.log(r.rows);
```

CI gate: this script runs as part of the `daemon` build target.

### 0.2 `DbGraph` abstraction interface

Today every db/*.ts file imports `DbClient` from `db/client.ts` and
calls `db.graph.query(...)` directly. The migration introduces a
typed interface in front of that:

```ts
// src/insrc/db/graph-backend.ts

export interface DbGraph {
  /** Run a write statement with optional bound parameters. */
  exec(stmt: string, params?: Record<string, unknown>): Promise<void>;
  /** Run a read query and return rows. */
  query(stmt: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  /** Run a write batch atomically. Maps to Cozo's transaction; falls back to per-stmt sequential exec on Kuzu. */
  txWrite<T>(fn: (tx: DbGraphTx) => Promise<T>): Promise<T>;
}

export interface DbGraphTx {
  exec(stmt: string, params?: Record<string, unknown>): Promise<void>;
}
```

Kuzu and Cozo each provide one implementation. The selector is a
settings flag (Phase 5.1) plus, during dual-write phases, both are
populated and `db/client.ts` exposes both via the strategy.

This interface is **not** a generic graph DB API -- it's deliberately
narrow. Specifically, the query language at `stmt` is whichever
backend is active. The per-call-site code in `db/relations.ts` etc.
gets two implementations during the migration window: one Cypher,
one Datalog. The strategy in `graph-backend.ts` picks which to
invoke. After Phase 6 the Cypher version goes away and the file
stops being a strategy.

### 0.3 Cozo connection wrapper

```ts
// src/insrc/db/cozo-client.ts

import { CozoDb } from '@cozodb/cozo-node';
import { getLogger } from '../shared/logger.js';

const log = getLogger('cozo');

export class CozoGraph implements DbGraph {
  private readonly db: CozoDb;

  constructor(path: string) {
    this.db = new CozoDb('rocksdb', path);
  }

  async exec(stmt: string, params?: Record<string, unknown>): Promise<void> {
    const t0 = Date.now();
    try {
      await this.db.run(stmt, params ?? {});
    } catch (err) {
      log.warn({ stmt: stmt.slice(0, 200), err: String(err) }, 'cozo exec failed');
      throw err;
    }
    log.debug({ stmt: stmt.slice(0, 80), ms: Date.now() - t0 }, 'cozo exec');
  }

  async query(stmt: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const t0 = Date.now();
    const r = await this.db.run(stmt, params ?? {});
    log.debug({ stmt: stmt.slice(0, 80), rows: r.rows.length, ms: Date.now() - t0 }, 'cozo query');
    return rowsToObjects(r);
  }

  async txWrite<T>(fn: (tx: DbGraphTx) => Promise<T>): Promise<T> {
    // Cozo runs each `:put` / `:rm` atomically; multi-statement
    // transactions go through the multi-transact API. v1 wraps a
    // simple sequential exec; the multi-statement path lands when
    // the indexer's batched UNWIND hits a case that needs it.
    return fn({ exec: this.exec.bind(this) });
  }
}

function rowsToObjects(r: { headers: string[]; rows: unknown[][] }): Record<string, unknown>[] {
  return r.rows.map(row => Object.fromEntries(r.headers.map((h, i) => [h, row[i]])));
}
```

Connection lifecycle: one `CozoGraph` per daemon process. Cozo
handles its own internal concurrency; we don't replicate Kuzu's
two-Connection split because Cozo's storage layer already serializes
writes correctly via RocksDB and serves concurrent reads natively.

The `Database` segfault-on-close fragility from Kuzu does NOT carry
over -- Cozo's drop is clean. We can call `db.close()` in the
daemon's shutdown path without needing the workaround in
[client.ts:103](../src/insrc/db/client.ts#L103).

### 0.4 Logger module + telemetry

`module: 'cozo'` for low-level driver events, `module: 'graph'` for
DbGraph-level events. Per-query timing at `debug`; warn-level on
errors. Mirrors the pattern in
[daemon/db/drivers/](../src/insrc/daemon/db/drivers/) for the
data-driver tools.

Bench observability (Phase 4.3) plugs in here -- a debug-level
sampler that captures per-query latencies into a small ring buffer
the bench harness reads.

## Phase 1 -- schema

### 1.1-1.4 Schema declaration

The DDL (`:create`) statements from the schema-mapping section are
concatenated into a single `COZO_STATEMENTS` array in the new
`db/cozo-schema.ts`, mirroring `db/schema.ts`'s `KUZU_STATEMENTS`
pattern. Run on daemon startup via an extended `initDb()`.

`:create` is idempotent in Cozo when paired with `:if_not_exists`
(`:create entities { ... } if not exists` is the syntax in Cozo
0.7+). For older Cozo versions we wrap each create in a
try/catch over the "relation already exists" error.

### 1.5 Stored procedures for hot writes

Cozo's stored procedures (`:save_proc`) let us register a multi-step
write under a single name and call it with one round-trip. Worth doing
for the indexer's hot path:

```
:save_proc upsert_entity_batch as ?[id, kind] <- $rows :put entities { id => kind }
```

Then the indexer calls `?:upsert_entity_batch { rows: [[..., ...], ...] }`
once per batch. This is conceptually like a prepared statement; saves
parser overhead on every batch. The 500-row Kuzu batch size still fits.

For v1 we skip stored procedures and inline the queries; the
performance bench in Phase 4.3 decides whether they're worth the
complexity.

## Phase 2 -- per-file translation

Mechanical work, one file at a time. No behavior change because the
function signatures stay identical and the tests are the same.

For each file:

1. Add a Cozo branch alongside the Kuzu branch, gated on the
   strategy in `graph-backend.ts`.
2. Translate the queries per the table in "Query mapping".
3. Run the existing per-file tests against both backends. New tests
   added in Phase 4 (parity).

The slice list in the status table breaks this down per file; each
slice is a self-contained PR.

### 2.4 special note: `resolveClosure`

This is the most semantically loaded query in the codebase -- it
walks `DEPENDS_ON` (transitive) over registered repos to compute the
search closure for vector / FTS lookups. Today Kuzu does it via a
Cypher recursive pattern; Cozo does it via a recursive Datalog rule:

```
closure[from, to] := *depends_on{from, to}
closure[from, to] := closure[from, mid], *depends_on{from: mid, to}
?[r] := closure[$root, r]
```

The semi-naive evaluator inside Cozo handles this without us thinking
about fixed-point convergence. The query is one round-trip; Kuzu's
recursive form was also one round-trip. Behavior parity is direct.

### 2.5 special note: `getNextStep`

The plan-store's "find the next ready step" walks `STEP_DEPENDS_ON`
filtered by `status = 'pending'`. The Datalog version:

```
ready[step] := *plan_steps{id: step, status: 'pending', plan_id: $plan_id},
               not blocking[step]
blocking[step] := *plan_step_deps{step_id: step, depends_on_step_id: dep},
                  *plan_steps{id: dep, status: status},
                  status != 'done'
?[step, idx, title, ...] := ready[step], *plan_steps{id: step, idx, title, ...}
```

Negation-as-failure works in Cozo because the rules are stratified.
The query returns the first ready step (by `idx`); the TS caller adds
an `:order +idx :limit 1` qualifier.

## Phase 3 -- dual-write + backfill

### 3.1 Dual-write

The strategy in `graph-backend.ts` gains a `dualWrite` mode that:

- Sends every write to BOTH Kuzu and Cozo
- Reads exclusively from Kuzu (the authoritative source until
  cutover)
- Logs any divergence between the two on write (e.g. one fails, one
  succeeds)

A divergence is an alarm condition. Kuzu is still authoritative; the
write that succeeded on Kuzu is what users see. The Cozo failure
gets logged at `error` level and the Cozo store falls behind. Phase
3.3 reconciliation handles drift.

### 3.2 Backfill migrator

A one-shot migration script:

```ts
// scripts/migrate-kuzu-to-cozo.ts
```

Walks the existing Kuzu DB row by row and writes to Cozo. Idempotent:
re-running it is safe (cozo `:put` is upsert). Non-disruptive: runs
while the daemon is offline (or on a separate Cozo path that the
daemon picks up after restart).

Backfill order, dependency-driven:

1. `repos` (no deps)
2. `entities` (no deps; entity ids are independent)
3. Each edge relation (refers to entity ids, but Cozo doesn't
   foreign-key-enforce, so order is nominal)
4. `unresolved_relations`
5. `plans`, `plan_steps`, `plan_step_deps`

Per-relation throughput: read 1k rows from Kuzu, write 1k rows to
Cozo, repeat. Wall-clock budget on a 50k-entity / 500k-edge repo:
~30 s. The bench in 4.3 measures the actual figure on a real repo.

### 3.3 Backfill validation

After the migrator runs, a validation pass:

- Row-count parity per relation (`MATCH (e:Entity) RETURN count(e)`
  in Kuzu vs `?[count(id)] := *entities{id}` in Cozo)
- Sampled-edge check: pick 100 random `Entity` ids from Kuzu, walk
  CALLS / IMPORTS / DEPENDS_ON outgoing in both, assert set equality
- Plans / plan_steps: full-row diff (small N)

Failure of any of these blocks the migrator script with an explicit
diff report. The user reruns after fixing whatever caused the drift
(usually: another daemon was running concurrently and a write got
interleaved).

## Phase 4 -- shadow read + bench

### 4.1 Shadow read

The strategy adds a `shadowRead` mode that:

- Sends reads to BOTH Kuzu and Cozo
- Returns the Kuzu result to the caller (Kuzu is still primary)
- Compares the two results; logs any divergence

This runs in dev / staging environments only -- not in production
(double the read cost). Catches bugs in the Datalog translation that
the unit tests miss.

Divergence categories:

1. **Set inequality** -- different rows. Real bug.
2. **Order inequality on unordered queries** -- normalize, ignore.
3. **Missing rows on Cozo** -- backfill drift; trigger a re-backfill.
4. **Extra rows on Cozo** -- usually a stale entry from a prior
   dual-write window; alarming.

### 4.2 Per-query parity tests

Concrete tests under `db/__tests__/`:

```
findCallers.parity.test.ts     -- N entity ids, assert findCallers identical
findCallees.parity.test.ts
resolveClosure.parity.test.ts  -- N repos, assert closure identical
listRepos.parity.test.ts
unresolved.parity.test.ts
plan.parity.test.ts
```

Each runs against a fixture DB built from a snapshot of a real repo
at a known commit. CI gate during phases 4-5.

### 4.3 Bench harness on real repo

The bench from the discussion thread, now spelled out:

**Fixture**: snapshot the current Kuzu DB on a representative large
repo (≥10k files; the `insors-extraction` repo is a good candidate at
~3k files, or any monorepo we have access to). Export entities + all
8 edge tables to JSONL.

**Three load scripts** -- one per backend (kuzu, cozo, the third TBD):

- Kuzu via existing `repo.add`-driven indexer
- Cozo via the backfill migrator
- A third for sanity (raw RocksDB? sqlite?) if time permits

**Five queries** drawn from real `db/search.ts` patterns, each
replayed N times concurrently from K reader threads. The query
fixtures land under `scripts/bench/queries/`:

```
findCallers.fixtures.json
findCallees.fixtures.json
resolveClosure.fixtures.json
multihop.fixtures.json
indexer-write-pattern.fixtures.json   -- simulated UNWIND batches
```

**Metrics**:

- P50 / P90 / P99 latency per query
- Throughput (qps) at the read worker count
- Indexer-pass wall-clock (full re-index from cold)
- Disk space on a finished index
- Peak RSS during indexer pass

**Acceptance gates** for cutover:

- Read-path P50 within 1.2× Kuzu's
- Read-path P99 within 1.5× Kuzu's
- Indexer-pass wall-clock equal to or better than Kuzu's
- Disk space within 1.5× Kuzu's

Failing any of these means we don't flip the default in 5.3 and
revisit the migration plan.

## Phase 5 -- cutover

### 5.1 Settings flag

```
insrc.graph.backend = 'kuzu' | 'cozo' | 'dual-write' | 'shadow-read'
```

Default in this phase: still `'kuzu'`. The flag flips per daemon
instance and the strategy in `graph-backend.ts` honors it.

### 5.2 Production validation

Flip the flag for one user (developer) on one daemon; soak for one
week with normal usage. Watch for:

- Query latency in the daemon log
- Crash reports / unexpected shutdowns
- Indexer pass times relative to baseline
- Any divergence-log entries during the soak

### 5.3 Default to Cozo

Flip the default in `daemon/tools/config.ts` (or a fresh
`daemon/graph/config.ts`). Kuzu still callable via the flag for one
release window, in case rollback is needed.

## Phase 6 -- decommission

### 6.1-6.3 Remove Kuzu

After one release of Cozo as the default with no rollback events:

- Remove the kuzu branches from `db/relations.ts`, `db/search.ts`,
  etc. (the Cozo branches stay).
- Drop `kuzu` from `package.json` and run `npm i`.
- Remove `db/schema.ts` (Kuzu DDL).
- Filesystem cleanup: a one-shot migration on daemon startup deletes
  `~/.insrc/graph/` if `~/.insrc/graph-cozo/` exists. Idempotent.

### 6.4 Post-mortem

Append a new section to this plan capturing:

- Acceptance-gate numbers at cutover
- Any bugs surfaced during dual-write / shadow-read that the parity
  tests caught vs missed
- Production soak observations
- Performance delta vs Kuzu after one release of soak data

The post-mortem is the artifact a future migration (Cozo → next
graph DB, if it ever happens) will read first.

## Rollback plan

Phase-by-phase rollback story:

| If we discover a problem in... | Rollback is... |
|---|---|
| Phase 0-2 | Revert the slice. Kuzu is still authoritative; nothing user-visible. |
| Phase 3 (dual-write) | Disable dual-write via the strategy flag. Kuzu still authoritative. Cozo store on disk is harmless; can be deleted. |
| Phase 4 (shadow-read) | Same as Phase 3 -- dev/staging only, no prod impact. |
| Phase 5.1-5.2 (one developer's daemon on Cozo) | Flip the flag back to `'kuzu'`. Restart daemon. The Kuzu DB is still there because dual-write kept it warm; it's stale by however long the soak ran. **Re-index the affected repos** -- one explicit user action, ~minutes per repo. This is the only rollback that costs the user anything. |
| Phase 5.3 (cozo default) | Settings flag still works -- users flip to `'kuzu'`. Same re-index cost as 5.2. |
| Phase 6 (kuzu removed) | Rollback requires reverting the removal commit AND the user's local Kuzu store still being on disk (it was deleted in 6.3). After 6.3 lands, rollback is "wait for the next release". |

The only painful rollback window is **between 5.1 and 6.3** -- and
that's by design: the rollback cost is bounded (re-index, minutes per
repo) and we wait until 6.3 only after one full release of clean
soak data.

## Open questions

1. **Should we use Cozo's SQLite backing for the local-dev case?**
   RocksDB is the right answer for production (write throughput,
   concurrent reader); SQLite is simpler for dev and might play
   better with single-process testing. **Default: RocksDB everywhere
   for v1.** Switching backends is a one-line change in the
   constructor and we can flip if a dev reports friction.
2. **Stored procedures for hot writes (Phase 1.5)?** **Default: skip
   in v1.** Land if the bench shows parser overhead on indexer
   batches. Mechanical to add post-cutover.
3. **Do we want the Cozo store to live alongside the Kuzu store
   permanently (`~/.insrc/graph-cozo/` next to `~/.insrc/graph/`)?**
   This makes rollback cheap during 5.x but doubles disk for the
   migration window. **Default: yes, until 6.3.** Pre-cutover: ~50
   MB extra per repo. Trivial.
4. **Cozo version pinning policy.** Pin exact version through
   migration, allow `^` patches after Phase 6 lands cleanly. Same
   policy as `kuzu`'s today.
5. **Backup / disaster recovery.** Kuzu's DB directory is currently
   not included in any backup story (we re-index from source on
   loss). Cozo inherits this -- re-indexing is the recovery path.
   **No new backup work needed.**

## Lessons baked in from prior incidents

1. **Settings-gate the cutover.** Mirrors the
   `insrc.tools.enabledCategories` pattern -- a flag the IDE pushes
   so behavior changes don't require daemon restart. Phase 5.1 is
   that flag.
2. **Default-enabled list / registry agreement.** Our pre-2026-04-30
   experience with the cross-agent enabledCategories oversight
   teaches: every place that enumerates the "set of valid backends"
   must read from one source of truth. The strategy in
   `graph-backend.ts` and the settings parser in
   `daemon/tools/config.ts` both consume the same enum.
3. **No silent fallback on backend mismatch.** If the configured
   backend isn't available (e.g. cozo native module didn't load on
   this platform), the daemon fails to start with a clear log line.
   We do NOT silently fall back to Kuzu -- that's the kind of
   behavior the data-analyzer's hallucinated-class incident on
   2026-04-30 was made of.
4. **No hard wall-clock caps inside the migrator.** Per the no-
   walltime-caps lesson from the code-analyzer rollout, we don't
   give the backfill script a tight per-relation budget. It runs
   until done; the only cap is a generous 1-hour safety upper bound
   for the whole script (way more than measured wall-clock; never
   intended to fire).
5. **Confidence floor on shadow-read divergences.** When the parity
   check finds a mismatch, the failure detail surfaces at warn-level
   in the daemon log AND blocks the cutover until resolved. We do
   not "let it ride" expecting the divergence to resolve on its own;
   that's the pattern that turned cross-agent oversight into a
   user-facing hallucination.
