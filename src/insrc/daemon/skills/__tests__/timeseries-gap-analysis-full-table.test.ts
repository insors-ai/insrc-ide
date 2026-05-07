/**
 * Tests for `data.timeseries.gap-analysis.rdbms` full-table mode
 * (Phase 5g.4 Track-C). Skill delegates to db_sql_temporal_gap_stats
 * (server-side LAG + PERCENTILE_CONT) and converts the seconds-based
 * server output to the skill's milliseconds-based public schema.
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

interface GapOut {
	source: 'sample' | 'full-table';
	count: number | null;
	medianSpacingMs: number | null;
	cadenceHumanReadable: string | null;
	regularityScore: number | null;
	gapCount: number;
	topGaps: { startTimestamp: string; endTimestamp: string; durationMs: number; ratioToMedian: number }[];
	verdict: 'regular' | 'mostly-regular' | 'has-gaps' | 'sparse' | 'inconclusive';
	interpretation: string;
}

test('gap-analysis.rdbms full-table: regular cadence (1h spacing, no gaps)', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_aggregate: PLACEHOLDER_SAMPLE,
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_temporal_gap_stats: {
			content: 'gaps',
			isError: false,
			data: {
				target: 'public.events',
				timestampColumn: 'ts',
				n: 1000,
				medianDeltaSeconds: 3600,  // 1h
				regularityScore: 0.95,
				gapCount: 0,
				topGaps: [],
				minTimestampEpoch: 1735689600,
				maxTimestampEpoch: 1735689600 + 999 * 3600,
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, GapOut>(
		'data.timeseries.gap-analysis.rdbms',
		{ connectionId: 'pg', target: 'public.events', timestampColumn: 'ts', mode: 'full-table' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.medianSpacingMs, 3_600_000); // converted to ms
	assert.equal(result.value.cadenceHumanReadable, '1.0 hours');
	assert.equal(result.value.regularityScore, 0.95);
	assert.equal(result.value.gapCount, 0);
	assert.equal(result.value.verdict, 'regular');
	assert.match(result.value.interpretation, /full-table/);
});

test('gap-analysis.rdbms full-table: has-gaps verdict with top-N gap entries', async () => {
	const t0 = 1735689600;
	const fakeTools: FakeToolMap = {
		db_sql_aggregate: PLACEHOLDER_SAMPLE,
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_temporal_gap_stats: {
			content: 'gaps',
			isError: false,
			data: {
				target: 'public.events',
				timestampColumn: 'ts',
				n: 200,
				medianDeltaSeconds: 60,  // 1 minute cadence
				regularityScore: 0.55,    // → has-gaps
				gapCount: 7,
				topGaps: [
					{ fromEpoch: t0,        toEpoch: t0 + 600,  deltaSeconds: 600,  ratio: 10 },
					{ fromEpoch: t0 + 1200, toEpoch: t0 + 1500, deltaSeconds: 300,  ratio: 5 },
				],
				minTimestampEpoch: t0,
				maxTimestampEpoch: t0 + 200 * 60,
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, GapOut>(
		'data.timeseries.gap-analysis.rdbms',
		{ connectionId: 'pg', target: 'public.events', timestampColumn: 'ts', mode: 'full-table', gapRatio: 3 },
		{ fakeTools },
	);

	assert.equal(result.value.source, 'full-table');
	assert.equal(result.value.verdict, 'has-gaps');
	assert.equal(result.value.gapCount, 7);
	assert.equal(result.value.topGaps.length, 2);
	// The first top gap: 600s = 600_000ms duration; ISO from t0=1735689600
	assert.equal(result.value.topGaps[0]!.durationMs, 600_000);
	assert.equal(result.value.topGaps[0]!.ratioToMedian, 10);
	assert.equal(result.value.topGaps[0]!.startTimestamp, new Date(t0 * 1000).toISOString());
	assert.equal(result.value.topGaps[0]!.endTimestamp,   new Date((t0 + 600) * 1000).toISOString());
});

test('gap-analysis.rdbms full-table: zero / negative median yields medium confidence', async () => {
	const fakeTools: FakeToolMap = {
		db_sql_aggregate: PLACEHOLDER_SAMPLE,
		db_sql_sample: PLACEHOLDER_SAMPLE,
		db_sql_temporal_gap_stats: {
			content: 'gaps',
			isError: false,
			data: {
				target: 'public.events',
				timestampColumn: 'ts',
				n: 100,
				medianDeltaSeconds: 0,  // duplicate timestamps
				regularityScore: null,
				gapCount: 0,
				topGaps: [],
				minTimestampEpoch: 0,
				maxTimestampEpoch: 0,
			},
		},
	};

	const { result } = await runSkillIsolated<unknown, GapOut>(
		'data.timeseries.gap-analysis.rdbms',
		{ connectionId: 'pg', target: 'public.events', timestampColumn: 'ts', mode: 'full-table' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'medium');
	assert.equal(result.value.source, 'full-table');
	assert.match(result.value.interpretation, /undefined|cadence/i);
});
