/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase gamma tests for runDiscoveryPlanExpansion (Stage 1).
 *
 * Covers:
 *   - Happy path: cycle 1 with valid gap-fact-targeting steps
 *   - Cycle 2+: cycleMemory rendered into prompt
 *   - Retry path: first attempt has unknown skillId, retry validates
 *   - Throw path: both attempts fail
 *   - Empty gapFacts throws (orchestrator should take fast-path instead)
 *   - Call opts (temperature 0, disableThinking, responseFormat='json')
 *   - Validator rejections: empty steps, missing intent, unknown skillId,
 *     invalid targetsCriteria index, duplicate step ids, duplicate skill ids,
 *     missing dependsOn target
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runDiscoveryPlanExpansion,
	_validateForTest             as validate,
	_coerceStepForTest           as coerceStep,
	_renderGapFactsForTest       as renderGapFacts,
	_validateDependsOnForTest    as validateDependsOn,
} from '../step-discovery-plan-expansion.js';
import { emptyCycleMemory } from '../../content-gen/discovery-plan.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { TodoSpec } from '../types.js';
import type { MemoryShapeBundle } from '../../working-memory/index.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { RequiredFact } from '../fact-gap-types.js';
import type { CycleMemory } from '../../content-gen/discovery-plan.js';

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

function makeTodo(): TodoSpec {
	return { id: 'todo-x', objective: 'map GRN JSON to INGRN class', origin: 'initial' };
}
function makeMemory(): MemoryShapeBundle {
	return { system: '', summary: '', recent: '', semantic: '', code: '' };
}
function makeCatalog(): readonly CatalogSkill[] {
	return [
		{ id: 'code.class.extract-fields',  description: 'Extract Pydantic fields',  family: 'class',  owner: 'code-analyzer', inputs: {}, outputPaths: [] },
		{ id: 'code.entity.locate-by-name', description: 'Locate entity by name',    family: 'entity', owner: 'code-analyzer', inputs: {}, outputPaths: [] },
		{ id: 'data.source.file.sample-shape', description: 'Sample file shape',     family: 'source', owner: 'data-analyzer', inputs: {}, outputPaths: [] },
	];
}
function makeGapFacts(): readonly RequiredFact[] {
	return [
		{ id: 'ingrn-fields', fact: 'INGRN class field list',  why: 'mapping baseline', status: 'absent',
		  suggestedSkills: ['code.class.extract-fields'] },
		{ id: 'json-shape',   fact: 'GRN JSON top-level keys', why: 'data side',         status: 'absent',
		  suggestedSkills: ['data.source.file.sample-shape'] },
	];
}

const HEALTHY_PLAN_JSON = JSON.stringify({
	steps: [
		{
			id: 'step-1',
			intent: 'locate then extract INGRN class fields',
			skills: [
				{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' },
				{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'entityId from s1.a', dependsOn: 's1.a' },
			],
			targetsCriteria: [0],
		},
		{
			id: 'step-2',
			intent: 'sample one GRN JSON file shape',
			skills: [
				{ id: 's2.a', skillId: 'data.source.file.sample-shape', context: 'path=test/integration/data/BB/GRN/grn-basic.json' },
			],
			targetsCriteria: [1],
		},
	],
});

const UNKNOWN_SKILL_PLAN_JSON = JSON.stringify({
	steps: [
		{
			id: 'step-1', intent: 'do a thing',
			skills: [{ id: 's1.a', skillId: 'not.a.real.skill', context: 'foo' }],
			targetsCriteria: [0],
		},
	],
});

// ---------------------------------------------------------------------------
// End-to-end via runDiscoveryPlanExpansion
// ---------------------------------------------------------------------------

test('runDiscoveryPlanExpansion: cycle 1 happy path -> validated, 2 steps', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_PLAN_JSON]);
	const r = await runDiscoveryPlanExpansion({
		todo: makeTodo(), gapFacts: makeGapFacts(), memory: makeMemory(),
		catalog: makeCatalog(), cycle: 1, cycleMemory: emptyCycleMemory(['ingrn-fields', 'json-shape']),
		provider,
	});
	assert.equal(calls.length, 1);
	assert.equal(r.retried, false);
	assert.equal(r.steps.length, 2);
	assert.deepEqual(r.steps[0]!.targetsCriteria, [0]);
	assert.deepEqual(r.steps[1]!.targetsCriteria, [1]);
});

// Regression guard: the prompt MUST teach the model about the two
// `dependsOn` forms (intra-step bare id vs cross-step "stepId.skillId").
// If this assertion stops matching, the planner will stop emitting the
// cross-step form and we lose the orchestrator's cross-step priorOutputs
// forwarding path -- which is the whole reason the per-TODO raw cache
// exists. See plans/section-flow-cross-step-deps.md (if written).
test('runDiscoveryPlanExpansion: prompt teaches both intra-step + cross-step dependsOn forms', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_PLAN_JSON]);
	await runDiscoveryPlanExpansion({
		todo: makeTodo(), gapFacts: makeGapFacts(), memory: makeMemory(),
		catalog: makeCatalog(), cycle: 1, cycleMemory: emptyCycleMemory(['ingrn-fields', 'json-shape']),
		provider,
	});
	const user = calls[0]!.messages[1]!.content;
	assert.match(user, /INTRA-STEP/);
	assert.match(user, /CROSS-STEP/);
	assert.match(user, /step-1\.s1\.a/);
	// The "do NOT invent" guard belongs at the end of the dependsOn block.
	assert.match(user, /Never invent a step or skill id that hasn't been declared/);
});

test('runDiscoveryPlanExpansion: cycle 2 renders cycleMemory into prompt', async () => {
	const cycleMemory: CycleMemory = {
		priorAsks: [{ cycle: 1, steps: [{ id: 'step-1', intent: 'locate INGRN' }] }],
		criteriaCoverage: [
			{ criterion: 'INGRN class field list', status: 'open',    contributingStepIds: [] },
			{ criterion: 'GRN JSON top-level keys', status: 'covered', contributingStepIds: ['step-1'] },
		],
		scratchpad: '',
	};
	const { provider, calls } = scriptedProvider([HEALTHY_PLAN_JSON]);
	await runDiscoveryPlanExpansion({
		todo: makeTodo(), gapFacts: makeGapFacts(), memory: makeMemory(),
		catalog: makeCatalog(), cycle: 2, cycleMemory,
		provider,
	});
	const user = calls[0]!.messages[1]!.content;
	assert.match(user, /## PRIOR CYCLE CONTEXT/);
	assert.match(user, /cycle 1 -- 1 step:/);
	assert.match(user, /step-1: locate INGRN/);
	// Cycle-2 prompt also surfaces the dedupe-warning rule.
	assert.match(user, /already-attempted/);
});

test('runDiscoveryPlanExpansion: retry path -> first attempt unknown skill, retry validates', async () => {
	const { provider, calls } = scriptedProvider([UNKNOWN_SKILL_PLAN_JSON, HEALTHY_PLAN_JSON]);
	const r = await runDiscoveryPlanExpansion({
		todo: makeTodo(), gapFacts: makeGapFacts(), memory: makeMemory(),
		catalog: makeCatalog(), cycle: 1, cycleMemory: emptyCycleMemory(['ingrn-fields', 'json-shape']),
		provider,
	});
	assert.equal(calls.length, 2);
	assert.equal(r.retried, true);
	assert.match(r.firstFailureReason ?? '', /not in the SKILL CATALOG/);
	assert.match(calls[1]!.messages[1]!.content, /RETRY CORRECTION/);
});

test('runDiscoveryPlanExpansion: both attempts fail -> throws', async () => {
	const { provider } = scriptedProvider([UNKNOWN_SKILL_PLAN_JSON, UNKNOWN_SKILL_PLAN_JSON]);
	await assert.rejects(
		() => runDiscoveryPlanExpansion({
			todo: makeTodo(), gapFacts: makeGapFacts(), memory: makeMemory(),
			catalog: makeCatalog(), cycle: 1, cycleMemory: emptyCycleMemory(['ingrn-fields', 'json-shape']),
			provider,
		}),
		/discovery-plan expansion validation failed after retry/,
	);
});

test('runDiscoveryPlanExpansion: empty gapFacts -> throws (orchestrator bug guard)', async () => {
	const { provider } = scriptedProvider([]);
	await assert.rejects(
		() => runDiscoveryPlanExpansion({
			todo: makeTodo(), gapFacts: [], memory: makeMemory(),
			catalog: makeCatalog(), cycle: 1, cycleMemory: emptyCycleMemory([]),
			provider,
		}),
		/gapFacts is empty/,
	);
});

test('runDiscoveryPlanExpansion: call opts -- temperature 0, disableThinking, responseFormat json', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_PLAN_JSON]);
	await runDiscoveryPlanExpansion({
		todo: makeTodo(), gapFacts: makeGapFacts(), memory: makeMemory(),
		catalog: makeCatalog(), cycle: 1, cycleMemory: emptyCycleMemory(['a', 'b']),
		provider,
	});
	assert.equal(calls[0]!.opts.temperature, 0);
	assert.equal(calls[0]!.opts.disableThinking, true);
	assert.equal(calls[0]!.opts.responseFormat, 'json');
});

// ---------------------------------------------------------------------------
// validate() — direct tests
// ---------------------------------------------------------------------------

test('validate: empty steps -> rejected', () => {
	const r = validate(JSON.stringify({ steps: [] }), new Set(['code.class.extract-fields']), 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /at least one entry/); }
});

test('validate: duplicate step ids -> rejected', () => {
	const json = JSON.stringify({
		steps: [
			{ id: 'step-1', intent: 'first attempt', skills: [{ id: 's', skillId: 'code.class.extract-fields', context: 'try a' }], targetsCriteria: [0] },
			{ id: 'step-1', intent: 'duplicate id', skills: [{ id: 't', skillId: 'code.class.extract-fields', context: 'try b' }], targetsCriteria: [0] },
		],
	});
	const r = validate(json, new Set(['code.class.extract-fields']), 0);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /duplicates an earlier step/); }
});

test('validate: skillId not in catalog -> rejected', () => {
	const r = validate(UNKNOWN_SKILL_PLAN_JSON, new Set(['code.class.extract-fields']), 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /not in the SKILL CATALOG/); }
});

test('validate: targetsCriteria with invalid index -> rejected', () => {
	const json = JSON.stringify({
		steps: [{
			id: 'step-1', intent: 'out-of-range target', skills: [{ id: 's', skillId: 'code.class.extract-fields', context: 'foo' }],
			targetsCriteria: [5],   // maxFactIdx = 1 in this test
		}],
	});
	const r = validate(json, new Set(['code.class.extract-fields']), 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /not a valid fact index/); }
});

test('coerceStep: dependsOn referencing a non-existent skill id -> error', () => {
	const r = coerceStep({
		id: 'step-1', intent: 'extract with bad dep',
		skills: [
			{ id: 's1.a', skillId: 'code.class.extract-fields', context: 'foo', dependsOn: 's9.x' },
		],
		targetsCriteria: [0],
	}, 0, new Set(['code.class.extract-fields']), 0, new Map());
	assert.equal(typeof r, 'string');
	if (typeof r === 'string') { assert.match(r, /dependsOn.*"s9\.x"/); }
});

test('coerceStep: dependsOn referencing earlier sibling -> accepted', () => {
	const r = coerceStep({
		id: 'step-1', intent: 'locate then extract',
		skills: [
			{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' },
			{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'use s1.a result', dependsOn: 's1.a' },
		],
		targetsCriteria: [0],
	}, 0, new Set(['code.entity.locate-by-name', 'code.class.extract-fields']), 0, new Map());
	assert.notEqual(typeof r, 'string');
	if (typeof r !== 'string') {
		assert.equal(r.skills.length, 2);
		assert.equal(r.skills[1]!.dependsOn, 's1.a');
	}
});

// ---------------------------------------------------------------------------
// validateDependsOn — cross-step `stepId.skillId` form
// ---------------------------------------------------------------------------

test('validateDependsOn: bare id matching an earlier same-step skill -> ok', () => {
	const r = validateDependsOn('s1.a', 's1.b', new Set(['s1.a']), new Map());
	assert.equal(r, undefined);
});

test('validateDependsOn: self-reference -> error', () => {
	const r = validateDependsOn('s1.a', 's1.a', new Set(['s1.a']), new Map());
	assert.match(r ?? '', /must not reference itself/);
});

test('validateDependsOn: cross-step ref to earlier step + valid skill -> ok', () => {
	// Plan: step-1 has skills s1.a + s1.b; step-2 declares dep on step-1.s1.a.
	const earlier = new Map<string, ReadonlySet<string>>([
		['step-1', new Set(['s1.a', 's1.b'])],
	]);
	const r = validateDependsOn('step-1.s1.a', 's2.a', new Set(), earlier);
	assert.equal(r, undefined);
});

test('validateDependsOn: cross-step ref to non-existent step -> error', () => {
	const earlier = new Map<string, ReadonlySet<string>>([
		['step-1', new Set(['s1.a'])],
	]);
	const r = validateDependsOn('step-9.s9.a', 's2.a', new Set(), earlier);
	assert.match(r ?? '', /step "step-9" which is not an earlier step/);
});

test('validateDependsOn: cross-step ref to existing step but unknown skill -> error', () => {
	const earlier = new Map<string, ReadonlySet<string>>([
		['step-1', new Set(['s1.a'])],
	]);
	const r = validateDependsOn('step-1.s9.x', 's2.a', new Set(), earlier);
	assert.match(r ?? '', /skill "s9\.x" which is not in step "step-1"/);
});

test('validateDependsOn: intra-step skill id `s1.a` (with dot) matches before falling back to cross-step parse', () => {
	// Skill ids contain dots themselves. The full-string intra-step match
	// MUST be tried before any cross-step parse, otherwise `s1.a` from
	// `s1.b` in the same step would be treated as stepId="s1" / skillId="a".
	const earlier = new Map<string, ReadonlySet<string>>([
		['step-1', new Set(['s1.a'])],   // an unrelated earlier step
	]);
	const r = validateDependsOn('s1.a', 's1.b', new Set(['s1.a']), earlier);
	assert.equal(r, undefined);
});

test('validateDependsOn: bare id with no intra-step match and no dot -> error explaining both forms', () => {
	const r = validateDependsOn('orphan', 's1.a', new Set(['s1.a']), new Map());
	assert.match(r ?? '', /same step OR use the "stepId\.skillId" cross-step form/);
});

// ---------------------------------------------------------------------------
// renderGapFacts
// ---------------------------------------------------------------------------

test('renderGapFacts: empty list -> placeholder', () => {
	assert.match(renderGapFacts([]), /no gap facts/);
});

test('renderGapFacts: includes index, id, status, fact, why, suggested', () => {
	const out = renderGapFacts([
		{ id: 'ingrn-fields', fact: 'INGRN field list', why: 'mapping baseline', status: 'absent',
		  suggestedSkills: ['code.class.extract-fields'] },
	]);
	assert.match(out, /^\[0\] ingrn-fields \(absent\)/);
	assert.match(out, /fact: INGRN field list/);
	assert.match(out, /why:  mapping baseline/);
	assert.match(out, /suggested: code\.class\.extract-fields/);
});
