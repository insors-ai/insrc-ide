/**
 * Phase 7.3 unit tests for the bench harness.
 *
 * Pure-JS / pure-math: no LMDB or Lance touched. Verifies percentile
 * calc, baseline loading + diffing, regression-threshold logic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	REGRESSION_THRESHOLD,
	diffAgainstBaseline,
	loadBaseline,
	percentile,
	saveBaseline,
	type RunResult,
} from '../harness.js';

let dir: string;

test.beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'insrc-bench-harness-'));
});
test.afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Percentile math
// ---------------------------------------------------------------------------

test('percentile: empty input returns 0', () => {
	assert.equal(percentile([], 0.5), 0);
});

test('percentile: single sample returns that value', () => {
	assert.equal(percentile([42], 0.5), 42);
	assert.equal(percentile([42], 0.99), 42);
});

test('percentile: median of [1..9] is 5', () => {
	assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9], 0.5), 5);
});

test('percentile: extremes', () => {
	const xs = [1, 2, 3, 4, 5];
	assert.equal(percentile(xs, 0),    1);
	assert.equal(percentile(xs, 1),    5);
});

test('percentile: linear interpolation between adjacent samples', () => {
	// p99 of [1, 2] interpolates: idx = (2-1)*0.99 = 0.99
	// -> 1*0.01 + 2*0.99 = 1.99
	assert.equal(Math.round(percentile([1, 2], 0.99) * 100) / 100, 1.99);
});

// ---------------------------------------------------------------------------
// Baseline I/O
// ---------------------------------------------------------------------------

test('loadBaseline: missing file returns null', () => {
	assert.equal(loadBaseline(join(dir, 'absent.json')), null);
});

test('loadBaseline + saveBaseline round-trip a RunResult', () => {
	const path = join(dir, 'baseline.json');
	const r: RunResult = {
		tier:        'smoke',
		timestamp:   '2026-05-06T00:00:00.000Z',
		nodeVersion: 'v22.0.0',
		peakRssMb:   123,
		fileSizesMb: { 'lmdb.graph': 50 },
		ops: [
			{ name: 'op1', count: 100, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4 },
		],
	};
	saveBaseline(path, r);
	const loaded = loadBaseline(path);
	assert.deepEqual(loaded, r);
});

// ---------------------------------------------------------------------------
// Baseline diff
// ---------------------------------------------------------------------------

const BASE: RunResult = {
	tier:        'smoke',
	timestamp:   '2026-01-01T00:00:00.000Z',
	nodeVersion: 'v22.0.0',
	peakRssMb:   100,
	fileSizesMb: { 'lmdb.graph': 50, 'lance.entity_vec': 30 },
	ops: [
		{ name: 'a', count: 1, p50_ms: 1, p95_ms: 1.5, p99_ms: 2, max_ms: 2.5 },
		{ name: 'b', count: 1, p50_ms: 5, p95_ms: 7,   p99_ms: 10, max_ms: 12 },
	],
};

function withOps(ops: RunResult['ops'], fileSizes: RunResult['fileSizesMb'] = BASE.fileSizesMb): RunResult {
	return {
		tier:        'smoke',
		timestamp:   '2026-05-06T00:00:00.000Z',
		nodeVersion: 'v22.0.0',
		peakRssMb:   100,
		fileSizesMb: fileSizes,
		ops,
	};
}

test('diffAgainstBaseline: null baseline = no regression, all ops new', () => {
	const cur = withOps([{ name: 'a', count: 1, p50_ms: 1, p95_ms: 1, p99_ms: 1, max_ms: 1 }]);
	const d = diffAgainstBaseline(cur, null);
	assert.equal(d.regressed, false);
	assert.deepEqual(d.newOps, ['a']);
	assert.deepEqual(d.opDeltas, []);
});

test('diffAgainstBaseline: equal current = no regression', () => {
	const d = diffAgainstBaseline(BASE, BASE);
	assert.equal(d.regressed, false);
	for (const od of d.opDeltas) assert.equal(od.regressed, false);
});

test('diffAgainstBaseline: p99 within threshold = no regression', () => {
	// p99 grows by 25% (within 30% threshold)
	const cur = withOps([
		{ name: 'a', count: 1, p50_ms: 1, p95_ms: 1.5, p99_ms: 2.5, max_ms: 3 },
		{ name: 'b', count: 1, p50_ms: 5, p95_ms: 7,   p99_ms: 10, max_ms: 12 },
	]);
	const d = diffAgainstBaseline(cur, BASE);
	assert.equal(d.regressed, false);
});

test('diffAgainstBaseline: p99 over threshold = regression', () => {
	// p99 grows from 2 to 3 = 1.5x, over the 1.30 threshold
	const cur = withOps([
		{ name: 'a', count: 1, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4 },
		{ name: 'b', count: 1, p50_ms: 5, p95_ms: 7, p99_ms: 10, max_ms: 12 },
	]);
	const d = diffAgainstBaseline(cur, BASE);
	assert.equal(d.regressed, true);
	const aDelta = d.opDeltas.find(o => o.name === 'a')!;
	assert.equal(aDelta.regressed, true);
	assert.ok(aDelta.ratio > REGRESSION_THRESHOLD);
});

test('diffAgainstBaseline: file-size over threshold = regression', () => {
	const cur = withOps(BASE.ops, { 'lmdb.graph': 100, 'lance.entity_vec': 30 });
	// 100/50 = 2x > 1.3
	const d = diffAgainstBaseline(cur, BASE);
	assert.equal(d.regressed, true);
	const fd = d.fileDeltas.find(f => f.label === 'lmdb.graph')!;
	assert.equal(fd.regressed, true);
});

test('diffAgainstBaseline: new op in current = noted but not regression', () => {
	const cur = withOps([
		...BASE.ops,
		{ name: 'c', count: 1, p50_ms: 1, p95_ms: 1, p99_ms: 1, max_ms: 1 },
	]);
	const d = diffAgainstBaseline(cur, BASE);
	assert.equal(d.regressed, false);
	assert.deepEqual(d.newOps, ['c']);
});

test('diffAgainstBaseline: missing op (was in baseline, gone now) = noted', () => {
	const cur = withOps([BASE.ops[0]!]);
	const d = diffAgainstBaseline(cur, BASE);
	assert.deepEqual(d.missingOps, ['b']);
});

test('REGRESSION_THRESHOLD is 1.30 (30%) per design doc', () => {
	assert.equal(REGRESSION_THRESHOLD, 1.30);
});
