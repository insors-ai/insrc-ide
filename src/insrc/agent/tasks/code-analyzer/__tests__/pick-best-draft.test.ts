/**
 * Tests for the Phase P.9 best-of-rounds picker.
 *
 * Picker uses a weighted-sum scoring with absolute-target normalisation:
 *
 *   weighted-items-addressed (weight 4, target 10) -- inner weights:
 *     fix=3, add=2, enhance=2, trim=1
 *   citation-diversity        (weight 3, target 8 unique cited files)
 *   paragraph-count           (weight 2, target 6)
 *   text-length               (weight 1, target 3000 chars)
 *
 *   score = sum(weight_i * min(raw_i / target_i, 1.0))
 *   // max possible: 10.0
 *
 * shipDecisionReason is the signal that contributed the most points
 * to the winner's total.
 *
 * The G.3 buildSectionFooter helper was removed after run #3 --
 * reviewer misses are now only logged, not appended to the section
 * markdown. See the orchestrator's per-section log line +
 * TodoList reviewRounds[] trace.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	pickBestRound,
	type RoundCandidate,
	_scoreOneForTest as scoreOne,
	_countWeightedItemsAddressedForTest as countItems,
	_countCitationDiversityForTest as countCiteDiv,
	_countParagraphsForTest as countParagraphs,
	_WEIGHTS,
	_TARGETS,
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
// Counter helpers
// ---------------------------------------------------------------------------

test('countCitationDiversity: zero / one / many distinct files', () => {
	assert.equal(countCiteDiv('no citations here'), 0);
	assert.equal(countCiteDiv('one [`X`](path:X.ts#L1) here'), 1);
	assert.equal(countCiteDiv(RICH_MD), 3);
});

test('countCitationDiversity: multiple citations to SAME file count as 1', () => {
	// Phase P.9: diversity, not raw count -- two citations to foo.ts at
	// different line ranges = 1 cited file.
	const md = '[A](path:foo.ts#L10) and [B](path:foo.ts#L50) plus [C](path:bar.ts#L1).';
	assert.equal(countCiteDiv(md), 2);   // foo.ts + bar.ts = 2 distinct files
});

test('countParagraphs: blank-line separated', () => {
	assert.equal(countParagraphs(''), 0);
	assert.equal(countParagraphs(SHORT_MD), 1);
	assert.equal(countParagraphs(TWO_PARA_MD), 2);
	assert.equal(countParagraphs(RICH_MD), 3);
});

test('countWeightedItemsAddressed: round 1 (no patch field) -> 0', () => {
	const c: RoundCandidate = {
		round:    1,
		markdown: RICH_MD,
		review:   mkReview('needs-work'),
	};
	assert.equal(countItems(c), 0);
});

test('countWeightedItemsAddressed: kind weights -- fix=3, add=2, enhance=2, trim=1', () => {
	const c: RoundCandidate = {
		round:    2,
		markdown: SHORT_MD,
		review:   mkReview('needs-work'),
		patch: {
			priorWorkItems: [
				wi({ id: 'wi-1', kind: 'fix' }),       // 3
				wi({ id: 'wi-2', kind: 'add' }),       // 2
				wi({ id: 'wi-3', kind: 'enhance' }),   // 2
				wi({ id: 'wi-4', kind: 'trim' }),      // 1
				wi({ id: 'wi-5', kind: 'enhance' }),   // not addressed -> 0
			],
			itemStatuses: [
				{ id: 'wi-1', status: 'addressed' },
				{ id: 'wi-2', status: 'addressed' },
				{ id: 'wi-3', status: 'addressed' },
				{ id: 'wi-4', status: 'addressed' },
				{ id: 'wi-5', status: 'partial' },     // not counted
			],
		},
	};
	// 3 + 2 + 2 + 1 = 8
	assert.equal(countItems(c), 8);
});

test('countWeightedItemsAddressed: skipped + partial NOT counted', () => {
	const c: RoundCandidate = {
		round:    2,
		markdown: SHORT_MD,
		review:   mkReview('needs-work'),
		patch: {
			priorWorkItems: [
				wi({ id: 'wi-1', kind: 'fix' }),
				wi({ id: 'wi-2', kind: 'enhance' }),
			],
			itemStatuses: [
				{ id: 'wi-1', status: 'skipped' },
				{ id: 'wi-2', status: 'partial' },
			],
		},
	};
	assert.equal(countItems(c), 0);
});

test('scoreOne: produces normalised + contribution + totalScore breakdown', () => {
	const c: RoundCandidate = {
		round:    2,
		markdown: RICH_MD,                                   // 3 paras / 3 cites / 213 chars
		review:   mkReview('needs-work'),
		patch: {
			priorWorkItems: [wi({ id: 'wi-1', kind: 'fix' })],
			itemStatuses:   [{ id: 'wi-1', status: 'addressed' }],
		},
	};
	const s = scoreOne(c);
	assert.equal(s.weightedItemsAddressed, 3);                          // 1 fix * 3 = 3
	assert.equal(s.citationDiversity,      3);                          // 3 unique files
	assert.equal(s.paragraphCount,         3);
	assert.equal(s.textLength,             RICH_MD.length);

	// Normalised: items 3/10=0.3, cites 3/8=0.375, paras 3/6=0.5, len ≈ 0.07
	assert.ok(Math.abs(s.normalised.weightedItemsAddressed - 0.3)   < 1e-6);
	assert.ok(Math.abs(s.normalised.citationDiversity      - 0.375) < 1e-6);
	assert.ok(Math.abs(s.normalised.paragraphCount         - 0.5)   < 1e-6);

	// Total = 4*0.3 + 3*0.375 + 2*0.5 + 1*(RICH_MD.length/3000)
	const expected = 4*0.3 + 3*0.375 + 2*0.5 + 1*(RICH_MD.length/3000);
	assert.ok(Math.abs(s.totalScore - expected) < 1e-6);
});

test('scoreOne: normalised caps at 1.0', () => {
	const longMd = 'x'.repeat(5000);   // 5000 chars > target 3000
	const c: RoundCandidate = {
		round:    1,
		markdown: longMd,
		review:   mkReview('needs-work'),
	};
	const s = scoreOne(c);
	assert.equal(s.normalised.textLength, 1.0);   // capped, NOT 1.67
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

test('pickBestRound: round 2 wins when it addresses enough fixes to outweigh richer r1', () => {
	// r2 addresses 3 fix items (3*3=9, normalised 0.9, contribution 3.6).
	// r1 has RICH_MD (3 cites = contribution 1.125, 3 paras = 1.0,
	// len ~ 0.08, items=0). r1 total ~2.2; r2 total ~3.7+ -> r2 wins.
	const r1: RoundCandidate = {
		round:    1,
		markdown: RICH_MD,
		review:   mkReview('needs-work', [
			wi({ id: 'wi-1', kind: 'fix' }),
			wi({ id: 'wi-2', kind: 'fix' }),
			wi({ id: 'wi-3', kind: 'fix' }),
		]),
	};
	const r2: RoundCandidate = {
		round:    2,
		markdown: SHORT_MD,
		review:   mkReview('needs-work'),
		patch: {
			priorWorkItems: [
				wi({ id: 'wi-1', kind: 'fix' }),
				wi({ id: 'wi-2', kind: 'fix' }),
				wi({ id: 'wi-3', kind: 'fix' }),
			],
			itemStatuses: [
				{ id: 'wi-1', status: 'addressed' },
				{ id: 'wi-2', status: 'addressed' },
				{ id: 'wi-3', status: 'addressed' },
			],
		},
	};
	const r = pickBestRound([r1, r2]);
	assert.equal(r.winnerIdx, 1, `r2 should win; scores=${JSON.stringify(r.scores.map(s => s.totalScore))}`);
	assert.equal(r.reason, 'weighted-items-addressed');
});

test('pickBestRound: single fix item NOT enough to win over a much richer r1', () => {
	// Inverse of the above: 1 fix item (weight 3, normalised 0.3,
	// contribution 1.2) does NOT beat r1's combined cites+paras+len
	// (contribution ~2.2). This is the P.9 design intent: weighted
	// scores let small wins on one axis be outvoted by sustained
	// strength on the others.
	const r1: RoundCandidate = {
		round:    1,
		markdown: RICH_MD,
		review:   mkReview('needs-work', [wi({ id: 'wi-1', kind: 'fix' })]),
	};
	const r2: RoundCandidate = {
		round:    2,
		markdown: SHORT_MD,
		review:   mkReview('needs-work'),
		patch: {
			priorWorkItems: [wi({ id: 'wi-1', kind: 'fix' })],
			itemStatuses:   [{ id: 'wi-1', status: 'addressed' }],
		},
	};
	const r = pickBestRound([r1, r2]);
	assert.equal(r.winnerIdx, 0);
});

test('pickBestRound: P.9 fix -- enhance/add items now count (run #4 section 1 case)', () => {
	// Run #4 section 1: reviewer flagged 6 items, all kind=enhance/add/trim
	// (NO fix items). Round 2 addressed 5 of them, round 1 had 13 citations.
	// Under the OLD lex picker: r1 won (because fixItemsAddressed tied at
	// 0 and citationCount fell through to r1's lead). Under the NEW
	// weighted picker: r2 wins because items-addressed weight=4 > cites
	// weight=3.
	const r1: RoundCandidate = {
		round:    1,
		// Round 1 markdown: 13 distinct cited files, 5 paragraphs, ~2500 chars
		markdown: [
			'Section opener',
			...Array.from({ length: 13 }, (_, i) => `Para ${i + 1} with [link](path:f${i}.ts#L1).`),
		].join('\n\n').padEnd(2500, ' '),
		review:   mkReview('needs-work'),
	};
	const r2: RoundCandidate = {
		round:    2,
		// Patched draft: 8 distinct cited files, 4 paragraphs, ~2200 chars
		markdown: [
			...Array.from({ length: 8 }, (_, i) => `Para ${i + 1} with [link](path:g${i}.ts#L1).`),
		].join('\n\n').padEnd(2200, ' '),
		review:   mkReview('needs-work'),
		patch: {
			priorWorkItems: Array.from({ length: 5 }, (_, i) => wi({ id: `wi-${i + 1}`, kind: 'enhance' })),
			itemStatuses:   Array.from({ length: 5 }, (_, i) => ({ id: `wi-${i + 1}`, status: 'addressed' as const })),
		},
	};
	const r = pickBestRound([r1, r2]);
	assert.equal(r.winnerIdx, 1, `r2 should win under P.9; scores=${JSON.stringify(r.scores.map(s => s.totalScore))}`);
});

test('pickBestRound: regression -- r2/r3 worse than r1 -> r1 wins', () => {
	// Hadoop-style regression: r2 + r3 shorter, citation-poor, addressed nothing.
	const r1: RoundCandidate = { round: 1, markdown: RICH_MD,    review: mkReview('needs-work') };
	const r2: RoundCandidate = { round: 2, markdown: SHORT_MD,   review: mkReview('needs-work') };
	const r3: RoundCandidate = { round: 3, markdown: TWO_PARA_MD, review: mkReview('needs-work') };
	const r = pickBestRound([r1, r2, r3]);
	assert.equal(r.winnerIdx, 0);
});

test('pickBestRound: all-tied -> reason="tied", first round wins', () => {
	const r1: RoundCandidate = { round: 1, markdown: SHORT_MD, review: mkReview('needs-work') };
	const r2: RoundCandidate = { round: 2, markdown: SHORT_MD, review: mkReview('needs-work') };
	const r3: RoundCandidate = { round: 3, markdown: SHORT_MD, review: mkReview('needs-work') };
	const r = pickBestRound([r1, r2, r3]);
	assert.equal(r.winnerIdx, 0);
	assert.equal(r.reason, 'tied');
});

test('pickBestRound: absolute normalisation -- 13 vs 8 citations both cap at 1.0', () => {
	// Both candidates exceed the citation-diversity target (8). Their
	// citation contribution should be identical (1.0 normalised); the
	// picker should fall through to other signals (length tiebreaker).
	const md8  = Array.from({ length: 8 },  (_, i) => `[x](path:f${i}.ts#L1)`).join('\n\n');
	const md13 = Array.from({ length: 13 }, (_, i) => `[x](path:g${i}.ts#L1)`).join('\n\n');
	const r1: RoundCandidate = { round: 1, markdown: md13, review: mkReview('needs-work') };
	const r2: RoundCandidate = { round: 2, markdown: md8,  review: mkReview('needs-work') };
	const s1 = scoreOne(r1);
	const s2 = scoreOne(r2);
	assert.equal(s1.normalised.citationDiversity, 1.0);
	assert.equal(s2.normalised.citationDiversity, 1.0);
	// Both cap at full credit on citations -- the picker doesn't favour
	// the candidate with MORE excess citations (the P.9 design goal).
});

test('pickBestRound: empty -> throws', () => {
	assert.throws(() => pickBestRound([]), /non-empty/);
});

test('pickBestRound: constants exposed for tuning', () => {
	// Sanity-check that WEIGHTS/TARGETS are exposed so they can be
	// retuned without rewriting test fixtures.
	assert.equal(_WEIGHTS.weightedItemsAddressed, 4);
	assert.equal(_WEIGHTS.citationDiversity,      3);
	assert.equal(_WEIGHTS.paragraphCount,         2);
	assert.equal(_WEIGHTS.textLength,             1);
	assert.equal(_TARGETS.weightedItemsAddressed, 10);
	assert.equal(_TARGETS.citationDiversity,      8);
	assert.equal(_TARGETS.paragraphCount,         6);
	assert.equal(_TARGETS.textLength,             3000);
});
