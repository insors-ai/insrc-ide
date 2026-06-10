/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for executeDiscoveryStep (Stage 2 adapter) -- Phase 1 batch 3b of
 * plans/section-flow-architecture-redesign.md.
 *
 * The dedicated `summarizeResult` cloud call is gone; the adapter now just
 * dispatches each PlannedSkillCall through the leaf executor and stashes
 * the raw stringified value + spillId on `StepOutput.rawOutputs` /
 * `.artifactIds`. The reviewer (Stage 3) does summary emission in the
 * same turn it judges keep/new_steps.
 *
 * Covers:
 *   - Happy path: 2 calls, both succeed, status='ok', rawOutputs +
 *     artifactIds populated correctly
 *   - Partial: one call returns empty, status='partial', empty call
 *     present in rawOutputs with value '', absent from artifactIds
 *   - Failed: every call returns empty, status='failed'
 *   - Empty skills: status='failed' (executedCount=0)
 *   - executeLeaf throws -> treated as empty (no abort), step continues
 *   - dependsOn wiring: earlier call's output is in the priorOutputs map
 *     when later call dispatches (verified via mock recording priors)
 *   - deriveStatus unit tests
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	executeDiscoveryStep,
	_makeSyntheticLeafForTest    as makeSyntheticLeaf,
	_deriveStatusForTest         as deriveStatus,
} from '../step-discovery-execute.js';
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

function mockLeafExecutor(
	returnsByLeafId: Readonly<Record<string, string | Error>>,
	spillIdsByLeafId: Readonly<Record<string, string>> = {},
): {
	executeLeaf: ExecuteLeaf;
	calls: LeafRecord[];
} {
	const calls: LeafRecord[] = [];
	const executeLeaf: ExecuteLeaf = async (input: LeafExecutionInput) => {
		const rec: LeafRecord = {
			leafId:       input.leaf.id,
			skill:        input.leaf.skill ?? '',
			objective:    input.leaf.objective ?? '',
			priorOutputs: { ...input.priorOutputs },
		};
		calls.push(rec);
		const ret = returnsByLeafId[input.leaf.id];
		if (ret instanceof Error) { throw ret; }
		return { text: ret ?? '', spillId: spillIdsByLeafId[input.leaf.id] };
	};
	return { executeLeaf, calls };
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

test('executeDiscoveryStep: 2 calls both succeed -> status ok, rawOutputs + artifactIds populated', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'use locate result', dependsOn: 's1.a' },
	]);
	const { executeLeaf } = mockLeafExecutor(
		{ 's1.a': 'INGRN located at insors/grn.py:40', 's1.b': 'INGRN has 21 fields' },
		{ 's1.a': 'sess:1:code.entity.locate-by-name', 's1.b': 'sess:2:code.class.extract-fields' },
	);

	const result = await executeDiscoveryStep({
		step,
		priorOutputs: {},
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf },
	});

	assert.equal(result.output.status, 'ok');
	assert.equal(result.output.rawOutputs['s1.a'], 'INGRN located at insors/grn.py:40');
	assert.equal(result.output.rawOutputs['s1.b'], 'INGRN has 21 fields');
	assert.equal(result.output.artifactIds['s1.a'], 'sess:1:code.entity.locate-by-name');
	assert.equal(result.output.artifactIds['s1.b'], 'sess:2:code.class.extract-fields');
	// skillOutputs + skillArtifactIds mirror the StepOutput fields.
	assert.equal(result.skillOutputs['s1.a'], result.output.rawOutputs['s1.a']);
	assert.equal(result.skillArtifactIds['s1.b'], result.output.artifactIds['s1.b']);
});

test('executeDiscoveryStep: 1 call empty -> status partial, empty call present in rawOutputs but absent from artifactIds', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'use s1.a',         dependsOn: 's1.a' },
	]);
	const { executeLeaf } = mockLeafExecutor(
		{ 's1.a': 'INGRN located', 's1.b': '' },
		{ 's1.a': 'sess:1:locate' },
	);

	const result = await executeDiscoveryStep({
		step,
		priorOutputs: {},
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf },
	});

	assert.equal(result.output.status, 'partial');
	assert.equal(result.output.rawOutputs['s1.a'], 'INGRN located');
	assert.equal(result.output.rawOutputs['s1.b'], '');
	assert.equal(result.output.artifactIds['s1.a'], 'sess:1:locate');
	assert.equal(result.output.artifactIds['s1.b'], undefined);
});

test('executeDiscoveryStep: all calls empty -> status failed', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'try anyway' },
	]);
	const { executeLeaf } = mockLeafExecutor({ 's1.a': '', 's1.b': '' });

	const result = await executeDiscoveryStep({
		step,
		priorOutputs: {},
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf },
	});

	assert.equal(result.output.status, 'failed');
	assert.deepEqual(result.output.artifactIds, {});
});

test('executeDiscoveryStep: executeLeaf throws -> treated as empty, step continues', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'still runs' },
	]);
	const { executeLeaf } = mockLeafExecutor(
		{ 's1.a': new Error('locate boom'), 's1.b': 'INGRN has 21 fields' },
		{ 's1.b': 'sess:2:extract' },
	);

	const result = await executeDiscoveryStep({
		step,
		priorOutputs: {},
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf },
	});

	// s1.a threw -> recorded as empty -> partial overall.
	assert.equal(result.output.status, 'partial');
	assert.equal(result.output.rawOutputs['s1.a'], '');
	assert.equal(result.output.rawOutputs['s1.b'], 'INGRN has 21 fields');
});

// ---------------------------------------------------------------------------
// Wiring: priorOutputs merging
// ---------------------------------------------------------------------------

test('executeDiscoveryStep: earlier skill output reaches later call via priorOutputs', async () => {
	const step = makeStep([
		{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' },
		{ id: 's1.b', skillId: 'code.class.extract-fields', context: 'consume s1.a', dependsOn: 's1.a' },
	]);
	const { executeLeaf, calls: leafCalls } = mockLeafExecutor({
		's1.a': 'entityId=b209...',
		's1.b': 'fields=...',
	});

	await executeDiscoveryStep({
		step,
		priorOutputs: { 'prior-step': 'from a previous cycle' },
		deps: { todo: TODO, gapFacts: GAP_FACTS, executeLeaf },
	});

	// First call sees only the orchestrator-supplied priors.
	assert.equal(leafCalls[0]!.priorOutputs['prior-step'], 'from a previous cycle');
	assert.equal(leafCalls[0]!.priorOutputs['s1.a'], undefined);
	// Second call additionally sees the in-step skill output (s1.a).
	assert.equal(leafCalls[1]!.priorOutputs['prior-step'], 'from a previous cycle');
	assert.equal(leafCalls[1]!.priorOutputs['s1.a'], 'entityId=b209...');
});

// ---------------------------------------------------------------------------
// Internal helpers
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

test('deriveStatus: no empties -> ok', () => {
	assert.equal(deriveStatus(2, 0), 'ok');
});

test('makeSyntheticLeaf: leaves kind=leaf, propagates skillId + context', () => {
	const node = makeSyntheticLeaf({ id: 's1.a', skillId: 'code.x', context: 'do the thing' });
	assert.equal(node.kind, 'leaf');
	assert.equal(node.skill, 'code.x');
	assert.equal(node.objective, 'do the thing');
	assert.equal(node.id, 's1.a');
});
