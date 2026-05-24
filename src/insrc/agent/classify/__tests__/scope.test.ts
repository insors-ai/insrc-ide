/**
 * Tests for the scope + subtype classifier (Plan 3 Phase 1-3).
 *
 * Two surfaces:
 *   - `parseResponse` pure function -- exercised against synthetic
 *     LLM responses (no provider needed)
 *   - `classifyScope` end-to-end with a fake LLMProvider scripting
 *     the response text
 *
 * Coverage:
 *   - Every subtype parses correctly
 *   - Missing subtype defaults to 'review'
 *   - Invalid subtype defaults to 'review' (soft requirement)
 *   - Invalid scope fails parse hard (scope is load-bearing)
 *   - Malformed JSON, missing fields, provider errors all fall
 *     back to { scope: 'M', subtype: 'review', fallback: true }
 *   - Backward compatibility: existing callers still get a valid
 *     scope field
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	classifyScope,
	_parseResponseForTest as parseResponse,
	_DEFAULT_SUBTYPE_FOR_TEST as DEFAULT_SUBTYPE,
	type AnalysisSubtype,
	type ScopeClassifyResult,
} from '../scope.js';
import type {
	LLMProvider,
	LLMMessage,
	LLMResponse,
	CompletionOpts,
} from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeProvider(responseText: string): LLMProvider {
	return {
		supportsTools: false,
		async complete(_messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
			return { text: responseText, stopReason: 'end_turn' };
		},
		async *stream() { return; },
		async embed() { return []; },
	};
}

function throwingProvider(message: string): LLMProvider {
	return {
		supportsTools: false,
		async complete(): Promise<LLMResponse> { throw new Error(message); },
		async *stream() { return; },
		async embed() { return []; },
	};
}

// ---------------------------------------------------------------------------
// parseResponse — every subtype
// ---------------------------------------------------------------------------

const SUBTYPES_TO_PARSE: readonly AnalysisSubtype[] = [
	'review', 'summarize', 'audit', 'explain', 'compare', 'document', 'diagnose',
];

for (const subtype of SUBTYPES_TO_PARSE) {
	test(`parseResponse: subtype="${subtype}" parses verbatim`, () => {
		const parsed = parseResponse(JSON.stringify({ scope: 'M', subtype, reasoning: 'fixture' }));
		assert.ok(parsed);
		if (parsed) {
			assert.equal(parsed.subtype, subtype);
			assert.equal(parsed.scope, 'M');
			assert.equal(parsed.fallback, false);
		}
	});
}

test('parseResponse: subtype normalized (uppercase -> lowercase, trimmed)', () => {
	const parsed = parseResponse(JSON.stringify({ scope: 'L', subtype: '  AUDIT  ', reasoning: 'x' }));
	assert.equal(parsed?.subtype, 'audit');
});

// ---------------------------------------------------------------------------
// parseResponse — subtype defaulting (soft requirement)
// ---------------------------------------------------------------------------

test('parseResponse: missing subtype -> defaults to review (soft requirement)', () => {
	const parsed = parseResponse(JSON.stringify({ scope: 'M', reasoning: 'no subtype' }));
	assert.ok(parsed);
	if (parsed) {
		assert.equal(parsed.subtype, 'review');
		assert.equal(parsed.scope, 'M');
		assert.equal(parsed.fallback, false);    // valid scope -> not a fallback
	}
});

test('parseResponse: invalid subtype value -> defaults to review', () => {
	const parsed = parseResponse(JSON.stringify({ scope: 'L', subtype: 'evangelize', reasoning: 'fake' }));
	assert.equal(parsed?.subtype, 'review');
});

test('parseResponse: non-string subtype -> defaults to review', () => {
	const parsed = parseResponse(JSON.stringify({ scope: 'L', subtype: 42, reasoning: 'wrong type' }));
	assert.equal(parsed?.subtype, 'review');
});

test('DEFAULT_SUBTYPE constant matches the fallback used by the parser', () => {
	assert.equal(DEFAULT_SUBTYPE, 'review');
});

// ---------------------------------------------------------------------------
// parseResponse — scope is the load-bearing axis (hard requirement)
// ---------------------------------------------------------------------------

test('parseResponse: invalid scope fails the whole parse (returns null)', () => {
	const parsed = parseResponse(JSON.stringify({ scope: 'HUGE', subtype: 'review', reasoning: '' }));
	assert.equal(parsed, null);
});

test('parseResponse: missing scope fails the whole parse', () => {
	const parsed = parseResponse(JSON.stringify({ subtype: 'review', reasoning: '' }));
	assert.equal(parsed, null);
});

test('parseResponse: scope normalized to uppercase', () => {
	const parsed = parseResponse(JSON.stringify({ scope: 'xl', subtype: 'review', reasoning: '' }));
	assert.equal(parsed?.scope, 'XL');
});

// ---------------------------------------------------------------------------
// parseResponse — malformed input
// ---------------------------------------------------------------------------

test('parseResponse: malformed JSON returns null', () => {
	assert.equal(parseResponse('this is not json'), null);
});

test('parseResponse: empty string returns null', () => {
	assert.equal(parseResponse(''), null);
});

test('parseResponse: handles markdown fences', () => {
	const parsed = parseResponse('```json\n{"scope":"M","subtype":"review","reasoning":"x"}\n```');
	assert.equal(parsed?.scope, 'M');
	assert.equal(parsed?.subtype, 'review');
});

// ---------------------------------------------------------------------------
// classifyScope — end-to-end with fake provider
// ---------------------------------------------------------------------------

test('classifyScope: well-shaped response → returns parsed result', async () => {
	const provider = fakeProvider(JSON.stringify({
		scope: 'XL',
		subtype: 'review',
		reasoning: 'multi-subsystem audit',
	}));
	const out = await classifyScope({ text: 'review insors/extraction' }, provider);
	assert.equal(out.scope, 'XL');
	assert.equal(out.subtype, 'review');
	assert.equal(out.fallback, false);
});

test('classifyScope: provider error → fallback to M / review / fallback=true', async () => {
	const provider = throwingProvider('boom');
	const out = await classifyScope({ text: 'whatever' }, provider);
	assert.equal(out.scope, 'M');
	assert.equal(out.subtype, 'review');
	assert.equal(out.fallback, true);
	assert.match(out.reasoning, /provider error: boom/);
});

test('classifyScope: unparseable response → fallback to M / review / fallback=true', async () => {
	const provider = fakeProvider('the LLM forgot to respond with JSON');
	const out = await classifyScope({ text: 'whatever' }, provider);
	assert.equal(out.scope, 'M');
	assert.equal(out.subtype, 'review');
	assert.equal(out.fallback, true);
	assert.match(out.reasoning, /unparseable LLM response/);
});

test('classifyScope: well-shaped response without subtype → review (soft requirement)', async () => {
	const provider = fakeProvider(JSON.stringify({ scope: 'L', reasoning: 'no subtype emitted' }));
	const out = await classifyScope({ text: 'whatever' }, provider);
	assert.equal(out.scope, 'L');
	assert.equal(out.subtype, 'review');
	assert.equal(out.fallback, false);
});

test('classifyScope: well-shaped response with invalid subtype → review', async () => {
	const provider = fakeProvider(JSON.stringify({ scope: 'L', subtype: 'investigate', reasoning: '' }));
	const out = await classifyScope({ text: 'whatever' }, provider);
	assert.equal(out.subtype, 'review');
});

// ---------------------------------------------------------------------------
// Backward compatibility — `scope` field semantics unchanged
// ---------------------------------------------------------------------------

test('backward-compat: caller that reads only `scope` continues to work', async () => {
	const provider = fakeProvider(JSON.stringify({
		scope: 'XXL',
		subtype: 'summarize',
		reasoning: 'broad sweep',
	}));
	const out: ScopeClassifyResult = await classifyScope({ text: 'audit everything' }, provider);
	// Old callers read .scope without touching .subtype -- still valid.
	const sizeOnly: { readonly scope: typeof out.scope } = out;
	assert.equal(sizeOnly.scope, 'XXL');
});

test('classifyScope: all 7 subtypes round-trip correctly', async () => {
	for (const subtype of SUBTYPES_TO_PARSE) {
		const provider = fakeProvider(JSON.stringify({ scope: 'M', subtype, reasoning: 'test' }));
		const out = await classifyScope({ text: 'x' }, provider);
		assert.equal(out.subtype, subtype, `roundtrip failed for ${subtype}`);
	}
});
