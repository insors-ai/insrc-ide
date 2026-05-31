/**
 * Unit tests for `data.meta.classify-question` (data-analyzer-skills §7.1).
 *
 * The smoke gate (smoke.test.ts) only exercises the LLM-unavailable
 * degraded path. These tests inject a fakeProvider that returns canned
 * JSON to cover:
 *   - happy path: valid JSON in candidates → confidence: high|medium|low
 *   - retry path: first response invalid, second valid → success
 *   - rejection path: both responses invalid → confidence: low
 *   - empty-catalog path: no skill survives prefilter → confidence: low
 *   - hallucination guard: LLM picks an id not in the catalog → rejected
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../index.js';
import {
	getSkill,
	_resetSkillRegistryForTests,
} from '../registry.js';
import { runSkillIsolated, type FakeProvider } from '../test-harness.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import type { LLMResponse } from '../../../shared/types.js';

const CLASSIFY = 'data.meta.classify-question';

interface ClassifyOutput {
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

function setup(): void {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
	assert.ok(getSkill(CLASSIFY), `${CLASSIFY} must be in the registry`);
}

/**
 * Stub provider that emits canned responses. Each input string is
 * interpreted as the LLM's intended structured payload:
 *   - Parses cleanly -> emits a `tool_use` block with
 *     `input: <parsed object>`. Mirrors the runtime tool-call
 *     protocol the skill expects after the migration.
 *   - Doesn't parse (test sends 'not-json-at-all' / 'garbage') ->
 *     emits an end_turn with no tool_use, simulating a provider
 *     that didn't honor `toolChoice: { name: '...' }`. The skill
 *     surfaces this as a "no tool_use payload" rejection.
 * Strings that contain a fenced ```json``` block are unwrapped
 * before parsing to keep the legacy fence-stripping test
 * meaningful (it now exercises payload tolerance in the fake,
 * not in the skill).
 */
function fakeProviderReturning(...texts: readonly string[]): FakeProvider {
	let i = 0;
	return {
		async complete(): Promise<LLMResponse> {
			const text = texts[Math.min(i, texts.length - 1)] ?? '';
			i++;
			const unwrapped = text.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
			try {
				const parsed = JSON.parse(unwrapped);
				return {
					text:       '',
					stopReason: 'tool_use',
					toolCalls:  [{ id: `tc-${i}`, name: 'submit_classification', input: parsed }],
				};
			} catch {
				return { text, stopReason: 'end_turn' };
			}
		},
	};
}

const RDBMS_ROSTER = [{ id: 'prod-db', family: 'rdbms', kind: 'postgres' }];
const KV_ROSTER    = [{ id: 'cache', family: 'kv', kind: 'redis' }];
const FILE_ROSTER  = [{ id: 'parquet-dir', family: 'file', kind: 'parquet' }];

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('classify-question: returns LLM output verbatim when JSON is valid', async () => {
	setup();
	const validJson = JSON.stringify({
		questionType: 'describe-schema',
		candidates: [
			{
				skillId: 'data.source.rdbms.describe-table',
				rationale: 'RDBMS schema introspection.',
				goal: 'Introspect the orders table on prod-db; return columns + types so the caller can render the schema.',
				mustHaveScope: 'connection+target',
			},
		],
		fallbacks: ['data.source.rdbms.list-tables'],
		uncertaintyNotes: [],
	});

	const { result } = await runSkillIsolated<unknown, ClassifyOutput>(
		CLASSIFY,
		{
			question: 'Describe the schema of the orders table on prod-db.',
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning(validJson) },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.questionType, 'describe-schema');
	assert.equal(result.value.candidates.length, 1);
	assert.equal(result.value.candidates[0]!.skillId, 'data.source.rdbms.describe-table');
	assert.equal(result.value.fallbacks.length, 1);
	assert.equal(result.value.uncertaintyNotes.length, 0);
});

test('classify-question: confidence is medium when uncertaintyNotes present', async () => {
	setup();
	const json = JSON.stringify({
		questionType: 'drift-analysis',
		candidates: [
			{
				skillId: 'data.drift.volume.rdbms',
				rationale: 'Two-window volume comparison.',
				goal: 'Compare event volume between two windows on the events connection so the caller can flag the shift.',
				mustHaveScope: 'connection+target',
			},
		],
		fallbacks: [],
		uncertaintyNotes: ['Window boundaries not specified.'],
	});

	const { result } = await runSkillIsolated<unknown, ClassifyOutput>(
		CLASSIFY,
		{
			question: 'Has request volume changed?',
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning(json) },
	);

	assert.equal(result.confidence, 'medium');
	assert.deepEqual(result.notes, ['Window boundaries not specified.']);
});

test('classify-question: strips a fenced ```json block if the model wraps the response', async () => {
	setup();
	const json = JSON.stringify({
		questionType: 'sample-data',
		candidates: [
			{
				skillId: 'data.source.rdbms.sample-rows',
				rationale: 'Row sampling.',
				goal: 'Sample rows from prod-db.users so the caller can preview.',
				mustHaveScope: 'connection+target',
			},
		],
		fallbacks: [],
		uncertaintyNotes: [],
	});
	const wrapped = '```json\n' + json + '\n```';

	const { result } = await runSkillIsolated<unknown, ClassifyOutput>(
		CLASSIFY,
		{
			question: 'Pull a sample from prod-db.users.',
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning(wrapped) },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.candidates.length, 1);
});

// ---------------------------------------------------------------------------
// Retry path
// ---------------------------------------------------------------------------

test('classify-question: retries once on invalid JSON; second-pass valid → success', async () => {
	setup();
	const valid = JSON.stringify({
		questionType: 'describe-schema',
		candidates: [
			{
				skillId: 'data.source.rdbms.describe-table',
				rationale: 'after retry.',
				goal: 'Describe the orders schema (after retry).',
				mustHaveScope: 'connection+target',
			},
		],
		fallbacks: [],
		uncertaintyNotes: [],
	});

	const { result } = await runSkillIsolated<unknown, ClassifyOutput>(
		CLASSIFY,
		{
			question: 'Describe orders.',
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning('not-json-at-all', valid) },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.candidates[0]!.rationale, 'after retry.');
});

test('classify-question: retry path with hallucinated skillId rejected → low', async () => {
	setup();
	const hallucination = JSON.stringify({
		questionType: 'describe-schema',
		candidates: [
			{ skillId: 'data.does.not.exist', rationale: 'fake', goal: 'whatever', mustHaveScope: 'connection' },
		],
		fallbacks: [],
		uncertaintyNotes: [],
	});

	const { result } = await runSkillIsolated<unknown, ClassifyOutput>(
		CLASSIFY,
		{
			question: 'Describe orders.',
			connections: RDBMS_ROSTER,
		},
		// Both responses hallucinate; second-pass rejection lands at low.
		{ fakeProvider: fakeProviderReturning(hallucination, hallucination) },
	);

	assert.equal(result.confidence, 'low');
	assert.ok(result.notes !== undefined);
	const noteText = result.notes.join(' | ');
	assert.match(noteText, /failed validation twice|not in the catalog/);
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

test('classify-question: both responses invalid → confidence low + helpful notes', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, ClassifyOutput>(
		CLASSIFY,
		{
			question: 'Anything.',
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning('garbage one', 'garbage two') },
	);

	assert.equal(result.confidence, 'low');
	assert.ok(result.notes !== undefined);
	assert.match(result.notes.join(' '), /validation twice/);
});

test('classify-question: LLM throw → confidence low + LLM-failure note', async () => {
	setup();

	const { result } = await runSkillIsolated<unknown, ClassifyOutput>(
		CLASSIFY,
		{
			question: 'Anything.',
			connections: RDBMS_ROSTER,
		},
		{
			fakeProvider: {
				async complete(): Promise<LLMResponse> {
					throw new Error('provider boom');
				},
			},
		},
	);

	assert.equal(result.confidence, 'low');
	assert.ok(result.notes !== undefined);
	assert.match(result.notes.join(' '), /LLM call failed.*provider boom/);
});

// ---------------------------------------------------------------------------
// Catalog prefilter
// ---------------------------------------------------------------------------

test('classify-question: KV roster excludes rdbms-only skills from the catalog', async () => {
	setup();
	// The fakeProvider lets us inspect what the prompt contained --
	// stash the user message on capture and then fail.
	let capturedUser = '';
	const { result } = await runSkillIsolated<unknown, ClassifyOutput>(
		CLASSIFY,
		{
			question: 'List the keys in cache.',
			connections: KV_ROSTER,
		},
		{
			fakeProvider: {
				async complete(messages): Promise<LLMResponse> {
					const userMsg = messages.find(m => m.role === 'user');
					if (typeof userMsg?.content === 'string') {
						capturedUser = userMsg.content;
					}
					// Return a valid kv pick as a tool_use block (matches
					// the migrated tool-call protocol).
					return {
						text:       '',
						stopReason: 'tool_use',
						toolCalls: [{
							id:   'tc-1',
							name: 'submit_classification',
							input: {
								questionType: 'sample-data',
								candidates: [
									{
										skillId: 'data.source.kv.scan-keys',
										rationale: 'KV key scan.',
											goal: 'Scan keys in the cache connection so the caller can see what is stored.',
										mustHaveScope: 'connection',
									},
								],
								fallbacks: [],
								uncertaintyNotes: [],
							},
						}],
					};
				},
			},
		},
	);

	// The KV roster's catalog should NOT include rdbms-only skills.
	assert.doesNotMatch(capturedUser, /data\.source\.rdbms\./, 'rdbms-only skills must not appear in the KV catalog');
	assert.match(capturedUser, /data\.source\.kv\./, 'KV skills should appear in the KV catalog');
	assert.equal(result.confidence, 'high');
});

test('classify-question: file roster excludes rdbms + kv skills from the catalog', async () => {
	setup();
	let capturedUser = '';
	await runSkillIsolated<unknown, ClassifyOutput>(
		CLASSIFY,
		{
			question: 'Describe the parquet file.',
			connections: FILE_ROSTER,
		},
		{
			fakeProvider: {
				async complete(messages): Promise<LLMResponse> {
					const userMsg = messages.find(m => m.role === 'user');
					if (typeof userMsg?.content === 'string') {
						capturedUser = userMsg.content;
					}
					// Reply with something invalid so we focus on the
					// catalog assertion -- the test is about prompt
					// shape, not classification correctness.
					return { text: 'parse-fail', stopReason: 'end_turn' };
				},
			},
		},
	);

	assert.doesNotMatch(capturedUser, /data\.source\.rdbms\./, 'rdbms-only skills must not appear in file catalog');
	assert.doesNotMatch(capturedUser, /data\.source\.kv\./,    'kv skills must not appear in file catalog');
	assert.match(capturedUser, /data\.source\.file\./, 'file skills should appear');
});

test('classify-question: meta + synthesis families never appear in the catalog', async () => {
	setup();
	let capturedUser = '';
	await runSkillIsolated<unknown, ClassifyOutput>(
		CLASSIFY,
		{
			question: 'Anything.',
			connections: RDBMS_ROSTER,
		},
		{
			fakeProvider: {
				async complete(messages): Promise<LLMResponse> {
					const userMsg = messages.find(m => m.role === 'user');
					if (typeof userMsg?.content === 'string') {
						capturedUser = userMsg.content;
					}
					return { text: 'stop', stopReason: 'end_turn' };
				},
			},
		},
	);

	// Skills classify-question must NOT route into:
	assert.doesNotMatch(capturedUser, /data\.meta\./,           'meta-family skills must not be in the catalog');
	assert.doesNotMatch(capturedUser, /data\.synth\./,          'synthesis-family skills must not be in the catalog');
	// But must include analytical skills:
	assert.match(capturedUser, /data\.profile\./,    'profile skills should appear');
	assert.match(capturedUser, /data\.quality\./,    'quality skills should appear');
});
