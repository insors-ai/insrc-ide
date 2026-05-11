/**
 * Tests for `chunkResponseForRetrieval` (Phase 2 of
 * plans/intent-classification-consolidation.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkResponseForRetrieval } from '../response-chunker.js';

test('empty / whitespace input -> zero chunks', () => {
	assert.deepEqual(chunkResponseForRetrieval(''),       []);
	assert.deepEqual(chunkResponseForRetrieval('   \n\n\t'), []);
});

test('short single-section response -> one chunk, idx=0', () => {
	const out = chunkResponseForRetrieval('Apache Hadoop is a distributed framework.');
	assert.equal(out.length, 1);
	assert.equal(out[0]!.idx, 0);
	assert.equal(out[0]!.text, 'Apache Hadoop is a distributed framework.');
});

test('## heading boundaries split into separate chunks', () => {
	// Force splitting by exceeding the default max so the chunker
	// actually walks the heading-split path (small inputs hit the
	// "fits in one chunk" fast path even when they have headings).
	const filler = 'lorem ipsum '.repeat(150);
	const text = [
		'## HDFS Core',
		filler,
		'',
		'## YARN',
		filler,
		'',
		'## NameNode HA',
		filler,
	].join('\n');
	const out = chunkResponseForRetrieval(text);
	assert.equal(out.length, 3);
	assert.match(out[0]!.text, /^## HDFS Core/);
	assert.match(out[1]!.text, /^## YARN/);
	assert.match(out[2]!.text, /^## NameNode HA/);
	assert.deepEqual(out.map(c => c.idx), [0, 1, 2]);
});

test('### subheadings also start new chunks', () => {
	const filler = 'words '.repeat(300);
	const text = [
		'### Section A',
		filler,
		'',
		'### Section B',
		filler,
	].join('\n');
	const out = chunkResponseForRetrieval(text);
	assert.equal(out.length, 2);
	assert.match(out[0]!.text, /^### Section A/);
	assert.match(out[1]!.text, /^### Section B/);
});

test('# (top-level h1) does NOT count as a heading boundary -- only ## and deeper', () => {
	// Pin the input small enough that the only thing that COULD
	// produce >1 chunk is the heading-split pass. If h1 were a
	// boundary we'd get 2 chunks; with the chunker's `{2,4}` regex
	// it must remain a single chunk.
	const text = [
		'# Title',
		'A short intro paragraph.',
		'# Another title',
		'A short follow-up paragraph.',
	].join('\n');
	const out = chunkResponseForRetrieval(text);
	assert.equal(out.length, 1, 'h1 must not split; whole response stays in one chunk');
});

test('large heading section with paragraph breaks splits at blank lines', () => {
	const para = 'This is a single paragraph that contains a moderate amount of text. '.repeat(15);
	const text = [
		'## Big Section',
		para,
		'',
		para,
		'',
		para,
		'',
		para,
	].join('\n');
	const out = chunkResponseForRetrieval(text, { maxCharsPerChunk: 1500 });
	assert.ok(out.length >= 2, 'must split when paragraphs exceed maxCharsPerChunk');
	for (const c of out) {
		assert.ok(c.text.length <= 1500 + para.length,
			'no chunk should grow far beyond maxChars (paragraph-bounded)');
	}
});

test('single oversized paragraph (no blank lines) is emitted as one chunk -- no mid-split', () => {
	// Simulate an LLM response that's all one paragraph wider than
	// max. We do NOT mid-split paragraphs (see chunker rationale).
	const huge = 'a'.repeat(5000);
	const out = chunkResponseForRetrieval(huge, { maxCharsPerChunk: 1000 });
	assert.equal(out.length, 1);
	assert.equal(out[0]!.text.length, 5000);
});

test('tail coalescing: short trailing chunk folds into the previous', () => {
	const big   = 'X '.repeat(800);     // ~1600 chars, big enough to be its own chunk
	const small = 'Done.';              // 5 chars, well below default minChars=200
	const text  = [
		'## Section A',
		big,
		'',
		'## Tail',
		small,
	].join('\n');
	const out = chunkResponseForRetrieval(text);
	// Section A produces one (large) chunk; the "Tail" section is
	// way under minChars so it folds into the previous.
	assert.equal(out.length, 1, 'short tail must coalesce into the previous chunk');
	assert.match(out[0]!.text, /## Section A/);
	assert.match(out[0]!.text, /## Tail/);
	assert.match(out[0]!.text, /Done\./);
});

test('tail coalescing leaves the first chunk alone even if it is below min', () => {
	const tiny  = 'tiny';                       // < min
	const big   = 'X '.repeat(1000);            // forces a split
	const text  = ['## A', tiny, '', '## B', big].join('\n');
	const out = chunkResponseForRetrieval(text);
	// First chunk is tiny but cannot fold "left" -- must remain as
	// its own chunk so the second chunk's idx stays 1.
	assert.ok(out.length >= 1);
	assert.equal(out[0]!.idx, 0);
	if (out.length > 1) {
		assert.equal(out[1]!.idx, 1);
	}
});

test('idx is stable + sequential across inputs', () => {
	const filler = 'words '.repeat(300);
	const text = ['## A', filler, '', '## B', filler, '', '## C', filler].join('\n');
	const out1 = chunkResponseForRetrieval(text);
	const out2 = chunkResponseForRetrieval(text);
	assert.deepEqual(out1.map(c => c.idx), out2.map(c => c.idx));
	assert.deepEqual(out1.map(c => c.text), out2.map(c => c.text));
	assert.deepEqual(out1.map(c => c.idx), [0, 1, 2]);
});

test('custom maxCharsPerChunk affects packing', () => {
	const para = 'sentence. '.repeat(20);  // ~200 chars
	const text = ['## Sec', para, '', para, '', para, '', para].join('\n');
	const tight = chunkResponseForRetrieval(text, { maxCharsPerChunk: 250, minCharsPerChunk: 50 });
	const loose = chunkResponseForRetrieval(text, { maxCharsPerChunk: 1500, minCharsPerChunk: 50 });
	assert.ok(tight.length > loose.length, 'tighter cap must produce more chunks');
});
