/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for runDecideNextStep (citation-contract update).
 *
 * v2 contract: the cloud no longer authors summaries -- the local-tier
 * `summarize-step` writer + verifier handle that. The cloud just emits
 * action + reasoning + (step | verdict).
 *
 * Covered:
 *
 *   - execute-step: `step` validates via the shared coerceStep.
 *   - replan-sketch: action + reasoning pass through.
 *   - terminate: `verdict` is `covered` or `unrecoverable`.
 *   - First-turn (no lastStep) behaves the same as later turns.
 *   - Retry path: malformed first attempt -> corrective hint retry.
 *   - Both attempts fail -> throws.
 *   - parse() rejection branches for every required field.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runDecideNextStep,
	_parseForTest       as parse,
	_stripFencesForTest as stripFences,
} from '../step-decide-next-step.js';
import { _resetPromptRegistryForTest, registerAllPromptWriters } from '../../prompts/index.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { TodoSpec } from '../types.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { RequiredFact } from '../fact-gap-types.js';
import type { DiscoveryStep } from '../../content-gen/discovery-plan.js';
import type { DecideLastStepRawOutputs } from '../../prompts/writers/decide-next-step.js';

test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall { readonly messages: LLMMessage[]; readonly opts: CompletionOpts; }
function scriptedProvider(responses: readonly string[]): { provider: LLMProvider; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const provider = {
		name: 'scripted',
		async complete(messages: LLMMessage[], opts: CompletionOpts): Promise<LLMResponse> {
			calls.push({ messages, opts });
			const text = responses[cursor] ?? responses[responses.length - 1] ?? '';
			cursor++;
			return { text, finishReason: 'stop' };
		},
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls };
}

const TODO: TodoSpec = { id: 'todo-x', objective: 'Map INGRN class fields', origin: 'initial' };
const GAPS: readonly RequiredFact[] = [
	{ id: 'ingrn-fields', summary: 'Full list of INGRN fields with types' },
];
const CATALOG: readonly CatalogSkill[] = [
	{ id: 'code.entity.locate-by-name', description: 'locate entity by name', schema: { type: 'object' } },
	{ id: 'code.class.extract-fields',  description: 'extract class fields', schema: { type: 'object' } },
];
const CATALOG_IDS = new Set(CATALOG.map(c => c.id));
const SKETCH: readonly DiscoveryStep[] = [
	{
		id: 'step-1', intent: 'locate INGRN class',
		skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
		targetsCriteria: [0],
	},
];
const LAST_STEP: DecideLastStepRawOutputs = {
	stepId:     'step-1',
	stepIntent: 'locate INGRN class',
	skills: [{
		callId:  's1.a',
		skillId: 'code.entity.locate-by-name',
		context: 'name=INGRN',
		rawText: JSON.stringify({ entityId: 'b209...8442', filePath: '/repo/insors/grn.py' }),
	}],
};

// ---------------------------------------------------------------------------
// Happy paths -- each terminal branch
// ---------------------------------------------------------------------------

test('runDecideNextStep: action=execute-step parses + carries coerced step', async () => {
	const { provider, calls } = scriptedProvider([
		JSON.stringify({
			action: 'execute-step',
			reasoning: 'INGRN located; next step extracts its fields by entityId',
			step: {
				id: 'step-2', intent: 'extract INGRN fields by entityId',
				skills: [{ id: 's2.a', skillId: 'code.class.extract-fields', context: 'entityId from prior step' }],
				targetsCriteria: [0],
			},
		}),
	]);
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: '## TABLE OF CONTENTS\n(no artifacts persisted yet)',
		lastStep: LAST_STEP, provider,
	});
	assert.equal(calls.length, 1);
	assert.equal(r.action, 'execute-step');
	if (r.action === 'execute-step') {
		assert.equal(r.step.id, 'step-2');
		assert.equal(r.step.skills[0]!.skillId, 'code.class.extract-fields');
	}
	assert.equal(r.retried, false);
});

test('runDecideNextStep: action=replan-sketch parses', async () => {
	const { provider } = scriptedProvider([
		JSON.stringify({
			action: 'replan-sketch',
			reasoning: 'locate-by-name returned not-found; the sketch needs a different angle',
		}),
	]);
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: '## TABLE OF CONTENTS', lastStep: LAST_STEP, provider,
	});
	assert.equal(r.action, 'replan-sketch');
	if (r.action === 'replan-sketch') {
		assert.match(r.reasoning, /not-found/);
	}
});

test('runDecideNextStep: action=terminate + verdict=covered parses', async () => {
	const { provider } = scriptedProvider([
		JSON.stringify({
			action: 'terminate',
			verdict: 'covered',
			reasoning: 'every gap has a CLOSES marker in the TOC',
		}),
	]);
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: '## TABLE OF CONTENTS', lastStep: LAST_STEP, provider,
	});
	assert.equal(r.action, 'terminate');
	if (r.action === 'terminate') { assert.equal(r.verdict, 'covered'); }
});

test('runDecideNextStep: action=terminate + verdict=unrecoverable parses', async () => {
	const { provider } = scriptedProvider([
		JSON.stringify({
			action: 'terminate',
			verdict: 'unrecoverable',
			reasoning: 'no skill in the catalog can close the remaining gaps',
		}),
	]);
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: '## TABLE OF CONTENTS', lastStep: LAST_STEP, provider,
	});
	assert.equal(r.action, 'terminate');
	if (r.action === 'terminate') { assert.equal(r.verdict, 'unrecoverable'); }
});

// ---------------------------------------------------------------------------
// First-turn behaviour (no last step)
// ---------------------------------------------------------------------------

test('runDecideNextStep: first turn (no lastStep) passes through', async () => {
	const { provider } = scriptedProvider([
		JSON.stringify({
			action: 'execute-step',
			reasoning: 'starting with the sketch\'s first step',
			step: {
				id: 'step-1', intent: 'locate INGRN by name',
				skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
				targetsCriteria: [0],
			},
		}),
	]);
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: '## TABLE OF CONTENTS', lastStep: undefined, provider,
	});
	assert.equal(r.action, 'execute-step');
});

// ---------------------------------------------------------------------------
// Retry path
// ---------------------------------------------------------------------------

test('runDecideNextStep: malformed first attempt -> retry succeeds, retried=true', async () => {
	const { provider, calls } = scriptedProvider([
		'not json',
		JSON.stringify({
			action: 'terminate', verdict: 'covered',
			reasoning: 'on retry I see everything is covered',
		}),
	]);
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: '## TABLE OF CONTENTS', lastStep: undefined, provider,
	});
	assert.equal(calls.length, 2);
	assert.equal(r.retried, true);
	assert.match(r.firstFailureReason ?? '', /JSON parse failed/);
	assert.match(calls[1]!.messages[1]!.content, /RETRY CORRECTION/);
});

test('runDecideNextStep: both attempts malformed -> throws', async () => {
	const { provider } = scriptedProvider(['bad', 'still bad']);
	await assert.rejects(
		() => runDecideNextStep({
			todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
			toc: '## TABLE OF CONTENTS', lastStep: undefined, provider,
		}),
		/decide-next-step validation failed after retry/,
	);
});

// ---------------------------------------------------------------------------
// parse() direct rejection branches
// ---------------------------------------------------------------------------

test('parse: action not in enum -> rejected', () => {
	const r = parse(JSON.stringify({ action: 'invent-it', reasoning: 'no' }), CATALOG_IDS, 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /not one of/); }
});

test('parse: reasoning missing -> rejected', () => {
	const r = parse(JSON.stringify({ action: 'terminate', verdict: 'covered' }), CATALOG_IDS, 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /reasoning/); }
});

test('parse: action=execute-step but step missing -> rejected', () => {
	const r = parse(JSON.stringify({ action: 'execute-step', reasoning: 'noop' }), CATALOG_IDS, 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /step.*object/); }
});

test('parse: action=execute-step but step fails coerceStep -> rejected', () => {
	const r = parse(JSON.stringify({
		action: 'execute-step', reasoning: 'noop',
		step: { id: 'step-1', intent: 'too short', skills: [{ id: 's1.a', skillId: 'fake.skill', context: 'x' }], targetsCriteria: [0] },
	}), CATALOG_IDS, 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /SKILL CATALOG/); }
});

test('parse: action=terminate but verdict missing -> rejected', () => {
	const r = parse(JSON.stringify({ action: 'terminate', reasoning: 'no verdict' }), CATALOG_IDS, 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /verdict.*string/); }
});

test('parse: action=terminate but verdict not in enum -> rejected', () => {
	const r = parse(JSON.stringify({ action: 'terminate', verdict: 'kinda-covered', reasoning: 'meh' }), CATALOG_IDS, 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /covered.*unrecoverable/); }
});

test('parse: tolerates markdown fences', () => {
	const fenced = '```json\n' + JSON.stringify({
		action: 'terminate', verdict: 'covered', reasoning: 'covered',
	}) + '\n```';
	const r = parse(fenced, CATALOG_IDS, 1);
	assert.equal(r.ok, true);
});

test('stripFences: strips fences correctly', () => {
	assert.equal(stripFences('```json\n{}\n```'), '{}');
	assert.equal(stripFences('  {}  '), '{}');
});
