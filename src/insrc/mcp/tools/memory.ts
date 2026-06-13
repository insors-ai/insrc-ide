/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc_memory_*` MCP tools -- semantic search over prior conversation
 * turns and response segments. Lets the external agent recall
 * previously-discussed context without insrc pre-fetching it.
 *
 * Both tools accept a query string; the MCP handler embeds it via
 * Ollama before the Lance ANN call (Day 2 wiring).
 */

import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { NotImplementedError } from '../types.js';

const memoryRecall: ToolDefinition = {
	name:        'insrc_memory_recall',
	description: 'Semantic search over prior conversation turns (turn_vec ANN). Returns ranked turn refs with intent and response summary.',
	scope:       'global',
	inputSchema: {
		query: z.string().min(1).describe('Natural-language query (e.g. "did we fix the flaky test in foo.test.ts?").'),
		limit: z.number().int().positive().max(50).default(10).describe('Maximum hits.'),
		since: z.string().datetime().optional().describe('ISO 8601 timestamp; restrict to turns after this point.'),
	},
	async handler() { throw new NotImplementedError('insrc_memory_recall'); },
};

const memoryRelatedTurns: ToolDefinition = {
	name:        'insrc_memory_related_turns',
	description: 'Find prior turns about the same subject via response_segment_vec ANN. Use when you need finer recall than full-turn matching.',
	scope:       'global',
	inputSchema: {
		query: z.string().min(1).describe('Natural-language query against response segments.'),
		limit: z.number().int().positive().max(50).default(10).describe('Maximum hits.'),
	},
	async handler() { throw new NotImplementedError('insrc_memory_related_turns'); },
};

export const MEMORY_TOOLS: readonly ToolDefinition[] = [
	memoryRecall,
	memoryRelatedTurns,
];
