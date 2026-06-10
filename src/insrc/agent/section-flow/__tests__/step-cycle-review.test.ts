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
	_validateForTest             as validate,
	_coerceNewStepForTest        as coerceNewStep,
	_renderCycleOutputsForTest   as renderCycleOutputs,
	_extractStepSummariesForTest as extractStepSummaries,
	_scanClosureClaimsForTest    as scanClosureClaims,
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

// ---------------------------------------------------------------------------
// v2: stepSummaries extraction (lenient -- never throws)
// ---------------------------------------------------------------------------

const VALID_CALL_IDS = new Map<string, ReadonlySet<string>>([
	['step-1', new Set(['s1.a'])],
	['step-2', new Set(['s2.a'])],
]);

test('extractStepSummaries: well-formed response is passed through verbatim', () => {
	const raw = JSON.stringify({
		keep: [], new_steps: [],
		stepSummaries: {
			'step-1': { 's1.a': 'INGRN has 21 fields. CLOSES ingrn-fields fully' },
			'step-2': { 's2.a': 'sampled 1 row. PARTIALLY supports json-shape' },
		},
	});
	const out = extractStepSummaries(raw, VALID_CALL_IDS);
	assert.equal(out['step-1']!['s1.a'], 'INGRN has 21 fields. CLOSES ingrn-fields fully');
	assert.equal(out['step-2']!['s2.a'], 'sampled 1 row. PARTIALLY supports json-shape');
});

test('extractStepSummaries: missing field -> empty object (no throw)', () => {
	const raw = JSON.stringify({ keep: [], new_steps: [] });
	assert.deepEqual(extractStepSummaries(raw, VALID_CALL_IDS), {});
});

test('extractStepSummaries: top-level non-JSON -> empty object', () => {
	assert.deepEqual(extractStepSummaries('not json', VALID_CALL_IDS), {});
	assert.deepEqual(extractStepSummaries('[]', VALID_CALL_IDS), {});
});

test('extractStepSummaries: unknown stepId / callId entries dropped, valid ones kept', () => {
	const raw = JSON.stringify({
		keep: [], new_steps: [],
		stepSummaries: {
			'step-1': {
				's1.a':       'valid call. CLOSES ingrn-fields fully',
				's1.unknown': 'invented call. OFF-TOPIC',     // unknown call id
			},
			'step-99': { 's9.a': 'invented step. OFF-TOPIC' },   // unknown step
		},
	});
	const out = extractStepSummaries(raw, VALID_CALL_IDS);
	assert.deepEqual(Object.keys(out).sort(), ['step-1']);
	assert.deepEqual(Object.keys(out['step-1']!).sort(), ['s1.a']);
});

test('extractStepSummaries: non-object inner / empty string values dropped silently', () => {
	const raw = JSON.stringify({
		keep: [], new_steps: [],
		stepSummaries: {
			'step-1': { 's1.a': '' },              // empty -> drop
			'step-2': 'not-an-object',             // non-object -> drop
		},
	});
	const out = extractStepSummaries(raw, VALID_CALL_IDS);
	assert.deepEqual(out, {});
});

test('extractStepSummaries: tolerates markdown fences around the JSON', () => {
	const fenced = '```json\n' + JSON.stringify({
		keep: [], new_steps: [],
		stepSummaries: { 'step-1': { 's1.a': 'observed. CLOSES ingrn-fields fully' } },
	}) + '\n```';
	const out = extractStepSummaries(fenced, VALID_CALL_IDS);
	assert.equal(out['step-1']!['s1.a'], 'observed. CLOSES ingrn-fields fully');
});

// ---------------------------------------------------------------------------
// v2: closure marker scan
// ---------------------------------------------------------------------------

const GAP_ID_SET = new Set(['ingrn-fields', 'json-shape']);

test('scanClosureClaims: CLOSES marker -> closes-fully verdict', () => {
	const claims = scanClosureClaims(
		{ 'step-1': { 's1.a': 'INGRN has 21 fields. CLOSES ingrn-fields fully' } },
		GAP_ID_SET,
	);
	assert.equal(claims.length, 1);
	assert.deepEqual(claims[0], { stepId: 'step-1', callId: 's1.a', gapId: 'ingrn-fields', verdict: 'closes-fully' });
});

test('scanClosureClaims: PARTIALLY marker -> partial verdict', () => {
	const claims = scanClosureClaims(
		{ 'step-2': { 's2.a': 'sampled one row. PARTIALLY supports json-shape' } },
		GAP_ID_SET,
	);
	assert.equal(claims.length, 1);
	assert.deepEqual(claims[0], { stepId: 'step-2', callId: 's2.a', gapId: 'json-shape', verdict: 'partial' });
});

test('scanClosureClaims: OFF-TOPIC marker -> off-topic verdict with gapId null', () => {
	const claims = scanClosureClaims(
		{ 'step-1': { 's1.a': 'extract-fields returned empty. OFF-TOPIC' } },
		GAP_ID_SET,
	);
	assert.equal(claims.length, 1);
	assert.deepEqual(claims[0], { stepId: 'step-1', callId: 's1.a', gapId: null, verdict: 'off-topic' });
});

test('scanClosureClaims: chained markers in one summary -> multiple claims', () => {
	const claims = scanClosureClaims(
		{
			'step-1': {
				's1.a': 'INGRN imports GRNItem. PARTIALLY supports ingrn-fields; PARTIALLY supports json-shape',
			},
		},
		GAP_ID_SET,
	);
	assert.equal(claims.length, 2);
	const gapIds = claims.map(c => c.gapId).sort();
	assert.deepEqual(gapIds, ['ingrn-fields', 'json-shape']);
	for (const c of claims) { assert.equal(c.verdict, 'partial'); }
});

test('scanClosureClaims: unknown gap-id dropped (no fabricated coverage)', () => {
	const claims = scanClosureClaims(
		{ 'step-1': { 's1.a': 'CLOSES not-a-real-gap fully' } },
		GAP_ID_SET,
	);
	assert.equal(claims.length, 0);
});

test('scanClosureClaims: summary with no recognised marker -> no claims (logged + dropped)', () => {
	const claims = scanClosureClaims(
		{ 'step-1': { 's1.a': 'just a sentence without any marker keyword' } },
		GAP_ID_SET,
	);
	assert.equal(claims.length, 0);
});

test('scanClosureClaims: case-insensitive on marker keyword', () => {
	const claims = scanClosureClaims(
		{ 'step-1': { 's1.a': 'observed. closes ingrn-fields fully' } },
		GAP_ID_SET,
	);
	assert.equal(claims.length, 1);
	assert.equal(claims[0]!.verdict, 'closes-fully');
});

test('scanClosureClaims: OFF TOPIC (space variant) also matches', () => {
	const claims = scanClosureClaims(
		{ 'step-1': { 's1.a': 'attempted nothing useful. OFF TOPIC' } },
		GAP_ID_SET,
	);
	assert.equal(claims.length, 1);
	assert.equal(claims[0]!.verdict, 'off-topic');
});

// ---------------------------------------------------------------------------
// v2: end-to-end via runCycleReview (writer + caller + extractor)
// ---------------------------------------------------------------------------

const REVIEW_V2_TERMINATE = JSON.stringify({
	keep: ['step-1', 'step-2'],
	new_steps: [],
	stepSummaries: {
		'step-1': { 's1.a': 'located INGRN at insors/grn.py:40. PARTIALLY supports ingrn-fields' },
		'step-2': { 's2.a': 'sampled 1 row. CLOSES json-shape fully' },
	},
});

test('runCycleReview: v2 prompt teaches stepSummaries shape + closure vocabulary', async () => {
	const { provider, calls } = scriptedProvider([REVIEW_V2_TERMINATE]);
	await runCycleReview({
		todo: TODO, gapFacts: GAP_FACTS,
		stepsThisCycle: [STEP_1, STEP_2],
		cycleOutputs: [output('step-1'), output('step-2')],
		cycleMemory: emptyCycleMemory(['INGRN field list', 'JSON shape']),
		cycle: 1, catalog: CATALOG, provider,
	});
	const user = calls[0]!.messages[1]!.content;
	// New schema bits
	assert.match(user, /stepSummaries/);
	assert.match(user, /CLOSES.*fully/);
	assert.match(user, /PARTIALLY supports/);
	assert.match(user, /OFF-TOPIC/);
	// Per-call breakdown so the LLM knows valid (stepId, callId) tuples
	assert.match(user, /skill calls:/);
	assert.match(user, /s1\.a/);
	assert.match(user, /s2\.a/);
});

test('runCycleReview: v2 response -> stepSummaries + closureClaims surfaced on result', async () => {
	const { provider } = scriptedProvider([REVIEW_V2_TERMINATE]);
	const r = await runCycleReview({
		todo: TODO, gapFacts: GAP_FACTS,
		stepsThisCycle: [STEP_1, STEP_2],
		cycleOutputs: [output('step-1'), output('step-2')],
		cycleMemory: emptyCycleMemory(['INGRN field list', 'JSON shape']),
		cycle: 1, catalog: CATALOG, provider,
	});
	assert.equal(r.stepSummaries['step-1']?.['s1.a'], 'located INGRN at insors/grn.py:40. PARTIALLY supports ingrn-fields');
	assert.equal(r.stepSummaries['step-2']?.['s2.a'], 'sampled 1 row. CLOSES json-shape fully');
	assert.equal(r.closureClaims.length, 2);
	const byCall = new Map(r.closureClaims.map(c => [c.callId, c]));
	assert.equal(byCall.get('s1.a')!.verdict, 'partial');
	assert.equal(byCall.get('s1.a')!.gapId,   'ingrn-fields');
	assert.equal(byCall.get('s2.a')!.verdict, 'closes-fully');
	assert.equal(byCall.get('s2.a')!.gapId,   'json-shape');
});

test('runCycleReview: v1-shaped response (no stepSummaries) -> empty stepSummaries + claims, no throw', async () => {
	const { provider } = scriptedProvider([KEEP_ONLY_TERMINATE_JSON]);
	const r = await runCycleReview({
		todo: TODO, gapFacts: GAP_FACTS,
		stepsThisCycle: [STEP_1, STEP_2],
		cycleOutputs: [output('step-1'), output('step-2')],
		cycleMemory: emptyCycleMemory(['INGRN field list', 'JSON shape']),
		cycle: 1, catalog: CATALOG, provider,
	});
	assert.deepEqual(r.stepSummaries, {});
	assert.deepEqual(r.closureClaims, []);
	// The keep/new_steps contract still holds, so the orchestrator keeps working.
	assert.deepEqual([...r.response.keep].sort(), ['step-1', 'step-2']);
});
