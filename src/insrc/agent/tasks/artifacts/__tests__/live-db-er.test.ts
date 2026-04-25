/**
 * Tests for the live-DB ER source renderer (`renderLiveDbMermaid`).
 *
 * The acquire-pool + per-table describe pipeline is integration-shaped
 * (tested via the existing data-driver suites). This file covers the
 * pure rendering function: SchemaDescription[] -> Mermaid `erDiagram`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { SchemaDescription } from '../../../../shared/db-driver.js';
import { renderLiveDbMermaid } from '../kinds/er-sources.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function schema(
	target: string,
	columns: readonly Partial<SchemaDescription['columns'][number]>[],
): SchemaDescription {
	return {
		target,
		source: 'introspect',
		columns: columns.map(c => ({
			name: c.name ?? 'col',
			type: c.type ?? 'text',
			...(c.nullable !== undefined ? { nullable: c.nullable } : {}),
			...(c.primaryKey !== undefined ? { primaryKey: c.primaryKey } : {}),
			...(c.foreignKey !== undefined ? { foreignKey: c.foreignKey } : {}),
		})),
	};
}

// ---------------------------------------------------------------------------
// Single-table rendering
// ---------------------------------------------------------------------------

describe('renderLiveDbMermaid - single table', () => {
	it('emits a header + entity block + PK column', () => {
		const out = renderLiveDbMermaid([
			schema('users', [
				{ name: 'id', type: 'integer', primaryKey: true },
				{ name: 'email', type: 'text' },
			]),
		]);
		assert.match(out, /^erDiagram/);
		assert.match(out, /USERS \{/);
		assert.match(out, /integer id PK/);
		assert.match(out, /text email/);
	});

	it('marks nullable columns', () => {
		const out = renderLiveDbMermaid([
			schema('users', [
				{ name: 'id', type: 'integer', primaryKey: true },
				{ name: 'nickname', type: 'text', nullable: true },
			]),
		]);
		assert.match(out, /text nickname "nullable"/);
	});

	it('sanitises column / type tokens to Mermaid-safe identifiers', () => {
		const out = renderLiveDbMermaid([
			schema('weird', [
				{ name: 'first-name', type: 'character varying' },
				{ name: '@@meta', type: 'jsonb' },
			]),
		]);
		// Hyphens / spaces / @ replaced with `_`.
		assert.match(out, /character_varying first_name/);
		assert.match(out, /jsonb __meta/);
	});

	it('upper-cases entity names + de-collides duplicates', () => {
		const out = renderLiveDbMermaid([
			schema('users', [{ name: 'id', type: 'int' }]),
			// Same Mermaid-name target -> appended underscore.
			schema('Users', [{ name: 'id', type: 'int' }]),
		]);
		assert.match(out, /USERS \{/);
		assert.match(out, /USERS_ \{/);
	});
});

// ---------------------------------------------------------------------------
// Foreign-key rendering
// ---------------------------------------------------------------------------

describe('renderLiveDbMermaid - foreign keys', () => {
	it('emits one ||--o{ relationship per in-scope FK', () => {
		const out = renderLiveDbMermaid([
			schema('users', [
				{ name: 'id', type: 'integer', primaryKey: true },
			]),
			schema('orders', [
				{ name: 'id', type: 'integer', primaryKey: true },
				{ name: 'user_id', type: 'integer', foreignKey: { table: 'users', column: 'id' } },
			]),
		]);
		// FK column carries the FK flag.
		assert.match(out, /integer user_id FK/);
		// Relationship line: users (1) -> orders (many).
		assert.match(out, /USERS \|\|--o\{ ORDERS : user_id/);
	});

	it('matches FK targets case-insensitively', () => {
		const out = renderLiveDbMermaid([
			schema('Users', [
				{ name: 'id', type: 'integer', primaryKey: true },
			]),
			schema('orders', [
				{ name: 'id', type: 'integer', primaryKey: true },
				{ name: 'user_id', type: 'integer', foreignKey: { table: 'users', column: 'id' } },
			]),
		]);
		assert.match(out, /USERS \|\|--o\{ ORDERS : user_id/);
	});

	it('skips out-of-scope FKs in relationship lines but keeps the FK flag on the column', () => {
		const out = renderLiveDbMermaid([
			schema('orders', [
				{ name: 'id', type: 'integer', primaryKey: true },
				// References users which isn't in the requested set.
				{ name: 'user_id', type: 'integer', foreignKey: { table: 'users', column: 'id' } },
			]),
		]);
		// Column still flagged FK so the reader sees there's a relation.
		assert.match(out, /integer user_id FK/);
		// But no ||--o{ line because the target table isn't rendered.
		assert.doesNotMatch(out, /USERS\b.*ORDERS/);
		assert.doesNotMatch(out, /\|\|--o\{/);
	});

	it('does not emit duplicate relationship lines when two FKs target the same table', () => {
		const out = renderLiveDbMermaid([
			schema('users', [
				{ name: 'id', type: 'integer', primaryKey: true },
			]),
			schema('messages', [
				{ name: 'id', type: 'integer', primaryKey: true },
				{ name: 'sender_id', type: 'integer', foreignKey: { table: 'users', column: 'id' } },
				{ name: 'recipient_id', type: 'integer', foreignKey: { table: 'users', column: 'id' } },
			]),
		]);
		const senderRel = out.match(/USERS \|\|--o\{ MESSAGES : sender_id/g);
		const recipientRel = out.match(/USERS \|\|--o\{ MESSAGES : recipient_id/g);
		// Both columns should produce distinct relationship lines (key
		// includes the FK column name for disambiguation).
		assert.equal(senderRel?.length ?? 0, 1);
		assert.equal(recipientRel?.length ?? 0, 1);
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('renderLiveDbMermaid - edge cases', () => {
	it('handles a table with no columns', () => {
		const out = renderLiveDbMermaid([schema('empty', [])]);
		assert.match(out, /^erDiagram/);
		assert.match(out, /EMPTY \{/);
		assert.match(out, /\}/);
	});

	it('returns a header-only diagram for an empty schema list', () => {
		const out = renderLiveDbMermaid([]);
		assert.equal(out, 'erDiagram');
	});

	it('preserves PK + FK flags together when both apply (junction-table style)', () => {
		const out = renderLiveDbMermaid([
			schema('users', [{ name: 'id', type: 'integer', primaryKey: true }]),
			schema('roles', [{ name: 'id', type: 'integer', primaryKey: true }]),
			schema('user_roles', [
				{ name: 'user_id', type: 'integer', primaryKey: true,
					foreignKey: { table: 'users', column: 'id' } },
				{ name: 'role_id', type: 'integer', primaryKey: true,
					foreignKey: { table: 'roles', column: 'id' } },
			]),
		]);
		assert.match(out, /integer user_id PK,FK/);
		assert.match(out, /integer role_id PK,FK/);
	});
});
