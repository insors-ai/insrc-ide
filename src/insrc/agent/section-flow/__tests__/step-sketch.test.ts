/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for runSketch -- Phase 4 of
 * plans/section-flow-architecture-redesign.md.
 *
 * Covers:
 *
 *   - Happy path: 3-step sketch validates; coerced steps preserve id +
 *     skillId + targetsCriteria verbatim.
 *   - Partial validity: bad entries DROPPED with warn, valid ones
 *     retained, droppedStepIds reported.
 *   - Retry path: first attempt malformed; retry succeeds; retried=true
 *     and firstFailureReason carries the original reason.
 *   - Throws when both attempts fail validation.
 *   - Validator rejection branches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runSketch,
	_parseAndCoerceForTest as parseAndCoerce,
	_MAX_STEPS             as MAX_STEPS,
} from '../step-sketch.js';
import { _resetPromptRegistryForTest, registerAllPromptWriters } from '../../prompts/index.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { TodoSpec } from '../types.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { RequiredFact } from '../fact-gap-types.js';

test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall { readonly messages: LLMMessage[]; readonly opts: CompletionOpts; readonly schema: unknown; }
// plans/structured-output.md Phase C.5. The sketch call now flows via
// provider.completeStructured. Malformed text is replayed as `{}` so
// the application-level retry path still exercises the same shape.
function scriptedProvider(responses: readonly string[]): { provider: LLMProvider; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const provider = {
		supportsTools: true,
		capabilities: {
			structuredOutput: true, toolCalling: true, vision: false,
			webSearch: false, streaming: false, embeddings: false,
		},
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts, schema: undefined });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			return { text, stopReason: 'end_turn' };
		},
		async completeStructured<T>(messages: LLMMessage[], schema: unknown, opts: CompletionOpts = {}): Promise<T> {
			calls.push({ messages, opts, schema });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			try { return JSON.parse(text) as T; }
			catch { return {} as T; }
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls };
}

const TODO: TodoSpec = { id: 'todo-x', objective: 'Map GRN JSON to INGRN class', origin: 'initial' };
const CATALOG: readonly CatalogSkill[] = [
	{ id: 'code.entity.locate-by-name',    description: 'locate', family: 'entity', owner: 'code-analyzer', inputs: {}, outputPaths: [] },
	{ id: 'code.class.extract-fields',     description: 'extract', family: 'class', owner: 'code-analyzer', inputs: {}, outputPaths: [] },
	{ id: 'data.source.file.sample-shape', description: 'sample', family: 'source', owner: 'data-analyzer', inputs: {}, outputPaths: [] },
];
const GAPS: readonly RequiredFact[] = [
	{ id: 'ingrn-fields', fact: 'INGRN field list', why: 'baseline', status: 'absent' },
	{ id: 'json-shape',   fact: 'GRN JSON shape',   why: 'data',     status: 'absent' },
];

const VALID_SKETCH = JSON.stringify({
	steps: [
		{ id: 'step-1', intent: 'locate INGRN by name in the repo',
		  skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
		  targetsCriteria: [0] },
		{ id: 'step-2', intent: 'extract INGRN fields by entityId',
		  skills: [{ id: 's2.a', skillId: 'code.class.extract-fields', context: 'use s1.a entityId', dependsOn: 'step-1.s1.a' }],
		  targetsCriteria: [0] },
		{ id: 'step-3', intent: 'sample GRN JSON shape',
		  skills: [{ id: 's3.a', skillId: 'data.source.file.sample-shape', context: 'path=grn-basic.json' }],
		  targetsCriteria: [1] },
	],
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('runSketch: 3-step sketch validates; ids + skillIds + targetsCriteria preserved', async () => {
	const { provider, calls } = scriptedProvider([VALID_SKETCH]);
	const r = await runSketch({ todo: TODO, gapFacts: GAPS, catalog: CATALOG, provider });
	assert.equal(calls.length, 1);
	assert.equal(r.retried, false);
	assert.equal(r.steps.length, 3);
	assert.equal(r.steps[0]!.id, 'step-1');
	assert.equal(r.steps[1]!.skills[0]!.dependsOn, 'step-1.s1.a');
	assert.deepEqual(r.steps[2]!.targetsCriteria, [1]);
});

// ---------------------------------------------------------------------------
// Retry path
// ---------------------------------------------------------------------------

test('runSketch: first attempt fails app invariant -> retry succeeds, retried=true', async () => {
	// plans/structured-output.md Phase C.5. The wire layer guarantees JSON
	// parseability before parseAndCoerce sees the value; the realistic
	// first-attempt failure is now a schema-conformant-but-app-invariant
	// failing object. `'not even json'` becomes `{}` in the mock, which
	// fails the "`steps` must be an array" check.
	const { provider, calls } = scriptedProvider([
		'not even json',
		VALID_SKETCH,
	]);
	const r = await runSketch({ todo: TODO, gapFacts: GAPS, catalog: CATALOG, provider });
	assert.equal(calls.length, 2);
	assert.equal(r.retried, true);
	assert.equal(r.steps.length, 3);
	assert.match(r.firstFailureReason ?? '', /must be an array/);
	assert.match(calls[1]!.messages[1]!.content, /RETRY CORRECTION/);
});

test('runSketch: both attempts fail invariant -> throws', async () => {
	const { provider } = scriptedProvider(['still not json', 'still not json']);
	await assert.rejects(
		() => runSketch({ todo: TODO, gapFacts: GAPS, catalog: CATALOG, provider }),
		/sketch validation failed after retry/,
	);
});

// ---------------------------------------------------------------------------
// Partial validity
// ---------------------------------------------------------------------------

test('runSketch: drops invalid entries, keeps valid ones, reports droppedStepIds', async () => {
	const partial = JSON.stringify({
		steps: [
			{ id: 'step-1', intent: 'locate INGRN by name',
			  skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
			  targetsCriteria: [0] },
			// unknown skill -> dropped
			{ id: 'step-2', intent: 'extract via a hallucinated skill',
			  skills: [{ id: 's2.a', skillId: 'fake.skill', context: 'x' }],
			  targetsCriteria: [0] },
			// empty targetsCriteria -> dropped
			{ id: 'step-3', intent: 'sample with no targets declared',
			  skills: [{ id: 's3.a', skillId: 'code.class.extract-fields', context: 'x' }],
			  targetsCriteria: [] },
		],
	});
	const { provider } = scriptedProvider([partial]);
	const r = await runSketch({ todo: TODO, gapFacts: GAPS, catalog: CATALOG, provider });
	assert.equal(r.steps.length, 1);
	assert.equal(r.steps[0]!.id, 'step-1');
	assert.deepEqual([...r.droppedStepIds].sort(), ['step-2', 'step-3']);
});

// ---------------------------------------------------------------------------
// parseAndCoerce direct tests
// ---------------------------------------------------------------------------

const CATALOG_IDS = new Set(CATALOG.map(c => c.id));

test('parseAndCoerce: empty steps array -> rejected', () => {
	const r = parseAndCoerce({ steps: [] }, CATALOG_IDS, 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /empty/); }
});

test('parseAndCoerce: steps not an array -> rejected', () => {
	const r = parseAndCoerce({ steps: 'one' }, CATALOG_IDS, 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /must be an array/); }
});

test('parseAndCoerce: exceeds MAX_STEPS -> rejected', () => {
	const big = Array.from({ length: MAX_STEPS + 1 }, (_, i) => ({
		id: `step-${i}`, intent: 'pad',
		skills: [{ id: `s${i}.a`, skillId: 'code.entity.locate-by-name', context: 'name=x' }],
		targetsCriteria: [0],
	}));
	const r = parseAndCoerce({ steps: big }, CATALOG_IDS, 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /cap is/); }
});

test('parseAndCoerce: duplicate step ids -> drops the duplicate', () => {
	const r = parseAndCoerce({
		steps: [
			{ id: 'step-1', intent: 'first one',
			  skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
			  targetsCriteria: [0] },
			{ id: 'step-1', intent: 'duplicate id',
			  skills: [{ id: 's2.a', skillId: 'code.class.extract-fields', context: 'x' }],
			  targetsCriteria: [0] },
		],
	}, CATALOG_IDS, 1);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.steps.length, 1);
		assert.equal(r.droppedStepIds.length, 1);
	}
});

test('parseAndCoerce: every entry fails coercion -> rejected', () => {
	const r = parseAndCoerce({
		steps: [
			{ id: 'step-1', intent: 'unknown', skills: [{ id: 's1.a', skillId: 'fake', context: 'x' }], targetsCriteria: [0] },
		],
	}, CATALOG_IDS, 1);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /nothing usable/); }
});
