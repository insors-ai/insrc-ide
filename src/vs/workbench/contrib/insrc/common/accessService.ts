/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Browser-side window into the daemon's per-session AccessStore +
 * AuditLog (plans/access-gate.md Phase 5.3). Backs the Approvals pane.
 *
 * Standing approvals (current state):
 *   - exact:  one (kind, key) tuple the user explicitly approved.
 *   - prefix: a kind-prefix that cascades to every descendant key.
 *
 * Audit history (chronological):
 *   - every gate dispatch -- auto-pass, approve, approve-prefix,
 *     deny, auto-deny -- recorded with timestamp + tool + key +
 *     severity. Capped at 1000 events server-side.
 *
 * Approvals are session-scoped; data dies with the session.
 */

export interface AccessApprovalInfo {
	readonly kind: string;
	readonly key: string;
	readonly approvedAt: number;
	readonly prefix: boolean;
}

export type AccessAuditDecision =
	| 'auto-pass'
	| 'approve'
	| 'approve-prefix'
	| 'deny'
	| 'auto-deny';

export interface AccessAuditEventInfo {
	readonly timestamp: number;
	readonly toolId: string;
	readonly kind: string;
	readonly key: string;
	readonly decision: AccessAuditDecision;
	readonly prefix?: string;
	readonly severity: 'standard' | 'destructive';
	readonly description?: string;
}

export interface AccessSnapshot {
	readonly approvals: readonly AccessApprovalInfo[];
	readonly audit: readonly AccessAuditEventInfo[];
}

export interface IInsrcAccessService {
	readonly _serviceBrand: undefined;

	/**
	 * Snapshot the active session's approvals + audit. Returns
	 * `undefined` when no session is active or when the daemon
	 * rejects the call (the pane shows an empty-state in either case).
	 */
	snapshot(sessionId: string): Promise<AccessSnapshot | undefined>;

	/** Revoke an exact (kind, key) approval. Idempotent. */
	revoke(sessionId: string, kind: string, key: string): Promise<void>;

	/** Revoke a prefix-scope approval. Idempotent. */
	revokePrefix(sessionId: string, kind: string, prefix: string): Promise<void>;
}

export const IInsrcAccessService =
	createDecorator<IInsrcAccessService>('insrcAccessService');
