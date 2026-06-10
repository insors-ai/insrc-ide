/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase epsilon tests for runTodoOrchestrator (fact-gap loop cutover).
 *
 * Each test scripts the provider with one response per LLM call in
 * stage order:
 *
 *   Stage 0 fact-gap analysis
 *   Stage 1 discovery-plan expansion (per cycle)
 *   Stage 2 summarizer (one call per non-empty leaf output)
 *   Stage 3 cycle review (per cycle)
 *   Stage 6 synthesis (free-form markdown, not JSON)
 *   Stage 7 section review (JSON)
 *
 * Covers:
 *   - Trivial fast-path: Stage 0 returns all-present -> skip cycle loop
 *   - 1-cycle termination: Stage 3 emits new_steps=[] -> stop
 *   - L2 fallback path A: Stage 0 throws twice (both attempts fail)
 *   - L2 fallback path B: cycle loop exits with empty retained ledger
 *   - Entry shape: WorkingMemoryEntry.findings is built from ledger;
 *     on L2 path, entry.findings.fallback === 'L2'
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	registerAllPromptWriters,
	_resetPromptRegistryForTest,
} from '../../prompts/index.js';
import {
	runTodoOrchestrator,
	_collectCrossStepPriorsForTest as collectCrossStepPriors,
	type L2Fallback,
} from '../todo-orchestrator.js';
import type { DiscoveryStep } from '../../content-gen/discovery-plan.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { TodoSpec } from '../types.js';
import type { CloudMemoryView } from '../../working-memory/index.js';
import { legacyBundleToCloudView } from '../../working-memory/index.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { ExecuteLeaf } from '../leaf-executor.js';

// Prompt registry must be initialized before any orchestrator stage
// (fact-gap analysis, discovery-plan expansion, cycle review,
// synthesis, section review) -- every stage resolves its prompt via
// `getPromptRegistry().get(...)`. Reset between tests so registering
// twice doesn't throw.
test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall { readonly messages: LLMMessage[]; readonly opts: CompletionOpts; }

function scriptedProvider(responses: readonly (string | Error)[]): { provider: LLMProvider; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const provider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out of responses at call ${cursor + 1}`);
			}
			const next = responses[cursor]!;
			cursor++;
			if (next instanceof Error) { throw next; }
			return { text: next, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls };
}

function makeTodo(): TodoSpec {
	return { id: 'todo-x', objective: 'map GRN JSON to INGRN class', origin: 'initial' };
}
function makeMemory(): CloudMemoryView {
	return legacyBundleToCloudView({
		system: '', summary: 'INGRN at insors/.../grn.py', recent: '', semantic: '', code: '',
	});
}
function makeCatalog(): readonly CatalogSkill[] {
	return [
		{ id: 'code.class.extract-fields',     description: 'extract',   family: 'class',  owner: 'code-analyzer', inputs: {}, outputPaths: [] },
		{ id: 'data.source.file.sample-shape', description: 'sample',    family: 'source', owner: 'data-analyzer', inputs: {}, outputPaths: [] },
	];
}

const ALL_PRESENT_GAP_ANALYSIS = JSON.stringify({
	reasoning: 'Memory has everything.',
	requiredFacts: [
		{ id: 'a', fact: 'fact A', why: 'because', status: 'present',
		  sourceRef: { kind: 'memory-layer', layer: 'summary', excerpt: 'INGRN at ...' } },
	],
});

const MIXED_GAP_ANALYSIS = JSON.stringify({
	reasoning: 'Need INGRN fields + JSON shape.',
	requiredFacts: [
		{ id: 'ingrn-fields', fact: 'INGRN class field list', why: 'baseline', status: 'absent',
		  suggestedSkills: ['code.class.extract-fields'] },
		{ id: 'json-shape',   fact: 'GRN JSON shape', why: 'data side', status: 'absent',
		  suggestedSkills: ['data.source.file.sample-shape'] },
	],
});

// Phase 4 batch 4.2: the cycle loop is gone. The orchestrator now
// runs Stage 0 (fact-gap) + Stage 1 (sketch) + a dynamic decide-next-step
// loop + Stage 6 (synth) + Stage 7 (section review). Per-iteration cloud
// calls are: 1 decide-next-step per iteration; the very last iteration
// requests `terminate` and ALSO emits the prior step's summary.

const SKETCH_TWO_STEPS = JSON.stringify({
	steps: [
		{ id: 'step-1', intent: 'extract INGRN fields by name',
		  skills: [{ id: 's1.a', skillId: 'code.class.extract-fields', context: 'class=INGRN' }],
		  targetsCriteria: [0] },
		{ id: 'step-2', intent: 'sample the GRN JSON top-level shape',
		  skills: [{ id: 's2.a', skillId: 'data.source.file.sample-shape', context: 'path=grn.json' }],
		  targetsCriteria: [1] },
	],
});

function decideExecute(stepNum: 1 | 2, lastSummaries: Record<string, string> = {}): string {
	const stepN = stepNum === 1
		? { id: 'step-1', intent: 'extract INGRN fields by name',
		    skills: [{ id: 's1.a', skillId: 'code.class.extract-fields', context: 'class=INGRN' }],
		    targetsCriteria: [0] }
		: { id: 'step-2', intent: 'sample the GRN JSON top-level shape',
		    skills: [{ id: 's2.a', skillId: 'data.source.file.sample-shape', context: 'path=grn.json' }],
		    targetsCriteria: [1] };
	return JSON.stringify({
		action:                  'execute-step',
		reasoning:               `following the sketch -- step ${stepNum}`,
		lastStepArtifactSummary: lastSummaries,
		step:                    stepN,
	});
}

function decideTerminate(verdict: 'covered' | 'unrecoverable', lastSummaries: Record<string, string> = {}): string {
	return JSON.stringify({
		action:                  'terminate',
		verdict,
		reasoning:               `terminate -- ${verdict}`,
		lastStepArtifactSummary: lastSummaries,
	});
}

const SECTION_REVIEW_ACCEPT = JSON.stringify({ verdict: 'accept', reasoning: 'looks good' });

const SYNTH_MARKDOWN = '# GRN Mapping\n\nReal section content here.';

function mockExecuteLeaf(returnsBySkill: Readonly<Record<string, string>>): ExecuteLeaf {
	return async ({ leaf }) => {
		const skill = leaf.skill ?? '';
		return { text: returnsBySkill[skill] ?? '', spillId: undefined };
	};
}

// L2 stub that records invocation
function mockL2(returns = 'L2 stub markdown'): { l2: L2Fallback; calls: { reason: string }[] } {
	const calls: { reason: string }[] = [];
	const l2: L2Fallback = async ({ reason }) => {
		calls.push({ reason });
		return returns;
	};
	return { l2, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('runTodoOrchestrator: trivial fast-path (all facts present) -> Stage 0 + synth + review only', async () => {
	const { provider, calls } = scriptedProvider([
		ALL_PRESENT_GAP_ANALYSIS,    // Stage 0
		SYNTH_MARKDOWN,              // Stage 6 (free-form markdown)
		SECTION_REVIEW_ACCEPT,       // Stage 7
	]);
	const { l2, calls: l2Calls } = mockL2();
	const result = await runTodoOrchestrator({
		todo: makeTodo(), memory: makeMemory(), provider,
		executeLeaf: mockExecuteLeaf({}), l2Fallback: l2, catalog: makeCatalog(),
	});
	assert.equal(calls.length, 3);
	assert.equal(l2Calls.length, 0);
	assert.equal(result.trace.l2FallbackUsed, false);
	assert.equal(result.trace.stepsRun, 0);
	assert.equal(result.trace.terminationVerdict, 'reviewer-accept');
	assert.equal(result.entry.findings.fallback, undefined);
	assert.match(result.entry.detail, /Real section content/);
});

test('runTodoOrchestrator: 2-step dynamic loop -> terminate covered after both gaps closed', async () => {
	// Cloud call sequence: gap-analysis (1) + sketch (1) + decide#1=execute step-1
	// (1) + decide#2=execute step-2 with summaries for step-1 (1) + decide#3=
	// terminate covered with summaries for step-2 (1) + synth (1) + section-review (1)
	// = 7 calls.
	const { provider, calls } = scriptedProvider([
		MIXED_GAP_ANALYSIS,
		SKETCH_TWO_STEPS,
		decideExecute(1),
		decideExecute(2, { 's1.a': 'INGRN has 21 fields. CLOSES ingrn-fields fully' }),
		decideTerminate('covered', { 's2.a': 'sampled JSON shape. CLOSES json-shape fully' }),
		SYNTH_MARKDOWN,
		SECTION_REVIEW_ACCEPT,
	]);
	const { l2, calls: l2Calls } = mockL2();
	const result = await runTodoOrchestrator({
		todo: makeTodo(), memory: makeMemory(), provider,
		executeLeaf: mockExecuteLeaf({
			'code.class.extract-fields':     'INGRN has 21 fields: vendor, buyer, items, ...',
			'data.source.file.sample-shape': 'JSON has grn_number, grn_date, vendor_details, ...',
		}),
		l2Fallback: l2, catalog: makeCatalog(),
	});
	assert.equal(l2Calls.length, 0);
	assert.equal(result.trace.l2FallbackUsed, false);
	assert.equal(result.trace.stepsRun, 2);
	assert.equal(result.trace.retainedStepCount, 2);
	// Both steps should be present in perStepTrace.
	assert.deepEqual(result.trace.perStepTrace.map(t => t.stepId), ['step-1', 'step-2']);
	assert.equal(calls.length, 7);
	assert.match(result.entry.detail, /Real section content/);
});

test('runTodoOrchestrator: Stage 0 throws twice -> L2 fallback', async () => {
	// Stage 0 attempts to retry once on validation failure; both
	// scripted responses are malformed -> runFactGapAnalysis throws.
	const { provider } = scriptedProvider([
		'not valid json at all',
		'still not valid json',
	]);
	const { l2, calls: l2Calls } = mockL2('L2 stub');
	const result = await runTodoOrchestrator({
		todo: makeTodo(), memory: makeMemory(), provider,
		executeLeaf: mockExecuteLeaf({}), l2Fallback: l2, catalog: makeCatalog(),
	});
	assert.equal(l2Calls.length, 1);
	assert.match(l2Calls[0]!.reason, /fact-gap analysis failed/);
	assert.equal(result.trace.l2FallbackUsed, true);
	assert.equal(result.trace.terminationVerdict, 'l2');
	assert.equal(result.entry.findings.fallback, 'L2');
	assert.equal(result.entry.detail, 'L2 stub');
});

test('runTodoOrchestrator: first decide-turn terminates with no executed step -> L2 fallback', async () => {
	// gap (1) + sketch (1) + decide#1=terminate unrecoverable (1)
	// = retainedLedger.length === 0 -> L2.
	const { provider } = scriptedProvider([
		MIXED_GAP_ANALYSIS,
		SKETCH_TWO_STEPS,
		decideTerminate('unrecoverable'),
	]);
	const { l2, calls: l2Calls } = mockL2();
	const result = await runTodoOrchestrator({
		todo: makeTodo(), memory: makeMemory(), provider,
		executeLeaf: mockExecuteLeaf({}), l2Fallback: l2, catalog: makeCatalog(),
	});
	assert.equal(l2Calls.length, 1);
	assert.match(l2Calls[0]!.reason, /no retained facts/);
	assert.equal(result.trace.l2FallbackUsed, true);
	assert.equal(result.trace.terminationVerdict, 'l2');
	assert.equal(result.entry.findings.fallback, 'L2');
});

test('runTodoOrchestrator: 2-step dynamic loop -> findings.perRoot has both step ids on successful entry', async () => {
	const { provider } = scriptedProvider([
		MIXED_GAP_ANALYSIS,
		SKETCH_TWO_STEPS,
		decideExecute(1),
		decideExecute(2, { 's1.a': 'CLOSES ingrn-fields fully' }),
		decideTerminate('covered', { 's2.a': 'CLOSES json-shape fully' }),
		SYNTH_MARKDOWN,
		SECTION_REVIEW_ACCEPT,
	]);
	const { l2 } = mockL2();
	const result = await runTodoOrchestrator({
		todo: makeTodo(), memory: makeMemory(), provider,
		executeLeaf: mockExecuteLeaf({
			'code.class.extract-fields':     'real INGRN fields',
			'data.source.file.sample-shape': 'real JSON shape',
		}),
		l2Fallback: l2, catalog: makeCatalog(),
	});
	assert.equal(result.entry.findings.perRoot.length, 2);
	assert.deepEqual(result.entry.findings.perRoot.map(f => f.rootId), ['step-1', 'step-2']);
	for (const f of result.entry.findings.perRoot) {
		assert.equal(f.verdict, 'accept');
	}
	assert.equal(result.entry.findings.fallback, undefined);
});

// ---------------------------------------------------------------------------
// collectCrossStepPriors — selective forwarding for cross-step deps
// ---------------------------------------------------------------------------

function makeStep(id: string, skills: Array<{ id: string; skillId: string; dependsOn?: string }>): DiscoveryStep {
	return {
		id,
		intent: `intent for ${id}`,
		skills: skills.map(s => ({
			id: s.id,
			skillId: s.skillId,
			context: 'ctx',
			...(s.dependsOn !== undefined ? { dependsOn: s.dependsOn } : {}),
		})),
		targetsCriteria: [0],
	};
}

test('collectCrossStepPriors: pulls only declared cross-step deps; intra-step deps untouched', () => {
	const cache = {
		'step-1.s1.a': 'INGRN entityId b2097ef0ba38110e005d437d6b0c8442',
		'step-1.s1.b': 'INGRN fields list',
		'step-2.s2.a': 'unrelated output',
	};
	const step = makeStep('step-3', [
		// Intra-step dep -- bare skill id, must NOT be forwarded by collectCrossStepPriors.
		{ id: 's3.a', skillId: 'code.entity.locate-by-name' },
		{ id: 's3.b', skillId: 'code.entity.summary', dependsOn: 's3.a' },
		// Cross-step dep -- pulls one specific cached entry.
		{ id: 's3.c', skillId: 'code.entity.summary', dependsOn: 'step-1.s1.a' },
	]);
	const priors = collectCrossStepPriors(step, cache);
	assert.deepEqual(priors, { 'step-1.s1.a': 'INGRN entityId b2097ef0ba38110e005d437d6b0c8442' });
});

test('collectCrossStepPriors: no cross-step deps -> empty map', () => {
	const cache = { 'step-1.s1.a': 'cached output' };
	const step = makeStep('step-2', [
		{ id: 's2.a', skillId: 'code.class.extract-fields' },
	]);
	assert.deepEqual(collectCrossStepPriors(step, cache), {});
});

test('collectCrossStepPriors: cross-step dep with no cache hit -> entry omitted', () => {
	const cache = { 'step-1.s1.a': 'cached output' };
	const step = makeStep('step-2', [
		{ id: 's2.a', skillId: 'code.entity.summary', dependsOn: 'step-9.s9.x' },
	]);
	assert.deepEqual(collectCrossStepPriors(step, cache), {});
});

test('collectCrossStepPriors: multiple cross-step deps -> all forwarded', () => {
	const cache = {
		'step-1.s1.a': 'A',
		'step-1.s1.b': 'B',
		'step-2.s2.a': 'C',
	};
	const step = makeStep('step-3', [
		{ id: 's3.a', skillId: 'x', dependsOn: 'step-1.s1.a' },
		{ id: 's3.b', skillId: 'y', dependsOn: 'step-2.s2.a' },
		// Intra-step ref should be skipped here -- handled by within-step
		// merge in executeDiscoveryStep, not this helper.
		{ id: 's3.c', skillId: 'z', dependsOn: 's3.a' },
	]);
	const priors = collectCrossStepPriors(step, cache);
	assert.deepEqual(priors, { 'step-1.s1.a': 'A', 'step-2.s2.a': 'C' });
});
