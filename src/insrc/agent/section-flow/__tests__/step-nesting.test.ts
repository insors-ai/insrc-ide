/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for step-tree nesting: discriminated DiscoveryStep type
 * (leaf vs branch), recursive coerceStep validation, walkLeaves
 * traversal, countLeaves accounting.
 *
 * Pins the architectural rule: a step is EITHER a leaf (skills only)
 * OR a branch (children only); validator rejects both and rejects
 * neither.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	isLeafStep,
	isBranchStep,
	walkLeaves,
	countLeaves,
	type DiscoveryStep,
} from '../../content-gen/discovery-plan.js';
import { coerceStep } from '../step-validators.js';

const CATALOG_IDS = new Set(['code.entity.locate-by-name', 'code.class.extract-fields', 'shared.fs.list-files']);
const MAX_FACT_IDX = 4;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

test('isLeafStep: leaf with skills -> true', () => {
	const leaf: DiscoveryStep = {
		id: 'step-1', intent: 'locate INGRN',
		skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
		targetsCriteria: [0],
	};
	assert.equal(isLeafStep(leaf), true);
	assert.equal(isBranchStep(leaf), false);
});

test('isBranchStep: branch with children -> true', () => {
	const branch: DiscoveryStep = {
		id: 'step-1', intent: 'extract complete INGRN',
		children: [
			{ id: 'step-1.1', intent: 'locate INGRN', skills: [{ id: 's1.1.a', skillId: 'code.entity.locate-by-name', context: 'x' }], targetsCriteria: [0] },
			{ id: 'step-1.2', intent: 'extract fields',   skills: [{ id: 's1.2.a', skillId: 'code.class.extract-fields',  context: 'x' }], targetsCriteria: [1] },
		],
		targetsCriteria: [0, 1],
	};
	assert.equal(isBranchStep(branch), true);
	assert.equal(isLeafStep(branch), false);
});

// ---------------------------------------------------------------------------
// walkLeaves
// ---------------------------------------------------------------------------

test('walkLeaves: leaf yields itself', () => {
	const leaf: DiscoveryStep = {
		id: 'step-1', intent: 'x',
		skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'x' }],
		targetsCriteria: [0],
	};
	const leaves = [...walkLeaves(leaf)];
	assert.equal(leaves.length, 1);
	assert.equal(leaves[0]!.id, 'step-1');
});

test('walkLeaves: branch yields children in order', () => {
	const branch: DiscoveryStep = {
		id: 'step-1', intent: 'compound',
		children: [
			{ id: 'step-1.1', intent: 'a', skills: [{ id: 's1.1.a', skillId: 'code.entity.locate-by-name', context: 'x' }], targetsCriteria: [0] },
			{ id: 'step-1.2', intent: 'b', skills: [{ id: 's1.2.a', skillId: 'code.class.extract-fields', context: 'x' }], targetsCriteria: [1] },
			{ id: 'step-1.3', intent: 'c', skills: [{ id: 's1.3.a', skillId: 'shared.fs.list-files', context: 'x' }], targetsCriteria: [2] },
		],
		targetsCriteria: [0, 1, 2],
	};
	const leaves = [...walkLeaves(branch)];
	assert.equal(leaves.length, 3);
	assert.deepEqual(leaves.map(l => l.id), ['step-1.1', 'step-1.2', 'step-1.3']);
});

test('walkLeaves: nested branches walked depth-first', () => {
	const nested: DiscoveryStep = {
		id: 'step-1', intent: 'compound',
		children: [
			{ id: 'step-1.1', intent: 'sub-compound',
				children: [
					{ id: 'step-1.1.1', intent: 'leaf a', skills: [{ id: 's', skillId: 'code.entity.locate-by-name', context: 'x' }], targetsCriteria: [0] },
					{ id: 'step-1.1.2', intent: 'leaf b', skills: [{ id: 's', skillId: 'code.class.extract-fields', context: 'x' }], targetsCriteria: [1] },
				],
				targetsCriteria: [0, 1] },
			{ id: 'step-1.2', intent: 'leaf c', skills: [{ id: 's', skillId: 'shared.fs.list-files', context: 'x' }], targetsCriteria: [2] },
		],
		targetsCriteria: [0, 1, 2],
	};
	const leaves = [...walkLeaves(nested)];
	assert.deepEqual(leaves.map(l => l.id), ['step-1.1.1', 'step-1.1.2', 'step-1.2']);
});

test('countLeaves: leaf = 1, branch = sum of descendants', () => {
	const leaf: DiscoveryStep = { id: 's', intent: 'x', skills: [{ id: 's.a', skillId: 'code.entity.locate-by-name', context: 'x' }], targetsCriteria: [0] };
	assert.equal(countLeaves(leaf), 1);

	const branchOfTwoLeaves: DiscoveryStep = {
		id: 's', intent: 'x',
		children: [leaf, leaf],
		targetsCriteria: [0],
	};
	assert.equal(countLeaves(branchOfTwoLeaves), 2);
});

// ---------------------------------------------------------------------------
// coerceStep: leaf path (legacy shape, still valid)
// ---------------------------------------------------------------------------

test('coerceStep: legacy leaf shape -> valid leaf', () => {
	const raw = {
		id: 'step-1', intent: 'locate INGRN class',
		skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
		targetsCriteria: [0],
	};
	const out = coerceStep(raw, 0, CATALOG_IDS, MAX_FACT_IDX, new Map());
	assert.notEqual(typeof out, 'string');
	if (typeof out !== 'string') {
		assert.equal(isLeafStep(out), true);
		assert.equal(out.id, 'step-1');
	}
});

// ---------------------------------------------------------------------------
// coerceStep: branch path
// ---------------------------------------------------------------------------

test('coerceStep: valid branch with 2 child leaves', () => {
	const raw = {
		id: 'step-1', intent: 'extract complete INGRN class definition',
		children: [
			{ id: 'step-1.1', intent: 'locate INGRN entity',
			  skills: [{ id: 's1.1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
			  targetsCriteria: [0] },
			{ id: 'step-1.2', intent: 'extract its field list',
			  skills: [{ id: 's1.2.a', skillId: 'code.class.extract-fields', context: 'class=INGRN' }],
			  targetsCriteria: [1] },
		],
		targetsCriteria: [0, 1],
	};
	const out = coerceStep(raw, 0, CATALOG_IDS, MAX_FACT_IDX, new Map());
	assert.notEqual(typeof out, 'string');
	if (typeof out !== 'string') {
		assert.equal(isBranchStep(out), true);
		assert.equal(out.children?.length, 2);
		const leaves = [...walkLeaves(out)];
		assert.equal(leaves.length, 2);
	}
});

// ---------------------------------------------------------------------------
// coerceStep: rejection paths
// ---------------------------------------------------------------------------

test('coerceStep: rejects step with BOTH skills and children', () => {
	const raw = {
		id: 'step-1', intent: 'invalid both',
		skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'x' }],
		children: [{ id: 'c1', intent: 'leaf c1', skills: [{ id: 'sc1', skillId: 'code.class.extract-fields', context: 'x' }], targetsCriteria: [0] }],
		targetsCriteria: [0],
	};
	const out = coerceStep(raw, 0, CATALOG_IDS, MAX_FACT_IDX, new Map());
	assert.equal(typeof out, 'string');
	if (typeof out === 'string') {
		assert.match(out, /BOTH `skills` and `children`/);
	}
});

test('coerceStep: rejects step with NEITHER skills nor children', () => {
	const raw = {
		id: 'step-1', intent: 'empty step body',
		targetsCriteria: [0],
	};
	const out = coerceStep(raw, 0, CATALOG_IDS, MAX_FACT_IDX, new Map());
	assert.equal(typeof out, 'string');
	if (typeof out === 'string') {
		assert.match(out, /must be a non-empty array/);
	}
});

test('coerceStep: rejects branch with single child (pointless)', () => {
	const raw = {
		id: 'step-1', intent: 'singleton branch',
		children: [
			{ id: 'step-1.1', intent: 'only one', skills: [{ id: 's', skillId: 'code.entity.locate-by-name', context: 'x' }], targetsCriteria: [0] },
		],
		targetsCriteria: [0],
	};
	const out = coerceStep(raw, 0, CATALOG_IDS, MAX_FACT_IDX, new Map());
	assert.equal(typeof out, 'string');
	if (typeof out === 'string') {
		assert.match(out, /at least 2 entries/);
	}
});

test('coerceStep: branch propagates child validation errors', () => {
	const raw = {
		id: 'step-1', intent: 'branch with bad child',
		children: [
			{ id: 'step-1.1', intent: 'good leaf', skills: [{ id: 's', skillId: 'code.entity.locate-by-name', context: 'x' }], targetsCriteria: [0] },
			{ id: 'step-1.2', intent: 'bad - skillId not in catalog', skills: [{ id: 's', skillId: 'fake.skill', context: 'x' }], targetsCriteria: [1] },
		],
		targetsCriteria: [0, 1],
	};
	const out = coerceStep(raw, 0, CATALOG_IDS, MAX_FACT_IDX, new Map());
	assert.equal(typeof out, 'string');
	if (typeof out === 'string') {
		assert.match(out, /SKILL CATALOG/);
		assert.match(out, /children\[1\]/);
	}
});

test('coerceStep: nested branch (branch within branch) valid', () => {
	const raw = {
		id: 'step-1', intent: 'doubly nested',
		children: [
			{ id: 'step-1.1', intent: 'inner branch',
			  children: [
			    { id: 'step-1.1.1', intent: 'leaf a', skills: [{ id: 's', skillId: 'code.entity.locate-by-name', context: 'x' }], targetsCriteria: [0] },
			    { id: 'step-1.1.2', intent: 'leaf b', skills: [{ id: 's', skillId: 'code.class.extract-fields', context: 'x' }], targetsCriteria: [1] },
			  ],
			  targetsCriteria: [0, 1] },
			{ id: 'step-1.2', intent: 'leaf c', skills: [{ id: 's', skillId: 'shared.fs.list-files', context: 'x' }], targetsCriteria: [2] },
		],
		targetsCriteria: [0, 1, 2],
	};
	const out = coerceStep(raw, 0, CATALOG_IDS, MAX_FACT_IDX, new Map());
	assert.notEqual(typeof out, 'string');
	if (typeof out !== 'string') {
		assert.equal(isBranchStep(out), true);
		const leaves = [...walkLeaves(out)];
		assert.equal(leaves.length, 3);
		assert.deepEqual(leaves.map(l => l.id), ['step-1.1.1', 'step-1.1.2', 'step-1.2']);
	}
});

test('coerceStep: rejects branch with duplicate child ids', () => {
	const raw = {
		id: 'step-1', intent: 'dupes',
		children: [
			{ id: 'step-1.1', intent: 'leaf alpha', skills: [{ id: 's', skillId: 'code.entity.locate-by-name', context: 'x' }], targetsCriteria: [0] },
			{ id: 'step-1.1', intent: 'leaf beta',  skills: [{ id: 's', skillId: 'code.class.extract-fields', context: 'x' }], targetsCriteria: [1] },
		],
		targetsCriteria: [0, 1],
	};
	const out = coerceStep(raw, 0, CATALOG_IDS, MAX_FACT_IDX, new Map());
	assert.equal(typeof out, 'string');
	if (typeof out === 'string') {
		assert.match(out, /duplicates/);
	}
});
