/**
 * Tests for the three Phase 4 comparison composites:
 *   - code.compare.signature
 *   - code.compare.impl-vs-doc
 *   - code.compare.entity-versions
 *
 * Composite skills compose other skills + tools. signature uses
 * an in-memory LMDB graph (so the dep skill code.entity.summary
 * runs verbatim). impl-vs-doc + entity-versions stub the
 * underlying tool / sub-skill via the test harness's fakeTools
 * map (the cross-skill calls run through the real registry but
 * the tools they hit -- file_read, git_diff -- are mocked).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { closeGraphStore, setGraphStorePath } from '../../../db/graph/store.js';
import { upsertEntities } from '../../../db/entities.js';
import { addRepo } from '../../../db/repos.js';
import { registerAllSkills } from '../index.js';
import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import { registerCodeTools } from '../../tools/builtins/code/index.js';
import { runSkillIsolated, type FakeToolMap } from '../test-harness.js';
import { parseHunks } from '../built-ins/code.compare.entity-versions.js';
import { parseMarkdownFirstColumns } from '../built-ins/code.compare.impl-vs-doc.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';

const REPO = '/repo/alpha';

let dir: string;

function mkId(repo: string, file: string, kind: string, name: string): string {
	return createHash('sha256').update(`${repo}\x00${file}\x00${kind}\x00${name}`).digest('hex').slice(0, 32);
}

function ent(opts: {
	kind: EntityKind;
	name: string;
	file?: string;
	body?: string;
	language?: Language;
	startLine?: number;
	endLine?: number;
	signature?: string;
	isExported?: boolean;
	isAbstract?: boolean;
	isAsync?: boolean;
}): Entity {
	const file = opts.file ?? `${REPO}/src/${opts.name}.ts`;
	const e: Entity = {
		id:        mkId(REPO, file, opts.kind, opts.name),
		kind:      opts.kind,
		name:      opts.name,
		language:  opts.language ?? 'typescript',
		repoId:    1,
		repo:      REPO,
		file,
		startLine: opts.startLine ?? 1,
		endLine:   opts.endLine ?? 10,
		body:      opts.body ?? '',
		embedding: [],
		indexedAt: '2026-05-09T10:00:00.000Z',
	};
	if (opts.signature  !== undefined) e.signature  = opts.signature;
	if (opts.isExported === true) e.isExported = true;
	if (opts.isAbstract === true) e.isAbstract = true;
	if (opts.isAsync    === true) e.isAsync    = true;
	return e;
}

test.beforeEach(async () => {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	dir = mkdtempSync(join(tmpdir(), 'insrc-compare-skills-'));
	setGraphStorePath(join(dir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO, name: '', addedAt: now, status: 'pending' });
	registerAllSkills();
	registerSkillTools();
	registerCodeTools();   // code.class.extract-fields rides code_class_locate + code_class_fields
});

test.afterEach(async () => {
	await closeGraphStore();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4.1 -- signature diff
// ---------------------------------------------------------------------------

test('signature diff: name + signature + isAsync change -> three changes', async () => {
	const a = ent({
		kind: 'function', name: 'compute', file: `${REPO}/src/a.ts`,
		signature: 'compute(): number',
		isExported: true,
	});
	const b = ent({
		kind: 'function', name: 'computeAsync', file: `${REPO}/src/b.ts`,
		signature: 'computeAsync(): Promise<number>',
		isExported: true,
		isAsync: true,
	});
	await upsertEntities(null, [a, b]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.compare.signature',
		{ aEntityId: a.id, bEntityId: b.id },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['changed'], true);
	const changes = v['changes'] as Array<Record<string, unknown>>;
	const fields = new Set(changes.map(c => c['field']));
	assert.ok(fields.has('name'));
	assert.ok(fields.has('signature'));
	assert.ok(fields.has('isAsync'));
});

test('signature diff: identical entities -> changed: false', async () => {
	const a = ent({ kind: 'function', name: 'f', signature: 'f(): void' });
	await upsertEntities(null, [a]);
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.compare.signature',
		{ aEntityId: a.id, bEntityId: a.id },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['changed'], false);
	assert.deepEqual(v['changes'], []);
});

test('signature diff: missing entity -> { found: false, reason }', async () => {
	const a = ent({ kind: 'function', name: 'f' });
	await upsertEntities(null, [a]);
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.compare.signature',
		{ aEntityId: a.id, bEntityId: 'b'.repeat(32) },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], false);
	assert.equal(v['reason'], 'b-not-found');
});

// ---------------------------------------------------------------------------
// 4.2 -- impl vs doc
// ---------------------------------------------------------------------------

test('parseMarkdownFirstColumns: extracts data rows, skips header + separator + code fences', () => {
	const md = `
# User

| field | type |
|---|---|
| id | number |
| email | string |
| createdAt | Date |

\`\`\`ts
| nope | nada |
\`\`\`
`;
	const cols = parseMarkdownFirstColumns(md);
	assert.deepEqual(cols, ['id', 'email', 'createdAt']);
});

test('parseMarkdownFirstColumns: strips backtick + bold decorations', () => {
	const md = `
| field | type |
|---|---|
| \`id\` | number |
| **email** | string |
`;
	const cols = parseMarkdownFirstColumns(md);
	assert.deepEqual(cols, ['id', 'email']);
});

test('impl-vs-doc: stubs file_read + class-extract-fields tools; surfaces drift', async () => {
	// runSkillIsolated dispatches every tool call through fakeTools --
	// so the inner code_class_locate / code_class_fields tools that
	// `code.class.extract-fields` rides need stubs too. The test
	// exercises the composite's diff logic, not the upstream tools'
	// extraction (those have their own coverage).
	const docContent = `
| field | type |
|---|---|
| id | number |
| email | string |
| createdAt | Date |
`;
	const entityId = 'a'.repeat(32);
	const fakeTools: FakeToolMap = {
		code_class_locate: {
			content: '',
			isError: false,
			data: {
				found: true, entityId,
				path: `${REPO}/src/User.ts`, line: 1,
				language: 'typescript', kind: 'class',
			},
		},
		code_class_fields: {
			content: '',
			isError: false,
			data: {
				entityId,
				className: 'User',
				language:  'typescript',
				source:    'body',
				fields: [
					{ name: 'id',    declaredAt: { path: `${REPO}/src/User.ts`, line: 2 } },
					{ name: 'email', declaredAt: { path: `${REPO}/src/User.ts`, line: 3 } },
				],
			},
		},
		file_read: {
			content: docContent,
			isError: false,
			data: { content: docContent },
		},
	};

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.compare.impl-vs-doc',
		{ className: 'User', repoPath: REPO, docPath: '/docs/user.md' },
		{ fakeTools },
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['drift'], true);
	assert.deepEqual(v['onlyInDoc'], ['createdAt']);
	assert.deepEqual(v['both'], ['email', 'id']);
});

test('impl-vs-doc: no markdown tables in doc -> { found: false, reason: no-doc-tables }', async () => {
	const entityId = 'a'.repeat(32);
	const fakeTools: FakeToolMap = {
		code_class_locate: { content: '', isError: false,
			data: { found: true, entityId, path: '/p/E.ts', line: 1, language: 'typescript', kind: 'class' } },
		code_class_fields: { content: '', isError: false,
			data: { entityId, className: 'Empty', language: 'typescript', source: 'body',
				fields: [{ name: 'x', declaredAt: { path: '/p/E.ts', line: 2 } }] } },
		file_read: { content: '# Just prose, no tables here.', isError: false, data: { content: '# Just prose' } },
	};
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.compare.impl-vs-doc',
		{ className: 'Empty', repoPath: REPO, docPath: '/docs/empty.md' },
		{ fakeTools },
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], false);
	assert.equal(v['reason'], 'no-doc-tables');
});

test('impl-vs-doc: missing class -> { found: false, reason: class-not-found }', async () => {
	// Stub locate to a miss; the composite must short-circuit before
	// touching file_read.
	const fakeTools: FakeToolMap = {
		code_class_locate: { content: '', isError: false,
			data: { found: false, nearest: [{ className: 'Nopes', score: 0.7, entityId: 'b'.repeat(32) }] } },
		code_class_fields: { content: '', isError: false, data: {} },
		file_read: { content: '', isError: false, data: { content: '' } },
	};
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.compare.impl-vs-doc',
		{ className: 'Nope', repoPath: REPO, docPath: '/docs/n.md' },
		{ fakeTools },
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], false);
	assert.equal(v['reason'], 'class-not-found');
});

// ---------------------------------------------------------------------------
// 4.3 -- entity versions
// ---------------------------------------------------------------------------

test('parseHunks: extracts +A,B coords and per-hunk insert / delete counts', () => {
	const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,7 @@ class Foo {
 line1
-line2
+line2_new
 line3
+line3_5
 line4
@@ -20,3 +22,4 @@
 line20
 line21
+line21_5
 line22`;
	const hunks = parseHunks(diff);
	assert.equal(hunks.length, 2);
	assert.equal(hunks[0]!.headerLine, 1);
	assert.equal(hunks[0]!.headerCount, 7);
	assert.equal(hunks[0]!.insertions, 2);
	assert.equal(hunks[0]!.deletions, 1);
	assert.equal(hunks[1]!.headerLine, 22);
	assert.equal(hunks[1]!.headerCount, 4);
});

test('entity-versions: filters hunks to those overlapping the entity range', async () => {
	const fn = ent({
		kind: 'function', name: 'compute', file: `${REPO}/src/compute.ts`,
		startLine: 10, endLine: 20,
	});
	await upsertEntities(null, [fn]);

	const diffText = `--- a/src/compute.ts
+++ b/src/compute.ts
@@ -2,3 +2,4 @@
 imports
+import x;
 imports
@@ -15,5 +16,6 @@ function compute() {
 line
+const y = 1;
 line`;

	const fakeTools: FakeToolMap = {
		git_diff: {
			content: diffText,
			isError: false,
			data: { diff: diffText, truncated: false },
		},
	};
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.compare.entity-versions',
		{ entityId: fn.id, baseRef: 'HEAD~3' },
		{ fakeTools },
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	const hunks = v['hunks'] as Array<Record<string, unknown>>;
	// Only the second hunk (16..21) overlaps the entity range 10..20.
	assert.equal(hunks.length, 1);
	assert.equal(hunks[0]!['headerLine'], 16);
	assert.equal(v['totalInsertions'], 1);
	assert.equal(v['totalDeletions'], 0);
});

test('entity-versions: missing entity -> { found: false, reason }', async () => {
	const fakeTools: FakeToolMap = {
		git_diff: { content: '', isError: false, data: { diff: '' } },
	};
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.compare.entity-versions',
		{ entityId: 'a'.repeat(32), baseRef: 'HEAD~1' },
		{ fakeTools },
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], false);
	assert.equal(v['reason'], 'entity-not-found');
});

test('entity-versions: git_diff error -> { found: false, reason: git-diff-failed }', async () => {
	const fn = ent({ kind: 'function', name: 'f', startLine: 1, endLine: 5 });
	await upsertEntities(null, [fn]);
	const fakeTools: FakeToolMap = {
		git_diff: { content: 'fatal: bad revision', isError: true },
	};
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.compare.entity-versions',
		{ entityId: fn.id, baseRef: 'NOPE' },
		{ fakeTools },
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], false);
	assert.equal(v['reason'], 'git-diff-failed');
});
