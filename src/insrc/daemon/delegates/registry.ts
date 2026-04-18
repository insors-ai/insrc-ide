/**
 * Delegate handler registry.
 *
 * Controllers can delegate work to named handlers (web-search, code-analysis,
 * test-run, etc.). Each handler encapsulates execution logic, approval
 * requirements, and result formatting.
 */

import type { TaskResult, TaskOrchestratorDeps, TaskFormat } from '../task.js';
import type { GateAction, ReplyPayload } from '../../agent/framework/types.js';
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
  /** Fallback approval message when buildApprovalGate is not provided. */
  readonly approvalMessage?: string | undefined;
  /**
   * Build a dynamic approval gate from the current input. Runs before
   * execute() when requiresApproval is true. Lets handlers surface the
   * actual query / parameters to the user and offer an Edit action.
   */
  buildApprovalGate?(input: DelegateInput): { title: string; content: string; actions: GateAction[] };
  /**
   * Apply the user's edit feedback to the input before retrying the gate.
   * Return the modified input. If omitted, edit defaults to replacing
   * input.query with the feedback text.
   */
  applyEdit?(input: DelegateInput, feedback: string): DelegateInput;
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

  // Approval gate loop -- supports approve / skip / edit (re-gate with edited input)
  let effectiveInput = input;
  if (handler.requiresApproval) {
    const reply = await runApprovalGate(handler, effectiveInput, deps);
    if (!reply) {
      return {
        index: taskIndex,
        description,
        output: `[Skipped by user] ${handler.description}`,
        format: 'text' as TaskFormat,
        success: true,
      };
    }
    effectiveInput = reply.input;
  }

  // Execute
  try {
    deps.send({ id: deps.requestId, stream: 'progress', data: {
      message: `Delegate: ${handler.description}...`,
    }});

    const result = await handler.execute(effectiveInput, deps);

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
// Approval gate
// ---------------------------------------------------------------------------

const DEFAULT_APPROVAL_ACTIONS: GateAction[] = [
  { name: 'approve', label: 'Approve' },
  { name: 'skip', label: 'Skip' },
];

/**
 * Drive the approve / skip / edit loop. Returns the approved input, or null
 * if the user skipped. Uses the channel's external-gate registration so the
 * reply flows through the standard chat.reply RPC.
 */
async function runApprovalGate(
  handler: DelegateHandler,
  input: DelegateInput,
  deps: TaskOrchestratorDeps,
): Promise<{ input: DelegateInput } | null> {
  const { channel } = deps;
  if (!channel || typeof channel.registerExternalGate !== 'function') {
    log.warn({ delegateId: handler.id }, 'no channel registerExternalGate -- auto-approving');
    return { input };
  }

  let current = input;
  // Bounded loop to stop pathological edit cycles.
  for (let attempt = 0; attempt < 5; attempt++) {
    const gate = handler.buildApprovalGate
      ? handler.buildApprovalGate(current)
      : {
          title: `Approval: ${handler.description}`,
          content: handler.approvalMessage
            ?? `The agent wants to use: ${handler.description}. Proceed?`,
          actions: DEFAULT_APPROVAL_ACTIONS,
        };

    const gateId = `delegate-${handler.id}-${Date.now()}-${attempt}`;
    deps.send({
      id: deps.requestId,
      stream: 'gate',
      data: {
        gateId,
        title: gate.title,
        content: gate.content,
        actions: gate.actions,
      },
    });

    const reply: ReplyPayload = await new Promise((resolve, reject) => {
      channel.registerExternalGate(gateId, resolve, reject);
    });

    const action = reply.action.toLowerCase();
    if (action === 'approve' || action === 'execute') {
      return { input: current };
    }
    if (action === 'skip' || action === 'reject' || action === 'cancel') {
      log.info({ delegateId: handler.id }, 'delegate skipped by user');
      return null;
    }
    if (action === 'edit' && reply.feedback) {
      const feedback = reply.feedback.trim();
      current = handler.applyEdit
        ? handler.applyEdit(current, feedback)
        : { ...current, query: feedback };
      log.info({ delegateId: handler.id, edited: feedback.slice(0, 80) }, 'delegate input edited');
      continue;
    }
    // Unknown action -- treat as skip to avoid silent execution.
    log.warn({ delegateId: handler.id, action: reply.action }, 'unknown gate action, treating as skip');
    return null;
  }

  log.warn({ delegateId: handler.id }, 'approval gate edit loop exceeded -- skipping');
  return null;
}
