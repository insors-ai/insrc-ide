/**
 * MongoDB driver (kind: `mongodb`).
 *
 * Lives in the KV family per the code-analyzer design doc (§13.1):
 * collections are schema-less documents. Keys are
 * `{ db, collection, _id }` objects; scan lists _ids via
 * `find({}).project({_id:1}).limit(N)`; sampleShape merges the
 * observed fields across the first N documents into a type tree.
 */

import { MongoClient } from 'mongodb';

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

const log = getLogger('db-mongodb');

interface CollectionRef {
	readonly db: string;
	readonly collection: string;
	readonly _id?: unknown;
}

function isCollectionRef(k: unknown): k is CollectionRef {
	return k !== null && typeof k === 'object'
		&& typeof (k as CollectionRef).db === 'string'
		&& typeof (k as CollectionRef).collection === 'string';
}

class MongoDriver implements KvDriver {
	readonly family = 'kv' as const;
	readonly kind = 'mongodb';

	private readonly client: MongoClient;

	constructor(
		readonly id: string,
		url: string,
		private readonly config: ConnectionConfig,
	) {
		this.client = new MongoClient(url, {
			serverSelectionTimeoutMS: SCAN_TIMEOUT_MS,
			connectTimeoutMS: SCAN_TIMEOUT_MS,
		});
	}

	async scan(opts: ScanOpts): Promise<KeyList> {
		assertNamespaceAllowed(this.config, opts);
		const limit = clampScanLimit(opts.limit);
		const target = requireCollectionTarget(opts);

		await this.client.connect();
		const docs = await this.client.db(target.db).collection(target.collection)
			.find({}, { projection: { _id: 1 } })
			.limit(limit + 1)
			.toArray();

		const keys = docs.slice(0, limit).map(d => ({
			db: target.db,
			collection: target.collection,
			_id: d._id,
		}));
		return { keys, truncated: docs.length > limit };
	}

	async get(key: string | Readonly<Record<string, unknown>>): Promise<KvValue> {
		if (!isCollectionRef(key)) {
			throw new Error(
				`data-driver: mongodb keys must be { db, collection, _id }; got ${JSON.stringify(key)}`,
			);
		}
		await this.client.connect();
		const doc = await this.client.db(key.db).collection(key.collection)
			.findOne({ _id: key._id } as never);
		if (doc === null) {
			return { key, value: null, type: 'null' };
		}
		return { key, value: doc, type: 'object' };
	}

	async sampleShape(opts: ScanOpts): Promise<ShapeReport> {
		assertNamespaceAllowed(this.config, opts);
		const limit = clampSampleShapeLimit(opts.limit);
		const target = requireCollectionTarget(opts);

		await this.client.connect();
		const docs = await this.client.db(target.db).collection(target.collection)
			.find({}).limit(limit).toArray();
		return inferShape(docs);
	}

	async close(): Promise<void> {
		await this.client.close().catch((err: Error) => {
			log.warn({ id: this.id, err: err.message }, 'mongo close failed');
		});
	}
}

/**
 * Mongo targets live on `prefix` (for scan / sampleShape) as
 * `"<db>.<collection>"`. We don't use `pattern` for mongo -- there
 * are no wildcard matches on collection names at read time.
 */
function requireCollectionTarget(opts: ScanOpts): { db: string; collection: string } {
	const raw = opts.prefix ?? opts.pattern;
	if (raw === undefined) {
		throw new Error('data-driver: mongodb requires prefix="<db>.<collection>"');
	}
	const dot = raw.indexOf('.');
	if (dot < 1 || dot === raw.length - 1) {
		throw new Error(`data-driver: mongodb prefix must be "<db>.<collection>"; got '${raw}'`);
	}
	const db = raw.slice(0, dot);
	const collection = raw.slice(dot + 1);
	if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(db) || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(collection)) {
		throw new Error(`data-driver: mongodb target contains invalid characters: '${raw}'`);
	}
	return { db, collection };
}

// ---------------------------------------------------------------------------

registerDriver({
	kind: 'mongodb',
	family: 'kv',
	factory: async (config: ConnectionConfig) => {
		if (config.url === undefined) {
			throw new Error(`data-driver: mongodb connection '${config.id}' missing url`);
		}
		return new MongoDriver(config.id, config.url, config);
	},
});
