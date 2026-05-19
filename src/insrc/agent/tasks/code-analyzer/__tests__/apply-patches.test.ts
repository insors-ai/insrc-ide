/**
 * Tests for the Phase F patch-block parser + applier.
 *
 *   parsePatches:  scan a writer's text for `patch:<id>` / `skip:<id>`
 *                  fenced blocks; return them in order.
 *   applyPatches:  apply the blocks to a draft markdown driven by the
 *                  reviewer's work-item list; return patched markdown
 *                  + per-item statuses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	parsePatches,
	applyPatches,
	_resolveParagraphIdxForTest as resolveIdx,
	_splitParagraphsForTest     as splitParas,
	_stripTrailingTransitionForTest as stripTransition,
} from '../apply-patches.js';
import type { ReviewWorkItem } from '../../../content-gen/review-action.js';

// ---------------------------------------------------------------------------
// splitParagraphs (helper sanity)
// ---------------------------------------------------------------------------

test('splitParagraphs: blank-line separated -> trimmed list', () => {
	const out = splitParas('one\n\ntwo\n\nthree');
	assert.deepEqual(out, ['one', 'two', 'three']);
});

test('splitParagraphs: empty -> empty list', () => {
	assert.deepEqual(splitParas(''), []);
	assert.deepEqual(splitParas('   \n\n  '), []);
});

test('splitParagraphs: leading/trailing whitespace tolerated', () => {
	const out = splitParas('\n\n  one  \n\n  two  \n\n');
	assert.deepEqual(out, ['one', 'two']);
});

// ---------------------------------------------------------------------------
// resolveParagraphIdx
// ---------------------------------------------------------------------------

const THREE: readonly string[] = ['a', 'b', 'c'];

test('resolveIdx: "paragraph N" 1-indexed', () => {
	assert.equal(resolveIdx('paragraph 1', THREE), 0);
	assert.equal(resolveIdx('paragraph 2', THREE), 1);
	assert.equal(resolveIdx('paragraph 3', THREE), 2);
});

test('resolveIdx: out-of-range -> null', () => {
	assert.equal(resolveIdx('paragraph 5', THREE), null);
	assert.equal(resolveIdx('paragraph 0', THREE), null);
});

test('resolveIdx: "section opening" / "section closing"', () => {
	assert.equal(resolveIdx('section opening', THREE), 0);
	assert.equal(resolveIdx('section closing', THREE), 2);
	assert.equal(resolveIdx('opening', THREE), 0);
	assert.equal(resolveIdx('end', THREE), 2);
});

test('resolveIdx: "after paragraph N"', () => {
	assert.equal(resolveIdx('after paragraph 2', THREE), 1);
});

test('resolveIdx: range "paragraphs 2-4" -> first of range', () => {
	assert.equal(resolveIdx('paragraphs 2-4', THREE), 1);
});

test('resolveIdx: empty paragraphs -> null', () => {
	assert.equal(resolveIdx('paragraph 1', []), null);
});

test('resolveIdx: vague phrasing -> null', () => {
	assert.equal(resolveIdx('throughout the draft', THREE), null);
	assert.equal(resolveIdx('several places', THREE), null);
});

// ---------------------------------------------------------------------------
// parsePatches
// ---------------------------------------------------------------------------

test('parsePatches: single patch block extracted', () => {
	const text = [
		'I will replace paragraph 2 with a citation.',
		'',
		'```patch:wi-1',
		'New paragraph text with [`X`](path:X.ts#L1).',
		'```',
	].join('\n');
	const blocks = parsePatches(text);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0]!.kind, 'patch');
	assert.equal(blocks[0]!.itemId, 'wi-1');
	assert.match(blocks[0]!.body, /New paragraph text/);
});

test('parsePatches: skip block extracted with reason', () => {
	const text = [
		'```skip:wi-3',
		'Could not find rack-awareness module.',
		'```',
	].join('\n');
	const blocks = parsePatches(text);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0]!.kind, 'skip');
	assert.equal(blocks[0]!.itemId, 'wi-3');
	assert.match(blocks[0]!.body, /rack-awareness/);
});

test('parsePatches: patch + skip + patch in order', () => {
	const text = [
		'```patch:wi-1', 'replace1', '```',
		'',
		'reasoning prose between blocks...',
		'',
		'```skip:wi-2',
		'gave up',
		'```',
		'',
		'```patch:wi-3 after=paragraph-2',
		'inserted text',
		'```',
	].join('\n');
	const blocks = parsePatches(text);
	assert.equal(blocks.length, 3);
	assert.deepEqual(blocks.map(b => b.itemId), ['wi-1', 'wi-2', 'wi-3']);
	assert.equal(blocks[2]!.attrs['after'], 'paragraph-2');
});

test('parsePatches: no blocks -> empty array', () => {
	const text = 'just prose, no fenced blocks.\n\nstill prose.';
	assert.deepEqual(parsePatches(text), []);
});

test('parsePatches: malformed (unclosed fence) -> skipped', () => {
	const text = '```patch:wi-1\nbody but no closing fence';
	assert.deepEqual(parsePatches(text), []);
});

// ---------------------------------------------------------------------------
// applyPatches end-to-end
// ---------------------------------------------------------------------------

const DRAFT = [
	'Hadoop is an open-source framework.',                          // paragraph 1
	'HDFS stores data across cluster nodes.',                        // paragraph 2
	'MapReduce processes data in two phases.',                       // paragraph 3
].join('\n\n');

function wi(opts: Partial<ReviewWorkItem> & Pick<ReviewWorkItem, 'id' | 'kind'>): ReviewWorkItem {
	return {
		where:  opts.where  ?? 'paragraph 1',
		issue:  opts.issue  ?? 'placeholder',
		action: opts.action ?? 'placeholder',
		...opts,
	} as ReviewWorkItem;
}

test('applyPatches: fix replaces target paragraph', () => {
	const items = [wi({ id: 'wi-1', kind: 'fix', where: 'paragraph 2' })];
	const blocks = parsePatches('```patch:wi-1\nHDFS stores data across a cluster, default replication 3.\n```');
	const r = applyPatches(DRAFT, items, blocks);
	const lines = r.patchedMarkdown.split('\n\n');
	assert.equal(lines.length, 3);
	assert.match(lines[1]!, /replication 3/);
	assert.equal(r.itemStatuses[0]!.status, 'addressed');
});

test('applyPatches: add inserts after the where paragraph', () => {
	const items = [wi({ id: 'wi-1', kind: 'add', where: 'after paragraph 2' })];
	const blocks = parsePatches('```patch:wi-1\nYARN schedules containers across the cluster.\n```');
	const r = applyPatches(DRAFT, items, blocks);
	const lines = r.patchedMarkdown.split('\n\n');
	assert.equal(lines.length, 4);
	assert.match(lines[2]!, /YARN schedules/);
	assert.equal(r.itemStatuses[0]!.status, 'addressed');
});

test('applyPatches: add with after= attr overrides where', () => {
	const items = [wi({ id: 'wi-1', kind: 'add', where: 'paragraph 1' })];
	const blocks = parsePatches('```patch:wi-1 after=paragraph-3\nAppended after para 3.\n```');
	const r = applyPatches(DRAFT, items, blocks);
	const lines = r.patchedMarkdown.split('\n\n');
	assert.equal(lines.length, 4);
	assert.match(lines[3]!, /Appended after para 3/);
});

test('applyPatches: trim deletes the targeted paragraph', () => {
	const items = [wi({ id: 'wi-1', kind: 'trim', where: 'paragraph 3' })];
	const blocks = parsePatches('```patch:wi-1\n\n```');
	const r = applyPatches(DRAFT, items, blocks);
	const lines = r.patchedMarkdown.split('\n\n');
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /Hadoop/);
	assert.match(lines[1]!, /HDFS/);
	assert.equal(r.itemStatuses[0]!.status, 'addressed');
});

test('applyPatches: fix where unresolved -> appended at end, status=partial', () => {
	const items = [wi({ id: 'wi-1', kind: 'fix', where: 'throughout the draft' })];
	const blocks = parsePatches('```patch:wi-1\nCorrected claim.\n```');
	const r = applyPatches(DRAFT, items, blocks);
	const lines = r.patchedMarkdown.split('\n\n');
	assert.equal(lines.length, 4);
	assert.match(lines[3]!, /Corrected claim/);
	assert.equal(r.itemStatuses[0]!.status, 'partial');
	assert.match(r.itemStatuses[0]!.reason ?? '', /where unresolved/);
});

test('applyPatches: skip block -> status=skipped with reason', () => {
	const items = [wi({ id: 'wi-1', kind: 'add', where: 'paragraph 1' })];
	const blocks = parsePatches('```skip:wi-1\nCould not find the relevant code path.\n```');
	const r = applyPatches(DRAFT, items, blocks);
	const lines = r.patchedMarkdown.split('\n\n');
	assert.equal(lines.length, 3);  // unchanged
	assert.equal(r.itemStatuses[0]!.status, 'skipped');
	assert.match(r.itemStatuses[0]!.reason ?? '', /Could not find/);
});

test('applyPatches: no block emitted for item -> status=skipped no-patch', () => {
	const items = [wi({ id: 'wi-1', kind: 'fix', where: 'paragraph 1' })];
	const blocks = parsePatches('');
	const r = applyPatches(DRAFT, items, blocks);
	const lines = r.patchedMarkdown.split('\n\n');
	assert.equal(lines.length, 3);  // unchanged
	assert.equal(r.itemStatuses[0]!.status, 'skipped');
	assert.match(r.itemStatuses[0]!.reason ?? '', /no patch emitted/);
});

test('applyPatches: multiple ops -- replace, insert, delete -- non-overlapping', () => {
	const items = [
		wi({ id: 'wi-1', kind: 'fix', where: 'paragraph 1' }),
		wi({ id: 'wi-2', kind: 'add',     where: 'after paragraph 1' }),
		wi({ id: 'wi-3', kind: 'trim',    where: 'paragraph 3' }),
	];
	const blocks = parsePatches([
		'```patch:wi-1', 'Hadoop is a distributed framework with three subsystems.', '```',
		'```patch:wi-2', 'Inserted between para 1 and 2.', '```',
		'```patch:wi-3', '', '```',
	].join('\n'));
	const r = applyPatches(DRAFT, items, blocks);
	const lines = r.patchedMarkdown.split('\n\n');
	assert.equal(lines.length, 3);   // 3 (start) - 1 trim + 1 insert = 3
	assert.match(lines[0]!, /three subsystems/);
	assert.match(lines[1]!, /Inserted between/);
	assert.match(lines[2]!, /HDFS/);
	assert.equal(r.itemStatuses.length, 3);
	for (const s of r.itemStatuses) assert.equal(s.status, 'addressed');
});

test('applyPatches: status order matches workItems order, not block order', () => {
	const items = [
		wi({ id: 'wi-A', kind: 'fix', where: 'paragraph 1' }),
		wi({ id: 'wi-B', kind: 'fix', where: 'paragraph 2' }),
	];
	// Emit block B before block A in the writer text:
	const blocks = parsePatches([
		'```patch:wi-B', 'B-body', '```',
		'```patch:wi-A', 'A-body', '```',
	].join('\n'));
	const r = applyPatches(DRAFT, items, blocks);
	assert.equal(r.itemStatuses[0]!.id, 'wi-A');
	assert.equal(r.itemStatuses[1]!.id, 'wi-B');
});

test('applyPatches: empty workItems -> draft unchanged', () => {
	const r = applyPatches(DRAFT, [], []);
	assert.equal(r.patchedMarkdown, DRAFT);
	assert.deepEqual(r.itemStatuses, []);
});

// ---------------------------------------------------------------------------
// Phase L.4: trailing-transition sanitizer
// ---------------------------------------------------------------------------

test('stripTransition: clean body -> unchanged', () => {
	const out = stripTransition('The HDFS DataNode handles block storage.');
	assert.equal(out.changed, false);
	assert.equal(out.body, 'The HDFS DataNode handles block storage.');
});

test('stripTransition: trailing "Next, I will..." -> stripped', () => {
	const out = stripTransition('The HDFS module contains 707 files. Next, I will examine MapReduce.');
	assert.equal(out.changed, true);
	assert.match(out.body, /707 files\.$/);
});

test('stripTransition: trailing "Let me now investigate..." -> stripped', () => {
	const out = stripTransition('Three cycles were reported. Let me now investigate the largest one.');
	assert.equal(out.changed, true);
	assert.match(out.body, /reported\.$/);
});

test('stripTransition: trailing "I will examine..." -> stripped', () => {
	const out = stripTransition('YARN handles resource allocation. I will examine the NodeManager next.');
	assert.equal(out.changed, true);
	assert.match(out.body, /allocation\.$/);
});

test('stripTransition: "I will" mid-paragraph -> NOT stripped', () => {
	const out = stripTransition('The reader I will describe is BlockReader; it serves all reads.');
	assert.equal(out.changed, false);
});

test('stripTransition: empty body -> unchanged', () => {
	const out = stripTransition('');
	assert.equal(out.changed, false);
	assert.equal(out.body, '');
});

test('applyPatches: patch body with trailing transition -> sanitized + status=partial', () => {
	const items = [wi({ id: 'wi-1', kind: 'fix', where: 'paragraph 1' })];
	const blocks = parsePatches('```patch:wi-1\nHadoop is an open-source framework. Next, I will examine HDFS.\n```');
	const r = applyPatches(DRAFT, items, blocks);
	const lines = r.patchedMarkdown.split('\n\n');
	assert.match(lines[0]!, /open-source framework\.$/);
	assert.doesNotMatch(lines[0]!, /Next, I will/);
	assert.equal(r.itemStatuses[0]!.status, 'partial');
	assert.match(r.itemStatuses[0]!.reason ?? '', /trailing sentence stripped/);
});
