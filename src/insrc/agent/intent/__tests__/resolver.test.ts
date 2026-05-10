/**
 * Tests for `resolveIntent` (plans/conversation-flow-refinement.md
 * Phase 1).
 *
 * Two layers:
 *
 *   1. Pure helper -- `looksLikeContinuation`. Just regex + length
 *      math; no LLM, no session.
 *
 *   2. resolveIntent end-to-end against a fake Session whose
 *      ContextManager is a real instance (so the tag round-trip is
 *      exercised). The cold-path LLM call is short-circuited by
 *      injecting a fake provider that returns canned classifier JSON.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	resolveIntent,
	looksLikeContinuation,
	INTENT_TAG_CURRENT,
	INTENT_TAG_TIMESTAMP,
	INTENT_TAG_LAST_RESOLVED,
} from '../resolver.js';
import type { Session } from '../../session.js';
import type { LLMProvider, LLMResponse, LLMMessage } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Pure helper: looksLikeContinuation
// ---------------------------------------------------------------------------

test('looksLikeContinuation: anaphoric short message -> true', () => {
	assert.equal(looksLikeContinuation('show me that'), true);
	assert.equal(looksLikeContinuation('what about it'), true);
	assert.equal(looksLikeContinuation('drill into the same module'), true);
	assert.equal(looksLikeContinuation('describe HDFS Core'), true);
	assert.equal(looksLikeContinuation('now look at YARN'), true);
});

test('looksLikeContinuation: continuation lead-in short message -> true', () => {
	assert.equal(looksLikeContinuation('next show me callers'), true);
	assert.equal(looksLikeContinuation('also describe the module'), true);
	assert.equal(looksLikeContinuation('how does the auth flow work'), true);
});

test('looksLikeContinuation: long fresh ask -> false', () => {
	const long = 'I would like a full architectural review of the entire codebase including dependencies between every package, with a focus on cyclic deps and unused exports across all language ecosystems present in the repo.';
	assert.equal(looksLikeContinuation(long), false);
});

test('looksLikeContinuation: slash command -> false', () => {
	assert.equal(looksLikeContinuation('/code-analyze describe HDFS Core'), false);
});

test('looksLikeContinuation: empty -> false', () => {
	assert.equal(looksLikeContinuation(''), false);
	assert.equal(looksLikeContinuation('   '), false);
});

test('looksLikeContinuation: short fresh ask without anaphora or lead-in -> false', () => {
	// "describe authentication module" is a self-contained ask -- no
	// anaphoric pronoun, doesn't start with a continuation lead-in
	// token (no "now/then/show me/what about/...").
	assert.equal(looksLikeContinuation('audit the codebase for security issues'), false);
});

// ---------------------------------------------------------------------------
// resolveIntent end-to-end
// ---------------------------------------------------------------------------

interface QueuedResponse {
	readonly text: string;
}

function buildFakeProvider(responses: readonly QueuedResponse[]): LLMProvider {
	let i = 0;
	return {
		async complete(_messages: readonly LLMMessage[]): Promise<LLMResponse> {
			const r = responses[Math.min(i, responses.length - 1)];
			i++;
			return { text: r?.text ?? '', stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
}

function makeFakeSession(provider: LLMProvider): Session {
	// Minimal ContextManager-shaped stub: just the tag round-trip
	// surface the resolver needs. The full ContextManager has L1-L4
	// machinery the resolver doesn't touch.
	const tags = new Map<string, string>();
	const contextManager = {
		setTag: (k: string, v: string) => { tags.set(k, v); },
		getTag: (k: string) => tags.get(k) ?? '',
		hasTag: (k: string) => tags.has(k) && (tags.get(k) ?? '').length > 0,
	};

	const stub = {
		id: 'fake-session',
		contextManager,
		// resolveClassifierProvider in agent/classify/provider.ts walks
		// session.resolver.resolve(...) to pick the classifier provider.
		// Stub to always return our fake.
		resolver: { resolve: () => provider },
		ollamaProvider: provider,
		claudeProvider: null,
	} as unknown as Session;
	return stub;
}

function classifierJson(intent: string, confidence = 0.95, reasoning = 'fake'): string {
	return JSON.stringify({ id: intent, confidence, reasoning, scope: 'M' });
}

test('resolveIntent: fresh session + cold ask -> classified-fresh', async () => {
	const provider = buildFakeProvider([{ text: classifierJson('code-analysis') }]);
	const session  = makeFakeSession(provider);
	const r = await resolveIntent(session, 'audit the entire codebase');
	assert.equal(r.id, 'code-analysis');
	assert.equal(r.source, 'classified-fresh');
	assert.equal(r.confidence, 'high');
	// Tag stamped after resolution.
	assert.equal(session.contextManager.getTag(INTENT_TAG_CURRENT), 'code-analysis');
	assert.ok(session.contextManager.getTag(INTENT_TAG_TIMESTAMP).length > 0);
	assert.match(session.contextManager.getTag(INTENT_TAG_LAST_RESOLVED), /classified-fresh/);
});

test('resolveIntent: prior tag + continuation-shaped follow-up -> tag reuse (no LLM call)', async () => {
	let llmCalls = 0;
	const provider: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			llmCalls++;
			return { text: classifierJson('code-analysis'), stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	const session = makeFakeSession(provider);
	// Pre-stamp the tag (simulates a prior turn).
	session.contextManager.setTag(INTENT_TAG_CURRENT, 'code-analysis');

	const r = await resolveIntent(session, 'now describe HDFS Core');
	assert.equal(r.id, 'code-analysis');
	assert.equal(r.source, 'tag');
	assert.equal(r.confidence, 'high');
	assert.equal(llmCalls, 0, 'tag reuse must NOT call the LLM');
});

test('resolveIntent: prior tag + cold-shaped ask -> classified-shifted on different intent', async () => {
	const provider = buildFakeProvider([{ text: classifierJson('debug') }]);
	const session  = makeFakeSession(provider);
	session.contextManager.setTag(INTENT_TAG_CURRENT, 'code-analysis');

	const r = await resolveIntent(
		session,
		'I am hitting a NullPointerException in our Spring controller and the stack trace points to a request mapping that is supposed to be wired',
	);
	assert.equal(r.id, 'debug');
	assert.equal(r.source, 'classified-shifted');
	assert.equal(r.previousIntent, 'code-analysis');
	assert.equal(session.contextManager.getTag(INTENT_TAG_CURRENT), 'debug');
});

test('resolveIntent: prior tag + cold ask + classifier returns same intent -> classified-fresh', async () => {
	// `classified-fresh` here means "we ran the LLM (didn't reuse the
	// tag) and the result happened to match the prior tag". Could be
	// renamed `classified-confirmed` later; for now the source string
	// signals "cold path ran".
	const provider = buildFakeProvider([{ text: classifierJson('code-analysis') }]);
	const session  = makeFakeSession(provider);
	session.contextManager.setTag(INTENT_TAG_CURRENT, 'code-analysis');

	const r = await resolveIntent(
		session,
		'I would like a comprehensive end-to-end review of the whole project covering each subsystem and how they connect to each other',
	);
	assert.equal(r.id, 'code-analysis');
	assert.equal(r.source, 'classified-fresh');
	assert.equal(r.previousIntent, 'code-analysis');
});

test('resolveIntent: low-confidence classifier output -> resolved.confidence: low', async () => {
	const provider = buildFakeProvider([{ text: classifierJson('research', 0.4) }]);
	const session  = makeFakeSession(provider);
	const r = await resolveIntent(session, 'audit the entire codebase for security issues across the board');
	assert.equal(r.confidence, 'low');
});

test('resolveIntent: classifier fallback (LLM error) -> low confidence', async () => {
	const provider: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			throw new Error('provider down');
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	const session = makeFakeSession(provider);
	const r = await resolveIntent(session, 'audit the entire codebase for security issues across the board');
	assert.equal(r.confidence, 'low');
	// classify() returns classes[0] on error -- just assert we got
	// SOME intent back without crashing.
	assert.ok(typeof r.id === 'string' && r.id.length > 0);
});
