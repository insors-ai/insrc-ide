/**
 * Connection-approval + sample-review gate helpers for the Data Analyzer.
 *
 * Per design §7.3, the data-analyzer fires three gate kinds at three
 * different points where blocking on user input is worth more than
 * the latency cost:
 *
 *   connection-approval    First use of a registered connection in
 *                          this session. Even though the connection
 *                          is registered with the data-driver, the
 *                          analyzer asks before the first
 *                          introspection / sample / scan call.
 *                          Approval is session-scoped, not persistent
 *                          (NOT in K_STATE -- re-prompt on resume).
 *
 *   sample-review          Optional. Fires before returning sample
 *                          rows touching a connection flagged `prod`,
 *                          when the sample crosses a threshold of
 *                          unmasked PII columns. Belt-and-braces
 *                          over the per-connection pii config.
 *
 *   schema-source-mismatch A drift task finds a Prisma schema
 *                          referencing a connection that's not
 *                          registered (or vice versa). Lands in
 *                          Phase 3 alongside the data:schema-drift
 *                          tool; this module reserves the type
 *                          shapes for it but doesn't fire it yet.
 *
 * The gate REQUEST/REPLY shapes + state-tracking helpers live here.
 * The actual fire-and-await logic lives inline in the analyzer
 * runner (mirroring code-analyzer/analyzer/runner.ts's fs-access
 * gate pattern).
 */

import type { BlockedReason } from './types.js';

// ---------------------------------------------------------------------------
// Gate identifiers (shared with the workbench gate widget)
// ---------------------------------------------------------------------------

export const GATE_CONNECTION_APPROVAL = 'connection-approval';
export const GATE_SAMPLE_REVIEW = 'sample-review';
export const GATE_SCHEMA_SOURCE_MISMATCH = 'schema-source-mismatch';

export type GateId =
  | typeof GATE_CONNECTION_APPROVAL
  | typeof GATE_SAMPLE_REVIEW
  | typeof GATE_SCHEMA_SOURCE_MISMATCH;

// ---------------------------------------------------------------------------
// Connection-approval gate
// ---------------------------------------------------------------------------

export interface ConnectionApprovalRequest {
  readonly gateId: typeof GATE_CONNECTION_APPROVAL;
  readonly connectionId: string;
  readonly connectionLabel?: string | undefined;
  readonly family: string;
  readonly kind: string;
  readonly prod: boolean;
  /** What the analyzer wants to do (one-line, e.g. "describe table users"). */
  readonly intent: string;
}

export type ConnectionApprovalReply =
  | { readonly action: 'approve' }    // approve once for the session
  | { readonly action: 'deny' };       // deny -> task blocks with connection-denied

// ---------------------------------------------------------------------------
// Sample-review gate
// ---------------------------------------------------------------------------

export interface SampleReviewRequest {
  readonly gateId: typeof GATE_SAMPLE_REVIEW;
  readonly connectionId: string;
  readonly target: string;             // table / collection
  readonly piiColumns: readonly string[];   // columns matching the PII pattern library
  /** Snapshot of the rows about to be returned, masked or unmasked per per-conn pii config. */
  readonly sampleRows: number;
}

export type SampleReviewReply =
  | { readonly action: 'mask-and-proceed' }
  | { readonly action: 'cancel-task' };

// ---------------------------------------------------------------------------
// Schema-source-mismatch (Phase 3; shape reserved here)
// ---------------------------------------------------------------------------

export interface SchemaSourceMismatchRequest {
  readonly gateId: typeof GATE_SCHEMA_SOURCE_MISMATCH;
  readonly mismatchKind:
    | 'prisma-references-unregistered-connection'
    | 'connection-has-no-static-source';
  readonly detail: string;
}

export type SchemaSourceMismatchReply =
  | { readonly action: 'register-now' }
  | { readonly action: 'continue-without' }
  | { readonly action: 'cancel-task' };

// ---------------------------------------------------------------------------
// Approved-connection tracking (session-scoped, NOT persisted)
// ---------------------------------------------------------------------------

/**
 * Per-session memory of which connection ids the user has approved
 * during this session. Lives in the Session object, NOT in the
 * orchestrator's TaskStateStore -- per design §14, approvals do
 * NOT persist across daemon restart / IDE reopen.
 *
 * The data-analyzer's runner consults / mutates this store via the
 * `isApproved` / `approve` / `deny` helpers below.
 */
export interface ApprovedConnectionsStore {
  isApproved(connectionId: string): boolean;
  approve(connectionId: string): void;
  /** Mark as denied for THIS task only; doesn't poison future tasks. */
  // (deny() is intentionally absent from the persistent store -- a
  // deny only blocks the current task. Future tasks against the same
  // connection should re-prompt; the gate widget gives the user a
  // chance to change their mind.)
}

/**
 * Default in-memory implementation. The Session pool constructs one
 * per session; the data-analyzer orchestrator threads it into deps
 * the runner sees.
 */
export class DefaultApprovedConnectionsStore implements ApprovedConnectionsStore {
  private readonly approved = new Set<string>();

  isApproved(connectionId: string): boolean {
    return this.approved.has(connectionId);
  }

  approve(connectionId: string): void {
    this.approved.add(connectionId);
  }
}

// ---------------------------------------------------------------------------
// Gate-outcome -> blockedReason mapping (used by the runner)
// ---------------------------------------------------------------------------

/**
 * When a gate denies, the runner short-circuits the LLM turn and
 * returns a DataAnalyzerResult with blockedReason set. This helper
 * gives the runner the right reason for a given gate id + reply.
 */
export function blockedReasonForGate(gateId: GateId): BlockedReason {
  switch (gateId) {
    case GATE_CONNECTION_APPROVAL:    return 'connection-denied';
    case GATE_SAMPLE_REVIEW:          return 'pii-gate-denied';
    case GATE_SCHEMA_SOURCE_MISMATCH: return 'connection-denied';
  }
}
