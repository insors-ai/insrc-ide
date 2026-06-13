/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc_entity_*` MCP tools.
 *
 * Each tool wraps an existing daemon IPC (see `daemon/index.ts` under
 * `'search.*'` and `'entity.*'` keys). The MCP server runs as a
 * subprocess separate from the daemon, so handlers call into the
 * daemon over JSON-RPC -- they never touch LMDB / Lance directly.
 *
 * Each tool also exports its handler as a named function (e.g.
 * `entitySearchHandler`) so unit tests can call it with a stub RPC
 * function without standing up a real daemon.
 */

import { z } from 'zod';
import type { Entity } from '../../shared/types.js';
import type { RpcFn } from '../daemon-rpc.js';
import type { ToolCallResult, ToolDefinition, ToolHandlerContext } from '../types.js';
import { jsonResult } from '../types.js';

// ---------------------------------------------------------------------------
// insrc_entity_search
// ---------------------------------------------------------------------------

const entitySearchSchema = {
	query: z.string().min(1).describe('Natural-language search query.'),
	limit: z.number().int().positive().max(50).default(10).describe('Maximum hits to return.'),
	kind:  z.string().optional().describe('Optional kind filter (function, class, method, ...).'),
	repo:  z.string().optional().describe('Optional repo path to restrict the search to (prefix match).'),
};

export interface EntitySearchHit {
	readonly entityId: string;
	readonly kind:     string;
	readonly name:     string;
	readonly path:     string;
	readonly repo:     string;
}

export async function entitySearchHandler(
	args: { query: string; limit: number; kind?: string | undefined; repo?: string | undefined },
	rpc:  RpcFn,
): Promise<ToolCallResult> {
	// daemon's search.query already embeds the text and scopes to all
	// registered repos. Filter is fixed to 'code' for entity search;
	// 'artifact' is the artifact_vec search exposed by insrc_artifact_*.
	const raw = await rpc<Entity[]>('search.query', {
		text:   args.query,
		limit:  args.limit,
		filter: 'code',
	});
	let hits = raw;
	if (args.kind !== undefined)  hits = hits.filter(e => e.kind === args.kind);
	if (args.repo !== undefined)  hits = hits.filter(e => e.repo.startsWith(args.repo!));
	const projected: EntitySearchHit[] = hits.map(e => ({
		entityId: e.id,
		kind:     e.kind,
		name:     e.name,
		path:     e.file,
		repo:     e.repo,
	}));
	return jsonResult({ hits: projected });
}

const entitySearch: ToolDefinition<typeof entitySearchSchema> = {
	name:        'insrc_entity_search',
	description: 'Semantic ANN search over entity embeddings (LanceDB). Returns ranked entity hits scoped to the active repo and its dependency closure. Optional client-side `kind` and `repo` filters narrow the post-ANN results.',
	scope:       'global',
	inputSchema: entitySearchSchema,
	handler: async (args, ctx) => entitySearchHandler(args, ctx.rpc),
};

// ---------------------------------------------------------------------------
// insrc_entity_summary
// ---------------------------------------------------------------------------

const entitySummarySchema = {
	entityId: z.string().min(1).describe('Deterministic entity id (hex-32).'),
};

export async function entitySummaryHandler(
	args: { entityId: string },
	rpc:  RpcFn,
): Promise<ToolCallResult> {
	const entity = await rpc<Entity | null>('entity.summary', { entityId: args.entityId });
	if (entity === null) {
		return {
			content: [{ type: 'text', text: `entity '${args.entityId}' not found` }],
			isError: true,
		};
	}
	return jsonResult({ entity });
}

const entitySummary: ToolDefinition<typeof entitySummarySchema> = {
	name:        'insrc_entity_summary',
	description: 'Pre-extracted typed summary of one entity: kind, name, file, repo, body excerpt, docstring (when present).',
	scope:       'global',
	inputSchema: entitySummarySchema,
	handler: async (args, ctx) => entitySummaryHandler(args, ctx.rpc),
};

// ---------------------------------------------------------------------------
// insrc_entity_callers
// ---------------------------------------------------------------------------

const entityCallersSchema = {
	entityId: z.string().min(1).describe('Target function/method entity id.'),
	depth:    z.number().int().positive().max(3).default(1).describe('Traversal depth (1 = direct callers only; cap is 3 to bound expansion).'),
};

export async function entityCallersHandler(
	args: { entityId: string; depth: number },
	rpc:  RpcFn,
): Promise<ToolCallResult> {
	const method = args.depth > 1 ? 'search.callers_nhop' : 'search.callers';
	const params = args.depth > 1
		? { entityId: args.entityId, hops: args.depth }
		: { entityId: args.entityId };
	const callers = await rpc<Entity[]>(method, params);
	return jsonResult({ callers });
}

const entityCallers: ToolDefinition<typeof entityCallersSchema> = {
	name:        'insrc_entity_callers',
	description: 'Callers of a function/method via the LMDB graph (typed CALLS edge in-neighbors). `depth=1` is direct callers; `depth>1` walks the multi-hop call frontier (capped at 3 to bound expansion).',
	scope:       'global',
	inputSchema: entityCallersSchema,
	handler: async (args, ctx) => entityCallersHandler(args, ctx.rpc),
};

// ---------------------------------------------------------------------------
// insrc_entity_callees
// ---------------------------------------------------------------------------

const entityCalleesSchema = {
	entityId: z.string().min(1).describe('Source function/method entity id.'),
};

export async function entityCalleesHandler(
	args: { entityId: string },
	rpc:  RpcFn,
): Promise<ToolCallResult> {
	const callees = await rpc<Entity[]>('search.callees', { entityId: args.entityId });
	return jsonResult({ callees });
}

const entityCallees: ToolDefinition<typeof entityCalleesSchema> = {
	name:        'insrc_entity_callees',
	description: 'Direct callees of a function/method via the LMDB graph (typed CALLS edge out-neighbors). Multi-hop callee walk is intentionally not exposed -- use insrc_entity_closure with edgeKind=CALLS instead.',
	scope:       'global',
	inputSchema: entityCalleesSchema,
	handler: async (args, ctx) => entityCalleesHandler(args, ctx.rpc),
};

// ---------------------------------------------------------------------------
// insrc_entity_closure
// ---------------------------------------------------------------------------

const entityClosureSchema = {
	entityId:  z.string().min(1).describe('Root entity to walk from.'),
	edgeKind:  z.string().min(1).describe('Edge kind to traverse (CALLS, IMPORTS, DEPENDS_ON, INHERITS, IMPLEMENTS, REFERENCES, DEFINES, EXPORTS).'),
	direction: z.enum(['in', 'out']).default('out').describe('`out` follows outgoing edges; `in` follows incoming.'),
	maxDepth:  z.number().int().positive().max(32).default(8).describe('Maximum traversal depth.'),
};

export async function entityClosureHandler(
	args: { entityId: string; edgeKind: string; direction: 'in' | 'out'; maxDepth: number },
	rpc:  RpcFn,
): Promise<ToolCallResult> {
	const reachable = await rpc<Entity[]>('entity.closure', {
		rootIds:   [args.entityId],
		edgeKind:  args.edgeKind,
		direction: args.direction,
		maxDepth:  args.maxDepth,
	});
	return jsonResult({ reachable, count: reachable.length });
}

const entityClosure: ToolDefinition<typeof entityClosureSchema> = {
	name:        'insrc_entity_closure',
	description: 'BFS reachable set from an entity along a typed edge (e.g. CALLS, IMPORTS, DEPENDS_ON). Returns the hydrated entity rows reachable up to maxDepth.',
	scope:       'global',
	inputSchema: entityClosureSchema,
	handler: async (args, ctx) => entityClosureHandler(args, ctx.rpc),
};

// ---------------------------------------------------------------------------
// insrc_entity_unreachable
// ---------------------------------------------------------------------------

const entityUnreachableSchema = {
	repoId:      z.string().min(1).describe('Repo path scoping the closure (used for client-side filtering of results).'),
	entryPoints: z.array(z.string().min(1)).nonempty().describe('Entry-point entity ids (e.g. exported handlers).'),
	kindFilter:  z.array(z.string()).optional().describe("Optional kinds to include in the 'unreachable' output (defaults to ['function', 'method'])."),
};

export async function entityUnreachableHandler(
	args: { repoId: string; entryPoints: readonly string[]; kindFilter?: readonly string[] | undefined },
	rpc:  RpcFn,
): Promise<ToolCallResult> {
	const candidateKinds = args.kindFilter ?? ['function', 'method'];
	const raw = await rpc<Entity[]>('entity.unreachable', {
		rootIds:        args.entryPoints,
		candidateKinds,
	});
	const unreachable = raw.filter(e => e.repo.startsWith(args.repoId));
	return jsonResult({ unreachable, count: unreachable.length });
}

const entityUnreachable: ToolDefinition<typeof entityUnreachableSchema> = {
	name:        'insrc_entity_unreachable',
	description: 'Dead-code detection within a closure: entities of the given kinds not reachable from the given entry points. Post-filters to entries whose repo path begins with `repoId`.',
	scope:       'global',
	inputSchema: entityUnreachableSchema,
	handler: async (args, ctx) => entityUnreachableHandler(args, ctx.rpc),
};

// ---------------------------------------------------------------------------

export const ENTITY_TOOLS: readonly ToolDefinition[] = [
	entitySearch as unknown as ToolDefinition,
	entitySummary as unknown as ToolDefinition,
	entityCallers as unknown as ToolDefinition,
	entityCallees as unknown as ToolDefinition,
	entityClosure as unknown as ToolDefinition,
	entityUnreachable as unknown as ToolDefinition,
];

// Re-export for tests:
export type { ToolHandlerContext };
