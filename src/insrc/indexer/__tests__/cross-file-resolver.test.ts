/**
 * Tests for cross-file-resolver.ts -- the second pass over the graph.
 * See plans/cross-file-references.md §3.
 *
 * Integration-style: spins up a real Kuzu + LanceDB pair backed by
 * tmp directories, seeds the graph with synthetic entities + relations,
 * runs the resolver, and asserts the graph state reflects the expected
 * resolutions.
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PATHS } from '../../shared/paths.js';
import { getDb, initDb, closeDb } from '../../db/client.js';
import { upsertEntities } from '../../db/entities.js';
import { upsertRelations } from '../../db/relations.js';
import type { DbClients } from '../../db/client.js';
import type { Entity, Relation } from '../../shared/types.js';
import { makeEntityId } from '../parser/base.js';
import { runCrossFileResolver } from '../cross-file-resolver.js';
import { detectSourceRoots } from '../source-roots.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpHome:  string;
let origGraph: string;
let origLance: string;
let db: DbClients;

before(async () => {
	tmpHome = mkdtempSync(join(tmpdir(), 'insrc-cfr-'));
	origGraph = PATHS.graph;
	origLance = PATHS.lance;
	(PATHS as Record<string, string>)['graph'] = join(tmpHome, 'graph');
	(PATHS as Record<string, string>)['lance'] = join(tmpHome, 'lance');
	mkdirSync(join(tmpHome, 'lance'), { recursive: true });

	db = await getDb();
	await initDb(db);
});

after(async () => {
	await closeDb();
	(PATHS as Record<string, string>)['graph'] = origGraph;
	(PATHS as Record<string, string>)['lance'] = origLance;
	try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkEntity(
	repo: string,
	file: string,
	kind: Entity['kind'],
	name: string,
	language: Entity['language'] = 'java',
	extra: Partial<Entity> = {},
): Entity {
	return {
		id:        makeEntityId(repo, file, kind, name),
		kind, name, language, repo, file,
		startLine: 0, endLine: 0,
		body: '', embedding: [], indexedAt: new Date().toISOString(),
		...extra,
	};
}

/**
 * Count edges in the `relation` table matching (src, dst, kind).
 * Replaces the old MATCH ... RETURN count(*) Cypher pattern.
 */
async function countEdge(src: string, dst: string, kind: string): Promise<number> {
	const rows = await db.duck.query<{ n: number }>(
		'SELECT COUNT(*)::INTEGER AS n FROM relation WHERE src = ? AND dst = ? AND kind = ?',
		[src, dst, kind],
	);
	return Number(rows[0]?.n ?? 0);
}

/** Count rows in `unresolved_relation` matching (from_entity, kind). */
async function countUnresolved(fromEntity: string, kind: string): Promise<number> {
	const rows = await db.duck.query<{ n: number }>(
		'SELECT COUNT(*)::INTEGER AS n FROM unresolved_relation WHERE from_entity = ? AND kind = ?',
		[fromEntity, kind],
	);
	return Number(rows[0]?.n ?? 0);
}

/** Count all relations of a given kind. */
async function countAllOfKind(kind: string): Promise<number> {
	const rows = await db.duck.query<{ n: number }>(
		'SELECT COUNT(*)::INTEGER AS n FROM relation WHERE kind = ?',
		[kind],
	);
	return Number(rows[0]?.n ?? 0);
}

/** Fetch unresolved-relation rows for a fromEntity + kind, returning meta + raw_to. */
async function listUnresolvedRows(fromEntity: string, kind: string): Promise<{ rawTo: string; meta: string }[]> {
	const rows = await db.duck.query<{ raw_to: string; meta: string }>(
		'SELECT raw_to, meta FROM unresolved_relation WHERE from_entity = ? AND kind = ?',
		[fromEntity, kind],
	);
	return rows.map(r => ({ rawTo: r.raw_to, meta: r.meta }));
}

// ---------------------------------------------------------------------------
// Test 1: INHERITS resolution -- two-file Java project, same package
// ---------------------------------------------------------------------------

describe('runCrossFileResolver -- INHERITS in same package', () => {
	let repo: string;

	before(async () => {
		// /repo/src/main/java/com/example/Foo.java
		// /repo/src/main/java/com/example/Bar.java
		repo = mkdtempSync(join(tmpdir(), 'insrc-cfr-mvn-'));
		const javaRoot = join(repo, 'src', 'main', 'java', 'com', 'example');
		mkdirSync(javaRoot, { recursive: true });
		writeFileSync(join(javaRoot, 'Foo.java'), 'package com.example;\npublic class Foo {}');
		writeFileSync(join(javaRoot, 'Bar.java'),
			'package com.example;\npublic class Bar extends Foo {}');

		const fooFile = join(javaRoot, 'Foo.java');
		const barFile = join(javaRoot, 'Bar.java');

		const fooFileEnt  = mkEntity(repo, fooFile, 'file', fooFile);
		const fooClassEnt = mkEntity(repo, fooFile, 'class', 'Foo');
		const barFileEnt  = mkEntity(repo, barFile, 'file', barFile);
		const barClassEnt = mkEntity(repo, barFile, 'class', 'Bar');

		await upsertEntities(db, [fooFileEnt, fooClassEnt, barFileEnt, barClassEnt]);

		// Bar INHERITS from raw 'Foo' -- the unresolved case the cross-file
		// resolver should fix. upsertRelation routes resolved:false rows to
		// the UnresolvedRelation table.
		const inheritsRel: Relation = {
			kind: 'INHERITS', from: barClassEnt.id, to: 'Foo', resolved: false,
			meta: { file: barFile, repo },
		};
		await upsertRelations(db, [inheritsRel]);
	});

	after(() => {
		try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it('resolves INHERITS Bar->Foo via same-package visibility', async () => {
		const sourceRoots = detectSourceRoots(repo);
		const result = await runCrossFileResolver({ db, repoRoot: repo, sourceRoots });

		assert.equal(result.resolved, 1, `expected 1 resolution; got: ${JSON.stringify(result)}`);
		assert.equal(result.ambiguous, 0);

		// Verify the typed REL edge now exists
		const barId = makeEntityId(repo, join(repo, 'src/main/java/com/example/Bar.java'), 'class', 'Bar');
		const fooId = makeEntityId(repo, join(repo, 'src/main/java/com/example/Foo.java'), 'class', 'Foo');
		const n = await countEdge(barId, fooId, 'INHERITS');
		assert.equal(n, 1);
	});
});

// ---------------------------------------------------------------------------
// Test 2: Module-stub IMPORTS rewiring -- Java import that maps to in-tree file
// ---------------------------------------------------------------------------

describe('runCrossFileResolver -- module-stub IMPORTS rewiring', () => {
	let repo: string;

	before(async () => {
		repo = mkdtempSync(join(tmpdir(), 'insrc-cfr-imports-'));
		const javaRoot = join(repo, 'src', 'main', 'java', 'com', 'example');
		mkdirSync(javaRoot, { recursive: true });
		writeFileSync(join(javaRoot, 'Foo.java'), 'package com.example;\npublic class Foo {}');
		// User.java is in a different package and explicitly imports Foo
		const userDir = join(repo, 'src', 'main', 'java', 'com', 'other');
		mkdirSync(userDir, { recursive: true });
		writeFileSync(join(userDir, 'User.java'),
			'package com.other;\nimport com.example.Foo;\npublic class User {}');

		const fooFile  = join(javaRoot, 'Foo.java');
		const userFile = join(userDir,  'User.java');

		const fooFileEnt = mkEntity(repo, fooFile, 'file', fooFile);
		const userFileEnt = mkEntity(repo, userFile, 'file', userFile);
		const moduleStub: Entity = {
			id: makeEntityId('', '', 'module', 'com.example.Foo'),
			kind: 'module', name: 'com.example.Foo', language: 'java',
			repo: '', file: '', startLine: 0, endLine: 0,
			body: '', embedding: [], indexedAt: new Date().toISOString(),
		};
		await upsertEntities(db, [fooFileEnt, userFileEnt, moduleStub]);

		// Resolved IMPORTS edge user-file -> module-stub (the parser emits this)
		const importsRel: Relation = {
			kind: 'IMPORTS', from: userFileEnt.id, to: moduleStub.id, resolved: true,
		};
		await upsertRelations(db, [importsRel]);
	});

	after(() => {
		try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it('rewires IMPORTS to point at the in-tree file entity', async () => {
		const sourceRoots = detectSourceRoots(repo);
		const result = await runCrossFileResolver({ db, repoRoot: repo, sourceRoots });
		assert.equal(result.importsRewired, 1, `expected 1 rewire; got: ${JSON.stringify(result)}`);

		const fooFileId  = makeEntityId(
			repo, join(repo, 'src/main/java/com/example/Foo.java'), 'file',
			join(repo, 'src/main/java/com/example/Foo.java'),
		);
		const userFileId = makeEntityId(
			repo, join(repo, 'src/main/java/com/other/User.java'), 'file',
			join(repo, 'src/main/java/com/other/User.java'),
		);

		// Verify file-target edge exists
		assert.equal(await countEdge(userFileId, fooFileId, 'IMPORTS'), 1);

		// Verify module-stub edge is gone
		const stubId = makeEntityId('', '', 'module', 'com.example.Foo');
		assert.equal(await countEdge(userFileId, stubId, 'IMPORTS'), 0);
	});
});

// ---------------------------------------------------------------------------
// Test 3: External-dep import -- module stays as stub when no in-tree match
// ---------------------------------------------------------------------------

describe('runCrossFileResolver -- external-dep stays as module stub', () => {
	let repo: string;

	before(async () => {
		repo = mkdtempSync(join(tmpdir(), 'insrc-cfr-ext-'));
		const javaRoot = join(repo, 'src', 'main', 'java', 'app');
		mkdirSync(javaRoot, { recursive: true });
		writeFileSync(join(javaRoot, 'App.java'),
			'package app;\nimport org.springframework.boot.SpringApplication;\npublic class App {}');

		const appFile = join(javaRoot, 'App.java');
		const appFileEnt = mkEntity(repo, appFile, 'file', appFile);
		const moduleStub: Entity = {
			id: makeEntityId('', '', 'module', 'org.springframework.boot.SpringApplication'),
			kind: 'module', name: 'org.springframework.boot.SpringApplication', language: 'java',
			repo: '', file: '', startLine: 0, endLine: 0,
			body: '', embedding: [], indexedAt: new Date().toISOString(),
		};
		await upsertEntities(db, [appFileEnt, moduleStub]);
		await upsertRelations(db, [{
			kind: 'IMPORTS', from: appFileEnt.id, to: moduleStub.id, resolved: true,
		}]);
	});

	after(() => {
		try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it('leaves the module-stub edge alone for external deps', async () => {
		const sourceRoots = detectSourceRoots(repo);
		const result = await runCrossFileResolver({ db, repoRoot: repo, sourceRoots });
		assert.equal(result.importsRewired, 0,
			`expected no rewires for external deps; got: ${JSON.stringify(result)}`);

		const stubId = makeEntityId('', '', 'module', 'org.springframework.boot.SpringApplication');
		const appFileId = makeEntityId(
			repo, join(repo, 'src/main/java/app/App.java'), 'file',
			join(repo, 'src/main/java/app/App.java'),
		);
		assert.equal(await countEdge(appFileId, stubId, 'IMPORTS'), 1);
	});
});

// ---------------------------------------------------------------------------
// Test 4: CALLS resolution -- two-file Python project, exported function
// ---------------------------------------------------------------------------

describe('runCrossFileResolver -- CALLS resolves to exported function in imported file', () => {
	let repo: string;

	before(async () => {
		repo = mkdtempSync(join(tmpdir(), 'insrc-cfr-calls-'));
		const helpersFile = join(repo, 'helpers.py');
		const mainFile    = join(repo, 'main.py');
		writeFileSync(helpersFile, 'def validate(x):\n    return x is not None\n');
		writeFileSync(mainFile,
			'from helpers import validate\n\ndef main():\n    return validate(1)\n');

		const helpersFileEnt = mkEntity(repo, helpersFile, 'file', helpersFile, 'python');
		const validateFn     = mkEntity(repo, helpersFile, 'function', 'validate', 'python', { isExported: true });
		const mainFileEnt    = mkEntity(repo, mainFile,    'file', mainFile, 'python');
		const mainFn         = mkEntity(repo, mainFile,    'function', 'main', 'python', { isExported: true });

		await upsertEntities(db, [helpersFileEnt, validateFn, mainFileEnt, mainFn]);

		// IMPORTS edge -- already file-targeted (mimics the per-file
		// resolver having handled relative imports, so Phase 3 has nothing
		// to rewire for this row).
		await upsertRelations(db, [{
			kind: 'IMPORTS', from: mainFileEnt.id, to: helpersFileEnt.id, resolved: true,
		}]);

		// CALLS edge -- main() -> validate (raw name, unresolved)
		await upsertRelations(db, [{
			kind: 'CALLS', from: mainFn.id, to: 'validate', resolved: false,
			meta: { file: mainFile, repo },
		}]);
	});

	after(() => {
		try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it('promotes the CALLS edge to the validate function', async () => {
		const sourceRoots = detectSourceRoots(repo);
		const result = await runCrossFileResolver({ db, repoRoot: repo, sourceRoots });
		assert.equal(result.resolved, 1,
			`expected 1 CALLS resolution; got: ${JSON.stringify(result)}`);

		const helpersFile = join(repo, 'helpers.py');
		const mainFile    = join(repo, 'main.py');
		const mainFnId     = makeEntityId(repo, mainFile,    'function', 'main');
		const validateFnId = makeEntityId(repo, helpersFile, 'function', 'validate');
		assert.equal(await countEdge(mainFnId, validateFnId, 'CALLS'), 1);
	});
});

// ---------------------------------------------------------------------------
// Test 5: CALLS to a non-exported function stays unresolved
// ---------------------------------------------------------------------------

describe('runCrossFileResolver -- CALLS to non-exported target stays unresolved', () => {
	let repo: string;

	before(async () => {
		repo = mkdtempSync(join(tmpdir(), 'insrc-cfr-calls-priv-'));
		const helpersFile = join(repo, 'helpers.py');
		const mainFile    = join(repo, 'main.py');
		writeFileSync(helpersFile, 'def _internal(x):\n    return x\n');
		writeFileSync(mainFile, 'from helpers import _internal\n\ndef use():\n    return _internal(1)\n');

		const helpersFileEnt = mkEntity(repo, helpersFile, 'file', helpersFile, 'python');
		// Underscore-prefixed function, isExported: false
		const internalFn     = mkEntity(repo, helpersFile, 'function', '_internal', 'python', { isExported: false });
		const mainFileEnt    = mkEntity(repo, mainFile,    'file', mainFile, 'python');
		const useFn          = mkEntity(repo, mainFile,    'function', 'use', 'python', { isExported: true });

		await upsertEntities(db, [helpersFileEnt, internalFn, mainFileEnt, useFn]);
		await upsertRelations(db, [
			{ kind: 'IMPORTS', from: mainFileEnt.id, to: helpersFileEnt.id, resolved: true },
			{ kind: 'CALLS',   from: useFn.id, to: '_internal', resolved: false,
			  meta: { file: mainFile, repo } },
		]);
	});

	after(() => {
		try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it('does not resolve the CALLS edge', async () => {
		const sourceRoots = detectSourceRoots(repo);
		const result = await runCrossFileResolver({ db, repoRoot: repo, sourceRoots });
		assert.equal(result.resolved, 0,
			`expected no resolution; got: ${JSON.stringify(result)}`);

		// The unresolved row should still be in UnresolvedRelation
		const useFnId = makeEntityId(repo, join(repo, 'main.py'), 'function', 'use');
		assert.equal(await countUnresolved(useFnId, 'CALLS'), 1);
	});
});

// ---------------------------------------------------------------------------
// Test 6: CALLS ambiguity -- same name in two imported files
// ---------------------------------------------------------------------------

describe('runCrossFileResolver -- CALLS marks ambiguous when two imported files export same name', () => {
	let repo: string;

	before(async () => {
		repo = mkdtempSync(join(tmpdir(), 'insrc-cfr-calls-amb-'));
		const aFile  = join(repo, 'a.py');
		const bFile  = join(repo, 'b.py');
		const main   = join(repo, 'main.py');
		writeFileSync(aFile, 'def fmt(x):\n    return str(x)\n');
		writeFileSync(bFile, 'def fmt(x):\n    return repr(x)\n');
		writeFileSync(main,  'from a import fmt\nfrom b import fmt\n\ndef m():\n    return fmt(1)\n');

		const aFileEnt = mkEntity(repo, aFile,  'file', aFile, 'python');
		const bFileEnt = mkEntity(repo, bFile,  'file', bFile, 'python');
		const mainFileEnt = mkEntity(repo, main, 'file', main, 'python');
		const fmtA = mkEntity(repo, aFile, 'function', 'fmt', 'python', { isExported: true });
		const fmtB = mkEntity(repo, bFile, 'function', 'fmt', 'python', { isExported: true });
		const mFn  = mkEntity(repo, main,  'function', 'm',   'python', { isExported: true });

		await upsertEntities(db, [aFileEnt, bFileEnt, mainFileEnt, fmtA, fmtB, mFn]);
		await upsertRelations(db, [
			{ kind: 'IMPORTS', from: mainFileEnt.id, to: aFileEnt.id, resolved: true },
			{ kind: 'IMPORTS', from: mainFileEnt.id, to: bFileEnt.id, resolved: true },
			{ kind: 'CALLS',   from: mFn.id, to: 'fmt', resolved: false,
			  meta: { file: main, repo } },
		]);
	});

	after(() => {
		try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it('records candidates in meta and stays unresolved', async () => {
		const sourceRoots = detectSourceRoots(repo);
		const result = await runCrossFileResolver({ db, repoRoot: repo, sourceRoots });
		assert.equal(result.ambiguous, 1,
			`expected 1 ambiguous; got: ${JSON.stringify(result)}`);

		const mFnId = makeEntityId(repo, join(repo, 'main.py'), 'function', 'm');
		const rows = await listUnresolvedRows(mFnId, 'CALLS');
		assert.equal(rows.length, 1);
		const meta = JSON.parse(rows[0]!.meta);
		assert.ok(Array.isArray(meta.candidates), `expected candidates array; got: ${JSON.stringify(meta)}`);
		assert.equal(meta.candidates.length, 2);
	});
});

// ---------------------------------------------------------------------------
// Test 7 (Phase 6): Idempotency -- a second pass over identical state is a no-op
// ---------------------------------------------------------------------------

describe('runCrossFileResolver -- idempotency', () => {
	let repo: string;

	before(async () => {
		repo = mkdtempSync(join(tmpdir(), 'insrc-cfr-idem-'));
		const javaRoot = join(repo, 'src', 'main', 'java', 'com', 'example');
		mkdirSync(javaRoot, { recursive: true });
		writeFileSync(join(javaRoot, 'Foo.java'), 'package com.example;\npublic class Foo {}');
		writeFileSync(join(javaRoot, 'Bar.java'),
			'package com.example;\npublic class Bar extends Foo {}');

		const fooFile = join(javaRoot, 'Foo.java');
		const barFile = join(javaRoot, 'Bar.java');

		await upsertEntities(db, [
			mkEntity(repo, fooFile, 'file',  fooFile),
			mkEntity(repo, fooFile, 'class', 'Foo'),
			mkEntity(repo, barFile, 'file',  barFile),
			mkEntity(repo, barFile, 'class', 'Bar'),
		]);
		await upsertRelations(db, [{
			kind: 'INHERITS', from: makeEntityId(repo, barFile, 'class', 'Bar'), to: 'Foo', resolved: false,
			meta: { file: barFile, repo },
		}]);
	});

	after(() => {
		try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it('second run resolves nothing new and the typed REL count is unchanged', async () => {
		const sourceRoots = detectSourceRoots(repo);

		const first = await runCrossFileResolver({ db, repoRoot: repo, sourceRoots });
		assert.equal(first.resolved, 1, `first: ${JSON.stringify(first)}`);

		// Snapshot the INHERITS edge count
		const beforeN = await countAllOfKind('INHERITS');

		const second = await runCrossFileResolver({ db, repoRoot: repo, sourceRoots });
		assert.equal(second.resolved, 0, `second pass should resolve nothing new: ${JSON.stringify(second)}`);
		assert.equal(second.importsRewired, 0);

		const afterN = await countAllOfKind('INHERITS');
		assert.equal(afterN, beforeN, `INHERITS count drifted between passes: ${beforeN} -> ${afterN}`);
	});
});

// ---------------------------------------------------------------------------
// Test 8 (Phase 6): Perf budget -- the resolver is fast on synthetic input
// ---------------------------------------------------------------------------

describe('runCrossFileResolver -- perf budget', () => {
	let repo: string;
	const N_FILES = 50;
	const N_CLASSES_PER_FILE = 4;

	before(async () => {
		repo = mkdtempSync(join(tmpdir(), 'insrc-cfr-perf-'));
		const javaRoot = join(repo, 'src', 'main', 'java', 'com', 'pkg');
		mkdirSync(javaRoot, { recursive: true });

		const entities: Entity[] = [];
		const relations: Relation[] = [];
		// Each file defines N_CLASSES_PER_FILE classes; class-i in file f
		// inherits from class-(i-1) in the same file (within-file resolution)
		// or from class-N in a different file (cross-file resolution).
		for (let f = 0; f < N_FILES; f++) {
			const file = join(javaRoot, `File${f}.java`);
			writeFileSync(file, `package com.pkg;\npublic class _stub {}\n`);
			entities.push(mkEntity(repo, file, 'file', file));
			for (let c = 0; c < N_CLASSES_PER_FILE; c++) {
				const name = `C_${f}_${c}`;
				entities.push(mkEntity(repo, file, 'class', name));
			}
			// Cross-file INHERITS: C_f_0 extends C_(f+1 mod N)_0
			const target = `C_${(f + 1) % N_FILES}_0`;
			relations.push({
				kind: 'INHERITS',
				from: makeEntityId(repo, file, 'class', `C_${f}_0`),
				to: target,
				resolved: false,
				meta: { file, repo },
			});
		}

		await upsertEntities(db, entities);
		await upsertRelations(db, relations);
	});

	after(() => {
		try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it(`resolves ${N_FILES} cross-file INHERITS in under 5 s`, async () => {
		const sourceRoots = detectSourceRoots(repo);
		const result = await runCrossFileResolver({ db, repoRoot: repo, sourceRoots });
		assert.ok(result.resolved >= N_FILES,
			`expected at least ${N_FILES} resolutions; got ${result.resolved}: ${JSON.stringify(result)}`);
		assert.ok(result.elapsedMs < 5000,
			`took ${result.elapsedMs} ms (>= 5 s budget): ${JSON.stringify(result)}`);
	});

	it('a no-op second pass is much cheaper than the first', async () => {
		const sourceRoots = detectSourceRoots(repo);
		const second = await runCrossFileResolver({ db, repoRoot: repo, sourceRoots });
		assert.equal(second.resolved, 0,
			`second pass should resolve nothing new: ${JSON.stringify(second)}`);
		// 1 s is generous; on local hardware the no-op pass typically
		// finishes in <100 ms because there are no UnresolvedRelation
		// rows left.
		assert.ok(second.elapsedMs < 1000,
			`no-op pass took ${second.elapsedMs} ms (>= 1 s): ${JSON.stringify(second)}`);
	});
});
