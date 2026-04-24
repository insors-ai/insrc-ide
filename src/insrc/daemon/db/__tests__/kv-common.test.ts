/**
 * Tests for daemon/db/drivers/kv-common.ts -- namespace whitelist
 * enforcement + shape inference.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ConnectionConfig } from '../../../shared/db-driver.js';
import {
	assertNamespaceAllowed,
	clampSampleShapeLimit,
	clampScanLimit,
	inferShape,
} from '../drivers/kv-common.js';

const BASE_CONFIG: ConnectionConfig = {
	id: 'test',
	kind: 'redis',
	family: 'kv',
	url: 'redis://localhost:6379',
};

function cfg(allow?: readonly string[]): ConnectionConfig {
	if (allow === undefined) { return BASE_CONFIG; }
	return { ...BASE_CONFIG, namespace: { allow } };
}

// ---------------------------------------------------------------------------
// assertNamespaceAllowed
// ---------------------------------------------------------------------------

describe('assertNamespaceAllowed', () => {
	it('is a no-op when no whitelist is configured', () => {
		assert.doesNotThrow(() => assertNamespaceAllowed(cfg(), { pattern: 'anything:*', limit: 10 }));
	});

	it('accepts a prefix inside the whitelist', () => {
		assert.doesNotThrow(() => assertNamespaceAllowed(
			cfg(['cache:*', 'session:*']),
			{ prefix: 'cache:user:42', limit: 10 },
		));
	});

	it('accepts a pattern whose literal stem starts with an allowed prefix', () => {
		assert.doesNotThrow(() => assertNamespaceAllowed(
			cfg(['cache:', 'session:']),
			{ pattern: 'cache:user:*', limit: 10 },
		));
	});

	it('rejects a pattern outside the whitelist', () => {
		assert.throws(
			() => assertNamespaceAllowed(
				cfg(['cache:*']),
				{ pattern: 'auth:tokens:*', limit: 10 },
			),
			/outside the namespace whitelist/,
		);
	});

	it('rejects a prefix outside the whitelist', () => {
		assert.throws(
			() => assertNamespaceAllowed(
				cfg(['cache:']),
				{ prefix: 'session:', limit: 10 },
			),
			/outside the namespace whitelist/,
		);
	});

	it('requires a pattern or prefix when a whitelist is configured', () => {
		assert.throws(
			() => assertNamespaceAllowed(cfg(['cache:*']), { limit: 10 }),
			/pattern or prefix is required/,
		);
	});
});

// ---------------------------------------------------------------------------
// clamp helpers
// ---------------------------------------------------------------------------

describe('clamp helpers', () => {
	it('clamps scan limit to [1, 500]', () => {
		assert.equal(clampScanLimit(10_000), 500);
		assert.equal(clampScanLimit(-5), 1);
		assert.equal(clampScanLimit(0), 1);
		assert.equal(clampScanLimit(42), 42);
	});

	it('clamps sample-shape limit to [1, 50]', () => {
		assert.equal(clampSampleShapeLimit(10_000), 50);
		assert.equal(clampSampleShapeLimit(-5), 1);
	});
});

// ---------------------------------------------------------------------------
// inferShape
// ---------------------------------------------------------------------------

describe('inferShape', () => {
	it('reports types + nullability + frequency across a batch', () => {
		const report = inferShape([
			{ name: 'a', age: 10 },
			{ name: 'b', age: null },
			{ name: 'c', age: 20, nick: 'x' },
		]);
		const byPath = new Map(report.fields.map(f => [f.path, f]));
		assert.deepEqual(byPath.get('name')?.types, ['string']);
		assert.equal(byPath.get('name')?.nullable, false);
		assert.equal(byPath.get('name')?.frequency, 1);

		assert.deepEqual([...(byPath.get('age')?.types ?? [])].sort(), ['null', 'number']);
		assert.equal(byPath.get('age')?.nullable, true);

		assert.equal(byPath.get('nick')?.frequency, 1 / 3);
	});

	it('collapses arrays onto the []-suffixed path', () => {
		const report = inferShape([
			{ tags: ['a', 'b'] },
			{ tags: ['c'] },
		]);
		const byPath = new Map(report.fields.map(f => [f.path, f]));
		assert.ok(byPath.has('tags.[]'));
		assert.deepEqual(byPath.get('tags.[]')?.types, ['string']);
	});

	it('recognises binary values via Uint8Array', () => {
		const report = inferShape([{ data: new Uint8Array([1, 2, 3]) }]);
		const byPath = new Map(report.fields.map(f => [f.path, f]));
		assert.deepEqual(byPath.get('data')?.types, ['binary']);
	});
});
