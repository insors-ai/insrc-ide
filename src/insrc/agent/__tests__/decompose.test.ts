/**
 * Phase 5 tests for `decompose` -- the decomposer's prompt and
 * parser behaviour.
 *
 * The plan
 * (plans/intent-classification-consolidation.md, Phase 5) narrows
 * decompose.ts to STRUCTURE only. These tests pin the prompt
 * changes so a future edit can't quietly bring back the
 * trigger-bug rule ("Informational questions are research").
 *
 * Capture-provider pattern: a fake LLMProvider records the system
 * prompt the decomposer sent + returns a canned JSON response so
 * the parser's behaviour stays covered too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decompose } from '../decompose.js';
import type { LLMProvider, LLMMessage, LLMResponse } from '../../shared/types.js';

function captureProvider(canned: string, capture: { messages?: LLMMessage[] }): LLMProvider {
	return {
		async complete(messages: LLMMessage[]): Promise<LLMResponse> {
			capture.messages = messages.map(m => ({ ...m }));
			return { text: canned, stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: false,
	};
}

// ---------------------------------------------------------------------------
// Prompt assertions (Phase 5 -- the trigger-bug rules MUST stay out)
// ---------------------------------------------------------------------------

test('decompose prompt: "Informational questions ... are research" rule is GONE', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	await decompose('hello', captureProvider(canonicalJson(), cap));
	const sys = (cap.messages![0]!.content as string);
	assert.ok(
		!/Informational questions/i.test(sys),
		'decomposer system prompt must not bias informational questions toward research',
	);
});

test('decompose prompt: biased "Greetings/conversational: research" rule is GONE', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	await decompose('hello', captureProvider(canonicalJson(), cap));
	const sys = cap.messages![0]!.content as string;
	assert.ok(
		!/Greetings\/conversational/i.test(sys),
		'decomposer must not steer greetings toward a research intent',
	);
});

test('decompose prompt: biased "find NodeJS OCR libs"->research example is GONE', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	await decompose('hello', captureProvider(canonicalJson(), cap));
	const sys = cap.messages![0]!.content as string;
	assert.ok(
		!/NodeJS\s+(?:libs|OCR)/i.test(sys),
		'the NodeJS OCR example (which used research) must be gone',
	);
	// And the broader anti-pattern: NO example whose intent demonstrates
	// research being applied to an in-repo question.
	assert.ok(
		!/primary:\s*research\s+"analyze/i.test(sys),
		'no example must demonstrate research being chosen for in-repo analysis',
	);
});

test('decompose prompt: "Available intents" list is GONE (LLM no longer reasons about taxonomy)', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	await decompose('hello', captureProvider(canonicalJson(), cap));
	const sys = cap.messages![0]!.content as string;
	assert.ok(
		!/Available intents:/i.test(sys),
		'the LLM no longer needs an intent taxonomy in the prompt -- resolveIntent owns it',
	);
});

// ---------------------------------------------------------------------------
// Prompt assertions (positive -- the tiebreaker + structural mandate IS there)
// ---------------------------------------------------------------------------

test('decompose prompt: explicitly STRUCTURAL (resolveIntent overrules)', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	await decompose('hello', captureProvider(canonicalJson(), cap));
	const sys = cap.messages![0]!.content as string;
	assert.match(sys, /STRUCTURAL job/i);
	assert.match(sys, /resolveIntent/i);
	assert.match(sys, /advisory only/i);
});

test('decompose prompt: carries the classifier-aligned research vs code-analysis tiebreaker', async () => {
	const cap: { messages?: LLMMessage[] } = {};
	await decompose('hello', captureProvider(canonicalJson(), cap));
	const sys = cap.messages![0]!.content as string;
	// Same intent the classifier uses (see agent/classify/intent.ts).
	assert.match(sys, /research.*EXTERNAL/i);
	assert.match(sys, /code-analysis.*DEFAULT/i);
	assert.match(sys, /is the answer inside this repo\?/i);
});

// ---------------------------------------------------------------------------
// Parser still works for the structural shape Phase 6 will rely on
// ---------------------------------------------------------------------------

test('decompose: parses primary + attached + relation correctly', async () => {
	const json = JSON.stringify({
		primary: {
			intent: 'design', action: 'design the API', subject: 'auth API',
			confidence: 0.9,
		},
		attached: [
			{
				intent: 'implement', action: 'implement the API',
				relation: 'depends', reason: 'needs design first', confidence: 0.85,
			},
		],
	});
	const r = await decompose('design the API then implement it', captureProvider(json, {}));
	assert.equal(r.usedLLM, true);
	assert.ok(r.prompt !== undefined);
	assert.equal(r.prompt!.primary.action, 'design the API');
	assert.equal(r.prompt!.attached.length, 1);
	assert.equal(r.prompt!.attached[0]!.relation, 'depends');
});

test('decompose: file ref extraction still works', async () => {
	const json = JSON.stringify({
		primary: {
			intent: 'implement', action: 'implement X based on Y', subject: 'X',
			refs: [{ path: 'docs/spec.md', purpose: 'requirements-source' }],
			confidence: 0.9,
		},
		attached: [],
	});
	const r = await decompose('implement X based on @docs/spec.md', captureProvider(json, {}));
	assert.ok(r.prompt !== undefined);
	assert.deepEqual(r.prompt!.primary.refs, [
		{ path: 'docs/spec.md', purpose: 'requirements-source' },
	]);
});

test('decompose: commandHint preserved for infra-style primaries', async () => {
	const json = JSON.stringify({
		primary: {
			intent: 'infra', action: 'check pods', commandHint: 'kubectl get pods',
			confidence: 0.95,
		},
		attached: [
			{ intent: 'document', action: 'format as markdown', relation: 'format', reason: 'output directive', confidence: 0.9 },
		],
	});
	const r = await decompose('check pods and format as markdown', captureProvider(json, {}));
	assert.ok(r.prompt !== undefined);
	assert.equal(r.prompt!.primary.commandHint, 'kubectl get pods');
	assert.equal(r.prompt!.attached[0]!.relation, 'format');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalJson(): string {
	return JSON.stringify({
		primary: { intent: 'code-analysis', action: 'hello', confidence: 0.5 },
		attached: [],
	});
}
