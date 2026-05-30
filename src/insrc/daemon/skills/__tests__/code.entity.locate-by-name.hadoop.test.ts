/**
 * Hadoop integration tests for `code.entity.locate-by-name`.
 *
 * Targets the already-indexed Hadoop workspace at
 *   /Users/subhagho/work/projects/insors/hadoop
 *
 * Verified fixtures (via the indexed entity graph):
 *   - NameNode             (>=1 hit; canonical class)
 *   - BlockManager         (>=1 hit; canonical class)
 *   - Configuration        (>=2 hits; multi-match across hadoop-common
 *                            + hadoop-yarn-services)
 *
 * Coverage:
 *   - Cold-path locate against the real LMDB graph.
 *   - Second-call cache hit short-circuits the LMDB walk.
 *   - Nonexistent name -> empty + miss-cache populated.
 *   - Second-call miss-cache short-circuit.
 *   - Multi-match Configuration returns 2+ entities from different repos.
 *
 * Skips gracefully if the Hadoop workspace isn't present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
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
// Harness
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

	const root = mkdtempSync(join(tmpdir(), 'insrc-substrate-locate-hadoop-'));
	const memory = createMemoryStore({ workspaceId: 'wsHadoopLocate', rootDir: root });
	const substrate = createSubstrateRuntime({ memory });

	const skill = getSkill('code.entity.locate-by-name');
	assert.ok(skill, 'code.entity.locate-by-name not registered');
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
		id: 'hadoop-locate-test-session',
		repoPath: opts.repoPath,
		closureRepos: [opts.repoPath],
		startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

interface LocateMatch {
	readonly id:   string;
	readonly name: string;
	readonly kind: string;
	readonly repo: string;
	readonly file: string;
}

interface LocateValue {
	readonly name:    string;
	readonly matches: readonly LocateMatch[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('hadoop: NameNode resolves with real graph data', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const result = await runSkill<{ name: string; repoPath: string }, LocateValue>(
			'code.entity.locate-by-name',
			{ name: 'NameNode', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);

		assert.equal(result.confidence, 'high');
		const v = result.value;
		assert.ok(v.matches.length >= 1, `expected at least 1 match for NameNode; got ${v.matches.length}`);
		// At least one match should be the canonical NameNode class.
		assert.ok(v.matches.some(m => m.name === 'NameNode' && m.kind === 'class'),
			`no class:NameNode match in ${JSON.stringify(v.matches.map(m => `${m.kind}:${m.name}`))}`);
	} finally { fx.dispose(); }
});

test('hadoop: second call to NameNode is a cache hit', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		// First call -- cold.
		const first = await runSkill<{ name: string; repoPath: string }, LocateValue>(
			'code.entity.locate-by-name',
			{ name: 'NameNode', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		assert.ok(first.value.matches.length >= 1);
		assert.ok(!(first.notes ?? []).some(n => /from cache/.test(n)));

		// Verify the cache slot is populated.
		const ns = fx.substrate.memory.scope('skill:code.entity.locate-by-name', 'located-entities');
		const cached = await ns.get(`NameNode::*::repo:${HADOOP_PATH}::*`);
		assert.ok(cached, 'located-entities cache should be populated after first call');

		// Second call -- must hit the cache.
		const second = await runSkill<{ name: string; repoPath: string }, LocateValue>(
			'code.entity.locate-by-name',
			{ name: 'NameNode', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		assert.ok((second.notes ?? []).some(n => /from cache/.test(n)),
			`expected 'from cache' note on second call; got: ${JSON.stringify(second.notes)}`);
	} finally { fx.dispose(); }
});

test('hadoop: BlockManager resolves', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const result = await runSkill<{ name: string; repoPath: string }, LocateValue>(
			'code.entity.locate-by-name',
			{ name: 'BlockManager', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		assert.equal(result.confidence, 'high');
		assert.ok(result.value.matches.length >= 1);
	} finally { fx.dispose(); }
});

test('hadoop: nonexistent name -> empty + miss cache populated', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const result = await runSkill<{ name: string; repoPath: string }, LocateValue>(
			'code.entity.locate-by-name',
			{ name: 'ThisClassDefinitelyDoesNotExist_XyzQ', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		assert.equal(result.confidence, 'medium');
		assert.equal(result.value.matches.length, 0);

		// Miss cache populated.
		const missNs = fx.substrate.memory.scope('skill:code.entity.locate-by-name', 'recent-misses');
		const miss = await missNs.get<{ name: string }>('ThisClassDefinitelyDoesNotExist_XyzQ');
		assert.ok(miss, 'miss should be persisted to recent-misses');
		assert.equal(miss.value.name, 'ThisClassDefinitelyDoesNotExist_XyzQ');
	} finally { fx.dispose(); }
});

test('hadoop: second call to nonexistent name short-circuits via miss cache', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		// Prime the miss.
		await runSkill<{ name: string; repoPath: string }, LocateValue>(
			'code.entity.locate-by-name',
			{ name: 'ThisClassDefinitelyDoesNotExist_XyzQ', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);

		const second = await runSkill<{ name: string; repoPath: string }, LocateValue>(
			'code.entity.locate-by-name',
			{ name: 'ThisClassDefinitelyDoesNotExist_XyzQ', repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		assert.ok((second.notes ?? []).some(n => /from miss cache/.test(n)),
			`expected 'from miss cache' note on second call; got: ${JSON.stringify(second.notes)}`);
	} finally { fx.dispose(); }
});

test('hadoop: Configuration multi-match returns 2+ entities', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		// Use scope: 'global' to span every indexed repo (multi-repo Hadoop project).
		const result = await runSkill<{ name: string; scope: string }, LocateValue>(
			'code.entity.locate-by-name',
			{ name: 'Configuration', scope: 'global' },
			fx.runnerDeps,
		);
		assert.equal(result.confidence, 'high');
		// Two or more Configuration classes across the hadoop subprojects.
		assert.ok(result.value.matches.length >= 2,
			`expected 2+ Configuration matches across hadoop subprojects; got ${result.value.matches.length}`);
	} finally { fx.dispose(); }
});
