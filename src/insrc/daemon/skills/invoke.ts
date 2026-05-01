/**
 * runSkill -- the single entry point for invoking a registered skill.
 *
 * Pipeline (top-to-bottom; any failure short-circuits):
 *
 *   1. Lookup. `getSkill` returns undefined when the skill is
 *      missing OR its family is settings-gated off; both surface as
 *      `unknown-skill` rejections.
 *   2. Input validation. The skill's declared input JSON Schema is
 *      checked. Mismatch -> `invalid-input` rejection.
 *   3. Depth accounting. Bumps `_skillDepth`; a cross-owner call
 *      adds an extra increment (`shared` callees exempt). Beyond
 *      the cap (4) the skill returns confidence: 'low' with a
 *      `cross-skill-depth-exceeded` note.
 *   4. Feasibility. Walks preconditions; on failure short-circuits
 *      with confidence: 'low' and the failure detail in `notes`.
 *      `execute()` is NOT called.
 *   5. Execute. Runs the skill body with the captured deps. Any
 *      thrown error is caught and translated to confidence: 'low'
 *      plus an `execute-threw` note; never re-thrown.
 *   6. Output validation. The result's `value` is checked against
 *      the declared output schema. Mismatch is a registry-contract
 *      violation: confidence is clamped to 'low' and the validator
 *      detail surfaces in `notes`.
 *   7. Confidence calibration. Clamped DOWN (never up) based on:
 *        - any tool-call error in the trace -> ceiling 'medium'
 *        - majority of tool calls errored -> ceiling 'low'
 *        - any sub-skill returning 'low' -> ceiling 'low'
 *        - feasibility failures present -> ceiling 'low'
 *      The skill's own claimed confidence is the upper bound. This
 *      is the lever that fixed the hallucinated-class incident
 *      from 2026-04-30 (where the analyzer claimed `high` on a
 *      result built from one surviving tool call).
 */

import { getLogger } from '../../shared/logger.js';
import type { IpcStreamMessage, LLMProvider, ToolCall } from '../../shared/types.js';
import { executeTool } from '../../agent/tools/executor.js';
import type { DaemonChannel } from '../channel.js';
import { getSkill } from './registry.js';
import { assertFeasible } from './feasibility.js';
import { validate } from './json-schema.js';
import type {
  ProviderAffinity,
  RunSkillOpts,
  Skill,
  SkillConfidence,
  SkillContext,
  SkillDeps,
  SkillEvent,
  SkillResult,
  SkillSubSkillSummary,
  SkillToolCallSummary,
  SkillToolResult,
} from './types.js';
import { SkillInvocationError } from './types.js';
import type { Session } from '../../agent/session.js';

const log = getLogger('skills');

const MAX_SKILL_DEPTH = 4;

const CONFIDENCE_RANK: Record<SkillConfidence, number> = {
  high: 2,
  medium: 1,
  low: 0,
};

/**
 * Bundle the runner needs from the calling agent. Mirrors the small
 * subset of `ToolExecContext` skills actually use; we don't expose
 * the full tool-context surface to skill bodies because reaching past
 * `runTool` into tool internals is the kind of leak the layering is
 * meant to prevent.
 */
export interface SkillRunnerToolCtx {
  readonly send?: ((msg: IpcStreamMessage) => void) | undefined;
  readonly channel?: DaemonChannel | undefined;
  readonly requestId?: number | undefined;
}

export interface SkillRunnerDeps {
  readonly session: Session;
  /** Resolves the LLM provider for the skill's affinity. */
  readonly resolveProvider: (affinity: ProviderAffinity) => LLMProvider;
  /** Forwarded to executeTool so the access gate / tool-error gate fire correctly. */
  readonly toolExecCtx?: SkillRunnerToolCtx | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function runSkill<I = unknown, O = unknown>(
  id: string,
  input: I,
  runnerDeps: SkillRunnerDeps,
  opts?: RunSkillOpts,
): Promise<SkillResult<O>> {
  const startedAt = Date.now();
  const depth = (opts?.skillDepth ?? 0);
  const callerOwner = opts?.callerOwner;

  // 1. Lookup.
  const skill = getSkill(id, opts?.version);
  if (skill === undefined) {
    log.warn({ id, version: opts?.version }, 'runSkill: unknown-skill');
    return rejectAsLow<O>('unknown-skill', `skill '${id}' not registered or family disabled`);
  }

  // 2. Depth check (cross-owner adds an extra increment unless callee is shared).
  const newDepth = computeNextDepth(depth, callerOwner, skill.owner);
  if (newDepth > MAX_SKILL_DEPTH) {
    log.warn({ id, depth, newDepth }, 'runSkill: depth cap exceeded');
    return {
      value: nullValueFor<O>(),
      confidence: 'low',
      notes: [
        `skill-depth ${newDepth} exceeds cap ${MAX_SKILL_DEPTH}; halting recursion before execute()`,
      ],
      toolCalls: [],
    };
  }

  // 3. Input validation.
  const inputCheck = validate(input as unknown, skill.inputs);
  if (!inputCheck.ok) {
    log.warn({ id, errors: inputCheck.errors }, 'runSkill: invalid-input');
    return rejectAsLow<O>('invalid-input', `input validation failed: ${inputCheck.errors.join('; ')}`);
  }

  // 4. Telemetry: skill-start.
  const inputDigest = digestInput(input);
  emit({
    kind: 'skill-start',
    skillId: id,
    version: skill.version,
    inputDigest,
    depth: newDepth,
  });

  // 5. Feasibility.
  const ctx: SkillContext = {
    session: runnerDeps.session,
    ...(opts?.availableSampleSize !== undefined ? { availableSampleSize: opts.availableSampleSize } : {}),
    ...(callerOwner !== undefined ? { callerOwner } : {}),
    skillDepth: newDepth,
  };
  const feasibility = assertFeasible(skill, ctx);
  if (!feasibility.ok) {
    const reasons = feasibility.reasons.map(r => `${r.precondition.kind}: ${r.detail}`);
    emit({ kind: 'skill-feasibility', skillId: id, ok: false, reasons });
    log.info({ id, reasons }, 'runSkill: feasibility-failed');
    emit({
      kind: 'skill-end',
      skillId: id,
      confidence: 'low',
      durationMs: Date.now() - startedAt,
    });
    return {
      value: nullValueFor<O>(),
      confidence: 'low',
      notes: ['precondition-failed: ' + reasons.join('; ')],
      toolCalls: [],
    };
  }
  emit({ kind: 'skill-feasibility', skillId: id, ok: true });

  // 6. Build skill-side deps. runSkill captures the depth + caller for
  //    sub-skill calls so the chain accumulates correctly.
  const toolCallTrace: SkillToolCallSummary[] = [];
  const subSkillTrace: SkillSubSkillSummary[] = [];

  const childRunner = async <CI, CO>(
    childId: string,
    childInput: CI,
    childOpts?: RunSkillOpts,
  ): Promise<SkillResult<CO>> => {
    emit({ kind: 'skill-sub-skill', parentId: id, childId, depth: newDepth + 1 });
    const childResult = await runSkill<CI, CO>(childId, childInput, runnerDeps, {
      ...(childOpts ?? {}),
      skillDepth: newDepth,
      callerOwner: skill.owner,
    });
    subSkillTrace.push({
      skillId: childId,
      version: childOpts?.version ?? 0,    // 0 = "latest"; specific version recorded by sub-runSkill in its own audit
      confidence: childResult.confidence,
      durationMs: 0,    // duration is recorded by the child's skill-end event
    });
    return childResult;
  };

  const skillDeps: SkillDeps = {
    session: runnerDeps.session,
    runSkill: childRunner,
    runTool: async (call) => runToolForSkill(id, call, runnerDeps, toolCallTrace, emit),
    resolveProvider: () => runnerDeps.resolveProvider(skill.providerAffinity),
    emit,
    ...(runnerDeps.signal !== undefined ? { signal: runnerDeps.signal } : {}),
  };

  // 7. Execute.
  let bodyResult: SkillResult<O>;
  try {
    bodyResult = await skill.execute(input, skillDeps) as SkillResult<O>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ kind: 'skill-error', skillId: id, error: msg });
    log.warn({ id, err: msg }, 'runSkill: execute threw');
    const errNotes: string[] = [`execute-threw: ${msg}`];
    // Phase 5.2: even when execute() threw, surface over-budget so a
    // skill that hung for minutes before throwing is visible in the
    // trace -- the no-walltime-caps rule applies to enforcement, not
    // to observability.
    checkSoftBudget(skill, startedAt, errNotes, emit);
    emit({
      kind: 'skill-end',
      skillId: id,
      confidence: 'low',
      durationMs: Date.now() - startedAt,
    });
    return {
      value: nullValueFor<O>(),
      confidence: 'low',
      notes: errNotes,
      toolCalls: toolCallTrace,
      ...(subSkillTrace.length > 0 ? { subSkillCalls: subSkillTrace } : {}),
    };
  }

  // 8. Output validation. Clamps to low on failure but doesn't drop
  //    the value -- callers may still find it useful, especially
  //    during skill-development iteration.
  const notes: string[] = [...(bodyResult.notes ?? [])];
  let outputClampToLow = false;
  const outputCheck = validate(bodyResult.value, skill.outputs);
  if (!outputCheck.ok) {
    log.warn({ id, errors: outputCheck.errors }, 'runSkill: invalid-output');
    notes.push(`invalid-output: ${outputCheck.errors.join('; ')}`);
    outputClampToLow = true;
  }

  // 9. Confidence calibration.
  let calibrated = bodyResult.confidence;
  // Authoritative trace = body trace + runner-side trace.
  const fullToolCalls = mergeToolCalls(bodyResult.toolCalls, toolCallTrace);
  const fullSubSkills = mergeSubSkills(bodyResult.subSkillCalls, subSkillTrace);

  const errorRatio = computeErrorRatio(fullToolCalls);
  if (errorRatio >= 0.5) {
    calibrated = clampDown(calibrated, 'low');
    notes.push(`tool-error ratio ${(errorRatio * 100).toFixed(0)}% >= 50%; confidence clamped to low`);
  } else if (errorRatio > 0) {
    calibrated = clampDown(calibrated, 'medium');
    notes.push(`one or more tool calls errored; confidence clamped to medium`);
  }
  for (const sub of fullSubSkills) {
    if (sub.confidence === 'low') {
      calibrated = clampDown(calibrated, 'low');
      notes.push(`sub-skill ${sub.skillId} returned low confidence; clamped to low`);
      break;
    }
  }
  if (outputClampToLow) {
    calibrated = clampDown(calibrated, 'low');
  }

  // Phase 5.2: soft-budget telemetry. Telemetry-only -- the skill has
  // already completed; we never abort. Emits skill-over-budget event
  // and pushes a caller-visible note when elapsed exceeds the
  // declared softBudgetMs.
  checkSoftBudget(skill, startedAt, notes, emit);

  emit({
    kind: 'skill-end',
    skillId: id,
    confidence: calibrated,
    durationMs: Date.now() - startedAt,
  });

  return {
    value: bodyResult.value,
    confidence: calibrated,
    ...(notes.length > 0 ? { notes } : {}),
    toolCalls: fullToolCalls,
    ...(fullSubSkills.length > 0 ? { subSkillCalls: fullSubSkills } : {}),
    ...(bodyResult.truncated ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool dispatch within a skill body
// ---------------------------------------------------------------------------

async function runToolForSkill(
  skillId: string,
  call: ToolCall,
  runnerDeps: SkillRunnerDeps,
  trace: SkillToolCallSummary[],
  emit: (e: SkillEvent) => void,
): Promise<SkillToolResult> {
  const t0 = Date.now();
  const exec = runnerDeps.toolExecCtx ?? {};
  const result = await executeTool(call, {
    session: runnerDeps.session,
    ...(exec.send !== undefined ? { send: exec.send } : {}),
    ...(exec.channel !== undefined ? { channel: exec.channel } : {}),
    ...(exec.requestId !== undefined ? { requestId: exec.requestId } : {}),
    ...(runnerDeps.signal !== undefined ? { signal: runnerDeps.signal } : {}),
  });
  const durationMs = Date.now() - t0;
  const summary: SkillToolCallSummary = {
    toolId: call.name,
    durationMs,
    ...(result.isError ? { error: result.content.slice(0, 200) } : {}),
  };
  trace.push(summary);
  emit({
    kind: 'skill-tool-call',
    skillId,
    toolId: call.name,
    durationMs,
    ...(result.isError ? { error: result.content.slice(0, 200) } : {}),
  });
  return {
    content: result.content,
    isError: result.isError === true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeNextDepth(
  current: number,
  callerOwner: Skill['owner'] | undefined,
  calleeOwner: Skill['owner'],
): number {
  // A cross-owner call adds an extra increment unless the callee is
  // `shared`. callerOwner undefined = top-level entry; treat as
  // matching (no extra increment).
  if (callerOwner === undefined) { return current + 1; }
  if (calleeOwner === 'shared') { return current + 1; }
  if (callerOwner === calleeOwner) { return current + 1; }
  return current + 2;
}

function clampDown(actual: SkillConfidence, ceiling: SkillConfidence): SkillConfidence {
  return CONFIDENCE_RANK[actual] <= CONFIDENCE_RANK[ceiling] ? actual : ceiling;
}

/**
 * Phase 5.2: soft-budget enforcement.
 *
 * Skills declare an optional `softBudgetMs` -- a wall-clock guideline,
 * NOT a hard timeout (the no-walltime-caps lesson from the code-
 * analyzer rollout: skills should not abort themselves on time). When
 * elapsed exceeds the budget we:
 *
 *   1. emit a `skill-over-budget` telemetry event so downstream
 *      consumers (the meta.feasibility-check rollup, the workbench
 *      skill-trace panel) can flag persistently-slow skills, and
 *   2. push a human-readable note to the SkillResult so the calling
 *      agent / user can see the overshoot inline.
 *
 * Skills without a softBudgetMs are skipped; budgets are opt-in.
 */
function checkSoftBudget(
  skill: Skill,
  startedAt: number,
  notes: string[],
  emit: (e: SkillEvent) => void,
): void {
  if (skill.softBudgetMs === undefined) { return; }
  const durationMs = Date.now() - startedAt;
  if (durationMs <= skill.softBudgetMs) { return; }
  const overshootPct = Math.round(((durationMs / skill.softBudgetMs) - 1) * 100);
  emit({
    kind: 'skill-over-budget',
    skillId: skill.id,
    durationMs,
    budgetMs: skill.softBudgetMs,
  });
  notes.push(
    `over soft budget: ${durationMs}ms vs ${skill.softBudgetMs}ms (+${overshootPct}%)`,
  );
}

function computeErrorRatio(calls: readonly SkillToolCallSummary[]): number {
  if (calls.length === 0) { return 0; }
  let errors = 0;
  for (const c of calls) {
    if (c.error !== undefined) { errors++; }
  }
  return errors / calls.length;
}

function mergeToolCalls(
  bodyTrace: readonly SkillToolCallSummary[],
  runnerTrace: readonly SkillToolCallSummary[],
): SkillToolCallSummary[] {
  // The runner-recorded trace is authoritative -- the body trace is a
  // hint the skill body MAY supply. If both are present, prefer the
  // runner-recorded (length-and-content) but include any body-only
  // entries so a skill that records pseudo-calls (e.g. "consulted
  // cache") doesn't lose them.
  if (bodyTrace.length === 0) { return [...runnerTrace]; }
  if (runnerTrace.length === 0) { return [...bodyTrace]; }
  return [...runnerTrace, ...bodyTrace];
}

function mergeSubSkills(
  bodyTrace: readonly SkillSubSkillSummary[] | undefined,
  runnerTrace: readonly SkillSubSkillSummary[],
): SkillSubSkillSummary[] {
  if (bodyTrace === undefined || bodyTrace.length === 0) { return [...runnerTrace]; }
  if (runnerTrace.length === 0) { return [...bodyTrace]; }
  return [...runnerTrace, ...bodyTrace];
}

function digestInput(input: unknown): string {
  // Cheap stable digest -- 32-bit FNV over canonical JSON. Used for
  // telemetry only; not security-relevant.
  const canonical = JSON.stringify(input, sortKeys);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function sortKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return value; }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return sorted;
}

function rejectAsLow<O>(
  reason: import('./types.js').SkillRejectReason,
  message: string,
): SkillResult<O> {
  return {
    value: nullValueFor<O>(),
    confidence: 'low',
    notes: [`${reason}: ${message}`],
    toolCalls: [],
  };
}

function nullValueFor<O>(): O {
  // Skills that fail before execute() runs need a value to fill the
  // SkillResult.value field. We return an empty object cast to O;
  // callers downstream of a low-confidence result should consult
  // confidence + notes before reading value.
  return {} as O;
}

// ---------------------------------------------------------------------------
// Telemetry emit
// ---------------------------------------------------------------------------

/**
 * Module-level telemetry sink. Logs structured events at info level
 * so they show up in `module: 'skills'` lines in the daemon log. The
 * audit ring buffer (Phase 7.2 of skills-core) plugs in here in a
 * follow-up commit -- when it lands, it taps this same emit and
 * keeps a per-session window.
 */
function emit(event: SkillEvent): void {
  log.info(event, `skill-event:${event.kind}`);
}

// ---------------------------------------------------------------------------
// Public re-exports for callers
// ---------------------------------------------------------------------------

export { SkillInvocationError };
