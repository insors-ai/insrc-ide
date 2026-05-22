/**
 * Tests for executeStep (Phase 8 -- per-task orchestrator-driven driver).
 *
 * Coverage:
 *   - Pure helpers: inferCriteriaForStep, uniqueFlattenFacts,
 *     mergeCitations, parseLegacyCitation, formatArgsInline.
 *   - Per-task prompt assembly: buildPerTaskMessages /
 *     buildPerTaskUserPrompt rendering, including chain-dependency
 *     framing when a prior task's result must be surfaced.
 *   - System prompt: per-task contract is documented; old agentic
 *     framing is gone.
 *   - End-to-end behavior via FakeProvider:
 *       - Happy path: N planned tasks -> N provider calls -> N
 *         evidence entries captured.
 *       - Per-task retry: one empty-toolCall response triggers a
 *         retry; if retry succeeds, the step proceeds.
 *       - Per-task skip: two consecutive empty-toolCall responses
 *         cause the task to be skipped (no abort) and the step
 *         continues with partial evidence.
 *       - Step with zero planned tasks: returns empty StepOutput
 *         with no provider calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	executeStep,
	formatArgsInline,
	buildPerTaskMessages,
	_buildPerTaskMessagesForTest,
	_buildStepSystemPromptForTest    as buildStepSystemPrompt,
	_buildPerTaskUserPromptForTest   as buildPerTaskUserPrompt,
	_renderSkillSchemaForTest        as renderSkillSchema,
	_determineStatusForTest          as determineStatus,
	_inferCriteriaForStepForTest     as inferCriteriaForStep,
	_uniqueFlattenFactsForTest       as uniqueFlattenFacts,
	_mergeCitationsForTest           as mergeCitations,
	_parseLegacyCitationForTest      as parseLegacyCitation,
	_PER_TASK_EMPTY_RETRIES_FOR_TEST as PER_TASK_EMPTY_RETRIES,
} from '../execute-step.js';

import type {
	DiscoveryStep,
	PlannedSkillCall,
} from '../../../content-gen/discovery-plan.js';
import type { EvidenceEntry } from '../summarize-result.js';
import type { LLMProvider, LLMMessage, LLMResponse, CompletionOpts } from '../../../../shared/types.js';
import type { Session } from '../../../session.js';
import { registerSkillTools } from '../../../../daemon/tools/builtins/skills/invoke-skill.js';

// Register the skill_invoke meta-tool once for this file's tests.
// executeStep guards against it being missing.
registerSkillTools();

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function call(id: string, skillId: string, ctx: string, dependsOn?: string): PlannedSkillCall {
	return dependsOn === undefined ? { id, skillId, context: ctx } : { id, skillId, context: ctx, dependsOn };
}

function fixtureStep(): DiscoveryStep {
	return {
		id:               'step-1',
		intent:           'investigate the FSDirectory class in the NameNode',
		skills:           [
			call('s1.a', 'code.entity.locate-by-name', 'the FSDirectory class'),
			call('s1.b', 'code.entity.summary',         'use entityId from s1.a', 's1.a'),
		],
		targetsCriteria:  [0, 2],
	};
}

function fakeProvider(responses: readonly LLMResponse[]): { provider: LLMProvider; calls: { messages: LLMMessage[]; opts: CompletionOpts | undefined }[] } {
	const calls: { messages: LLMMessage[]; opts: CompletionOpts | undefined }[] = [];
	let i = 0;
	const provider: LLMProvider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse> {
			calls.push({ messages: [...messages], opts });
			const r = responses[i++];
			if (r === undefined) {
				throw new Error(`fake provider out of canned responses (idx=${i - 1})`);
			}
			return r;
		},
		async *stream() { return; },
		async embed() { return []; },
	};
	return { provider, calls };
}

const FAKE_SESSION: Session = {} as unknown as Session;

function fixtureEntry(overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
	return {
		skillId:    'code.entity.locate-by-name',
		args:       { name: 'FSDirectory' },
		facts:      ['Found 3 entities named FSDirectory'],
		citations:  ['path:/repo/FSDirectory.java#L1-L400'],
		confidence: 'high',
		...overrides,
	};
}

function toolUseResp(skillId: string, args: Record<string, unknown>, id = `tc_${Math.random().toString(36).slice(2, 8)}`): LLMResponse {
	return {
		text:       '',
		stopReason: 'tool_use',
		toolCalls:  [{ id, name: 'skill_invoke', input: { skillId, args } }],
	};
}

function emptyResp(text = ''): LLMResponse {
	return { text, stopReason: 'end_turn' };
}

// ---------------------------------------------------------------------------
// inferCriteriaForStep
// ---------------------------------------------------------------------------

test('inferCriteriaForStep: returns 3 criteria including the step intent', () => {
	const crit = inferCriteriaForStep(fixtureStep());
	assert.equal(crit.length, 3);
	assert.ok(crit[0]!.includes('investigate the FSDirectory class'));
	assert.ok(crit.some(c => /specific entities/.test(c)));
	assert.ok(crit.some(c => /citations verbatim/.test(c)));
});

// ---------------------------------------------------------------------------
// uniqueFlattenFacts
// ---------------------------------------------------------------------------

test('uniqueFlattenFacts: dedups across entries case-insensitively', () => {
	const out = uniqueFlattenFacts([
		fixtureEntry({ facts: ['Found 3 entities', 'INode tree class'] }),
		fixtureEntry({ facts: ['found 3 entities', 'Another fact'] }),
	]);
	assert.deepEqual([...out], ['Found 3 entities', 'INode tree class', 'Another fact']);
});

test('uniqueFlattenFacts: empty / blank facts are dropped', () => {
	const out = uniqueFlattenFacts([
		fixtureEntry({ facts: ['real', '', '   '] }),
	]);
	assert.deepEqual([...out], ['real']);
});

// ---------------------------------------------------------------------------
// parseLegacyCitation
// ---------------------------------------------------------------------------

test('parseLegacyCitation: path with line range -> structured', () => {
	const c = parseLegacyCitation('path:/repo/a.ts#L1-L20');
	assert.deepEqual(c, { path: '/repo/a.ts', startLine: 1, endLine: 20 });
});

test('parseLegacyCitation: path with single line -> structured', () => {
	const c = parseLegacyCitation('path:/repo/a.ts#L42');
	assert.deepEqual(c, { path: '/repo/a.ts', startLine: 42 });
});

test('parseLegacyCitation: path without #L -> path only', () => {
	const c = parseLegacyCitation('path:/repo/a.ts');
	assert.deepEqual(c, { path: '/repo/a.ts' });
});

test('parseLegacyCitation: empty -> null', () => {
	assert.equal(parseLegacyCitation(''), null);
});

test('parseLegacyCitation: tolerates missing path: prefix', () => {
	const c = parseLegacyCitation('/repo/a.ts#L1-L5');
	assert.deepEqual(c, { path: '/repo/a.ts', startLine: 1, endLine: 5 });
});

// ---------------------------------------------------------------------------
// mergeCitations
// ---------------------------------------------------------------------------

test('mergeCitations: dedups on (path, startLine, endLine) across entries', () => {
	const out = mergeCitations([
		fixtureEntry({ citations: ['path:/repo/a.ts#L1-L20'] }),
		fixtureEntry({ citations: ['path:/repo/a.ts#L1-L20', 'path:/repo/b.ts#L5-L9'] }),
	]);
	assert.equal(out.length, 2);
	assert.equal(out[0]!.path, '/repo/a.ts');
	assert.equal(out[1]!.path, '/repo/b.ts');
});

test('mergeCitations: prefers citationObjs when present', () => {
	const out = mergeCitations([
		{
			skillId:      'x',
			args:         {},
			facts:        ['fact'],
			citations:    ['path:/repo/a.ts#L1'],
			citationObjs: [{ path: '/repo/a.ts', startLine: 1, endLine: 50, label: 'Foo' }],
			confidence:   'high',
		},
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0]!.endLine, 50);
	assert.equal(out[0]!.label, 'Foo');
});

// ---------------------------------------------------------------------------
// formatArgsInline (carried over from the deleted agentic mode)
// ---------------------------------------------------------------------------

test('formatArgsInline: quotes string values', () => {
	assert.equal(formatArgsInline({ name: 'FSDirectory' }), 'name="FSDirectory"');
});

test('formatArgsInline: renders numbers + booleans bare', () => {
	assert.equal(formatArgsInline({ pageIndex: 2, includeBody: true, verbose: false }), 'pageIndex=2, includeBody=true, verbose=false');
});

test('formatArgsInline: arrays render as [N] size marker', () => {
	assert.equal(formatArgsInline({ kinds: ['class', 'function', 'method'] }), 'kinds=[3]');
});

test('formatArgsInline: nested objects render as {N keys}', () => {
	assert.equal(formatArgsInline({ filter: { a: 1, b: 2, c: 3 } }), 'filter={3 keys}');
});

test('formatArgsInline: truncates string values at 30 chars with "..." suffix', () => {
	const long = 'a'.repeat(100);
	assert.equal(formatArgsInline({ name: long }), `name="${'a'.repeat(30)}..."`);
});

test('formatArgsInline: empty args -> empty string', () => {
	assert.equal(formatArgsInline({}), '');
});

// ---------------------------------------------------------------------------
// determineStatus
// ---------------------------------------------------------------------------

test('determineStatus: zero evidence -> failed', () => {
	assert.equal(determineStatus({
		evidenceCount:     0,
		facts:             [],
		citations:         [],
		calledSkillIds:    [],
		plannedSkillCount: 2,
	}), 'failed');
});

test('determineStatus: evidence captured but no citations -> partial', () => {
	assert.equal(determineStatus({
		evidenceCount:     2,
		facts:             ['a', 'b'],
		citations:         [],
		calledSkillIds:    ['code.entity.summary'],
		plannedSkillCount: 1,
	}), 'partial');
});

test('determineStatus: fewer skills called than planned -> partial', () => {
	assert.equal(determineStatus({
		evidenceCount:     1,
		facts:             ['a'],
		citations:         [{ path: '/x.ts' }],
		calledSkillIds:    ['code.entity.locate-by-name'],
		plannedSkillCount: 2,
	}), 'partial');
});

test('determineStatus: all planned called + evidence + citations -> ok', () => {
	assert.equal(determineStatus({
		evidenceCount:     2,
		facts:             ['a', 'b'],
		citations:         [{ path: '/x.ts' }],
		calledSkillIds:    ['code.entity.locate-by-name', 'code.entity.summary'],
		plannedSkillCount: 2,
	}), 'ok');
});

// ---------------------------------------------------------------------------
// System prompt assembly (per-task framing)
// ---------------------------------------------------------------------------

test('buildStepSystemPrompt: documents the per-task contract', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.match(prompt, /executing ONE skill call at a time/i);
	assert.match(prompt, /skill_invoke/);
	assert.match(prompt, /How a turn is shaped/);
});

test('buildStepSystemPrompt: tells the model to emit exactly one tool_use', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.match(prompt, /Exactly one `skill_invoke` tool_use block per turn/);
	assert.match(prompt, /Do NOT emit narration, acknowledgement prose, or planning/i);
});

test('buildStepSystemPrompt: removes the agentic "STOP calling tools" contract', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.doesNotMatch(prompt, /STOP calling tools/);
	assert.doesNotMatch(prompt, /Final output \(your LAST assistant turn\)/);
});

test('buildStepSystemPrompt: removes the orchestrator-stub paragraph (Phase 2.5)', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.doesNotMatch(prompt, /\[evidence e_/);
	assert.doesNotMatch(prompt, /skill_load_page if needed/);
});

test('buildStepSystemPrompt: states tool_choice=required is enforced', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.match(prompt, /tool_choice: required/);
});

test('buildStepSystemPrompt: omits repo-context block when repoSizeSummary is undefined', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.doesNotMatch(prompt, /## Repository under analysis/);
});

// ---------------------------------------------------------------------------
// Per-task user prompt assembly
// ---------------------------------------------------------------------------

test('buildPerTaskUserPrompt: names step context + the single task to execute', () => {
	const step = fixtureStep();
	const prompt = buildPerTaskUserPrompt({
		stepIntent:         step.intent,
		task:               step.skills[0]!,
		priorTaskAndResult: null,
		retryAttempt:       0,
	});
	assert.match(prompt, /## Step context/);
	assert.match(prompt, /investigate the FSDirectory class/);
	assert.match(prompt, /## Task to execute now/);
	assert.match(prompt, /Skill:\s+`code\.entity\.locate-by-name`/);
	assert.match(prompt, /Target: the FSDirectory class/);
});

test('buildPerTaskUserPrompt: inlines the skill arg schema', () => {
	const step = fixtureStep();
	const prompt = buildPerTaskUserPrompt({
		stepIntent:         step.intent,
		task:               step.skills[0]!,
		priorTaskAndResult: null,
		retryAttempt:       0,
	});
	assert.match(prompt, /## Skill schema/);
	// The inlined schema is the JSON representation of skill_invoke's
	// declared inputSchema (registered by registerSkillTools()).
	assert.match(prompt, /```json/);
});

test('buildPerTaskUserPrompt: surfaces prior task result when dependsOn is set', () => {
	const step = fixtureStep();
	const task1 = step.skills[0]!;
	const task2 = step.skills[1]!;
	const prompt = buildPerTaskUserPrompt({
		stepIntent:         step.intent,
		task:               task2,
		priorTaskAndResult: {
			priorTask:       task1,
			priorResultText: '{"matches": [{"entityId": "a7f1c83b...", "name": "FSDirectory"}]}',
		},
		retryAttempt:       0,
	});
	assert.match(prompt, /## Prior task that just completed/);
	assert.match(prompt, /code\.entity\.locate-by-name/);
	assert.match(prompt, /a7f1c83b\.\.\./);
	assert.match(prompt, /This task chains off prior task `s1\.a`/);
});

test('buildPerTaskUserPrompt: omits prior-task block when there is no prior result', () => {
	const step = fixtureStep();
	const prompt = buildPerTaskUserPrompt({
		stepIntent:         step.intent,
		task:               step.skills[0]!,
		priorTaskAndResult: null,
		retryAttempt:       0,
	});
	assert.doesNotMatch(prompt, /## Prior task that just completed/);
});

test('buildPerTaskUserPrompt: includes retry notice when retryAttempt > 0', () => {
	const step = fixtureStep();
	const prompt = buildPerTaskUserPrompt({
		stepIntent:         step.intent,
		task:               step.skills[0]!,
		priorTaskAndResult: null,
		retryAttempt:       1,
	});
	assert.match(prompt, /## RETRY NOTICE/);
	assert.match(prompt, /Your previous response had no tool_use block/);
});

test('buildPerTaskMessages: returns [system, user] messages', () => {
	const step = fixtureStep();
	const messages = buildPerTaskMessages({
		stepIntent:         step.intent,
		task:               step.skills[0]!,
		priorTaskAndResult: null,
		retryAttempt:       0,
	});
	assert.equal(messages.length, 2);
	assert.equal(messages[0]!.role, 'system');
	assert.equal(messages[1]!.role, 'user');
});

// ---------------------------------------------------------------------------
// renderSkillSchema
// ---------------------------------------------------------------------------

test('renderSkillSchema: returns JSON schema string for a registered skill', () => {
	const schema = renderSkillSchema('skill_invoke');
	assert.ok(schema.length > 0);
	// Should be parseable JSON.
	const parsed = JSON.parse(schema);
	assert.equal(parsed.type, 'object');
});

test('renderSkillSchema: falls back gracefully for unregistered skill', () => {
	const schema = renderSkillSchema('non.existent.skill');
	const parsed = JSON.parse(schema);
	assert.equal(parsed.type, 'object');
});

// ---------------------------------------------------------------------------
// executeStep end-to-end with FakeProvider
// ---------------------------------------------------------------------------

test('executeStep: zero planned tasks -> empty StepOutput, no provider calls', async () => {
	const { provider, calls } = fakeProvider([]);
	const out = await executeStep({
		provider,
		session: FAKE_SESSION,
		step:    { id: 'step-empty', intent: 'nothing to do', skills: [], targetsCriteria: [] },
	});
	assert.equal(out.status, 'failed');   // zero evidence -> failed
	assert.equal(out.facts.length, 0);
	assert.equal(out.citations.length, 0);
	assert.equal(calls.length, 0);
});

test('executeStep: per-task retry on empty toolCalls; second response succeeds', async () => {
	// Provider response sequence:
	//   [0] task 1 first attempt: emptyResp -> orchestrator retries
	//   [1] task 1 retry:         toolUseResp -> orchestrator dispatches the skill
	//   [2] summarizer call:      facts/citations JSON -> evidence captured
	const { provider, calls } = fakeProvider([
		emptyResp('I will...'),
		toolUseResp('non.existent.skill', { name: 'x' }),
		{
			text:       JSON.stringify({ facts: ['x found'], citations: [], confidence: 'low' }),
			stopReason: 'end_turn',
		},
	]);
	await executeStep({
		provider,
		session: FAKE_SESSION,
		step:    {
			id:               'step-retry',
			intent:           'test retry',
			skills:           [call('s1.a', 'code.entity.locate-by-name', 'FSDirectory')],
			targetsCriteria:  [],
		},
	});
	// 3 calls total = 1 first try (empty) + 1 retry + 1 summarizer.
	assert.equal(calls.length, 3);
	// First call's user prompt has NO retry notice; the retry (second
	// call) DOES include it.
	const firstUserMsg  = calls[0]!.messages[1]!.content as string;
	const retryUserMsg  = calls[1]!.messages[1]!.content as string;
	assert.doesNotMatch(firstUserMsg, /RETRY NOTICE/);
	assert.match(retryUserMsg, /RETRY NOTICE/);
	// First two calls used tool_choice=required; summarizer doesn't.
	assert.equal(calls[0]!.opts?.toolChoice, 'required');
	assert.equal(calls[1]!.opts?.toolChoice, 'required');
	assert.notEqual(calls[2]!.opts?.toolChoice, 'required');
});

test('executeStep: two empty responses in a row -> task skipped, step continues', async () => {
	// Single-task step. Two empty responses (initial + retry) means the
	// task is skipped. With only one planned task, this yields zero
	// evidence -> failed step. But importantly, executeStep returns
	// cleanly rather than aborting.
	const { provider, calls } = fakeProvider([
		emptyResp(),   // initial
		emptyResp(),   // retry
	]);
	const out = await executeStep({
		provider,
		session: FAKE_SESSION,
		step:    {
			id:               'step-skip',
			intent:           'test skip path',
			skills:           [call('s1.a', 'code.entity.locate-by-name', 'X')],
			targetsCriteria:  [],
		},
	});
	assert.equal(calls.length, 1 + PER_TASK_EMPTY_RETRIES);
	assert.equal(out.status, 'failed');
	assert.equal(out.facts.length, 0);
});

test('executeStep: passes toolChoice="required" on every per-task call', async () => {
	const { provider, calls } = fakeProvider([
		emptyResp(),   // task 1
		emptyResp(),   // task 1 retry
	]);
	await executeStep({
		provider,
		session: FAKE_SESSION,
		step:    {
			id:               'step-opts',
			intent:           'check opts',
			skills:           [call('s1.a', 'code.entity.locate-by-name', 'X')],
			targetsCriteria:  [],
		},
	});
	for (const c of calls) {
		assert.equal(c.opts?.toolChoice, 'required');
	}
});

test('executeStep: stepId preserved on the StepOutput', async () => {
	const { provider } = fakeProvider([
		emptyResp(),
		emptyResp(),
	]);
	const out = await executeStep({
		provider,
		session: FAKE_SESSION,
		step:    {
			id:               'step-42',
			intent:           'preserve id',
			skills:           [call('s1.a', 'code.entity.locate-by-name', 'X')],
			targetsCriteria:  [],
		},
	});
	assert.equal(out.stepId, 'step-42');
});
