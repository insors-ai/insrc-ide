/**
 * Tests for the expandAction helper (Phase 2 of
 * plans/analyzers/cloud-plan-local-expand-cloud-review.md).
 *
 * The helper sends one LLM call to the local provider and returns
 * the markdown body. Tests use a fakeProvider that returns canned
 * text + stopReason so we can exercise the truncation flag and the
 * refine-hint prompt-shape without hitting Ollama.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	expandAction,
	_buildExpandMessagesForTest as buildExpandMessages,
	_cleanExpanderResponseForTest as cleanExpanderResponse,
} from '../expand-action.js';
import type { PlannedAction, PlanExecution } from '../plan-actions.js';
import type { LLMMessage, LLMProvider, LLMResponse, CompletionOpts } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTION: PlannedAction = {
	id:        'modules-overview',
	title:     'HDFS Core: Module Layout',
	objective: 'Map the top-level HDFS Core packages and their responsibilities.',
	maxBudgetTokens: 1500,
	reviewCriteria: [
		'Names each top-level HDFS Core module by absolute path',
		'Cites the module.describe finding at least once',
	],
};

const EVIDENCE: PlanExecution[] = [
	{ skillId: 'code.source.repo.describe',   value: { topModules: [{ path: '/repo/hadoop/hadoop-hdfs', fileCount: 240 }] }, confidence: 'high', notes: [] },
	{ skillId: 'code.source.module.describe', value: { found: true, modulePath: '/repo/hadoop/hadoop-hdfs' },                confidence: 'high', notes: [] },
];

const REQUEST = 'do a detailed analysis of HDFS Core';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function fakeProvider(text: string, stopReason: string = 'end_turn'): LLMProvider {
	return {
		async complete(_messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
			return { text, stopReason };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};
}

function captureMessagesProvider(text: string, stopReason: string = 'end_turn'): {
	provider: LLMProvider;
	getCaptured: () => LLMMessage[];
	getOpts: () => CompletionOpts | undefined;
} {
	let captured: LLMMessage[] = [];
	let opts: CompletionOpts | undefined;
	return {
		provider: {
			async complete(messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
				captured = messages;
				opts = _opts;
				return { text, stopReason };
			},
			async *stream() { yield ''; },
			async embed() { return []; },
			supportsTools: true,
		},
		getCaptured: () => captured,
		getOpts: () => opts,
	};
}

function fakeProviderThrowing(message: string): LLMProvider {
	return {
		async complete(): Promise<LLMResponse> {
			throw new Error(message);
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};
}

// ---------------------------------------------------------------------------
// cleanExpanderResponse (pure)
// ---------------------------------------------------------------------------

test('cleanExpanderResponse: strips ```markdown / ``` fences', () => {
	assert.equal(cleanExpanderResponse('```markdown\nbody\n```'), 'body');
	assert.equal(cleanExpanderResponse('```md\nbody\n```'),       'body');
	assert.equal(cleanExpanderResponse('```\nbody\n```'),         'body');
});

test('cleanExpanderResponse: strips a leading `## Title` line', () => {
	const got = cleanExpanderResponse('## HDFS Core: Module Layout\n\nThe HDFS module ...');
	assert.equal(got, 'The HDFS module ...');
});

test('cleanExpanderResponse: leaves clean markdown alone', () => {
	const body = 'The HDFS module is at `/repo/hadoop/hadoop-hdfs`.\n\n- foo\n- bar';
	assert.equal(cleanExpanderResponse(body), body);
});

// ---------------------------------------------------------------------------
// buildExpandMessages (prompt assembly)
// ---------------------------------------------------------------------------

test('buildExpandMessages: includes objective, criteria, evidence, request', () => {
	const msgs = buildExpandMessages({ action: ACTION, evidence: EVIDENCE, request: REQUEST });
	assert.equal(msgs.length, 2);
	const sys = msgs[0]!.content as string;
	const user = msgs[1]!.content as string;
	assert.match(sys, /You write ONE section/);
	assert.match(user, /## Original request/);
	assert.match(user, /detailed analysis of HDFS Core/);
	assert.match(user, /title:     HDFS Core: Module Layout/);
	assert.match(user, /objective: Map the top-level/);
	assert.match(user, /## Review criteria/);
	assert.match(user, /Names each top-level HDFS Core module/);
	assert.match(user, /## Evidence \(2\)/);
	assert.match(user, /code\.source\.repo\.describe/);
});

test('buildExpandMessages: refineHint is prepended to system prompt', () => {
	const msgs = buildExpandMessages({
		action: ACTION,
		evidence: EVIDENCE,
		request: REQUEST,
		refineHint: 'Section misses the YARN cross-reference; mention how HDFS Core relates to YARN.',
	});
	const sys = msgs[0]!.content as string;
	assert.match(sys, /## Focused refinement/);
	assert.match(sys, /YARN cross-reference/);
	// And the base system prompt is still in there.
	assert.match(sys, /You write ONE section/);
});

test('buildExpandMessages: system prompt mandates clickable-citation Markdown links (Phase C.2)', () => {
	// Phase C.2 of plans/intent-funnel-followups.md -- the live test
	// surfaced that the analyzer's reports referenced classes / files
	// as plain text. Pre-fix, the rule said "code, paths, and
	// identifiers go in `inline code`" -- a plain-text instruction.
	// Post-fix, the prompt instructs `path:` Markdown links (the
	// scheme the IDE's PathUriOpener wires through).
	const msgs = buildExpandMessages({ action: ACTION, evidence: EVIDENCE, request: REQUEST });
	const sys = msgs[0]!.content as string;
	assert.match(sys, /CLICKABLE CITATIONS/);
	assert.match(sys, /Markdown link the IDE recognises/);
	assert.match(sys, /path:.*#L\d+/, 'system prompt must show a path: URI with a line-fragment example');
	assert.match(sys, /NEVER mention an entity as plain text/,
		'system prompt must forbid plain-text entity mentions when a file is available');
});

test('buildExpandMessages: empty evidence array -> placeholder line', () => {
	const msgs = buildExpandMessages({
		action: ACTION,
		evidence: [],
		request: REQUEST,
	});
	const user = msgs[1]!.content as string;
	assert.match(user, /## Evidence \(0\)/);
	assert.match(user, /no evidence supplied/);
});

// ---------------------------------------------------------------------------
// expandAction end-to-end
// ---------------------------------------------------------------------------

test('expandAction: happy path -> returns clean markdown + tokenEstimate', async () => {
	const result = await expandAction(
		{ action: ACTION, evidence: EVIDENCE, request: REQUEST },
		fakeProvider('The HDFS module lives at `/repo/hadoop/hadoop-hdfs` (240 files).'),
	);
	assert.equal(result.actionId, 'modules-overview');
	assert.match(result.markdown, /HDFS module/);
	assert.equal(result.truncated, false);
	assert.equal(result.degraded, false);
	assert.ok(result.tokenEstimate > 0);
});

test('expandAction: stopReason "max_tokens" -> truncated:true', async () => {
	const result = await expandAction(
		{ action: ACTION, evidence: EVIDENCE, request: REQUEST },
		fakeProvider('truncated body...', 'max_tokens'),
	);
	assert.equal(result.truncated, true);
});

test('expandAction: stopReason "length" -> truncated:true', async () => {
	const result = await expandAction(
		{ action: ACTION, evidence: EVIDENCE, request: REQUEST },
		fakeProvider('truncated body...', 'length'),
	);
	assert.equal(result.truncated, true);
});

test('expandAction: provider throws -> degraded fallback markdown, no throw', async () => {
	const result = await expandAction(
		{ action: ACTION, evidence: EVIDENCE, request: REQUEST },
		fakeProviderThrowing('connection lost'),
	);
	assert.equal(result.degraded, true);
	assert.match(result.markdown, /could not draft/);
	assert.match(result.markdown, /Map the top-level/);
});

test('expandAction: maxBudgetTokens flows to CompletionOpts.maxTokens', async () => {
	const cap = captureMessagesProvider('body');
	const customAction = { ...ACTION, maxBudgetTokens: 800 };
	await expandAction(
		{ action: customAction, evidence: EVIDENCE, request: REQUEST },
		cap.provider,
	);
	assert.equal(cap.getOpts()?.maxTokens, 800);
});

test('expandAction: refineHint round-trips into the system prompt', async () => {
	const cap = captureMessagesProvider('body');
	await expandAction(
		{
			action: ACTION,
			evidence: EVIDENCE,
			request: REQUEST,
			refineHint: 'Add the cyclic-deps citation.',
		},
		cap.provider,
	);
	const captured = cap.getCaptured();
	const sys = captured.find(m => m.role === 'system');
	assert.ok(sys);
	assert.match(sys!.content as string, /cyclic-deps citation/);
});

test('expandAction: empty response -> degraded:true', async () => {
	const result = await expandAction(
		{ action: ACTION, evidence: EVIDENCE, request: REQUEST },
		fakeProvider(''),
	);
	assert.equal(result.degraded, true);
});
