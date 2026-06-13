/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc_repo_*` MCP tools -- cross-repo dependency closure awareness.
 * Lets the external agent discover that an entity it's editing lives
 * in a repo whose transitive DEPENDS_ON closure spans N other repos
 * (so it can search across them) without insrc pre-rendering a full
 * cross-repo entity dump into the spec.
 */

import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { NotImplementedError } from '../types.js';

const repoDependsOn: ToolDefinition = {
	name:        'insrc_repo_depends_on',
	description: 'List repos in the transitive DEPENDS_ON closure of the active repo, with a `transitive` flag distinguishing direct deps.',
	scope:       'global',
	inputSchema: {
		repoId: z.string().min(1).describe('Repo path (workspace registry key).'),
	},
	async handler() { throw new NotImplementedError('insrc_repo_depends_on'); },
};

const repoSearchCrossRepo: ToolDefinition = {
	name:        'insrc_repo_search_cross_repo',
	description: 'Semantic ANN entity search across the active repo + its DEPENDS_ON closure. Useful when an entity might live in a dependency repo.',
	scope:       'global',
	inputSchema: {
		query:  z.string().min(1).describe('Natural-language query.'),
		repoId: z.string().min(1).describe('Root repo whose closure scopes the search.'),
		limit:  z.number().int().positive().max(50).default(10).describe('Maximum hits.'),
	},
	async handler() { throw new NotImplementedError('insrc_repo_search_cross_repo'); },
};

export const REPO_TOOLS: readonly ToolDefinition[] = [
	repoDependsOn,
	repoSearchCrossRepo,
];
