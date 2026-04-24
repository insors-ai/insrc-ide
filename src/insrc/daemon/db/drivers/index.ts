/**
 * Driver barrel. Each driver module `registerDriver()`s at top-level
 * import time; pulling this module once at daemon boot is the
 * bootstrap.
 *
 * Phase 1 Round 1: Postgres, Redis (+valkey/keydb), CSV (+tsv).
 * Round 2 adds MySQL / SQLite / MongoDB / JSON / JSONL.
 * Round 3 adds MSSQL / Oracle / Cassandra / NATS / Excel / Avro /
 * Arrow / BSON / fixed-width.
 */

import './pg.js';
import './redis.js';
import './csv.js';

import { listRegisteredKinds } from '../registry.js';
import { getLogger } from '../../../shared/logger.js';

const log = getLogger('db-drivers');

export function registerBuiltinDataDrivers(): void {
	const kinds = listRegisteredKinds();
	log.info({ count: kinds.length, kinds: kinds.map(k => k.kind) }, 'data drivers registered');
}
