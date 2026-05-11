/**
 * Phase 4 tests for `classifyPrimaryIntent` -- specifically the
 * memory-context rendering. The generic `classify()` relationship
 * plumbing is covered separately in relationship.test.ts; here we
 * focus on the intent-classifier-specific behaviour:
 *   1. memory bundle renders into a `## Recent context` section with
 *      [tN] / [sN] citation keys
 *   2. memory absent -> no Recent context block, no relationshipEnum
 *      flows through to classify()
 *   3. memory empty (zero turns + zero segments) -> same as absent
 *   4. /intent override short-circuits before any rendering happens
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPrimaryIntent } from '../intent.js';
import type { Session } from '../../session.js';
import type { LLMProvider, LLMMessage, LLMResponse } from '../../../shared/types.js';
import type { ClassifierMemory } from '../../intent/classifier-memory.js';

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
		repoPath: '/repo/foo',
	} as unknown as Session;
}

function captureProvider(canned: string, capture: { messages?: LLMMessage[] }): LLMProvider {
	return {
		async complete(messages: LLMMessage[]): Promise<LLMResponse> {
			capture.messages = messages.map(m => ({ ...m }));
			return { text: canned, stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
}

const SAMPLE_MEMORY: ClassifierMemory = {
	turns: [
		{ turnId: 's:0', role: 'user',      excerpt: 'describe what this repo does',     timestamp: Date.now() - 60_000,  recencyRank: 1, relevance: 0.9 },
		{ turnId: 's:0', role: 'assistant', excerpt: 'Apache Hadoop is a framework.',    timestamp: Date.now() - 60_000,  recencyRank: 2, relevance: 0.82 },
		{ turnId: 's:1', role: 'user',      excerpt: 'tell me about NameNode HA',        timestamp: Date.now() - 600_000, recencyRank: 3, relevance: 0.42 },
	],
	segments: [
		{ segmentId: 's:0:4', turnId: 's:0', segmentIdx: 4, text: 'HDFS Core is the distributed filesystem layer.', timestamp: Date.now() - 60_000,  recencyRank: 1, relevance: 0.94 },
		{ segmentId: 's:0:7', turnId: 's:0', segmentIdx: 7, text: 'NameNode owns the namespace.',                    timestamp: Date.now() - 60_000,  recencyRank: 2, relevance: 0.78 },
	],
};

test('classifyPrimaryIntent: memory bundle renders into ## Recent context with [tN] / [sN] keys', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	const session = makeFakeSession(captureProvider(JSON.stringify({
		id: 'code-analysis', confidence: 0.9, reasoning: 'r', scope: 'M',
		relationship: { kind: 'DRILL_DOWN', confidence: 0.9, reasoning: 'm', citations: ['t1', 's1'] },
	}), cap));

	const out = await classifyPrimaryIntent('elaborate on the core filesystem', session, SAMPLE_MEMORY);

	const userMsg = cap.messages![1]!.content;
	// Recent context block present.
	assert.match(userMsg, /## Recent context/);
	// All three turns get [t1]..[t3] keys.
	assert.match(userMsg, /\[t1\]/);
	assert.match(userMsg, /\[t2\]/);
	assert.match(userMsg, /\[t3\]/);
	assert.match(userMsg, /\[s1\]/);
	assert.match(userMsg, /\[s2\]/);
	// Turn excerpts present.
	assert.match(userMsg, /describe what this repo does/);
	// Segment excerpt present.
	assert.match(userMsg, /HDFS Core is the distributed filesystem layer/);
	// Recencyrank 1 = most recent: matches the formatRelativeAge "min ago" format.
	assert.match(userMsg, /min ago/);

	// And the result carries the relationship.
	assert.ok(out.relationship !== undefined);
	assert.equal(out.relationship!.kind, 'DRILL_DOWN');
	assert.deepEqual(out.relationship!.citations, ['t1', 's1']);
});

test('classifyPrimaryIntent: memory unset -> no Recent context section + no relationship', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	const session = makeFakeSession(captureProvider(JSON.stringify({
		id: 'code-analysis', confidence: 0.9, reasoning: 'r', scope: 'M',
	}), cap));
	const out = await classifyPrimaryIntent('audit the codebase', session);

	const userMsg = cap.messages![0]!.content + '\n' + cap.messages![1]!.content;
	assert.ok(!/## Recent context/.test(userMsg));
	assert.ok(!/Relationship to prior conversation/.test(cap.messages![0]!.content),
		'system prompt must not have the relationship section without memory');
	assert.equal(out.relationship, undefined);
});

test('classifyPrimaryIntent: memory empty (zero hits) -> treated as absent', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	const session = makeFakeSession(captureProvider(JSON.stringify({
		id: 'code-analysis', confidence: 0.9, reasoning: 'r', scope: 'M',
	}), cap));
	const out = await classifyPrimaryIntent(
		'audit the codebase',
		session,
		{ turns: [], segments: [] },
	);
	assert.ok(!/## Recent context/.test(cap.messages![1]!.content));
	assert.equal(out.relationship, undefined);
});

test('classifyPrimaryIntent: /intent override short-circuits BEFORE any LLM call -> no relationship', async () => {
	let calls = 0;
	const session = makeFakeSession({
		async complete() { calls++; return { text: '{}', stopReason: 'end_turn' }; },
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	});
	const out = await classifyPrimaryIntent('/intent design draft this', session, SAMPLE_MEMORY);
	assert.equal(out.intent, 'design');
	assert.equal(out.relationship, undefined);
	assert.equal(calls, 0);
});
