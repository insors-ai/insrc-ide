# Plan: DuckDB-backed File Driver

Consolidate the bespoke per-format file drivers (csv, jsonl, json, parquet,
arrow) into a single DuckDB-backed driver, and extend the formats DuckDB
doesn't natively read (avro, bson, fixed-width, xlsx) via thin Parquet
converters with cached output. Add **directory-as-table** support so a
connection can point at a tree of files (with recursive descent) and the
query layer sees one logical table.

## Why

The existing file driver layer in
[`src/insrc/daemon/db/drivers/`](../src/insrc/daemon/db/drivers/) ships nine
bespoke drivers (csv, jsonl, json, xlsx, avro, arrow, bson, fixed-width,
parquet) plus shared helpers. Each implements `describe / sample /
sampleShape` against its own parser library. This works for introspection
but **none of them aggregate** -- the data-analyzer-skills.md Phase 0
explicitly needs aggregation (`db_file_aggregate`, `db_correlation_matrix`,
`db_outliers`) over file connections, and there is no path through the
existing drivers that gives us this without writing per-format
aggregation code N more times.

DuckDB collapses this:

1. **One SQL surface for files**. `read_csv_auto` / `read_parquet` /
   `read_json_auto` cover the majority of file kinds natively; queries get
   the full DuckDB analytical SQL surface (`regr_*`, `skewness`,
   `kurtosis`, `mad`, `mode`, `entropy`, percentiles, window functions,
   approximate aggregates).
2. **Streaming + projection pushdown**. CSV / JSONL stream through
   memory-bounded; Parquet projects only the columns the query references.
   For large files this is 5-100× faster than today's row-by-row JS path.
3. **Directory-as-table for free**. DuckDB globs (`'/data/**/*.parquet'`)
   and hive-partition discovery (`hive_partitioning=true`) make a tree of
   files queryable without ingestion. This is the foundation for
   "connection points at a directory" semantics.
4. **Format consolidation**. Five bespoke drivers (csv, jsonl, json,
   parquet, arrow) collapse into one DuckDB-backed driver. The four
   formats DuckDB cannot read natively (avro, bson, fixed-width, xlsx)
   stay covered via converters that produce Parquet; the rest of the
   stack (driver, tools, skills) sees only Parquet.

## Related plans

- [plans/data-driver.md](data-driver.md) -- shipped; the
  multi-driver substrate this plan reshapes the file portion of. The
  `RdbmsDriver` / `KvDriver` halves of that plan are unchanged; this
  plan touches only `FileDriver` + adds DuckDB as a new daemon
  dependency.
- [plans/analyzers/data-analyzer-skills.md](analyzers/data-analyzer-skills.md)
  -- depends on this plan's outcomes. Phase 0.4 (`db_file_aggregate`)
  and Phase 0.10 (`db_file_list_files`) collapse into "use the new
  driver" once this lands. Phase 1.3 (file source-introspection skills)
  gets cheaper for the same reason.
- [plans/access-gate.md](access-gate.md) -- shipped; the file driver's
  path security continues to flow through the universal access gate
  on every read. This plan does not introduce a parallel access surface.
- [plans/analyzers/skills-core.md](analyzers/skills-core.md) -- shipped;
  this plan does not add new skill-substrate concepts.

## Status

Native-format consolidation + directory model done; legacy-format
converters deferred. The data-analyzer-skills Phase 0 dependencies on
`db_file_aggregate` (0.4) and `db_file_list_files` (0.10) are
satisfied for csv / tsv / jsonl / ndjson / json / parquet / arrow /
feather. The 4 non-native formats (xlsx / avro / bson / fixed-width)
keep their bespoke drivers and don't yet route through DuckDB --
Phase 2 / 3 / 4.5 / 7 stay open.

| Phase | Slice | State | Notes |
|---|---|---|---|
| 0.1 | `@duckdb/node-api` daemon dep + Node bindings | done | added during the storage-migration phase; verified on macOS arm64 |
| 0.2 | DuckDB singleton + memory budget | done | two singletons exist: in-memory query pool (`daemon/db/duckdb-pool.ts`, 512 MB cap, used for file-driver `read_*` calls) + file-backed storage pool (`daemon/db/duckdb-storage-pool.ts`, 2 GB cap, used for graph + entity persistence) |
| 0.3 | Path-injection guard | partial | file paths flow through the pool's existing root-scoping (`resolveAndCheckRepoPath` in `daemon/db/pool.ts`); they're then bound as DuckDB `?` parameters, never string-interpolated. The dedicated centralised path-validation helper from the plan's prose is not yet extracted -- pool's check is sufficient for the moment |
| 0.4 | Disabled-by-default extensions | done | query pool sets `autoinstall_known_extensions=false` + `autoload_known_extensions=false`; only `arrow` and `vss` are pre-loaded. `httpfs` / `postgres` / `mysql` / `sqlite` extensions cannot be pulled in at runtime, so ATTACH against those types fails. (The query pool no longer sets `enable_external_access=false`; that flag also blocked legitimate `read_csv_auto` / `read_parquet` -- inappropriate for a pool whose job is reading user-configured files. The storage pool keeps the full lockdown.) |
| 1.1 | New `duckdb-file` driver class | done | `daemon/db/drivers/duckdb-file.ts` -- implements `FileDriver` end-to-end |
| 1.2 | Reader selection per kind | done | `read_csv_auto` / `read_json_auto` (newline_delimited / auto) / `read_parquet` / `read_arrow` per kind |
| 1.3 | `describe()` via DuckDB DESCRIBE | done | `DESCRIBE SELECT * FROM read_xxx(?)` |
| 1.4 | `sample()` + `sampleShape()` via DuckDB SELECT | done | `compileWhere` from rdbms-common reused for structured WHERE filtering; sampleShape pulls a sample via DuckDB then runs `inferShape` from `shape-common.ts` (DuckDB has no native nested-shape inference) |
| 1.5 | Driver registration -- 8 native kinds collapse to one factory | done | `duckdb-file.ts` self-registers for csv / tsv / jsonl / ndjson / json / parquet / arrow / feather; imported LAST in `drivers/index.ts` so its registrations supersede the bespoke per-format drivers' registrations |
| 2.1 | Converter interface (single-file + directory) | pending (deferred) | non-native formats (xlsx / avro / bson / fixed-width) keep their bespoke drivers for now; they don't yet expose `aggregate()`. Lifts when those formats need Family-5 skills coverage |
| 2.2-2.6 | avro / bson / fixed-width / xlsx → Parquet + writer choice | pending (deferred) | requires 2.1 + Phase 3 cache layer; substantial standalone effort |
| 3.1-3.4 | Cache layer (layout / invalidation / LRU / concurrent guard) | pending (deferred) | needed for 2.x. Single-file deps already cover today's data analysis use cases |
| 4.1 | Connection schema gains `path-can-be-directory` semantics | done | `ConnectionConfig.path` may be a file OR a directory; `duckdb-file.ts` factory introspects via `fs.statSync` |
| 4.2 | `recursive` connection option | done | `connection.recursive: boolean` added to `ConnectionConfig`; `duckdb-file.ts` switches to a `**/*.<ext>` glob when set |
| 4.3 | Hive partition option | done | `connection.partitioning: 'hive' \| 'none'` added to `ConnectionConfig`; when `'hive'`, the driver appends `, hive_partitioning=true` to the reader call. Auto-detection on connection-create is not yet wired -- explicit opt-in only |
| 4.4 | Native formats: glob pass-through | done | directory connections pass `<root>/*.<ext>` (or `<root>/**/<ext>` recursive) to DuckDB readers verbatim; no per-file walking in JS |
| 4.5 | Non-native formats: per-file conversion walk | pending (deferred) | needs Phase 2 + 3 |
| 5.1 | `db_file_describe` rewires through new driver | done | no code change needed -- `acquireDriver(...,'file')` goes through the registry; consolidated driver wins because of registration order |
| 5.2 | `db_file_sample` rewires through new driver | done | same |
| 5.3 | `db_file_sample_shape` rewires through new driver | done | same |
| 6.1 | New `db_file_aggregate` tool | done | thin wrapper over the new driver's `aggregate()`. data-analyzer-skills Phase 0.4 dependency satisfied for native formats |
| 6.2 | New `db_file_list_files` tool | done | enumerates files; respects `recursive`, optional basename glob, hidden-file skip; backed by `daemon/db/list-files.ts`. data-analyzer-skills Phase 0.10 dependency satisfied |
| 7.1 | Remove old drivers (csv/jsonl/json/parquet/arrow) | pending (validation gate) | the new driver overrides registrations at runtime, but the bespoke modules stay in `drivers/index.ts` until validation gates pass on a real workload. Removing them is a one-shot delete once we're confident |
| 7.2 | Migrate existing connection configs | n/a | `path` field stays single-file-compatible; new fields default-off, so no migration needed |
| 7.3 | Decide: keep or replace xlsx? | pending (deferred) | bundled with 2.5 |

## Goals

1. **Single SQL surface for file data**. After this plan, every file
   query -- introspection, sampling, aggregation -- runs through
   DuckDB SQL. No format-specific aggregation code paths.
2. **Per-file invalidation, not per-connection rebuild**. Changing
   one file in a 1000-file directory re-converts that one file. The
   other 999 stay cached.
3. **Directory connections work for every file kind**. Native
   formats glob into DuckDB directly; non-native formats walk-and-
   convert. The user-facing surface is identical: `connection.path`
   is a file or a directory; queries don't care.
4. **No new ops burden**. DuckDB is in-process via the existing
   N-API binding; no extra daemon to manage. Conversion libraries
   (`avsc`, `bson`, `exceljs`, parquet writer) are all Node packages
   already in `src/insrc/package.json` or trivial additions.
5. **Backward compatibility for existing connections**. The
   `connection.path` field stays single-file-compatible. New fields
   (`recursive`, `partitioning`) default-off. Existing configs keep
   working without edits.

## Non-goals

- **No DuckDB-as-proxy for non-file drivers**. RDBMS / KV / doc
  connections continue through their native drivers. DuckDB's
  `postgres` / `mysql` / `sqlite` attach extensions are explicitly
  disabled. Cross-source joins are out of scope until a concrete
  user need surfaces.
- **No streaming-pipe model**. Conversion goes through a cached
  Parquet file, not a stream piped into DuckDB. Streams break
  DuckDB's projection pushdown / file-stat assumptions.
- **No HTTP / S3 file sources in v1**. The `httpfs` extension stays
  disabled. File connections target local paths only. Cloud-storage
  file connections are a follow-up plan.
- **No database-style write capability**. The driver is read-only,
  same as today's file drivers. The Parquet cache is a build
  artifact, not a write target.
- **No conversion of avro / bson / fixed-width / xlsx to anything
  other than Parquet**. JSONL / CSV intermediate formats lose
  type fidelity; one cache target keeps the driver code simple.

## Phase 0 -- DuckDB integration

### 0.1 Daemon dependency

Add `@duckdb/node-api` to `src/insrc/package.json`. The N-API binding
is prebuilt for macOS arm64 / Linux x86_64 / Windows x86_64 -- the
three OS / arch combos the daemon supports today. Native build
fallback only kicks in on unsupported targets.

The data-analyzer-skills Phase 0 budget for the wider integration
work (memory sizing, connection lifecycle) lives in this plan.

### 0.2 Singleton instance + lifecycle + memory budget

#### Lifecycle decision: lazy-init singleton, daemon-lifetime

Four lifecycle models were considered:

| Model | Init | Lifetime | Memory when idle | Cold-call latency |
|---|---|---|---|---|
| **A. Lazy singleton, daemon-lifetime** | first file query | until daemon shutdown | ~50-100 MB resident; `memory_limit` is a cap not a reservation | ~0 ms once warm |
| **B. Lazy singleton + idle-timeout close** | first file query | closes after N min idle | reclaims everything | 50-100 ms after each timeout (re-init + extension load) |
| **C. Per-connection instance** | first query on the connection | until the connection closes | scales with active file connection count | 50-100 ms per connection cold start |
| **D. Per-call instance** | every query | one query | zero | 50-100 ms every query (kills DuckDB plan cache) |

**v1 picks A** for three reasons:

1. **Idle memory is small enough that auto-close pays for itself
   poorly.** The `memory_limit='512MB'` is the per-query CAP, not a
   reservation. DuckDB allocates pages for active result sets, sorts,
   hash joins -- not idle metadata. Resident size on an idle daemon
   is ~50-100 MB (prepared-statement cache + extension binaries).
   Compared to the daemon's existing memory ledger -- Kuzu's 1 GB
   pool, Ollama's ~3 GB resident, Node's 4-8 GB heap during indexing
   -- 50-100 MB of DuckDB idle state is in the noise.
2. **Plan cache + DESCRIBE-result cache stay warm.** Analyzer
   skills hit the same file across many queries in one session
   (sample → describe → aggregate → describe again). Re-initialising
   between them throws away the cache that makes the second through
   Nth query fast.
3. **Simpler code path.** No idle-timer, no re-init-on-cold race,
   no double-close handling around skill cancellations. The
   complexity of B / C buys little when the savings are 50-100 MB.

B remains a viable v2 if memory profiling under load shows the
singleton is meaningful in the daemon's resident size. Until then
it's premature.

#### Concurrent-init guard

Two skills firing on a cold daemon could call `getDuckDB()` in
parallel; both would see `_db === null` and start their own
`new Database(...)`. The guard collapses concurrent first-callers
onto the same init promise:

```ts
// daemon/db/duckdb-pool.ts (new)

import { Database, type Connection } from '@duckdb/node-api';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('duckdb-pool');

let _db: Database | null = null;
let _initPromise: Promise<Database> | null = null;

export async function getDuckDB(): Promise<Database> {
  if (_db !== null) return _db;
  if (_initPromise !== null) return _initPromise;

  _initPromise = (async () => {
    const t0 = Date.now();
    const db = new Database(':memory:');
    const conn = db.connect();
    try {
      // Cap on per-query buffer-pool memory. Sized alongside Kuzu's
      // 1 GB pool + Ollama's ~3 GB resident; conservative for 16 GB
      // dev laptops. Bumpable via `~/.insrc/config.json`
      // duckdb.memoryMb.
      await conn.run("PRAGMA memory_limit='512MB'");
      // Lock down extensions: ATTACH / httpfs / load_extension all
      // blocked at runtime. The `arrow` extension is the only one
      // explicitly loaded (for native .arrow IPC reads).
      await conn.run("SET enable_external_access=false");
      try {
        await conn.run("INSTALL arrow; LOAD arrow");
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'arrow extension unavailable -- .arrow files will fall back to error');
      }
    } finally {
      conn.close();
    }
    log.info({ initMs: Date.now() - t0 }, 'duckdb singleton initialised');
    _db = db;
    return db;
  })();

  try {
    return await _initPromise;
  } catch (e) {
    // Init failed; clear the promise so the next caller can retry
    // instead of awaiting a permanently-rejected promise.
    _initPromise = null;
    throw e;
  }
}

export async function closeDuckDB(): Promise<void> {
  const inst = _db;
  _db = null;
  _initPromise = null;
  if (inst !== null) {
    try { await inst.close(); }
    catch (e) { log.warn({ err: (e as Error).message }, 'duckdb close failed'); }
  }
}
```

#### Per-query Connection handle

DuckDB Database state is process-wide; Connections are cheap
(`db.connect()` is sub-millisecond) and provide query-isolation +
per-query cancel. Every tool / driver method acquires a fresh
Connection per call, runs its query, and closes the Connection
before returning:

```ts
export async function withConnection<T>(
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  const db = await getDuckDB();
  const conn = db.connect();
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}
```

This is the canonical entry point for DuckDB usage in the daemon.
The DuckDB-backed file driver, the converters, and the
`db_file_aggregate` tool all go through `withConnection`; they
never call `getDuckDB()` directly except in cold-init paths where
a long-lived Connection is genuinely warranted (none in v1).

#### Daemon shutdown integration

The daemon's existing graceful-shutdown handler (per
`daemon/index.ts` -- the same handler that closes Kuzu and LanceDB)
calls `closeDuckDB()` alongside the other DB closes. Order: Kuzu
first (it has the WAL-flush dependency), then LanceDB, then DuckDB.
DuckDB has no on-disk state to flush (everything is in-memory or
in the file-converted cache, which is a build artifact); close is
fast. The hard-exit backstop covers the case where close hangs.

#### Memory budget recap

| Knob | Value | Effect |
|---|---|---|
| `memory_limit` PRAGMA | 512 MB | per-query cap; only allocated under load |
| Idle resident (no queries) | ~50-100 MB | prepared-statement cache + extension binaries |
| Sustained under load | up to 512 MB | hash joins / sorts / large aggregations |
| Configurable via | `~/.insrc/config.json` `duckdb.memoryMb` (default 512) | user override; same pattern as Kuzu's pool size |

The 512 MB default sits within the daemon's overall budget on a
16 GB machine alongside Kuzu (1 GB), Ollama (~3 GB), and Node
(4-8 GB during indexing). Users with bigger files who hit
"out of memory" errors from DuckDB bump the knob; users on tight
machines reduce it.

### 0.3 Path-injection guard

DuckDB will read whatever path you put in a `read_*` function. The
file connection's existing root-scoping (per
[plans/data-driver.md](data-driver.md) §4.5 -- the per-repo opt-in
+ root-relative path resolution) MUST run **before** the path goes
into DuckDB SQL.

Every path is parameterised, never string-interpolated:

```ts
// CORRECT: parameterised
await conn.query("SELECT * FROM read_parquet(?)", [resolvedPath]);

// WRONG: never do this
await conn.query(`SELECT * FROM read_parquet('${userPath}')`);
```

The driver's `resolvePath(connection, target)` helper applies the
existing scope check (path stays under the connection's configured
root + escapes via `..` are rejected) and returns the absolute path
the SQL parameter receives.

### 0.4 Disabled-by-default extensions

DuckDB's extension model is opt-in. The daemon installs and loads
exactly one extension at startup: `arrow` (for `.arrow` IPC files).
The following are explicitly **not** installed:

- `httpfs` (no remote / S3 / Azure file reads)
- `postgres`, `mysql`, `sqlite` (no DB attachments -- DuckDB stays
  a file-only engine in our deployment)
- `spatial` (xlsx via spatial is the cleaner Parquet-converter route)
- Any user-loadable extensions

Extension state is reasserted on every daemon start; `INSTALL` is
idempotent so this is cheap.

## Phase 1 -- DuckDB-backed driver for native formats

### 1.1 The driver class

```ts
// daemon/db/drivers/duckdb-file.ts (new)

class DuckDBFileDriver implements FileDriver {
  readonly id: string;
  readonly kind: 'csv' | 'jsonl' | 'json' | 'parquet' | 'arrow';
  readonly family = 'file' as const;

  constructor(public readonly config: ConnectionConfig) { /* ... */ }

  async describe(target?: string): Promise<SchemaDescription> { /* ... */ }
  async sample(target: string | undefined, opts: SampleOpts): Promise<SampleResult> { /* ... */ }
  async sampleShape(opts: ScanOpts): Promise<ShapeReport> { /* ... */ }

  /** Phase 6.1 -- new method available only on the new driver. */
  async aggregate(target: string, opts: AggregateOpts): Promise<AggregateResult> { /* ... */ }

  async close(): Promise<void> { /* connection-level state, if any */ }
}
```

The `FileDriver` interface in
[`shared/db-driver.ts`](../src/insrc/shared/db-driver.ts) already
captures the `describe / sample / sampleShape / get` surface; the new
class implements that. The `aggregate` method is a new addition that
the existing bespoke drivers can stub out (returning
`{ unsupported: true }`) until they go away.

### 1.2 Reader selection

```ts
function readerExpression(kind: FileKind, path: string): string {
  // Returns a SQL fragment usable inside a SELECT FROM clause.
  // Path comes in as a parameter placeholder; the function returns
  // the function name + any kind-specific options.
  switch (kind) {
    case 'csv':     return "read_csv_auto(?, sample_size=10000)";
    case 'jsonl':   return "read_json_auto(?, format='newline_delimited')";
    case 'json':    return "read_json_auto(?, format='auto')";
    case 'parquet': return "read_parquet(?)";
    case 'arrow':   return "read_arrow_table(?)";
  }
}
```

For directory connections, the parameter is a glob (`/dir/**/*.csv`);
DuckDB's `read_csv_auto` accepts a glob in the same parameter slot.

### 1.3 `describe()` via `DESCRIBE`

```ts
async describe(target?: string): Promise<SchemaDescription> {
  const path = await this.resolveTarget(target);
  const expr = readerExpression(this.kind, path);
  const rows = await conn.query(`DESCRIBE SELECT * FROM ${expr}`, [path]);
  return {
    target: target ?? this.config.path,
    columns: rows.map(r => ({ name: r.column_name, type: r.column_type, nullable: r.null === 'YES' })),
    source: this.kind === 'parquet' || this.kind === 'arrow' ? 'header' : 'inferred',
  };
}
```

DuckDB's `DESCRIBE` is the fastest path to schema -- for Parquet /
Arrow it reads the header without scanning rows; for CSV / JSONL it
samples per its `sample_size` setting (10 000 rows by default;
configurable).

### 1.4 `sample()` + `sampleShape()`

```ts
async sample(target, opts): Promise<SampleResult> {
  const path = await this.resolveTarget(target);
  const expr = readerExpression(this.kind, path);
  const limit = clampFileLimit(opts.limit);
  const rows = await conn.query(`SELECT * FROM ${expr} LIMIT ?`, [path, limit]);
  return { rows, metadata: { ... } };
}
```

`sampleShape` for json / jsonl: sample N rows via DuckDB, then run
the existing shape-merge logic in [`shape-common.ts`](../src/insrc/daemon/db/drivers/shape-common.ts)
to produce the typed nested-field inventory. DuckDB doesn't have
native nested-shape inference; the JS code stays valuable here.

### 1.5 Driver registration

The existing `registerDriver({ kind: 'csv', factory: makeCsvFactory() })`
calls in the various per-format drivers all swap to point at one
factory:

```ts
// daemon/db/drivers/index.ts (or a new register module)
import { makeDuckDBFileFactory } from './duckdb-file.js';

const factory = makeDuckDBFileFactory();
registerDriver({ kind: 'csv',     family: 'file', factory });
registerDriver({ kind: 'jsonl',   family: 'file', factory });
registerDriver({ kind: 'json',    family: 'file', factory });
registerDriver({ kind: 'parquet', family: 'file', factory });
registerDriver({ kind: 'arrow',   family: 'file', factory });
```

The `ConnectionConfig.kind` still discriminates, so the factory
returns a `DuckDBFileDriver` instance that knows which reader to use.

## Phase 2 -- Format converters → Parquet

### 2.1 Converter interface

```ts
// daemon/db/drivers/converters/types.ts

export interface FileConverter {
  /** Convert one source file. Returns the destination Parquet path. */
  convertFile(source: string, dest: string): Promise<{ rowCount: number; durationMs: number }>;

  /** Convert a directory tree. Returns a glob pointing at the
   *  Parquet output (under the cache root). */
  convertDirectory(
    sourceDir: string,
    destDir: string,
    opts: { recursive: boolean; pattern?: string },
  ): Promise<{ parquetGlob: string; sourceCount: number; durationMs: number }>;
}
```

Each converter is one file in `daemon/db/drivers/converters/`. The
single-file path is used when a connection points at one file; the
directory path mirrors the source tree under the cache and returns a
DuckDB-friendly glob.

### 2.2 avro → Parquet

```ts
// daemon/db/drivers/converters/avro.ts

import avsc from 'avsc';
import { ParquetWriter } from '<chosen-writer>';

export class AvroConverter implements FileConverter {
  async convertFile(source, dest) {
    const decoder = avsc.createFileDecoder(source);
    const schema = await firstSchemaFromDecoder(decoder);
    const parquetSchema = mapAvroSchemaToParquet(schema);
    const writer = await ParquetWriter.openFile(parquetSchema, dest);
    let rowCount = 0;
    for await (const record of decoder) {
      await writer.appendRow(record);
      rowCount++;
    }
    await writer.close();
    return { rowCount, durationMs: ... };
  }

  async convertDirectory(sourceDir, destDir, opts) { /* walk + per-file convert */ }
}
```

The Avro-to-Parquet schema mapping is the substantive work:

| Avro type | Parquet type |
|---|---|
| null | (handled via Parquet repetition: optional) |
| boolean | BOOLEAN |
| int | INT32 |
| long | INT64 |
| float | FLOAT |
| double | DOUBLE |
| bytes | BYTE_ARRAY |
| string | UTF8 |
| record | GROUP (nested) |
| enum | string (enum values become strings) |
| array | repeated GROUP |
| map | repeated GROUP with key/value |
| union | flattened to one branch with `_type` discriminator OR Parquet logical-type union (writer-dependent) |
| fixed | FIXED_LEN_BYTE_ARRAY |

Decimal logical types map directly. Union handling is the only fiddly
case -- the simplest interpretation flattens nullable unions
(`["null", T]`) into Parquet's optional column, and treats wider
unions as a STRUCT with one column per branch.

### 2.3 bson → Parquet

```ts
// daemon/db/drivers/converters/bson.ts

import { deserialize } from 'bson';

export class BsonConverter implements FileConverter {
  async convertFile(source, dest) {
    // First pass: schema inference. Sample first N docs, merge
    // observed fields. Reuses existing bson driver's inference code.
    const schema = await inferSchemaFromBson(source, /* sampleN */ 1000);

    // Second pass: stream-decode + write Parquet rows.
    const writer = await ParquetWriter.openFile(schema, dest);
    for await (const doc of streamBsonDocs(source)) {
      await writer.appendRow(normalizeBsonTypes(doc));
    }
    await writer.close();
  }
}
```

BSON type mapping:

| BSON type | Parquet type | Notes |
|---|---|---|
| Double | DOUBLE | |
| String | UTF8 | |
| Int32 | INT32 | |
| Int64 / Long | INT64 | |
| Decimal128 | DECIMAL(38, 10) | |
| Boolean | BOOLEAN | |
| Date | TIMESTAMP_MILLIS | |
| ObjectId | UTF8 (24 hex chars) | could also be FIXED_LEN_BYTE_ARRAY(12); UTF8 is friendlier for queries |
| Binary | BYTE_ARRAY | |
| Embedded document | GROUP (nested) | |
| Array | repeated GROUP | |
| RegExp / Code / DBPointer | UTF8 (string-ified) | rare types; lossy |

Heterogeneous documents (some with field X, some without) merge into
a union schema with all fields nullable -- standard Parquet pattern.

### 2.4 fixed-width → Parquet

```ts
// daemon/db/drivers/converters/fixed-width.ts

export class FixedWidthConverter implements FileConverter {
  async convertFile(source, dest) {
    const spec = this.config.options.columns; // already in connection config
    const parquetSchema = mapFixedWidthSpecToParquet(spec);
    const writer = await ParquetWriter.openFile(parquetSchema, dest);
    const rl = createInterface({ input: createReadStream(source) });
    for await (const line of rl) {
      const row = sliceLineByWidths(line, spec);
      await writer.appendRow(row);
    }
    await writer.close();
  }
}
```

Trivial: existing `spec.columns: { name, start, length, type }[]` from
the connection config already carries the widths and per-column types.
One pass, streaming, lossless.

### 2.5 xlsx → Parquet (per sheet)

```ts
// daemon/db/drivers/converters/xlsx.ts

import ExcelJS from 'exceljs';

export class XlsxConverter implements FileConverter {
  async convertFile(source, dest) {
    // dest is a directory: one Parquet per sheet
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(source);
    for (const worksheet of workbook.worksheets) {
      const sheetDest = path.join(dest, `${slugify(worksheet.name)}.parquet`);
      await convertSheet(worksheet, sheetDest);
    }
  }
}
```

One Parquet per sheet keeps the existing per-sheet target model
(today's xlsx driver treats each sheet as a separate `target` per
[plans/data-driver.md](data-driver.md) §1.4 row 4). Subsequent
queries reference targets by sheet name → DuckDB reads the
corresponding Parquet.

### 2.6 Parquet writer choice

Three Node Parquet writers in scope:

| Library | In tree? | Capability |
|---|---|---|
| `parquetjs-lite` | yes | basic primitives; no DECIMAL, no nested STRUCT depth > 1 |
| `@dsnp/parquetjs` | no -- new dep | broader types: DECIMAL, nested groups, multiple compression codecs |
| `apache-arrow` (Arrow IPC, not Parquet) | yes | could write Arrow IPC instead of Parquet; DuckDB reads via the arrow extension; larger files |

Default proposal: **add `@dsnp/parquetjs` as a daemon dep**. It
covers Decimal128 / nested groups / GZIP+SNAPPY -- all needed for
clean BSON / Avro conversion. The size is modest (~250 KB
unpacked); maintenance is decent; the project is alive.

`parquetjs-lite` stays usable as a fallback for the simple
fixed-width / csv-with-flat-types cases where its limits don't
bite. We pick per converter rather than one library across the
board.

## Phase 3 -- Cache layer

### 3.1 Cache directory layout

```
~/.insrc/cache/file-converted/
  <connection-id>/
    .meta.json                     # connection-level metadata
    files/
      data.bson.parquet            # single-file connection
      events/2024-01.bson.parquet  # directory connection -- mirrored tree
      events/2024-02.bson.parquet
      events/sub/2023.bson.parquet # only present if recursive=true
```

The mirrored tree means DuckDB queries can use a glob that exactly
mirrors the source layout (`/cache/.../events/**/*.parquet` for
recursive directory connections). Hive partition columns, when
present in source paths (`year=2024/month=03/`), are preserved in
the cache layout so `hive_partitioning=true` continues to work.

### 3.2 Per-source-file invalidation

Cache validity per source file is checked on every query:

```ts
async function isCached(source: string, dest: string): Promise<boolean> {
  if (!fsSync.existsSync(dest)) return false;
  const sourceStat = await fs.stat(source);
  const meta = await readSidecar(`${dest}.meta`);
  return meta.sourceMtime === sourceStat.mtimeMs
      && meta.sourceSize  === sourceStat.size;
}
```

Sidecar files (`<dest>.meta`) carry the source `(mtime, size)`. A
source file's mtime change → cache miss → re-convert. Other files
in the same connection stay cached.

For directory connections: walk the source tree (recursive when
configured), check each file's cache, convert only the misses, then
return the glob over the cache root.

### 3.3 LRU eviction + size cap

The cache is bounded to **5 GB by default** per cache root (across
all connections); configurable in `~/.insrc/config.json`. On every
write, after closing the new Parquet, the cache manager checks
total size and evicts the oldest-mtime entries until the cap is met.

Eviction is at the (cached file, sidecar) granularity, not the
connection -- an old archive file's cache can roll off without
invalidating the rest of the connection.

### 3.4 Concurrent-access guard

Two queries against the same connection might race on the same
source-file conversion. The cache layer holds a per-source-file
mutex (in-memory `Map<sourcePath, Promise>`) so the second query
awaits the first's conversion instead of starting its own:

```ts
async function ensureCached(source, dest): Promise<void> {
  if (await isCached(source, dest)) return;
  const inflight = INFLIGHT.get(source);
  if (inflight !== undefined) { await inflight; return; }
  const p = doConvert(source, dest).finally(() => INFLIGHT.delete(source));
  INFLIGHT.set(source, p);
  await p;
}
```

Cross-process races (two daemons, or daemon + standalone tools) are
out of scope -- the daemon owns the cache and is the only writer.

## Phase 4 -- Directory-as-table connection model

### 4.1 `path` can be file or directory

The existing `ConnectionConfig` (per
[shared/db-driver.ts](../src/insrc/shared/db-driver.ts)) carries
`path: string`. Today's drivers all `fs.stat` and treat as a single
file. The new driver:

```ts
async resolveTarget(target: string | undefined): Promise<{ path: string; isDirectory: boolean }> {
  const root = this.config.path;
  const stat = await fs.stat(root);
  return { path: root, isDirectory: stat.isDirectory() };
}
```

When `isDirectory`, downstream logic switches to the directory path
in 4.2 / 4.4 / 4.5. When not, the existing single-file path runs.

### 4.2 `recursive` connection option

```ts
// shared/db-driver.ts (extension)
interface ConnectionConfig {
  // ...existing fields
  recursive?: boolean;      // default false; only meaningful when path is a directory
}
```

Recursive=false: only files directly under `path` are part of the
connection. Recursive=true: the whole subtree.

The flag is also accepted as a per-call override on
`db_file_aggregate` / `db_file_sample` etc. -- a user can preview a
single subdirectory without reconfiguring the connection.

### 4.3 Hive partition auto-detection

```ts
interface ConnectionConfig {
  // ...
  partitioning?: 'hive' | 'none';  // default 'none'
}
```

When `'hive'`:
- Native formats: pass `hive_partitioning=true` to DuckDB read fns
- Non-native formats: the converter mirrors the source tree under
  the cache (which preserves hive directory names); DuckDB reads
  the cache with `hive_partitioning=true`

Auto-detection on connection creation: if any directory under `path`
matches `<key>=<value>/`, default `partitioning` to `'hive'`. User
can override.

### 4.4 Native formats: glob pass-through

```ts
// In DuckDBFileDriver:
private async readerArg(target?: string): Promise<string> {
  const { path: root, isDirectory } = await this.resolveTarget(target);
  if (!isDirectory) return root;             // single file
  const pattern = this.config.recursive ? '**' : '*';
  return path.join(root, pattern, `*.${this.kind === 'jsonl' ? 'jsonl' : this.kind}`);
}
```

The result is a glob string DuckDB's `read_*` functions accept
directly. No file walking in the driver; DuckDB handles enumeration.

### 4.5 Non-native formats: per-file conversion walk

For avro / bson / fixed-width / xlsx connections pointing at a
directory:

```ts
async function syncCacheTree(connection): Promise<string> {  // returns DuckDB-readable glob
  const sources = await walkSources(connection.path, connection.recursive);
  for (const sourcePath of sources) {
    const cachePath = mirrorIntoCache(sourcePath, connection);
    await ensureCached(sourcePath, cachePath);
  }
  const root = cacheRootFor(connection);
  return path.join(root, connection.recursive ? '**' : '*', '*.parquet');
}
```

Source-tree walking respects the `recursive` flag. The walker
ignores hidden files (`.foo`) and respects `connection.options.glob`
if set (e.g. `**/*.bson` to skip non-BSON files in a mixed
directory).

## Phase 5 -- Tool migration

### 5.1 / 5.2 / 5.3

The existing tools `db_file_describe`, `db_file_sample`, and
`db_file_sample_shape` keep their current input / output schemas.
Internally they dispatch to the same `DuckDBFileDriver` returned
by the registry; no caller-visible behaviour change.

For the four non-native kinds (avro / bson / fixed-width / xlsx),
the tool dispatch flows through:

1. Resolve connection → factory → `DuckDBFileDriver` (kind discriminates)
2. Driver's `describe / sample / sampleShape` calls `syncCacheTree(connection)`
3. DuckDB queries the resulting Parquet glob

For native kinds, `syncCacheTree` short-circuits to "no conversion;
glob the source path."

## Phase 6 -- New tools enabled

### 6.1 `db_file_aggregate`

The data-analyzer-skills.md Phase 0.4 dependency. With the new
driver in place, this is a thin wrapper:

```ts
const aggregateTool: Tool = {
  id: 'db_file_aggregate',
  description: 'Run native SQL aggregations over a file connection.',
  inputSchema: { /* connectionId, target?, aggregations: [...], where? */ },
  async execute(input) {
    const driver = await getDriver(input.connectionId);
    const sql = buildAggregateSQL(input);
    const rows = await driver.queryRaw(sql);   // new method on the duckdb-file driver
    return { output: rendered, format: 'json', success: true, data: rows };
  },
};
```

The `queryRaw` escape on `DuckDBFileDriver` is internal-only -- the
tool builds the SQL, never the user. (Path-injection guard from 0.3
applies on the file path; the aggregations array is parameter-built,
never string-concatenated.)

### 6.2 `db_file_list_files`

Walks a directory connection's source tree (or returns a single-element
list for a file connection):

```ts
const listTool: Tool = {
  id: 'db_file_list_files',
  inputSchema: { /* connectionId, glob?, limit? */ },
  async execute(input) {
    const driver = await getDriver(input.connectionId);
    const files = await driver.listFiles({ glob: input.glob, limit: input.limit ?? 200 });
    return { output: files, format: 'json', success: true, data: files };
  },
};
```

Returns `Array<{ path, size, mtime, kind }>` -- the kind field is
the data-driver's classification for that file (so a heterogeneous
directory containing both `.parquet` and `.csv` shows both kinds and
the caller can filter).

## Phase 7 -- Cleanup

### 7.1 Files to be deleted

After the new driver passes side-by-side validation against the
existing driver tests (per Phase 1.5 of
[plans/data-driver.md](data-driver.md)) and one daemon release ships,
**every standalone file driver** in
[`src/insrc/daemon/db/drivers/`](../src/insrc/daemon/db/drivers/) is
removed.

#### 7.1.1 Driver implementation files (delete)

Nine files. The `kinds` column lists every `registerDriver({ kind: ... })`
call that moves to the new driver's factory in 1.5.

| File | Kinds registered | Replacement |
|---|---|---|
| `daemon/db/drivers/csv.ts` | `csv`, `tsv` | `duckdb-file.ts` (native via `read_csv_auto`) |
| `daemon/db/drivers/jsonl.ts` | `jsonl`, `ndjson` | `duckdb-file.ts` (native via `read_json_auto(format='newline_delimited')`) |
| `daemon/db/drivers/json.ts` | `json` | `duckdb-file.ts` (native via `read_json_auto`) |
| `daemon/db/drivers/parquet.ts` | `parquet` | `duckdb-file.ts` (native via `read_parquet`) |
| `daemon/db/drivers/arrow.ts` | `arrow`, `feather` | `duckdb-file.ts` (native via `read_arrow_table` -- requires `arrow` extension loaded at startup, see 0.4) |
| `daemon/db/drivers/avro.ts` | `avro` | `duckdb-file.ts` + `converters/avro.ts` (avsc-driven Parquet conversion) |
| `daemon/db/drivers/bson.ts` | `bson` | `duckdb-file.ts` + `converters/bson.ts` (bson-driven Parquet conversion) |
| `daemon/db/drivers/fixed-width.ts` | `fixed-width` | `duckdb-file.ts` + `converters/fixed-width.ts` (line-reader Parquet conversion) |
| `daemon/db/drivers/xlsx.ts` | `xlsx` | `duckdb-file.ts` + `converters/xlsx.ts` (exceljs-driven Parquet conversion, one Parquet per sheet) |

**Twelve distinct driver kinds** total (`csv`, `tsv`, `jsonl`,
`ndjson`, `json`, `parquet`, `arrow`, `feather`, `avro`, `bson`,
`fixed-width`, `xlsx`) all migrate to point at the same factory
class (`duckdb-file.ts`). The four converter modules in
`converters/` reuse the existing libraries (`avsc`, `bson`,
`exceljs`, native line-reader) the deleted drivers used.

#### 7.1.2 Driver index updates (edit, do not delete)

The driver barrel
[`daemon/db/drivers/index.ts`](../src/insrc/daemon/db/drivers/index.ts)
imports each driver module for its registration side effect. The
nine `import './<kind>.js';` lines for the file drivers above are
removed; one `import './duckdb-file.js';` line replaces them.
Phase 1.5 of this plan already covers the registration calls; the
barrel just needs to import the new module.

Diff sketch:

```diff
 // File
-import './csv.js';           // csv + tsv
-import './jsonl.js';         // jsonl + ndjson
-import './json.js';
-import './xlsx.js';
-import './avro.js';
-import './arrow.js';         // arrow + feather
-import './bson.js';
-import './fixed-width.js';
-import './parquet.js';
+import './duckdb-file.js';   // csv + tsv + jsonl + ndjson + json + parquet + arrow + feather +
+                             // avro + bson + fixed-width + xlsx (12 kinds via one factory)
```

#### 7.1.3 Driver tests (delete)

If per-driver test files exist under
`src/insrc/daemon/db/drivers/__tests__/<kind>.test.ts` (the
data-driver plan §1.5 prescribes this layout but the directory
isn't materialized yet -- verify before deleting), the
file-flavoured ones get removed alongside their drivers:

| Test file (if present) | Reason |
|---|---|
| `__tests__/csv.test.ts` | csv driver gone |
| `__tests__/jsonl.test.ts` | jsonl driver gone |
| `__tests__/json.test.ts` | json driver gone |
| `__tests__/parquet.test.ts` | parquet driver gone |
| `__tests__/arrow.test.ts` | arrow driver gone |
| `__tests__/avro.test.ts` | replaced by `__tests__/converters/avro.test.ts` |
| `__tests__/bson.test.ts` | replaced by `__tests__/converters/bson.test.ts` |
| `__tests__/fixed-width.test.ts` | replaced by `__tests__/converters/fixed-width.test.ts` |
| `__tests__/xlsx.test.ts` | replaced by `__tests__/converters/xlsx.test.ts` |

Test fixtures under `test/fixtures/db-driver/files/` stay -- the
new driver + converters consume the same fixtures.

#### 7.1.4 Helpers (status-by-helper)

| Helper file | Status |
|---|---|
| `daemon/db/drivers/file-common.ts` | **trim, not delete**. Today every file driver imports `clampFileLimit` and `rowMatchesWhere` from here. The new DuckDB-backed driver still calls `clampFileLimit` (the row-cap is an analyzer-side guarantee independent of DuckDB); `rowMatchesWhere` becomes unused (DuckDB SQL handles the where clause natively) and gets removed. Net: file shrinks by ~30 LOC, stays as a small home for path resolution + cap enforcement. |
| `daemon/db/drivers/shape-common.ts` | **keep unchanged**. Used by the seven KV / file drivers (json + redis + etcd + nats + dynamodb + cassandra + mongodb) for nested-shape inference. The new driver's `sampleShape()` for json / jsonl still calls `inferShape` after pulling N sample rows. No change. |
| `daemon/db/drivers/kv-common.ts` | **keep unchanged**. KV-only helper; not touched by this plan. |
| `daemon/db/drivers/rdbms-common.ts` | **keep unchanged**. RDBMS-only helper; not touched. |

Net file count change in `daemon/db/drivers/`:

```
Today:                                    After consolidation:
  9 file driver implementations             1 driver implementation (duckdb-file.ts)
                                            + 4 converter modules under converters/
                                            = 5 files
  1 shared helper (file-common.ts)          1 shared helper (file-common.ts, trimmed)
  Total file-family files: 10               Total: 6
                                            (4-file reduction; identical 12-kind coverage)
```

#### 7.1.5 Migration order (so the daemon never boots without file drivers)

Cleanup runs in **two waves** across two daemon releases:

**Wave A (this plan ships, drivers stay)**:
1. Phase 0 (DuckDB integration), Phase 1 (new driver), Phase 2
   (converters), Phase 3 (cache), Phase 4 (directory model) all
   land alongside the existing drivers.
2. The new driver registers a **second** factory under each kind
   name (or the registry grows a `priority` field; default the new
   driver to lower priority so existing connections keep using the
   bespoke driver). Behaviour unchanged for users.
3. Side-by-side validation: the smoke / fixture tests run against
   both drivers; differences are recorded.

**Wave B (next daemon release, drivers come out)**:
1. The bespoke drivers' factories are removed from
   `drivers/index.ts`; the new driver becomes the sole factory for
   each kind.
2. The nine driver files + the file-flavoured per-driver tests are
   deleted in one PR.
3. `file-common.ts` is trimmed to drop the now-unused
   `rowMatchesWhere` helper.

The two-wave model means there's no point during the migration where
file connections silently break -- the registry always has a factory
for every kind.

### 7.2 Migrate connection configs

The `ConnectionConfig.path` field stays the same. New fields
(`recursive`, `partitioning`) are optional and default-off. Existing
configs continue to work unchanged. New connections created via the
Data Sources pane (per [plans/data-driver.md](data-driver.md) §2.2)
gain a "Path is a directory" toggle that flips on `recursive` /
shows the `partitioning` selector.

### 7.3 xlsx -- keep or replace?

DuckDB's `spatial` extension reads xlsx via `st_read`. It's awkward
(geometry-shaped abstractions over a tabular file); existing `exceljs`
+ converter is cleaner. Default: **keep xlsx as a converter**, do
NOT enable `spatial`.

## Open questions

1. **Single Parquet per source-directory, or per-source-file
   mirrored tree?** Mirrored tree (current proposal) lets per-file
   invalidation work cheaply; one Parquet per directory is faster
   to write but invalidates everything when one source file
   changes. **Default: mirrored tree.** Revisit if the cache write
   amplification becomes a problem.

2. **Should fixed-width connections support directories?** Today's
   fixed-width driver assumes one file with one column spec. A
   directory of fixed-width files presumably shares the spec; the
   converter could apply the same spec to every file. **Default:
   yes, support directory connections for fixed-width with the same
   spec across all files.** Document explicitly that mixing specs
   within one directory is not supported; user splits into multiple
   connections.

3. **DuckDB version pinning.** New DuckDB releases occasionally
   break the wire format of cached Parquets (rare but real). Pin
   `@duckdb/node-api` to a specific minor (e.g. `~1.x`); upgrade
   notes call out cache-clearing if a major bump lands. **Default:
   pin minor; document upgrade ritual.**

4. **What about `httpfs` for cloud-backed file connections?** The
   plan disables it in v1 but the architecture trivially supports
   it: `s3://...` paths flow through `read_parquet` once `httpfs`
   is loaded. **Default: not in v1; ship as a follow-up plan tied
   to credential management.**

5. **Should the singleton auto-close on idle to reclaim the
   ~50-100 MB resident size?** Phase 0.2 picks the always-on
   lazy-init singleton (Model A) over the idle-timeout-close
   variant (Model B) on the read that 50-100 MB is in the noise
   compared to the daemon's existing memory ledger
   (Kuzu 1 GB + Ollama ~3 GB + Node 4-8 GB). **Default: stay
   always-on for v1.** Revisit if memory profiling under sustained
   load shows the singleton's idle footprint is meaningful, or if
   a "low-memory mode" daemon setting is added (in which case B
   would be the natural opt-in).

## Lessons baked in from prior work

1. **Parameterise paths into DuckDB**. The Kuzu integration's
   `bufferManagerSize` story showed how easy it is to pass thick
   parameter shapes through native bindings. Use parameter
   placeholders for paths (`?` in SQL); never string-interpolate
   user-controlled paths into a `read_*` call.
2. **Memory budget alongside Kuzu**. The daemon's resident memory
   today is dominated by the Kuzu pool (1 GB) + Ollama runner
   (~3 GB) + Node heap during indexing (4-8 GB). DuckDB's 512 MB
   default sits within the remaining budget on a 16 GB machine.
   Bumping it requires explicit user action via daemon settings,
   same model as Kuzu.
3. **Cache invalidation by source `(mtime, size)`, not by content
   hash**. Hashing every source file on every query is too
   expensive for large inputs. The skills-core 7.2 audit ring
   buffer's design used a similar pattern (cheap stable digest,
   not security-relevant); we apply it here for cache keys.
4. **Default-enabled extensions list, not opt-in.** The cross-agent
   tool oversight from 2026-04-30 (registered tools, missing from
   `enabledCategories`, silently unreachable) drove the
   skills-core 2.4 fix. We avoid the same trap here by INSTALLing
   only one extension (`arrow`) at startup -- the rest of the
   surface is dark by design.
