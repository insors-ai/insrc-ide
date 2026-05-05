# Storage substrate scale-validation spike

Phase 0.4 of [plans/storage-migration-lmdb-lance.md](../../../../plans/storage-migration-lmdb-lance.md). **HARD GATE** before any caller code in Phase 1.x is rewired.

Goal: validate that LMDB and LanceDB don't fail at production scale -- the failure mode that bit DuckDB (148 GiB bloat + fatal checkpoint OOM at 2 GiB pool when indexing the Hadoop YARN repo).

## Running

From `src/insrc/`:

```sh
# all 7 tests, sequential, halt on first failure
npx tsx scripts/storage-spike/run-all.ts

# individual tests
npx tsx scripts/storage-spike/01-lmdb-bulk-write.ts
npx tsx scripts/storage-spike/02-lmdb-random-read.ts
npx tsx scripts/storage-spike/03-lmdb-closure.ts
npx tsx scripts/storage-spike/04-lance-bulk-write.ts
npx tsx scripts/storage-spike/05-lance-ann.ts
npx tsx scripts/storage-spike/06-lance-rebuild.ts
npx tsx scripts/storage-spike/07-hadoop-realistic.ts
```

Each test exits 0 on pass, non-zero on fail. The runner stops at first failure per HARD GATE policy.

## Tests + actual results (2026-05-05, darwin-arm64)

| # | Test | Plan expectation | Actual | Result |
|---|---|---|---|---|
| 1 | LMDB bulk-write 10M synthetic edges | < 5 min, < 10 GiB | 8.2 s, 129 MiB, peak RSS 266 MiB | PASS (37x faster, 79x smaller) |
| 2 | LMDB random reads (100k queries on 10M-edge env) | warm p99 < 1 ms, cold p99 < 10 ms | warm p99 0.003 ms, cold p99 0.007 ms | PASS (333x / 1400x faster) |
| 3 | LMDB BFS from 100 random roots | max < 5 s | max 16.3 ms (avg 1.8 ms) | PASS (300x faster) |
| 4 | Lance bulk-write 1M random 1024-dim vectors | < 30 min, < 10 GiB | 46.4 s, 3.84 GiB, peak RSS 661 MiB | PASS (39x faster) |
| 5 | Lance ANN throughput (10k queries on 1M-vector HNSW) | warm p99 < 50 ms | p99 1.53 ms (p50 0.86 ms) | PASS (33x faster) |
| 6 | Lance HNSW index rebuild on 1M vectors | completes, peak RSS < 4 GiB | 1.8 min, peak RSS 2.61 GiB | PASS (1.5 GiB headroom) |
| 7 | **Full Hadoop YARN indexing** -- the canonical workload that broke DuckDB | completes, peak RSS < 4 GiB | 11,996 files parsed; 401,993 entities + 389,998 edges; 111 MiB LMDB + 1,586 MiB Lance = 1.7 GiB total; peak RSS 1.12 GiB; 38.4 s end-to-end | PASS |

**Comparison to DuckDB on the same Hadoop workload**: 148 GiB on disk, fatal checkpoint OOM at 2 GiB pool, daemon required full restart. LMDB+Lance: 1.7 GiB on disk (87x reduction), peak RSS 1.12 GiB, completed in 38.4 s without intervention.

## What the spike does NOT cover

- **Linux x64 / linux arm64** -- per Phase 0.1 user decision, deferred to CI when set up. lmdb-js + LanceDB both ship prebuilt binaries for these platforms.
- **Real embedding generation through Ollama** -- the spike uses pseudorandom 1024-dim vectors. Embedder integration is exercised in Phase 3.x. The spike isolates substrate write/read throughput, not embedding quality.
- **Cross-file resolver Pass 2** -- the Hadoop test only writes parse-time-resolved edges (~390k). Cross-file resolved edges (CALLS, IMPORTS, INHERITS, IMPLEMENTS targeting symbols in other files) would add ~5-10x more, all of which exercise the same write path.
- **Multi-process concurrent access** -- daemon is single-writer by design.

## Files

- `spike-store.ts` -- minimal LMDB env wrapper + key codec helpers + monitoring helpers. Throw-away; deleted at end of Phase 0.4 (the real `db/graph/store.ts` lands in Phase 1.1).
- `01-..` to `07-..` -- individual tests.
- `run-all.ts` -- sequential runner.

## After the gate passes

Per the design doc Phase 7.3, this spike becomes a permanent CI regression suite (parameterised across scales; > 30% latency / RSS regression fails the build). For now it lives as a one-shot validation.
