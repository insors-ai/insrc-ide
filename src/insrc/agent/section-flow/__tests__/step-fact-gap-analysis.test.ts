/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase beta tests for runFactGapAnalysis -- Stage 0 of the fact-gap
 * loop. Scripted-provider tests covering:
 *
 *   - Happy path: well-formed analysis with mixed statuses validates first try
 *   - Trivial fast-path: all-present analysis validates + isTrivialFastPath=true
 *   - Retry path: first attempt missing required field, retry validates
 *   - Throw path: both attempts fail -> rejects with reason
 *   - Schema-prompted call opts (responseFormat.schema, temperature 0, disableThinking)
 *   - Prompt structure carries TODO objective + memory + catalog summary
 *   - validate() rejects: missing reasoning, empty requiredFacts, too many facts,
 *     duplicate ids, missing sourceRef for present/partial, all-unknown
 *     suggestedSkills for absent fact
 *   - coerceRequiredFact handles sourceRef shapes for memory-layer vs prior-todo
 *   - renderCatalogSummary respects empty + non-empty catalog
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runFactGapAnalysis,
	_validateForTest               as validate,
	_coerceRequiredFactForTest     as coerceRequiredFact,
	_renderCatalogSummaryForTest   as renderCatalogSummary,
} from '../step-fact-gap-analysis.js';
import { isTrivialFastPath } from '../fact-gap-types.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { TodoSpec } from '../types.js';
import type { MemoryShapeBundle } from '../../working-memory/index.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall {
	readonly messages: LLMMessage[];
	readonly opts:     CompletionOpts;
}

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

function makeTodo(overrides: Partial<TodoSpec> = {}): TodoSpec {
	return {
		id:        overrides.id        ?? 'todo-grn-mapping',
		objective: overrides.objective ?? 'Map JSON GRN fixtures to the Pydantic INGRN class fields.',
		origin:    overrides.origin    ?? 'initial',
	};
}

function makeMemory(overrides: Partial<MemoryShapeBundle> = {}): MemoryShapeBundle {
	return {
		system:   overrides.system   ?? 'You analyze data structures against schema definitions.',
		summary:  overrides.summary  ?? 'Investigation comparing JSON fixtures to INGRN class.',
		recent:   overrides.recent   ?? '- prior todo found INGRN file at insors/.../grn.py',
		semantic: overrides.semantic ?? '',
		code:     overrides.code     ?? '',
	};
}

function makeCatalog(): readonly CatalogSkill[] {
	return [
		{ id: 'code.class.extract-fields',         description: 'Extract field defs from a Python class', family: 'class',   owner: 'code-analyzer', inputs: {}, outputPaths: [] },
		{ id: 'code.entity.locate-by-name',        description: 'Locate code entities by name',          family: 'entity',  owner: 'code-analyzer', inputs: {}, outputPaths: [] },
		{ id: 'data.source.file.sample-shape',     description: 'Sample a file and emit shape',          family: 'source',  owner: 'data-analyzer', inputs: {}, outputPaths: [] },
		{ id: 'shared.compare.fields-vs-shape',    description: 'Compare class fields vs data shape',    family: 'compare', owner: 'shared',        inputs: {}, outputPaths: [] },
	];
}

const HEALTHY_ANALYSIS_JSON = JSON.stringify({
	reasoning: 'Need class fields + data shape; alignment then synthesis.',
	requiredFacts: [
		{ id: 'ingrn-fields',  fact: 'INGRN field list with types',  why: 'baseline for the mapping table',   status: 'absent',
		  suggestedSkills: ['code.class.extract-fields'] },
		{ id: 'json-shape',    fact: 'GRN JSON top-level shape',     why: 'data side of the mapping',         status: 'absent',
		  suggestedSkills: ['data.source.file.sample-shape'] },
		{ id: 'class-location',fact: 'INGRN file path',              why: 'pre-req for extract-fields',       status: 'present',
		  sourceRef: { kind: 'memory-layer', layer: 'recent', excerpt: 'INGRN at insors/.../grn.py' } },
	],
});

const ALL_PRESENT_JSON = JSON.stringify({
	reasoning: 'Memory has everything; trivial.',
	requiredFacts: [
		{ id: 'a', fact: 'fact A', why: 'because', status: 'present',
		  sourceRef: { kind: 'memory-layer', layer: 'summary', excerpt: '...' } },
		{ id: 'b', fact: 'fact B', why: 'because', status: 'present',
		  sourceRef: { kind: 'prior-todo', todoId: 'todo-1', excerpt: '...' } },
	],
});

const MISSING_REASONING_JSON = JSON.stringify({
	requiredFacts: [
		{ id: 'a', fact: 'x', why: 'y', status: 'absent', suggestedSkills: ['code.class.extract-fields'] },
	],
});

const EMPTY_FACTS_JSON = JSON.stringify({
	reasoning: 'no facts identified',
	requiredFacts: [],
});

const DUPE_IDS_JSON = JSON.stringify({
	reasoning: 'r',
	requiredFacts: [
		{ id: 'a', fact: 'x', why: 'y', status: 'absent', suggestedSkills: ['code.class.extract-fields'] },
		{ id: 'a', fact: 'z', why: 'w', status: 'absent', suggestedSkills: ['code.class.extract-fields'] },
	],
});

const PRESENT_NO_SOURCEREF_JSON = JSON.stringify({
	reasoning: 'r',
	requiredFacts: [
		{ id: 'a', fact: 'x', why: 'y', status: 'present' },
	],
});

const UNKNOWN_SKILLS_JSON = JSON.stringify({
	reasoning: 'r',
	requiredFacts: [
		{ id: 'a', fact: 'x', why: 'y', status: 'absent', suggestedSkills: ['not.a.real.skill', 'another.fake'] },
	],
});

// ---------------------------------------------------------------------------
// End-to-end via runFactGapAnalysis
// ---------------------------------------------------------------------------

test('runFactGapAnalysis: happy path -> retried=false, 3 facts parsed', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_ANALYSIS_JSON]);
	const result = await runFactGapAnalysis({
		todo: makeTodo(), memory: makeMemory(), catalog: makeCatalog(), provider,
	});
	assert.equal(calls.length, 1);
	assert.equal(result.retried, false);
	assert.equal(result.analysis.requiredFacts.length, 3);
	assert.deepEqual(
		result.analysis.requiredFacts.map(f => f.status).sort(),
		['absent', 'absent', 'present'],
	);
});

test('runFactGapAnalysis: trivial fast-path -> isTrivialFastPath true', async () => {
	const { provider } = scriptedProvider([ALL_PRESENT_JSON]);
	const result = await runFactGapAnalysis({
		todo: makeTodo(), memory: makeMemory(), catalog: makeCatalog(), provider,
	});
	assert.equal(isTrivialFastPath(result.analysis), true);
});

test('runFactGapAnalysis: retry path -> first attempt missing reasoning, retry passes', async () => {
	const { provider, calls } = scriptedProvider([MISSING_REASONING_JSON, HEALTHY_ANALYSIS_JSON]);
	const result = await runFactGapAnalysis({
		todo: makeTodo(), memory: makeMemory(), catalog: makeCatalog(), provider,
	});
	assert.equal(calls.length, 2);
	assert.equal(result.retried, true);
	assert.match(result.firstFailureReason ?? '', /reasoning.*missing/);
	// Retry message carries the corrective hint.
	assert.match(calls[1]!.messages[1]!.content, /RETRY CORRECTION/);
});

test('runFactGapAnalysis: both attempts fail -> throws with reason', async () => {
	const { provider } = scriptedProvider([MISSING_REASONING_JSON, MISSING_REASONING_JSON]);
	await assert.rejects(
		() => runFactGapAnalysis({ todo: makeTodo(), memory: makeMemory(), catalog: makeCatalog(), provider }),
		/fact-gap analysis validation failed after retry/,
	);
});

test('runFactGapAnalysis: call opts -- temperature 0, disableThinking, schema-pinned responseFormat', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_ANALYSIS_JSON]);
	await runFactGapAnalysis({ todo: makeTodo(), memory: makeMemory(), catalog: makeCatalog(), provider });
	assert.equal(calls[0]!.opts.temperature, 0);
	assert.equal(calls[0]!.opts.disableThinking, true);
	const rf = calls[0]!.opts.responseFormat;
	assert.ok(rf !== undefined && typeof rf === 'object' && 'schema' in rf);
});

test('runFactGapAnalysis: prompt carries TODO objective + memory + catalog summary', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_ANALYSIS_JSON]);
	await runFactGapAnalysis({
		todo:    makeTodo({ objective: 'unique-objective-text-for-prompt-check' }),
		memory:  makeMemory({ recent: 'memory-line-marker-xyz' }),
		catalog: makeCatalog(),
		provider,
	});
	const user = calls[0]!.messages[1]!.content;
	assert.match(user, /## TODO OBJECTIVE/);
	assert.match(user, /unique-objective-text-for-prompt-check/);
	assert.match(user, /## WORKING MEMORY/);
	assert.match(user, /memory-line-marker-xyz/);
	assert.match(user, /## SKILL CATALOG \(4 skills available\)/);
	assert.match(user, /code\.class\.extract-fields/);
});

// ---------------------------------------------------------------------------
// validate() — direct tests
// ---------------------------------------------------------------------------

test('validate: rejects empty requiredFacts', () => {
	const ids = new Set(['code.class.extract-fields']);
	const r = validate(EMPTY_FACTS_JSON, ids);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /at least one entry/); }
});

test('validate: rejects duplicate fact ids', () => {
	const ids = new Set(['code.class.extract-fields']);
	const r = validate(DUPE_IDS_JSON, ids);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /duplicates an earlier fact/); }
});

test('validate: rejects present/partial fact missing sourceRef', () => {
	const ids = new Set(['code.class.extract-fields']);
	const r = validate(PRESENT_NO_SOURCEREF_JSON, ids);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /requires sourceRef/); }
});

test('validate: rejects absent fact whose suggestedSkills are all unknown ids', () => {
	const ids = new Set(['code.class.extract-fields']);
	const r = validate(UNKNOWN_SKILLS_JSON, ids);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /none in catalog/); }
});

test('validate: rejects more than 12 requiredFacts', () => {
	const factsArr: Record<string, unknown>[] = [];
	for (let i = 0; i < 13; i++) {
		factsArr.push({ id: `f${i}`, fact: `x${i}`, why: 'y', status: 'absent', suggestedSkills: ['code.class.extract-fields'] });
	}
	const json = JSON.stringify({ reasoning: 'r', requiredFacts: factsArr });
	const r = validate(json, new Set(['code.class.extract-fields']));
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /cap is 12/); }
});

test('validate: accepts mixed sourceRef shapes (memory-layer + prior-todo)', () => {
	// Catalog must include every suggested skill in HEALTHY_ANALYSIS_JSON so
	// the suggestedSkills-membership check passes for the absent facts.
	const ids = new Set(['code.class.extract-fields', 'data.source.file.sample-shape']);
	const r = validate(HEALTHY_ANALYSIS_JSON, ids);
	assert.equal(r.ok, true);
	if (r.ok) {
		const present = r.analysis.requiredFacts.find(f => f.status === 'present');
		assert.ok(present?.sourceRef);
		assert.equal(present.sourceRef.kind, 'memory-layer');
	}
});

// ---------------------------------------------------------------------------
// coerceRequiredFact — edge cases
// ---------------------------------------------------------------------------

test('coerceRequiredFact: prior-todo sourceRef without todoId -> error', () => {
	const ids = new Set(['code.class.extract-fields']);
	const r = coerceRequiredFact({
		id: 'a', fact: 'x', why: 'y', status: 'present',
		sourceRef: { kind: 'prior-todo' },
	}, 0, ids);
	assert.equal(typeof r, 'string');
	if (typeof r === 'string') { assert.match(r, /todoId missing for prior-todo/); }
});

test('coerceRequiredFact: filters unknown suggested skills, keeps known when at least one valid', () => {
	const ids = new Set(['code.class.extract-fields']);
	const r = coerceRequiredFact({
		id: 'a', fact: 'x', why: 'y', status: 'absent',
		suggestedSkills: ['code.class.extract-fields', 'not.real'],
	}, 0, ids);
	assert.notEqual(typeof r, 'string');
	if (typeof r !== 'string') {
		assert.deepEqual(r.suggestedSkills, ['code.class.extract-fields']);
	}
});

// ---------------------------------------------------------------------------
// renderCatalogSummary
// ---------------------------------------------------------------------------

test('renderCatalogSummary: empty catalog -> placeholder header', () => {
	assert.match(renderCatalogSummary([]), /SKILL CATALOG \(empty\)/);
});

test('renderCatalogSummary: lists skills with truncated descriptions', () => {
	const longDesc = 'x'.repeat(200);
	const out = renderCatalogSummary([
		{ id: 'a.b', description: longDesc, family: 'f', owner: 'o', inputs: {}, outputPaths: [] },
	]);
	assert.match(out, /^## SKILL CATALOG \(1 skills available\)/);
	assert.match(out, /`a\.b`/);
	// Description truncated to 120 chars.
	assert.ok(out.length < 200);
});
