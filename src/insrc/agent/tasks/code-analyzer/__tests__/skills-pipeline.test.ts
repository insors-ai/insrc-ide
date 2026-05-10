/**
 * Tests for `agent/tasks/code-analyzer/skills-pipeline.ts`
 * (code-analyzer-skills.md Phase 8a). Mirror of
 * `data-analyzer/__tests__/skills-pipeline.test.ts`.
 *
 * Drives the pipeline end-to-end against the live skill registry,
 * stubbing the LLM provider so classify-question + select-scope
 * return canned JSON. Tests cover:
 *   - happy path: classify -> select -> 1 skill execution -> calibrated
 *   - early abort: classify returns no candidates -> aborted=true
 *   - early abort: select returns no scoped -> aborted=true
 *   - adapter: pipeline result -> AcceptedTaskPair[] shape + concern
 *     mapping from skill family
 *   - feature flag: state precedence over env var; env var fallback
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../../../../daemon/skills/index.js';
import {
	getSkill,
	_resetSkillRegistryForTests,
} from '../../../../daemon/skills/registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../../daemon/tools/registry.js';
import { registerSkillTools } from '../../../../daemon/tools/builtins/skills/invoke-skill.js';
import {
	runSkillsPipeline,
	pipelineResultToAcceptedTasks,
	repoContextFromSummary,
	type SkillsPipelineDeps,
} from '../skills-pipeline.js';
import type { Session } from '../../../session.js';
import type { LLMProvider, LLMResponse } from '../../../../shared/types.js';
import type { RepoSummary } from '../types.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface QueuedResponse {
	readonly skillFilter: (messages: { role: string; content: string }[]) => boolean;
	readonly text: string;
}

function buildFakeProvider(responses: readonly QueuedResponse[]): LLMProvider {
	return {
		async complete(messages): Promise<LLMResponse> {
			const flat = messages.map(m => ({
				role:    m.role,
				content: typeof m.content === 'string' ? m.content : '',
			}));
			for (const r of responses) {
				if (r.skillFilter(flat)) {
					return { text: r.text, stopReason: 'end_turn' };
				}
			}
			throw new Error(
				`fake provider: no canned response matched.\n` +
				`system snippet: ${flat[0]?.content?.slice(0, 80) ?? ''}\n` +
				`user snippet:   ${flat[1]?.content?.slice(0, 120) ?? ''}`,
			);
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};
}

function setup(): SkillsPipelineDeps {
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	registerAllSkills();
	registerSkillTools();
	assert.ok(getSkill('code.meta.classify-question'));
	assert.ok(getSkill('code.meta.select-scope'));

	const auditEvents: unknown[] = [];
	const session = {
		skillAudit: { push: (e: unknown) => { auditEvents.push(e); }, list: () => auditEvents },
	} as unknown as Session;

	return {
		session,
		resolveProvider: () => { throw new Error('test must override resolveProvider'); },
	};
}

const REPO = { path: '/repo/alpha', primaryLanguages: ['typescript'] };

const CLASSIFY_REPO_DESCRIBE = JSON.stringify({
	questionType: 'describe-repo',
	candidates: [
		{
			skillId: 'code.source.repo.describe',
			rationale: 'Whole-repo summary.',
			mustHaveScope: 'repo',
		},
	],
	fallbacks: [],
	uncertaintyNotes: [],
});

const SELECT_REPO_DESCRIBE = JSON.stringify({
	scoped: [
		{
			skillId: 'code.source.repo.describe',
			args:    { repoPath: REPO.path },
			resolvedScope: { repoPath: REPO.path },
		},
	],
	notes: [],
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('skills-pipeline: classify -> select -> execute -> calibrate (happy path)', async () => {
	const baseDeps = setup();

	const provider = buildFakeProvider([
		{
			skillFilter: msgs =>
				msgs.some(m => m.role === 'system' && m.content.includes('code-analyzer skill router')),
			text: CLASSIFY_REPO_DESCRIBE,
		},
		{
			skillFilter: msgs =>
				msgs.some(m => m.role === 'system' && m.content.includes('code-analyzer scope-selector')),
			text: SELECT_REPO_DESCRIBE,
		},
	]);

	const deps: SkillsPipelineDeps = {
		...baseDeps,
		resolveProvider: () => provider,
	};

	const result = await runSkillsPipeline(
		{ question: 'Describe the repo.', repo: REPO },
		deps,
	);

	assert.equal(result.aborted, false);
	assert.equal(result.classify.candidates.length, 1);
	assert.equal(result.select.scoped.length, 1);
	assert.equal(result.executions.length, 1);
	assert.equal(result.executions[0]!.skillId, 'code.source.repo.describe');
	// Repo isn't actually indexed in the test harness; the skill body
	// will return `found: false` (repo-not-indexed). The pipeline records
	// that as a normal execution; calibrate-confidence rolls accordingly.
	const exec = result.executions[0]!;
	assert.ok(exec.confidence === 'high' || exec.confidence === 'medium' || exec.confidence === 'low');
});

// ---------------------------------------------------------------------------
// Early-abort paths
// ---------------------------------------------------------------------------

test('skills-pipeline: classify returns no candidates -> aborted with note', async () => {
	const baseDeps = setup();
	const emptyClassify = JSON.stringify({
		questionType: 'free-form',
		candidates: [],
		fallbacks: [],
		uncertaintyNotes: ['no skills survived prefilter'],
	});

	const provider = buildFakeProvider([
		{ skillFilter: () => true, text: emptyClassify },
	]);
	const deps: SkillsPipelineDeps = { ...baseDeps, resolveProvider: () => provider };

	const result = await runSkillsPipeline(
		{ question: 'whatever', repo: REPO },
		deps,
	);

	assert.equal(result.aborted, true);
	assert.equal(result.executions.length, 0);
	assert.equal(result.finalConfidence, 'low');
	assert.match(result.notes.join(' '), /no candidates|low/);
});

test('skills-pipeline: onSkillEnd hook fires for every skill the pipeline runs', async () => {
	// Conversation-flow-refinement Phase 2: the spill writer rides
	// `SkillRunnerDeps.onSkillEnd`. Earlier the orchestrator only
	// wired the hook on its inline `runSkill` calls -- the meta-skills
	// pipeline's own `runSkill` invocations got a hand-rolled deps
	// object without it, so spills never made it into Lance for real
	// sessions. This test asserts the hook propagates through.
	const baseDeps = setup();

	const provider = buildFakeProvider([
		{
			skillFilter: msgs =>
				msgs.some(m => m.role === 'system' && m.content.includes('code-analyzer skill router')),
			text: CLASSIFY_REPO_DESCRIBE,
		},
		{
			skillFilter: msgs =>
				msgs.some(m => m.role === 'system' && m.content.includes('code-analyzer scope-selector')),
			text: SELECT_REPO_DESCRIBE,
		},
	]);

	const calls: string[] = [];
	const deps: SkillsPipelineDeps = {
		...baseDeps,
		resolveProvider: () => provider,
		onSkillEnd: async (payload) => { calls.push(payload.skillId); },
	};

	const result = await runSkillsPipeline(
		{ question: 'Describe the repo.', repo: REPO },
		deps,
	);

	assert.equal(result.aborted, false);
	// classify-question + select-scope + the per-skill execution all
	// ride runSkill internally -- each one MUST end up in `calls`.
	// Order isn't strictly required, only that all three fired.
	assert.ok(calls.includes('code.meta.classify-question'),
		`expected classify-question to spill; got ${calls.join(', ')}`);
	assert.ok(calls.includes('code.meta.select-scope'),
		`expected select-scope to spill; got ${calls.join(', ')}`);
	assert.ok(calls.includes('code.source.repo.describe'),
		`expected repo.describe to spill; got ${calls.join(', ')}`);
});

test('skills-pipeline: select returns no scoped -> aborted with note', async () => {
	const baseDeps = setup();
	const emptySelect = JSON.stringify({ scoped: [], notes: ['could not resolve scope'] });

	const provider = buildFakeProvider([
		{
			skillFilter: msgs =>
				msgs.some(m => m.role === 'system' && m.content.includes('skill router')),
			text: CLASSIFY_REPO_DESCRIBE,
		},
		{
			skillFilter: msgs =>
				msgs.some(m => m.role === 'system' && m.content.includes('scope-selector')),
			text: emptySelect,
		},
	]);

	const deps: SkillsPipelineDeps = { ...baseDeps, resolveProvider: () => provider };

	const result = await runSkillsPipeline(
		{ question: 'whatever', repo: REPO },
		deps,
	);

	assert.equal(result.aborted, true);
	assert.equal(result.executions.length, 0);
	assert.match(result.notes.join(' '), /select-scope|no scoped/);
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

test('pipelineResultToAcceptedTasks: emits one pair per execution', () => {
	const accepted = pipelineResultToAcceptedTasks(
		{
			classify: { questionType: 'free-form', candidates: [], fallbacks: [], uncertaintyNotes: [] },
			select:   { scoped: [], notes: [] },
			executions: [
				{
					skillId: 'code.source.repo.describe',
					args:    { repoPath: '/r' },
					resolvedScope: { repoPath: '/r' },
					value:   { fileCount: 100 },
					confidence: 'high',
					notes:   [],
					toolCalls: [],
					errored: false,
				},
				{
					skillId: 'code.quality.complexity',
					args:    { repoPath: '/r' },
					resolvedScope: { repoPath: '/r', file: '/r/foo.ts' },
					value:   null,
					confidence: 'low',
					notes:   ['skill execution threw: boom'],
					toolCalls: [],
					errored: true,
				},
			],
			finalConfidence: 'low',
			notes: [],
			aborted: false,
		},
		'item-prefix',
	);

	assert.equal(accepted.length, 2);
	assert.equal(accepted[0]!.task.itemId, 'item-prefix-skill-0');
	assert.equal(accepted[0]!.task.kind, 'free-form');
	assert.match(accepted[0]!.task.question, /\[skill\]/);
	assert.equal(accepted[0]!.result.confidence, 'high');
	assert.equal(accepted[1]!.result.findings.length, 0, 'errored skills produce no finding');
});

test('pipelineResultToAcceptedTasks: maps skill family to CodeAnalysisConcern', () => {
	const make = (skillId: string) => ({
		classify: { questionType: 'free-form', candidates: [], fallbacks: [], uncertaintyNotes: [] },
		select:   { scoped: [], notes: [] },
		executions: [{
			skillId,
			args: { repoPath: '/r' },
			resolvedScope: { repoPath: '/r', file: '/r/x.ts' },
			value: {},
			confidence: 'high' as const,
			notes: ['ok'],
			toolCalls: [],
			errored: false,
		}],
		finalConfidence: 'high' as const,
		notes: [],
		aborted: false,
	});

	const dup  = pipelineResultToAcceptedTasks(make('code.quality.duplication'),     'p');
	const cmp  = pipelineResultToAcceptedTasks(make('code.compare.signature'),       'p');
	const docs = pipelineResultToAcceptedTasks(make('code.compare.impl-vs-doc'),     'p');
	const ver  = pipelineResultToAcceptedTasks(make('code.compare.entity-versions'), 'p');
	const orm  = pipelineResultToAcceptedTasks(make('code.orm.resolve-model'),       'p');
	const dflt = pipelineResultToAcceptedTasks(make('code.entity.summary'),          'p');

	assert.equal(dup[0]!.result.findings[0]!.concern,  'duplicates');
	assert.equal(cmp[0]!.result.findings[0]!.concern,  'interface-mismatch');
	assert.equal(docs[0]!.result.findings[0]!.concern, 'consistency');
	assert.equal(ver[0]!.result.findings[0]!.concern,  'impact');
	assert.equal(orm[0]!.result.findings[0]!.concern,  'consistency');
	assert.equal(dflt[0]!.result.findings[0]!.concern, 'smells');
});

// ---------------------------------------------------------------------------
// repoContextFromSummary
// ---------------------------------------------------------------------------

test('repoContextFromSummary: projects RepoSummary -> lean RepoMetaContext', () => {
	const summary: RepoSummary = {
		name: 'alpha',
		rootPath: '/repo/alpha',
		primaryLanguages: ['typescript', 'python'],
		topLevelPackages: ['src', 'lib'],
		closureSize: 1,
		repoSnapshotId: 'snap-1',
	};
	const ctx = repoContextFromSummary(summary);
	assert.equal(ctx.path, '/repo/alpha');
	assert.deepEqual(ctx.primaryLanguages, ['typescript', 'python']);
	// detectedOrms / migrationTool not yet on RepoSummary -- v1 omits.
	assert.equal(ctx.detectedOrms, undefined);
	assert.equal(ctx.migrationTool, undefined);
});

