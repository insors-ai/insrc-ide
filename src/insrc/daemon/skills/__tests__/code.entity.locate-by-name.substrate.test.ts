/**
 * Substrate-aware tests for `code.entity.locate-by-name`.
 *
 * Built on the same in-memory LMDB fixture used by code.entity.test.ts
 * so the cold path actually walks the name_index. The substrate runtime
 * is set up per-test in a tmpdir; tests assert both the cache short-
 * circuit paths AND the cold-path-then-cache-population path.
 *
 * Coverage:
 *   - Cache hit short-circuits the LMDB walk + returns 'from cache' note.
 *   - Cold path writes back to located-entities via working-state pin
 *     + distill; a second call returns from cache.
 *   - Alias rewrites the lookup name before LMDB; cold path uses the
 *     canonical name + a second call returns from cache (keyed by
 *     canonical).
 *   - Miss persists to recent-misses; a second call short-circuits.
 *   - Preferred-repo re-rank floats the preferred-repo match to the front.
 *   - Legacy compatibility: skill works without a substrate, returning
 *     the same results as the legacy path.
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
// Test harness
// ---------------------------------------------------------------------------

const REPO_A = '/repo/alpha';
const REPO_B = '/repo/beta';

interface Fixture {
	readonly substrate: SubstrateRuntime;
	readonly substrateRoot: string;
	readonly graphDir:      string;
	dispose(): Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-locate-by-name-graph-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO_A, name: '', addedAt: now, status: 'pending' });
	await addRepo(null, { path: REPO_B, name: '', addedAt: now, status: 'pending' });

	registerAllSkills();

	const substrateRoot = mkdtempSync(join(tmpdir(), 'insrc-locate-by-name-substrate-'));
	const memory = createMemoryStore({ workspaceId: 'wsLocate', rootDir: substrateRoot });
	const substrate = createSubstrateRuntime({ memory });

	const skill = getSkill('code.entity.locate-by-name');
	assert.ok(skill, 'code.entity.locate-by-name not registered');
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
	language?: Language;
	isExported?: boolean;
}): Entity {
	const repo     = opts.repo     ?? REPO_A;
	const repoId   = opts.repoId   ?? 1;
	const file     = opts.file     ?? `${repo}/src/${opts.name}.ts`;
	const language = opts.language ?? 'typescript';
	const e: Entity = {
		id:        mkId(repo, file, opts.kind, opts.name),
		kind:      opts.kind,
		name:      opts.name,
		language,
		repoId,
		repo,
		file,
		startLine: 1,
		endLine:   10,
		body:      '',
		embedding: [],
		indexedAt: '2026-05-30T00:00:00.000Z',
	};
	if (opts.isExported === true) { e.isExported = true; }
	return e;
}

const SESSION_FIELDS_A = Object.freeze({
	repoPath:     REPO_A,
	closureRepos: [REPO_A],
});

const SESSION_FIELDS_AB = Object.freeze({
	repoPath:     REPO_A,
	closureRepos: [REPO_A, REPO_B],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('substrate: cache hit short-circuits the LMDB walk', async () => {
	const fx = await setupFixture();
	try {
		// Pre-warm the cache as if a prior call had succeeded. Cache key
		// matches the request { name: 'NameNode', kinds: undefined,
		// scope: 'closure' (default), language: undefined } -> uses '*'
		// for kinds and language.
		const ns = fx.substrate.memory.scope('skill:code.entity.locate-by-name', 'located-entities');
		await ns.put(
			'NameNode::*::scope:closure::*',
			{
				name: 'NameNode',
				matches: [{
					id: 'cached-id', name: 'NameNode', kind: 'class', language: 'java',
					file: '/cached/NameNode.java', repo: REPO_A, startLine: 1, endLine: 2,
				}],
			},
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.95 },
		);

		// DON'T populate LMDB -- the cache hit must avoid touching it
		// (if the skill walked the empty LMDB it would return 0 matches).
		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.locate-by-name',
			{ name: 'NameNode' },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION_FIELDS_A } },
		);

		assert.equal(result.confidence, 'high');
		const v = result.value as { name: string; matches: Array<{ id: string }> };
		assert.equal(v.matches.length, 1);
		assert.equal(v.matches[0]!.id, 'cached-id', 'must come from cache, not LMDB');
		assert.ok((result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: cold path pins to located-entities; second call is a cache hit', async () => {
	const fx = await setupFixture();
	try {
		const e = ent({ kind: 'class', name: 'Widget', isExported: true });
		await upsertEntities(null, [e]);

		// First call -- cold; walks LMDB and pins.
		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.locate-by-name',
			{ name: 'Widget' },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION_FIELDS_A } },
		);
		const firstMatches = (first.result.value as { matches: unknown[] }).matches;
		assert.equal(firstMatches.length, 1);
		assert.equal(first.result.confidence, 'high');
		assert.ok(!(first.result.notes ?? []).some(n => /from cache/.test(n)));

		// Verify the cache is populated.
		const ns = fx.substrate.memory.scope('skill:code.entity.locate-by-name', 'located-entities');
		const cached = await ns.get('Widget::*::scope:closure::*');
		assert.ok(cached, 'cache should be populated post-call');

		// Second call -- must hit the cache.
		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.locate-by-name',
			{ name: 'Widget' },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION_FIELDS_A } },
		);
		assert.ok((second.result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: alias resolves before the LMDB walk', async () => {
	const fx = await setupFixture();
	try {
		// Seed an alias: 'User' -> 'UserModel' in REPO_A.
		await fx.substrate.memory.scope('skill:code.entity.locate-by-name', 'name-aliases').put(
			`${REPO_A}::User`,
			{ userTerm: 'User', canonical: 'UserModel', repoPath: REPO_A },
			{ kind: 'constraint', source: { kind: 'user-asserted', turnId: 'turn-1' }, confidence: 1.0 },
		);

		// Populate LMDB with UserModel, NOT User.
		const e = ent({ kind: 'class', name: 'UserModel', isExported: true });
		await upsertEntities(null, [e]);

		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.locate-by-name',
			{ name: 'User' },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION_FIELDS_A } },
		);

		const v = result.value as { matches: Array<{ name: string }> };
		assert.equal(v.matches.length, 1, 'alias must resolve to UserModel');
		assert.equal(v.matches[0]!.name, 'UserModel');
		assert.ok((result.notes ?? []).some(n => /alias:.*User.*UserModel/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: miss persists to recent-misses; second call is a miss-cache hit', async () => {
	const fx = await setupFixture();
	try {
		// LMDB is intentionally empty for this name.

		// First call -- cold miss.
		const first = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.locate-by-name',
			{ name: 'ThisDoesNotExist_XyzQ' },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION_FIELDS_A } },
		);
		assert.equal((first.result.value as { matches: unknown[] }).matches.length, 0);
		assert.equal(first.result.confidence, 'medium');

		// Verify the miss is in recent-misses.
		const missNs = fx.substrate.memory.scope('skill:code.entity.locate-by-name', 'recent-misses');
		const miss = await missNs.get<{ name: string }>('ThisDoesNotExist_XyzQ');
		assert.ok(miss, 'miss should be persisted to recent-misses');
		assert.equal(miss.value.name, 'ThisDoesNotExist_XyzQ');

		// Second call -- must short-circuit via miss cache.
		const second = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.locate-by-name',
			{ name: 'ThisDoesNotExist_XyzQ' },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION_FIELDS_A } },
		);
		assert.ok((second.result.notes ?? []).some(n => /from miss cache/.test(n)));
	} finally { await fx.dispose(); }
});

test('substrate: preferred-repo re-rank floats the preferred match to the front', async () => {
	const fx = await setupFixture();
	try {
		// Two repos contain a Configuration class.
		await upsertEntities(null, [
			ent({ kind: 'class', name: 'Configuration', repo: REPO_A, repoId: 1, file: `${REPO_A}/Configuration.ts` }),
			ent({ kind: 'class', name: 'Configuration', repo: REPO_B, repoId: 2, file: `${REPO_B}/Configuration.ts` }),
		]);

		// Assert preference for REPO_B.
		await fx.substrate.memory
			.scope('skill:code.entity.locate-by-name', 'preferred-repo-for-name')
			.put(
				'Configuration',
				{ name: 'Configuration', preferredRepo: REPO_B, reason: 'workspace policy' },
				{ kind: 'constraint', source: { kind: 'user-asserted', turnId: 'turn-1' }, confidence: 1.0 },
			);

		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.locate-by-name',
			{ name: 'Configuration' },
			{ substrate: fx.substrate, extraSessionFields: { ...SESSION_FIELDS_AB } },
		);

		const v = result.value as { matches: Array<{ repo: string }> };
		assert.equal(v.matches.length, 2);
		assert.equal(v.matches[0]!.repo, REPO_B, 'preferred repo must come first');
		assert.equal(v.matches[1]!.repo, REPO_A);
	} finally { await fx.dispose(); }
});

test('substrate: skill works without a substrate (legacy compatibility)', async () => {
	const fx = await setupFixture();
	try {
		const e = ent({ kind: 'class', name: 'LegacyOnly', isExported: true });
		await upsertEntities(null, [e]);

		// No substrate passed -- legacy path.
		const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
			'code.entity.locate-by-name',
			{ name: 'LegacyOnly' },
			{ extraSessionFields: { ...SESSION_FIELDS_A } },
		);

		const v = result.value as { matches: Array<{ name: string }> };
		assert.equal(v.matches.length, 1);
		assert.equal(v.matches[0]!.name, 'LegacyOnly');
		// No 'from cache' note on the legacy path.
		assert.ok(!(result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { await fx.dispose(); }
});
