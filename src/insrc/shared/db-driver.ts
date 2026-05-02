/**
 * Data-driver family interfaces -- shared between daemon + browser.
 *
 * Three families, three operation shapes. A `kind` (open string) maps
 * to exactly one family; drivers self-register with the daemon on boot.
 *
 * See `plans/data-driver.md` for the full shape rationale.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type DriverFamily = 'rdbms' | 'kv' | 'file';

/**
 * Per-connection config as stored in
 * ~/.insrc/<repoId>/db-connections.json.
 *
 * `kind` is an open string -- unknown kinds reject at load time.
 * `family` is derived from the registered driver for `kind` unless
 * the user pins it explicitly (e.g. forcing MongoDB into the `kv`
 * family even though the driver registers as `kv` by default).
 */
export interface ConnectionConfig {
	readonly id: string;
	readonly kind: string;
	readonly family?: DriverFamily;
	readonly label?: string;
	/** RDBMS + KV: connection URL. May contain `${secret:<ref>}` for
	 *  password-redacted form; the daemon resolves these via keystore
	 *  before building the driver. */
	readonly url?: string;
	/** File kinds: repo-relative path. */
	readonly path?: string;
	/** Keychain reference. Set by the setup UX on save; the daemon
	 *  resolves `url`'s `${secret:<ref>}` token against this ref. */
	readonly secretRef?: string;
	/** RDBMS-only. Optional schema source; defaults to live
	 *  introspection. */
	readonly schemaSource?: {
		readonly type: 'prisma';
		readonly path: string;
	};
	/** KV-only. Restricts `scan` / `sample_shape` to whitelisted
	 *  patterns / prefixes. */
	readonly namespace?: {
		readonly allow: readonly string[];
	};
	/** Per-connection PII masking -- replaces matched fields with
	 *  sha256 hashes in tool results. */
	readonly pii?: readonly string[];
	/** Kind-specific extras (e.g. CSV delimiter, Cassandra
	 *  keyspace + contactPoints, fixed-width column spec). */
	readonly options?: Readonly<Record<string, unknown>>;
	/** File kinds, directory-as-table support
	 *  (plans/data-driver-duckdb-files.md Phase 4.2). When `path`
	 *  points at a directory and `recursive` is true, the driver
	 *  globs the whole subtree; when false (default), only files
	 *  directly under `path` participate. Ignored for single-file
	 *  connections. */
	readonly recursive?: boolean;
	/** File kinds, directory-as-table support
	 *  (plans/data-driver-duckdb-files.md Phase 4.3). When set to
	 *  `'hive'`, the driver passes `hive_partitioning=true` to
	 *  DuckDB readers so `<key>=<value>/` directory components
	 *  surface as columns. Default `'none'`. Ignored for single-file
	 *  connections. */
	readonly partitioning?: 'hive' | 'none';
	/**
	 * Session-scoped ephemeral connection. Set by the data-analyzer
	 * (and future siblings) when registering a one-off local file the
	 * user referenced in their prompt -- so they don't have to go
	 * through the Data Sources pane for every ad-hoc file.
	 *
	 * Ephemeral connections:
	 *   - live in the pool's in-memory entries map only (NOT written
	 *     to db-connections.json),
	 *   - survive `pool.reload()` -- the prune pass skips them so a
	 *     concurrent Data Sources edit doesn't drop the analyzer's
	 *     ephemeral entries mid-run,
	 *   - are visible to `db_list_connections` like any other entry,
	 *   - are auto-approved by the connection-approval gate (the
	 *     user just typed the path; explicit consent).
	 */
	readonly ephemeral?: boolean;
}

export interface ConnectionsFile {
	readonly connections: readonly ConnectionConfig[];
}

// ---------------------------------------------------------------------------
// Shared result shapes (carried back to the tool layer)
// ---------------------------------------------------------------------------

export interface ColumnDescription {
	readonly name: string;
	readonly type: string;
	readonly nullable?: boolean;
	readonly primaryKey?: boolean;
	readonly foreignKey?: { readonly table: string; readonly column: string };
}

export interface SchemaDescription {
	readonly target: string;
	readonly columns: readonly ColumnDescription[];
	/** Where the schema came from: `'introspect'` for live catalog
	 *  queries, `'prisma'` for parsed schema.prisma, `'header'` for
	 *  binary formats (Avro / Arrow / Parquet / xlsx), `'inferred'`
	 *  for text formats sampled to build the schema. */
	readonly source: 'introspect' | 'prisma' | 'header' | 'inferred';
}

/**
 * How a sample was actually produced. Set by the driver; informs the
 * caller about the bias profile of the result independently of what
 * `strategy` was requested. See `plans/data-driver.md` §7.2.
 */
export type SamplingMethod =
	/** Deterministic top-N (today's only behaviour). */
	| 'first'
	/** True uniform random over rows -- e.g. Postgres `ORDER BY random()`,
	 *  reservoir over a streamed file. */
	| 'row-uniform'
	/** Page / block sampled -- biased toward dense pages. ClickHouse
	 *  `SAMPLE 0.0X`, Postgres `TABLESAMPLE BERNOULLI`. */
	| 'page-uniform'
	/** Cassandra K-anchor scattered random. K independent token
	 *  anchors, M token-adjacent rows per anchor. */
	| 'token-multi-anchor'
	/** File random-index seek -- Parquet, Arrow, fixed-width. */
	| 'index-direct'
	/** Engine-native opaque sampler -- MongoDB `$sample`, DynamoDB
	 *  `Scan` + shuffle. */
	| 'engine-native';

export interface SampleResultMetadata {
	/** Always set -- honest signal about how the rows were produced. */
	readonly samplingMethod: SamplingMethod;
	/** Echoed when the caller passed `seed`. */
	readonly seed?: number;
	/** Present when the caller passed `seed`; signals whether the
	 *  underlying engine honoured it. Drivers that can't seed return
	 *  `false` here so tests / reproducibility checks can detect it. */
	readonly seedHonored?: boolean;
	/** Set when the requested strategy was downgraded at driver-init
	 *  time (Cassandra ByteOrderedPartitioner, ClickHouse no-`SAMPLE BY`)
	 *  -- distinct from per-call timeout, which surfaces as an error. */
	readonly fallbackFrom?: SampleStrategy;
	readonly fallbackReason?: string;
	/** Sample returned fewer rows than `limit` (source size, empty
	 *  token range, etc.) -- distinct from `truncated`, which means
	 *  more rows existed than were returned. */
	readonly shortResult?: boolean;

	// Multi-anchor specifics (Cassandra `token-multi-anchor`).
	readonly anchors?: number;
	readonly rowsPerAnchor?: number;

	// File-format extras populated by binary-format drivers.
	readonly fileSize?: number;
	readonly rowCountHint?: number | `>=${number}`;
	readonly schemaSource?: 'header' | 'sample' | 'config';
}

export interface SampleResult {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
	readonly rowCountHint?: number | `>=${number}`;
	readonly truncated: boolean;
	readonly metadata: SampleResultMetadata;
}

export interface WhereClause {
	readonly column: string;
	readonly op: '=' | '!=' | 'in' | 'is null';
	readonly value?: unknown;
}

export type SampleStrategy = 'first' | 'random' | 'stratified';

export interface SampleOpts {
	readonly limit: number;
	readonly where?: readonly WhereClause[];
	/** Defaults to `'first'` (existing behaviour). `'stratified'`
	 *  requires `stratifyBy` to be set. */
	readonly strategy?: SampleStrategy;
	/** Required when `strategy === 'stratified'`; rejected otherwise. */
	readonly stratifyBy?: string;
	/** Optional. Per-engine honouring varies (see §7.6) -- drivers that
	 *  can't seed echo it back via `metadata.seedHonored = false`. */
	readonly seed?: number;
}

export interface ScanOpts {
	readonly pattern?: string;
	readonly prefix?: string;
	readonly limit: number;
}

export interface KeyList {
	readonly keys: readonly (string | Readonly<Record<string, unknown>>)[];
	readonly truncated: boolean;
}

export interface KvValue {
	readonly key: string | Readonly<Record<string, unknown>>;
	readonly value: unknown;
	readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'binary' | 'null';
}

export interface ShapeReport {
	readonly sampleSize: number;
	readonly fields: readonly {
		readonly path: string;
		readonly types: readonly string[];
		readonly nullable: boolean;
		readonly frequency: number;
	}[];
}

/** Placeholder. Full shape lands in phase 3.2 alongside
 *  `db.sql.explain`. */
export interface QueryAst {
	readonly kind: 'select';
	readonly target: string;
	readonly where?: readonly WhereClause[];
}

/** Placeholder mirror of QueryAst. */
export interface PlanResult {
	readonly plan: string;
}

// ---------------------------------------------------------------------------
// Aggregation (Phase 0.1 of plans/analyzers/data-analyzer-skills.md)
// ---------------------------------------------------------------------------

/**
 * Functions a driver may be asked to compute server-side. The skill /
 * tool layer never invents these client-side -- the LLM produces a
 * structured request, the driver compiles to SQL, the engine returns
 * numbers. This is the "no-hallucinated-numbers" boundary.
 */
export type AggregateFunction =
	| 'count'             // COUNT(*)
	| 'count_non_null'    // COUNT(<col>)
	| 'distinct_count'    // COUNT(DISTINCT <col>)
	| 'sum'
	| 'avg'
	| 'stddev'            // sample stddev
	| 'variance'          // sample variance
	| 'min'
	| 'max'
	| 'percentile';       // requires args.p in [0, 1]

export interface AggregateSpec {
	/** Column to aggregate. Ignored by `count` (which is COUNT(*)) but
	 *  still required so the result key is well-defined. */
	readonly column: string;
	readonly function: AggregateFunction;
	readonly args?: { readonly p?: number };
}

export interface AggregateRequest {
	readonly aggregations: readonly AggregateSpec[];
}

export interface AggregateResult {
	readonly target: string;
	/**
	 * Flat numeric record keyed `<column>__<function>` (or
	 * `<column>__percentile_<p>` for percentile to disambiguate
	 * multiple percentile asks on the same column). Values are `null`
	 * when the underlying engine returned NULL (e.g. AVG over an
	 * empty table).
	 */
	readonly values: Readonly<Record<string, number | null>>;
}

/**
 * Top-N distinct value request. Returns the most frequent values for
 * one column plus the column's overall distinct cardinality. Used by
 * `db_sql_distinct` (Phase 0.3 of plans/analyzers/data-analyzer-skills.md)
 * and the `data.source.rdbms.sample-distinct` skill.
 *
 * `topN` is clamped to [1, 1000] in the tool layer; results are
 * ordered by frequency descending, ties broken by lexicographic
 * order on the value (deterministic across re-runs, cache-friendly).
 */
export interface DistinctRequest {
	readonly column: string;
	readonly topN: number;
}

export interface DistinctResult {
	readonly target: string;
	readonly column: string;
	readonly distinctCount: number;
	readonly topValues: readonly { readonly value: unknown; readonly count: number }[];
}

// ---------------------------------------------------------------------------
// Driver interfaces
// ---------------------------------------------------------------------------

export interface BaseDriver {
	readonly id: string;
	readonly kind: string;
	readonly family: DriverFamily;
	close(): Promise<void>;
}

export interface RdbmsDriver extends BaseDriver {
	readonly family: 'rdbms';
	describe(target: string): Promise<SchemaDescription>;
	sample(target: string, opts: SampleOpts): Promise<SampleResult>;
	explain?(queryAst: QueryAst): Promise<PlanResult>;
	/**
	 * Compute server-side aggregations and return a flat numeric
	 * record. Drivers that cannot implement a particular function on
	 * their dialect should throw a clear error -- the tool layer
	 * surfaces it as `success: false` rather than papering over a
	 * missing primitive.
	 */
	aggregate(target: string, request: AggregateRequest): Promise<AggregateResult>;
	/**
	 * Top-N distinct values for one column plus overall distinct
	 * cardinality. Drives `data.source.rdbms.sample-distinct` and
	 * downstream Family-5 categorical-profile skills.
	 */
	distinct(target: string, request: DistinctRequest): Promise<DistinctResult>;
}

export interface KvDriver extends BaseDriver {
	readonly family: 'kv';
	scan(opts: ScanOpts): Promise<KeyList>;
	get(key: string | Readonly<Record<string, unknown>>): Promise<KvValue>;
	sampleShape(opts: ScanOpts): Promise<ShapeReport>;
}

export interface FileDriver extends BaseDriver {
	readonly family: 'file';
	/** Tabular file kinds (csv, tsv, jsonl, xlsx, avro, arrow, bson,
	 *  parquet, fixed-width). Target is optional for single-target
	 *  files (csv); required for multi-target files (xlsx sheets). */
	describe?(target?: string): Promise<SchemaDescription>;
	sample?(target: string | undefined, opts: SampleOpts): Promise<SampleResult>;
	/** Document file kinds (single-doc json). Also used by tabular
	 *  kinds that want to expose nested-field shape inference. */
	sampleShape?(opts: ScanOpts): Promise<ShapeReport>;
	get?(path: string): Promise<KvValue>;
	/** Optional. Tabular file kinds that route through DuckDB (parquet
	 *  today; the data-driver-duckdb-files plan unifies the rest)
	 *  expose this for Family 5 quality / distribution / dependency
	 *  skills. Other file kinds throw. */
	aggregate?(target: string | undefined, request: AggregateRequest): Promise<AggregateResult>;
	/** Optional. Same shape as the RDBMS `distinct` method; the
	 *  consolidated DuckDB-backed file driver implements it for the
	 *  file family. Other file drivers throw. */
	distinct?(target: string | undefined, request: DistinctRequest): Promise<DistinctResult>;
}

export type Driver = RdbmsDriver | KvDriver | FileDriver;

// ---------------------------------------------------------------------------
// Driver factory + registration (implemented in daemon/db/registry.ts)
// ---------------------------------------------------------------------------

/**
 * Factory builds a live, ready-to-use driver from a config entry.
 * Secrets in `config.url` have already been resolved by the pool
 * layer before the factory is called, so drivers see the raw
 * connection string.
 */
export type DriverFactory = (config: ConnectionConfig) => Promise<Driver>;

export interface DriverRegistration {
	readonly kind: string;
	readonly family: DriverFamily;
	readonly factory: DriverFactory;
}
