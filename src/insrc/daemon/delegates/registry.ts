/**
 * Delegate registry -- thin shim over the unified tools registry.
 *
 * Stage 3a of plans/tools.md: delegates no longer maintain their own
 * handler map or approval loop. Each registerDelegate() builds a Tool
 * adapter and hands it to the unified registry. executeDelegate()
 * looks the same to callers (TaskResult shape, TaskOrchestratorDeps)
 * but forwards to executeTool() -- approval, schema validation, and
 * streaming live in one place.
 *
 * The DelegateHandler interface is kept so existing handler files
 * (web-search.ts) do not need to change in stage 3. Stages 4-6 migrate
 * controllers + handlers to emit Tools directly.
 */

import { getLogger } from '../../shared/logger.js';
import type { TaskResult, TaskOrchestratorDeps, TaskFormat } from '../task.js';
import type { GateAction } from '../../agent/framework/types.js';
import { registerTool } from '../tools/registry.js';
import { executeTool } from '../tools/executor.js';
import type { Tool, ToolInput, ToolResult, ToolDeps } from '../tools/types.js';

const log = getLogger('delegate-registry');

// ---------------------------------------------------------------------------
// Types (kept stable for existing handler files)
// ---------------------------------------------------------------------------

export interface DelegateInput {
  [key: string]: unknown;
}

export interface DelegateHandler {
  readonly id: string;
  readonly description: string;
  readonly requiresApproval: boolean;
  readonly approvalMessage?: string | undefined;
  buildApprovalGate?(input: DelegateInput): { title: string; content: string; actions: GateAction[] };
  applyEdit?(input: DelegateInput, feedback: string): DelegateInput;
  execute(input: DelegateInput, deps: TaskOrchestratorDeps): Promise<DelegateResult>;
}

export interface DelegateResult {
  output: string;
  format: TaskFormat;
  success: boolean;
  error?: string | undefined;
}

// ---------------------------------------------------------------------------
// Registration -- registerDelegate is now a one-liner that registers a
// Tool adapter. No local map; the unified registry is the source of truth.
// ---------------------------------------------------------------------------

export function registerDelegate(handler: DelegateHandler): void {
  registerTool(buildDelegateAdapter(handler));
  log.info({ id: handler.id, requiresApproval: handler.requiresApproval }, 'delegate registered (via unified tools)');
}

function buildDelegateAdapter(delegate: DelegateHandler): Tool {
  const tool: Tool = {
    id: delegate.id,
    description: delegate.description,
    // Delegates never carried a JSON Schema. Stage 5 will replace these
    // with hand-written schemas as each delegate migrates to a first-
    // class tool.
    inputSchema: { type: 'object', additionalProperties: true },
    requiresApproval: delegate.requiresApproval,
    async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
      if (!deps.channel) {
        return {
          output: '[delegate adapter] missing channel in tool deps',
          format: 'text',
          success: false,
          error: 'no channel',
        };
      }
      // TaskOrchestratorDeps is a superset of ToolDeps. Safe to forward
      // the required fields; task-only extras (historyMessages,
      // stateStore, getInjectedMessages) aren't consumed by any
      // delegate handler today.
      const result = await delegate.execute(input, {
        session: deps.session,
        channel: deps.channel,
        send: deps.send,
        requestId: deps.requestId,
      });
      return {
        output: result.output,
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

// ---------------------------------------------------------------------------
// executeDelegate -- kept as a thin shim returning TaskResult.
// Callers (task orchestrator on kind: 'delegate') see the same shape
// they always did.
// ---------------------------------------------------------------------------

export async function executeDelegate(
  delegateId: string,
  input: DelegateInput,
  deps: TaskOrchestratorDeps,
  taskIndex: number,
  description: string,
): Promise<TaskResult> {
  const result = await executeTool(delegateId, input, {
    session: deps.session,
    channel: deps.channel,
    send: deps.send,
    requestId: deps.requestId,
  });

  return {
    index: taskIndex,
    description,
    output: result.output,
    format: result.format as TaskFormat,
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
  };
}
