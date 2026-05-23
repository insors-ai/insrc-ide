/**
 * Phase 10.A.1 tests for plans/code-analyzer-hallucination-mitigation.md.
 *
 * Cover the regex tripwire patterns:
 *   - Each pattern fires on prior-run boilerplate samples (regression
 *     fixtures).
 *   - Clean evidence-anchored prose does NOT trigger the detector
 *     (false-positive guard).
 *   - formatMetaNarrativeNotes shapes the hits into redraft notes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	detectMetaNarrative,
	formatMetaNarrativeNotes,
	META_NARRATIVE_PATTERNS,
} from '../meta-narrative-detector.js';

// ---------------------------------------------------------------------------
// Fixture: prior-run boilerplate that the tripwire MUST catch
// ---------------------------------------------------------------------------

const BOILERPLATE_SAMPLES: readonly string[] = [
	// Canonical pattern from the NameNode drill-down §6 & §9 + the
	// 12-section HDFS run.
	'The available evidence does not surface the request-routing subsystem. The gather phase opened the top-level module entries but did not reach the routing layer. This is a gap in the section, not a claim about the codebase.',
	// Variant: different subsystem name, same shape
	'The gather phase opened the relevant modules but did not reach the persistence layer. This is a gap in the section, not a claim about the codebase.',
	// Variant: "did not extend"
	'Evidence did not extend to the federation subsystem.',
	// "Survey" variant
	'The gather phase only surveyed the top-level entries.',
	// "Index miss" variant
	'No tests matching this pattern were found in the index.',
];

const CLEAN_SAMPLES: readonly string[] = [
	// Real evidence-anchored prose from the live run -- should NOT fire
	'The `BlockManager` class manages block replicas and tracks replication state ([`BlockManager.java:162-5558`](path:.../BlockManager.java#L162-L5558)).',
	'`FSNamesystem` integrates with `BlockManager` to enforce safe mode guards during startup.',
	// Mentions "evidence" as a noun but not in a meta-narration context
	'The evidence ledger contained 14 entries spanning the namenode package.',
	// Mentions "gather" but not as a meta-process verb
	'The DataNode gathers heartbeat responses every 3 seconds.',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('detectMetaNarrative: fires on every prior-run boilerplate sample', () => {
	for (const sample of BOILERPLATE_SAMPLES) {
		const result = detectMetaNarrative(sample);
		assert.equal(
			result.hit,
			true,
			`expected detector to fire on: "${sample.slice(0, 60)}..." -- got no hit`,
		);
		assert.ok(result.matches.length > 0);
		assert.ok(result.matches[0]!.excerpt.length > 0);
	}
});

test('detectMetaNarrative: does NOT fire on clean evidence-anchored prose', () => {
	for (const sample of CLEAN_SAMPLES) {
		const result = detectMetaNarrative(sample);
		assert.equal(
			result.hit,
			false,
			`false positive on: "${sample.slice(0, 80)}..." -- matched ${result.matches[0]?.pattern}`,
		);
	}
});

test('detectMetaNarrative: handles empty + non-string input', () => {
	assert.equal(detectMetaNarrative('').hit, false);
	assert.equal(detectMetaNarrative('   \n\n  ').hit, false);
});

test('detectMetaNarrative: caps matches at 3 to bound notes[] size', () => {
	// Concatenate many boilerplate paragraphs
	const big = BOILERPLATE_SAMPLES.join('\n\n') + '\n\n' + BOILERPLATE_SAMPLES.join('\n\n');
	const result = detectMetaNarrative(big);
	assert.equal(result.hit, true);
	assert.ok(result.matches.length <= 3, `expected ≤3 matches, got ${result.matches.length}`);
});

test('formatMetaNarrativeNotes: returns empty array when no hits', () => {
	const empty = formatMetaNarrativeNotes({ hit: false, matches: [] });
	assert.deepEqual(empty, []);
});

test('formatMetaNarrativeNotes: produces a header + bullet list', () => {
	const result = detectMetaNarrative(BOILERPLATE_SAMPLES[0]!);
	const notes = formatMetaNarrativeNotes(result);
	assert.ok(notes.length >= 2);
	assert.match(notes[0]!, /Meta-narrative paragraphs detected/);
	for (const n of notes.slice(1)) {
		assert.match(n, /^\s+- "/);
	}
});

test('META_NARRATIVE_PATTERNS: at least 5 patterns present (regression guard)', () => {
	assert.ok(
		META_NARRATIVE_PATTERNS.length >= 5,
		'pattern list should not be trimmed below 5 without explicit review',
	);
});
