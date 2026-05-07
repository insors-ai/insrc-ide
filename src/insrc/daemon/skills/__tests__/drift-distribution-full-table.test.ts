/**
 * Tests for `data.drift.distribution.{rdbms,file}` full-table mode
 * (Phase 5f.1 Track-C swap). Exercises the four-call protocol:
 *   1. parallel bounds aggregates per window (min/max/count_non_null)
 *   2. parallel bucket count_where aggregates per window (N specs each)
 * The skill builds shared bucket edges from joint min/max, counts
 * each window's rows per bucket server-side, then runs the JS
 * divergence math client-side on the exact bucket counts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../index.js';
import { runSkillIsolated, type FakeToolMap } from '../test-harness.js';
import type { DriftDistributionOutput } from '../built-ins/data.drift.distribution.algo.js';

registerAllSkills();

// Both windows on the same numeric column. Window A spans [10..50],
// Window B spans [10..50] too (joint range = [10, 50]). Buckets are
// 4 evenly-spaced over that range; counts per bucket are constructed
// to land in the 'identical' verdict region (normalizedJs < 0.05).
const PLACEHOLDER_SAMPLE = {
	content: '_unused_',
	isError: false,
	data: { target: 'placeholder', columns: [], rows: [], truncated: false, metadata: { samplingMethod: 'first' } },
} as const;

test('drift.distribution.rdbms full-table: identical distributions across windows', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_aggregate: (call) => {
			const input = call.input as { aggregations: { column: string; function: string }[] };
			const isBounds = input.aggregations.some(s => s.function === 'min');
			if (isBounds) {
				return {
					content: 'bounds',
					isError: false,
					data: {
						target: 'public.events',
						values: {
							'amount__count_non_null': 100,
							'amount__min': 10,
							'amount__max': 50,
						},
					},
				};
			}
			// bucket aggregates -- equal counts per bucket across both
			// windows produce normalizedJs = 0 -> verdict 'identical'.
			return {
				content: 'buckets',
				isError: false,
				data: {
					target: 'public.events',
					values: {
						'bucket_0__count_where_amount___amount_': 25,
						'bucket_1__count_where_amount___amount_': 25,
						'bucket_2__count_where_amount___amount_': 25,
						'bucket_3__count_where_amount___amount_': 25,
					},
				},
			};
		},
	};

	const { result } = await runSkillIsolated<unknown, DriftDistributionOutput>(
		'data.drift.distribution.rdbms',
		{
			connectionId: 'pg',
			target: 'public.events',
			column: 'amount',
			windowAWhere: [{ column: 'year', op: '=', value: 2025 }],
			windowBWhere: [{ column: 'year', op: '=', value: 2026 }],
			bins: 4,
			mode: 'full-table',
		},
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.windowA.sampleSize, 100);
	assert.equal(result.value.windowB.sampleSize, 100);
	assert.equal(result.value.sharedRange.lower, 10);
	assert.equal(result.value.sharedRange.upper, 50);
	assert.equal(result.value.bins, 4);
	assert.equal(result.value.verdict, 'identical');
	// JS over identical bucket counts is exactly 0
	assert.equal(result.value.jsDivergence, 0);
	assert.equal(result.value.normalizedJs, 0);
});

test('drift.distribution.rdbms full-table: divergent distributions land verdict=divergent', async () => {
	// Window A is concentrated in the lower buckets, B in the upper.
	const fakeTools: FakeToolMap = {
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_aggregate: (call) => {
			const input = call.input as { where: { value: unknown }[]; aggregations: { column: string; function: string }[] };
			const isBounds = input.aggregations.some(s => s.function === 'min');
			const window = (input.where[0]?.value === 2025) ? 'A' : 'B';
			if (isBounds) {
				return {
					content: 'bounds',
					isError: false,
					data: {
						target: 'public.events',
						values: {
							'amount__count_non_null': 100,
							'amount__min': 0,
							'amount__max': 100,
						},
					},
				};
			}
			const counts = window === 'A'
				? { 'bucket_0__count_where_amount___amount_': 90, 'bucket_1__count_where_amount___amount_': 10, 'bucket_2__count_where_amount___amount_':  0, 'bucket_3__count_where_amount___amount_':  0 }
				: { 'bucket_0__count_where_amount___amount_':  0, 'bucket_1__count_where_amount___amount_':  0, 'bucket_2__count_where_amount___amount_': 10, 'bucket_3__count_where_amount___amount_': 90 };
			return { content: 'buckets', isError: false, data: { target: 'public.events', values: counts } };
		},
	};

	const { result } = await runSkillIsolated<unknown, DriftDistributionOutput>(
		'data.drift.distribution.rdbms',
		{
			connectionId: 'pg',
			target: 'public.events',
			column: 'amount',
			windowAWhere: [{ column: 'year', op: '=', value: 2025 }],
			windowBWhere: [{ column: 'year', op: '=', value: 2026 }],
			bins: 4,
			mode: 'full-table',
		},
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.verdict, 'divergent');
	assert.ok((result.value.normalizedJs ?? 0) >= 0.5, `expected normalizedJs >= 0.5, got ${result.value.normalizedJs}`);
	assert.match(result.value.interpretation, /full-table/);
});

test('drift.distribution.rdbms full-table: empty window degrades confidence to medium', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_aggregate: (call) => {
			const input = call.input as { where: { value: unknown }[]; aggregations: { column: string; function: string }[] };
			const isBounds = input.aggregations.some(s => s.function === 'min');
			const window = (input.where[0]?.value === 2025) ? 'A' : 'B';
			if (isBounds) {
				if (window === 'A') {
					return {
						content: 'bounds',
						isError: false,
						data: {
							target: 'public.events',
							values: { 'amount__count_non_null': 100, 'amount__min': 10, 'amount__max': 50 },
						},
					};
				}
				return {
					content: 'bounds',
					isError: false,
					data: {
						target: 'public.events',
						values: { 'amount__count_non_null': 0, 'amount__min': null, 'amount__max': null },
					},
				};
			}
			return { content: 'should not reach', isError: true };
		},
	};

	const { result } = await runSkillIsolated<unknown, DriftDistributionOutput>(
		'data.drift.distribution.rdbms',
		{
			connectionId: 'pg',
			target: 'public.events',
			column: 'amount',
			windowAWhere: [{ column: 'year', op: '=', value: 2025 }],
			windowBWhere: [{ column: 'year', op: '=', value: 2026 }],
			bins: 4,
			mode: 'full-table',
		},
		{ fakeTools },
	);

	assert.equal(result.confidence, 'medium');
	assert.ok((result.notes ?? []).some(n => n.includes('at least one window has no rows')));
	assert.equal(result.value.source, 'full-table');
});

test('drift.distribution.rdbms full-table: bounds tool error -> low confidence', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_aggregate: { content: 'simulated dialect error', isError: true },
	};

	const { result } = await runSkillIsolated<unknown, DriftDistributionOutput>(
		'data.drift.distribution.rdbms',
		{
			connectionId: 'pg',
			target: 'public.events',
			column: 'amount',
			windowAWhere: [{ column: 'year', op: '=', value: 2025 }],
			windowBWhere: [{ column: 'year', op: '=', value: 2026 }],
			bins: 4,
			mode: 'full-table',
		},
		{ fakeTools },
	);

	assert.equal(result.confidence, 'low');
	assert.equal(result.value.source, 'full-table');
	assert.ok((result.notes ?? []).some(n => n.includes('db_sql_aggregate')));
});

test('drift.distribution.file full-table: forwards path for xlsx sheet', async () => {
	const capturedPaths: (unknown)[] = [];
	const fakeTools: FakeToolMap = {
		db_file_sample: PLACEHOLDER_SAMPLE,
		db_file_aggregate: (call) => {
			const input = call.input as Record<string, unknown>;
			capturedPaths.push(input['path']);
			const aggs = input['aggregations'] as { function: string }[];
			const isBounds = aggs.some(s => s.function === 'min');
			if (isBounds) {
				return {
					content: 'bounds',
					isError: false,
					data: {
						target: 'orders.xlsx',
						values: { 'amount__count_non_null': 100, 'amount__min': 10, 'amount__max': 50 },
					},
				};
			}
			return {
				content: 'buckets',
				isError: false,
				data: {
					target: 'orders.xlsx',
					values: {
						'bucket_0__count_where_amount___amount_': 25,
						'bucket_1__count_where_amount___amount_': 25,
						'bucket_2__count_where_amount___amount_': 25,
						'bucket_3__count_where_amount___amount_': 25,
					},
				},
			};
		},
	};

	const { result } = await runSkillIsolated<unknown, DriftDistributionOutput>(
		'data.drift.distribution.file',
		{
			connectionId: 'csv',
			column: 'amount',
			windowAWhere: [{ column: 'year', op: '=', value: 2025 }],
			windowBWhere: [{ column: 'year', op: '=', value: 2026 }],
			target: 'Sheet1',
			bins: 4,
			mode: 'full-table',
		},
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.source, 'full-table');
	// All four aggregate calls (2 bounds + 2 buckets) should pass `path: 'Sheet1'`.
	assert.equal(capturedPaths.length, 4);
	for (const p of capturedPaths) {
		assert.equal(p, 'Sheet1');
	}
});
