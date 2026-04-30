/**
 * LLM tool-call executor.
 *
 * Dispatches every LLM tool call through the unified registry.
 * Each tool has one implementation shared between the LLM path
 * (this file) and the controller task path (kind: 'tool').
 *
 * The LLM path bypasses the unified approval gate because the
 * validator layer in agent/tools/validator.ts already handles
 * permissioning via a separate Claude/Haiku pre-check.
 */

import type { ToolCall, ToolResult, IpcStreamMessage } from '../../shared/types.js';
import type { Session } from '../session.js';
import { getTool as getUnifiedTool } from '../../daemon/tools/registry.js';
import { translateAliasInput } from '../../daemon/tools/builtins/llm-aliases.js';
import type { Tool, ToolDeps, ToolResult as UnifiedToolResult } from '../../daemon/tools/types.js';
import { getDb } from '../../db/client.js';
import { makeTodosApi } from '../../daemon/todos-api.js';
import type { TodosApi } from '../../shared/todos.js';
import type { AccessPolicy, AccessPolicyContext } from '../../shared/access.js';
import type { DaemonChannel } from '../../daemon/channel.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('tools-executor');

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
  /**
   * IPC send function used to emit gate events for the universal
   * access gate (plans/access-gate.md Phase 2). Required for the
   * dispatcher to fire a user prompt on an access-store miss; when
   * absent, the dispatcher fails closed and denies the call. Tests
   * that drive executeTool directly should either supply a
   * PermissiveAccessStore on the session OR omit access from the
   * tool under test.
   */
  send?: ((msg: IpcStreamMessage) => void) | undefined;
  /** Channel used to await gate replies via registerExternalGate. */
  channel?: DaemonChannel | undefined;
  /** Stream id to stamp on emitted gate events. */
  requestId?: number | undefined;
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

  // Universal access gate (plans/access-gate.md Phase 2). Tools that
  // declare an `access` policy route through Session.access here:
  // approved keys bypass; unapproved fire a gate UI; destructive ops
  // re-fire even when previously approved. Tools without `access`
  // (internal-config reads, discovery calls) skip this branch.
  if (tool.access !== undefined && context !== undefined) {
    const decision = await checkAccess(tool, call.input, context);
    if (!decision.allowed) {
      return {
        toolCallId: call.id,
        content: `[error] ACCESS_DENIED: ${decision.reason}`,
        isError: true,
      };
    }
  }

  const deps = await buildDeps(context);
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
// Access-gate dispatcher (Phase 2 of plans/access-gate.md)
// ---------------------------------------------------------------------------

/**
 * Check the tool's access policy against the session's AccessStore.
 * Pre-approved keys bypass silently; unapproved ones fire a gate UI;
 * destructive policies always fire even on prior approval.
 *
 * Returns `{ allowed: true }` when ALL extracted keys cleared. Any
 * deny aborts (collects all denials for non-destructive; aborts on
 * first deny for destructive to avoid asking about more keys when
 * the call is already going to fail).
 */
async function checkAccess(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const policy = tool.access!;
  const policyCtx: AccessPolicyContext = {
    repoPath: ctx.session?.repoPath,
  };

  let raw: string | readonly string[] | undefined;
  try {
    raw = await Promise.resolve(policy.extractKey(input, policyCtx));
  } catch (err) {
    log.warn({ err: (err as Error).message, tool: tool.id }, 'access policy extractKey threw; allowing');
    return { allowed: true };
  }
  if (raw === undefined) return { allowed: true };
  const keys = Array.isArray(raw) ? raw : [raw as string];
  if (keys.length === 0) return { allowed: true };

  if (ctx.session === undefined) {
    // No session = no AccessStore. Test harness path; the tool runs
    // ungated. Production callers always plumb a session through.
    return { allowed: true };
  }

  const store = ctx.session.access;
  const isDestructive = policy.severity === 'destructive';

  const denials: string[] = [];
  for (const key of keys) {
    // Destructive ops bypass the previously-approved fast path -- the
    // user must explicitly re-approve every call. Read approvals
    // never auto-promote to writes.
    if (!isDestructive && store.isApproved(policy.kind, key)) {
      continue;
    }
    const reply = await fireAccessGate(ctx, tool, policy, input, key, isDestructive);
    if (reply.action === 'approve') {
      // Don't store destructive approvals -- next call must re-prompt.
      if (!isDestructive) {
        store.approve(policy.kind, key);
      }
      continue;
    }
    if (reply.action === 'approve-prefix' && typeof reply.prefix === 'string' && reply.prefix.length > 0) {
      store.approvePrefix(policy.kind, reply.prefix);
      continue;
    }
    denials.push(key);
    if (isDestructive) break;   // no point asking about further keys
  }

  if (denials.length > 0) {
    return {
      allowed: false,
      reason: `user denied access to ${policy.kind} \`${denials.join('\`, \`')}\``,
    };
  }
  return { allowed: true };
}

interface GateReply {
  readonly action: string;
  readonly prefix?: string;
}

/**
 * Emit a gate stream event and await the user's reply. Standardised
 * copy + actions per plans/access-gate.md "UX flows".
 *
 * Fails closed (returns deny) when ctx.send / ctx.channel /
 * ctx.requestId are missing -- the dispatcher can't surface the
 * gate UI without them, and silently allowing the call would defeat
 * the security boundary.
 */
async function fireAccessGate(
  ctx: ToolExecContext,
  tool: Tool,
  policy: AccessPolicy,
  input: Record<string, unknown>,
  key: string,
  isDestructive: boolean,
): Promise<GateReply> {
  if (ctx.send === undefined || ctx.channel === undefined || ctx.requestId === undefined) {
    log.warn(
      { tool: tool.id, kind: policy.kind, key },
      'fireAccessGate: ctx missing send/channel/requestId; failing closed',
    );
    return { action: 'deny' };
  }

  const gateId = `access-${tool.id}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const description = policy.describe ? policy.describe(input) : `${tool.id} on \`${key}\``;
  const titleVerb = verbForKind(policy.kind, isDestructive);
  const title = isDestructive ? `⚠ ${titleVerb}` : titleVerb;

  const contentLines: string[] = [];
  if (isDestructive) {
    contentLines.push('**Destructive operation.**', '');
  }
  contentLines.push(description);
  contentLines.push('');
  contentLines.push(
    isDestructive
      ? 'This may be irreversible. Each call re-prompts; previous approvals do not carry over.'
      : 'Approval is session-scoped; re-prompts after IDE restart.',
  );

  const actions: { name: string; label: string; prefix?: string }[] = [
    {
      name: 'approve',
      label: isDestructive ? 'Approve once' : `Approve \`${truncateForLabel(key)}\``,
    },
  ];

  // Phase 5 of plans/access-gate.md: offer an "Approve scope" action
  // for kinds where a prefix grant is materially useful (the user
  // clears every descendant in one click). Skip for destructive ops
  // -- prefix-grants don't bypass destructive-severity, and offering
  // them on rm/delete/terminate would mislead the user. Skip kinds
  // where a prefix isn't meaningful (connection ids are atomic;
  // shell commands are always destructive).
  if (!isDestructive) {
    const prefix = inferPrefixForGate(policy.kind, key);
    if (prefix !== undefined && prefix.length > 0 && prefix !== key) {
      actions.push({
        name: 'approve-prefix',
        label: `Approve scope \`${truncateForLabel(prefix)}\``,
        prefix,
      });
    }
  }

  actions.push({ name: 'deny', label: 'Deny' });

  ctx.send({
    id: ctx.requestId,
    stream: 'gate',
    data: {
      gateId,
      title,
      content: contentLines.join('\n'),
      format: 'markdown',
      actions,
    },
  });

  const channel = ctx.channel;
  try {
    return await new Promise<GateReply>((resolve, reject) => {
      channel.registerExternalGate(
        gateId,
        (reply) => resolve({ action: reply.action, ...(reply.prefix !== undefined ? { prefix: reply.prefix } : {}) }),
        reject,
      );
    });
  } catch {
    return { action: 'deny' };
  }
}

/**
 * Compute a sensible prefix to offer for an "Approve scope" gate
 * action (Phase 5 of plans/access-gate.md). Returns undefined when no
 * useful prefix exists for this kind/key.
 *
 *   - fs-path:        the parent directory (covers every sibling /
 *                     descendant file). DefaultAccessStore auto-appends
 *                     `/` so we don't risk `/var/log` matching
 *                     `/var/log_archive/`.
 *   - cloud-resource: the provider+scope segment of the key. Cloud
 *                     keys are shaped `aws:profile=p,region=r:ec2:i-X`
 *                     so the scope is everything up to and including
 *                     the second `:`. Approving that covers every
 *                     resource (ec2, s3, lambda, ...) in the same
 *                     profile/region for the rest of the session.
 *
 * Returns undefined for kinds without a meaningful prefix shape:
 *   - connection: ids are atomic; no parent.
 *   - shell-command: always destructive (caller skips the prefix
 *                    branch); no parent shell-command anyway.
 *   - network-host: a future kind; FQDN slicing isn't well-defined.
 */
function inferPrefixForGate(kind: string, key: string): string | undefined {
  if (kind === 'fs-path') {
    const lastSep = Math.max(key.lastIndexOf('/'), key.lastIndexOf('\\'));
    if (lastSep <= 0) return undefined;          // root path; no parent
    return key.slice(0, lastSep);                 // store auto-appends '/'
  }
  if (kind === 'cloud-resource') {
    // Find the second `:`; everything up to and including it is the
    // provider+scope marker.
    const first = key.indexOf(':');
    if (first === -1) return undefined;
    const second = key.indexOf(':', first + 1);
    if (second === -1) return undefined;
    return key.slice(0, second + 1);              // include the trailing ':'
  }
  return undefined;
}

function verbForKind(kind: string, destructive: boolean): string {
  if (destructive) return 'Destructive operation';
  switch (kind) {
    case 'connection':         return 'Approve connection use';
    case 'fs-path':            return 'Approve filesystem access';
    case 'fs-path-prefix':     return 'Approve filesystem scope';
    case 'cloud-resource':     return 'Approve cloud resource use';
    case 'shell-command':      return 'Approve shell command';
    case 'network-host':       return 'Approve network access';
    default:                   return `Approve ${kind}`;
  }
}

function truncateForLabel(s: string, max = 40): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

async function buildDeps(ctx: ToolExecContext | undefined): Promise<ToolDeps> {
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

  // Pre-build a TodosApi scoped to `'chat'`. The LLM tool-loop isn't
  // tied to a specific agent family -- it's the generic chat turn's
  // tool-call path -- so 'chat' is the right owner for any TODO items
  // tools write here. Agent controllers run tools through the
  // controller task path (daemon/task.ts) where a family-scoped
  // TodosApi is already plumbed through.
  let todos: TodosApi | undefined;
  if (ctx?.session !== undefined) {
    try {
      const db = await getDb();
      todos = makeTodosApi(db, 'chat');
    } catch {
      // DB unavailable (tests, degraded mode) -- tools that need
      // `todos` will fall through to their own handling.
      todos = undefined;
    }
  }

  return {
    session,
    send,
    requestId: 0,
    ...(ctx?.signal ? { signal: ctx.signal } : {}),
    ...(todos !== undefined ? { todos } : {}),
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
