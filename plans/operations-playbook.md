# Operations playbook — insrc storage substrate

Phase 7.5 of [storage-migration-lmdb-lance.md](storage-migration-lmdb-lance.md).
Reference for diagnosing and recovering from storage-layer failures
in the LMDB + Lance substrate.

This doc describes the **target post-migration** stack:

- **LMDB** (via `lmdb-js`) at `~/.insrc/graph.lmdb` — graph + repos +
  plans + conversations + todos + config (single mmap'd file with
  20 sub-DBs, schema-versioned).
- **LanceDB** (via `@lancedb/lancedb`) at `~/.insrc/lance/` —
  entity / session / turn / config vector tables.
- **DuckDB** in-memory only — backs the data-driver `db_file_*` tools
  for CSV / Parquet / JSONL attaches; no persistent role.

## Daemon health: how to read `insrc daemon status`

```text
status:  running  (uptime 3h 12m)
queue:   0 job(s) pending
model:   ready
lmdb:    412 MiB on disk  (run 'insrc daemon compact' to reclaim freed pages)
repos:
  [ready   ]  /Users/me/work/foo  (last indexed: 2026-05-06 09:14)
  [ready   ]  /Users/me/work/bar  (last indexed: 2026-05-06 11:02)
```

| Line | Meaning | When to act |
|---|---|---|
| `status: running` | Daemon process is alive, IPC socket open. | If `not running`: `insrc daemon start`. |
| `queue: N job(s) pending` | Indexer queue depth. Each job is one repo full / partial index. | If N > 0 for hours: check daemon log at `~/.insrc/log/daemon.log` for stuck job. |
| `model: ready` / `pulling N%` | Ollama embedding model status. `pulling` is a one-shot bootstrap. | If `pulling` for > 1 h: check Ollama daemon. |
| `lmdb: <N> MiB` | LMDB env file size on disk. Inflates with deletes (free pages aren't returned to the OS). | After a `repo remove` on a large repo, run `insrc daemon compact` if the file looks oversized for your data. |
| `repos: [status]` | Per-repo status from the registry. `error` means the last index failed; daemon log has the stack trace. | If `error`: `insrc repo remove <path>` then `insrc repo add <path>` to re-index from clean. |

## Env-open error matrix

The LMDB env opens once per daemon lifetime. If `getGraphStore()`
throws, the daemon refuses to start until the underlying issue is
resolved. Each failure class is a typed subclass of `LmdbStoreError`
in [src/insrc/db/graph/store.ts](../src/insrc/db/graph/store.ts).

| Error class | Trigger | Recovery |
|---|---|---|
| `LmdbStoreLockConflict` | Another process (a previous daemon instance, or a stuck reader) still holds the env lock. | `insrc daemon stop` (graceful), or kill the orphan process and remove `~/.insrc/graph.lmdb-lock`. |
| `LmdbStoreCorrupted` | Both meta pages invalid (filesystem-level damage; LMDB never auto-corrupts under normal use). | **Restore from backup** (`insrc daemon backup` snapshots; replace `~/.insrc/graph.lmdb` with the snapshot). If no backup: `rm ~/.insrc/graph.lmdb*` and re-index from source — accept the data-loss for conversations / todos / config. |
| `LmdbStoreMapsizeTooSmall` | The file on disk is bigger than the configured mapsize (e.g. someone restored a backup that grew past the default 1024 GiB cap). | Set `INSRC_LMDB_MAPSIZE_GIB=<N>` to at least the file size (in GiB), then restart the daemon. |
| `LmdbStoreSchemaVersionMismatch` | Stored schema_version > expected. Means an older daemon is opening a file written by a newer daemon. | Upgrade the daemon. **Never silently downgrade** — older code can't reliably read newer rows. If downgrade is required: wipe the env and re-index from source. |
| `MigrationPathError` (during forward migration) | Stored schema_version < expected, but no chain of registered migrations reaches the target. | Restore from a backup taken at the older version, or wipe and re-index. Indicates either a deleted migration entry or a corrupt `meta.schema_version` value. |

The runtime catches each at env-open in [`getGraphStore()`](../src/insrc/db/graph/store.ts);
no auto-recovery is attempted because every recovery path involves
either user-acknowledged data loss or a config change.

## Backup and restore

### Hot backup (no daemon downtime)

```bash
insrc daemon backup ~/insrc-backups/2026-05-06
```

Snapshots both substrates while the daemon stays running:

- LMDB: single-file copy via `mdb_env_copy2` under a snapshot read
  txn. Concurrent writes during the backup are **not** in the
  snapshot — they'll appear in the running env but not the copy.
  Re-running the command overwrites the target idempotently.
- Lance: recursive `fs.cp` of the directory. Lance writes are
  versioned and commit a manifest last, so cp-while-open captures a
  coherent (possibly pre-write) version per table.

Output layout:

```
~/insrc-backups/2026-05-06/
  graph.lmdb       single LMDB env file (all sub-DBs)
  lance/           full Lance store directory tree
```

### Restore

1. Stop the daemon: `insrc daemon stop`.
2. Move the backup files into place:
   ```bash
   mv ~/.insrc/graph.lmdb ~/.insrc/graph.lmdb.broken
   mv ~/.insrc/lance      ~/.insrc/lance.broken
   cp ~/insrc-backups/2026-05-06/graph.lmdb ~/.insrc/graph.lmdb
   cp -R ~/insrc-backups/2026-05-06/lance   ~/.insrc/lance
   ```
3. Start the daemon: `insrc daemon start`.
4. Verify: `insrc daemon status`, then trigger a search to confirm
   reads work.
5. After at least one successful day of normal operation, delete the
   `.broken` directories.

### Backup cadence

There is no built-in scheduler for backups (yet). Recommended:

- Per-machine daily cron / launchd job that runs `insrc daemon
  backup` to a date-stamped path.
- Retain the last 7 daily snapshots + 4 weekly snapshots; older
  ones can be pruned. Total disk overhead scales with index size
  (typically << 1× the running env per snapshot since cp is sparse-
  aware and Lance has heavy file overlap across snapshots).

## Compaction (offline page reclamation)

LMDB never returns freed pages to the OS — they stay in the file's
free-list, available for reuse by future writes. After a large delete
burst (e.g. `insrc repo remove` on a 100k-entity repo, or a
conversation-compaction run that drops thousands of archive turns),
the file size on disk stays inflated until the next compact.

```bash
# 1. Confirm the daemon is idle (queue depth 0).
insrc daemon status

# 2. Compact.
insrc daemon compact
```

Output:

```
compact complete in 4.32 s
  before: 412 MiB
  after:  118 MiB
  saved:  294 MiB (71.4%)
```

Refused if the indexer queue is non-empty or processing — wait for
indexing to drain, then retry. Internally the operation:

1. Writes a defragged copy via `mdb_env_copy2(MDB_CP_COMPACT)`.
2. Closes the env.
3. Atomically renames original → `.bak`, `.compact` → original.
4. Re-opens the env.
5. Removes the `.bak` on success.

If the rename step fails, the `.bak` survives and the original is
restored where possible. Manual recovery is then `mv ~/.insrc/graph.lmdb.bak ~/.insrc/graph.lmdb`.

## Stale reader slots

Killed daemon processes (SIGKILL, OOM, kernel panic) leave their
reader-table slot occupied in `~/.insrc/graph.lmdb-lock`. The slot
pins the writer's free-list — new writes can't reclaim pages that
the killed reader's snapshot referenced — and bloats the file.

The daemon handles this automatically:

- **Boot**: `runReaderCheck('startup')` runs immediately after env
  open. Stale slots (PIDs that no longer exist) are cleared.
- **Periodic**: every 5 minutes, `runReaderCheck('periodic')` re-runs
  defensively for slots left over by a daemon process that died
  between the boot sweep and now.

Manual sweep: there is no separate CLI; restarting the daemon is
sufficient. If the lock file itself is corrupted, remove
`~/.insrc/graph.lmdb-lock` while the daemon is stopped — LMDB
recreates it on the next open.

## Schema migrations

Schema version is stored at `meta.schema_version`. The runner in
[src/insrc/db/graph/migrations.ts](../src/insrc/db/graph/migrations.ts)
applies registered forward migrations at env-open when stored <
expected.

- **v1 → v1**: no-op (current state; v1 is the first version).
- **Future bumps**: each migration is `{from, to, description, run}`;
  runs inside a single write txn that also advances
  `meta.schema_version` to `to`. A crash mid-migration leaves the env
  at a coherent intermediate version that the next boot resumes from.

Diagnosing failures:

| Symptom | Cause | Recovery |
|---|---|---|
| Daemon refuses to start with `LmdbStoreSchemaVersionMismatch` | Stored > expected: older daemon binary against newer env. | Upgrade daemon. |
| Daemon refuses to start with `MigrationPathError: ... starting at N, target M` | Registry has gaps; runner can't reach target. | Restore from a pre-mismatch backup, or wipe + re-index. Indicates a registry bug — file an issue. |
| Daemon starts but logs `forward migrations complete applied=K` | Normal: K migrations were applied at this boot. | None. |

## Page corruption mitigation

LMDB checksums the **meta page** (so torn-write at the meta level is
detected and rolled back) but **not data pages**. A bit-flip in a
data page is silent until a query reads it — at which point you'll
see decoded rows with garbage fields, not an exception. Two
defenses:

1. **Recommend a checksumming filesystem** for the directory holding
   `~/.insrc/graph.lmdb`. macOS ships APFS (defaults to checksum on);
   Linux options are ZFS or btrfs. Filesystem-level checksums catch
   bit-flips at read time and either repair (with redundancy) or
   surface them as I/O errors.
2. **Backups are the second line** — if a flipped bit lands in your
   data and isn't caught, the daily snapshot from before the flip is
   what you restore from.

ext4 / NTFS / FAT-family filesystems have no read-time data
checksums; if you must run on those, increase backup frequency and
treat suspect query results as a corruption signal (verify against a
known-good state).

## Lance considerations

The Lance store is a directory tree of versioned data files. Writes
commit a manifest atomically, so:

- A `cp -R` of `~/.insrc/lance/` while the daemon is writing
  captures either the pre-write or post-write version per table —
  never a torn write. Worst case the snapshot is slightly stale.
- A killed daemon leaves no lock file; the next boot opens cleanly.
- Lance does its own background compaction; you don't need to run
  anything equivalent to `daemon compact` for the vector store.
- The `_transactions/` subdirectory contains short-lived transaction
  marker files. They appear and disappear quickly; treat them as
  invisible.

If the Lance directory is corrupted (rare; usually filesystem-
level), restoration is the same as LMDB: replace from backup, or
delete the directory and accept embedding-loss (the indexer
re-embeds entities lazily on the next index pass).

### Storage budget — plan for ~10–13 GiB per million indexed code entities

The on-disk size of `~/.insrc/lance/entity_vec.lance/` scales roughly
linearly with the number of indexed code entities. From the Phase 9.1
full-tier benchmark run:

| Layer | Size at 1M entities |
|---|---:|
| Raw vector data (1024 dims × 4 B per row) | ~3.8 GiB |
| Lance row metadata + filter columns (id / repo / kind / artifact) | ~6 GiB |
| HNSW index files (Scalar Quantization, built once at end-of-full-index) | ~2.5 GiB |
| **Total** | **~12.3 GiB** |

What this means in practice:

- A 100 k-entity repo lives in ~1–1.5 GiB. Trivially small.
- A 200 k-entity repo (a typical large project) lives in ~2.5 GiB. Fine.
- A 1 M-entity repo (large monorepo) lives in ~12 GiB. Workable but
  not free — make sure `$HOME` has the headroom before adding the
  repo.
- Reading the daemon log: the `entity_vec HNSW index built` line
  emitted at end-of-full-index is the moment Lance writes the
  ~2.5 GiB index. Expect a one-shot disk-write spike there.

Two operational levers if the size becomes a problem:

1. `insrc repo remove <path>` drops every entity belonging to that
   repo, including its Lance rows. Followed by `insrc daemon
   compact` to reclaim LMDB pages. Lance's own compaction reclaims
   the dropped vector rows on its next background pass.
2. The HNSW index variant is currently `hnswSq` (Scalar
   Quantization) — chosen for build speed and acceptable recall. If
   the index size becomes the dominant cost, switching to `hnswPq`
   (Product Quantization) in
   [`db/lance/entity-vec.ts:optimizeEntityVecIndex`](../src/insrc/db/lance/entity-vec.ts)
   gives ~2–4× index-size reduction at some recall cost. Not
   currently the default because the 51 ms p99 search latency
   already meets the perf target.

> **Note**: the LMDB graph file (`~/.insrc/graph.lmdb`) is much
> smaller — at 1 M entities + ~10 M edges it's ~60 MiB. Lance
> dominates the storage budget; the LMDB env is a rounding error
> next to it.

## Quick-reference command summary

| Command | What it does |
|---|---|
| `insrc daemon start` | Spawn the daemon in the background. |
| `insrc daemon stop` | Graceful shutdown via `daemon.shutdown` RPC. |
| `insrc daemon status` | Print health: uptime, queue depth, model state, LMDB size, registered repos. |
| `insrc daemon backup <dir>` | Hot-snapshot LMDB + Lance into `<dir>` while running. |
| `insrc daemon compact` | Reclaim freed LMDB pages via `mdb_env_copy2(MDB_CP_COMPACT)` + atomic swap. Requires idle queue. |

## See also

- [graph-storage-lmdb.md](graph-storage-lmdb.md) — design doc for the
  custom graph layer.
- [storage-migration-lmdb-lance.md](storage-migration-lmdb-lance.md)
  — execution-side migration plan; this file is Phase 7.5.
- `~/.insrc/log/daemon.log` — running daemon log (rotated by
  `pino-roll`); first place to look on an unexplained failure.
