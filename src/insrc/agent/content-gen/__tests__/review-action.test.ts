/**
 * Tests for the reviewAction helper + expandThenReview loop driver
 * (Phase 3 of plans/analyzers/cloud-plan-local-expand-cloud-review.md,
 * with Phase E of plans/code-analyzer-structured-review.md replacing
 * the single-hint refine shape with a typed work-item list).
 *
 * The review helper sends one cloud LLM call and parses the JSON
 * verdict; the loop driver chains expand+review with a bounded
 * second-round refinement. We use stubbed providers throughout so
 * the tests are deterministic.
 *
 * Note: `expandThenReview` is deprecated (Phase H deletes it). The
 * tests here keep it covered until that deletion lands so the
 * Phase E bridge doesn't regress silently.
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
	verdict:   'accept',
	workItems: [],
	notes:     ['evidence is concrete; criteria satisfied'],
});

const ACCEPT_WITH_POLISH = JSON.stringify({
	verdict:   'accept',
	workItems: [],
	accepted:  { markdown: 'HDFS Core lives at `/repo/hadoop/hadoop-hdfs` -- 240 files (polished).' },
	notes:     ['lightly tightened wording'],
});

const NEEDS_WORK_VERDICT = JSON.stringify({
	verdict:   'needs-work',
	workItems: [
		{
			id:     'wi-1',
			kind:   'enhance',
			where:  'paragraph 1',
			issue:  'No per-module file counts cited',
			action: 'Mention the file count per top-level module, not just the root',
		},
	],
	notes:     ['draft missed the per-module count'],
});

// ---------------------------------------------------------------------------
// validateReview (pure)
// ---------------------------------------------------------------------------

test('validateReview: bare accept with empty workItems -> ok, no accepted block', () => {
	const r = validateReview({ verdict: 'accept', workItems: [] });
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.verdict, 'accept');
	assert.equal(r.accepted, undefined);
	assert.deepEqual(r.workItems, []);
});

test('validateReview: accept with polished rewrite -> ok, accepted.markdown set', () => {
	const r = validateReview({ verdict: 'accept', workItems: [], accepted: { markdown: 'polished' } });
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.accepted?.markdown, 'polished');
});

test('validateReview: accept with NON-empty workItems -> error', () => {
	const r = validateReview({
		verdict: 'accept',
		workItems: [{ id: 'wi-1', kind: 'fix', where: 'p1', issue: 'x', action: 'y' }],
	});
	assert.equal(typeof r, 'string');
	assert.match(r as string, /workItems.*empty/);
});

test('validateReview: needs-work without workItems -> error', () => {
	const r = validateReview({ verdict: 'needs-work', workItems: [] });
	assert.equal(typeof r, 'string');
	assert.match(r as string, /workItems.*non-empty/);
});

test('validateReview: needs-work with single fix item -> ok', () => {
	const r = validateReview({
		verdict: 'needs-work',
		workItems: [
			{ id: 'wi-1', kind: 'fix', where: 'paragraph 2', issue: 'wrong claim', action: 'verify and correct' },
		],
	});
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.verdict, 'needs-work');
	assert.equal(r.workItems.length, 1);
	assert.equal(r.workItems[0]!.id, 'wi-1');
	assert.equal(r.workItems[0]!.kind, 'fix');
});

test('validateReview: work item missing required field -> error', () => {
	const r = validateReview({
		verdict: 'needs-work',
		workItems: [{ id: 'wi-1', kind: 'fix', where: 'p1', issue: 'x' }],   // missing `action`
	});
	assert.equal(typeof r, 'string');
	assert.match(r as string, /action.*required/);
});

test('validateReview: work item with bogus kind -> error', () => {
	const r = validateReview({
		verdict: 'needs-work',
		workItems: [{ id: 'wi-1', kind: 'overhaul', where: 'p1', issue: 'x', action: 'y' }],
	});
	assert.equal(typeof r, 'string');
	assert.match(r as string, /kind.*fix\|enhance\|add\|trim/);
});

test('validateReview: duplicate work item ids -> error', () => {
	const r = validateReview({
		verdict: 'needs-work',
		workItems: [
			{ id: 'wi-1', kind: 'fix',     where: 'p1', issue: 'a', action: 'fix it' },
			{ id: 'wi-1', kind: 'enhance', where: 'p2', issue: 'b', action: 'enhance it' },
		],
	});
	assert.equal(typeof r, 'string');
	assert.match(r as string, /duplicated/);
});

test('validateReview: more than 6 work items -> error', () => {
	const items = Array.from({ length: 7 }, (_, i) => ({
		id: `wi-${i + 1}`, kind: 'enhance' as const, where: `p${i + 1}`, issue: 'x', action: 'y',
	}));
	const r = validateReview({ verdict: 'needs-work', workItems: items });
	assert.equal(typeof r, 'string');
	assert.match(r as string, /capped at 6/);
});

test('validateReview: work item with evidenceRefs -> ok, refs preserved', () => {
	const r = validateReview({
		verdict: 'needs-work',
		workItems: [{
			id: 'wi-1', kind: 'enhance', where: 'p1', issue: 'x', action: 'y',
			evidenceRefs: ['evidence[0]', 'evidence[2]'],
		}],
	});
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.deepEqual(r.workItems[0]!.evidenceRefs, ['evidence[0]', 'evidence[2]']);
});

test('validateReview: bogus verdict -> error', () => {
	const r = validateReview({ verdict: 'maybe', workItems: [] });
	assert.equal(typeof r, 'string');
	assert.match(r as string, /verdict/);
});

test('validateReview: legacy "refine" verdict -> error (no longer accepted)', () => {
	const r = validateReview({ verdict: 'refine', refine: { hint: 'old shape' } });
	assert.equal(typeof r, 'string');
	assert.match(r as string, /accept.*needs-work/);
});

test('validateReview: notes filter to non-empty strings only', () => {
	const r = validateReview({ verdict: 'accept', workItems: [], notes: ['', 'good', '   ', 'fine'] });
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
	assert.match(sys, /Work-item kinds:/);
	assert.match(sys, /fix.*factually wrong/);
	assert.match(sys, /needs-work/);
	assert.match(user, /## Section under review/);
	assert.match(user, /HDFS Core: Module Layout/);
	assert.match(user, /## Review criteria/);
	assert.match(user, /Names each top-level HDFS Core module/);
	assert.match(user, /## Draft markdown/);
	assert.match(user, /\/repo\/hadoop\/hadoop-hdfs/);
	assert.match(user, /## Evidence the expander saw/);
	assert.match(user, /workItems/);
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
	assert.deepEqual(r.workItems, []);
});

test('reviewAction: accept-with-polish -> accepted.markdown surfaced', async () => {
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProvider(ACCEPT_WITH_POLISH),
	);
	assert.equal(r.verdict, 'accept');
	assert.match(r.accepted?.markdown ?? '', /polished/);
});

test('reviewAction: needs-work verdict -> workItems surfaced', async () => {
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProvider(NEEDS_WORK_VERDICT),
	);
	assert.equal(r.verdict, 'needs-work');
	assert.equal(r.workItems.length, 1);
	assert.equal(r.workItems[0]!.kind, 'enhance');
	assert.match(r.workItems[0]!.action, /file count/);
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
	assert.deepEqual(r.workItems, []);
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
	assert.deepEqual(r.workItems, []);
});

// ---------------------------------------------------------------------------
// expandThenReview loop (deprecated; bridges old hint loop through workItems)
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

test('expandThenReview: needs-work then accept -> rounds=2, second draft used', async () => {
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

	const cloud = fakeProvider(NEEDS_WORK_VERDICT, ACCEPT_VERDICT);

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

test('expandThenReview: needs-work twice -> rounds=2, binding accept on second draft, note flag', async () => {
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

	const cloud = fakeProvider(NEEDS_WORK_VERDICT, NEEDS_WORK_VERDICT);

	const result = await expandThenReview(
		{ action: ACTION, evidence: EVIDENCE, request: 'q' },
		local,
		cloud,
	);

	assert.equal(result.rounds, 2);
	assert.equal(result.verdict, 'refine-then-accept');
	assert.match(result.markdown, /second-refined/);
	assert.ok(result.notes.some(n => /second-review-still-needs-work/.test(n)));
});

test('expandThenReview: needs-work without items -> treated as accept of round 1', async () => {
	const local = fakeProvider(LOCAL_BODY);
	// reviewer says needs-work but with empty workItems (validator
	// rejects -> retry fails too -> degraded soft-accept).
	const cloud = fakeProvider(
		JSON.stringify({ verdict: 'needs-work', workItems: [] }),
		JSON.stringify({ verdict: 'needs-work', workItems: [] }),
	);

	const result = await expandThenReview(
		{ action: ACTION, evidence: EVIDENCE, request: 'q' },
		local,
		cloud,
	);
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
