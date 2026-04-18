/**
 * Legacy tool / delegate adapters.
 *
 * Stage 2 of the unified-tools migration: register every existing LLM
 * builtin (agent/tools/registry.ts) and every existing delegate
 * (daemon/delegates/*.ts) as an entry in the unified registry so both
 * can be looked up through a single API.
 *
 * In stage 2 the adapters are WRITE-ONLY from the unified registry's
 * perspective -- nothing calls executeTool() through them yet. Stage 3
 * points the legacy tool executor and delegate executor at this
 * registry, at which point these adapters start handling traffic.
 *
 * Each adapter preserves the legacy wire format:
 *   - LLM tools return strings (the existing ToolCall/ToolResult shape)
 *   - delegates return DelegateResult with format + success
 * so stage 3 can flip the callers without changing on-the-wire semantics.
 */

import { getLogger } from '../../shared/logger.js';
import { registerTool } from './registry.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from './types.js';
import type { ToolCall } from '../../shared/types.js';
import { executeTool as legacyExecuteLLMTool } from '../../agent/tools/executor.js';
import { getTool as getLegacyLLMTool } from '../../agent/tools/registry.js';
import {
  webSearchDelegate,
  claudeWebSearchDelegate,
  braveWebSearchDelegate,
} from '../delegates/web-search.js';
import type { DelegateHandler } from '../delegates/registry.js';

const log = getLogger('tools-legacy-adapters');

let registered = false;

/**
 * Register all legacy LLM tools + delegates with the unified registry.
 * Idempotent -- safe to call more than once.
 */
export function registerLegacyAdapters(): void {
  if (registered) { return; }
  registered = true;

  // LLM tool-call builtins (Read, Write, Edit, ..., lsp_*).
  for (const legacy of collectLegacyLLMTools()) {
    registerTool(buildLLMAdapter(legacy.name, legacy.description, legacy.inputSchema));
  }

  // Delegates (web-search family).
  for (const delegate of [webSearchDelegate, braveWebSearchDelegate, claudeWebSearchDelegate]) {
    registerTool(buildDelegateAdapter(delegate));
  }

  log.info('legacy adapters registered');
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

// ---------------------------------------------------------------------------
// Delegate -> Tool adapter
// ---------------------------------------------------------------------------

function buildDelegateAdapter(delegate: DelegateHandler): Tool {
  const tool: Tool = {
    id: delegate.id,
    description: delegate.description,
    // Delegates never carried a JSON Schema. Stage 5 will replace these
    // with hand-written schemas as each delegate migrates to a first-
    // class tool.
    inputSchema: { type: 'object', additionalProperties: true },
    requiresApproval: delegate.requiresApproval,
    async execute(input, deps): Promise<ToolResult> {
      if (!deps.channel) {
        return {
          output: '[delegate adapter] missing channel in tool deps',
          format: 'text',
          success: false,
          error: 'no channel',
        };
      }
      // TaskOrchestratorDeps is a superset of ToolDeps (session, channel,
      // send, requestId are all required on the former). Safe to forward.
      const result = await delegate.execute(input, {
        session: deps.session,
        channel: deps.channel,
        send: deps.send,
        requestId: deps.requestId,
      });
      return {
        output: result.output,
        // Legacy TaskFormat and unified ToolFormat overlap on
        // 'text' | 'markdown' | 'code' | 'diff' | 'table' | 'json'.
        // Anything else coerces to 'text'.
        format: mapLegacyFormat(result.format),
        success: result.success,
        ...(result.error ? { error: result.error } : {}),
      };
    },
  };
  if (delegate.buildApprovalGate) {
    tool.buildApprovalGate = input => delegate.buildApprovalGate!(input);
  }
  if (delegate.applyEdit) {
    tool.applyEdit = (input, feedback) => delegate.applyEdit!(input, feedback);
  }
  return tool;
}

function mapLegacyFormat(fmt: string): ToolResult['format'] {
  switch (fmt) {
    case 'markdown':
    case 'code':
    case 'diff':
    case 'table':
    case 'json':
      return fmt;
    default:
      return 'text';
  }
}
