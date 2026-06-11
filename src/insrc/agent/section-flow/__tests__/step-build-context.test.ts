/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for runBuildContext (Phase 3 of
 * plans/section-flow-architecture-redesign.md).
 *
 * The build-context turn is a pre-shape-resolver LLM call that names
 * which artifact ids the orchestrator should fetch into the
 * shape-resolver's priorOutputs. This file covers:
 *
 *   - Happy path: valid `fetch` -> result carries the ids verbatim.
 *   - Empty fetch: `fetch: []` is a valid answer (some steps need no
 *     artifacts).
 *   - Invalid id -> one retry with corrective hint, then success.
 *   - Both attempts fail -> graceful degrade (fetch: [], gracefulDegrade=true).
 *   - Validator unit tests: every rejection branch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runBuildContext,
	_validateForTest    as validate,
	_stripFencesForTest as stripFences,
	_MAX_FETCH          as MAX_FETCH,
} from '../step-build-context.js';
import { _resetPromptRegistryForTest, registerAllPromptWriters } from '../../prompts/index.js';
import { _resetSkillRegistryForTests } from '../../../daemon/skills/registry.js';
import { registerAllSkills } from '../../../daemon/skills/index.js';
import type {
	CompletionOpts, LLMMessage, LLMProvider, LLMResponse, ToolCall,
} from '../../../shared/types.js';
import type { SkillRunnerDeps } from '../../../daemon/skills/invoke.js';

test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall { readonly messages: LLMMessage[]; readonly opts: CompletionOpts; }

function scriptedProvider(responses: readonly string[]): { provider: LLMProvider; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const provider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out of responses at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			return { text, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls };
}

/**
 * Scripted provider that supports tool-call turns. Each script entry
 * is either `{ text }` (final emission, stopReason: 'end_turn') or
 * `{ toolCalls }` (mid-loop tool-use turn, stopReason: 'tool_use').
 */
type ScriptTurn =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'toolCalls'; readonly calls: readonly ToolCall[] };

function scriptedProviderWithTools(turns: readonly ScriptTurn[]): { provider: LLMProvider; calls: RecordedCall[] } {
	const recorded: RecordedCall[] = [];
	let cursor = 0;
	const provider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			recorded.push({ messages, opts });
			if (cursor >= turns.length) {
				throw new Error(`scriptedProviderWithTools: ran out at call ${cursor + 1}`);
			}
			const turn = turns[cursor]!;
			cursor++;
			if (turn.kind === 'text') {
				return { text: turn.text, stopReason: 'end_turn' };
			}
			return { text: '', toolCalls: [...turn.calls], stopReason: 'tool_use' };
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls: recorded };
}

const TOC_IDS = new Set([
	'sess-1:100:code.entity.locate-by-name',
	'sess-1:200:shared.fs.list-files',
	'sess-1:300:shared.fs.peek',
]);

const TOC_BLOCK = [
	'## TABLE OF CONTENTS',
	'sess-1:300:shared.fs.peek: snippet of grn-basic.json. PARTIALLY supports json-shape',
	'sess-1:200:shared.fs.list-files: 25 GRN JSON files. CLOSES enumerate-grn-fixtures fully',
	'sess-1:100:code.entity.locate-by-name: located INGRN at insors/grn.py:40. CLOSES ingrn-locate fully',
].join('\n');

function baseInput(provider: LLMProvider): Parameters<typeof runBuildContext>[0] {
	return {
		stepIntent:       'extract INGRN fields by entityId',
		skillId:          'code.class.extract-fields',
		skillDescription: 'Extract declared fields of a class entity.',
		skillSchema:      '{"type":"object","required":["entityId"],"properties":{"entityId":{"type":"string","minLength":32,"maxLength":32}}}',
		todoObjective:    'Map GRN JSON to INGRN Pydantic class.',
		toc:              TOC_BLOCK,
		tocIds:           TOC_IDS,
		provider,
	};
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('runBuildContext: valid single-id fetch -> first-attempt success', async () => {
	const { provider, calls } = scriptedProvider([
		JSON.stringify({
			fetch: ['sess-1:100:code.entity.locate-by-name'],
			notes: 'need the locate artifact for the 32-char entityId required by extract-fields',
		}),
	]);
	const r = await runBuildContext(baseInput(provider));
	assert.equal(calls.length, 1);
	assert.deepEqual(r.fetchIds, ['sess-1:100:code.entity.locate-by-name']);
	assert.match(r.notes, /entityId/);
	assert.equal(r.retried, false);
	assert.equal(r.gracefulDegrade, false);
});

test('runBuildContext: empty fetch is a valid answer', async () => {
	const { provider } = scriptedProvider([
		JSON.stringify({ fetch: [], notes: 'step does a fresh grep; no artifacts needed' }),
	]);
	const r = await runBuildContext(baseInput(provider));
	assert.deepEqual(r.fetchIds, []);
	assert.equal(r.retried, false);
	assert.equal(r.gracefulDegrade, false);
});

test('runBuildContext: dedupes a duplicate id quietly', async () => {
	const id = 'sess-1:100:code.entity.locate-by-name';
	const { provider } = scriptedProvider([
		JSON.stringify({ fetch: [id, id], notes: 'noop dedupe' }),
	]);
	const r = await runBuildContext(baseInput(provider));
	assert.deepEqual(r.fetchIds, [id]);
	assert.equal(r.retried, false);
});

// ---------------------------------------------------------------------------
// Retry path
// ---------------------------------------------------------------------------

test('runBuildContext: invalid id on attempt 1 -> retry with corrective hint succeeds', async () => {
	const { provider, calls } = scriptedProvider([
		JSON.stringify({ fetch: ['sess-1:999:invented-by-llm'], notes: '...' }),
		JSON.stringify({
			fetch: ['sess-1:100:code.entity.locate-by-name'],
			notes: 'corrected after retry',
		}),
	]);
	const r = await runBuildContext(baseInput(provider));
	assert.equal(calls.length, 2);
	assert.deepEqual(r.fetchIds, ['sess-1:100:code.entity.locate-by-name']);
	assert.equal(r.retried, true);
	assert.equal(r.gracefulDegrade, false);
	assert.match(r.firstFailureReason ?? '', /not in the TOC/);
	assert.match(calls[1]!.messages[1]!.content, /RETRY CORRECTION/);
});

test('runBuildContext: both attempts fail validation -> graceful degrade to fetch:[]', async () => {
	const { provider, calls } = scriptedProvider([
		JSON.stringify({ fetch: ['sess-1:999:made-up'], notes: '...' }),
		JSON.stringify({ fetch: ['sess-1:888:also-made-up'], notes: '...' }),
	]);
	const r = await runBuildContext(baseInput(provider));
	assert.equal(calls.length, 2);
	assert.deepEqual(r.fetchIds, []);
	assert.equal(r.gracefulDegrade, true);
	assert.equal(r.retried, true);
	assert.match(r.firstFailureReason ?? '', /not in the TOC/);
	assert.match(r.notes, /fell back to fetch/);
});

test('runBuildContext: non-JSON garbage -> retry then graceful degrade', async () => {
	const { provider } = scriptedProvider([
		'I think you should fetch the locate artifact.',
		'I really mean it this time.',
	]);
	const r = await runBuildContext(baseInput(provider));
	assert.equal(r.gracefulDegrade, true);
	assert.deepEqual(r.fetchIds, []);
	assert.match(r.firstFailureReason ?? '', /JSON parse failed/);
});

// ---------------------------------------------------------------------------
// validate() unit tests
// ---------------------------------------------------------------------------

test('validate: non-JSON -> rejected', () => {
	const r = validate('not json at all', TOC_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /JSON parse failed/); }
});

test('validate: top-level not an object -> rejected', () => {
	const r = validate(JSON.stringify(['array', 'not', 'object']), TOC_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /not a JSON object/); }
});

test('validate: fetch not an array -> rejected', () => {
	const r = validate(JSON.stringify({ fetch: 'single-id', notes: '' }), TOC_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /must be an array/); }
});

test('validate: fetch entry not a string -> rejected', () => {
	const r = validate(JSON.stringify({ fetch: [42], notes: '' }), TOC_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /not a non-empty string/); }
});

test('validate: fetch id not in TOC -> rejected with helpful sample', () => {
	const r = validate(JSON.stringify({ fetch: ['sess-1:404:missing'], notes: '' }), TOC_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.match(r.reason, /not in the TOC/);
		assert.match(r.reason, /sess-1:100|sess-1:200|sess-1:300/);
	}
});

test('validate: fetch exceeds MAX_FETCH cap -> rejected', () => {
	const big = Array.from({ length: MAX_FETCH + 1 }, (_, i) => `sess-1:${i}:x`);
	const r = validate(JSON.stringify({ fetch: big, notes: '' }), new Set(big));
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /cap is/); }
});

test('validate: handles markdown fences around the JSON body', () => {
	const fenced = '```json\n' + JSON.stringify({
		fetch: ['sess-1:100:code.entity.locate-by-name'],
		notes: 'fenced response, still valid',
	}) + '\n```';
	const r = validate(fenced, TOC_IDS);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.deepEqual(r.fetchIds, ['sess-1:100:code.entity.locate-by-name']);
	}
});

test('validate: notes missing or non-string -> still accepted, notes=""', () => {
	const r = validate(JSON.stringify({ fetch: ['sess-1:100:code.entity.locate-by-name'] }), TOC_IDS);
	assert.equal(r.ok, true);
	if (r.ok) { assert.equal(r.notes, ''); }
});

// ---------------------------------------------------------------------------
// stripFences
// ---------------------------------------------------------------------------

test('stripFences: ```json ... ``` -> body', () => {
	assert.equal(stripFences('```json\n{}\n```'), '{}');
});

test('stripFences: no fences -> trimmed body', () => {
	assert.equal(stripFences('  {}  '), '{}');
});

// ---------------------------------------------------------------------------
// Tool-loop path (Phase 3 plan: shared.fs.list-files + shared.fs.peek)
// ---------------------------------------------------------------------------

const fakeRunnerDeps: SkillRunnerDeps = {
	session:         { id: 'test-session' } as unknown as SkillRunnerDeps['session'],
	resolveProvider: () => ({} as unknown as LLMProvider),
};

test('runBuildContext: tools omitted when runnerDeps undefined', async () => {
	_resetSkillRegistryForTests();
	registerAllSkills();
	const { provider, calls } = scriptedProvider([
		JSON.stringify({ fetch: [], notes: 'noop' }),
	]);
	await runBuildContext({ ...baseInput(provider), tocIds: new Set<string>(), toc: '## TOC\n(no artifacts persisted yet)' });
	assert.equal(calls.length, 1);
	// No tools in opts when runnerDeps is undefined.
	assert.equal(calls[0]!.opts.tools, undefined);
});

test('runBuildContext: runnerDeps supplied -> tools surfaced to provider', async () => {
	_resetSkillRegistryForTests();
	registerAllSkills();
	const { provider, calls } = scriptedProviderWithTools([
		{ kind: 'text', text: JSON.stringify({ fetch: [], notes: 'no tool needed' }) },
	]);
	await runBuildContext({
		...baseInput(provider),
		tocIds:     new Set<string>(),
		toc:        '## TOC\n(no artifacts persisted yet)',
		runnerDeps: fakeRunnerDeps,
	});
	assert.equal(calls.length, 1);
	const toolNames = (calls[0]!.opts.tools ?? []).map(t => t.name).sort();
	assert.deepEqual(toolNames, ['shared.fs.list-files', 'shared.fs.peek']);
});

test('runBuildContext: model emits a tool call -> runner invoked, second turn produces JSON', async () => {
	_resetSkillRegistryForTests();
	registerAllSkills();
	const { provider, calls } = scriptedProviderWithTools([
		{ kind: 'toolCalls', calls: [{
			id:    'tc-1',
			name:  'shared.fs.list-files',
			input: { path: '/tmp/insors-build-context-test-nonexistent', recursive: false },
		}] },
		{ kind: 'text', text: JSON.stringify({ fetch: [], notes: 'no useful files; bare priors are fine' }) },
	]);
	const r = await runBuildContext({
		...baseInput(provider),
		tocIds:     new Set<string>(),
		toc:        '## TOC\n(no artifacts persisted yet)',
		runnerDeps: fakeRunnerDeps,
	});
	// 2 provider calls: the tool-use turn + the final-JSON turn.
	assert.equal(calls.length, 2);
	// The second turn's messages must include the assistant's tool_use
	// block + the user's tool_result block from the runner.
	const secondMessages = calls[1]!.messages;
	const lastAssistant = secondMessages.find(m => m.role === 'assistant');
	const lastUser = secondMessages[secondMessages.length - 1]!;
	assert.ok(lastAssistant !== undefined, 'second turn should carry the assistant tool_use turn');
	assert.equal(lastUser.role, 'user');
	assert.ok(Array.isArray(lastUser.content), 'last user message should be a content-block array (tool_result)');
	const blocks = lastUser.content;
	assert.ok(blocks.some(b => b.type === 'tool_result' && b.tool_use_id === 'tc-1'), 'tool_result block missing');
	// Final answer surfaces.
	assert.equal(r.gracefulDegrade, false);
	assert.deepEqual(r.fetchIds, []);
	assert.match(r.notes, /bare priors/);
});

test('runBuildContext: tool-iteration cap respected (no infinite loop)', async () => {
	_resetSkillRegistryForTests();
	registerAllSkills();
	// Script emits tool-call turns indefinitely; the cap forces the
	// caller to give up after 2 iterations and parse whatever text the
	// 3rd turn produced (a tool-call turn here, so .text is empty ->
	// validate() will fail and trigger the retry path).
	const turns: ScriptTurn[] = [];
	for (let i = 0; i < 10; i++) {
		turns.push({ kind: 'toolCalls', calls: [{
			id:    `tc-${i}`,
			name:  'shared.fs.list-files',
			input: { path: '/tmp/insors-build-context-test-nonexistent' },
		}] });
	}
	const { provider, calls } = scriptedProviderWithTools(turns);
	const r = await runBuildContext({
		...baseInput(provider),
		tocIds:     new Set<string>(),
		toc:        '## TOC\n(no artifacts persisted yet)',
		runnerDeps: fakeRunnerDeps,
	});
	// First attempt: 3 turns (2 tool iters + 1 cap-exit) -> empty text -> retry
	// Retry: another 3 turns -> empty text -> graceful degrade.
	// Total: 6 provider calls.
	assert.equal(calls.length, 6);
	assert.equal(r.gracefulDegrade, true);
	assert.deepEqual(r.fetchIds, []);
});
