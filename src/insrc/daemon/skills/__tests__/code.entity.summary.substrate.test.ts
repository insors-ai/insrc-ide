/**
 * Substrate-aware tests for `code.entity.summary`.
 *
 * Same fixture pattern as the other code-skill substrate tests:
 * in-memory LMDB + per-test substrate runtime.
 *
 * Coverage:
 *   - Cache hit short-circuits LMDB; emits 'from cache' note.
 *   - Cold path pins to entity-summaries; second call is a cache hit.
 *   - entity-not-found pins to recent-misses; second call short-circuits.
 *   - entity-out-of-scope is NOT cached (scope flips per session).
 *   - Disk-fallback (excerptSource: 'file-fallback') is NOT cached.
 *   - Legacy compatibility: skill works without a substrate.
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

import { _resetSkillRegistryForTests, getSkill } from '../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { runSkillIsolated } from '../test-harness.js';

import { createMemoryStore } from '../../substrate/memory-store.js';
import { createSubstrateRuntime, type SubstrateRuntime } from '../../substrate/runtime.js';

import type { Entity, EntityKind, Language } from '../../../shared/types.js';

// ---------------------------------------------------------------------------

const REPO = '/repo/alpha';
const OTHER_REPO = '/repo/elsewhere';

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

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-entity-summary-graph-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO,       name: '', addedAt: now, status: 'pending' });
	await addRepo(null, { path: OTHER_REPO, name: '', addedAt: now, status: 'pending' });

	registerAllSkills();

	const substrateRoot = mkdtempSync(join(tmpdir(), 'insrc-entity-summary-substrate-'));
	const memory = createMemoryStore({ workspaceId: 'wsSummary', rootDir: substrateRoot });
	const substrate = createSubstrateRuntime({ memory });

	const skill = getSkill('code.entity.summary');
	assert.ok(skill, 'code.entity.summary not registered');
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
	repo?: string;
	repoId?: number;
	file?: string;
	body?: string;
	language?: Language;
}): Entity {
	const repo     = opts.repo     ?? REPO;
	const repoId   = opts.repoId   ?? 1;
	const file     = opts.file     ?? `${repo}/src/${opts.name}.ts`;
	const language = opts.language ?? 'typescript';
	return {
		id:        mkId(repo, file, opts.kind, opts.name),
		kind:      opts.kind,
		name:      opts.name,
		language,
		repoId,
		repo,
		file,
		startLine: 1,
		endLine:   10,
		body:      opts.body ?? '',
		embedding: [],
		indexedAt: '2026-05-31T00:00:00.000Z',
	};
}

const SESSION = Object.freeze({ repoPath: REPO, closureRepos: [REPO] });

// ---------------------------------------------------------------------------

test('substrate: cache hit short-circuits the getEntity read', async () => {
	const fx = await setupFixture();
	try {
		const entId = mkId(REPO, `${REPO}/src/Widget.ts`, 'class', 'Widget');
		// Pre-warm cache.
		await fx.substrate.memory
			.scope('skill:code.entity.summary', 'entity-summaries')
			.put(
				`${entId}::800::closure`,
				{
					found: true, entityId: entId, name: 'CachedWidget',
					kind: 'class', language: 'typescript',
					file: '/cached/file.ts', startLine: 1, endLine: 99,
					excerpt: 'cached body', excerptTruncated: false, excerptSource: 'graph',
				},
				{ kind: 'fact', source: { kind: 'test' }, confidence: 0.95 },
			);

		// DON'T populate LMDB.
		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.summary',
			{ entityId: entId },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION } },
		);

		assert.equal(result.confidence, 'high');
		const v = result.value as { found: boolean; name: string; excerpt: string };
		assert.equal(v.found, true);
		assert.equal(v.name, 'CachedWidget', 'must come from cache');
		assert.equal(v.excerpt, 'cached body');
		assert.ok((result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: cold path pins; second call is a cache hit', async () => {
	const fx = await setupFixture();
	try {
		const e = ent({ kind: 'class', name: 'User', body: 'class User { id: string; }\n' });
		await upsertEntities(null, [e]);

		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.summary',
			{ entityId: e.id },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION } },
		);
		assert.equal(first.result.confidence, 'high');
		const v = first.result.value as { found: boolean; excerpt: string };
		assert.equal(v.found, true);
		assert.match(v.excerpt, /class User/);
		assert.ok(!(first.result.notes ?? []).some(n => /from cache/.test(n)));

		const ns = fx.substrate.memory.scope('skill:code.entity.summary', 'entity-summaries');
		const cached = await ns.get(`${e.id}::800::closure`);
		assert.ok(cached, 'cache should be populated post-call');

		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.summary',
			{ entityId: e.id },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION } },
		);
		assert.ok((second.result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: entity-not-found pins to recent-misses; second call short-circuits', async () => {
	const fx = await setupFixture();
	try {
		const phantomId = 'a'.repeat(32);

		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.summary',
			{ entityId: phantomId },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION } },
		);
		const v = first.result.value as { found: boolean; reason?: string };
		assert.equal(v.found, false);
		assert.equal(v.reason, 'entity-not-found');

		const missNs = fx.substrate.memory.scope('skill:code.entity.summary', 'recent-misses');
		const miss = await missNs.get<{ entityId: string }>(phantomId);
		assert.ok(miss, 'miss should be persisted');

		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.summary',
			{ entityId: phantomId },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION } },
		);
		assert.ok((second.result.notes ?? []).some(n => /from miss cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: out-of-scope is NOT cached (scope flips per session)', async () => {
	const fx = await setupFixture();
	try {
		// Entity lives in OTHER_REPO, session closure is REPO only.
		const e = ent({
			kind: 'class', name: 'Foreign',
			repo: OTHER_REPO, repoId: 2,
			file: `${OTHER_REPO}/src/Foreign.ts`,
			body: 'class Foreign {}',
		});
		await upsertEntities(null, [e]);

		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.summary',
			{ entityId: e.id },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION } },
		);
		const v = result.value as { found: boolean; reason?: string };
		assert.equal(v.found, false);
		assert.equal(v.reason, 'entity-out-of-scope');

		// Neither cache nor miss-cache should record this -- scope changes
		// per session, so we don't want a stale rejection.
		const ns     = fx.substrate.memory.scope('skill:code.entity.summary', 'entity-summaries');
		const missNs = fx.substrate.memory.scope('skill:code.entity.summary', 'recent-misses');
		assert.equal(await ns.get(`${e.id}::800::closure`), undefined);
		assert.equal(await missNs.get(e.id), undefined);
	} finally { await fx.dispose(); }
});

test('substrate: disk-fallback (medium confidence) is NOT cached', async () => {
	const fx = await setupFixture();
	try {
		// File entity with empty body -> skill tries the disk fallback.
		// Disk read fails (path doesn't exist), so confidence='low' and
		// we don't cache. Tests the "don't cache medium-or-below" rule.
		const e = ent({
			kind: 'file', name: '/repo/alpha/src/no-such-file.yaml',
			file: '/repo/alpha/src/no-such-file.yaml',
			language: 'unknown' as Language,
			body: '',
		});
		await upsertEntities(null, [e]);

		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.summary',
			{ entityId: e.id },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION } },
		);
		const v = result.value as { found: boolean; excerptSource?: string; excerpt: string };
		assert.equal(v.found, true);
		assert.equal(v.excerpt, '');
		// Cache must NOT be populated -- only high-confidence path caches.
		const ns = fx.substrate.memory.scope('skill:code.entity.summary', 'entity-summaries');
		assert.equal(await ns.get(`${e.id}::800::closure`), undefined,
			'low/medium-confidence results must not be cached');
	} finally { await fx.dispose(); }
});

test('substrate: legacy compatibility -- works without a substrate', async () => {
	const fx = await setupFixture();
	try {
		const e = ent({ kind: 'class', name: 'Legacy', body: 'class Legacy {}' });
		await upsertEntities(null, [e]);

		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.summary',
			{ entityId: e.id },
			{ extraSessionFields: { ...SESSION } },
		);
		const v = result.value as { found: boolean; name: string };
		assert.equal(v.found, true);
		assert.equal(v.name, 'Legacy');
		assert.ok(!(result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});
