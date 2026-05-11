/**
 * Phase 6 tests for `resolveActionIntents` -- the chat-handler's
 * bridge from decomposer output to resolver-driven intents.
 *
 * Three invariants matter most:
 *   1. The primary action's resolved intent is what stamps
 *      `[intent:current]`. Attached actions resolve with
 *      `noStamp: true` so the next turn's tag-reuse heuristic
 *      reads the primary, not the last attached aside.
 *   2. `action.intent` is mutated in place to the resolver's
 *      answer (downstream code reads it).
 *   3. Attached actions resolve in parallel. We don't strictly
 *      test parallelism, but we DO test that each attached
 *      action's intent ends up at the resolver's answer rather
 *      than the decomposer's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	resolveActionIntents,
	resolveSingleActionIntent,
} from '../action-intents.js';
import { INTENT_TAG_CURRENT } from '../resolver.js';
import type { Session } from '../../session.js';
import type { LLMProvider, LLMMessage, LLMResponse } from '../../../shared/types.js';
import type { DecomposedAction, AttachedAction } from '../../decompose.js';

interface QueuedResponse { text: string }

/**
 * Sequential queue provider. Use when you don't care which attached
 * call sees which response (race-tolerant tests).
 */
function buildQueuedProvider(responses: readonly QueuedResponse[]): LLMProvider & { calls: number } {
	let i = 0;
	const p = {
		calls: 0,
		async complete(_messages: readonly LLMMessage[]): Promise<LLMResponse> {
			p.calls++;
			const r = responses[Math.min(i, responses.length - 1)];
			i++;
			return { text: r?.text ?? '', stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	return p as LLMProvider & { calls: number };
}

/**
 * Content-keyed provider. Inspects the LAST user message in each
 * `complete()` call and returns the response whose key the message
 * contains (substring match). Use when attached actions resolve in
 * parallel and the test cares about which response landed on
 * which action.
 */
function buildKeyedProvider(map: Record<string, string>): LLMProvider & { calls: number } {
	const p = {
		calls: 0,
		async complete(messages: readonly LLMMessage[]): Promise<LLMResponse> {
			p.calls++;
			const last = messages[messages.length - 1]?.content ?? '';
			const text = typeof last === 'string' ? last : '';
			for (const key of Object.keys(map)) {
				if (text.includes(key)) {
					return { text: map[key]!, stopReason: 'end_turn' };
				}
			}
			// Fallback: low-confidence so the resolver falls back too.
			return { text: classifierJson('research', 0.4), stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	return p as LLMProvider & { calls: number };
}

function makeFakeSession(provider: LLMProvider): Session {
	const tags = new Map<string, string>();
	const contextManager = {
		setTag: (k: string, v: string) => { tags.set(k, v); },
		getTag: (k: string) => tags.get(k) ?? '',
		hasTag: (k: string) => tags.has(k) && (tags.get(k) ?? '').length > 0,
	};
	return {
		id: 'fake-session',
		contextManager,
		resolver: { resolve: () => provider },
		ollamaProvider: provider,
		claudeProvider: null,
	} as unknown as Session;
}

function classifierJson(intent: string, confidence = 0.9): string {
	return JSON.stringify({ id: intent, confidence, reasoning: 'fake', scope: 'M' });
}

function action(action: string, intent = 'research'): DecomposedAction {
	return {
		intent: intent as DecomposedAction['intent'],
		action,
		confidence: 0.9,
	};
}

function attached(actionStr: string, intent = 'research'): AttachedAction {
	return {
		...action(actionStr, intent),
		relation: 'augment',
		reason:   'attached',
	};
}

// ---------------------------------------------------------------------------
// Primary + attached
// ---------------------------------------------------------------------------

test('resolveActionIntents: mutates each action.intent to the resolver answer', async () => {
	// Attached actions resolve in parallel under Promise.all, so a
	// FIFO queue would race. Key responses by the action's text so
	// each resolveIntent call gets the right answer regardless of
	// scheduling order.
	const provider = buildKeyedProvider({
		'auth module':    classifierJson('code-analysis'),
		'failing test':   classifierJson('debug'),
		'rename `foo`':   classifierJson('refactor'),
	});
	const session = makeFakeSession(provider);

	const primary  = action('describe the auth module', 'research');     // decomposer guessed research
	const a0       = attached('find the failing test',  'research');
	const a1       = attached('rename `foo` to `bar`',  'research');

	const result = await resolveActionIntents({ session, primary, attached: [a0, a1] });

	// Each action.intent now reflects the resolver's call.
	assert.equal(primary.intent, 'code-analysis', 'primary.intent must be the resolver answer, not the decomposer guess');
	assert.equal(a0.intent,      'debug');
	assert.equal(a1.intent,      'refactor');

	// And the result mirror.
	assert.equal(result.primary.id,        'code-analysis');
	assert.equal(result.attached.length,   2);
	assert.equal(result.attached[0]!.id,   'debug');
	assert.equal(result.attached[1]!.id,   'refactor');
});

test('resolveActionIntents: tag is stamped ONCE with the primary intent (not the last attached)', async () => {
	// Keyed so attached results don't matter for tag-correctness;
	// only the primary's stamp should land. Attached resolves with
	// `noStamp: true` so even if it landed second, it wouldn't
	// overwrite the primary.
	const provider = buildKeyedProvider({
		'a-primary': classifierJson('code-analysis'),
		'b-attach':  classifierJson('research'),
		'c-attach':  classifierJson('debug'),
	});
	const session = makeFakeSession(provider);
	await resolveActionIntents({
		session,
		primary:  action('a-primary', 'research'),
		attached: [attached('b-attach'), attached('c-attach')],
	});
	// Primary's resolved intent (code-analysis) stamped the tag.
	// Attached actions resolved with noStamp so they didn't overwrite.
	assert.equal(session.contextManager.getTag(INTENT_TAG_CURRENT), 'code-analysis');
});

test('resolveActionIntents: zero attached -> only primary runs', async () => {
	const provider = buildQueuedProvider([
		{ text: classifierJson('code-analysis') },
	]);
	const session = makeFakeSession(provider);
	const result = await resolveActionIntents({
		session,
		primary:  action('a'),
		attached: [],
	});
	assert.equal(result.attached.length, 0);
	assert.equal(provider.calls, 1, 'only the primary should call the LLM');
});

test('resolveActionIntents: N attached -> exactly 1 + N classifier calls', async () => {
	const responses = Array.from({ length: 5 }, () => ({ text: classifierJson('code-analysis') }));
	const provider = buildQueuedProvider(responses);
	const session = makeFakeSession(provider);
	await resolveActionIntents({
		session,
		primary:  action('a'),
		attached: [attached('b'), attached('c'), attached('d'), attached('e')],
	});
	// 1 primary + 4 attached = 5 LLM calls.
	assert.equal(provider.calls, 5);
});

// ---------------------------------------------------------------------------
// Legacy single-action shape
// ---------------------------------------------------------------------------

test('resolveSingleActionIntent: mutates intent + stamps tag', async () => {
	const provider = buildQueuedProvider([{ text: classifierJson('refactor') }]);
	const session  = makeFakeSession(provider);
	const a = action('rename FooBar', 'research');

	const r = await resolveSingleActionIntent(session, a);
	assert.equal(a.intent, 'refactor');
	assert.equal(r.id, 'refactor');
	assert.equal(session.contextManager.getTag(INTENT_TAG_CURRENT), 'refactor');
});
