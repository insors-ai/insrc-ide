/**
 * Tests for the question-enhancer
 * (conversation-flow-refinement.md Phase 3.3).
 *
 * Two layers:
 *
 *   1. Pure parser/builder helpers: `parseAndValidate`, `stripFences`,
 *      `buildMessages` (snapshot of the prompt shape to verify
 *      `spill_path` lines + retry-hint placement).
 *
 *   2. enhanceQuestion end-to-end with a fake LLM provider that
 *      returns canned JSON. Covers happy / retry / hard-cap /
 *      pass-through / re-fetch round.
 *
 * The enhancer's provider goes through `resolveClassifierProvider`,
 * which reads `session.resolver.resolve(...)`. We stub that to
 * always return our fake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	enhanceQuestion,
	_parseAndValidateForTest as parseAndValidate,
	_stripFencesForTest as stripFences,
	_buildMessagesForTest as buildMessages,
	MAX_REQUESTED_REFETCHES_FOR_TEST,
	MAX_INLINE_ARTIFACTS_FOR_TEST,
} from '../enhancer.js';
import type { PriorContext, RetrievedArtifact } from '../retriever.js';
import type { Session } from '../../session.js';
import type { LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface QueuedResponse {
	readonly text: string;
}

function buildFakeProvider(responses: readonly QueuedResponse[]): { provider: LLMProvider; calls: number } {
	let i = 0;
	const counter = { calls: 0 };
	const provider: LLMProvider = {
		async complete(_messages: readonly LLMMessage[]): Promise<LLMResponse> {
			counter.calls++;
			const r = responses[Math.min(i, responses.length - 1)];
			i++;
			return { text: r?.text ?? '', stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
	return { provider, get calls() { return counter.calls; } } as { provider: LLMProvider; calls: number };
}

function makeFakeSession(provider: LLMProvider): Session {
	const tags = new Map<string, string>();
	const stub = {
		id:        'fake-session',
		repoPath:  '',
		startedAt: Date.now(),
		contextManager: {
			setTag: (k: string, v: string) => { tags.set(k, v); },
			getTag: (k: string) => tags.get(k) ?? '',
			hasTag: (k: string) => tags.has(k),
		},
		resolver: { resolve: () => provider },
		ollamaProvider: provider,
		claudeProvider: null,
	} as unknown as Session;
	return stub;
}

const FACT_MODULES = [
	{ path: '/repo/hadoop/hadoop-hdfs', label: 'HDFS Core', fileCount: 240 },
	{ path: '/repo/hadoop/hadoop-yarn', label: 'YARN',      fileCount: 180 },
];

function priorContextWithModules(): PriorContext {
	return {
		currentIntent: 'code-analysis',
		intentChanged: false,
		artifacts: [
			makeArtifact('a1', 'code.source.repo.describe',
				JSON.stringify({ topModules: FACT_MODULES }), 0.81, 60_000),
		],
		facts: { modules: FACT_MODULES },
	};
}

function makeArtifact(id: string, skillId: string, preview: string, score: number, ageMs: number): RetrievedArtifact {
	return {
		id,
		skillId,
		intent:    'code-analysis',
		timestamp: Date.now() - ageMs,
		score,
		path:      `/tmp/insrc/fake/${Date.now()}-${skillId}.json`,
		preview,
	};
}

const EMPTY_PRIOR_CONTEXT: PriorContext = {
	currentIntent: 'code-analysis',
	intentChanged: false,
	artifacts:     [],
	facts:         {},
};

// ---------------------------------------------------------------------------
// stripFences + parseAndValidate
// ---------------------------------------------------------------------------

test('stripFences: unwraps ```json fences', () => {
	const text = '```json\n{"a":1}\n```';
	assert.equal(stripFences(text), '{"a":1}');
});

test('stripFences: leaves plain text alone', () => {
	assert.equal(stripFences('{"a":1}'), '{"a":1}');
});

test('parseAndValidate: well-formed output passes', () => {
	const r = parseAndValidate(JSON.stringify({
		enhancedQuestion: 'q',
		citedArtifactIds: [],
		requestArtifactIds: [],
		notes: [],
	}), EMPTY_PRIOR_CONTEXT);
	assert.equal(r.ok, true);
});

test('parseAndValidate: missing enhancedQuestion -> rejected', () => {
	const r = parseAndValidate(JSON.stringify({
		citedArtifactIds: [], requestArtifactIds: [],
	}), EMPTY_PRIOR_CONTEXT);
	assert.equal(r.ok, false);
});

test('parseAndValidate: requestArtifactIds with unknown id -> rejected', () => {
	const r = parseAndValidate(JSON.stringify({
		enhancedQuestion: 'q',
		citedArtifactIds: [],
		requestArtifactIds: ['ghost-id'],
		notes: [],
	}), priorContextWithModules());
	assert.equal(r.ok, false);
});

test('parseAndValidate: citedArtifactIds for unknown ids are dropped (not rejected)', () => {
	const r = parseAndValidate(JSON.stringify({
		enhancedQuestion: 'q',
		citedArtifactIds: ['ghost-id', 'a1'],
		requestArtifactIds: [],
		notes: [],
	}), priorContextWithModules());
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.deepEqual(r.value.citedArtifactIds, ['a1']);
	}
});

// ---------------------------------------------------------------------------
// buildMessages snapshot (asserts spill_path appears in the prompt)
// ---------------------------------------------------------------------------

test('buildMessages: emits spill_path line per inline artifact', () => {
	const ctx = priorContextWithModules();
	const msgs = buildMessages({ originalMessage: 'describe HDFS Core', priorContext: ctx }, undefined);
	const userBlock = msgs[1]!.content as string;
	assert.match(userBlock, /spill_path:/);
	assert.match(userBlock, /artifact_id: a1/);
});

test('buildMessages: caps inline previews at MAX_INLINE_ARTIFACTS', () => {
	const arts: RetrievedArtifact[] = [];
	for (let i = 0; i < MAX_INLINE_ARTIFACTS_FOR_TEST + 3; i++) {
		arts.push(makeArtifact(`a${i}`, 'code.source.repo.describe', '{}', 0.5, 1000));
	}
	const ctx: PriorContext = {
		currentIntent: 'code-analysis',
		intentChanged: false,
		artifacts: arts,
		facts: {},
	};
	const msgs = buildMessages({ originalMessage: 'q', priorContext: ctx }, undefined);
	const block = msgs[1]!.content as string;
	for (let i = 0; i < MAX_INLINE_ARTIFACTS_FOR_TEST; i++) {
		assert.match(block, new RegExp(`artifact_id: a${i}\\b`));
	}
	assert.equal(block.includes(`artifact_id: a${MAX_INLINE_ARTIFACTS_FOR_TEST}`), false);
});

test('buildMessages: includes Full artifact bodies section on second pass', () => {
	const ctx = priorContextWithModules();
	const inline = [{
		artifactId: 'a1',
		skillId:    'code.source.repo.describe',
		value:      { fileCount: 12500 },
	}];
	const msgs = buildMessages({ originalMessage: 'q', priorContext: ctx }, inline);
	const block = msgs[1]!.content as string;
	assert.match(block, /## Full artifact bodies/);
	assert.match(block, /artifact_id: a1/);
});

// ---------------------------------------------------------------------------
// Phase 5.2: intent-shift signaling
// ---------------------------------------------------------------------------

test('buildMessages: stable intent -> no shift note in user prompt', () => {
	const ctx = priorContextWithModules();   // intentChanged = false
	const msgs = buildMessages({ originalMessage: 'q', priorContext: ctx }, undefined);
	const block = msgs[1]!.content as string;
	assert.equal(block.includes('Note: intent shifted'), false);
});

test('buildMessages: shifted intent -> emits shift note + system rule 6 reference', () => {
	const ctx: PriorContext = {
		currentIntent:  'data-analysis',
		intentChanged:  true,
		previousIntent: 'code-analysis',
		artifacts:      [],
		facts:          { tables: [{ connectionId: 'main', name: 'users' }] },
	};
	const msgs = buildMessages({ originalMessage: 'schema of users', priorContext: ctx }, undefined);
	const block = msgs[1]!.content as string;
	assert.match(block, /Note: intent shifted from `code-analysis` to `data-analysis`/);
	assert.match(block, /system rule 6/);
	// The current-intent line still appears, but stays clean.
	assert.match(block, /## Current intent\ndata-analysis/);
});

test('buildMessages: intentChanged=true without previousIntent -> no shift note (defensive)', () => {
	// Should not happen in practice (retriever always populates the
	// pair together), but the renderer must not blow up.
	const ctx: PriorContext = {
		currentIntent:  'data-analysis',
		intentChanged:  true,
		artifacts:      [],
		facts:          {},
	};
	const msgs = buildMessages({ originalMessage: 'q', priorContext: ctx }, undefined);
	const block = msgs[1]!.content as string;
	assert.equal(block.includes('Note: intent shifted'), false);
});

test('SYSTEM_PROMPT carries rule 6 (cross-intent translation)', () => {
	// Indirect: rule 6 has to be in the system message that buildMessages
	// emits, otherwise rule 6 references in the user-prompt note are
	// dangling. Pull the system message from a buildMessages call.
	const msgs = buildMessages({ originalMessage: 'q', priorContext: EMPTY_PRIOR_CONTEXT }, undefined);
	const sys = msgs[0]!.content as string;
	assert.match(sys, /6\. INTENT SHIFT/);
});

// ---------------------------------------------------------------------------
// enhanceQuestion end-to-end
// ---------------------------------------------------------------------------

test('enhanceQuestion: empty message -> pass-through', async () => {
	const fake = buildFakeProvider([]);
	const session = makeFakeSession(fake.provider);
	const out = await enhanceQuestion(session, {
		originalMessage: '   ',
		priorContext:    EMPTY_PRIOR_CONTEXT,
	});
	assert.equal(out.enhancedQuestion, '');
	assert.equal(fake.calls, 0, 'pass-through must not call the LLM');
});

test('enhanceQuestion: happy path -> rewrite + cited ids', async () => {
	const fake = buildFakeProvider([{
		text: JSON.stringify({
			enhancedQuestion:   'describe the module at /repo/hadoop/hadoop-hdfs',
			citedArtifactIds:   ['a1'],
			requestArtifactIds: [],
			notes:              [],
		}),
	}]);
	const session = makeFakeSession(fake.provider);
	const out = await enhanceQuestion(session, {
		originalMessage: 'describe HDFS Core',
		priorContext:    priorContextWithModules(),
	});
	assert.equal(out.enhancedQuestion, 'describe the module at /repo/hadoop/hadoop-hdfs');
	assert.deepEqual(out.citedArtifactIds, ['a1']);
	assert.deepEqual(out.requestArtifactIds, []);
});

test('enhanceQuestion: invalid first-pass -> validation retry succeeds', async () => {
	const valid = JSON.stringify({
		enhancedQuestion: 'q', citedArtifactIds: [], requestArtifactIds: [], notes: [],
	});
	const fake = buildFakeProvider([
		{ text: 'not-json-at-all' },
		{ text: valid },
	]);
	const session = makeFakeSession(fake.provider);
	const out = await enhanceQuestion(session, {
		originalMessage: 'q',
		priorContext:    EMPTY_PRIOR_CONTEXT,
	});
	assert.equal(out.enhancedQuestion, 'q');
});

test('enhanceQuestion: both passes invalid -> pass-through with note', async () => {
	const fake = buildFakeProvider([
		{ text: 'garbage one' },
		{ text: 'garbage two' },
	]);
	const session = makeFakeSession(fake.provider);
	const original = 'an original message';
	const out = await enhanceQuestion(session, {
		originalMessage: original,
		priorContext:    EMPTY_PRIOR_CONTEXT,
	});
	assert.equal(out.enhancedQuestion, original);
	assert.ok((out.notes ?? []).join(' ').length > 0);
});

test('enhanceQuestion: re-fetch round inlines requested bodies + second pass honored', async () => {
	// Set up a real spill file on disk so the loader can read it.
	const dir = mkdtempSync(join(tmpdir(), 'insrc-enhancer-refetch-'));
	const file = join(dir, 'a1.json');
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, JSON.stringify({
		session_id:  'fake',
		skill_id:    'code.source.repo.describe',
		value:       { fileCount: 12500, topModules: FACT_MODULES },
	}));

	const ctx: PriorContext = {
		currentIntent: 'code-analysis',
		intentChanged: false,
		artifacts: [{
			id:        'a1',
			skillId:   'code.source.repo.describe',
			intent:    'code-analysis',
			timestamp: Date.now() - 60_000,
			score:     0.81,
			path:      file,        // <- read from this path
			preview:   '{"truncated":"yes"}',
		}],
		facts: {},
	};

	try {
		const fake = buildFakeProvider([
			// First pass: requests a1.
			{ text: JSON.stringify({
				enhancedQuestion: 'tentative',
				citedArtifactIds: [],
				requestArtifactIds: ['a1'],
				notes: [],
			}) },
			// Second pass: full body inlined; produces a final rewrite.
			{ text: JSON.stringify({
				enhancedQuestion: 'final rewrite using full body',
				citedArtifactIds: ['a1'],
				requestArtifactIds: [],
				notes: [],
			}) },
		]);
		const session = makeFakeSession(fake.provider);
		const out = await enhanceQuestion(session, {
			originalMessage: 'describe HDFS Core',
			priorContext:    ctx,
		});
		assert.equal(out.enhancedQuestion, 'final rewrite using full body');
		assert.deepEqual(out.citedArtifactIds, ['a1']);
		// Hard cap: requestArtifactIds is cleared on the returned output
		// regardless of what the second pass said.
		assert.deepEqual(out.requestArtifactIds, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('enhanceQuestion: second-pass requestArtifactIds is IGNORED (one-round hard cap)', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'insrc-enhancer-cap-'));
	const file = join(dir, 'a1.json');
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, JSON.stringify({ session_id: 'fake', skill_id: 's', value: {} }));

	const ctx: PriorContext = {
		currentIntent: 'code-analysis',
		intentChanged: false,
		artifacts: [{
			id: 'a1', skillId: 's', intent: 'code-analysis',
			timestamp: Date.now(), score: 0.5, path: file, preview: '{}',
		}],
		facts: {},
	};

	try {
		const fake = buildFakeProvider([
			{ text: JSON.stringify({
				enhancedQuestion: 'first', citedArtifactIds: [],
				requestArtifactIds: ['a1'], notes: [],
			}) },
			{ text: JSON.stringify({
				enhancedQuestion: 'second',
				citedArtifactIds: [],
				requestArtifactIds: ['a1'],     // tries again -- must be ignored
				notes: [],
			}) },
			// If the runner respects the cap, this third response is never read.
			{ text: '{"enhancedQuestion":"third should not appear","citedArtifactIds":[],"requestArtifactIds":[],"notes":[]}' },
		]);
		const session = makeFakeSession(fake.provider);
		const out = await enhanceQuestion(session, {
			originalMessage: 'q',
			priorContext:    ctx,
		});
		assert.equal(out.enhancedQuestion, 'second',
			'second-pass output is the final answer; third pass must NOT happen');
		assert.deepEqual(out.requestArtifactIds, []);
		assert.equal(fake.calls, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('enhanceQuestion: requested artifact body fails to load -> falls back to first-pass output', async () => {
	const ctx: PriorContext = {
		currentIntent: 'code-analysis',
		intentChanged: false,
		artifacts: [{
			id: 'a1', skillId: 's', intent: 'code-analysis',
			timestamp: Date.now(), score: 0.5,
			path: '/nonexistent/path/that/cannot/be/read.json',
			preview: '{}',
		}],
		facts: {},
	};
	const fake = buildFakeProvider([
		{ text: JSON.stringify({
			enhancedQuestion: 'first-pass rewrite',
			citedArtifactIds: ['a1'],
			requestArtifactIds: ['a1'],
			notes: [],
		}) },
		// If the loader fails, the runner skips the second LLM call.
		{ text: 'should-not-be-read' },
	]);
	const session = makeFakeSession(fake.provider);
	const out = await enhanceQuestion(session, {
		originalMessage: 'q', priorContext: ctx,
	});
	assert.equal(out.enhancedQuestion, 'first-pass rewrite');
	// Only one LLM call happened (first pass) -- loader failure
	// short-circuited the round.
	assert.equal(fake.calls, 1);
});

// MAX_REQUESTED_REFETCHES is in scope -- assert it's <= 3 per the
// design contract (system rule #5 allows up to 3).
test('MAX_REQUESTED_REFETCHES is at most 3 (design cap)', () => {
	assert.ok(MAX_REQUESTED_REFETCHES_FOR_TEST <= 3);
});
