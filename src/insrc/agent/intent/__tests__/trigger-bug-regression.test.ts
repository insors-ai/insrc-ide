/**
 * Phase 9 regression test for the trigger bug that motivated
 * plans/intent-classification-consolidation.md.
 *
 * Scenario: a 2-turn session.
 *
 *   Turn 1:  /code-analyze describe what this repo does
 *            -> resolveIntent({ slashForced: 'code-analysis' })
 *            -> stamps [intent:current] = 'code-analysis'
 *
 *   Turn 2:  elaborate on the core filesystem design/architecture
 *            -> resolveIntent(...)
 *            -> the message starts with "elaborate on" which
 *               matches the continuation lead-in heuristic.
 *               combined with the prior tag, this hits the
 *               TAG-REUSE fast path -- NO LLM classify call.
 *            -> resolves to 'code-analysis'.
 *
 * Before the consolidation, turn 2 went through the decomposer
 * which carried the rule "Informational questions are research
 * intent". It misclassified, the [intent:current] tag got
 * clobbered, downstream retrievers ran with the wrong intent, and
 * the assistant produced a generic research reply instead of the
 * deep-dive analysis the user wanted.
 *
 * This test pins the new behaviour: ANY LLM classifier invocation
 * in turn 2 means the tag-reuse fast path is bypassed and the bug
 * could come back. The fake provider in this test would error on
 * every call -- the test passes only when the resolver short-
 * circuits before reaching the LLM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	resolveIntent,
	INTENT_TAG_CURRENT,
} from '../resolver.js';
import type { Session } from '../../session.js';
import type { LLMProvider, LLMResponse } from '../../../shared/types.js';

function neverCallProvider(): LLMProvider {
	return {
		async complete(): Promise<LLMResponse> {
			throw new Error('LLM classifier should NOT be called -- tag-reuse fast path expected');
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
}

function makeFakeSession(provider: LLMProvider): Session {
	const tags = new Map<string, string>();
	const contextManager = {
		setTag: (k: string, v: string) => { tags.set(k, v); },
		getTag: (k: string) => tags.get(k) ?? '',
		hasTag: (k: string) => tags.has(k) && (tags.get(k) ?? '').length > 0,
	};
	return {
		id: 'regression-session',
		contextManager,
		resolver:       { resolve: () => provider },
		ollamaProvider: provider,
		claudeProvider: null,
	} as unknown as Session;
}

test('regression: /code-analyze then "elaborate on X" -> code-analysis via tag reuse (NO LLM call)', async () => {
	const session = makeFakeSession(neverCallProvider());

	// Turn 1: slash-forced code-analyze. No LLM call (slash short-
	// circuits before the classifier).
	const t1 = await resolveIntent(session, 'describe what this repo does', {
		slashForced: 'code-analysis',
	});
	assert.equal(t1.id, 'code-analysis');
	assert.equal(t1.source, 'slash-forced');
	assert.equal(session.contextManager.getTag(INTENT_TAG_CURRENT), 'code-analysis',
		'turn 1 must stamp [intent:current] = code-analysis');

	// Turn 2: continuation-shaped follow-up. The continuation
	// heuristic matches "elaborate on ...", so the tag-reuse fast
	// path fires. No LLM call -- if one ran, neverCallProvider
	// throws and the test fails.
	const t2 = await resolveIntent(session, 'elaborate on the core filesystem design/architecture');
	assert.equal(t2.id, 'code-analysis',
		'turn 2 must resolve to code-analysis (the trigger bug was misclassifying it as research)');
	assert.equal(t2.source, 'tag',
		'turn 2 must hit the tag-reuse fast path -- not cold classify');
	assert.equal(session.contextManager.getTag(INTENT_TAG_CURRENT), 'code-analysis',
		'turn 2 must NOT clobber the tag');
	assert.equal(t2.relationship, undefined,
		'tag-reuse path skips memory retrieval -- no relationship hydration');
});

test('regression: /code-analyze then "describe HDFS Core" -> code-analysis via tag reuse', async () => {
	// The other common shape of the trigger bug -- a continuation
	// that looks like a research-y verb but is asking about an
	// in-repo entity.
	const session = makeFakeSession(neverCallProvider());
	await resolveIntent(session, 'describe what this repo does', {
		slashForced: 'code-analysis',
	});
	const t2 = await resolveIntent(session, 'describe HDFS Core');
	assert.equal(t2.id, 'code-analysis');
	assert.equal(t2.source, 'tag');
});

test('regression: /data-analyze then "what columns are in the orders table" -> data-analysis via tag reuse', async () => {
	// Parallel scenario for the data-analyzer slash.
	const session = makeFakeSession(neverCallProvider());
	await resolveIntent(session, 'audit the customers dataset', {
		slashForced: 'data-analysis',
	});
	const t2 = await resolveIntent(session, 'what about the orders table');
	assert.equal(t2.id, 'data-analysis');
	assert.equal(t2.source, 'tag');
});
