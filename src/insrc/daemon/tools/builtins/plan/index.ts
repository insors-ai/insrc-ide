/**
 * Plan tools -- get / step-update / next-step.
 *
 * Thin adapters over the plan-store DB helpers so the agent can
 * drive multi-step execution without hitting internal IPC.
 */

import { getDb } from '../../../../db/client.js';
import { getPlan, getActivePlan, updateStepState, getNextStep } from '../../../../agent/tasks/plan-store.js';
import { registerTool } from '../../registry.js';
import type { Plan, PlanStep, PlanStepStatus } from '../../../../shared/types.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../../types.js';

function str(input: ToolInput, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function fail(id: string, msg: string): ToolResult {
  return { output: `[${id}] ${msg}`, format: 'text', success: false, error: msg };
}

const VALID_STATUSES: readonly PlanStepStatus[] = ['pending', 'in_progress', 'done', 'failed', 'skipped'];

function isStatus(v: unknown): v is PlanStepStatus {
  return typeof v === 'string' && (VALID_STATUSES as readonly string[]).includes(v);
}

function renderPlan(plan: Plan): string {
  const lines: string[] = [`**Plan** \`${plan.id}\` (repo: \`${plan.repoPath}\`, status: ${plan.status})`];
  if (plan.title) { lines.push(`_${plan.title}_`); }
  for (const step of plan.steps) {
    lines.push(`- [${step.status}] \`${step.id}\` ${step.title}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// plan:get
// ---------------------------------------------------------------------------

interface PlanGetData { plan: Plan | null }

export const planGetTool: Tool = {
  id: 'plan_get',
  description: 'Fetch a plan by ID, or the active plan for a repo (defaults to the session repo).',
  inputSchema: {
    type: 'object',
    properties: {
      planId: { type: 'string', description: 'Plan ID. Mutually exclusive with `repo`.' },
      repo: { type: 'string', description: 'Repo path. Defaults to session repo.' },
    },
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
    const db = await getDb();
    const planId = str(input, 'planId');
    let plan: Plan | null = null;
    if (planId) {
      plan = await getPlan(db, planId);
    } else {
      const repo = str(input, 'repo') ?? deps.session.repoPath;
      if (!repo) { return fail('plan_get', 'repo required (no session repo and no override)'); }
      plan = await getActivePlan(db, repo);
    }
    const data: PlanGetData = { plan };
    if (!plan) {
      return { output: '_no active plan_', format: 'markdown', success: true, data };
    }
    return {
      output: renderPlan(plan),
      format: 'markdown', success: true, data,
    };
  },
};

// ---------------------------------------------------------------------------
// plan_step-update
// ---------------------------------------------------------------------------

interface PlanStepUpdateData {
  stepId: string;
  status: PlanStepStatus;
  note: string | undefined;
  ok: boolean;
  error: string | undefined;
}

export const planStepUpdateTool: Tool = {
  id: 'plan_step-update',
  description: 'Transition a plan step to a new status (pending / in_progress / done / failed / skipped).',
  inputSchema: {
    type: 'object',
    properties: {
      stepId: { type: 'string' },
      status: { type: 'string', enum: [...VALID_STATUSES] },
      note: { type: 'string' },
    },
    required: ['stepId', 'status'],
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput): Promise<ToolResult> {
    const stepId = str(input, 'stepId');
    const status = input['status'];
    if (!stepId) { return fail('plan_step-update', 'stepId required'); }
    if (!isStatus(status)) { return fail('plan_step-update', 'status must be pending / in_progress / done / failed / skipped'); }
    const note = str(input, 'note');
    const db = await getDb();
    const result = await updateStepState(db, stepId, status, note);
    const data: PlanStepUpdateData = {
      stepId, status, note,
      ok: result.ok,
      error: result.error,
    };
    return {
      output: result.ok
        ? `Step \`${stepId}\` -> \`${status}\`${note ? ` _(${note})_` : ''}.`
        : `**Update failed** for step \`${stepId}\`: ${result.error ?? 'unknown error'}.`,
      format: 'markdown',
      success: result.ok,
      ...(result.ok ? {} : { error: result.error ?? 'update failed' }),
      data,
    };
  },
};

// ---------------------------------------------------------------------------
// plan_next-step
// ---------------------------------------------------------------------------

interface PlanNextStepData {
  planId: string;
  step: PlanStep | null;
}

export const planNextStepTool: Tool = {
  id: 'plan_next-step',
  description: 'Return the next unblocked step for a plan (first pending step with all dependencies done).',
  inputSchema: {
    type: 'object',
    properties: {
      planId: { type: 'string' },
    },
    required: ['planId'],
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput): Promise<ToolResult> {
    const planId = str(input, 'planId');
    if (!planId) { return fail('plan_next-step', 'planId required'); }
    const db = await getDb();
    const step = await getNextStep(db, planId);
    const data: PlanNextStepData = { planId, step };
    return {
      output: step
        ? `Next step in \`${planId}\`: \`${step.id}\` -- ${step.title} (${step.status}).`
        : `No unblocked step in plan \`${planId}\`.`,
      format: 'markdown',
      success: true,
      data,
    };
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPlanTools(): void {
  registerTool(planGetTool);
  registerTool(planStepUpdateTool);
  registerTool(planNextStepTool);
}
