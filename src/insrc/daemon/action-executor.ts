/**
 * Action executor — runs decomposed actions in DAG order.
 *
 * Independent actions run in parallel. Dependent actions run sequentially
 * after their dependency completes, with the prior action's output passed
 * as context.
 */

import type { DecomposedAction } from '../agent/decompose.js';
import type { IpcStreamMessage } from '../shared/types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('action-executor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionResult {
  index: number;
  intent: string;
  action: string;
  output: string;
  success: boolean;
}

export type ActionRunner = (
  action: DecomposedAction,
  index: number,
  priorOutput: string | undefined,
  send: (msg: IpcStreamMessage) => void,
  requestId: number,
) => Promise<string>;

// ---------------------------------------------------------------------------
// DAG execution
// ---------------------------------------------------------------------------

/**
 * Execute actions in dependency order.
 *
 * @param actions - Decomposed actions from the classifier
 * @param runner - Callback that executes a single action, returns output text
 * @param send - IPC stream send function for progress
 * @param requestId - Request ID for stream messages
 * @returns Array of results in execution order
 */
export async function executeActions(
  actions: DecomposedAction[],
  runner: ActionRunner,
  send: (msg: IpcStreamMessage) => void,
  requestId: number,
): Promise<ActionResult[]> {
  if (actions.length === 0) return [];

  // Single action — skip DAG overhead
  if (actions.length === 1) {
    const action = actions[0]!;
    send({ id: requestId, stream: 'progress', data: { message: `Action: ${action.action}` } });

    try {
      const output = await runner(action, 0, undefined, send, requestId);
      return [{ index: 0, intent: action.intent, action: action.action, output, success: true }];
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return [{ index: 0, intent: action.intent, action: action.action, output: errMsg, success: false }];
    }
  }

  // Build dependency graph
  const results: ActionResult[] = new Array(actions.length);
  const completed = new Set<number>();
  const pending = new Set(actions.map((_, i) => i));

  log.info({ total: actions.length, deps: actions.filter(a => a.dependsOn !== undefined).length }, 'executing action DAG');

  send({ id: requestId, stream: 'progress', data: {
    message: `Executing ${actions.length} actions${actions.some(a => a.dependsOn !== undefined) ? ' (with dependencies)' : ' (parallel)'}`,
  } });

  while (pending.size > 0) {
    // Find actions whose dependencies are all completed
    const ready: number[] = [];
    for (const idx of pending) {
      const action = actions[idx]!;
      const dep = action.dependsOn;
      if (dep === undefined || completed.has(dep)) {
        ready.push(idx);
      }
    }

    if (ready.length === 0) {
      // Circular dependency or all remaining have unmet deps
      log.error({ pending: [...pending] }, 'deadlock: no ready actions');
      for (const idx of pending) {
        const action = actions[idx]!;
        results[idx] = {
          index: idx,
          intent: action.intent,
          action: action.action,
          output: 'Skipped: unresolvable dependency',
          success: false,
        };
      }
      break;
    }

    // Execute ready actions in parallel
    const promises = ready.map(async (idx) => {
      const action = actions[idx]!;
      const dep = action.dependsOn;
      const priorOutput = dep !== undefined ? results[dep]?.output : undefined;

      send({ id: requestId, stream: 'progress', data: {
        message: `Action ${idx + 1}/${actions.length}: ${action.action}`,
      } });

      try {
        const output = await runner(action, idx, priorOutput, send, requestId);
        results[idx] = { index: idx, intent: action.intent, action: action.action, output, success: true };
        log.info({ idx, intent: action.intent }, 'action completed');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results[idx] = { index: idx, intent: action.intent, action: action.action, output: errMsg, success: false };
        log.error({ idx, intent: action.intent, error: errMsg }, 'action failed');
      }

      completed.add(idx);
      pending.delete(idx);
    });

    await Promise.all(promises);
  }

  return results.filter(Boolean);
}
