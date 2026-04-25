# Data Driver -- implementation plan

## Mission

Build the unified **data driver** that exposes live data sources to
the code analyzer (and eventually any agent that needs live data) via
a small, sandboxed tool surface under `db.*`. Three families in
scope:

- **RDBMS** -- Postgres, MySQL / MariaDB, SQLite, MSSQL, Oracle,
  CockroachDB, ClickHouse.
- **KV / document** -- Redis / Valkey / KeyDB, MongoDB, Cassandra
  (wide-column), NATS JetStream KV, DynamoDB, etcd, Memcached.
- **File** *(new -- not in the code-analyzer design doc)* -- CSV,
  TSV, JSON, JSONL, Excel (xlsx), Avro (OCF), Arrow / Feather,
  BSON, fixed-width text, Parquet. Read-only tabular / document
  files the user points at by path.

The "common" part of the name is a promise about the **tool-call
contract**, not the implementation: every RDBMS kind shares one
`describe` + `sample` shape, every KV kind shares one `scan` + `get`
+ `sample_shape` shape, and every file kind reuses whichever of the
two fits its schema. Underneath, each kind is a hand-written driver
module using the idiomatic npm package for that store -- **no single
abstraction library** (Prisma / Knex / Kysely / Drizzle) is adopted
runtime-wide. See [design §13.2][design-13-2].

This plan is the long-blocked "code-analyzer phase 3" called out in
[plans/artifact-tasks.md §3.1](artifact-tasks.md#phase-3----deeper-data-sources)
and in the code-analyzer design doc's
[§13 -- DB Driver Extension][design-13].

[design-13]:   ../design/code-analyzer/index.html
[design-13-2]: ../design/code-analyzer/index.html
[design-13-3]: ../design/code-analyzer/index.html
[design-13-4]: ../design/code-analyzer/index.html
[design-13-5]: ../design/code-analyzer/index.html

---

## Related documents

- [`design/code-analyzer/index.html`](../design/code-analyzer/index.html)
  §13 is the authoritative design for the RDBMS + KV portion. This
  plan defers to it on naming, shapes, and safety posture; additions
  here are limited to the **file** family and phase breakdown.
- [`plans/artifact-tasks.md`](artifact-tasks.md) -- unblocks **live-DB
  ER** (§3.1 of that plan) once phase 1 of this plan lands.
- [`plans/tools.md`](tools.md) -- tool registration + executor that
  every `db.*` tool plugs into.
- [`plans/tools-settings.md`](tools-settings.md) -- the per-tool
  approval + destructive-flag taxonomy `db.*` tools must declare.
- [`src/insrc/agent/tasks/artifacts/kinds/er-sources.ts`](../src/insrc/agent/tasks/artifacts/kinds/er-sources.ts)
  -- existing hand-rolled `schema.prisma` regex parser, reusable for
  the optional `schemaSource: 'prisma'` branch on RDBMS drivers.
- [`src/insrc/shared/keystore.ts`](../src/insrc/shared/keystore.ts)
  -- keytar-backed OS keychain. Re-used for DB URL secrets.

---

## Phase overview

| Phase | Scope                                                                   | Status |
|-------|-------------------------------------------------------------------------|--------|
| 0     | Foundations: config schema, driver registry, family interfaces, keychain integration | done (225e10ec68a) |
| 1     | Core drivers: 5 RDBMS + 4 KV + 8 file (CSV / JSONL / JSON / Excel / Avro / Arrow / BSON / fixed-width)               | partial -- 17 drivers compiled + registered; Prisma schema.prisma fast path + live-DB integration tests still open. |
| 2     | Setup UX: palette commands, Data Sources pane, connection tester                    | done (uncommitted) |
| 3     | Tool surface: `db.list_connections` + `db.sql.*` + `db.kv.*` + `db.file.*`          | in-progress -- 9 tools landed, browser `IInsrcDbConnectionsService.list()` shipped, `db.sql.explain` deferred to phase 3.2. |
| 4     | Guardrails: raw-query rejection, row/time caps, namespace scoping, opt-in           | done -- caps + raw-query denylist + KV namespace scoping landed in phase 1, per-repo opt-in short-circuit landed in phase 3. PII masking explicitly dropped (target is dev/staging, not prod). |
| 5     | Extended drivers: DynamoDB, etcd, ClickHouse, Parquet, CockroachDB                  | todo |
| 6     | Schema indexing: graph-resident `db_table` / `db_column` entities + ORM-aware linking | todo |

**Legend** for per-task status cells: `todo`, `in-progress`, `done`
(with commit sha or "uncommitted"), `partial` with deferred scope
called out (see
[`feedback_plan_status`](../../../.claude/projects/-home-subho-work-dev-insors-insrc-ide/memory/feedback_plan_status.md)).

---

## Goals

1. **One tool contract per family**. Adding a new store kind is a
   driver module + one `registerDriver()` call; the tool surface
   does not grow.
2. **Idiomatic npm drivers**. Use `pg` for Postgres, `mysql2` for
   MySQL, `better-sqlite3` for SQLite, `ioredis` for Redis,
   `mongodb` for Mongo. Files use `csv-parse` + `stream-json` where
   needed; everything else is Node stdlib.
3. **Read-only by default**. Tool inputs are structured (`target`,
   `where`-objects, key objects) -- never raw SQL or raw commands.
4. **Opt-in per repo**. Disabled unless at least one connection is
   configured in `~/.insrc/<repo>/db-connections.json`.
5. **Secrets stay in the OS keychain**. URL passwords are extracted
   on save, keyed under `db:<repoId>:<connId>`, and the URL stored
   in JSON with a `${secret:...}` placeholder.

## Non-goals

- Writing / mutating data. No `db.sql.insert`, no `db.kv.set`, no
  `db.file.write`. Ever.
- Cross-connection joins or federated queries.
- Production-grade security hardening. The target audience is
  dev / local / staging -- see [design §13.5][design-13-5] on why.
- Shipping a query language across families -- RDBMS `where`-objects
  and KV key-objects are intentionally separate shapes.
- Mapping files to "virtual tables" in a SQL engine (no
  DuckDB-in-process). File kinds are their own surface.

---

## Phase 0 -- Foundations

### 0.1 Config file shape

Per-repo config at `~/.insrc/<repoId>/db-connections.json`. Matches
[design §13.1][design-13] with a small extension for the `file`
family:

```jsonc
{
  "connections": [
    {
      "id":     "primary",           // unique within the repo
      "kind":   "postgres",          // open string; see registered drivers
      "family": "rdbms",             // optional; inferred from kind on load
      "label":  "Local (docker-compose)",
      "url":    "postgres://app@localhost:5432/app",
      "secretRef": "db:myrepo:primary",   // set on save; password lives in keychain
      "schemaSource": { "type": "prisma", "path": "prisma/schema.prisma" }
    },
    {
      "id":    "orders-csv",
      "kind":  "csv",
      "family": "file",              // new family
      "label": "Orders export",
      "path":  "data/orders.csv",    // relative to repo root
      "options": { "delimiter": ",", "header": true }
    }
  ]
}
```

- `id` is repo-unique and is the tool-call selector.
- `kind` is an **open string**. Unknown kinds reject at load time.
- `family` is inferred from `kind` unless overridden (e.g. MongoDB
  lives in `kv` but the user may set it explicitly).
- File kinds use `path` (repo-relative) instead of `url`. Paths that
  resolve outside the active repo go through the fs-access gate
  (§7.3 of the analyzer design).

### 0.2 Driver registry

- `src/insrc/daemon/db/registry.ts`:
  `registerDriver({ kind, family, factory })` +
  `listDrivers()` + `getDriver(kind)`.
- All built-in drivers register at daemon boot from
  `src/insrc/daemon/db/drivers/index.ts`.
- Unknown `kind` on config load -> actionable error in the daemon
  log + a single `connectionsLoadFailed` event on the IPC stream so
  the pane can surface it.

### 0.3 Family interfaces

Three TypeScript interfaces in `src/insrc/shared/db-driver.ts`
(shared so the browser pane can type-check against them):

```typescript
interface BaseDriver {
  readonly id:     string;
  readonly kind:   string;
  readonly family: 'rdbms' | 'kv' | 'file';
  close(): Promise<void>;
}

interface RdbmsDriver extends BaseDriver {
  family: 'rdbms';
  describe(target: string): Promise<SchemaDescription>;
  sample(target: string, opts: SampleOpts): Promise<SampleResult>;
  explain?(queryAst: QueryAst): Promise<PlanResult>;
}

interface KvDriver extends BaseDriver {
  family: 'kv';
  scan(opts: ScanOpts): Promise<KeyList>;
  get(key: string | Record<string, unknown>): Promise<KvValue>;
  sampleShape(opts: ScanOpts): Promise<ShapeReport>;
}

interface FileDriver extends BaseDriver {
  family: 'file';
  // Structured-file kinds (csv, tsv, jsonl, parquet) implement the
  // rdbms-shaped surface below; single-doc json implements the
  // kv-shaped one. A driver MAY implement both -- e.g. a JSON
  // driver that auto-detects doc vs. array-of-records.
  describe?(target?: string): Promise<SchemaDescription>;
  sample?(target: string | undefined, opts: SampleOpts): Promise<SampleResult>;
  sampleShape?(opts: ScanOpts): Promise<ShapeReport>;
  get?(path: string): Promise<KvValue>;
}
```

Exact shapes of `SchemaDescription`, `SampleResult`, `ScanOpts`,
`ShapeReport` come from [design §13.3][design-13-3] unchanged.

### 0.4 Secret handling

- On config save, daemon parses each `url`, extracts the password,
  writes it to the keychain under `db:<repoId>:<connId>`, and
  rewrites the JSON with `${secret:db:<repoId>:<connId>}` in place
  of the password.
- On driver factory: resolve `${secret:...}` via the keystore before
  building the connection URL. Keychain miss -> driver construction
  fails with a *user-actionable* "password missing for connection X;
  re-enter via `insrc.editDbConnection`" message.
- Keystore surface: reuse
  [`src/insrc/shared/keystore.ts`](../src/insrc/shared/keystore.ts)
  as-is. Service name stays `'insrc'`; account names are the
  `db:<repoId>:<connId>` strings.

### 0.5 Lifecycle

- Drivers are built lazily on first tool call and pooled for the
  daemon's lifetime.
- `connection.close` on daemon shutdown, on config reload for
  changed entries, and on explicit
  `db.reloadConnections` RPC (triggered by the setup UX).
- Unused connections idle-close after 10 minutes of no tool calls.

---

## Phase 1 -- Core drivers

Drivers are each self-contained in
`src/insrc/daemon/db/drivers/<kind>.ts`. Phase 1 covers 17 kinds
(5 RDBMS + 4 KV + 8 file) so the surface is useful end-to-end.

### 1.1 RDBMS -- Postgres / MySQL / SQLite / MSSQL / Oracle

| Kind      | npm driver        | Notes |
|-----------|-------------------|-------|
| postgres  | `pg`              | Pool from `new Pool({ connectionString })`; `information_schema.columns` for introspection. |
| mysql     | `mysql2/promise`  | Covers MariaDB too; `information_schema.columns` introspection. |
| sqlite    | `better-sqlite3`  | Sync driver; wrap in `Promise.resolve()` for the interface. `sqlite_master` + `PRAGMA table_info(<table>)` for introspection. |
| mssql     | `tedious` + `tarn` | Connection pool via `tarn`; `sys.columns` + `sys.types` for introspection. Supports SQL auth + Windows integrated auth; Azure AD token auth deferred to a follow-up. |
| oracle    | `oracledb`        | **Requires the Oracle Instant Client.** Thin mode (`oracledb.thin = true`, default from 6.x) works without it for 12c+ servers; thick mode needed for older servers. Setup UX detects missing client and surfaces install instructions. `ALL_TAB_COLUMNS` / `ALL_CONSTRAINTS` for introspection. |

Shared logic lives in
`src/insrc/daemon/db/drivers/rdbms-common.ts`:

- `compileWhere(whereObjects, dialect)` -> parametrised SQL
  fragment. Column names are validated against the cached
  `describe()` result *before* query compilation; unknown columns
  throw a typed error the tool layer turns into a retry-hint.
- `limit` is clamped to `min(input, 50)` inside this helper so no
  driver can forget the cap.

### 1.2 RDBMS -- schema.prisma fast path

- When `schemaSource.type === 'prisma'`, `describe(target)` reads
  the path (gated through the fs-access check when outside-repo),
  parses it via the existing regex parser at
  [`src/insrc/agent/tasks/artifacts/kinds/er-sources.ts`](../src/insrc/agent/tasks/artifacts/kinds/er-sources.ts),
  and returns the `SchemaDescription` built from the model
  declarations. **No live catalog query on schema.prisma repos.**
- `sample()` still hits the live DB -- the prisma file is schema
  truth only, never row data.
- Rationale: [design §13.2][design-13-2]; reuses the parser we
  already ship.

### 1.3 KV -- Redis, MongoDB, Cassandra, NATS

| Kind      | npm driver          | Notes |
|-----------|---------------------|-------|
| redis     | `ioredis`           | `SCAN MATCH` for `scan`; `GET` + `TYPE` for `get`; value-shape inferred in `sampleShape`. |
| mongodb   | `mongodb` (official)| Keys are `{ db, collection, _id }`; `scan` is a `find({}).project({_id:1}).limit()`; `sampleShape` walks the first N docs. |
| cassandra | `cassandra-driver` (DataStax) | **Wide-column store; classified as KV here because the tool surface is keyed access.** Connection config adds `keyspace` + `contactPoints` + `localDataCenter`. Keys are `{ keyspace, table, primaryKey }`; `scan` runs `SELECT <pk-cols> FROM <ks>.<table> LIMIT ?` (no `ALLOW FILTERING`); `get` looks up by full PK; `sampleShape` pulls N rows via `SELECT * ... LIMIT N` and merges the observed columns. Describe-shaped introspection via `system_schema.columns` is exposed indirectly -- agents that need it call `db.kv.sample_shape` which synthesises a schema from CQL metadata on the first call. |
| nats      | `@nats-io/nats-core` + `@nats-io/kv` | JetStream KV bucket. Connection config adds `servers` + `bucket`. `scan` uses `kv.keys(filter)` async iterable; `get` uses `kv.get(key)` returning `{ value: Uint8Array, revision }`; `sampleShape` decodes values as UTF-8 + JSON when possible (falls back to `{ type: "binary", bytes: N }`). Pattern matching uses NATS subject wildcards (`*`, `>`) rather than glob. |

Shared logic in `src/insrc/daemon/db/drivers/kv-common.ts`:

- `compileNamespace(opts, allowList)` -> validates `pattern` /
  `prefix` against the connection's `namespace.allow` list
  ([design §13.5][design-13-5]).
- `scan` cap 500; `sampleShape` sample cap 50; 5 s wall-clock
  timeout everywhere (`AbortSignal.timeout`).

### 1.4 File -- CSV, JSONL, JSON, Excel, Avro, Arrow, BSON, fixed-width

Every file kind below is **tabular-leaning** (rdbms-shape), with one
exception -- single-document JSON falls back to kv-shape when the
root is an object rather than an array.

| Kind        | npm driver              | Family-surface                                  |
|-------------|-------------------------|-------------------------------------------------|
| csv         | `csv-parse`             | rdbms-shape; header row -> columns; type inference samples first 100 rows. |
| jsonl       | none (stdlib)           | rdbms-shape; each line is a record; `describe` samples first 100 lines, merges observed fields into a union schema. |
| json        | none (stdlib)           | kv-shape (`get` returns the whole doc; `sampleShape` over its top-level). If the root is an array-of-objects, auto-promotes to rdbms-shape. |
| xlsx        | `exceljs`               | rdbms-shape. **Each sheet is a `target`** (`describe(sheetName)` / `sample(sheetName, opts)`); `list_targets` for multi-sheet files. Streaming read; first row treated as header unless `options.header === false`. |
| avro        | `avsc`                  | rdbms-shape. Schema is in the OCF header, so `describe` is zero-cost (no row sample needed). Streamed decode via `avsc.createFileDecoder` for `sample`. |
| arrow       | `apache-arrow`          | rdbms-shape. Covers `.arrow` (IPC stream / file) + `.feather` (Arrow v2). Columnar format is memory-mapped via `RecordBatchFileReader` / `RecordBatchStreamReader`; column types come from the schema directly. |
| bson        | `bson` (official)       | rdbms-shape when the file is a stream of documents (typical `mongodump` output; each doc is a record). `describe` samples first 100 docs and merges observed fields. |
| fixed-width | none (hand-rolled)      | rdbms-shape. **Requires a column spec** in `options.columns: { name, start, length, type }[]` -- there is no in-band schema, so the config carries it. No library dep; parser is ~50 LoC on a streamed read. |

- File drivers resolve `path` relative to the repo root. Absolute
  paths and paths that escape the repo go through the fs-access
  gate from the analyzer design (§7.3).
- `sample()` streams the file wherever the format allows -- never
  read the whole thing into memory. The 50-row limit applies the
  same way.
- Results include `metadata.fileSize` and `metadata.rowCountHint`
  (exact once we've streamed to EOF; otherwise `>=<N>`). Arrow +
  Avro + Parquet carry exact row counts in their footers / headers
  and populate it without streaming.
- **Binary formats (Avro / Arrow / BSON / Parquet / xlsx)** also
  populate `metadata.schemaSource = "header"` to distinguish from
  text formats where the schema is inferred from samples.

### 1.5 Driver tests

- Unit tests per driver under
  `src/insrc/daemon/db/drivers/__tests__/<kind>.test.ts`.
  `node:test` + `node:assert`, no new deps.
- **RDBMS drivers** run against docker-compose'd test instances
  (`test/fixtures/db-driver/docker-compose.yml`) -- Postgres + MySQL
  + a throwaway SQLite file. Guarded by `INSRC_DB_TESTS=1` so CI can
  opt in without always running containers.
- **KV drivers** -- same shape; Redis + MongoDB containers in the
  compose file.
- **File drivers** -- purely local fixtures under
  `test/fixtures/db-driver/files/`. No env flag needed.

---

## Phase 2 -- Setup UX

Four palette commands, one pane section, one connection tester.
Mirrors the Model Providers pane pattern.

### 2.1 Palette commands

- `insrc.addDbConnection` -- walks kind -> URL/path -> label ->
  (for SQL kinds) optional Prisma schema path. Password extracted to
  keychain; JSON written with `${secret:...}` placeholder.
- `insrc.editDbConnection` -- quick pick over existing connections;
  reuses the add flow pre-populated.
- `insrc.removeDbConnection` -- confirm dialog; deletes from JSON +
  keychain.
- `insrc.testDbConnection` -- runs the driver-level connection
  probe (RDBMS: `SELECT 1`; KV: driver-native ping; File: file
  exists + first-line parseable) and surfaces success / error as a
  toast.

Commands live in
`src/vs/workbench/contrib/insrc/browser/dbDrivers/dbConnectionCommands.ts`.
Each command round-trips to the daemon via a new
`IInsrcDbConnectionsService` (Phase 3).

### 2.2 Data Sources pane

- Section in the existing Model Providers pane (not a new pane).
  Rationale: same ergonomics, same "configuration surface" mental
  model, avoids another navigable view.
- Shows connections grouped by family; each card: label, kind
  badge, URL (redacted), status light (green / amber / red based on
  the last test), `Test` / `Edit` / `Remove` actions.
- Empty state: a single *Add data source* button + a link to
  the docs. No auto-detection of existing docker-compose / repo
  SQLite files in phase 2 (deferred).

### 2.3 Connection tester

- Daemon RPC `db.testConnection({ config })`. Builds a transient
  driver, runs the probe, closes it. Does not register the
  connection.
- Tester is also called automatically on save from the palette
  flow; surface the error if it fails.

---

## Phase 3 -- Tool surface

Five tools registered under the `db` category via the same
`registerTool` pattern as the `artifact:*` tools
([`src/insrc/daemon/tools/builtins/artifact/index.ts`](../src/insrc/daemon/tools/builtins/artifact/index.ts)):

| Tool id                       | Input                                                     | Output                                         |
|-------------------------------|-----------------------------------------------------------|------------------------------------------------|
| `db.list_connections`         | `{}`                                                      | `{ id, kind, family, label, status }[]`        |
| `db.sql.describe`             | `{ connectionId, target }`                                | `SchemaDescription`                            |
| `db.sql.sample`               | `{ connectionId, target, limit, where? }`                 | `SampleResult`                                 |
| `db.sql.explain`              | `{ connectionId, queryAst }`                              | `PlanResult`  *(phase 3.2)*                    |
| `db.kv.scan`                  | `{ connectionId, pattern? \| prefix?, limit }`            | `KeyList`                                      |
| `db.kv.get`                   | `{ connectionId, key }`                                   | `KvValue`                                      |
| `db.kv.sample_shape`          | `{ connectionId, pattern? \| prefix?, limit }`            | `ShapeReport`                                  |
| `db.file.describe`            | `{ connectionId }`                                        | `SchemaDescription` (for tabular file kinds)   |
| `db.file.sample`              | `{ connectionId, limit, where? }`                         | `SampleResult`                                 |
| `db.file.sample_shape`        | `{ connectionId, path?, limit }`                          | `ShapeReport` (for document file kinds)        |

Dispatch rules:

- `db.sql.*` on a non-RDBMS connection rejects with a typed
  `FAMILY_MISMATCH` error that names the correct namespace; the
  same applies to `db.kv.*` and `db.file.*`.
- `db.sql.explain` is marked optional in the driver interface
  and returns `UNSUPPORTED` on kinds that don't implement it.
- All tools are **non-destructive**; `requiresApproval` is false.
  Approval gates for DB access are a session-level concern (the
  user approves "use DB tools for this session"), not per-call.

### Browser-side service

- `IInsrcDbConnectionsService` in
  `src/vs/workbench/contrib/insrc/common/dbConnectionsService.ts`:
  `list()`, `add(config)`, `edit(id, config)`, `remove(id)`,
  `test(config)`. Backed by daemon RPCs; no local cache (surface is
  rare-use, same trade-off as `IInsrcArtifactsService`).

---

## Phase 4 -- Guardrails

Most of these are already enforced *at the driver layer* (phase 1);
phase 4 wires the cross-cutting pieces.

### 4.1 Raw-query rejection

- `db.sql.sample` and `db.kv.scan` inputs are structured already;
  nothing to enforce.
- The driver-level SQL compilers (`rdbms-common.ts`) emit only
  parametrised `SELECT` statements. A regex guard in the helper
  rejects any compiled fragment that contains a semicolon or a
  keyword from a denylist (`INSERT|UPDATE|DELETE|DROP|TRUNCATE|
  ALTER|CREATE|GRANT|REVOKE|CALL|DO|BEGIN|COMMIT`). Belt and
  braces; the parametriser should never produce these.
- KV drivers do not expose raw commands -- each exposed method is a
  single client method call (`SCAN`, `GET`, `TYPE`). There is no
  `RAW` escape hatch.

### 4.2 Result + timeout caps

- RDBMS: 50 rows, 5 s. Enforced in `rdbms-common.ts`.
- KV: 500 keys for `scan`, 50 values for `sample_shape`, 5 s across
  the board. Enforced in `kv-common.ts`.
- File: same as RDBMS for `sample`; 5 s walltime; 50 records for
  `sample_shape` on JSON.
- All timeouts use `AbortSignal.timeout(5000)`. Drivers that don't
  natively accept `AbortSignal` wrap their client call in
  `Promise.race` + a cleanup step (`.close()` / `.abort()`).

### 4.3 PII masking -- **dropped from scope**

Originally specified as a per-connection `pii` array that would
hash-substitute matched fields in tool results. **Not shipping**
because the data driver's expected target is dev / local / staging
DBs (see [design §13.5][design-13-5] and the mission preamble at
the top of this plan); the `pii` toggle was a prod-safety nudge
for a use case we explicitly don't optimise for.

If a user does point at prod, they own the choice -- the same way
they would when opening a `psql` shell. We don't pretend hashing
is a security boundary; if real prod safety is wanted later it
needs design-level work (audit logs, append-only access journal,
read-only enforcement at the SQL grant level), not a string-
matcher.

Reflected: the `pii` field stays on the `ConnectionConfig`
TypeScript shape so a future revisit is non-breaking, but no
driver consumes it. The setup UX does not surface a PII column
picker.

### 4.4 Namespace scoping (KV)

- Connection config gains optional `namespace.allow: string[]`.
- `kv-common.ts#compileNamespace` rejects any `pattern` /
  `prefix` that does not fall entirely within one of the allowed
  prefixes. Error is user-facing so the LLM sees it and retries
  with a valid pattern.

### 4.5 Per-repo opt-in

- Tool executor short-circuits `db.*` calls to `NO_CONNECTIONS_CONFIGURED`
  when `db-connections.json` is missing or has zero entries for the
  active repo. The tool is still *listed* (so the LLM can pick it
  up) but every call errors until the user configures one.

---

## Phase 5 -- Extended drivers

Ships after phase 3 proves the core surface. Each kind is a single
driver module + a registry line; the tool surface does not grow.

| Kind               | npm driver                      | Family | Why deferred |
|--------------------|---------------------------------|--------|--------------|
| cockroachdb        | `pg`                            | rdbms  | Wire-compatible with Postgres; trivial once phase 1 ships. |
| clickhouse         | `@clickhouse/client`            | rdbms  | Column types diverge from standard SQL; needs type-mapping work. |
| dynamodb           | `@aws-sdk/client-dynamodb`      | kv     | Partition+sort key model; namespace scoping needs rethinking. |
| etcd               | `etcd3`                         | kv     | Hierarchical paths instead of patterns. |
| valkey / keydb     | `ioredis`                       | kv     | Protocol-compatible with Redis; trivial. |
| memcached          | `memjs`                         | kv     | No SCAN; listing requires `stats items` walking. |
| tsv                | `csv-parse` (`delimiter: '\t'`) | file   | Sibling of csv; drops out naturally. |
| parquet            | `parquetjs` or `duckdb-async`   | file   | Columnar binary format; picks up Parquet metadata natively. |

---

## Phase 6 -- Schema indexing (graph-resident DB schemas)

So far the data driver fetches schema **on demand** per tool call.
That's the right shape for sample / get / where-filter use cases,
but it leaves a class of analyzer questions awkward to answer:

- "Which functions read from `users.email`?"
- "Show every code path that writes to a column flagged `pii`."
- "Find schema drift: prisma model fields that have no matching
  column on the live DB."

These need DB schemas to live in the same Kuzu graph as code
entities, with edges joining the two worlds. Phase 6 lifts schemas
into the graph so cross-cutting queries become a Cypher away.

### 6.1 Graph extensions

Add to `EntityKind` (currently code-only -- see
[`shared/types.ts`][types.ts]):
- `db_table`        -- one per RDBMS table / KV collection / file dataset
- `db_column`       -- one per RDBMS column (KV / file map onto inferred
                       fields the same way; family-tagged on the entity)
- `db_namespace`    -- optional, for KV stores with `namespace.allow`

Add to `RelationKind`:
- `FK_TO`           -- column -> column foreign key
- `BELONGS_TO`      -- column -> table containment (mirrors how `class`
                       members relate to `class` today)
- `READS_COLUMN`    -- function/method -> column
- `WRITES_COLUMN`   -- function/method -> column

Stable IDs follow the existing convention -- `SHA256(repo + connId
+ kind + name)` keeps the entity id deterministic across re-indexes
even when table layouts shift internally.

[types.ts]: ../src/insrc/shared/types.ts

### 6.2 Indexer hook

A new step at the end of the per-repo index pass walks every
configured connection in `db-connections.json` and persists its
schema:

```
for each connection in loadConnections(repoRoot):
    if family == 'rdbms':
        for each table from describe-walk:
            upsert db_table + db_column entities
            emit FK_TO edges from constraint metadata
    elif family == 'kv':
        sample_shape on the connection's namespace prefixes
        upsert db_namespace + db_column entities (one column per
        observed top-level field)
    elif family == 'file':
        describe -> upsert db_table + db_column
```

Re-runs on `db.saveConnection` / `db.deleteConnection` (the pool
already calls `reloadAll()` on save; we extend it to also kick the
indexer's per-repo pass for the affected `repoRoot`).

Skipped automatically when a connection's test probe fails -- the
schema-indexer treats unreachable databases as soft errors so the
overall index doesn't fail just because the user's local Postgres
is down.

### 6.3 Code-side discovery (joining the two worlds)

The graph is only useful if code entities link to db ones. Three
sources of those links, in increasing fidelity:

1. **ORM model declarations.** Extend the tree-sitter parsers to
   recognise Prisma model blocks, Drizzle table builders,
   SQLAlchemy `Column` calls, Django model fields, ActiveRecord
   `t.string`, etc. Each model field becomes a `BELONGS_TO`-edged
   `db_column` entity *and* a `class`-style code entity, so a
   single column can be queried from either side.
2. **Raw query strings.** Pattern-match SQL string literals in
   source for `FROM <table>` / `INSERT INTO <table>` /
   `UPDATE <table>` -- emit `READS_COLUMN` / `WRITES_COLUMN` on the
   columns named in the projection / SET clause when statically
   resolvable. Best-effort; not a parser, just heuristics.
3. **Runtime traces** (out of scope; flagged for a later phase) --
   instrument the user's test runs and observe which functions
   actually touch which tables. High-fidelity but invasive.

Phases 1 + 2 land here; phase 3 is its own discussion.

### 6.4 Storage + cost

Per-table entity cost: ~1 `db_table` + N `db_column` rows in
LanceDB + their `BELONGS_TO` / `FK_TO` edges in Kuzu. A typical
mid-size schema (50 tables, ~500 columns total) adds roughly 1000
graph rows -- negligible against the existing code-entity volume.

### 6.5 Open questions

- **Versioning.** When a column is dropped, the `db_column` entity
  should disappear from the graph but its references from code
  (`READS_COLUMN`) might still resolve to a now-stale id. Probably
  re-emit-then-prune on each index pass, same as code.
- **Multi-tenancy.** Cassandra keyspaces, Postgres schemas,
  MongoDB collections all introduce a "tenant" axis. For phase 6
  we treat the keyspace/schema as the qualifier on `db_table.name`
  (`public.users`) and call it done.
- **PII propagation.** With Phase 4's PII masking dropped, the
  `pii` array on `ConnectionConfig` is currently inert. If a
  future phase revives it (e.g. as a query-time warning rather
  than a hash-substitute), this is where graph-resident
  propagation would slot in.

### 6.6 Status

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| `EntityKind` + `RelationKind` extensions   | todo   |       |
| Indexer schema-walker (per family)         | todo   |       |
| Reload-on-save / reload-on-delete hook     | todo   |       |
| ORM-model parser extensions                | todo   |       |
| SQL-string heuristic linker                | todo   |       |
| Re-index trigger from `db.saveConnection`  | todo   |       |

---

## Testing strategy

### Per-driver
- Unit tests with fixtures where possible (SQLite, files).
- Integration tests against docker-compose'd instances (Postgres,
  MySQL, Redis, MongoDB). Gated by `INSRC_DB_TESTS=1`.
- Each driver asserts:
  - `describe` returns the expected columns/fields.
  - `sample` respects the limit + where filter.
  - `scan` respects `namespace.allow`.
  - Timeout fires cleanly (wall-clock test with an artificial
    delay; driver should return `TIMEOUT` rather than hang).
  - Raw SQL attempts rejected at the helper layer.

### End-to-end
- `scripts/test-db-driver-live.ts` -- spin up the compose stack,
  register connections, call each tool, assert shapes. Run locally
  before a PR that touches this code.
- Smoke test: artifact-tasks.md Phase 3 "live-DB ER" becomes an
  end-to-end signal once the ER renderer is wired.

### Security posture tests
- `no-raw-sql.test.ts`: fuzzes `where`-objects and column names
  looking for injection paths into the compiled SQL.
- `no-fs-escape.test.ts`: file-family drivers reject paths outside
  the active repo unless the gate is explicitly granted.
- `secret-leak.test.ts`: asserts that connection URLs and error
  messages never contain the plaintext password after save.

---

## Blocks / blocked-on

- **Blocks** `artifact-tasks.md` Phase 3.1 (live-DB ER via
  `db.sql.describe`).
- **Blocks** any future analyzer task that reasons about live data
  ("does the code match the schema?", "what shape is
  `users.metadata`?").
- **Blocked-on** nothing -- the analyzer tool-call plumbing, keystore,
  and artifact-kinds Prisma parser are all in place already.

---

## Open risks / deferred follow-ups

- **ORM repo detection.** We ship a Prisma-schema fast path but the
  code-analyzer itself might want to *detect* that a repo uses
  Drizzle / TypeORM / Sequelize / ActiveRecord and map their
  abstractions to `db.sql.describe` calls. Deferred to a later
  analyzer phase.
- **Schema drift.** If the repo's `schema.prisma` disagrees with
  the live DB, `describe` will surface whichever we asked for; we
  don't diff them. Add a `db.sql.diff_schema(connectionId)` tool
  later if analyzers start asking.
- **Auto-detect local DBs.** A repo with `docker-compose.yml`
  containing `image: postgres` is a very strong hint we could seed
  a default connection from. Deferred until the base UX is in.
- **Parquet metadata.** Parquet files carry column stats (min/max,
  null counts). We throw that away in phase 5; a later pass can
  surface them in `describe`.
- **Write-path tools.** Repeated temptation to add "just a small
  `db.sql.delete_where` for test setup". The answer is always no;
  analyzers are read-only.

---

## Status tracking

### Phase 0 -- Foundations
| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| `db-connections.json` schema + loader      | done (225e10ec68a) | `daemon/db/config.ts`. Per-repo at `~/.insrc/repos/<repoId>/db-connections.json`; repoId = sha256 of repo path matching the indexer's `repo` entity id. |
| Driver registry (`registerDriver`)         | done (225e10ec68a) | `daemon/db/registry.ts`. Module singleton; re-registration logs a warning + replaces (useful for tests). |
| `BaseDriver` + family interfaces           | done (225e10ec68a) | `shared/db-driver.ts` -- RdbmsDriver / KvDriver / FileDriver + result shapes. Shared with the browser pane. |
| Keystore integration (`${secret:...}`)     | done (225e10ec68a) | `daemon/db/secrets.ts`. `extractUrlPassword` + `resolveSecrets` round-trip; re-uses the existing `keytar`-backed keystore. |
| Connection lifecycle (pool, idle-close)    | done (225e10ec68a) | `daemon/db/pool.ts`. Per-repo `DriverPool`; 10-minute idle close; in-flight build promise so concurrent first-calls share one build. |

### Phase 1 -- Core drivers
| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| Postgres driver (`pg`)                     | done (0b558c339d2) | `drivers/pg.ts`. Pool(max=3). Introspection: `information_schema.columns` + `pg_index` (PK) + constraint_column_usage (FK). |
| MySQL driver (`mysql2`)                    | done (4ddc3afbf01) | `drivers/mysql.ts`. Covers `mysql` + `mariadb`. `information_schema.columns` + `KEY_COLUMN_USAGE` for PK + FK. |
| SQLite driver (`better-sqlite3`)           | done (4ddc3afbf01) | `drivers/sqlite.ts`. Read-only (`readonly:true` + `pragma query_only=ON`). Introspection via PRAGMA `table_info` + `foreign_key_list`. |
| MSSQL driver (`tedious` + `tarn`)          | done (8015a3c3ed3) | `drivers/mssql.ts`. SQL auth via URL. Pooling via `tarn`. Introspection: `sys.columns` + `sys.indexes`. TOP N sampling via MSSQL dialect. |
| Oracle driver (`oracledb`)                 | done (8015a3c3ed3) | `drivers/oracle.ts`. Thin mode (default 6.x; no Instant Client for 12c+). Introspection: `ALL_TAB_COLUMNS` + `ALL_CONSTRAINTS` + `ALL_CONS_COLUMNS`. `FETCH FIRST N ROWS ONLY`. |
| RDBMS shared helpers + prisma fast path    | partial (0b558c339d2) | `drivers/rdbms-common.ts` has dialect quoting + parametrised where-compile + DML/DDL denylist + withTimeout wrapper. **Prisma schema.prisma branch still todo** -- wiring to the artifact-kinds regex parser is a follow-up. |
| Redis driver (`ioredis`)                   | done (0b558c339d2) | `drivers/redis.ts`. Covers `redis` + `valkey` + `keydb`. Non-blocking SCAN MATCH; JSON auto-decode for GET values. |
| MongoDB driver (`mongodb`)                 | done (4ddc3afbf01) | `drivers/mongodb.ts`. KV-family. Keys are `{db, collection, _id}`; target via `prefix="<db>.<collection>"`. |
| Cassandra driver (`cassandra-driver`)      | done (8015a3c3ed3) | `drivers/cassandra.ts`. Multi-part PKs resolved via `system_schema.columns`; scan selects only PK cols with LIMIT, no ALLOW FILTERING. Config needs options.contactPoints + options.localDataCenter. |
| NATS KV driver (`@nats-io/kv`)             | done (8015a3c3ed3) | `drivers/nats.ts`. JetStream KV bucket only. Connect via `@nats-io/transport-node`. Subject-wildcard scan patterns; UTF-8 + JSON value decode. |
| KV shared helpers (namespace + caps)       | done (0b558c339d2) | `drivers/kv-common.ts`. Namespace whitelist enforcement + scan/sample-shape clamps + inferShape (nested objects, arrays, binary detection). |
| CSV driver (`csv-parse`)                   | done (0b558c339d2) | `drivers/csv.ts`. Streaming reader with early-exit on limit. Header required; type inference from first 100 rows. TSV registers with delimiter='\t'. |
| JSONL driver (stdlib stream)               | done (4ddc3afbf01) | `drivers/jsonl.ts`. Covers `jsonl` + `ndjson`. node:readline streaming; typed line-number error on malformed JSON. |
| JSON single-doc driver (stdlib)            | done (4ddc3afbf01) | `drivers/json.ts`. Dual-mode: array-of-objects -> rdbms-shape; object -> kv-shape (get with JSON pointer). |
| Excel driver (`exceljs`)                   | done (8015a3c3ed3) | `drivers/xlsx.ts`. Per-sheet `target` dispatch; reads header row for column names; in-memory filter (exceljs streaming+filter doesn't mix). |
| Avro driver (`avsc`)                       | done (8015a3c3ed3) | `drivers/avro.ts`. Header-schema driven `describe` (zero-cost); union types collapse to non-null branch; streamed decode for sample. |
| Arrow / Feather driver (`apache-arrow`)    | done (8015a3c3ed3) | `drivers/arrow.ts`. Covers `.arrow` + `.feather`. Schema from IPC footer; sample materializes up to N rows + applies WHERE in memory. |
| BSON driver (`bson`)                       | done (8015a3c3ed3) | `drivers/bson.ts`. Length-prefixed doc stream (mongodump layout); describe samples first 100 docs + merges fields. |
| Fixed-width driver (hand-rolled)           | done (8015a3c3ed3) | `drivers/fixed-width.ts`. No lib dep; requires `options.columns: {name, start, length, type}[]`. Type coercion + encoding + skipFirstLine options. |
| Per-driver unit + docker tests             | partial (0b558c339d2, 4ddc3afbf01) | Unit tests landed for rdbms-common + kv-common + csv + jsonl + json + sqlite (end-to-end via pool). Live-DB integration tests against docker-compose'd Postgres / MySQL / MSSQL / Oracle / Redis / MongoDB / Cassandra / NATS still **todo**. |

### Phase 2 -- Setup UX
| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| `insrc.addDbConnection`                    | done (uncommitted) | Repo picker (skipped when only one registered) -> kind picker -> id -> URL/path -> label. URL passwords redacted to keychain by daemon before persistence. |
| `insrc.editDbConnection`                   | done (uncommitted) | Same flow, prepopulated; upserts on `id`. Accepts optional `{repoRoot, id}` args from the pane to skip the pickers. |
| `insrc.removeDbConnection`                 | done (uncommitted) | Confirm dialog, then deletes the JSON entry + clears its keychain secret. |
| `insrc.testDbConnection`                   | done (uncommitted) | Builds a transient driver via the registry factory; closes immediately. Hydrates url/path from db-connections.json when only `{id}` is given (palette flow). |
| Data Sources pane (accordion of repos)     | done (uncommitted) | **Standalone** pane (not a tab in Model Providers, since data sources are per-repo and providers are global). `<details>`/`<summary>` accordion with [+ Add connection] button + per-row Test/Edit/Remove actions delegating to the palette commands with `{repoRoot, id}` preset. Opens via `insrc.openDataSources`. |
| `db.testConnection` daemon RPC             | done (uncommitted) | Plus `db.saveConnection`, `db.deleteConnection`, `db.listDriverKinds` for the kind picker. Shape on `daemon/db-rpc.ts`. |

### Phase 3 -- Tool surface
| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| `db:list_connections`                      | done (uncommitted) | Tool ids use the existing `category:action` colon pattern (`db:sql:describe`, etc.); the plan's `db.sql.describe` prose is purely naming. |
| `db:sql:describe` / `db:sql:sample`        | done (uncommitted) | Structured `where` objects only; limit clamped at 50; column names validated against describe() cache before query compile. |
| `db:sql:explain`                           | todo   | Phase 3.2 follow-up |
| `db:kv:scan` / `db:kv:get` / `db:kv:sample_shape` | done (uncommitted) | Honors `namespace.allow` via kv-common; scan cap 500, sample_shape cap 50. |
| `db:file:describe` / `db:file:sample` / `db:file:sample_shape` | done (uncommitted) | File driver methods are optional; tools surface clean "UNSUPPORTED" errors when a kind doesn't implement one (e.g. single-doc json rejects describe). |
| `FAMILY_MISMATCH` error shape + retry hint | done (uncommitted) | `acquireDriver` rejects with `FAMILY_MISMATCH: Connection X is kv; use db:kv:* instead` so the LLM retries with the right namespace. |
| `IInsrcDbConnectionsService` browser-side  | done (uncommitted) | Phase 3 ships `list()` only; add/edit/remove/test land with phase-2 setup UX. Backed by `db.listConnections` daemon RPC. |

### Phase 4 -- Guardrails
| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| Raw-SQL regex guard                        | done (Phase 1) | `looksLikeMutation` + DML/DDL denylist in rdbms-common. |
| Row / time caps (enforced in shared)       | done (Phase 1) | 50 rows + 5s RDBMS; 500 keys + 50 values + 5s KV; 50 rows + 5s file. |
| PII masking (hash substitution)            | dropped | Target audience is dev / local / staging, not prod; hashing isn't a real security boundary anyway. See §4.3 for rationale. The `pii` field on `ConnectionConfig` stays so a future revisit is non-breaking. |
| KV namespace scoping                       | done (Phase 1) | `assertNamespaceAllowed` in kv-common. |
| Per-repo opt-in short-circuit              | done (Phase 3) | Tools short-circuit to `NO_CONNECTIONS_CONFIGURED` when the repo has no entries in `db-connections.json`. |
| Guardrail tests (injection, fs escape)     | partial | rdbms-common injection tests + pool fs-escape test landed; full-matrix injection fuzz still todo. |

### Phase 5 -- Extended drivers
| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| CockroachDB (pg reuse)                     | todo   |       |
| ClickHouse driver                          | todo   |       |
| DynamoDB driver                            | todo   |       |
| etcd driver                                | todo   |       |
| Valkey / KeyDB (ioredis reuse)             | todo   |       |
| Memcached driver                           | todo   |       |
| TSV driver (csv-parse reuse)               | todo   |       |
| Parquet driver                             | todo   |       |
