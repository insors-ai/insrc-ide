/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for `OpenAIProvider.completeStructured` (plans/structured-output.md Phase B.2).
 *
 * Pins:
 *   - Capability flag flipped to structuredOutput: true.
 *   - Schema is sent under response_format.json_schema with strict: true.
 *   - processSchemaForOpenAIStrict is applied (additionalProperties:false
 *     appears on the wire schema).
 *   - Happy path: scripted JSON content parses + ajv-validates.
 *   - Retry path: malformed JSON content -> retry -> success.
 *   - Final failure: 3 malformed responses -> exhausted error.
 *   - Discriminated union (Phase1Ask shape) round-trips.
 *   - Caller's original schema constant is NOT mutated (deep-clone).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Static, Type } from '@sinclair/typebox';

import { OpenAIProvider } from '../openai.js';


interface RecordedCreate { req: Record<string, unknown> }
type CreateResponse = {
	choices: Array<{ message: { content: string; role?: 'assistant' } }>;
};

function makeProvider(scriptedResponses: readonly CreateResponse[]): {
	provider: OpenAIProvider;
	calls:    RecordedCreate[];
} {
	const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-test' });
	const calls: RecordedCreate[] = [];
	let i = 0;
	const mockClient = {
		chat: {
			completions: {
				create: async (req: Record<string, unknown>) => {
					calls.push({ req });
					const resp = scriptedResponses[i++];
					if (resp === undefined) {
						throw new Error(`mock client: no more scripted responses (call ${i})`);
					}
					return resp;
				},
			},
		},
	};
	(provider as unknown as { client: unknown }).client = mockClient;
	return { provider, calls };
}

function jsonResp(value: unknown): CreateResponse {
	return { choices: [{ message: { content: JSON.stringify(value), role: 'assistant' } }] };
}

function rawResp(text: string): CreateResponse {
	return { choices: [{ message: { content: text, role: 'assistant' } }] };
}


// ---------------------------------------------------------------------------
// Capability flag
// ---------------------------------------------------------------------------

test('B.2 capabilities.structuredOutput is true on OpenAIProvider', () => {
	const p = new OpenAIProvider({ apiKey: 'test' });
	assert.equal(p.capabilities.structuredOutput, true);
});


// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('B.2 completeStructured: scripted JSON content parses + validates', async () => {
	const Schema = Type.Object({
		category: Type.String(),
		count:    Type.Integer({ minimum: 0 }),
	});
	type R = Static<typeof Schema>;

	const { provider, calls } = makeProvider([jsonResp({ category: 'good', count: 3 })]);
	const r = await provider.completeStructured<R>(
		[{ role: 'user', content: 'classify this' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal(r.category, 'good');
	assert.equal(r.count,    3);
	assert.equal(calls.length, 1);

	const req = calls[0]!.req as {
		response_format: {
			type: string;
			json_schema: {
				name:   string;
				schema: { type: string; additionalProperties?: boolean; required?: string[] };
				strict: boolean;
			};
		};
	};
	assert.equal(req.response_format.type, 'json_schema');
	assert.equal(req.response_format.json_schema.strict, true);
	assert.equal(req.response_format.json_schema.schema.type, 'object');
	// processSchemaForOpenAIStrict applied: additionalProperties:false + full required.
	assert.equal(req.response_format.json_schema.schema.additionalProperties, false);
	assert.deepEqual([...(req.response_format.json_schema.schema.required ?? [])].sort(),
		['category', 'count']);
});


// ---------------------------------------------------------------------------
// Retry path
// ---------------------------------------------------------------------------

test('B.2 completeStructured: malformed JSON -> retry -> success', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });

	const { provider, calls } = makeProvider([
		rawResp('not json'),
		jsonResp({ ok: true }),
	]);
	const r = await provider.completeStructured<Static<typeof Schema>>(
		[{ role: 'user', content: 'go' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal((r as { ok: boolean }).ok, true);
	assert.equal(calls.length, 2);

	// Second call gets the feedback note.
	const req2 = calls[1]!.req as { messages: Array<{ role: string; content: string }> };
	const lastMsg = req2.messages[req2.messages.length - 1]!;
	assert.equal(lastMsg.role, 'user');
	assert.match(lastMsg.content, /schema validation|not valid JSON/);
});


// ---------------------------------------------------------------------------
// Final failure
// ---------------------------------------------------------------------------

test('B.2 completeStructured: 3 bad responses -> exhausted error', async () => {
	const Schema = Type.Object({ count: Type.Integer() });

	const { provider } = makeProvider([
		jsonResp({}),
		jsonResp({}),
		jsonResp({}),
	]);
	await assert.rejects(
		provider.completeStructured(
			[{ role: 'user', content: 'fail me' }],
			Schema as unknown as Record<string, unknown>,
		),
		(err: Error) => {
			assert.match(err.message, /failed after 3 attempts/);
			return true;
		},
	);
});


// ---------------------------------------------------------------------------
// Discriminated union (Phase1Ask)
// ---------------------------------------------------------------------------

test('B.2 completeStructured: discriminated union round-trips', async () => {
	const Phase1AskSchema = Type.Union([
		Type.Object({ kind: Type.Literal('sufficient') }),
		Type.Object({
			kind:     Type.Literal('context-needed'),
			requests: Type.Array(Type.Object({ kind: Type.String() })),
		}),
	]);
	type Ask = Static<typeof Phase1AskSchema>;

	const { provider } = makeProvider([jsonResp({ kind: 'sufficient' })]);
	const r = await provider.completeStructured<Ask>(
		[{ role: 'user', content: 'need context?' }],
		Phase1AskSchema as unknown as Record<string, unknown>,
	);
	assert.equal(r.kind, 'sufficient');
});


// ---------------------------------------------------------------------------
// Schema deep-clone: caller's constant must not mutate
// ---------------------------------------------------------------------------

test('B.2 completeStructured: caller schema is NOT mutated by strict pre-flight', async () => {
	const Schema = Type.Object({
		x: Type.String(),
	}) as unknown as Record<string, unknown>;
	// Capture the original shape via deep-clone snapshot.
	const before = JSON.parse(JSON.stringify(Schema));

	const { provider } = makeProvider([jsonResp({ x: 'hi' })]);
	await provider.completeStructured(
		[{ role: 'user', content: 'go' }],
		Schema,
	);

	const after = JSON.parse(JSON.stringify(Schema));
	assert.deepEqual(before, after, 'caller schema must stay untouched after the call');
});


// ---------------------------------------------------------------------------
// Empty content -> treated as failure -> retry
// ---------------------------------------------------------------------------

test('B.2 completeStructured: empty content -> retry', async () => {
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
