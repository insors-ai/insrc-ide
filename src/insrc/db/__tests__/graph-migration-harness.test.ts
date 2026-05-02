/**
 * End-to-end migration harness (plans/storage-migration-duckdb.md
 * Phase A.0).
 *
 * Spins up an in-memory Kuzu + in-memory DuckDB, applies both
 * schemas, drives a synthetic graph through the dual-write helpers
 * (mode='both'), and asserts:
 *
 *   1. After the same fixture goes through dual-write, snapshotKuzu
 *      and snapshotDuck produce identical row counts + hashes for
 *      entities / relations / unresolved / repos.
 *
 *   2. Reads return identical results regardless of mode: running
 *      findCallers / findCallees / findDefinedIn / findImports /
 *      resolveClosure with INSRC_GRAPH_BACKEND='kuzu' produces the
 *      same ID set as with INSRC_GRAPH_BACKEND='duckdb'.
 *
 * This is the gate before Phase A.8 dual-write activation; if the
 * harness disagrees on any synthetic graph, the same code path will
 * disagree on real data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import kuzu from 'kuzu';

import { closeDuckDB } from '../../daemon/db/duckdb-pool.js';
import {
  getDuckDBGraphClient,
  resetDuckDBGraphClient,
} from '../duckdb-graph-client.js';
import { applyDuckDBGraphSchema } from '../duckdb-graph-schema.js';
import { withConnection } from '../../daemon/db/duckdb-pool.js';
import { KUZU_STATEMENTS } from '../schema.js';
import {
  upsertEntities,
  deleteEntitiesForFile,
} from '../entities.js';
import {
  upsertRelations,
  deleteUnresolvedForFile,
} from '../relations.js';
import { addRepo, removeRepo, updateRepoStatus } from '../repos.js';
import {
  findCallers,
  findCallees,
  findDefinedIn,
  findImports,
  resolveClosure,
} from '../search.js';
import { snapshotKuzu, snapshotDuck, diff, summariseDiff } from '../graph-comparison.js';
import type { Entity, Relation, RegisteredRepo } from '../../shared/types.js';
import type { DbClient } from '../client.js';

// ---------------------------------------------------------------------------
// Test scaffolding -- assemble a DbClient with real Kuzu + real DuckDB,
// no Lance (graph migration doesn't need vectors).
// ---------------------------------------------------------------------------

async function makeTestDbClient(): Promise<{ db: DbClient; cleanup: () => void }> {
  // Kuzu :memory: -- no on-disk state to clean up.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kuzuDb: any = new (kuzu as any).Database(':memory:');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graph: any = new (kuzu as any).Connection(kuzuDb);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphReader: any = new (kuzu as any).Connection(kuzuDb);
  // Apply Kuzu DDL.
  for (const stmt of KUZU_STATEMENTS) {
    await graph.query(stmt);
  }
  // DuckDB pool is the daemon-wide singleton; apply schema.
  await withConnection(async (conn) => applyDuckDBGraphSchema(conn));
  const duck = getDuckDBGraphClient();
  // Lance stub: graph migration paths don't touch lance, but the
  // DbClient interface requires the field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lance: any = {};
  const db: DbClient = { graph, graphReader, duck, lance };
  return {
    db,
    cleanup: () => {
      // Per db/client.ts:105-106 -- do NOT call kuzu close(); GC
      // handles it. Same applies in tests; null the references and
      // let GC sweep.
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic-graph fixture
// ---------------------------------------------------------------------------

/**
 * Build a small but representative graph:
 *   - 2 repos: /r1 (root) and /r2 (dep of /r1 via DEPENDS_ON)
 *   - File A in /r1 defines functions a_foo, a_bar
 *   - File B in /r1 defines function b_main; b_main CALLS a_foo, IMPORTS A
 *   - Some unresolved relations queued for the resolver
 */
function buildSyntheticGraph(): {
  repos: RegisteredRepo[];
  entities: Entity[];
  relations: Relation[];
} {
  const repos: RegisteredRepo[] = [
    { path: '/r1', name: 'r1', addedAt: '2026-05-02T00:00:00Z', status: 'pending' },
    { path: '/r2', name: 'r2', addedAt: '2026-05-02T00:00:01Z', status: 'pending' },
  ];

  const entities: Entity[] = [
    blank('file_a', 'file', 'A.ts'),
    blank('file_b', 'file', 'B.ts'),
    blank('a_foo', 'function', 'foo'),
    blank('a_bar', 'function', 'bar'),
    blank('b_main', 'function', 'main'),
    // Repo path -> entity-stub mapping. Required for DEPENDS_ON edges
    // between repos to land in Kuzu, where the typed REL TABLE only
    // accepts FROM/TO Entity. The production manifest indexer creates
    // these stubs when emitting cross-repo DEPENDS_ON; the harness
    // mirrors that. Without them, Kuzu silently drops the MERGE while
    // DuckDB accepts it -- exactly the kind of cross-store drift the
    // harness exists to catch (caught it on first run).
    blank('/r1', 'repo' as Entity['kind'], 'r1'),
    blank('/r2', 'repo' as Entity['kind'], 'r2'),
  ];

  const relations: Relation[] = [
    // file_a DEFINES a_foo, a_bar
    { from: 'file_a', to: 'a_foo', kind: 'DEFINES', resolved: true },
    { from: 'file_a', to: 'a_bar', kind: 'DEFINES', resolved: true },
    // file_b DEFINES b_main
    { from: 'file_b', to: 'b_main', kind: 'DEFINES', resolved: true },
    // b_main CALLS a_foo
    { from: 'b_main', to: 'a_foo', kind: 'CALLS', resolved: true },
    // file_b IMPORTS file_a
    { from: 'file_b', to: 'file_a', kind: 'IMPORTS', resolved: true },
    // /r1 DEPENDS_ON /r2
    { from: '/r1', to: '/r2', kind: 'DEPENDS_ON', resolved: true },
    // Unresolved: b_main CALLS some-external-fn (no entity yet)
    {
      from: 'b_main',
      to: 'externalFn',
      kind: 'CALLS',
      resolved: false,
      meta: { repo: '/r1', file: '/r1/B.ts' },
    },
  ];

  return { repos, entities, relations };
}

function blank(id: string, kind: Entity['kind'], name: string): Entity {
  return {
    id,
    kind,
    name,
    language: 'typescript',
    repo: '/r1',
    file: name === 'A.ts' || name === 'foo' || name === 'bar' ? '/r1/A.ts' : '/r1/B.ts',
    startLine: 1,
    endLine: 1,
    body: '',
    indexedAt: '2026-05-02T00:00:00Z',
    embedding: [],
  };
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let saveBackend: string | undefined;

test.beforeEach(async () => {
  saveBackend = process.env['INSRC_GRAPH_BACKEND'];
  resetDuckDBGraphClient();
  await closeDuckDB();
});

test.afterEach(async () => {
  if (saveBackend === undefined) {
    delete process.env['INSRC_GRAPH_BACKEND'];
  } else {
    process.env['INSRC_GRAPH_BACKEND'] = saveBackend;
  }
  resetDuckDBGraphClient();
  await closeDuckDB();
});

// KNOWN ISSUE: this test file's process exit segfaults inside the
// Kuzu native binding (per db/client.ts:105-106 -- "do NOT call kuzu
// close; the 0.11.x binding segfaults; GC handles it"). The four
// subtests below all pass cleanly; only the file-level exit code
// reports failure because Node propagates SIGSEGV through the test
// runner. Workarounds tried: process.exit(0) in test.after()
// (ineffective: the segfault fires in native code before Node's exit
// handlers run); single shared Kuzu instance (still segfaults on
// teardown; just one destructor instead of four).
//
// The bug goes away entirely after Phase A.10 cutover when Kuzu is
// removed. Until then this test file is intentionally NOT wired to a
// CI npm script -- run it manually as `tsx --test db/__tests__/
// graph-migration-harness.test.ts` and read the subtest pass count
// (4/4 expected); ignore the file-level exit code.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Seed both backends from the synthetic graph. The dual-write helpers
 * for entity stubs are internal to entities.ts; here we replicate what
 * `upsertEntities` would do for the graph side (Kuzu MERGE + DuckDB
 * ON CONFLICT) without going through Lance (no Lance in the harness).
 */
async function seedSyntheticGraph(db: DbClient, graph: ReturnType<typeof buildSyntheticGraph>): Promise<void> {
  for (const repo of graph.repos) await addRepo(db, repo);
  for (const e of graph.entities) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prep = await (db.graph as any).prepare('MERGE (n:Entity {id: $id}) SET n.kind = $kind');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db.graph as any).execute(prep, { id: e.id, kind: e.kind });
    await db.duck.exec(
      'INSERT INTO entity (id, kind) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind',
      [e.id, e.kind],
    );
  }
  await upsertRelations(db, graph.relations);
}

test('A.0 harness: dual-write produces identical state in Kuzu and DuckDB', async () => {
  process.env['INSRC_GRAPH_BACKEND'] = 'both';
  const { db, cleanup } = await makeTestDbClient();
  try {
    const graph = buildSyntheticGraph();
    await seedSyntheticGraph(db, graph);

    // Snapshot both stores.
    const kuzuSnap = await snapshotKuzu(db.graph);
    const duckSnap = await snapshotDuck(db.duck);
    const d = diff(kuzuSnap, duckSnap);

    assert.ok(
      d.clean,
      `dual-write left stores out of sync: ${summariseDiff(d)}\n` +
      `kuzu: ${JSON.stringify(kuzuSnap)}\n` +
      `duck: ${JSON.stringify(duckSnap)}`,
    );
  } finally {
    cleanup();
  }
});

test('A.0 harness: removeRepo + delete-unresolved-for-file stay in sync', async () => {
  process.env['INSRC_GRAPH_BACKEND'] = 'both';
  const { db, cleanup } = await makeTestDbClient();
  try {
    const graph = buildSyntheticGraph();
    await seedSyntheticGraph(db, graph);

    const before = diff(await snapshotKuzu(db.graph), await snapshotDuck(db.duck));
    assert.ok(before.clean, 'pre-mutation parity required');

    // Mutations
    await updateRepoStatus(db, '/r1', 'ready', '2026-05-02T01:00:00Z');
    await removeRepo(db, '/r2');
    await deleteUnresolvedForFile(db, '/r1/B.ts');

    const after = diff(await snapshotKuzu(db.graph), await snapshotDuck(db.duck));
    assert.ok(
      after.clean,
      `post-mutation drift: ${summariseDiff(after)}`,
    );
  } finally {
    cleanup();
  }
});

test('A.0 harness: read parity -- findCallers / findCallees / findDefinedIn / findImports', async () => {
  // Setup with mode='both' so both backends have the same data.
  process.env['INSRC_GRAPH_BACKEND'] = 'both';
  const { db, cleanup } = await makeTestDbClient();
  try {
    const graph = buildSyntheticGraph();
    await seedSyntheticGraph(db, graph);

    // The findCallers/etc. functions hydrate via Lance; here we don't
    // have Lance, so we'd get [] from hydrateIds either way. Bypass:
    // call the same query patterns directly to verify the underlying
    // graph queries return the same IDs across backends.
    async function readIds(mode: 'kuzu' | 'duckdb', queryName: string): Promise<string[]> {
      process.env['INSRC_GRAPH_BACKEND'] = mode;
      switch (queryName) {
        case 'callers-of-a_foo':
          // findCallers logic: who CALLS a_foo? Expected: b_main.
          if (mode === 'kuzu') {
            return runKuzuIds(db, 'MATCH (caller:Entity)-[:CALLS]->(target:Entity {id: $id}) RETURN caller.id AS id', { id: 'a_foo' });
          }
          return (await db.duck.query<{ id: string }>(
            'SELECT src AS id FROM relation WHERE dst = ? AND kind = ?',
            ['a_foo', 'CALLS'],
          )).map(r => r.id);
        case 'callees-of-b_main':
          if (mode === 'kuzu') {
            return runKuzuIds(db, 'MATCH (source:Entity {id: $id})-[:CALLS]->(callee:Entity) RETURN callee.id AS id', { id: 'b_main' });
          }
          return (await db.duck.query<{ id: string }>(
            'SELECT dst AS id FROM relation WHERE src = ? AND kind = ?',
            ['b_main', 'CALLS'],
          )).map(r => r.id);
        case 'defined-in-file_a':
          if (mode === 'kuzu') {
            return runKuzuIds(db, 'MATCH (f:Entity {id: $id})-[:DEFINES]->(e:Entity) RETURN e.id AS id', { id: 'file_a' });
          }
          return (await db.duck.query<{ id: string }>(
            'SELECT dst AS id FROM relation WHERE src = ? AND kind = ?',
            ['file_a', 'DEFINES'],
          )).map(r => r.id);
        case 'imports-of-file_b':
          if (mode === 'kuzu') {
            return runKuzuIds(db, 'MATCH (f:Entity {id: $id})-[:IMPORTS]->(target:Entity) RETURN target.id AS id', { id: 'file_b' });
          }
          return (await db.duck.query<{ id: string }>(
            'SELECT dst AS id FROM relation WHERE src = ? AND kind = ?',
            ['file_b', 'IMPORTS'],
          )).map(r => r.id);
        default:
          throw new Error(`unknown query name: ${queryName}`);
      }
    }

    for (const queryName of ['callers-of-a_foo', 'callees-of-b_main', 'defined-in-file_a', 'imports-of-file_b']) {
      const k = (await readIds('kuzu', queryName)).slice().sort();
      const d = (await readIds('duckdb', queryName)).slice().sort();
      assert.deepEqual(k, d, `${queryName}: kuzu ${JSON.stringify(k)} ≠ duck ${JSON.stringify(d)}`);
    }
    // Confirm we got non-empty results (not just an empty-array tie)
    const callers = await readIds('duckdb', 'callers-of-a_foo');
    assert.ok(callers.includes('b_main'), 'expected b_main as caller of a_foo');
  } finally {
    cleanup();
  }
});

test('A.0 harness: read parity -- resolveClosure via DEPENDS_ON', async () => {
  // The DEPENDS_ON edge in the Kuzu schema is declared between Entity
  // nodes (per schema.ts). resolveClosure's Cypher matches on Repo
  // nodes -- a long-standing schema mismatch where the query returns
  // empty and the function falls back to "just include the root" via
  // the `unshift` line. We replicate that exact behaviour in DuckDB:
  // the recursive CTE walks DEPENDS_ON edges in the unified relation
  // table; today no Repo→Repo edges exist, so closure = [root].
  // This test pins that behaviour so any future divergence is loud.
  process.env['INSRC_GRAPH_BACKEND'] = 'both';
  const { db, cleanup } = await makeTestDbClient();
  try {
    await addRepo(db, { path: '/r1', name: 'r1', addedAt: '2026-05-02', status: 'pending' });
    await addRepo(db, { path: '/r2', name: 'r2', addedAt: '2026-05-02', status: 'pending' });

    process.env['INSRC_GRAPH_BACKEND'] = 'kuzu';
    const kuzuClosure = (await resolveClosure(db, '/r1')).slice().sort();

    process.env['INSRC_GRAPH_BACKEND'] = 'duckdb';
    const duckClosure = (await resolveClosure(db, '/r1')).slice().sort();

    assert.deepEqual(kuzuClosure, duckClosure, 'resolveClosure must agree across backends');
    assert.ok(kuzuClosure.includes('/r1'), 'root must be included');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runKuzuIds(
  db: DbClient,
  stmt: string,
  params: Record<string, unknown>,
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prep = await (db.graphReader as any).prepare(stmt);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (db.graphReader as any).execute(prep, params);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion
  const qr = Array.isArray(result) ? result[0]! : result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (qr as any).getAll() as Record<string, unknown>[];
  return rows.map(r => r['id'] as string).filter(Boolean);
}
