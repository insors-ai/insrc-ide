/**
 * DuckDB-backed entities + search smoke tests (Phase B.6).
 *
 * Covers the migration from LanceDB to the entity table on the
 * storage pool: full-row upsert (with + without embeddings),
 * by-id / by-name / by-repo lookups, deleteEntitiesForFile cascade
 * (entities + relations), the unembedded sentinel, and vector ANN
 * search via array_distance + the HNSW index.
 *
 * Vector tests use a small dim (config-resolved, defaults to 2560
 * but tests build vectors of that exact length so they can bind
 * via arrayValue without per-test schema overrides).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeDuckDBStorage,
  setStorageDuckDBPath,
  withStorageConnection,
} from '../../daemon/db/duckdb-storage-pool.js';
import {
  getDuckDBGraphClient,
  resetDuckDBGraphClient,
} from '../duckdb-graph-client.js';
import { applyDuckDBGraphSchema } from '../duckdb-graph-schema.js';
import {
  upsertEntities,
  deleteEntitiesForFile,
  deleteEntitiesForRepo,
  getEntity,
  getEntitiesByIds,
  findEntitiesByName,
  listEntitiesForRepo,
  listUnembeddedEntities,
  updateEmbedding,
} from '../entities.js';
import { searchEntities, findCallers, findCallees, findDefinedIn, findImports } from '../search.js';
import { upsertRelations } from '../relations.js';
import type { DbClient } from '../client.js';
import type { Entity } from '../../shared/types.js';
import { loadConfig } from '../../agent/config.js';

const EMBEDDING_DIM = loadConfig().models.providers.local.embeddingDim;

test.beforeEach(async () => {
  resetDuckDBGraphClient();
  setStorageDuckDBPath(':memory:');
  await closeDuckDBStorage();
});
test.afterEach(async () => {
  resetDuckDBGraphClient();
  await closeDuckDBStorage();
});

async function setup(): Promise<DbClient> {
  await withStorageConnection(async (conn) => applyDuckDBGraphSchema(conn));
  return { duck: getDuckDBGraphClient() } satisfies DbClient;
}

const NOW = '2026-05-02T00:00:00Z';

function makeEntity(overrides: Partial<Entity> & { id: string; name: string }): Entity {
  return {
    id: overrides.id,
    kind: overrides.kind ?? 'function',
    name: overrides.name,
    language: overrides.language ?? 'typescript',
    repo: overrides.repo ?? '/repo',
    file: overrides.file ?? '/repo/src/x.ts',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 10,
    body: overrides.body ?? 'function x() {}',
    indexedAt: overrides.indexedAt ?? NOW,
    embedding: overrides.embedding ?? [],
    ...(overrides.embeddingModel !== undefined ? { embeddingModel: overrides.embeddingModel } : {}),
    ...(overrides.isExported  !== undefined ? { isExported:  overrides.isExported  } : {}),
    ...(overrides.isAsync     !== undefined ? { isAsync:     overrides.isAsync     } : {}),
    ...(overrides.isAbstract  !== undefined ? { isAbstract:  overrides.isAbstract  } : {}),
    ...(overrides.signature   !== undefined ? { signature:   overrides.signature   } : {}),
    ...(overrides.hash        !== undefined ? { hash:        overrides.hash        } : {}),
    ...(overrides.rootPath    !== undefined ? { rootPath:    overrides.rootPath    } : {}),
    ...(overrides.artifact    !== undefined ? { artifact:    overrides.artifact    } : {}),
  };
}

function unitVec(seed: number): number[] {
  // Deterministic, mostly-orthogonal embeddings: each entry uses a
  // different seed offset so cosine distance ranks them stably.
  const v = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    v[i] = Math.sin(seed * 0.7 + i * 0.0013);
  }
  return v;
}

test('upsertEntities + getEntity round-trip with optional fields', async () => {
  const db = await setup();
  await upsertEntities(db, [makeEntity({
    id: 'e1', name: 'foo', isExported: true, isAsync: true, signature: '(x: number) => void',
  })]);
  const back = await getEntity(db, 'e1');
  assert.equal(back?.name, 'foo');
  assert.equal(back?.isExported, true);
  assert.equal(back?.isAsync, true);
  assert.equal(back?.signature, '(x: number) => void');
  assert.deepEqual(back?.embedding, []);
});

test('ON CONFLICT updates fields rather than inserting a duplicate', async () => {
  const db = await setup();
  await upsertEntities(db, [makeEntity({ id: 'e1', name: 'foo', body: 'v1' })]);
  await upsertEntities(db, [makeEntity({ id: 'e1', name: 'foo', body: 'v2', isExported: true })]);
  const back = await getEntity(db, 'e1');
  assert.equal(back?.body, 'v2', 'body should be updated by upsert');
  assert.equal(back?.isExported, true);
  const all = await listEntitiesForRepo(db, '/repo');
  assert.equal(all.length, 1, 'should not duplicate');
});

test('getEntitiesByIds returns matched subset (no nulls; chunks 500-safe)', async () => {
  const db = await setup();
  await upsertEntities(db, [
    makeEntity({ id: 'e1', name: 'a' }),
    makeEntity({ id: 'e2', name: 'b' }),
  ]);
  const out = await getEntitiesByIds(db, ['e1', 'missing', 'e2']);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(e => e.id).sort(), ['e1', 'e2']);
});

test('findEntitiesByName respects kinds + repo + limit filters', async () => {
  const db = await setup();
  await upsertEntities(db, [
    makeEntity({ id: 'e1', name: 'foo', kind: 'function', repo: '/r1' }),
    makeEntity({ id: 'e2', name: 'foo', kind: 'class',    repo: '/r1' }),
    makeEntity({ id: 'e3', name: 'foo', kind: 'function', repo: '/r2' }),
  ]);
  const fns = await findEntitiesByName(db, ['foo'], { kinds: ['function'] });
  assert.deepEqual(fns.map(e => e.id).sort(), ['e1', 'e3']);
  const r1 = await findEntitiesByName(db, ['foo'], { repo: '/r1' });
  assert.deepEqual(r1.map(e => e.id).sort(), ['e1', 'e2']);
});

test('listUnembeddedEntities returns rows with embedding_model = ""', async () => {
  const db = await setup();
  await upsertEntities(db, [
    makeEntity({ id: 'e1', name: 'a', embeddingModel: 'qwen3' }),
    makeEntity({ id: 'e2', name: 'b' }),
  ]);
  const unembedded = await listUnembeddedEntities(db, '/repo');
  assert.deepEqual(unembedded.map(e => e.id), ['e2']);
});

test('updateEmbedding sets embedding + model on existing row', async () => {
  const db = await setup();
  await upsertEntities(db, [makeEntity({ id: 'e1', name: 'a' })]);
  const vec = unitVec(7);
  await updateEmbedding(db, 'e1', vec, 'qwen3-embedding:4b');
  const back = await getEntity(db, 'e1');
  assert.equal(back?.embedding.length, EMBEDDING_DIM);
  assert.equal(back?.embeddingModel, 'qwen3-embedding:4b');
});

test('deleteEntitiesForFile cascades to incident relations', async () => {
  const db = await setup();
  await upsertEntities(db, [
    makeEntity({ id: 'e1', name: 'a', file: '/repo/x.ts' }),
    makeEntity({ id: 'e2', name: 'b', file: '/repo/x.ts' }),
    makeEntity({ id: 'e3', name: 'c', file: '/repo/y.ts' }),
  ]);
  await upsertRelations(db, [
    { from: 'e1', to: 'e2', kind: 'CALLS', resolved: true },
    { from: 'e1', to: 'e3', kind: 'CALLS', resolved: true },
    { from: 'e3', to: 'e2', kind: 'CALLS', resolved: true },
  ]);
  await deleteEntitiesForFile(db, '/repo/x.ts');
  // e1, e2 gone -> only e3 left
  const left = await listEntitiesForRepo(db, '/repo');
  assert.deepEqual(left.map(e => e.id), ['e3']);
  // No relations should reference e1 or e2 anymore
  const dangling = await db.duck.query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM relation WHERE src IN ('e1','e2') OR dst IN ('e1','e2')",
  );
  assert.equal(Number(dangling[0]!.count), 0);
});

test('deleteEntitiesForRepo cascades same way as file delete', async () => {
  const db = await setup();
  await upsertEntities(db, [
    makeEntity({ id: 'r1e1', name: 'a', repo: '/r1' }),
    makeEntity({ id: 'r2e1', name: 'b', repo: '/r2' }),
  ]);
  await upsertRelations(db, [{ from: 'r1e1', to: 'r2e1', kind: 'CALLS', resolved: true }]);
  await deleteEntitiesForRepo(db, '/r1');
  const left = await listEntitiesForRepo(db, '/r2');
  assert.deepEqual(left.map(e => e.id), ['r2e1']);
});

test('searchEntities returns nearest by cosine; empty inputs return []', async () => {
  const db = await setup();
  // Three vectors -- e1 closest to query, e2 mid, e3 furthest
  const q = unitVec(1);
  const close = q;
  const mid   = unitVec(2);
  const far   = unitVec(50);
  await upsertEntities(db, [
    makeEntity({ id: 'e1', name: 'close', embedding: close, embeddingModel: 'qwen3' }),
    makeEntity({ id: 'e2', name: 'mid',   embedding: mid,   embeddingModel: 'qwen3' }),
    makeEntity({ id: 'e3', name: 'far',   embedding: far,   embeddingModel: 'qwen3' }),
  ]);

  const top = await searchEntities(db, q, ['/repo'], 2, 'all');
  assert.equal(top.length, 2);
  assert.equal(top[0]!.id, 'e1', 'closest should rank first');

  // Empty closure -> []
  assert.deepEqual(await searchEntities(db, q, [], 5, 'all'), []);
  // Empty query vector -> []
  assert.deepEqual(await searchEntities(db, [], ['/repo'], 5, 'all'), []);
});

test('searchEntities filter=code/artifact narrows by `artifact` flag', async () => {
  const db = await setup();
  const q = unitVec(1);
  await upsertEntities(db, [
    makeEntity({ id: 'code1', name: 'a', embedding: q, embeddingModel: 'qwen3', artifact: false }),
    makeEntity({ id: 'art1',  name: 'b', embedding: q, embeddingModel: 'qwen3', artifact: true  }),
  ]);
  const codeOnly = await searchEntities(db, q, ['/repo'], 5, 'code');
  assert.deepEqual(codeOnly.map(e => e.id), ['code1']);
  const artOnly = await searchEntities(db, q, ['/repo'], 5, 'artifact');
  assert.deepEqual(artOnly.map(e => e.id), ['art1']);
});

test('upsertEntities collapses intra-batch duplicate ids (last-wins)', async () => {
  // The HNSW index wrapper rejects duplicate keys in a single VALUES
  // clause BEFORE ON CONFLICT can fire, so an intra-batch duplicate
  // crashes DuckDB and invalidates the whole instance. The dedupe
  // path collapses duplicates to one row before the INSERT.
  // Last-wins matches the per-row ON CONFLICT DO UPDATE semantic --
  // the second occurrence of the same id replaces the first.
  const db = await setup();
  await upsertEntities(db, [
    makeEntity({ id: 'e1', name: 'foo', body: 'overload-1', startLine: 10 }),
    makeEntity({ id: 'e1', name: 'foo', body: 'overload-2', startLine: 20 }),
    makeEntity({ id: 'e1', name: 'foo', body: 'overload-3', startLine: 30 }),
    makeEntity({ id: 'e2', name: 'bar', body: 'distinct',   startLine: 40 }),
  ]);
  const all = await listEntitiesForRepo(db, '/repo');
  assert.equal(all.length, 2, 'duplicates should collapse to one row each');
  const e1 = all.find(e => e.id === 'e1');
  assert.equal(e1?.body, 'overload-3', 'last-wins on duplicate id');
  assert.equal(e1?.startLine, 30);
});

test('upsertRelations collapses intra-batch duplicate (src, dst, kind) edges', async () => {
  // Symmetric test for the relation path. Same root cause as the
  // entity dedupe: bulk INSERT with two rows sharing the primary
  // key can fail before ON CONFLICT fires.
  const db = await setup();
  await upsertEntities(db, [
    makeEntity({ id: 'a', name: 'a' }),
    makeEntity({ id: 'b', name: 'b' }),
  ]);
  await upsertRelations(db, [
    { from: 'a', to: 'b', kind: 'CALLS', resolved: true },
    { from: 'a', to: 'b', kind: 'CALLS', resolved: true },
    { from: 'a', to: 'b', kind: 'CALLS', resolved: true },
    { from: 'a', to: 'b', kind: 'CALLS', resolved: true },
  ]);
  const rows = await db.duck.query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM relation WHERE src = 'a' AND dst = 'b'",
  );
  assert.equal(Number(rows[0]!.count), 1);
});

test('module entities use ON CONFLICT DO NOTHING (idempotent across calls)', async () => {
  // Repro for the cross-call HNSW crash: every Java/Python/Go file that
  // imports `org.apache.hadoop.security` emits the same module stub
  // entity (id keyed off ('', '', 'module', name) -- empty repo + file).
  // The first INSERT lands cleanly; the second one previously crashed
  // DuckDB's experimental HNSW with "Duplicate keys not allowed in
  // high-level wrappers" via WAL replay. With DO NOTHING routing for
  // module-kind rows, the second insert is a no-op.
  const db = await setup();
  const stub: Entity = {
    id: 'mod1', kind: 'module', name: 'org.apache.hadoop.security',
    language: 'java', repo: '', file: '',
    startLine: 0, endLine: 0, body: '', indexedAt: NOW, embedding: [],
  };
  await upsertEntities(db, [stub]);                       // first sighting
  await upsertEntities(db, [stub]);                       // second sighting (different file in real life)
  await upsertEntities(db, [stub, stub, stub]);           // dedup + DO NOTHING

  const rows = await db.duck.query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM entity WHERE id = 'mod1'",
  );
  assert.equal(Number(rows[0]!.count), 1, 'module stub should land exactly once');
});

test('non-module entities still UPDATE on conflict (re-parse refreshes body)', async () => {
  // Make sure the DO NOTHING route didn't accidentally fire for non-stub
  // kinds. A function entity inserted twice with different bodies should
  // end up with the second body (DO UPDATE semantics, last-wins).
  const db = await setup();
  await upsertEntities(db, [makeEntity({ id: 'f1', name: 'foo', body: 'first', startLine: 1 })]);
  await upsertEntities(db, [makeEntity({ id: 'f1', name: 'foo', body: 'second', startLine: 99 })]);

  const all = await listEntitiesForRepo(db, '/repo');
  const f1 = all.find(e => e.id === 'f1');
  assert.equal(f1?.body, 'second', 'non-module entities still get DO UPDATE');
  assert.equal(f1?.startLine, 99);
});

test('upsertEntities handles a chunk-spanning batch with intra-chunk duplicates', async () => {
  // Build > ENTITY_BULK_CHUNK (100) entities with 5 distinct ids
  // each repeated 30+ times. After dedup we expect exactly 5 rows
  // and no DuckDB-level error (the HNSW wrapper would crash on the
  // first chunk if dedup didn't fire).
  const db = await setup();
  const batch: Entity[] = [];
  for (let i = 0; i < 150; i++) {
    const ord = i % 5;  // 5 distinct ids cycling 30 times each
    batch.push(makeEntity({
      id: `e${ord}`,
      name: `entity-${ord}`,
      body: `iteration-${i}`,
      startLine: i,
    }));
  }
  await upsertEntities(db, batch);
  const all = await listEntitiesForRepo(db, '/repo');
  assert.equal(all.length, 5);
  // Last occurrence of each id is the one with highest iteration --
  // for id 'e0' that's i=145 (since 145 % 5 == 0).
  const e0 = all.find(e => e.id === 'e0');
  assert.equal(e0?.body, 'iteration-145');
  assert.equal(e0?.startLine, 145);
});

test('1-hop graph queries via the entity table return hydrated rows', async () => {
  const db = await setup();
  await upsertEntities(db, [
    makeEntity({ id: 'caller', name: 'caller' }),
    makeEntity({ id: 'callee', name: 'callee' }),
    makeEntity({ id: 'fileA', kind: 'file', name: 'A.ts' }),
    makeEntity({ id: 'fileB', kind: 'file', name: 'B.ts' }),
  ]);
  await upsertRelations(db, [
    { from: 'caller', to: 'callee', kind: 'CALLS',   resolved: true },
    { from: 'fileA',  to: 'caller',  kind: 'DEFINES', resolved: true },
    { from: 'fileA',  to: 'fileB',   kind: 'IMPORTS', resolved: true },
  ]);
  const callees = await findCallees(db, 'caller');
  assert.deepEqual(callees.map(e => e.name), ['callee']);
  const callers = await findCallers(db, 'callee');
  assert.deepEqual(callers.map(e => e.name), ['caller']);
  const defined = await findDefinedIn(db, 'fileA');
  assert.deepEqual(defined.map(e => e.name), ['caller']);
  const imports = await findImports(db, 'fileA');
  assert.deepEqual(imports.map(e => e.name), ['B.ts']);
});
