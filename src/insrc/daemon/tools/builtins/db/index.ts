/**
 * Data-driver tools: `db_list_connections` + `db:sql:*` + `db:kv:*`
 * + `db:file:*`.
 *
 * Each tool validates input shape, acquires a driver from the repo's
 * cached pool, dispatches to the matching method, and wraps the
 * result in a ToolResult with a markdown summary on `output` +
 * structured payload on `data`.
 *
 * Family mismatch (calling db:sql:* on a KV connection, etc.) errors
 * cleanly with a FAMILY_MISMATCH message that names the right tool
 * namespace -- the LLM retries with the correct call.
 *
 * Per-repo opt-in: `db:*` tools short-circuit to an
 * NO_CONNECTIONS_CONFIGURED error when the active repo has zero
 * entries in db-connections.json. The tools stay listed (so the LLM
 * can pick them up) but refuse to run until configured.
 */

import { getLogger } from '../../../../shared/logger.js';
import { registerTool } from '../../registry.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../../types.js';
import { acquirePool } from '../../../db/pool-cache.js';
import type {
	ConnectionConfig,
	Driver,
	FileDriver,
	KvDriver,
	RdbmsDriver,
	SampleOpts,
	ScanOpts,
	WhereClause,
} from '../../../../shared/db-driver.js';

const log = getLogger('tools-db');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fail(id: string, msg: string, code?: string): ToolResult {
	const body = code === undefined ? `[${id}] ${msg}` : `[${id}] ${code}: ${msg}`;
	return { output: body, format: 'text', success: false, error: msg };
}

function ok(
	output: string,
	data: unknown,
	format: ToolResult['format'] = 'markdown',
): ToolResult {
	return { output, format, success: true, data };
}

async function requireRepoPath(
	toolId: string,
	deps: ToolDeps,
): Promise<string | ToolResult> {
	const repoPath = deps.session.repoPath;
	if (repoPath === undefined || repoPath === '') {
		return fail(toolId, 'No active repo on the session; db:* tools need a repoPath', 'NO_ACTIVE_REPO');
	}
	return repoPath;
}

async function acquireDriver(
	toolId: string,
	deps: ToolDeps,
	connectionId: string,
	expected: 'rdbms' | 'kv' | 'file',
): Promise<Driver | ToolResult> {
	const repoPath = await requireRepoPath(toolId, deps);
	if (typeof repoPath !== 'string') { return repoPath; }

	const pool = await acquirePool(repoPath);
	const configured = pool.list();
	if (configured.length === 0) {
		return fail(
			toolId,
			'No data-driver connections configured for this repo. Use the Data Sources pane / insrc.addDbConnection to add one.',
			'NO_CONNECTIONS_CONFIGURED',
		);
	}
	const match = configured.find(c => c.id === connectionId);
	if (match === undefined) {
		return fail(
			toolId,
			`Unknown connection '${connectionId}'. Known: ${configured.map(c => c.id).join(', ') || '(none)'}`,
			'UNKNOWN_CONNECTION',
		);
	}
	if (match.family !== expected) {
		return fail(
			toolId,
			`Connection '${connectionId}' is ${match.family}; use db:${match.family}:* instead`,
			'FAMILY_MISMATCH',
		);
	}
	return await pool.acquire(connectionId);
}

function summariseConnections(conns: readonly ConnectionConfig[]): string {
	if (conns.length === 0) { return '(no connections configured)'; }
	const rows = ['| id | kind | family | label |', '|---|---|---|---|'];
	for (const c of conns) {
		rows.push(`| ${c.id} | ${c.kind} | ${c.family ?? '?'} | ${c.label ?? ''} |`);
	}
	return rows.join('\n');
}

// ---------------------------------------------------------------------------
// Schema snippets reused across tools
// ---------------------------------------------------------------------------

const CONNECTION_ID_PROP = {
	connectionId: {
		type: 'string',
		description: 'Connection id from `db_list_connections` (unique within the repo).',
	},
} as const;

const WHERE_SCHEMA = {
	type: 'array',
	maxItems: 10,
	items: {
		type: 'object',
		required: ['column', 'op'],
		additionalProperties: false,
		properties: {
			column: { type: 'string' },
			op:     { type: 'string', enum: ['=', '!=', 'in', 'is null'] },
			value:  {},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// db:list_connections
// ---------------------------------------------------------------------------

const listConnectionsTool: Tool = {
	id: 'db_list_connections',
	description:
		'List every data-driver connection configured for the active repo. ' +
		'Each entry: { id, kind, family, label }. Use this first to discover which ' +
		'db:sql:* / db:kv:* / db:file:* calls are available and what connectionId to pass.',
	inputSchema: { type: 'object', additionalProperties: false, properties: {} },
	async execute(_input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const repoPath = await requireRepoPath(this.id, deps);
		if (typeof repoPath !== 'string') { return repoPath; }
		try {
			const pool = await acquirePool(repoPath);
			const list = pool.list();
			return ok(
				summariseConnections(list),
				list.map(c => ({
					id: c.id, kind: c.kind, family: c.family, label: c.label,
				})),
			);
		} catch (err) {
			return fail(this.id, (err as Error).message);
		}
	},
};

// ---------------------------------------------------------------------------
// db:sql:describe + db:sql:sample
// ---------------------------------------------------------------------------

const sqlDescribeTool: Tool = {
	id: 'db_sql_describe',
	description:
		'Describe the schema of a single RDBMS table or view: columns + types + nullability + PK/FK. ' +
		'Accepts bare `table` or `schema.table`. Use this before db:sql:sample so the LLM can pick valid column names.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['connectionId', 'target'],
		properties: {
			...CONNECTION_ID_PROP,
			target: { type: 'string', description: 'Table or view name, with optional schema (e.g. `public.users`).' },
		},
	},
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const connectionId = String(input['connectionId'] ?? '');
		const target = String(input['target'] ?? '');
		if (connectionId === '' || target === '') {
			return fail(this.id, 'connectionId and target are required');
		}
		const driver = await acquireDriver(this.id, deps, connectionId, 'rdbms');
		if (!isDriver(driver)) { return driver; }
		try {
			const schema = await (driver as RdbmsDriver).describe(target);
			const rows = [
				`**${schema.target}** (${schema.source})`,
				'',
				'| column | type | nullable | pk | fk |',
				'|---|---|---|---|---|',
			];
			for (const c of schema.columns) {
				rows.push(
					`| ${c.name} | ${c.type} | ${c.nullable === true ? 'yes' : 'no'} ` +
					`| ${c.primaryKey === true ? 'yes' : ''} ` +
					`| ${c.foreignKey === undefined ? '' : `${c.foreignKey.table}.${c.foreignKey.column}`} |`,
				);
			}
			return ok(rows.join('\n'), schema);
		} catch (err) {
			return fail(this.id, (err as Error).message);
		}
	},
};

const sqlExplainTool: Tool = {
	id: 'db_sql_explain',
	description:
		'Run EXPLAIN against a SELECT-shaped query on an RDBMS connection. ' +
		'Returns the dialect-native plan as a string. Same WHERE / target ' +
		'safety envelope as db:sql:sample (no raw SQL; column names ' +
		'validated against describe()). Limit clamped at 50.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['connectionId', 'queryAst'],
		properties: {
			...CONNECTION_ID_PROP,
			queryAst: {
				type: 'object',
				required: ['kind', 'target'],
				additionalProperties: false,
				properties: {
					kind: { type: 'string', enum: ['select'] },
					target: { type: 'string' },
					where: WHERE_SCHEMA,
				},
			},
		},
	},
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const connectionId = String(input['connectionId'] ?? '');
		if (connectionId === '') { return fail(this.id, 'connectionId is required'); }
		const rawAst = input['queryAst'];
		if (rawAst === null || typeof rawAst !== 'object') {
			return fail(this.id, 'queryAst must be an object');
		}
		const ast = rawAst as Record<string, unknown>;
		if (ast['kind'] !== 'select' || typeof ast['target'] !== 'string' || ast['target'] === '') {
			return fail(this.id, 'queryAst.kind must be "select" and target must be a non-empty string');
		}
		const driver = await acquireDriver(this.id, deps, connectionId, 'rdbms');
		if (!isDriver(driver)) { return driver; }
		const rdbms = driver as RdbmsDriver;
		if (rdbms.explain === undefined) {
			return fail(this.id, `Connection '${connectionId}' (${rdbms.kind}) does not implement explain`, 'UNSUPPORTED');
		}
		try {
			const opts = buildSampleOpts({ ...input, ...ast });
			const result = await rdbms.explain({
				kind: 'select',
				target: ast['target'],
				...(opts.where !== undefined ? { where: opts.where } : {}),
			});
			return ok('```\n' + result.plan + '\n```', result, 'markdown');
		} catch (err) {
			return fail(this.id, (err as Error).message);
		}
	},
};

const sqlSampleTool: Tool = {
	id: 'db_sql_sample',
	description:
		'Sample up to 50 rows from an RDBMS table / view with an optional WHERE filter. ' +
		'Raw SQL is never accepted; filters are structured { column, op, value } objects. ' +
		'Clamped at 50 rows + 5s wall-clock.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['connectionId', 'target', 'limit'],
		properties: {
			...CONNECTION_ID_PROP,
			target: { type: 'string' },
			limit:  { type: 'integer', minimum: 1, maximum: 50 },
			where:  WHERE_SCHEMA,
		},
	},
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const connectionId = String(input['connectionId'] ?? '');
		const target = String(input['target'] ?? '');
		if (connectionId === '' || target === '') {
			return fail(this.id, 'connectionId and target are required');
		}
		const driver = await acquireDriver(this.id, deps, connectionId, 'rdbms');
		if (!isDriver(driver)) { return driver; }
		try {
			const opts = buildSampleOpts(input);
			const result = await (driver as RdbmsDriver).sample(target, opts);
			return ok(formatSample(result.target, result), result);
		} catch (err) {
			return fail(this.id, (err as Error).message);
		}
	},
};

// ---------------------------------------------------------------------------
// db:kv:scan + db:kv:get + db:kv:sample_shape
// ---------------------------------------------------------------------------

const kvScanTool: Tool = {
	id: 'db_kv_scan',
	description:
		'List keys on a KV connection (redis / valkey / keydb / mongodb / cassandra / nats). ' +
		'Supply either `pattern` (glob / subject-wildcard per kind) or `prefix`. ' +
		'Clamped at 500 keys + 5s wall-clock. Respects the connection\'s namespace.allow whitelist.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['connectionId', 'limit'],
		properties: {
			...CONNECTION_ID_PROP,
			pattern: { type: 'string' },
			prefix:  { type: 'string' },
			limit:   { type: 'integer', minimum: 1, maximum: 500 },
		},
	},
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const connectionId = String(input['connectionId'] ?? '');
		if (connectionId === '') { return fail(this.id, 'connectionId is required'); }
		const driver = await acquireDriver(this.id, deps, connectionId, 'kv');
		if (!isDriver(driver)) { return driver; }
		try {
			const result = await (driver as KvDriver).scan(buildScanOpts(input));
			const summary =
				`${result.keys.length} keys${result.truncated ? ' (truncated)' : ''}` +
				(result.keys.length === 0
					? ''
					: '\n\n' + result.keys.slice(0, 50).map(k => `- ${keyToString(k)}`).join('\n'));
			return ok(summary, result);
		} catch (err) {
			return fail(this.id, (err as Error).message);
		}
	},
};

const kvGetTool: Tool = {
	id: 'db_kv_get',
	description:
		'Read a single key from a KV connection. For string-key stores (redis / valkey / nats) ' +
		'pass `key` as a string; for composite-key stores (mongodb: {db, collection, _id}; ' +
		'cassandra: {keyspace, table, ...pkCols}) pass `key` as an object.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['connectionId', 'key'],
		properties: {
			...CONNECTION_ID_PROP,
			key: {
				anyOf: [
					{ type: 'string' },
					{ type: 'object' },
				],
			},
		},
	},
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const connectionId = String(input['connectionId'] ?? '');
		if (connectionId === '') { return fail(this.id, 'connectionId is required'); }
		const rawKey = input['key'];
		if (rawKey === undefined || rawKey === null) { return fail(this.id, 'key is required'); }
		const driver = await acquireDriver(this.id, deps, connectionId, 'kv');
		if (!isDriver(driver)) { return driver; }
		try {
			const result = await (driver as KvDriver).get(
				rawKey as string | Readonly<Record<string, unknown>>,
			);
			const preview = JSON.stringify(result.value, null, 2) ?? 'null';
			const summary = `**${keyToString(result.key)}** (${result.type})\n\n\`\`\`json\n${preview.slice(0, 2_000)}\n\`\`\``;
			return ok(summary, result);
		} catch (err) {
			return fail(this.id, (err as Error).message);
		}
	},
};

const kvSampleShapeTool: Tool = {
	id: 'db_kv_sample_shape',
	description:
		'Infer the shape (field names + observed types + nullability + frequency) of values ' +
		'under a pattern or prefix on a KV connection. Samples at most 50 values + 5s wall-clock.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['connectionId', 'limit'],
		properties: {
			...CONNECTION_ID_PROP,
			pattern: { type: 'string' },
			prefix:  { type: 'string' },
			limit:   { type: 'integer', minimum: 1, maximum: 50 },
		},
	},
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const connectionId = String(input['connectionId'] ?? '');
		if (connectionId === '') { return fail(this.id, 'connectionId is required'); }
		const driver = await acquireDriver(this.id, deps, connectionId, 'kv');
		if (!isDriver(driver)) { return driver; }
		try {
			const result = await (driver as KvDriver).sampleShape(buildScanOpts(input));
			const rows = [
				`sampled ${result.sampleSize} values`,
				'',
				'| path | types | nullable | frequency |',
				'|---|---|---|---|',
			];
			for (const f of result.fields) {
				rows.push(`| ${f.path} | ${f.types.join(', ')} | ${f.nullable ? 'yes' : 'no'} | ${(f.frequency * 100).toFixed(0)}% |`);
			}
			return ok(rows.join('\n'), result);
		} catch (err) {
			return fail(this.id, (err as Error).message);
		}
	},
};

// ---------------------------------------------------------------------------
// db:file:describe + db:file:sample + db:file:sample_shape
// ---------------------------------------------------------------------------

const fileDescribeTool: Tool = {
	id: 'db_file_describe',
	description:
		'Describe the inferred / embedded schema of a tabular file connection ' +
		'(csv / tsv / jsonl / xlsx / avro / arrow / bson / fixed-width). ' +
		'For xlsx / multi-target files, supply `target` = sheet name.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['connectionId'],
		properties: {
			...CONNECTION_ID_PROP,
			target: { type: 'string', description: 'For multi-target files (xlsx sheets).' },
		},
	},
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const connectionId = String(input['connectionId'] ?? '');
		if (connectionId === '') { return fail(this.id, 'connectionId is required'); }
		const driver = await acquireDriver(this.id, deps, connectionId, 'file');
		if (!isDriver(driver)) { return driver; }
		const fd = driver as FileDriver;
		if (fd.describe === undefined) {
			return fail(this.id, `Connection '${connectionId}' (${fd.kind}) does not support describe; try db:file:sample_shape`);
		}
		try {
			const target = typeof input['target'] === 'string' ? input['target'] : undefined;
			const schema = target === undefined
				? await fd.describe()
				: await fd.describe(target);
			const rows = [
				`**${schema.target}** (${schema.source})`,
				'',
				'| column | type | nullable |',
				'|---|---|---|',
			];
			for (const c of schema.columns) {
				rows.push(`| ${c.name} | ${c.type} | ${c.nullable === true ? 'yes' : 'no'} |`);
			}
			return ok(rows.join('\n'), schema);
		} catch (err) {
			return fail(this.id, (err as Error).message);
		}
	},
};

const fileSampleTool: Tool = {
	id: 'db_file_sample',
	description:
		'Sample up to 50 records from a file connection with an optional WHERE filter. ' +
		'Clamped at 50 rows + 5s wall-clock.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['connectionId', 'limit'],
		properties: {
			...CONNECTION_ID_PROP,
			target: { type: 'string' },
			limit:  { type: 'integer', minimum: 1, maximum: 50 },
			where:  WHERE_SCHEMA,
		},
	},
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const connectionId = String(input['connectionId'] ?? '');
		if (connectionId === '') { return fail(this.id, 'connectionId is required'); }
		const driver = await acquireDriver(this.id, deps, connectionId, 'file');
		if (!isDriver(driver)) { return driver; }
		const fd = driver as FileDriver;
		if (fd.sample === undefined) {
			return fail(this.id, `Connection '${connectionId}' (${fd.kind}) does not support row-sample; try db:file:sample_shape`);
		}
		try {
			const target = typeof input['target'] === 'string' ? input['target'] : undefined;
			const opts = buildSampleOpts(input);
			const result = await fd.sample(target, opts);
			return ok(formatSample(result.target, result), result);
		} catch (err) {
			return fail(this.id, (err as Error).message);
		}
	},
};

const fileSampleShapeTool: Tool = {
	id: 'db_file_sample_shape',
	description:
		'Infer the shape of records in a document-style file connection (e.g. single-doc JSON, nested fields). ' +
		'Clamped at 50 records + 5s wall-clock.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['connectionId', 'limit'],
		properties: {
			...CONNECTION_ID_PROP,
			pattern: { type: 'string' },
			prefix:  { type: 'string' },
			limit:   { type: 'integer', minimum: 1, maximum: 50 },
		},
	},
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const connectionId = String(input['connectionId'] ?? '');
		if (connectionId === '') { return fail(this.id, 'connectionId is required'); }
		const driver = await acquireDriver(this.id, deps, connectionId, 'file');
		if (!isDriver(driver)) { return driver; }
		const fd = driver as FileDriver;
		if (fd.sampleShape === undefined) {
			return fail(this.id, `Connection '${connectionId}' (${fd.kind}) does not support sample_shape; try db:file:describe`);
		}
		try {
			const result = await fd.sampleShape(buildScanOpts(input));
			const rows = [
				`sampled ${result.sampleSize} records`,
				'',
				'| path | types | nullable | frequency |',
				'|---|---|---|---|',
			];
			for (const f of result.fields) {
				rows.push(`| ${f.path} | ${f.types.join(', ')} | ${f.nullable ? 'yes' : 'no'} | ${(f.frequency * 100).toFixed(0)}% |`);
			}
			return ok(rows.join('\n'), result);
		} catch (err) {
			return fail(this.id, (err as Error).message);
		}
	},
};

// ---------------------------------------------------------------------------
// Input adapters
// ---------------------------------------------------------------------------

function buildSampleOpts(input: ToolInput): SampleOpts {
	const limit = Math.min(Math.max(1, Number(input['limit'] ?? 10)), 50);
	const rawWhere = input['where'];
	const where: WhereClause[] = [];
	if (Array.isArray(rawWhere)) {
		for (const raw of rawWhere) {
			if (raw === null || typeof raw !== 'object') { continue; }
			const r = raw as Record<string, unknown>;
			const column = typeof r['column'] === 'string' ? r['column'] : '';
			const op = r['op'];
			if (column === '') { continue; }
			if (op === '=' || op === '!=' || op === 'in' || op === 'is null') {
				const clause: WhereClause = op === 'is null'
					? { column, op }
					: { column, op, value: r['value'] };
				where.push(clause);
			}
		}
	}
	return where.length === 0 ? { limit } : { limit, where };
}

function buildScanOpts(input: ToolInput): ScanOpts {
	const limit = Math.min(Math.max(1, Number(input['limit'] ?? 50)), 500);
	const pattern = typeof input['pattern'] === 'string' ? input['pattern'] : undefined;
	const prefix  = typeof input['prefix']  === 'string' ? input['prefix']  : undefined;
	return pattern !== undefined
		? { limit, pattern }
		: prefix !== undefined
			? { limit, prefix }
			: { limit };
}

function isDriver(v: Driver | ToolResult): v is Driver {
	return (v as Driver).family !== undefined;
}

function keyToString(key: string | Readonly<Record<string, unknown>>): string {
	return typeof key === 'string' ? key : JSON.stringify(key);
}

function formatSample(target: string, result: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[]; truncated: boolean }): string {
	if (result.rows.length === 0) {
		return `**${target}** — no rows${result.truncated ? ' (truncated)' : ''}`;
	}
	const header = `| ${result.columns.join(' | ')} |`;
	const sep = `| ${result.columns.map(() => '---').join(' | ')} |`;
	const rows = result.rows.map(r =>
		`| ${result.columns.map(c => fmtCell(r[c])).join(' | ')} |`,
	);
	return `**${target}**${result.truncated ? ' (truncated)' : ''}\n\n${header}\n${sep}\n${rows.join('\n')}`;
}

function fmtCell(v: unknown): string {
	if (v === null || v === undefined) { return ''; }
	if (typeof v === 'string') { return v.length > 200 ? v.slice(0, 200) + '…' : v; }
	if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
	if (v instanceof Date) { return v.toISOString(); }
	const s = JSON.stringify(v);
	return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDbTools(): void {
	registerTool(listConnectionsTool);
	registerTool(sqlDescribeTool);
	registerTool(sqlSampleTool);
	registerTool(sqlExplainTool);
	registerTool(kvScanTool);
	registerTool(kvGetTool);
	registerTool(kvSampleShapeTool);
	registerTool(fileDescribeTool);
	registerTool(fileSampleTool);
	registerTool(fileSampleShapeTool);
	log.debug({ count: 10 }, 'data-driver tools registered');
}
