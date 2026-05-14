/**
 * Phase 8.1 tests for the data.code.dead-code skill.
 *
 * The skill itself is a thin wrapper over `unreachableEntities` from
 * db/search.ts; the unit-of-failure here is the skill's contract:
 *
 *   - auto-detected entry-point set (exported entities only)
 *   - explicit entryPoints input override
 *   - repo scoping (entities in OTHER repos must not appear as dead)
 *   - candidateKinds + relationKinds defaults
 *   - empty-roots short-circuit returns low confidence
 *   - limit cap + truncated flag
 *
 * The graph state is seeded directly through the public LMDB
 * surface (upsertEntities + upsertRelations) -- the same shape an
 * actual indexer pass produces.
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
import { registerAllSkills } from '../index.js';
import { runSkillIsolated } from '../test-harness.js';
import type { Entity, EntityKind } from '../../../shared/types.js';

let dir: string;
let registered = false;

test.before(() => {
	if (!registered) {
		registerAllSkills();
		registered = true;
	}
});

test.beforeEach(async () => {
	await closeGraphStore();
	dir = mkdtempSync(join(tmpdir(), 'insrc-deadcode-skill-8.1-'));
	setGraphStorePath(join(dir, 'graph.lmdb'));
	const { addRepo } = await import('../../../db/repos.js');
	for (const path of ['/repo/foo', '/repo/bar']) {
		await addRepo(null, { path, name: '', addedAt: new Date().toISOString(), status: 'pending' });
	}
});
test.afterEach(async () => {
	await closeGraphStore();
	rmSync(dir, { recursive: true, force: true });
});

const REPO = '/repo/foo';

function makeEntityId(repo: string, file: string, kind: string, name: string): string {
	return createHash('sha256')
		.update(`${repo}\x00${file}\x00${kind}\x00${name}`)
		.digest('hex')
		.slice(0, 32);
}

function makeEntity(
	name: string,
	opts: { repo?: string; file?: string; kind?: EntityKind; isExported?: boolean; repoId?: number } = {},
): Entity {
	const repo = opts.repo ?? REPO;
	const kind = opts.kind ?? 'function';
	const file = opts.file ?? `${repo}/src/${name}.ts`;
	const e: Entity = {
		id:        makeEntityId(repo, file, kind, name),
		kind, name,
		language:  'typescript',
		repoId:    opts.repoId ?? 1,
		repo, file,
		startLine: 1, endLine: 5,
		body:      `function ${name}() {}`,
		embedding: [],
		indexedAt: '2026-05-06T10:00:00.000Z',
	};
	if (opts.isExported !== undefined) e.isExported = opts.isExported;
	return e;
}

interface DeadEntity {
	id: string;
	name: string;
	kind: string;
}

interface DeadCodeOutput {
	repo: string;
	rootCount: number;
	deadCount: number;
	dead: DeadEntity[];
}

// ---------------------------------------------------------------------------
// Auto-detected roots (exported entities)
// ---------------------------------------------------------------------------

test('auto-detects exported entities as roots and flags only the unreachable ones', async () => {
	// main (exported) -> helper. orphan is not reachable from main.
	const main   = makeEntity('main',   { isExported: true });
	const helper = makeEntity('helper', { isExported: false });
	const orphan = makeEntity('orphan', { isExported: false });
	await upsertEntities(null, [main, helper, orphan]);
	await upsertRelations(null, [
		{ kind: 'CALLS', from: main.id, to: helper.id, resolved: true },
	]);

	const result = await runSkillIsolated<unknown, DeadCodeOutput>(
		'data.code.dead-code',
		{ repo: REPO },
	);

	assert.equal(result.result.value.repo, REPO);
	assert.equal(result.result.value.rootCount, 1, 'one exported root expected (main)');
	assert.equal(result.result.value.deadCount, 1);
	assert.deepEqual(result.result.value.dead.map(d => d.name), ['orphan']);
	assert.equal(result.result.confidence, 'high');
});

test('explicit entryPoints input overrides auto-detection', async () => {
	const a = makeEntity('a', { isExported: false });
	const b = makeEntity('b', { isExported: false });
	const c = makeEntity('c', { isExported: false });
	await upsertEntities(null, [a, b, c]);
	await upsertRelations(null, [
		{ kind: 'CALLS', from: b.id, to: c.id, resolved: true },
	]);

	// Pass `b` explicitly as the root. `a` and (transitively-reachable
	// from `b`) `c` are reachable; only `a` is dead.
	const result = await runSkillIsolated<unknown, DeadCodeOutput>(
		'data.code.dead-code',
		{ repo: REPO, entryPoints: [b.id] },
	);
	assert.equal(result.result.value.rootCount, 1);
	assert.equal(result.result.value.deadCount, 1);
	assert.equal(result.result.value.dead[0]!.name, 'a');
});

// ---------------------------------------------------------------------------
// Repo scoping
// ---------------------------------------------------------------------------

test('repo scoping: entities in another repo are NOT flagged as dead', async () => {
	const OTHER_REPO = '/repo/bar';
	const main         = makeEntity('main',         { repo: REPO,       isExported: true });
	const orphanInRepo = makeEntity('orphanInRepo', { repo: REPO,       isExported: false });
	const inOtherRepo  = makeEntity('inOtherRepo',  { repo: OTHER_REPO, isExported: false });
	await upsertEntities(null, [main, orphanInRepo, inOtherRepo]);

	const result = await runSkillIsolated<unknown, DeadCodeOutput>(
		'data.code.dead-code',
		{ repo: REPO },
	);
	const names = result.result.value.dead.map(d => d.name);
	assert.deepEqual(names, ['orphanInRepo']);
	assert.ok(!names.includes('inOtherRepo'),
		'cross-repo entities must not surface in the active-repo dead set');
});

// ---------------------------------------------------------------------------
// Empty-roots short-circuit
// ---------------------------------------------------------------------------

test('returns low confidence when no roots can be resolved', async () => {
	// All entities non-exported and no entryPoints supplied -> roots empty.
	const a = makeEntity('a', { isExported: false });
	const b = makeEntity('b', { isExported: false });
	await upsertEntities(null, [a, b]);

	const result = await runSkillIsolated<unknown, DeadCodeOutput>(
		'data.code.dead-code',
		{ repo: REPO },
	);
	assert.equal(result.result.value.rootCount, 0);
	assert.equal(result.result.value.deadCount, 0);
	assert.deepEqual(result.result.value.dead, []);
	assert.equal(result.result.confidence, 'low');
});

// ---------------------------------------------------------------------------
// candidateKinds filter
// ---------------------------------------------------------------------------

test('candidateKinds default excludes file/repo/module entities', async () => {
	const main = makeEntity('main', { isExported: true });
	const orphanFn  = makeEntity('orphanFn',  { isExported: false });
	const orphanCls = makeEntity('OrphanCls', { kind: 'class',  isExported: false });
	// File entity should NEVER show up as dead under default candidate kinds.
	const fileE = makeEntity('file.ts', { kind: 'file', isExported: false });
	await upsertEntities(null, [main, orphanFn, orphanCls, fileE]);

	const result = await runSkillIsolated<unknown, DeadCodeOutput>(
		'data.code.dead-code',
		{ repo: REPO },
	);
	const kinds = new Set(result.result.value.dead.map(d => d.kind));
	assert.ok(!kinds.has('file'), 'file kind should be excluded by default candidate kinds');
	assert.ok(kinds.has('function'));
	assert.ok(kinds.has('class'));
});

test('explicit candidateKinds narrows the dead set', async () => {
	const main = makeEntity('main', { isExported: true });
	const orphanFn  = makeEntity('orphanFn',  { kind: 'function',  isExported: false });
	const orphanCls = makeEntity('OrphanCls', { kind: 'class',     isExported: false });
	await upsertEntities(null, [main, orphanFn, orphanCls]);

	const result = await runSkillIsolated<unknown, DeadCodeOutput>(
		'data.code.dead-code',
		{ repo: REPO, candidateKinds: ['function'] },
	);
	assert.deepEqual(result.result.value.dead.map(d => d.name), ['orphanFn']);
});

// ---------------------------------------------------------------------------
// full-fidelity output (Phase B.1: skill returns the complete unreachable set;
// no `limit` parameter; renderer / skill_load_page handle paging for the LLM)
// ---------------------------------------------------------------------------

test('returns the COMPLETE dead set; no truncation in the skill body', async () => {
	const main = makeEntity('main', { isExported: true });
	const orphans: Entity[] = [];
	for (let i = 0; i < 10; i++) {
		orphans.push(makeEntity(`orphan${i}`, { isExported: false }));
	}
	await upsertEntities(null, [main, ...orphans]);

	const result = await runSkillIsolated<unknown, DeadCodeOutput>(
		'data.code.dead-code',
		{ repo: REPO },
	);
	assert.equal(result.result.value.deadCount, 10, 'deadCount = full unreachable total');
	assert.equal(result.result.value.dead.length, 10, 'dead array contains every entry, not a slice');
	assert.equal(result.result.truncated, undefined, 'no truncated flag emitted any more');
});

// ---------------------------------------------------------------------------
// relationKinds filter
// ---------------------------------------------------------------------------

test('relationKinds restricts which edges count as reaching', async () => {
	// main exported. main IMPORTS helper, but does not CALL it.
	// With relationKinds=['CALLS'] only, helper is dead.
	const main   = makeEntity('main',   { isExported: true });
	const helper = makeEntity('helper', { isExported: false });
	await upsertEntities(null, [main, helper]);
	await upsertRelations(null, [
		{ kind: 'IMPORTS', from: main.id, to: helper.id, resolved: true },
	]);

	const callsOnly = await runSkillIsolated<unknown, DeadCodeOutput>(
		'data.code.dead-code',
		{ repo: REPO, relationKinds: ['CALLS'] },
	);
	assert.deepEqual(callsOnly.result.value.dead.map(d => d.name), ['helper']);

	// With the default kinds (which includes IMPORTS), helper is alive.
	const defaultKinds = await runSkillIsolated<unknown, DeadCodeOutput>(
		'data.code.dead-code',
		{ repo: REPO },
	);
	assert.equal(defaultKinds.result.value.deadCount, 0);
});
