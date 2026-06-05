/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Tests for the section review loop (P3.c, part 2 / Q5).
 *
 * Covered:
 * - Initial accept -> 1 call, cyclesConsumed=0, finalVerdict=accept.
 * - revise-edits -> rewrite -> accept -> cyclesConsumed=1.
 * - revise-edits cap hit (cyclesConsumed === SECTION_REVIEW_CYCLE_CAP)
 *   -> finalVerdict='force-accept', exhausted=true.
 * - revise-major escalation: reopenRequested=true; subsequent
 *   revise/review calls NOT made; finalMarkdown is the candidate at
 *   escalation time.
 * - Parse robustness: malformed JSON degrades to accept;
 *   markdown-fence unwrap.
 * - LLM contract: review calls have responseFormat=json; revise calls
 *   do NOT (output is markdown). Both have disableThinking + temp 0.
 * - Prompt structure: review user has objective + findings + cycles
 *   counter; revise user has current section + edits string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	reviewSection,
	_parseReviewForTest as parseReview,
	_buildReviewUserForTest as buildReviewUser,
	_buildReviseUserForTest as buildReviseUser,
	SECTION_REVIEW_CYCLE_CAP_VALUE,
} from '../step-section-review.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { MemoryShapeBundle } from '../../working-memory/index.js';
import type { WorkingMemoryFindings } from '../../working-memory/types.js';
import type { TodoSpec } from '../types.js';

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

const todo: TodoSpec = { id: 'todo-x', objective: 'Investigate X', origin: 'initial' };
const memory: MemoryShapeBundle = { system: '', summary: '', recent: '', semantic: '', code: '' };
const findings: WorkingMemoryFindings = {
	perRoot: [
		{ rootId: 'discover', verdict: 'accept', cyclesConsumed: 0, exhausted: false, content: 'discover findings' },
		{ rootId: 'synthesize', verdict: 'accept', cyclesConsumed: 0, exhausted: false, content: 'synthesize findings' },
	],
};

const verdict = (v: 'accept' | 'revise-edits' | 'revise-major', extras: Record<string, unknown> = {}): string =>
	JSON.stringify({ verdict: v, ...extras });

// ---------------------------------------------------------------------------
// parseReview
// ---------------------------------------------------------------------------

test('parseReview: accept verdict', () => {
	const r = parseReview(verdict('accept', { reasoning: 'good' }));
	assert.equal(r.verdict, 'accept');
	assert.equal(r.reasoning, 'good');
});

test('parseReview: revise-edits with edits string', () => {
	const r = parseReview(verdict('revise-edits', { edits: 'fix the intro' }));
	assert.equal(r.verdict, 'revise-edits');
	assert.equal(r.edits, 'fix the intro');
});

test('parseReview: invalid verdict -> defaults to accept', () => {
	const r = parseReview(verdict('whatever' as 'accept'));
	assert.equal(r.verdict, 'accept');
});

test('parseReview: malformed JSON -> accept (safe default)', () => {
	const r = parseReview('not json');
	assert.equal(r.verdict, 'accept');
	assert.match(r.reasoning ?? '', /parse failure/);
});

test('parseReview: markdown-fenced JSON unwraps', () => {
	const r = parseReview('```json\n' + verdict('revise-edits', { edits: 'x' }) + '\n```');
	assert.equal(r.verdict, 'revise-edits');
});

// ---------------------------------------------------------------------------
// Prompt structure
// ---------------------------------------------------------------------------

test('buildReviewUser: surfaces objective + findings + cycle counter', () => {
	const text = buildReviewUser({ todo, memory, candidate: 'section text', findings, provider: {} as LLMProvider }, 'section text', 1);
	assert.match(text, /Investigate X/);
	assert.match(text, /discover/);
	assert.match(text, /CYCLES CONSUMED: 1/);
	assert.match(text, /section text/);
});

test('buildReviseUser: surfaces objective + current section + edits', () => {
	const text = buildReviseUser(todo, 'current section text', 'fix the intro paragraph');
	assert.match(text, /Investigate X/);
	assert.match(text, /current section text/);
	assert.match(text, /fix the intro paragraph/);
});

// ---------------------------------------------------------------------------
// reviewSection: initial accept
// ---------------------------------------------------------------------------

test('initial accept -> 1 call, cyclesConsumed=0, accept verdict', async () => {
	const { provider, calls } = scriptedProvider([verdict('accept', { reasoning: 'reads well' })]);
	const result = await reviewSection({ todo, memory, candidate: 'candidate md', findings, provider });
	assert.equal(calls.length, 1);
	assert.equal(result.cyclesConsumed, 0);
	assert.equal(result.exhausted, false);
	assert.equal(result.reopenRequested, false);
	assert.equal(result.finalVerdict, 'accept');
	assert.equal(result.finalMarkdown, 'candidate md');
});

// ---------------------------------------------------------------------------
// revise-edits cycle
// ---------------------------------------------------------------------------

test('revise-edits -> rewrite -> accept: cyclesConsumed=1, accept verdict', async () => {
	const { provider, calls } = scriptedProvider([
		verdict('revise-edits', { edits: 'tighten the intro' }),
		'# Section\n\nRevised intro and body.\n',     // revise call returns markdown directly (trimmed by the call site)
		verdict('accept'),
	]);
	const result = await reviewSection({ todo, memory, candidate: 'original markdown', findings, provider });
	assert.equal(calls.length, 3);    // review -> revise -> review
	assert.equal(result.cyclesConsumed, 1);
	assert.equal(result.exhausted, false);
	assert.equal(result.finalVerdict, 'accept');
	// Revise normalises whitespace via trim().
	assert.equal(result.finalMarkdown, '# Section\n\nRevised intro and body.');
});

test('revise-edits cap hit -> force-accept + exhausted=true', async () => {
	// CAP=3 followup cycles -> 4 reviews + 3 revises = 7 calls when all
	// reviews stay on revise-edits.
	const calls: string[] = [];
	for (let i = 0; i < SECTION_REVIEW_CYCLE_CAP_VALUE + 1; i++) {
		calls.push(verdict('revise-edits', { edits: `fix cycle ${i}` }));
		// After each review (except the final cap-hit one), a revise call lands.
		if (i < SECTION_REVIEW_CYCLE_CAP_VALUE) {
			calls.push(`# Revision ${i + 1}\n\nbody\n`);
		}
	}
	const { provider, calls: recorded } = scriptedProvider(calls);
	const result = await reviewSection({ todo, memory, candidate: 'orig', findings, provider });

	assert.equal(result.cyclesConsumed, SECTION_REVIEW_CYCLE_CAP_VALUE);
	assert.equal(result.exhausted, true);
	assert.equal(result.finalVerdict, 'force-accept');
	assert.equal(result.reopenRequested, false);
	// 4 reviews + 3 revises = 7 calls.
	assert.equal(recorded.length, SECTION_REVIEW_CYCLE_CAP_VALUE * 2 + 1);
	// The final markdown is the last revise output (cycle 3).
	assert.match(result.finalMarkdown, /# Revision 3/);
});

// ---------------------------------------------------------------------------
// revise-major escalation
// ---------------------------------------------------------------------------

test('initial revise-major -> reopenRequested=true, no revise call, no subsequent review', async () => {
	const { provider, calls } = scriptedProvider([
		verdict('revise-major', { reasoning: 'findings missed key subsystem' }),
	]);
	const result = await reviewSection({ todo, memory, candidate: 'whatever', findings, provider });
	assert.equal(calls.length, 1);
	assert.equal(result.cyclesConsumed, 0);
	assert.equal(result.reopenRequested, true);
	assert.match(result.reopenReason ?? '', /findings missed/);
	assert.equal(result.finalVerdict, 'revise-major');
	assert.equal(result.finalMarkdown, 'whatever');
});

test('revise-major after a revise-edits cycle: escalates with current revised markdown', async () => {
	const { provider } = scriptedProvider([
		verdict('revise-edits', { edits: 'fix intro' }),
		'# Cycle 1 revision\n',
		verdict('revise-major', { reasoning: 'investigation has a gap' }),
	]);
	const result = await reviewSection({ todo, memory, candidate: 'orig', findings, provider });
	assert.equal(result.cyclesConsumed, 1);
	assert.equal(result.reopenRequested, true);
	assert.equal(result.finalVerdict, 'revise-major');
	assert.equal(result.finalMarkdown, '# Cycle 1 revision');
});

// ---------------------------------------------------------------------------
// LLM contract
// ---------------------------------------------------------------------------

test('LLM contract: review calls send responseFormat=json + disableThinking + temp=0', async () => {
	const { provider, calls } = scriptedProvider([verdict('accept')]);
	await reviewSection({ todo, memory, candidate: 'x', findings, provider });
	assert.equal(calls[0]!.opts.responseFormat, 'json');
	assert.equal(calls[0]!.opts.disableThinking, true);
	assert.equal(calls[0]!.opts.temperature, 0);
});

test('LLM contract: revise call does NOT send responseFormat=json (output is markdown)', async () => {
	const { provider, calls } = scriptedProvider([
		verdict('revise-edits', { edits: 'x' }),
		'# Revised\n',
		verdict('accept'),
	]);
	await reviewSection({ todo, memory, candidate: 'x', findings, provider });
	// Calls: 0 = review, 1 = revise, 2 = review.
	assert.equal(calls[1]!.opts.responseFormat, undefined);
	assert.equal(calls[1]!.opts.disableThinking, true);
	assert.equal(calls[1]!.opts.temperature, 0);
});

// ---------------------------------------------------------------------------
// Defensive: empty revise response keeps current
// ---------------------------------------------------------------------------

test('revise returns empty -> current section preserved, cycle still counted, next review runs', async () => {
	const { provider } = scriptedProvider([
		verdict('revise-edits', { edits: 'fix' }),
		'   ',                                  // empty after trim
		verdict('accept'),
	]);
	const result = await reviewSection({ todo, memory, candidate: 'original', findings, provider });
	assert.equal(result.cyclesConsumed, 1);
	assert.equal(result.finalMarkdown, 'original');
});

// ---------------------------------------------------------------------------
// Missing edits string on revise-edits: revise still proceeds with a placeholder
// ---------------------------------------------------------------------------

test('revise-edits without edits string -> revise still runs with placeholder', async () => {
	const { provider, calls } = scriptedProvider([
		verdict('revise-edits'),    // NO edits field
		'# Cycle 1\n',
		verdict('accept'),
	]);
	const result = await reviewSection({ todo, memory, candidate: 'orig', findings, provider });
	assert.equal(result.cyclesConsumed, 1);
	assert.match(calls[1]!.messages[1]!.content, /no specific edits/);
});
