/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc_entity_*` MCP tools -- knowledge-graph queries the external
 * agent uses to discover code structure at execution time.
 *
 * Day 1 ships definitions + handler stubs; Day 2 wires the actual
 * backing functions (see scoping report -- `db/search.ts`,
 * `db/entities.ts`). Handlers throw NotImplementedError until then.
 */

import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { NotImplementedError } from '../types.js';

const entitySearch: ToolDefinition = {
	name:        'insrc_entity_search',
	description: 'Semantic ANN search over entity embeddings (LanceDB). Returns ranked entity hits scoped to the active repo and its dependency closure.',
	scope:       'global',
	inputSchema: {
		query: z.string().min(1).describe('Natural-language search query.'),
		limit: z.number().int().positive().max(50).default(10).describe('Maximum hits to return.'),
		kind:  z.string().optional().describe('Optional kind filter (function, class, method, ...).'),
		repo:  z.string().optional().describe('Optional repo path to restrict the search to.'),
	},
	async handler() { throw new NotImplementedError('insrc_entity_search'); },
};

const entitySummary: ToolDefinition = {
	name:        'insrc_entity_summary',
	description: 'Pre-extracted typed summary of one entity: kind, name, path, fields, methods, parents, children, docstring.',
	scope:       'global',
	inputSchema: {
		entityId: z.string().min(1).describe('Deterministic entity id (hex-32).'),
	},
	async handler() { throw new NotImplementedError('insrc_entity_summary'); },
};

const entityCallers: ToolDefinition = {
	name:        'insrc_entity_callers',
	description: 'Direct callers of a function/method via the LMDB graph (typed CALLS edge in-neighbors).',
	scope:       'global',
	inputSchema: {
		entityId: z.string().min(1).describe('Target function/method entity id.'),
		depth:    z.number().int().positive().max(8).default(1).describe('Traversal depth (1 = direct callers only).'),
	},
	async handler() { throw new NotImplementedError('insrc_entity_callers'); },
};

const entityCallees: ToolDefinition = {
	name:        'insrc_entity_callees',
	description: 'Direct callees of a function/method via the LMDB graph (typed CALLS edge out-neighbors).',
	scope:       'global',
	inputSchema: {
		entityId: z.string().min(1).describe('Source function/method entity id.'),
		depth:    z.number().int().positive().max(8).default(1).describe('Traversal depth (1 = direct callees only).'),
	},
	async handler() { throw new NotImplementedError('insrc_entity_callees'); },
};

const entityClosure: ToolDefinition = {
	name:        'insrc_entity_closure',
	description: 'BFS reachable set from an entity along a typed edge (e.g. CALLS, IMPORTS, DEPENDS_ON). Returns entity ids and depths.',
	scope:       'global',
	inputSchema: {
		entityId: z.string().min(1).describe('Root entity to walk from.'),
		edgeKind: z.string().min(1).describe('Edge kind to traverse (CALLS, IMPORTS, DEPENDS_ON, ...).'),
		maxDepth: z.number().int().positive().max(32).default(8).describe('Maximum traversal depth.'),
	},
	async handler() { throw new NotImplementedError('insrc_entity_closure'); },
};

const entityUnreachable: ToolDefinition = {
	name:        'insrc_entity_unreachable',
	description: 'Dead-code detection within a closure: entities of the given kinds not reachable from the given entry points.',
	scope:       'global',
	inputSchema: {
		repoId:       z.string().min(1).describe('Repo path scoping the closure.'),
		entryPoints:  z.array(z.string().min(1)).nonempty().describe('Entry-point entity ids (e.g. exported handlers).'),
		kindFilter:   z.array(z.string()).optional().describe('Optional kinds to include in the "unreachable" output (defaults to function + method).'),
	},
	async handler() { throw new NotImplementedError('insrc_entity_unreachable'); },
};

export const ENTITY_TOOLS: readonly ToolDefinition[] = [
	entitySearch,
	entitySummary,
	entityCallers,
	entityCallees,
	entityClosure,
	entityUnreachable,
];
