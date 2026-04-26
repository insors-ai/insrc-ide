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

function mkEntity(repo: string, file: string, kind: Entity['kind'], name: string, language: Entity['language'] = 'java'): Entity {
	return {
		id:        makeEntityId(repo, file, kind, name),
		kind, name, language, repo, file,
		startLine: 0, endLine: 0,
		body: '', embedding: [], indexedAt: new Date().toISOString(),
	};
}

async function fileExistsForGraph(stmt: string, params: Record<string, unknown>): Promise<unknown[]> {
	const prepared = await db.graph.prepare(stmt);
	const result   = await db.graph.execute(prepared, params);
	const qr = Array.isArray(result) ? result[0]! : result;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (qr as any).getAll() as Promise<unknown[]>;
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
		const rows = await fileExistsForGraph(
			`MATCH (a:Entity)-[:INHERITS]->(b:Entity)
			 WHERE a.id = $barId AND b.id = $fooId
			 RETURN count(*) AS n`,
			{
				barId: makeEntityId(repo, join(repo, 'src/main/java/com/example/Bar.java'), 'class', 'Bar'),
				fooId: makeEntityId(repo, join(repo, 'src/main/java/com/example/Foo.java'), 'class', 'Foo'),
			},
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const n = (rows[0] as any)['n'];
		assert.equal(Number(n), 1);
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
		const fileEdge = await fileExistsForGraph(
			`MATCH (u:Entity {id: $userId})-[:IMPORTS]->(f:Entity {id: $fooId})
			 RETURN count(*) AS n`,
			{ userId: userFileId, fooId: fooFileId },
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		assert.equal(Number((fileEdge[0] as any)['n']), 1);

		// Verify module-stub edge is gone
		const stubId = makeEntityId('', '', 'module', 'com.example.Foo');
		const stubEdge = await fileExistsForGraph(
			`MATCH (u:Entity {id: $userId})-[:IMPORTS]->(m:Entity {id: $stubId})
			 RETURN count(*) AS n`,
			{ userId: userFileId, stubId },
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		assert.equal(Number((stubEdge[0] as any)['n']), 0);
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
		const stillThere = await fileExistsForGraph(
			`MATCH (a:Entity {id: $appId})-[:IMPORTS]->(m:Entity {id: $stubId})
			 RETURN count(*) AS n`,
			{ appId: appFileId, stubId },
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		assert.equal(Number((stillThere[0] as any)['n']), 1);
	});
});
