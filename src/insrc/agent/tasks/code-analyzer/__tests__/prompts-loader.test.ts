/**
 * Loader unit tests.
 *
 * Phase 6 of plans/code-analyzer-migration.md collapsed the prompt
 * surface to a single flow: `review`. The writer + gather + patch +
 * discovery-* flows were deleted with the legacy pingpong; per-tier
 * coverage-angles / planner-context sections went with them. The
 * loader's section-include + variable-substitution machinery still
 * matters (review composes via {{section:...}} includes, and the
 * `code.answer-question` L2 skill could grow inline `loadPromptFile`
 * uses later), so the test surface keeps those paths covered against
 * the test-fixture sections in `sections/_test-fixtures/`.
 *
 * These tests run against the SRC tree (no build step) because
 * import.meta.url in `loader.ts` resolves to the .ts location under
 * tsx and the MD files live next to it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	loadFlowPrompt,
	loadPromptFile,
	readSection,
	_clearCacheForTest,
} from '../prompts/loader.js';

const HERE         = dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = join(HERE, '..', 'prompts');

// ---------------------------------------------------------------------------
// Section file invariants
// ---------------------------------------------------------------------------

test('every section under sections/ loads without throwing', () => {
	_clearCacheForTest();
	const sectionFiles = listMdFiles(join(PROMPTS_ROOT, 'sections'))
		.map(abs => relPathFromSections(abs));
	assert.ok(sectionFiles.length > 0, 'expected at least one section file');
	for (const sec of sectionFiles) {
		assert.doesNotThrow(() => readSection(sec), `readSection failed for ${sec}`);
	}
});

test('every section file has non-empty content', () => {
	_clearCacheForTest();
	const sectionFiles = listMdFiles(join(PROMPTS_ROOT, 'sections'))
		.map(abs => relPathFromSections(abs));
	for (const sec of sectionFiles) {
		const raw = readSection(sec);
		assert.ok(raw.trim().length > 0, `section ${sec} is empty`);
	}
});

// ---------------------------------------------------------------------------
// The lone remaining flow composes cleanly
// ---------------------------------------------------------------------------

test('loadFlowPrompt: review composes without throwing', () => {
	_clearCacheForTest();
	const out = loadFlowPrompt('review', {});
	assert.ok(out.length > 0, 'review composed prompt is empty');
	assert.match(out, /<!-- BEGIN SECTION: compliance -->/);
	assert.match(out, /<!-- END SECTION: compliance -->/);
	// Every {{section:...}} include must have been resolved.
	assert.doesNotMatch(out, /\{\{section:/);
});

// ---------------------------------------------------------------------------
// Error modes
// ---------------------------------------------------------------------------

test('loadPromptFile throws ENOENT on a missing file', () => {
	_clearCacheForTest();
	assert.throws(
		() => loadPromptFile('flow/__nonexistent__/system.md', {}),
		/ENOENT|no such file/i,
	);
});

// ---------------------------------------------------------------------------
// Variable substitution INSIDE {{section:path}} (still load-bearing)
// ---------------------------------------------------------------------------

test('{{section:path/{{VAR}}}} dispatches to the right file when VAR is set', () => {
	_clearCacheForTest();
	// Fixture: sections/_test-fixtures/dispatch-root.md contains
	//   {{section:_test-fixtures/leaf-{{LEAF}}}}
	// LEAF='a' -> reads _test-fixtures/leaf-a.md ("LEAF_A_CONTENT")
	const outA = loadPromptFile('sections/_test-fixtures/dispatch-root.md', { LEAF: 'a' });
	assert.match(outA, /LEAF_A_CONTENT/);
	assert.doesNotMatch(outA, /LEAF_B_CONTENT/);

	_clearCacheForTest();
	const outB = loadPromptFile('sections/_test-fixtures/dispatch-root.md', { LEAF: 'b' });
	assert.match(outB, /LEAF_B_CONTENT/);
	assert.doesNotMatch(outB, /LEAF_A_CONTENT/);
});

test('{{section:path/{{VAR}}}} preserves outer text around the dispatch', () => {
	_clearCacheForTest();
	const out = loadPromptFile('sections/_test-fixtures/dispatch-root.md', { LEAF: 'a' });
	assert.match(out, /START\nLEAF_A_CONTENT\n.*END$/s);
});

test('{{section:path/{{VAR}}}} throws when VAR missing from path', () => {
	_clearCacheForTest();
	assert.throws(
		() => loadPromptFile('sections/_test-fixtures/dispatch-root.md', {}),
		/prompt variable missing: LEAF/,
	);
});

test('{{section:path/{{VAR}}}} throws ENOENT when the resolved path does not exist', () => {
	_clearCacheForTest();
	assert.throws(
		() => loadPromptFile('sections/_test-fixtures/dispatch-root.md', { LEAF: 'nope' }),
		/ENOENT|no such file/i,
	);
});

// ---------------------------------------------------------------------------
// Cache hygiene
// ---------------------------------------------------------------------------

test('_clearCacheForTest allows re-read after cache invalidation', () => {
	_clearCacheForTest();
	const first  = readSection('compliance');
	_clearCacheForTest();
	const second = readSection('compliance');
	assert.equal(first, second);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listMdFiles(root: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(root)) {
		const abs = join(root, ent);
		if (statSync(abs).isDirectory()) {
			out.push(...listMdFiles(abs));
		} else if (ent.endsWith('.md')) {
			out.push(abs);
		}
	}
	return out;
}

function relPathFromSections(abs: string): string {
	const sectionsRoot = join(PROMPTS_ROOT, 'sections') + '/';
	return abs.slice(sectionsRoot.length).replace(/\.md$/, '');
}
