/**
 * Access-gate RPCs (plans/access-gate.md Phase 5.3).
 *
 * Workbench-facing window into a session's AccessStore + AuditLog so
 * the Approvals pane can render what's been granted, what was asked,
 * and let the user revoke a standing approval.
 *
 * All three RPCs accept `{sessionId}` and return `{error}` when the
 * id doesn't resolve to an active session in the pool. Sessions are
 * disposable, so the data dies with them; there's no persisted view.
 */

import { getActiveSession } from './chat-handler.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('access-rpc');

interface AccessSnapshotRequest {
  readonly sessionId?: unknown;
}

interface AccessRevokeRequest {
  readonly sessionId?: unknown;
  readonly kind?: unknown;
  readonly key?: unknown;
}

interface AccessRevokePrefixRequest {
  readonly sessionId?: unknown;
  readonly kind?: unknown;
  readonly prefix?: unknown;
}

function resolveSession(req: { sessionId?: unknown }) {
  const id = typeof req.sessionId === 'string' ? req.sessionId : '';
  if (id.length === 0) return { error: 'sessionId required' as const };
  const session = getActiveSession(id);
  if (!session) return { error: `session ${id} not found` as const };
  return { session };
}

/**
 * Snapshot: list every standing approval (exact + prefix) plus the
 * chronological audit trail. Both arrays are sorted by approvedAt /
 * timestamp; the workbench is free to slice / filter.
 */
export async function snapshotRpc(
  params: AccessSnapshotRequest,
): Promise<
  | { error: string }
  | {
      approvals: ReadonlyArray<{
        kind: string;
        key: string;
        approvedAt: number;
        prefix: boolean;
      }>;
      audit: ReadonlyArray<{
        timestamp: number;
        toolId: string;
        kind: string;
        key: string;
        decision: string;
        prefix?: string;
        severity: string;
        description?: string;
      }>;
    }
> {
  const r = resolveSession(params);
  if ('error' in r) return { error: r.error };
  const approvals = r.session.access.list().map(a => ({
    kind: a.kind,
    key: a.key,
    approvedAt: a.approvedAt,
    prefix: a.prefix,
  }));
  const audit = r.session.accessAudit.list().map(e => ({
    timestamp: e.timestamp,
    toolId: e.toolId,
    kind: e.kind,
    key: e.key,
    decision: e.decision,
    ...(e.prefix !== undefined ? { prefix: e.prefix } : {}),
    severity: e.severity,
    ...(e.description !== undefined ? { description: e.description } : {}),
  }));
  return { approvals, audit };
}

/**
 * Revoke an exact-match approval. The dispatcher will re-prompt next
 * time the same (kind, key) is requested. Idempotent: revoking an
 * unknown key still returns ok.
 */
export async function revokeRpc(
  params: AccessRevokeRequest,
): Promise<{ error: string } | { ok: true }> {
  const r = resolveSession(params);
  if ('error' in r) return { error: r.error };
  const kind = typeof params.kind === 'string' ? params.kind : '';
  const key = typeof params.key === 'string' ? params.key : '';
  if (kind.length === 0 || key.length === 0) {
    return { error: 'kind and key required' };
  }
  r.session.access.revoke(kind, key);
  log.info({ sessionId: r.session.id, kind, key }, 'access.revoke');
  return { ok: true };
}

/**
 * Revoke a prefix-scope approval (the cascading-grant version).
 * Stored under the `<kind>-prefix` companion bucket; this method
 * routes through AccessStore.revokePrefix so callers don't have to
 * know the suffix convention.
 */
export async function revokePrefixRpc(
  params: AccessRevokePrefixRequest,
): Promise<{ error: string } | { ok: true }> {
  const r = resolveSession(params);
  if ('error' in r) return { error: r.error };
  const kind = typeof params.kind === 'string' ? params.kind : '';
  const prefix = typeof params.prefix === 'string' ? params.prefix : '';
  if (kind.length === 0 || prefix.length === 0) {
    return { error: 'kind and prefix required' };
  }
  r.session.access.revokePrefix(kind, prefix);
  log.info({ sessionId: r.session.id, kind, prefix }, 'access.revokePrefix');
  return { ok: true };
}
