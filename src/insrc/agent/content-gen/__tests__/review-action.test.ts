/**
 * Tests for the reviewAction helper + expandThenReview loop driver
 * (Phase 3 of plans/analyzers/cloud-plan-local-expand-cloud-review.md).
 *
 * The review helper sends one cloud LLM call and parses the JSON
 * verdict; the loop driver chains expand+review with a bounded
 * second-round refinement. We use stubbed providers throughout so
 * the tests are deterministic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	reviewAction,
	expandThenReview,
	type ExpandThenReviewPhase,
	type ExpandThenReviewPayload,
	_validateReviewForTest as validateReview,
	_buildReviewMessagesForTest as buildReviewMessages,
} from '../review-action.js';
import type { ExpandActionResult } from '../expand-action.js';
import type { PlannedAction, PlanExecution } from '../plan-actions.js';
import type { LLMMessage, LLMProvider, LLMResponse, CompletionOpts } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTION: PlannedAction = {
	id:        'modules-overview',
	title:     'HDFS Core: Module Layout',
	objective: 'Map the top-level HDFS Core packages and their responsibilities.',
	evidence:  [{ skillId: 'code.source.repo.describe', executionIdx: 0 }],
	maxBudgetTokens: 1500,
	reviewCriteria: [
		'Names each top-level HDFS Core module by absolute path',
		'Cites the module.describe finding at least once',
	],
};

const EVIDENCE: PlanExecution[] = [
	{ skillId: 'code.source.repo.describe', value: { topModules: [{ path: '/repo/hadoop/hadoop-hdfs', fileCount: 240 }] }, confidence: 'high', notes: [] },
];

const DRAFT: ExpandActionResult = {
	actionId:      ACTION.id,
	markdown:      'HDFS Core lives at `/repo/hadoop/hadoop-hdfs` (240 files).',
	tokenEstimate: 24,
	truncated:     false,
	degraded:      false,
};

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function fakeProvider(...texts: readonly string[]): LLMProvider {
	let i = 0;
	return {
		async complete(_messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
			const text = texts[Math.min(i, texts.length - 1)] ?? '';
			i++;
			return { text, stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};
}

function fakeProviderThrowing(message: string): LLMProvider {
	return {
		async complete(): Promise<LLMResponse> { throw new Error(message); },
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};
}

const ACCEPT_VERDICT = JSON.stringify({
	verdict: 'accept',
	notes:   ['evidence is concrete; criteria satisfied'],
});

const ACCEPT_WITH_POLISH = JSON.stringify({
	verdict: 'accept',
	accepted: { markdown: 'HDFS Core lives at `/repo/hadoop/hadoop-hdfs` -- 240 files (polished).' },
	notes:    ['lightly tightened wording'],
});

const REFINE_VERDICT = JSON.stringify({
	verdict: 'refine',
	refine:  { hint: 'Mention the file count per top-level module, not just the root.' },
	notes:   ['draft missed the per-module count'],
});

// ---------------------------------------------------------------------------
// validateReview (pure)
// ---------------------------------------------------------------------------

test('validateReview: bare accept -> ok, no accepted block', () => {
	const r = validateReview({ verdict: 'accept' });
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.verdict, 'accept');
	assert.equal(r.accepted, undefined);
});

test('validateReview: accept with polished rewrite -> ok, accepted.markdown set', () => {
	const r = validateReview({ verdict: 'accept', accepted: { markdown: 'polished' } });
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.accepted?.markdown, 'polished');
});

test('validateReview: accept with empty markdown -> ok, accepted dropped', () => {
	const r = validateReview({ verdict: 'accept', accepted: { markdown: '   ' } });
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.accepted, undefined);
});

test('validateReview: refine without hint -> error', () => {
	const r = validateReview({ verdict: 'refine', refine: {} });
	assert.equal(typeof r, 'string');
	assert.match(r as string, /hint/);
});

test('validateReview: refine without refine block -> error', () => {
	const r = validateReview({ verdict: 'refine' });
	assert.equal(typeof r, 'string');
	assert.match(r as string, /refine/);
});

test('validateReview: refine with hint -> ok', () => {
	const r = validateReview({ verdict: 'refine', refine: { hint: 'Add the cyclic-deps citation' } });
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.verdict, 'refine');
	assert.equal(r.refine?.hint, 'Add the cyclic-deps citation');
});

test('validateReview: bogus verdict -> error', () => {
	const r = validateReview({ verdict: 'maybe' });
	assert.equal(typeof r, 'string');
	assert.match(r as string, /verdict/);
});

test('validateReview: notes filter to non-empty strings only', () => {
	const r = validateReview({ verdict: 'accept', notes: ['', 'good', '   ', 'fine'] });
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.deepEqual(r.notes, ['good', 'fine']);
});

// ---------------------------------------------------------------------------
// buildReviewMessages (prompt assembly)
// ---------------------------------------------------------------------------

test('buildReviewMessages: includes objective, criteria, draft, evidence', () => {
	const msgs = buildReviewMessages({ action: ACTION, draft: DRAFT, evidence: EVIDENCE });
	assert.equal(msgs.length, 2);
	const sys = msgs[0]!.content as string;
	const user = msgs[1]!.content as string;
	assert.match(sys, /You review ONE section/);
	assert.match(user, /## Section under review/);
	assert.match(user, /HDFS Core: Module Layout/);
	assert.match(user, /## Review criteria/);
	assert.match(user, /Names each top-level HDFS Core module/);
	assert.match(user, /## Draft markdown/);
	assert.match(user, /\/repo\/hadoop\/hadoop-hdfs/);
	assert.match(user, /## Evidence the expander saw/);
});

test('buildReviewMessages: truncated draft -> truncation note rendered', () => {
	const msgs = buildReviewMessages({
		action: ACTION,
		draft:  { ...DRAFT, truncated: true },
		evidence: EVIDENCE,
	});
	const user = msgs[1]!.content as string;
	assert.match(user, /local expander hit its token cap/);
});

test('buildReviewMessages: degraded draft -> degraded note rendered', () => {
	const msgs = buildReviewMessages({
		action: ACTION,
		draft:  { ...DRAFT, degraded: true },
		evidence: EVIDENCE,
	});
	const user = msgs[1]!.content as string;
	assert.match(user, /local expander degraded/);
});

// ---------------------------------------------------------------------------
// reviewAction end-to-end
// ---------------------------------------------------------------------------

test('reviewAction: accept verdict on first try -> verdict accept, no degraded', async () => {
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProvider(ACCEPT_VERDICT),
	);
	assert.equal(r.verdict, 'accept');
	assert.equal(r.degraded, false);
});

test('reviewAction: accept-with-polish -> accepted.markdown surfaced', async () => {
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProvider(ACCEPT_WITH_POLISH),
	);
	assert.equal(r.verdict, 'accept');
	assert.match(r.accepted?.markdown ?? '', /polished/);
});

test('reviewAction: refine verdict -> hint surfaced', async () => {
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProvider(REFINE_VERDICT),
	);
	assert.equal(r.verdict, 'refine');
	assert.match(r.refine?.hint ?? '', /file count/);
});

test('reviewAction: first-pass invalid + second-pass valid -> ok', async () => {
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProvider('not-json', ACCEPT_VERDICT),
	);
	assert.equal(r.verdict, 'accept');
	assert.equal(r.degraded, false);
});

test('reviewAction: both attempts invalid -> soft accept with degraded:true', async () => {
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProvider('garbage one', 'garbage two'),
	);
	assert.equal(r.verdict, 'accept');
	assert.equal(r.degraded, true);
	assert.equal(r.accepted?.markdown, DRAFT.markdown);
	assert.match(r.notes[0] ?? '', /reviewer-degraded/);
});

test('reviewAction: provider throws on both attempts -> soft accept', async () => {
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProviderThrowing('connection lost'),
	);
	assert.equal(r.verdict, 'accept');
	assert.equal(r.degraded, true);
});

// ---------------------------------------------------------------------------
// expandThenReview loop
// ---------------------------------------------------------------------------

const LOCAL_BODY = 'HDFS Core lives at `/repo/hadoop/hadoop-hdfs` (240 files).';

test('expandThenReview: 1-round accept -> rounds=1, no second expand', async () => {
	const expandCalls: number[] = [];
	const reviewCalls: number[] = [];
	let expandIdx = 0;
	let reviewIdx = 0;

	const local: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			expandCalls.push(++expandIdx);
			return { text: LOCAL_BODY, stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};

	const cloud: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			reviewCalls.push(++reviewIdx);
			return { text: ACCEPT_VERDICT, stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};

	const phases: ExpandThenReviewPhase[] = [];
	const result = await expandThenReview(
		{
			action:   ACTION,
			evidence: EVIDENCE,
			request:  'do a detailed analysis of HDFS Core',
			onProgress: (phase: ExpandThenReviewPhase, _payload: ExpandThenReviewPayload) => { phases.push(phase); },
		},
		local,
		cloud,
	);

	assert.equal(result.rounds, 1);
	assert.equal(result.verdict, 'accept');
	assert.equal(expandCalls.length, 1);
	assert.equal(reviewCalls.length, 1);
	assert.deepEqual(phases, ['expand-1', 'review-1', 'final']);
});

test('expandThenReview: refine then accept -> rounds=2, second draft used', async () => {
	let localIdx = 0;
	const local: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			const text = (localIdx++ === 0) ? LOCAL_BODY : 'Refined: HDFS Core (240 files), HDFS Client, HDFS NN.';
			return { text, stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};

	const cloud = fakeProvider(REFINE_VERDICT, ACCEPT_VERDICT);

	const phases: ExpandThenReviewPhase[] = [];
	const result = await expandThenReview(
		{
			action:   ACTION,
			evidence: EVIDENCE,
			request:  'do a detailed analysis of HDFS Core',
			onProgress: (phase) => { phases.push(phase); },
		},
		local,
		cloud,
	);

	assert.equal(result.rounds, 2);
	assert.equal(result.verdict, 'refine-then-accept');
	assert.match(result.markdown, /Refined/);
	assert.deepEqual(phases, ['expand-1', 'review-1', 'expand-2', 'review-2', 'final']);
});

test('expandThenReview: refine then refine -> rounds=2, binding accept on second draft, note flag', async () => {
	let localIdx = 0;
	const local: LLMProvider = {
		async complete(): Promise<LLMResponse> {
			const text = (localIdx++ === 0) ? 'first' : 'second-refined';
			return { text, stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};

	const cloud = fakeProvider(REFINE_VERDICT, REFINE_VERDICT);

	const result = await expandThenReview(
		{ action: ACTION, evidence: EVIDENCE, request: 'q' },
		local,
		cloud,
	);

	assert.equal(result.rounds, 2);
	assert.equal(result.verdict, 'refine-then-accept');
	assert.match(result.markdown, /second-refined/);
	assert.ok(result.notes.some(n => /second-review-still-refine/.test(n)));
});

test('expandThenReview: refine without hint -> treated as accept of round 1', async () => {
	const local = fakeProvider(LOCAL_BODY);
	const cloud = fakeProvider(JSON.stringify({ verdict: 'refine', refine: { hint: 'Add the cyclic-deps citation.' } }));
	// Modify reviewer above to return refine WITH hint, then we'll
	// cover the without-hint path via a different path: pass a
	// fakeProvider that yields refine-with-empty-hint -> validation
	// rejects it, retry returns same -> degraded soft-accept.
	void cloud;

	// Different test: simulate the reviewer returning refine without
	// a hint at the schema-violation level. validateReview will
	// reject; tryReview retries; the retry also returns the same
	// shape -> reviewAction returns degraded soft-accept.
	const cloudDegraded = fakeProvider(
		JSON.stringify({ verdict: 'refine' }),                  // no refine block -> error
		JSON.stringify({ verdict: 'refine', refine: {} }),       // still bad -> error
	);

	const result = await expandThenReview(
		{ action: ACTION, evidence: EVIDENCE, request: 'q' },
		local,
		cloudDegraded,
	);
	// Both review attempts fail -> reviewAction returns degraded
	// accept -> the loop accepts in round 1.
	assert.equal(result.rounds, 1);
	assert.equal(result.verdict, 'accept');
});

test('expandThenReview: review degraded both attempts -> soft-accept round 1', async () => {
	const local = fakeProvider(LOCAL_BODY);
	const cloud = fakeProvider('garbage', 'garbage');
	const result = await expandThenReview(
		{ action: ACTION, evidence: EVIDENCE, request: 'q' },
		local,
		cloud,
	);
	assert.equal(result.rounds, 1);
	assert.equal(result.verdict, 'accept');
});

test('expandThenReview: progress callback receives expand/review/final payloads', async () => {
	const local = fakeProvider(LOCAL_BODY);
	const cloud = fakeProvider(ACCEPT_VERDICT);

	const seen: { phase: ExpandThenReviewPhase; kind: string }[] = [];
	await expandThenReview(
		{
			action:   ACTION,
			evidence: EVIDENCE,
			request:  'q',
			onProgress: (phase, payload) => {
				seen.push({ phase, kind: payload.kind });
			},
		},
		local,
		cloud,
	);
	assert.deepEqual(seen, [
		{ phase: 'expand-1', kind: 'expand' },
		{ phase: 'review-1', kind: 'review' },
		{ phase: 'final',    kind: 'final' },
	]);
});
