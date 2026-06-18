/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for meta-task M3 owner registration with the substrate.
 *
 * Pins the contract:
 *   - `registerTemplate` registers the owner's assertion interests with the
 *     substrate's AssertionIndex when the runtime is available.
 *   - `registerKnownTemplatesWithSubstrate()` catches up templates that
 *     were declared before the substrate booted (the daemon boot order).
 *   - Re-registration is idempotent.
 *   - End-to-end: `runtime.classifyAssertion` with a subject matching the
 *     review template's interests writes the constraint to BOTH the chat
 *     owner AND the review owner's namespaces (no manual fan-out).
 *
 * Uses a scripted Layer 2 hook so the routing test doesn't depend on
 * Ollama -- the AssertionIndex behaviour is what we're pinning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	_clearRegistryForTests,
	registerKnownTemplatesWithSubstrate,
	registerTemplate,
	type MetaTaskTemplate,
} from '../templates/index.js';
import { reviewTemplate } from '../templates/review.js';
import {
	_resetSubstrateRuntimeForTests,
	AGENT_CHAT_OWNER,
	getSubstrateRuntime,
	initSubstrateRuntime,
	registerAgentChatOwner,
} from '../../daemon/substrate/singleton.js';
import { createMemoryStore } from '../../daemon/substrate/memory-store.js';
import { createSubstrateRuntime } from '../../daemon/substrate/runtime.js';
import type { LlmClassifyHook } from '../../daemon/substrate/classifier/user-assertion.js';
import type { LLMMessage, LLMProvider, LLMResponse } from '../../shared/types.js';


function noopProvider(): LLMProvider {
	return {
		async complete(_messages: LLMMessage[]): Promise<LLMResponse> {
			throw new Error('noopProvider.complete: should not be invoked');
		},
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
	};
}


// ---------------------------------------------------------------------------
// Direct registration paths
// ---------------------------------------------------------------------------

test('registerTemplate: registers substrate owner when runtime is ready', async () => {
	_resetSubstrateRuntimeForTests();
	_clearRegistryForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm3-reg-'));
	try {
		const runtime = initSubstrateRuntime({
			localProvider: noopProvider(),
			workspaceId:   'm3-reg',
			rootDir:       dir,
		});
		registerAgentChatOwner(runtime);

		// Register a custom template AFTER substrate boot.
		const template: MetaTaskTemplate = {
			id:           'custom-x',
			displayName:  'Custom',
			worktreeMode: 'none',
			plan: () => ({ revision: 0, steps: [] }),
			ownerId: 'agent:meta-task:custom-x',
			schemaVersion: 1,
			assertionInterests: [
				{ subjectPattern: 'test-policy', description: 'Custom test interest' },
			],
		};
		registerTemplate(template);

		// AssertionIndex now routes test-policy -> custom owner too.
		const matches = runtime.assertionIndex.lookup('test-policy');
		const owners = matches.map(m => m.owner);
		assert.ok(owners.includes('agent:meta-task:custom-x'),
			`expected custom owner in matches, got [${owners.join(', ')}]`);
		assert.ok(owners.includes(AGENT_CHAT_OWNER), 'chat owner should still be in matches');
	} finally {
		_clearRegistryForTests();
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});


test('registerKnownTemplatesWithSubstrate: catches up templates registered before substrate', async () => {
	_resetSubstrateRuntimeForTests();
	_clearRegistryForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm3-catchup-'));
	try {
		// Register the review template FIRST (substrate not yet up).
		registerTemplate(reviewTemplate);

		// Then boot the substrate.
		const runtime = initSubstrateRuntime({
			localProvider: noopProvider(),
			workspaceId:   'm3-catchup',
			rootDir:       dir,
		});
		registerAgentChatOwner(runtime);

		// Before catch-up: AssertionIndex doesn't know about the review owner.
		const before = runtime.assertionIndex.lookup('security-policy').map(m => m.owner);
		assert.ok(!before.includes('agent:meta-task:review'),
			'review owner shouldn\'t be registered yet');

		// Catch-up: replays known templates.
		registerKnownTemplatesWithSubstrate();

		const after = runtime.assertionIndex.lookup('security-policy').map(m => m.owner);
		assert.ok(after.includes('agent:meta-task:review'),
			`review owner expected after catch-up; got [${after.join(', ')}]`);
	} finally {
		_clearRegistryForTests();
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});


test('registerTemplateSubstrate: idempotent on re-registration', async () => {
	_resetSubstrateRuntimeForTests();
	_clearRegistryForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm3-idem-'));
	try {
		const runtime = initSubstrateRuntime({
			localProvider: noopProvider(),
			workspaceId:   'm3-idem',
			rootDir:       dir,
		});
		registerAgentChatOwner(runtime);
		registerTemplate(reviewTemplate);

		// Replay catch-up twice; AssertionIndex shouldn't double-count.
		registerKnownTemplatesWithSubstrate();
		registerKnownTemplatesWithSubstrate();

		const matches = runtime.assertionIndex.lookup('test-policy');
		const reviewCount = matches.filter(m => m.owner === 'agent:meta-task:review').length;
		assert.equal(reviewCount, 1, 'review owner should appear exactly once');
	} finally {
		_clearRegistryForTests();
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});


// ---------------------------------------------------------------------------
// Template declarations on the review template itself
// ---------------------------------------------------------------------------

test('reviewTemplate: declares ownerId + matching assertionInterests', () => {
	assert.equal(reviewTemplate.ownerId, 'agent:meta-task:review');
	assert.equal(reviewTemplate.schemaVersion, 1);
	assert.ok(reviewTemplate.assertionInterests);
	const subjects = reviewTemplate.assertionInterests!.map(i => i.subjectPattern);
	assert.ok(subjects.includes('test-policy'));
	assert.ok(subjects.includes('code-style'));
	assert.ok(subjects.includes('security-policy'));
});


// ---------------------------------------------------------------------------
// End-to-end: classifyAssertion routes to chat AND meta-task:review owners
// ---------------------------------------------------------------------------

test('classifyAssertion: assertion with matching subject lands in chat owner + review owner namespaces', async () => {
	_resetSubstrateRuntimeForTests();
	_clearRegistryForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm3-route-'));
	try {
		// Custom runtime so we can plug in a scripted Layer 2 hook -- the
		// real Ollama hook is non-deterministic and not the contract under
		// test. Same memory store the singleton expects to use.
		const llmClassify: LlmClassifyHook = async (span, _hints) => ({
			kind: 'accept',
			payload: {
				text:               span,
				subject:            'test-policy',
				preferenceSubject:  'test-policy',
				canonicalText:      span,
				polarity:           'preference',
				scope:              'workspace',
				targetOwners:       [],
				confidence:         0.95,
			},
		});
		const memory = createMemoryStore({ workspaceId: 'm3-route', rootDir: dir });
		const runtime = createSubstrateRuntime({ memory, classifier: { llmClassify } });

		// Wire the runtime into the singleton so the orchestrator/fetcher path
		// can find it later -- not strictly required for this test, but mirrors
		// the production boot order.
		const singleton = await import('../../daemon/substrate/singleton.js');
		singleton._resetSubstrateRuntimeForTests();
		// We can't initSubstrateRuntime here without an Ollama provider, so we
		// register directly: the chat owner + the review template owner.
		runtime.assertionIndex.register(AGENT_CHAT_OWNER,
			(await import('../../daemon/substrate/taxonomy/preference-subjects.js')).PREFERENCE_SUBJECTS
				.map(s => ({ subjectPattern: s, description: 'chat catch-all' })));
		runtime.assertionIndex.register(reviewTemplate.ownerId!, reviewTemplate.assertionInterests!);

		// Classify a preference that matches test-policy.
		const r = await runtime.classifyAssertion({
			turnId: 't-1',
			text:   'always include unit tests',
		});
		assert.ok(r.persisted.length >= 2,
			`expected fan-out to chat + review owners; got ${r.persisted.length} writes`);

		// Verify both namespaces have the entry.
		const chatEntry = await memory.scope(AGENT_CHAT_OWNER, 'user-assertions')
			.get('t-1::test-policy');
		const reviewEntry = await memory.scope('agent:meta-task:review', 'user-assertions')
			.get('t-1::test-policy');
		assert.ok(chatEntry, 'chat owner should have the entry');
		assert.ok(reviewEntry, 'review owner should have the entry');
		assert.equal(chatEntry!.kind, 'constraint');
		assert.equal(reviewEntry!.kind, 'constraint');
	} finally {
		_clearRegistryForTests();
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});


test('classifyAssertion: subject NOT in review interests does NOT land in review owner', async () => {
	_resetSubstrateRuntimeForTests();
	_clearRegistryForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm3-no-route-'));
	try {
		// Scripted Layer 2: accept with a subject the review template doesn't claim.
		const llmClassify: LlmClassifyHook = async (span, _hints) => ({
			kind: 'accept',
			payload: {
				text:               span,
				subject:            'commit-policy',
				preferenceSubject:  'commit-policy',
				canonicalText:      span,
				polarity:           'preference',
				scope:              'workspace',
				targetOwners:       [],
				confidence:         0.95,
			},
		});
		const memory = createMemoryStore({ workspaceId: 'm3-no-route', rootDir: dir });
		const runtime = createSubstrateRuntime({ memory, classifier: { llmClassify } });

		runtime.assertionIndex.register(AGENT_CHAT_OWNER,
			(await import('../../daemon/substrate/taxonomy/preference-subjects.js')).PREFERENCE_SUBJECTS
				.map(s => ({ subjectPattern: s, description: 'chat catch-all' })));
		runtime.assertionIndex.register(reviewTemplate.ownerId!, reviewTemplate.assertionInterests!);

		await runtime.classifyAssertion({ turnId: 't-1', text: 'always squash commits' });

		const chatEntry = await memory.scope(AGENT_CHAT_OWNER, 'user-assertions').get('t-1::commit-policy');
		const reviewEntry = await memory.scope('agent:meta-task:review', 'user-assertions').get('t-1::commit-policy');
		assert.ok(chatEntry, 'chat owner should still get the entry (catch-all)');
		assert.equal(reviewEntry, undefined,
			'review owner should NOT get an entry for a subject outside its interests');
	} finally {
		_clearRegistryForTests();
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});
