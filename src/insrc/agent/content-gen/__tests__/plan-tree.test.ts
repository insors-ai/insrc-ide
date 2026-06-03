/**
 * Tests for the skill-tree planner schema + validator (P1 of
 * plans/planner-skill-tree.md).
 *
 * Coverage:
 *   - Valid trees: single leaf, nested composition, every InputBinding
 *     variant, every emit kind, render variants.
 *   - Invariants: duplicate ids, leaf/composition exclusivity, missing
 *     children on composition, forward refs disallowed, self-refs
 *     disallowed.
 *   - Caps: leaf-count, depth, branching all rejected.
 *   - Bindings: each source variant validated; bad regex rejected;
 *     missing required fields per source rejected.
 *   - Helpers: walkTree / countLeaves / maxDepth / inferCategoriesFromTree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	validatePlannedTree,
	walkTree,
	countLeaves,
	maxDepth,
	inferCategoriesFromTree,
	MAX_LEAVES,
	MAX_DEPTH,
	MAX_BRANCHING,
	type PlannedNode,
	type PlannedTree,
} from '../plan-tree.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SINGLE_LEAF = {
	intentBrief: 'Single-leaf plan.',
	root: {
		id: 'lone',
		title: 'Lonely',
		objective: 'Stand alone.',
		kind: 'leaf',
		skill: 'data.source.file.describe',
		inputs: {
			connectionId: { source: 'context', key: 'primaryConnection' },
		},
		emit: 'section',
	},
} as const;

const INGRN_LIKE = {
	intentBrief: 'Map JSON to INGRN.',
	root: {
		id: 'root',
		title: 'Report root',
		objective: 'Compose three branches.',
		kind: 'composition',
		composition: 'parallel',
		inputs: {},
		emit: 'discard',
		children: [
			{
				id: 'data-inv',
				title: 'JSON files',
				objective: 'Describe the JSON shape.',
				kind: 'leaf',
				skill: 'data.source.file.describe',
				inputs: {
					connectionId: { source: 'context', key: 'primaryConnection' },
				},
				emit: 'section',
			},
			{
				id: 'class-def',
				title: 'INGRN class',
				objective: 'Extract pydantic class fields.',
				kind: 'leaf',
				skill: 'code.class.extract-fields',
				inputs: {
					className: { source: 'question', extract: 'INGRN' },
					language:  { source: 'literal', value: 'python' },
					repoPath:  { source: 'context', key: 'codeRepoPath' },
				},
				emit: 'section',
			},
			{
				id: 'align',
				title: 'Field alignment',
				objective: 'Align JSON shape with class fields.',
				kind: 'composition',
				composition: 'sequence',
				inputs: {},
				emit: 'section',
				children: [
					{
						id: 'align-sample',
						title: 'Sample shape',
						objective: 'Sample JSON shape.',
						kind: 'leaf',
						skill: 'data.source.file.sample-shape',
						inputs: {
							connectionId: { source: 'context', key: 'primaryConnection' },
						},
						emit: 'intermediate',
					},
					{
						id: 'align-compute',
						title: 'Compute alignment',
						objective: 'Compare fields to shape.',
						kind: 'leaf',
						skill: 'shared.compare.fields-vs-shape',
						inputs: {
							classFields: { source: 'node', nodeId: 'class-def',    path: 'fields' },
							dataShape:   { source: 'node', nodeId: 'align-sample', path: 'columns' },
						},
						emit: 'section',
					},
				],
			},
		],
	},
} as const;

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('validatePlannedTree: accepts a single-leaf tree', () => {
	const r = validatePlannedTree(SINGLE_LEAF);
	assert.notEqual(typeof r, 'string', r as string);
	if (typeof r === 'string') return;
	assert.equal(r.intentBrief, 'Single-leaf plan.');
	assert.equal(r.root.kind, 'leaf');
});

test('validatePlannedTree: accepts the INGRN-like tree (composition + wiring)', () => {
	const r = validatePlannedTree(INGRN_LIKE);
	assert.notEqual(typeof r, 'string', r as string);
	if (typeof r === 'string') return;
	assert.equal(r.root.kind, 'composition');
	assert.equal(r.root.children!.length, 3);
	assert.equal(countLeaves(r), 4);
	assert.equal(maxDepth(r), 2);   // root -> align -> align-compute
});

test('validatePlannedTree: accepts every InputBinding variant', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'p', title: 't', objective: 'o', kind: 'composition', inputs: {}, emit: 'discard',
			children: [
				{
					id: 'a', title: 't', objective: 'o', kind: 'leaf',
					skill: 'foo.bar', emit: 'intermediate',
					inputs: {
						w1: { source: 'literal',  value: 42 },
						w2: { source: 'literal',  value: null },
						w3: { source: 'question', extract: '\\bFoo\\b' },
						w4: { source: 'context',  key: 'codeRepoPath' },
					},
				},
				{
					id: 'b', title: 't', objective: 'o', kind: 'leaf',
					skill: 'foo.baz', emit: 'section',
					inputs: {
						w5: { source: 'node', nodeId: 'a', path: 'result.value' },
					},
				},
			],
		},
	});
	assert.notEqual(typeof r, 'string', r as string);
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test('validatePlannedTree: rejects empty intentBrief', () => {
	const r = validatePlannedTree({ ...SINGLE_LEAF, intentBrief: '' });
	assert.match(r as string, /intentBrief/);
});

test('validatePlannedTree: rejects missing root', () => {
	const r = validatePlannedTree({ intentBrief: 'x' });
	assert.match(r as string, /root/);
});

test('validatePlannedTree: rejects duplicate ids', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'dup', title: 't', objective: 'o', kind: 'composition', inputs: {}, emit: 'discard',
			children: [
				{ id: 'dup', title: 't', objective: 'o', kind: 'leaf', skill: 'a.b', inputs: {}, emit: 'section' },
			],
		},
	});
	assert.match(r as string, /duplicate node id "dup"/);
});

test('validatePlannedTree: rejects leaf with children', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'leaf',
			skill: 'foo.bar', inputs: {}, emit: 'section',
			children: [{ id: 'c', title: 't', objective: 'o', kind: 'leaf', skill: 'x.y', inputs: {}, emit: 'section' }],
		},
	});
	assert.match(r as string, /leaf.*must not have children/);
});

test('validatePlannedTree: rejects leaf with composition field', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'leaf',
			skill: 'foo.bar', inputs: {}, emit: 'section',
			composition: 'sequence',
		},
	});
	assert.match(r as string, /leaf.*must not declare composition/);
});

test('validatePlannedTree: rejects leaf without skill', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: { id: 'r', title: 't', objective: 'o', kind: 'leaf', inputs: {}, emit: 'section' },
	});
	assert.match(r as string, /leaf.*missing skill/);
});

test('validatePlannedTree: rejects composition with skill', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'composition',
			inputs: {}, emit: 'discard', skill: 'sneaky.skill',
			children: [{ id: 'c', title: 't', objective: 'o', kind: 'leaf', skill: 'a.b', inputs: {}, emit: 'section' }],
		},
	});
	assert.match(r as string, /composition.*must not declare skill/);
});

test('validatePlannedTree: rejects composition with zero children', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: { id: 'r', title: 't', objective: 'o', kind: 'composition', inputs: {}, emit: 'discard', children: [] },
	});
	assert.match(r as string, /composition.*at least one child/);
});

test('validatePlannedTree: rejects forward node refs (sibling later in the same composition)', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'composition', inputs: {}, emit: 'discard',
			children: [
				{
					id: 'first', title: 't', objective: 'o', kind: 'leaf',
					skill: 'foo.bar', emit: 'section',
					inputs: { wire: { source: 'node', nodeId: 'second', path: 'x' } },   // forward
				},
				{ id: 'second', title: 't', objective: 'o', kind: 'leaf', skill: 'foo.bar', inputs: {}, emit: 'section' },
			],
		},
	});
	assert.match(r as string, /not an ancestor or earlier sibling/);
});

test('validatePlannedTree: rejects self-ref on a wire', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'leaf',
			skill: 'foo.bar', emit: 'section',
			inputs: { selfish: { source: 'node', nodeId: 'r', path: 'x' } },
		},
	});
	assert.match(r as string, /refers to the wiring node itself/);
});

test('validatePlannedTree: accepts wire to ancestor', () => {
	// Composition child refers to its parent composition's id.
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'p', title: 't', objective: 'o', kind: 'composition', inputs: {}, emit: 'discard',
			children: [
				{
					id: 'c', title: 't', objective: 'o', kind: 'leaf',
					skill: 'foo.bar', emit: 'section',
					inputs: { wire: { source: 'node', nodeId: 'p', path: 'x' } },
				},
			],
		},
	});
	assert.notEqual(typeof r, 'string', r as string);
});

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

test(`validatePlannedTree: rejects > MAX_LEAVES (${MAX_LEAVES}) leaves`, () => {
	const children = Array.from({ length: MAX_LEAVES + 1 }, (_, i) => ({
		id: `c${i}`, title: 't', objective: 'o',
		kind: 'leaf', skill: 'foo.bar', inputs: {}, emit: 'section',
	}));
	// Need to split into multiple compositions because MAX_BRANCHING <= 8.
	// Build a composition tree of compositions that totals MAX_LEAVES+1 leaves.
	function chunk(arr: typeof children, size: number): (typeof children)[] {
		const out: (typeof children)[] = [];
		for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
		return out;
	}
	const groups = chunk(children, MAX_BRANCHING).map((group, i) => ({
		id: `g${i}`, title: 't', objective: 'o',
		kind: 'composition', composition: 'sequence', inputs: {}, emit: 'discard',
		children: group,
	}));
	// At MAX_DEPTH=4, levels are: root(0) -> g(1) -> children(2). Safe.
	const tree = {
		intentBrief: 'x',
		root: {
			id: 'root', title: 't', objective: 'o',
			kind: 'composition', composition: 'parallel', inputs: {}, emit: 'discard',
			children: groups,
		},
	};
	const r = validatePlannedTree(tree);
	assert.match(r as string, new RegExp(`cap is ${MAX_LEAVES}`));
});

test(`validatePlannedTree: rejects > MAX_BRANCHING (${MAX_BRANCHING}) children`, () => {
	const children = Array.from({ length: MAX_BRANCHING + 1 }, (_, i) => ({
		id: `c${i}`, title: 't', objective: 'o',
		kind: 'leaf', skill: 'foo.bar', inputs: {}, emit: 'section',
	}));
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'composition', inputs: {}, emit: 'discard',
			children,
		},
	});
	assert.match(r as string, new RegExp(`cap is ${MAX_BRANCHING}`));
});

test(`validatePlannedTree: rejects depth >= MAX_DEPTH (${MAX_DEPTH})`, () => {
	// Build a chain depth 0 -> 1 -> 2 -> 3 -> 4 (one too deep).
	function nest(depth: number): unknown {
		if (depth === 0) {
			return { id: 'leaf', title: 't', objective: 'o', kind: 'leaf', skill: 'foo.bar', inputs: {}, emit: 'section' };
		}
		return {
			id: `lvl${depth}`, title: 't', objective: 'o',
			kind: 'composition', composition: 'sequence', inputs: {}, emit: 'discard',
			children: [nest(depth - 1)],
		};
	}
	const r = validatePlannedTree({ intentBrief: 'x', root: nest(MAX_DEPTH + 1) });
	assert.match(r as string, new RegExp(`depth.*cap of ${MAX_DEPTH}`));
});

// ---------------------------------------------------------------------------
// Binding-specific
// ---------------------------------------------------------------------------

test('validatePlannedTree: rejects unknown binding source', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'leaf', skill: 'foo.bar', emit: 'section',
			inputs: { bad: { source: 'mystery', mysteryArg: 'whatever' } },
		},
	});
	assert.match(r as string, /unknown source "mystery"/);
});

test('validatePlannedTree: rejects source=node without nodeId', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'leaf', skill: 'foo.bar', emit: 'section',
			inputs: { bad: { source: 'node', path: 'x' } },
		},
	});
	assert.match(r as string, /source=node requires `nodeId`/);
});

test('validatePlannedTree: rejects source=question with bad regex', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'leaf', skill: 'foo.bar', emit: 'section',
			inputs: { bad: { source: 'question', extract: '[invalid' } },
		},
	});
	assert.match(r as string, /not a valid regex/);
});

test('validatePlannedTree: accepts source=literal with value null and value undefined-via-omission... wait, undefined must be explicit', () => {
	// `value` is required for source=literal; omitting it fails.
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'leaf', skill: 'foo.bar', emit: 'section',
			inputs: { bad: { source: 'literal' } },
		},
	});
	assert.match(r as string, /source=literal requires `value`/);
});

test('validatePlannedTree: accepts source=literal with null value', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'leaf', skill: 'foo.bar', emit: 'section',
			inputs: { ok: { source: 'literal', value: null } },
		},
	});
	assert.notEqual(typeof r, 'string', r as string);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('walkTree: yields every node depth-first parent-first', () => {
	const tree = validatePlannedTree(INGRN_LIKE) as PlannedTree;
	const ids = [...walkTree(tree)].map(n => n.id);
	assert.deepEqual(ids, ['root', 'data-inv', 'class-def', 'align', 'align-sample', 'align-compute']);
});

test('countLeaves: matches the validator\'s count', () => {
	const tree = validatePlannedTree(INGRN_LIKE) as PlannedTree;
	assert.equal(countLeaves(tree), 4);
});

test('maxDepth: 0 for single leaf, > 0 for compositions', () => {
	assert.equal(maxDepth(validatePlannedTree(SINGLE_LEAF) as PlannedTree), 0);
	assert.equal(maxDepth(validatePlannedTree(INGRN_LIKE) as PlannedTree), 2);
});

test('inferCategoriesFromTree: returns the union of leaf skill prefixes', () => {
	const tree = validatePlannedTree(INGRN_LIKE) as PlannedTree;
	const cats = inferCategoriesFromTree(tree);
	assert.ok(cats.includes('code-analyzer'), 'expected code-analyzer in cats');
	assert.ok(cats.includes('data-analyzer'), 'expected data-analyzer in cats');
	assert.ok(cats.includes('shared'),        'expected shared in cats');
});

test('inferCategoriesFromTree: skips composition nodes (no skill)', () => {
	const tree = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o', kind: 'composition', inputs: {}, emit: 'discard',
			children: [
				{ id: 'a', title: 't', objective: 'o', kind: 'leaf', skill: 'data.foo.bar', inputs: {}, emit: 'section' },
			],
		},
	}) as PlannedTree;
	const cats = inferCategoriesFromTree(tree);
	assert.deepEqual([...cats].sort(), ['data-analyzer']);
});

// ---------------------------------------------------------------------------
// Unused / future-proofing: PlannedNode type sanity
// ---------------------------------------------------------------------------

test('PlannedNode type: leaf shape compiles correctly', () => {
	const _n: PlannedNode = {
		id: 'x', title: 'X', objective: 'Test the leaf shape.',
		kind: 'leaf', skill: 'foo.bar',
		inputs: {}, emit: 'section',
	};
	void _n;
});

// ---------------------------------------------------------------------------
// Strict lookups (P2 of plans/planner-skill-tree.md)
// ---------------------------------------------------------------------------

const LOOKUPS_STRICT = {
	skillExists: (id: string) => ['data.source.file.describe', 'code.class.extract-fields', 'data.source.file.sample-shape', 'shared.compare.fields-vs-shape'].includes(id),
	skillOutputPaths: (id: string): readonly string[] => {
		switch (id) {
			case 'data.source.file.describe':       return ['columns', 'columns[*]', 'columns[*].name', 'rowCount'];
			case 'code.class.extract-fields':       return ['found', 'fields', 'fields[*]', 'fields[*].name', 'fields[*].type'];
			case 'data.source.file.sample-shape':   return ['columns', 'columns[*]', 'columns[*].type'];
			case 'shared.compare.fields-vs-shape':  return ['alignment', 'alignment[*]', 'alignment[*].jsonKey', 'alignment[*].classField', 'alignment[*].match'];
			default: return [];
		}
	},
} as const;

test('strict lookups: accepts a tree wired against real outputPaths', () => {
	const r = validatePlannedTree({
		intentBrief: 'INGRN comparison',
		root: {
			id: 'root', title: 't', objective: 'o',
			kind: 'composition', composition: 'parallel', inputs: {}, emit: 'discard',
			children: [
				{
					id: 'class-def', title: 't', objective: 'o',
					kind: 'leaf', skill: 'code.class.extract-fields', emit: 'intermediate',
					inputs: {
						className: { source: 'question', extract: 'INGRN' },
						language:  { source: 'literal',  value: 'python' },
					},
				},
				{
					id: 'data-shape', title: 't', objective: 'o',
					kind: 'leaf', skill: 'data.source.file.sample-shape', emit: 'intermediate',
					inputs: {
						connectionId: { source: 'context', key: 'primaryConnection' },
					},
				},
				{
					id: 'align', title: 't', objective: 'o',
					kind: 'leaf', skill: 'shared.compare.fields-vs-shape', emit: 'section',
					inputs: {
						classFields: { source: 'node', nodeId: 'class-def',  path: 'fields' },
						dataShape:   { source: 'node', nodeId: 'data-shape', path: 'columns' },
					},
				},
			],
		},
	}, LOOKUPS_STRICT);
	assert.notEqual(typeof r, 'string', r as string);
});

test('strict lookups: rejects unregistered skill on a leaf', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'r', title: 't', objective: 'o',
			kind: 'leaf', skill: 'foo.does-not-exist', emit: 'section', inputs: {},
		},
	}, LOOKUPS_STRICT);
	assert.match(r as string, /unregistered skill "foo.does-not-exist"/);
});

test('strict lookups: rejects wire path that is not in the source skill outputPaths', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'root', title: 't', objective: 'o',
			kind: 'composition', inputs: {}, emit: 'discard',
			children: [
				{ id: 'a', title: 't', objective: 'o',
				  kind: 'leaf', skill: 'code.class.extract-fields', emit: 'intermediate', inputs: {} },
				{ id: 'b', title: 't', objective: 'o',
				  kind: 'leaf', skill: 'shared.compare.fields-vs-shape', emit: 'section',
				  inputs: {
					classFields: { source: 'node', nodeId: 'a', path: 'fields[*].DOES_NOT_EXIST' },
					dataShape:   { source: 'literal', value: [] },
				  } },
			],
		},
	}, LOOKUPS_STRICT);
	assert.match(r as string, /path "fields\[\*\]\.DOES_NOT_EXIST" is not in "code.class.extract-fields" outputPaths/);
	assert.match(r as string, /valid: /);
});

test('strict lookups: rejects wire to a composition node (no structured output)', () => {
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'parent', title: 't', objective: 'o',
			kind: 'composition', inputs: {}, emit: 'discard',
			children: [
				{ id: 'inner', title: 't', objective: 'o',
				  kind: 'composition', inputs: {}, emit: 'intermediate',
				  children: [
					{ id: 'leaf-x', title: 't', objective: 'o',
					  kind: 'leaf', skill: 'code.class.extract-fields', emit: 'intermediate', inputs: {} },
				  ],
				},
				{ id: 'consumer', title: 't', objective: 'o',
				  kind: 'leaf', skill: 'shared.compare.fields-vs-shape', emit: 'section',
				  // Wires to the composition node "inner" instead of the leaf "leaf-x".
				  inputs: {
					classFields: { source: 'node', nodeId: 'inner', path: 'fields' },
					dataShape:   { source: 'literal', value: [] },
				  } },
			],
		},
	}, LOOKUPS_STRICT);
	assert.match(r as string, /"inner" is a composition; wires must target leaf nodes/);
});

test('strict lookups omitted: skill ids and paths NOT validated (P1 behavior preserved)', () => {
	// Same tree as the "rejects wire path" test above, but WITHOUT strict
	// lookups. The structural validator should still accept it.
	const r = validatePlannedTree({
		intentBrief: 'x',
		root: {
			id: 'root', title: 't', objective: 'o',
			kind: 'composition', inputs: {}, emit: 'discard',
			children: [
				{ id: 'a', title: 't', objective: 'o',
				  kind: 'leaf', skill: 'foo.even-unregistered', emit: 'intermediate', inputs: {} },
				{ id: 'b', title: 't', objective: 'o',
				  kind: 'leaf', skill: 'shared.compare.fields-vs-shape', emit: 'section',
				  inputs: {
					classFields: { source: 'node', nodeId: 'a', path: 'made.up.path.no.lookup' },
					dataShape:   { source: 'literal', value: [] },
				  } },
			],
		},
	}); // <-- no lookups param
	assert.notEqual(typeof r, 'string', r as string);
});
