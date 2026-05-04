/**
 * Tests for the extended `data.quality.scorecard.rdbms` composite
 * (Track B: folds conformity + consistency in alongside the existing
 * completeness + uniqueness + validity dimensions).
 *
 * The smoke gate's existing fixture exercises the base path
 * (completeness + uniqueness only) so back-compat is covered there.
 * This test exercises the extended path: validity + conformity per-
 * column, consistency cross-column, and the resulting weight profile
 * + per-column composite + top-issues + consistency block.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../index.js';
import { runSkillIsolated, type FakeToolMap } from '../test-harness.js';

registerAllSkills();

const target = 'public.orders';
const columns = [
	{ name: 'id',          type: 'bigint',        nullable: false },
	{ name: 'user_id',     type: 'bigint',        nullable: false },
	{ name: 'phone',       type: 'text',          nullable: true  },
	{ name: 'shipped_at',  type: 'timestamp',     nullable: true  },
	{ name: 'received_at', type: 'timestamp',     nullable: true  },
];

// One reusable describe + aggregate response. The aggregate keys cover
// every column-aggregate the per-column atomics ask for.
const fakeTools: FakeToolMap = {
	db_sql_describe: {
		content: 'desc',
		isError: false,
		data: { target, columns, source: 'introspect' },
	},
	db_sql_aggregate: {
		content: 'agg',
		isError: false,
		data: {
			target,
			values: {
				'*__count':                   1000,
				'id__count_non_null':         1000,
				'id__distinct_count':         1000,
				'user_id__count_non_null':     995,
				'user_id__distinct_count':     180,
				'phone__count_non_null':       950,
				'phone__distinct_count':       940,
				'shipped_at__count_non_null':  720,
				'shipped_at__distinct_count':  700,
				'received_at__count_non_null': 700,
				'received_at__distinct_count': 690,
			},
		},
	},
	// Validity samples 50 rows; consistency samples 50 rows; conformity
	// samples 50 rows. We give a single canned sample that satisfies
	// the patterns / rules / formats we'll wire below. Same response
	// goes to every db_sql_sample call in this fixture.
	db_sql_sample: {
		content: 'sample',
		isError: false,
		data: {
			target,
			columns: ['id', 'user_id', 'phone', 'shipped_at', 'received_at'],
			rows: Array.from({ length: 50 }, (_, i) => ({
				id: i + 1,
				user_id: 100 + (i % 25),
				phone: `+1${(2125550000 + i).toString()}`,
				shipped_at: new Date(2026, 4, 1 + (i % 10)).toISOString(),
				received_at: new Date(2026, 4, 2 + (i % 10)).toISOString(),
			})),
			truncated: false,
			metadata: { samplingMethod: 'first' },
		},
	},
};

test('scorecard composite: validity + conformity + consistency all fold in', async () => {
	const out = await runSkillIsolated('data.quality.scorecard.rdbms', {
		connectionId: 'pg-orders',
		target,
		columns: ['id', 'user_id', 'phone', 'shipped_at', 'received_at'],
		validityPatterns: { phone: '^\\+1\\d{10}$' },     // matches every fake row
		conformityRules: { phone: 'e164-phone' },          // matches catalog
		consistencyRules: [{
			name: 'shipped_before_received',
			leftColumn: 'shipped_at',
			op: '<',
			rightColumn: 'received_at',
		}],
	}, { fakeTools });

	const v = out.result.value as Record<string, unknown>;
	const weights = v['weights'] as Record<string, number>;

	// Weights profile picked = WEIGHTS_VAL_CONF (both validity AND
	// conformity are present). Sums to 1.0 (40+25+17.5+17.5).
	assert.equal(weights['completeness'], 0.4,  'completeness weight when val+conf both present');
	assert.equal(weights['uniqueness'],   0.25, 'uniqueness weight when val+conf both present');
	assert.equal(weights['validity'],     0.175, 'validity weight when val+conf both present');
	assert.equal(weights['conformity'],   0.175, 'conformity weight when val+conf both present');

	// Per-column scorecard now carries the conformity field (back-compat
	// shape: validity + conformity always present, score=null when
	// not exercised for that column).
	const cols = v['columns'] as Array<Record<string, unknown>>;
	const phoneCol = cols.find(c => c['name'] === 'phone');
	assert.ok(phoneCol, 'phone column present in scorecard');

	const phoneValidity   = phoneCol['validity']   as Record<string, unknown>;
	const phoneConformity = phoneCol['conformity'] as Record<string, unknown>;
	assert.notEqual(phoneValidity['score'],   null, 'phone column has a validity score');
	assert.notEqual(phoneConformity['score'], null, 'phone column has a conformity score');
	assert.equal(phoneConformity['format'], 'e164-phone', 'caller-supplied format echoed back');

	// Columns without an opt-in keep null scores for the absent dim.
	const idCol = cols.find(c => c['name'] === 'id')!;
	assert.equal((idCol['validity']   as Record<string, unknown>)['score'], null, 'id column has no validity score');
	assert.equal((idCol['conformity'] as Record<string, unknown>)['score'], null, 'id column has no conformity score');

	// Consistency block populated, NOT 'not-checked'.
	const consistency = v['consistency'] as Record<string, unknown>;
	assert.notEqual(consistency['verdict'], 'not-checked', 'consistency was actually evaluated');
	const rules = consistency['rules'] as Array<Record<string, unknown>>;
	assert.equal(rules.length, 1, 'one consistency rule reported back');
	assert.equal(rules[0]!['name'], 'shipped_before_received');
	// All sample rows satisfy shipped < received -> satisfactionRate=1.
	assert.equal(rules[0]!['satisfactionRate'], 1, 'rule satisfied on every applicable row');
});

test('scorecard composite: no opt-ins keeps base weights (back-compat)', async () => {
	const out = await runSkillIsolated('data.quality.scorecard.rdbms', {
		connectionId: 'pg-orders',
		target,
		columns: ['id', 'user_id', 'phone'],
		// No validityPatterns / conformityRules / consistencyRules.
	}, { fakeTools });

	const v = out.result.value as Record<string, unknown>;
	const weights = v['weights'] as Record<string, number>;
	assert.equal(weights['completeness'], 0.6, 'base completeness weight');
	assert.equal(weights['uniqueness'],   0.4, 'base uniqueness weight');
	assert.equal(weights['validity'],     0,   'validity weight off');
	assert.equal(weights['conformity'],   0,   'conformity weight off');

	// Consistency block present (never null) but verdict = not-checked.
	const consistency = v['consistency'] as Record<string, unknown>;
	assert.equal(consistency['verdict'], 'not-checked');
	assert.deepEqual(consistency['rules'], []);
});
