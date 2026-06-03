/**
 * Tests for the JSON-schema output-path walker (P2 of
 * plans/planner-skill-tree.md).
 *
 * The walker produces the list of dotted paths a tree-planner wire may
 * reference. It must:
 *   - emit top-level properties
 *   - recurse into nested objects (`a.b`)
 *   - emit `[*]` for arrays of objects/scalars
 *   - handle `oneOf` / `anyOf` as the union of variants' paths
 *   - cap recursion depth + total path count
 *   - never throw on malformed input
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOutputPaths } from '../output-paths.js';

test('extractOutputPaths: flat object emits top-level properties', () => {
	const paths = extractOutputPaths({
		type: 'object',
		properties: {
			found: { type: 'boolean' },
			count: { type: 'number' },
			label: { type: 'string' },
		},
	});
	assert.deepEqual([...paths].sort(), ['count', 'found', 'label']);
});

test('extractOutputPaths: nested objects produce dotted paths', () => {
	const paths = extractOutputPaths({
		type: 'object',
		properties: {
			meta: {
				type: 'object',
				properties: {
					version: { type: 'number' },
					owner:   { type: 'string' },
				},
			},
		},
	});
	assert.ok(paths.includes('meta'));
	assert.ok(paths.includes('meta.version'));
	assert.ok(paths.includes('meta.owner'));
});

test('extractOutputPaths: arrays of scalars emit `prop` + `prop[*]`', () => {
	const paths = extractOutputPaths({
		type: 'object',
		properties: {
			tags: { type: 'array', items: { type: 'string' } },
		},
	});
	assert.ok(paths.includes('tags'));
	assert.ok(paths.includes('tags[*]'));
});

test('extractOutputPaths: arrays of objects emit `prop`, `prop[*]`, `prop[*].sub`', () => {
	const paths = extractOutputPaths({
		type: 'object',
		properties: {
			fields: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						name: { type: 'string' },
						type: { type: 'string' },
					},
				},
			},
		},
	});
	assert.ok(paths.includes('fields'));
	assert.ok(paths.includes('fields[*]'));
	assert.ok(paths.includes('fields[*].name'));
	assert.ok(paths.includes('fields[*].type'));
});

test('extractOutputPaths: oneOf union -- paths from every variant are admissible', () => {
	const paths = extractOutputPaths({
		type: 'object',
		properties: { found: { type: 'boolean' } },
		oneOf: [
			{
				type: 'object',
				properties: {
					found:     { type: 'boolean', enum: [true] },
					className: { type: 'string' },
					fields:    {
						type: 'array',
						items: { type: 'object', properties: { name: { type: 'string' } } },
					},
				},
			},
			{
				type: 'object',
				properties: {
					found: { type: 'boolean', enum: [false] },
					reason: { type: 'string' },
				},
			},
		],
	});
	// Properties from BOTH oneOf arms should be present.
	assert.ok(paths.includes('className'));
	assert.ok(paths.includes('fields'));
	assert.ok(paths.includes('fields[*].name'));
	assert.ok(paths.includes('reason'));
	assert.ok(paths.includes('found'));
});

test('extractOutputPaths: extract-fields-shaped schema emits the canonical wire paths', () => {
	const paths = extractOutputPaths({
		type: 'object',
		properties: { found: { type: 'boolean' } },
		oneOf: [
			{
				type: 'object',
				properties: {
					found:     { type: 'boolean' },
					entityId:  { type: 'string' },
					className: { type: 'string' },
					path:      { type: 'string' },
					line:      { type: 'number' },
					fields: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								name:       { type: 'string' },
								type:       { type: 'string' },
								declaredAt: {
									type: 'object',
									properties: { path: { type: 'string' }, line: { type: 'number' } },
								},
							},
						},
					},
				},
			},
		],
	});
	assert.ok(paths.includes('fields'));
	assert.ok(paths.includes('fields[*]'));
	assert.ok(paths.includes('fields[*].name'));
	assert.ok(paths.includes('fields[*].type'));
	assert.ok(paths.includes('fields[*].declaredAt'));
	assert.ok(paths.includes('fields[*].declaredAt.path'));
	assert.ok(paths.includes('fields[*].declaredAt.line'));
});

test('extractOutputPaths: scalar schema yields empty set', () => {
	assert.deepEqual(extractOutputPaths({ type: 'string' }), []);
	assert.deepEqual(extractOutputPaths({ type: 'number' }), []);
	assert.deepEqual(extractOutputPaths({ type: 'boolean' }), []);
});

test('extractOutputPaths: malformed input returns empty without throwing', () => {
	assert.doesNotThrow(() => extractOutputPaths(null));
	assert.doesNotThrow(() => extractOutputPaths(undefined));
	assert.doesNotThrow(() => extractOutputPaths(42));
	assert.doesNotThrow(() => extractOutputPaths([]));
	assert.deepEqual(extractOutputPaths(null),     []);
	assert.deepEqual(extractOutputPaths(undefined), []);
});

test('extractOutputPaths: caps recursion at depth 6 (no runaway on cyclic-shaped schemas)', () => {
	// Build a 10-level deep object schema. The walker should bail by depth 6.
	function deep(depth: number): unknown {
		if (depth === 0) return { type: 'string' };
		return { type: 'object', properties: { next: deep(depth - 1) } };
	}
	const paths = extractOutputPaths(deep(10));
	// Without the cap, we'd see "next.next.next.next.next.next.next.next.next.next"
	// (10 nexts). The cap stops well before that.
	const maxNests = Math.max(...paths.map(p => p.split('.').length));
	assert.ok(maxNests <= 7, `paths went deeper than 6 nests: max=${maxNests}`);
});
