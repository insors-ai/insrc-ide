/**
 * code.answer-question unit tests (deterministic-fake provider).
 *
 * Per A6: fake-provider tests pin code-path coverage. The live LLM
 * test in ./live/ exercises the judgment loop.
 *
 * Coverage:
 *   - Input validation rejects missing question.
 *   - classify-question returning zero candidates -> early-exit shortcut.
 *   - Happy path: classify -> select-scope -> dispatch -> draft -> ground.
 *   - Draft LLM omits citationRefs -> grounding drops, confidence low.
 *   - Draft LLM emits no tool call at all -> sections empty, low conf.
 *   - select-scope returning zero scoped invocations -> early-exit shortcut.
 *
 * The flow under test makes (up to) three LLM calls in order:
 *   1. classify-question (text JSON; responseFormat: schema)
 *   2. select-scope     (text JSON; responseFormat: schema)
 *   3. submit_answer    (tool_use; toolChoice: submit_answer)
 *
 * The dispatched L1 skill is `code.source.file.describe`, which is
 * pure-graph (no LLM call) so the sequence stays tight.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { closeGraphStore, setGraphStorePath } from '../../../../db/graph/store.js';
import { upsertEntities } from '../../../../db/entities.js';
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
import type { Entity, EntityKind, Language } from '../../../../shared/types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const REPO = '/repo/aq-test';
const FILE = `${REPO}/src/widgets/Widget.ts`;

interface Fixture {
	readonly graphDir: string;
	dispose(): Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	_resetL2RegistryForTests();

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-answer-question-test-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO, name: '', addedAt: now, status: 'pending' });

	registerAllSkills();
	// classify-question's precondition requires `skill_describe` tool
	// to be registered. Wire the skill-meta tools so feasibility passes.
	registerSkillTools();

	return {
		graphDir,
		async dispose() {
			await closeGraphStore();
			rmSync(graphDir, { recursive: true, force: true });
		},
	};
}

function mkId(repo: string, file: string, kind: string, name: string): string {
	return createHash('sha256').update(`${repo}\x00${file}\x00${kind}\x00${name}`).digest('hex').slice(0, 32);
}

function ent(opts: { kind: EntityKind; name: string; file?: string; body?: string }): Entity {
	const file = opts.file ?? FILE;
	return {
		id:        mkId(REPO, file, opts.kind, opts.name),
		kind:      opts.kind,
		name:      opts.name,
		language:  'typescript' as Language,
		repoId:    1,
		repo:      REPO,
		file,
		startLine: 1,
		endLine:   30,
		body:      opts.body ?? '',
		embedding: [],
		indexedAt: '2026-06-01T00:00:00.000Z',
	};
}

function fakeSession(): Session {
	const stub: Record<string, unknown> = {
		id: 'aq-test', repoPath: REPO, closureRepos: [REPO], startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

// ---------------------------------------------------------------------------
// Routed fake provider
// ---------------------------------------------------------------------------

/**
 * Returns canned responses per LLM call. The provider inspects the
 * `tools` / `responseFormat` options to decide which staged response
 * to use:
 *
 *   - `submit_answer` in tools  -> the staged `draft` tool_use
 *                                  (toolCalls populated).
 *   - otherwise                 -> consume the next item from
 *                                  `textResponses` in order. This
 *                                  matches how classify-question +
 *                                  select-scope call the LLM (text
 *                                  with responseFormat: { schema }).
 */
interface ProviderScript {
	readonly textResponses: readonly string[];
	readonly draft?:        Record<string, unknown> | 'no-tool-call';
}

function makeProvider(script: ProviderScript): LLMProvider {
	let textIndex = 0;
	return {
		complete: async (_messages: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse> => {
			const wantsAnswerTool = (opts?.tools ?? []).some(t => t.name === 'submit_answer');
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
	const questionType = opts.questionType ?? 'describe-file';
	const candidates = (opts.candidates ?? []).map(c => ({
		skillId:       c.skillId,
		rationale:     c.rationale ?? 'fixed rationale for test',
		goal:          c.goal,
		mustHaveScope: c.mustHaveScope ?? 'repo+file',
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

test('answer-question: input validation rejects missing question', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('code.answer-question');
		assert.ok(skill, 'answer-question not registered');
		const result = await runL2Skill(skill,
			{ input: { activeRepoPath: REPO } as unknown as Parameters<typeof skill.run>[0]['input'], invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => makeProvider({ textResponses: [] }) },
		);
		assert.ok(result.rejected, 'should have rejected');
		assert.equal(result.rejected.reason, 'input-validation');
	} finally { await fx.dispose(); }
});

test('answer-question: classify returns zero candidates -> low-confidence shortcut', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('code.answer-question');
		assert.ok(skill);

		const result = await runL2Skill(skill,
			{ input: { question: 'What does this repo do?', activeRepoPath: REPO }, invocationContext: {} },
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

test('answer-question: select-scope returns zero scoped -> low-confidence shortcut', async () => {
	const fx = await setupFixture();
	try {
		await upsertEntities(null, [
			ent({ kind: 'file', name: FILE, file: FILE }),
		]);

		const skill = getL2Skill('code.answer-question');
		assert.ok(skill);

		const result = await runL2Skill(skill,
			{ input: { question: 'What entities does Widget.ts declare?', activeRepoPath: REPO }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [
					classifyOutput({
						candidates: [{
							skillId: 'code.source.file.describe',
							goal: 'Enumerate the entities defined in Widget.ts and its imports so the caller can present the file surface.',
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

test('answer-question: happy path with classify -> select -> dispatch -> draft -> ground', async () => {
	const fx = await setupFixture();
	try {
		await upsertEntities(null, [
			ent({ kind: 'file', name: FILE, file: FILE }),
			ent({ kind: 'function', name: 'render', file: FILE, body: 'function render() { return 1; }' }),
		]);

		const skill = getL2Skill('code.answer-question');
		assert.ok(skill);

		const draftPayload = {
			sections: [
				{
					title: 'Widget.ts file surface',
					body:  'Defines one function: `render`. No imports detected.',
					// citationRefs are filled at runtime via callsite ref propagation;
					// we use the wildcard form here -- see the fake provider note below.
					citationRefs: ['__WILDCARD__'],
				},
			],
		};

		const result = await runL2Skill(skill,
			{ input: { question: 'What entities does Widget.ts declare?', activeRepoPath: REPO }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [
					classifyOutput({
						candidates: [{
							skillId: 'code.source.file.describe',
							goal: 'Enumerate the entities defined in Widget.ts plus its imports; return the structured surface.',
						}],
					}),
					scopeOutput({
						scoped: [{
							skillId:       'code.source.file.describe',
							args:          { file: FILE, repoPath: REPO },
							resolvedScope: { repoPath: REPO, file: FILE },
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
		assert.equal(v.dispatched[0]!.skillId, 'code.source.file.describe');
		assert.match(v.dispatched[0]!.goal, /Enumerate the entities/);

		// The dispatched call produced a ledger entry -- the section's
		// `__WILDCARD__` ref isn't a real ledger ref, so grounding drops
		// it. We assert the structural path; the next test pins phantom-
		// citation drops directly.
		assert.equal(v.questionType, 'describe-file');
	} finally { await fx.dispose(); }
});

test('answer-question: phantom citationRefs are dropped and confidence drops', async () => {
	const fx = await setupFixture();
	try {
		await upsertEntities(null, [
			ent({ kind: 'file', name: FILE, file: FILE }),
		]);

		const skill = getL2Skill('code.answer-question');
		assert.ok(skill);

		const groundedEvents: string[] = [];

		const result = await runL2Skill(skill,
			{ input: { question: 'What entities does Widget.ts declare?', activeRepoPath: REPO }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [
					classifyOutput({
						candidates: [{
							skillId: 'code.source.file.describe',
							goal: 'Enumerate the entities defined in Widget.ts plus its imports.',
						}],
					}),
					scopeOutput({
						scoped: [{
							skillId:       'code.source.file.describe',
							args:          { file: FILE, repoPath: REPO },
							resolvedScope: { repoPath: REPO, file: FILE },
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

test('answer-question: LLM emits no draft tool call -> empty sections + low confidence', async () => {
	const fx = await setupFixture();
	try {
		await upsertEntities(null, [
			ent({ kind: 'file', name: FILE, file: FILE }),
		]);

		const skill = getL2Skill('code.answer-question');
		assert.ok(skill);

		const result = await runL2Skill(skill,
			{ input: { question: 'What entities does Widget.ts declare?', activeRepoPath: REPO }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => makeProvider({
				textResponses: [
					classifyOutput({
						candidates: [{
							skillId: 'code.source.file.describe',
							goal: 'Enumerate the entities defined in Widget.ts plus its imports.',
						}],
					}),
					scopeOutput({
						scoped: [{
							skillId:       'code.source.file.describe',
							args:          { file: FILE, repoPath: REPO },
							resolvedScope: { repoPath: REPO, file: FILE },
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

test('answer-question: grounded section keeps when citationRefs include a real ledger entry', async () => {
	const fx = await setupFixture();
	try {
		await upsertEntities(null, [
			ent({ kind: 'file', name: FILE, file: FILE }),
		]);

		const skill = getL2Skill('code.answer-question');
		assert.ok(skill);

		// We need a real ledger ref to cite -- capture it via the
		// ledger-grew event. The L2 runtime appends a ledger entry
		// after each successful callL1, but we don't see the ref via
		// emit. Instead, we use a two-pass approach: run once with a
		// wildcard ref to harvest the actual ref via the ledger after
		// the run, then use it. Cleaner: rely on the runtime invariant
		// that the answer-question implementation calls
		// `deps.workingState.list()` to render the prompt with refs in
		// the form `ref=<entry.ref>` -- but the LLM is faked.
		//
		// Simpler workable approach: configure the draft step to cite
		// EVERY ledger entry it knows of. We pre-compute the ref the
		// L2 runtime generates by hooking into the same workingState
		// implementation. Since the ledger ref is `entry.ref` and
		// each append yields a deterministic ref shape, we cite the
		// well-known shape `entry-N` produced by working-state.
		//
		// To stay decoupled from internal naming we do the capture
		// approach: use a provider that captures the dynamically-
		// rendered evidence prompt (it contains `ref=\`<ref>\``) and
		// echo that ref back in the tool_use. This makes the test
		// resilient to ledger-ref naming changes.
		let capturedRef: string | undefined;
		const provider: LLMProvider = {
			complete: async (messages: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse> => {
				const wantsAnswerTool = (opts?.tools ?? []).some(t => t.name === 'submit_answer');
				if (wantsAnswerTool) {
					// Find a ref embedded in the user message.
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
									title: 'Widget.ts file surface',
									body:  'Defines no functions; the file is an empty shell.',
									citationRefs: [capturedRef],
								},
							],
						}}],
						usage: { inputTokens: 100, outputTokens: 200 },
					};
				}
				// classify or select-scope: serve canned text.
				const callSeq = (provider as unknown as { _seq?: number })._seq ?? 0;
				(provider as unknown as { _seq?: number })._seq = callSeq + 1;
				const responses = [
					classifyOutput({
						candidates: [{
							skillId: 'code.source.file.describe',
							goal: 'Enumerate the entities defined in Widget.ts plus its imports.',
						}],
					}),
					scopeOutput({
						scoped: [{
							skillId:       'code.source.file.describe',
							args:          { file: FILE, repoPath: REPO },
							resolvedScope: { repoPath: REPO, file: FILE },
						}],
					}),
				];
				if (callSeq >= responses.length) {
					throw new Error(`fake provider exhausted: callSeq=${callSeq}`);
				}
				return { text: responses[callSeq]!, stopReason: 'end_turn' as const };
			},
			stream: async function* () { yield ''; },
			embed:  async () => [],
			supportsTools: true,
		};

		const result = await runL2Skill(skill,
			{ input: { question: 'What entities does Widget.ts declare?', activeRepoPath: REPO }, invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => provider },
		);

		assert.equal(result.rejected, undefined, JSON.stringify(result.rejected));
		const v = result.output.value as { sections: Array<{ title: string }>; dispatched: unknown[] };
		assert.equal(v.sections.length, 1, `section with real ref should ground; got ${JSON.stringify(v.sections)}`);
		assert.equal(v.sections[0]!.title, 'Widget.ts file surface');
		assert.equal(v.dispatched.length, 1);
		assert.ok(result.output.evidence.length >= 1, 'evidence must be populated');
		assert.equal(result.output.confidence, 'high', 'no drops + no dispatch failures -> high');
	} finally { await fx.dispose(); }
});
