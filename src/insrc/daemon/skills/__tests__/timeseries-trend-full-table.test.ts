/**
 * Tests for `data.timeseries.trend.rdbms` full-table mode (Phase 5g.1
 * Track-C). The skill delegates to `db_sql_temporal_trend` (server-
 * side OLS) and combines its output with min/max valueColumn from
 * `db_sql_aggregate` to derive the direction-band heuristic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../index.js';
import { runSkillIsolated, type FakeToolMap } from '../test-harness.js';

registerAllSkills();

const PLACEHOLDER_SAMPLE = {
	content: '_unused_',
	isError: false,
	data: { target: 'placeholder', columns: [], rows: [], truncated: false, metadata: { samplingMethod: 'first' } },
} as const;

interface TrendOut {
	source: 'sample' | 'full-table';
	slope: number | null;
	slopePerDay: number | null;
	intercept: number | null;
	rSquared: number | null;
	direction: 'increasing' | 'decreasing' | 'flat';
	strength: 'strong' | 'moderate' | 'weak' | 'inconclusive';
	count: number | null;
	valueMean: number | null;
	interpretation: string;
}

test('timeseries.trend.rdbms full-table: strong increasing trend', async () => {
	// Server returns slope = 1e-6 / sec (i.e. ~0.0864 per day)
	// over 100 days, with R²=0.95.
	const t0 = 1735689600;
	const tEnd = t0 + 100 * 86400;
	const fakeTools: FakeToolMap = {
		db_sql_aggregate: {
			content: 'agg',
			isError: false,
			data: {
				target: 'public.metrics',
				values: {
					'val__count_non_null': 1000,
					'val__avg':            5.0,
					'val__min':            0.0,
					'val__max':           10.0,
				},
			},
		},
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_temporal_trend: {
			content: 'trend',
			isError: false,
			data: {
				target: 'public.metrics',
				timestampColumn: 'ts',
				valueColumn: 'val',
				n: 1000,
				slope: 1e-6,
				slopePerDay: 1e-6 * 86400,
				intercept: 0,
				r2: 0.95,
				minTimestampEpoch: t0,
				maxTimestampEpoch: tEnd,
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, TrendOut>(
		'data.timeseries.trend.rdbms',
		{
			connectionId: 'pg',
			target: 'public.metrics',
			timestampColumn: 'ts',
			valueColumn: 'val',
			mode: 'full-table',
		},
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.source, 'full-table');
	// slope is reported per-millisecond; substrate returned per-second.
	// Conversion: slope_ms = 1e-6 / 1000 = 1e-9.
	assert.ok(Math.abs(result.value.slope! - 1e-9) < 1e-15, `slope_ms=${result.value.slope}`);
	assert.equal(result.value.slopePerDay, 1e-6 * 86400);
	assert.equal(result.value.rSquared, 0.95);
	// expectedYChange = |1e-6 * 100*86400| = 8.64; flatThreshold = 10*0.05 = 0.5; not flat.
	assert.equal(result.value.direction, 'increasing');
	assert.equal(result.value.strength, 'strong');
	assert.equal(result.value.count, 1000);
	assert.equal(result.value.valueMean, 5.0);
	assert.match(result.value.interpretation, /full-table/);
});

test('timeseries.trend.rdbms full-table: flat trend when slope * tSpan < 5% of value range', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_aggregate: {
			content: 'agg',
			isError: false,
			data: {
				target: 'public.metrics',
				values: {
					'val__count_non_null': 1000,
					'val__avg':              5.0,
					'val__min':              0.0,
					'val__max':            100.0, // wide value range
				},
			},
		},
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_temporal_trend: {
			content: 'trend',
			isError: false,
			data: {
				target: 'public.metrics',
				timestampColumn: 'ts',
				valueColumn: 'val',
				n: 1000,
				// slope = 1e-9 / sec over 100 days = ~0.00864 per day total
				// expected change over 100 days: 1e-9 * 8_640_000 = 0.00864
				// flat threshold: 100 * 0.05 = 5
				// expectedYChange < flatThreshold -> flat
				slope: 1e-9,
				slopePerDay: 1e-9 * 86400,
				intercept: 5,
				r2: 0.01,
				minTimestampEpoch: 0,
				maxTimestampEpoch: 100 * 86400,
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, TrendOut>(
		'data.timeseries.trend.rdbms',
		{ connectionId: 'pg', target: 'public.metrics', timestampColumn: 'ts', valueColumn: 'val', mode: 'full-table' },
		{ fakeTools },
	);

	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.direction, 'flat');
	assert.equal(result.value.strength, 'weak');
});

test('timeseries.trend.rdbms full-table: undefined slope (constant timestamps) yields medium confidence', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_aggregate: {
			content: 'agg',
			isError: false,
			data: {
				target: 'public.metrics',
				values: { 'val__count_non_null': 100, 'val__avg': 5, 'val__min': 0, 'val__max': 10 },
			},
		},
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_temporal_trend: {
			content: 'trend',
			isError: false,
			data: {
				target: 'public.metrics',
				timestampColumn: 'ts', valueColumn: 'val',
				n: 100,
				slope: null,  // X variance is zero
				slopePerDay: null,
				intercept: null,
				r2: null,
				minTimestampEpoch: 1735689600,
				maxTimestampEpoch: 1735689600,
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, TrendOut>(
		'data.timeseries.trend.rdbms',
		{ connectionId: 'pg', target: 'public.metrics', timestampColumn: 'ts', valueColumn: 'val', mode: 'full-table' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'medium');
	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.slope, null);
	assert.match(result.value.interpretation, /undefined|cannot compute slope/);
});

test('timeseries.trend.rdbms full-table: tool error -> low confidence', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_aggregate: { content: 'agg ok', isError: false, data: { target: 't', values: {} } },
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_temporal_trend: { content: 'simulated dialect error', isError: true },
	};

	const { result } = await runSkillIsolated<unknown, TrendOut>(
		'data.timeseries.trend.rdbms',
		{ connectionId: 'pg', target: 'public.metrics', timestampColumn: 'ts', valueColumn: 'val', mode: 'full-table' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'low');
	assert.equal(result.value.source, 'full-table');
	assert.ok((result.notes ?? []).some(n => n.includes('db_sql_temporal_trend')));
});
