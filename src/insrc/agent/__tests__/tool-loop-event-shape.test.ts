/**
 * Pin the substrate's terminal-event log shapes so the
 * `scripts/audit-tool-loop.ts` aggregator stays in sync.
 *
 * The substrate emits one terminal log line per run via getLogger
 * at info/warn levels. The aggregator depends on:
 *   - `msg` field (the canonical event name)
 *   - `label` field (the consumer's name)
 *   - `turnCount` field (numeric)
 *
 * If the substrate's log shape changes, update the aggregator AND
 * regenerate the fixture below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	summarizeToolLoopEvents,
	renderSummary,
} from '../../../../scripts/audit-tool-loop.js';

// ---------------------------------------------------------------------------
// Stable fixture -- mirrors what the daemon log emits.
// ---------------------------------------------------------------------------

const FIXTURE_LINES: readonly string[] = [
	// 1. Two callPerTask runs that dispatched successfully
	JSON.stringify({
		level: 30, time: 1, module: 'tool-loop',
		label: 'execute-step:per-task', turnCount: 1, toolName: 'skill_invoke',
		msg: 'tool-loop: complete (dispatched -- stopOnFirstDispatch)',
	}),
	JSON.stringify({
		level: 30, time: 2, module: 'tool-loop',
		label: 'execute-step:per-task', turnCount: 2, toolName: 'skill_invoke',
		msg: 'tool-loop: complete (dispatched -- stopOnFirstDispatch)',
	}),
	// 2. One callPerTask run that exhausted on turn cap
	JSON.stringify({
		level: 30, time: 3, module: 'tool-loop',
		label: 'execute-step:per-task', turnCount: 2, lastError: 'tool-isError: ...',
		msg: 'tool-loop: complete (exhausted -- turn cap)',
	}),
	// 3. One planner-discovery run that terminated (submit_plan)
	JSON.stringify({
		level: 30, time: 4, module: 'tool-loop',
		label: 'planner-discovery', turnCount: 3, terminationTool: 'submit_plan',
		msg: 'tool-loop: complete (terminated)',
	}),
	// 4. One planner-discovery run that hit degenerate-repeat
	JSON.stringify({
		level: 40, time: 5, module: 'tool-loop',
		label: 'planner-discovery', turnCount: 2, name: 'planner_list_subdir',
		msg: 'tool-loop: degenerate-repeat -- exhausting',
	}),
	// 5. One planner-discovery run with a provider error
	JSON.stringify({
		level: 40, time: 6, module: 'tool-loop',
		label: 'planner-discovery', turnCount: 1, err: 'connection reset',
		msg: 'tool-loop: provider error -- bubbling up',
	}),
	// 6. One unlabeled run (no `label` field) -> goes to <unlabeled>
	JSON.stringify({
		level: 30, time: 7, module: 'tool-loop',
		turnCount: 1, finalText: 'just text',
		msg: 'tool-loop: complete (no-tools)',
	}),
	// 7. Unrelated log line -- must not contribute
	JSON.stringify({ level: 30, module: 'orchestrator', msg: 'something else' }),
	// 8. Malformed -- must be skipped silently
	'this is not JSON',
];

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test('summarizeToolLoopEvents: totals match the fixture', () => {
	const s = summarizeToolLoopEvents(FIXTURE_LINES);
	assert.equal(s.totalRuns, 7);   // 6 labeled + 1 unlabeled
});

test('summarizeToolLoopEvents: groups runs by consumer label', () => {
	const s = summarizeToolLoopEvents(FIXTURE_LINES);
	assert.ok(s.perConsumer['execute-step:per-task']);
	assert.ok(s.perConsumer['planner-discovery']);
	assert.ok(s.perConsumer['<unlabeled>']);
});

test('summarizeToolLoopEvents: callPerTask consumer aggregates correctly', () => {
	const s = summarizeToolLoopEvents(FIXTURE_LINES);
	const c = s.perConsumer['execute-step:per-task']!;
	assert.equal(c.dispatched, 2);
	assert.equal(c.exhausted,  1);
	assert.equal(c.terminated, 0);
	assert.equal(c.exhaustionReasons['turn-cap'], 1);
});

test('summarizeToolLoopEvents: planner consumer aggregates degenerate + provider-error', () => {
	const s = summarizeToolLoopEvents(FIXTURE_LINES);
	const c = s.perConsumer['planner-discovery']!;
	assert.equal(c.terminated,    1);
	assert.equal(c.exhausted,     1);
	assert.equal(c.providerError, 1);
	assert.equal(c.exhaustionReasons['degenerate-repeat'], 1);
});

test('summarizeToolLoopEvents: average turn count computed per consumer', () => {
	const s = summarizeToolLoopEvents(FIXTURE_LINES);
	const c = s.perConsumer['execute-step:per-task']!;
	// (1 + 2 + 2) / 3 = 1.666...
	assert.ok(c.turnCountSum / c.turnCountSamples > 1.6);
	assert.ok(c.turnCountSum / c.turnCountSamples < 1.7);
});

test('summarizeToolLoopEvents: malformed + unrelated lines silently ignored', () => {
	const s = summarizeToolLoopEvents([
		'not json',
		'',
		JSON.stringify({ msg: 'orchestrator: doing things' }),
	]);
	assert.equal(s.totalRuns, 0);
});

test('summarizeToolLoopEvents: empty input -> zero summary', () => {
	const s = summarizeToolLoopEvents([]);
	assert.equal(s.totalRuns, 0);
	assert.deepEqual(s.perConsumer, {});
});

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

test('renderSummary: emits per-consumer table + exhaustion-reasons table', () => {
	const s = summarizeToolLoopEvents(FIXTURE_LINES);
	const md = renderSummary(s);
	assert.match(md, /Total runs across all consumers: \*\*7\*\*/);
	assert.match(md, /## Per-consumer outcomes/);
	assert.match(md, /## Exhaustion reasons/);
	assert.match(md, /execute-step:per-task \| 3 \| 0 \| 2 \| 0 \| 1 \| 0/);   // table row
	assert.match(md, /planner-discovery \| /);
});

test('renderSummary: empty summary -> no-events placeholder', () => {
	const md = renderSummary(summarizeToolLoopEvents([]));
	assert.match(md, /no tool-loop events found/);
	assert.doesNotMatch(md, /## Per-consumer outcomes/);
});

test('renderSummary: no exhausted runs -> exhaustion-reasons section omitted', () => {
	const s = summarizeToolLoopEvents([
		JSON.stringify({
			module: 'tool-loop', label: 'foo', turnCount: 1,
			msg: 'tool-loop: complete (dispatched -- stopOnFirstDispatch)',
		}),
	]);
	const md = renderSummary(s);
	assert.doesNotMatch(md, /## Exhaustion reasons/);
});
