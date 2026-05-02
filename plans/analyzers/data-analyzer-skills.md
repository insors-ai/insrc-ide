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

Phase 0 partially landed: 0.1 (`db_sql_aggregate` + `aggregate()` on
RDBMS drivers and the consolidated DuckDB-backed file driver), 0.3
(`db_sql_distinct` + `db_file_distinct` + `distinct()` on every
RDBMS driver and the file driver), and 0.6 (sampling-confidence
library) are done; 0.2 / 0.4 / 0.5 deferred until the first
Family-5 skill needs them; 0.7-0.9 (KV substrate + naming
reconciliation) remain. The data-driver-duckdb-files
prerequisite is **fully shipped** -- every file kind already routes
through the consolidated DuckDB-backed driver with `db_file_*` tools
in place. Phase 1.1 (`data.source.rdbms.describe-table`), Phase 1.3
(`data.source.file.describe`), Phase 2.1 (both
`data.source.rdbms.sample-rows` and `data.source.rdbms.sample-distinct`),
Phase 2.2 (all three KV sampling skills:
`data.source.kv.scan-keys` / `get-value` / `sample-shape`), and
Phase 2.3 (`data.source.file.sample-rows`,
`data.source.file.sample-shape`) are landed. Phase 5a (univariate
profilers) is partially landed: `profile.numeric.rdbms`,
`profile.categorical.rdbms`, and `profile.boolean.rdbms` shipped;
temporal / text / auto / file-side variants are follow-ups.
Phase 5d (quality scorecard) atomic dimensions are also partially
landed: `quality.completeness.rdbms` (per-column null rate + table
overall) and `quality.uniqueness.rdbms` (per-column distinct ratio
+ single-column PK candidates) shipped. The remaining 5d atomics
(validity, conformity, consistency) and the `quality.scorecard`
composite are pending. Phase 5e starts:
`data.pii.detect-patterns.rdbms` ships -- regex over sampled values
for the 10 most common PII / credentials shapes. Phase 1.2
(source-introspection: kv) is blocked on 0.7 / 0.8 (the
`db_kv_list_namespaces` / `db_kv_describe_namespace` tools);
Phase 1.4 / 2.4 (doc family) blocked on 0.9 naming
reconciliation -- though plan default is to collapse `doc` into
`kv`, which the Phase 2.2 KV sampling skills already cover for
mongo / cassandra. Slice 3.4 has a partial wrapper from
skills-core 9. Skill core (skills-core.md) is fully shipped.

| Phase | Slice | State | Notes |
|---|---|---|---|
| 0.1 | `db_sql_aggregate` tool | done | `daemon/tools/builtins/db/index.ts` + `compileAggregate(Exprs)` in `rdbms-common.ts` + `aggregate()` on `RdbmsDriver` (postgres / mysql / sqlite / mssql / oracle real impls; clickhouse throws for now) and on the new `DuckDBFileDriver`. 35 + 8 tests |
| 0.2 | `db_sql_histogram` tool | pending | needs `histogram(target, opts)` driver method per dialect (`width_bucket` Postgres / DuckDB; `NTILE` fallback for SQLite / MySQL). Deferred until first Family-5 distribution skill needs it -- avoids speculative cross-dialect work |
| 0.3 | `db_sql_distinct` tool | done | `daemon/tools/builtins/db/index.ts` + `compileDistinct` in `rdbms-common.ts` + `distinct()` on `RdbmsDriver` (postgres / mysql / sqlite / mssql / oracle real impls; clickhouse throws for now -- pairs with the aggregate() follow-up) and on the consolidated `DuckDBFileDriver`. Sister tool `db_file_distinct` ships in the same change. Deterministic order (count desc, value asc); topN clamped [1, 1000] |
| 0.4 | `db_correlation_matrix` tool | pending | needs `correlationMatrix(target, opts)` driver method. RDBMS via per-dialect `corr(c1, c2)` (Postgres / DuckDB native; computed expression elsewhere); file connections route through the consolidated DuckDB-backed driver's `aggregate()` path which has `corr` natively. KV / doc connections refuse via precondition. Deferred |
| 0.5 | `db_outliers` tool | pending | composite over existing aggregate primitives (percentile for IQR; avg + stddev for Z-score) plus a new sample-with-comparison helper (`>=` / `<=` ops on WhereClause). Works for both RDBMS and file (file path goes through `db_file_aggregate`). Deferred |
| 0.6 | sampling-confidence library | done | `daemon/db/sampling-confidence.ts` -- `sampleSizeFor` + `confidenceFor` for mean / percentile / normality / correlation estimators; finite-population correction; 11-test suite |
| 0.7 | `db_kv_list_namespaces` tool | pending | enumerate top-level keyspaces / Mongo collections / Cassandra column-families. Required by 1.2 |
| 0.8 | `db_kv_describe_namespace` tool | pending | shape + key-prefix layout of one namespace. Required by 1.2 |
| 0.9 | doc-family naming reconciliation | pending | driver today classifies MongoDB / Cassandra as `kv`; plan mentions a `doc` family. Decide: extend driver with `doc` family, or rename plan-side `doc` → `kv` and update Phase 1.4 / 2.4. Affects every doc-flavoured skill |
| 1.1 | source-introspection: rdbms | partial | `data.source.rdbms.describe-table` shipped (`daemon/skills/built-ins/data.source.rdbms.describe-table.ts`), thin wrapper over `db_sql_describe`. `list-tables` and `list-indexes` skills still pending -- their underlying tools (`db_sql_list_tables`, `db_sql_list_indexes`) don't exist yet; will land alongside those tools |
| 1.2 | source-introspection: kv | pending | list-namespaces, describe-namespace |
| 1.3 | source-introspection: file | done | `data.source.file.describe` shipped (`daemon/skills/built-ins/data.source.file.describe.ts`). One skill covers all 12 file kinds via `connection-family: ['file', csv / tsv / jsonl / ndjson / json / parquet / arrow / feather / avro / bson / fixed-width / xlsx]` precondition. Thin wrapper over `db_file_describe`; the underlying DuckDB-backed driver dispatches to native readers or staged-Parquet readers transparently. xlsx target selects a sheet |
| 1.4 | source-introspection: doc | pending | describe-collection, list-collections |
| 2.1 | source-sampling: rdbms | done | Both atomic skills shipped: `data.source.rdbms.sample-rows` (over `db_sql_sample`, structured WHERE support) and `data.source.rdbms.sample-distinct` (over `db_sql_distinct`, top-N + distinct cardinality, deterministic order) |
| 2.2 | source-sampling: kv | done | All three skills shipped: `data.source.kv.scan-keys` (over `db_kv_scan`), `data.source.kv.get-value` (over `db_kv_get`), `data.source.kv.sample-shape` (over `db_kv_sample_shape`). Covers redis / valkey / keydb / mongodb / cassandra / nats / dynamodb / etcd / memcached |
| 2.3 | source-sampling: file | done | `data.source.file.sample-rows` and `data.source.file.sample-shape` shipped. Both are thin wrappers (`db_file_sample` / `db_file_sample_shape`) covering all 12 file kinds via the consolidated DuckDB-backed driver. xlsx target selects a sheet; directory connections glob / walk-and-convert transparently. WHERE clause supported on sample-rows; sample-shape pulls a sample then runs `inferShape` for nested types (json / jsonl / ndjson) |
| 2.4 | source-sampling: doc | pending | sample-docs, sample-shape |
| 3.1 | code-binding: class.extract-fields | pending | cross-owner into code-analyzer |
| 3.2 | code-binding: class.locate-references | pending | |
| 3.3 | code-binding: orm.resolve-model | pending | Prisma / TypeORM / SQLAlchemy / Hibernate |
| 3.4 | code-binding: lineage.read-write-callsites | partial (one wrapper from skills-core 9) | atomic skill replacing data_lineage tool |
| 3.5 | code-binding: migration.extract-history | pending | |
| 4.1 | comparison-diff: drift.prisma-vs-live | pending | composite over rdbms.describe-table |
| 4.2 | comparison-diff: drift.typeorm-vs-live | pending | |
| 4.3 | comparison-diff: drift.sqlalchemy-vs-live | pending | |
| 4.4 | comparison-diff: mapping.json-vs-class | pending | composite (class.extract-fields + file.sample-shape) |
| 4.5 | comparison-diff: mapping.csv-vs-dto | pending | |
| 4.6 | comparison-diff: cardinality.expected-vs-live | pending | |
| 4.7 | comparison-diff: range.expected-vs-live | pending | |
| 5a.1 | quality-profile: profile.numeric | partial | `data.profile.numeric.rdbms` shipped (atomic; 10 server-side aggregates -- count / non-null / distinct + min / max / avg / stddev / variance + p50 / p95). File-side variant (`profile.numeric.file`) still pending; the underlying `db_file_aggregate` already exposes the same surface |
| 5a.2 | quality-profile: profile.categorical | partial | `data.profile.categorical.rdbms` shipped (composite over `db_sql_aggregate` + `db_sql_distinct` -- count + null rate + cardinality + top-N + frequency). File-side variant pending |
| 5a.3 | quality-profile: profile.temporal | pending | range, gap detection, period inference |
| 5a.4 | quality-profile: profile.text | pending | length stats, encoding, regex pattern inference |
| 5a.5 | quality-profile: profile.boolean | partial | `data.profile.boolean.rdbms` shipped (atomic; one `db_sql_distinct` round-trip + cross-dialect normalization for true / false / null / other counts plus true ratio). File-side variant pending |
| 5a.6 | quality-profile: profile.auto | pending | composite -- picks profiler from declared type. Blocked on 5a.3 + 5a.4 (needs all six atomics) |
| 5b.1 | distribution: distribution.histogram | pending | |
| 5b.2 | distribution: distribution.outliers-iqr | pending | |
| 5b.3 | distribution: distribution.outliers-zscore | pending | |
| 5b.4 | distribution: distribution.outliers-mad | pending | |
| 5b.5 | distribution: distribution.normality-test | pending | |
| 5b.6 | distribution: distribution.heavy-tail-check | pending | |
| 5b.7 | distribution: distribution.modes | pending | |
| 5c.1 | dependency: correlation.numeric-pairwise | pending | Pearson + Spearman |
| 5c.2 | dependency: correlation.categorical-pairwise | pending | Cramér's V |
| 5c.3 | dependency: dependency.functional | pending | does A determine B? |
| 5c.4 | dependency: dependency.co-null-pattern | pending | |
| 5c.5 | dependency: cardinality.join-key | pending | 1:1 / 1:N / N:M |
| 5d.1 | quality scorecard: quality.completeness | partial | `data.quality.completeness.rdbms` shipped (atomic; auto-discovers columns via `db_sql_describe`, packs `count(*)` + `count_non_null` per column into one `db_sql_aggregate` round-trip; up to 31 columns per call). File-side variant pending |
| 5d.2 | quality scorecard: quality.uniqueness | partial | `data.quality.uniqueness.rdbms` shipped (atomic; per-column `distinctCount/nonNullCount` + single-column PK-candidate detector; cap at 15 columns per call due to `1 + 2N <= 32` aggregate-spec budget). Multi-column PK candidates + file-side variant pending |
| 5d.3 | quality scorecard: quality.validity | pending | matches declared type / domain / regex |
| 5d.4 | quality scorecard: quality.conformity | pending | date / currency / country / postal formats |
| 5d.5 | quality scorecard: quality.consistency | pending | cross-column agreements |
| 5d.6 | quality scorecard: quality.scorecard | pending | composite rollup of 5d.1-5d.5 -- ships once 5d.3-5d.5 land |
| 5e.1 | sensitivity: pii.detect-patterns | partial | `data.pii.detect-patterns.rdbms` shipped (samples up to 50 values via `db_sql_sample`, applies anchored regex set: email / ssn-us / phone-us / credit-card / jwt / ipv4 / iban / aws-access-key / github-token / uuid; returns per-pattern hit count + rate + up to 3 examples). Provider affinity `local`. File / KV variants pending; address detection skipped (no clean regex) |
| 5e.2 | sensitivity: pii.column-classifier | pending | regex + values + column-name heuristics |
| 5e.3 | sensitivity: sensitivity.policy-check | pending | vs connection's pii config |
| 5f.1 | drift over windows: drift.distribution | pending | KL / JS divergence between sample windows |
| 5f.2 | drift over windows: drift.volume | pending | row-count outlier vs cadence |
| 5f.3 | drift over windows: anomaly.change-point | pending | |
| 5g.1 | timeseries: timeseries.trend | pending | regression slope |
| 5g.2 | timeseries: timeseries.seasonality | pending | autocorrelation peaks |
| 5g.3 | timeseries: timeseries.stationarity | pending | ADF test |
| 5g.4 | timeseries: timeseries.gap-analysis | pending | |
| 6.1 | synthesis: synth.target-description | pending | |
| 6.2 | synthesis: synth.field-table | pending | |
| 6.3 | synthesis: synth.drift-report | pending | |
| 6.4 | synthesis: synth.er-diagram | pending | mermaid |
| 6.5 | synthesis: synth.sample-table | pending | |
| 6.6 | synthesis: synth.lineage-fold | pending | |
| 6.7 | synthesis: synth.profile-card | pending | univariate profile card per column |
| 6.8 | synthesis: synth.scorecard | pending | quality scorecard rendering |
| 6.9 | synthesis: synth.histogram-block | pending | mermaid histogram |
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
