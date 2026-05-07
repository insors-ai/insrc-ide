/**
 * Tests for `data.timeseries.stationarity.rdbms` full-table mode
 * (Phase 5g.3 Track-C). Skill delegates to db_sql_dickey_fuller and
 * compares the resulting t-statistic to MacKinnon asymptotic critical
 * values.
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

interface StatOut {
	source: 'sample' | 'full-table';
	tStatistic: number | null;
	beta: number | null;
	betaStdErr: number | null;
	criticalValue1pct: number;
	criticalValue5pct: number;
	criticalValue10pct: number;
	rejectsAtLevel: '1%' | '5%' | '10%' | 'none';
	verdict: 'stationary' | 'non-stationary' | 'inconclusive';
	count: number | null;
	interpretation: string;
}

test('stationarity.rdbms full-table: stationary at 1% level', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_aggregate: {
			content: 'agg',
			isError: false,
			data: { target: 'public.events', values: { 'val__count_non_null': 5000 } },
		},
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_dickey_fuller: {
			content: 'df',
			isError: false,
			data: {
				target: 'public.events',
				valueColumn: 'val',
				timestampColumn: 'ts',
				n: 5000,
				beta: -0.7,
				seBeta: 0.1,
				tStat: -7.0,  // very strongly negative; rejects at 1% (cv=-3.43)
				sxx: 100, ssRes: 50,
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, StatOut>(
		'data.timeseries.stationarity.rdbms',
		{ connectionId: 'pg', target: 'public.events', timestampColumn: 'ts', valueColumn: 'val', mode: 'full-table' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.tStatistic, -7.0);
	assert.equal(result.value.criticalValue1pct, -3.43);  // asymptotic CV
	assert.equal(result.value.rejectsAtLevel, '1%');
	assert.equal(result.value.verdict, 'stationary');
	assert.match(result.value.interpretation, /full-table/);
});

test('stationarity.rdbms full-table: non-stationary when t-stat > -2.57', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_aggregate: {
			content: 'agg',
			isError: false,
			data: { target: 'public.events', values: { 'val__count_non_null': 5000 } },
		},
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_dickey_fuller: {
			content: 'df',
			isError: false,
			data: {
				target: 'public.events',
				valueColumn: 'val',
				timestampColumn: 'ts',
				n: 5000,
				beta: -0.05,
				seBeta: 0.05,
				tStat: -1.0,  // not negative enough to reject at 10% (cv=-2.57)
				sxx: 100, ssRes: 4900,
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, StatOut>(
		'data.timeseries.stationarity.rdbms',
		{ connectionId: 'pg', target: 'public.events', timestampColumn: 'ts', valueColumn: 'val', mode: 'full-table' },
		{ fakeTools },
	);

	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.rejectsAtLevel, 'none');
	assert.equal(result.value.verdict, 'non-stationary');
});

test('stationarity.rdbms full-table: undefined t-stat yields medium confidence', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_aggregate: {
			content: 'agg',
			isError: false,
			data: { target: 'public.events', values: { 'val__count_non_null': 5000 } },
		},
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_dickey_fuller: {
			content: 'df',
			isError: false,
			data: {
				target: 'public.events',
				valueColumn: 'val',
				timestampColumn: 'ts',
				n: 5000,
				beta: null,
				seBeta: null,
				tStat: null,
				sxx: 0, ssRes: null,
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, StatOut>(
		'data.timeseries.stationarity.rdbms',
		{ connectionId: 'pg', target: 'public.events', timestampColumn: 'ts', valueColumn: 'val', mode: 'full-table' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'medium');
	assert.equal(result.value.source, 'full-table');
	assert.match(result.value.interpretation, /undefined|deterministic/i);
});
