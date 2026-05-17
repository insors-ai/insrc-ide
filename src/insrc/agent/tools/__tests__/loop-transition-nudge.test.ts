/**
 * Tests for the Phase J.2 transition-phrase nudge in runToolLoop.
 *
 * The nudge fires when the model produces a final paragraph that
 * STARTS with a transition phrase ("Let me now investigate X",
 * "I'll examine Y next", etc.) without making the announced tool
 * call. The 2026-05-16 Hadoop run surfaced this as the dominant
 * round-2 refine-pass failure mode (Section 8 R2 ended with
 * "Let me now investigate the distinction between unit and
 * integration tests" then end_turn).
 *
 * Three behaviours under test:
 *   1. Loop accepts a final turn whose last paragraph does NOT
 *      match the transition pattern (no nudge fired).
 *   2. Loop fires the nudge exactly once on a transition-phrase
 *      ending, then exits after the model's next response.
 *   3. Loop accepts a second transition-phrase ending without
 *      infinite-looping (budget = 1, honored).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runToolLoop } from '../loop.js';
import type {
	LLMMessage,
	LLMProvider,
	LLMResponse,
	CompletionOpts,
	ToolDefinition,
} from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Scripted provider: returns a queue of canned responses in order
// ---------------------------------------------------------------------------

function scriptedProvider(script: LLMResponse[]): {
	provider: LLMProvider;
	callCount: () => number;
	lastMessages: () => LLMMessage[];
} {
	let i = 0;
	let last: LLMMessage[] = [];
	return {
		provider: {
			async complete(messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
				last = messages;
				const r = script[i] ?? { text: '', stopReason: 'end_turn' as const };
				i++;
				return r;
			},
			async *stream() { yield ''; },
			async embed() { return []; },
			supportsTools: true,
		},
		callCount: () => i,
		lastMessages: () => last,
	};
}

const NO_TOOLS: ToolDefinition[] = [];
const SEED: LLMMessage[] = [
	{ role: 'system', content: 'you are a test agent' },
	{ role: 'user',   content: 'describe something' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('transition-nudge: non-transitional closing -> no nudge, loop exits cleanly', async () => {
	const { provider, callCount } = scriptedProvider([
		{
			text: 'The HDFS DataNode handles block storage and serves read/write requests. This is the takeaway.',
			stopReason: 'end_turn',
		},
	]);

	const r = await runToolLoop(SEED, {
		provider,
		tools:          NO_TOOLS,
		intent:         'test',
		permissionMode: 'auto-accept',
	});

	assert.equal(callCount(), 1, 'should not have re-prompted');
	assert.equal(r.transitionPhraseNudgeFired, false);
	assert.equal(r.iterations, 0);
	assert.match(r.response, /HDFS DataNode/);
});

test('transition-nudge: "Let me now investigate" closing -> fires nudge, loop continues', async () => {
	const { provider, callCount, lastMessages } = scriptedProvider([
		{
			text: 'Let me now investigate the distinction between unit and integration tests.',
			stopReason: 'end_turn',
		},
		{
			text: 'On reflection, the unit tests live under src/test/java/.../unit/ and the integration tests under src/test/java/.../integration/.',
			stopReason: 'end_turn',
		},
	]);

	const r = await runToolLoop(SEED, {
		provider,
		tools:          NO_TOOLS,
		intent:         'test',
		permissionMode: 'auto-accept',
	});

	assert.equal(callCount(), 2, 'nudge should have triggered a second provider call');
	assert.equal(r.transitionPhraseNudgeFired, true);

	// The nudge user message should be in the message history we sent on call 2.
	const msgs = lastMessages();
	const lastUser = [...msgs].reverse().find(m => m.role === 'user');
	assert.ok(lastUser, 'a user message should exist after the nudge');
	const userContent = typeof lastUser!.content === 'string' ? lastUser!.content : '';
	assert.match(userContent, /announced an action/);
	assert.match(userContent, /Let me now investigate/);

	// Both turns' text should be in the final response (paragraph stream).
	assert.match(r.response, /Let me now investigate/);
	assert.match(r.response, /unit tests live under/);
});

test('transition-nudge: second transition closing -> budget exhausted, accepts output', async () => {
	const { provider, callCount } = scriptedProvider([
		{ text: 'Let me now investigate the test architecture.',  stopReason: 'end_turn' },
		{ text: "I'll examine the YARN ResourceManager next.",     stopReason: 'end_turn' },
		// would-be third response, should NEVER be requested
		{ text: 'this should not appear', stopReason: 'end_turn' },
	]);

	const r = await runToolLoop(SEED, {
		provider,
		tools:          NO_TOOLS,
		intent:         'test',
		permissionMode: 'auto-accept',
	});

	assert.equal(callCount(), 2, 'nudge budget is 1; second transition must NOT trigger a 3rd call');
	assert.equal(r.transitionPhraseNudgeFired, true);
	assert.match(r.response, /YARN ResourceManager/);
	assert.doesNotMatch(r.response, /this should not appear/);
});

test('transition-nudge: disabled via opt -> no nudge even on transition phrase', async () => {
	const { provider, callCount } = scriptedProvider([
		{ text: 'Let me now investigate the test architecture.', stopReason: 'end_turn' },
		{ text: 'this should not appear', stopReason: 'end_turn' },
	]);

	const r = await runToolLoop(SEED, {
		provider,
		tools:                   NO_TOOLS,
		intent:                  'test',
		permissionMode:          'auto-accept',
		disableTransitionNudge:  true,
	});

	assert.equal(callCount(), 1, 'opt-out should suppress the nudge');
	assert.equal(r.transitionPhraseNudgeFired, false);
	assert.match(r.response, /Let me now investigate/);
});

test('transition-nudge: pattern is anchored at start of FINAL paragraph, not anywhere', async () => {
	// Text containing "I will" mid-paragraph but ending with a real closing
	// sentence -- must not trigger the nudge.
	const { provider, callCount } = scriptedProvider([
		{
			text: 'The HDFS architecture is layered. The reader I will describe is the BlockReader. The takeaway is that BlockReader is the canonical entry point for client-side reads.',
			stopReason: 'end_turn',
		},
	]);

	const r = await runToolLoop(SEED, {
		provider,
		tools:          NO_TOOLS,
		intent:         'test',
		permissionMode: 'auto-accept',
	});

	assert.equal(callCount(), 1);
	assert.equal(r.transitionPhraseNudgeFired, false);
});

// ---------------------------------------------------------------------------
// Phase P.8: trigram-shingle Jaccard similarity
// ---------------------------------------------------------------------------

import { _jaccardTrigramSimilarityForTest as jaccard } from '../loop.js';

test('jaccard: identical strings -> 1.0', () => {
	const a = 'The HDFS module contains 707 files and 19327 entities';
	assert.equal(jaccard(a, a), 1);
});

test('jaccard: near-duplicate paragraphs (run #3 section 2 case) -> >= 0.7', () => {
	// Actual paragraphs 2 and 3 from section 2 round 1 of run #3 -- the
	// model emitted two paragraphs that differ only in entity names +
	// citation markup, sharing two full trailing sentences verbatim.
	const a = 'The org.apache.hadoop.fs module contains 297 files and 5796 entities, with 3591 public entities. Key files include FileSystem.java, Path.java, and FSDataInputStream.java, which form the core of the filesystem abstraction layer. This layer enables Hadoop to interact with various storage backends through a unified interface.';
	const b = 'The org.apache.hadoop.fs module contains 297 files and 5796 entities, with 3591 public entities. Key files include Abortable, AbstractFileSystem, and BufferedFSInputStream, which form the core of the filesystem abstraction layer. This layer enables Hadoop to interact with various storage backends through a unified interface.';
	const sim = jaccard(a, b);
	assert.ok(sim >= 0.7, `expected near-duplicate to score >=0.7, got ${sim}`);
});

test('jaccard: legitimate "module Y contains M files" pattern with different entities -> < 0.7', () => {
	const a = 'The HDFS module contains 707 files including DFSConfigKeys, DFSUtil, and DFSNetworkTopology.';
	const b = 'The YARN module contains 111 files including AllocateRequest, AllocateResponse, and ApplicationsRequestScope.';
	const sim = jaccard(a, b);
	assert.ok(sim < 0.7, `legitimate followup should not score >=0.7, got ${sim}`);
});

test('jaccard: completely different topics -> near 0', () => {
	const a = 'The HDFS DataNode handles block storage and serves read/write requests.';
	const b = 'YARN ResourceManager schedules containers across NodeManagers in the cluster.';
	const sim = jaccard(a, b);
	assert.ok(sim < 0.1, `unrelated topics should score near 0, got ${sim}`);
});

test('jaccard: empty strings -> 1.0 (both empty)', () => {
	assert.equal(jaccard('', ''), 1);
});
