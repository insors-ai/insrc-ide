/**
 * Tests for the pre-dispatch tool-call guard (Phase 1).
 *
 * Phase 1 covers Stage 1 (tool-name fuzzy match) + Stage 3 (type
 * coercions). Stages 2 (per-skill arg renames) and 4 (pre-dispatch
 * schema check) are tested separately when those phases land.
 *
 * All tests use injected `GuardDeps` so the global skill registry
 * is not touched -- avoids ordering issues with other test files
 * that register skills.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	guardLocalToolCall,
	levenshtein,
	_resolveToolNameForTest      as resolveToolName,
	_coerceInputTypesForTest     as coerceInputTypes,
	_normalizeSeparatorsForTest  as normalizeSeparators,
	type GuardDeps,
	type GuardOutcome,
} from '../tool-call-guard.js';
import type { ToolCall } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_CATALOG: readonly string[] = [
	'code.entity.summary',
	'code.entity.locate-by-name',
	'code.entity.search-by-vector',
	'code.source.file.describe',
	'code.source.module.describe',
	'code.class.extract-fields',
];

const FAKE_SCHEMAS: Record<string, Record<string, unknown>> = {
	'code.entity.locate-by-name': {
		type: 'object',
		properties: {
			name:  { type: 'string' },
			kinds: { type: 'array', items: { type: 'string' } },
		},
		required: ['name'],
	},
	'code.entity.summary': {
		type: 'object',
		properties: {
			entityId: { type: 'string' },
		},
		required: ['entityId'],
	},
	'code.source.file.describe': {
		type: 'object',
		properties: {
			file:     { type: 'string' },
			repoPath: { type: 'string' },
		},
		required: ['file', 'repoPath'],
	},
};

function fakeDeps(): GuardDeps {
	return {
		listSkillIds:        () => FAKE_CATALOG,
		getSkillInputSchema: (id) => FAKE_SCHEMAS[id],
	};
}

function call(name: string, input: Record<string, unknown>, id = 'tc1'): ToolCall {
	return { id, name, input };
}

// ---------------------------------------------------------------------------
// Levenshtein helper
// ---------------------------------------------------------------------------

test('levenshtein: identical strings → 0', () => {
	assert.equal(levenshtein('abc', 'abc'), 0);
	assert.equal(levenshtein('', ''), 0);
});

test('levenshtein: single char edit → 1', () => {
	assert.equal(levenshtein('abc', 'abd'), 1);     // substitution
	assert.equal(levenshtein('abc', 'ab'),  1);     // deletion
	assert.equal(levenshtein('abc', 'abcd'), 1);    // insertion
});

test('levenshtein: empty input fast-path', () => {
	assert.equal(levenshtein('', 'hello'), 5);
	assert.equal(levenshtein('hello', ''), 5);
});

test('levenshtein: tool-id-shaped inputs', () => {
	assert.equal(levenshtein('code.entity.summary', 'code.entity.summary'),   0);
	assert.equal(levenshtein('code.entity.summary', 'code.entity.sumary'),    1);   // missing m
	assert.equal(levenshtein('code.entity.summary', 'code.entity.summery'),   1);   // a/e swap
});

// ---------------------------------------------------------------------------
// Stage 1 — separator normalization
// ---------------------------------------------------------------------------

test('normalizeSeparators: dot/underscore/dash all collapse to dot', () => {
	assert.equal(normalizeSeparators('code_entity_summary'), 'code.entity.summary');
	assert.equal(normalizeSeparators('code-entity-summary'), 'code.entity.summary');
	assert.equal(normalizeSeparators('Code.Entity.Summary'), 'code.entity.summary');   // also lowercases
});

// ---------------------------------------------------------------------------
// Stage 1 — tool-name resolution
// ---------------------------------------------------------------------------

test('resolveToolName: exact match → pass-or-coerce with no notes', () => {
	const out = resolveToolName(call('code.entity.summary', {}), FAKE_CATALOG);
	assert.equal(out.kind, 'pass-or-coerce');
	if (out.kind === 'pass-or-coerce') {
		assert.equal(out.name, 'code.entity.summary');
		assert.equal(out.notes.length, 0);
	}
});

test('resolveToolName: separator-normalized match → coerced', () => {
	const out = resolveToolName(call('code_entity_summary', {}), FAKE_CATALOG);
	assert.equal(out.kind, 'pass-or-coerce');
	if (out.kind === 'pass-or-coerce') {
		assert.equal(out.name, 'code.entity.summary');
		assert.equal(out.notes.length, 1);
		assert.match(out.notes[0]!, /separator normalization/);
	}
});

test('resolveToolName: typo within Levenshtein threshold → coerced', () => {
	// 'code.entity.sumary' is distance=1 from 'code.entity.summary'
	const out = resolveToolName(call('code.entity.sumary', {}), FAKE_CATALOG);
	assert.equal(out.kind, 'pass-or-coerce');
	if (out.kind === 'pass-or-coerce') {
		assert.equal(out.name, 'code.entity.summary');
		assert.match(out.notes[0]!, /fuzzy match/);
		assert.match(out.notes[0]!, /distance=1/);
	}
});

test('resolveToolName: unknown name beyond threshold → rejected with suggestions', () => {
	const out = resolveToolName(call('code.foobar.totally-unrelated', {}), FAKE_CATALOG);
	assert.equal(out.kind, 'rejected');
	if (out.kind === 'rejected') {
		assert.match(out.reason, /unknown tool/);
		assert.match(out.correctiveResult.content, /Closest tools in the catalog/);
		assert.ok((out.suggestions ?? []).length > 0);
		assert.equal(out.correctiveResult.isError, true);
		assert.equal(out.correctiveResult.toolCallId, 'tc1');   // preserves original id
	}
});

test('resolveToolName: near-tie within threshold → rejected (ambiguous)', () => {
	// Build a catalog where two ids are equidistant from a probe.
	const catalog = ['code.entity.a', 'code.entity.b'];
	const out = resolveToolName(call('code.entity.x', {}), catalog);
	// Both are distance=1 → ambiguous → reject rather than guess.
	assert.equal(out.kind, 'rejected');
});

test('resolveToolName: completely empty catalog → reject with no suggestions', () => {
	const out = resolveToolName(call('code.entity.summary', {}), []);
	assert.equal(out.kind, 'rejected');
	if (out.kind === 'rejected') {
		assert.equal((out.suggestions ?? []).length, 0);
		assert.match(out.correctiveResult.content, /no close matches found/);
	}
});

// ---------------------------------------------------------------------------
// Stage 3 — type coercions
// ---------------------------------------------------------------------------

test('coerceInputTypes: scalar string → [scalar] for array-typed schema field', () => {
	const out = coerceInputTypes(
		{ name: 'Foo', kinds: 'class' },           // 'class' is a scalar
		FAKE_SCHEMAS['code.entity.locate-by-name']!,
	);
	assert.deepEqual(out.input, { name: 'Foo', kinds: ['class'] });
	assert.equal(out.notes.length, 1);
	assert.match(out.notes[0]!, /scalar to single-element array/);
});

test('coerceInputTypes: already-array value passes through unchanged', () => {
	const out = coerceInputTypes(
		{ name: 'Foo', kinds: ['class', 'function'] },
		FAKE_SCHEMAS['code.entity.locate-by-name']!,
	);
	assert.deepEqual(out.input, { name: 'Foo', kinds: ['class', 'function'] });
	assert.equal(out.notes.length, 0);
});

test('coerceInputTypes: no schema match → returns input unchanged', () => {
	const out = coerceInputTypes(
		{ random: 'value' },
		{ type: 'object' },     // no properties key
	);
	assert.deepEqual(out.input, { random: 'value' });
	assert.equal(out.notes.length, 0);
});

test('coerceInputTypes: only relevant fields coerce; others untouched', () => {
	const out = coerceInputTypes(
		{ name: 'Foo' },        // no kinds arg; should NOT introduce one
		FAKE_SCHEMAS['code.entity.locate-by-name']!,
	);
	assert.deepEqual(out.input, { name: 'Foo' });
	assert.equal(out.notes.length, 0);
});

test('coerceInputTypes: non-coercible scalar (number where string array expected) → still arrayified', () => {
	// Defensible behavior: schema declares array, model gave number.
	// Wrap it; the inner item-type check is downstream (skill schema).
	const out = coerceInputTypes(
		{ name: 'Foo', kinds: 42 },
		FAKE_SCHEMAS['code.entity.locate-by-name']!,
	);
	assert.deepEqual(out.input, { name: 'Foo', kinds: [42] });
	assert.equal(out.notes.length, 1);
});

// ---------------------------------------------------------------------------
// guardLocalToolCall — end-to-end
// ---------------------------------------------------------------------------

test('guard: pass-through for fully-correct call', async () => {
	const result = await guardLocalToolCall(
		call('code.entity.summary', { entityId: 'abc' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'pass');
	if (result.kind === 'pass') {
		assert.equal(result.call.name, 'code.entity.summary');
		assert.deepEqual(result.call.input, { entityId: 'abc' });
	}
});

test('guard: separator-normalized name + scalar-to-array coercion in one call', async () => {
	const result = await guardLocalToolCall(
		call('code_entity_locate-by-name', { name: 'Foo', kinds: 'class' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'coerced');
	if (result.kind === 'coerced') {
		assert.equal(result.call.name, 'code.entity.locate-by-name');
		assert.deepEqual(result.call.input, { name: 'Foo', kinds: ['class'] });
		// Both notes should be present.
		assert.equal(result.notes.length, 2);
		assert.ok(result.notes.some(n => n.includes('separator normalization')));
		assert.ok(result.notes.some(n => n.includes('scalar to single-element array')));
	}
});

test('guard: unknown tool name → rejected with corrective ToolResult', async () => {
	const result = await guardLocalToolCall(
		call('code.totally.fake', { foo: 'bar' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'rejected');
	if (result.kind === 'rejected') {
		assert.match(result.reason, /unknown tool/);
		assert.equal(result.correctiveResult.isError, true);
		assert.equal(result.correctiveResult.toolCallId, 'tc1');
		assert.match(result.correctiveResult.content, /not in the skill catalog/);
	}
});

test('guard: typo-coerced name with valid args → coerced (name fixed, args unchanged)', async () => {
	const result = await guardLocalToolCall(
		call('code.entity.sumary', { entityId: 'abc' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'coerced');
	if (result.kind === 'coerced') {
		assert.equal(result.call.name, 'code.entity.summary');
		assert.deepEqual(result.call.input, { entityId: 'abc' });
		assert.equal(result.notes.length, 1);
		assert.match(result.notes[0]!, /fuzzy match/);
	}
});

test('guard: resolved name has no schema available → coercion stage no-ops', async () => {
	// Resolves the name but schema lookup returns undefined.
	const deps: GuardDeps = {
		listSkillIds:        () => ['code.entity.summary'],
		getSkillInputSchema: () => undefined,
	};
	const result = await guardLocalToolCall(
		call('code.entity.summary', { entityId: 'abc' }),
		deps,
	);
	assert.equal(result.kind, 'pass');
});

test('guard: original ToolCall.id is preserved through coercion', async () => {
	const result = await guardLocalToolCall(
		{ id: 'call_xyz_123', name: 'code_entity_summary', input: { entityId: 'abc' } },
		fakeDeps(),
	);
	assert.equal(result.kind, 'coerced');
	if (result.kind === 'coerced') {
		assert.equal(result.call.id, 'call_xyz_123');
	}
});
