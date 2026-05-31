/**
 * Substrate-aware tests for `code.source.file.describe`.
 *
 * Same fixture pattern as code.source.module.describe.substrate.test.ts.
 *
 * Coverage:
 *   - Cache hit short-circuits the LMDB walk + emits 'from cache' note.
 *   - Cold path pins to file-descriptions; second call is a cache hit.
 *   - Miss persists to recent-misses; second call short-circuits.
 *   - Disk-fallback (bodyExcerpt branch) is NOT cached -- the content
 *     can change between calls.
 *   - Legacy compatibility: skill works without a substrate.
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

import { _resetSkillRegistryForTests, getSkill } from '../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { runSkillIsolated } from '../test-harness.js';

import { createMemoryStore } from '../../substrate/memory-store.js';
import { createSubstrateRuntime, type SubstrateRuntime } from '../../substrate/runtime.js';

import type { Entity, EntityKind, Language } from '../../../shared/types.js';

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

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-file-describe-graph-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO, name: '', addedAt: now, status: 'pending' });

	registerAllSkills();

	const substrateRoot = mkdtempSync(join(tmpdir(), 'insrc-file-describe-substrate-'));
	const memory = createMemoryStore({ workspaceId: 'wsFile', rootDir: substrateRoot });
	const substrate = createSubstrateRuntime({ memory });

	const skill = getSkill('code.source.file.describe');
	assert.ok(skill, 'code.source.file.describe not registered');
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
		// Pre-warm the cache.
		const ns = fx.substrate.memory.scope('skill:code.source.file.describe', 'file-descriptions');
		const filePath = `${REPO}/src/Widget.ts`;
		await ns.put(
			`${REPO}::${filePath}`,
			{
				found: true, file: filePath, language: 'typescript',
				fileEntityId: 'cached-id', startLine: 1, endLine: 100,
				entityCount: 2,
				entities: [{ id: 'cached-entity', name: 'Widget', kind: 'class', startLine: 5, endLine: 50, isExported: true }],
				imports: [{ target: 'cached-import', resolved: true }],
			},
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.95 },
		);

		// DON'T populate LMDB -- cache hit must avoid touching it.
		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.file.describe',
			{ file: filePath, repoPath: REPO },
			{ substrate: fx.substrate },
		);

		assert.equal(result.confidence, 'high');
		const v = result.value as { found: boolean; entityCount: number; fileEntityId: string };
		assert.equal(v.found, true);
		assert.equal(v.fileEntityId, 'cached-id', 'must come from cache');
		assert.equal(v.entityCount, 2);
		assert.ok((result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: cold path pins; second call is a cache hit', async () => {
	const fx = await setupFixture();
	try {
		const filePath = `${REPO}/src/User.ts`;
		const file = fileEnt(filePath);
		const cls  = ent({ kind: 'class', name: 'User', file: filePath, isExported: true });
		await upsertEntities(null, [file, cls]);
		await upsertRelations(null, [
			{ kind: 'DEFINES', from: file.id, to: cls.id, resolved: true },
		]);

		// First call -- cold.
		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.file.describe',
			{ file: filePath, repoPath: REPO },
			{ substrate: fx.substrate },
		);
		assert.equal(first.result.confidence, 'high');
		assert.ok(!(first.result.notes ?? []).some(n => /from cache/.test(n)));

		// Cache populated.
		const ns = fx.substrate.memory.scope('skill:code.source.file.describe', 'file-descriptions');
		const cached = await ns.get(`${REPO}::${filePath}`);
		assert.ok(cached, 'cache should be populated after first call');

		// Second call -- cache hit.
		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.file.describe',
			{ file: filePath, repoPath: REPO },
			{ substrate: fx.substrate },
		);
		assert.ok((second.result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: file-not-indexed pins to recent-misses; second call short-circuits', async () => {
	const fx = await setupFixture();
	try {
		const phantom = `${REPO}/never-existed-${Date.now()}.ts`;

		// First call -- cold miss.
		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.file.describe',
			{ file: phantom, repoPath: REPO },
			{ substrate: fx.substrate },
		);
		const firstVal = first.result.value as { found: boolean; reason?: string };
		assert.equal(firstVal.found, false);
		assert.equal(firstVal.reason, 'file-not-indexed');

		const missNs = fx.substrate.memory.scope('skill:code.source.file.describe', 'recent-misses');
		const miss = await missNs.get<{ file: string }>(`${REPO}::${phantom}`);
		assert.ok(miss, 'miss should be persisted');

		// Second call -- short-circuit.
		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.file.describe',
			{ file: phantom, repoPath: REPO },
			{ substrate: fx.substrate },
		);
		assert.ok((second.result.notes ?? []).some(n => /from miss cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: disk-fallback (bodyExcerpt) result is NOT cached', async () => {
	const fx = await setupFixture();
	try {
		// File entity exists in graph but has no children/imports;
		// skill falls back to disk read.
		const dockerDir  = mkdtempSync(join(tmpdir(), 'insrc-file-fallback-disk-'));
		const dockerfile = join(dockerDir, 'Dockerfile');
		writeFileSync(dockerfile, 'FROM alpine\nRUN echo hello\n', 'utf8');
		try {
			const file = fileEnt(dockerfile, 'dockerfile' as Language);
			await upsertEntities(null, [file]);

			const first = await runSkillIsolated<unknown, Record<string, unknown>>(
				'code.source.file.describe',
				{ file: dockerfile, repoPath: REPO },
				{ substrate: fx.substrate },
			);
			const v = first.result.value as { found: boolean; bodyExcerptSource?: string };
			assert.equal(v.found, true);
			assert.equal(v.bodyExcerptSource, 'file-fallback');
			assert.equal(first.result.confidence, 'medium');

			// Cache must NOT be populated for disk-fallback paths.
			const ns = fx.substrate.memory.scope('skill:code.source.file.describe', 'file-descriptions');
			assert.equal(await ns.get(`${REPO}::${dockerfile}`), undefined,
				'medium-confidence disk-fallback must not be cached');
		} finally { rmSync(dockerDir, { recursive: true, force: true }); }
	} finally { await fx.dispose(); }
});

test('substrate: legacy compatibility -- works without a substrate', async () => {
	const fx = await setupFixture();
	try {
		const filePath = `${REPO}/src/Legacy.ts`;
		const file = fileEnt(filePath);
		const cls  = ent({ kind: 'class', name: 'Legacy', file: filePath, isExported: true });
		await upsertEntities(null, [file, cls]);
		await upsertRelations(null, [
			{ kind: 'DEFINES', from: file.id, to: cls.id, resolved: true },
		]);

		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.source.file.describe',
			{ file: filePath, repoPath: REPO },
		);

		const v = result.value as { found: boolean; entityCount: number };
		assert.equal(v.found, true);
		assert.equal(v.entityCount, 1);
		assert.ok(!(result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});
