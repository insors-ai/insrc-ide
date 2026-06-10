/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase gamma tests for runCycleReview (Stage 3).
 *
 * Covers:
 *   - Termination: keep-only response (new_steps: []) validates
 *   - Continuation: keep + new_steps validates; new_steps follow Stage-1 rules
 *   - Retry path: bad keep id -> retry with corrective hint validates
 *   - Throw path: top-level shape always wrong -> throws
 *   - new_steps[] partial validity: bad entries DROPPED with warn,
 *     valid ones retained, droppedStepIds reported
 *   - Cycle-2 prompt rendering includes prior cycle context block
 *   - Cycle outputs render facts + status into the prompt
 *   - Validator rejections: keep id not from this cycle, new_steps not an array
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runCycleReview,
	_validateForTest         as validate,
	_coerceNewStepForTest    as coerceNewStep,
	_renderCycleOutputsForTest as renderCycleOutputs,
} from '../step-cycle-review.js';
import { emptyCycleMemory } from '../../content-gen/discovery-plan.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { TodoSpec } from '../types.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { RequiredFact } from '../fact-gap-types.js';
import { _resetPromptRegistryForTest, registerAllPromptWriters } from '../../prompts/index.js';

test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});
import type { CycleMemory, DiscoveryStep, StepOutput } from '../../content-gen/discovery-plan.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall { readonly messages: LLMMessage[]; readonly opts: CompletionOpts; }

function scriptedProvider(responses: readonly string[]): { provider: LLMProvider; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const provider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out of responses at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			return { text, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls };
}

const TODO: TodoSpec = { id: 'todo-x', objective: 'map GRN JSON to INGRN class', origin: 'initial' };
const CATALOG: readonly CatalogSkill[] = [
	{ id: 'code.class.extract-fields',     description: 'extract',   family: 'class',  owner: 'code-analyzer', inputs: {}, outputPaths: [] },
	{ id: 'code.entity.locate-by-name',    description: 'locate',    family: 'entity', owner: 'code-analyzer', inputs: {}, outputPaths: [] },
	{ id: 'data.source.file.sample-shape', description: 'sample',    family: 'source', owner: 'data-analyzer', inputs: {}, outputPaths: [] },
];
const GAP_FACTS: readonly RequiredFact[] = [
	{ id: 'ingrn-fields', fact: 'INGRN field list', why: 'baseline', status: 'absent' },
	{ id: 'json-shape',   fact: 'JSON shape',       why: 'data',     status: 'absent' },
];

const STEP_1: DiscoveryStep = {
	id: 'step-1', intent: 'locate INGRN',
	skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
	targetsCriteria: [0],
};
const STEP_2: DiscoveryStep = {
	id: 'step-2', intent: 'sample JSON shape',
	skills: [{ id: 's2.a', skillId: 'data.source.file.sample-shape', context: 'path=grn-basic.json' }],
	targetsCriteria: [1],
};

function output(stepId: string, status: 'ok' | 'partial' | 'failed' = 'ok'): StepOutput {
	return {
		stepId, status,
		facts: ['a real fact'],
		citations: [{ path: '/repo/foo.ts', startLine: 1, endLine: 20 }],
		durationMs: 100,
	};
}

const KEEP_ONLY_TERMINATE_JSON = JSON.stringify({
	keep: ['step-1', 'step-2'],
	new_steps: [],
	scratchpad: 'all gaps covered',
});

const KEEP_PLUS_NEW_STEPS_JSON = JSON.stringify({
	keep: ['step-1'],
	new_steps: [
		{
			id: 'step-3', intent: 'retry sample with explicit connectionId',
			skills: [{ id: 's3.a', skillId: 'data.source.file.sample-shape', context: 'path=grn-basic.json, connectionId=fs-local' }],
			targetsCriteria: [1],
		},
	],
});

const BAD_KEEP_ID_JSON = JSON.stringify({
	keep: ['step-1', 'step-9'],   // step-9 not in this cycle
	new_steps: [],
});

const NEW_STEPS_PARTIAL_VALIDITY_JSON = JSON.stringify({
	keep: [],
	new_steps: [
		// valid
		{ id: 'step-3', intent: 'good step',
		  skills: [{ id: 's3.a', skillId: 'code.class.extract-fields', context: 'use s1.a entityId' }],
		  targetsCriteria: [0] },
		// bad: unknown skillId
		{ id: 'step-4', intent: 'bad step',
		  skills: [{ id: 's4.a', skillId: 'fake.skill', context: 'x' }],
		  targetsCriteria: [0] },
		// bad: empty targetsCriteria
		{ id: 'step-5', intent: 'targets empty',
		  skills: [{ id: 's5.a', skillId: 'code.class.extract-fields', context: 'x' }],
		  targetsCriteria: [] },
	],
});

const TOP_LEVEL_SHAPE_BAD_JSON = JSON.stringify({ keep: 'not-an-array', new_steps: [] });

// ---------------------------------------------------------------------------
// End-to-end via runCycleReview
// ---------------------------------------------------------------------------

test('runCycleReview: termination -> keep populated, new_steps empty', async () => {
	const { provider } = scriptedProvider([KEEP_ONLY_TERMINATE_JSON]);
	const r = await runCycleReview({
		todo: TODO, gapFacts: GAP_FACTS,
		stepsThisCycle: [STEP_1, STEP_2],
		cycleOutputs: [output('step-1'), output('step-2')],
		cycleMemory: emptyCycleMemory(['INGRN field list', 'JSON shape']),
		cycle: 1, catalog: CATALOG, provider,
	});
	assert.deepEqual([...r.response.keep].sort(), ['step-1', 'step-2']);
	assert.equal(r.response.new_steps.length, 0);
	assert.equal(r.response.scratchpad, 'all gaps covered');
	assert.equal(r.retried, false);
});

test('runCycleReview: continuation -> keep + new_steps both populated', async () => {
	const { provider } = scriptedProvider([KEEP_PLUS_NEW_STEPS_JSON]);
	const r = await runCycleReview({
		todo: TODO, gapFacts: GAP_FACTS,
		stepsThisCycle: [STEP_1, STEP_2],
		cycleOutputs: [output('step-1'), output('step-2', 'partial')],
		cycleMemory: emptyCycleMemory(['INGRN field list', 'JSON shape']),
		cycle: 1, catalog: CATALOG, provider,
	});
	assert.deepEqual(r.response.keep, ['step-1']);
	assert.equal(r.response.new_steps.length, 1);
	assert.equal(r.response.new_steps[0]!.id, 'step-3');
});

test('runCycleReview: bad keep id -> retry with corrective hint', async () => {
	const { provider, calls } = scriptedProvider([BAD_KEEP_ID_JSON, KEEP_ONLY_TERMINATE_JSON]);
	const r = await runCycleReview({
		todo: TODO, gapFacts: GAP_FACTS,
		stepsThisCycle: [STEP_1, STEP_2],
		cycleOutputs: [output('step-1'), output('step-2')],
		cycleMemory: emptyCycleMemory(['INGRN field list', 'JSON shape']),
		cycle: 1, catalog: CATALOG, provider,
	});
	assert.equal(calls.length, 2);
	assert.equal(r.retried, true);
	assert.match(r.firstFailureReason ?? '', /not from this cycle/);
	assert.match(calls[1]!.messages[1]!.content, /RETRY CORRECTION/);
});

test('runCycleReview: top-level shape always wrong -> throws', async () => {
	const { provider } = scriptedProvider([TOP_LEVEL_SHAPE_BAD_JSON, TOP_LEVEL_SHAPE_BAD_JSON]);
	await assert.rejects(
		() => runCycleReview({
			todo: TODO, gapFacts: GAP_FACTS,
			stepsThisCycle: [STEP_1, STEP_2],
			cycleOutputs: [output('step-1')],
			cycleMemory: emptyCycleMemory(['INGRN field list', 'JSON shape']),
			cycle: 1, catalog: CATALOG, provider,
		}),
		/cycle review validation failed after retry/,
	);
});

test('runCycleReview: new_steps partial validity -> drops bad entries, keeps good ones', async () => {
	const { provider } = scriptedProvider([NEW_STEPS_PARTIAL_VALIDITY_JSON]);
	const r = await runCycleReview({
		todo: TODO, gapFacts: GAP_FACTS,
		stepsThisCycle: [STEP_1, STEP_2],
		cycleOutputs: [output('step-1')],
		cycleMemory: emptyCycleMemory(['INGRN field list', 'JSON shape']),
		cycle: 1, catalog: CATALOG, provider,
	});
	// Only step-3 survives the per-entry coercion; step-4 (unknown skill) and step-5 (empty targets) drop.
	assert.equal(r.response.new_steps.length, 1);
	assert.equal(r.response.new_steps[0]!.id, 'step-3');
	assert.deepEqual([...r.droppedStepIds].sort(), ['step-4', 'step-5']);
});

test('runCycleReview: cycle-2 prompt renders cycleMemory + dedupe rule', async () => {
	const cycleMemory: CycleMemory = {
		priorAsks: [{ cycle: 1, steps: [{ id: 'step-1', intent: 'locate INGRN' }] }],
		criteriaCoverage: [
			{ criterion: 'INGRN field list', status: 'open',    contributingStepIds: [] },
			{ criterion: 'JSON shape',       status: 'covered', contributingStepIds: ['step-2'] },
		],
		scratchpad: '',
	};
	const { provider, calls } = scriptedProvider([KEEP_ONLY_TERMINATE_JSON]);
	await runCycleReview({
		todo: TODO, gapFacts: GAP_FACTS,
		stepsThisCycle: [STEP_1, STEP_2],
		cycleOutputs: [output('step-1'), output('step-2')],
		cycleMemory,
		cycle: 2, catalog: CATALOG, provider,
	});
	const user = calls[0]!.messages[1]!.content;
	assert.match(user, /## PRIOR CYCLE CONTEXT/);
	assert.match(user, /cycle 1 -- 1 step:/);
	assert.match(user, /DO NOT re-emit/);
});

test('runCycleReview: cycle outputs render facts + status into prompt', async () => {
	const { provider, calls } = scriptedProvider([KEEP_ONLY_TERMINATE_JSON]);
	await runCycleReview({
		todo: TODO, gapFacts: GAP_FACTS,
		stepsThisCycle: [STEP_1, STEP_2],
		cycleOutputs: [
			{ stepId: 'step-1', status: 'ok',     facts: ['real fact A'], citations: [], durationMs: 100 },
			{ stepId: 'step-2', status: 'failed', facts: [],              citations: [], durationMs: 50  },
		],
		cycleMemory: emptyCycleMemory(['INGRN field list', 'JSON shape']),
		cycle: 1, catalog: CATALOG, provider,
	});
	const user = calls[0]!.messages[1]!.content;
	assert.match(user, /### step-1 \(status: ok\) -- locate INGRN/);
	assert.match(user, /real fact A/);
	assert.match(user, /### step-2 \(status: failed\)/);
	assert.match(user, /facts: \(none\)/);
});

// ---------------------------------------------------------------------------
// validate() — direct tests
// ---------------------------------------------------------------------------

test('validate: new_steps not an array -> rejected at top level', () => {
	const r = validate(JSON.stringify({ keep: [], new_steps: 'nope' }), new Set(), new Set(), 0, new Map());
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /must be an array/); }
});

test('validate: keep entry not a string -> rejected', () => {
	const r = validate(JSON.stringify({ keep: [42], new_steps: [] }), new Set(['step-1']), new Set(), 0, new Map());
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /not a non-empty string/); }
});

test('coerceNewStep: missing dependsOn target -> error', () => {
	const r = coerceNewStep({
		id: 'step-3', intent: 'extract with bad dep',
		skills: [{ id: 's3.a', skillId: 'code.class.extract-fields', context: 'foo', dependsOn: 's9.x' }],
		targetsCriteria: [0],
	}, 0, new Set(['code.class.extract-fields']), 0, new Set(), new Map());
	assert.equal(typeof r, 'string');
	if (typeof r === 'string') { assert.match(r, /dependsOn.*"s9\.x"/); }
});

// ---------------------------------------------------------------------------
// renderCycleOutputs
// ---------------------------------------------------------------------------

test('renderCycleOutputs: empty -> placeholder', () => {
	assert.match(renderCycleOutputs([], []), /no outputs/);
});

test('renderCycleOutputs: includes citations count when present', () => {
	const out = renderCycleOutputs(
		[{ stepId: 'step-1', status: 'ok', facts: ['f'], citations: [{ path: 'a' }, { path: 'b' }], durationMs: 10 }],
		[STEP_1],
	);
	assert.match(out, /citations: 2/);
});
