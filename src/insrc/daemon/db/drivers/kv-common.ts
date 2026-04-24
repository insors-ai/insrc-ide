/**
 * Shared helpers for KV drivers (Redis / Valkey / KeyDB, MongoDB,
 * Cassandra-as-KV, NATS JetStream KV, DynamoDB, etcd, Memcached).
 *
 * Each driver implements the scan / get / sampleShape contract in
 * its own idiomatic client; shared concerns here:
 *   - scan pattern / prefix validation against the connection's
 *     `namespace.allow` whitelist (if configured);
 *   - limit + wall-clock caps;
 *   - shape inference for sampleShape output.
 */

import type {
	ConnectionConfig,
	ScanOpts,
	ShapeReport,
} from '../../../shared/db-driver.js';

export const SCAN_LIMIT = 500;
export const SAMPLE_SHAPE_LIMIT = 50;
export const SCAN_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Namespace whitelist
// ---------------------------------------------------------------------------

/**
 * Reject scan opts whose pattern/prefix doesn't fall within any
 * allowed prefix. Each allowed entry is itself treated as a prefix
 * match (longest wins; we only care about "is the request inside?"
 * semantics).
 *
 * No whitelist configured -> permissive (pattern/prefix passes).
 * Pattern mode: the input's literal stem (anything before the first
 * wildcard) must start with one of the allowed prefixes.
 */
export function assertNamespaceAllowed(
	config: ConnectionConfig,
	opts: ScanOpts,
): void {
	const allow = config.namespace?.allow;
	if (allow === undefined || allow.length === 0) { return; }

	const stem = scanStem(opts);
	if (stem === null) {
		throw new Error(
			`data-driver: connection '${config.id}' has a namespace whitelist; ` +
			`pattern or prefix is required`,
		);
	}

	const ok = allow.some((a) => {
		const aStem = a.endsWith('*') ? a.slice(0, -1) : a;
		return stem.startsWith(aStem);
	});
	if (!ok) {
		throw new Error(
			`data-driver: scan pattern/prefix '${stem}' is outside the ` +
			`namespace whitelist for connection '${config.id}' ` +
			`(allowed: ${allow.join(', ')})`,
		);
	}
}

function scanStem(opts: ScanOpts): string | null {
	if (opts.prefix !== undefined) { return opts.prefix; }
	if (opts.pattern !== undefined) {
		const first = opts.pattern.search(/[*?[\\]/);
		return first < 0 ? opts.pattern : opts.pattern.slice(0, first);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export function clampScanLimit(n: number): number {
	return Math.min(Math.max(1, Math.floor(n)), SCAN_LIMIT);
}

export function clampSampleShapeLimit(n: number): number {
	return Math.min(Math.max(1, Math.floor(n)), SAMPLE_SHAPE_LIMIT);
}

// ---------------------------------------------------------------------------
// Shape inference
// ---------------------------------------------------------------------------

interface FieldAcc {
	types: Set<string>;
	nullCount: number;
	totalCount: number;
}

/**
 * Walk a batch of sampled values + emit a ShapeReport. Handles nested
 * objects by dot-joining paths (`addresses.0.city`). Arrays collapse
 * element-level paths onto `[]` to avoid path explosion on variable
 * arrays.
 */
export function inferShape(values: readonly unknown[]): ShapeReport {
	const acc = new Map<string, FieldAcc>();

	for (const v of values) {
		walk(v, '', acc);
	}

	const fields = Array.from(acc.entries()).map(([path, a]) => ({
		path,
		types: Array.from(a.types).sort(),
		nullable: a.nullCount > 0,
		frequency: a.totalCount / values.length,
	}));
	fields.sort((a, b) => a.path.localeCompare(b.path));

	return { sampleSize: values.length, fields };
}

function walk(node: unknown, path: string, acc: Map<string, FieldAcc>): void {
	if (path !== '') { bump(acc, path, typeName(node), node === null); }

	if (node === null || typeof node !== 'object') { return; }

	if (Array.isArray(node)) {
		const childPath = path === '' ? '[]' : `${path}.[]`;
		for (const item of node) { walk(item, childPath, acc); }
		return;
	}

	for (const [k, v] of Object.entries(node)) {
		walk(v, path === '' ? k : `${path}.${k}`, acc);
	}
}

function bump(
	acc: Map<string, FieldAcc>,
	path: string,
	type: string,
	isNull: boolean,
): void {
	let a = acc.get(path);
	if (a === undefined) {
		a = { types: new Set(), nullCount: 0, totalCount: 0 };
		acc.set(path, a);
	}
	a.types.add(type);
	if (isNull) { a.nullCount++; }
	a.totalCount++;
}

function typeName(value: unknown): string {
	if (value === null) { return 'null'; }
	if (Array.isArray(value)) { return 'array'; }
	if (value instanceof Uint8Array) { return 'binary'; }
	return typeof value;
}
