/**
 * Shared call-graph traversal used by sequence + flow (code
 * sub-kind).
 *
 * Given an entry point (entity id OR exact name), walk the CALLS
 * relation up to `depth` hops and return a compact list of participants
 * + edges. The caller decides how to render (sequenceDiagram vs.
 * flowchart); we just do the graph walk.
 *
 * No ranking / scoring in phase 1 -- we take up to `maxParticipants`
 * callees in insertion order. Good enough for the default visualisation;
 * a richer "hot-path" heuristic is a later follow-up.
 */

import { getLogger } from '../../../../shared/logger.js';
import type { DbClient } from '../../../../db/client.js';
import { getDb } from '../../../../db/client.js';
import { findEntitiesByName, getEntity } from '../../../../db/entities.js';
import { findCallees } from '../../../../db/search.js';
import type { Entity, EntityKind } from '../../../../shared/types.js';

const log = getLogger('artifact-kind-call-graph');
void log;

export interface CallGraph {
	/** Entry entity (resolved, always first in `nodes`). */
	readonly entry: Entity;
	/** Nodes reached during traversal, including the entry. Insertion
	 *  order matches BFS visit order. */
	readonly nodes: readonly Entity[];
	/** Directed edges (caller -> callee) between nodes. */
	readonly edges: readonly { readonly from: string; readonly to: string }[];
}

/**
 * Resolve an entry identifier. Accepts either an entity id (hex-32,
 * matching the SHA256 convention) or a human-readable name. The id
 * path is preferred; name lookup widens to the graph call-kinds
 * (function / method / class / module) when ambiguous.
 */
async function resolveEntry(
	db: DbClient,
	identifier: string,
	repoPath: string | undefined,
): Promise<Entity | null> {
	// Heuristic: ids are 32 hex chars.
	if (/^[0-9a-f]{32}$/i.test(identifier)) {
		return await getEntity(db, identifier).catch(() => null);
	}

	const kinds: readonly EntityKind[] = ['function', 'method', 'class', 'module'];
	const candidates = await findEntitiesByName(db, [identifier], {
		kinds,
		...(repoPath !== undefined ? { repo: repoPath } : {}),
		limit: 10,
	}).catch(() => [] as Entity[]);

	if (candidates.length === 0) { return null; }

	// Prefer function -> method -> class -> module when multiple hit the same name.
	const priority: Record<EntityKind, number> = {
		function: 0, method: 1, class: 2, module: 3,
		interface: 4, type: 5, variable: 6,
		repo: 7, file: 7, document: 7, section: 7, config: 7,
	};
	const sorted = [...candidates].sort((a, b) =>
		(priority[a.kind] ?? 10) - (priority[b.kind] ?? 10),
	);
	return sorted[0] ?? null;
}

export interface TraverseOpts {
	readonly entry: string;                    // id or name
	readonly depth?: number | undefined;       // default 3; clamped [1, 6]
	readonly maxParticipants?: number | undefined;  // default 20
	readonly repoPath?: string | undefined;
}

/**
 * Walk the CALLS graph from an entry point. Returns null when the
 * entry can't be resolved.
 */
export async function traverseCallGraph(
	opts: TraverseOpts,
	dbOverride?: DbClient,
): Promise<CallGraph | null> {
	const db = dbOverride ?? await getDb();
	const depth = Math.max(1, Math.min(6, opts.depth ?? 3));
	const cap = Math.max(2, Math.min(50, opts.maxParticipants ?? 20));

	const entry = await resolveEntry(db, opts.entry, opts.repoPath);
	if (entry === null) { return null; }

	const nodes: Entity[] = [entry];
	const byId = new Map<string, Entity>([[entry.id, entry]]);
	const edges: { from: string; to: string }[] = [];
	const edgeKey = new Set<string>();

	interface Frontier { id: string; hop: number; }
	const queue: Frontier[] = [{ id: entry.id, hop: 0 }];
	let cursor = 0;

	while (cursor < queue.length && nodes.length < cap) {
		const head = queue[cursor++];
		if (head === undefined) { break; }
		if (head.hop >= depth) { continue; }
		const callees = await findCallees(db, head.id).catch(() => [] as Entity[]);
		for (const callee of callees) {
			if (nodes.length >= cap) { break; }
			if (!byId.has(callee.id)) {
				byId.set(callee.id, callee);
				nodes.push(callee);
				queue.push({ id: callee.id, hop: head.hop + 1 });
			}
			const key = `${head.id}->${callee.id}`;
			if (!edgeKey.has(key)) {
				edgeKey.add(key);
				edges.push({ from: head.id, to: callee.id });
			}
		}
	}

	return { entry, nodes, edges };
}
