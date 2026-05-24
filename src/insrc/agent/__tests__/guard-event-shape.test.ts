/**
 * Pin the log-event shapes the guard emits so the
 * `scripts/audit-guard-events.ts` aggregator stays in sync.
 *
 * This is a *log-shape* test — it doesn't validate end-to-end
 * behaviour (covered by `tool-call-guard.test.ts`), it validates
 * that the structured fields the aggregator depends on are
 * present and stably named.
 *
 * If you change the guard's log structure, update the aggregator
 * AND regenerate the fixture below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	summarizeGuardEvents,
	renderSummary,
} from '../../../../scripts/audit-guard-events.js';

// ---------------------------------------------------------------------------
// Stable fixture — mirrors the JSON lines the daemon log emits
// ---------------------------------------------------------------------------

const FIXTURE_LINES: readonly string[] = [
	// 1. coerce: separator + arg-rename + type-array
	JSON.stringify({
		level: 30,
		time: 1779000000000,
		module: 'tool-call-guard',
		originalName: 'code_entity_locate-by-name',
		resolvedName: 'code.entity.locate-by-name',
		notes: [
			"coerced tool name 'code_entity_locate-by-name' -> 'code.entity.locate-by-name' (separator normalization)",
			"renamed arg 'kind' -> 'kinds'",
			"coerced arg 'kinds' from scalar to single-element array",
		],
		msg: 'tool-call-guard: coerced before dispatch',
	}),
	// 2. coerce: fuzzy
	JSON.stringify({
		level: 30,
		time: 1779000000010,
		module: 'tool-call-guard',
		originalName: 'code.entity.sumary',
		resolvedName: 'code.entity.summary',
		notes: ["coerced tool name 'code.entity.sumary' -> 'code.entity.summary' (fuzzy match, distance=1)"],
		msg: 'tool-call-guard: coerced before dispatch',
	}),
	// 3. reject: missing required
	JSON.stringify({
		level: 30,
		time: 1779000000020,
		module: 'tool-call-guard',
		toolCallId: 'tc1',
		resolvedName: 'code.entity.summary',
		missing: ['entityId'],
		unexpected: [],
		typeMismatch: [],
		msg: 'tool-call-guard: pre-dispatch schema check rejected the call',
	}),
	// 4. reject: missing + unexpected (composite)
	JSON.stringify({
		level: 30,
		time: 1779000000030,
		module: 'tool-call-guard',
		toolCallId: 'tc2',
		resolvedName: 'code.source.file.describe',
		missing: ['file', 'repoPath'],
		unexpected: ['path'],
		typeMismatch: [],
		msg: 'tool-call-guard: pre-dispatch schema check rejected the call',
	}),
	// 5. unrelated log line — must not contribute to counts
	JSON.stringify({ level: 30, module: 'orchestrator', msg: 'something else' }),
	// 6. malformed line — must be skipped silently
	'this is not JSON',
];

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test('summarizeGuardEvents: totals reflect only guard-shaped events', () => {
	const s = summarizeGuardEvents(FIXTURE_LINES);
	assert.equal(s.totalEvents, 4);
	assert.equal(s.coerced,    2);
	assert.equal(s.rejected,   2);
	assert.equal(s.estimatedRoundTripsSaved, 4);
});

test('summarizeGuardEvents: coerce categories tally from `notes` field', () => {
	const s = summarizeGuardEvents(FIXTURE_LINES);
	assert.equal(s.coerceCategories['name-separator'], 1);
	assert.equal(s.coerceCategories['name-fuzzy'],     1);
	assert.equal(s.coerceCategories['arg-rename'],     1);
	assert.equal(s.coerceCategories['type-array'],     1);
});

test('summarizeGuardEvents: reject categories tally from missing/unexpected/typeMismatch arrays', () => {
	const s = summarizeGuardEvents(FIXTURE_LINES);
	assert.equal(s.rejectCategories['missing-required'],     2);  // both rejects had missing[]
	assert.equal(s.rejectCategories['unexpected-property'],  1);  // only the composite
	assert.equal(s.rejectCategories['type-mismatch'] ?? 0,   0);
});

test('summarizeGuardEvents: skills-touched aggregates resolvedName across events', () => {
	const s = summarizeGuardEvents(FIXTURE_LINES);
	assert.equal(s.skillsTouched['code.entity.summary'],         2);
	assert.equal(s.skillsTouched['code.entity.locate-by-name'],  1);
	assert.equal(s.skillsTouched['code.source.file.describe'],   1);
});

test('summarizeGuardEvents: malformed + unrelated lines silently ignored', () => {
	const s = summarizeGuardEvents([
		'not json',
		'',
		JSON.stringify({ msg: 'unrelated' }),
	]);
	assert.equal(s.totalEvents, 0);
});

test('summarizeGuardEvents: empty input → zero summary', () => {
	const s = summarizeGuardEvents([]);
	assert.equal(s.totalEvents, 0);
	assert.equal(s.estimatedRoundTripsSaved, 0);
	assert.deepEqual(s.coerceCategories, {});
	assert.deepEqual(s.rejectCategories, {});
});

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

test('renderSummary: includes total, coerce/reject splits, top-skills table', () => {
	const s = summarizeGuardEvents(FIXTURE_LINES);
	const md = renderSummary(s);
	assert.match(md, /Total events: \*\*4\*\*/);
	assert.match(md, /Coerced .*: 2/);
	assert.match(md, /Rejected .*: 2/);
	assert.match(md, /## Coercion categories/);
	assert.match(md, /## Rejection categories/);
	assert.match(md, /## Top skills by guard activity/);
	assert.match(md, /code\.entity\.summary \| 2/);
});

test('renderSummary: empty summary omits per-category sections', () => {
	const md = renderSummary(summarizeGuardEvents([]));
	assert.match(md, /Total events: \*\*0\*\*/);
	assert.doesNotMatch(md, /## Coercion categories/);
	assert.doesNotMatch(md, /## Rejection categories/);
});
