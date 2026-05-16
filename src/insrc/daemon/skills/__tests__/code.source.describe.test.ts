/**
 * Tests for the three Phase 1 source-introspection skills:
 *   - code.source.file.describe
 *   - code.source.module.describe
 *   - code.source.repo.describe
 *
 * All three are pure-graph computations (no `runTool`), so the
 * tests build an in-memory LMDB graph with a small fixture repo
 * and exercise each skill via `runSkillIsolated`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { closeGraphStore, setGraphStorePath } from '../../../db/graph/store.js';
import { upsertEntities } from '../../../db/entities.js';
import { upsertRelations } from '../../../db/relations.js';
import { addRepo } from '../../../db/repos.js';
import { registerAllSkills } from '../index.js';
import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import { runSkillIsolated } from '../test-harness.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';

const REPO = '/repo/alpha';

let dir: string;

function makeId(repo: string, file: string, kind: string, name: string): string {
	return createHash('sha256').update(`${repo}\x00${file}\x00${kind}\x00${name}`).digest('hex').slice(0, 32);
}

function ent(opts: {
	kind: EntityKind;
	name: string;
	file: string;
	repo?: string;
	language?: Language;
	startLine?: number;
	endLine?: number;
	isExported?: boolean;
	signature?: string;
}): Entity {
	const repo = opts.repo ?? REPO;
	const language = opts.language ?? 'typescript';
	const e: Entity = {
		id:        makeId(repo, opts.file, opts.kind, opts.name),
		kind:      opts.kind,
		name:      opts.name,
		language,
		repoId:    1,
		repo,
		file:      opts.file,
		startLine: opts.startLine ?? 1,
		endLine:   opts.endLine ?? 10,
		body:      '',
		embedding: [],
		indexedAt: '2026-05-09T10:00:00.000Z',
	};
	if (opts.isExported === true) e.isExported = true;
	if (opts.signature !== undefined) e.signature = opts.signature;
	return e;
}

function fileEnt(file: string, language: Language = 'typescript', endLine = 100): Entity {
	return ent({ kind: 'file', name: file, file, language, endLine });
}

test.beforeEach(async () => {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	dir = mkdtempSync(join(tmpdir(), 'insrc-source-describe-'));
	setGraphStorePath(join(dir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO, name: '', addedAt: now, status: 'pending' });
	registerAllSkills();
	registerSkillTools();
});

test.afterEach(async () => {
	await closeGraphStore();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// code.source.file.describe
// ---------------------------------------------------------------------------

test('file.describe: known file -> { found: true, entities, imports }', async () => {
	const filePath = `${REPO}/src/User.ts`;
	const file = fileEnt(filePath);
	const cls  = ent({ kind: 'class', name: 'User', file: filePath, startLine: 5, endLine: 30, isExported: true });
	const fn   = ent({ kind: 'function', name: 'helper', file: filePath, startLine: 35, endLine: 40, signature: 'helper(): void' });
	const importTarget = ent({
		kind: 'module', name: 'lodash', repo: '',
		file: '', language: 'typescript',
	});
	await upsertEntities(null, [file, cls, fn, importTarget]);
	await upsertRelations(null, [
		{ kind: 'DEFINES', from: file.id, to: cls.id, resolved: true },
		{ kind: 'DEFINES', from: file.id, to: fn.id,  resolved: true },
		{ kind: 'IMPORTS', from: file.id, to: importTarget.id, resolved: true },
	]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.file.describe',
		{ file: filePath, repoPath: REPO },
		{},
	);
	assert.equal(result.confidence, 'high');
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['language'], 'typescript');
	const entities = v['entities'] as Array<Record<string, unknown>>;
	assert.equal(entities.length, 2);
	assert.ok(entities.some(e => e['name'] === 'User' && e['kind'] === 'class' && e['isExported'] === true));
	assert.ok(entities.some(e => e['name'] === 'helper' && e['signature'] === 'helper(): void'));

	const imports = v['imports'] as Array<Record<string, unknown>>;
	assert.equal(imports.length, 1);
	assert.equal(imports[0]!['target'], 'lodash');
});

test('file.describe: unknown path -> { found: false, reason: file-not-indexed }', async () => {
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.file.describe',
		{ file: `${REPO}/never-indexed.ts`, repoPath: REPO },
		{},
	);
	assert.equal(result.confidence, 'high');
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], false);
	assert.equal(v['reason'], 'file-not-indexed');
});

// ---------------------------------------------------------------------------
// code.source.module.describe
// ---------------------------------------------------------------------------

test('module.describe: directory with files -> aggregates files + entities + publicSurface', async () => {
	const dirPath = `${REPO}/src/orm`;
	const userFile  = fileEnt(`${dirPath}/User.ts`);
	const userCls   = ent({ kind: 'class', name: 'User', file: `${dirPath}/User.ts`, isExported: true });
	const orderFile = fileEnt(`${dirPath}/Order.ts`);
	const orderCls  = ent({ kind: 'class', name: 'Order', file: `${dirPath}/Order.ts`, isExported: true });
	const internal  = ent({ kind: 'function', name: 'internalHelper', file: `${dirPath}/Order.ts` });

	// Sibling directory to verify the prefix scoping.
	const otherFile = fileEnt(`${REPO}/src/ormExtra/Plain.ts`);

	await upsertEntities(null, [userFile, userCls, orderFile, orderCls, internal, otherFile]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.module.describe',
		{ modulePath: dirPath, repoPath: REPO },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['fileCount'], 2);
	assert.equal(v['entityCount'], 3);
	assert.equal(v['publicCount'], 2);

	// `ormExtra` must NOT match `orm`.
	const files = v['files'] as Array<Record<string, unknown>>;
	const filePaths = files.map(f => f['path']);
	assert.ok(!filePaths.some(p => String(p).includes('ormExtra')));

	const publicSurface = v['publicSurface'] as Array<Record<string, unknown>>;
	const names = publicSurface.map(e => e['name']).sort();
	assert.deepEqual(names, ['Order', 'User']);
});

test('module.describe: empty directory -> { found: false, reason: no-files-in-module }', async () => {
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.module.describe',
		{ modulePath: `${REPO}/src/empty`, repoPath: REPO },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], false);
	assert.equal(v['reason'], 'no-files-in-module');
});

// ---------------------------------------------------------------------------
// code.source.repo.describe
// ---------------------------------------------------------------------------

test('repo.describe: aggregates kindCounts, languages, top modules', async () => {
	const f1 = fileEnt(`${REPO}/src/orm/User.ts`,  'typescript');
	const f2 = fileEnt(`${REPO}/src/orm/Order.ts`, 'typescript');
	const f3 = fileEnt(`${REPO}/src/util/helper.py`, 'python');
	const c1 = ent({ kind: 'class', name: 'User', file: `${REPO}/src/orm/User.ts`, isExported: true });
	const c2 = ent({ kind: 'class', name: 'Order', file: `${REPO}/src/orm/Order.ts`, isExported: true });
	const fn = ent({ kind: 'function', name: 'helper', file: `${REPO}/src/util/helper.py`, language: 'python' });
	await upsertEntities(null, [f1, f2, f3, c1, c2, fn]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.repo.describe',
		{ repoPath: REPO },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['fileCount'], 3);
	assert.equal(v['entityCount'], 3);

	const kindCounts = v['kindCounts'] as Record<string, number>;
	assert.equal(kindCounts['file'],     3);
	assert.equal(kindCounts['class'],    2);
	assert.equal(kindCounts['function'], 1);

	const langs = v['languages'] as Array<Record<string, unknown>>;
	const tsRow = langs.find(l => l['language'] === 'typescript')!;
	assert.equal(tsRow['fileCount'], 2);
	assert.equal(tsRow['entityCount'], 2);

	// Phase B.1 renamed `topModules` -> `modules` (returns the COMPLETE list,
	// no longer top-K).
	const modules = v['modules'] as Array<Record<string, unknown>>;
	// `${REPO}/src/orm` has 2 files (top), `${REPO}/src/util` has 1.
	assert.equal(modules[0]!['path'], `${REPO}/src/orm`);
	assert.equal(modules[0]!['fileCount'], 2);
});

test('repo.describe: unindexed repo -> { found: false, reason: repo-not-indexed }', async () => {
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.repo.describe',
		{ repoPath: REPO },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], false);
	assert.equal(v['reason'], 'repo-not-indexed');
});
