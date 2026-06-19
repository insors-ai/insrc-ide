/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for `MistralProvider.completeStructured` (plans/structured-output.md Phase B.4).
 *
 * Pins:
 *   - supportsJsonSchema allow-list: mistral-large / mistral-small-2503 / mistral-small-latest /
 *     pixtral-large / codestral get json_schema; older / unknown models get json_object.
 *   - Capability flag flipped to true.
 *   - Happy / retry / exhausted paths.
 *   - The wire-level responseFormat matches the model's tier.
 *   - Caller schema is sent verbatim under jsonSchema.schemaDefinition for new-tier models.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Static, Type } from '@sinclair/typebox';

import { MistralProvider, _supportsJsonSchemaForTest } from '../mistral.js';


// ---------------------------------------------------------------------------
// supportsJsonSchema allow-list
// ---------------------------------------------------------------------------

test('supportsJsonSchema: matches large + small-latest + small-2503 + pixtral-large + codestral', () => {
	assert.equal(_supportsJsonSchemaForTest('mistral-large-latest'),  true);
	assert.equal(_supportsJsonSchemaForTest('mistral-large-2411'),    true);
	assert.equal(_supportsJsonSchemaForTest('mistral-small-latest'),  true);
	assert.equal(_supportsJsonSchemaForTest('mistral-small-2503'),    true);
	assert.equal(_supportsJsonSchemaForTest('pixtral-large-2411'),    true);
	assert.equal(_supportsJsonSchemaForTest('codestral-2501'),        true);
	assert.equal(_supportsJsonSchemaForTest('mistral-medium-2505'),   true);
});

test('supportsJsonSchema: rejects older / unknown models -> json_object fallback', () => {
	assert.equal(_supportsJsonSchemaForTest('mistral-small-2402'),    false);
	assert.equal(_supportsJsonSchemaForTest('open-mistral-7b'),       false);
	assert.equal(_supportsJsonSchemaForTest('totally-unknown-model'), false);
});


// ---------------------------------------------------------------------------
// Provider end-to-end with mock client
// ---------------------------------------------------------------------------

interface RecordedCall { req: Record<string, unknown> }
type ChatResp = {
	choices: Array<{ message: { content: string; role?: 'assistant' } }>;
};

function makeProvider(
	scriptedResponses: readonly ChatResp[],
	model = 'mistral-large-latest',
): { provider: MistralProvider; calls: RecordedCall[] } {
	const provider = new MistralProvider({ apiKey: 'test', model });
	const calls: RecordedCall[] = [];
	let i = 0;
	const mockClient = {
		chat: {
			complete: async (req: Record<string, unknown>) => {
				calls.push({ req });
				const r = scriptedResponses[i++];
				if (r === undefined) { throw new Error(`mock: no more responses (call ${i})`); }
				return r;
			},
		},
	};
	(provider as unknown as { client: unknown }).client = mockClient;
	return { provider, calls };
}

function jsonResp(value: unknown): ChatResp {
	return { choices: [{ message: { content: JSON.stringify(value), role: 'assistant' } }] };
}

function rawResp(text: string): ChatResp {
	return { choices: [{ message: { content: text, role: 'assistant' } }] };
}


test('B.4 capabilities.structuredOutput is true on MistralProvider', () => {
	const p = new MistralProvider({ apiKey: 'test' });
	assert.equal(p.capabilities.structuredOutput, true);
});


test('B.4 completeStructured: scripted JSON parses + validates (new-tier model)', async () => {
	const Schema = Type.Object({
		category: Type.String(),
		count:    Type.Integer({ minimum: 0 }),
	});
	type R = Static<typeof Schema>;

	const { provider, calls } = makeProvider([
		jsonResp({ category: 'good', count: 3 }),
	], 'mistral-large-latest');
	const r = await provider.completeStructured<R>(
		[{ role: 'user', content: 'classify' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal(r.category, 'good');
	assert.equal(r.count, 3);

	const req = calls[0]!.req as {
		responseFormat: { type: string; jsonSchema?: { name: string; strict: boolean; schemaDefinition: unknown } };
	};
	assert.equal(req.responseFormat.type, 'json_schema');
	assert.equal(req.responseFormat.jsonSchema!.strict, true);
	// Caller schema sent verbatim (no strict-mode preprocess on Mistral).
	assert.equal((req.responseFormat.jsonSchema!.schemaDefinition as { type?: string }).type, 'object');
});


test('B.4 completeStructured: older model falls back to json_object', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });
	const { provider, calls } = makeProvider([
		jsonResp({ ok: true }),
	], 'open-mistral-7b');
	await provider.completeStructured(
		[{ role: 'user', content: 'go' }],
		Schema as unknown as Record<string, unknown>,
	);
	const req = calls[0]!.req as { responseFormat: { type: string } };
	assert.equal(req.responseFormat.type, 'json_object');
});


test('B.4 completeStructured: malformed JSON -> retry -> success', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });
	const { provider, calls } = makeProvider([
		rawResp('not json'),
		jsonResp({ ok: true }),
	]);
	const r = await provider.completeStructured(
		[{ role: 'user', content: 'go' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal((r as { ok: boolean }).ok, true);
	assert.equal(calls.length, 2);
});


test('B.4 completeStructured: 3 bad -> exhausted', async () => {
	const Schema = Type.Object({ count: Type.Integer() });
	const { provider } = makeProvider([
		jsonResp({}),
		jsonResp({}),
		jsonResp({}),
	]);
	await assert.rejects(
		provider.completeStructured(
			[{ role: 'user', content: 'fail' }],
			Schema as unknown as Record<string, unknown>,
		),
		/failed after 3 attempts/,
	);
});


test('B.4 completeStructured: discriminated union round-trips', async () => {
	const Phase1AskSchema = Type.Union([
		Type.Object({ kind: Type.Literal('sufficient') }),
		Type.Object({
			kind:     Type.Literal('context-needed'),
			requests: Type.Array(Type.Object({ kind: Type.String() })),
		}),
	]);
	type Ask = Static<typeof Phase1AskSchema>;

	const { provider } = makeProvider([
		jsonResp({ kind: 'sufficient' }),
	]);
	const r = await provider.completeStructured<Ask>(
		[{ role: 'user', content: 'need context?' }],
		Phase1AskSchema as unknown as Record<string, unknown>,
	);
	assert.equal(r.kind, 'sufficient');
});


test('B.4 completeStructured: empty content -> retry', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });
	const { provider, calls } = makeProvider([
		rawResp(''),
		jsonResp({ ok: true }),
	]);
	const r = await provider.completeStructured(
		[{ role: 'user', content: 'go' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal((r as { ok: boolean }).ok, true);
	assert.equal(calls.length, 2);
});
