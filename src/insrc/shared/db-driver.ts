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

export interface SampleResult {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
	readonly rowCountHint?: number | `>=${number}`;
	readonly truncated: boolean;
}

export interface WhereClause {
	readonly column: string;
	readonly op: '=' | '!=' | 'in' | 'is null';
	readonly value?: unknown;
}

export interface SampleOpts {
	readonly limit: number;
	readonly where?: readonly WhereClause[];
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
