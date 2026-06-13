/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Session-token issue + validate.
 *
 * Each handoff spawn (Phase 2a) issues a short-lived token scoped to a
 * single `sessionId`. The token is presented by the external agent
 * (via the `INSRC_SESSION_TOKEN` env var of the spawned process,
 * forwarded to the MCP server subprocess) to invoke session-scoped
 * tools (`insrc_artifact_*`, `insrc_spec_*`).
 *
 * Global tools (`insrc_entity_*`, `insrc_memory_*`, `insrc_repo_*`)
 * ignore the token entirely.
 *
 * Phase 1 (this file): minimal in-memory token store with
 * issue/validate primitives. Wiring to the handoff spawn pipeline is
 * Phase 2a; until then issuance is unused in production paths.
 *
 * Tokens are intentionally NOT cryptographic: this is a same-host
 * isolation token, not an auth bearer. The MCP server runs inside the
 * user's own process tree; a leaked token only gives access to the
 * user's own session artifacts.
 */

import { randomBytes } from 'node:crypto';

/** Default token TTL -- 1 hour (per design §7.2). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface IssuedToken {
	readonly token:     string;
	readonly sessionId: string;
	readonly expiresAt: number;
}

const TOKEN_STORE: Map<string, IssuedToken> = new Map();

export interface IssueOpts {
	/** Override the default TTL (1h). */
	readonly ttlMs?: number;
}

/**
 * Issue a fresh session token bound to `sessionId`.
 *
 * Returns the opaque token string. Caller is responsible for
 * propagating it to the external agent via INSRC_SESSION_TOKEN.
 */
export function issueSessionToken(sessionId: string, opts: IssueOpts = {}): string {
	if (sessionId.length === 0) {
		throw new Error('issueSessionToken: sessionId must be non-empty');
	}
	const token     = randomBytes(24).toString('base64url');
	const ttlMs     = opts.ttlMs ?? DEFAULT_TTL_MS;
	const expiresAt = nowMs() + ttlMs;
	TOKEN_STORE.set(token, { token, sessionId, expiresAt });
	return token;
}

/**
 * Validate a token and return its bound sessionId. Returns `undefined`
 * if the token is unknown or expired.
 *
 * Expired tokens are evicted lazily on lookup; no background sweeper.
 */
export function validateSessionToken(token: string | undefined): string | undefined {
	if (token === undefined || token.length === 0) { return undefined; }
	const hit = TOKEN_STORE.get(token);
	if (hit === undefined) { return undefined; }
	if (hit.expiresAt <= nowMs()) {
		TOKEN_STORE.delete(token);
		return undefined;
	}
	return hit.sessionId;
}

/**
 * Revoke a token explicitly (e.g. after handoff completion or
 * audit-time accept/reject).
 */
export function revokeSessionToken(token: string): void {
	TOKEN_STORE.delete(token);
}

/**
 * Test-only -- reset the in-memory store. Production paths never call
 * this; unit tests do between cases.
 */
export function _resetTokenStoreForTest(): void {
	TOKEN_STORE.clear();
}

/**
 * Test-only -- count live tokens. Used to assert leak-freedom in unit
 * tests.
 */
export function _liveTokenCountForTest(): number {
	return TOKEN_STORE.size;
}

function nowMs(): number {
	return Date.now();
}
