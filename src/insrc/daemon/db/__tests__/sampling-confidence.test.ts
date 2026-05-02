/**
 * Tests for daemon/db/sampling-confidence.ts (Phase 0.6 of
 * plans/analyzers/data-analyzer-skills.md).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { confidenceFor, sampleSizeFor } from '../sampling-confidence.js';

describe('sampleSizeFor', () => {
	it('mean / percentile uses Cochran z*0.5/ME', () => {
		// 0.95 CI: z=1.96, ME=0.025 -> n = (1.96)^2 * 0.25 / (0.025)^2 = ~1537
		const n = sampleSizeFor('mean', null, 0.95);
		assert.ok(n >= 1500 && n <= 1600, `got ${n}`);
	});

	it('finite population correction reduces the recommended size', () => {
		const inf = sampleSizeFor('mean', null, 0.95);
		const fpc = sampleSizeFor('mean', 100, 0.95);
		assert.ok(fpc < inf);
		assert.ok(fpc <= 100, `must not exceed population size, got ${fpc}`);
	});

	it('normality at 0.95 needs ~200 samples', () => {
		assert.equal(sampleSizeFor('normality', null, 0.95), 200);
	});

	it('correlation at 0.95 needs ~384 samples', () => {
		assert.equal(sampleSizeFor('correlation', null, 0.95), 384);
	});

	it('rejects invalid desiredCI', () => {
		assert.throws(() => sampleSizeFor('mean', null, 0));
		assert.throws(() => sampleSizeFor('mean', null, 1));
		assert.throws(() => sampleSizeFor('mean', null, 1.5));
	});

	it('floors at MIN_SIZE for trivially small populations', () => {
		assert.ok(sampleSizeFor('mean', 5, 0.95) >= 5);
	});
});

describe('confidenceFor', () => {
	it('actualN above 0.95 threshold => high', () => {
		assert.equal(confidenceFor(500, 'correlation', null), 'high');
		assert.equal(confidenceFor(2000, 'mean', null), 'high');
	});

	it('actualN above 0.80 but below 0.95 => medium', () => {
		assert.equal(confidenceFor(50, 'normality', null), 'medium');     // 0.80=30, 0.95=200
		assert.equal(confidenceFor(100, 'correlation', null), 'medium');  // 0.80=30, 0.95=384
	});

	it('actualN below the 0.80 threshold => low', () => {
		assert.equal(confidenceFor(5, 'normality', null), 'low');
		assert.equal(confidenceFor(20, 'correlation', null), 'low');
	});

	it('zero / negative actualN => low', () => {
		assert.equal(confidenceFor(0, 'mean', null), 'low');
		assert.equal(confidenceFor(-1, 'mean', null), 'low');
	});

	it('finite population: actualN equal to population => high', () => {
		// If you sampled the whole population, you have it all.
		assert.equal(confidenceFor(100, 'mean', 100), 'high');
	});
});
