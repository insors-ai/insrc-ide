/**
 * Tests for `patchSectionItemwise` -- Phase R.1 of the structured-review
 * plan. The per-item patch loop eliminates the ghost-ID failure mode of
 * `patchSectionWithTools` by iterating one work item at a time and
 * letting the orchestrator (not the LLM) own the patch-block IDs.
 *
 * These tests stub the LLM provider so we can drive scenarios that
 * exercise each kind end-to-end without a network call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	patchSectionItemwise,
	_stripParagraphArtifactsForTest as stripArtifacts,
	_resolveParagraphIdxByWhereForTest as resolveIdx,
	_KIND_ORDER_FOR_TEST as KIND_ORDER,
	type PatchSectionItemwiseInput,
} from '../write-section.js';
import type { ReviewWorkItem } from '../../../content-gen/review-action.js';
import type { LLMProvider, LLMResponse, LLMMessage, CompletionOpts } from '../../../../shared/types.js';
import type { Session } from '../../../session.js';
import type { PlannedAction } from '../../../content-gen/plan-actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CompleteCall {
	readonly system: string;
	readonly user:   string;
	readonly maxTokens?: number | undefined;
}

interface FakeProviderHandle {
	readonly provider: LLMProvider;
	readonly calls:    CompleteCall[];
}

/**
 * Build a provider whose `complete()` returns canned text in sequence.
 * Each call records the system + user prompts so tests can assert what
 * the per-item prompt looked like.
 */
function buildFakeProvider(responses: readonly string[]): FakeProviderHandle {
	const calls: CompleteCall[] = [];
	let idx = 0;
	const provider: LLMProvider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse> {
			const sys  = messages.find(m => m.role === 'system')?.content ?? '';
			const user = messages.find(m => m.role === 'user')?.content ?? '';
			calls.push({
				system: typeof sys  === 'string' ? sys  : '',
				user:   typeof user === 'string' ? user : '',
				maxTokens: opts?.maxTokens,
			});
			if (idx >= responses.length) {
				throw new Error(`fake provider out of canned responses (idx=${idx})`);
			}
			const text = responses[idx]!;
			idx++;
			return { text, stopReason: 'end_turn' };
		},
		async *stream() { /* unused */ },
		async embed() { return []; },
	};
	return { provider, calls };
}

function buildInput(opts: {
	draft:     string;
	workItems: readonly ReviewWorkItem[];
	provider:  LLMProvider;
}): PatchSectionItemwiseInput {
	const action: PlannedAction = {
		id:              'sec-1',
		title:           'Test Section',
		objective:       'Explain something.',
		maxBudgetTokens: 1500,
		reviewCriteria:  ['cite files', 'be specific'],
	};
	return {
		provider:             opts.provider,
		session:              {} as unknown as Session,
		action,
		request:              'test request',
		repoContext:          {},
		draftMarkdown:        opts.draft,
		workItems:            opts.workItems,
		priorDescribedSkills: new Set<string>(),
		priorSkillCalls:      [],
		round:                2,
	};
}

// ---------------------------------------------------------------------------
// stripParagraphArtifacts
// ---------------------------------------------------------------------------

test('stripParagraphArtifacts: removes fenced wrapper', () => {
	assert.equal(stripArtifacts('```\nhello world\n```'), 'hello world');
	assert.equal(stripArtifacts('```markdown\nhello world\n```'), 'hello world');
});

test('stripParagraphArtifacts: strips "Here is the revised paragraph:" prefix', () => {
	assert.equal(
		stripArtifacts('Here is the revised paragraph: The actual content.'),
		'The actual content.',
	);
});

test('stripParagraphArtifacts: strips "Revised paragraph:" label', () => {
	assert.equal(
		stripArtifacts('Revised paragraph: The actual content.'),
		'The actual content.',
	);
});

test('stripParagraphArtifacts: no-op on clean paragraph', () => {
	const clean = 'The `NameNode` keeps the FsImage in memory across restarts.';
	assert.equal(stripArtifacts(clean), clean);
});

// ---------------------------------------------------------------------------
// resolveParagraphIdxByWhere
// ---------------------------------------------------------------------------

test('resolveIdxByWhere: paragraph N is 1-indexed', () => {
	const paras = ['a', 'b', 'c'];
	assert.equal(resolveIdx('paragraph 1', paras), 0);
	assert.equal(resolveIdx('paragraph 3', paras), 2);
	assert.equal(resolveIdx('paragraph 4', paras), null);
});

test('resolveIdxByWhere: section opening / closing', () => {
	const paras = ['a', 'b', 'c'];
	assert.equal(resolveIdx('section opening', paras), 0);
	assert.equal(resolveIdx('section closing', paras), 2);
	assert.equal(resolveIdx('end', paras), 2);
});

// ---------------------------------------------------------------------------
// KIND_ORDER (fix first; trim last)
// ---------------------------------------------------------------------------

test('KIND_ORDER: fix < add < trim', () => {
	assert.ok(KIND_ORDER.fix < KIND_ORDER.add);
	assert.ok(KIND_ORDER.add < KIND_ORDER.trim);
});

// ---------------------------------------------------------------------------
// patchSectionItemwise -- per-kind behaviour
// ---------------------------------------------------------------------------

test('patchSectionItemwise: trim deletes target paragraph without an LLM call', async () => {
	const draft = 'para one.\n\npara two.\n\npara three.';
	const workItems: ReviewWorkItem[] = [
		{ id: 'wi-1', kind: 'trim', where: 'paragraph 2', issue: 'redundant', action: 'cut' },
	];
	const { provider, calls } = buildFakeProvider([]); // expect ZERO calls
	const result = await patchSectionItemwise(buildInput({ draft, workItems, provider }));

	assert.equal(calls.length, 0, 'trim should NOT call the LLM');
	assert.equal(result.itemStatuses[0]?.status, 'addressed');
	assert.equal(result.markdown, 'para one.\n\npara three.');
	assert.equal(result.patchProtocolFollowed, true);
});

test('patchSectionItemwise: fix replaces the targeted paragraph', async () => {
	const draft = 'opening.\n\nORIGINAL paragraph 2 with mistake.\n\nclosing.';
	const workItems: ReviewWorkItem[] = [
		{ id: 'wi-fix', kind: 'fix', where: 'paragraph 2', issue: 'wrong', action: 'correct it' },
	];
	const { provider, calls } = buildFakeProvider(['Corrected paragraph 2 with the right fact.']);
	const result = await patchSectionItemwise(buildInput({ draft, workItems, provider }));

	assert.equal(calls.length, 1);
	assert.equal(result.itemStatuses[0]?.status, 'addressed');
	assert.match(result.markdown, /Corrected paragraph 2/);
	assert.doesNotMatch(result.markdown, /ORIGINAL paragraph 2/);
	assert.equal(result.patchProtocolFollowed, true);
});

test('patchSectionItemwise: fix replaces target paragraph with LLM output', async () => {
	const draft = 'p1.\n\nthin paragraph.\n\np3.';
	const workItems: ReviewWorkItem[] = [
		{ id: 'wi-2', kind: 'fix', where: 'paragraph 2', issue: 'thin', action: 'add specifics' },
	];
	const { provider } = buildFakeProvider(['Richer paragraph with [foo](path:foo.ts) citation.']);
	const result = await patchSectionItemwise(buildInput({ draft, workItems, provider }));

	assert.equal(result.itemStatuses[0]?.status, 'addressed');
	assert.match(result.markdown, /Richer paragraph/);
});

test('patchSectionItemwise: empty fix response yields skipped status, draft unchanged', async () => {
	const draft = 'p1.\n\np2.\n\np3.';
	const workItems: ReviewWorkItem[] = [
		{ id: 'wi-1', kind: 'fix', where: 'paragraph 2', issue: 'x', action: 'y' },
	];
	const { provider } = buildFakeProvider(['   \n  ']);
	const result = await patchSectionItemwise(buildInput({ draft, workItems, provider }));

	assert.equal(result.itemStatuses[0]?.status, 'skipped');
	assert.match(result.itemStatuses[0]?.reason ?? '', /empty/);
	assert.equal(result.markdown, draft);
	assert.equal(result.patchProtocolFollowed, false);
});

test('patchSectionItemwise: prompts include item.issue + action + targeted paragraph text', async () => {
	const draft = 'first paragraph.\n\nsecond paragraph that is broken.\n\nthird paragraph.';
	const workItems: ReviewWorkItem[] = [
		{ id: 'wi-1', kind: 'fix', where: 'paragraph 2', issue: 'broken claim', action: 'rewrite specifically' },
	];
	const { provider, calls } = buildFakeProvider(['fixed second paragraph.']);
	await patchSectionItemwise(buildInput({ draft, workItems, provider }));

	assert.equal(calls.length, 1);
	const userPrompt = calls[0]!.user;
	assert.match(userPrompt, /broken claim/);
	assert.match(userPrompt, /rewrite specifically/);
	assert.match(userPrompt, /second paragraph that is broken/);
});

test('patchSectionItemwise: addresses fix BEFORE add even when reviewer lists add first', async () => {
	const draft = 'p1.\n\np2.\n\np3.';
	const workItems: ReviewWorkItem[] = [
		{ id: 'wi-add', kind: 'add', where: 'after paragraph 3', issue: 'missing', action: 'add coverage' },
		{ id: 'wi-fix', kind: 'fix', where: 'paragraph 2',       issue: 'wrong',   action: 'correct'      },
	];
	const { provider, calls } = buildFakeProvider([
		'corrected p2.',     // fix runs first (KIND_ORDER.fix=0)
		'new paragraph.',    // add runs second (KIND_ORDER.add=1)
	]);
	const result = await patchSectionItemwise(buildInput({ draft, workItems, provider }));

	assert.equal(calls.length, 2);
	// Fix prompt must mention the fix item's issue, NOT the add item's.
	assert.match(calls[0]!.user, /wrong/);
	assert.doesNotMatch(calls[0]!.user, /missing/);
	// Statuses emitted in the reviewer's original order (add first, fix second).
	assert.equal(result.itemStatuses[0]?.id, 'wi-add');
	assert.equal(result.itemStatuses[1]?.id, 'wi-fix');
	assert.equal(result.itemStatuses[0]?.status, 'addressed');
	assert.equal(result.itemStatuses[1]?.status, 'addressed');
});

test('patchSectionItemwise: ghost-ID immunity -- no fenced-block IDs anywhere in the input', async () => {
	// The reviewer hands the orchestrator wi-XYZ; the per-item prompt
	// must NOT ask the writer to emit any kind of ID, fence, or block
	// tag. This is the structural property R.1 guarantees.
	const draft = 'a.\n\nb.\n\nc.';
	const workItems: ReviewWorkItem[] = [
		{ id: 'wi-XYZ-123', kind: 'fix', where: 'paragraph 2', issue: 'wrong', action: 'rewrite' },
	];
	const { provider, calls } = buildFakeProvider(['new b.']);
	await patchSectionItemwise(buildInput({ draft, workItems, provider }));

	const userPrompt = calls[0]!.user;
	const sysPrompt  = calls[0]!.system;
	assert.doesNotMatch(userPrompt + sysPrompt, /patch:wi/);
	assert.doesNotMatch(userPrompt + sysPrompt, /wi-XYZ-123/);
	assert.doesNotMatch(userPrompt + sysPrompt, /skip:wi/);
	assert.doesNotMatch(userPrompt + sysPrompt, /```patch/);
});

test('patchSectionItemwise: patchProtocolFollowed false when zero items addressed', async () => {
	const draft = 'p1.\n\np2.';
	const workItems: ReviewWorkItem[] = [
		{ id: 'wi-1', kind: 'fix',     where: 'paragraph 1', issue: 'x', action: 'y' },
		{ id: 'wi-2', kind: 'fix', where: 'paragraph 2', issue: 'x', action: 'y' },
	];
	const { provider } = buildFakeProvider(['', '   ']); // both empty
	const result = await patchSectionItemwise(buildInput({ draft, workItems, provider }));

	assert.equal(result.patchProtocolFollowed, false);
	assert.equal(result.itemStatuses.every(s => s.status === 'skipped'), true);
	assert.equal(result.markdown, draft);
});

test('patchSectionItemwise: tool-call budget exhaustion skips remaining non-trim items', async () => {
	const draft = 'p1.\n\np2.\n\np3.';
	const workItems: ReviewWorkItem[] = [
		{ id: 'wi-1', kind: 'fix', where: 'paragraph 1', issue: 'x', action: 'y' },
		{ id: 'wi-2', kind: 'fix', where: 'paragraph 2', issue: 'x', action: 'y' },
	];
	const { provider, calls } = buildFakeProvider(['first.']);
	const input: PatchSectionItemwiseInput = { ...buildInput({ draft, workItems, provider }), maxToolCalls: 1 };
	const result = await patchSectionItemwise(input);

	assert.equal(calls.length, 1);
	assert.equal(result.itemStatuses[0]?.status, 'addressed');
	assert.equal(result.itemStatuses[1]?.status, 'skipped');
	assert.match(result.itemStatuses[1]?.reason ?? '', /budget/);
});

test('patchSectionItemwise: trim still runs even when LLM budget is exhausted', async () => {
	// trim makes NO LLM call so it should always run.
	const draft = 'p1.\n\np2.';
	const workItems: ReviewWorkItem[] = [
		{ id: 'wi-trim', kind: 'trim', where: 'paragraph 2', issue: 'cut', action: 'cut' },
	];
	const { provider } = buildFakeProvider([]); // zero responses -- must not be called
	const input: PatchSectionItemwiseInput = { ...buildInput({ draft, workItems, provider }), maxToolCalls: 0 };
	const result = await patchSectionItemwise(input);

	assert.equal(result.itemStatuses[0]?.status, 'addressed');
	assert.equal(result.markdown, 'p1.');
});
