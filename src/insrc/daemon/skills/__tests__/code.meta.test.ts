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
import type { CompletionOpts, LLMMessage, LLMResponse } from '../../../shared/types.js';

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

/**
 * Returns canned JSON texts wrapped as `tool_use` responses so the
 * meta-skills' tool-call protocol parses them as if a real cloud
 * provider had emitted the structured payload. Picks the tool name
 * from the caller's `opts.toolChoice` (set per skill: classify-
 * question uses `submit_classification`; select-scope uses
 * `submit_scope`), so the same helper serves both skills in this
 * file. If a staged text isn't valid JSON (legacy "garbage in,
 * garbage out" tests), falls back to a text-only end_turn response
 * which the skill treats as "no tool_use payload" -> validation
 * failure -> retry path.
 */
function fakeProviderReturning(...texts: readonly string[]): FakeProvider {
	let i = 0;
	return {
		async complete(_msgs: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse> {
			const text = texts[Math.min(i, texts.length - 1)] ?? '';
			i++;
			const toolName = opts?.toolChoice !== undefined
				&& typeof opts.toolChoice === 'object'
				&& 'name' in opts.toolChoice
				? (opts.toolChoice as { name: string }).name
				: 'submit_classification';
			const unwrapped = text.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
			try {
				const parsed = JSON.parse(unwrapped);
				return {
					text:       '',
					stopReason: 'tool_use',
					toolCalls:  [{ id: `tc-${i}`, name: toolName, input: parsed }],
				};
			} catch {
				// Not JSON -- emit plain text so the skill's parser sees
				// "no tool_use payload" and exercises the rejection path.
				return { text, stopReason: 'end_turn' };
			}
		},
	};
}

const REPO = { path: '/repo/alpha', primaryLanguages: ['typescript'] };

interface ClassifyValue {
	readonly questionType: string;
	readonly candidates: readonly {
		readonly skillId: string;
		readonly rationale: string;
		readonly goal: string;
		readonly mustHaveScope: string;
	}[];
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
			{
				skillId: 'code.source.file.describe',
				rationale: 'single file enumeration',
				goal: 'Enumerate entities + imports declared in src/User.ts so the caller can render the file surface.',
				mustHaveScope: 'repo+file',
			},
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
	const cand = result.value.candidates[0]!;
	assert.equal(cand.skillId, 'code.source.file.describe');
	// A5: every candidate carries a non-empty goal.
	assert.ok(typeof cand.goal === 'string' && cand.goal.length > 0,
		'candidate must include a non-empty goal per A5');
});

test('classify-question: uncertainty notes -> medium confidence', async () => {
	setup();
	const json = JSON.stringify({
		questionType: 'version-diff',
		candidates: [
			{
				skillId: 'code.compare.entity-versions',
				rationale: 'two-ref diff',
				goal: 'Diff parseConfig across two git refs and return the structural delta.',
				mustHaveScope: 'repo+entity',
			},
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
		candidates: [{
			skillId: 'code.does.not.exist',
			rationale: 'fake',
			goal: 'whatever',
			mustHaveScope: 'repo',
		}],
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
			{
				skillId: 'code.quality.complexity',
				rationale: 'after retry',
				goal: 'Compute cyclomatic per function across the repo so the caller can filter to high-complexity entries.',
				mustHaveScope: 'repo',
			},
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
// classify-question A5: goal validation (per plans/skills/code/code.meta.classify-question.md)
// ---------------------------------------------------------------------------

test('classify-question (A5): missing goal -> rejected on retry -> low confidence', async () => {
	setup();
	const noGoal = JSON.stringify({
		questionType: 'describe-file',
		candidates: [
			// `goal` field omitted -- must be rejected by parseAndValidate.
			{ skillId: 'code.source.file.describe', rationale: 'single file', mustHaveScope: 'repo+file' },
		],
		fallbacks: [],
		uncertaintyNotes: [],
	});
	const { result } = await runSkillIsolated<unknown, ClassifyValue>(
		CLASSIFY,
		{ question: 'q', repo: REPO },
		{ fakeProvider: fakeProviderReturning(noGoal, noGoal) },
	);
	assert.equal(result.confidence, 'low');
	const noteText = (result.notes ?? []).join(' | ');
	assert.match(noteText, /goal must be a non-empty string/,
		`expected goal-validation note; got: ${noteText}`);
});

test('classify-question (A5): empty-string goal -> rejected', async () => {
	setup();
	const emptyGoal = JSON.stringify({
		questionType: 'describe-file',
		candidates: [
			{ skillId: 'code.source.file.describe', rationale: 'single file', goal: '', mustHaveScope: 'repo+file' },
		],
		fallbacks: [],
		uncertaintyNotes: [],
	});
	const { result } = await runSkillIsolated<unknown, ClassifyValue>(
		CLASSIFY,
		{ question: 'q', repo: REPO },
		{ fakeProvider: fakeProviderReturning(emptyGoal, emptyGoal) },
	);
	assert.equal(result.confidence, 'low');
	const noteText = (result.notes ?? []).join(' | ');
	assert.match(noteText, /goal must be a non-empty string/);
});

test('classify-question (A5): goal present + non-empty -> threaded through to the candidate', async () => {
	setup();
	const detailedGoal = 'Enumerate every entity declared in src/User.ts plus its imports; surface exports vs internals so the caller can render an API summary.';
	const json = JSON.stringify({
		questionType: 'describe-file',
		candidates: [
			{ skillId: 'code.source.file.describe', rationale: 'enum file', goal: detailedGoal, mustHaveScope: 'repo+file' },
		],
		fallbacks: [],
		uncertaintyNotes: [],
	});
	const { result } = await runSkillIsolated<unknown, ClassifyValue>(
		CLASSIFY,
		{ question: 'What does src/User.ts define?', repo: REPO },
		{ fakeProvider: fakeProviderReturning(json) },
	);
	assert.equal(result.confidence, 'high');
	assert.equal(result.value.candidates[0]!.goal, detailedGoal,
		'goal must be threaded through unchanged from the LLM output');
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
				{ skillId: 'code.source.repo.describe', rationale: 'repo summary', goal: 'Summarise the active repo for the caller.', mustHaveScope: 'repo' },
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
				{ skillId: 'code.source.repo.describe', rationale: 'r', goal: 'Describe the repo for the caller.', mustHaveScope: 'repo' },
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
				{ skillId: 'code.entity.summary', rationale: 'r', goal: 'Return the summary card for the resolved entity.', mustHaveScope: 'repo+entity' },
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
				{ skillId: 'code.source.repo.describe', rationale: 'r', goal: 'Describe the repo for the caller.', mustHaveScope: 'repo' },
			],
			repo: REPO,
		},
		{ fakeProvider: fakeProviderReturning(bad, bad) },
	);
	assert.equal(result.confidence, 'low');
	const noteText = (result.notes ?? []).join(' | ');
	assert.match(noteText, /repoPath/);
});

// ---------------------------------------------------------------------------
// Phase 6 (conversation-flow-refinement.md): priorFacts -> LLM prompt
// ---------------------------------------------------------------------------

/**
 * Capture-mode provider: records the most recent `messages` argument
 * so the test can assert what actually reached the LLM. This is the
 * bottom-of-the-funnel check for Phase 6 -- if priorFacts don't show
 * up here, the HDFS-Core regression is back even with all the
 * upstream wiring intact.
 */
function captureProvider(text: string): {
	provider: FakeProvider;
	getCapturedMessages: () => LLMMessage[];
} {
	let captured: LLMMessage[] = [];
	return {
		provider: {
			async complete(messages, opts?: CompletionOpts): Promise<LLMResponse> {
				captured = messages;
				const toolName = opts?.toolChoice !== undefined
					&& typeof opts.toolChoice === 'object'
					&& 'name' in opts.toolChoice
					? (opts.toolChoice as { name: string }).name
					: 'submit_scope';
				try {
					const parsed = JSON.parse(text);
					return {
						text:       '',
						stopReason: 'tool_use',
						toolCalls:  [{ id: 'tc-capture', name: toolName, input: parsed }],
					};
				} catch {
					return { text, stopReason: 'end_turn' };
				}
			},
		},
		getCapturedMessages: () => captured,
	};
}

test('select-scope: priorFacts.modules render in the LLM prompt with path + label', async () => {
	setup();
	const valid = JSON.stringify({
		scoped: [
			{
				skillId: 'code.source.module.describe',
				args: { repoPath: REPO.path, modulePath: '/repo/alpha/hadoop-hdfs' },
				resolvedScope: { repoPath: REPO.path },
			},
		],
		notes: [],
	});
	const cap = captureProvider(valid);
	await runSkillIsolated<unknown, SelectValue>(
		SELECT,
		{
			question: 'describe HDFS Core',
			candidates: [
				{ skillId: 'code.source.module.describe', rationale: 'module summary', goal: 'Describe the module surface for the caller.', mustHaveScope: 'repo' },
			],
			repo: REPO,
			priorFacts: {
				modules: [
					{ path: '/repo/alpha/hadoop-hdfs', label: 'HDFS Core', fileCount: 240 },
				],
			},
		},
		{ fakeProvider: cap.provider },
	);

	const userMsg = cap.getCapturedMessages().find(m => m.role === 'user');
	assert.ok(userMsg, 'user message should reach the provider');
	const body = userMsg!.content as string;
	assert.match(body, /Prior facts \(from prior turns/, 'prompt should carry the Prior facts header');
	assert.match(body, /Modules \(1\):/);
	assert.match(body, /\/repo\/alpha\/hadoop-hdfs/);
	assert.match(body, /HDFS Core/);
});

test('select-scope: priorFacts.entities + tables + ormModels all render in the prompt', async () => {
	setup();
	const valid = JSON.stringify({
		scoped: [
			{
				skillId: 'code.entity.summary',
				args: { repoPath: REPO.path, entityId: 'a'.repeat(32) },
				resolvedScope: { repoPath: REPO.path, entityRef: 'compute' },
			},
		],
		notes: [],
	});
	const cap = captureProvider(valid);
	await runSkillIsolated<unknown, SelectValue>(
		SELECT,
		{
			question: 'tell me about compute',
			candidates: [
				{ skillId: 'code.entity.summary', rationale: 'r', goal: 'Return the summary card for the resolved entity.', mustHaveScope: 'repo+entity' },
			],
			repo: REPO,
			priorFacts: {
				entities:  [{ entityRef: 'e1', name: 'compute',  kind: 'function', file: '/repo/alpha/src/c.ts' }],
				tables:    [{ connectionId: 'pg-main', name: 'orders', columns: ['id', 'total'] }],
				ormModels: [{ name: 'Order', dialect: 'prisma', table: 'orders' }],
			},
		},
		{ fakeProvider: cap.provider },
	);

	const body = (cap.getCapturedMessages().find(m => m.role === 'user')!.content) as string;
	assert.match(body, /Entities \(1\):/);
	assert.match(body, /compute/);
	assert.match(body, /Tables \(1\):/);
	assert.match(body, /pg-main\.orders/);
	assert.match(body, /ORM models \(1\):/);
	assert.match(body, /prisma: Order -> orders/);
});

// ---------------------------------------------------------------------------
// select-scope A5: goal is required + load-bearing
// ---------------------------------------------------------------------------

test('select-scope (A5): missing goal on a candidate -> input validation fails', async () => {
	setup();
	// Pre-#6: this candidate shape worked (goal was optional).
	// Post-#6: schema requires `goal` -- skill must reject at input
	// validation before reaching the LLM.
	const { result } = await runSkillIsolated<unknown, SelectValue>(
		SELECT,
		{
			question: 'q',
			candidates: [
				// `goal` deliberately omitted.
				{ skillId: 'code.source.repo.describe', rationale: 'r', mustHaveScope: 'repo' },
			],
			repo: REPO,
		},
		{ fakeProvider: fakeProviderReturning('{}') },
	);
	// runSkill clamps to 'low' on input schema validation failure.
	assert.equal(result.confidence, 'low');
});

test('select-scope (A5): goal renders in the LLM prompt for each candidate', async () => {
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
	const cap = captureProvider(valid);
	const goalA = 'Summarise the active repo so the caller can decide which module to drill into next.';
	const goalB = 'Enumerate fields on the User class so the caller can render the schema.';
	await runSkillIsolated<unknown, SelectValue>(
		SELECT,
		{
			question: 'q',
			candidates: [
				{ skillId: 'code.source.repo.describe',   rationale: 'a', goal: goalA, mustHaveScope: 'repo' },
				{ skillId: 'code.class.extract-fields',   rationale: 'b', goal: goalB, mustHaveScope: 'repo+class' },
			],
			repo: REPO,
		},
		{ fakeProvider: cap.provider },
	);

	const userMsg = cap.getCapturedMessages().find(m => m.role === 'user');
	assert.ok(userMsg, 'user message should reach the provider');
	const body = userMsg!.content as string;

	// Both goals should render verbatim in the user prompt.
	assert.ok(body.includes(goalA), 'goal A must appear in the rendered prompt');
	assert.ok(body.includes(goalB), 'goal B must appear in the rendered prompt');
	// Goal renders BEFORE rationale per A5 (rationale is informational).
	const goalAIdx = body.indexOf(goalA);
	const ratAIdx  = body.indexOf('rationale (informational only): a');
	assert.ok(goalAIdx >= 0 && ratAIdx >= 0 && goalAIdx < ratAIdx,
		'goal should render before rationale per A5 (goal is primary signal)');
});

test('select-scope: no priorFacts -> Prior facts header is NOT in the prompt', async () => {
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
	const cap = captureProvider(valid);
	await runSkillIsolated<unknown, SelectValue>(
		SELECT,
		{
			question: 'describe the repo',
			candidates: [
				{ skillId: 'code.source.repo.describe', rationale: 'r', goal: 'Describe the repo for the caller.', mustHaveScope: 'repo' },
			],
			repo: REPO,
			// no priorFacts
		},
		{ fakeProvider: cap.provider },
	);
	const body = (cap.getCapturedMessages().find(m => m.role === 'user')!.content) as string;
	assert.equal(body.includes('Prior facts'), false, 'cold runs should not advertise an empty Prior facts section');
});
