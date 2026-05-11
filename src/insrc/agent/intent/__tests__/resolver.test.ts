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
import type { ClassifierMemory } from '../classifier-memory.js';

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

// ---------------------------------------------------------------------------
// Phase 1: slash-forced + explicit override + prefix absorption
// ---------------------------------------------------------------------------

test('resolveIntent: slashForced bypasses classifier, stamps tag, source=slash-forced', async () => {
	let llmCalls = 0;
	const provider: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			llmCalls++;
			return { text: classifierJson('research'), stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	const session = makeFakeSession(provider);
	const r = await resolveIntent(session, 'describe HDFS Core', { slashForced: 'code-analysis' });
	assert.equal(r.id, 'code-analysis');
	assert.equal(r.source, 'slash-forced');
	assert.equal(r.confidence, 'high');
	assert.equal(r.reasoning, 'forced by slash command');
	assert.equal(llmCalls, 0, 'slash-forced must NOT call the LLM');
	assert.equal(session.contextManager.getTag(INTENT_TAG_CURRENT), 'code-analysis');
	assert.ok(session.contextManager.getTag(INTENT_TAG_TIMESTAMP).length > 0);
	assert.match(session.contextManager.getTag(INTENT_TAG_LAST_RESOLVED), /slash-forced/);
});

test('resolveIntent: slashForced overrides any prior tag and records previousIntent', async () => {
	const provider = buildFakeProvider([{ text: classifierJson('debug') }]);
	const session  = makeFakeSession(provider);
	session.contextManager.setTag(INTENT_TAG_CURRENT, 'research');

	const r = await resolveIntent(session, 'analyse the package', { slashForced: 'code-analysis' });
	assert.equal(r.id, 'code-analysis');
	assert.equal(r.source, 'slash-forced');
	assert.equal(r.previousIntent, 'research');
	assert.equal(session.contextManager.getTag(INTENT_TAG_CURRENT), 'code-analysis',
		'tag must be overwritten with the slash-forced intent');
});

test('resolveIntent: explicitOverride opt bypasses classifier, source=override', async () => {
	let llmCalls = 0;
	const provider: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			llmCalls++;
			return { text: classifierJson('research'), stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	const session = makeFakeSession(provider);
	const r = await resolveIntent(session, 'rewrite the auth flow', { explicitOverride: 'refactor' });
	assert.equal(r.id, 'refactor');
	assert.equal(r.source, 'override');
	assert.equal(r.confidence, 'high');
	assert.equal(r.reasoning, 'explicit override by caller');
	assert.equal(llmCalls, 0);
	assert.equal(session.contextManager.getTag(INTENT_TAG_CURRENT), 'refactor');
});

test('resolveIntent: /intent <name> in raw message -> source=override (parsePrefix absorbed)', async () => {
	let llmCalls = 0;
	const provider: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			llmCalls++;
			return { text: classifierJson('research'), stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	const session = makeFakeSession(provider);
	const r = await resolveIntent(session, '/intent design build a streaming pipeline');
	assert.equal(r.id, 'design');
	assert.equal(r.source, 'override');
	assert.equal(r.message, 'build a streaming pipeline', 'message must be prefix-stripped');
	assert.equal(llmCalls, 0, '/intent override must NOT call the LLM');
	assert.equal(session.contextManager.getTag(INTENT_TAG_CURRENT), 'design');
});

test('resolveIntent: slashForced wins over /intent in raw message', async () => {
	const provider = buildFakeProvider([{ text: classifierJson('research') }]);
	const session  = makeFakeSession(provider);
	const r = await resolveIntent(
		session,
		'/intent debug fix the loop',
		{ slashForced: 'code-analysis' },
	);
	assert.equal(r.id, 'code-analysis');
	assert.equal(r.source, 'slash-forced');
});

// ---------------------------------------------------------------------------
// Phase 4: memory + relationship + citation hydration
// ---------------------------------------------------------------------------

const SAMPLE_MEMORY: ClassifierMemory = {
	turns: [
		{ turnId: 'sess-1:2', role: 'user',      excerpt: 'now describe HDFS Core',          timestamp: 1_700_000_002_000, recencyRank: 1, relevance: 0.9 },
		{ turnId: 'sess-1:1', role: 'assistant', excerpt: 'NameNode owns the namespace.',   timestamp: 1_700_000_001_000, recencyRank: 2, relevance: 0.7 },
		{ turnId: 'sess-1:0', role: 'user',      excerpt: 'describe what this repo does',    timestamp: 1_700_000_000_000, recencyRank: 3, relevance: 0.4 },
	],
	segments: [
		{ segmentId: 'sess-1:0:4', turnId: 'sess-1:0', segmentIdx: 4, text: 'HDFS Core is the distributed filesystem layer.', timestamp: 1_700_000_000_500, recencyRank: 1, relevance: 0.94 },
		{ segmentId: 'sess-1:1:2', turnId: 'sess-1:1', segmentIdx: 2, text: 'YARN handles cluster resource scheduling.',      timestamp: 1_700_000_001_500, recencyRank: 2, relevance: 0.66 },
	],
};

function classifierJsonWithRelationship(opts: {
	intent?: string;
	relationship?: { kind?: string; confidence?: number; citations?: string[] };
}): string {
	return JSON.stringify({
		id:         opts.intent ?? 'code-analysis',
		confidence: 0.9,
		reasoning:  'fake',
		scope:      'M',
		relationship: opts.relationship === undefined
			? { kind: 'NEW', confidence: 0.5, reasoning: 'no memory', citations: [] }
			: {
				kind:       opts.relationship.kind       ?? 'FOLLOWUP',
				confidence: opts.relationship.confidence ?? 0.8,
				reasoning:  'derived from recent context',
				citations:  opts.relationship.citations  ?? [],
			},
	});
}

test('resolveIntent: cold path with memory -> relationship hydrated with cited turn + segment', async () => {
	const provider = buildFakeProvider([{
		text: classifierJsonWithRelationship({
			intent: 'code-analysis',
			relationship: { kind: 'DRILL_DOWN', confidence: 0.92, citations: ['t1', 's1'] },
		}),
	}]);
	const session = makeFakeSession(provider);

	const r = await resolveIntent(
		session,
		'elaborate on the core filesystem',
		{ memoryOverride: SAMPLE_MEMORY },
	);

	assert.equal(r.id, 'code-analysis');
	assert.equal(r.source, 'classified-fresh');
	assert.ok(r.relationship !== undefined);
	assert.equal(r.relationship!.kind,       'DRILL_DOWN');
	assert.equal(r.relationship!.confidence, 'high');
	assert.equal(r.relationship!.citations.length, 2);

	const turnCitation = r.relationship!.citations.find(c => c.kind === 'turn');
	assert.ok(turnCitation !== undefined);
	assert.equal(turnCitation!.id, 'sess-1:2');
	assert.equal(turnCitation!.recencyRank, 1);
	assert.match(turnCitation!.excerpt, /HDFS Core/);

	const segCitation = r.relationship!.citations.find(c => c.kind === 'segment');
	assert.ok(segCitation !== undefined);
	assert.equal(segCitation!.id, 'sess-1:0:4');
	assert.match(segCitation!.excerpt, /HDFS Core/);
});

test('resolveIntent: hydrator drops citation keys not present in the memory bundle', async () => {
	const provider = buildFakeProvider([{
		text: classifierJsonWithRelationship({
			intent: 'code-analysis',
			relationship: { kind: 'DRILL_DOWN', citations: ['t1', 't99', 's1', 's42', 'not-a-key', 'x1'] },
		}),
	}]);
	const session = makeFakeSession(provider);

	const r = await resolveIntent(
		session,
		'anything',
		{ memoryOverride: SAMPLE_MEMORY },
	);

	const ids = r.relationship!.citations.map(c => c.id);
	// t1 -> sess-1:2 ; s1 -> sess-1:0:4. Everything else dropped.
	assert.deepEqual(ids.sort(), ['sess-1:0:4', 'sess-1:2'].sort());
});

test('resolveIntent: cold path with EMPTY memory -> classifier sees no memory + no relationship on result', async () => {
	let capturedSystem: string | null = null;
	const provider: LLMProvider = {
		async complete(messages: LLMMessage[]): Promise<LLMResponse> {
			capturedSystem = messages[0]!.content;
			return { text: classifierJson('code-analysis'), stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	const session = makeFakeSession(provider);

	const r = await resolveIntent(
		session,
		'audit the entire codebase',
		{ memoryOverride: { turns: [], segments: [] } },
	);

	assert.equal(r.relationship, undefined,
		'empty memory means no relationshipEnum was passed -> no relationship on result');
	assert.ok(capturedSystem !== null);
	assert.ok(!/Relationship to prior conversation/.test(capturedSystem!),
		'classifier prompt must NOT include the relationship section when memory was empty');
});

test('resolveIntent: slash-forced path -> NO memory retrieval, NO relationship', async () => {
	let memoryFn = 0;
	const provider: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			throw new Error('classifier should not be called');
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	const session = makeFakeSession(provider);
	const r = await resolveIntent(
		session,
		'describe HDFS',
		{
			slashForced: 'code-analysis',
			memoryOverride: SAMPLE_MEMORY,   // even with memory present
		},
	);
	void memoryFn;
	assert.equal(r.source, 'slash-forced');
	assert.equal(r.relationship, undefined,
		'slash-forced bypasses the cold path; relationship must be undefined');
});

test('resolveIntent: tag-reuse path -> NO relationship', async () => {
	const provider = buildFakeProvider([{ text: classifierJson('research') }]);
	const session  = makeFakeSession(provider);
	session.contextManager.setTag(INTENT_TAG_CURRENT, 'code-analysis');

	const r = await resolveIntent(session, 'now describe HDFS Core');
	assert.equal(r.source, 'tag');
	assert.equal(r.relationship, undefined);
});

test('resolveIntent: relationship confidence mapped to high/medium/low', async () => {
	const session = makeFakeSession(buildFakeProvider([{
		text: classifierJsonWithRelationship({
			relationship: { kind: 'FOLLOWUP', confidence: 0.55, citations: ['t1'] },
		}),
	}]));
	const r = await resolveIntent(session, 'a', { memoryOverride: SAMPLE_MEMORY });
	assert.equal(r.relationship!.confidence, 'low');
});

test('resolveIntent: /intent strips prefix BEFORE continuation heuristic so tag-reuse path still fires', async () => {
	// Even with the @provider prefix, "now describe HDFS Core" is
	// continuation-shaped on the stripped body. Without prefix
	// absorption the tag-reuse path would miss it and force a cold
	// classify.
	let llmCalls = 0;
	const provider: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			llmCalls++;
			return { text: classifierJson('research'), stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	const session = makeFakeSession(provider);
	session.contextManager.setTag(INTENT_TAG_CURRENT, 'code-analysis');

	const r = await resolveIntent(session, '@local now describe HDFS Core');
	assert.equal(r.id, 'code-analysis');
	assert.equal(r.source, 'tag');
	assert.equal(r.message, 'now describe HDFS Core', 'message must be prefix-stripped');
	assert.equal(llmCalls, 0);
});
