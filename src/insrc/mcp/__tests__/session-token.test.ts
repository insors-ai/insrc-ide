/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Session-token issue + validate unit tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	issueSessionToken,
	validateSessionToken,
	revokeSessionToken,
	_resetTokenStoreForTest,
	_liveTokenCountForTest,
} from '../session-token.js';

test.beforeEach(() => {
	_resetTokenStoreForTest();
});

test('issue + validate -> returns bound sessionId', () => {
	const token = issueSessionToken('sess-1');
	assert.equal(validateSessionToken(token), 'sess-1');
});

test('issueSessionToken: empty sessionId is rejected', () => {
	assert.throws(() => issueSessionToken(''), /non-empty/);
});

test('validateSessionToken: undefined token -> undefined', () => {
	assert.equal(validateSessionToken(undefined), undefined);
});

test('validateSessionToken: empty token -> undefined', () => {
	assert.equal(validateSessionToken(''), undefined);
});

test('validateSessionToken: unknown token -> undefined', () => {
	assert.equal(validateSessionToken('not-a-real-token'), undefined);
});

test('issueSessionToken: each call produces a distinct token', () => {
	const t1 = issueSessionToken('sess-1');
	const t2 = issueSessionToken('sess-1');
	assert.notEqual(t1, t2);
	// Both still resolve to the same sessionId.
	assert.equal(validateSessionToken(t1), 'sess-1');
	assert.equal(validateSessionToken(t2), 'sess-1');
});

test('revokeSessionToken: revoked token no longer validates', () => {
	const token = issueSessionToken('sess-1');
	revokeSessionToken(token);
	assert.equal(validateSessionToken(token), undefined);
});

test('revokeSessionToken: idempotent on unknown token', () => {
	assert.doesNotThrow(() => revokeSessionToken('nope'));
});

test('expired tokens are evicted lazily on lookup', () => {
	// Issue with a TTL of 0 -> immediately expired.
	const token = issueSessionToken('sess-1', { ttlMs: 0 });
	assert.equal(_liveTokenCountForTest(), 1);
	assert.equal(validateSessionToken(token), undefined);
	assert.equal(_liveTokenCountForTest(), 0,
		'expired tokens must be evicted during validate lookup');
});
