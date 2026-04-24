/**
 * Driver barrel. Each driver module `registerDriver()`s at top-level
 * import time; pulling this module once at daemon boot is the
 * bootstrap.
 *
 * Phase 1 Round 1 (landed): Postgres, Redis (+valkey/keydb), CSV (+tsv).
 * Phase 1 Round 2 (this round): MySQL/MariaDB, SQLite, MongoDB,
 *   JSONL/NDJSON, JSON.
 * Round 3 adds MSSQL / Oracle / Cassandra / NATS / Excel / Avro /
 *   Arrow / BSON / fixed-width.
 */

import './pg.js';
import './mysql.js';
import './sqlite.js';
import './redis.js';
import './mongodb.js';
import './csv.js';
import './jsonl.js';
import './json.js';

import { listRegisteredKinds } from '../registry.js';
import { getLogger } from '../../../shared/logger.js';

const log = getLogger('db-drivers');

export function registerBuiltinDataDrivers(): void {
	const kinds = listRegisteredKinds();
	log.info({ count: kinds.length, kinds: kinds.map(k => k.kind) }, 'data drivers registered');
}
