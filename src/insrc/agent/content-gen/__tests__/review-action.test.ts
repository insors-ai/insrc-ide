/**
 * Tests for the reviewAction helper (Phase 3 of
 * plans/analyzers/cloud-plan-local-expand-cloud-review.md, with
 * Phase E of plans/code-analyzer-structured-review.md replacing the
 * single-hint refine shape with a typed work-item list).
 *
 * The review helper sends one cloud LLM call and parses the JSON
 * verdict. We use stubbed providers throughout so the tests are
 * deterministic.
 *
 * The legacy `expandThenReview` 2-round driver was deleted in
 * Phase H; the code-analyzer orchestrator runs the 3-round patch
 * loop directly. End-to-end coverage of that loop is in the
 * orchestrator's integration tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	reviewAction,
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
			kind: 'fix',
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
	assert.match(r as string, /kind.*fix\|add\|trim/);
});

test('validateReview: duplicate work item ids -> error', () => {
	const r = validateReview({
		verdict: 'needs-work',
		workItems: [
			{ id: 'wi-1', kind: 'fix',     where: 'p1', issue: 'a', action: 'fix it' },
			{ id: 'wi-1', kind: 'fix', where: 'p2', issue: 'b', action: 'enhance it' },
		],
	});
	assert.equal(typeof r, 'string');
	assert.match(r as string, /duplicated/);
});

test('validateReview: more than 6 work items -> error', () => {
	const items = Array.from({ length: 7 }, (_, i) => ({
		id: `wi-${i + 1}`, kind: 'fix' as const, where: `p${i + 1}`, issue: 'x', action: 'y',
	}));
	const r = validateReview({ verdict: 'needs-work', workItems: items });
	assert.equal(typeof r, 'string');
	assert.match(r as string, /capped at 6/);
});

test('validateReview: P.3 issue >200 chars -> soft-truncated, NOT rejected', () => {
	const longIssue  = 'x'.repeat(250);
	const longAction = 'y'.repeat(220);
	const r = validateReview({
		verdict: 'needs-work',
		workItems: [{
			id: 'wi-1', kind: 'fix', where: 'p1', issue: longIssue, action: longAction,
		}],
	});
	assert.notEqual(typeof r, 'string', 'validator must NOT reject; should soft-truncate');
	if (typeof r === 'string') return;
	assert.equal(r.verdict, 'needs-work');
	assert.equal(r.workItems[0]!.issue.length, 200, 'issue clipped to 200 chars');
	assert.equal(r.workItems[0]!.action.length, 200, 'action clipped to 200 chars');
	assert.ok(r.workItems[0]!.issue.endsWith('...'),  'truncated issue should end with ellipsis');
	assert.ok(r.workItems[0]!.action.endsWith('...'), 'truncated action should end with ellipsis');
	// Truncation notes surfaced
	assert.ok(r.notes.some(n => /workItems\[0\]\.issue truncated from 250/.test(n)));
	assert.ok(r.notes.some(n => /workItems\[0\]\.action truncated from 220/.test(n)));
});

test('validateReview: work item with evidenceRefs -> ok, refs preserved', () => {
	const r = validateReview({
		verdict: 'needs-work',
		workItems: [{
			id: 'wi-1', kind: 'fix', where: 'p1', issue: 'x', action: 'y',
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
	assert.match(sys, /When to pick each work-item kind/);
	assert.match(sys, /fix[\s\S]*factually wrong/);
	assert.match(sys, /needs-work/);
	assert.match(user, /## Section under review/);
	assert.match(user, /HDFS Core: Module Layout/);
	assert.match(user, /## Review criteria/);
	assert.match(user, /Names each top-level HDFS Core module/);
	assert.match(user, /## Draft markdown/);
	assert.match(user, /\/repo\/hadoop\/hadoop-hdfs/);
	assert.match(user, /## Evidence the expander saw/);
	// Phase P.4: JSON Schema block now lives in the user message.
	assert.match(user, /## Response schema \(JSON Schema\)/);
	assert.match(user, /"enum":\s*\[\s*"fix",\s*"add",\s*"trim"\s*\]/);
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
	assert.equal(r.workItems[0]!.kind, 'fix');
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

test('reviewAction: all 3 attempts invalid -> soft accept with degraded:true', async () => {
	// P.4 raised max attempts to 3 -- need 3 garbage responses to exhaust the loop.
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProvider('garbage one', 'garbage two', 'garbage three'),
	);
	assert.equal(r.verdict, 'accept');
	assert.equal(r.degraded, true);
	assert.deepEqual(r.workItems, []);
	assert.equal(r.accepted?.markdown, DRAFT.markdown);
	assert.match(r.notes[0] ?? '', /reviewer-degraded after 3 attempts/);
});

test('reviewAction: provider throws on all attempts -> soft accept', async () => {
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProviderThrowing('connection lost'),
	);
	assert.equal(r.verdict, 'accept');
	assert.equal(r.degraded, true);
	assert.deepEqual(r.workItems, []);
});

test('reviewAction: P.4 kind-enum violation recovers on corrective retry', async () => {
	// First attempt: out-of-enum kind 'clarify'.
	// Second attempt: corrected to 'fix' after seeing the corrective message.
	const bad = JSON.stringify({
		verdict:   'needs-work',
		workItems: [{ id: 'wi-1', kind: 'clarify', where: 'p1', issue: 'thin', action: 'add detail' }],
	});
	const good = JSON.stringify({
		verdict:   'needs-work',
		workItems: [{ id: 'wi-1', kind: 'fix', where: 'p1', issue: 'thin', action: 'add detail' }],
	});
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProvider(bad, good),
	);
	assert.equal(r.verdict, 'needs-work');
	assert.equal(r.degraded, false);
	assert.equal(r.workItems[0]!.kind, 'fix');
});

test('reviewAction: P.4 third attempt succeeds after two failures (3-attempt loop)', async () => {
	const r = await reviewAction(
		{ action: ACTION, draft: DRAFT, evidence: EVIDENCE },
		fakeProvider(
			'garbage one',
			'garbage two',
			JSON.stringify({ verdict: 'accept', workItems: [], notes: ['recovered'] }),
		),
	);
	assert.equal(r.verdict, 'accept');
	assert.equal(r.degraded, false);
});

