/**
 * Skill feasibility checks.
 *
 * Walks the skill's preconditions against a runtime context and
 * returns a structured Feasibility decision. A failed precondition
 * does NOT throw -- the runner uses the decision to short-circuit
 * with `confidence: 'low'` and the rejection reasons attached as
 * notes. Skills can choose to still run on a failed precondition by
 * not declaring the precondition in the first place.
 *
 * This is the substrate that the data-analyzer's `meta.feasibility-
 * check` skill (Phase 7.3 of plans/analyzers/data-analyzer-skills.md)
 * exposes as a public skill -- that skill is just a thin wrapper
 * over `assertFeasible` per id.
 *
 * Precondition kinds in scope here mirror the type union in
 * `types.ts`:
 *
 *   min-sample-size      ctx.availableSampleSize must reach n
 *   required-tools       getTool(id) must return a tool for each
 *   connection-family    session has at least one connection in the family
 *   connection-property  session has at least one connection with the property
 *   cross-owner-allowed  marker; passes unless the runner's depth
 *                        accounting separately rejects
 */

import { getTool } from '../tools/registry.js';
import type {
  Feasibility,
  Precondition,
  PreconditionFailure,
  Skill,
  SkillContext,
} from './types.js';

export function assertFeasible(skill: Skill, ctx: SkillContext): Feasibility {
  const preconditions = skill.preconditions ?? [];
  if (preconditions.length === 0) { return { ok: true }; }

  const failures: PreconditionFailure[] = [];
  for (const pre of preconditions) {
    const failure = checkPrecondition(pre, ctx);
    if (failure !== null) { failures.push(failure); }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, reasons: failures };
}

function checkPrecondition(
  pre: Precondition,
  ctx: SkillContext,
): PreconditionFailure | null {
  switch (pre.kind) {
    case 'min-sample-size': {
      const have = ctx.availableSampleSize;
      // null = unknown; treat as passing. Skills wanting strict
      // sample-size enforcement should pair this with a
      // connection-property precondition that REQUIRES the count.
      if (have === undefined || have === null) { return null; }
      if (have >= pre.n) { return null; }
      return {
        precondition: pre,
        detail: `available sample ${have} < required ${pre.n}`,
      };
    }

    case 'required-tools': {
      const missing: string[] = [];
      for (const toolId of pre.tools) {
        if (getTool(toolId) === undefined) { missing.push(toolId); }
      }
      if (missing.length === 0) { return null; }
      return {
        precondition: pre,
        detail: `missing tool registrations: ${missing.join(', ')}`,
      };
    }

    case 'connection-family': {
      // The session exposes its connection registry through the
      // chat-session's data-driver layer; we don't reach into it
      // here because that layer's interface is in flux and binding
      // ourselves to it would constrain refactors. Instead, we ask
      // the session for a flag the data-driver code populates on
      // chat-session creation.
      //
      // For v1 the session.connectionFamilies field may be
      // unset (the data-analyzer is the only caller today and has
      // already handled connection scoping inside its own
      // orchestrator); when unset we pass the precondition. The
      // proper enforcement lands when the data-analyzer-skills
      // plan rewires the orchestrator to populate
      // ctx.session.connectionFamilies before invoking skills.
      const families = readConnectionFamilies(ctx.session);
      if (families === undefined) { return null; }
      if (pre.families.some(f => families.has(f))) { return null; }
      return {
        precondition: pre,
        detail: `no registered connection in families [${pre.families.join(', ')}] (have: [${[...families].join(', ')}])`,
      };
    }

    case 'connection-property': {
      // Same caveat as connection-family.
      const props = readConnectionProperties(ctx.session);
      if (props === undefined) { return null; }
      if (props.has(pre.property)) { return null; }
      return {
        precondition: pre,
        detail: `no connection has property '${pre.property}'`,
      };
    }

    case 'cross-owner-allowed': {
      // Marker precondition; passes here. The depth-accounting check
      // is done by the runner inside runSkill -- this precondition
      // exists so the registry can enforce that cross-owner-calling
      // skills declare their intent.
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Session-side accessors. Tolerant of missing fields so feasibility
// works during the registry's pre-population phase, when the session
// hasn't loaded its connection registry yet.
// ---------------------------------------------------------------------------

function readConnectionFamilies(session: SkillContext['session']): Set<string> | undefined {
  // Avoid a hard import on a session-internal type; runtime check the
  // shape we expect. The data-driver / chat-handler will populate
  // these fields when the data-analyzer-skills plan lands its
  // orchestrator rewire.
  const v = (session as unknown as { connectionFamilies?: Iterable<string> }).connectionFamilies;
  if (v === undefined) { return undefined; }
  return new Set(v);
}

function readConnectionProperties(session: SkillContext['session']): Set<string> | undefined {
  const v = (session as unknown as { connectionProperties?: Iterable<string> }).connectionProperties;
  if (v === undefined) { return undefined; }
  return new Set(v);
}
