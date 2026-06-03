/**
 * Tests for the cross-category materializer module.
 *
 * Scope:
 *   - extractIdentifierHints: pure extraction logic (no I/O)
 *   - runCategoryMaterializers: cache + ownCategory-skip + not-found
 *     drop + note surfacing semantics, using stub materializers
 *     plugged in via the exported CATEGORY_MATERIALIZERS registry.
 *
 * The real materializers (materializeCode / materializeData) touch
 * LMDB + the data pool and are exercised by the live integration
 * tests; unit-testing them here would duplicate that surface without
 * adding signal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	extractIdentifierHints,
	runCategoryMaterializers,
	CATEGORY_MATERIALIZERS,
	type MaterializerOutcome,
	type CategoryResourceMaterializer,
} from '../category-materializer.js';
import type { PlannedAction } from '../plan-actions.js';
import type { SkillOwner } from '../../../daemon/skills/types.js';

// Test-only registry mutation: see CATEGORY_MATERIALIZERS comment in the
// module under test. The Readonly type is enforced at compile time; the
// underlying object is intentionally left mutable for this pattern.
const REG = CATEGORY_MATERIALIZERS as unknown as Record<SkillOwner, CategoryResourceMaterializer | undefined>;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FAKE_SESSION = { repoPath: '/repo/x', access: undefined } as never;

function fakeAction(overrides: Partial<PlannedAction> = {}): PlannedAction {
	return {
		id:                 'a1',
		title:              'INGRN Pydantic Class Fields',
		objective:          'Extract field types and validation rules from the INGRN pydantic class.',
		maxBudgetTokens:    1500,
		reviewCriteria:     ['names each field with its type'],
		requiredCategories: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// extractIdentifierHints
// ---------------------------------------------------------------------------

test('extractIdentifierHints: catches PascalCase + ALLCAPS identifiers', () => {
	const out = extractIdentifierHints({
		action:  fakeAction({ title: 'INGRN class', objective: 'compare FooBar to BazQux' }),
		request: '',
		session: FAKE_SESSION,
	});
	assert.deepEqual([...out], ['INGRN', 'FooBar', 'BazQux']);
});

test('extractIdentifierHints: drops common acronym stop-words (JSON, CSV, API, ...)', () => {
	const out = extractIdentifierHints({
		action:  fakeAction({ title: 'Compare JSON test data to INGRN', objective: 'Use the API to fetch CSV files' }),
		request: '',
		session: FAKE_SESSION,
	});
	assert.equal(out.includes('JSON'), false);
	assert.equal(out.includes('CSV'),  false);
	assert.equal(out.includes('API'),  false);
	assert.equal(out.includes('INGRN'), true);
});

test('extractIdentifierHints: dedupes repeats + caps at 12', () => {
	const objective = Array.from({ length: 30 }, (_, i) => `Foo${i}`).join(' ');
	const out = extractIdentifierHints({
		action:  fakeAction({ title: 'Foo0 Foo0 Foo0', objective }),
		request: '',
		session: FAKE_SESSION,
	});
	assert.equal(out.length, 12);
	// First entry deduped against the title repeats.
	const seen = new Set(out);
	assert.equal(seen.size, out.length);
});

test('extractIdentifierHints: scans title + objective + request together', () => {
	const out = extractIdentifierHints({
		action:  fakeAction({ title: 'Only TitleClass', objective: 'Only ObjectiveClass' }),
		request: 'RequestClass too',
		session: FAKE_SESSION,
	});
	assert.equal(out.includes('TitleClass'),     true);
	assert.equal(out.includes('ObjectiveClass'), true);
	assert.equal(out.includes('RequestClass'),   true);
});

// ---------------------------------------------------------------------------
// runCategoryMaterializers: cache + skip-own + drop-not-found semantics
// ---------------------------------------------------------------------------

function stubMaterializer(outcome: MaterializerOutcome, callLog: string[], label: string): CategoryResourceMaterializer {
	return async () => {
		callLog.push(label);
		return outcome;
	};
}

function patchRegistry(slot: SkillOwner, m: CategoryResourceMaterializer | undefined): () => void {
	const original = REG[slot];
	REG[slot] = m;
	return () => { REG[slot] = original; };
}

test('runCategoryMaterializers: skips own category implicitly', async () => {
	const callLog: string[] = [];
	const notes: string[]   = [];
	const restoreCode = patchRegistry('code-analyzer', stubMaterializer(
		{ kind: 'resolved', resource: { category: 'code-analyzer', repoPath: '/repo/c', label: 'c' }, notes: [] },
		callLog, 'code',
	));
	try {
		const action = fakeAction({ requiredCategories: ['code-analyzer', 'data-analyzer'] });
		const out = await runCategoryMaterializers({
			action, ownCategory: 'data-analyzer', request: '', session: FAKE_SESSION,
			emitNote: (l) => notes.push(l),
		}, new Map());
		assert.deepEqual([...out.effectiveCategories], ['code-analyzer']);
		assert.equal(out.resources.length, 1);
		assert.deepEqual(callLog, ['code']);   // own category 'data-analyzer' never invoked
	} finally {
		restoreCode();
	}
});

test('runCategoryMaterializers: caches result per category across actions', async () => {
	const callLog: string[] = [];
	const restoreCode = patchRegistry('code-analyzer', stubMaterializer(
		{ kind: 'resolved', resource: { category: 'code-analyzer', repoPath: '/repo/c', label: 'c' }, notes: [] },
		callLog, 'code',
	));
	try {
		const cache = new Map<SkillOwner, MaterializerOutcome>();
		const a1 = fakeAction({ id: 'a1', requiredCategories: ['code-analyzer'] });
		const a2 = fakeAction({ id: 'a2', requiredCategories: ['code-analyzer'] });
		await runCategoryMaterializers({ action: a1, ownCategory: 'data-analyzer', request: '', session: FAKE_SESSION, emitNote: () => {} }, cache);
		await runCategoryMaterializers({ action: a2, ownCategory: 'data-analyzer', request: '', session: FAKE_SESSION, emitNote: () => {} }, cache);
		assert.deepEqual(callLog, ['code']);   // only called once despite two actions
	} finally {
		restoreCode();
	}
});

test('runCategoryMaterializers: not-found drops the category from effective list', async () => {
	const notes: string[] = [];
	const restoreCode = patchRegistry('code-analyzer', stubMaterializer(
		{ kind: 'not-found', notes: ['no class matched'] },
		[], 'code',
	));
	try {
		const action = fakeAction({ requiredCategories: ['code-analyzer'] });
		const out = await runCategoryMaterializers({
			action, ownCategory: 'data-analyzer', request: '', session: FAKE_SESSION,
			emitNote: (l) => notes.push(l),
		}, new Map());
		assert.deepEqual([...out.effectiveCategories], []);
		assert.equal(out.resources.length, 0);
		// The not-found note still surfaces.
		assert.equal(notes.some(n => n.includes('no class matched')), true);
	} finally {
		restoreCode();
	}
});

test('runCategoryMaterializers: ambiguous surfaces notes but keeps chosen in effective list', async () => {
	const notes: string[] = [];
	const restoreCode = patchRegistry('code-analyzer', stubMaterializer(
		{
			kind:         'ambiguous',
			chosen:       { category: 'code-analyzer', repoPath: '/repo/a', label: 'a' },
			alternatives: [{ category: 'code-analyzer', repoPath: '/repo/b', label: 'b' }],
			notes:        ['ambiguous: 2 repos matched', 'rerun with more specific hint'],
		},
		[], 'code',
	));
	try {
		const action = fakeAction({ requiredCategories: ['code-analyzer'] });
		const out = await runCategoryMaterializers({
			action, ownCategory: 'data-analyzer', request: '', session: FAKE_SESSION,
			emitNote: (l) => notes.push(l),
		}, new Map());
		assert.deepEqual([...out.effectiveCategories], ['code-analyzer']);
		assert.equal(out.resources.length, 1);
		assert.equal(out.resources[0]!.category === 'code-analyzer' && out.resources[0]!.repoPath === '/repo/a', true);
		assert.equal(notes.some(n => n.includes('ambiguous: 2 repos matched')), true);
	} finally {
		restoreCode();
	}
});

test('runCategoryMaterializers: unknown category logged as skipped', async () => {
	const notes: string[] = [];
	// 'deploy-analyzer' has no registered materializer.
	const action = fakeAction({ requiredCategories: ['deploy-analyzer'] });
	const out = await runCategoryMaterializers({
		action, ownCategory: 'data-analyzer', request: '', session: FAKE_SESSION,
		emitNote: (l) => notes.push(l),
	}, new Map());
	assert.deepEqual([...out.effectiveCategories], []);
	assert.equal(notes.some(n => n.includes('no materializer registered')), true);
});

test('runCategoryMaterializers: materializer throw is contained, surfaced as not-found', async () => {
	const notes: string[] = [];
	const restoreCode = patchRegistry('code-analyzer', async () => {
		throw new Error('boom');
	});
	try {
		const action = fakeAction({ requiredCategories: ['code-analyzer'] });
		const out = await runCategoryMaterializers({
			action, ownCategory: 'data-analyzer', request: '', session: FAKE_SESSION,
			emitNote: (l) => notes.push(l),
		}, new Map());
		assert.deepEqual([...out.effectiveCategories], []);
		assert.equal(notes.some(n => n.includes('materializer threw: boom')), true);
	} finally {
		restoreCode();
	}
});
