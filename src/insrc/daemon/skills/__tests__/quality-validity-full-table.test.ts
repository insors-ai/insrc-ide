/**
 * Tests for `data.quality.validity.{rdbms,file}` full-table mode
 * (Phase 5d.3 Gap 1 of plans/analyzers/data-analyzer-skills.md).
 *
 * The smoke gate's existing fixture exercises the default sample
 * mode so back-compat is covered there. This test exercises the
 * opt-in `mode: 'full-table'` path: the skill issues a single
 * `db_*_aggregate` call with three aggregations
 * (count + count_non_null + count_where(regex)) and the algo
 * derives matchCount / mismatchCount / matchRate from the flat
 * values map.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../index.js';
import { runSkillIsolated, type FakeToolMap } from '../test-harness.js';
import type { QualityValidityOutput } from '../built-ins/data.quality.validity.algo.js';

registerAllSkills();

// The skill's precondition requires both db_sql_sample (for mode:sample)
// and db_sql_aggregate (for mode:full-table); the harness needs both
// keys registered for feasibility to pass even when only one will fire.
const PLACEHOLDER_SAMPLE = {
	content: '_unused_',
	isError: false,
	data: { target: 'placeholder', columns: [], rows: [], truncated: false, metadata: { samplingMethod: 'first' } },
} as const;

test('validity.rdbms full-table mode reads count_where(regex) + count_non_null + count', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_aggregate: {
			content: 'agg',
			isError: false,
			data: {
				target: 'public.users',
				values: {
					'email__count':                       1000,  // total rows
					'email__count_non_null':               950,  // non-null
					'email__count_where_email_regex':      900,  // matches the regex
				},
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, QualityValidityOutput>(
		'data.quality.validity.rdbms',
		{
			connectionId: 'pg',
			target: 'public.users',
			column: 'email',
			pattern: '^.+@.+$',
			mode: 'full-table',
		},
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.totalRows, 1000);
	assert.equal(result.value.nonNullCount, 950);
	assert.equal(result.value.matchCount, 900);
	assert.equal(result.value.mismatchCount, 50);  // 950 - 900
	assert.equal(result.value.matchRate, 900 / 950);
	assert.equal(result.value.score,     900 / 950);
	assert.equal(result.value.sampleSize, 0);
	assert.deepEqual(result.value.examples, { matched: [], mismatched: [] });
});

test('validity.rdbms full-table mode handles all-null column (matchRate=null)', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_aggregate: {
			content: 'agg',
			isError: false,
			data: {
				target: 'public.users',
				values: {
					'email__count':                  1000,
					'email__count_non_null':            0,
					'email__count_where_email_regex':   0,
				},
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, QualityValidityOutput>(
		'data.quality.validity.rdbms',
		{
			connectionId: 'pg',
			target: 'public.users',
			column: 'email',
			pattern: '^.+@.+$',
			mode: 'full-table',
		},
		{ fakeTools },
	);

	// Empty non-null population: matchRate is null but the call
	// still succeeded; medium confidence per the wrapper's ladder.
	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.nonNullCount, 0);
	assert.equal(result.value.matchRate, null);
	assert.equal(result.value.matchCount, 0);
	assert.equal(result.value.mismatchCount, 0);
	assert.equal(result.confidence, 'medium');
});

test('validity.rdbms full-table mode surfaces aggregate tool errors as low-confidence', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_aggregate: {
			content: 'simulated dialect error: regex not supported',
			isError: true,
		},
	};

	const { result } = await runSkillIsolated<unknown, QualityValidityOutput>(
		'data.quality.validity.rdbms',
		{
			connectionId: 'pg',
			target: 'public.users',
			column: 'email',
			pattern: '^.+@.+$',
			mode: 'full-table',
		},
		{ fakeTools },
	);

	assert.equal(result.confidence, 'low');
	assert.equal(result.value.source, 'full-table');
	assert.ok((result.notes ?? []).some(n => n.includes('db_sql_aggregate error')));
});

test('validity.rdbms default mode (sample) still works and reports source=sample', async () => {
	// Back-compat check: explicit + implicit sample mode behave identically.
	const fakeTools: FakeToolMap = {
		db_sql_sample: {
			content: 'sample',
			isError: false,
			data: {
				target: 'public.users',
				columns: ['email'],
				rows: [
					{ email: 'a@x.com' },
					{ email: 'b@y.com' },
					{ email: 'not-an-email' },
				],
				truncated: false,
				metadata: { samplingMethod: 'first' },
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, QualityValidityOutput>(
		'data.quality.validity.rdbms',
		{
			connectionId: 'pg',
			target: 'public.users',
			column: 'email',
			pattern: '^.+@.+$',
		},
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.source, 'sample');
	assert.equal(result.value.matchCount, 2);
	assert.equal(result.value.mismatchCount, 1);
	assert.equal(result.value.totalRows, null);
	assert.equal(result.value.nonNullCount, null);
});

test('validity.file full-table mode passes through path for xlsx sheet', async () => {
	let capturedToolInput: Record<string, unknown> | null = null;
	const fakeTools: FakeToolMap = {
		db_file_sample: PLACEHOLDER_SAMPLE,
		db_file_aggregate: (call) => {
			capturedToolInput = call.input as Record<string, unknown>;
			return {
				content: 'agg',
				isError: false,
				data: {
					target: 'orders.xlsx',
					values: {
						'email__count':                       100,
						'email__count_non_null':              100,
						'email__count_where_email_regex':      85,
					},
				},
			};
		},
	};

	const { result } = await runSkillIsolated<unknown, QualityValidityOutput>(
		'data.quality.validity.file',
		{
			connectionId: 'csv',
			column: 'email',
			pattern: '^.+@.+$',
			target: 'Sheet1',
			mode: 'full-table',
		},
		{ fakeTools },
	);

	assert.ok(capturedToolInput !== null, 'tool should have been called');
	// db_file_aggregate uses `path` for the sheet selector (not `target`).
	assert.equal((capturedToolInput as Record<string, unknown>)['path'], 'Sheet1');
	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.matchRate, 0.85);
});
