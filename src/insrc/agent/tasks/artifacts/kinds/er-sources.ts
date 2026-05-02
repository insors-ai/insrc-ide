/**
 * Structured source fetchers for the ER artifact kind.
 *
 * Three branches:
 *   - Prisma `schema.prisma` parse -- small hand-rolled regex parser
 *     sufficient for `model X { ... }` blocks + basic field types +
 *     relations. We deliberately skip the heavy `@prisma/internals`
 *     dep so users without Prisma installed pay nothing.
 *   - Code knowledge-graph traversal -- pick up entities of kind
 *     'class' / 'interface' / 'type' from the DuckDB entity table
 *     and their REFERENCES edges as a cross-reference approximation.
 *   - Live DB via the data-driver pool -- per-table `describe()`
 *     against an RDBMS connection, composed into a Mermaid
 *     `erDiagram`. This is plan §3.1's live-DB ER source.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { getLogger } from '../../../../shared/logger.js';
import type { DbClient } from '../../../../db/client.js';
import { getDb } from '../../../../db/client.js';
import { findEntitiesByName, getEntity } from '../../../../db/entities.js';
import { acquirePool } from '../../../../daemon/db/pool-cache.js';
import type {
	RdbmsDriver,
	SchemaDescription,
} from '../../../../shared/db-driver.js';
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
// Code knowledge-graph traversal (DuckDB-backed)
// ---------------------------------------------------------------------------

/**
 * Pick up entity stubs of type-ish kinds. Filter optionally by name
 * (used when the caller supplied `tables` / `entityIds`). Produces a
 * small ER diagram with entity blocks + REFERENCES edges.
 */
export async function parseGraphEntitiesSource(
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
		throw new Error('Graph ER source needs at least one name or entity id to traverse');
	}

	if (selected.length === 0) {
		throw new Error('Graph ER source found no matching entities');
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

	// REFERENCES edges between selected entities. The relation table is
	// shape (src, dst, kind); we fetch the REFERENCES edges (capped at
	// 2000) and filter in-process against the selected id set.
	const refs = await db.duck.query<{ fromId: string; toId: string }>(
		`SELECT src AS "fromId", dst AS "toId"
		 FROM relation WHERE kind = 'REFERENCES' LIMIT 2000`,
	).catch(() => [] as { fromId: string; toId: string }[]);
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
		provenance: `code knowledge graph (${selected.length} entit${selected.length === 1 ? 'y' : 'ies'})`,
		entityCount: selected.length,
		sourceKind: 'graph',
	};
}

// ---------------------------------------------------------------------------
// Live DB introspection via the data-driver pool (plan §3.1)
// ---------------------------------------------------------------------------

/**
 * Compose a Mermaid `erDiagram` from a list of `SchemaDescription`s.
 * Foreign-key columns become both an FK-marked column on the source
 * entity and a one-to-many relationship line pointing at the
 * referenced table. Exported for tests.
 */
export function renderLiveDbMermaid(
	schemas: readonly SchemaDescription[],
): string {
	const lines: string[] = ['erDiagram'];

	// First pass: choose a unique Mermaid name per target so that
	// `public.users` and `public.orders` don't collide on `users` /
	// `orders`.
	const erNameOf = new Map<string, string>();
	const usedNames = new Set<string>();
	for (const s of schemas) {
		let base = erName(s.target, 'TABLE');
		while (usedNames.has(base)) { base = `${base}_`; }
		usedNames.add(base);
		erNameOf.set(s.target, base);
	}

	// Second pass: entity blocks. Skip FK columns from the column body
	// (they're rendered as relationship lines below); keep them as
	// columns when their target table isn't in the requested set.
	const targetSet = new Set(schemas.map(s => s.target));
	const targetSetLower = new Set(schemas.map(s => s.target.toLowerCase()));
	const fkInScope = (col: { foreignKey?: { table: string; column: string } }): boolean => {
		if (col.foreignKey === undefined) { return false; }
		const t = col.foreignKey.table;
		return targetSet.has(t) || targetSetLower.has(t.toLowerCase());
	};

	for (const s of schemas) {
		const ename = erNameOf.get(s.target) ?? erName(s.target, 'TABLE');
		lines.push(`  ${ename} {`);
		for (const c of s.columns) {
			const flags: string[] = [];
			if (c.primaryKey === true) { flags.push('PK'); }
			if (c.foreignKey !== undefined) { flags.push('FK'); }
			const flagPart = flags.length > 0 ? ` ${flags.join(',')}` : '';
			const comment = c.nullable === true ? ' "nullable"' : '';
			// Mermaid column lines: <type> <name> [PK,FK] ["nullable"].
			// Sanitise type to keep tokens within ER grammar.
			const typeToken = c.type.replace(/[^A-Za-z0-9_]/g, '_') || 'unknown';
			const nameToken = c.name.replace(/[^A-Za-z0-9_]/g, '_') || 'col';
			lines.push(`    ${typeToken} ${nameToken}${flagPart}${comment}`);
		}
		lines.push('  }');
	}

	// Third pass: relationships. One per FK-in-scope. Direction is
	// "referenced (one) ||--o{ referrer (many)".
	const emittedPairs = new Set<string>();
	for (const s of schemas) {
		for (const c of s.columns) {
			if (!fkInScope(c)) { continue; }
			const fk = c.foreignKey!;
			const fromT = schemas.find(
				x => x.target === fk.table || x.target.toLowerCase() === fk.table.toLowerCase(),
			);
			if (fromT === undefined) { continue; }
			const fromName = erNameOf.get(fromT.target) ?? erName(fromT.target, 'TABLE');
			const toName = erNameOf.get(s.target) ?? erName(s.target, 'TABLE');
			const key = `${fromName}->${toName}:${c.name}`;
			if (emittedPairs.has(key)) { continue; }
			emittedPairs.add(key);
			lines.push(`  ${fromName} ||--o{ ${toName} : ${escapeErComment(c.name)}`);
		}
	}

	return lines.join('\n');
}

export interface LiveDbErOpts {
	readonly connection: string;
	readonly tables: readonly string[];
	readonly repoRoot: string;
}

/**
 * Pull `SchemaDescription`s from a configured RDBMS connection (one
 * per table) and emit an `erDiagram`. Throws on:
 *   - unknown connection id
 *   - non-RDBMS connection family
 *   - probe / acquire failure (connection unreachable)
 *   - all-tables-failed describe (every table errored)
 *
 * Partial success (some tables describe, some fail) returns a diagram
 * over the successful subset and surfaces the failures via a thrown
 * error containing the per-table reasons -- so the caller can choose
 * to use the partial result or fall through.
 *
 * The kind module catches and falls through to Prisma / graph /
 * scaffold per plan §3.1 ("probe failure falls through to the existing
 * priority chain rather than erroring").
 */
export async function parseLiveDbSource(
	opts: LiveDbErOpts,
): Promise<ErSourceResult> {
	if (opts.tables.length === 0) {
		throw new Error(
			'Live DB ER needs an explicit `tables` list -- there is no ' +
			'`db_sql_list_tables` tool, and dumping the entire schema ' +
			'unconditionally is hostile.',
		);
	}

	const pool = await acquirePool(opts.repoRoot);
	const configured = pool.list();
	const match = configured.find(c => c.id === opts.connection);
	if (match === undefined) {
		throw new Error(
			`Live DB ER: unknown connection '${opts.connection}'. ` +
			`Known: ${configured.map(c => c.id).join(', ') || '(none)'}`,
		);
	}
	if (match.family !== 'rdbms') {
		throw new Error(
			`Live DB ER: connection '${opts.connection}' is ${match.family}; ` +
			'only rdbms connections support `describe()`.',
		);
	}

	const driver = await pool.acquire(opts.connection) as RdbmsDriver;

	const schemas: SchemaDescription[] = [];
	const failed: { table: string; reason: string }[] = [];
	for (const table of opts.tables) {
		try {
			const schema = await driver.describe(table);
			schemas.push(schema);
		} catch (err) {
			failed.push({ table, reason: (err as Error).message });
		}
	}

	if (schemas.length === 0) {
		throw new Error(
			`Live DB ER: every requested table failed to describe. ` +
			failed.map(f => `${f.table}: ${f.reason}`).join('; '),
		);
	}

	const provenanceParts = [
		`live DB: ${opts.connection}`,
		`${schemas.length}/${opts.tables.length} tables`,
	];
	if (failed.length > 0) {
		provenanceParts.push(`(failed: ${failed.map(f => f.table).join(', ')})`);
	}

	return {
		mermaidSource: renderLiveDbMermaid(schemas),
		provenance: provenanceParts.join(' · '),
		entityCount: schemas.length,
		sourceKind: 'live-db',
	};
}

