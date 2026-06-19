/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for `GeminiProvider.completeStructured` + the OpenAPI 3.0
 * schema adapter (plans/structured-output.md Phase B.3).
 *
 * Pins:
 *   - Adapter: type lowercase -> UPPERCASE, oneOf -> anyOf, const ->
 *     enum-of-one, drop additionalProperties / allOf / etc.
 *   - $ref throws explicitly (no silent drop).
 *   - Provider call carries responseMimeType + responseSchema.
 *   - Happy / retry / exhausted paths mirror B.1 + B.2.
 *   - Discriminated union (Phase1Ask shape) round-trips.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Static, Type } from '@sinclair/typebox';

import { GeminiProvider } from '../gemini.js';
import { jsonSchemaToGeminiSchema } from '../gemini-schema-adapter.js';


// ---------------------------------------------------------------------------
// Schema adapter
// ---------------------------------------------------------------------------

test('adapter: type lowercase -> UPPERCASE', () => {
	const out = jsonSchemaToGeminiSchema({ type: 'object' }) as Record<string, unknown>;
	assert.equal(out['type'], 'OBJECT');
});

test('adapter: nested object preserves UPPERCASE recursion', () => {
	const out = jsonSchemaToGeminiSchema({
		type: 'object',
		properties: {
			name:   { type: 'string' },
			count:  { type: 'integer' },
			active: { type: 'boolean' },
		},
	}) as { properties: Record<string, { type: string }> };
	assert.equal(out['properties']['name']!.type,   'STRING');
	assert.equal(out['properties']['count']!.type,  'INTEGER');
	assert.equal(out['properties']['active']!.type, 'BOOLEAN');
});

test('adapter: oneOf -> anyOf rewrite', () => {
	const out = jsonSchemaToGeminiSchema({
		oneOf: [
			{ type: 'object', properties: { a: { type: 'string' } } },
			{ type: 'object', properties: { b: { type: 'integer' } } },
		],
	}) as Record<string, unknown>;
	assert.equal(out['oneOf'], undefined);
	assert.ok(Array.isArray(out['anyOf']));
});

test('adapter: const -> enum-of-one + type from JS typeof', () => {
	const out1 = jsonSchemaToGeminiSchema({ const: 'sufficient' }) as Record<string, unknown>;
	assert.equal(out1['type'], 'STRING');
	assert.deepEqual(out1['enum'], ['sufficient']);

	const out2 = jsonSchemaToGeminiSchema({ const: 42 }) as Record<string, unknown>;
	assert.equal(out2['type'], 'INTEGER');
	assert.deepEqual(out2['enum'], [42]);
});

test('adapter: drops unsupported keywords (additionalProperties, allOf, etc.)', () => {
	const out = jsonSchemaToGeminiSchema({
		type: 'object',
		additionalProperties: false,
		properties: { x: { type: 'string' } },
		allOf: [{ type: 'string' }],
		definitions: { foo: { type: 'string' } },
	}) as Record<string, unknown>;
	assert.equal(out['additionalProperties'], undefined);
	assert.equal(out['allOf'],               undefined);
	assert.equal(out['definitions'],         undefined);
});

test('adapter: $ref throws explicitly', () => {
	assert.throws(
		() => jsonSchemaToGeminiSchema({ $ref: '#/definitions/Foo' }),
		/\$ref is not supported/,
	);
});

test('adapter: discriminated union (Phase1Ask shape) survives translation', () => {
	const Phase1AskSchema = Type.Union([
		Type.Object({ kind: Type.Literal('sufficient') }),
		Type.Object({
			kind:     Type.Literal('context-needed'),
			requests: Type.Array(Type.Object({ kind: Type.String() })),
		}),
	]);
	const out = jsonSchemaToGeminiSchema(Phase1AskSchema as unknown as Record<string, unknown>) as Record<string, unknown>;
	// typebox emits `anyOf` for Type.Union; adapter passes through.
	assert.ok(Array.isArray(out['anyOf']));
	// Each branch is an object whose type is UPPERCASE.
	const branches = out['anyOf'] as Array<Record<string, unknown>>;
	for (const b of branches) {
		assert.equal(b['type'], 'OBJECT');
	}
});

test('adapter: array of items', () => {
	const out = jsonSchemaToGeminiSchema({
		type:  'array',
		items: { type: 'string' },
	}) as Record<string, unknown>;
	assert.equal(out['type'],            'ARRAY');
	assert.deepEqual(out['items'],       { type: 'STRING' });
});


// ---------------------------------------------------------------------------
// Provider end-to-end with mock client
// ---------------------------------------------------------------------------

interface RecordedCall { req: Record<string, unknown> }
type GenContentResp = {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
	}>;
	text?: string;
};


function makeProvider(scriptedResponses: readonly GenContentResp[]): {
	provider: GeminiProvider;
	calls:    RecordedCall[];
} {
	const provider = new GeminiProvider({ apiKey: 'test', model: 'gemini-test' });
	const calls: RecordedCall[] = [];
	let i = 0;
	const mockClient = {
		models: {
			generateContent: async (req: Record<string, unknown>) => {
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

function jsonResp(value: unknown): GenContentResp {
	return {
		candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
	};
}

function textResp(text: string): GenContentResp {
	return { candidates: [{ content: { parts: [{ text }] } }] };
}


test('B.3 capabilities.structuredOutput is true on GeminiProvider', () => {
	const p = new GeminiProvider({ apiKey: 'test' });
	assert.equal(p.capabilities.structuredOutput, true);
});


test('B.3 completeStructured: scripted JSON parses + ajv-validates', async () => {
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

	const req = calls[0]!.req as {
		config: {
			responseMimeType: string;
			responseSchema:   { type: string };
		};
	};
	assert.equal(req.config.responseMimeType, 'application/json');
	assert.equal(req.config.responseSchema.type, 'OBJECT'); // adapter applied
});


test('B.3 completeStructured: malformed JSON -> retry -> success', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });
	const { provider, calls } = makeProvider([
		textResp('not json'),
		jsonResp({ ok: true }),
	]);
	const r = await provider.completeStructured(
		[{ role: 'user', content: 'go' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal((r as { ok: boolean }).ok, true);
	assert.equal(calls.length, 2);
});


test('B.3 completeStructured: 3 bad responses -> exhausted', async () => {
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


test('B.3 completeStructured: discriminated union round-trips', async () => {
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


test('B.3 completeStructured: caller schema NOT mutated by adapter', async () => {
	const Schema = Type.Object({ x: Type.String() }) as unknown as Record<string, unknown>;
	const before = JSON.parse(JSON.stringify(Schema));

	const { provider } = makeProvider([jsonResp({ x: 'hi' })]);
	await provider.completeStructured(
		[{ role: 'user', content: 'go' }],
		Schema,
	);
	assert.deepEqual(JSON.parse(JSON.stringify(Schema)), before);
});


test('B.3 completeStructured: empty text -> retry', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });
	const { provider, calls } = makeProvider([
		textResp(''),
		jsonResp({ ok: true }),
	]);
	const r = await provider.completeStructured(
		[{ role: 'user', content: 'go' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal((r as { ok: boolean }).ok, true);
	assert.equal(calls.length, 2);
});
