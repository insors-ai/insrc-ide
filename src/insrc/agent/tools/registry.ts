/**
 * Legacy LLM-tool registry facade.
 *
 * Stage 3b: this file used to own hardcoded BUILTIN_TOOLS / MCP_TOOLS /
 * LSP_TOOLS lists. Today the unified `daemon/tools/registry.ts` is the
 * single source of truth for every tool. This module derives the
 * LLM-facing ToolDefinition[] from that registry so runToolLoop still
 * gets the familiar shape without a second catalog drifting out of
 * sync.
 */

import type { ToolDefinition } from '../../shared/types.js';
import {
  getTool as getUnifiedTool,
  listTools as listUnifiedTools,
  getAliases as getUnifiedAliases,
} from '../../daemon/tools/registry.js';
import type { Tool as UnifiedTool } from '../../daemon/tools/types.js';

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/** Legacy tool names the LLM currently sees -- all resolve via alias. */
const LEGACY_LLM_NAMES: ReadonlySet<string> = new Set([
  'Read', 'Write', 'Edit', 'FileInfo',
  'Glob', 'Grep', 'ListDirectory',
  'Bash',
  'Diff', 'GitLog', 'GitBlame',
  'WebSearch', 'WebFetch',
  'graph_entity', 'graph_search', 'graph_callers', 'graph_callees', 'graph_query',
  'plan_get', 'plan_step_update', 'plan_next_step',
]);

function toDefinition(tool: UnifiedTool, name: string): ToolDefinition {
  return {
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

// ---------------------------------------------------------------------------
// Public API (backwards-compatible with the previous registry)
// ---------------------------------------------------------------------------

export type ToolBackend = 'builtin' | 'mcp';

export interface RegisteredTool {
  definition: ToolDefinition;
  backend: ToolBackend;
}

/**
 * Get all tool definitions for injection into LLM prompts.
 *
 * The LLM path currently keys tools by their legacy short names
 * (`Read`, `Grep`, `graph_search`, ...) rather than canonical
 * `file_read` / `search_grep` ids. We emit only the names the LLM
 * already knows so prompt templates don't change, but the definitions
 * are pulled from the unified registry.
 *
 * `mcpAvailable` is kept as a parameter for call-site compatibility
 * but is effectively a no-op now -- every tool runs in-process.
 */
export function getToolDefinitions(_opts?: { mcpAvailable?: boolean }): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  const aliases = getUnifiedAliases();
  for (const name of LEGACY_LLM_NAMES) {
    const tool = getUnifiedTool(name);
    if (!tool) { continue; }
    out.push(toDefinition(tool, name));
  }
  // Include any alias that points to a tool we didn't already surface
  // under its legacy name (future-proofing -- keeps the list complete
  // if llm-aliases.ts grows).
  for (const alias of aliases.keys()) {
    if (LEGACY_LLM_NAMES.has(alias)) { continue; }
    const tool = getUnifiedTool(alias);
    if (!tool) { continue; }
    if (out.some(d => d.name === alias)) { continue; }
    out.push(toDefinition(tool, alias));
  }
  return out;
}

/** Look up a registered tool by name (legacy alias or canonical id). */
export function getTool(name: string): RegisteredTool | undefined {
  const tool = getUnifiedTool(name);
  if (!tool) { return undefined; }
  // Backend distinction is vestigial -- every tool is in-process.
  return { definition: toDefinition(tool, name), backend: 'builtin' };
}

/** All registered tool definitions (canonical ids + legacy aliases). */
export function listAllDefinitions(): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const tool of listUnifiedTools()) {
    out.push(toDefinition(tool, tool.id));
  }
  return out;
}
