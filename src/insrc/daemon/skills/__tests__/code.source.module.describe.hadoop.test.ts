/**
 * Hadoop integration tests for `code.source.module.describe`.
 *
 * Targets the already-indexed Hadoop workspace. Picks a module path
 * known to contain indexed entities (NameNode lives under
 * .../org/apache/hadoop/hdfs/server/namenode). Each test runs against
 * the real LMDB graph.
 *
 * Coverage:
 *   - Cold-path module describe against real indexed entities.
 *   - Second-call cache hit short-circuits the LMDB walk.
 *   - A definitely-empty path returns clean refusal + populates the
 *     miss cache.
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
// Known to contain indexed namenode classes (NameNode, BlockManager
// live under this tree). repoPath is the Hadoop project root (the
// indexer registers Hadoop as a single repo, not per-subproject).
const NAMENODE_DIR = join(
	HADOOP_PATH,
	'hadoop-hdfs-project/hadoop-hdfs/src/main/java/org/apache/hadoop/hdfs/server/namenode',
);
const HDFS_REPO = HADOOP_PATH;

const HADOOP_AVAILABLE = existsSync(HADOOP_PATH) && existsSync(NAMENODE_DIR);
const skipIfNoHadoop = HADOOP_AVAILABLE
	? undefined
	: { skip: 'Hadoop workspace or NAMENODE_DIR not present' };

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

	const root = mkdtempSync(join(tmpdir(), 'insrc-substrate-module-hadoop-'));
	const memory = createMemoryStore({ workspaceId: 'wsHadoopModule', rootDir: root });
	const substrate = createSubstrateRuntime({ memory });

	const skill = getSkill('code.source.module.describe');
	assert.ok(skill, 'code.source.module.describe not registered');
	substrate.registerSkill(skill);

	const session: Session = makeRealSession({ repoPath: HDFS_REPO });

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
		id: 'hadoop-module-test-session',
		repoPath: opts.repoPath,
		closureRepos: [opts.repoPath],
		startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

interface DescribeFound {
	readonly found:        true;
	readonly fileCount:    number;
	readonly entityCount:  number;
	readonly publicCount:  number;
	readonly languages:    readonly string[];
	readonly source?:      'graph' | 'disk-listing';
}

interface DescribeMiss {
	readonly found:  false;
	readonly reason: string;
}

type DescribeValue = DescribeFound | DescribeMiss;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('hadoop: NameNode module describes with indexed entities', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const result = await runSkill<{ modulePath: string; repoPath: string }, DescribeValue>(
			'code.source.module.describe',
			{ modulePath: NAMENODE_DIR, repoPath: HDFS_REPO },
			fx.runnerDeps,
		);

		assert.equal(result.confidence, 'high');
		assert.equal(result.value.found, true);
		const v = result.value as DescribeFound;
		assert.ok(v.fileCount > 0,    `expected indexed files in namenode dir; got fileCount=${v.fileCount}`);
		assert.ok(v.entityCount > 0,  `expected indexed entities in namenode dir; got entityCount=${v.entityCount}`);
		assert.ok(v.languages.includes('java'),
			`expected java in languages; got ${JSON.stringify(v.languages)}`);
		assert.equal(v.source, 'graph');
	} finally { fx.dispose(); }
});

test('hadoop: second call to NameNode dir is a cache hit', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		// First call -- cold.
		const first = await runSkill<{ modulePath: string; repoPath: string }, DescribeValue>(
			'code.source.module.describe',
			{ modulePath: NAMENODE_DIR, repoPath: HDFS_REPO },
			fx.runnerDeps,
		);
		assert.equal(first.value.found, true);
		assert.ok(!(first.notes ?? []).some(n => /from cache/.test(n)));

		// Verify the cache is populated.
		const ns = fx.substrate.memory.scope('skill:code.source.module.describe', 'module-descriptions');
		const cached = await ns.get(`${HDFS_REPO}::${NAMENODE_DIR}`);
		assert.ok(cached, 'module-descriptions cache should be populated after first call');

		// Second call -- must hit the cache.
		const second = await runSkill<{ modulePath: string; repoPath: string }, DescribeValue>(
			'code.source.module.describe',
			{ modulePath: NAMENODE_DIR, repoPath: HDFS_REPO },
			fx.runnerDeps,
		);
		assert.ok((second.notes ?? []).some(n => /from cache/.test(n)),
			`expected 'from cache' note; got: ${JSON.stringify(second.notes)}`);
	} finally { fx.dispose(); }
});

test('hadoop: nonexistent module path -> clean refusal + miss cache populated', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const phantom = `${HDFS_REPO}/this/path/does/not/exist_XyzQ_${Date.now()}`;

		const result = await runSkill<{ modulePath: string; repoPath: string }, DescribeValue>(
			'code.source.module.describe',
			{ modulePath: phantom, repoPath: HDFS_REPO },
			fx.runnerDeps,
		);
		assert.equal(result.confidence, 'high');
		assert.equal(result.value.found, false);
		assert.equal((result.value as DescribeMiss).reason, 'no-files-in-module');

		// Miss cache populated.
		const missNs = fx.substrate.memory.scope('skill:code.source.module.describe', 'recent-misses');
		const miss = await missNs.get<{ modulePath: string }>(`${HDFS_REPO}::${phantom}`);
		assert.ok(miss, 'miss should be persisted to recent-misses');
	} finally { fx.dispose(); }
});
