/**
 * Phase 2 of plans/code-analyzer-externalize-prompts.md +
 * Phase D of plans/code-analyzer-scope-tier-prompts.md (per-tier dispatch).
 *
 * Golden-file snapshot tests for the externalized Gather (Phase G)
 * system prompt -- ONE golden per tier (xl / l / m / s) since the
 * gather flow now dispatches the coverage-angles section by TIER.
 *
 * Update goldens: INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test <this-file>
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFlowPrompt, _clearCacheForTest } from '../prompts/loader.js';

const HERE       = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, 'prompts-golden');

// ---------------------------------------------------------------------------
// Fixed fixtures -- intentionally tiny so each golden stays readable
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

const TIERS = ['xl', 'l', 'm', 's'] as const;

// ---------------------------------------------------------------------------
// Per-tier byte-equivalence
// ---------------------------------------------------------------------------

for (const tier of TIERS) {
	test(`flow/gather/system.md (tier=${tier}) composes byte-equivalently to golden`, () => {
		_clearCacheForTest();
		const composed = loadFlowPrompt('gather', {
			SKILL_CATALOG: FIXTURE_SKILL_CATALOG,
			REPO_CONTEXT:  FIXTURE_REPO_CONTEXT_PRESENT,
			TIER:          tier,
		});

		const goldenPath = join(GOLDEN_DIR, `gather-${tier}.txt`);
		if (process.env['INSRC_PROMPT_SNAPSHOT_UPDATE'] === '1') {
			writeFileSync(goldenPath, composed + '\n', 'utf8');
			console.log(`updated golden: ${goldenPath}`);
			return;
		}
		const golden = readFileSync(goldenPath, 'utf8').replace(/\n$/, '');
		assert.equal(composed, golden, snapshotMismatchHint(tier));
	});
}

// ---------------------------------------------------------------------------
// Cross-tier invariants
// ---------------------------------------------------------------------------

test('flow/gather/system.md drops repo-context block when no repo summary', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('gather', {
		SKILL_CATALOG: FIXTURE_SKILL_CATALOG,
		REPO_CONTEXT:  '',
		TIER:          'm',
	});
	assert.doesNotMatch(composed, /## Repository under analysis/);
	assert.match(composed, /## Available skills[\s\S]+code\.source\.file\.describe[^\n]*\n?$/);
});

test('flow/gather/system.md preserves BEGIN/END section markers (all tiers)', () => {
	for (const tier of TIERS) {
		_clearCacheForTest();
		const composed = loadFlowPrompt('gather', {
			SKILL_CATALOG: FIXTURE_SKILL_CATALOG,
			REPO_CONTEXT:  '',
			TIER:          tier,
		});
		for (const section of [
			'role', 'compliance', 'anti-hallucination',
			'skill-usage', 'skill-glossary', 'coverage-angles', 'output-format',
		]) {
			assert.match(composed, new RegExp(`<!-- BEGIN SECTION: ${section} -->`),
				`tier ${tier} missing BEGIN ${section}`);
			assert.match(composed, new RegExp(`<!-- END SECTION: ${section} -->`),
				`tier ${tier} missing END ${section}`);
		}
	}
});

test('flow/gather/system.md substitutes {{SKILL_CATALOG}} verbatim', () => {
	_clearCacheForTest();
	const sentinel = '## SENTINEL-CATALOG-XYZ\nsentinel-line-1\nsentinel-line-2';
	const composed = loadFlowPrompt('gather', {
		SKILL_CATALOG: sentinel,
		REPO_CONTEXT:  '',
		TIER:          'm',
	});
	assert.ok(composed.includes(sentinel), 'sentinel catalog should appear verbatim');
});

test('flow/gather/system.md (tier=xl) carries the XL+ menu items', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('gather', {
		SKILL_CATALOG: '', REPO_CONTEXT: '', TIER: 'xl',
	});
	// XL+ menu is the broadest: must reference functional overview,
	// data persistence design, and external dependencies.
	assert.match(composed, /Functional Overview/);
	assert.match(composed, /Data Persistence/);
	assert.match(composed, /External Dependencies/);
});

test('flow/gather/system.md (tier=s) carries the S menu items', () => {
	_clearCacheForTest();
	const composed = loadFlowPrompt('gather', {
		SKILL_CATALOG: '', REPO_CONTEXT: '', TIER: 's',
	});
	// S menu emphasises file-level review + usage review.
	assert.match(composed, /In-depth file review/);
	assert.match(composed, /Usage review/);
});

function snapshotMismatchHint(tier: string): string {
	return (
		`Gather flow prompt (tier=${tier}) diverged from the committed golden.\n` +
		'If the divergence is intentional (e.g. you edited a section), regenerate:\n' +
		'  INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test \\\n' +
		'    src/insrc/agent/tasks/code-analyzer/__tests__/gather-prompt-snapshot.test.ts'
	);
}
