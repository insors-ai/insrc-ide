/**
 * Phase 5 of plans/code-analyzer-externalize-prompts.md.
 *
 * Golden-file snapshot test for the externalized Review (Phase R)
 * system prompt. Same pattern as the other flow snapshot tests:
 * compose flow/review/system.md (no variables required) and compare
 * against prompts-golden/review.txt.
 *
 * Update golden: INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test <this-file>
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFlowPrompt, _clearCacheForTest } from '../prompts/loader.js';

const HERE        = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, 'prompts-golden', 'review.txt');

test('flow/review/system.md composes byte-equivalently to golden', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('review', {});

	if (process.env['INSRC_PROMPT_SNAPSHOT_UPDATE'] === '1') {
		writeFileSync(GOLDEN_PATH, composed + '\n', 'utf8');
		console.log(`updated golden: ${GOLDEN_PATH}`);
		return;
	}

	const golden = readFileSync(GOLDEN_PATH, 'utf8').replace(/\n$/, '');
	assert.equal(composed, golden, snapshotMismatchHint());
});

test('flow/review/system.md preserves BEGIN/END section markers', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('review', {});
	for (const section of [
		'compliance', 'role', 'anti-hallucination',
		'review-rules', 'error-catalog', 'output-format',
	]) {
		assert.match(composed, new RegExp(`<!-- BEGIN SECTION: ${section} -->`));
		assert.match(composed, new RegExp(`<!-- END SECTION: ${section} -->`));
	}
});

test('flow/review/system.md includes the error catalog (Phase 6)', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('review', {});
	// Reviewer side: same catalog, but framed as patterns to FLAG.
	assert.match(composed, /Common failure patterns/);
	assert.match(composed, /FABRICATED PARAGRAPH/);
	assert.match(composed, /HAND-ROLLED CITATION/);
	assert.match(composed, /LANGUAGE THAT CONFESSES THE GAP/);
});

test('flow/review/system.md carries the anti-hallucination gate + verdict guidance', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('review', {});
	assert.match(composed, /Anti-hallucination gate/);
	assert.match(composed, /CLAIMS WITHOUT EVIDENCE/);
	assert.match(composed, /When to pick each verdict/);
	assert.match(composed, /When to pick each work-item kind/);
	assert.match(composed, /Citation preservation/);
});

test('flow/review/system.md ends with strict-JSON output rule', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('review', {});
	assert.match(composed, /Strict JSON ONLY/);
	assert.match(composed, /JSON Schema appears at the end of the user message/);
});

function snapshotMismatchHint(): string {
	return (
		'Review flow prompt diverged from the committed golden.\n' +
		'If the divergence is intentional, regenerate:\n' +
		'  INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test \\\n' +
		'    src/insrc/agent/tasks/code-analyzer/__tests__/review-prompt-snapshot.test.ts'
	);
}
