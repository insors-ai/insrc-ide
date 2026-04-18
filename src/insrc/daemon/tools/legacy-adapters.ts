/**
 * Legacy LLM tool adapters.
 *
 * Stage 2 of the unified-tools migration: register every existing LLM
 * builtin (agent/tools/registry.ts) as an entry in the unified registry.
 *
 * Stage 3a moved delegate adapters out of this file; `registerDelegate`
 * now registers its own tool adapter directly when the delegate is
 * registered (see daemon/delegates/registry.ts).
 *
 * Adapter preserves legacy wire format: LLM tools still return strings
 * via the ToolCall / ToolResult shape. Stage 3b will fold the legacy
 * LLM executor to look up here instead of maintaining its own dispatch.
 */

import { getLogger } from '../../shared/logger.js';
import { registerTool } from './registry.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from './types.js';
import type { ToolCall } from '../../shared/types.js';
import { executeTool as legacyExecuteLLMTool } from '../../agent/tools/executor.js';
import { getTool as getLegacyLLMTool } from '../../agent/tools/registry.js';

const log = getLogger('tools-legacy-adapters');

let registered = false;

/**
 * Register all legacy LLM tools with the unified registry.
 * Idempotent -- safe to call more than once.
 */
export function registerLegacyAdapters(): void {
  if (registered) { return; }
  registered = true;

  for (const legacy of collectLegacyLLMTools()) {
    registerTool(buildLLMAdapter(legacy.name, legacy.description, legacy.inputSchema));
  }

  log.info('legacy LLM adapters registered');
}

// ---------------------------------------------------------------------------
// LLM builtin -> Tool adapter
// ---------------------------------------------------------------------------

function collectLegacyLLMTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  // The legacy registry does not expose a public `listAll()` call, so we
  // enumerate known builtin names and look each up. When stage 3 folds
  // the registry this helper is deleted -- unified registrations will
  // be the source of truth.
  const names = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch',
    'ListDirectory', 'FileInfo', 'TreeView', 'Diff', 'GitLog', 'GitBlame',
    'graph_entity', 'graph_search', 'graph_callers', 'graph_callees', 'graph_query',
    'plan_get', 'plan_step_update', 'plan_next_step',
    'lsp_diagnostics', 'lsp_definitions', 'lsp_references', 'lsp_hover', 'lsp_symbols',
  ];
  const out: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
  for (const name of names) {
    const legacy = getLegacyLLMTool(name);
    if (!legacy) { continue; }
    const def = legacy.definition;
    out.push({ name: def.name, description: def.description, inputSchema: def.inputSchema });
  }
  return out;
}

function buildLLMAdapter(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): Tool {
  return {
    id: name,
    description,
    inputSchema,
    // Approval wiring stays in the legacy path for stage 2 -- the unified
    // executor treats these as auto-allow so nothing gates twice once
    // stage 3 flips the caller.
    requiresApproval: false,
    async execute(input: ToolInput, _deps: ToolDeps): Promise<ToolResult> {
      const call: ToolCall = {
        id: `unified-${Date.now()}`,
        name,
        input: input as Record<string, unknown>,
      };
      const legacy = await legacyExecuteLLMTool(call);
      return {
        output: legacy.content,
        format: 'text',
        success: !legacy.isError,
        ...(legacy.isError ? { error: legacy.content } : {}),
      };
    },
  };
}

