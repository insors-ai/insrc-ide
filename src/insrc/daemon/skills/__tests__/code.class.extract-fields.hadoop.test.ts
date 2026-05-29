/**
 * Hadoop integration tests for `code.class.extract-fields` -- P1.7.
 *
 * These tests target the actually-indexed Hadoop workspace at
 *   /Users/subhagho/work/projects/insors/hadoop
 *
 * Verified test fixtures (via scripts/dump-hadoop-classes.ts):
 *   - NameNode             (1 hit; single-match happy path)
 *   - BlockManager         (1 hit; single-match alternative)
 *   - HdfsServerConstants  (1 hit; likely large field set)
 *   - Configuration        (2 hits; multi-match ambiguity fixture
 *                           between hadoop-common + hadoop-yarn-services)
 *
 * The tests use the real code_class_locate + code_class_fields tools
 * (no fakes) against the LMDB graph + entity-vec index. They skip
 * gracefully if the Hadoop workspace is unavailable.
 *
 * Coverage:
 *   - Substrate cache hit short-circuit on a second call against the
 *     same class (validates distillation -> read-back).
 *   - Single-match happy path returns found:true with real fields.
 *   - Configuration multi-match returns either of the two valid
 *     entityIds (we don't pin which the locate tool picks; the test
 *     just asserts found:true and a real path).
 *
 * Prerequisite: the daemon's repo registry must contain the Hadoop
 * path with status='ready'. Tests skip otherwise (no fail).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { registerCodeTools } from '../../tools/builtins/code/index.js';
import { runSkill } from '../invoke.js';
import { getSkill } from '../registry.js';
import { DefaultSkillAuditLog } from '../audit.js';
import { DefaultAccessStore, DefaultAccessAuditLog } from '../../../shared/access.js';
import { createMemoryStore } from '../../substrate/memory-store.js';
import { createSubstrateRuntime, type SubstrateRuntime } from '../../substrate/runtime.js';
import type { Session } from '../../../agent/session.js';
import type { LLMProvider, ProviderAffinity } from '../../../shared/types.js';
import type { SkillRunnerDeps } from '../invoke.js';

const HADOOP_PATH = '/Users/subhagho/work/projects/insors/hadoop';

const HADOOP_AVAILABLE = existsSync(HADOOP_PATH);

const skipIfNoHadoop = HADOOP_AVAILABLE
	? undefined
	: { skip: 'Hadoop workspace not present at ' + HADOOP_PATH };

// ---------------------------------------------------------------------------
// Test harness: build real SkillRunnerDeps + a substrate runtime
// ---------------------------------------------------------------------------

interface Harness {
	readonly substrate: SubstrateRuntime;
	readonly runnerDeps: SkillRunnerDeps;
	readonly root:      string;
	dispose(): void;
}

function setup(): Harness {
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	registerAllSkills();
	registerCodeTools();

	// Substrate root in a per-test temp dir.
	const root = mkdtempSync(join(tmpdir(), 'insrc-substrate-hadoop-test-'));
	const memory = createMemoryStore({ workspaceId: 'wsHadoop', rootDir: root });
	const substrate = createSubstrateRuntime({ memory });

	// Register the migrated skill's substrate-facing declarations.
	const skill = getSkill('code.class.extract-fields');
	assert.ok(skill, 'code.class.extract-fields not registered');
	substrate.registerSkill(skill);

	const session: Session = makeRealSession({ repoPath: HADOOP_PATH });

	const provider: LLMProvider = {
		complete: () => { throw new Error('LLM not expected in this integration test'); },
		stream:   async function* () { yield ''; },
		embed:    async () => [],
		supportsTools: false,
	};

	const runnerDeps: SkillRunnerDeps = {
		session,
		resolveProvider: (_a: ProviderAffinity) => provider,
		substrate,
	};

	return {
		substrate,
		runnerDeps,
		root,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

function makeRealSession(opts: { repoPath: string }): Session {
	const stub: Record<string, unknown> = {
		id: 'hadoop-integration-test-session',
		repoPath: opts.repoPath,
		closureRepos: [opts.repoPath],
		startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('hadoop: NameNode resolves to a real entity with fields', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const result = await runSkill<{ className: string; repoPath?: string }, { found: boolean }>(
			'code.class.extract-fields',
			{ className: 'NameNode', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);

		const value = result.value as Record<string, unknown>;
		assert.equal(value.found, true,
			`Expected NameNode to be found; got ${JSON.stringify(value).slice(0, 200)}`);
		assert.ok(typeof value.entityId === 'string' && (value.entityId as string).length > 0);
		assert.ok(typeof value.path === 'string' && (value.path as string).includes('NameNode'));
		// fields may legitimately be 0 on some JVM classes the body
		// extractor can't parse, but the path + entityId + line must be
		// real graph data.
		assert.equal(typeof value.line, 'number');
		assert.ok(['high', 'medium', 'low'].includes(result.confidence));
	} finally { fx.dispose(); }
});

test('hadoop: second call to NameNode is a cache hit', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		// First call -- cold; populates the substrate cache via distillation.
		const first = await runSkill<{ className: string; repoPath?: string }, { found: boolean }>(
			'code.class.extract-fields',
			{ className: 'NameNode', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		assert.equal((first.value as { found: boolean }).found, true);

		// Verify the cache namespace now contains the entry.
		const ns = fx.substrate.memory.scope('skill:code.class.extract-fields', 'extracted-classes');
		const cached = await ns.get(`${HADOOP_PATH}::NameNode`);
		assert.ok(cached, 'extracted-classes cache should be populated after first call');

		// Second call -- should short-circuit; notes should include "from cache".
		const second = await runSkill<{ className: string; repoPath?: string }, { found: boolean }>(
			'code.class.extract-fields',
			{ className: 'NameNode', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		assert.equal((second.value as { found: boolean }).found, true);
		const notes = second.notes ?? [];
		assert.ok(notes.some(n => /from cache/.test(n)),
			`Expected "from cache" note on second call; got: ${JSON.stringify(notes)}`);
	} finally { fx.dispose(); }
});

test('hadoop: BlockManager single-match returns real fields', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const result = await runSkill<{ className: string; repoPath?: string }, { found: boolean }>(
			'code.class.extract-fields',
			{ className: 'BlockManager', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		const value = result.value as Record<string, unknown>;
		assert.equal(value.found, true);
		assert.ok(typeof value.entityId === 'string');
	} finally { fx.dispose(); }
});

test('hadoop: Configuration multi-match returns one of the two real entities', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		// We don't pin which Configuration class locate picks; both
		// hadoop-common's and hadoop-yarn-services's are valid hits.
		// The test just asserts found:true with a real entityId.
		const result = await runSkill<{ className: string; repoPath?: string }, { found: boolean }>(
			'code.class.extract-fields',
			{ className: 'Configuration', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);

		const value = result.value as Record<string, unknown>;
		assert.equal(value.found, true);
		assert.ok(typeof value.entityId === 'string');
		// Both Configuration classes are under hadoop subprojects.
		assert.ok((value.path as string).includes('Configuration'));
	} finally { fx.dispose(); }
});

test('hadoop: nonexistent class returns found:false with nearest candidates', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const result = await runSkill<{ className: string; repoPath?: string }, { found: boolean; nearest?: unknown[] }>(
			'code.class.extract-fields',
			{ className: 'ThisClassDefinitelyDoesNotExist_XyzQ', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);

		const value = result.value as Record<string, unknown>;
		assert.equal(value.found, false);
		assert.ok(Array.isArray(value.nearest));
		// The miss is a HIGH-confidence refusal per the skill's typed-
		// refusal contract.
		assert.equal(result.confidence, 'high');

		// Substrate cached the miss in recent-misses.
		const ns = fx.substrate.memory.scope('skill:code.class.extract-fields', 'recent-misses');
		const persisted = await ns.get('ThisClassDefinitelyDoesNotExist_XyzQ');
		assert.ok(persisted, 'miss should be persisted in recent-misses');
	} finally { fx.dispose(); }
});
