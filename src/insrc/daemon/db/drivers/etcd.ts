/**
 * etcd v3 driver (kind: `etcd`).
 *
 * Hierarchical-path KV store. The native idiom is range queries
 * (everything under a prefix), which maps cleanly onto our `prefix`
 * scan + `get` shapes. `pattern` is intentionally NOT supported --
 * etcd has no glob; users must supply `prefix`.
 *
 * Connection config:
 *   options.hosts: ['http://localhost:2379']  (required)
 *   options.user, options.password            (optional auth)
 */

import { Etcd3 } from 'etcd3';
import type { IOptions as Etcd3Options } from 'etcd3';

import { getLogger } from '../../../shared/logger.js';
import type {
	ConnectionConfig,
	KvDriver,
	KeyList,
	KvValue,
	ScanOpts,
	ShapeReport,
} from '../../../shared/db-driver.js';
import { registerDriver } from '../registry.js';
import {
	SCAN_TIMEOUT_MS,
	assertNamespaceAllowed,
	clampSampleShapeLimit,
	clampScanLimit,
} from './kv-common.js';
import { inferShape } from './shape-common.js';

const log = getLogger('db-etcd');

class EtcdDriver implements KvDriver {
	readonly family = 'kv' as const;
	readonly kind = 'etcd';

	private readonly client: Etcd3;

	constructor(
		readonly id: string,
		etcdOpts: Etcd3Options,
		private readonly config: ConnectionConfig,
	) {
		this.client = new Etcd3(etcdOpts);
	}

	async scan(opts: ScanOpts): Promise<KeyList> {
		assertNamespaceAllowed(this.config, opts);
		const limit = clampScanLimit(opts.limit);
		if (opts.pattern !== undefined && opts.prefix === undefined) {
			throw new Error(
				`data-driver: etcd does not support pattern matches; use prefix instead`,
			);
		}
		const prefix = opts.prefix ?? '';
		const keys = await this.client.getAll().prefix(prefix).keys()
			.then(arr => arr.slice(0, limit));
		// etcd's getAll() returns up to 1000 by default; we slice to
		// `limit` and assume truncation if we hit it exactly. A more
		// precise check would re-page; phase-5 leaves that to a
		// follow-up.
		return { keys, truncated: keys.length >= limit };
	}

	async get(key: string | Readonly<Record<string, unknown>>): Promise<KvValue> {
		if (typeof key !== 'string') {
			throw new Error(`data-driver: etcd keys are plain strings; got ${typeof key}`);
		}
		const raw = await this.client.get(key).string();
		if (raw === null) { return { key, value: null, type: 'null' }; }
		try {
			const parsed = JSON.parse(raw);
			if (parsed === null) { return { key, value: null, type: 'null' }; }
			if (Array.isArray(parsed)) { return { key, value: parsed, type: 'array' }; }
			switch (typeof parsed) {
				case 'object':  return { key, value: parsed, type: 'object' };
				case 'number':  return { key, value: parsed, type: 'number' };
				case 'boolean': return { key, value: parsed, type: 'boolean' };
				case 'string':  return { key, value: parsed, type: 'string' };
			}
		} catch { /* not JSON */ }
		return { key, value: raw, type: 'string' };
	}

	async sampleShape(opts: ScanOpts): Promise<ShapeReport> {
		assertNamespaceAllowed(this.config, opts);
		const limit = clampSampleShapeLimit(opts.limit);
		const prefix = opts.prefix ?? '';
		const all = await this.client.getAll().prefix(prefix).strings();
		const slice = Object.values(all).slice(0, limit);
		const decoded: unknown[] = [];
		for (const v of slice) {
			try { decoded.push(JSON.parse(v)); }
			catch { decoded.push(v); }
		}
		return inferShape(decoded);
	}

	async close(): Promise<void> {
		try { this.client.close(); }
		catch (err) { log.warn({ id: this.id, err: (err as Error).message }, 'etcd close failed'); }
	}
}

// ---------------------------------------------------------------------------

registerDriver({
	kind: 'etcd',
	family: 'kv',
	factory: async (config: ConnectionConfig) => {
		const opts = (config.options ?? {}) as Record<string, unknown>;
		const hosts = Array.isArray(opts['hosts'])
			? opts['hosts'].filter((x): x is string => typeof x === 'string')
			: undefined;
		if (hosts === undefined || hosts.length === 0) {
			throw new Error(
				`data-driver: etcd connection '${config.id}' needs options.hosts: string[]`,
			);
		}
		const etcdOpts: Etcd3Options = { hosts, dialTimeout: SCAN_TIMEOUT_MS };
		if (typeof opts['user'] === 'string' && typeof opts['password'] === 'string') {
			etcdOpts.auth = {
				username: opts['user'],
				password: opts['password'],
			};
		}
		return new EtcdDriver(config.id, etcdOpts, config);
	},
});
