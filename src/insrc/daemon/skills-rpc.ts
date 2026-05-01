/**
 * Skill RPCs (plans/analyzers/skills-core.md Phases 2.3 + 7.2).
 *
 * Workbench / CLI -facing window into the skill registry + invoker.
 * Four RPCs:
 *
 *   skill.list         enumerate registered, family-enabled skills
 *   skill.feasibility  preflight a skill against a session without executing
 *   skill.invoke       run a skill via the same runSkill pipeline the
 *                      `skill_invoke` meta-tool uses; returns the full
 *                      SkillResult
 *   skill.audit        snapshot of the session's SkillEvent ring buffer;
 *                      powers the workbench skill-trace panel
 *
 * All RPCs that need a runtime session resolve through chat-handler's
 * `getRunnerSession`; callers must pass an active sessionId. The
 * feasibility RPC tolerates a missing session for "preflight before
 * opening a chat" affordances -- session-side preconditions short-
 * circuit to pass when the session-fields they read are undefined
 * (see feasibility.ts:130-144).
 */

import { getLogger } from '../shared/logger.js';
import type { LLMProvider } from '../shared/types.js';
import { getRunnerSession } from './chat-handler.js';
import { assertFeasible } from './skills/feasibility.js';
import { runSkill } from './skills/invoke.js';
import { getSkill, listSkills } from './skills/registry.js';
import type {
  ProviderAffinity,
  SkillContext,
  SkillEvent,
  SkillOwner,
  SkillResult,
} from './skills/types.js';

const log = getLogger('skill-rpc');

// ---------------------------------------------------------------------------
// skill.list
// ---------------------------------------------------------------------------

interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly family: string;
  readonly owner: string;
  readonly version: number;
  readonly providerAffinity: string;
  readonly toolDeps: readonly string[];
  readonly hasPreconditions: boolean;
}

/**
 * Enumerate every skill the registry's family-gate is currently
 * letting through. The workbench renders these in a "Skills" pane;
 * the CLI uses them for tab-completion. Stable order: skills are
 * returned in registration order (which is topological -- atomics
 * before composites).
 */
export async function listRpc(): Promise<{ skills: SkillSummary[] }> {
  const skills = listSkills().map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    family: s.family,
    owner: s.owner,
    version: s.version,
    providerAffinity: s.providerAffinity,
    toolDeps: s.toolDeps,
    hasPreconditions: (s.preconditions?.length ?? 0) > 0,
  }));
  return { skills };
}

// ---------------------------------------------------------------------------
// skill.feasibility
// ---------------------------------------------------------------------------

interface FeasibilityRequest {
  readonly skillId?: unknown;
  readonly version?: unknown;
  readonly sessionId?: unknown;
  readonly availableSampleSize?: unknown;
}

interface FeasibilityReason {
  readonly kind: string;
  readonly detail: string;
}

/**
 * Preflight a skill against (optionally) an active session. The skill
 * is looked up via the family-gated `getSkill` so a disabled-family
 * skill returns the same "unknown skill" shape as a typo. When a
 * sessionId is provided but doesn't resolve, the caller gets an
 * explicit error -- silent fall-through to a stub session would mask
 * a stale workbench reference.
 *
 * When sessionId is omitted entirely, the caller is preflighting
 * before any chat exists; we pass a stub session and rely on the
 * tolerant readers in feasibility.ts (the connection-* preconditions
 * read fields that are undefined and pass by default).
 */
export async function feasibilityRpc(
  params: FeasibilityRequest,
): Promise<
  | { error: string }
  | { ok: true }
  | { ok: false; reasons: readonly FeasibilityReason[] }
> {
  const skillId = typeof params.skillId === 'string' ? params.skillId : '';
  if (skillId.length === 0) return { error: 'skillId required' };

  const version = typeof params.version === 'number' ? params.version : undefined;
  const skill = getSkill(skillId, version);
  if (skill === undefined) {
    return { error: `skill '${skillId}' not registered or family disabled` };
  }

  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
  let session: ReturnType<typeof getRunnerSession>;
  if (sessionId !== undefined && sessionId.length > 0) {
    session = getRunnerSession(sessionId);
    if (session === undefined) {
      return { error: `session ${sessionId} not found` };
    }
  }

  const ctx: SkillContext = {
    // Cast through unknown: feasibility's session-side readers tolerate
    // undefined fields, and a no-session preflight is intentional. Any
    // precondition that genuinely requires a populated session should
    // declare connection-property and accept the pass-by-default semantics.
    session: (session ?? {}) as unknown as SkillContext['session'],
    ...(typeof params.availableSampleSize === 'number'
      ? { availableSampleSize: params.availableSampleSize }
      : {}),
  };

  const f = assertFeasible(skill, ctx);
  if (f.ok) {
    log.info({ skillId, sessionId, ok: true }, 'feasibility ok');
    return { ok: true };
  }
  const reasons = f.reasons.map(r => ({ kind: r.precondition.kind, detail: r.detail }));
  log.info({ skillId, sessionId, reasons }, 'feasibility failed');
  return { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// skill.invoke
// ---------------------------------------------------------------------------

interface InvokeRequest {
  readonly skillId?: unknown;
  readonly version?: unknown;
  readonly sessionId?: unknown;
  readonly args?: unknown;
  readonly callerOwner?: unknown;
  readonly availableSampleSize?: unknown;
}

interface InvokeResponse extends SkillResult<unknown> {
  readonly skillId: string;
}

const VALID_OWNERS: ReadonlySet<SkillOwner> = new Set([
  'data-analyzer',
  'code-analyzer',
  'deploy-analyzer',
  'test-agent',
  'shared',
]);

function parseCallerOwner(v: unknown): SkillOwner | undefined {
  if (typeof v !== 'string') return undefined;
  return VALID_OWNERS.has(v as SkillOwner) ? (v as SkillOwner) : undefined;
}

/**
 * Run a skill end-to-end against an active session, returning the
 * full SkillResult shape (value + confidence + notes + tool/sub-skill
 * traces). This is the same code path the `skill_invoke` meta-tool
 * uses inside an analyzer's tool loop; the only difference is the
 * provider-resolution glue lives here instead of in ToolDeps. The
 * runner's confidence-clamping + feasibility short-circuit + output-
 * schema validation all apply identically -- callers don't need to
 * re-check.
 *
 * `sessionId` is required (unlike feasibility): a real run needs the
 * session for tool dispatch + the access gate + provider resolution.
 */
export async function invokeRpc(
  params: InvokeRequest,
): Promise<{ error: string } | InvokeResponse> {
  const skillId = typeof params.skillId === 'string' ? params.skillId : '';
  if (skillId.length === 0) return { error: 'skillId required' };

  const args = (params.args ?? {}) as Record<string, unknown>;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { error: 'args must be a JSON object' };
  }

  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  if (sessionId.length === 0) return { error: 'sessionId required for skill.invoke' };

  const session = getRunnerSession(sessionId);
  if (session === undefined) return { error: `session ${sessionId} not found` };

  const version = typeof params.version === 'number' ? params.version : undefined;
  const callerOwner = parseCallerOwner(params.callerOwner);
  const availableSampleSize =
    typeof params.availableSampleSize === 'number' ? params.availableSampleSize : undefined;

  log.info({ skillId, version, sessionId, callerOwner }, 'skill.invoke start');

  const result = await runSkill<Record<string, unknown>, unknown>(
    skillId,
    args,
    {
      session,
      resolveProvider: (affinity: ProviderAffinity): LLMProvider => {
        switch (affinity) {
          case 'local': return session.ollamaProvider;
          case 'cloud': return session.claudeProvider ?? session.ollamaProvider;
          case 'auto':  return session.resolver.resolve('skill', 'default');
        }
      },
    },
    {
      ...(version !== undefined ? { version } : {}),
      ...(callerOwner !== undefined ? { callerOwner } : {}),
      ...(availableSampleSize !== undefined ? { availableSampleSize } : {}),
    },
  );

  log.info(
    {
      skillId,
      confidence: result.confidence,
      toolCalls: result.toolCalls.length,
      hasNotes: (result.notes?.length ?? 0) > 0,
    },
    'skill.invoke complete',
  );

  return { ...result, skillId };
}

// ---------------------------------------------------------------------------
// skill.audit
// ---------------------------------------------------------------------------

interface AuditRequest {
  readonly sessionId?: unknown;
  readonly limit?: unknown;
  readonly skillId?: unknown;
  readonly kind?: unknown;
}

/**
 * Snapshot of the session's SkillEvent ring buffer (Phase 7.2). Read
 * only -- v1 has no revoke / clear via RPC; events roll off the bounded
 * 1000-entry ring as new ones arrive. The workbench's skill-trace panel
 * polls this for the "what skills did this run touch?" view.
 *
 * Optional filters:
 *   - `limit`   -- last N events (default: full buffer)
 *   - `skillId` -- only events for that skill id
 *   - `kind`    -- only events of that telemetry kind
 *
 * Filters compose; we apply skillId / kind first then take the tail.
 */
export async function auditRpc(
  params: AuditRequest,
): Promise<{ error: string } | { events: readonly SkillEvent[] }> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  if (sessionId.length === 0) return { error: 'sessionId required' };

  const session = getRunnerSession(sessionId);
  if (session === undefined) return { error: `session ${sessionId} not found` };

  const skillIdFilter = typeof params.skillId === 'string' && params.skillId.length > 0
    ? params.skillId
    : undefined;
  const kindFilter = typeof params.kind === 'string' && params.kind.length > 0
    ? params.kind
    : undefined;
  const limit = typeof params.limit === 'number' && params.limit > 0
    ? Math.floor(params.limit)
    : undefined;

  let events = session.skillAudit.list();
  if (skillIdFilter !== undefined) {
    events = events.filter(e => 'skillId' in e && e.skillId === skillIdFilter);
  }
  if (kindFilter !== undefined) {
    events = events.filter(e => e.kind === kindFilter);
  }
  if (limit !== undefined && events.length > limit) {
    events = events.slice(-limit);
  }
  return { events };
}
