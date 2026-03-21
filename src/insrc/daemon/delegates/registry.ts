/**
 * Delegate handler registry.
 *
 * Controllers can delegate work to named handlers (web-search, code-analysis,
 * test-run, etc.). Each handler encapsulates execution logic, approval
 * requirements, and result formatting.
 */

import type { TaskResult, TaskOrchestratorDeps, TaskFormat } from '../task.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('delegate-registry');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegateInput {
  [key: string]: unknown;
}

export interface DelegateHandler {
  /** Unique handler ID (e.g. 'web-search', 'code-analysis'). */
  readonly id: string;
  /** Human-readable description. */
  readonly description: string;
  /** Whether user approval is required before execution. */
  readonly requiresApproval: boolean;
  /** Approval message shown in the gate (if requiresApproval). */
  readonly approvalMessage?: string | undefined;
  /** Execute the delegate task. */
  execute(input: DelegateInput, deps: TaskOrchestratorDeps): Promise<DelegateResult>;
}

export interface DelegateResult {
  output: string;
  format: TaskFormat;
  success: boolean;
  error?: string | undefined;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const handlers = new Map<string, DelegateHandler>();

export function registerDelegate(handler: DelegateHandler): void {
  if (handlers.has(handler.id)) {
    log.warn({ id: handler.id }, 'overwriting existing delegate handler');
  }
  handlers.set(handler.id, handler);
  log.info({ id: handler.id, requiresApproval: handler.requiresApproval }, 'delegate handler registered');
}

export function getDelegate(id: string): DelegateHandler | undefined {
  return handlers.get(id);
}

export function listDelegates(): DelegateHandler[] {
  return Array.from(handlers.values());
}

/**
 * Execute a delegate by ID. Handles approval gating internally.
 * Returns a TaskResult-compatible object.
 */
export async function executeDelegate(
  delegateId: string,
  input: DelegateInput,
  deps: TaskOrchestratorDeps,
  taskIndex: number,
  description: string,
): Promise<TaskResult> {
  const handler = handlers.get(delegateId);
  if (!handler) {
    log.error({ delegateId }, 'delegate handler not found');
    return {
      index: taskIndex,
      description,
      output: `Unknown delegate: ${delegateId}`,
      format: 'text' as TaskFormat,
      success: false,
      error: `No delegate handler registered for '${delegateId}'`,
    };
  }

  log.info({ delegateId, requiresApproval: handler.requiresApproval }, 'executing delegate');

  // Approval gate if needed
  if (handler.requiresApproval) {
    const gateId = `delegate-${delegateId}-${Date.now()}`;
    const approvalMsg = handler.approvalMessage
      ?? `The agent wants to use: ${handler.description}. Proceed?`;

    // Send gate
    deps.send({ id: deps.requestId, stream: 'gate', data: {
      gateId,
      title: `Approval: ${handler.description}`,
      content: approvalMsg,
      actions: ['Approve', 'Skip'],
    }});

    // Wait for gate reply via channel
    const reply = await waitForGateReply(deps, gateId);
    if (!reply || reply.action?.toLowerCase() === 'skip') {
      log.info({ delegateId }, 'delegate skipped by user');
      return {
        index: taskIndex,
        description,
        output: `[Skipped by user] ${handler.description}`,
        format: 'text' as TaskFormat,
        success: true,
      };
    }
  }

  // Execute
  try {
    deps.send({ id: deps.requestId, stream: 'progress', data: {
      message: `Delegate: ${handler.description}...`,
    }});

    const result = await handler.execute(input, deps);

    return {
      index: taskIndex,
      description,
      output: result.output,
      format: result.format,
      success: result.success,
      error: result.error,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ delegateId, error: errMsg }, 'delegate execution failed');
    return {
      index: taskIndex,
      description,
      output: `[Delegate failed] ${errMsg}`,
      format: 'text' as TaskFormat,
      success: false,
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Gate reply helper
// ---------------------------------------------------------------------------

async function waitForGateReply(
  deps: TaskOrchestratorDeps,
  _gateId: string,
): Promise<{ action?: string; feedback?: string } | null> {
  // The controlled pipeline runner handles gate replies via the channel.
  // For delegate tasks within the pipeline, the gate reply comes through
  // the standard gate mechanism. This is a simplified version that
  // returns the reply from the channel's next message.
  const { channel } = deps;
  if (!channel) return { action: 'approve' }; // no channel = auto-approve

  return new Promise((resolve) => {
    // Listen for the next gate reply on the channel
    const timeout = setTimeout(() => resolve({ action: 'approve' }), 60_000); // 60s timeout
    const handler = (msg: unknown) => {
      clearTimeout(timeout);
      const reply = msg as { action?: string; feedback?: string } | undefined;
      resolve(reply ?? { action: 'approve' });
    };
    // Use channel's reply mechanism
    if ('onReply' in channel && typeof channel.onReply === 'function') {
      channel.onReply(handler);
    } else {
      // Fallback: auto-approve after showing the gate
      clearTimeout(timeout);
      resolve({ action: 'approve' });
    }
  });
}
