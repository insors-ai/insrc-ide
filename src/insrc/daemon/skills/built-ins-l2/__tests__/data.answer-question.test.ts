/**
 * data.answer-question unit tests (deterministic-fake provider).
 *
 * Mirrors the post-P11 `code.answer-question.test.ts` pattern --
 * fake-provider tests pin code-path coverage; the live LLM test in
 * ./live/ exercises the judgment loop.
 *
 * Coverage:
 *   - Input validation rejects missing question.
 *   - classify-question returning zero candidates -> early-exit shortcut.
 *   - select-scope returning zero scoped invocations -> early-exit shortcut.
 *   - Happy path: classify -> select-scope -> dispatch -> draft -> ground.
 *   - extraField-leak regression guard: extra fields don't propagate
 *     from this L2 skill's input to select-scope (mirrors the
 *     scopeTier=XL regression on the code side).
 *   - Draft LLM omits citationRefs -> grounding drops, confidence low.
 *   - Draft LLM emits no tool call at all -> sections empty, low conf.
 *   - Grounded section keeps when citationRefs include a real ledger ref.
 *
 * The flow under test makes (up to) three LLM calls in order:
 *   1. data.meta.classify-question (tool_use; submit_classification)
 *   2. data.meta.select-scope      (tool_use; submit_scope)
 *   3. submit_answer               (tool_use; toolChoice: submit_answer)
 *
 * The dispatched L1 skill is `data.source.file.describe`, which is
 * file-family scoped (matches the test fixture's `file`-family
 * roster). Its execute() returns precondition-failed (no real driver
 * registered) but the L2 still counts the dispatch and appends a
 * ledger entry -- which is all the control-flow assertions need.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeGraphStore, setGraphStorePath } from '../../../../db/graph/store.js';
import { addRepo } from '../../../../db/repos.js';

import { _resetSkillRegistryForTests } from '../../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../tools/registry.js';
import { _resetL2RegistryForTests, getL2Skill } from '../../l2/registry.js';
import { registerAllSkills } from '../../index.js';
import { registerSkillTools } from '../../../tools/builtins/skills/invoke-skill.js';
import { runL2Skill } from '../../l2/runtime.js';
import { DefaultSkillAuditLog } from '../../audit.js';
import { DefaultAccessStore, DefaultAccessAuditLog } from '../../../../shared/access.js';

import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../../shared/types.js';
import type { Session } from '../../../../agent/session.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const REPO = '/repo/aq-data-test';
// data.meta.classify-question's catalog prefilter requires
// `owner: 'data-analyzer'` AND a matching `connection-family`
// precondition. So we stage a `file`-family connection so that
// data-analyzer file-family L1 skills (e.g. data.source.file.describe)
// survive the prefilter. The connection here is a roster entry only;
// it doesn't need to be a real registered connection in the data
// driver pool because we never actually execute the L1 against a
// live driver -- the dispatch returns a precondition-failed
// SkillResult which is still counted as a dispatched call by the L2
// runtime (callL1 doesn't throw on precondition failures; it returns
// rejectAsLow which the L2 captures and appends to the ledger).
const CONNECTIONS = [
	{ id: 'file-1', family: 'file', kind: 'csv', label: 'fixture-csv' },
];

// The L1 skill we route classify/select-scope toward in every test.
// File-family scope means it survives the prefilter for the `file`
// connection above. Its execute() will return low-confidence (no
// registered driver), but the dispatch is still counted -- which is
// what the L2-control-flow assertions need.
const DISPATCH_SKILL = 'data.source.file.describe';
const DISPATCH_GOAL  = 'Describe the schema of the fixture-csv file connection so the caller can present columns + types to the user.';
const DISPATCH_ARGS  = { connectionId: 'file-1' };

interface Fixture {
	readonly graphDir: string;
	dispose(): Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	_resetL2RegistryForTests();

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-data-answer-question-test-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO, name: '', addedAt: now, status: 'pending' });

	registerAllSkills();
	// classify-question's precondition requires `skill_describe` tool.
	registerSkillTools();

	return {
		graphDir,
		async dispose() {
			await closeGraphStore();
			rmSync(graphDir, { recursive: true, force: true });
		},
	};
}

function fakeSession(): Session {
	const stub: Record<string, unknown> = {
		id: 'aq-data-test', repoPath: REPO, closureRepos: [REPO], startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

// ---------------------------------------------------------------------------
// Routed fake provider (mirrors the post-P11 code-side helper)
// ---------------------------------------------------------------------------

/**
 * Returns canned responses per LLM call. The provider inspects the
 * `tools` option to decide which staged response to use:
 *
 *   - `submit_answer` in tools          -> staged `draft` tool_use
 *                                          (toolCalls populated, or
 *                                          end_turn if `draft` is
 *                                          'no-tool-call').
 *   - `submit_classification` in tools  -> consume next textResponse,
 *                                          wrap as classify tool_use.
 *   - `submit_scope` in tools           -> same, wrapped as
 *                                          submit_scope.
 *   - otherwise                         -> raw text + end_turn.
 */
interface ProviderScript {
	readonly textResponses: readonly string[];
	readonly draft?:        Record<string, unknown> | 'no-tool-call';
}

function makeProvider(script: ProviderScript): LLMProvider {
	let textIndex = 0;
	const wrapAsToolCall = (raw: string, toolName: string): LLMResponse => {
		const unwrapped = raw.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
		try {
			const parsed = JSON.parse(unwrapped);
			return {
				text:       '',
				stopReason: 'tool_use' as const,
				toolCalls:  [{ id: `tc-${textIndex}`, name: toolName, input: parsed }],
				usage:      { inputTokens: 100, outputTokens: 200 },
			};
		} catch {
			return { text: raw, stopReason: 'end_turn' as const };
		}
	};
	return {
		complete: async (_messages: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse> => {
			const tools = opts?.tools ?? [];
			const wantsAnswerTool = tools.some(t => t.name === 'submit_answer');
			if (wantsAnswerTool) {
				if (script.draft === undefined || script.draft === 'no-tool-call') {
					return { text: '', stopReason: 'end_turn' as const };
				}
				return {
					text:       '',
					stopReason: 'tool_use' as const,
					toolCalls:  [{ id: 'tc-draft', name: 'submit_answer', input: script.draft }],
					usage:      { inputTokens: 100, outputTokens: 200 },
				};
			}
			if (textIndex >= script.textResponses.length) {
				throw new Error(`fake provider exhausted: textIndex=${textIndex}, available=${script.textResponses.length}`);
			}
			const text = script.textResponses[textIndex++]!;
			const submitTool = tools.find(t => t.name === 'submit_classification' || t.name === 'submit_scope');
			if (submitTool !== undefined) {
				return wrapAsToolCall(text, submitTool.name);
			}
			return { text, stopReason: 'end_turn' as const };
		},
		stream: async function* () { yield ''; },
		embed:  async () => [],
		supportsTools: true,
	};
}

// ---------------------------------------------------------------------------
// Canned JSON helpers
// ---------------------------------------------------------------------------

function classifyOutput(opts: {
	readonly questionType?: string;
	readonly candidates?:   Array<{ skillId: string; goal: string; mustHaveScope?: string; rationale?: string }>;
}): string {
	const questionType = opts.questionType ?? 'free-form';
	const candidates = (opts.candidates ?? []).map(c => ({
		skillId:       c.skillId,
		rationale:     c.rationale ?? 'fixed rationale for test',
		goal:          c.goal,
		mustHaveScope: c.mustHaveScope ?? 'none',
	}));
	return JSON.stringify({ questionType, candidates, fallbacks: [], uncertaintyNotes: [] });
}

function scopeOutput(opts: {
	readonly scoped?: Array<{ skillId: string; args: Record<string, unknown>; resolvedScope: Record<string, unknown> }>;
}): string {
	const scoped = (opts.scoped ?? []).map(s => ({
		skillId:       s.skillId,
		args:          s.args,
		resolvedScope: s.resolvedScope,
	}));
	return JSON.stringify({ scoped, notes: [] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('data.answer-question: input validation rejects missing question', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('data.answer-question');
		assert.ok(skill, 'data.answer-question not registered');
		const result = await runL2Skill(skill,
			{ input: { connections: CONNECTIONS } as unknown as Parameters<typeof skill.run>[0]['input'], invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => makeProvider({ textResponses: [] }) },
		);
		assert.ok(result.rejected, 'should have rejected');
		assert.equal(result.rejected.reason, 'input-validation');
	} finally { await fx.dispose(); }
});

test('data.answer-question: classify returns zero candidates -> low-confidence shortcut', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('data.answer-question');
		assert.ok(skill);

		const result = await runL2Skill(skill,
			{ input: { question: 'How many tables are in the warehouse?', connections: CONNECTIONS }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [classifyOutput({ candidates: [] })],
			  }) },
		);

		assert.equal(result.rejected, undefined, JSON.stringify(result.rejected));
		const v = result.output.value as { sections: unknown[]; dispatched: unknown[] };
		assert.equal(v.sections.length, 0);
		assert.equal(v.dispatched.length, 0);
		assert.equal(result.output.confidence, 'low');
		assert.ok((result.output.notes ?? []).some(n => /no-candidates/.test(n)),
			`expected no-candidates note; got ${JSON.stringify(result.output.notes)}`);
	} finally { await fx.dispose(); }
});

test('data.answer-question: select-scope returns zero scoped -> low-confidence shortcut', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('data.answer-question');
		assert.ok(skill);

		const result = await runL2Skill(skill,
			{ input: { question: 'List unreachable code entities.', connections: CONNECTIONS }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [
					classifyOutput({
						candidates: [{
							skillId: DISPATCH_SKILL,
							goal: DISPATCH_GOAL,
							mustHaveScope: 'connection',
						}],
					}),
					scopeOutput({ scoped: [] }),
				],
			  }) },
		);

		assert.equal(result.rejected, undefined, JSON.stringify(result.rejected));
		const v = result.output.value as { sections: unknown[]; dispatched: unknown[] };
		assert.equal(v.sections.length, 0);
		assert.equal(v.dispatched.length, 0);
		assert.equal(result.output.confidence, 'low');
		assert.ok((result.output.notes ?? []).some(n => /no-scoped/.test(n)),
			`expected no-scoped note; got ${JSON.stringify(result.output.notes)}`);
	} finally { await fx.dispose(); }
});

test('data.answer-question: happy path with classify -> select -> dispatch -> draft -> ground', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('data.answer-question');
		assert.ok(skill);

		const draftPayload = {
			sections: [
				{
					title: 'Dead code summary',
					body:  'No unreachable entities reported.',
					citationRefs: ['__WILDCARD__'],
				},
			],
		};

		const result = await runL2Skill(skill,
			{ input: { question: 'List unreachable code entities.', connections: CONNECTIONS }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [
					classifyOutput({
						candidates: [{
							skillId: DISPATCH_SKILL,
							goal: DISPATCH_GOAL,
							mustHaveScope: 'connection',
						}],
					}),
					scopeOutput({
						scoped: [{
							skillId:       DISPATCH_SKILL,
							args:          DISPATCH_ARGS,
							resolvedScope: { connectionId: 'file-1' },
						}],
					}),
				],
				draft: draftPayload,
			  }) },
		);

		assert.equal(result.rejected, undefined, JSON.stringify(result.rejected));
		const v = result.output.value as { sections: Array<{ title: string }>; dispatched: Array<{ skillId: string; goal: string }>; questionType: string };

		// Dispatch ran exactly one L1 sub-skill.
		assert.equal(v.dispatched.length, 1);
		assert.equal(v.dispatched[0]!.skillId, DISPATCH_SKILL);
		assert.match(v.dispatched[0]!.goal, /Describe the schema/);

		// The dispatched call produced a ledger entry -- the section's
		// `__WILDCARD__` ref isn't a real ledger ref, so grounding drops
		// it. We assert the structural path; the next test pins phantom-
		// citation drops directly.
		assert.equal(v.questionType, 'free-form');
	} finally { await fx.dispose(); }
});

test('data.answer-question: invocationContext.requiredCategories does not break dispatch (P4 stage-only)', async () => {
	// P4 of plans/planner-cross-category-skills.md: the L2 skill reads
	// `requiredCategories` from invocationContext and computes
	// `allowedOwners` locally. Until P5 lands the meta-skill schema
	// widening, the value is NOT passed to classify/select-scope -- so
	// the dispatch must complete with the same result it would without
	// the field present.
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('data.answer-question');
		assert.ok(skill);

		const result = await runL2Skill(skill,
			{ input: {
				question:    'List unreachable code entities.',
				connections: CONNECTIONS,
			  }, invocationContext: {
				// Wire the field that P3->P4 threads via the orchestrator.
				// The L2 skill reads it; the value is staged locally and
				// not propagated to meta skills (would trip their
				// additionalProperties:false schema until P5).
				requiredCategories: ['code-analyzer'],
			  } },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [
					classifyOutput({
						candidates: [{
							skillId: DISPATCH_SKILL,
							goal: DISPATCH_GOAL,
							mustHaveScope: 'connection',
						}],
					}),
					scopeOutput({
						scoped: [{
							skillId:       DISPATCH_SKILL,
							args:          DISPATCH_ARGS,
							resolvedScope: { connectionId: 'file-1' },
						}],
					}),
				],
				draft: {
					sections: [
						{ title: 'surface', body: 'Empty result.', citationRefs: ['__WILDCARD__'] },
					],
				},
			  }) },
		);

		assert.equal(result.rejected, undefined, `runtime rejected: ${JSON.stringify(result.rejected)}`);
		const v = result.output.value as { dispatched: unknown[] };
		assert.equal(v.dispatched.length, 1,
			'requiredCategories must NOT leak into meta-skill payloads in P4; ' +
			'a length of 0 means the value propagated and tripped select-scope input validation');
	} finally { await fx.dispose(); }
});

test('data.answer-question: extra fields do not leak into select-scope payload', async () => {
	// REGRESSION GUARD (mirrors the 2026-06-02 code-side scopeTier=XL
	// regression). data.meta.select-scope's inputSchema is
	// `additionalProperties: false` and accepts ONLY
	// { question, candidates, connections }. If this L2 skill ever
	// adds a field to its input (priorContext, ad-hoc hints, etc.)
	// and lets it leak through to the select-scope call, the L1
	// runtime rejects with `invalid-input`, the dispatch loop hits
	// the no-scoped shortcut, dispatched.length collapses to 0, and
	// this test fails loudly.
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('data.answer-question');
		assert.ok(skill);

		const result = await runL2Skill(skill,
			{ input: {
				question:    'List unreachable code entities.',
				connections: CONNECTIONS,
				// priorContext is a legitimate input field on
				// data.answer-question that MUST stay inside this L2
				// skill and NOT leak through to select-scope.
				priorContext: { repoPath: REPO, sessionTags: ['unit-test'] },
			  }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [
					classifyOutput({
						candidates: [{
							skillId: DISPATCH_SKILL,
							goal: DISPATCH_GOAL,
							mustHaveScope: 'connection',
						}],
					}),
					scopeOutput({
						scoped: [{
							skillId:       DISPATCH_SKILL,
							args:          DISPATCH_ARGS,
							resolvedScope: { connectionId: 'file-1' },
						}],
					}),
				],
				draft: {
					sections: [
						{ title: 'surface', body: 'Empty result.', citationRefs: ['__WILDCARD__'] },
					],
				},
			  }) },
		);

		assert.equal(result.rejected, undefined, `runtime rejected: ${JSON.stringify(result.rejected)}`);
		const v = result.output.value as { dispatched: unknown[] };
		assert.equal(v.dispatched.length, 1,
			'select-scope must accept the L2 payload when priorContext is set; ' +
			'a length of 0 means priorContext (or some other extra field) leaked ' +
			'into the select-scope call and tripped its inputSchema');

		const notes = result.output.notes ?? [];
		for (const n of notes) {
			assert.doesNotMatch(n, /select-scope.*invalid-input|unexpected property/,
				`notes should not flag select-scope input-validation; got: ${n}`);
		}
	} finally { await fx.dispose(); }
});

test('data.answer-question: phantom citationRefs are dropped and confidence drops', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('data.answer-question');
		assert.ok(skill);

		const groundedEvents: string[] = [];

		const result = await runL2Skill(skill,
			{ input: { question: 'List unreachable code entities.', connections: CONNECTIONS }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [
					classifyOutput({
						candidates: [{
							skillId: DISPATCH_SKILL,
							goal: DISPATCH_GOAL,
							mustHaveScope: 'connection',
						}],
					}),
					scopeOutput({
						scoped: [{
							skillId:       DISPATCH_SKILL,
							args:          DISPATCH_ARGS,
							resolvedScope: { connectionId: 'file-1' },
						}],
					}),
				],
				draft: {
					sections: [
						{
							title: 'Phantom section',
							body:  'This section cites a ref that does not exist in the ledger.',
							citationRefs: ['ref-does-not-exist'],
						},
					],
				},
			  }),
			  emit: (event) => { if (event.kind === 'self-ground-flagged') groundedEvents.push(event.claim); } },
		);

		assert.equal(result.rejected, undefined, JSON.stringify(result.rejected));
		const v = result.output.value as { sections: unknown[]; dispatched: unknown[] };
		assert.equal(v.sections.length, 0, 'phantom-ref section should be dropped');
		assert.equal(v.dispatched.length, 1, 'dispatch still ran');
		assert.equal(result.output.confidence, 'low', 'no grounded sections -> confidence low');
		assert.ok(groundedEvents.includes('Phantom section'),
			`expected self-ground-flagged for "Phantom section"; got ${groundedEvents.join(',')}`);
		assert.ok((result.output.notes ?? []).some(n => /dropped/.test(n)),
			`expected drop note; got ${JSON.stringify(result.output.notes)}`);
	} finally { await fx.dispose(); }
});

test('data.answer-question: LLM emits no draft tool call -> empty sections + low confidence', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('data.answer-question');
		assert.ok(skill);

		const result = await runL2Skill(skill,
			{ input: { question: 'List unreachable code entities.', connections: CONNECTIONS }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [
					classifyOutput({
						candidates: [{
							skillId: DISPATCH_SKILL,
							goal: DISPATCH_GOAL,
							mustHaveScope: 'connection',
						}],
					}),
					scopeOutput({
						scoped: [{
							skillId:       DISPATCH_SKILL,
							args:          DISPATCH_ARGS,
							resolvedScope: { connectionId: 'file-1' },
						}],
					}),
				],
				draft: 'no-tool-call',
			  }) },
		);

		assert.equal(result.rejected, undefined, JSON.stringify(result.rejected));
		const v = result.output.value as { sections: unknown[]; dispatched: unknown[] };
		assert.equal(v.sections.length, 0);
		assert.equal(v.dispatched.length, 1, 'dispatch still ran before draft step');
		assert.equal(result.output.confidence, 'low');
		assert.ok((result.output.notes ?? []).some(n => /submit_answer/.test(n)),
			`expected submit_answer note; got ${JSON.stringify(result.output.notes)}`);
	} finally { await fx.dispose(); }
});

test('data.answer-question: grounded section keeps when citationRefs include a real ledger entry', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('data.answer-question');
		assert.ok(skill);

		// Capture-mode provider: harvest the actual ledger ref from the
		// draft-step prompt and echo it back in the tool_use. Resilient
		// to ledger-ref naming changes.
		let capturedRef: string | undefined;
		const provider: LLMProvider = {
			complete: async (messages: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse> => {
				const tools = opts?.tools ?? [];
				const wantsAnswerTool = tools.some(t => t.name === 'submit_answer');
				if (wantsAnswerTool) {
					const userMsg = messages.find(m => m.role === 'user');
					if (userMsg !== undefined && typeof userMsg.content === 'string') {
						const m = /ref=`([^`]+)`/.exec(userMsg.content);
						if (m !== null) capturedRef = m[1];
					}
					if (capturedRef === undefined) {
						return { text: '', stopReason: 'end_turn' as const };
					}
					return {
						text:       '',
						stopReason: 'tool_use' as const,
						toolCalls:  [{ id: 'tc-draft', name: 'submit_answer', input: {
							sections: [
								{
									title: 'Dead code surface',
									body:  'No unreachable entities reported.',
									citationRefs: [capturedRef],
								},
							],
						}}],
						usage: { inputTokens: 100, outputTokens: 200 },
					};
				}
				const callSeq = (provider as unknown as { _seq?: number })._seq ?? 0;
				(provider as unknown as { _seq?: number })._seq = callSeq + 1;
				const responses = [
					classifyOutput({
						candidates: [{
							skillId: DISPATCH_SKILL,
							goal: DISPATCH_GOAL,
							mustHaveScope: 'connection',
						}],
					}),
					scopeOutput({
						scoped: [{
							skillId:       DISPATCH_SKILL,
							args:          DISPATCH_ARGS,
							resolvedScope: { connectionId: 'file-1' },
						}],
					}),
				];
				if (callSeq >= responses.length) {
					throw new Error(`fake provider exhausted: callSeq=${callSeq}`);
				}
				const submitTool = tools.find(t => t.name === 'submit_classification' || t.name === 'submit_scope');
				const raw = responses[callSeq]!;
				if (submitTool === undefined) {
					return { text: raw, stopReason: 'end_turn' as const };
				}
				return {
					text:       '',
					stopReason: 'tool_use' as const,
					toolCalls:  [{ id: `tc-${callSeq}`, name: submitTool.name, input: JSON.parse(raw) }],
					usage:      { inputTokens: 100, outputTokens: 200 },
				};
			},
			stream: async function* () { yield ''; },
			embed:  async () => [],
			supportsTools: true,
		};

		const result = await runL2Skill(skill,
			{ input: { question: 'List unreachable code entities.', connections: CONNECTIONS }, invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => provider },
		);

		assert.equal(result.rejected, undefined, JSON.stringify(result.rejected));
		const v = result.output.value as { sections: Array<{ title: string }>; dispatched: unknown[] };
		assert.equal(v.sections.length, 1, `section with real ref should ground; got ${JSON.stringify(v.sections)}`);
		assert.equal(v.sections[0]!.title, 'Dead code surface');
		assert.equal(v.dispatched.length, 1);
		assert.ok(result.output.evidence.length >= 1, 'evidence must be populated');
		assert.equal(result.output.confidence, 'high', 'no drops + no dispatch failures -> high');
	} finally { await fx.dispose(); }
});
