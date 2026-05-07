# Plan: Data Analyzer Skills

Decomposes the data-analyzer's monolithic per-task analyzer runner into a
graph of fine-grained, registered skills. Builds on the substrate in
[plans/analyzers/skills-core.md](./skills-core.md). Bakes in the lessons from
the 2026-04-30 hallucinated-class incident (tracked in commit history; the
post-mortem fixes shipped 2026-05-01 added a tool-error gate, runner-side
confidence downgrade, reviewer hallucination guardrails, and the missing
`code`/`data` registry-category enables).

## Why decompose?

Today the data-analyzer's per-task work is one bounded LLM tool loop with one
prompt that switches behaviour by `task.kind` (`inspect-schema`, `sample-data`,
`sample-shape`, `lineage`, `schema-drift`, `er`, `free-form`). The single-
runner approach has two structural failure modes:

1. **Behaviour leaks across kinds.** A task labelled `inspect-schema` against
   a class-shaped question (`"Describe the INPurchaseOrder class"`) ends up
   inside the same tool loop as a real schema-drift task; the model picks
   from the same wide tool list with the same per-kind playbook nudges, and
   when its tool calls fail it has no per-task contract to fall back on.
2. **Quality / statistical analysis is impossible to land.** Every
   distributional, profiling, or PII-detection capability would have to be
   bolted onto the same runner, growing its prompt + tool list past the
   point where the local model's tool-call accuracy degrades.

Skills give every capability a typed contract (input / output / preconditions
/ confidence calibration) and let the orchestrator compose them. The model
sees a small closed set of skill ids per question; the runner enforces
preconditions before any LLM call; the registry calibrates confidence after
the fact.

## Related plans

- [plans/analyzers/skills-core.md](./skills-core.md) -- substrate. Required
  prerequisite. Every phase below assumes the registry, `runSkill`,
  `invoke_skill` meta-tool, and feasibility infrastructure are landed.
- [plans/analyzers/data-analyzer.md](./data-analyzer.md) -- existing
  data-analyzer. Orchestrator stays; per-task runner becomes a skill
  composer. The `db_*` tool surface stays as the primitive layer skills
  call into.
- [plans/analyzers/code-analyzer.md](./code-analyzer.md) -- exposes its
  first batch of skills (`code.class.extract-fields`, `code.lineage.callers`)
  via the cross-owner skill mechanism. Without these, data-analyzer's
  code-binding family hard-fails the `required-tools` precondition.
- [plans/data-driver.md](../data-driver.md) -- shipped; the substrate the
  source-introspection / sampling / aggregation tools call into. This plan
  adds a new `db_aggregate_*` tool family on top of the driver.
- [plans/data-driver-duckdb-files.md](../data-driver-duckdb-files.md) --
  **shipped**, was a hard prerequisite for this plan and is now fully
  done. Consolidated every file kind (csv / tsv / jsonl / ndjson /
  json / parquet / arrow / feather / avro / bson / fixed-width / xlsx)
  onto a single DuckDB-backed driver. Native kinds hit DuckDB's reader
  functions directly; non-native kinds stage through Parquet
  converters (`avsc` / `bson` / `exceljs` / streaming line reader)
  into a per-source-file Parquet cache, then read via the same SQL
  surface. Directory connections (with `recursive` + optional
  `options.glob` filter) work for every kind. xlsx honors a sheet
  `target` for per-sheet selection. The bespoke per-format file
  drivers were deleted in Phase 7.1; `daemon/db/drivers/index.ts`
  registers exactly one factory for the file family
  (`duckdb-file.ts`). The tools `db_file_aggregate`,
  `db_file_list_files`, and the consolidated `db_file_describe` /
  `db_file_sample` / `db_file_sample_shape` are in place; this plan
  does not re-implement them. File-flavoured Family 5 (quality /
  distribution) skills consume those tools as shipped primitives,
  with no per-kind branching at the skill layer.
- [plans/access-gate.md](../access-gate.md) -- shipped; skill calls inherit
  the universal access gate via the tools they call.
- [plans/content-generator.md](../content-generator.md) -- shipped; the
  multi-pass synthesise infrastructure that synthesis-family skills compose.

## Status

> **Storage substrate (2026-05-07): unblocked.** The 2026-05-05 DuckDB
> checkpoint-OOM that paused this plan is resolved. The substrate has been
> re-split as anticipated, with LMDB substituted for SQLite (decision
> driven by the existing graph workload's u64-keyed binary access pattern
> and the desire for a custom graph layer over a high-throughput KV
> substrate): **LMDB for graph + metadata** (`db/graph/`, 20 sub-DBs,
> typed JS API for traversal), **LanceDB for entity embeddings** (one
> `entity_vec` table; ANN + repo / kind / artifact filters; periodic
> compaction during fullIndex), **DuckDB demoted** to the in-memory
> analytical query-engine substrate only -- exactly the `db_file_*`
> data-driver pool this plan's Family-5 file-side skills consume. The
> daemon is operational on the new substrate; skill smoke runs, fixture
> replays, and end-to-end verification are unblocked. Skill code remains
> substrate-independent (skills hit the data-driver pool, not the
> storage pool), so the only follow-up cost from the substrate work is
> verifying the smoke harness against the LMDB+Lance daemon before
> resuming Phase-by-Phase work below.

> ### ⚠️ Deferred -- code-analyzer prerequisites required
>
> **Phase 3 code-binding skills (3.1, 3.2, 3.3, 3.5) are deferred** until
> the code-analyzer-side skills they cross-call into are implemented.
> Each data-analyzer-side wrapper is structurally a thin
> `runSkill('code.<...>', ...)` dispatch under the cross-owner depth cap;
> the dispatch target does not yet exist in the registry, so the skills
> would hard-fail their `required-tools: ['code_locate', 'code_describe']`
> precondition on every invocation today.
>
> | Deferred slice | Cross-calls into (code-analyzer-side) |
> |---|---|
> | 3.1 `data.code.class.extract-fields` | `code.class.extract-fields` |
> | 3.2 `data.code.class.locate-references` | `code.class.locate-references` |
> | 3.3 `data.code.orm.resolve-model` | `code.orm.resolve-model` (Prisma / TypeORM / SQLAlchemy / Hibernate dialects) |
> | 3.5 `data.code.migration.extract-history` | `code.migration.extract-history` |
>
> **Transitive impact -- Phase 4 composites (4.1-4.5) are also deferred**:
> `drift.prisma-vs-live` / `drift.typeorm-vs-live` /
> `drift.sqlalchemy-vs-live` cannot resolve the schema side without 3.3;
> `mapping.json-vs-class` / `mapping.csv-vs-dto` cannot resolve the
> class side without 3.1. 4.6 `cardinality.expected-vs-live` and 4.7
> `range.expected-vs-live` could plausibly accept caller-supplied
> "expected" values directly and ship independently of code-binding;
> deferring them with the rest of Phase 4 for now to keep the
> comparison-diff family landing as one coherent batch when the
> prerequisites arrive.
>
> **Action when code-analyzer skills land:** revisit
> [plans/analyzers/code-analyzer.md](./code-analyzer.md) for the slice
> that registers the four `code.<...>` skills above; once those land,
> the data-analyzer wrappers (3.1 / 3.2 / 3.3 / 3.5) are mechanical
> follow-ups (~80 lines each, identical structure to 3.4 lineage).
> Phase 4 composites land next on top of those. The hallucinated-class
> regression test from 2026-04-30 (per "Lessons baked in" §1) MUST go
> green before the deferral is closed -- a wrapper that papers over a
> missing class side with an empty diff is the failure mode this plan
> exists to prevent.

**Phase 0 is now fully shipped.** All nine slices are done (see the table
below for per-slice evidence + tests). The completion landed as one PR
extending the driver interface with `histogram()` / `correlationMatrix()`
/ `outliers()` / `listNamespaces()` / `describeNamespace()`, with shared
orchestrators in `rdbms-common.ts` (`executeHistogram` /
`executeCorrelationMatrix` / `executeOutliers`) so each driver wires the
new methods via a per-driver `runRows` callback. The data-driver-duckdb-files
prerequisite is **fully shipped** -- every file kind already routes
through the consolidated DuckDB-backed driver with `db_file_*` tools in
place. Currently **23 `db_*` tools** are registered:
`db_list_connections`; SQL: `db_sql_describe` / `_sample` / `_explain` /
`_aggregate` / `_distinct` / `_histogram` / `_correlation_matrix` /
`_outliers`; KV: `db_kv_scan` / `_get` / `_sample_shape` /
`_list_namespaces` / `_describe_namespace`; file: `db_file_describe` /
`_sample` / `_sample_shape` / `_list_files` / `_aggregate` / `_distinct` /
`_histogram` / `_correlation_matrix` / `_outliers`. Phase 1.1
(`data.source.rdbms.describe-table`), Phase 1.3
(`data.source.file.describe`), Phase 2.1 (both
`data.source.rdbms.sample-rows` and `data.source.rdbms.sample-distinct`),
Phase 2.2 (all three KV sampling skills:
`data.source.kv.scan-keys` / `get-value` / `sample-shape`), and
Phase 2.3 (`data.source.file.sample-rows`,
`data.source.file.sample-shape`) are landed. Phase 5a-5g
(quality-profile / distribution / dependency / quality-scorecard /
sensitivity / drift / timeseries) are fully shipped on the RDBMS side
and Track A (file-side ports) is now complete: 22 file variants land
across 5a (5 profilers), 5b (6 distribution), 5c (3 dependency), 5d
(6 quality including the scorecard composite), 5e (1 PII), 5f (2 drift).
Several rows stay `partial` because their full-table math has not yet
been folded into the existing skills (transport ports are done; the
math swap is mechanical now that the tools land). Phase 1.2
(source-introspection: kv) is **done** -- both skills shipped:
`data.source.kv.list-namespaces` and
`data.source.kv.describe-namespace` (atomic thin wrappers over
`db_kv_list_namespaces` / `db_kv_describe_namespace`; memcached's
`supported: false` clamps to `low`). Phase 1.4 / 2.4 (doc family) is
moot now that 0.9 reconciled to `kv`. Slice 3.4 has a partial wrapper
from skills-core 9. Skill core (skills-core.md) is fully shipped.

| Phase | Slice | State | Notes |
|---|---|---|---|
| 0.1 | `db_sql_aggregate` + `db_file_aggregate` tool | done | Tools registered at [tools/builtins/db/index.ts:480 (sql) and the file-side counterpart](src/insrc/daemon/tools/builtins/db/index.ts). Helper `compileAggregate` in [rdbms-common.ts:409-424](src/insrc/daemon/db/drivers/rdbms-common.ts#L409-L424) (now compiles WHERE via `compileWhere`). Driver method `aggregate()`: real impl on [postgres](src/insrc/daemon/db/drivers/pg.ts#L142), [mysql](src/insrc/daemon/db/drivers/mysql.ts#L131), [sqlite](src/insrc/daemon/db/drivers/sqlite.ts#L127), [mssql](src/insrc/daemon/db/drivers/mssql.ts#L184), [oracle](src/insrc/daemon/db/drivers/oracle.ts#L156); [clickhouse](src/insrc/daemon/db/drivers/clickhouse.ts#L123-L135) throws-with-message (per-dialect `quantile()` / `stddevSamp` / `varSamp` follow-up). File path: [DuckDBFileDriver.aggregate()](src/insrc/daemon/db/drivers/duckdb-file.ts#L395). **WHERE support** added per the 5f.2 drift.volume fix -- both tools now accept `where: WHERE_SCHEMA`, threaded through `AggregateRequest.where` / `compileAggregate` / file-side `aggregate()` SQL builder. Coverage: `compileAggregate` table tests in [rdbms-common.test.ts](src/insrc/daemon/db/__tests__/rdbms-common.test.ts) (incl. 4 WHERE-on-aggregate cases) + sqlite / duckdb integration tests |
| 0.2 | `db_sql_histogram` + `db_file_histogram` tool | done | Both tools registered in [tools/builtins/db/index.ts](src/insrc/daemon/tools/builtins/db/index.ts). Compile helpers `clampHistogramBuckets` / `histogramBoundsRequest` / `compileHistogramBuckets` / `readHistogramRows` + orchestrator `executeHistogram` in [rdbms-common.ts](src/insrc/daemon/db/drivers/rdbms-common.ts). Two-phase protocol: bounds via `aggregate(min/max/count_non_null/count)`, then a bucketed counts query. **Equal-width** uses `FLOOR((col - lower) / width)` arithmetic with a CASE clamp at the upper edge (every dialect supports it). **Equal-frequency** uses `NTILE(n) OVER (ORDER BY col)` (Postgres / DuckDB / SQLite>=3.25 / MySQL>=8.0 / MSSQL / Oracle). `histogram()` wired on every RDBMS driver except clickhouse (throws-with-message) + DuckDBFileDriver. Default 20 buckets, capped at 200. Coverage: 4 integration tests on duckdb-file (equal-width + equal-frequency) and sqlite (same). Unblocks the full-table upgrade for 5b.7 distribution.modes (skill swap pending in Track C) |
| 0.3 | `db_sql_distinct` + `db_file_distinct` tool | done | Both tools registered in [tools/builtins/db/index.ts](src/insrc/daemon/tools/builtins/db/index.ts) (sql at line 574, file at 611). Helper [`compileDistinct` in rdbms-common.ts:451-482](src/insrc/daemon/db/drivers/rdbms-common.ts#L451-L482). Driver method `distinct()`: real impl on [postgres:155](src/insrc/daemon/db/drivers/pg.ts#L155), [mysql:143](src/insrc/daemon/db/drivers/mysql.ts#L143), [sqlite:141](src/insrc/daemon/db/drivers/sqlite.ts#L141), [mssql:196](src/insrc/daemon/db/drivers/mssql.ts#L196), [oracle:175](src/insrc/daemon/db/drivers/oracle.ts#L175); [clickhouse:138-150](src/insrc/daemon/db/drivers/clickhouse.ts#L138-L150) throws-with-message (paired with the aggregate() follow-up). File path: [DuckDBFileDriver.distinct() at duckdb-file.ts:416](src/insrc/daemon/db/drivers/duckdb-file.ts#L416). Deterministic order (count desc, value asc); topN clamped [1, 1000]. Coverage: 2 `compileDistinct` cases + `readDistinctCount` test + sqlite / duckdb integration |
| 0.4 | `db_sql_correlation_matrix` + `db_file_correlation_matrix` tool | done | Both tools registered in [tools/builtins/db/index.ts](src/insrc/daemon/tools/builtins/db/index.ts). Helpers `compileCorrelationMatrix` + `readCorrelationRow` + orchestrator `executeCorrelationMatrix` in [rdbms-common.ts](src/insrc/daemon/db/drivers/rdbms-common.ts). Single SQL; one column per ordered upper-triangular pair plus a row-count column. **Pearson** uses native `CORR()` on Postgres / Oracle / DuckDB; portable expression `(N*sum(ab) - sum(a)*sum(b)) / sqrt((N*sum(a^2) - sum(a)^2)*(N*sum(b^2) - sum(b)^2))` with `NULLIF(..., 0)` zero-variance guard on dialects without `CORR()` (SQLite / MySQL / MSSQL). **Spearman** ranks each column with `RANK() OVER (ORDER BY col)` in a CTE-style subquery, then runs the same Pearson SQL on the ranks. Pairwise complete observations (rows where every requested column is non-null). Capped at 10 columns. Wired on every RDBMS driver except clickhouse + DuckDBFileDriver. Coverage: 4 integration tests on duckdb-file (Pearson + Spearman) and sqlite (same). Unblocks 5c.1 correlation.numeric-pairwise full-table math |
| 0.5 | `db_sql_outliers` + `db_file_outliers` tool | done | Both tools registered in [tools/builtins/db/index.ts](src/insrc/daemon/tools/builtins/db/index.ts). Helpers `outlierBoundsRequest` + `compileOutlierCounts` + `compileOutlierExamples` + readers + orchestrator `executeOutliers` in [rdbms-common.ts](src/insrc/daemon/db/drivers/rdbms-common.ts). Two-phase protocol: bounds via `aggregate(percentile_0.25/0.5/0.75 + count_non_null)` for IQR or `aggregate(avg + stddev + count_non_null)` for zscore; then a counts query (`SUM(CASE WHEN col < lower THEN 1)` / `... > upper`) + an examples query (LIMIT N ordered by extremity descending). Default thresholds: IQR=1.5, zscore=3; default 20 / max 50 examples. Wired on every RDBMS driver that supports the underlying aggregate functions (clickhouse stub throws as before). DuckDBFileDriver works fully. Coverage: 2 integration tests on duckdb-file (IQR + zscore). Replaces sample-based math in 5b.2 / 5b.3 outlier skills (skill swap pending in Track C) |
| 0.6 | sampling-confidence library | done | [`daemon/db/sampling-confidence.ts`](src/insrc/daemon/db/sampling-confidence.ts) -- exports `sampleSizeFor()` + `confidenceFor()` (with `Estimator` + `Confidence` types) for mean / percentile / normality / correlation estimators; finite-population correction; 13-test suite at [`daemon/db/__tests__/sampling-confidence.test.ts`](src/insrc/daemon/db/__tests__/sampling-confidence.test.ts). **Currently under-utilised**: most Family-5 skills hard-code 'high' / 'medium' / 'low' confidence rather than calling `confidenceFor(actualN, estimator, populationN)`. Threading this through the existing skills is a follow-up tracked separately from Phase 0 itself |
| 0.7 | `db_kv_list_namespaces` tool | done | Tool registered in [tools/builtins/db/index.ts](src/insrc/daemon/tools/builtins/db/index.ts). `KvDriver.listNamespaces()` is now an interface member. Per-driver impls: **MongoDB** lists databases via `admin().listDatabases()` (filtering out admin/config/local) then collections via `db.listCollections({}, { nameOnly: true })`, returning `<db>.<coll>` names; **Cassandra** queries `system_schema.tables` filtering out the system keyspaces; **DynamoDB** uses `ListTablesCommand` with paginated `ExclusiveStartTableName`; **NATS KV** reports the connection-bound bucket; **Redis / etcd** SCAN a sample of keys (~5K) and group by the first separator (`:` for Redis, `/` for etcd) into `prefix` namespaces with approximate counts; **Memcached** returns `supported: false` (no enumeration surface). Result shape: `{ namespaces: [{ name, kind, approxCount }], truncated, supported }`. Unblocks Phase 1.2 source-introspection: kv |
| 0.8 | `db_kv_describe_namespace` tool | done | Tool registered in [tools/builtins/db/index.ts](src/insrc/daemon/tools/builtins/db/index.ts). `KvDriver.describeNamespace(name, opts)` is now an interface member. **MongoDB** returns `estimatedDocumentCount()` + sample keys + shape inferred via `inferShape` over a doc sample; **Cassandra** returns native column types from `system_schema.columns` keyed on partition / clustering kind, plus a key-only sample of recent rows; **DynamoDB** returns `DescribeTableCommand.ItemCount` + a partition/sort-key sample + value-shape via `inferShape`; **NATS KV** scans the bucket's keys and infers a value shape; **Redis / etcd** scan the prefix and infer JSON shape; **Memcached** returns `supported: false`. Result shape: `{ name, kind, approxCount, sampleKeys, fields, supported }` |
| 0.9 | doc-family naming reconciliation | done | Driver-side family enum at [`shared/db-driver.ts:14`](src/insrc/shared/db-driver.ts#L14) defines exactly `'rdbms' \| 'kv' \| 'file'` -- no `doc` family. [MongoDB at mongodb.ts:140](src/insrc/daemon/db/drivers/mongodb.ts#L140) and [Cassandra at cassandra.ts:198](src/insrc/daemon/db/drivers/cassandra.ts#L198) both report `kv`. The Phase 2.2 KV sampling skills already cover both. Plan-side rows for "doc" (1.4 / 2.4) are now obsolete -- they collapse into `kv`. Decision recorded: **`doc` references in this plan should be read as `kv`**; do not add a `doc` family to the driver |
| 1.1 | source-introspection: rdbms | done | All three skills shipped: `data.source.rdbms.describe-table` (over `db_sql_describe`), `data.source.rdbms.list-tables` (over the new `db_sql_list_tables` tool, returns base tables + views excluding system schemas; optional `schema` filter; default limit 500 / cap 5000), `data.source.rdbms.list-indexes` (over the new `db_sql_list_indexes` tool, returns name + columns + unique flag + PK flag). Driver methods `listTables()` / `listIndexes()` real impls on Postgres / MySQL / SQLite / MSSQL / Oracle; ClickHouse stubs throw with a per-engine follow-up note (system.tables / system.data_skipping_indices have a different shape) |
| 1.2 | source-introspection: kv | done | Both skills shipped: `data.source.kv.list-namespaces` (over `db_kv_list_namespaces`) and `data.source.kv.describe-namespace` (over `db_kv_describe_namespace`). Atomic thin wrappers; `supported: false` (memcached) clamps confidence to `low` with a "driver does not expose namespaces / namespace shape" note. Covers redis / valkey / keydb / mongodb / cassandra / nats / dynamodb / etcd / memcached. Coverage: smoke fixtures land high-confidence on Mongo-shaped data |
| 1.3 | source-introspection: file | done | `data.source.file.describe` shipped (`daemon/skills/built-ins/data.source.file.describe.ts`). One skill covers all 12 file kinds via `connection-family: ['file', csv / tsv / jsonl / ndjson / json / parquet / arrow / feather / avro / bson / fixed-width / xlsx]` precondition. Thin wrapper over `db_file_describe`; the underlying DuckDB-backed driver dispatches to native readers or staged-Parquet readers transparently. xlsx target selects a sheet |
| 1.4 | source-introspection: doc | pending | describe-collection, list-collections |
| 2.1 | source-sampling: rdbms | done | Both atomic skills shipped: `data.source.rdbms.sample-rows` (over `db_sql_sample`, structured WHERE support) and `data.source.rdbms.sample-distinct` (over `db_sql_distinct`, top-N + distinct cardinality, deterministic order) |
| 2.2 | source-sampling: kv | done | All three skills shipped: `data.source.kv.scan-keys` (over `db_kv_scan`), `data.source.kv.get-value` (over `db_kv_get`), `data.source.kv.sample-shape` (over `db_kv_sample_shape`). Covers redis / valkey / keydb / mongodb / cassandra / nats / dynamodb / etcd / memcached |
| 2.3 | source-sampling: file | done | `data.source.file.sample-rows` and `data.source.file.sample-shape` shipped. Both are thin wrappers (`db_file_sample` / `db_file_sample_shape`) covering all 12 file kinds via the consolidated DuckDB-backed driver. xlsx target selects a sheet; directory connections glob / walk-and-convert transparently. WHERE clause supported on sample-rows; sample-shape pulls a sample then runs `inferShape` for nested types (json / jsonl / ndjson) |
| 2.4 | source-sampling: doc | pending | sample-docs, sample-shape |
| 3.1 | code-binding: class.extract-fields | **deferred** -- needs code-analyzer prerequisites | Blocked on `code.class.extract-fields` registration in code-analyzer; see "Deferred -- code-analyzer prerequisites required" callout above |
| 3.2 | code-binding: class.locate-references | **deferred** -- needs code-analyzer prerequisites | Blocked on `code.class.locate-references`; see callout above |
| 3.3 | code-binding: orm.resolve-model | **deferred** -- needs code-analyzer prerequisites | Blocked on `code.orm.resolve-model` (Prisma / TypeORM / SQLAlchemy / Hibernate dialects); see callout above |
| 3.4 | code-binding: lineage.read-write-callsites | done | `data.lineage.read-write-callsites` skill wraps the `data_lineage` tool. Tool upgraded with: (a) ORM-typed call-pattern recognition (`.create(`, `.findOne(`, `.update_all(`, etc.) covering Prisma / TypeORM / Sequelize / SQLAlchemy / Hibernate / ActiveRecord -- the leading-`.` requirement avoids identifier-substring false positives like `update_count`; (b) name-variant matching on the literal target (lowercase / UPPERCASE / Rails-singularised / PascalCase / camelCase / snake_case) so `users` also matches `User.create(...)` and `user_profile` matches `UserProfile.find(...)`; (c) wider classification window (200 chars vs the v1 80) to catch ORM chains where `.method(` is several tokens past the literal name. ORM-write precedence: when both write and read patterns match (e.g. `User.where(...).update_all(...)`) the operation is classified as writer, since ORM chains build queries then call a terminal write method. 22 unit tests in `daemon/tools/builtins/data/__tests__/lineage.test.ts`. The Phase 3.2 / 3.3 type-resolved identifier path (Prisma schema -> model -> table mapping) is a complementary follow-up that lands with the rest of code-binding. |
| 3.5 | code-binding: migration.extract-history | **deferred** -- needs code-analyzer prerequisites | Blocked on `code.migration.extract-history`; see callout above |
| 4.1 | comparison-diff: drift.prisma-vs-live | **deferred** -- transitive on Phase 3 | Composite over rdbms.describe-table + 3.3 orm.resolve-model (Prisma); deferred with the rest of Phase 4 until code-analyzer prerequisites land. See callout above |
| 4.2 | comparison-diff: drift.typeorm-vs-live | **deferred** -- transitive on Phase 3 | Same shape as 4.1 over the TypeORM dialect of 3.3 |
| 4.3 | comparison-diff: drift.sqlalchemy-vs-live | **deferred** -- transitive on Phase 3 | Same shape as 4.1 over the SQLAlchemy dialect of 3.3 |
| 4.4 | comparison-diff: mapping.json-vs-class | **deferred** -- transitive on Phase 3 | Composite (3.1 class.extract-fields + 2.3 file.sample-shape); deferred until 3.1 lands. The hallucinated-class regression test from 2026-04-30 must go green before this slice ships |
| 4.5 | comparison-diff: mapping.csv-vs-dto | **deferred** -- transitive on Phase 3 | Composite (3.1 class.extract-fields on the DTO + 2.3 file.sample-shape on the CSV) |
| 4.6 | comparison-diff: cardinality.expected-vs-live | **deferred** -- batched with Phase 4 | Could plausibly ship independently with caller-supplied "expected" values; deferred to keep the comparison-diff family landing as one coherent batch when 3.x prerequisites arrive |
| 4.7 | comparison-diff: range.expected-vs-live | **deferred** -- batched with Phase 4 | Same rationale as 4.6 |
| 5a.1 | quality-profile: profile.numeric | done (modulo helper-extraction follow-up) | Both `data.profile.numeric.rdbms` and `data.profile.numeric.file` shipped. Math + output schema lifted into `data.profile.numeric.algo.ts`; both wrappers delegate. `.rdbms` calls `db_sql_aggregate`; `.file` calls `db_file_aggregate` (xlsx sheet selection via the optional `target` field, mapped to the file-tool's `path` parameter at the boundary). Both fixtures green |
| 5a.2 | quality-profile: profile.categorical | done | Both `.rdbms` and `.file` shipped. Math lives in `data.profile.categorical.algo.ts`. `.rdbms` uses `db_sql_aggregate` + `db_sql_distinct`; `.file` uses `db_file_aggregate` + `db_file_distinct` (xlsx sheet selection via optional `target` field) |
| 5a.3 | quality-profile: profile.temporal | done | Both `.rdbms` and `.file` shipped (count + non-null + null + distinct cardinality + temporal min/max + range span). Math in `data.profile.temporal.algo.ts`. Phase 0.1.x type-aware aggregate values now carry temporal min/max as ISO strings; output includes `minValue` / `maxValue` / `rangeSpanMs` / `rangeSpanDays`. Gap-detection / period-inference left for a future skill |
| 5a.4 | quality-profile: profile.text | done | Both `.rdbms` and `.file` shipped. Math in `data.profile.text.algo.ts`. Server-side cardinality + null rate + distinct count via aggregate; sample-based length stats (min / max / avg / median) + empty-string count + **encoding signals** (asciiOnly / nonAsciiRate / astralPresent / controlCharCount / bomCount / mojibakeSuspectCount + `verdict` rolling them up to one of `ascii` / `utf8-clean` / `has-bom` / `control-chars-present` / `mojibake-suspect` / `inconclusive`). Mojibake detection catches Latin-1-decoded-as-UTF-8 byte sequences (`Ã©`, `â€™`, `Â£`) that survive the driver decode -- a tell-tale sign of double-decoding. 11 unit tests in `daemon/skills/__tests__/profile-text-encoding.test.ts`. Generalized regex pattern inference is intentionally out of scope (covered by 5e.1 `pii.detect-patterns` for canonical PII shapes; a future general-pattern skill could ship as a follow-up if a caller actually needs it). |
| 5a.5 | quality-profile: profile.boolean | done | Both `.rdbms` and `.file` shipped. Math in `data.profile.boolean.algo.ts` (one `db_*_distinct` round-trip + dialect-tolerant true / false / null / other normaliser; true ratio over non-null observations). xlsx sheet selection on the file variant via optional `target` field |
| 5a.6 | quality-profile: profile.auto | done | `data.profile.auto.rdbms` shipped (composite over all 5 RDBMS profile atomics). Calls `db_sql_describe` to read the column's declared SQL type, classifies into `numeric / text / boolean / temporal / categorical` via lowercase substring rules, dispatches to the matching profiler via `runSkill`. Returns `{ declaredType, kind, profile }` so synthesise renderers branch without re-classifying |
| 5b.1 | distribution: distribution.histogram | done | Both `.rdbms` and `.file` shipped. Math is entirely server-side (Phase 0.2 `db_sql_histogram` / `db_file_histogram`); skill is a pass-through wrapper that normalises the tool result into a typed output and stamps a top-level verdict (`has-data` / `empty` / `inconclusive`). Default 20 buckets, capped at 200; modes `equal-width` (every dialect) / `equal-frequency` (NTILE-supporting dialects). xlsx sheet selection on file variant via optional `target` field. Output: `{ target, column, mode, bucketsRequested, bounds, nonNullCount, nullCount, buckets, verdict }`. Unblocks 6.9 synth.histogram-block. |
| 5b.2 | distribution: distribution.outliers-iqr | done | Both `.rdbms` and `.file` shipped. Math in `data.distribution.outliers-iqr.algo.ts` (Tukey-IQR; default k=1.5; Q1/Q3/IQR + bounds from server-side aggregate; sample-based outlier examples + estimated count over 50 rows; `hasFullTableOutliers` precise from min/max vs bounds). `.file` uses xlsx sheet selection via optional `target` field |
| 5b.3 | distribution: distribution.outliers-zscore | done | Both `.rdbms` and `.file` shipped. Math in `data.distribution.outliers-zscore.algo.ts`. Same Z-score model both sides; mean/stddev from server-side aggregate, examples from sample. |
| 5b.4 | distribution: distribution.outliers-mad | done | Both `.rdbms` and `.file` shipped. Math in `data.distribution.outliers-mad.algo.ts` (modified Z-score via MAD; default threshold 3.5). Phase 0.1.x: server-side `mad` aggregate is now consumed automatically when the engine supports it (DuckDB native); falls back to sample-based MAD on dialects that don't. `madSource` reports `'server' \| 'sample' \| 'unknown'`. |
| 5b.5 | distribution: distribution.normality-test | done | Both `.rdbms` and `.file` shipped. Math in `data.distribution.normality-test.algo.ts` (Jarque-Bera; chi-squared(2) closed-form p-value). Phase 0.1.x: server-side `skewness` + `kurtosis` aggregates now consumed automatically when supported (DuckDB native). `momentSource` reports `'server' \| 'sample' \| 'unknown'`. |
| 5b.6 | distribution: distribution.heavy-tail-check | done | Both `.rdbms` and `.file` shipped. Math in `data.distribution.heavy-tail-check.algo.ts` (excess kurtosis verdict, default threshold 1.0). Phase 0.1.x: server-side `kurtosis` aggregate consumed when supported. Verdict tagged "(full-table)" in interpretation when server moments were used. |
| 5b.7 | distribution: distribution.modes | done | Both `.rdbms` and `.file` shipped. Math in `data.distribution.modes.algo.ts` (histogram + smoothing + local-maxima detection + plateau-collapse). Phase 0.2: opt-in `mode: 'full-table'` delegates to `db_*_histogram` for precise bin counts; smoothing + peak-detection runs on the precise bins. Default `mode: 'sample'` for back-compat. |
| 5c.1 | dependency: correlation.numeric-pairwise | done | Both `.rdbms` and `.file` shipped. Math in `data.correlation.numeric-pairwise.algo.ts` (Pearson + Spearman + classification). Phase 0.4: opt-in `mode: 'full-table'` issues two `db_*_correlation_matrix` calls (Pearson + Spearman) and reshapes the result into the existing PairResult[]. Capped at 10 columns in matrix mode. Default `mode: 'sample'` for back-compat. |
| 5c.2 | dependency: correlation.categorical-pairwise | done | Both `.rdbms` and `.file` shipped. Math in `data.correlation.categorical-pairwise.algo.ts` (Cramér's V + cardinality filter + classification). |
| 5c.3 | dependency: dependency.functional | done | `data.dependency.functional.rdbms` shipped. Sample mode (default): pairwise FD over a 50-row sample. **Full-table mode** (`mode: 'full-table'`): delegates to a new `db_sql_functional_dependency` tool that issues GROUP BY + COUNT(DISTINCT) per pair. Driver method `functionalDependency(target, request)` real impls on Postgres / MySQL / SQLite / MSSQL / Oracle (clickhouse stubbed-with-message); compile helpers `compileFdStats` / `compileFdViolations` / `compileFdToSample` + orchestrator `executeFunctionalDependency` in `rdbms-common.ts`. Cap: 10 columns / 90 ordered pairs per call. Skill returns the same FdResult shape in both modes -- consumers can treat full-table results as the precise answer (sampleSize=0 sentinel) |
| 5c.4 | dependency: dependency.co-null-pattern | done | Both `.rdbms` and `.file` shipped. Math in `data.dependency.co-null-pattern.algo.ts`. Phase 0.1.x: opt-in `mode: 'full-table'` issues 4 `count_where` aggregates per pair (bothNull / aNullOnly / bNullOnly / neitherNull), batched 8 pairs per call to fit the 32-spec budget. Default `mode: 'sample'` for back-compat. |
| 5c.5 | dependency: cardinality.join-key | done | `data.cardinality.join-key.rdbms` shipped. Three parallel tool calls (aggregate on each side + a server-side anti-join) derive `1:1 / 1:N / N:1 / N:M / unknown` and an **exact full-table orphan count** -- no value-set cap, no `valueSetTruncated` flag. The anti-join uses `SELECT COUNT(*) FROM (SELECT DISTINCT left.col) WHERE NOT EXISTS (SELECT 1 FROM right WHERE right.col = left.col)` -- universally portable across dialects (clickhouse stubbed-with-message). Driver method `RdbmsDriver.antiJoin()` + new `db_sql_anti_join` tool. Cross-connection joins remain out of scope (per-user decision; would need a federated query layer that hasn't been requested). |
| 5d.1 | quality scorecard: quality.completeness | done | Both `.rdbms` and `.file` shipped. Math in `data.quality.completeness.algo.ts` (auto-discovers columns; packs `count(*)` + `count_non_null` per column into one aggregate round-trip; up to 31 columns per call). |
| 5d.2 | quality scorecard: quality.uniqueness | done | Both `.rdbms` and `.file` shipped. Math in `data.quality.uniqueness.algo.ts` (per-column `distinctCount/nonNullCount` + single-column PK-candidate detector; cap at 15 columns per call due to `1 + 2N <= 32` aggregate-spec budget). Phase 0.1.x: optional `compositePkCandidates: string[][]` input enables multi-column PK detection via the new `composite_distinct_count` aggregate (one spec per candidate, capped at 16 candidates). Output gained `compositePkCandidates` field with per-tuple distinctCount + isCandidate verdict. |
| 5d.3 | quality scorecard: quality.validity | partial — open decision | Both `.rdbms` and `.file` shipped. Math in `data.quality.validity.algo.ts` (caller-supplied JS regex pattern, samples up to 50 values, returns match / mismatch counts + match rate + up to 3 examples each). Pattern compiled once with `new RegExp(pattern)` so a malformed pattern fails fast. **Integrated into 5d.6 scorecard** via the optional `validityPatterns` map. **In-flight decision (paused on storage-substrate work)** -- two gaps remain in the partial: **Gap 1** -- full-table regex match-rate via per-dialect `regex_like` SQL (`~` PG, `REGEXP` MySQL/SQLite, `REGEXP_LIKE` Oracle/MSSQL); tractable, ~2 hours: extend WhereClause op enum with `regex` / `not regex`, use `count_where` with regex predicate. **Gap 2** -- type/domain/CHECK-constraint introspection; needs per-dialect catalog reads (pg_constraint, sys.check_constraints, all_constraints) plus a way to express CHECK clauses (which are arbitrary SQL expressions, not WhereClause structs). Three options on the table: **(1)** Just Gap 1, defer Gap 2 with explicit framing -- caller must continue to supply explicit regex patterns; without Gap 2 the skill cannot auto-discover validity rules from schema; format-shape validation is still covered by 5d.4 conformity's built-in catalog. **(2)** Gap 1 + Gap 2(a) raw-SQL escape hatch (e.g. `count_where_raw`) bypassing structured WhereClause safety. **(3)** Gap 1 only (same as 1). User leaning toward Option 1 pending confirmation; storage-substrate work has paused this decision. |
| 5d.4 | quality scorecard: quality.conformity | partial | Both `.rdbms` and `.file` shipped. Math in `data.quality.conformity.algo.ts` (built-in catalog of 13 canonical formats: iso-date, iso-datetime, us-date, eu-date, usd/eur/iso-currency, iso-country-2/3, us-zip, uk-postal, ca-postal, e164-phone). Returns per-format hit rates + best-fitting format + verdict (conformant >=95% / mostly-conformant >=70% / mixed / unrecognized / inconclusive). Sample-based (50 rows). Pairs with `quality.validity` -- this skill picks a known format; validity validates a custom regex. Folded into scorecard composite (5d.6) via `conformityRules` |
| 5d.5 | quality scorecard: quality.consistency | done | Both `.rdbms` and `.file` shipped. Math in `data.quality.consistency.algo.ts` (caller-supplied cross-column rules). Operators: comparison (`< <= = != >= >`) with null-aware inapplicable handling, plus `and-not-null` and `xor-null`. Phase 0.1.x: opt-in `mode: 'full-table'` issues per-rule `count_where` aggregates; comparison rules use `valueColumn` for `left op right` predicates, null-pattern rules use null-flag combinations. Default `mode: 'sample'` for back-compat. Folded into scorecard composite (5d.6) via `consistencyRules` |
| 5d.6 | quality scorecard: quality.scorecard | partial | Both `.rdbms` and `.file` shipped (composite over 5d.1 + 5d.2 + optionally 5d.3 + 5d.4 + 5d.5). Math in `data.quality.scorecard.algo.ts`. All five dimensions opt in via caller-supplied input: `validityPatterns: { col: regex }` activates 5d.3; `conformityRules: { col: format-slug }` activates 5d.4; `consistencyRules: ConsistencyRule[]` activates 5d.5 (cross-column). Weight profile picked dynamically: base (completeness=0.6, uniqueness=0.4); +validity (0.5/0.3/0.2); +conformity (0.5/0.3/0.0/0.2); +both (0.4/0.25/0.175/0.175). Per-column composite excludes dimensions without scores so columns missing one opt-in aren't penalized. **Consistency reports as a separate top-level `consistency` block** (cross-column by nature; doesn't enter the per-column composite); per-rule satisfaction + verdict + mean satisfactionRate. Top-issues now also surface broken consistency rules below 0.7 satisfaction alongside per-column problems. Repo-overridable weights (`~/.insrc/data-analyzer/scorecard.json`) deferred per the open-question table. Coverage: 2 dedicated composite tests (validity+conformity+consistency all on; back-compat with no opt-ins). 6.8 synth.scorecard renderer also extended -- conditional conformity column + new "Cross-column consistency" section |
| 5e.1 | sensitivity: pii.detect-patterns | done | All three variants shipped: `.rdbms`, `.file`, `.kv`. Math + catalog in `data.pii.detect-patterns.algo.ts` (anchored regex set: email / ssn-us / phone-us / credit-card / jwt / ipv4 / iban / aws-access-key / github-token / uuid). KV variant uses `db_kv_list_namespaces` + `db_kv_scan` + `db_kv_get`, walks nested document leaves into a flat string list, regex-matches against the same catalog. Address detection skipped (no clean regex) |
| 5e.2 | sensitivity: pii.column-classifier | done | `data.pii.column-classifier.rdbms` shipped (composite over `data.pii.detect-patterns.rdbms` + a 14-rule column-name heuristic). Returns one of `pii / likely-pii / not-pii` with explicit `evidence` strings. Surfaces both data-leak (PII values, generic name) and missing-data (named-PII column, empty sample) cases per the 2026-04-30 lessons-learned fix |
| 5e.3 | sensitivity: sensitivity.policy-check | done | `data.sensitivity.policy-check.rdbms` shipped (composite over `data.pii.column-classifier.rdbms`). Cross-references the per-column verdict against caller-supplied `declaredPiiColumns`. Per-column status: `declared-and-detected / declared-not-detected / undeclared-detected / undeclared-likely / clean`. Verdict ladder: `conformant` / `mismatch` (over-declared or review-needed) / `gaps` (missing PII declarations -- the security-relevant signal). Caller supplies the declared list; exposing the connection's `pii` field through a tool surface is a separate decision |
| 5f.1 | drift over windows: drift.distribution | partial | Both `.rdbms` and `.file` shipped. Math in `data.drift.distribution.algo.ts` (caller supplies two `WhereClause[]` filters defining the windows; skill samples 50 rows from each, builds shared-range histograms (default 10 bins), computes Jensen-Shannon divergence + per-direction KL (Laplace-smoothed)). Returns `normalizedJs` (0=identical, 1=max divergent) + verdict (identical/similar/shifted/divergent/inconclusive). Sample-based; full-table KL/JS needs a server-side histogram tool (Phase 0.2) |
| 5f.2 | drift over windows: drift.volume | partial | Both `.rdbms` and `.file` shipped. Math in `data.drift.volume.algo.ts` (row-volume comparison between two windows; caller supplies two `WhereClause[]` filters; two parallel `count_non_null` aggregates with the where filters return absolute / relative / percent change + ratio + verdict ladder: stable <10% / minor-change 10-25% / significant-drop <=-25% / significant-spike >=+25% / inconclusive when countA=0). `countColumn` auto-detected from describe -- prefers PK, falls back to first non-nullable column. **Earlier bug fixed:** the original ship passed `where` to `db_sql_aggregate` whose input schema rejected it. Resolution: extended `db_sql_aggregate` (and `db_file_aggregate`) to accept `where: WHERE_SCHEMA`, threaded through `compileAggregate` -- benefits any future windowed skill. The smoke harness was also hardened to validate skill tool-call inputs against the registered tool's schema (would have caught this regression class; verified with a dedicated harness test that intentionally passes a phantom field). Pairs with `data.drift.distribution` (5f.1) -- volume drift = how much got produced; distribution drift = whether the shape of values changed. |
| 5f.3 | drift over windows: anomaly.change-point | partial | `data.anomaly.change-point.rdbms` shipped (atomic; single-change-point detection on sorted (timestamp, value) sample). For every interior split index k computes the standardised mean shift `|leftMean - rightMean| / pooledStddev`; returns the k that maximises it. Verdict: clear-change (>=2σ) / subtle-change (>=1σ) / no-change / inconclusive. Sample-based at n=50 (min n=10). End-to-end verified: synthetic step at index 20 (50 -> 100 with σ=3 noise) -> changePointIndex=20, leftMean=49.5, rightMean=99.2, standardisedShift=2.07σ, verdict 'clear-change'. Pairs with `drift.distribution.rdbms` (which compares two pre-chosen windows; this skill *finds* the best split) |
| 5g.1 | timeseries: timeseries.trend | partial | `data.timeseries.trend.rdbms` shipped (atomic; activates the `timeseries` family). Least-squares linear regression of `valueColumn` over `timestampColumn`. Returns slope + slopePerDay (human-readable) + intercept + R-squared + direction (increasing / decreasing / flat) + strength (strong>=0.7 / moderate>=0.3 / weak / inconclusive). Pure-JS OLS over a 50-row sample (min n=10). End-to-end verified: synthetic linear data with slope=2/day -> recovered slopePerDay=2.0144, R²=0.97, verdict 'strong increasing'. Pairs with `drift.distribution.rdbms` for a complete temporal-analysis story (trend + drift) |
| 5g.2 | timeseries: timeseries.seasonality | partial | `data.timeseries.seasonality.rdbms` shipped (atomic; autocorrelation-peak detection on a detrended sample). Pulls a 50-row (timestamp, value) sample, sorts by timestamp, removes the OLS trend, computes `r(k)` for k=2..n/2, finds local maxima above the 95% Bartlett band (1.96/sqrt(n)). **Lag 1 is excluded from peak detection** -- its implicit left-neighbor is `r(0)=1`, so for any smooth signal r(1) appears as a "peak" of smoothness, not periodicity. Returns top-5 peaks + best peak's lag + estimated time-span (lag × median timestamp-delta) + human-readable form ("approx. 1.0 days"). Verdict ladder: seasonal (\|r\|>=0.5) / weakly-seasonal (\|r\|>=0.3) / aperiodic / inconclusive (n<20 or constant residuals). Detrend is inlined (~10 lines of OLS) -- no sub-skill dep on 5g.1. End-to-end verified: synthetic 50-hour series with sin(2πt/10h) + small noise (5 full cycles) -> bestPeriodLag=10, bestPeriodSpan ≈ 10 hours, r=0.79, verdict 'seasonal'; also surfaces the lag-20 harmonic at r=0.59. Pairs with `data.timeseries.trend.rdbms` -- trend captures monotonic change, seasonality captures periodic structure |
| 5g.3 | timeseries: timeseries.stationarity | partial | `data.timeseries.stationarity.rdbms` shipped (atomic; Dickey-Fuller unit-root test, constant-only model). Regresses Δy[t] = α + β·y[t-1] + ε on the sorted (timestamp, value) sample, computes the t-statistic on β, compares to MacKinnon (1996) critical values for n=50: -3.58 (1%) / -2.93 (5%) / -2.60 (10%). Verdict: stationary (rejects H₀ at any level) / non-stationary (fails to reject) / inconclusive (n<20 OR Var(y[t-1])=0). Sample-based at n=50 (min n=20). Pure JS closed-form OLS, no matrix inversion. v1 limit: simple DF (no augmented lagged-difference terms); ADF would need a 5x5+ matrix invert for default Schwert k=4 -- deferred until empirical need. End-to-end verified: synthetic AR(1) with theoretical φ=0.3 (so β=ρ-1=-0.7) -> recovered β=-0.7066, t=-5.07, rejects at 1% level, verdict 'stationary'. Pairs with `data.timeseries.trend.rdbms` (5g.1) -- trend captures slope, stationarity captures whether residuals are mean-reverting vs random walk |
| 5g.4 | timeseries: timeseries.gap-analysis | partial | `data.timeseries.gap-analysis.rdbms` shipped (atomic; consecutive-delta inspection over a sorted timestamp sample). Computes median spacing as the inferred cadence, flags any delta > `gapRatio` × median (default ratio = 2) as a gap, returns top-10 gaps by ratio + a regularity score (fraction of deltas within ±50% of median). Verdict ladder: regular (>=0.9 in band) / mostly-regular (>=0.7) / has-gaps (>=0.5) / sparse (<0.5) / inconclusive (n<10 or median delta=0). Interpretation always surfaces gapCount even when overall cadence is 'regular' so isolated outages don't get hidden by a high score. End-to-end verified: synthetic hourly series (n=50) with 2 deliberate gaps (5h and 3h) -> cadence 1.0h, regularityScore=0.959, gapCount=2, verdict 'regular' with both gaps surfaced in topGaps. Pairs with the rest of 5g -- regression / autocorrelation / DF tests all assume regular sampling, so this skill is the canonical precondition |
| 6.1 | synthesis: synth.target-description | pending | needs an LLM call (narrative summary); not template-only |
| 6.2 | synthesis: synth.field-table | done | `data.synth.field-table` ships -- renders SchemaDescription as markdown table with header / summary / per-row [PK] / [FK] / [nullable] tags |
| 6.3 | synthesis: synth.drift-report | pending | needs Phase 4 drift skills first |
| 6.4 | synthesis: synth.er-diagram | pending | mermaid; multi-table input shape -- needs Phase 4.x or a new aggregation point |
| 6.5 | synthesis: synth.sample-table | done | `data.synth.sample-table` ships -- renders sample-rows as markdown table; long values truncate at 80 chars; nested JSON-stringified |
| 6.6 | synthesis: synth.lineage-fold | done | `data.synth.lineage-fold` ships -- groups call-sites by source-file path; classification badges + truncated snippets in fenced code blocks |
| 6.7 | synthesis: synth.profile-card | done | `data.synth.profile-card` ships -- branches on `kind` (numeric / categorical / boolean / temporal / text), pairs with profile.auto.rdbms's output |
| 6.8 | synthesis: synth.scorecard | done | `data.synth.scorecard` ships -- markdown report card with overall score badge / weights / PK candidates / top-issues table / per-column detail. Pairs with `data.quality.scorecard.rdbms`. Renders an extra `validity` column in the per-column table when the scorecard included a validity dimension (i.e. the caller supplied `validityPatterns`); falls back to the original 7-column layout otherwise |
| 6.9 | synthesis: synth.histogram-block | pending | needs the 5b.1 histogram skill first |
| 7.1 | meta: meta.classify-question | pending | which family answers this? |
| 7.2 | meta: meta.select-scope | pending | pick connections / tables / files |
| 7.3 | meta: meta.feasibility-check | pending | thin wrapper around assertFeasible |
| 7.4 | meta: meta.calibrate-confidence | pending | findings + tool-error trace -> final confidence |
| 8.1 | planner rewrite | pending | emits skill invocations, not DataAnalysisTask kinds |
| 8.2 | per-task runner rewrite | pending | composes skills via `invoke_skill` meta-tool |
| 8.3 | reviewer integration | pending | reviewer sees per-skill confidence, not just per-task |
| 9.1 | backward-compat shim | pending | legacy DataAnalysisTask kinds map onto skill invocations |
| 9.2 | per-skill caching layer | pending | extends existing per-task cache |
| 10.1 | telemetry + skill-trace pane | pending | workbench inspector |
| 10.2 | smoke fixtures per skill | pending | CI gate |

## Goals (short)

1. **Every claim in the report grounds in a typed skill output.** The
   answer-text and findings are stitched from `SkillResult.value`s; a finding
   that doesn't trace back to a skill is rejected by the synthesise pass.
2. **Statistical analysis is first-class.** Family 5 (quality / distribution
   / dependency) ships with driver-side aggregation (Phase 0) so the local
   LLM never invents numerical answers from row samples.
3. **Cross-analyzer reuse.** The test-agent, designer, pair (debug mode), and
   code-analyzer can each call data-analyzer skills via `runSkill` without
   touching the data-analyzer's runner internals.
4. **Backward-compatible cutover.** The legacy `data:*` cross-agent tool
   surface stays callable; internally it dispatches to the registered
   skills. A workspace that names `data_lineage` in a custom prompt keeps
   working.
5. **Bake in 2026-04-30 hallucinated-class lessons.** `class.extract-fields`
   declares `required-tools: ['code_locate', 'code_describe']`; its absence
   fails the precondition and clamps confidence to `low` instead of letting
   the model fabricate. `mapping.json-vs-class` is a composite that calls
   both `class.extract-fields` AND `file.sample-shape`, so a missing class
   side cannot be silently papered over with the JSON side.

## Non-goals (in this plan)

- **No replacement of the data-analyzer orchestrator.** The pipeline stages
  (`planning -> reviewing -> synthesising`) stay. Only the per-task runner's
  internals change.
- **No new data-driver families.** Skills consume the existing driver
  kinds shipped via [plans/data-driver.md](../data-driver.md) and
  [plans/data-driver-duckdb-files.md](../data-driver-duckdb-files.md)
  (12 file kinds + the RDBMS / KV roster). Adding new drivers is in
  those plans' scope.
- **No SQL-write capability.** Aggregation tools are read-only. The driver-
  side enforcement from data-driver stays the source of truth.
- **No real-time / continuous quality monitoring.** Skills run inside a
  `/data-analyze` invocation. Periodic background quality-scoring is a future
  plan.
- **No external statistical engine.** `db_sql_aggregate` uses native SQL
  aggregations; `db_file_aggregate` uses DuckDB. We do not embed numpy /
  scipy / pandas as a subprocess. Anything those would do beyond what
  DuckDB offers is out of scope until a concrete user need surfaces.
- **No user-overrideable skill prompts in v1.** The
  `~/.insrc/data-analyzer/<kind>.md` overrides shipped in
  [data-analyzer.md](./data-analyzer.md) Phase 1.3 stay file-by-file at
  the per-kind level. Per-skill prompt overrides are a follow-up.

## Phase 0 -- driver-tool substrate

This phase is **infrastructure only** -- no skills land here. It exists for
two reasons:

1. **Family 5 cannot land without aggregation tools.** Quality / distribution
   / dependency skills will hallucinate numbers if asked to compute them in
   the LLM; the only safe path is to push aggregation into the driver and
   let skills consume structured numerical results. Slices 0.1-0.6 below
   ship the **RDBMS aggregation** primitives. The **file-side aggregation**
   primitives (`db_file_aggregate`, `db_file_list_files`, the consolidated
   `db_file_describe` / `db_file_sample` / `db_file_sample_shape`,
   directory-as-table semantics) are **already shipped** via the
   prerequisite plan
   [data-driver-duckdb-files.md](../data-driver-duckdb-files.md). All 12
   file kinds (native + converted) flow through the same
   `DuckDBFileDriver`, so file-flavoured Family 5 skills consume one
   tool surface (`db_file_aggregate` / `db_file_sample` / etc.) with no
   per-kind branching. **Skills in subsequent phases can assume the
   file tool surface exists; this plan does not re-define it.**

2. **Phase 1 / 2 introspection skills depend on KV-side tool primitives
   that are not yet registered.** The existing `db_*` family covers SQL
   describe / sample, KV scan / get / sample-shape, and (via the
   consolidated DuckDB-backed file driver) the full file query surface
   -- but NOT keyspace / namespace enumeration on the KV side. Skills
   that need to "tell me what collections / namespaces exist on this
   connection" hard-fail on the `required-tools` precondition without
   these. Slices 0.7-0.8 below close that gap.

Slice 0.9 is a naming reconciliation, not new code: the plan refers to a
`doc` source family (Phase 1.4 / 2.4) but the data-driver classifies
MongoDB / Cassandra under `kv`. Either the driver grows a `doc` family
distinction (Mongo collections + Cassandra column-families have richer
structure than Redis-style flat KV) or the plan-side `doc` references all
collapse into `kv`. Decide before any 1.4 / 2.4 / 5e-vs-mongo skill lands.

### 0.1 `db_sql_aggregate`

Tool id: `db_sql_aggregate`. Inputs: `connectionId`, `target`, `aggregations`
(an array of `{column, function, args?}` entries). Functions:

```
count | count_non_null | distinct_count
sum | avg | stddev | variance | min | max
percentile (args.p)
```

Output: a flat numeric record keyed on `<column>__<function>`. One SQL
statement, server-side aggregation. Per-driver dialect handled by the
existing driver dispatch. Row cap doesn't apply (this is aggregate, not
sampled).

### 0.2 `db_sql_histogram`

Inputs: `connectionId`, `target`, `column`, `buckets` (default 20),
`mode` (`equal-width` | `equal-frequency`). Output: an array of
`{lower, upper, count}`. Per-driver via `width_bucket` (Postgres,
DuckDB) or `NTILE` for equal-frequency variants on dialects without
`width_bucket`. Documented per-dialect coverage matrix in the
implementation note.

### 0.3 `db_sql_distinct`

Inputs: `connectionId`, `target`, `column`, `topN` (default 20). Output:
`{distinctCount, topValues: Array<{value, count}>}`. The top-N is
ordered by frequency descending; ties broken by lexicographic order to
keep results deterministic across re-runs (cache-friendly).

### 0.4 `db_correlation_matrix`

Inputs: `connectionId`, `target`, `columns` (≤ 10), `method`
(`pearson` | `spearman`). Output: a symmetric matrix of pairwise
coefficients.

Coverage:

- **RDBMS connections**: native SQL via `corr()` (Postgres / DuckDB) or
  per-dialect computed expressions (`SUM((x-avg(x))*(y-avg(y))) / ...`)
  for dialects without a built-in.
- **File connections**: routed through the DuckDB-backed file driver's
  `aggregate()` path; DuckDB has `corr` natively.
- **KV / document connections (Cassandra, Mongo, Redis)**: precondition
  fails with `connection-family: ['rdbms', 'file']`. The skill returns
  `confidence: low` + a "correlation not supported on this connection
  family; pull a sample first if you want sample-based correlation"
  note. Earlier drafts of this slice claimed a "DuckDB-over-sample
  fallback" for non-SQL drivers; that's removed -- a sample-based
  correlation presented as if it were the full-table answer is the
  same correctness failure as letting the LLM compute it.

### 0.5 `db_outliers`

Inputs: `connectionId`, `target`, `column`, `method`
(`iqr` | `zscore`). Output: `{count, examples: Array<{rowKey?, value}>}`
(examples capped at 20). For drivers without window functions, the
tool returns `confidence: low` and a note about the missing
implementation -- the skill calling it is responsible for falling back
gracefully.

### 0.6 Sampling-confidence library

A shared helper module (`daemon/db/sampling-confidence.ts`) exposing:

```ts
export function sampleSizeFor(
  estimator: 'mean' | 'percentile-p' | 'normality' | 'correlation',
  populationN: number | null,
  desiredCI: number,
): number;

export function confidenceFor(
  actualN: number,
  estimator: ...,
  populationN: number | null,
): 'high' | 'medium' | 'low';
```

Skills in Family 5 use this to translate "I have 50 sampled values" + "I'm
running a Shapiro-Wilk normality test" into a confidence value the registry
can clamp on. **No skill implements its own sample-size threshold logic;
they all consult this library.**

### 0.7 `db_kv_list_namespaces`

Inputs: `connectionId`. Output: `Array<{name, kind, approxKeyCount?}>`.
Per-driver semantics:

```
Redis / Valkey / KeyDB / DragonflyDB   distinct prefixes from SCAN  (kind: 'prefix')
MongoDB                                 db.listCollections()          (kind: 'collection')
Cassandra                               keyspace + table list         (kind: 'table')
DynamoDB                                ListTables                    (kind: 'table')
etcd                                    distinct prefixes from KV     (kind: 'prefix')
```

The shape is unified so a skill can iterate "namespaces on this kv
connection" without per-driver branching. `approxKeyCount` is best-effort;
omit when the driver has no cheap count path. Required by Phase 1.2
(`source-introspection: kv -> list-namespaces`).

### 0.8 `db_kv_describe_namespace`

Inputs: `connectionId`, `namespace`. Output: a NamespaceShape document
that mirrors the existing `db_kv_sample_shape` envelope but adds
namespace-level metadata (key-prefix patterns, sub-document field
inventory for Mongo / Cassandra). Builds on `db_kv_sample_shape` -- the
new tool wraps it with namespace-scoping logic and consolidates the
shape view that `describe-namespace` skills need. Required by Phase 1.2
(`source-introspection: kv -> describe-namespace`).

### 0.9 doc-family naming reconciliation

No code lands for 0.9 -- it's the plan-level decision needed before any
of Phase 1.4 / 2.4 / doc-flavoured 5e (PII against Mongo) can land.

The data-driver in `daemon/db/drivers/` classifies MongoDB and Cassandra
under `family: 'kv'`. Mongo's documents and Cassandra's column-families
have richer structure than a flat Redis namespace; treating them all as
`kv` loses that distinction at the skill-precondition level
(`connection-family: ['kv']` is too broad).

Two paths:

- **A. Driver grows a `doc` family.** Mongo and Cassandra (and possibly
  DynamoDB single-table) move out of `kv`. Adds a SOURCE_FAMILY enum
  member; skills can declare `connection-family: ['doc']` to scope to
  document stores. Most expensive option; touches the data-driver type
  surface.
- **B. Plan-side `doc` collapses into `kv`.** Phase 1.4 / 2.4 / etc.
  rename to use `kv`; the doc-vs-kv distinction lives at the skill-id
  level (`data.kv.collection.list-fields` for Mongo-style;
  `data.kv.namespace.list-keys` for Redis-style). Cheapest, but skill
  consumers have to know which kv kind they're targeting.

Default for v1: **B**, because the data-driver is shipped and adding a
new family breaks existing connection registrations. Ship a per-skill
`required-driver-kind: ['mongodb', 'cassandra', ...]` precondition to
recover the discrimination Path A would have given for free.
(Implementation note: if `required-driver-kind` doesn't already exist as
a Precondition variant in skills-core, this slice adds it -- it's a
narrower restriction than `connection-family` and hasn't been needed
until now.)

## Phase 1 -- source-introspection skills (atomic)

Each skill is a thin typed wrapper over one introspection tool, plus
preconditions for the connection family. Example:

```ts
const rdbmsDescribeTable: Skill<...> = {
  id: 'data.source.rdbms.describe-table',
  family: 'source-introspection',
  owner: 'data-analyzer',
  version: 1,
  inputs: { /* { connectionId, target } */ },
  outputs: { /* SchemaDescription */ },
  toolDeps: ['db_sql_describe'],
  providerAffinity: 'auto',
  preconditions: [
    { kind: 'required-tools', tools: ['db_sql_describe'], reason: 'introspection' },
    { kind: 'connection-family', families: ['postgres', 'mysql', 'sqlite', 'mssql', ...],
      reason: 'SQL describe path' },
  ],
  execute: async (input, deps) => {
    const result = await deps.runTool({ name: 'db_sql_describe', input });
    if (result.isError) {
      return { value: null, confidence: 'low', notes: [result.content], toolCalls: [...] };
    }
    return { value: parseDescribe(result.content), confidence: 'high', toolCalls: [...] };
  },
};
```

Slices 1.1-1.4 ship one Skill per (driver-family, kind) combination. Total
skill count ~12. All atomic. Confidence is `high` on success, `low` on
tool error.

## Phase 2 -- source-sampling skills (atomic)

Same pattern as Phase 1 but for the sampling tools. Confidence calibration
adds a sample-size factor: `low` if the requested limit was clamped down by
the driver to a value below the precondition's `min-sample-size`. Total
skill count ~8.

## Phase 3 -- code-binding skills (cross-owner atomic)

The hallucinated-class incident's primary fix.

### 3.1 `data.code.class.extract-fields`

Owner: `data-analyzer`. `cross-owner-allowed: true`. Calls
`code.class.extract-fields` (registered by code-analyzer) via `runSkill`
under the cross-owner depth cap. Inputs: `className` + optional
`repoPath` scope. Outputs: typed field list `{name, type, nullable,
defaultValue?}`. Without code-analyzer registered (or with code-analyzer's
family-gate disabled), the skill fails the `required-tools: ['code_locate',
'code_describe']` precondition and returns `confidence: 'low'` with a
"code-analyzer unavailable" note. **No fabrication path.**

### 3.2-3.5

Each is the same shape: cross-owner atomic skill, narrow tool deps, hard
fail on precondition miss. Implementations live mostly inside the code-
analyzer; this plan ships only the data-analyzer-side typed wrappers and
their preconditions. The code-analyzer-side skills are tracked as a
prerequisite work item in [code-analyzer.md](./code-analyzer.md).

## Phase 4 -- comparison / diff skills (composite)

Composite skills that orchestrate atomics. Sub-skill failure floors the
composite's confidence (per the registry contract in skills-core 4.3).

### Example: `data.mapping.json-vs-class`

```ts
{
  id: 'data.mapping.json-vs-class',
  family: 'comparison-diff',
  owner: 'data-analyzer',
  skillDeps: [
    'data.code.class.extract-fields',
    'data.source.file.sample-shape',
  ],
  preconditions: [
    { kind: 'cross-owner-allowed', reason: 'consumes code-analyzer' },
    { kind: 'required-tools', tools: ['code_describe', 'db_file_sample_shape'], ... },
  ],
  execute: async (input, deps) => {
    const klass = await deps.runSkill('data.code.class.extract-fields', { className: input.className });
    const shape = await deps.runSkill('data.source.file.sample-shape', { connectionId, path });
    if (klass.confidence === 'low' || shape.confidence === 'low') {
      // Floor to low; surface BOTH sides' notes; never paper over a missing side.
      return {
        value: { klass: klass.value, shape: shape.value, diff: null },
        confidence: 'low',
        notes: [...klass.notes ?? [], ...shape.notes ?? []],
        toolCalls: [...klass.toolCalls, ...shape.toolCalls],
      };
    }
    const diff = computeFieldDiff(klass.value, shape.value);
    return { value: { klass: klass.value, shape: shape.value, diff }, confidence: 'high', ... };
  },
}
```

The hallucinated "perfect alignment" finding from 2026-04-30 is
mechanically impossible under this composite: no class side, no diff;
diff is `null` and confidence is `low`.

Slices 4.1-4.7 each follow the composite pattern. Total skill count ~7.

## Phase 5 -- quality / statistical skills

Largest phase. Sub-divided per the seven sub-families introduced in the
discussion thread that preceded this plan.

**File vs RDBMS dispatch.** Tool names below (`db_sql_aggregate` /
`db_sql_histogram` / `db_outliers` / `db_correlation_matrix`) are the
RDBMS-side primitives. For file connections, every numerical skill
routes through `db_file_aggregate` instead, which sits on the
consolidated DuckDB-backed driver and exposes the same function set
(count / sum / avg / stddev / variance / min / max / percentile /
distinct_count / `corr` for the correlation skill, plus
`approx_count_distinct` and the rest of DuckDB's analytical surface).
Histogram / outliers / distinct skills compose `db_file_aggregate`
queries (percentile bucketing, IQR / Z-score, GROUP BY top-N) without
needing a separate `db_file_histogram` tool. Skill bodies branch on
`connection.family` once at the top and pick the right tool; the rest
of the logic is shared. Sub-families:

- **5a univariate profiling** (6 skills) -- atomic, each backed by
  `db_sql_aggregate` + `db_sql_distinct` (RDBMS) or `db_file_aggregate`
  (file). `profile.auto` is the only composite in 5a; it picks the
  right profile skill from the declared type.
- **5b distribution shape** (7 skills) -- atomic, each backed by
  `db_sql_aggregate` / `db_sql_histogram` / `db_outliers` for RDBMS,
  `db_file_aggregate` for file (histogram via percentile bucketing,
  outliers via IQR / Z-score expressions). Heavy on `min-sample-size`
  preconditions: e.g. `distribution.normality-test` declares
  `n >= 50`, `distribution.heavy-tail-check` declares `n >= 200`.
- **5c cross-column** (5 skills) -- atomic, backed by
  `db_correlation_matrix` (RDBMS path) and per-skill SQL queries
  (functional dependency detection is one query; co-null patterns is
  another). For file connections, correlation runs through
  `db_file_aggregate` since DuckDB has `corr` natively. The join-key
  cardinality skill needs paired sampling across two tables.
- **5d quality scorecard** (6 skills) -- 5 atomics + the `quality.scorecard`
  composite. Atomic skills run cheap aggregations against either
  driver family via the matching `db_*_aggregate` tool; the scorecard
  composes them into a single typed rollup with weights per dimension
  (the rubric is hard-coded; per-repo override is a follow-up).
- **5e PII / sensitivity** (3 skills) -- `pii.detect-patterns` is atomic
  (regex over sampled values); `pii.column-classifier` composes 5e.1 with
  column-name heuristics; `sensitivity.policy-check` reads the connection's
  pii config and compares against detected patterns.
- **5f drift / anomalies** (3 skills) -- composite. Each requires two
  windows of input data; `drift.distribution` calls
  `db_sql_aggregate` twice with `where`-clauses splitting the windows.
- **5g time-series** (4 skills) -- atomic. Each requires a temporal
  column declaration in input; precondition asserts the column is
  temporal-typed.

**Confidence calibration** in this phase is unusually strict: any sample-
based computation declares its `min-sample-size` precondition; the registry
clamps confidence to `low` when the actual sample falls below. Skills that
push aggregation to the driver (the common case in 5a-5d) skip the clamp.

**No statistical computation in the LLM.** The skill body's `execute()`
pulls aggregated numbers from tools and packages them into the typed
output. The LLM call (when one exists -- mostly in 5d's scorecard
composition) is for narrative, not arithmetic.

## Phase 6 -- synthesis skills

Each renderer takes one typed `SkillResult.value` shape and produces a
markdown fragment. They have **no LLM call** -- they're deterministic
templates. The data-analyzer orchestrator's existing `synthesise` step
(which does have LLM calls) consumes these fragments inside its multi-pass
content-gen pipeline; the skills are the substrate for finding-typed
rendering.

The per-skill-output schema makes this possible: a `synth.profile-card`
skill knows how to render a `profile.numeric` output because it imports
the same JsonSchema that defines that output. Slices 6.1-6.9 ship one
renderer per major output shape. Total skill count 9.

## Phase 7 -- meta skills

### 7.1 `meta.classify-question`

LLM-routed (cloud affinity). Input: the user's question + the available
connection roster. Output: a list of skill ids the planner should invoke,
ordered by priority. This is the skill the planner-rewrite (8.1) calls
first; its output is the skeleton of the per-task plan.

### 7.2 `meta.select-scope`

LLM-routed (cloud affinity). Input: the user's question. Output: a list
of `{connectionId, target?}` scoping the rest of the run. Preconditions:
`required-tools: ['db_list_connections']`. The current orchestrator's
`_registerEphemeralFromPrompt` plus `_loadConnections` lift moves into
this skill.

### 7.3 `meta.feasibility-check`

Pure helper -- no LLM, no tool calls. Walks `assertFeasible(skillId, ctx)`
for every skill in a candidate list and returns a structured rejection
report. The planner uses this AFTER `meta.classify-question` to drop
infeasible skill ids from the plan before any execution starts.

### 7.4 `meta.calibrate-confidence`

Per-task post-processing. Input: a list of `SkillResult` values + the
question + the tool-error trace. Output: a calibrated final confidence
for the task's answer. Atomic, deterministic. The reviewer (cloud-side
LLM) consumes the calibrated value as a hard prior, mitigating the over-
acceptance failure mode the 2026-05-01 fixes addressed at the prompt
level.

## Phase 8 -- planner / runner / reviewer rewrite

The orchestrator stays. Its three LLM tasks (`plan`, `analyzer-per-task`,
`review`) gain a skill-shaped contract.

### 8.1 Planner

The planner's prompt today decomposes a question into a `DataAnalysisTask[]`.
Post-rewrite, it produces a list of `SkillInvocation`s:

```ts
interface SkillInvocation {
  skillId: string;
  args: Record<string, unknown>;
  why: string;          // for the user-facing TodoItem title
  parentItemId?: string; // for drill-down chains, unchanged
}
```

The plan stays human-readable in the TodoList; the orchestrator now knows
how to run each item without a per-kind playbook.

### 8.2 Per-task runner

Replaces the inline 8-call tool loop. The new runner:

1. Validates the invocation against the registered skill's input schema.
2. Calls `runSkill(invocation.skillId, invocation.args, deps)`.
3. Streams the resulting `toolCalls` as `liveStep` events (the same
   transcript-style pattern shipped in F13).
4. Returns the `SkillResult` to the orchestrator's `K_LAST_RESULT` slot.

The existing JSON parse retry / citations invariant retry / runner-side
confidence downgrade all move into the registry's `runSkill` machinery
(skills-core 3.1 / 3.7) -- they apply to every skill, not just data-
analyzer skills.

### 8.3 Reviewer integration

The reviewer LLM now receives `SkillResult` shapes instead of free-form
analyzer results. The decision rules in
[review.ts](../../src/insrc/agent/tasks/data-analyzer/prompts/review.ts) (which
got hardened 2026-05-01) carry over almost verbatim; the only change is
that the toolCalls list is per-skill, and the answer is a typed value
rather than a free-form string. The hallucination guardrails added
2026-05-01 stay -- they work on the same `toolCalls` summary the registry
exposes.

## Phase 9 -- backward compatibility

### 9.1 Legacy `DataAnalysisTask` shim

The orchestrator's `K_PLAN_TASKS` storage retains its `DataAnalysisTask[]`
shape for one daemon release. A migration helper maps each legacy `kind`
to a default skill invocation:

```
inspect-schema -> data.source.rdbms.describe-table | kv | file (per scope)
sample-data    -> data.source.<family>.sample-rows
sample-shape   -> data.source.<family>.sample-shape
lineage        -> data.code.lineage.read-write-callsites
schema-drift   -> data.comparison.drift.prisma-vs-live
er             -> [composite -- multiple describe-table + artifact_er rendering]
free-form      -> data.meta.classify-question + per-result skills
```

This shim lets pre-skill-cutover cached plans (per-task cache from
[data-analyzer.md](./data-analyzer.md) Phase 2.4) keep replaying through
the new runner. After one release, the legacy shape is removed and the
cache directory is invalidated by a versioned cache-key bump.

### 9.2 Legacy `data:*` cross-agent tools

`data_lineage` / `data_schema-drift` / `data_describe` / etc. stay
registered. Their bodies become one-line dispatches to the corresponding
skill (skills-core Phase 9 already shipped this pattern for `data_lineage`).
A custom user prompt that names `data_schema-drift` keeps working.

## Phase 10 -- caching + telemetry

### 10.1 Telemetry / skill-trace

Every `runSkill` invocation emits a `SkillEvent` (skills-core Phase 7).
The data-analyzer orchestrator already streams `liveStep` for LLM tasks;
this phase adds a parallel `skill-trace` stream rendered in a new
sub-pane of the analyzer report (or behind a "Show skill trace" toggle
on the existing pane). Inspector-style; not in the user's primary path.

### 10.2 Per-skill cache layer

Extends the existing per-task cache from
[data-analyzer.md](./data-analyzer.md) Phase 2.4 down to skill granularity.
Cache key: `(skill.id, skill.version, hashCanonical(input), connection-roster-fingerprint)`.
On hit, skip the skill's `execute()` entirely; the orchestrator stamps the
cached `SkillResult` into the task's accepted bucket. Same LRU + atomic-
write disk layout as the per-task cache, separate directory:
`~/.insrc/cache/skills/`.

This cache is **strictly orthogonal** to the per-task cache: a re-run hits
the per-task cache first (cheap), and only when the per-task entry is
invalidated (different connection roster, different question, no entry)
does the per-skill cache become relevant. The cost of the per-skill cache
is its complexity around invalidation; we'd skip it entirely if not for
the high cost of repeating Family 5 statistical computations on the same
target.

## Open cleanup work

This section tracks the "partial → done" work that doesn't need new
skills, just port / refactor / fold-in work on what's already shipped.
Three tracks; pick by appetite. Cross-references
[plans/data-driver-duckdb-files.md](../data-driver-duckdb-files.md)
since the consolidated DuckDB file driver unblocks most of Track A.

### Track A -- file-side ports of the analytical families (~22 skills)

Every analytical skill family currently has only its `*.rdbms` variant.
The corresponding `*.file` variant is mechanical to add now that the
consolidated DuckDB-backed file driver covers all 12 file kinds (per
data-driver-duckdb-files.md, Phase 1 + 2 + 3 + 4 are all done). Same
DuckDB SQL surface, same `SampleResult` / `AggregateResult` shapes
(both halves go through `formatSample` / `formatAggregateResult` in
`daemon/tools/builtins/db/index.ts`) -- the math is identical.

**Refactor strategy: extract shared math, dispatch from both wrappers.**

Per family, the algorithm becomes a pure function over already-fetched
rows + columns + aggregates:

```
src/insrc/daemon/skills/built-ins/
  data.X.algo.ts    # pure-JS math + verdict ladder, NO tool deps
  data.X.rdbms.ts   # wrapper: db_sql_*  tools + RDBMS_FAMILY_TAGS + algo()
  data.X.file.ts    # wrapper: db_file_* tools + FILE_FAMILY_TAGS  + algo()
```

Both wrappers ship together so the math has one source of truth.
Existing `*.rdbms` skills get refactored to delegate; new `*.file`
skills are ~80-line parallel wrappers.

**Wrapper differences (both wrappers handle the same algo input):**

|  | `.rdbms` | `.file` |
|---|---|---|
| Tool ids | `db_sql_describe`, `db_sql_sample`, `db_sql_aggregate`, `db_sql_distinct` | `db_file_describe`, `db_file_sample`, `db_file_aggregate`, `db_file_distinct` |
| `target` field | required | optional (inferred from `connection.path`) |
| Field name on `aggregate` / `distinct` calls | `target` | **`path`** (xlsx sheet selector; ignored elsewhere) |
| `connection-family` precondition | `RDBMS_FAMILY_TAGS` | `['file', 'csv', 'tsv', 'jsonl', 'ndjson', 'json', 'parquet', 'arrow', 'feather', 'avro', 'bson', 'fixed-width', 'xlsx']` |
| `providerAffinity` | unchanged from `.rdbms` |
| Output schema | identical |
| Smoke fixture | parallel structure with file driver shape |

**Skills to port (~22):**

- 5a (5): profile.numeric / .categorical / .temporal / .text / .boolean
- 5b (6): outliers-iqr / -zscore / -mad / normality-test / heavy-tail-check / modes
- 5c (3 plausible): correlation.numeric-pairwise / .categorical-pairwise / dependency.co-null-pattern. (5c.3 dependency.functional + 5c.5 cardinality.join-key are RDBMS-shaped multi-table queries; defer until file-side cross-table needs surface.)
- 5d (5): completeness / uniqueness / validity / conformity / consistency. 5d.6 scorecard composite ports automatically once its 5 dimension atomics do.
- 5e (1): pii.detect-patterns
- 5f (2 plausible): drift.distribution / drift.volume (5f.3 anomaly.change-point assumes a temporal axis -- file analog plausible but lower priority)
- 5g (0): timeseries skills assume an indexed temporal column on the source; file connections rarely fit that shape -- defer

Synth renderers (6.x) are RDBMS / file-agnostic; no port needed.

### Track B -- scorecard composite extension (1 skill + 1 renderer) ✅ done

Shipped. Conformity (5d.4) and consistency (5d.5) now fold into the
5d.6 quality.scorecard composite via opt-in `conformityRules` /
`consistencyRules` inputs (mirrors the existing `validityPatterns`
shape). Weight profile picks one of four tables based on which
dimensions are on; missing per-column dimensions still get
renormalized weights so opt-in absence isn't punitive. Consistency
reports as a separate top-level `consistency` block (cross-column by
nature); broken consistency rules now surface in the top-issues
list alongside per-column problems. `synth.scorecard` (6.8)
extended with a conditional conformity column + a new "Cross-column
consistency" section.

Track A is now complete -- 5d.6 file variant shipped (`data.quality.scorecard.file`)
along with the rest of the 5d / 5e / 5f file ports.

### Track C -- skill swaps consuming the new Phase 0 tools (now landed)

Phase 0 is fully shipped, plus the `0.1.x` aggregate extensions
(skewness / kurtosis / mad / count_where / composite_distinct_count
+ type-aware values for temporal min/max). Track C swaps are now
complete except for the explicitly-deferred items called out below.

| Skill | Consumes | State |
|---|---|---|
| 5a.3 profile.temporal -- min/max range, period inference | 0.1.x type-aware values | done. Output now includes `minValue` / `maxValue` (ISO strings) + `rangeSpanMs` / `rangeSpanDays`. |
| 5b.2 distribution.outliers-iqr | 0.5 `db_sql_outliers` (method=iqr) | done. Opt-in `mode: 'full-table'` delegates to the tool; result populates `fullTableBelowCount` / `fullTableAboveCount` / `fullTableOutlierCount` / `fullTableOutlierRate` + `source: 'full-table'`. Default mode unchanged for back-compat. |
| 5b.3 distribution.outliers-zscore | 0.5 `db_sql_outliers` (method=zscore) | done. Same shape as 5b.2. |
| 5b.4 distribution.outliers-mad | 0.1.x `mad` aggregate | done. Reads server-side `mad()` when supported (DuckDB native); falls back to sample-based MAD otherwise. `madSource` reports `'server' \| 'sample' \| 'unknown'`. |
| 5b.5 distribution.normality-test | 0.1.x `skewness` + `kurtosis` aggregates | done. Reads server-side moments when supported (DuckDB native); `momentSource` reports `'server' \| 'sample' \| 'unknown'`. |
| 5b.6 distribution.heavy-tail-check | 0.1.x `kurtosis` aggregate | done. Same shape as 5b.5 (server vs sample); interpretation tagged "(full-table)" when server. |
| 5b.7 distribution.modes | 0.2 `db_sql_histogram` | done. Opt-in `mode: 'full-table'` delegates to the histogram tool; smoothing + peak-detection runs on the precise bins. |
| 5c.1 correlation.numeric-pairwise | 0.4 `db_correlation_matrix` | done. Opt-in `mode: 'full-table'` issues two correlation_matrix calls (Pearson + Spearman) and reshapes the result into the existing PairResult[]. Capped at 10 columns in matrix mode (the tool's limit). |
| 5c.4 dependency.co-null-pattern | 0.1.x `count_where` | done. Opt-in `mode: 'full-table'` issues 4 count_where aggregates per pair, batched 8 pairs per call to fit the 32-spec budget. Output adds `source` + `totalRows`. |
| 5d.1 / 5d.2 quality.uniqueness | 0.1.x `composite_distinct_count` | done. New optional `compositePkCandidates: string[][]` input + `compositePkCandidates` output field; each candidate runs one composite_distinct_count aggregate. |
| 5d.5 quality.consistency | 0.1.x `count_where` + WhereClause column-to-column comparisons | done. Opt-in `mode: 'full-table'` issues per-rule count_where aggregates; comparison rules use `valueColumn` for `left op right` predicates, null-pattern rules use null-flag combinations. |
| 5e.1 pii.detect-patterns -- KV variant | 0.7 `db_kv_list_namespaces` + `db_kv_scan` + `db_kv_get` | done. New `data.pii.detect-patterns.kv` skill. Lists namespaces (or takes a specific one), scans values, walks nested document leaves, regex-matches against the same PII catalog as the rdbms / file variants. |
| 5c.3 dependency.functional -- full-table FD | needs grouped distinct-count | **deferred**. Requires `count_distinct(b) GROUP BY a` -- not currently expressible via `compileAggregate`'s flat-per-column shape. Tracked as a future 0.1.x extension. |
| 5d.3 quality.validity -- full-table regex match-rate | needs per-dialect `regex_like` SQL | **deferred**. WhereClause was extended with `like` / `not like` (LIKE-pattern shape), but the full-richness regex the skill accepts can't be approximated by LIKE. A `regex_like` SQL function differs across dialects (`~` Postgres, `REGEXP` MySQL/SQLite, `LIKE_REGEX` MSSQL/Oracle) -- ship as a new compileWhere op when a caller actually needs it. |

### Tool-surface inconsistencies surfaced during this review

Documented for later Phase 0 cleanup. None block Track A by themselves,
but ignoring them costs duplicate per-skill workarounds:

1. **`target` vs `path` field name across file tools.**
   `db_file_describe` and `db_file_sample` use `target`;
   `db_file_aggregate` and `db_file_distinct` use `path`. Same
   conceptual field (xlsx sheet selector for those kinds, ignored
   elsewhere). Skills wrapping these have to remember which is which.
   Recommend renaming to `target` everywhere; the breaking change is
   small and one-shot.

2. ~~**No `where` on `db_sql_aggregate` / `db_file_aggregate`.**~~
   **Fixed.** Both tools now accept `where: WHERE_SCHEMA`;
   `AggregateRequest.where` plumbs through `compileAggregate`
   (RDBMS dialects via the existing `compileWhere` helper) and through
   the `DuckDBFileDriver.aggregate()` SQL builder for file kinds.
   `db_sql_distinct` / `db_file_distinct` still lack `where`; add
   when a categorical-windowed skill needs it. (5f.2 drift.volume
   now works correctly.)

3. **Per-call `recursive` override on `db_file_*` tools.** Per
   data-driver-duckdb-files.md §4.2, the connection-level flag works
   but the per-call override the prose proposed isn't wired. Skills
   that want to scope a query to a subset of a directory connection
   currently must reconfigure the connection. Cheap to add when a
   skill needs it.

4. **WHERE op enum is narrow** (`= / != / in / is null`). Time-window
   filters (`>= / <= / between`) need an extension to the
   `WHERE_SCHEMA` enum + per-driver `compileWhere` plumbing. Affects
   any skill that wants to express time-bounded queries via the
   structured-WHERE surface (5f.2 drift.volume in particular).

5. ~~**5f.2 drift.volume bug.**~~ **Fixed.** Took option (a) from
   the original analysis: extended `db_sql_aggregate` and
   `db_file_aggregate` to accept `where: WHERE_SCHEMA`, plumbed
   through `compileAggregate` for RDBMS drivers + the
   `DuckDBFileDriver.aggregate()` for file kinds. Also hardened the
   smoke gate so `runSkillIsolated` validates each tool-call input
   against the registered tool's actual `inputSchema` (looks up the
   real tool definition via the registry; ignores placeholders).
   Verified with a dedicated harness regression test that
   intentionally passes a phantom field and asserts the gate
   surfaces a schema-rejection note. Future tool-input mismatches
   in any skill are now caught at the smoke gate.

6. **`db_file_aggregate` / `db_file_distinct` `path` semantics.**
   Plan documents this as "xlsx sheet name" but the field is generic
   on the schema. For non-xlsx file kinds the field is ignored
   entirely. File-side wrappers should pass `undefined` when the
   connection isn't xlsx; only set when the caller explicitly
   targeted a sheet.

### Recommended order of operations

1. ~~**Fix 5f.2 bug first.**~~ Done. Tool-extension path (option a)
   shipped + smoke-gate input-validation hardening shipped.
2. ~~**Track B (scorecard)**~~ Done. Conformity + consistency folded
   into 5d.6; synth.scorecard (6.8) renderer extended; 2 dedicated
   composite tests + smoke gate green.
3. **Track A starting with 5a profilers** -- extract algo helpers,
   refactor existing `.rdbms` skills, ship new `.file` skills together.
   Sets the pattern for the rest of Track A.
4. **Track A continuation** -- 5b → 5c → 5d → 5e → 5f, family by
   family, applying the established pattern.
5. **Track C** -- defer; lands when Phase 0 tooling work happens.
6. **Tool-surface cleanups (#1, #3, #4 above)** -- batch into a single
   Phase 0 tool refresh PR after Track A proves out the file-port
   pattern; the rename in #1 is most easily done across all callers
   simultaneously.

## LLM routing -- per-skill provider affinity

| Skill family | Affinity | Why |
|---|---|---|
| source-introspection (1) | `auto` | thin tool wrapper; the calling agent picks |
| source-sampling (2) | `auto` | thin tool wrapper |
| code-binding (3) | `auto` | dispatches to code-analyzer; depth-cap handles the rest |
| comparison-diff (4) | `auto` | composite; calling agent picks; some need cloud for narrative |
| 5a univariate profile | `local` | post-processing; deterministic; cost-driven |
| 5b distribution | `local` | post-processing; deterministic |
| 5c dependency | `local` | post-processing; deterministic |
| 5d quality scorecard | `cloud` | composite needing narrative ranking |
| 5e PII | `local` | regex + heuristics; deterministic |
| 5f drift | `cloud` | composite needing narrative explanation |
| 5g timeseries | `local` | numerical |
| synthesis (6) | n/a | no LLM call |
| meta (7) | `cloud` | classifier + scope picker; judgment-heavy |

This routing is the per-skill realisation of the routing table in
[data-analyzer.md](./data-analyzer.md)'s "LLM routing" section. The agent-
level resolver in [agent/router.ts](../../src/insrc/agent/router.ts) overrides any of these
when the user `@mentions` a provider; per-step-binding overrides apply
identically.

## Open questions

1. **Should skill-level caching invalidate on connection schema drift?**
   The per-task cache uses a connection-roster fingerprint that catches
   roster changes but not live schema changes (driver-fingerprint helper
   is deferred per [data-analyzer.md](./data-analyzer.md) Phase 2.4
   notes). Per-skill cache inherits the same blind spot. **Default for
   v1: same as per-task -- explicit `clearCache` is the user's escape
   hatch. Land the proper fingerprint helper as a follow-up shared
   between both caches.**

2. **How does Phase 5g (time-series) handle non-temporal connections?**
   Time-series skills declare a precondition that the target has a
   `timestamp`-typed column; the precondition fails on KV connections
   without a configured time field. **Default: `confidence: 'low'` plus
   a "no temporal column" note. Connection-level configuration of "this
   key is the timestamp" is a follow-up plan tied to the data-driver.**

3. **Should `quality.scorecard` weights be repo-overridable?** Today
   the scorecard rubric is hard-coded (e.g. completeness=30%, validity=25%,
   uniqueness=20%, ...). **Default: hard-coded for v1; ship per-repo
   override as `~/.insrc/data-analyzer/scorecard.json` once a real user
   has a non-default rubric in mind.**

4. **Should the planner skip Phase 7's `meta.classify-question` for
   simple slash-direct invocations like `/data-profile <connection>
   <table>`?** A direct-skill invocation route (`/data <skill> ...`) is
   tempting -- bypasses planner entirely -- but ships a parallel UX that
   needs its own help / autocomplete / error surface. **Default: not in
   this plan; revisit if power users ask.**

## Lessons baked in from prior incidents

1. **No fabrication of code-side facts.** `class.extract-fields` and
   `mapping.json-vs-class` hard-fail without code-binding tools. The
   2026-04-30 hallucinated 28-row INPurchaseOrder field table is
   structurally impossible.
2. **No statistical computation in the LLM.** Phase 0 is a hard
   prerequisite; quality skills consume tool output, never compute means
   from row samples.
3. **Default-enabled list / registry agreement.** Mirrors the
   skills-core 2.4 fix for the cross-agent tool oversight. Every family
   declared in [skills-core.md](./skills-core.md)'s validator is in
   `enabledSkillFamilies` defaults; CI gate.
4. **Confidence floors enforced server-side.** A skill that claims
   `high` confidence with one tool error in its trace is clamped down by
   the registry. The skill body cannot lie its way past this. Mirrors
   the runner-side downgrade lever from 2026-05-01.
5. **Tool-error gate inheritance.** Skills calling tools that error
   inherit the tool-error gate the data-analyzer runner shipped
   2026-05-01. The skill body's `deps.runTool` calls are the same
   dispatch path; user gets the same Continue / Abort prompt; abort
   propagates as `confidence: 'low'` plus a `notes` entry up through
   composite skills.
