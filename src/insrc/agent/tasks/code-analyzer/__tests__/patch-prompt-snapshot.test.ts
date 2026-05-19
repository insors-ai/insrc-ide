/**
 * Phase 4 of plans/code-analyzer-externalize-prompts.md.
 *
 * Golden-file snapshot tests for the externalized Patch (Phase P)
 * system prompts -- three flows, one per kind (fix / enhance / add).
 * Each composition is verified against a committed golden under
 * prompts-golden/patch-<kind>.txt.
 *
 * Update goldens: INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test <this-file>
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPatchPrompt, _clearCacheForTest, type PatchKind } from '../prompts/loader.js';

const HERE         = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR   = join(HERE, 'prompts-golden');

const FIXTURE_SKILL_CATALOG = [
	'## Available skills',
	'You MUST call `skill_describe({ id: <skillId> })` BEFORE `skill_invoke({ skillId, args })` for that skill.',
	'The tool loop rejects undescribed invocations. Describe-once-per-skill-per-section is enough.',
	'',
	'### source',
	'- `code.source.module.describe          ` -- summarise a module',
	'- `code.source.file.describe            ` -- summarise one file',
].join('\n');

const FIXTURE_REPO_CONTEXT =
	'\n\n## Repository under analysis\n' +
	'Repo: example/demo\n' +
	'Files: 42\n' +
	'Top modules: alpha, beta';

const KINDS: readonly PatchKind[] = ['fix', 'add'];

for (const kind of KINDS) {
	test(`flow/patch/${kind}/system.md composes byte-equivalently to golden`, () => {
		_clearCacheForTest();
		const composed = loadPatchPrompt(kind, {
			SKILL_CATALOG: FIXTURE_SKILL_CATALOG,
			REPO_CONTEXT:  FIXTURE_REPO_CONTEXT,
		});

		const goldenPath = join(GOLDEN_DIR, `patch-${kind}.txt`);
		if (process.env['INSRC_PROMPT_SNAPSHOT_UPDATE'] === '1') {
			writeFileSync(goldenPath, composed + '\n', 'utf8');
			console.log(`updated golden: ${goldenPath}`);
			return;
		}
		const golden = readFileSync(goldenPath, 'utf8').replace(/\n$/, '');
		assert.equal(composed, golden, snapshotMismatchHint(kind));
	});

	test(`flow/patch/${kind}/system.md preserves BEGIN/END section markers`, () => {
		_clearCacheForTest();
		const composed = loadPatchPrompt(kind, { SKILL_CATALOG: '', REPO_CONTEXT: '' });
		for (const section of [
			'compliance', 'role', 'anti-hallucination',
			'coverage-angles', 'error-catalog', 'gap-paragraph-template',
			'output-format',
		]) {
			assert.match(composed, new RegExp(`<!-- BEGIN SECTION: ${section} -->`));
			assert.match(composed, new RegExp(`<!-- END SECTION: ${section} -->`));
		}
	});

	test(`flow/patch/${kind}/system.md includes the error catalog + gap template (Phase 6)`, () => {
		_clearCacheForTest();
		const composed = loadPatchPrompt(kind, { SKILL_CATALOG: '', REPO_CONTEXT: '' });
		assert.match(composed, /Common failure patterns/);
		assert.match(composed, /FABRICATED PARAGRAPH/);
		assert.match(composed, /When the evidence does not cover a topic/);
	});
}

test('fix-kind intro emphasizes "NOT optional"', () => {
	_clearCacheForTest();
	const composed = loadPatchPrompt('fix', { SKILL_CATALOG: '', REPO_CONTEXT: '' });
	assert.match(composed, /NOT optional/);
	assert.match(composed, /MUST change/);
});

test('add-kind intro talks about ADDING a new paragraph', () => {
	_clearCacheForTest();
	const composed = loadPatchPrompt('add', { SKILL_CATALOG: '', REPO_CONTEXT: '' });
	assert.match(composed, /ADDING ONE new paragraph/);
});

function snapshotMismatchHint(kind: PatchKind): string {
	return (
		`Patch ${kind} flow prompt diverged from the committed golden.\n` +
		'If the divergence is intentional, regenerate:\n' +
		'  INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test \\\n' +
		'    src/insrc/agent/tasks/code-analyzer/__tests__/patch-prompt-snapshot.test.ts'
	);
}
