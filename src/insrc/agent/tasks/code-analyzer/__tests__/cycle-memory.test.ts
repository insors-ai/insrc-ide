/**
 * Phase α tests for plans/code-analyzer-discovery-plan-loop.md.
 *
 * Covers the two pure helpers:
 *   - summarizeCycleMemory(mem) -> prompt block string
 *   - computeCoverage(ledger, criteria, stepsById) -> coverage array
 *
 * Plus the `emptyCycleMemory(criteria)` constructor in
 * `discovery-plan.ts`. No LLM calls, no provider mocks; this is type-
 * level + helper coverage so future structural drift surfaces fast.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	emptyCycleMemory,
	type CycleMemory,
	type DiscoveryStep,
	type StepOutput,
} from '../../../content-gen/discovery-plan.js';
import {
	summarizeCycleMemory,
	computeCoverage,
} from '../cycle-memory.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function step(id: string, intent: string, targetsCriteria: readonly number[]): DiscoveryStep {
	return {
		id,
		intent,
		skills: [{ id: `${id}.a`, skillId: 'code.entity.locate-by-name', context: 'X' }],
		targetsCriteria,
	};
}

function output(stepId: string, status: 'ok' | 'partial' | 'failed' = 'ok'): StepOutput {
	return {
		stepId,
		status,
		facts:      ['a fact'],
		citations:  [{ path: '/repo/foo.ts', startLine: 1, endLine: 20 }],
		durationMs: 100,
	};
}

// ---------------------------------------------------------------------------
// emptyCycleMemory
// ---------------------------------------------------------------------------

test('emptyCycleMemory: priorAsks empty, scratchpad empty, all criteria open', () => {
	const mem = emptyCycleMemory(['Names X', 'Explains Y', 'Covers Z']);
	assert.equal(mem.priorAsks.length, 0);
	assert.equal(mem.scratchpad, '');
	assert.equal(mem.criteriaCoverage.length, 3);
	for (const cov of mem.criteriaCoverage) {
		assert.equal(cov.status, 'open');
		assert.equal(cov.contributingStepIds.length, 0);
	}
});

test('emptyCycleMemory: empty criteria list -> empty coverage', () => {
	const mem = emptyCycleMemory([]);
	assert.equal(mem.criteriaCoverage.length, 0);
});

// ---------------------------------------------------------------------------
// summarizeCycleMemory
// ---------------------------------------------------------------------------

test('summarizeCycleMemory: empty memory -> empty string (cycle-1 fresh)', () => {
	const mem = emptyCycleMemory(['Names X']);
	assert.equal(summarizeCycleMemory(mem), '');
});

test('summarizeCycleMemory: renders priorAsks block when non-empty', () => {
	const mem: CycleMemory = {
		priorAsks: [
			{ cycle: 1, steps: [{ id: 'step-1', intent: 'investigate NameNode' }] },
		],
		criteriaCoverage: [{ criterion: 'X', status: 'open', contributingStepIds: [] }],
		scratchpad: '',
	};
	const out = summarizeCycleMemory(mem);
	assert.match(out, /Prior cycles/);
	assert.match(out, /cycle 1 -- 1 step:/);
	assert.match(out, /step-1: investigate NameNode/);
});

test('summarizeCycleMemory: pluralises "step" / "steps" correctly', () => {
	const mem: CycleMemory = {
		priorAsks: [
			{ cycle: 1, steps: [{ id: 's1', intent: 'a' }] },
			{ cycle: 2, steps: [{ id: 's2', intent: 'b' }, { id: 's3', intent: 'c' }] },
		],
		criteriaCoverage: [],
		scratchpad: '',
	};
	const out = summarizeCycleMemory(mem);
	assert.match(out, /cycle 1 -- 1 step:/);
	assert.match(out, /cycle 2 -- 2 steps:/);
});

test('summarizeCycleMemory: renders criteria coverage with status tags', () => {
	const mem: CycleMemory = {
		priorAsks: [{ cycle: 1, steps: [{ id: 's1', intent: 'x' }] }],
		criteriaCoverage: [
			{ criterion: 'Names X',     status: 'covered', contributingStepIds: ['step-1', 'step-4'] },
			{ criterion: 'Explains Y',  status: 'partial', contributingStepIds: ['step-2'] },
			{ criterion: 'Covers Z',    status: 'open',    contributingStepIds: [] },
		],
		scratchpad: '',
	};
	const out = summarizeCycleMemory(mem);
	assert.match(out, /\[covered\]\s+"Names X" -- step-1, step-4/);
	assert.match(out, /\[partial\]\s+"Explains Y" -- step-2/);
	assert.match(out, /\[open\]\s+"Covers Z"$/m);
});

test('summarizeCycleMemory: renders scratchpad when non-empty', () => {
	const mem: CycleMemory = {
		priorAsks: [{ cycle: 1, steps: [{ id: 's1', intent: 'x' }] }],
		criteriaCoverage: [],
		scratchpad: 'EditLog has unusual format',
	};
	const out = summarizeCycleMemory(mem);
	assert.match(out, /## Scratchpad/);
	assert.match(out, /EditLog has unusual format/);
});

test('summarizeCycleMemory: scratchpad-only memory still renders', () => {
	// Even if priorAsks is empty + all criteria open, a non-empty
	// scratchpad means someone WROTE state; render it.
	const mem: CycleMemory = {
		priorAsks: [],
		criteriaCoverage: [{ criterion: 'X', status: 'open', contributingStepIds: [] }],
		scratchpad: 'a non-empty note',
	};
	const out = summarizeCycleMemory(mem);
	assert.ok(out.length > 0);
	assert.match(out, /a non-empty note/);
});

test('summarizeCycleMemory: trims trailing whitespace', () => {
	const mem: CycleMemory = {
		priorAsks: [{ cycle: 1, steps: [{ id: 's1', intent: 'x' }] }],
		criteriaCoverage: [],
		scratchpad: '',
	};
	const out = summarizeCycleMemory(mem);
	assert.equal(out.endsWith('\n'), false);
});

// ---------------------------------------------------------------------------
// computeCoverage
// ---------------------------------------------------------------------------

test('computeCoverage: no contributing outputs -> open', () => {
	const criteria = ['Names X', 'Explains Y'];
	const stepsById = new Map<string, DiscoveryStep>();
	const cov = computeCoverage([], criteria, stepsById);
	assert.equal(cov.length, 2);
	for (const c of cov) {
		assert.equal(c.status, 'open');
		assert.equal(c.contributingStepIds.length, 0);
	}
});

test('computeCoverage: single ok output covers its targeted criterion', () => {
	const criteria = ['Names X', 'Explains Y'];
	const s1 = step('step-1', 'investigate X', [0]);   // targets criterion 0
	const stepsById = new Map([[s1.id, s1]]);
	const cov = computeCoverage([output('step-1')], criteria, stepsById);
	assert.equal(cov[0]!.status, 'covered');
	assert.deepEqual(cov[0]!.contributingStepIds, ['step-1']);
	assert.equal(cov[1]!.status, 'open');
});

test('computeCoverage: failed contributing output -> still open', () => {
	const criteria = ['Names X'];
	const s1 = step('step-1', 'investigate X', [0]);
	const stepsById = new Map([[s1.id, s1]]);
	const cov = computeCoverage([output('step-1', 'failed')], criteria, stepsById);
	assert.equal(cov[0]!.status, 'open');
	// Even though the step contributed (it ran), failed status keeps
	// the criterion open -- the cloud should re-ask in the next cycle.
	assert.deepEqual(cov[0]!.contributingStepIds, ['step-1']);
});

test('computeCoverage: only partial outputs -> partial', () => {
	const criteria = ['Names X'];
	const s1 = step('step-1', 'investigate X', [0]);
	const s2 = step('step-2', 'investigate X again', [0]);
	const stepsById = new Map([[s1.id, s1], [s2.id, s2]]);
	const cov = computeCoverage([
		output('step-1', 'partial'),
		output('step-2', 'partial'),
	], criteria, stepsById);
	assert.equal(cov[0]!.status, 'partial');
	assert.deepEqual([...cov[0]!.contributingStepIds].sort(), ['step-1', 'step-2']);
});

test('computeCoverage: any ok promotes partial criterion to covered', () => {
	const criteria = ['Names X'];
	const s1 = step('step-1', 'first try', [0]);
	const s2 = step('step-2', 'second try', [0]);
	const stepsById = new Map([[s1.id, s1], [s2.id, s2]]);
	const cov = computeCoverage([
		output('step-1', 'partial'),
		output('step-2', 'ok'),
	], criteria, stepsById);
	assert.equal(cov[0]!.status, 'covered');
});

test('computeCoverage: one step targets multiple criteria', () => {
	const criteria = ['Names X', 'Explains Y', 'Covers Z'];
	const s1 = step('step-1', 'investigate X and Y', [0, 1]);
	const stepsById = new Map([[s1.id, s1]]);
	const cov = computeCoverage([output('step-1')], criteria, stepsById);
	assert.equal(cov[0]!.status, 'covered');
	assert.equal(cov[1]!.status, 'covered');
	assert.equal(cov[2]!.status, 'open');
});

test('computeCoverage: orphan step output (step not in stepsById) is ignored', () => {
	// Defensive: if a ledger entry references a step we don't have a
	// definition for (e.g. drift between orchestrator state + memory),
	// don't crash, just skip it.
	const criteria = ['Names X'];
	const stepsById = new Map<string, DiscoveryStep>();
	const cov = computeCoverage([output('step-ghost')], criteria, stepsById);
	assert.equal(cov[0]!.status, 'open');
});
