/**
 * Tests for daemon/db/drivers/rdbms-common.ts -- the shared
 * safety envelope around every RDBMS driver. Verifies:
 *   - identifier quoting + dialect differences
 *   - where compilation (parametrised, validates against known cols)
 *   - full SELECT assembly + DML/DDL denylist
 *   - withTimeout races
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
	MSSQL_DIALECT,
	MYSQL_DIALECT,
	ORACLE_DIALECT,
	POSTGRES_DIALECT,
	SQLITE_DIALECT,
	aggregateResultKey,
	buildSampleSql,
	compileAggregate,
	compileAggregateExprs,
	compileWhere,
	looksLikeMutation,
	quoteTarget,
	readAggregateRow,
	withTimeout,
} from '../drivers/rdbms-common.js';

// ---------------------------------------------------------------------------
// quoteTarget
// ---------------------------------------------------------------------------

describe('quoteTarget', () => {
	it('quotes a bare table name for each dialect', () => {
		assert.equal(quoteTarget('users', POSTGRES_DIALECT), '"users"');
		assert.equal(quoteTarget('users', MYSQL_DIALECT), '`users`');
		assert.equal(quoteTarget('users', SQLITE_DIALECT), '"users"');
		assert.equal(quoteTarget('users', MSSQL_DIALECT), '[users]');
		assert.equal(quoteTarget('users', ORACLE_DIALECT), '"users"');
	});

	it('quotes schema.table with a dot', () => {
		assert.equal(quoteTarget('public.users', POSTGRES_DIALECT), '"public"."users"');
		assert.equal(quoteTarget('dbo.Users', MSSQL_DIALECT), '[dbo].[Users]');
	});

	it('rejects identifiers with whitespace or SQL syntax', () => {
		assert.throws(() => quoteTarget('users; DROP TABLE', POSTGRES_DIALECT), /invalid table identifier/);
		assert.throws(() => quoteTarget('users table', POSTGRES_DIALECT), /invalid table identifier/);
		assert.throws(() => quoteTarget('1users', POSTGRES_DIALECT), /invalid table identifier/);
	});
});

// ---------------------------------------------------------------------------
// compileWhere
// ---------------------------------------------------------------------------

describe('compileWhere', () => {
	it('returns empty text + values for no clauses', () => {
		const r = compileWhere([], ['id'], POSTGRES_DIALECT);
		assert.equal(r.text, '');
		assert.deepEqual(r.values, []);
	});

	it('compiles = / != with parametrised placeholders (postgres)', () => {
		const r = compileWhere(
			[{ column: 'id', op: '=', value: 42 }, { column: 'name', op: '!=', value: 'bob' }],
			['id', 'name'],
			POSTGRES_DIALECT,
		);
		assert.equal(r.text, 'WHERE "id" = $1 AND "name" != $2');
		assert.deepEqual(r.values, [42, 'bob']);
	});

	it('compiles "in" with an array', () => {
		const r = compileWhere(
			[{ column: 'id', op: 'in', value: [1, 2, 3] }],
			['id'],
			POSTGRES_DIALECT,
		);
		assert.equal(r.text, 'WHERE "id" IN ($1, $2, $3)');
		assert.deepEqual(r.values, [1, 2, 3]);
	});

	it('compiles "is null" with no placeholder', () => {
		const r = compileWhere(
			[{ column: 'deleted_at', op: 'is null' }],
			['deleted_at'],
			POSTGRES_DIALECT,
		);
		assert.equal(r.text, 'WHERE "deleted_at" IS NULL');
		assert.deepEqual(r.values, []);
	});

	it('mysql uses `?` for every param', () => {
		const r = compileWhere(
			[{ column: 'a', op: '=', value: 1 }, { column: 'b', op: 'in', value: [2, 3] }],
			['a', 'b'],
			MYSQL_DIALECT,
		);
		assert.equal(r.text, 'WHERE `a` = ? AND `b` IN (?, ?)');
	});

	it('rejects unknown columns (defense against injection)', () => {
		assert.throws(
			() => compileWhere(
				[{ column: 'id"; DROP', op: '=', value: 1 }],
				['id'],
				POSTGRES_DIALECT,
			),
			/unknown column 'id"; DROP'/,
		);
	});

	it('rejects empty "in" arrays', () => {
		assert.throws(
			() => compileWhere([{ column: 'id', op: 'in', value: [] }], ['id'], POSTGRES_DIALECT),
			/non-empty array/,
		);
	});

	it('column lookup is case-insensitive', () => {
		const r = compileWhere(
			[{ column: 'Id', op: '=', value: 1 }],
			['id'],
			POSTGRES_DIALECT,
		);
		assert.equal(r.text, 'WHERE "Id" = $1');
	});
});

// ---------------------------------------------------------------------------
// buildSampleSql
// ---------------------------------------------------------------------------

describe('buildSampleSql', () => {
	it('assembles SELECT * FROM ... LIMIT N on postgres', () => {
		const r = buildSampleSql('users', { limit: 10 }, ['id', 'name'], POSTGRES_DIALECT);
		assert.equal(r.text, 'SELECT * FROM "users" LIMIT 10');
		assert.deepEqual(r.values, []);
	});

	it('clamps the limit to SAMPLE_LIMIT (50)', () => {
		const r = buildSampleSql('users', { limit: 10_000 }, ['id'], POSTGRES_DIALECT);
		assert.match(r.text, /LIMIT 50$/);
	});

	it('emits TOP N for mssql instead of LIMIT', () => {
		const r = buildSampleSql('Users', { limit: 5 }, ['Id'], MSSQL_DIALECT);
		assert.equal(r.text, 'SELECT TOP 5 * FROM [Users]');
	});

	it('emits FETCH FIRST ... for oracle', () => {
		const r = buildSampleSql('USERS', { limit: 5 }, ['ID'], ORACLE_DIALECT);
		assert.match(r.text, /FETCH FIRST 5 ROWS ONLY$/);
	});

	it('includes the WHERE clause when provided', () => {
		const r = buildSampleSql(
			'users',
			{ limit: 10, where: [{ column: 'active', op: '=', value: true }] },
			['id', 'active'],
			POSTGRES_DIALECT,
		);
		assert.equal(r.text, 'SELECT * FROM "users" WHERE "active" = $1 LIMIT 10');
		assert.deepEqual(r.values, [true]);
	});
});

// ---------------------------------------------------------------------------
// looksLikeMutation
// ---------------------------------------------------------------------------

describe('looksLikeMutation', () => {
	it('flags DML/DDL keywords', () => {
		assert.equal(looksLikeMutation('SELECT * FROM u; DROP TABLE u'), true);
		assert.equal(looksLikeMutation('UPDATE u SET x=1'), true);
		assert.equal(looksLikeMutation('create table x'), true);
	});

	it('accepts clean SELECTs', () => {
		assert.equal(looksLikeMutation('SELECT * FROM users WHERE id = $1 LIMIT 10'), false);
	});
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe('withTimeout', () => {
	it('resolves when the op wins the race', async () => {
		const r = await withTimeout(Promise.resolve(42), 100);
		assert.equal(r, 42);
	});

	it('rejects with a typed message when the timer wins', async () => {
		const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 500));
		await assert.rejects(withTimeout(slow, 50), /timed out after 50ms/);
	});

	it('calls onTimeout() when it fires', async () => {
		let aborted = false;
		const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 500));
		await assert.rejects(withTimeout(slow, 50, () => { aborted = true; }));
		assert.equal(aborted, true);
	});
});

// ---------------------------------------------------------------------------
// Aggregate compilation (Phase 0.1 of plans/analyzers/data-analyzer-skills.md)
// ---------------------------------------------------------------------------

describe('aggregateResultKey', () => {
	it('formats <col>__<fn> for the simple cases', () => {
		assert.equal(
			aggregateResultKey({ column: 'price', function: 'avg' }),
			'price__avg',
		);
		assert.equal(
			aggregateResultKey({ column: 'id', function: 'distinct_count' }),
			'id__distinct_count',
		);
	});

	it('embeds the percentile fraction (with `.` -> `_`)', () => {
		assert.equal(
			aggregateResultKey({ column: 'price', function: 'percentile', args: { p: 0.95 } }),
			'price__percentile_0_95',
		);
	});

	it('rejects percentile spec missing args.p', () => {
		assert.throws(
			() => aggregateResultKey({ column: 'price', function: 'percentile' }),
			/percentile spec missing args\.p/,
		);
	});
});

describe('compileAggregateExprs', () => {
	it('emits one quoted-aliased expression per aggregation', () => {
		const out = compileAggregateExprs(
			{ aggregations: [
				{ column: '*',     function: 'count' },
				{ column: 'price', function: 'avg' },
				{ column: 'price', function: 'percentile', args: { p: 0.5 } },
			] },
			['price', 'qty'],
			POSTGRES_DIALECT,
		);
		assert.deepEqual([...out.keys], ['*__count', 'price__avg', 'price__percentile_0_5']);
		assert.equal(out.exprs.length, 3);
		assert.match(out.exprs[0]!, /^COUNT\(\*\) AS "\*__count"$/);
		assert.match(out.exprs[1]!, /^AVG\("price"\) AS "price__avg"$/);
		assert.match(out.exprs[2]!, /^PERCENTILE_CONT\(0\.5\) WITHIN GROUP \(ORDER BY "price"\) AS "price__percentile_0_5"$/);
	});

	it('rejects unknown columns (count exempt)', () => {
		// `count` doesn't reference a real column, so any column string passes.
		assert.doesNotThrow(() => compileAggregateExprs(
			{ aggregations: [{ column: 'totalRows', function: 'count' }] },
			['price'],
			POSTGRES_DIALECT,
		));
		assert.throws(
			() => compileAggregateExprs(
				{ aggregations: [{ column: 'discount', function: 'avg' }] },
				['price'],
				POSTGRES_DIALECT,
			),
			/unknown column 'discount'/,
		);
	});

	it('rejects duplicate result-keys', () => {
		assert.throws(
			() => compileAggregateExprs(
				{ aggregations: [
					{ column: 'price', function: 'avg' },
					{ column: 'price', function: 'avg' },
				] },
				['price'],
				POSTGRES_DIALECT,
			),
			/duplicate aggregate key 'price__avg'/,
		);
	});

	it('rejects empty aggregations', () => {
		assert.throws(
			() => compileAggregateExprs({ aggregations: [] }, ['price'], POSTGRES_DIALECT),
			/zero aggregations/,
		);
	});

	it('uses dialect-specific stddev / variance for MSSQL', () => {
		const out = compileAggregateExprs(
			{ aggregations: [
				{ column: 'price', function: 'stddev' },
				{ column: 'price', function: 'variance' },
			] },
			['price'],
			MSSQL_DIALECT,
		);
		assert.match(out.exprs[0]!, /^STDEV\(\[price\]\) AS \[price__stddev\]$/);
		assert.match(out.exprs[1]!, /^VAR\(\[price\]\) AS \[price__variance\]$/);
	});

	it('uses STDDEV_SAMP / VAR_SAMP for the SQL-standard dialects', () => {
		for (const d of [POSTGRES_DIALECT, MYSQL_DIALECT, ORACLE_DIALECT]) {
			const out = compileAggregateExprs(
				{ aggregations: [{ column: 'price', function: 'stddev' }] },
				['price'],
				d,
			);
			assert.match(out.exprs[0]!, /^STDDEV_SAMP\(/);
		}
	});

	it('rejects out-of-range percentile p', () => {
		assert.throws(
			() => compileAggregateExprs(
				{ aggregations: [{ column: 'price', function: 'percentile', args: { p: 1.5 } }] },
				['price'],
				POSTGRES_DIALECT,
			),
			/args\.p in \[0, 1\]/,
		);
	});
});

describe('compileAggregate', () => {
	it('wraps exprs in a SELECT ... FROM <quotedTarget>', () => {
		const out = compileAggregate(
			'public.orders',
			{ aggregations: [
				{ column: '*',     function: 'count' },
				{ column: 'total', function: 'sum' },
			] },
			['total'],
			POSTGRES_DIALECT,
		);
		assert.equal(
			out.text,
			'SELECT COUNT(*) AS "*__count", SUM("total") AS "total__sum" FROM "public"."orders"',
		);
		assert.deepEqual([...out.values], []);
		assert.deepEqual([...out.keys], ['*__count', 'total__sum']);
	});

	it('refuses suspicious target identifiers', () => {
		assert.throws(
			() => compileAggregate(
				'orders; DROP TABLE',
				{ aggregations: [{ column: '*', function: 'count' }] },
				[],
				POSTGRES_DIALECT,
			),
			/invalid table identifier/,
		);
	});
});

describe('readAggregateRow', () => {
	it('coerces number / bigint / numeric-string / null', () => {
		const out = readAggregateRow(
			{ a__count: 42, a__sum: 1234567890123n, a__avg: '3.14', a__min: null, a__max: undefined },
			['a__count', 'a__sum', 'a__avg', 'a__min', 'a__max'],
		);
		assert.equal(out['a__count'], 42);
		assert.equal(out['a__sum'], Number(1234567890123n));
		assert.equal(out['a__avg'], 3.14);
		assert.equal(out['a__min'], null);
		assert.equal(out['a__max'], null);
	});

	it('NaN / non-numeric / object becomes null', () => {
		const out = readAggregateRow(
			{ a__avg: 'not a number', b__sum: { whatever: true }, c__max: NaN },
			['a__avg', 'b__sum', 'c__max'],
		);
		assert.equal(out['a__avg'], null);
		assert.equal(out['b__sum'], null);
		assert.equal(out['c__max'], null);
	});
});
