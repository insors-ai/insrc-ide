/**
 * P5 of plans/planner-cross-category-skills.md.
 *
 * `code.meta.classify-question` and `data.meta.classify-question` each
 * carry a hardcoded owner prefilter that defaults to their own owner.
 * P5 replaced that with a set-based check driven by the new
 * `allowedOwners` input field. These tests pin the contract:
 *   - default (field omitted) -> own-owner only (pre-P5 behavior)
 *   - widened set             -> cross-owner skills survive the filter
 *   - empty set               -> no skills survive (safe degradation)
 *
 * The catalog widening is the load-bearing change. The render-time
 * owner tagging in the user prompt is exercised indirectly via the
 * existing classify-question integration tests; pinning the rendered
 * prompt verbatim would over-fit on the prompt's wording.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _resetSkillRegistryForTests } from '../registry.js';
import { registerAllSkills }            from '../index.js';
import { _buildCatalogForTest as buildCodeCatalog } from '../built-ins/code.meta.classify-question.js';
import { _buildCatalogForTest as buildDataCatalog } from '../built-ins/data.meta.classify-question.js';
import type { SkillContext } from '../types.js';

const FAKE_CTX = {} as unknown as SkillContext;

function setup() {
	_resetSkillRegistryForTests();
	registerAllSkills();
}

// ---------------------------------------------------------------------------
// code.meta.classify-question -- catalog widening
// ---------------------------------------------------------------------------

test('code.meta.classify-question: default allowedOwners -> only code-analyzer skills', () => {
	setup();
	const cat = buildCodeCatalog({
		question: 'List the entities in the active repo.',
		repo:     { path: '/repo/x' },
	}, FAKE_CTX);
	assert.ok(cat.length > 0, 'expected non-empty catalog when registry is loaded');
	for (const e of cat) {
		assert.equal(e.owner, 'code-analyzer', `expected code-analyzer owner, got ${e.owner} for ${e.id}`);
	}
});

test('code.meta.classify-question: allowedOwners=[code-analyzer, data-analyzer] admits both owners', () => {
	setup();
	const cat = buildCodeCatalog({
		question:      'Map the JSON fixture to the INGRN pydantic class.',
		repo:          { path: '/repo/x' },
		allowedOwners: ['code-analyzer', 'data-analyzer'],
	}, FAKE_CTX);
	const owners = new Set(cat.map(e => e.owner));
	assert.ok(owners.has('code-analyzer'), 'code-analyzer skills missing from widened catalog');
	assert.ok(owners.has('data-analyzer'), 'data-analyzer skills missing from widened catalog');
});

test('code.meta.classify-question: allowedOwners=[] drops every skill (safe degradation)', () => {
	setup();
	const cat = buildCodeCatalog({
		question:      'q',
		repo:          { path: '/repo/x' },
		allowedOwners: [],
	}, FAKE_CTX);
	assert.equal(cat.length, 0);
});

test('code.meta.classify-question: allowedOwners=[data-analyzer] only -> own-owner skills excluded', () => {
	setup();
	const cat = buildCodeCatalog({
		question:      'q',
		repo:          { path: '/repo/x' },
		allowedOwners: ['data-analyzer'],
	}, FAKE_CTX);
	for (const e of cat) {
		assert.equal(e.owner, 'data-analyzer', `expected data-analyzer owner, got ${e.owner} for ${e.id}`);
	}
});

// ---------------------------------------------------------------------------
// data.meta.classify-question -- catalog widening
// ---------------------------------------------------------------------------

const FILE_CONNECTION = [{ id: 'file-1', family: 'file', kind: 'json' }];

test('data.meta.classify-question: default allowedOwners -> only data-analyzer skills', () => {
	setup();
	const cat = buildDataCatalog({
		question:    'Describe the schema of the fixture.',
		connections: FILE_CONNECTION,
	}, FAKE_CTX);
	assert.ok(cat.length > 0, 'expected non-empty catalog with file connection registered');
	for (const e of cat) {
		assert.equal(e.owner, 'data-analyzer', `expected data-analyzer owner, got ${e.owner} for ${e.id}`);
	}
});

test('data.meta.classify-question: allowedOwners=[data-analyzer, code-analyzer] admits both owners', () => {
	setup();
	const cat = buildDataCatalog({
		question:      'Map the JSON fixture to the INGRN pydantic class.',
		connections:   FILE_CONNECTION,
		allowedOwners: ['data-analyzer', 'code-analyzer'],
	}, FAKE_CTX);
	const owners = new Set(cat.map(e => e.owner));
	assert.ok(owners.has('data-analyzer'), 'data-analyzer skills missing from widened catalog');
	assert.ok(owners.has('code-analyzer'), 'code-analyzer skills missing from widened catalog');
});

test('data.meta.classify-question: allowedOwners=[] drops every skill (safe degradation)', () => {
	setup();
	const cat = buildDataCatalog({
		question:      'q',
		connections:   FILE_CONNECTION,
		allowedOwners: [],
	}, FAKE_CTX);
	assert.equal(cat.length, 0);
});

test('data.meta.classify-question: catalog sorted by owner first when widened', () => {
	setup();
	const cat = buildDataCatalog({
		question:      'q',
		connections:   FILE_CONNECTION,
		allowedOwners: ['data-analyzer', 'code-analyzer'],
	}, FAKE_CTX);
	// Owners alpha-sorted: code-analyzer before data-analyzer.
	const ownerSequence = cat.map(e => e.owner);
	let lastOwner = '';
	for (const o of ownerSequence) {
		assert.ok(o >= lastOwner, `catalog not sorted by owner: ${ownerSequence.join(',')}`);
		lastOwner = o;
	}
});
