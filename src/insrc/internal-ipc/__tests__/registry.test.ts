/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Registry-level tests: invariants on the internal IPC surface.
 *
 * The handlers themselves are mostly thin wrappers over existing
 * functions; their behaviour is covered by the upstream tests for
 * `resolveIntent`, `retrieveClassifierMemory`, `saveTurn`,
 * `verifyCitedSummary`, and `reviewSection`. What we pin here is
 * the SURFACE -- the eight-tuple of registered IPCs, their naming
 * convention, and the stub→NotImplementedError contract for the
 * Phase 2a/3 entries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	INTERNAL_IPCS,
	assertInternalIpcInvariants,
	type InternalIpcName,
} from '../registry.js';
import { InternalIpcNotImplementedError } from '../types.js';

test('registry: 8 IPCs exactly (5 real, 3 stubs)', () => {
	const names = Object.keys(INTERNAL_IPCS) as InternalIpcName[];
	assert.equal(names.length, 8);
});

test('registry: assertInternalIpcInvariants() passes on the v1 surface', () => {
	assertInternalIpcInvariants();
});

test('registry: every key is `internal.<family>.<verb>` dot-separated', () => {
	for (const k of Object.keys(INTERNAL_IPCS)) {
		assert.match(k, /^internal\.[a-z-]+\.[a-z-]+$/, `'${k}' does not match internal.<family>.<verb>`);
	}
});

test('registry: handler.name matches its registry key', () => {
	for (const [k, h] of Object.entries(INTERNAL_IPCS)) {
		assert.equal(h.name, k, `key '${k}' vs handler.name '${h.name}'`);
	}
});

test('registry: Phase 2a stubs (handoff.*) throw NotImplementedError mentioning Phase 2a', async () => {
	const spawn = INTERNAL_IPCS['internal.handoff.spawn'];
	const ret   = INTERNAL_IPCS['internal.handoff.return'];
	await assert.rejects(
		() => spawn.invoke({}),
		(err: Error) => err instanceof InternalIpcNotImplementedError && /Phase 2a/.test(err.message),
	);
	await assert.rejects(
		() => ret.invoke({}),
		(err: Error) => err instanceof InternalIpcNotImplementedError && /Phase 2a/.test(err.message),
	);
});

test('registry: Phase 3 stub (gating.evaluate) throws NotImplementedError mentioning Phase 3', async () => {
	const gate = INTERNAL_IPCS['internal.gating.evaluate'];
	await assert.rejects(
		() => gate.invoke({}),
		(err: Error) => err instanceof InternalIpcNotImplementedError && /Phase 3/.test(err.message),
	);
});

test('registry: real handlers do NOT throw NotImplementedError on construction', () => {
	// Sanity: the 5 real handlers are wired functions, not stubs. Their
	// invoke functions exist and are callable types. (Actually invoking
	// them requires a Session / DbClient; that's the upstream tests' job.)
	const real = [
		'internal.intent.resolve',
		'internal.memory.recall',
		'internal.session.append-turn',
		'internal.review.citation-verify',
		'internal.review.section-review',
	] as const;
	for (const k of real) {
		const h = INTERNAL_IPCS[k];
		assert.equal(typeof h.invoke, 'function');
		assert.equal(h.name, k);
	}
});
