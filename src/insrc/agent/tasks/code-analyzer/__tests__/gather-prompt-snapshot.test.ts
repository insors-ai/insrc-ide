/**
 * Phase 2 of plans/code-analyzer-externalize-prompts.md.
 *
 * Golden-file snapshot test for the externalized Gather (Phase G)
 * system prompt. The test:
 *
 *   1. Composes the gather flow prompt with a fixed skill catalog +
 *      fixed repo summary fixture (no real I/O against the daemon).
 *   2. Reads the committed golden file `prompts-golden/gather.txt`.
 *   3. Asserts byte-equivalence.
 *
 * When you edit any of the gather-flow sections (compliance,
 * anti-hallucination/investigator, skill-usage, coverage-angles,
 * output-format/gather, role-gather, or flow/gather/system.md) the
 * test will fail. Eyeball the diff and update the golden file with:
 *
 *   INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test \
 *     src/insrc/agent/tasks/code-analyzer/__tests__/gather-prompt-snapshot.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFlowPrompt, _clearCacheForTest } from '../prompts/loader.js';

const HERE        = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, 'prompts-golden', 'gather.txt');

// ---------------------------------------------------------------------------
// Fixed fixtures -- intentionally tiny so the golden stays readable
// ---------------------------------------------------------------------------

const FIXTURE_SKILL_CATALOG = [
	'## Available skills',
	'You MUST call `skill_describe({ id: <skillId> })` BEFORE `skill_invoke({ skillId, args })` for that skill.',
	'The tool loop rejects undescribed invocations. Describe-once-per-skill-per-section is enough.',
	'',
	'### source',
	'- `code.source.module.describe          ` -- summarise a module',
	'- `code.source.file.describe            ` -- summarise one file',
].join('\n');

const FIXTURE_REPO_CONTEXT_PRESENT =
	'\n\n## Repository under analysis\n' +
	'Repo: example/demo\n' +
	'Files: 42\n' +
	'Top modules: alpha, beta';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('flow/gather/system.md composes byte-equivalently to golden (with repo summary)', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('gather', {
		SKILL_CATALOG: FIXTURE_SKILL_CATALOG,
		REPO_CONTEXT:  FIXTURE_REPO_CONTEXT_PRESENT,
	});

	if (process.env['INSRC_PROMPT_SNAPSHOT_UPDATE'] === '1') {
		writeFileSync(GOLDEN_PATH, composed + '\n', 'utf8');
		console.log(`updated golden: ${GOLDEN_PATH}`);
		return;
	}

	const golden = readGolden();
	assert.equal(composed, golden, snapshotMismatchHint());
});

test('flow/gather/system.md drops repo-context block when no repo summary', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('gather', {
		SKILL_CATALOG: FIXTURE_SKILL_CATALOG,
		REPO_CONTEXT:  '',
	});
	// The composed prompt must NOT contain "Repository under analysis"
	// when the caller passes empty repo context (gather-evidence.ts
	// gates this by checking `repoSizeSummary.empty`).
	assert.doesNotMatch(composed, /## Repository under analysis/);
	// And it MUST end with the skill catalog (no trailing repo block).
	assert.match(composed, /## Available skills[\s\S]+code\.source\.file\.describe[^\n]*\n?$/);
});

test('flow/gather/system.md preserves BEGIN/END section markers', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('gather', {
		SKILL_CATALOG: FIXTURE_SKILL_CATALOG,
		REPO_CONTEXT:  '',
	});
	for (const section of [
		'role', 'compliance', 'anti-hallucination',
		'skill-usage', 'coverage-angles', 'output-format',
	]) {
		assert.match(composed, new RegExp(`<!-- BEGIN SECTION: ${section} -->`));
		assert.match(composed, new RegExp(`<!-- END SECTION: ${section} -->`));
	}
});

test('flow/gather/system.md substitutes {{SKILL_CATALOG}} verbatim', () => {
	_clearCacheForTest();
	const sentinel = '## SENTINEL-CATALOG-XYZ\nsentinel-line-1\nsentinel-line-2';
	const composed = loadFlowPrompt('gather', {
		SKILL_CATALOG: sentinel,
		REPO_CONTEXT:  '',
	});
	assert.ok(composed.includes(sentinel), 'sentinel catalog should appear verbatim');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readGolden(): string {
	try {
		// strip trailing newline that writeFileSync added during update
		return readFileSync(GOLDEN_PATH, 'utf8').replace(/\n$/, '');
	} catch {
		throw new Error(
			`golden file not found at ${GOLDEN_PATH}.\n` +
			'Generate it with: INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test <this-file>',
		);
	}
}

function snapshotMismatchHint(): string {
	return (
		'Gather flow prompt diverged from the committed golden.\n' +
		'If the divergence is intentional (e.g. you edited a section), regenerate the golden:\n' +
		'  INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test \\\n' +
		'    src/insrc/agent/tasks/code-analyzer/__tests__/gather-prompt-snapshot.test.ts'
	);
}
