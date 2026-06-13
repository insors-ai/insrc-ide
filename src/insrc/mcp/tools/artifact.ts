/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc_artifact_*` MCP tools -- read prior skill-call outputs (cited
 * summaries + raw spill bodies) that section-flow produced.
 *
 * Both are session-scoped: the agent must present a valid
 * INSRC_SESSION_TOKEN issued at handoff spawn (Phase 2a).
 */

import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { NotImplementedError } from '../types.js';

const artifactGet: ToolDefinition = {
	name:        'insrc_artifact_get',
	description: 'Read a cited summary + raw output of a prior skill call by artifact id. Session-scoped.',
	scope:       'session',
	inputSchema: {
		artifactId: z.string().min(1).describe('Artifact id from a prior tool result or memory recall.'),
	},
	async handler() { throw new NotImplementedError('insrc_artifact_get'); },
};

const artifactSearch: ToolDefinition = {
	name:        'insrc_artifact_search',
	description: 'Semantic ANN search over artifact_vec scoped to the active session. Returns ranked artifact summaries.',
	scope:       'session',
	inputSchema: {
		query:     z.string().min(1).describe('Natural-language query against artifact summaries.'),
		limit:     z.number().int().positive().max(50).default(10).describe('Maximum hits.'),
		sessionId: z.string().optional().describe('Override the token-bound session id (rarely needed; defaults to the token holder).'),
	},
	async handler() { throw new NotImplementedError('insrc_artifact_search'); },
};

export const ARTIFACT_TOOLS: readonly ToolDefinition[] = [
	artifactGet,
	artifactSearch,
];
