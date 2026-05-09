/**
 * Tests for the two new Phase 7 LLM-routed meta skills:
 *   - code.meta.classify-question
 *   - code.meta.select-scope
 *
 * Mirrors the data.meta.* test pattern: inject a fakeProvider that
 * returns canned JSON to exercise happy / retry / rejection paths.
 * No daemon, no IPC.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../index.js';
import { getSkill, _resetSkillRegistryForTests } from '../registry.js';
import { runSkillIsolated, type FakeProvider } from '../test-harness.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import {
	_buildCatalogForTest as buildCatalog,
	_matchesRepoCapabilityForTest as matchesRepoCapability,
} from '../built-ins/code.meta.classify-question.js';
import type { LLMResponse } from '../../../shared/types.js';

const CLASSIFY = 'code.meta.classify-question';
const SELECT   = 'code.meta.select-scope';

function setup(): void {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
	assert.ok(getSkill(CLASSIFY), `${CLASSIFY} must be in the registry`);
	assert.ok(getSkill(SELECT),   `${SELECT} must be in the registry`);
}

function fakeProviderReturning(...texts: readonly string[]): FakeProvider {
	let i = 0;
	return {
		async complete(): Promise<LLMResponse> {
			const text = texts[Math.min(i, texts.length - 1)] ?? '';
			i++;
			return { text, stopReason: 'end_turn' };
		},
	};
}

const REPO = { path: '/repo/alpha', primaryLanguages: ['typescript'] };

interface ClassifyValue {
	readonly questionType: string;
	readonly candidates: readonly { readonly skillId: string; readonly rationale: string; readonly mustHaveScope: string }[];
	readonly fallbacks: readonly string[];
	readonly uncertaintyNotes: readonly string[];
}

// ---------------------------------------------------------------------------
// classify-question -- catalog prefilter (no LLM)
// ---------------------------------------------------------------------------

test('catalog: drops meta + synthesis families', () => {
	setup();
	const catalog = buildCatalog(
		{ question: 'q', repo: REPO },
		{ session: {} as unknown as import('../types.js').SkillContext['session'] },
	);
	for (const e of catalog) {
		assert.notEqual(e.family, 'meta');
		assert.notEqual(e.family, 'synthesis');
	}
});

test('catalog: drops code.orm.* when no ORM detected', () => {
	setup();
	const catalog = buildCatalog(
		{ question: 'q', repo: { path: '/repo/alpha' } }, // no detectedOrms
		{ session: {} as unknown as import('../types.js').SkillContext['session'] },
	);
	assert.ok(!catalog.some(e => e.id.startsWith('code.orm.')),
		'code.orm.* skills should not appear when no ORM is detected');
});

test('catalog: keeps code.orm.* when an ORM is detected', () => {
	setup();
	const catalog = buildCatalog(
		{ question: 'q', repo: { path: '/repo/alpha', detectedOrms: ['prisma'] } },
		{ session: {} as unknown as import('../types.js').SkillContext['session'] },
	);
	assert.ok(catalog.some(e => e.id === 'code.orm.resolve-model'));
});

test('catalog: drops code.migration.* when no migration tool present', () => {
	setup();
	const catalog = buildCatalog(
		{ question: 'q', repo: { path: '/repo/alpha' } },
		{ session: {} as unknown as import('../types.js').SkillContext['session'] },
	);
	assert.ok(!catalog.some(e => e.id.startsWith('code.migration.')));
});

test('matchesRepoCapability: hardcoded family rules', () => {
	setup();
	// A skill outside code.orm.* / code.migration.* always passes.
	const benignSkill = getSkill('code.entity.summary')!;
	assert.ok(matchesRepoCapability(benignSkill, [], undefined));

	const ormSkill = getSkill('code.orm.resolve-model')!;
	assert.equal(matchesRepoCapability(ormSkill, [], undefined), false);
	assert.ok(matchesRepoCapability(ormSkill, ['prisma'], undefined));

	const migSkill = getSkill('code.migration.extract-history')!;
	assert.equal(matchesRepoCapability(migSkill, [], undefined), false);
	assert.ok(matchesRepoCapability(migSkill, [], 'prisma-migrate'));
});

// ---------------------------------------------------------------------------
// classify-question -- happy path
// ---------------------------------------------------------------------------

test('classify-question: valid LLM JSON -> high confidence', async () => {
	setup();
	const validJson = JSON.stringify({
		questionType: 'describe-file',
		candidates: [
			{ skillId: 'code.source.file.describe', rationale: 'single file enumeration', mustHaveScope: 'repo+file' },
		],
		fallbacks: [],
		uncertaintyNotes: [],
	});
	const { result } = await runSkillIsolated<unknown, ClassifyValue>(
		CLASSIFY,
		{ question: 'What does src/User.ts define?', repo: REPO },
		{ fakeProvider: fakeProviderReturning(validJson) },
	);
	assert.equal(result.confidence, 'high');
	assert.equal(result.value.candidates[0]!.skillId, 'code.source.file.describe');
});

test('classify-question: uncertainty notes -> medium confidence', async () => {
	setup();
	const json = JSON.stringify({
		questionType: 'version-diff',
		candidates: [
			{ skillId: 'code.compare.entity-versions', rationale: 'two-ref diff', mustHaveScope: 'repo+entity' },
		],
		fallbacks: [],
		uncertaintyNotes: ['baseRef not specified in question'],
	});
	const { result } = await runSkillIsolated<unknown, ClassifyValue>(
		CLASSIFY,
		{ question: 'How did parseConfig change?', repo: REPO },
		{ fakeProvider: fakeProviderReturning(json) },
	);
	assert.equal(result.confidence, 'medium');
	assert.ok(result.notes?.includes('baseRef not specified in question'));
});

test('classify-question: hallucinated skillId rejected on retry -> low', async () => {
	setup();
	const hallucination = JSON.stringify({
		questionType: 'free-form',
		candidates: [{ skillId: 'code.does.not.exist', rationale: 'fake', mustHaveScope: 'repo' }],
		fallbacks: [],
		uncertaintyNotes: [],
	});
	const { result } = await runSkillIsolated<unknown, ClassifyValue>(
		CLASSIFY,
		{ question: 'q', repo: REPO },
		{ fakeProvider: fakeProviderReturning(hallucination, hallucination) },
	);
	assert.equal(result.confidence, 'low');
	const noteText = (result.notes ?? []).join(' | ');
	assert.match(noteText, /validation twice|not in the catalog/);
});

test('classify-question: first-pass invalid + second-pass valid -> high', async () => {
	setup();
	const valid = JSON.stringify({
		questionType: 'quality',
		candidates: [
			{ skillId: 'code.quality.complexity', rationale: 'after retry', mustHaveScope: 'repo' },
		],
		fallbacks: [],
		uncertaintyNotes: [],
	});
	const { result } = await runSkillIsolated<unknown, ClassifyValue>(
		CLASSIFY,
		{ question: 'q', repo: REPO },
		{ fakeProvider: fakeProviderReturning('not-json', valid) },
	);
	assert.equal(result.confidence, 'high');
	assert.equal(result.value.candidates[0]!.rationale, 'after retry');
});

// ---------------------------------------------------------------------------
// select-scope
// ---------------------------------------------------------------------------

interface SelectValue {
	readonly scoped: readonly { readonly skillId: string; readonly args: Record<string, unknown>; readonly resolvedScope: Record<string, unknown>; readonly ambiguity?: Record<string, unknown> }[];
	readonly notes:  readonly string[];
}

test('select-scope: empty candidates -> low confidence', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, SelectValue>(
		SELECT,
		{ question: 'q', candidates: [], repo: REPO },
		{ fakeProvider: fakeProviderReturning('{}') },
	);
	assert.equal(result.confidence, 'low');
	assert.equal(result.value.scoped.length, 0);
});

test('select-scope: valid args validated against the skill\'s inputSchema -> high', async () => {
	setup();
	const valid = JSON.stringify({
		scoped: [
			{
				skillId: 'code.source.repo.describe',
				args: { repoPath: REPO.path },
				resolvedScope: { repoPath: REPO.path },
			},
		],
		notes: [],
	});
	const { result } = await runSkillIsolated<unknown, SelectValue>(
		SELECT,
		{
			question: 'Describe the repo.',
			candidates: [
				{ skillId: 'code.source.repo.describe', rationale: 'repo summary', mustHaveScope: 'repo' },
			],
			repo: REPO,
		},
		{ fakeProvider: fakeProviderReturning(valid) },
	);
	assert.equal(result.confidence, 'high');
	assert.equal(result.value.scoped.length, 1);
	assert.equal(result.value.scoped[0]!.args['repoPath'], REPO.path);
});

test('select-scope: args missing required field -> validation rejects -> retry; second still bad -> low', async () => {
	setup();
	// `code.source.repo.describe` requires `repoPath`. Our fake omits it.
	const bad = JSON.stringify({
		scoped: [
			{ skillId: 'code.source.repo.describe', args: {}, resolvedScope: { repoPath: REPO.path } },
		],
		notes: [],
	});
	const { result } = await runSkillIsolated<unknown, SelectValue>(
		SELECT,
		{
			question: 'q',
			candidates: [
				{ skillId: 'code.source.repo.describe', rationale: 'r', mustHaveScope: 'repo' },
			],
			repo: REPO,
		},
		{ fakeProvider: fakeProviderReturning(bad, bad) },
	);
	assert.equal(result.confidence, 'low');
	const noteText = (result.notes ?? []).join(' | ');
	assert.match(noteText, /failed inputSchema|repoPath/);
});

test('select-scope: ambiguity surfaces medium confidence', async () => {
	setup();
	const value = JSON.stringify({
		scoped: [
			{
				skillId: 'code.entity.summary',
				args: { entityId: 'a'.repeat(32) },
				resolvedScope: { repoPath: REPO.path, entityRef: 'compute' },
				ambiguity: { kind: 'multiple-matches', alternatives: ['compute@a.ts', 'compute@b.ts'] },
			},
		],
		notes: [],
	});
	const { result } = await runSkillIsolated<unknown, SelectValue>(
		SELECT,
		{
			question: 'Show me compute.',
			candidates: [
				{ skillId: 'code.entity.summary', rationale: 'r', mustHaveScope: 'repo+entity' },
			],
			repo: REPO,
		},
		{ fakeProvider: fakeProviderReturning(value) },
	);
	assert.equal(result.confidence, 'medium');
	assert.equal(result.value.scoped[0]!.ambiguity!['kind'], 'multiple-matches');
});

test('select-scope: repoPath mismatch is rejected', async () => {
	setup();
	const bad = JSON.stringify({
		scoped: [
			{ skillId: 'code.source.repo.describe', args: { repoPath: '/wrong' }, resolvedScope: { repoPath: '/wrong' } },
		],
		notes: [],
	});
	const { result } = await runSkillIsolated<unknown, SelectValue>(
		SELECT,
		{
			question: 'q',
			candidates: [
				{ skillId: 'code.source.repo.describe', rationale: 'r', mustHaveScope: 'repo' },
			],
			repo: REPO,
		},
		{ fakeProvider: fakeProviderReturning(bad, bad) },
	);
	assert.equal(result.confidence, 'low');
	const noteText = (result.notes ?? []).join(' | ');
	assert.match(noteText, /repoPath/);
});
