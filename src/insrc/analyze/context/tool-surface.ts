/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P2 stub -- read-only tool surface for the LLM-driven shaper.
 *
 * Phase 2 of plans/analyze-context-builder.md owns this module:
 *   getReadOnlyTools(): ToolDefinition[]
 *     filters the built-in tool registry to read-only families
 *     (graph traversal, db describe/sample, file read/glob, manifest
 *     parse, repo registry read) and excludes every mutation tool
 *     (file write, shell, db_sql_execute, repo.add/remove/reindex,
 *     k8s mutation, pkg install, ssh, network mutation).
 *
 * The shaper passes this surface into the Ollama tool-loop. The same
 * filter is intended for reuse by any future LLM-driven framework
 * module that needs the same "read-only registry slice".
 */

import type { ToolDefinition } from '../../shared/types.js';

export function getReadOnlyTools(): ToolDefinition[] {
	throw new Error('analyze/context/tool-surface.ts: getReadOnlyTools is a P2 stub');
}
