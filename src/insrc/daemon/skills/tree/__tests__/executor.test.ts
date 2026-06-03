/**
 * Tests for the skill-tree executor (P3 of
 * plans/planner-skill-tree.md).
 *
 * Coverage:
 *   - tokenizePath: prop, iter, mixed, rejects positional indexes.
 *   - resolvePath: scalar prop, nested, iter over array of scalars,
 *     iter over array of objects with sub-prop, errors on type
 *     mismatch + nested [*][*].
 *   - resolveBinding: every source variant produces the right value;
 *     missing source-node fails clean.
 *   - executeTree: end-to-end with a stub skill registry. Inputs flow
 *     from earlier-sibling outputs to later siblings; failures cascade
 *     to downstream wires that depended on them.
 *   - stitchTreeSections: section nodes rendered depth-first;
 *     intermediate / discard nodes don't appear; failed nodes render
 *     a "Failed" stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	tokenizePath,
	resolvePath,
	resolveBinding,
	executeTree,
	stitchTreeSections,
	type TreeContext,
	type TreeExecutionEvent,
} from '../executor.js';
import { validatePlannedTree, type PlannedTree, type PlannedNode } from '../../../../agent/content-gen/plan-tree.js';

import { _resetSkillRegistryForTests, registerSkill } from '../../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../tools/registry.js';
import { closeGraphStore, setGraphStorePath } from '../../../../db/graph/store.js';
import { addRepo } from '../../../../db/repos.js';
import { DefaultAccessAuditLog, DefaultAccessStore } from '../../../../shared/access.js';
import { DefaultSkillAuditLog } from '../../audit.js';
import type { Session } from '../../../../agent/session.js';
import type { Skill } from '../../types.js';
import type { LLMProvider } from '../../../../shared/types.js';

// ---------------------------------------------------------------------------
// Path tokenizer / resolver
// ---------------------------------------------------------------------------

test('tokenizePath: simple prop chain', () => {
	const r = tokenizePath('vendor.name') as readonly { kind: string; name?: string }[];
	assert.deepEqual([...r], [{ kind: 'prop', name: 'vendor' }, { kind: 'prop', name: 'name' }]);
});

test('tokenizePath: iter then prop', () => {
	const r = tokenizePath('fields[*].name') as readonly { kind: string; name?: string }[];
	assert.deepEqual([...r], [{ kind: 'prop', name: 'fields' }, { kind: 'iter' }, { kind: 'prop', name: 'name' }]);
});

test('tokenizePath: positional index rejected', () => {
	const r = tokenizePath('fields[0].name');
	assert.ok(!Array.isArray(r), 'expected error');
	assert.match((r as { error: string }).error, /\[\*\]/);
});

test('tokenizePath: empty path rejected', () => {
	const r = tokenizePath('');
	assert.ok(!Array.isArray(r));
	assert.match((r as { error: string }).error, /empty/);
});

test('resolvePath: top-level prop', () => {
	assert.equal(resolvePath({ x: 7 }, 'x'), 7);
});

test('resolvePath: nested prop', () => {
	assert.equal(resolvePath({ a: { b: { c: 'hit' } } }, 'a.b.c'), 'hit');
});

test('resolvePath: iter over scalars returns the array', () => {
	assert.deepEqual(resolvePath({ tags: ['a', 'b'] }, 'tags[*]'), ['a', 'b']);
});

test('resolvePath: iter then prop maps over each element', () => {
	const r = resolvePath({ fields: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }, 'fields[*].name');
	assert.deepEqual(r, ['a', 'b', 'c']);
});

test('resolvePath: missing prop yields undefined', () => {
	assert.equal(resolvePath({ x: 1 }, 'missing'), undefined);
});

test('resolvePath: iter on non-array errors', () => {
	const r = resolvePath({ tags: 'not an array' }, 'tags[*]');
	assert.ok(typeof r === 'object' && r !== null && 'error' in r);
	assert.match((r as { error: string }).error, /expected an array/);
});

test('resolvePath: nested [*][*] rejected in v1', () => {
	const r = resolvePath({ x: [['a', 'b']] }, 'x[*][*]');
	assert.ok(typeof r === 'object' && r !== null && 'error' in r);
	assert.match((r as { error: string }).error, /nested.*\[\*\]/);
});

// ---------------------------------------------------------------------------
// Binding resolver
// ---------------------------------------------------------------------------

const FAKE_LEAF: PlannedNode = {
	id: 'consumer', title: 't', objective: 'o',
	kind: 'leaf', skill: 'foo.bar',
	inputs: {}, emit: 'section',
};

test('resolveBinding: literal passes through', () => {
	const r = resolveBinding(
		{ source: 'literal', value: 42 },
		FAKE_LEAF, 'arg', '', {}, new Map(),
	);
	assert.deepEqual(r, { value: 42 });
});

test('resolveBinding: question regex extracts first group', () => {
	const r = resolveBinding(
		{ source: 'question', extract: 'class ([A-Z][A-Za-z0-9_]*)' },
		FAKE_LEAF, 'arg',
		'Map JSON to the class INGRN structure.',
		{},
		new Map(),
	);
	assert.deepEqual(r, { value: 'INGRN' });
});

test('resolveBinding: question regex with no match yields undefined', () => {
	const r = resolveBinding(
		{ source: 'question', extract: 'nonsense' },
		FAKE_LEAF, 'arg', 'no match here', {}, new Map(),
	);
	assert.deepEqual(r, { value: undefined });
});

test('resolveBinding: context lookup', () => {
	const r = resolveBinding(
		{ source: 'context', key: 'codeRepoPath' },
		FAKE_LEAF, 'arg', '',
		{ codeRepoPath: '/path/to/repo' },
		new Map(),
	);
	assert.deepEqual(r, { value: '/path/to/repo' });
});

test('resolveBinding: node + path resolves against the stored value', () => {
	const nodeValues = new Map<string, unknown>([
		['producer', { fields: [{ name: 'a' }, { name: 'b' }] }],
	]);
	const r = resolveBinding(
		{ source: 'node', nodeId: 'producer', path: 'fields[*].name' },
		FAKE_LEAF, 'classFields', '', {}, nodeValues,
	);
	assert.deepEqual(r, { value: ['a', 'b'] });
});

test('resolveBinding: node referencing an unrecorded id fails clean', () => {
	const r = resolveBinding(
		{ source: 'node', nodeId: 'missing', path: 'x' },
		FAKE_LEAF, 'arg', '', {}, new Map(),
	);
	assert.ok('error' in r);
	assert.match((r as { error: { reason: string } }).error.reason, /has no recorded output/);
});

// ---------------------------------------------------------------------------
// End-to-end executor: stub skills, real registry
// ---------------------------------------------------------------------------

const STUB_SKILL_PRODUCER: Skill<{ token: string }, { items: { id: string; size: number }[] }> = {
	id: 'test.produce-items',
	name: 'Produce items',
	description: 'Stub skill that emits a fixed list keyed by input.token.',
	family: 'meta',
	owner: 'shared',
	version: 1,
	inputs: {
		type: 'object',
		properties: { token: { type: 'string' } },
		required: ['token'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			items: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						id:   { type: 'string' },
						size: { type: 'number' },
					},
					required: ['id', 'size'],
				},
			},
		},
		required: ['items'],
	},
	toolDeps: [],
	providerAffinity: 'auto',
	async execute(input) {
		return {
			value: { items: [
				{ id: `${input.token}-1`, size: 10 },
				{ id: `${input.token}-2`, size: 20 },
			] },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

const STUB_SKILL_CONSUMER: Skill<{ idsFromUpstream: string[] }, { joined: string }> = {
	id: 'test.consume-items',
	name: 'Consume items',
	description: 'Stub skill that joins the ids it received.',
	family: 'meta',
	owner: 'shared',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			idsFromUpstream: { type: 'array', items: { type: 'string' } },
		},
		required: ['idsFromUpstream'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: { joined: { type: 'string' } },
		required: ['joined'],
	},
	toolDeps: [],
	providerAffinity: 'auto',
	async execute(input) {
		return {
			value: { joined: input.idsFromUpstream.join(',') },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

interface Fixture {
	readonly graphDir: string;
	dispose(): Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-tree-executor-test-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: '/repo/x', name: '', addedAt: now, status: 'pending' });

	registerSkill(STUB_SKILL_PRODUCER as unknown as Skill);
	registerSkill(STUB_SKILL_CONSUMER as unknown as Skill);

	return {
		graphDir,
		async dispose() {
			await closeGraphStore();
			rmSync(graphDir, { recursive: true, force: true });
		},
	};
}

function fakeSession(): Session {
	const stub: Record<string, unknown> = {
		id: 'tree-executor-test', repoPath: '/repo/x', closureRepos: ['/repo/x'], startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

const NEVER_LLM: LLMProvider = {
	complete: async () => { throw new Error('LLM should not be called in this test'); },
	stream:   async function* () { yield ''; },
	embed:    async () => [],
	supportsTools: true,
};

function makeCtx(events: TreeExecutionEvent[], question = 'feed me'): TreeContext {
	return {
		question,
		sessionContext: { codeRepoPath: '/repo/x' },
		runnerDeps: {
			session: fakeSession(),
			resolveProvider: () => NEVER_LLM,
		},
		onEvent: (e) => events.push(e),
	};
}

test('executeTree: happy path -- producer -> consumer with iter wire', async () => {
	const fx = await setupFixture();
	try {
		const tree = validatePlannedTree({
			intentBrief: 'producer -> consumer',
			root: {
				id: 'root', title: 'Root', objective: 'demo composition',
				kind: 'composition', composition: 'sequence', inputs: {}, emit: 'discard',
				children: [
					{
						id: 'p', title: 'Producer', objective: 'emit items',
						kind: 'leaf', skill: 'test.produce-items', emit: 'intermediate',
						inputs: {
							token: { source: 'question', extract: '\\bfeed (\\w+)\\b' },
						},
					},
					{
						id: 'c', title: 'Consumer', objective: 'join ids',
						kind: 'leaf', skill: 'test.consume-items', emit: 'section',
						inputs: {
							idsFromUpstream: { source: 'node', nodeId: 'p', path: 'items[*].id' },
						},
					},
				],
			},
		}) as PlannedTree;

		const events: TreeExecutionEvent[] = [];
		const result = await executeTree(tree, makeCtx(events, 'feed me'));

		assert.equal(result.executedLeaves, 2);
		assert.equal(result.failedLeaves, 0);
		const consumerRecord = result.nodes.get('c');
		assert.ok(consumerRecord);
		assert.deepEqual(consumerRecord!.value, { joined: 'me-1,me-2' });

		// Events: tree-start, p start, p complete, c start, c complete, root start, root complete, tree-complete
		assert.ok(events.some(e => e.kind === 'tree-start' && e.leafCount === 2));
		assert.ok(events.some(e => e.kind === 'node-complete' && e.nodeId === 'c'));
		assert.ok(events.some(e => e.kind === 'tree-complete'));
	} finally { await fx.dispose(); }
});

test('executeTree: failure of producer cascades to consumer wire', async () => {
	const fx = await setupFixture();
	try {
		// Producer is FORCED to fail by referencing an undefined node.
		// Actually trigger via the producer needing a missing context key:
		// we'll wire `token` from `nonexistent` context, leaving it undefined,
		// then check that the consumer (depending on the producer's output)
		// gets a binding error referring to "p".
		// Easier: make the producer's skill throw — replace the stub
		// for this test only.
		_resetSkillRegistryForTests();
		_resetToolRegistryForTests();
		registerSkill({
			...STUB_SKILL_PRODUCER,
			async execute() { throw new Error('producer boom'); },
		} as unknown as Skill);
		registerSkill(STUB_SKILL_CONSUMER as unknown as Skill);

		const tree = validatePlannedTree({
			intentBrief: 'producer fails',
			root: {
				id: 'root', title: 'Root', objective: 'o',
				kind: 'composition', inputs: {}, emit: 'discard',
				children: [
					{ id: 'p', title: 't', objective: 'o',
					  kind: 'leaf', skill: 'test.produce-items', emit: 'intermediate',
					  inputs: { token: { source: 'literal', value: 'x' } } },
					{ id: 'c', title: 't', objective: 'o',
					  kind: 'leaf', skill: 'test.consume-items', emit: 'section',
					  inputs: { idsFromUpstream: { source: 'node', nodeId: 'p', path: 'items[*].id' } } },
				],
			},
		}) as PlannedTree;

		const events: TreeExecutionEvent[] = [];
		const result = await executeTree(tree, makeCtx(events));

		assert.equal(result.failedLeaves, 2, 'both producer (threw) and consumer (failed wire) are failures');
		const cRecord = result.nodes.get('c');
		assert.ok(cRecord?.failed);
		assert.match(cRecord!.failureReason!, /source node "p" has no recorded output/);
	} finally { await fx.dispose(); }
});

test('stitchTreeSections: depth-first walk emits only `emit: section` nodes', async () => {
	const fx = await setupFixture();
	try {
		const tree = validatePlannedTree({
			intentBrief: 'mixed emit kinds',
			root: {
				id: 'root', title: 'Top', objective: 'o',
				kind: 'composition', inputs: {}, emit: 'discard',
				children: [
					{ id: 'p', title: 'Intermediate', objective: 'o',
					  kind: 'leaf', skill: 'test.produce-items', emit: 'intermediate',
					  inputs: { token: { source: 'literal', value: 'x' } } },
					{ id: 'c1', title: 'First section', objective: 'o',
					  kind: 'leaf', skill: 'test.consume-items', emit: 'section',
					  inputs: { idsFromUpstream: { source: 'node', nodeId: 'p', path: 'items[*].id' } } },
					{ id: 'c2', title: 'Second section', objective: 'o',
					  kind: 'leaf', skill: 'test.consume-items', emit: 'section',
					  inputs: { idsFromUpstream: { source: 'node', nodeId: 'p', path: 'items[*].id' } } },
				],
			},
		}) as PlannedTree;

		const events: TreeExecutionEvent[] = [];
		const result = await executeTree(tree, makeCtx(events));
		const stitched = stitchTreeSections(tree, result);

		// 'discard' root + 'intermediate' producer should NOT appear.
		assert.equal(stitched.sections.length, 2);
		assert.deepEqual(stitched.sections.map(s => s.nodeId), ['c1', 'c2']);
		assert.ok(stitched.sections[0]!.markdown.includes('joined'));
	} finally { await fx.dispose(); }
});

test('stitchTreeSections: failed section renders a Failed stub', async () => {
	const fx = await setupFixture();
	try {
		_resetSkillRegistryForTests();
		_resetToolRegistryForTests();
		registerSkill({
			...STUB_SKILL_PRODUCER,
			async execute() { throw new Error('boom'); },
		} as unknown as Skill);

		const tree = validatePlannedTree({
			intentBrief: 'failing section',
			root: {
				id: 'r', title: 'Failing section', objective: 'o',
				kind: 'leaf', skill: 'test.produce-items', emit: 'section',
				inputs: { token: { source: 'literal', value: 'x' } },
			},
		}) as PlannedTree;

		const result = await executeTree(tree, makeCtx([]));
		const stitched = stitchTreeSections(tree, result);

		assert.equal(stitched.sections.length, 1);
		assert.ok(stitched.sections[0]!.failed);
		assert.match(stitched.sections[0]!.markdown, /\*Failed: .*boom/);
	} finally { await fx.dispose(); }
});
