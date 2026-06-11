/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the TOC composer -- pins the newest-first render order
 * + oldest-first truncation contract. Prior to this test, the
 * composer's loop reversed the (already-newest-first) input and
 * dropped NEWEST entries when the budget hit -- the opposite of the
 * contract documented in the file header.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderToc, type Toc, type TocEntry } from '../toc.js';

function entry(id: string, summary: string): TocEntry {
	return { id, summary };
}

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

test('renderToc: empty entries -> placeholder header', () => {
	const out = renderToc({ entries: [] });
	assert.match(out, /TABLE OF CONTENTS/);
	assert.match(out, /no artifacts persisted yet/);
});

// ---------------------------------------------------------------------------
// Render order (THE bug fix this file pins)
// ---------------------------------------------------------------------------

test('renderToc: newest-first input rendered newest-first', () => {
	// `buildToc` returns entries newest-first; the composer preserves
	// that order so the model sees the most-recent artifact at the
	// top of the block.
	const toc: Toc = { entries: [
		entry('s:300:newest', 'C'),
		entry('s:200:middle', 'B'),
		entry('s:100:oldest', 'A'),
	]};
	const out = renderToc(toc);
	const newestIdx = out.indexOf('s:300:newest');
	const middleIdx = out.indexOf('s:200:middle');
	const oldestIdx = out.indexOf('s:100:oldest');
	assert.ok(newestIdx > 0, 'newest entry should be rendered');
	assert.ok(middleIdx > newestIdx, `middle (${middleIdx}) should follow newest (${newestIdx})`);
	assert.ok(oldestIdx > middleIdx, `oldest (${oldestIdx}) should follow middle (${middleIdx})`);
});

// ---------------------------------------------------------------------------
// Truncation contract (oldest-first)
// ---------------------------------------------------------------------------

test('renderToc: budget exhaustion drops OLDEST entries, keeps newest', () => {
	const entries: TocEntry[] = [];
	for (let i = 10; i >= 1; i--) {
		entries.push(entry(`art:${String(i).padStart(3, '0')}`, 'x'.repeat(100)));
	}
	// Each line is ~110 chars. Cap at ~250 chars to keep only the first
	// 1-2 entries (after the 2-line header).
	const out = renderToc({ entries }, { maxChars: 250 });
	// Newest (`art:010`) MUST appear.
	assert.match(out, /art:010/);
	// Oldest (`art:001`) MUST NOT.
	assert.ok(!out.includes('art:001'), `oldest entry leaked through truncation in:\n${out}`);
	// Truncation footer should report the correct count.
	const m = /\((\d+) older artifacts omitted/.exec(out);
	assert.ok(m, 'truncation footer missing');
	const truncated = parseInt(m![1]!, 10);
	assert.ok(truncated >= 8, `expected at least 8 truncated entries; got ${truncated} -- output:\n${out}`);
});

test('renderToc: no truncation when total fits under budget', () => {
	const toc: Toc = { entries: [
		entry('a:1', 'short'),
		entry('a:2', 'short'),
	]};
	const out = renderToc(toc, { maxChars: 10_000 });
	assert.match(out, /a:1/);
	assert.match(out, /a:2/);
	assert.ok(!out.includes('older artifacts omitted'), 'unexpected truncation footer');
});

test('renderToc: truncation footer correctly counts dropped entries', () => {
	const entries: TocEntry[] = [];
	for (let i = 5; i >= 1; i--) {
		entries.push(entry(`a:${i}`, 'x'.repeat(50)));
	}
	// Cap fits ~2 entries.
	const out = renderToc({ entries }, { maxChars: 200 });
	const m = /\((\d+) older artifacts omitted/.exec(out);
	assert.ok(m, 'truncation footer missing');
	const truncated = parseInt(m![1]!, 10);
	// 5 total minus however many fit. Footer must be 5 - rendered.
	const renderedMatches = out.match(/a:[1-5]/g) ?? [];
	assert.equal(truncated, 5 - renderedMatches.length);
});
