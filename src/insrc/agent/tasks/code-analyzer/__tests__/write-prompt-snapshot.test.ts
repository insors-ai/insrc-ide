/**
 * Phase 3 of plans/code-analyzer-externalize-prompts.md.
 *
 * Golden-file snapshot test for the externalized Write (Phase W)
 * system prompt. Same pattern as gather-prompt-snapshot.test.ts:
 * compose flow/write/system.md with a fixed repo-context fixture,
 * compare against committed golden under prompts-golden/write.txt.
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
const GOLDEN_PATH = join(HERE, 'prompts-golden', 'write.txt');

const FIXTURE_REPO_CONTEXT_PRESENT =
	'\n\n## Repository under analysis\n' +
	'Repo: example/demo\n' +
	'Files: 42\n' +
	'Top modules: alpha, beta';

test('flow/write/system.md composes byte-equivalently to golden (with repo summary)', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('write', {
		REPO_CONTEXT: FIXTURE_REPO_CONTEXT_PRESENT,
	});

	if (process.env['INSRC_PROMPT_SNAPSHOT_UPDATE'] === '1') {
		writeFileSync(GOLDEN_PATH, composed + '\n', 'utf8');
		console.log(`updated golden: ${GOLDEN_PATH}`);
		return;
	}

	const golden = readFileSync(GOLDEN_PATH, 'utf8').replace(/\n$/, '');
	assert.equal(composed, golden, snapshotMismatchHint());
});

test('flow/write/system.md drops repo-context block when no repo summary', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('write', { REPO_CONTEXT: '' });
	assert.doesNotMatch(composed, /## Repository under analysis/);
});

test('flow/write/system.md preserves BEGIN/END section markers', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('write', { REPO_CONTEXT: '' });
	for (const section of [
		'compliance', 'role', 'anti-hallucination',
		'citation-rules', 'error-catalog', 'gap-paragraph-template',
		'output-format',
	]) {
		assert.match(composed, new RegExp(`<!-- BEGIN SECTION: ${section} -->`));
		assert.match(composed, new RegExp(`<!-- END SECTION: ${section} -->`));
	}
});

test('flow/write/system.md includes the error catalog + gap template (Phase 6)', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('write', { REPO_CONTEXT: '' });
	// Spot-check Phase 6 content is wired in.
	assert.match(composed, /Common failure patterns/);
	assert.match(composed, /FABRICATED PARAGRAPH/);
	assert.match(composed, /GROUNDED PARAGRAPH/);
	assert.match(composed, /HAND-ROLLED CITATION/);
	assert.match(composed, /When the evidence does not cover a topic/);
	assert.match(composed, /A short honest gap is preferred/);
});

test('flow/write/system.md carries the anti-hallucination contract + ledger references', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('write', { REPO_CONTEXT: '' });
	// Spot-check that the writer-specific anti-hall content (different
	// from gather's investigator content) is present.
	assert.match(composed, /Anti-hallucination contract/);
	assert.match(composed, /evidence ledger/i);
	assert.match(composed, /\[label\]\(path:\.\.\.\)/);
});

function snapshotMismatchHint(): string {
	return (
		'Write flow prompt diverged from the committed golden.\n' +
		'If the divergence is intentional (e.g. you edited a section), regenerate:\n' +
		'  INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test \\\n' +
		'    src/insrc/agent/tasks/code-analyzer/__tests__/write-prompt-snapshot.test.ts'
	);
}
