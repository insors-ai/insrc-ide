/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the structured-output Phase A helpers
 * (plans/structured-output.md Phase A).
 *
 * Pins the contract for:
 *   - `validateAgainstSchema` -- ajv-backed JSON Schema validation with
 *     human-readable error messages.
 *   - `withStructuredRetry` -- Instructor-style retry loop: succeeds on
 *     first attempt, succeeds on later attempt after appending validation
 *     errors to the conversation, throws after exhausting attempts.
 *   - `processSchemaForOpenAIStrict` -- additionalProperties:false,
 *     required-array completeness, oneOf -> anyOf rewrite, idempotency,
 *     pure-dictionary preservation.
 *   - `notImplementedStructuredOutput` -- stable error message that
 *     Phase B.x providers throw until they migrate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';

import {
	notImplementedStructuredOutput,
	processSchemaForOpenAIStrict,
	validateAgainstSchema,
	withStructuredRetry,
	type ValidationResult,
} from '../structured-output.js';
import type { StructuredSchema } from '../../../shared/types.js';


// ---------------------------------------------------------------------------
// validateAgainstSchema
// ---------------------------------------------------------------------------

test('validateAgainstSchema: accepts well-formed input', () => {
	const schema = Type.Object({
		category: Type.String(),
		count:    Type.Integer({ minimum: 0 }),
	});
	const r = validateAgainstSchema<{ category: string; count: number }>(schema, {
		category: 'foo', count: 3,
	});
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.value.category, 'foo');
		assert.equal(r.value.count,    3);
	}
});

test('validateAgainstSchema: rejects missing required field with path', () => {
	const schema = Type.Object({
		category: Type.String(),
		count:    Type.Integer(),
	});
	const r = validateAgainstSchema(schema, { category: 'foo' });
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.errors.length >= 1);
		assert.match(r.errors[0]!, /count|required/);
	}
});

test('validateAgainstSchema: rejects wrong type with informative path', () => {
	const schema = Type.Object({ count: Type.Integer() });
	const r = validateAgainstSchema(schema, { count: 'not a number' });
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.errors.some(e => e.includes('/count') && /integer/.test(e)));
	}
});

test('validateAgainstSchema: discriminated union (mirrors Phase1Ask shape)', () => {
	const schema = Type.Union([
		Type.Object({ kind: Type.Literal('sufficient') }),
		Type.Object({
			kind:     Type.Literal('context-needed'),
			requests: Type.Array(Type.Object({ kind: Type.String() })),
		}),
	]);

	const ok1 = validateAgainstSchema(schema, { kind: 'sufficient' });
	assert.equal(ok1.ok, true);

	const ok2 = validateAgainstSchema(schema, {
		kind: 'context-needed', requests: [{ kind: 'files' }],
	});
	assert.equal(ok2.ok, true);

	const bad = validateAgainstSchema(schema, { kind: 'something-else' });
	assert.equal(bad.ok, false);
});


// ---------------------------------------------------------------------------
// withStructuredRetry
// ---------------------------------------------------------------------------

test('withStructuredRetry: succeeds on first attempt with no feedback note', async () => {
	const calls: (string | undefined)[] = [];
	const v: (raw: unknown) => ValidationResult<string> = (raw) =>
		typeof raw === 'string'
			? { ok: true, value: raw }
			: { ok: false, errors: ['not a string'] };
	const result = await withStructuredRetry(
		async (note) => { calls.push(note); return 'hello'; },
		v,
		3,
	);
	assert.equal(result, 'hello');
	assert.equal(calls.length, 1);
	assert.equal(calls[0], undefined);
});

test('withStructuredRetry: retries with feedback note on second attempt', async () => {
	const calls: (string | undefined)[] = [];
	let n = 0;
	const v: (raw: unknown) => ValidationResult<string> = (raw) =>
		raw === 'good'
			? { ok: true, value: raw as string }
			: { ok: false, errors: ['expected "good"', 'got something else'] };

	const result = await withStructuredRetry(
		async (note) => {
			calls.push(note);
			n += 1;
			return n === 1 ? 'bad' : 'good';
		},
		v,
		3,
	);
	assert.equal(result, 'good');
	assert.equal(calls.length, 2);
	assert.equal(calls[0], undefined);
	assert.ok(calls[1] !== undefined);
	assert.match(calls[1]!, /expected "good"/);
	assert.match(calls[1]!, /got something else/);
	assert.match(calls[1]!, /schema validation/);
});

test('withStructuredRetry: throws after exhausting maxAttempts; error contains last errors', async () => {
	const v: (raw: unknown) => ValidationResult<string> = () =>
		({ ok: false, errors: ['always wrong'] });
	await assert.rejects(
		withStructuredRetry(async () => 'whatever', v, 2),
		(err: Error) => {
			assert.match(err.message, /failed after 2 attempts/);
			assert.match(err.message, /always wrong/);
			return true;
		},
	);
});

test('withStructuredRetry: maxAttempts < 1 throws clearly', async () => {
	await assert.rejects(
		withStructuredRetry(async () => null, () => ({ ok: false, errors: [] }), 0),
		/maxAttempts must be >= 1/,
	);
});


// ---------------------------------------------------------------------------
// processSchemaForOpenAIStrict
// ---------------------------------------------------------------------------

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)) as T; }

test('processSchemaForOpenAIStrict: adds additionalProperties:false on objects', () => {
	const schema = clone({ type: 'object', properties: { name: { type: 'string' } } } as StructuredSchema);
	processSchemaForOpenAIStrict(schema);
	assert.equal((schema as Record<string, unknown>)['additionalProperties'], false);
});

test('processSchemaForOpenAIStrict: required covers every non-dict property', () => {
	const schema = clone({
		type: 'object',
		properties: {
			a: { type: 'string' },
			b: { type: 'integer' },
		},
	} as StructuredSchema);
	processSchemaForOpenAIStrict(schema);
	const req = (schema as { required?: string[] }).required ?? [];
	assert.deepEqual([...req].sort(), ['a', 'b']);
});

test('processSchemaForOpenAIStrict: rewrites oneOf -> anyOf', () => {
	const schema = clone({
		oneOf: [
			{ type: 'object', properties: { a: { type: 'string' } } },
			{ type: 'object', properties: { b: { type: 'string' } } },
		],
	} as StructuredSchema);
	processSchemaForOpenAIStrict(schema);
	const s = schema as Record<string, unknown>;
	assert.equal(s['oneOf'], undefined);
	assert.ok(Array.isArray(s['anyOf']));
	assert.equal((s['anyOf'] as unknown[]).length, 2);
});

test('processSchemaForOpenAIStrict: recurses into nested objects', () => {
	const schema = clone({
		type: 'object',
		properties: {
			nested: { type: 'object', properties: { x: { type: 'integer' } } },
		},
	} as StructuredSchema);
	processSchemaForOpenAIStrict(schema);
	const nested = (schema as { properties: { nested: Record<string, unknown> } }).properties.nested;
	assert.equal(nested['additionalProperties'], false);
	assert.deepEqual(nested['required'], ['x']);
});

test('processSchemaForOpenAIStrict: pure-dictionary objects preserved (no additionalProperties:false stamp)', () => {
	const schema = clone({
		type: 'object',
		additionalProperties: { type: 'string' },
	} as StructuredSchema);
	processSchemaForOpenAIStrict(schema);
	const s = schema as Record<string, unknown>;
	// additionalProperties stays as the schema; we did NOT overwrite to false.
	assert.ok(typeof s['additionalProperties'] === 'object',
		`pure-dict additionalProperties should stay as schema; got ${JSON.stringify(s['additionalProperties'])}`);
});

test('processSchemaForOpenAIStrict: idempotent (run twice = run once)', () => {
	const schema = clone({
		type: 'object',
		properties: { x: { type: 'integer' } },
		oneOf: [],
	} as StructuredSchema);
	processSchemaForOpenAIStrict(schema);
	const after1 = JSON.parse(JSON.stringify(schema));
	processSchemaForOpenAIStrict(schema);
	const after2 = JSON.parse(JSON.stringify(schema));
	assert.deepEqual(after1, after2);
});

test('processSchemaForOpenAIStrict: walks anyOf branches', () => {
	const schema = clone({
		anyOf: [
			{ type: 'object', properties: { a: { type: 'string' } } },
		],
	} as StructuredSchema);
	processSchemaForOpenAIStrict(schema);
	const branch0 = (schema as { anyOf: Record<string, unknown>[] }).anyOf[0]!;
	assert.equal(branch0['additionalProperties'], false);
	assert.deepEqual(branch0['required'], ['a']);
});


// ---------------------------------------------------------------------------
// notImplementedStructuredOutput
// ---------------------------------------------------------------------------

test('notImplementedStructuredOutput: throws with stable provider-named message', () => {
	assert.throws(
		() => notImplementedStructuredOutput('test-provider'),
		(err: Error) => {
			assert.match(err.message, /provider 'test-provider' does not implement completeStructured yet/);
			assert.match(err.message, /capabilities\.structuredOutput/);
			return true;
		},
	);
});
