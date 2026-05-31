/**
 * Hadoop integration tests for `code.source.file.describe`.
 *
 * Targets the indexed NameNode.java -- the canonical Hadoop fixture.
 *
 * Coverage:
 *   - Cold-path describe against the real LMDB graph.
 *   - Second-call cache hit short-circuits the LMDB walk.
 *   - A nonexistent file -> file-not-indexed + miss-cache populated.
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
const NAMENODE_JAVA = join(
	HADOOP_PATH,
	'hadoop-hdfs-project/hadoop-hdfs/src/main/java/org/apache/hadoop/hdfs/server/namenode/NameNode.java',
);

const HADOOP_AVAILABLE = existsSync(HADOOP_PATH) && existsSync(NAMENODE_JAVA);
const skipIfNoHadoop = HADOOP_AVAILABLE
	? undefined
	: { skip: 'Hadoop workspace or NameNode.java not present' };

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

	const root = mkdtempSync(join(tmpdir(), 'insrc-substrate-file-hadoop-'));
	const memory = createMemoryStore({ workspaceId: 'wsHadoopFile', rootDir: root });
	const substrate = createSubstrateRuntime({ memory });

	const skill = getSkill('code.source.file.describe');
	assert.ok(skill, 'code.source.file.describe not registered');
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
		id: 'hadoop-file-test-session',
		repoPath: opts.repoPath,
		closureRepos: [opts.repoPath],
		startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

interface FoundOut {
	readonly found:       true;
	readonly file:        string;
	readonly language:    string;
	readonly entityCount: number;
}
interface MissOut { readonly found: false; readonly reason: string; }
type FileValue = FoundOut | MissOut;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('hadoop: NameNode.java describes with indexed entities', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const result = await runSkill<{ file: string; repoPath: string }, FileValue>(
			'code.source.file.describe',
			{ file: NAMENODE_JAVA, repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);

		assert.equal(result.confidence, 'high');
		assert.equal(result.value.found, true);
		const v = result.value as FoundOut;
		assert.equal(v.language, 'java');
		assert.ok(v.entityCount > 0, `expected indexed entities in NameNode.java; got ${v.entityCount}`);
	} finally { fx.dispose(); }
});

test('hadoop: second call to NameNode.java is a cache hit', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const first = await runSkill<{ file: string; repoPath: string }, FileValue>(
			'code.source.file.describe',
			{ file: NAMENODE_JAVA, repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		assert.equal(first.value.found, true);
		assert.ok(!(first.notes ?? []).some(n => /from cache/.test(n)));

		const ns = fx.substrate.memory.scope('skill:code.source.file.describe', 'file-descriptions');
		const cached = await ns.get(`${HADOOP_PATH}::${NAMENODE_JAVA}`);
		assert.ok(cached, 'cache should be populated after first call');

		const second = await runSkill<{ file: string; repoPath: string }, FileValue>(
			'code.source.file.describe',
			{ file: NAMENODE_JAVA, repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		assert.ok((second.notes ?? []).some(n => /from cache/.test(n)));
	} finally { fx.dispose(); }
});

test('hadoop: nonexistent file -> file-not-indexed + miss cache populated', skipIfNoHadoop ?? {}, async () => {
	const fx = setup();
	try {
		const phantom = `${HADOOP_PATH}/this/file/does/not/exist_XyzQ_${Date.now()}.java`;

		const result = await runSkill<{ file: string; repoPath: string }, FileValue>(
			'code.source.file.describe',
			{ file: phantom, repoPath: HADOOP_PATH },
			fx.runnerDeps,
		);
		assert.equal(result.confidence, 'high');
		assert.equal(result.value.found, false);
		assert.equal((result.value as MissOut).reason, 'file-not-indexed');

		const missNs = fx.substrate.memory.scope('skill:code.source.file.describe', 'recent-misses');
		const miss = await missNs.get<{ file: string }>(`${HADOOP_PATH}::${phantom}`);
		assert.ok(miss, 'miss should be persisted to recent-misses');
	} finally { fx.dispose(); }
});
