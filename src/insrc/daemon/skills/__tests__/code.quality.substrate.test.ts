/**
 * Substrate-aware tests for the `code.quality.*` suite.
 *
 * Per plans/skills/code/code.quality.suite.md, all four quality skills
 * (complexity / cyclic-deps / duplication / unused-exports) share the
 * same migration shape: cached-report slot + always-on-success
 * distillation, no miss-cache. One combined test file covers each
 * skill's cache hit + cold-pin paths.
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

import { _resetSkillRegistryForTests, getSkill } from '../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { runSkillIsolated } from '../test-harness.js';

import { createMemoryStore } from '../../substrate/memory-store.js';
import { createSubstrateRuntime, type SubstrateRuntime } from '../../substrate/runtime.js';

import type { Entity, EntityKind, Language } from '../../../shared/types.js';

// ---------------------------------------------------------------------------

const REPO = '/repo/quality';

interface Fixture {
	readonly substrate:     SubstrateRuntime;
	readonly substrateRoot: string;
	readonly graphDir:      string;
	dispose(): Promise<void>;
}

async function setupFixture(skillId: string): Promise<Fixture> {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-quality-graph-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO, name: '', addedAt: now, status: 'pending' });

	registerAllSkills();

	const substrateRoot = mkdtempSync(join(tmpdir(), 'insrc-quality-substrate-'));
	const memory = createMemoryStore({ workspaceId: 'wsQuality', rootDir: substrateRoot });
	const substrate = createSubstrateRuntime({ memory });

	const skill = getSkill(skillId);
	assert.ok(skill, `${skillId} not registered`);
	substrate.registerSkill(skill);

	return {
		substrate,
		substrateRoot,
		graphDir,
		async dispose() {
			await closeGraphStore();
			rmSync(graphDir,      { recursive: true, force: true });
			rmSync(substrateRoot, { recursive: true, force: true });
		},
	};
}

function mkId(repo: string, file: string, kind: string, name: string): string {
	return createHash('sha256').update(`${repo}\x00${file}\x00${kind}\x00${name}`).digest('hex').slice(0, 32);
}

function fn(name: string, body: string): Entity {
	const file = `${REPO}/src/${name}.ts`;
	return {
		id: mkId(REPO, file, 'function', name),
		kind: 'function', name, language: 'typescript' as Language,
		repoId: 1, repo: REPO, file, startLine: 1, endLine: 10,
		body, embedding: [], indexedAt: '2026-05-31T00:00:00.000Z',
		isExported: true,
	};
}

function fileEnt(name: string): Entity {
	const file = `${REPO}/src/${name}.ts`;
	return {
		id: mkId(REPO, file, 'file', name),
		kind: 'file', name, language: 'typescript' as Language,
		repoId: 1, repo: REPO, file, startLine: 1, endLine: 50,
		body: '', embedding: [], indexedAt: '2026-05-31T00:00:00.000Z',
	};
}

// ---------------------------------------------------------------------------
// complexity
// ---------------------------------------------------------------------------

test('complexity: cold pin; second call is a cache hit', async () => {
	const fx = await setupFixture('code.quality.complexity');
	try {
		await upsertEntities(null, [
			fn('alpha', 'function alpha(x) { if (x > 0) return x; else return -x; }'),
			fn('beta',  'function beta(n) { for (let i = 0; i < n; i++) { if (i % 2) continue; } }'),
		]);

		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.quality.complexity',
			{ repoPath: REPO },
			{ substrate: fx.substrate },
		);
		const v1 = first.result.value as { entryCount: number };
		assert.ok(v1.entryCount > 0);
		assert.ok(!(first.result.notes ?? []).some(n => /from cache/.test(n)));

		// Cache populated.
		const ns = fx.substrate.memory.scope('skill:code.quality.complexity', 'complexity-reports');
		const cached = await ns.get(`${REPO}::*`);
		assert.ok(cached, 'complexity cache should be populated');

		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.quality.complexity',
			{ repoPath: REPO },
			{ substrate: fx.substrate },
		);
		assert.ok((second.result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('complexity: cache key narrows when `file` is set', async () => {
	const fx = await setupFixture('code.quality.complexity');
	try {
		const repoEnt = fn('alpha', 'function alpha() { return 1; }');
		await upsertEntities(null, [repoEnt]);

		// Repo-wide call.
		await runSkillIsolated('code.quality.complexity',
			{ repoPath: REPO },
			{ substrate: fx.substrate });

		// File-scoped call should miss cache (different key).
		const file = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.quality.complexity',
			{ repoPath: REPO, file: repoEnt.file },
			{ substrate: fx.substrate },
		);
		assert.ok(!(file.result.notes ?? []).some(n => /from cache/.test(n)),
			'file-scoped call must not hit the repo-wide cache');
	} finally { await fx.dispose(); }
});

// ---------------------------------------------------------------------------
// cyclic-deps
// ---------------------------------------------------------------------------

test('cyclic-deps: cold pin; second call is a cache hit', async () => {
	const fx = await setupFixture('code.quality.cyclic-deps');
	try {
		const a = fileEnt('A');
		const b = fileEnt('B');
		await upsertEntities(null, [a, b]);
		// A -> B -> A cycle
		await upsertRelations(null, [
			{ kind: 'IMPORTS', from: a.id, to: b.id, resolved: true },
			{ kind: 'IMPORTS', from: b.id, to: a.id, resolved: true },
		]);

		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.quality.cyclic-deps',
			{ repoPath: REPO },
			{ substrate: fx.substrate },
		);
		const v1 = first.result.value as { cycleCount: number };
		assert.ok(v1.cycleCount >= 1, `expected at least 1 cycle; got ${v1.cycleCount}`);

		const ns = fx.substrate.memory.scope('skill:code.quality.cyclic-deps', 'cyclic-deps-reports');
		const cached = await ns.get(REPO);
		assert.ok(cached, 'cyclic-deps cache should be populated');

		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.quality.cyclic-deps',
			{ repoPath: REPO },
			{ substrate: fx.substrate },
		);
		assert.ok((second.result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

// ---------------------------------------------------------------------------
// duplication
// ---------------------------------------------------------------------------

test('duplication: cold pin; second call is a cache hit', async () => {
	const fx = await setupFixture('code.quality.duplication');
	try {
		// Two similar function bodies.
		const body = 'function x(a, b) { const r = a + b; if (r > 10) return r; else return 0; }';
		await upsertEntities(null, [fn('foo', body), fn('bar', body)]);

		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.quality.duplication',
			{ repoPath: REPO },
			{ substrate: fx.substrate },
		);
		const v1 = first.result.value as { entityCount: number };
		assert.ok(v1.entityCount >= 2);

		const ns = fx.substrate.memory.scope('skill:code.quality.duplication', 'duplication-reports');
		const cached = await ns.get(`${REPO}::0.8`);
		assert.ok(cached, 'duplication cache should be populated');

		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.quality.duplication',
			{ repoPath: REPO },
			{ substrate: fx.substrate },
		);
		assert.ok((second.result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('duplication: cache key narrows by threshold', async () => {
	const fx = await setupFixture('code.quality.duplication');
	try {
		await upsertEntities(null, [fn('foo', 'function x() { return 1; }')]);

		await runSkillIsolated('code.quality.duplication', { repoPath: REPO }, { substrate: fx.substrate });
		const other = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.quality.duplication',
			{ repoPath: REPO, threshold: 0.5 },
			{ substrate: fx.substrate },
		);
		assert.ok(!(other.result.notes ?? []).some(n => /from cache/.test(n)),
			'different threshold should miss cache');
	} finally { await fx.dispose(); }
});

// ---------------------------------------------------------------------------
// unused-exports
// ---------------------------------------------------------------------------

test('unused-exports: cold pin; second call is a cache hit', async () => {
	const fx = await setupFixture('code.quality.unused-exports');
	try {
		await upsertEntities(null, [fn('orphan', 'function orphan() {}')]);

		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.quality.unused-exports',
			{ repoPath: REPO },
			{ substrate: fx.substrate },
		);
		const v1 = first.result.value as { candidateCount: number };
		assert.ok(v1.candidateCount > 0);

		const ns = fx.substrate.memory.scope('skill:code.quality.unused-exports', 'unused-exports-reports');
		const cached = await ns.get(`${REPO}::*`);
		assert.ok(cached, 'unused-exports cache should be populated');

		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.quality.unused-exports',
			{ repoPath: REPO },
			{ substrate: fx.substrate },
		);
		assert.ok((second.result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

// ---------------------------------------------------------------------------
// Legacy compat (just spot-check; same handler shape on all four)
// ---------------------------------------------------------------------------

test('all four quality skills run without a substrate (legacy compat)', async () => {
	const fx = await setupFixture('code.quality.complexity');
	try {
		await upsertEntities(null, [fn('alpha', 'function alpha() { return 1; }')]);
		for (const id of [
			'code.quality.complexity',
			'code.quality.cyclic-deps',
			'code.quality.duplication',
			'code.quality.unused-exports',
		]) {
			const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
				id,
				{ repoPath: REPO },
				// NO substrate passed.
			);
			assert.ok(result.value !== undefined, `${id} returned no value`);
			assert.ok(!(result.notes ?? []).some(n => /from cache/.test(n)),
				`${id} should not emit 'from cache' on legacy path`);
		}
	} finally { await fx.dispose(); }
});
