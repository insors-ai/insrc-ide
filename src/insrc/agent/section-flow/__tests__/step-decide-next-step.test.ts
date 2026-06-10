/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for runDecideNextStep -- Phase 4 of
 * plans/section-flow-architecture-redesign.md.
 *
 * Covers each terminal-branch of the decision union:
 *
 *   - execute-step: `step` validates via the shared coerceStep; result
 *     carries the parsed DiscoveryStep.
 *   - replan-sketch: action passes through with reasoning.
 *   - terminate: `verdict` is one of `covered` / `unrecoverable`.
 *
 * Plus:
 *
 *   - First-turn behaviour: `lastStep: undefined` -> empty
 *     `lastStepSummaries`, no error.
 *   - Second-turn behaviour: `lastStep` supplied + valid summaries ->
 *     summaries surfaced on result.
 *   - Unknown callId in lastStepArtifactSummary -> silently dropped.
 *   - Retry path: malformed first attempt -> corrective hint retry
 *     succeeds; retried=true.
 *   - Both attempts fail -> throws.
 *   - Validator: every rejection branch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runDecideNextStep,
	_parseForTest                    as parse,
	_stripFencesForTest              as stripFences,
	_extractLastStepSummariesForTest as extractLastStepSummaries,
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
		supportsTools: true,
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out at call ${cursor + 1}`);
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

const TODO: TodoSpec = { id: 'todo-x', objective: 'Map GRN JSON to INGRN class', origin: 'initial' };

const CATALOG: readonly CatalogSkill[] = [
	{ id: 'code.entity.locate-by-name', description: 'locate', family: 'entity', owner: 'code-analyzer', inputs: {}, outputPaths: [] },
	{ id: 'code.class.extract-fields',  description: 'extract', family: 'class', owner: 'code-analyzer', inputs: {}, outputPaths: [] },
];
const CATALOG_IDS = new Set(CATALOG.map(c => c.id));

const GAPS: readonly RequiredFact[] = [
	{ id: 'ingrn-fields', fact: 'INGRN field list', why: 'baseline', status: 'absent' },
	{ id: 'json-shape',   fact: 'GRN JSON shape',   why: 'data',     status: 'absent' },
];

const SKETCH: readonly DiscoveryStep[] = [
	{ id: 'step-1', intent: 'locate INGRN by name',
	  skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
	  targetsCriteria: [0] },
];

const LAST_STEP: DecideLastStepRawOutputs = {
	stepId:     'step-1',
	stepIntent: 'locate INGRN by name',
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
			lastStepArtifactSummary: {
				's1.a': 'located INGRN at insors/grn.py, entityId b209...8442. PARTIALLY supports ingrn-fields',
			},
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
		assert.match(r.lastStepSummaries['s1.a'] ?? '', /PARTIALLY supports/);
	}
	assert.equal(r.retried, false);
});

test('runDecideNextStep: action=replan-sketch parses', async () => {
	const { provider } = scriptedProvider([
		JSON.stringify({
			action: 'replan-sketch',
			reasoning: 'locate-by-name returned not-found; the sketch needs a different angle',
			lastStepArtifactSummary: { 's1.a': 'INGRN not located. OFF-TOPIC' },
		}),
	]);
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: '## TABLE OF CONTENTS', lastStep: LAST_STEP, provider,
	});
	assert.equal(r.action, 'replan-sketch');
	if (r.action === 'replan-sketch') {
		assert.match(r.reasoning, /not-found/);
		assert.equal(r.lastStepSummaries['s1.a'], 'INGRN not located. OFF-TOPIC');
	}
});

test('runDecideNextStep: action=terminate + verdict=covered parses', async () => {
	const { provider } = scriptedProvider([
		JSON.stringify({
			action: 'terminate',
			verdict: 'covered',
			reasoning: 'every gap has a CLOSES marker in the TOC',
			lastStepArtifactSummary: {
				's1.a': 'INGRN has 21 fields. CLOSES ingrn-fields fully',
			},
		}),
	]);
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: '## TABLE OF CONTENTS', lastStep: LAST_STEP, provider,
	});
	assert.equal(r.action, 'terminate');
	if (r.action === 'terminate') {
		assert.equal(r.verdict, 'covered');
	}
});

test('runDecideNextStep: action=terminate + verdict=unrecoverable parses', async () => {
	const { provider } = scriptedProvider([
		JSON.stringify({
			action: 'terminate',
			verdict: 'unrecoverable',
			reasoning: 'no skill in the catalog can close the remaining gaps',
			lastStepArtifactSummary: { 's1.a': 'attempted nothing useful. OFF-TOPIC' },
		}),
	]);
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: '## TABLE OF CONTENTS', lastStep: LAST_STEP, provider,
	});
	assert.equal(r.action, 'terminate');
	if (r.action === 'terminate') {
		assert.equal(r.verdict, 'unrecoverable');
	}
});

// ---------------------------------------------------------------------------
// First-turn behaviour (no last step)
// ---------------------------------------------------------------------------

test('runDecideNextStep: first turn (no lastStep) -> empty summaries, action passes through', async () => {
	const { provider } = scriptedProvider([
		JSON.stringify({
			action: 'execute-step',
			reasoning: 'starting with the sketch\'s first step',
			lastStepArtifactSummary: {},
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
	assert.deepEqual(r.lastStepSummaries, {});
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
			lastStepArtifactSummary: {},
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
// extractLastStepSummaries lenient handling
// ---------------------------------------------------------------------------

test('extractLastStepSummaries: unknown callId dropped silently', () => {
	const valid = new Set(['s1.a']);
	const out = extractLastStepSummaries({
		's1.a':       'CLOSES ingrn-fields fully',
		's1.unknown': 'invented call',
	}, valid);
	assert.deepEqual(Object.keys(out).sort(), ['s1.a']);
});

test('extractLastStepSummaries: non-object input -> empty', () => {
	assert.deepEqual(extractLastStepSummaries(undefined, new Set()), {});
	assert.deepEqual(extractLastStepSummaries('string', new Set()), {});
	assert.deepEqual(extractLastStepSummaries(['array', 'value'], new Set()), {});
});

test('extractLastStepSummaries: empty / non-string values dropped', () => {
	const valid = new Set(['s1.a', 's1.b']);
	const out = extractLastStepSummaries({
		's1.a': '',
		's1.b': 42,
	}, valid);
	assert.deepEqual(out, {});
});

// ---------------------------------------------------------------------------
// parse() direct rejection branches
// ---------------------------------------------------------------------------

test('parse: action not in enum -> rejected', () => {
	const r = parse(JSON.stringify({ action: 'invent-it', reasoning: 'no', lastStepArtifactSummary: {} }), CATALOG_IDS, 1, new Set());
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /not one of/); }
});

test('parse: reasoning missing -> rejected', () => {
	const r = parse(JSON.stringify({ action: 'terminate', verdict: 'covered', lastStepArtifactSummary: {} }), CATALOG_IDS, 1, new Set());
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /reasoning/); }
});

test('parse: action=execute-step but step missing -> rejected', () => {
	const r = parse(JSON.stringify({ action: 'execute-step', reasoning: 'noop' }), CATALOG_IDS, 1, new Set());
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /step.*object/); }
});

test('parse: action=execute-step but step fails coerceStep -> rejected', () => {
	const r = parse(JSON.stringify({
		action: 'execute-step', reasoning: 'noop',
		step: { id: 'step-1', intent: 'too short' /* len=9, ok */, skills: [{ id: 's1.a', skillId: 'fake.skill', context: 'x' }], targetsCriteria: [0] },
	}), CATALOG_IDS, 1, new Set());
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /SKILL CATALOG/); }
});

test('parse: action=terminate but verdict missing -> rejected', () => {
	const r = parse(JSON.stringify({ action: 'terminate', reasoning: 'no verdict' }), CATALOG_IDS, 1, new Set());
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /verdict.*string/); }
});

test('parse: action=terminate but verdict not in enum -> rejected', () => {
	const r = parse(JSON.stringify({ action: 'terminate', verdict: 'kinda-covered', reasoning: 'meh' }), CATALOG_IDS, 1, new Set());
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /covered.*unrecoverable/); }
});

test('parse: tolerates markdown fences', () => {
	const fenced = '```json\n' + JSON.stringify({
		action: 'terminate', verdict: 'covered', reasoning: 'covered',
		lastStepArtifactSummary: {},
	}) + '\n```';
	const r = parse(fenced, CATALOG_IDS, 1, new Set());
	assert.equal(r.ok, true);
});

test('stripFences: strips fences correctly', () => {
	assert.equal(stripFences('```json\n{}\n```'), '{}');
	assert.equal(stripFences('  {}  '), '{}');
});
