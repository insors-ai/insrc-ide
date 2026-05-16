/**
 * Tests for the Phase G best-of-rounds picker + footer builder.
 *
 * Picker uses lexicographic preference:
 *   1. fixItemsAddressed (correctness wins)
 *   2. citationCount
 *   3. paragraphCount
 *   4. textLength (tie-breaker)
 *
 * Footer lists reviewer follow-ups left unaddressed by the shipped
 * draft.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	pickBestRound,
	buildSectionFooter,
	type RoundCandidate,
	_scoreOneForTest as scoreOne,
	_compareSignalsForTest as compareSignals,
	_countCitationsForTest as countCitations,
	_countParagraphsForTest as countParagraphs,
} from '../pick-best-draft.js';
import type { ReviewActionResult, ReviewWorkItem } from '../../../content-gen/review-action.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkReview(verdict: 'accept' | 'needs-work', workItems: ReviewWorkItem[] = []): ReviewActionResult {
	return {
		verdict,
		workItems,
		notes:    [],
		degraded: false,
	};
}

function wi(opts: Partial<ReviewWorkItem> & Pick<ReviewWorkItem, 'id' | 'kind'>): ReviewWorkItem {
	return {
		where:  opts.where  ?? 'paragraph 1',
		issue:  opts.issue  ?? 'placeholder',
		action: opts.action ?? 'placeholder',
		...opts,
	} as ReviewWorkItem;
}

const SHORT_MD = 'Short paragraph one.';
const TWO_PARA_MD = 'Para one.\n\nPara two.';
const RICH_MD = [
	'The HDFS DataNode [`DataNode`](path:hdfs/DataNode.java#L100) handles block storage.',
	'',
	'It serves reads and writes for [`BlockReader`](path:hdfs/BlockReader.java#L50).',
	'',
	'Replication is configured via [`dfs.replication`](path:hdfs/Conf.java#L200).',
].join('\n');

// ---------------------------------------------------------------------------
// scoring helpers (pure)
// ---------------------------------------------------------------------------

test('countCitations: zero / one / many', () => {
	assert.equal(countCitations('no citations here'), 0);
	assert.equal(countCitations('one [`X`](path:X.ts#L1) here'), 1);
	assert.equal(countCitations(RICH_MD), 3);
});

test('countParagraphs: blank-line separated', () => {
	assert.equal(countParagraphs(''), 0);
	assert.equal(countParagraphs(SHORT_MD), 1);
	assert.equal(countParagraphs(TWO_PARA_MD), 2);
	assert.equal(countParagraphs(RICH_MD), 3);
});

test('compareSignals: tie on all -> 0', () => {
	const a = { round: 1 as const, fixItemsAddressed: 0, citationCount: 0, paragraphCount: 0, textLength: 100 };
	const b = { round: 2 as const, fixItemsAddressed: 0, citationCount: 0, paragraphCount: 0, textLength: 100 };
	const cmp = compareSignals(a, b);
	assert.equal(cmp.cmp, 0);
});

test('compareSignals: fixItemsAddressed dominates', () => {
	const a = { round: 1 as const, fixItemsAddressed: 1, citationCount: 0, paragraphCount: 0, textLength: 100 };
	const b = { round: 2 as const, fixItemsAddressed: 0, citationCount: 99, paragraphCount: 99, textLength: 10000 };
	const cmp = compareSignals(a, b);
	assert.ok(cmp.cmp < 0, 'a wins on fixItemsAddressed');
	assert.equal(cmp.reason, 'fix-items-addressed');
});

test('compareSignals: citationCount second priority', () => {
	const a = { round: 1 as const, fixItemsAddressed: 0, citationCount: 5, paragraphCount: 1, textLength: 100 };
	const b = { round: 2 as const, fixItemsAddressed: 0, citationCount: 2, paragraphCount: 99, textLength: 10000 };
	const cmp = compareSignals(a, b);
	assert.ok(cmp.cmp < 0, 'a wins on citations');
	assert.equal(cmp.reason, 'citation-count');
});

test('compareSignals: text-length as tie-breaker', () => {
	const a = { round: 1 as const, fixItemsAddressed: 0, citationCount: 0, paragraphCount: 0, textLength: 200 };
	const b = { round: 2 as const, fixItemsAddressed: 0, citationCount: 0, paragraphCount: 0, textLength: 100 };
	const cmp = compareSignals(a, b);
	assert.ok(cmp.cmp < 0);
	assert.equal(cmp.reason, 'text-length');
});

test('scoreOne: round 1 has fixItemsAddressed=0 by definition', () => {
	const c: RoundCandidate = {
		round:    1,
		markdown: RICH_MD,
		review:   mkReview('needs-work', [wi({ id: 'wi-1', kind: 'fix' })]),
	};
	const s = scoreOne(c);
	assert.equal(s.fixItemsAddressed, 0);   // no `patch` field
	assert.equal(s.citationCount, 3);
	assert.equal(s.paragraphCount, 3);
});

test('scoreOne: patch round counts only `fix` items addressed', () => {
	const c: RoundCandidate = {
		round:    2,
		markdown: SHORT_MD,
		review:   mkReview('needs-work'),
		patch: {
			priorWorkItems: [
				wi({ id: 'wi-1', kind: 'fix' }),
				wi({ id: 'wi-2', kind: 'fix' }),
				wi({ id: 'wi-3', kind: 'enhance' }),    // not a fix
				wi({ id: 'wi-4', kind: 'fix' }),
			],
			itemStatuses: [
				{ id: 'wi-1', status: 'addressed' },     // counted
				{ id: 'wi-2', status: 'skipped' },        // not counted
				{ id: 'wi-3', status: 'addressed' },      // counted? no (kind=enhance)
				{ id: 'wi-4', status: 'partial' },        // not counted (not 'addressed')
			],
		},
	};
	const s = scoreOne(c);
	assert.equal(s.fixItemsAddressed, 1);
});

// ---------------------------------------------------------------------------
// pickBestRound
// ---------------------------------------------------------------------------

test('pickBestRound: sole candidate -> wins by default', () => {
	const c: RoundCandidate = { round: 1, markdown: SHORT_MD, review: mkReview('needs-work') };
	const r = pickBestRound([c]);
	assert.equal(r.winnerIdx, 0);
	assert.equal(r.reason, 'sole-candidate');
});

test('pickBestRound: round 2 wins when it addressed a fix item; round 1 had none', () => {
	const r1: RoundCandidate = {
		round:    1,
		markdown: RICH_MD,
		review:   mkReview('needs-work', [wi({ id: 'wi-1', kind: 'fix' })]),
	};
	const r2: RoundCandidate = {
		round:    2,
		markdown: SHORT_MD,     // shorter / fewer citations than r1
		review:   mkReview('needs-work'),
		patch: {
			priorWorkItems: [wi({ id: 'wi-1', kind: 'fix' })],
			itemStatuses:   [{ id: 'wi-1', status: 'addressed' }],
		},
	};
	const r = pickBestRound([r1, r2]);
	assert.equal(r.winnerIdx, 1);
	assert.equal(r.reason, 'fix-items-addressed');
});

test('pickBestRound: round 1 wins on citations when round 2 addressed no fix items', () => {
	const r1: RoundCandidate = { round: 1, markdown: RICH_MD,  review: mkReview('needs-work') };
	const r2: RoundCandidate = {
		round:    2,
		markdown: SHORT_MD,
		review:   mkReview('needs-work'),
		patch: {
			priorWorkItems: [wi({ id: 'wi-1', kind: 'fix' })],
			itemStatuses:   [{ id: 'wi-1', status: 'skipped' }],     // fix NOT addressed
		},
	};
	const r = pickBestRound([r1, r2]);
	assert.equal(r.winnerIdx, 0);
	assert.equal(r.reason, 'citation-count');
});

test('pickBestRound: three rounds, round 3 wins on citations', () => {
	const r1: RoundCandidate = { round: 1, markdown: SHORT_MD,   review: mkReview('needs-work') };
	const r2: RoundCandidate = { round: 2, markdown: TWO_PARA_MD, review: mkReview('needs-work') };
	const r3: RoundCandidate = { round: 3, markdown: RICH_MD,    review: mkReview('needs-work') };
	const r = pickBestRound([r1, r2, r3]);
	assert.equal(r.winnerIdx, 2);
	assert.equal(r.reason, 'citation-count');
});

test('pickBestRound: regression -> round 1 wins over round 2 + round 3', () => {
	// Hadoop-style regression: round 2 + 3 shorter and citation-poor.
	const r1: RoundCandidate = { round: 1, markdown: RICH_MD,   review: mkReview('needs-work') };
	const r2: RoundCandidate = { round: 2, markdown: SHORT_MD,  review: mkReview('needs-work') };
	const r3: RoundCandidate = { round: 3, markdown: TWO_PARA_MD, review: mkReview('needs-work') };
	const r = pickBestRound([r1, r2, r3]);
	assert.equal(r.winnerIdx, 0);
});

test('pickBestRound: empty -> throws', () => {
	assert.throws(() => pickBestRound([]), /non-empty/);
});

// ---------------------------------------------------------------------------
// buildSectionFooter
// ---------------------------------------------------------------------------

test('buildSectionFooter: empty -> empty string', () => {
	assert.equal(buildSectionFooter([]), '');
});

test('buildSectionFooter: items listed with kind + where + action', () => {
	const items: ReviewWorkItem[] = [
		wi({ id: 'wi-1', kind: 'enhance', where: 'paragraph 2', action: 'add file:line refs for DatanodeManager' }),
		wi({ id: 'wi-2', kind: 'add',     where: 'after paragraph 4', action: 'cover rack-awareness' }),
	];
	const out = buildSectionFooter(items);
	assert.match(out, /---/);
	assert.match(out, /Reviewer flagged 2 follow-ups/);
	assert.match(out, /enhance paragraph 2: add file:line refs for DatanodeManager/);
	assert.match(out, /add after paragraph 4: cover rack-awareness/);
	assert.match(out, /See the TodoList item/);
});

test('buildSectionFooter: single item -> singular noun', () => {
	const items: ReviewWorkItem[] = [wi({ id: 'wi-1', kind: 'fix', action: 'fix the claim' })];
	const out = buildSectionFooter(items);
	assert.match(out, /1 follow-up\b/);   // singular
	assert.doesNotMatch(out, /follow-ups/);
});
