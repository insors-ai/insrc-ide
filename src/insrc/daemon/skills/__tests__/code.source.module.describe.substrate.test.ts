/**
 * Substrate-aware tests for `code.source.module.describe`.
 *
 * Same fixture pattern as code.entity.locate-by-name.substrate.test.ts:
 * in-memory LMDB graph + per-test substrate runtime. Tests assert both
 * cache short-circuit paths (where LMDB is not touched) and the cold-
 * path-then-cache-population path.
 *
 * Coverage:
 *   - Cache hit short-circuits the LMDB walk + emits 'from cache' note.
 *   - Cold path pins to module-descriptions; second call is a cache hit.
 *   - Miss persists to recent-misses; second call short-circuits.
 *   - Disk-listing fallback is NOT cached (intentional: filesystem
 *     mutates outside the substrate's knowledge).
 *   - Legacy compatibility: skill works without a substrate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { closeGraphStore, setGraphStorePath } from '../../../db/graph/store.js';
import { upsertEntities } from '../../../db/entities.js';
import { addRepo } from '../../../db/repos.js';

import { _resetSkillRegistryForTests, getSkill } from '../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { runSkillIsolated } from '../test-harness.js';

import { createMemoryStore } from '../../substrate/memory-store.js';
import { createSubstrateRuntime, type SubstrateRuntime } from '../../substrate/runtime.js';

import type { Entity, EntityKind, Language } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const REPO = '/repo/alpha';

interface Fixture {
	readonly substrate:     SubstrateRuntime;
	readonly substrateRoot: string;
	readonly graphDir:      string;
	dispose(): Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-module-describe-graph-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO, name: '', addedAt: now, status: 'pending' });

	registerAllSkills();

	const substrateRoot = mkdtempSync(join(tmpdir(), 'insrc-module-describe-substrate-'));
	const memory = createMemoryStore({ workspaceId: 'wsModule', rootDir: substrateRoot });
	const substrate = createSubstrateRuntime({ memory });

	const skill = getSkill('code.source.module.describe');
	assert.ok(skill, 'code.source.module.describe not registered');
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

function ent(opts: {
	kind: EntityKind;
	name: string;
	file: string;
	language?: Language;
	isExported?: boolean;
}): Entity {
	const language = opts.language ?? 'typescript';
	const e: Entity = {
		id:        mkId(REPO, opts.file, opts.kind, opts.name),
		kind:      opts.kind,
		name:      opts.name,
		language,
		repoId:    1,
		repo:      REPO,
		file:      opts.file,
		startLine: 1,
		endLine:   10,
		body:      '',
		embedding: [],
		indexedAt: '2026-05-30T00:00:00.000Z',
	};
	if (opts.isExported === true) e.isExported = true;
	return e;
}

function fileEnt(file: string, language: Language = 'typescript'): Entity {
	return ent({ kind: 'file', name: file, file, language });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('substrate: cache hit short-circuits the LMDB walk', async () => {
	const fx = await setupFixture();
	try {
		// Pre-warm the cache as if a prior call had succeeded.
		const ns = fx.substrate.memory.scope('skill:code.source.module.describe', 'module-descriptions');
		await ns.put(
			`${REPO}::${REPO}/src/widgets`,
			{
				found: true, modulePath: `${REPO}/src/widgets`,
				fileCount: 3, entityCount: 5, publicCount: 2,
				languages: ['typescript'],
				files: [{ path: `${REPO}/src/widgets/cached.ts`, language: 'typescript', endLine: 50, entityId: 'cached-file-id' }],
				entities: [],
				publicSurface: [],
				source: 'graph',
			},
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.95 },
		);

		// DON'T populate LMDB -- cache hit must avoid touching it.
		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.module.describe',
			{ modulePath: `${REPO}/src/widgets`, repoPath: REPO },
			{ substrate: fx.substrate },
		);

		assert.equal(result.confidence, 'high');
		const v = result.value as { found: boolean; fileCount: number; files: Array<{ entityId: string }> };
		assert.equal(v.found, true);
		assert.equal(v.fileCount, 3);
		assert.equal(v.files[0]!.entityId, 'cached-file-id', 'must come from cache, not LMDB');
		assert.ok((result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: cold path pins to module-descriptions; second call is a cache hit', async () => {
	const fx = await setupFixture();
	try {
		const moduleDir = `${REPO}/src/widgets`;
		await upsertEntities(null, [
			fileEnt(`${moduleDir}/Widget.ts`),
			ent({ kind: 'class', name: 'Widget', file: `${moduleDir}/Widget.ts`, isExported: true }),
		]);

		// First call -- cold; walks LMDB and pins.
		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.module.describe',
			{ modulePath: moduleDir, repoPath: REPO },
			{ substrate: fx.substrate },
		);
		const firstValue = first.result.value as { found: boolean; fileCount: number };
		assert.equal(firstValue.found, true);
		assert.equal(firstValue.fileCount, 1);
		assert.ok(!(first.result.notes ?? []).some(n => /from cache/.test(n)));

		// Verify the cache is populated.
		const ns = fx.substrate.memory.scope('skill:code.source.module.describe', 'module-descriptions');
		const cached = await ns.get(`${REPO}::${moduleDir}`);
		assert.ok(cached, 'cache should be populated post-call');

		// Second call -- must hit the cache.
		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.module.describe',
			{ modulePath: moduleDir, repoPath: REPO },
			{ substrate: fx.substrate },
		);
		assert.ok((second.result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: clean refusal pins to recent-misses; second call short-circuits', async () => {
	const fx = await setupFixture();
	try {
		// Module path that has no indexed files AND does NOT exist on
		// disk (so the disk-listing fallback also fails -> clean refusal).
		const phantomModule = `/nonexistent/phantom/module/${Date.now()}`;

		// First call -- cold miss, pins to recent-misses.
		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.module.describe',
			{ modulePath: phantomModule, repoPath: REPO },
			{ substrate: fx.substrate },
		);
		const firstVal = first.result.value as { found: boolean; reason?: string };
		assert.equal(firstVal.found, false);
		assert.equal(firstVal.reason, 'no-files-in-module');

		const missNs = fx.substrate.memory.scope('skill:code.source.module.describe', 'recent-misses');
		const miss = await missNs.get<{ modulePath: string }>(`${REPO}::${phantomModule}`);
		assert.ok(miss, 'miss should be persisted to recent-misses');
		assert.equal(miss.value.modulePath, phantomModule);

		// Second call -- must short-circuit via miss cache.
		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.module.describe',
			{ modulePath: phantomModule, repoPath: REPO },
			{ substrate: fx.substrate },
		);
		assert.ok((second.result.notes ?? []).some(n => /from miss cache/.test(n)),
			`expected 'from miss cache' note; got: ${JSON.stringify(second.result.notes)}`);
	} finally { await fx.dispose(); }
});

test('substrate: disk-listing fallback is NOT cached', async () => {
	const fx = await setupFixture();
	try {
		// A real directory on disk with no indexed files.
		const diskDir = mkdtempSync(join(tmpdir(), 'insrc-module-disk-only-'));
		try {
			writeFileSync(join(diskDir, 'README.md'), '# unindexed', 'utf8');
			mkdirSync(join(diskDir, 'subdir'));

			// First call -- disk-listing fallback fires (no indexed entities).
			const first = await runSkillIsolated<unknown, Record<string, unknown>>(
				'code.source.module.describe',
				{ modulePath: diskDir, repoPath: REPO },
				{ substrate: fx.substrate },
			);
			const v = first.result.value as { found: boolean; source?: string; files: unknown[] };
			assert.equal(v.found, true);
			assert.equal(v.source, 'disk-listing');
			assert.ok(v.files.length >= 1);

			// Cache and miss-cache must both be empty: disk-listing
			// intentionally avoids caching (filesystem mutates outside the
			// substrate's knowledge).
			const cacheNs = fx.substrate.memory.scope('skill:code.source.module.describe', 'module-descriptions');
			const missNs  = fx.substrate.memory.scope('skill:code.source.module.describe', 'recent-misses');
			assert.equal(await cacheNs.get(`${REPO}::${diskDir}`), undefined, 'must not cache disk-listing');
			assert.equal(await missNs.get(`${REPO}::${diskDir}`),  undefined, 'must not miss-cache disk-listing');
		} finally { rmSync(diskDir, { recursive: true, force: true }); }
	} finally { await fx.dispose(); }
});

test('substrate: skill works without a substrate (legacy compatibility)', async () => {
	const fx = await setupFixture();
	try {
		const moduleDir = `${REPO}/src/legacy`;
		await upsertEntities(null, [
			fileEnt(`${moduleDir}/Old.ts`),
			ent({ kind: 'class', name: 'Old', file: `${moduleDir}/Old.ts`, isExported: true }),
		]);

		// No substrate passed -- legacy path.
		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.module.describe',
			{ modulePath: moduleDir, repoPath: REPO },
		);

		const v = result.value as { found: boolean; entityCount: number };
		assert.equal(v.found, true);
		assert.equal(v.entityCount, 1);
		assert.ok(!(result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});
