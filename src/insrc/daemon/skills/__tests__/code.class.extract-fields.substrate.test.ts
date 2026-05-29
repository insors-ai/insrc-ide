/**
 * Substrate-aware unit tests for `code.class.extract-fields` -- P1.6.
 *
 * Validates the migration:
 *   - Cache hit short-circuit (extracted-classes slot returns a fresh
 *     entry -> skill returns it without calling tools).
 *   - Cold path writes back to extracted-classes via working-state pin
 *     + distill on successful return.
 *   - Alias resolution (class-aliases slot populated directly -> skill
 *     resolves `User` to `UserModel` before the locate call).
 *   - Miss + nearest candidates persisted to recent-misses.
 *
 * Substrate is a per-test instance backed by an OS temp dir; existing
 * skill behavior is unchanged when the substrate is omitted (covered by
 * the legacy code.class.extract-fields.test.ts suite).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { runSkillIsolated, type FakeToolMap } from '../test-harness.js';
import { createMemoryStore } from '../../substrate/memory-store.js';
import { createSubstrateRuntime, type SubstrateRuntime } from '../../substrate/runtime.js';
import { getSkill } from '../registry.js';

// ---------------------------------------------------------------------------
// Test harness setup
// ---------------------------------------------------------------------------

interface Fixture {
	readonly substrate: SubstrateRuntime;
	readonly root:      string;
	dispose(): void;
}

function setupSubstrate(): Fixture {
	const root = mkdtempSync(join(tmpdir(), 'insrc-substrate-test-'));
	const memory = createMemoryStore({ workspaceId: 'wsTest', rootDir: root });
	const substrate = createSubstrateRuntime({ memory });
	return {
		substrate,
		root,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

function bootstrapSkillRegistry(fx: Fixture): void {
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	registerAllSkills();

	// Register code.class.extract-fields's substrate-facing fields.
	const skill = getSkill('code.class.extract-fields');
	assert.ok(skill, 'code.class.extract-fields not registered');
	fx.substrate.registerSkill(skill);
}

// ---------------------------------------------------------------------------
// Common fake tools
// ---------------------------------------------------------------------------

const HIT_LOCATE = {
	output:  'ok',
	format:  'text' as const,
	success: true,
	content: 'ok',
	isError: false,
	data: {
		found:    true,
		entityId: 'entity-NameNode-1',
		path:     '/repo/hadoop/NameNode.java',
		line:     42,
		language: 'java',
		kind:     'class',
	},
};

const HIT_FIELDS = {
	output:  'ok',
	format:  'text' as const,
	success: true,
	content: 'ok',
	isError: false,
	data: {
		entityId:  'entity-NameNode-1',
		className: 'NameNode',
		language:  'java',
		source:    'graph' as const,
		fields:    [
			{ name: 'rpcServer',  type: 'RPC.Server', modifiers: ['private'],            declaredAt: { path: '/repo/hadoop/NameNode.java', line: 60 } },
			{ name: 'httpServer', type: 'HttpServer', modifiers: ['private', 'final'],   declaredAt: { path: '/repo/hadoop/NameNode.java', line: 65 } },
		],
	},
};

const MISS_LOCATE = {
	output:  'ok',
	format:  'text' as const,
	success: true,
	content: 'ok',
	isError: false,
	data: {
		found:   false,
		nearest: [
			{ className: 'NameNodeRpcServer', score: 0.7, entityId: 'entity-NameNodeRpcServer' },
			{ className: 'NameNodeAdapter',    score: 0.5, entityId: 'entity-NameNodeAdapter' },
		],
	},
};

const fakesHit: FakeToolMap = {
	code_class_locate: HIT_LOCATE,
	code_class_fields: HIT_FIELDS,
};

const fakesMiss: FakeToolMap = {
	code_class_locate: MISS_LOCATE,
	code_class_fields: { output: 'unreachable', format: 'text', success: false, content: 'fields should not be called', isError: true },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('substrate: cache hit short-circuits, no tool calls', async () => {
	const fx = setupSubstrate();
	try {
		bootstrapSkillRegistry(fx);

		// Pre-warm the cache as if a prior call had succeeded.
		const ns = fx.substrate.memory.scope('skill:code.class.extract-fields', 'extracted-classes');
		await ns.put(
			'/repo/hadoop::NameNode',
			{
				found: true, entityId: 'entity-NameNode-1', className: 'NameNode', language: 'java',
				path: '/repo/hadoop/NameNode.java', line: 42, kind: 'class', source: 'graph',
				fields: [{ name: 'cached-field', declaredAt: { path: '/repo/hadoop/NameNode.java', line: 60 } }],
			},
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.95 },
		);

		// Cold-path fake tools would throw if called -- force the cache.
		// Both tools must be in the fake map so the required-tools
		// precondition passes (the harness lazily registers placeholders).
		const throwIfCalled: FakeToolMap = {
			code_class_locate: () => {
				throw new Error('locate should not be called on cache hit');
			},
			code_class_fields: () => {
				throw new Error('fields should not be called on cache hit');
			},
		};

		const { result } = await runSkillIsolated('code.class.extract-fields',
			{ className: 'NameNode', repoPath: '/repo/hadoop' },
			{ substrate: fx.substrate, fakeTools: throwIfCalled },
		);

		assert.equal(result.confidence, 'high');
		const value = result.value as { found: true; fields: { name: string }[] };
		assert.equal(value.found, true);
		assert.equal(value.fields[0]!.name, 'cached-field');
		assert.ok((result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { fx.dispose(); }
});

test('substrate: cold path pins extraction, distills on success', async () => {
	const fx = setupSubstrate();
	try {
		bootstrapSkillRegistry(fx);

		// Before: cache is cold.
		const ns = fx.substrate.memory.scope('skill:code.class.extract-fields', 'extracted-classes');
		const before = await ns.get('/repo/hadoop::NameNode');
		assert.equal(before, undefined);

		const { result } = await runSkillIsolated('code.class.extract-fields',
			{ className: 'NameNode', repoPath: '/repo/hadoop' },
			{ substrate: fx.substrate, fakeTools: fakesHit },
		);
		assert.equal(result.confidence, 'high');

		// After: cache is populated.
		const after = await ns.get<{ found: true; fields: unknown[] }>('/repo/hadoop::NameNode');
		assert.ok(after, 'extracted-classes cache should be populated post-call');
		assert.equal(after.value.found, true);
		assert.ok(Array.isArray(after.value.fields));
	} finally { fx.dispose(); }
});

test('substrate: alias resolves before locate', async () => {
	const fx = setupSubstrate();
	try {
		bootstrapSkillRegistry(fx);

		// Seed an alias: the user-asserted canonical for `User` is `NameNode`
		// in this workspace. (Contrived to reuse the fixtures.)
		await fx.substrate.memory
			.scope('skill:code.class.extract-fields', 'class-aliases')
			.put(
				'/repo/hadoop::User',
				{ userTerm: 'User', canonical: 'NameNode', repoPath: '/repo/hadoop' },
				{ kind: 'constraint', source: { kind: 'user-asserted', turnId: 'turn-1' }, confidence: 1.0 },
			);

		// Verify the alias resolves: tools see `NameNode`, not `User`.
		let seenClassName: string | undefined;
		const tracingFakes: FakeToolMap = {
			code_class_locate: (call) => {
				seenClassName = (call.input as { className: string }).className;
				return HIT_LOCATE;
			},
			code_class_fields: HIT_FIELDS,
		};

		const { result } = await runSkillIsolated('code.class.extract-fields',
			{ className: 'User', repoPath: '/repo/hadoop' },
			{ substrate: fx.substrate, fakeTools: tracingFakes },
		);

		assert.equal(seenClassName, 'NameNode', 'alias should resolve User -> NameNode');
		assert.equal(result.confidence, 'high');
	} finally { fx.dispose(); }
});

test('substrate: miss persists to recent-misses', async () => {
	const fx = setupSubstrate();
	try {
		bootstrapSkillRegistry(fx);

		const { result } = await runSkillIsolated('code.class.extract-fields',
			{ className: 'NameNodeMissingClass', repoPath: '/repo/hadoop' },
			{ substrate: fx.substrate, fakeTools: fakesMiss },
		);

		assert.equal((result.value as { found: false }).found, false);

		const missNs = fx.substrate.memory.scope('skill:code.class.extract-fields', 'recent-misses');
		const persisted = await missNs.get<{ attemptedName: string; nearest: { className: string }[] }>(
			'NameNodeMissingClass',
		);
		assert.ok(persisted, 'miss should be persisted to recent-misses');
		assert.equal(persisted.value.attemptedName, 'NameNodeMissingClass');
		assert.equal(persisted.value.nearest[0]!.className, 'NameNodeRpcServer');
	} finally { fx.dispose(); }
});

test('substrate: skill works without a substrate (legacy compatibility)', async () => {
	const fx = setupSubstrate();
	try {
		// Bootstrap the registry but don't pass `substrate` to runSkillIsolated.
		// The skill should behave exactly as the legacy path.
		_resetSkillRegistryForTests();
		_resetToolRegistryForTests();
		registerAllSkills();

		const { result } = await runSkillIsolated('code.class.extract-fields',
			{ className: 'NameNode', repoPath: '/repo/hadoop' },
			{ fakeTools: fakesHit },
		);

		assert.equal(result.confidence, 'high');
		const value = result.value as { found: true };
		assert.equal(value.found, true);
		// No "from cache" note -- legacy path was taken. (Notes can be
		// absent entirely when empty; defensive default.)
		assert.ok(!(result.notes ?? []).some(n => /from cache/.test(n)));
	} finally { fx.dispose(); }
});
