/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema adapter for Gemini's responseSchema (plans/structured-output.md Phase B.3).
 *
 * Gemini's structured-output API expects an OpenAPI 3.0-style schema,
 * NOT the JSON Schema draft 2020-12 dialect typebox emits. The
 * differences are small but load-bearing:
 *
 *   - **Type field is UPPERCASE** in OpenAPI 3.0 ('OBJECT', 'STRING',
 *     'INTEGER', 'NUMBER', 'BOOLEAN', 'ARRAY'). typebox emits lowercase.
 *   - **`additionalProperties` is not honoured** -- Gemini ignores it
 *     silently. Drop on conversion to avoid bloating the wire payload.
 *   - **`oneOf` / `allOf` / `not` / `if` / `then` / `else` are not
 *     supported.** We translate `oneOf` -> `anyOf` (Gemini DOES
 *     support `anyOf` for unions). Other unsupported keywords are
 *     dropped with a `description` annotation so the model still
 *     sees the intent.
 *   - **`$ref` / `definitions` / `$defs` are not supported.** typebox
 *     doesn't emit refs by default; we error if we encounter one
 *     (callers should inline their schemas).
 *   - **`const` is not supported.** Rewrite `{ const: 'foo' }` to
 *     `{ type: 'STRING', enum: ['foo'] }`.
 *   - **Top-level `nullable`** instead of `type: ['STRING', 'null']`
 *     union. typebox uses `Type.Union([Type.String(), Type.Null()])`
 *     which emits `anyOf` -- we keep that shape; Gemini's anyOf
 *     handles it.
 *
 * The adapter is pure: it returns a NEW schema, never mutates the
 * input. Mirrors the deep-clone discipline OpenAI's preprocessor
 * uses, and stays callable from `withStructuredRetry`'s call closure
 * (so re-issued attempts always see the same converted schema).
 */

import type { StructuredSchema } from '../../shared/types.js';


export function jsonSchemaToGeminiSchema(schema: StructuredSchema): StructuredSchema {
	return convert(schema as Record<string, unknown>) as StructuredSchema;
}


function convert(node: unknown): unknown {
	if (Array.isArray(node)) {
		return node.map(convert);
	}
	if (typeof node !== 'object' || node === null) {
		return node;
	}
	const src = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};

	// $ref is not supported in Gemini's responseSchema. Surface as an
	// error early -- the alternative (silent drop) produces confusing
	// validation failures downstream.
	if (typeof src['$ref'] === 'string') {
		throw new Error(`gemini-schema-adapter: $ref is not supported; inline the referenced schema. Got: ${src['$ref']}`);
	}

	// const -> enum-of-one rewrite. Gemini doesn't honour `const`.
	if (src['const'] !== undefined) {
		const c = src['const'];
		out['type'] = openApiType(typeof c === 'string'
			? 'string'
			: typeof c === 'number'
				? (Number.isInteger(c) ? 'integer' : 'number')
				: typeof c === 'boolean'
					? 'boolean'
					: 'string');
		out['enum'] = [c];
		// description preserved if set.
		if (typeof src['description'] === 'string') { out['description'] = src['description']; }
		return out;
	}

	// type translation (lowercase -> UPPERCASE OpenAPI 3.0).
	if (src['type'] !== undefined) {
		if (Array.isArray(src['type'])) {
			// JSON Schema nullable union -> Gemini's nullable: true.
			const types = src['type'].filter(t => t !== 'null');
			const hasNull = src['type'].length !== types.length;
			if (types.length === 1) {
				out['type']     = openApiType(types[0] as string);
				if (hasNull) { out['nullable'] = true; }
			} else if (types.length > 1) {
				// Multi-type without explicit union -- collapse to anyOf.
				out['anyOf'] = types.map(t => ({ type: openApiType(t as string) }));
				if (hasNull) { out['nullable'] = true; }
			}
		} else {
			out['type'] = openApiType(src['type'] as string);
		}
	}

	// Passthrough fields.
	for (const k of ['description', 'enum', 'format', 'minimum', 'maximum',
		'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
		'nullable', 'required'] as const) {
		if (src[k] !== undefined) { out[k] = src[k]; }
	}

	// Recurse into properties (each value is a sub-schema).
	if (isPlainObject(src['properties'])) {
		const props: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(src['properties'] as Record<string, unknown>)) {
			props[k] = convert(v);
		}
		out['properties'] = props;
	}

	// items: single schema or tuple (Gemini supports only single-schema items).
	if (src['items'] !== undefined) {
		out['items'] = convert(Array.isArray(src['items']) ? src['items'][0] : src['items']);
	}

	// oneOf -> anyOf rewrite + recurse.
	if (Array.isArray(src['oneOf'])) {
		out['anyOf'] = src['oneOf'].map(convert);
	} else if (Array.isArray(src['anyOf'])) {
		out['anyOf'] = src['anyOf'].map(convert);
	}

	// Unsupported keywords -- log into description so the LLM still
	// sees the intent. (Gemini's Vertex API also ignores them silently.)
	const dropped: string[] = [];
	for (const k of ['allOf', 'not', 'if', 'then', 'else', 'additionalProperties',
		'patternProperties', 'definitions', '$defs', '$schema'] as const) {
		if (src[k] !== undefined) { dropped.push(k); }
	}
	if (dropped.length > 0 && typeof src['description'] === 'string') {
		out['description'] = `${src['description']}\n(adapter note: stripped unsupported keywords: ${dropped.join(', ')})`;
	}

	return out;
}


function openApiType(t: string): string {
	switch (t) {
		case 'object':  return 'OBJECT';
		case 'string':  return 'STRING';
		case 'integer': return 'INTEGER';
		case 'number':  return 'NUMBER';
		case 'boolean': return 'BOOLEAN';
		case 'array':   return 'ARRAY';
		default:        throw new Error(`gemini-schema-adapter: unknown JSON Schema type '${t}'`);
	}
}


function isPlainObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x);
}
