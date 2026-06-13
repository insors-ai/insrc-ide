/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc_artifact_*` MCP tools.
 *
 * Both tools are session-scoped: the agent must present a valid
 * INSRC_SESSION_TOKEN, which the registry resolves to the
 * session id before reaching the handler (ctx.sessionId is
 * guaranteed defined here).
 *
 * Underlying functions are reached via daemon IPCs `artifact.get` and
 * `artifact.search` (see daemon/index.ts). The MCP subprocess does
 * not open Lance directly.
 */

import { z } from 'zod';
import type { RpcFn } from '../daemon-rpc.js';
import type { ToolCallResult, ToolDefinition } from '../types.js';
import { jsonResult } from '../types.js';

interface ArtifactGetResult {
	readonly id:         string;
	readonly session_id: string;
	readonly intent:     string;
	readonly skill_id:   string;
	readonly timestamp:  bigint | number | string;
	readonly path:       string;
	readonly preview:    string;
	readonly summary:    string;
	readonly raw:        string | null;
}

interface ArtifactSearchHit {
	readonly id:         string;
	readonly session_id: string;
	readonly intent:     string;
	readonly skill_id:   string;
	readonly timestamp:  bigint | number | string;
	readonly path:       string;
	readonly preview:    string;
	readonly summary:    string;
	readonly distance:   number;
}

// ---------------------------------------------------------------------------
// insrc_artifact_get
// ---------------------------------------------------------------------------

const artifactGetSchema = {
	artifactId: z.string().min(1).describe('Artifact id from a prior tool result or memory recall.'),
};

export async function artifactGetHandler(
	args: { artifactId: string },
	rpc:  RpcFn,
): Promise<ToolCallResult> {
	const hit = await rpc<ArtifactGetResult | null>('artifact.get', { artifactId: args.artifactId });
	if (hit === null) {
		return {
			content: [{ type: 'text', text: `artifact '${args.artifactId}' not found` }],
			isError: true,
		};
	}
	return jsonResult({ artifact: hit });
}

const artifactGet: ToolDefinition<typeof artifactGetSchema> = {
	name:        'insrc_artifact_get',
	description: 'Read a cited summary + raw spill body of a prior skill call by artifact id. Session-scoped.',
	scope:       'session',
	inputSchema: artifactGetSchema,
	handler: async (args, ctx) => artifactGetHandler(args, ctx.rpc),
};

// ---------------------------------------------------------------------------
// insrc_artifact_search
// ---------------------------------------------------------------------------

const artifactSearchSchema = {
	query:  z.string().min(1).describe('Natural-language query against artifact summaries.'),
	limit:  z.number().int().positive().max(50).default(10).describe('Maximum hits.'),
	intent: z.string().optional().describe('Optional intent filter (e.g. data-analyze, code-analysis).'),
};

export async function artifactSearchHandler(
	args:      { query: string; limit: number; intent?: string | undefined },
	rpc:       RpcFn,
	sessionId: string,
): Promise<ToolCallResult> {
	const hits = await rpc<ArtifactSearchHit[]>('artifact.search', {
		query:     args.query,
		sessionId,
		limit:     args.limit,
		...(args.intent !== undefined ? { intent: args.intent } : {}),
	});
	return jsonResult({ hits, count: hits.length });
}

const artifactSearch: ToolDefinition<typeof artifactSearchSchema> = {
	name:        'insrc_artifact_search',
	description: 'Semantic ANN search over artifact_vec scoped to the active session. Returns ranked artifact summaries with distance.',
	scope:       'session',
	inputSchema: artifactSearchSchema,
	handler: async (args, ctx) => {
		// `scope: 'session'` -> registry guaranteed ctx.sessionId is defined.
		return artifactSearchHandler(args, ctx.rpc, ctx.sessionId as string);
	},
};

export const ARTIFACT_TOOLS: readonly ToolDefinition[] = [
	artifactGet      as unknown as ToolDefinition,
	artifactSearch   as unknown as ToolDefinition,
];
