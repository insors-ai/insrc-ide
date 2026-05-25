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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('file.describe: indexed file but no parsed children -> reads file as fallback excerpt', async () => {
	// Simulate Dockerfile / configmap.yaml: indexer recorded the file
	// entity (graph has it) but tree-sitter has no grammar -> zero
	// children + zero imports. Skill should fall back to reading the
	// file from disk and surface bodyExcerpt.
	const dockerfilePath = join(dir, 'Dockerfile');
	writeFileSync(dockerfilePath, 'FROM python:3.11-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install -r requirements.txt\nCOPY . .\nCMD ["python", "main.py"]\n');
	const file = fileEnt(dockerfilePath, 'dockerfile' as Language);
	await upsertEntities(null, [file]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.file.describe',
		{ file: dockerfilePath, repoPath: REPO },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['entityCount'], 0);
	assert.equal(v['bodyExcerptSource'], 'file-fallback');
	assert.match(v['bodyExcerpt'] as string, /FROM python:3.11-slim/);
	assert.match(v['bodyExcerpt'] as string, /pip install/);
	assert.equal(result.confidence, 'medium');     // disk read worked
	assert.equal(result.notes.length, 1);
});

test('file.describe: indexed file, no children, file missing from disk -> low confidence, no bodyExcerpt', async () => {
	// Graph has the file row but disk read fails (e.g. file deleted
	// after indexing). Skill should return found=true with 0 children
	// and NO bodyExcerpt, plus a note explaining the gap. Honest
	// signal that there's nothing to cite.
	const file = fileEnt(`${REPO}/never-on-disk.yaml`, 'yaml' as Language);
	await upsertEntities(null, [file]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.file.describe',
		{ file: file.file, repoPath: REPO },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['entityCount'], 0);
	assert.equal(v['bodyExcerpt'], undefined);
	assert.equal(v['bodyExcerptSource'], undefined);
	assert.equal(result.confidence, 'low');
});

test('file.describe: parsed file with children -> no fallback (graph wins)', async () => {
	// Normal path: file has parsed children. Verify we DON'T read the
	// file unnecessarily even if it exists -- structural data is
	// strictly better than raw text, and the fallback path is meant
	// to be a strict last resort.
	const tsPath = `${REPO}/src/Real.ts`;
	const file = fileEnt(tsPath);
	const cls  = ent({ kind: 'class', name: 'Real', file: tsPath, startLine: 1, endLine: 5, isExported: true });
	await upsertEntities(null, [file, cls]);
	await upsertRelations(null, [{ kind: 'DEFINES', from: file.id, to: cls.id, resolved: true }]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.file.describe',
		{ file: tsPath, repoPath: REPO },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['entityCount'], 1);
	assert.equal(v['bodyExcerpt'], undefined);     // no spurious fallback
	assert.equal(result.confidence, 'high');
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

test('module.describe: empty directory (not on disk either) -> { found: false, reason: no-files-in-module }', async () => {
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.module.describe',
		{ modulePath: `${REPO}/src/empty`, repoPath: REPO },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], false);
	assert.equal(v['reason'], 'no-files-in-module');
});

test('module.describe: source=graph when indexed files exist (backward-compat marker)', async () => {
	const filePath = `${REPO}/src/marker/Foo.ts`;
	const file = fileEnt(filePath);
	await upsertEntities(null, [file]);
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.source.module.describe',
		{ modulePath: `${REPO}/src/marker`, repoPath: REPO },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['source'], 'graph');
});

test('module.describe: no indexed files but dir exists on disk -> disk-listing fallback', async () => {
	// Plan 4 Phase 1b: when the graph has nothing indexed under the
	// path but the dir is on disk (config / deployment / shell-script
	// dirs), return a basic file + subdir listing so the planner can
	// still see what's there.
	const realDir = mkdtempSync(join(tmpdir(), 'insrc-module-fallback-'));
	try {
		// Write some unparsed-language files
		writeFileSync(join(realDir, 'Dockerfile'), 'FROM python:3.11\n');
		writeFileSync(join(realDir, 'config.yaml'), 'key: value\n');
		writeFileSync(join(realDir, 'build.sh'),    '#!/bin/bash\n');
		// And a subdirectory
		mkdirSync(join(realDir, 'subconfig'));

		// Don't register the realDir as a repo -- listEntitiesForRepo
		// will throw if we pass an unregistered path. Use REPO and let
		// the under-modulePath filter find zero matches.
		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.module.describe',
			{ modulePath: realDir, repoPath: REPO },
			{},
		);
		const v = result.value as Record<string, unknown>;
		assert.equal(v['found'], true);
		assert.equal(v['source'], 'disk-listing');
		assert.equal(v['entityCount'], 0);
		const files = v['files'] as Array<{ path: string }>;
		const subdirs = v['subdirs'] as string[];
		assert.equal(files.length, 3);
		assert.ok(files.some(f => f.path.endsWith('Dockerfile')));
		assert.ok(files.some(f => f.path.endsWith('config.yaml')));
		assert.deepEqual(subdirs, ['subconfig']);
		assert.equal(result.confidence, 'medium');
	} finally {
		rmSync(realDir, { recursive: true, force: true });
	}
});

test('module.describe: disk-listing excludes node_modules + .git', async () => {
	const realDir = mkdtempSync(join(tmpdir(), 'insrc-module-fallback-excl-'));
	try {
		mkdirSync(join(realDir, 'node_modules'));
		mkdirSync(join(realDir, '.git'));
		mkdirSync(join(realDir, 'src'));
		writeFileSync(join(realDir, 'README.md'), '# hi\n');

		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.module.describe',
			{ modulePath: realDir, repoPath: REPO },
			{},
		);
		const v = result.value as Record<string, unknown>;
		const subdirs = v['subdirs'] as string[];
		assert.deepEqual(subdirs.sort(), ['src']);   // node_modules + .git excluded
	} finally {
		rmSync(realDir, { recursive: true, force: true });
	}
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
