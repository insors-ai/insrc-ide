/**
 * Phase 2.5 tests for the LMDB-backed `agent/tasks/plan-store.ts`.
 *
 * Verifies the public surface preserves the prior DuckDB-backed
 * behaviour:
 *   - savePlan + getPlan round-trip including dependsOn relationships
 *   - getActivePlan picks the latest active plan for a repo
 *   - updateStepState validates state-machine transitions
 *   - updateStepState side-effects: maybeCompletePlan + reactivatePlan
 *   - getNextStep returns the first unblocked pending step
 *   - deletePlan + deletePlansForRepo cascade
 *   - resetStaleLocks clears in_progress on crash recovery
 *   - isValidTransition pure-function correctness
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeGraphStore, setGraphStorePath } from '../../../db/graph/store.js';
import {
	savePlan,
	getPlan,
	getActivePlan,
	updateStepState,
	getNextStep,
	deletePlan,
	deletePlansForRepo,
	resetStaleLocks,
	isValidTransition,
} from '../plan-store.js';
import type { Plan, PlanStep } from '../../../shared/types.js';

let dir: string;

test.beforeEach(async () => {
	await closeGraphStore();
	dir = mkdtempSync(join(tmpdir(), 'insrc-plan-store-lmdb-2.5-'));
	setGraphStorePath(join(dir, 'graph.lmdb'));
});
test.afterEach(async () => {
	await closeGraphStore();
	rmSync(dir, { recursive: true, force: true });
});

const NOW = '2026-05-05T10:00:00.000Z';

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
	return {
		id:          overrides.id          ?? 'step-1',
		planId:      overrides.planId      ?? 'plan-1',
		idx:         overrides.idx         ?? 0,
		title:       overrides.title       ?? 'Step',
		description: overrides.description ?? 'do thing',
		checkpoint:  overrides.checkpoint  ?? false,
		status:      overrides.status      ?? 'pending',
		complexity:  overrides.complexity  ?? 'low',
		fileHint:    overrides.fileHint    ?? '',
		notes:       overrides.notes       ?? '',
		dependsOn:   overrides.dependsOn   ?? [],
		createdAt:   overrides.createdAt   ?? NOW,
		updatedAt:   overrides.updatedAt   ?? NOW,
		...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
		...(overrides.doneAt !== undefined ? { doneAt: overrides.doneAt } : {}),
	};
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
	return {
		id:        overrides.id        ?? 'plan-1',
		repoPath:  overrides.repoPath  ?? '/repo/foo',
		title:     overrides.title     ?? 'Test plan',
		status:    overrides.status    ?? 'active',
		steps:     overrides.steps     ?? [makeStep()],
		createdAt: overrides.createdAt ?? NOW,
		updatedAt: overrides.updatedAt ?? NOW,
	};
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('isValidTransition: pending → in_progress, skipped', () => {
	assert.equal(isValidTransition('pending', 'in_progress'), true);
	assert.equal(isValidTransition('pending', 'skipped'), true);
	assert.equal(isValidTransition('pending', 'done'), false);
});

test('isValidTransition: in_progress → done, failed, skipped, pending', () => {
	assert.equal(isValidTransition('in_progress', 'done'), true);
	assert.equal(isValidTransition('in_progress', 'failed'), true);
	assert.equal(isValidTransition('in_progress', 'skipped'), true);
	assert.equal(isValidTransition('in_progress', 'pending'), true);
});

test('isValidTransition: done → pending only (revert)', () => {
	assert.equal(isValidTransition('done', 'pending'), true);
	assert.equal(isValidTransition('done', 'in_progress'), false);
});

// ---------------------------------------------------------------------------
// savePlan + getPlan
// ---------------------------------------------------------------------------

test('savePlan + getPlan round-trip', async () => {
	await savePlan(null, makePlan());
	const back = await getPlan(null, 'plan-1');
	assert.ok(back);
	assert.equal(back.id, 'plan-1');
	assert.equal(back.title, 'Test plan');
	assert.equal(back.status, 'active');
	assert.equal(back.steps.length, 1);
	assert.equal(back.steps[0]!.id, 'step-1');
});

test('getPlan on unknown id returns null', async () => {
	assert.equal(await getPlan(null, 'nonexistent'), null);
});

test('savePlan preserves multiple steps in idx order', async () => {
	const steps = [
		makeStep({ id: 's2', idx: 2, title: 'second' }),
		makeStep({ id: 's0', idx: 0, title: 'zeroth' }),
		makeStep({ id: 's1', idx: 1, title: 'first' }),
	];
	await savePlan(null, makePlan({ steps }));
	const back = await getPlan(null, 'plan-1');
	assert.deepEqual(back!.steps.map(s => s.idx), [0, 1, 2]);
	assert.deepEqual(back!.steps.map(s => s.title), ['zeroth', 'first', 'second']);
});

test('savePlan preserves dependsOn arrays', async () => {
	const steps = [
		makeStep({ id: 's0', idx: 0 }),
		makeStep({ id: 's1', idx: 1, dependsOn: ['s0'] }),
		makeStep({ id: 's2', idx: 2, dependsOn: ['s0', 's1'] }),
	];
	await savePlan(null, makePlan({ steps }));
	const back = await getPlan(null, 'plan-1');
	assert.deepEqual(back!.steps[0]!.dependsOn, []);
	assert.deepEqual(back!.steps[1]!.dependsOn, ['s0']);
	assert.deepEqual(back!.steps[2]!.dependsOn, ['s0', 's1']);
});

test('savePlan upsert preserves identity (re-save same plan id)', async () => {
	await savePlan(null, makePlan());
	await savePlan(null, makePlan({ title: 'updated' }));
	const back = await getPlan(null, 'plan-1');
	assert.equal(back!.title, 'updated');
});

// ---------------------------------------------------------------------------
// getActivePlan
// ---------------------------------------------------------------------------

test('getActivePlan returns the latest active plan for a repo', async () => {
	await savePlan(null, makePlan({
		id: 'plan-old', createdAt: '2026-01-01T00:00:00.000Z', status: 'active',
	}));
	await savePlan(null, makePlan({
		id: 'plan-new', createdAt: '2026-05-01T00:00:00.000Z', status: 'active',
	}));
	const active = await getActivePlan(null, '/repo/foo');
	assert.ok(active);
	assert.equal(active.id, 'plan-new');
});

test('getActivePlan ignores completed/abandoned plans', async () => {
	await savePlan(null, makePlan({ id: 'p1', status: 'completed' }));
	await savePlan(null, makePlan({ id: 'p2', status: 'abandoned' }));
	const active = await getActivePlan(null, '/repo/foo');
	assert.equal(active, null);
});

test('getActivePlan filters by repo', async () => {
	await savePlan(null, makePlan({ id: 'pa', repoPath: '/repo/a', status: 'active' }));
	await savePlan(null, makePlan({ id: 'pb', repoPath: '/repo/b', status: 'active' }));
	const a = await getActivePlan(null, '/repo/a');
	const b = await getActivePlan(null, '/repo/b');
	assert.equal(a!.id, 'pa');
	assert.equal(b!.id, 'pb');
});

// ---------------------------------------------------------------------------
// updateStepState
// ---------------------------------------------------------------------------

test('updateStepState validates the transition', async () => {
	await savePlan(null, makePlan({
		steps: [makeStep({ id: 's0', status: 'pending' })],
	}));
	const ok = await updateStepState(null, 's0', 'in_progress');
	assert.equal(ok.ok, true);
	const bad = await updateStepState(null, 's0', 'pending'); // in_progress -> pending IS valid (crash recovery)
	assert.equal(bad.ok, true);
	const bad2 = await updateStepState(null, 's0', 'done'); // pending -> done is invalid
	assert.equal(bad2.ok, false);
	assert.match(bad2.error!, /invalid transition/);
});

test('updateStepState in_progress sets startedAt', async () => {
	await savePlan(null, makePlan());
	await updateStepState(null, 'step-1', 'in_progress');
	const back = await getPlan(null, 'plan-1');
	assert.ok(back!.steps[0]!.startedAt);
});

test('updateStepState done sets doneAt', async () => {
	await savePlan(null, makePlan());
	await updateStepState(null, 'step-1', 'in_progress');
	await updateStepState(null, 'step-1', 'done');
	const back = await getPlan(null, 'plan-1');
	assert.ok(back!.steps[0]!.doneAt);
});

test('updateStepState pending clears startedAt + doneAt', async () => {
	await savePlan(null, makePlan());
	await updateStepState(null, 'step-1', 'in_progress');
	await updateStepState(null, 'step-1', 'done');
	await updateStepState(null, 'step-1', 'pending');
	const back = await getPlan(null, 'plan-1');
	assert.equal(back!.steps[0]!.startedAt, undefined);
	assert.equal(back!.steps[0]!.doneAt, undefined);
});

test('updateStepState appends note to notes', async () => {
	await savePlan(null, makePlan());
	await updateStepState(null, 'step-1', 'in_progress', 'starting');
	const back = await getPlan(null, 'plan-1');
	assert.match(back!.steps[0]!.notes, /starting/);
});

test('updateStepState on unknown step returns error', async () => {
	const r = await updateStepState(null, 'no-such-step', 'in_progress');
	assert.equal(r.ok, false);
	assert.match(r.error!, /step not found/);
});

test('updateStepState completes plan when all steps terminal', async () => {
	await savePlan(null, makePlan({
		steps: [
			makeStep({ id: 's0', idx: 0 }),
			makeStep({ id: 's1', idx: 1 }),
		],
	}));
	await updateStepState(null, 's0', 'in_progress');
	await updateStepState(null, 's0', 'done');
	let plan = await getPlan(null, 'plan-1');
	assert.equal(plan!.status, 'active'); // not all terminal yet
	await updateStepState(null, 's1', 'skipped');
	plan = await getPlan(null, 'plan-1');
	assert.equal(plan!.status, 'completed');
});

test('updateStepState reactivates completed plan when step reverts to pending', async () => {
	await savePlan(null, makePlan({
		steps: [makeStep({ id: 's0', idx: 0 })],
	}));
	await updateStepState(null, 's0', 'in_progress');
	await updateStepState(null, 's0', 'done');
	let plan = await getPlan(null, 'plan-1');
	assert.equal(plan!.status, 'completed');
	await updateStepState(null, 's0', 'pending'); // revert
	plan = await getPlan(null, 'plan-1');
	assert.equal(plan!.status, 'active');
});

// ---------------------------------------------------------------------------
// getNextStep
// ---------------------------------------------------------------------------

test('getNextStep returns first pending step with no blocking deps', async () => {
	await savePlan(null, makePlan({
		steps: [
			makeStep({ id: 's0', idx: 0 }),
			makeStep({ id: 's1', idx: 1, dependsOn: ['s0'] }),
		],
	}));
	const first = await getNextStep(null, 'plan-1');
	assert.equal(first!.id, 's0'); // s1 is blocked by s0
});

test('getNextStep returns null when nothing is pending', async () => {
	await savePlan(null, makePlan({
		steps: [makeStep({ id: 's0', status: 'done' })],
	}));
	assert.equal(await getNextStep(null, 'plan-1'), null);
});

test('getNextStep returns null when all pending steps are blocked', async () => {
	await savePlan(null, makePlan({
		steps: [
			makeStep({ id: 's0', status: 'in_progress' }),
			makeStep({ id: 's1', idx: 1, dependsOn: ['s0'] }),
		],
	}));
	assert.equal(await getNextStep(null, 'plan-1'), null);
});

test('getNextStep advances when a blocker becomes done', async () => {
	await savePlan(null, makePlan({
		steps: [
			makeStep({ id: 's0', idx: 0 }),
			makeStep({ id: 's1', idx: 1, dependsOn: ['s0'] }),
		],
	}));
	await updateStepState(null, 's0', 'in_progress');
	await updateStepState(null, 's0', 'done');
	const next = await getNextStep(null, 'plan-1');
	assert.equal(next!.id, 's1');
});

// ---------------------------------------------------------------------------
// deletePlan + deletePlansForRepo
// ---------------------------------------------------------------------------

test('deletePlan removes plan + steps', async () => {
	await savePlan(null, makePlan({
		steps: [
			makeStep({ id: 's0', idx: 0 }),
			makeStep({ id: 's1', idx: 1 }),
		],
	}));
	await deletePlan(null, 'plan-1');
	assert.equal(await getPlan(null, 'plan-1'), null);
});

test('deletePlansForRepo removes only that repo\'s plans', async () => {
	await savePlan(null, makePlan({ id: 'pa', repoPath: '/repo/a' }));
	await savePlan(null, makePlan({ id: 'pb', repoPath: '/repo/b' }));
	await deletePlansForRepo(null, '/repo/a');
	assert.equal(await getPlan(null, 'pa'), null);
	assert.ok(await getPlan(null, 'pb'));
});

// ---------------------------------------------------------------------------
// resetStaleLocks
// ---------------------------------------------------------------------------

test('resetStaleLocks clears in_progress steps to pending', async () => {
	await savePlan(null, makePlan({
		steps: [
			makeStep({ id: 's0', status: 'in_progress' }),
			makeStep({ id: 's1', idx: 1, status: 'pending' }),
			makeStep({ id: 's2', idx: 2, status: 'in_progress' }),
		],
	}));
	const reset = await resetStaleLocks(null, 'plan-1');
	assert.equal(reset, 2);
	const back = await getPlan(null, 'plan-1');
	assert.deepEqual(
		back!.steps.map(s => s.status),
		['pending', 'pending', 'pending'],
	);
});

test('resetStaleLocks records a note in the step\'s notes field', async () => {
	await savePlan(null, makePlan({
		steps: [makeStep({ id: 's0', status: 'in_progress' })],
	}));
	await resetStaleLocks(null, 'plan-1');
	const back = await getPlan(null, 'plan-1');
	assert.match(back!.steps[0]!.notes, /reset stale in_progress lock/);
});

test('resetStaleLocks on plan with no in_progress is a no-op', async () => {
	await savePlan(null, makePlan({
		steps: [makeStep({ id: 's0', status: 'pending' })],
	}));
	const n = await resetStaleLocks(null, 'plan-1');
	assert.equal(n, 0);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('plans + steps survive close + reopen', async () => {
	const steps = [
		makeStep({ id: 's0', idx: 0 }),
		makeStep({ id: 's1', idx: 1, dependsOn: ['s0'] }),
	];
	await savePlan(null, makePlan({ steps }));
	await closeGraphStore();
	const back = await getPlan(null, 'plan-1');
	assert.equal(back!.steps.length, 2);
	assert.deepEqual(back!.steps[1]!.dependsOn, ['s0']);
});

