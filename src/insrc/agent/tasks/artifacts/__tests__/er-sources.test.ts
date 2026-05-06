/**
 * Tests for agent/tasks/artifacts/kinds/er-sources.ts.
 *
 * Scope: Prisma schema regex parser. The graph entity-graph branch
 * needs a live LMDB fixture and is covered by the smoke script.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parsePrismaSource } from '../kinds/er-sources.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRIVIAL_SCHEMA = `
datasource db { provider = "postgresql" url = env("DATABASE_URL") }
generator client { provider = "prisma-client-js" }

model User {
  id    String @id @default(cuid())
  email String @unique
  posts Post[]
}

model Post {
  id       String @id @default(cuid())
  title    String
  body     String?
  authorId String
  author   User @relation(fields: [authorId], references: [id])
}
`;

const SCALAR_TYPES_SCHEMA = `
model Account {
  id        String   @id
  name      String
  age       Int
  balance   Decimal
  isActive  Boolean
  createdAt DateTime
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempSchema<T>(
	contents: string,
	fn: (path: string, root: string) => Promise<T>,
): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), 'insrc-prisma-'));
	const schemaPath = join(root, 'schema.prisma');
	writeFileSync(schemaPath, contents);
	try {
		return await fn(schemaPath, root);
	} finally {
		try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parsePrismaSource - two-model schema with a relation', () => {
	it('produces an erDiagram with both models and the relation edge', async () => {
		await withTempSchema(TRIVIAL_SCHEMA, async (path) => {
			const result = await parsePrismaSource(path, undefined);
			assert.equal(result.sourceKind, 'prisma');
			assert.equal(result.entityCount, 2);
			assert.ok(result.mermaidSource.startsWith('erDiagram'));
			assert.ok(result.mermaidSource.includes('USER {'));
			assert.ok(result.mermaidSource.includes('POST {'));
			// Exactly one relation edge between the two models (the
			// pair-tracking Set dedupes the back-reference).
			const lines = result.mermaidSource.split('\n');
			const relationLines = lines.filter(l =>
				l.includes('||--') && l.includes('USER') && l.includes('POST'),
			);
			assert.equal(relationLines.length, 1);
		});
	});

	it('marks @id fields with PK and @unique fields with UK', async () => {
		await withTempSchema(TRIVIAL_SCHEMA, async (path) => {
			const result = await parsePrismaSource(path, undefined);
			// `id` is @id -> PK
			assert.match(result.mermaidSource, /String id PK/);
			// `email` is @unique -> UK
			assert.match(result.mermaidSource, /String email UK/);
		});
	});

	it('renders optional fields with the "nullable" comment', async () => {
		await withTempSchema(TRIVIAL_SCHEMA, async (path) => {
			const result = await parsePrismaSource(path, undefined);
			// Post.body is optional (`String?`); parser strips `?` from type
			// and appends the nullable comment.
			assert.match(result.mermaidSource, /String body "nullable"/);
		});
	});

	it('omits relation fields from the entity body (rendered as edges)', async () => {
		await withTempSchema(TRIVIAL_SCHEMA, async (path) => {
			const result = await parsePrismaSource(path, undefined);
			// User.posts and Post.author should NOT appear as columns
			// (they become the ||--o{ edges instead).
			assert.ok(!/Post posts/.test(result.mermaidSource), 'User.posts should not appear as a column');
			assert.ok(!/User author/.test(result.mermaidSource), 'Post.author should not appear as a column');
		});
	});

	it('uses ||--o{ for list sides and ||--|| for singular', async () => {
		await withTempSchema(TRIVIAL_SCHEMA, async (path) => {
			const result = await parsePrismaSource(path, undefined);
			// User has `posts Post[]` (list) -- the pair-emitter should
			// pick the list cardinality when either side is list.
			assert.match(result.mermaidSource, /USER \|\|--o\{ POST/);
		});
	});
});

describe('parsePrismaSource - primitive scalar handling', () => {
	it('preserves Prisma scalar type names verbatim', async () => {
		await withTempSchema(SCALAR_TYPES_SCHEMA, async (path) => {
			const result = await parsePrismaSource(path, undefined);
			assert.match(result.mermaidSource, /String name\b/);
			assert.match(result.mermaidSource, /Int age\b/);
			assert.match(result.mermaidSource, /Decimal balance\b/);
			assert.match(result.mermaidSource, /Boolean isActive\b/);
			assert.match(result.mermaidSource, /DateTime createdAt\b/);
		});
	});
});

describe('parsePrismaSource - error paths', () => {
	it('throws when the file parses but contains no models', async () => {
		await withTempSchema('// just a comment\n', async (path) => {
			await assert.rejects(
				parsePrismaSource(path, undefined),
				/no models/,
			);
		});
	});

	it('throws when the file does not exist', async () => {
		await assert.rejects(
			parsePrismaSource('/tmp/insrc-nope-does-not-exist.prisma', undefined),
			/ENOENT|no such file/,
		);
	});
});
