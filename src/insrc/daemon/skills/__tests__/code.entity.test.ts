/**
 * Tests for the four Phase 2 entity-lookup skills:
 *   - code.entity.locate-by-name
 *   - code.entity.summary
 *   - code.entity.callers
 *   - code.entity.callees
 *
 * In-memory LMDB graph fixtures + runSkillIsolated, mirroring the
 * Phase 1 / 3 skill test pattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { _buildExcerptForTest as buildExcerpt } from '../built-ins/code.entity.summary.js';
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
}): Entity {
	const file = opts.file ?? `${REPO}/src/${opts.name}.ts`;
	const language = opts.language ?? 'typescript';
	const e: Entity = {
		id:        mkId(REPO, file, opts.kind, opts.name),
		kind:      opts.kind,
		name:      opts.name,
		language,
		repoId:    1,
		repo:      REPO,
		file,
		startLine: opts.startLine ?? 1,
		endLine:   opts.endLine ?? 10,
		body:      opts.body ?? '',
		embedding: [],
		indexedAt: '2026-05-09T10:00:00.000Z',
	};
	if (opts.signature !== undefined) e.signature = opts.signature;
	if (opts.isExported === true)     e.isExported = true;
	return e;
}

test.beforeEach(async () => {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	dir = mkdtempSync(join(tmpdir(), 'insrc-entity-skills-'));
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
// Pure helper
// ---------------------------------------------------------------------------

test('buildExcerpt: empty body -> empty, not truncated', () => {
	const r = buildExcerpt('');
	assert.equal(r.excerpt, '');
	assert.equal(r.truncated, false);
});

test('buildExcerpt: short body passes through whole', () => {
	const r = buildExcerpt('line1\nline2\nline3');
	assert.equal(r.excerpt, 'line1\nline2\nline3');
	assert.equal(r.truncated, false);
});

test('buildExcerpt: long body -> head + truncated marker', () => {
	const body = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
	const r = buildExcerpt(body);
	assert.equal(r.truncated, true);
	assert.match(r.excerpt, /<truncated>$/);
});

// ---------------------------------------------------------------------------
// code.entity.locate-by-name
// ---------------------------------------------------------------------------
//
// Plan SCS Phase 2: locate-by-name now defaults to closure scope.
// Every test below seeds `closureRepos: [REPO]` on the fake session
// so the default scope resolves to the test repo. The dedicated
// scope tests at the bottom override this to exercise the multi-repo,
// 'global', and unrelated-repo cases.

const LOCATE_SESSION_FIELDS = Object.freeze({
	repoPath:     REPO,
	closureRepos: [REPO],
}) satisfies Record<string, unknown>;

test('locate-by-name: returns matches across kinds, sorted hit-first', async () => {
	const cls = ent({ kind: 'class',    name: 'Order', isExported: true });
	const fn  = ent({ kind: 'function', name: 'order', file: `${REPO}/src/order.ts` });
	await upsertEntities(null, [cls, fn]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.locate-by-name',
		{ name: 'Order' },
		{ extraSessionFields: { ...LOCATE_SESSION_FIELDS } },
	);
	const v = result.value as Record<string, unknown>;
	const matches = v['matches'] as Array<Record<string, unknown>>;
	assert.equal(matches.length, 1);
	assert.equal(matches[0]!['name'], 'Order');
	assert.equal(matches[0]!['kind'], 'class');
	// Phase 2: every match now carries its repo for cross-project
	// disambiguation; the closure default puts every result in the
	// active repo.
	assert.equal(matches[0]!['repo'], REPO);
});

test('locate-by-name: kinds filter narrows', async () => {
	const cls = ent({ kind: 'class', name: 'Foo', file: `${REPO}/src/Foo.ts` });
	const fn  = ent({ kind: 'function', name: 'Foo', file: `${REPO}/src/foo-fn.ts` });
	await upsertEntities(null, [cls, fn]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.locate-by-name',
		{ name: 'Foo', kinds: ['function'] },
		{ extraSessionFields: { ...LOCATE_SESSION_FIELDS } },
	);
	const matches = (result.value as Record<string, unknown>)['matches'] as Array<Record<string, unknown>>;
	assert.equal(matches.length, 1);
	assert.equal(matches[0]!['kind'], 'function');
});

test('locate-by-name: empty result -> medium confidence with helpful note', async () => {
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.locate-by-name',
		{ name: 'NeverExists' },
		{ extraSessionFields: { ...LOCATE_SESSION_FIELDS } },
	);
	assert.equal(result.confidence, 'medium');
	const matches = (result.value as Record<string, unknown>)['matches'] as unknown[];
	assert.equal(matches.length, 0);
	assert.ok((result.notes ?? []).some(n => n.includes('No entity named')));
});

// ---- Plan SCS Phase 2 scope behaviour ----

test('locate-by-name: default scope is closure -- unrelated indexed repo NOT in results', async () => {
	const OTHER = '/repo/unrelated';
	const now = new Date().toISOString();
	await addRepo(null, { path: OTHER, name: '', addedAt: now, status: 'pending' });

	const inScope = ent({ kind: 'class', name: 'Widget', file: `${REPO}/src/widget.ts`, isExported: true });
	// Hand-build a cross-repo match so we don't have to teach `ent()` about a second repo.
	const crossRepo: Entity = {
		id:        mkId(OTHER, `${OTHER}/lib/Widget.ts`, 'class', 'Widget'),
		kind:      'class',
		name:      'Widget',
		language:  'typescript',
		repoId:    2,
		repo:      OTHER,
		file:      `${OTHER}/lib/Widget.ts`,
		startLine: 1,
		endLine:   10,
		body:      '',
		embedding: [],
		indexedAt: now,
	};
	await upsertEntities(null, [inScope, crossRepo]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.locate-by-name',
		{ name: 'Widget' },
		{ extraSessionFields: { ...LOCATE_SESSION_FIELDS } },
	);
	const matches = (result.value as Record<string, unknown>)['matches'] as Array<Record<string, unknown>>;
	assert.equal(matches.length, 1, 'closure default must filter out the cross-repo match');
	assert.equal(matches[0]!['repo'], REPO);
});

test("locate-by-name: scope='global' includes cross-repo matches with repo tag + note", async () => {
	const OTHER = '/repo/unrelated';
	const now = new Date().toISOString();
	await addRepo(null, { path: OTHER, name: '', addedAt: now, status: 'pending' });

	const inScope: Entity = {
		id:        mkId(REPO, `${REPO}/src/widget.ts`, 'class', 'Widget'),
		kind:      'class', name: 'Widget', language: 'typescript',
		repoId:    1, repo: REPO, file: `${REPO}/src/widget.ts`,
		startLine: 1, endLine: 10, body: '', embedding: [], indexedAt: now,
	};
	const crossRepo: Entity = {
		id:        mkId(OTHER, `${OTHER}/lib/Widget.ts`, 'class', 'Widget'),
		kind:      'class', name: 'Widget', language: 'typescript',
		repoId:    2, repo: OTHER, file: `${OTHER}/lib/Widget.ts`,
		startLine: 1, endLine: 10, body: '', embedding: [], indexedAt: now,
	};
	await upsertEntities(null, [inScope, crossRepo]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.locate-by-name',
		{ name: 'Widget', scope: 'global' },
		{ extraSessionFields: { ...LOCATE_SESSION_FIELDS } },
	);
	const matches = (result.value as Record<string, unknown>)['matches'] as Array<Record<string, unknown>>;
	assert.equal(matches.length, 2);
	const repos = new Set(matches.map(m => m['repo'] as string));
	assert.ok(repos.has(REPO));
	assert.ok(repos.has(OTHER));
	assert.ok((result.notes ?? []).some(n => n.includes("scope='global'")));
});

test('locate-by-name: closure with multiple dependent repos returns matches from all of them', async () => {
	const DEP = '/repo/dependent';
	const OTHER = '/repo/unrelated';
	const now = new Date().toISOString();
	await addRepo(null, { path: DEP,   name: '', addedAt: now, status: 'pending' });
	await addRepo(null, { path: OTHER, name: '', addedAt: now, status: 'pending' });

	const inActive: Entity = {
		id:        mkId(REPO, `${REPO}/src/widget.ts`, 'class', 'Widget'),
		kind:      'class', name: 'Widget', language: 'typescript',
		repoId:    1, repo: REPO, file: `${REPO}/src/widget.ts`,
		startLine: 1, endLine: 10, body: '', embedding: [], indexedAt: now,
	};
	const inDep: Entity = {
		id:        mkId(DEP, `${DEP}/src/Widget.ts`, 'class', 'Widget'),
		kind:      'class', name: 'Widget', language: 'typescript',
		repoId:    2, repo: DEP, file: `${DEP}/src/Widget.ts`,
		startLine: 1, endLine: 10, body: '', embedding: [], indexedAt: now,
	};
	const inUnrelated: Entity = {
		id:        mkId(OTHER, `${OTHER}/lib/Widget.ts`, 'class', 'Widget'),
		kind:      'class', name: 'Widget', language: 'typescript',
		repoId:    3, repo: OTHER, file: `${OTHER}/lib/Widget.ts`,
		startLine: 1, endLine: 10, body: '', embedding: [], indexedAt: now,
	};
	await upsertEntities(null, [inActive, inDep, inUnrelated]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.locate-by-name',
		{ name: 'Widget' },
		// Closure includes the active repo + a genuine dependent. The
		// unrelated indexed repo is NOT in the closure.
		{ extraSessionFields: { repoPath: REPO, closureRepos: [REPO, DEP] } },
	);
	const matches = (result.value as Record<string, unknown>)['matches'] as Array<Record<string, unknown>>;
	assert.equal(matches.length, 2);
	const repos = new Set(matches.map(m => m['repo'] as string));
	assert.ok(repos.has(REPO));
	assert.ok(repos.has(DEP));
	assert.ok(!repos.has(OTHER), 'unrelated repo must not appear in closure-scoped results');
});

test('locate-by-name: explicit repoPath overrides scope (single-repo)', async () => {
	const DEP = '/repo/dependent';
	const now = new Date().toISOString();
	await addRepo(null, { path: DEP, name: '', addedAt: now, status: 'pending' });

	const inActive: Entity = {
		id:        mkId(REPO, `${REPO}/src/widget.ts`, 'class', 'Widget'),
		kind:      'class', name: 'Widget', language: 'typescript',
		repoId:    1, repo: REPO, file: `${REPO}/src/widget.ts`,
		startLine: 1, endLine: 10, body: '', embedding: [], indexedAt: now,
	};
	const inDep: Entity = {
		id:        mkId(DEP, `${DEP}/src/Widget.ts`, 'class', 'Widget'),
		kind:      'class', name: 'Widget', language: 'typescript',
		repoId:    2, repo: DEP, file: `${DEP}/src/Widget.ts`,
		startLine: 1, endLine: 10, body: '', embedding: [], indexedAt: now,
	};
	await upsertEntities(null, [inActive, inDep]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.locate-by-name',
		// closure would return both; explicit repoPath narrows to just the dep
		{ name: 'Widget', repoPath: DEP },
		{ extraSessionFields: { repoPath: REPO, closureRepos: [REPO, DEP] } },
	);
	const matches = (result.value as Record<string, unknown>)['matches'] as Array<Record<string, unknown>>;
	assert.equal(matches.length, 1);
	assert.equal(matches[0]!['repo'], DEP);
});

// ---------------------------------------------------------------------------
// code.entity.summary
// ---------------------------------------------------------------------------

test('summary: returns metadata + body excerpt for a known entity', async () => {
	const fn = ent({
		kind: 'function', name: 'compute',
		file: `${REPO}/src/compute.ts`, startLine: 5, endLine: 25,
		signature: 'compute(): number',
		isExported: true,
		body: 'export function compute(): number {\n  return 42;\n}',
	});
	await upsertEntities(null, [fn]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.summary',
		{ entityId: fn.id },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['name'], 'compute');
	assert.equal(v['kind'], 'function');
	assert.equal(v['signature'], 'compute(): number');
	assert.equal(v['isExported'], true);
	assert.match(v['excerpt'] as string, /return 42/);
});

test('summary: missing id -> { found: false, reason: entity-not-found }', async () => {
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.summary',
		{ entityId: 'a'.repeat(32) },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], false);
	assert.equal(v['reason'], 'entity-not-found');
});

// ---------------------------------------------------------------------------
// summary: file-read fallback (Dockerfile / YAML / shell-script case)
// ---------------------------------------------------------------------------

test('summary: empty body + real file on disk -> reads file as excerpt', async () => {
	// Simulate the Dockerfile / configmap.yaml case: graph has a
	// `kind: file` entity with an empty body (tree-sitter has no
	// grammar for these formats), file exists on disk. Skill should
	// read the file and surface it as the excerpt.
	const yamlPath = join(dir, 'configmap.yaml');
	writeFileSync(yamlPath, 'apiVersion: v1\nkind: ConfigMap\ndata:\n  key: value\n');
	const fileEnt = ent({
		kind:  'file',
		name:  'configmap.yaml',
		file:  yamlPath,
		body:  '',                // <-- the bug condition: graph has no body
		language: 'yaml' as Language,
	});
	await upsertEntities(null, [fileEnt]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.summary',
		{ entityId: fileEnt.id },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['excerptSource'], 'file-fallback');
	assert.match(v['excerpt'] as string, /apiVersion: v1/);
	assert.match(v['excerpt'] as string, /ConfigMap/);
	assert.equal(result.confidence, 'medium');   // file read worked
	assert.equal(result.notes.length, 1);         // explains the fallback
});

test('summary: empty body + missing file -> low confidence, empty excerpt, honest', async () => {
	// Graph has a file row but disk read fails (file deleted between
	// indexing and lookup). Skill should NOT crash; should return
	// excerpt='' with low confidence + a note explaining the gap.
	const fileEnt = ent({
		kind:  'file',
		name:  'gone.yaml',
		file:  join(dir, 'does-not-exist.yaml'),
		body:  '',
	});
	await upsertEntities(null, [fileEnt]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.summary',
		{ entityId: fileEnt.id },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['found'], true);
	assert.equal(v['excerpt'], '');
	assert.equal(v['excerptSource'], 'graph');   // no successful fallback
	assert.equal(result.confidence, 'low');
});

test('summary: non-empty body -> excerptSource is graph (no spurious fallback)', async () => {
	// Make sure the normal path still works: when body is non-empty,
	// we use it and DON'T touch the disk.
	const fn = ent({
		kind: 'function', name: 'normalPath',
		body: 'function normalPath(): void {}',
	});
	await upsertEntities(null, [fn]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.summary',
		{ entityId: fn.id },
		{},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['excerptSource'], 'graph');
	assert.match(v['excerpt'] as string, /normalPath/);
	assert.equal(result.confidence, 'high');
});

// ---------------------------------------------------------------------------
// code.entity.callers / callees
// ---------------------------------------------------------------------------

test('callers + callees: 1-hop CALLS edges round-trip', async () => {
	const a = ent({ kind: 'function', name: 'a', file: `${REPO}/src/a.ts` });
	const b = ent({ kind: 'function', name: 'b', file: `${REPO}/src/b.ts` });
	const c = ent({ kind: 'function', name: 'c', file: `${REPO}/src/c.ts` });
	await upsertEntities(null, [a, b, c]);
	// a -> b, a -> c
	await upsertRelations(null, [
		{ kind: 'CALLS', from: a.id, to: b.id, resolved: true },
		{ kind: 'CALLS', from: a.id, to: c.id, resolved: true },
	]);

	const callees = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.callees', { entityId: a.id }, {},
	);
	const cv = callees.result.value as Record<string, unknown>;
	const cn = cv['neighbors'] as Array<Record<string, unknown>>;
	const calleeNames = cn.map(n => n['name']).sort();
	assert.deepEqual(calleeNames, ['b', 'c']);

	const callers = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.callers', { entityId: b.id }, {},
	);
	const cr = callers.result.value as Record<string, unknown>;
	const crn = cr['neighbors'] as Array<Record<string, unknown>>;
	assert.equal(crn.length, 1);
	assert.equal(crn[0]!['name'], 'a');
});

test('callees: empty result -> medium confidence', async () => {
	const a = ent({ kind: 'function', name: 'a' });
	await upsertEntities(null, [a]);
	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.entity.callees', { entityId: a.id }, {},
	);
	assert.equal(result.confidence, 'medium');
	const v = result.value as Record<string, unknown>;
	assert.equal((v['neighbors'] as unknown[]).length, 0);
	// Phase B.1 dropped the `truncated` output field (no skill-side cap).
	assert.equal(v['truncated'], undefined);
});
