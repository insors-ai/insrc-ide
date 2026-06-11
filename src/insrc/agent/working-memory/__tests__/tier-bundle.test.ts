/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the tier-split memory builder -- Phase 2 of
 * plans/section-flow-architecture-redesign.md.
 *
 * The builder is deterministic + LLM-free; tests focus on:
 *
 *   - Field routing: which view gets which input slot.
 *   - Shared blocks: system + toc are byte-identical across views.
 *   - Compatibility adapters: legacy `MemoryShapeBundle` round-trips
 *     through the cloud view without lossy mutation of the 5 base
 *     fields.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildMemoryBundle,
	cloudViewToLegacyBundle,
	legacyBundleToCloudView,
	enforceLocalViewBudget,
	DEFAULT_LOCAL_VIEW_TOKEN_BUDGET,
} from '../tier-bundle.js';
import type { LocalMemoryView } from '../tier-bundle.js';
import type { MemoryShapeBundle } from '../shaper.js';

const SHAPE: MemoryShapeBundle = {
	system:   'system block',
	summary:  'TL;DR of the investigation so far',
	recent:   '- recent finding A\n- recent finding B',
	semantic: '- semantic match in turn 3',
	code:     'class INGRN: ...',
};

const TOC         = '- art-1: located INGRN at insors/grn.py:40. CLOSES ingrn-fields fully';
const FACT_LEDGER = '- gap [ingrn-fields] (covered)\n- gap [json-shape] (open)';
const CURRENT     = 'Active TODO: map GRN JSON to INGRN class (cycle 2, 1 step kept)';
const RECENT      = '- step-1 located INGRN, partial cover\n- step-2 sampled JSON';

// ---------------------------------------------------------------------------
// LocalMemoryView routing
// ---------------------------------------------------------------------------

test('buildMemoryBundle: LocalView gets system + currentTodo + toc + recentSteps', () => {
	const b = buildMemoryBundle({
		shape: SHAPE, toc: TOC, factLedger: FACT_LEDGER,
		currentTodo: CURRENT, recentSteps: RECENT,
	});
	assert.equal(b.local.system,      SHAPE.system);
	assert.equal(b.local.currentTodo, CURRENT);
	assert.equal(b.local.toc,         TOC);
	assert.equal(b.local.recentSteps, RECENT);
});

test('buildMemoryBundle: LocalView omits semantic + code + summary + factLedger', () => {
	const b = buildMemoryBundle({
		shape: SHAPE, toc: TOC, factLedger: FACT_LEDGER,
		currentTodo: CURRENT, recentSteps: RECENT,
	});
	// Whatever the TypeScript shape says, the runtime object must not
	// carry these fields -- the local LLM doesn't need them and they
	// would burn context budget.
	assert.equal('semantic'   in b.local, false);
	assert.equal('code'       in b.local, false);
	assert.equal('summary'    in b.local, false);
	assert.equal('factLedger' in b.local, false);
});

// ---------------------------------------------------------------------------
// CloudMemoryView routing
// ---------------------------------------------------------------------------

test('buildMemoryBundle: CloudView gets all 5 shape fields + toc + factLedger', () => {
	const b = buildMemoryBundle({
		shape: SHAPE, toc: TOC, factLedger: FACT_LEDGER,
		currentTodo: CURRENT, recentSteps: RECENT,
	});
	assert.equal(b.cloud.system,     SHAPE.system);
	assert.equal(b.cloud.summary,    SHAPE.summary);
	assert.equal(b.cloud.recent,     SHAPE.recent);
	assert.equal(b.cloud.semantic,   SHAPE.semantic);
	assert.equal(b.cloud.code,       SHAPE.code);
	assert.equal(b.cloud.toc,        TOC);
	assert.equal(b.cloud.factLedger, FACT_LEDGER);
});

test('buildMemoryBundle: CloudView omits currentTodo + recentSteps (those are local-only)', () => {
	const b = buildMemoryBundle({
		shape: SHAPE, toc: TOC, factLedger: FACT_LEDGER,
		currentTodo: CURRENT, recentSteps: RECENT,
	});
	assert.equal('currentTodo' in b.cloud, false);
	assert.equal('recentSteps' in b.cloud, false);
});

// ---------------------------------------------------------------------------
// Shared blocks (byte-identical across views)
// ---------------------------------------------------------------------------

test('buildMemoryBundle: system + toc shared verbatim across views', () => {
	const b = buildMemoryBundle({
		shape: SHAPE, toc: TOC, factLedger: FACT_LEDGER,
		currentTodo: CURRENT, recentSteps: RECENT,
	});
	assert.equal(b.local.system, b.cloud.system);
	assert.equal(b.local.toc,    b.cloud.toc);
});

// ---------------------------------------------------------------------------
// Empty paths
// ---------------------------------------------------------------------------

test('buildMemoryBundle: empty inputs propagate as empty strings, never undefined', () => {
	const b = buildMemoryBundle({
		shape:       { system: '', summary: '', recent: '', semantic: '', code: '' },
		toc:         '',
		factLedger:  '',
		currentTodo: '',
		recentSteps: '',
	});
	for (const v of Object.values(b.local)) { assert.equal(typeof v, 'string'); }
	for (const v of Object.values(b.cloud)) { assert.equal(typeof v, 'string'); }
});

// ---------------------------------------------------------------------------
// Compatibility adapters
// ---------------------------------------------------------------------------

test('cloudViewToLegacyBundle: strips toc + factLedger, preserves the 5 base fields', () => {
	const b = buildMemoryBundle({
		shape: SHAPE, toc: TOC, factLedger: FACT_LEDGER,
		currentTodo: CURRENT, recentSteps: RECENT,
	});
	const legacy = cloudViewToLegacyBundle(b.cloud);
	assert.deepEqual(legacy, SHAPE);
});

test('legacyBundleToCloudView: lifts to CloudView with empty toc + factLedger', () => {
	const lifted = legacyBundleToCloudView(SHAPE);
	assert.equal(lifted.toc,        '');
	assert.equal(lifted.factLedger, '');
	assert.equal(lifted.system,     SHAPE.system);
	assert.equal(lifted.summary,    SHAPE.summary);
	assert.equal(lifted.code,       SHAPE.code);
});

test('legacyBundleToCloudView + cloudViewToLegacyBundle: round-trip is identity for the 5 base fields', () => {
	const lifted = legacyBundleToCloudView(SHAPE);
	const back   = cloudViewToLegacyBundle(lifted);
	assert.deepEqual(back, SHAPE);
});

// ---------------------------------------------------------------------------
// enforceLocalViewBudget
// ---------------------------------------------------------------------------

const SMALL_LOCAL: LocalMemoryView = {
	system:      'project: insrc; subject: data analysis',
	currentTodo: 'Active TODO: map GRN JSON to INGRN class',
	toc:         '## TOC (no artifacts persisted yet)',
	recentSteps: '- step-1 (ok): s1.a=located INGRN at insors/grn.py',
};

test('enforceLocalViewBudget: under budget -> reference-equal return', () => {
	const out = enforceLocalViewBudget(SMALL_LOCAL);
	assert.equal(out, SMALL_LOCAL, 'no truncation should produce reference-equal output');
});

test('enforceLocalViewBudget: oversize recentSteps -> oldest lines dropped', () => {
	// Build a recentSteps block large enough to exceed the default 6k-
	// token budget (~18k chars). 100 lines x ~500 chars = ~50k chars.
	const longLines: string[] = [];
	for (let i = 0; i < 100; i++) {
		longLines.push(`- step-${i} (ok): ${'x'.repeat(500)}`);
	}
	const view: LocalMemoryView = {
		system:      SMALL_LOCAL.system,
		currentTodo: SMALL_LOCAL.currentTodo,
		toc:         SMALL_LOCAL.toc,
		recentSteps: longLines.join('\n'),
	};
	const out = enforceLocalViewBudget(view);
	assert.notEqual(out, view, 'truncation should return a new object');
	// Newest line MUST be retained; oldest MUST be dropped.
	assert.match(out.recentSteps, /step-99 \(ok\):/);
	assert.ok(!out.recentSteps.includes('step-0 (ok):'), 'oldest line should have been dropped');
	// The other fields are protected.
	assert.equal(out.system,      view.system);
	assert.equal(out.currentTodo, view.currentTodo);
	assert.equal(out.toc,         view.toc);
});

test('enforceLocalViewBudget: protected fields alone exceed budget -> recentSteps emptied', () => {
	const huge = 'x'.repeat(DEFAULT_LOCAL_VIEW_TOKEN_BUDGET * 3 + 100);
	const view: LocalMemoryView = {
		system:      'sys',
		currentTodo: huge,                 // exceeds the whole budget on its own
		toc:         '',
		recentSteps: 'should disappear',
	};
	const out = enforceLocalViewBudget(view);
	assert.equal(out.recentSteps, '');
	// currentTodo stays verbatim (protected, plan: "truncation kicks
	// in oldest-first on recentSteps, not on system or currentTodo").
	assert.equal(out.currentTodo, huge);
});

test('enforceLocalViewBudget: custom budget -> applies', () => {
	const view: LocalMemoryView = {
		system:      '',
		currentTodo: '',
		toc:         '',
		recentSteps: '- old\n- newer\n- newest',
	};
	// 18 chars total / 3 = 6 tokens. Set budget = 3 tokens -> drop
	// oldest until <=9 chars survive.
	const out = enforceLocalViewBudget(view, 3);
	assert.ok(!out.recentSteps.includes('- old'), 'oldest line should have been dropped');
	assert.match(out.recentSteps, /newest/);
});
