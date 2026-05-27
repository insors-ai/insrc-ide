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
	_resolveToolNameForTest             as resolveToolName,
	_coerceInputTypesForTest            as coerceInputTypes,
	_normalizeSeparatorsForTest         as normalizeSeparators,
	_categorizeValidationErrorsForTest  as categorizeValidationErrors,
	_buildCorrectivePromptForTest       as buildCorrectivePrompt,
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
			name:  { type: 'string', description: 'unqualified class name' },
			kinds: { type: 'array', items: { type: 'string' } },
		},
		required: ['name'],
		additionalProperties: false,
	},
	'code.entity.summary': {
		type: 'object',
		properties: {
			entityId: { type: 'string', description: '32-char hex entity id' },
		},
		required: ['entityId'],
		additionalProperties: false,
	},
	'code.source.file.describe': {
		type: 'object',
		properties: {
			file:     { type: 'string', description: 'Absolute file path' },
			repoPath: { type: 'string', description: 'Repo root absolute path' },
		},
		required: ['file', 'repoPath'],
		additionalProperties: false,
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

test('coerceInputTypes: [scalar] → scalar when schema expects string (Haiku live repro)', () => {
	// Live repro 2026-05-26: Haiku wraps `name: "foo"` as `name: ["foo"]`
	// on code.entity.locate-by-name, where the schema declares `name`
	// as a scalar string. Single-element coercion unwraps it.
	const out = coerceInputTypes(
		{ name: ['Foo'] },
		FAKE_SCHEMAS['code.entity.locate-by-name']!,
	);
	assert.deepEqual(out.input, { name: 'Foo' });
	assert.equal(out.notes.length, 1);
	assert.match(out.notes[0]!, /single-element array to scalar string/);
});

test('coerceInputTypes: multi-element array does NOT coerce to scalar (avoid info loss)', () => {
	// Schema expects scalar string; model gave 2 elements. Coercing
	// would silently drop one. Pass through; Stage 4 surfaces the
	// type mismatch.
	const out = coerceInputTypes(
		{ name: ['Foo', 'Bar'] },
		FAKE_SCHEMAS['code.entity.locate-by-name']!,
	);
	assert.deepEqual(out.input, { name: ['Foo', 'Bar'] });
	assert.equal(out.notes.length, 0);
});

test('coerceInputTypes: empty array does NOT coerce to scalar', () => {
	const out = coerceInputTypes(
		{ name: [] },
		FAKE_SCHEMAS['code.entity.locate-by-name']!,
	);
	assert.deepEqual(out.input, { name: [] });
	assert.equal(out.notes.length, 0);
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

// ---------------------------------------------------------------------------
// Stage 2 — arg-rename integration (uses real SKILL_ARG_RENAMES rules)
// ---------------------------------------------------------------------------

test('guard: Stage 2 renames id → entityId for code.entity.summary', async () => {
	const result = await guardLocalToolCall(
		call('code.entity.summary', { id: 'abc' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'coerced');
	if (result.kind === 'coerced') {
		assert.deepEqual(result.call.input, { entityId: 'abc' });
		assert.ok(result.notes.some(n => n.includes("renamed arg 'id' -> 'entityId'")));
	}
});

test('guard: Stage 2 renames path → file for code.source.file.describe', async () => {
	const result = await guardLocalToolCall(
		call('code.source.file.describe', { path: '/repo/Foo.ts', repoPath: '/repo' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'coerced');
	if (result.kind === 'coerced') {
		assert.deepEqual(result.call.input, { file: '/repo/Foo.ts', repoPath: '/repo' });
		assert.ok(result.notes.some(n => n.includes("renamed arg 'path' -> 'file'")));
	}
});

test('guard: Stage 2 + Stage 3 compose -- kind → kinds + scalar → array', async () => {
	// `kind: 'class'` → first renamed to `kinds: 'class'` (Stage 2),
	// then wrapped to `kinds: ['class']` (Stage 3).
	const result = await guardLocalToolCall(
		call('code.entity.locate-by-name', { name: 'Foo', kind: 'class' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'coerced');
	if (result.kind === 'coerced') {
		assert.deepEqual(result.call.input, { name: 'Foo', kinds: ['class'] });
		assert.ok(result.notes.some(n => n.includes("renamed arg 'kind' -> 'kinds'")));
		assert.ok(result.notes.some(n => n.includes('scalar to single-element array')));
	}
});

test('guard: Stage 2 skips rename when target already present; Stage 4 then rejects the unexpected property', async () => {
	// Model provided BOTH `entityId` (correct) and `id` (extra).
	// Stage 2 correctly refuses to silently overwrite. Stage 4 then
	// catches the unexpected `id` against the schema's
	// `additionalProperties: false` and rejects pre-dispatch with a
	// targeted prompt — the round-trip the skill runner would have
	// charged is avoided.
	const result = await guardLocalToolCall(
		call('code.entity.summary', { entityId: 'real', id: 'wrong' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'rejected');
	if (result.kind === 'rejected') {
		assert.match(result.reason, /unexpected=\[id\]/);
		assert.match(result.correctiveResult.content, /Unexpected arguments/);
		assert.match(result.correctiveResult.content, /id/);
	}
});

test('guard: pass-through when no rename rules match for the resolved skill', async () => {
	// Use a name that resolves, with all-correct args already.
	const result = await guardLocalToolCall(
		call('code.entity.summary', { entityId: 'abc' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'pass');
});

// ---------------------------------------------------------------------------
// Stage 4 — pre-dispatch schema check (categorization + corrective prompt)
// ---------------------------------------------------------------------------

test('categorizeValidationErrors: missing required property → missing bucket', () => {
	const cats = categorizeValidationErrors([
		"<root>: missing required property 'entityId'",
	]);
	assert.deepEqual(cats.missing, ['entityId']);
	assert.deepEqual(cats.unexpected, []);
	assert.deepEqual(cats.typeMismatch, []);
});

test('categorizeValidationErrors: unexpected property → unexpected bucket', () => {
	const cats = categorizeValidationErrors([
		"<root>: unexpected property 'path'",
	]);
	assert.deepEqual(cats.missing, []);
	assert.deepEqual(cats.unexpected, ['path']);
	assert.deepEqual(cats.typeMismatch, []);
});

test('categorizeValidationErrors: type-mismatch falls through to typeMismatch bucket', () => {
	const cats = categorizeValidationErrors([
		"<root>.entityId: expected type 'string', got 'number'",
	]);
	assert.deepEqual(cats.missing, []);
	assert.deepEqual(cats.unexpected, []);
	assert.equal(cats.typeMismatch.length, 1);
});

test('categorizeValidationErrors: multiple errors split across buckets', () => {
	const cats = categorizeValidationErrors([
		"<root>: missing required property 'file'",
		"<root>: missing required property 'repoPath'",
		"<root>: unexpected property 'path'",
	]);
	assert.deepEqual(cats.missing,    ['file', 'repoPath']);
	assert.deepEqual(cats.unexpected, ['path']);
	assert.deepEqual(cats.typeMismatch, []);
});

test('buildCorrectivePrompt: missing-required produces section with type + description', () => {
	const prompt = buildCorrectivePrompt({
		toolCallId:   'tc1',
		resolvedName: 'code.entity.summary',
		schema:       FAKE_SCHEMAS['code.entity.summary']!,
		input:        {},
		validationErrors: ["<root>: missing required property 'entityId'"],
	});
	assert.match(prompt, /code\.entity\.summary/);
	assert.match(prompt, /Missing required arguments:/);
	assert.match(prompt, /- entityId \(string\): 32-char hex entity id/);
});

test('buildCorrectivePrompt: unexpected-property section emitted only when present', () => {
	const prompt = buildCorrectivePrompt({
		toolCallId:   'tc1',
		resolvedName: 'code.entity.summary',
		schema:       FAKE_SCHEMAS['code.entity.summary']!,
		input:        { entityId: 'abc', stray: 1 },
		validationErrors: ["<root>: unexpected property 'stray'"],
	});
	assert.match(prompt, /Unexpected arguments/);
	assert.match(prompt, /- stray/);
	assert.doesNotMatch(prompt, /Missing required arguments:/);
});

test('buildCorrectivePrompt: composite error → all three categories surface in order', () => {
	const prompt = buildCorrectivePrompt({
		toolCallId:   'tc1',
		resolvedName: 'code.source.file.describe',
		schema:       FAKE_SCHEMAS['code.source.file.describe']!,
		input:        { path: '/x', extra: 1 },
		validationErrors: [
			"<root>: missing required property 'file'",
			"<root>: missing required property 'repoPath'",
			"<root>: unexpected property 'path'",
			"<root>: unexpected property 'extra'",
		],
	});
	// Section ordering: missing first, then unexpected, then re-emit footer.
	const missingIdx    = prompt.indexOf('Missing required arguments:');
	const unexpectedIdx = prompt.indexOf('Unexpected arguments');
	const footerIdx     = prompt.indexOf('Re-emit your call');
	assert.ok(missingIdx >= 0);
	assert.ok(unexpectedIdx > missingIdx);
	assert.ok(footerIdx > unexpectedIdx);
});

test('guard Stage 4: missing required arg → rejected with the dominant log pattern', async () => {
	// The 68 most-frequent failure shape: code.entity.summary called
	// without entityId. Pre-Phase-3 this would have dispatched and
	// paid a round-trip; post-Phase-3 it's caught here.
	const result = await guardLocalToolCall(
		call('code.entity.summary', {}),
		fakeDeps(),
	);
	assert.equal(result.kind, 'rejected');
	if (result.kind === 'rejected') {
		assert.match(result.reason, /missing=\[entityId\]/);
		assert.match(result.correctiveResult.content, /code\.entity\.summary/);
		assert.match(result.correctiveResult.content, /entityId/);
		assert.equal(result.correctiveResult.isError, true);
		assert.equal(result.correctiveResult.toolCallId, 'tc1');
	}
});

test('guard Stage 4: missing two args (file + repoPath) → both surfaced', async () => {
	// The other dominant shape from the logs.
	const result = await guardLocalToolCall(
		call('code.source.file.describe', {}),
		fakeDeps(),
	);
	assert.equal(result.kind, 'rejected');
	if (result.kind === 'rejected') {
		assert.match(result.reason, /missing=\[file,repoPath\]/);
		assert.match(result.correctiveResult.content, /file \(string\)/);
		assert.match(result.correctiveResult.content, /repoPath \(string\)/);
	}
});

test('guard Stage 4: input fully valid after Stages 1-3 → pass (no spurious rejection)', async () => {
	// Stage 1 fixes the name (separator); Stage 2 renames id → entityId;
	// final input is valid → Stage 4 does NOT reject.
	const result = await guardLocalToolCall(
		call('code_entity_summary', { id: 'abc' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'coerced');
	if (result.kind === 'coerced') {
		assert.deepEqual(result.call.input, { entityId: 'abc' });
	}
});

test('guard Stage 4: no schema available → Stage 4 skipped, falls through to pass/coerced', async () => {
	// Resolves the name but schema lookup returns undefined.
	const deps: GuardDeps = {
		listSkillIds:        () => ['code.entity.summary'],
		getSkillInputSchema: () => undefined,
	};
	const result = await guardLocalToolCall(
		call('code.entity.summary', {}),     // would fail validation if schema existed
		deps,
	);
	// No schema → no Stage 4 → no rejection.
	assert.equal(result.kind, 'pass');
});

test('guard Stage 4: Stage 2 rename fixes the call → validation passes', async () => {
	// path: '/repo/Foo.ts' is the wrong name; Stage 2 renames it to
	// `file`; Stage 4 then sees a complete valid input.
	const result = await guardLocalToolCall(
		call('code.source.file.describe', { path: '/repo/Foo.ts', repoPath: '/repo' }),
		fakeDeps(),
	);
	assert.equal(result.kind, 'coerced');
	if (result.kind === 'coerced') {
		assert.deepEqual(result.call.input, { file: '/repo/Foo.ts', repoPath: '/repo' });
	}
});
