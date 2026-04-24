/**
 * Driver barrel. Each driver module `registerDriver()`s at top-level
 * import time; pulling this module once at daemon boot is the
 * bootstrap.
 *
 * Phase 1 Round 1: Postgres, Redis (+valkey/keydb), CSV (+tsv).
 * Phase 1 Round 2: MySQL/MariaDB, SQLite, MongoDB, JSONL/NDJSON, JSON.
 * Phase 1 Round 3: MSSQL, Oracle, Cassandra, NATS (JetStream KV),
 *   Excel, Avro, Arrow/Feather, BSON, fixed-width.
 *
 * All 17 kinds of phase 1 land via this barrel.
 */

// RDBMS
import './pg.js';
import './mysql.js';
import './sqlite.js';
import './mssql.js';
import './oracle.js';
// KV
import './redis.js';
import './mongodb.js';
import './cassandra.js';
import './nats.js';
// File
import './csv.js';
import './jsonl.js';
import './json.js';
import './xlsx.js';
import './avro.js';
import './arrow.js';
import './bson.js';
import './fixed-width.js';

import { listRegisteredKinds } from '../registry.js';
import { getLogger } from '../../../shared/logger.js';

const log = getLogger('db-drivers');

export function registerBuiltinDataDrivers(): void {
	const kinds = listRegisteredKinds();
	log.info({ count: kinds.length, kinds: kinds.map(k => k.kind) }, 'data drivers registered');
}
