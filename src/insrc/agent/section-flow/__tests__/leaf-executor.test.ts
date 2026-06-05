/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the production leaf executor (P5.b leaf-execution wiring).
 *
 * Covered:
 * - applyPath: '$' / dotted / array index / wildcard / missing.
 * - tryParseJson: JSON-shape prefixes, scalar fallback.
 * - resolveLeafInputs: all four binding sources (literal / question /
 *   context / node) + missing-arg handling.
 * - stringifySkillValue: string passthrough, JSON encoding of objects,
 *   null/undefined fallback.
 * - buildSkillExecutor: happy path + skip non-leaf nodes + skip
 *   skill-less leaves + runSkill error -> empty string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildSkillExecutor,
	resolveLeafInputs,
	applyPath,
	stringifySkillValue,
	_resolveOneForTest as resolveOne,
	_tryParseJsonForTest as tryParseJson,
} from '../leaf-executor.js';
import type { PlannedNode } from '../../content-gen/plan-tree.js';
import type { SkillResult } from '../../../daemon/skills/types.js';
import type { SkillRunnerDeps } from '../../../daemon/skills/invoke.js';

// ---------------------------------------------------------------------------
// applyPath
// ---------------------------------------------------------------------------

test('applyPath: "$" returns whole value', () => {
	assert.deepEqual(applyPath({ a: 1 }, '$'), { a: 1 });
});

test('applyPath: empty path returns whole value', () => {
	assert.deepEqual(applyPath({ a: 1 }, ''), { a: 1 });
});

test('applyPath: dotted property access', () => {
	assert.equal(applyPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
});

test('applyPath: dotted with $. prefix', () => {
	assert.equal(applyPath({ a: { b: 9 } }, '$.a.b'), 9);
});

test('applyPath: array index bracket syntax', () => {
	assert.equal(applyPath({ xs: [10, 20, 30] }, 'xs[1]'), 20);
});

test('applyPath: array index dot syntax', () => {
	assert.equal(applyPath({ xs: [10, 20, 30] }, 'xs.2'), 30);
});

test('applyPath: wildcard array map', () => {
	const result = applyPath({ fields: [{ name: 'a' }, { name: 'b' }] }, 'fields[*].name');
	assert.deepEqual(result, ['a', 'b']);
});

test('applyPath: wildcard at end -> array of full elements', () => {
	assert.deepEqual(applyPath({ xs: [1, 2, 3] }, 'xs[*]'), [1, 2, 3]);
});

test('applyPath: missing property -> undefined', () => {
	assert.equal(applyPath({ a: 1 }, 'b'), undefined);
});

test('applyPath: missing array index -> undefined', () => {
	assert.equal(applyPath({ xs: [1] }, 'xs[5]'), undefined);
});

test('applyPath: null intermediate -> undefined', () => {
	assert.equal(applyPath({ a: null }, 'a.b'), undefined);
});

test('applyPath: traversing scalar -> undefined', () => {
	assert.equal(applyPath({ a: 5 }, 'a.b'), undefined);
});

// ---------------------------------------------------------------------------
// tryParseJson
// ---------------------------------------------------------------------------

test('tryParseJson: object JSON parses', () => {
	assert.deepEqual(tryParseJson('{"a":1}'), { a: 1 });
});

test('tryParseJson: array JSON parses', () => {
	assert.deepEqual(tryParseJson('[1, 2]'), [1, 2]);
});

test('tryParseJson: quoted-string JSON parses', () => {
	assert.equal(tryParseJson('"hello"'), 'hello');
});

test('tryParseJson: plain markdown returns raw string', () => {
	assert.equal(tryParseJson('# title\n\nbody'), '# title\n\nbody');
});

test('tryParseJson: numeric scalar returns raw string (we treat as plain text)', () => {
	assert.equal(tryParseJson('42'), '42');
});

test('tryParseJson: empty string returns input', () => {
	assert.equal(tryParseJson(''), '');
});

test('tryParseJson: malformed JSON returns raw string', () => {
	assert.equal(tryParseJson('{not json}'), '{not json}');
});

// ---------------------------------------------------------------------------
// resolveOne (per-binding)
// ---------------------------------------------------------------------------

const PRIOR_OUTPUTS = {
	discover: '{"fields":[{"name":"a"},{"name":"b"}]}',
	other:    '# Section\n\nmarkdown body',
};

test('resolveOne: literal -> verbatim', () => {
	assert.equal(resolveOne({ source: 'literal', value: 'x' }, PRIOR_OUTPUTS, 'Q', {}), 'x');
});

test('resolveOne: literal supports objects', () => {
	assert.deepEqual(resolveOne({ source: 'literal', value: { k: 1 } }, PRIOR_OUTPUTS, 'Q', {}), { k: 1 });
});

test('resolveOne: question regex first-group', () => {
	assert.equal(resolveOne({ source: 'question', extract: 'find (\\w+)' }, PRIOR_OUTPUTS, 'find errors in foo', {}), 'errors');
});

test('resolveOne: question regex no-group -> whole match', () => {
	assert.equal(resolveOne({ source: 'question', extract: '\\bbar\\b' }, PRIOR_OUTPUTS, 'foo bar baz', {}), 'bar');
});

test('resolveOne: question regex no match -> undefined', () => {
	assert.equal(resolveOne({ source: 'question', extract: 'zzz' }, PRIOR_OUTPUTS, 'foo bar baz', {}), undefined);
});

test('resolveOne: question malformed regex -> undefined', () => {
	assert.equal(resolveOne({ source: 'question', extract: '(' }, PRIOR_OUTPUTS, 'q', {}), undefined);
});

test('resolveOne: context lookup', () => {
	assert.equal(resolveOne({ source: 'context', key: 'codeRepoPath' }, PRIOR_OUTPUTS, 'q', { codeRepoPath: '/repo' }), '/repo');
});

test('resolveOne: context missing -> undefined', () => {
	assert.equal(resolveOne({ source: 'context', key: 'missing' }, PRIOR_OUTPUTS, 'q', { codeRepoPath: '/repo' }), undefined);
});

test('resolveOne: node with $ path returns whole parsed value', () => {
	const result = resolveOne({ source: 'node', nodeId: 'discover', path: '$' }, PRIOR_OUTPUTS, 'q', {});
	assert.deepEqual(result, { fields: [{ name: 'a' }, { name: 'b' }] });
});

test('resolveOne: node with dotted path against JSON output', () => {
	const result = resolveOne({ source: 'node', nodeId: 'discover', path: 'fields[*].name' }, PRIOR_OUTPUTS, 'q', {});
	assert.deepEqual(result, ['a', 'b']);
});

test('resolveOne: node against non-JSON (markdown) output returns raw string at $', () => {
	const result = resolveOne({ source: 'node', nodeId: 'other', path: '$' }, PRIOR_OUTPUTS, 'q', {});
	assert.equal(result, '# Section\n\nmarkdown body');
});

test('resolveOne: node missing -> undefined', () => {
	const result = resolveOne({ source: 'node', nodeId: 'nope', path: '$' }, PRIOR_OUTPUTS, 'q', {});
	assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// resolveLeafInputs (whole-leaf)
// ---------------------------------------------------------------------------

function leaf(id: string, inputs: PlannedNode['inputs']): PlannedNode {
	return { id, title: id, objective: 'o', kind: 'leaf', skill: 'shared.x', inputs, emit: 'intermediate' };
}

test('resolveLeafInputs: combines all binding sources', () => {
	const l = leaf('c', {
		lit:  { source: 'literal',  value: 42 },
		ctx:  { source: 'context',  key: 'sessionId' },
		fields: { source: 'node', nodeId: 'discover', path: 'fields[*].name' },
		match:  { source: 'question', extract: '(\\w+) at' },
	});
	const got = resolveLeafInputs(l, PRIOR_OUTPUTS, 'crashed at boot', { sessionId: 'sess-1' });
	assert.deepEqual(got, {
		lit:    42,
		ctx:    'sess-1',
		fields: ['a', 'b'],
		match:  'crashed',
	});
});

test('resolveLeafInputs: missing inputs are omitted (not present in result)', () => {
	const l = leaf('c', {
		present: { source: 'literal', value: 'x' },
		missing: { source: 'node',    nodeId: 'nope', path: '$' },
	});
	const got = resolveLeafInputs(l, PRIOR_OUTPUTS, 'q', {});
	assert.deepEqual(got, { present: 'x' });
	assert.equal('missing' in got, false);
});

// ---------------------------------------------------------------------------
// stringifySkillValue
// ---------------------------------------------------------------------------

test('stringifySkillValue: string passthrough', () => {
	assert.equal(stringifySkillValue('# markdown'), '# markdown');
});

test('stringifySkillValue: object -> JSON string', () => {
	assert.equal(stringifySkillValue({ a: 1 }), '{\n  "a": 1\n}');
});

test('stringifySkillValue: array -> JSON string', () => {
	assert.equal(stringifySkillValue([1, 2]), '[\n  1,\n  2\n]');
});

test('stringifySkillValue: null/undefined -> empty string', () => {
	assert.equal(stringifySkillValue(null), '');
	assert.equal(stringifySkillValue(undefined), '');
});

// ---------------------------------------------------------------------------
// buildSkillExecutor end-to-end
// ---------------------------------------------------------------------------

const fakeRunnerDeps = {} as unknown as SkillRunnerDeps;

function fakeResult<T>(value: T): SkillResult<T> {
	return {
		value,
		confidence: 'high',
		notes: [],
		toolCalls: [],
	};
}

test('buildSkillExecutor: happy path -- runSkill called with resolved input; result stringified', async () => {
	const calls: { skillId: string; input: unknown }[] = [];
	const exec = buildSkillExecutor({
		runnerDeps:   fakeRunnerDeps,
		userQuestion: 'q',
		contextBag:   { codeRepoPath: '/r' },
		runSkillOverride: async (skillId, input) => {
			calls.push({ skillId, input });
			return fakeResult({ fields: ['x', 'y'] });
		},
	});
	const l = leaf('discover', {
		ctx: { source: 'context', key: 'codeRepoPath' },
	});
	const out = await exec({ leaf: l, priorOutputs: {} });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.skillId, 'shared.x');
	assert.deepEqual(calls[0]!.input, { ctx: '/r' });
	assert.equal(out, '{\n  "fields": [\n    "x",\n    "y"\n  ]\n}');
});

test('buildSkillExecutor: non-leaf node -> empty output, runSkill NOT called', async () => {
	let called = 0;
	const exec = buildSkillExecutor({
		runnerDeps:   fakeRunnerDeps,
		userQuestion: 'q',
		contextBag:   {},
		runSkillOverride: async () => { called += 1; return fakeResult(''); },
	});
	const composition: PlannedNode = { id: 'c', title: 'c', objective: 'c', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate', children: [] };
	const out = await exec({ leaf: composition, priorOutputs: {} });
	assert.equal(out, '');
	assert.equal(called, 0);
});

test('buildSkillExecutor: leaf with empty skill id -> empty output, runSkill NOT called', async () => {
	let called = 0;
	const exec = buildSkillExecutor({
		runnerDeps:   fakeRunnerDeps,
		userQuestion: 'q',
		contextBag:   {},
		runSkillOverride: async () => { called += 1; return fakeResult(''); },
	});
	// PlannedNode requires skill on leaves; force an empty by hand for the defensive guard.
	const l: PlannedNode = { id: 'no-skill', title: 'n', objective: 'n', kind: 'leaf', skill: '', inputs: {}, emit: 'intermediate' };
	const out = await exec({ leaf: l, priorOutputs: {} });
	assert.equal(out, '');
	assert.equal(called, 0);
});

test('buildSkillExecutor: runSkill throws -> empty output (no propagation)', async () => {
	const exec = buildSkillExecutor({
		runnerDeps:   fakeRunnerDeps,
		userQuestion: 'q',
		contextBag:   {},
		runSkillOverride: async () => { throw new Error('boom'); },
	});
	const l = leaf('x', {});
	const out = await exec({ leaf: l, priorOutputs: {} });
	assert.equal(out, '');
});

test('buildSkillExecutor: node binding resolves against prior outputs across calls', async () => {
	const exec = buildSkillExecutor({
		runnerDeps:   fakeRunnerDeps,
		userQuestion: 'q',
		contextBag:   {},
		runSkillOverride: async (_id, input) => fakeResult(input),     // echo
	});
	// First call produces a JSON object.
	const l1 = leaf('first', { lit: { source: 'literal', value: { fields: ['a'] } } });
	const out1 = await exec({ leaf: l1, priorOutputs: {} });
	// Second call: read the field list out of the first output via path.
	const l2 = leaf('second', { fields: { source: 'node', nodeId: 'first', path: 'lit.fields' } });
	const out2 = await exec({ leaf: l2, priorOutputs: { first: out1 } });
	assert.match(out2, /"fields":/);
	assert.match(out2, /"a"/);
});
