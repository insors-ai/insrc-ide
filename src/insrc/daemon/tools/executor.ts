/**
 * Unified tool executor.
 *
 * Runs the approval gate (when required), then the tool's execute().
 * Used by the controller task path (kind: 'tool'); the LLM tool-loop
 * bypasses the gate layer and calls tool.execute() directly because
 * the tool-loop's Claude/Haiku validator (agent/tools/validator.ts)
 * handles its own permission checks.
 *
 * Approval flow: Approve / Skip / Edit via
 * channel.registerExternalGate(). Edit loops up to MAX_EDIT_ROUNDS
 * before giving up to avoid pathological back-and-forth.
 */

import { getLogger } from '../../shared/logger.js';
import type { GateAction, ReplyPayload } from '../../agent/framework/types.js';
import { getTool } from './registry.js';
import { getToolSettings } from './config.js';
import type {
  Tool, ToolDeps, ToolInput, ToolResult, ToolApprovalGate,
} from './types.js';

const log = getLogger('tools-executor');

const DEFAULT_APPROVAL_ACTIONS: GateAction[] = [
  { name: 'approve', label: 'Approve' },
  { name: 'skip', label: 'Skip' },
];

// ---------------------------------------------------------------------------
// Public: execute a tool by id
// ---------------------------------------------------------------------------

export async function executeTool(
  toolId: string,
  input: ToolInput,
  deps: ToolDeps,
): Promise<ToolResult> {
  const tool = getTool(toolId);
  if (!tool) {
    log.error({ toolId }, 'unknown tool');
    return {
      output: `Unknown tool: ${toolId}`,
      format: 'text',
      success: false,
      error: `No tool registered for '${toolId}'`,
    };
  }

  log.info({ id: tool.id }, 'executing tool');

  const needsGate = tool.requiresApproval === true
    || (typeof tool.requiresApproval === 'function' && tool.requiresApproval(input));

  let effectiveInput = input;
  if (needsGate) {
    const result = await runApprovalGate(tool, effectiveInput, deps);
    if (!result) {
      return {
        output: `[Skipped by user] ${tool.description}`,
        format: 'text',
        success: true,
      };
    }
    effectiveInput = result.input;
  }

  // Destructive double-confirm: show an additional gate after the
  // normal approval flow when both the tool and the user's settings
  // request it. The in-band confirmation token (confirmBucket /
  // confirmCount / ...) is already checked by execute() -- this is
  // a belt-and-suspenders UI prompt.
  if (tool.destructive === true && getToolSettings().destructive.requireDoubleConfirm) {
    const confirmed = await runDoubleConfirmGate(tool, effectiveInput, deps);
    if (!confirmed) {
      return {
        output: `[Skipped at double-confirm] ${tool.description}`,
        format: 'text',
        success: true,
      };
    }
  }

  try {
    return await tool.execute(effectiveInput, deps);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ id: tool.id, err: errMsg }, 'tool execution failed');
    return {
      output: `[Tool failed] ${errMsg}`,
      format: 'text',
      success: false,
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Approval gate (Approve / Skip / Edit loop via channel.registerExternalGate)
// ---------------------------------------------------------------------------

async function runApprovalGate(
  tool: Tool,
  input: ToolInput,
  deps: ToolDeps,
): Promise<{ input: ToolInput } | null> {
  const { channel } = deps;
  if (!channel || typeof channel.registerExternalGate !== 'function') {
    log.warn({ id: tool.id }, 'no channel registerExternalGate -- auto-approving');
    return { input };
  }

  let current = input;
  const maxRounds = getToolSettings().approval.maxEditRounds;
  for (let attempt = 0; attempt < maxRounds; attempt++) {
    const gate: ToolApprovalGate = tool.buildApprovalGate
      ? await tool.buildApprovalGate(current)
      : {
          title: `Approval: ${tool.description}`,
          content: `The agent wants to run ${tool.id}. Proceed?`,
          actions: DEFAULT_APPROVAL_ACTIONS,
        };

    const gateId = `tool-${tool.id}-${Date.now()}-${attempt}`;
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
      log.info({ id: tool.id }, 'tool skipped by user');
      return null;
    }
    if (action === 'edit' && reply.feedback) {
      const feedback = reply.feedback.trim();
      current = tool.applyEdit
        ? tool.applyEdit(current, feedback)
        : { ...current, query: feedback };
      log.info({ id: tool.id, edited: feedback.slice(0, 80) }, 'tool input edited');
      continue;
    }
    log.warn({ id: tool.id, action: reply.action }, 'unknown gate action -- treating as skip');
    return null;
  }

  log.warn({ id: tool.id }, 'approval gate edit loop exceeded -- skipping');
  return null;
}

// ---------------------------------------------------------------------------
// Destructive double-confirm gate
// ---------------------------------------------------------------------------

async function runDoubleConfirmGate(
  tool: Tool,
  input: ToolInput,
  deps: ToolDeps,
): Promise<boolean> {
  const { channel } = deps;
  if (!channel || typeof channel.registerExternalGate !== 'function') {
    log.warn({ id: tool.id }, 'no channel registerExternalGate -- auto-approving double-confirm');
    return true;
  }
  const gateId = `tool-${tool.id}-doubleconfirm-${Date.now()}`;
  deps.send({
    id: deps.requestId,
    stream: 'gate',
    data: {
      gateId,
      title: `Confirm destructive action: ${tool.id}`,
      content:
        `**This tool performs an irreversible change.**\n\n` +
        `You've already supplied the in-band confirmation, and the normal approval gate is past. ` +
        `Because \`insrc.tools.destructive.requireDoubleConfirm\` is enabled, one more explicit ` +
        `"Yes, do it" is required before \`${tool.id}\` runs.\n\n` +
        `Tool description: ${tool.description}`,
      actions: [
        { name: 'approve', label: 'Yes, run it' },
        { name: 'skip', label: 'Cancel' },
      ],
    },
  });
  // `input` is accepted for symmetry with runApprovalGate; the
  // current double-confirm content doesn't vary on input. Reference
  // it to keep the unused-parameter check quiet.
  void input;
  try {
    const reply: ReplyPayload = await new Promise((resolve, reject) => {
      channel.registerExternalGate(gateId, resolve, reject);
    });
    const action = reply.action.toLowerCase();
    return action === 'approve' || action === 'execute';
  } catch (err) {
    log.warn({ id: tool.id, err: String(err) }, 'double-confirm gate rejected');
    return false;
  }
}
