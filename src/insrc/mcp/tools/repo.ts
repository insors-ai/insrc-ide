/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc_repo_*` MCP tools -- cross-repo dependency closure awareness.
 *
 * `insrc_repo_depends_on` enumerates the transitive DEPENDS_ON closure
 * of the active repo (with name + `transitive` flag distinguishing
 * direct vs transitive deps). `insrc_repo_search_cross_repo` composes
 * the closure with an ANN entity search so the agent can find symbols
 * that live in a dependency repo without inspecting each one manually.
 */

import { z } from 'zod';
import type { Entity } from '../../shared/types.js';
import type { RpcFn } from '../daemon-rpc.js';
import type { ToolCallResult, ToolDefinition } from '../types.js';
import { jsonResult } from '../types.js';

interface RepoClosureEntry {
	readonly repoId:     string;
	readonly name:       string;
	readonly path:       string;
	readonly transitive: boolean;
}

interface CrossRepoSearchHit {
	readonly entityId: string;
	readonly kind:     string;
	readonly name:     string;
	readonly path:     string;
	readonly repo:     string;
}

// ---------------------------------------------------------------------------
// insrc_repo_depends_on
// ---------------------------------------------------------------------------

const repoDependsOnSchema = {
	repoId: z.string().min(1).describe('Repo path (workspace registry key).'),
};

export async function repoDependsOnHandler(
	args: { repoId: string },
	rpc:  RpcFn,
): Promise<ToolCallResult> {
	const closure = await rpc<RepoClosureEntry[]>('repo.depends_on', { repoId: args.repoId });
	return jsonResult({ closure, count: closure.length });
}

const repoDependsOn: ToolDefinition<typeof repoDependsOnSchema> = {
	name:        'insrc_repo_depends_on',
	description: 'List repos in the transitive DEPENDS_ON closure of the active repo, with a `transitive` flag distinguishing direct deps from indirect.',
	scope:       'global',
	inputSchema: repoDependsOnSchema,
	handler: async (args, ctx) => repoDependsOnHandler(args, ctx.rpc),
};

// ---------------------------------------------------------------------------
// insrc_repo_search_cross_repo
// ---------------------------------------------------------------------------

const repoSearchCrossRepoSchema = {
	query:  z.string().min(1).describe('Natural-language query.'),
	repoId: z.string().min(1).describe('Root repo whose DEPENDS_ON closure scopes the search.'),
	limit:  z.number().int().positive().max(50).default(10).describe('Maximum hits.'),
};

export async function repoSearchCrossRepoHandler(
	args: { query: string; repoId: string; limit: number },
	rpc:  RpcFn,
): Promise<ToolCallResult> {
	const raw = await rpc<Entity[]>('repo.search_cross_repo', {
		query:  args.query,
		repoId: args.repoId,
		limit:  args.limit,
	});
	const hits: CrossRepoSearchHit[] = raw.map(e => ({
		entityId: e.id,
		kind:     e.kind,
		name:     e.name,
		path:     e.file,
		repo:     e.repo,
	}));
	return jsonResult({ hits, count: hits.length });
}

const repoSearchCrossRepo: ToolDefinition<typeof repoSearchCrossRepoSchema> = {
	name:        'insrc_repo_search_cross_repo',
	description: 'Semantic ANN entity search across the active repo + its DEPENDS_ON closure. Use when an entity might live in a dependency repo.',
	scope:       'global',
	inputSchema: repoSearchCrossRepoSchema,
	handler: async (args, ctx) => repoSearchCrossRepoHandler(args, ctx.rpc),
};

// ---------------------------------------------------------------------------

export const REPO_TOOLS: readonly ToolDefinition[] = [
	repoDependsOn       as unknown as ToolDefinition,
	repoSearchCrossRepo as unknown as ToolDefinition,
];
