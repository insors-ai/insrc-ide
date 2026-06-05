/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the section assembly step (P3.c, part 1).
 *
 * Covered:
 * - Happy path: emit:section root finding lands as markdown.
 * - Fallback 1: emit:section root has no finding -> last finding wins.
 * - Fallback 2: no emit:section root at all -> last finding wins.
 * - Fallback 3: no findings at all -> empty marker.
 * - Single-leaf top-level (fast-path) -> the leaf itself sources the section.
 * - Multiple emit:section roots: last one wins (defensive; the
 *   section planner's prompt forbids multiple section emitters).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	assembleSection,
	_findSectionEmittingRootForTest as findSectionEmittingRoot,
} from '../step-section-assembly.js';
import type { PlannedNode, PlannedTree } from '../../content-gen/plan-tree.js';
import type { PerRootFinding, WorkingMemoryFindings } from '../../working-memory/types.js';
import type { TodoSpec } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const todo: TodoSpec = { id: 'todo-x', objective: 'Investigate X', origin: 'initial' };

function leaf(id: string, emit: PlannedNode['emit'] = 'intermediate'): PlannedNode {
	return { id, title: id, objective: 'o', kind: 'leaf', skill: 'shared.x', inputs: {}, emit };
}

function composition(id: string, children: PlannedNode[], emit: PlannedNode['emit'] = 'intermediate'): PlannedNode {
	return { id, title: id, objective: 'o', kind: 'composition', composition: 'sequence', inputs: {}, emit, children };
}

function tree(rootChildren: PlannedNode[]): PlannedTree {
	return {
		intentBrief: 'test',
		root: composition('top', rootChildren),
	};
}

function finding(rootId: string, content: string): PerRootFinding {
	return { rootId, verdict: 'accept', cyclesConsumed: 0, exhausted: false, content };
}

const findings = (perRoot: readonly PerRootFinding[]): WorkingMemoryFindings => ({ perRoot });

// ---------------------------------------------------------------------------
// findSectionEmittingRoot
// ---------------------------------------------------------------------------

test('findSectionEmittingRoot: returns the synthesize root', () => {
	const t = tree([
		composition('discover',   [leaf('a')]),
		composition('analyze',    [leaf('b')]),
		composition('synthesize', [leaf('c')], 'section'),
	]);
	const root = findSectionEmittingRoot(t);
	assert.equal(root?.id, 'synthesize');
});

test('findSectionEmittingRoot: returns null when no section emitter exists', () => {
	const t = tree([composition('discover', [leaf('a')]), composition('analyze', [leaf('b')])]);
	assert.equal(findSectionEmittingRoot(t), null);
});

test('findSectionEmittingRoot: single-leaf top-level (fast-path) -> the leaf itself', () => {
	const t: PlannedTree = {
		intentBrief: 't',
		root: leaf('only', 'section'),
	};
	const root = findSectionEmittingRoot(t);
	assert.equal(root?.id, 'only');
});

test('findSectionEmittingRoot: multiple emit:section roots -> last wins', () => {
	const t = tree([
		composition('a', [leaf('x')], 'section'),
		composition('b', [leaf('y')], 'section'),
	]);
	const root = findSectionEmittingRoot(t);
	assert.equal(root?.id, 'b');
});

test('findSectionEmittingRoot: single-leaf top-level WITHOUT emit:section -> null', () => {
	const t: PlannedTree = {
		intentBrief: 't',
		root: leaf('only', 'intermediate'),
	};
	assert.equal(findSectionEmittingRoot(t), null);
});

// ---------------------------------------------------------------------------
// assembleSection (happy path)
// ---------------------------------------------------------------------------

test('assembleSection: emit:section root finding -> markdown extracted, usedFallback=false', () => {
	const t = tree([
		composition('discover',   [leaf('a')]),
		composition('synthesize', [leaf('c')], 'section'),
	]);
	const fs = findings([
		finding('discover',   'discover content'),
		finding('synthesize', '# Section\n\nThe synthesized markdown.\n'),
	]);
	const result = assembleSection({ todo, tree: t, findings: fs });
	assert.equal(result.markdown,     '# Section\n\nThe synthesized markdown.\n');
	assert.equal(result.sourceRootId, 'synthesize');
	assert.equal(result.usedFallback, false);
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

test('assembleSection: emit:section root has empty finding -> falls back to last finding', () => {
	const t = tree([
		composition('discover',   [leaf('a')]),
		composition('synthesize', [leaf('c')], 'section'),
	]);
	const fs = findings([
		finding('discover',   'discover content here'),
		finding('synthesize', '   '),    // whitespace-only -> empty
	]);
	const result = assembleSection({ todo, tree: t, findings: fs });
	assert.equal(result.markdown,     'discover content here');
	assert.equal(result.sourceRootId, 'discover');
	assert.equal(result.usedFallback, true);
});

test('assembleSection: no emit:section root -> falls back to last finding', () => {
	const t = tree([
		composition('discover', [leaf('a')]),
		composition('analyze',  [leaf('b')]),
	]);
	const fs = findings([
		finding('discover', 'discover content'),
		finding('analyze',  'analyze content'),
	]);
	const result = assembleSection({ todo, tree: t, findings: fs });
	assert.equal(result.markdown,     'analyze content');
	assert.equal(result.sourceRootId, 'analyze');
	assert.equal(result.usedFallback, true);
});

test('assembleSection: no findings at all -> empty marker', () => {
	const t = tree([composition('discover', [leaf('a')])]);
	const fs = findings([]);
	const result = assembleSection({ todo, tree: t, findings: fs });
	assert.match(result.markdown, /no content for todo-x/);
	assert.equal(result.sourceRootId, '');
	assert.equal(result.usedFallback, true);
});

test('assembleSection: emit:section root missing AND all findings empty -> empty marker', () => {
	const t = tree([composition('discover', [leaf('a')])]);
	const fs = findings([finding('discover', '   ')]);
	const result = assembleSection({ todo, tree: t, findings: fs });
	assert.match(result.markdown, /no content for todo-x/);
	assert.equal(result.usedFallback, true);
});

test('assembleSection: single-leaf top-level + finding matches by rootId', () => {
	const t: PlannedTree = {
		intentBrief: 't',
		root: leaf('only', 'section'),
	};
	const fs = findings([finding('only', '# Single Section\n\nbody\n')]);
	const result = assembleSection({ todo, tree: t, findings: fs });
	assert.equal(result.markdown, '# Single Section\n\nbody\n');
	assert.equal(result.sourceRootId, 'only');
	assert.equal(result.usedFallback, false);
});
