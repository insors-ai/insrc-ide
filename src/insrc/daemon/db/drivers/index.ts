/**
 * Driver barrel. Each driver module `registerDriver()`s at top-level
 * import time; pulling this module once at daemon boot is the
 * bootstrap.
 *
 * Phase 1 Round 1: Postgres, Redis (+valkey/keydb), CSV (+tsv).
 * Phase 1 Round 2: MySQL/MariaDB, SQLite, MongoDB, JSONL/NDJSON, JSON.
 * Phase 1 Round 3: MSSQL, Oracle, Cassandra, NATS (JetStream KV),
 *   Excel, Avro, Arrow/Feather, BSON, fixed-width.
 * Phase 5:        CockroachDB (pg-compatible), ClickHouse, DynamoDB,
 *   etcd, Memcached (limited), Parquet.
 *
 * 23 distinct kinds total (17 phase 1 + 6 phase 5).
 */

// RDBMS
import './pg.js';            // postgres + cockroachdb
import './mysql.js';         // mysql + mariadb
import './sqlite.js';
import './mssql.js';
import './oracle.js';
import './clickhouse.js';
// KV
import './redis.js';         // redis + valkey + keydb
import './mongodb.js';
import './cassandra.js';
import './nats.js';
import './dynamodb.js';
import './etcd.js';
import './memcached.js';
// File -- bespoke per-format drivers. Kept registered first so
// non-native formats (xlsx / avro / bson / fixed-width) keep their
// implementations until the Phase 2 converters land. Native formats
// (csv / tsv / jsonl / ndjson / json / parquet / arrow / feather)
// are overridden by the consolidated DuckDB-backed driver imported
// last in this list.
import './csv.js';           // csv + tsv         (overridden by duckdb-file)
import './jsonl.js';         // jsonl + ndjson    (overridden by duckdb-file)
import './json.js';          //                   (overridden by duckdb-file)
import './xlsx.js';          // bespoke for now -- Phase 2.5 converter
import './avro.js';          // bespoke for now -- Phase 2.2 converter
import './arrow.js';         // arrow + feather   (overridden by duckdb-file)
import './bson.js';          // bespoke for now -- Phase 2.3 converter
import './fixed-width.js';   // bespoke for now -- Phase 2.4 converter
import './parquet.js';       //                   (overridden by duckdb-file)
// Phase 1 of plans/data-driver-duckdb-files.md: consolidated
// DuckDB-backed driver for native file kinds. Imported LAST so its
// `registerDriver` calls overwrite the bespoke registrations above.
import './duckdb-file.js';

import { listRegisteredKinds } from '../registry.js';
import { getLogger } from '../../../shared/logger.js';

const log = getLogger('db-drivers');

export function registerBuiltinDataDrivers(): void {
	const kinds = listRegisteredKinds();
	log.info({ count: kinds.length, kinds: kinds.map(k => k.kind) }, 'data drivers registered');
}
