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
	buildSampleSql,
	compileWhere,
	looksLikeMutation,
	quoteTarget,
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
