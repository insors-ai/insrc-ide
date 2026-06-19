/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the P6 synth Phase2Runner (M4.a Phase 3).
 *
 * Plan ref: `plans/meta-task-plan.md` Phase 3.
 *
 * Pin the contract:
 *   - Happy path: P1 + P3 + P5 present -> markdown body round-trips via
 *     fromMarkdown to a Plan with the right shape + category.
 *   - P5 emits the (skipped) sentinel -> markdown emitted without step.data.
 *   - P1 missing/unparseable -> defaults to 'implementation' (defensive).
 *   - P3 deliverable missing -> abort('user-required').
 *   - P3 deliverable empty -> abort('plan-revisable').
 *   - Runner never calls ctx.cloud.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planSynthRunner } from '../plan-step-synth.js';
import { PLAN_DETAIL_SKIPPED_SENTINEL } from '../plan-prompts.js';
import { fromMarkdown } from '../../../agent/planner/markdown.js';
import type { Phase2RunnerCtx } from '../../types.js';
import type { LLMProvider } from '../../../shared/types.js';
import type { Plan } from '../plan-types.js';


function throwingCloud(): LLMProvider {
	return {
		async complete() { throw new Error('plan-step-synth must NOT call cloud'); },
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
	};
}

function ctx(deliverables: ReadonlyMap<number, string>): Phase2RunnerCtx {
	return {
		stepDesc: {
			name: 'P6 synth', intent: 'synth', acceptance: [], phase2: planSynthRunner,
		},
		phase1Result:     null,
		cumulativeChunks: [],
		cloud:            throwingCloud(),
		catalog:          [],
		deliverables,
		stepIndex:        6,
		retryAttempt:     0,
		bubble:           'test',
		signal:           undefined,
	} as unknown as Phase2RunnerCtx;
}


const VALID_P1_BODY = JSON.stringify({
	category:    'migration',
	subCategory: 'data-migration',
	goals:       ['migrate user table to new schema'],
	constraints: ['zero downtime'],
	scope:       'medium',
});

const VALID_P3_BODY = JSON.stringify([
	{ title: 'Snapshot data',     description: 'Take row snapshot for rollback', dependsOnIdx: []  },
	{ title: 'Apply migration',   description: 'Run the ALTER',                  dependsOnIdx: [0] },
	{ title: 'Verify',            description: 'Diff old vs new',                dependsOnIdx: [1] },
]);

const VALID_P5_BODY = JSON.stringify([
	{ stepIndex: 0, data: { rollbackSteps: ['Restore from snapshot'] } },
	{ stepIndex: 1, data: { validationCheckpoints: [{ description: 'row count', query: 'SELECT count(*) FROM users' }] } },
]);


// ---------------------------------------------------------------------------
// Happy path: round-trip
// ---------------------------------------------------------------------------

test('planSynthRunner: P1 + P3 + P5 present -> markdown round-trips via fromMarkdown', async () => {
	const r = await planSynthRunner(ctx(new Map([
		[1, VALID_P1_BODY],
		[3, VALID_P3_BODY],
		[5, VALID_P5_BODY],
	])));
	assert.equal(r.kind, 'deliverable');
	if (r.kind !== 'deliverable') return;

	const body = r.body;
	assert.match(body, /^---/m);                       // YAML frontmatter
	assert.match(body, /title: /);
	assert.match(body, /migration plan/);             // description from P1 category

	const reconstructed = fromMarkdown<unknown>(body) as Plan;
	assert.equal(reconstructed.steps.length, 3);
	assert.equal(reconstructed.steps[0]!.title, 'Snapshot data');
	assert.equal(reconstructed.steps[1]!.title, 'Apply migration');
	assert.equal(reconstructed.steps[2]!.title, 'Verify');
	// `description` field is preserved through round-trip.
	assert.match(reconstructed.steps[0]!.description, /snapshot/i);
});


// ---------------------------------------------------------------------------
// P5 sentinel
// ---------------------------------------------------------------------------

test('planSynthRunner: P5 (skipped) sentinel -> markdown produced without step.data', async () => {
	const r = await planSynthRunner(ctx(new Map([
		[1, VALID_P1_BODY],
		[3, VALID_P3_BODY],
		[5, PLAN_DETAIL_SKIPPED_SENTINEL],
	])));
	assert.equal(r.kind, 'deliverable');
	if (r.kind !== 'deliverable') return;

	// Body should still contain the 3 steps but no JSON enrichment leak.
	assert.match(r.body, /Snapshot data/);
	assert.match(r.body, /Apply migration/);
	assert.match(r.body, /Verify/);
	// rollbackSteps from P5 must NOT appear (P5 was skipped).
	assert.doesNotMatch(r.body, /rollbackSteps/);
});

test('planSynthRunner: malformed P5 body -> treated as no enrichments (still deliverable)', async () => {
	const r = await planSynthRunner(ctx(new Map([
		[1, VALID_P1_BODY],
		[3, VALID_P3_BODY],
		[5, 'not json at all'],
	])));
	assert.equal(r.kind, 'deliverable');
});


// ---------------------------------------------------------------------------
// Defensive: P1 missing/unparseable
// ---------------------------------------------------------------------------

test('planSynthRunner: missing P1 -> defaults to implementation category', async () => {
	const r = await planSynthRunner(ctx(new Map([[3, VALID_P3_BODY]])));   // no P1, no P5
	assert.equal(r.kind, 'deliverable');
	if (r.kind === 'deliverable') {
		assert.match(r.body, /implementation plan/);
	}
});

test('planSynthRunner: P1 with malformed JSON -> defaults to implementation', async () => {
	const r = await planSynthRunner(ctx(new Map([
		[1, '{not json'],
		[3, VALID_P3_BODY],
	])));
	assert.equal(r.kind, 'deliverable');
	if (r.kind === 'deliverable') {
		assert.match(r.body, /implementation plan/);
	}
});


// ---------------------------------------------------------------------------
// Defensive: P3 problems
// ---------------------------------------------------------------------------

test('planSynthRunner: missing P3 -> abort user-required', async () => {
	const r = await planSynthRunner(ctx(new Map([[1, VALID_P1_BODY]])));
	assert.equal(r.kind, 'abort');
	if (r.kind === 'abort') {
		assert.equal(r.resolution, 'user-required');
		assert.match(r.reason, /missing P3 draft/);
	}
});

test('planSynthRunner: P3 body empty array -> abort plan-revisable', async () => {
	const r = await planSynthRunner(ctx(new Map([
		[1, VALID_P1_BODY],
		[3, '[]'],
	])));
	assert.equal(r.kind, 'abort');
	if (r.kind === 'abort') {
		assert.equal(r.resolution, 'plan-revisable');
		assert.match(r.reason, /zero steps/);
	}
});


// ---------------------------------------------------------------------------
// No-LLM invariant
// ---------------------------------------------------------------------------

test('planSynthRunner: never invokes ctx.cloud (deterministic invariant)', async () => {
	const r = await planSynthRunner(ctx(new Map([
		[1, VALID_P1_BODY],
		[3, VALID_P3_BODY],
	])));
	assert.equal(r.kind, 'deliverable');
});
