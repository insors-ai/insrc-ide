/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the final report review loop (P4 part 2 / Q7).
 *
 * Provider call sequence on the happy path:
 *   1. assemble (markdown response)
 *   2. review #1 (JSON verdict)
 *
 * On revise-edits:
 *   1. assemble    2. review #1 (revise-edits)
 *   3. revise      4. review #2 (terminal: accept or force-accept)
 *
 * On revise-structural:
 *   1. assemble    2. review #1 (revise-structural)
 *   [caller resolves -> entries possibly updated]
 *   3. assemble    4. review #2 (terminal)
 *
 * Covered:
 * - parseReview verdict coercion + structural payload coercion.
 * - Happy path: accept on first review.
 * - revise-edits -> accept (cap 1 cycle).
 * - revise-edits cap hit -> force-accept with exhausted annotation.
 * - revise-structural section-contradiction: resolver called; report
 *   regenerates.
 * - revise-structural scope-gap: resolver called with proposed
 *   todos; new entries appended; report regenerates;
 *   addedScopeGapTodos in trace.
 * - Second revise-structural attempt: force-accept (one-per-report).
 * - Structural without resolver supplied -> noted, entries unchanged.
 * - scope-gap proposedTodos clamped at MAX_SCOPE_GAP_TODOS.
 * - LLM contract: review calls have responseFormat=json; assemble +
 *   revise calls do NOT.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runReportReview,
	_parseReviewForTest as parseReview,
	_coerceStructuralForTest as coerceStructural,
	_appendExhaustedAnnotationForTest as appendExhaustedAnnotation,
	REPORT_REVIEW_CYCLE_CAP_VALUE,
	MAX_SCOPE_GAP_TODOS_VALUE,
	type SectionContradictionResolver,
	type ScopeGapResolver,
} from '../step-report-review.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { WorkingMemoryEntry } from '../../working-memory/types.js';

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

function entry(id: string, objective: string, detail: string): WorkingMemoryEntry {
	return {
		todoId: id, objective, detail,
		findings:    { perRoot: [] },
		completedAt: 1, origin: 'initial',
	};
}

const accept            = JSON.stringify({ verdict: 'accept', reasoning: 'good' });
const reviseEdits       = (edits = 'tighten the intro') => JSON.stringify({ verdict: 'revise-edits', reasoning: 'fix', edits });
const reviseSectionConflict = (ids: string[]) => JSON.stringify({
	verdict: 'revise-structural',
	reasoning: 'sections clash',
	structural: { kind: 'section-contradiction', sectionIds: ids, reasoning: 'conflict' },
});
const reviseScopeGap = (proposed: ReadonlyArray<{ id: string; objective: string }>) => JSON.stringify({
	verdict: 'revise-structural',
	reasoning: 'gap',
	structural: { kind: 'scope-gap', proposedTodos: proposed, reasoning: 'missing X' },
});

// ---------------------------------------------------------------------------
// parseReview + coerceStructural
// ---------------------------------------------------------------------------

test('parseReview: accept', () => {
	const r = parseReview(accept);
	assert.equal(r.verdict, 'accept');
});

test('parseReview: revise-edits surfaces edits', () => {
	const r = parseReview(reviseEdits('rewrite intro'));
	assert.equal(r.verdict, 'revise-edits');
	assert.equal(r.edits, 'rewrite intro');
});

test('parseReview: revise-structural section-contradiction', () => {
	const r = parseReview(reviseSectionConflict(['t1', 't2']));
	assert.equal(r.verdict, 'revise-structural');
	assert.equal(r.structural?.kind, 'section-contradiction');
	if (r.structural?.kind === 'section-contradiction') {
		assert.deepEqual(r.structural.sectionIds, ['t1', 't2']);
	}
});

test('parseReview: revise-structural scope-gap stamps origin', () => {
	const r = parseReview(reviseScopeGap([{ id: 'new1', objective: 'Audit something' }]));
	assert.equal(r.verdict, 'revise-structural');
	assert.equal(r.structural?.kind, 'scope-gap');
	if (r.structural?.kind === 'scope-gap') {
		assert.equal(r.structural.proposedTodos.length, 1);
		assert.equal(r.structural.proposedTodos[0]!.origin, 'report-review-escalation');
	}
});

test('parseReview: malformed JSON -> accept', () => {
	const r = parseReview('not json');
	assert.equal(r.verdict, 'accept');
});

test('parseReview: markdown-fenced JSON unwraps', () => {
	const r = parseReview('```json\n' + accept + '\n```');
	assert.equal(r.verdict, 'accept');
});

test('coerceStructural: invalid section-contradiction (no sectionIds) -> undefined', () => {
	const out = coerceStructural({ kind: 'section-contradiction', sectionIds: [] });
	assert.equal(out, undefined);
});

test('coerceStructural: scope-gap with malformed proposedTodos drops them', () => {
	const out = coerceStructural({
		kind: 'scope-gap',
		proposedTodos: [
			{ id: 'a', objective: 'A' },
			{ id: '', objective: 'no id' },           // dropped
			{ objective: 'no id field' },             // dropped
			{ id: 'b', objective: '' },               // dropped
		],
		reasoning: 'r',
	});
	assert.equal(out?.kind, 'scope-gap');
	if (out?.kind === 'scope-gap') {
		assert.equal(out.proposedTodos.length, 1);
		assert.equal(out.proposedTodos[0]!.id, 'a');
	}
});

test('coerceStructural: unknown kind -> undefined', () => {
	assert.equal(coerceStructural({ kind: 'mystery' }), undefined);
});

// ---------------------------------------------------------------------------
// appendExhaustedAnnotation
// ---------------------------------------------------------------------------

test('appendExhaustedAnnotation: adds Review Notes tail block with reasoning + HTML marker', () => {
	const out = appendExhaustedAnnotation('REPORT BODY', { verdict: 'revise-edits', reasoning: 'fix intro' });
	assert.match(out, /## Review Notes/);
	assert.match(out, /revise-edits/);
	assert.match(out, /fix intro/);
	assert.match(out, /<!-- section-flow: report-review-exhausted -->/);
});

// ---------------------------------------------------------------------------
// runReportReview: happy path
// ---------------------------------------------------------------------------

test('happy path: assemble + accept on first review -> 2 LLM calls, no edits/revise', async () => {
	const { provider, calls } = scriptedProvider([
		'# Final Report\n',     // assemble
		accept,                  // review #1
	]);
	const result = await runReportReview({
		question: 'q',
		entries:  [entry('t1', 'o1', 'd1')],
		provider,
	});
	assert.equal(calls.length, 2);
	assert.equal(result.cyclesConsumed, 0);
	assert.equal(result.exhausted, false);
	assert.equal(result.structuralReviseUsed, false);
	assert.equal(result.finalReport, '# Final Report');
});

// ---------------------------------------------------------------------------
// revise-edits
// ---------------------------------------------------------------------------

test('revise-edits within cap: assemble + review + revise + review accept', async () => {
	const { provider, calls } = scriptedProvider([
		'# Initial\n',
		reviseEdits('tighten intro'),
		'# Revised\n',
		accept,
	]);
	const result = await runReportReview({
		question: 'q',
		entries:  [entry('t1', 'o1', 'd1')],
		provider,
	});
	assert.equal(calls.length, 4);   // assemble + review + revise + review
	assert.equal(result.cyclesConsumed, 1);
	assert.equal(result.exhausted, false);
	assert.equal(result.finalReport, '# Revised');
});

test('revise-edits cap hit: force-accept with exhausted annotation', async () => {
	// Cap=1 -> max 1 revise cycle. After 2nd review still revise-edits -> force-accept.
	const { provider, calls } = scriptedProvider([
		'# Initial\n',
		reviseEdits('fix1'),
		'# Cycle1\n',
		reviseEdits('fix2'),     // 2nd review still wants more
	]);
	const result = await runReportReview({
		question: 'q',
		entries:  [entry('t1', 'o1', 'd1')],
		provider,
	});
	assert.equal(calls.length, 4);
	assert.equal(result.cyclesConsumed, REPORT_REVIEW_CYCLE_CAP_VALUE);
	assert.equal(result.exhausted, true);
	assert.match(result.finalReport, /report-review-exhausted/);
});

// ---------------------------------------------------------------------------
// revise-structural section-contradiction
// ---------------------------------------------------------------------------

test('revise-structural section-contradiction: resolver called; report regenerates', async () => {
	const entries = [entry('t1', 'o1', 'd1'), entry('t2', 'o2', 'd2')];
	const { provider, calls } = scriptedProvider([
		'# Initial\n',
		reviseSectionConflict(['t1', 't2']),
		'# Regenerated\n',         // assemble #2 (after resolver runs)
		accept,                     // review #2
	]);

	const resolverCalls: { sectionIds: readonly string[]; entries: readonly WorkingMemoryEntry[] }[] = [];
	const resolver: SectionContradictionResolver = async (input) => {
		resolverCalls.push(input);
		// Return entries unchanged for this test.
		return input.entries;
	};

	const result = await runReportReview({
		question: 'q',
		entries,
		provider,
		resolveSectionContradiction: resolver,
	});
	assert.equal(calls.length, 4);
	assert.equal(resolverCalls.length, 1);
	assert.deepEqual(resolverCalls[0]!.sectionIds, ['t1', 't2']);
	assert.equal(result.structuralReviseUsed, true);
	assert.equal(result.exhausted, false);
	assert.equal(result.finalReport, '# Regenerated');
});

// ---------------------------------------------------------------------------
// revise-structural scope-gap
// ---------------------------------------------------------------------------

test('revise-structural scope-gap: resolver called; new entries appended; addedScopeGapTodos populated', async () => {
	const entries = [entry('t1', 'o1', 'd1')];
	const newEntry = entry('new1', 'New TODO', 'new body');
	const { provider } = scriptedProvider([
		'# Initial\n',
		reviseScopeGap([{ id: 'new1', objective: 'Audit something' }]),
		'# Regenerated with new section\n',
		accept,
	]);

	const resolverCalls: { proposedTodos: readonly { id: string; objective: string }[] }[] = [];
	const resolver: ScopeGapResolver = async (input) => {
		resolverCalls.push(input);
		return [newEntry];
	};

	const result = await runReportReview({
		question: 'q',
		entries,
		provider,
		resolveScopeGap: resolver,
	});

	assert.equal(resolverCalls.length, 1);
	assert.equal(resolverCalls[0]!.proposedTodos.length, 1);
	assert.equal(result.addedScopeGapTodos.length, 1);
	assert.equal(result.entries.length, 2);     // original + appended
	assert.equal(result.entries[1]!.todoId, 'new1');
	assert.equal(result.exhausted, false);
});

test('scope-gap proposedTodos clamped at MAX_SCOPE_GAP_TODOS', async () => {
	const tooMany = Array.from({ length: MAX_SCOPE_GAP_TODOS_VALUE + 3 }, (_, i) => ({ id: `t${i}`, objective: `o${i}` }));
	const { provider } = scriptedProvider([
		'# Initial\n',
		reviseScopeGap(tooMany),
		'# Regen\n',
		accept,
	]);
	let observedProposalCount = 0;
	const resolver: ScopeGapResolver = async ({ proposedTodos }) => {
		observedProposalCount = proposedTodos.length;
		return [];
	};
	await runReportReview({
		question: 'q',
		entries:  [entry('t1', 'o', 'd')],
		provider,
		resolveScopeGap: resolver,
	});
	assert.equal(observedProposalCount, MAX_SCOPE_GAP_TODOS_VALUE);
});

// ---------------------------------------------------------------------------
// One revise-structural per report
// ---------------------------------------------------------------------------

test('second revise-structural attempt: force-accept (one-per-report cap)', async () => {
	const { provider } = scriptedProvider([
		'# Initial\n',
		reviseSectionConflict(['t1']),
		'# Regen\n',
		reviseSectionConflict(['t1']),    // 2nd structural-revise -> rejected
	]);
	let resolverInvocations = 0;
	const resolver: SectionContradictionResolver = async ({ entries }) => {
		resolverInvocations += 1;
		return entries;
	};
	const result = await runReportReview({
		question: 'q',
		entries:  [entry('t1', 'o', 'd')],
		provider,
		resolveSectionContradiction: resolver,
	});
	assert.equal(resolverInvocations, 1);     // Only the first structural call ran.
	assert.equal(result.exhausted, true);
	assert.match(result.finalReport, /report-review-exhausted/);
});

// ---------------------------------------------------------------------------
// Missing resolver -> noted, entries unchanged
// ---------------------------------------------------------------------------

test('revise-structural without resolver: entries unchanged, report regenerates anyway', async () => {
	const entries = [entry('t1', 'o', 'd')];
	const { provider } = scriptedProvider([
		'# Initial\n',
		reviseScopeGap([{ id: 'new1', objective: 'X' }]),
		'# Regen\n',
		accept,
	]);
	const result = await runReportReview({ question: 'q', entries, provider });
	// No resolver -> addedScopeGapTodos empty, entries unchanged.
	assert.equal(result.addedScopeGapTodos.length, 0);
	assert.equal(result.entries.length, 1);
	assert.equal(result.structuralReviseUsed, true);
	assert.equal(result.finalReport, '# Regen');
});

// ---------------------------------------------------------------------------
// LLM contract
// ---------------------------------------------------------------------------

test('LLM contract: review calls have responseFormat=json; assemble + revise do NOT', async () => {
	const { provider, calls } = scriptedProvider([
		'# Initial\n',
		reviseEdits('fix'),
		'# Revised\n',
		accept,
	]);
	await runReportReview({
		question: 'q',
		entries:  [entry('t1', 'o', 'd')],
		provider,
	});
	// Calls: 0=assemble, 1=review#1, 2=revise, 3=review#2.
	assert.equal(calls[0]!.opts.responseFormat, undefined);  // assemble (markdown)
	assert.equal(calls[1]!.opts.responseFormat, 'json');     // review
	assert.equal(calls[2]!.opts.responseFormat, undefined);  // revise (markdown)
	assert.equal(calls[3]!.opts.responseFormat, 'json');     // review
	for (const c of calls) {
		assert.equal(c.opts.disableThinking, true);
		assert.equal(c.opts.temperature, 0);
	}
});
