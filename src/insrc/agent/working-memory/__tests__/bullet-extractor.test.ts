/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Tests for the bullet extractor (P1.e).
 *
 * Covered:
 * - Happy path: model returns valid `{ bullets: [...] }` -> trimmed,
 *   non-empty strings returned.
 * - Markdown-fenced JSON unwrap.
 * - Bullets clamped at MAX_BULLETS_PER_TODO even when the model overshoots.
 * - minCount/maxCount opts surface in the prompt text.
 * - Parse failures degrade to [] (one extraction miss must not fail
 *   the whole TODO transition).
 * - Provider contract: every call sends disableThinking + temperature 0
 *   + responseFormat 'json' (parity with shape + updater).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	extractBullets,
	_parseBulletsForTest as parseBullets,
	_buildExtractorPromptForTest as buildExtractorPrompt,
	MAX_BULLETS_PER_TODO_VALUE,
} from '../bullet-extractor.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { WorkingMemoryEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall {
	readonly messages: LLMMessage[];
	readonly opts:     CompletionOpts;
}

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

function makeEntry(overrides: Partial<WorkingMemoryEntry> = {}): WorkingMemoryEntry {
	return {
		todoId:    overrides.todoId    ?? 'todo-namenode',
		objective: overrides.objective ?? 'Audit NameNode persistence layer',
		detail:    overrides.detail    ?? '# NameNode\n\nFSImage and EditLog cooperate for namespace persistence.\n',
		findings:  overrides.findings  ?? {
			perRoot: [
				{ rootId: 'discover', verdict: 'accept', cyclesConsumed: 0, exhausted: false, content: 'FSImage holds inode tree; EditLog appends mutations' },
			],
		},
		completedAt: overrides.completedAt ?? 1_717_545_600_000,
		origin:      overrides.origin      ?? 'initial',
	};
}

// ---------------------------------------------------------------------------
// parseBullets
// ---------------------------------------------------------------------------

test('parseBullets: valid array returns trimmed strings', () => {
	const raw = JSON.stringify({ bullets: ['  fact A  ', 'fact B', '  ', 'fact C'] });
	const out = parseBullets(raw);
	assert.deepEqual(out, ['fact A', 'fact B', 'fact C']);    // empty string dropped
});

test('parseBullets: unwraps markdown fences', () => {
	const raw = '```json\n' + JSON.stringify({ bullets: ['x'] }) + '\n```';
	assert.deepEqual(parseBullets(raw), ['x']);
});

test('parseBullets: malformed JSON -> []', () => {
	assert.deepEqual(parseBullets('not json'), []);
});

test('parseBullets: object without bullets key -> []', () => {
	assert.deepEqual(parseBullets(JSON.stringify({ other: ['x'] })), []);
});

test('parseBullets: non-string array entries dropped', () => {
	const raw = JSON.stringify({ bullets: ['ok', 42, null, 'also ok'] });
	assert.deepEqual(parseBullets(raw), ['ok', 'also ok']);
});

// ---------------------------------------------------------------------------
// buildExtractorPrompt
// ---------------------------------------------------------------------------

test('buildExtractorPrompt: surfaces min/max counts in user message', () => {
	const entry = makeEntry();
	const { user } = buildExtractorPrompt(entry, { min: 7, max: 9 });
	assert.match(user, /7-9 prompt-agnostic key fact strings/);
	assert.match(user, /7-9 bullets, each <= 300 chars/);
});

test('buildExtractorPrompt: handles entry with no findings', () => {
	const entry = makeEntry({ findings: { perRoot: [] } });
	const { user } = buildExtractorPrompt(entry, { min: 5, max: 10 });
	assert.match(user, /\(no findings\)/);
});

// ---------------------------------------------------------------------------
// extractBullets (end-to-end against scripted provider)
// ---------------------------------------------------------------------------

test('extractBullets: happy path returns the bullets', async () => {
	const bullets = ['fact A', 'fact B', 'fact C'];
	const { provider } = scriptedProvider([JSON.stringify({ bullets })]);
	const out = await extractBullets(provider, makeEntry());
	assert.deepEqual(out, bullets);
});

test('extractBullets: every call sends disableThinking=true + temperature=0 + responseFormat=json', async () => {
	const { provider, calls } = scriptedProvider([JSON.stringify({ bullets: ['x'] })]);
	await extractBullets(provider, makeEntry());
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.opts.disableThinking, true);
	assert.equal(calls[0]!.opts.temperature, 0);
	assert.equal(calls[0]!.opts.responseFormat, 'json');
});

test('extractBullets: clamps to MAX_BULLETS_PER_TODO when model overshoots', async () => {
	const bullets = Array.from({ length: 20 }, (_, i) => `b${i}`);
	const { provider } = scriptedProvider([JSON.stringify({ bullets })]);
	const out = await extractBullets(provider, makeEntry(), { minCount: 5, maxCount: 20 });
	assert.equal(out.length, MAX_BULLETS_PER_TODO_VALUE);
});

test('extractBullets: minCount/maxCount clamp + invert protection', async () => {
	const { provider, calls } = scriptedProvider([JSON.stringify({ bullets: ['x'] })]);
	// maxCount < minCount -> max gets bumped to min.
	await extractBullets(provider, makeEntry(), { minCount: 8, maxCount: 3 });
	assert.match(calls[0]!.messages[1]!.content, /8-8 prompt-agnostic/);
});

test('extractBullets: parse failure -> []', async () => {
	const { provider } = scriptedProvider(['not json']);
	const out = await extractBullets(provider, makeEntry());
	assert.deepEqual(out, []);
});

test('extractBullets: empty bullets array from model -> []', async () => {
	const { provider } = scriptedProvider([JSON.stringify({ bullets: [] })]);
	const out = await extractBullets(provider, makeEntry());
	assert.deepEqual(out, []);
});

test('extractBullets: markdown-fenced model response is unwrapped', async () => {
	const fenced = '```json\n' + JSON.stringify({ bullets: ['a', 'b'] }) + '\n```';
	const { provider } = scriptedProvider([fenced]);
	const out = await extractBullets(provider, makeEntry());
	assert.deepEqual(out, ['a', 'b']);
});
