/**
 * Legacy LLM-tool executor facade.
 *
 * Stage 3b: every call dispatches to the unified tool registry.
 * The hardcoded switch statement that used to live here (one `case`
 * per builtin) is gone; the LLM path and the controller path now
 * share a single implementation per tool.
 *
 * Approval gates live inside each tool's unified execute() and are
 * reached via the unified executeTool() in daemon/tools/executor.ts.
 * The LLM tool-loop bypasses the gate layer (calls tool.execute()
 * directly) because the caller-side validator in loop.ts already
 * handles its own permission flow via Claude/Haiku pre-checks.
 */

import type { ToolCall, ToolResult } from '../../shared/types.js';
import type { Session } from '../session.js';
import { getTool as getUnifiedTool } from '../../daemon/tools/registry.js';
import { translateAliasInput } from '../../daemon/tools/builtins/llm-aliases.js';
import type { ToolDeps, ToolResult as UnifiedToolResult } from '../../daemon/tools/types.js';

export interface ToolExecContext {
  /** Session the tool is running inside. Used for repo scoping, closure, etc. */
  session?: Session | undefined;
  /** The user's original prompt (kept for smart-read style heuristics). */
  userPrompt?: string | undefined;
  /** Available context budget in tokens. */
  contextBudgetTokens?: number | undefined;
  /** Progress callback. Unified tools stream via deps.send; we adapt it here. */
  onProgress?: ((message: string) => void) | undefined;
  /** Cancellation signal forwarded to tool.execute via deps.signal. */
  signal?: AbortSignal | undefined;
}

/**
 * Execute a single LLM tool call and return the legacy ToolResult shape.
 * Never throws -- errors surface as `{ isError: true, content }`.
 */
export async function executeTool(call: ToolCall, context?: ToolExecContext): Promise<ToolResult> {
  const tool = getUnifiedTool(call.name);
  if (!tool) {
    return {
      toolCallId: call.id,
      content: `Unknown tool: ${call.name}`,
      isError: true,
    };
  }

  const deps = buildDeps(context);
  const translatedInput = translateAliasInput(call.name, call.input);
  try {
    const result = await tool.execute(translatedInput, deps);
    return unifiedToLegacy(call.id, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      toolCallId: call.id,
      content: `[error] ${call.name}: ${msg}`,
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function buildDeps(ctx: ToolExecContext | undefined): ToolDeps {
  // The unified ToolDeps requires `session`. When the LLM path runs
  // in a context that does have a session (chat-handler, delegate
  // agents), the caller plumbs it through. When it doesn't (a few
  // test harnesses), we fabricate a minimal stand-in that satisfies
  // tools that ignore session entirely. Tools like graph:search that
  // actually read `session.closureRepos` will degrade gracefully
  // because the fabricated session has an empty closure.
  const session = ctx?.session ?? buildFakeSession();
  const send = ctx?.onProgress
    ? (msg: { stream?: string; data?: unknown }) => {
        const data = msg.data as { message?: string } | undefined;
        if (data?.message && typeof data.message === 'string') { ctx.onProgress!(data.message); }
      }
    : () => { /* no-op */ };
  return {
    session,
    send,
    requestId: 0,
    ...(ctx?.signal ? { signal: ctx.signal } : {}),
  };
}

function buildFakeSession(): Session {
  // We intentionally return an object that matches the shape Session
  // consumers within tools rely on (repoPath, closureRepos). Anything
  // else is left as a runtime-only stub; tools that depend on richer
  // session state simply won't work from this degraded path.
  const stub = { repoPath: '', closureRepos: [] as string[] };
  return stub as unknown as Session;
}

function unifiedToLegacy(toolCallId: string, result: UnifiedToolResult): ToolResult {
  return {
    toolCallId,
    content: result.output,
    isError: !result.success,
  };
}
