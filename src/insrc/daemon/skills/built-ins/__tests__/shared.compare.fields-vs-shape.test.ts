/**
 * Tests for shared.compare.fields-vs-shape (P5 of
 * plans/planner-skill-tree.md).
 *
 * Two layers:
 *   1. Pure-function tests of `alignFieldsAndShape` -- the alignment
 *      logic must be deterministic. Covers: exact, rename (case/
 *      underscore), class-only, data-only, type compatibility verdicts,
 *      mixed input shapes (describe-style vs sample-shape-style data).
 *   2. End-to-end via the tree executor -- registers the skill, runs
 *      it through a tiny tree, asserts the structured output and the
 *      stitched markdown render the alignment table.
 *
 * The integration test is the most important guarantee for P5: it
 * proves that the planner can compose `code.class.extract-fields` (or
 * a stand-in) + `data.source.file.describe` (or a stand-in) into
 * `shared.compare.fields-vs-shape` and the orchestrator will deliver a
 * grounded alignment as a real report section.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	alignFieldsAndShape,
	registerSharedCompareFieldsVsShapeSkill,
} from '../shared.compare.fields-vs-shape.js';
import { _resetSkillRegistryForTests, registerSkill, getSkillOutputPaths } from '../../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../tools/registry.js';
import { closeGraphStore, setGraphStorePath } from '../../../../db/graph/store.js';
import { addRepo } from '../../../../db/repos.js';
import { executeTree, stitchTreeSections } from '../../tree/executor.js';
import { validatePlannedTree, type PlannedTree } from '../../../../agent/content-gen/plan-tree.js';
import { DefaultAccessAuditLog, DefaultAccessStore } from '../../../../shared/access.js';
import { DefaultSkillAuditLog } from '../../audit.js';
import type { Session } from '../../../../agent/session.js';
import type { Skill } from '../../types.js';
import type { LLMProvider } from '../../../../shared/types.js';

// ===========================================================================
// Pure-function tests
// ===========================================================================

test('alignFieldsAndShape: exact match on identical names + compatible types', () => {
	const out = alignFieldsAndShape({
		classFields: [
			{ name: 'grn_number', type: 'str' },
			{ name: 'grn_amount', type: 'float' },
		],
		dataShape: [
			{ name: 'grn_number', type: 'VARCHAR' },
			{ name: 'grn_amount', type: 'DOUBLE' },
		],
	});
	assert.equal(out.summary.exact, 2);
	assert.equal(out.summary.classOnly, 0);
	assert.equal(out.summary.dataOnly,  0);
	const a = out.alignment[0]!;
	assert.equal(a.match, 'exact');
	assert.equal(a.classField, 'grn_number');
	assert.equal(a.dataKey,    'grn_number');
});

test('alignFieldsAndShape: snake_case ↔ camelCase rename detected', () => {
	const out = alignFieldsAndShape({
		classFields: [{ name: 'vendor_details', type: 'INPartyDetails' }],
		dataShape:   [{ name: 'vendorDetails',  type: 'STRUCT' }],
	});
	assert.equal(out.summary.renames, 1);
	assert.equal(out.summary.classOnly, 0);
	assert.equal(out.summary.dataOnly,  0);
	const a = out.alignment[0]!;
	assert.equal(a.match, 'rename');
	assert.match(a.note!, /case\/underscore/);
});

test('alignFieldsAndShape: type mismatch flagged as name-only', () => {
	const out = alignFieldsAndShape({
		classFields: [{ name: 'grn_status', type: 'str' }],            // class says enum-string
		dataShape:   [{ name: 'grn_status', type: 'BIGINT' }],         // data says integer
	});
	assert.equal(out.summary.exact, 0);
	assert.equal(out.summary.nameOnly, 1);
	const a = out.alignment[0]!;
	assert.equal(a.match, 'name-only');
	assert.match(a.note!, /type mismatch/);
});

test('alignFieldsAndShape: Optional[X] / Union strip → match', () => {
	const out = alignFieldsAndShape({
		classFields: [{ name: 'po_number', type: 'Optional[str]' }],
		dataShape:   [{ name: 'po_number', type: 'VARCHAR' }],
	});
	assert.equal(out.summary.exact, 1);
});

test('alignFieldsAndShape: class-only field surfaces with class-only verdict', () => {
	const out = alignFieldsAndShape({
		classFields: [{ name: 'buyer', type: 'Optional[INPartyDetails]' }],
		dataShape:   [],
	});
	assert.equal(out.summary.classOnly, 1);
	const a = out.alignment[0]!;
	assert.equal(a.match, 'class-only');
	assert.equal(a.classField, 'buyer');
	assert.equal(a.dataKey, undefined);
});

test('alignFieldsAndShape: data-only key surfaces with data-only verdict', () => {
	const out = alignFieldsAndShape({
		classFields: [],
		dataShape:   [{ name: 'extra_meta', type: 'STRUCT' }],
	});
	assert.equal(out.summary.dataOnly, 1);
	const a = out.alignment[0]!;
	assert.equal(a.match, 'data-only');
	assert.equal(a.dataKey, 'extra_meta');
});

test('alignFieldsAndShape: liberal data shape -- sample-shape "path/types" form accepted', () => {
	const out = alignFieldsAndShape({
		classFields: [{ name: 'grn_amount', type: 'float' }],
		// sample-shape emits `path` + `types: [...]` per column.
		dataShape:   [{ path: 'grn_amount', types: ['DOUBLE'] }],
	});
	assert.equal(out.summary.exact, 1);
	const a = out.alignment[0]!;
	assert.equal(a.dataKey,  'grn_amount');
	assert.equal(a.dataType, 'DOUBLE');
});

test('alignFieldsAndShape: List[X] vs scalar data type -> mismatch surfaced', () => {
	const out = alignFieldsAndShape({
		classFields: [{ name: 'sku_details', type: 'List[INSKUDetails]' }],
		dataShape:   [{ name: 'sku_details', type: 'VARCHAR' }],   // scalar -- no array/list pattern
	});
	const a = out.alignment[0]!;
	assert.equal(a.match, 'name-only');
	assert.match(a.note!, /inspection|mismatch/);
});

test('alignFieldsAndShape: List[X] vs array-ish data type -> match', () => {
	// STRUCT_ARRAY contains 'array', loosely compatible with List[X].
	const out = alignFieldsAndShape({
		classFields: [{ name: 'sku_details', type: 'List[INSKUDetails]' }],
		dataShape:   [{ name: 'sku_details', type: 'STRUCT_ARRAY' }],
	});
	assert.equal(out.alignment[0]!.match, 'exact');
});

test('alignFieldsAndShape: ingrn-shaped happy mix -- exact + rename + class-only + data-only', () => {
	const out = alignFieldsAndShape({
		className: 'INGRN',
		dataLabel: 'test/integration/data/BB/GRN',
		classFields: [
			{ name: 'grn_number',     type: 'str' },
			{ name: 'grn_amount',     type: 'float' },
			{ name: 'vendor',         type: 'INPartyDetails' },   // class uses 'vendor'
			{ name: 'buyer',          type: 'Optional[INPartyDetails]' },
		],
		dataShape: [
			{ name: 'grn_number',     type: 'VARCHAR' },
			{ name: 'grn_amount',     type: 'DOUBLE' },
			{ name: 'vendor_details', type: 'STRUCT' },           // data uses 'vendor_details'
			{ name: 'po_number',      type: 'VARCHAR' },          // no class field
		],
	});
	assert.equal(out.summary.exact,     2);  // grn_number, grn_amount
	assert.equal(out.summary.renames,   0);  // 'vendor' vs 'vendor_details' is NOT a case/underscore rename (different stems)
	assert.equal(out.summary.classOnly, 2);  // 'vendor' + 'buyer' both unmatched
	assert.equal(out.summary.dataOnly,  2);  // 'vendor_details' + 'po_number'
	assert.match(out.headline, /INGRN ↔ test\/integration\/data\/BB\/GRN/);
});

test('alignFieldsAndShape: stable ordering -- class fields in input order, data-only appended', () => {
	const out = alignFieldsAndShape({
		classFields: [{ name: 'c2' }, { name: 'c1' }],
		dataShape:   [{ name: 'c1' }, { name: 'extra' }],
	});
	const ids = out.alignment.map(a => a.classField ?? a.dataKey);
	assert.deepEqual(ids, ['c2', 'c1', 'extra']);
});

// ===========================================================================
// Skill registration: outputPaths get cached on register
// ===========================================================================

test('registration: skill registers with the expected outputPaths', () => {
	_resetSkillRegistryForTests();
	registerSharedCompareFieldsVsShapeSkill();
	const paths = getSkillOutputPaths('shared.compare.fields-vs-shape');
	assert.ok(paths.includes('alignment'),                    'alignment path missing');
	assert.ok(paths.includes('alignment[*]'),                 'alignment[*] path missing');
	assert.ok(paths.includes('alignment[*].classField'),      'classField path missing');
	assert.ok(paths.includes('alignment[*].dataKey'),         'dataKey path missing');
	assert.ok(paths.includes('alignment[*].match'),           'match path missing');
	assert.ok(paths.includes('summary'),                      'summary path missing');
	assert.ok(paths.includes('summary.exact'),                'summary.exact path missing');
	assert.ok(paths.includes('headline'),                     'headline path missing');
});

// ===========================================================================
// End-to-end via the tree executor: stub producers feed compare
// ===========================================================================

const STUB_CLASS_FIELDS: Skill = {
	id: 'test.stub-class-fields',
	name: 'Stub class fields', description: 'Test-only producer of class field metadata.',
	family: 'meta', owner: 'shared', version: 1,
	inputs: {
		type: 'object',
		properties: { className: { type: 'string' } },
		required: ['className'],
	} as unknown as Record<string, unknown>,
	outputs: {
		type: 'object',
		properties: {
			fields: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						name: { type: 'string' },
						type: { type: 'string' },
					},
					required: ['name'],
				},
			},
		},
		required: ['fields'],
	} as unknown as Record<string, unknown>,
	toolDeps: [], providerAffinity: 'auto',
	async execute() {
		return {
			value: {
				fields: [
					{ name: 'grn_number', type: 'str' },
					{ name: 'grn_amount', type: 'float' },
					{ name: 'vendor',     type: 'INPartyDetails' },
				],
			},
			confidence: 'high', toolCalls: [],
		};
	},
};

const STUB_DATA_SHAPE: Skill = {
	id: 'test.stub-data-shape',
	name: 'Stub data shape', description: 'Test-only producer of data column descriptors.',
	family: 'meta', owner: 'shared', version: 1,
	inputs: {
		type: 'object',
		properties: { connectionId: { type: 'string' } },
		required: ['connectionId'],
	} as unknown as Record<string, unknown>,
	outputs: {
		type: 'object',
		properties: {
			columns: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						name: { type: 'string' },
						type: { type: 'string' },
					},
					required: ['name'],
				},
			},
		},
		required: ['columns'],
	} as unknown as Record<string, unknown>,
	toolDeps: [], providerAffinity: 'auto',
	async execute() {
		return {
			value: {
				columns: [
					{ name: 'grn_number',     type: 'VARCHAR' },
					{ name: 'grn_amount',     type: 'DOUBLE' },
					{ name: 'vendor_details', type: 'STRUCT' },     // class has 'vendor' -- class-only + data-only
				],
			},
			confidence: 'high', toolCalls: [],
		};
	},
};

interface Fixture { readonly graphDir: string; dispose(): Promise<void>; }

async function setupFixture(): Promise<Fixture> {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-fields-vs-shape-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: '/repo/x', name: '', addedAt: now, status: 'pending' });
	registerSkill(STUB_CLASS_FIELDS);
	registerSkill(STUB_DATA_SHAPE);
	registerSharedCompareFieldsVsShapeSkill();
	return { graphDir, async dispose() { await closeGraphStore(); rmSync(graphDir, { recursive: true, force: true }); } };
}

function fakeSession(): Session {
	const stub: Record<string, unknown> = {
		id: 'compare-test', repoPath: '/repo/x', closureRepos: ['/repo/x'], startedAt: Date.now(),
		skillAudit: new DefaultSkillAuditLog(), access: new DefaultAccessStore(), accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

const NEVER_LLM: LLMProvider = {
	complete: async () => { throw new Error('LLM should not be called in this test'); },
	stream:   async function* () { yield ''; },
	embed:    async () => [],
	supportsTools: true,
};

test('executeTree: tree wires stub producers -> compare -> stitches a real alignment section', async () => {
	const fx = await setupFixture();
	try {
		const tree = validatePlannedTree({
			intentBrief: 'Stub INGRN comparison',
			root: {
				id: 'root', title: 'INGRN ↔ JSON', objective: 'demo composition',
				kind: 'composition', composition: 'sequence', inputs: {}, emit: 'discard',
				children: [
					{ id: 'cls', title: 'Class fields', objective: 'extract',
					  kind: 'leaf', skill: 'test.stub-class-fields', emit: 'intermediate',
					  inputs: { className: { source: 'literal', value: 'INGRN' } } },
					{ id: 'shp', title: 'Data shape', objective: 'describe',
					  kind: 'leaf', skill: 'test.stub-data-shape', emit: 'intermediate',
					  inputs: { connectionId: { source: 'literal', value: 'fake-conn' } } },
					{ id: 'aln', title: 'Field alignment', objective: 'align',
					  kind: 'leaf', skill: 'shared.compare.fields-vs-shape', emit: 'section',
					  inputs: {
						classFields: { source: 'node', nodeId: 'cls', path: 'fields' },
						dataShape:   { source: 'node', nodeId: 'shp', path: 'columns' },
						className:   { source: 'literal', value: 'INGRN' },
						dataLabel:   { source: 'literal', value: 'GRN JSON fixtures' },
					  } },
				],
			},
		}) as PlannedTree;

		const result = await executeTree(tree, {
			question: '',
			sessionContext: {},
			runnerDeps: { session: fakeSession(), resolveProvider: () => NEVER_LLM },
		});

		assert.equal(result.failedLeaves, 0, `unexpected failures: ${[...result.nodes.values()].filter(n => n.failed).map(n => n.failureReason).join('; ')}`);

		const alignment = result.nodes.get('aln');
		assert.ok(alignment);
		assert.equal(alignment!.failed, false);
		const value = alignment!.value as { summary: { exact: number; classOnly: number; dataOnly: number }; headline: string };
		// grn_number + grn_amount = 2 exact; class.vendor / data.vendor_details = NOT a rename (different stems) -> classOnly=1, dataOnly=1.
		assert.equal(value.summary.exact,     2);
		assert.equal(value.summary.classOnly, 1);
		assert.equal(value.summary.dataOnly,  1);
		assert.match(value.headline, /INGRN ↔ GRN JSON fixtures/);

		const stitched = stitchTreeSections(tree, result);
		const alignSection = stitched.sections.find(s => s.nodeId === 'aln');
		assert.ok(alignSection);
		// Default auto-render emits JSON for a structured value. We assert
		// the alignment payload is present in the rendered markdown so the
		// orchestrator + drafter could find / reference it.
		assert.match(alignSection!.markdown, /"alignment"/);
		assert.match(alignSection!.markdown, /"class-only"/);
	} finally { await fx.dispose(); }
});
