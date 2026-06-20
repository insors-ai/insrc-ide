/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the Ollama-backed Layer 2 hook.
 *
 * Exercises the parser + payload construction with a scripted `LLMProvider`. The
 * live-LLM hits live Ollama (see `ollama-hook.live.test.ts`) but for fast CI we
 * fake the provider here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LLMMessage, LLMProvider, LLMResponse, CompletionOpts } from '../../../shared/types.js';
import { createOllamaLayer2Hook } from '../classifier/ollama-hook.js';


function fakeProvider(scriptedText: string): LLMProvider {
	let lastOpts: CompletionOpts | undefined;
	let lastMessages: LLMMessage[] | undefined;
	let lastSchema: unknown;
	const provider: LLMProvider & {
		lastOpts:     () => CompletionOpts | undefined;
		lastMessages: () => LLMMessage[] | undefined;
		lastSchema:   () => unknown;
	} = {
		supportsTools: false,
		capabilities: {
			structuredOutput: true, toolCalling: false, vision: false,
			webSearch: false, streaming: false, embeddings: false,
		},
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			lastOpts = opts;
			lastMessages = messages;
			return { text: scriptedText, stopReason: 'end_turn' };
		},
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
		// plans/structured-output.md Phase C.4: replay the scripted JSON
		// through completeStructured for the migrated Layer 2 hook.
		async completeStructured<T>(messages: LLMMessage[], schema: unknown, opts?: Record<string, unknown>): Promise<T> {
			lastMessages = messages;
			lastSchema   = schema;
			lastOpts = opts as CompletionOpts | undefined;
			try { return JSON.parse(scriptedText) as T; }
			catch (err) {
				throw new Error(`fakeProvider.completeStructured: text not JSON: ${scriptedText.slice(0, 80)} (${(err as Error).message})`);
			}
		},
		lastOpts:     () => lastOpts,
		lastMessages: () => lastMessages,
		lastSchema:   () => lastSchema,
	};
	return provider;
}


// ---------------------------------------------------------------------------
// Verdict routing
// ---------------------------------------------------------------------------

test('ollama-hook: accept -> payload built from structured output', async () => {
	const hook = createOllamaLayer2Hook({
		provider: fakeProvider(JSON.stringify({
			verdict:       'accept',
			confidence:    0.92,
			rationale:     'Clear durable preference about test coverage.',
			subject:       'test-policy',
			canonicalText: 'Always include unit tests in implementation plans.',
			categories:    ['implementation'],
			repoPaths:     [],
			relationship:  { kind: 'independent' },
		})),
	});
	const result = await hook('always include unit tests', { turnId: 't1', layer1: 'defer' });
	assert.equal(result.kind, 'accept');
	if (result.kind !== 'accept') return;
	assert.equal(result.payload.preferenceSubject, 'test-policy');
	assert.equal(result.payload.canonicalText, 'Always include unit tests in implementation plans.');
	assert.deepEqual([...result.payload.categories ?? []], ['implementation']);
	assert.equal(result.payload.confidence, 0.92);
	assert.equal(result.payload.relationship?.kind, 'independent');
});

test('ollama-hook: reject -> rejection passed through', async () => {
	const hook = createOllamaLayer2Hook({
		provider: fakeProvider(JSON.stringify({
			verdict:    'reject',
			confidence: 0.85,
			rationale:  'Conversational filler, not a durable rule.',
		})),
	});
	const result = await hook('thanks!', { turnId: 't2', layer1: 'defer' });
	assert.equal(result.kind, 'reject');
	if (result.kind !== 'reject') return;
	assert.ok(result.reason.includes('Conversational'));
});

test('ollama-hook: defer -> deferral passed through', async () => {
	const hook = createOllamaLayer2Hook({
		provider: fakeProvider(JSON.stringify({
			verdict:    'defer',
			confidence: 0.4,
			rationale:  'Could go either way.',
		})),
	});
	const result = await hook('maybe we should always test things', { turnId: 't3', layer1: 'defer' });
	assert.equal(result.kind, 'defer');
});


// ---------------------------------------------------------------------------
// Robustness: malformed responses
// ---------------------------------------------------------------------------

test('ollama-hook: non-JSON response -> defer with error reason', async () => {
	const hook = createOllamaLayer2Hook({
		provider: fakeProvider('I am sorry, I cannot comply.'),
	});
	const result = await hook('always include unit tests', { turnId: 't4', layer1: 'defer' });
	assert.equal(result.kind, 'defer');
	if (result.kind !== 'defer') return;
	assert.ok(result.reason.includes('LLM call failed'));
});

test('ollama-hook: clean JSON accepted (text-recovery path retired post-C.4)', async () => {
	// plans/structured-output.md Phase C.4. After migration the wire
	// layer (provider.completeStructured) guarantees clean JSON; the
	// legacy fence-strip + brace-match recovery is no longer needed.
	// This test now pins the clean path; the fakeProvider's
	// completeStructured stub JSON.parses the script directly.
	const hook = createOllamaLayer2Hook({
		provider: fakeProvider(JSON.stringify({
			verdict:    'accept',
			confidence: 0.9,
			rationale:  'r',
			subject:    'code-style',
			canonicalText: 'Use tabs for indentation.',
			relationship: { kind: 'independent' },
		})),
	});
	const result = await hook('use tabs', { turnId: 't5', layer1: 'defer' });
	assert.equal(result.kind, 'accept');
	if (result.kind !== 'accept') return;
	assert.equal(result.payload.preferenceSubject, 'code-style');
});

test('ollama-hook: invalid verdict -> defer with parse-error reason', async () => {
	const hook = createOllamaLayer2Hook({
		provider: fakeProvider(JSON.stringify({
			verdict:    'maybe',
			confidence: 0.5,
			rationale:  'unsure',
		})),
	});
	const result = await hook('x', { turnId: 't6', layer1: 'defer' });
	assert.equal(result.kind, 'defer');
});

test('ollama-hook: subject not in PreferenceSubject enum -> omitted from payload', async () => {
	const hook = createOllamaLayer2Hook({
		provider: fakeProvider(JSON.stringify({
			verdict:       'accept',
			confidence:    0.9,
			rationale:     'r',
			subject:       'not-a-real-subject',     // outside the enum
			canonicalText: 'X',
			relationship:  { kind: 'independent' },
		})),
	});
	const result = await hook('always do X', { turnId: 't7', layer1: 'defer' });
	assert.equal(result.kind, 'accept');
	if (result.kind !== 'accept') return;
	assert.equal(result.payload.preferenceSubject, undefined);    // bad value dropped
	assert.equal(result.payload.subject, 'unknown');                // legacy fallback
});


// ---------------------------------------------------------------------------
// Schema constraint passed to the provider
// ---------------------------------------------------------------------------

test('ollama-hook: passes typebox schema to completeStructured with PreferenceSubject enum', async () => {
	// plans/structured-output.md Phase C.4. The schema is now sent
	// directly to provider.completeStructured (not in opts.responseFormat).
	// The typebox schema renders as JSON Schema with the PreferenceSubject
	// enum on the `subject` property's anyOf branch.
	const provider = fakeProvider(JSON.stringify({ verdict: 'reject', confidence: 0.8, rationale: 'r' }));
	const hook = createOllamaLayer2Hook({ provider });
	await hook('x', { turnId: 't8', layer1: 'defer' });
	const schema = (provider as unknown as { lastSchema: () => unknown }).lastSchema();
	assert.ok(schema !== undefined && typeof schema === 'object');
	// typebox Type.Union(literals) renders as `anyOf: [{ const: '...' }, ...]`;
	// the schema's properties.subject is that union (optionally wrapped).
	const subjectSchema = (schema as { properties?: { subject?: unknown } }).properties?.subject;
	const literals = collectStringLiterals(subjectSchema);
	assert.ok(literals.includes('test-policy'),  `expected 'test-policy' in literals, got ${JSON.stringify(literals)}`);
	assert.ok(literals.includes('code-style'),   `expected 'code-style' in literals, got ${JSON.stringify(literals)}`);
});

function collectStringLiterals(node: unknown): string[] {
	if (typeof node !== 'object' || node === null) { return []; }
	const o = node as Record<string, unknown>;
	if (typeof o['const'] === 'string') { return [o['const']]; }
	if (Array.isArray(o['enum'])) { return (o['enum'] as unknown[]).filter((x): x is string => typeof x === 'string'); }
	const out: string[] = [];
	for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
		const arr = o[k];
		if (Array.isArray(arr)) { for (const branch of arr) { out.push(...collectStringLiterals(branch)); } }
	}
	for (const k of ['items', 'additionalProperties'] as const) {
		if (o[k] !== undefined) { out.push(...collectStringLiterals(o[k])); }
	}
	return out;
}


// ---------------------------------------------------------------------------
// Related-entries injection (G7 relationship classification)
// ---------------------------------------------------------------------------

test('ollama-hook: relationship existingRef preserved when LLM emits it', async () => {
	const hook = createOllamaLayer2Hook({
		provider: fakeProvider(JSON.stringify({
			verdict:       'accept',
			confidence:    0.9,
			rationale:     'Refines the existing rule',
			subject:       'test-policy',
			canonicalText: 'always include unit tests with at least 80% coverage',
			relationship:  { kind: 'refinement', existingRef: 'turn-1::test-policy' },
		})),
		findRelatedEntries: async () => [
			{ id: 'turn-1::test-policy', canonicalText: 'always include unit tests', subject: 'test-policy' },
		],
	});
	const result = await hook('always include unit tests with at least 80% coverage', { turnId: 't9', layer1: 'defer' });
	assert.equal(result.kind, 'accept');
	if (result.kind !== 'accept') return;
	assert.equal(result.payload.relationship?.kind, 'refinement');
	if (result.payload.relationship?.kind === 'refinement') {
		assert.equal(result.payload.relationship.existingRef, 'turn-1::test-policy');
	}
});
