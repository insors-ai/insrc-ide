/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase delta tests for executeDiscoveryStep (Stage 2 adapter).
 *
 * Mock executeLeaf + scripted summarizer provider. Covers:
 *
 *   - Happy path: 2 calls, both succeed, status='ok', facts aggregated
 *   - Partial: one call returns empty, status='partial'
 *   - Failed: every call returns empty, status='failed'
 *   - Empty skills: status='failed' (executedCount=0)
 *   - executeLeaf throws -> treated as empty (no abort), status reflects
 *   - summarizeResult throws -> call's facts skipped but step continues
 *   - dependsOn wiring: earlier call's output is in the priorOutputs map
 *     when later call dispatches (verified via mock recording priors)
 *   - Citation parsing: path:foo.ts#L1-L20 -> structured Citation
 *   - deriveStatus / parseCitationString unit tests
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	executeDiscoveryStep,
	_makeSyntheticLeafForTest    as makeSyntheticLeaf,
	_deriveStatusForTest         as deriveStatus,
	_parseCitationStringForTest  as parseCitationString,
} from '../step-discovery-execute.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { TodoSpec } from '../types.js';
import type { DiscoveryStep, PlannedSkillCall } from '../../content-gen/discovery-plan.js';
import type { ExecuteLeaf, LeafExecutionInput } from '../leaf-executor.js';
import type { RequiredFact } from '../fact-gap-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface LeafRecord {
	readonly leafId:       string;
	readonly skill:        string;
	readonly objective:    string;
	readonly priorOutputs: Readonly<Record<string, string>>;
}

function mockLeafExecutor(returnsByLeafId: Readonly<Record<string, string | Error>>): {
	executeLeaf: ExecuteLeaf;
	calls: LeafRecord[];
} {
	const calls: LeafRecord[] = [];
	const executeLeaf: ExecuteLeaf = async (input: LeafExecutionInput): Promise<string> => {
		const rec: LeafRecord = {
			leafId:       input.leaf.id,
			skill:        input.leaf.skill ?? '',
			objective:    input.leaf.objective ?? '',
			priorOutputs: { ...input.priorOutputs },
		};
		calls.push(rec);
		const ret = returnsByLeafId[input.leaf.id];
		if (ret instanceof Error) { throw ret; }
		return ret ?? '';
	};
	return { executeLeaf, calls };
}

function scriptedSummarizer(responses: readonly string[]): { provider: LLMProvider; calls: { readonly messages: LLMMessage[]; readonly opts: CompletionOpts }[] } {
	const calls: { readonly messages: LLMMessage[]; readonly opts: CompletionOpts }[] = [];
	let cursor = 0;
	const provider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts });
			if (cursor >= responses.length) {
				throw new Error(`scriptedSummarizer: ran out of responses at call ${cursor + 1}`);
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

function summary(facts: readonly string[], citations: readonly string[], confidence: 'high' | 'medium' | 'low' = 'high'): string {
	return JSON.stringify({ facts, citations, confidence });
}

function makeStep(skills: readonly PlannedSkillCall[]): DiscoveryStep {
	return {
		id:              'step-1',
		intent:          'investigate something concrete',
		skills,
		targetsCriteria: [0],
	};
}

const TODO: TodoSpec = { id: 'todo-x', objective: 'map GRN JSON to INGRN class', origin: 'initial' };
const GAP_FACTS: readonly RequiredFact[] = [
	{ id: 'ingrn-fields', fact: 'INGRN field list', why: 'baseline', status: 'absent' },
];

// ---------------------------------------------------------------------------
// Happy path / status derivation
// ---------------------------------------------------------------------------

test('executeDiscoveryStep: 2 calls both succeed -> status ok, facts aggregated', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'use locate result', dependsOn: 's1.a' },
	]);
	const { executeLeaf } = mockLeafExecutor({
		's1.a': 'INGRN located at insors/.../grn.py:40',
		's1.b': 'INGRN has 21 fields',
	});
	const { provider } = scriptedSummarizer([
		summary(['fact A'], ['path:insors/.../grn.py#L40']),
		summary(['fact B'], []),
	]);

	const result = await executeDiscoveryStep({
		step,
		priorOutputs: {},
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf, summarizeProvider: provider },
	});
	assert.equal(result.output.status, 'ok');
	assert.deepEqual([...result.output.facts].sort(), ['fact A', 'fact B']);
	assert.equal(result.output.citations.length, 1);
	assert.equal(result.output.citations[0]!.path, 'insors/.../grn.py');
	assert.equal(result.output.citations[0]!.startLine, 40);
});

test('executeDiscoveryStep: one empty result -> status partial', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'X' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'Y' },
	]);
	const { executeLeaf } = mockLeafExecutor({
		's1.a': 'a result',
		's1.b': '',   // empty
	});
	const { provider } = scriptedSummarizer([summary(['fact A'], [])]);

	const result = await executeDiscoveryStep({
		step,
		priorOutputs: {},
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf, summarizeProvider: provider },
	});
	assert.equal(result.output.status, 'partial');
	assert.deepEqual(result.output.facts, ['fact A']);
});

test('executeDiscoveryStep: all empty -> status failed', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'X' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'Y' },
	]);
	const { executeLeaf } = mockLeafExecutor({ 's1.a': '', 's1.b': '' });
	const { provider } = scriptedSummarizer([]);   // no summarizations

	const result = await executeDiscoveryStep({
		step,
		priorOutputs: {},
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf, summarizeProvider: provider },
	});
	assert.equal(result.output.status, 'failed');
	assert.equal(result.output.facts.length, 0);
});

// ---------------------------------------------------------------------------
// Error tolerance
// ---------------------------------------------------------------------------

test('executeDiscoveryStep: executeLeaf throws -> treated as empty, step continues', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'X' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'Y' },
	]);
	const { executeLeaf } = mockLeafExecutor({
		's1.a': new Error('leaf crashed'),
		's1.b': 'second result',
	});
	const { provider } = scriptedSummarizer([summary(['fact B'], [])]);

	const result = await executeDiscoveryStep({
		step,
		priorOutputs: {},
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf, summarizeProvider: provider },
	});
	assert.equal(result.output.status, 'partial');
	assert.deepEqual(result.output.facts, ['fact B']);
});

test('executeDiscoveryStep: summarizer throws -> that call skipped, others recorded', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'X' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'Y' },
	]);
	const { executeLeaf } = mockLeafExecutor({
		's1.a': 'result A',
		's1.b': 'result B',
	});
	const { provider } = scriptedSummarizer([
		'not-json-bad-response',                           // summarizer fallback -> low confidence + synthetic fact
		summary(['fact B'], ['path:foo.ts']),
	]);

	const result = await executeDiscoveryStep({
		step,
		priorOutputs: {},
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf, summarizeProvider: provider },
	});
	// summarizer's "no facts extracted" fallback for call 1 plus fact B for call 2.
	assert.equal(result.output.status, 'ok');
	const factText = result.output.facts.join(' | ');
	assert.match(factText, /no facts extracted/);
	assert.match(factText, /fact B/);
});

// ---------------------------------------------------------------------------
// dependsOn wiring
// ---------------------------------------------------------------------------

test('executeDiscoveryStep: later call sees prior step outputs + earlier-sibling outputs in priorOutputs', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'X' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'Y', dependsOn: 's1.a' },
	]);
	const { executeLeaf, calls: leafCalls } = mockLeafExecutor({
		's1.a': 'A-result-text',
		's1.b': 'B-result-text',
	});
	const { provider } = scriptedSummarizer([
		summary(['fA'], []),
		summary(['fB'], []),
	]);

	await executeDiscoveryStep({
		step,
		priorOutputs: { 'prior-step-from-ledger': 'OLD result' },
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf, summarizeProvider: provider },
	});

	// First leaf call: sees only the orchestrator-supplied priors
	assert.deepEqual(leafCalls[0]!.priorOutputs, { 'prior-step-from-ledger': 'OLD result' });
	// Second leaf call: sees orchestrator priors PLUS s1.a's output
	assert.deepEqual(leafCalls[1]!.priorOutputs, {
		'prior-step-from-ledger': 'OLD result',
		's1.a':                   'A-result-text',
	});
});

// ---------------------------------------------------------------------------
// Synthetic leaf shape
// ---------------------------------------------------------------------------

test('makeSyntheticLeaf: shape matches PlannedNode leaf contract', () => {
	const leaf = makeSyntheticLeaf({
		id: 's1.a', skillId: 'code.class.extract-fields', context: 'className=INGRN',
	});
	assert.equal(leaf.kind, 'leaf');
	assert.equal(leaf.id, 's1.a');
	assert.equal(leaf.skill, 'code.class.extract-fields');
	assert.equal(leaf.objective, 'className=INGRN');
	assert.equal(leaf.emit, 'intermediate');
	assert.deepEqual(leaf.inputs, {});
});

// ---------------------------------------------------------------------------
// deriveStatus
// ---------------------------------------------------------------------------

test('deriveStatus: executedCount=0 -> failed', () => {
	assert.equal(deriveStatus(0, 0), 'failed');
});

test('deriveStatus: all empty -> failed', () => {
	assert.equal(deriveStatus(3, 3), 'failed');
});

test('deriveStatus: some empty -> partial', () => {
	assert.equal(deriveStatus(3, 1), 'partial');
});

test('deriveStatus: none empty -> ok', () => {
	assert.equal(deriveStatus(3, 0), 'ok');
});

// ---------------------------------------------------------------------------
// parseCitationString
// ---------------------------------------------------------------------------

test('parseCitationString: path:foo.ts#L1-L20 -> structured', () => {
	const c = parseCitationString('path:insors/foo.py#L40-L207');
	assert.ok(c !== null);
	assert.equal(c!.path, 'insors/foo.py');
	assert.equal(c!.startLine, 40);
	assert.equal(c!.endLine, 207);
});

test('parseCitationString: path:foo.ts#L42 -> startLine only', () => {
	const c = parseCitationString('path:foo.ts#L42');
	assert.ok(c !== null);
	assert.equal(c!.path, 'foo.ts');
	assert.equal(c!.startLine, 42);
	assert.equal(c!.endLine, undefined);
});

test('parseCitationString: bare path (no path: prefix, no line) -> path only', () => {
	const c = parseCitationString('test/data/foo.json');
	assert.ok(c !== null);
	assert.equal(c!.path, 'test/data/foo.json');
	assert.equal(c!.startLine, undefined);
});

test('parseCitationString: empty / whitespace-only -> null', () => {
	assert.equal(parseCitationString(''), null);
	assert.equal(parseCitationString('   '), null);
});
