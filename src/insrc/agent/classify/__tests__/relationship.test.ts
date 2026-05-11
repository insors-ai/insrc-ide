/**
 * Phase 4 tests for the generic `classify()` relationship plumbing.
 *
 * Three concerns:
 *   1. When `relationshipEnum` is supplied, the system prompt grows
 *      a relationship section + the schema mentions a `relationship`
 *      block.
 *   2. The parser projects the LLM's relationship JSON into a typed
 *      ClassifyRelationship.
 *   3. Defensive defaults: missing block, invalid kind, malformed
 *      citations all collapse safely (defaults to enum[0], empty
 *      citations) without throwing.
 *
 * Uses a fake LLMProvider that captures the messages the prompt
 * builder produced AND returns a canned response.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify } from '../index.js';
import type { LLMProvider, LLMMessage, LLMResponse } from '../../../shared/types.js';
import { RELATIONSHIP_KINDS } from '../../intent/relationship.js';

const CLASSES = [
	{ id: 'code-analysis', description: 'analyse the active repo' },
	{ id: 'research',      description: 'lookup external info' },
];

function fakeProvider(canned: string, capture?: { messages?: LLMMessage[] }): LLMProvider {
	return {
		async complete(messages: LLMMessage[]): Promise<LLMResponse> {
			if (capture !== undefined) capture.messages = messages.map(m => ({ ...m }));
			return { text: canned, stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

test('classify: relationshipEnum unset -> system prompt has no relationship section, schema is the legacy single-line form', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	await classify(
		{ classes: CLASSES, text: 'hello', context: '' },
		fakeProvider(JSON.stringify({ id: 'code-analysis', confidence: 0.9, reasoning: 'x', scope: 'M' }), cap),
	);
	const sys = cap.messages![0]!.content;
	assert.ok(!/Relationship to prior conversation/.test(sys));
	assert.ok(!/relationship/.test(sys.split('Schema:')[1] ?? ''),
		'Schema must not mention relationship when relationshipEnum is unset');
});

test('classify: relationshipEnum supplied -> system prompt grows relationship section + schema mentions relationship block', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	await classify(
		{
			classes: CLASSES,
			text: 'hello',
			relationshipEnum: RELATIONSHIP_KINDS,
		},
		fakeProvider(JSON.stringify({
			id: 'code-analysis', confidence: 0.9, reasoning: 'x', scope: 'M',
			relationship: { kind: 'NEW', confidence: 0.5, reasoning: 'no memory', citations: [] },
		}), cap),
	);
	const sys = cap.messages![0]!.content;
	assert.match(sys, /## Relationship to prior conversation/);
	for (const k of RELATIONSHIP_KINDS) {
		assert.match(sys, new RegExp(`- ${k}`), `enum value ${k} must appear in the prompt`);
	}
	assert.match(sys, /"relationship":\s*{/, 'schema must include the relationship block');
	assert.match(sys, /\[tN\]\s*\/\s*\[sN\]/, 'system prompt must mention the citation key shape');
});

// ---------------------------------------------------------------------------
// Parsing -- happy path
// ---------------------------------------------------------------------------

test('classify: valid relationship payload -> typed ClassifyRelationship returned', async () => {
	const out = await classify(
		{ classes: CLASSES, text: 'hello', relationshipEnum: RELATIONSHIP_KINDS },
		fakeProvider(JSON.stringify({
			id: 'code-analysis', confidence: 0.9, reasoning: 'r', scope: 'M',
			relationship: {
				kind: 'DRILL_DOWN', confidence: 0.82, reasoning: 'matches s2',
				citations: ['t1', 's2'],
			},
		})),
	);
	assert.equal(out.id,  'code-analysis');
	assert.equal(out.fallback, false);
	assert.deepEqual(out.relationship, {
		kind:        'DRILL_DOWN',
		confidence:  0.82,
		reasoning:   'matches s2',
		citations:   ['t1', 's2'],
	});
});

// ---------------------------------------------------------------------------
// Parsing -- defensive defaults
// ---------------------------------------------------------------------------

test('classify: relationship block missing -> defaults to NEW with empty citations', async () => {
	const out = await classify(
		{ classes: CLASSES, text: 'hello', relationshipEnum: RELATIONSHIP_KINDS },
		fakeProvider(JSON.stringify({
			id: 'code-analysis', confidence: 0.9, reasoning: 'r', scope: 'M',
			// no relationship block at all
		})),
	);
	assert.deepEqual(out.relationship, {
		kind:        'NEW',
		confidence:  0.5,
		reasoning:   'no relationship data emitted',
		citations:   [],
	});
});

test('classify: relationship.kind not in enum -> falls back to enum[0]', async () => {
	const out = await classify(
		{ classes: CLASSES, text: 'hello', relationshipEnum: RELATIONSHIP_KINDS },
		fakeProvider(JSON.stringify({
			id: 'code-analysis', confidence: 0.9, reasoning: 'r', scope: 'M',
			relationship: { kind: 'INVENTED_BY_LLM', confidence: 0.7, reasoning: 'meh', citations: ['t1'] },
		})),
	);
	assert.equal(out.relationship!.kind, 'NEW');
	// Other fields preserved -- only `kind` got coerced.
	assert.equal(out.relationship!.confidence, 0.7);
	assert.deepEqual(out.relationship!.citations, ['t1']);
});

test('classify: citations not an array -> empty citations, no throw', async () => {
	const out = await classify(
		{ classes: CLASSES, text: 'hello', relationshipEnum: RELATIONSHIP_KINDS },
		fakeProvider(JSON.stringify({
			id: 'code-analysis', confidence: 0.9, reasoning: 'r', scope: 'M',
			relationship: { kind: 'FOLLOWUP', confidence: 0.7, reasoning: 'm', citations: 'oops' },
		})),
	);
	assert.deepEqual(out.relationship!.citations, []);
});

test('classify: citations array with non-string entries -> non-string entries dropped', async () => {
	const out = await classify(
		{ classes: CLASSES, text: 'hello', relationshipEnum: RELATIONSHIP_KINDS },
		fakeProvider(JSON.stringify({
			id: 'code-analysis', confidence: 0.9, reasoning: 'r', scope: 'M',
			relationship: { kind: 'FOLLOWUP', confidence: 0.7, reasoning: 'm', citations: ['t1', 42, null, 's2', ''] },
		})),
	);
	assert.deepEqual(out.relationship!.citations, ['t1', 's2']);
});

test('classify: confidence outside 0..1 is clamped', async () => {
	const out = await classify(
		{ classes: CLASSES, text: 'hello', relationshipEnum: RELATIONSHIP_KINDS },
		fakeProvider(JSON.stringify({
			id: 'code-analysis', confidence: 0.9, reasoning: 'r', scope: 'M',
			relationship: { kind: 'NEW', confidence: 1.7, reasoning: 'r', citations: [] },
		})),
	);
	assert.equal(out.relationship!.confidence, 1);
});

test('classify: parse failure (provider returned junk) -> fallback result, NO relationship', async () => {
	const out = await classify(
		{ classes: CLASSES, text: 'hello', relationshipEnum: RELATIONSHIP_KINDS },
		fakeProvider('not valid json'),
	);
	assert.equal(out.fallback, true);
	assert.equal(out.relationship, undefined);
});
