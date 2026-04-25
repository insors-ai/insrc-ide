/**
 * Structured source fetchers for the ER artifact kind.
 *
 * Two branches:
 *   - Prisma `schema.prisma` parse -- small hand-rolled regex parser
 *     sufficient for `model X { ... }` blocks + basic field types +
 *     relations. We deliberately skip the heavy `@prisma/internals`
 *     dep so users without Prisma installed pay nothing.
 *   - Kuzu entity-graph traversal -- pick up entities of kind
 *     'class' / 'interface' / 'type' and their REFERENCES edges
 *     as a cross-reference approximation.
 *
 * Live-DB introspection (`db.sql.*`) is phase 3.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { getLogger } from '../../../../shared/logger.js';
import type { DbClient } from '../../../../db/client.js';
import { getDb } from '../../../../db/client.js';
import { findEntitiesByName, getEntity } from '../../../../db/entities.js';
import type { Entity } from '../../../../shared/types.js';
import {
	parsePrismaSchema,
	type PrismaModel,
} from '../../../../shared/prisma-schema.js';

const log = getLogger('artifact-kind-er-sources');
void log;

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export interface ErSourceResult {
	readonly mermaidSource: string;
	readonly provenance: string;
	readonly entityCount: number;
	readonly sourceKind: string;
}

function resolvePath(path: string, repoRoot: string | undefined): string {
	return isAbsolute(path) ? path : resolve(repoRoot ?? process.cwd(), path);
}

/** Mermaid ER entity names must match `[A-Z_][A-Z0-9_]*`. */
function erName(raw: string, fallback: string): string {
	let up = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
	if (up === '' || /^\d/.test(up)) { up = `${fallback}_${up}`; }
	if (up === '') { return fallback; }
	return up;
}

function escapeErComment(raw: string): string {
	return raw.replace(/"/g, "'");
}

// ---------------------------------------------------------------------------
// Prisma schema rendering (parser lives in shared/prisma-schema.ts so the
// data-driver describe() fast path can reuse it)
// ---------------------------------------------------------------------------

function renderPrismaMermaid(models: readonly PrismaModel[]): string {
	const lines: string[] = ['erDiagram'];
	const modelNames = new Set<string>();
	for (const m of models) { modelNames.add(m.name); }

	// Entity blocks
	for (const m of models) {
		lines.push(`  ${erName(m.name, 'MODEL')} {`);
		for (const f of m.fields) {
			if (f.relationTo !== undefined && modelNames.has(f.relationTo)) {
				// Relation fields are rendered as edges below, not columns.
				continue;
			}
			const flags: string[] = [];
			if (f.isId) { flags.push('PK'); }
			if (f.isUnique && !f.isId) { flags.push('UK'); }
			const flagPart = flags.length > 0 ? ` ${flags.join(',')}` : '';
			const comment = f.isOptional ? ' "nullable"' : '';
			lines.push(`    ${f.type} ${f.name}${flagPart}${comment}`);
		}
		lines.push('  }');
	}

	// Relations: one edge per relation field that points to a known model.
	// We pair "scalar list" fields from one side to "single" fields on the
	// other side when possible; otherwise emit a generic one-to-many.
	const emittedPairs = new Set<string>();
	for (const m of models) {
		for (const f of m.fields) {
			if (f.relationTo === undefined) { continue; }
			if (!modelNames.has(f.relationTo)) { continue; }
			const key = [m.name, f.relationTo].sort().join('::');
			if (emittedPairs.has(key)) { continue; }
			emittedPairs.add(key);
			const cardinality = f.isList ? '||--o{' : '||--||';
			lines.push(`  ${erName(m.name, 'MODEL')} ${cardinality} ${erName(f.relationTo, 'RELATED')} : ${escapeErComment(f.name)}`);
		}
	}

	return lines.join('\n');
}

export async function parsePrismaSource(
	path: string,
	repoRoot: string | undefined,
): Promise<ErSourceResult> {
	const abs = resolvePath(path, repoRoot);
	const text = await readFile(abs, 'utf8');
	const models = parsePrismaSchema(text);
	if (models.length === 0) {
		throw new Error(`Prisma schema parse found no models in ${abs}`);
	}
	return {
		mermaidSource: renderPrismaMermaid(models),
		provenance: `Prisma schema: ${path}`,
		entityCount: models.length,
		sourceKind: 'prisma',
	};
}

// ---------------------------------------------------------------------------
// Kuzu entity-graph traversal
// ---------------------------------------------------------------------------

/**
 * Pick up entity stubs of type-ish kinds. Filter optionally by name
 * (used when the caller supplied `tables` / `entityIds`). Produces a
 * small ER diagram with entity blocks + REFERENCES edges.
 */
export async function parseKuzuEntitiesSource(
	filters: {
		readonly names?: readonly string[] | undefined;
		readonly entityIds?: readonly string[] | undefined;
		readonly repoPath?: string | undefined;
	},
	dbOverride?: DbClient,
): Promise<ErSourceResult> {
	const db = dbOverride ?? await getDb();

	const selected: Entity[] = [];
	if (filters.entityIds !== undefined && filters.entityIds.length > 0) {
		// Direct-id branch: fetch each by id.
		for (const id of filters.entityIds) {
			const ent = await getEntity(db, id).catch(() => null);
			if (ent !== null) { selected.push(ent); }
		}
	} else if (filters.names !== undefined && filters.names.length > 0) {
		// Name branch: resolve type-ish entities by exact name.
		const ents = await findEntitiesByName(db, filters.names, {
			kinds: ['class', 'interface', 'type'],
			...(filters.repoPath !== undefined ? { repo: filters.repoPath } : {}),
			limit: 50,
		}).catch(() => [] as Entity[]);
		// Prefer the first match per requested name, preserving order.
		const byName = new Map<string, Entity>();
		for (const e of ents) {
			if (!byName.has(e.name)) { byName.set(e.name, e); }
		}
		for (const name of filters.names) {
			const hit = byName.get(name);
			if (hit !== undefined) { selected.push(hit); }
		}
	} else {
		// No filter: bail -- we don't want to dump the whole graph.
		throw new Error('Kuzu ER source needs at least one name or entity id to traverse');
	}

	if (selected.length === 0) {
		throw new Error('Kuzu ER source found no matching entities');
	}

	const byId = new Map<string, Entity>();
	for (const e of selected) { byId.set(e.id, e); }

	const lines: string[] = ['erDiagram'];
	const nameToErName = new Map<string, string>();
	const usedNames = new Set<string>();
	for (const e of selected) {
		let base = erName(e.name, 'ENTITY');
		while (usedNames.has(base)) { base = `${base}_`; }
		usedNames.add(base);
		nameToErName.set(e.id, base);
		lines.push(`  ${base} {`);
		lines.push(`    string id PK`);
		lines.push(`    string name "${escapeErComment(e.name)}"`);
		lines.push(`    string kind "${escapeErComment(e.kind)}"`);
		lines.push('  }');
	}

	// REFERENCES edges between selected entities. Kuzu stores only
	// `Entity{id, kind}` so we can't filter by any richer predicate in
	// Cypher; we fetch all REFERENCES edges (capped) and filter
	// in-process against the selected id set.
	const refs = await kuzuRows(
		db,
		'MATCH (a:Entity)-[:REFERENCES]->(b:Entity) RETURN a.id AS fromId, b.id AS toId LIMIT 2000',
	);
	for (const row of refs) {
		const fromId = row['fromId'];
		const toId = row['toId'];
		if (typeof fromId !== 'string' || typeof toId !== 'string') { continue; }
		if (!byId.has(fromId) || !byId.has(toId)) { continue; }
		const from = nameToErName.get(fromId);
		const to = nameToErName.get(toId);
		if (from === undefined || to === undefined) { continue; }
		lines.push(`  ${from} ||--o{ ${to} : references`);
	}

	return {
		mermaidSource: lines.join('\n'),
		provenance: `Kuzu entity graph (${selected.length} entit${selected.length === 1 ? 'y' : 'ies'})`,
		entityCount: selected.length,
		sourceKind: 'kuzu',
	};
}

// ---------------------------------------------------------------------------
// Small Kuzu helper (mirrors the kuzuQuery pattern in db/search.ts
// without importing the private helper)
// ---------------------------------------------------------------------------

async function kuzuRows(db: DbClient, stmt: string): Promise<Record<string, unknown>[]> {
	try {
		const result = await db.graph.query(stmt);
		const qr = Array.isArray(result) ? result[0] : result;
		if (qr === undefined) { return []; }
		// kuzu QueryResult has a runtime `.getAll()` method; the type
		// isn't exposed directly.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return await (qr as any).getAll() as Record<string, unknown>[];
	} catch {
		return [];
	}
}
