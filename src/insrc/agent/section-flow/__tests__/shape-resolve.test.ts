/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the per-leaf shape resolver (the 2-step executor's first
 * stage). Covers:
 *
 *   - Happy path: scripted provider emits a tool_use call satisfying
 *     the skill schema; resolver returns { kind:'ok' } first try.
 *   - Unknown skill: returns kind:'failed' without an LLM call.
 *   - Empty toolCalls -> retry path; second attempt succeeds ->
 *     { kind:'ok', retried:true }.
 *   - Missing required arg on first try -> retry with corrective hint;
 *     second attempt satisfies required -> ok+retried.
 *   - Both attempts miss required -> kind:'failed' with reason.
 *   - Prompt structure: user message carries the leaf objective +
 *     skill id + available prior outputs + session context block.
 *   - Tool definition forwarded to the provider: name + skill input
 *     schema verbatim.
 *   - Call opts: temperature 0, disableThinking true, toolChoice
 *     forcing the submit_skill_args tool.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	resolveSkillShape,
	_buildMessagesForTest      as buildMessages,
	_checkRequiredForTest      as checkRequired,
	_formatPriorOutputsForTest as formatPriorOutputs,
	SUBMIT_ARGS_TOOL_NAME      as SUBMIT_ARGS_TOOL,
} from '../shape-resolve.js';
import { registerSkill, _resetSkillRegistryForTests } from '../../../daemon/skills/registry.js';
import type { Skill } from '../../../daemon/skills/types.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse, ToolCall } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface ScriptedCall {
	readonly messages: LLMMessage[];
	readonly opts:     CompletionOpts;
}

interface ScriptedResponse {
	readonly toolCallInput?: Record<string, unknown> | undefined;
	readonly noToolCalls?:   boolean | undefined;
}

function scriptedProvider(responses: readonly ScriptedResponse[]): { provider: LLMProvider; calls: ScriptedCall[] } {
	const calls: ScriptedCall[] = [];
	let cursor = 0;
	const provider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out of responses at call ${cursor + 1}`);
			}
			const r = responses[cursor]!;
			cursor++;
			if (r.noToolCalls === true) {
				return { text: '', stopReason: 'end_turn' };
			}
			const toolCalls: ToolCall[] = [{
				id: `tc-${cursor}`,
				name: SUBMIT_ARGS_TOOL,
				input: r.toolCallInput ?? {},
			}];
			return { text: '', stopReason: 'tool_use', toolCalls };
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls };
}

const SAMPLE_SKILL_ID = 'test.sample-skill';

function registerTestSkill(): void {
	_resetSkillRegistryForTests();
	const skill: Skill = {
		id:          SAMPLE_SKILL_ID,
		version:     1,
		description: 'A test skill that takes a target + columns.',
		family:      'meta',
		owner:       'data-analyzer',
		toolDeps:    [],
		skillDeps:   [],
		inputs: {
			type: 'object',
			properties: {
				target:  { type: 'string' },
				columns: { type: 'array', items: { type: 'string' } },
			},
			required: ['target', 'columns'],
		},
		outputs: {
			type: 'object',
			properties: { rows: { type: 'number' } },
		},
		async execute(): Promise<{ value: unknown }> { return { value: {} }; },
	} as unknown as Skill;
	registerSkill(skill);
}

function baseInput(provider: LLMProvider): Parameters<typeof resolveSkillShape>[0] {
	return {
		skillId:      SAMPLE_SKILL_ID,
		objective:    'List the columns of the orders table.',
		priorOutputs: { 'discover-tables': '{"tables":["orders","customers"]}' },
		userQuestion: 'What columns does the orders table have?',
		contextBag:   { primaryConnection: 'pg-primary' },
		provider,
	};
}

// ---------------------------------------------------------------------------
// Tests -- happy path
// ---------------------------------------------------------------------------

test('resolveSkillShape: happy path -- one tool_use call satisfying schema -> ok no retry', async () => {
	registerTestSkill();
	const { provider, calls } = scriptedProvider([{
		toolCallInput: { target: 'orders', columns: ['id', 'total', 'created_at'] },
	}]);
	const result = await resolveSkillShape(baseInput(provider));
	assert.equal(result.kind, 'ok');
	if (result.kind === 'ok') {
		assert.deepEqual(result.args, { target: 'orders', columns: ['id', 'total', 'created_at'] });
		assert.equal(result.retried, false);
	}
	assert.equal(calls.length, 1);
});

test('resolveSkillShape: empty toolCalls -> retry path; second succeeds -> ok+retried', async () => {
	registerTestSkill();
	const { provider, calls } = scriptedProvider([
		{ noToolCalls: true },
		{ toolCallInput: { target: 'orders', columns: ['id'] } },
	]);
	const result = await resolveSkillShape(baseInput(provider));
	assert.equal(result.kind, 'ok');
	if (result.kind === 'ok') {
		assert.equal(result.retried, true);
		assert.deepEqual(result.args, { target: 'orders', columns: ['id'] });
	}
	assert.equal(calls.length, 2);
	// Retry message carries the corrective hint.
	const retryUserMsg = calls[1]!.messages.at(-1)!;
	assert.equal(retryUserMsg.role, 'user');
	assert.match(retryUserMsg.content as string, /RETRY CORRECTION/);
});

test('resolveSkillShape: missing required arg -> retry with explicit missing list', async () => {
	registerTestSkill();
	const { provider, calls } = scriptedProvider([
		{ toolCallInput: { target: 'orders' } },                              // missing columns
		{ toolCallInput: { target: 'orders', columns: ['id', 'total'] } },     // fixed
	]);
	const result = await resolveSkillShape(baseInput(provider));
	assert.equal(result.kind, 'ok');
	if (result.kind === 'ok') {
		assert.equal(result.retried, true);
	}
	assert.equal(calls.length, 2);
	// Retry hint names the missing arg verbatim.
	const retryUserMsg = calls[1]!.messages.at(-1)!.content as string;
	assert.match(retryUserMsg, /Missing required args/);
	assert.match(retryUserMsg, /columns/);
});

test('resolveSkillShape: both attempts miss required -> kind:failed with reason', async () => {
	registerTestSkill();
	const { provider } = scriptedProvider([
		{ toolCallInput: { target: 'orders' } },                  // missing columns
		{ toolCallInput: { target: 'orders' } },                  // still missing columns
	]);
	const result = await resolveSkillShape(baseInput(provider));
	assert.equal(result.kind, 'failed');
	if (result.kind === 'failed') {
		assert.match(result.reason, /still missing required/);
		assert.match(result.reason, /columns/);
		assert.equal(result.retried, true);
	}
});

test('resolveSkillShape: unknown skill -> kind:failed without an LLM call', async () => {
	registerTestSkill();
	const { provider, calls } = scriptedProvider([]);
	const result = await resolveSkillShape({
		...baseInput(provider),
		skillId: 'not.a.real.skill',
	});
	assert.equal(result.kind, 'failed');
	if (result.kind === 'failed') {
		assert.match(result.reason, /unknown skill id/);
	}
	assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Tests -- prompt + tool definition
// ---------------------------------------------------------------------------

test('resolveSkillShape: user prompt carries leaf objective + skill id + prior outputs + context', async () => {
	registerTestSkill();
	const { provider, calls } = scriptedProvider([{
		toolCallInput: { target: 'orders', columns: ['id'] },
	}]);
	await resolveSkillShape(baseInput(provider));
	const userMsg = calls[0]!.messages[1]!.content as string;
	assert.match(userMsg, /## USER QUESTION/);
	assert.match(userMsg, /What columns does the orders table have\?/);
	assert.match(userMsg, /## LEAF OBJECTIVE/);
	assert.match(userMsg, /List the columns of the orders table/);
	assert.match(userMsg, new RegExp(`SKILL TO INVOKE: \`${SAMPLE_SKILL_ID}\``));
	assert.match(userMsg, /## AVAILABLE PRIOR OUTPUTS/);
	assert.match(userMsg, /discover-tables/);
	assert.match(userMsg, /orders/);
	assert.match(userMsg, /## SESSION CONTEXT/);
	assert.match(userMsg, /primaryConnection: pg-primary/);
});

test('resolveSkillShape: tool definition forwarded to provider with skill input schema verbatim', async () => {
	registerTestSkill();
	const { provider, calls } = scriptedProvider([{
		toolCallInput: { target: 'orders', columns: ['id'] },
	}]);
	await resolveSkillShape(baseInput(provider));
	const tools = calls[0]!.opts.tools ?? [];
	assert.equal(tools.length, 1);
	assert.equal(tools[0]!.name, SUBMIT_ARGS_TOOL);
	assert.match(tools[0]!.description, new RegExp(SAMPLE_SKILL_ID));
	const schema = tools[0]!.inputSchema as Record<string, unknown>;
	assert.equal(schema['type'], 'object');
	assert.deepEqual(schema['required'], ['target', 'columns']);
});

test('resolveSkillShape: call opts -- temperature 0, disableThinking true, toolChoice forces submit_skill_args', async () => {
	registerTestSkill();
	const { provider, calls } = scriptedProvider([{
		toolCallInput: { target: 'orders', columns: ['id'] },
	}]);
	await resolveSkillShape(baseInput(provider));
	assert.equal(calls[0]!.opts.temperature, 0);
	assert.equal(calls[0]!.opts.disableThinking, true);
	assert.deepEqual(calls[0]!.opts.toolChoice, { name: SUBMIT_ARGS_TOOL });
});

// ---------------------------------------------------------------------------
// Unit-level helper coverage
// ---------------------------------------------------------------------------

test('checkRequired: returns missing keys', () => {
	const schema = { type: 'object', required: ['a', 'b', 'c'] };
	assert.deepEqual(checkRequired({ a: 1, c: 3 }, schema), ['b']);
	assert.deepEqual(checkRequired({ a: 1, b: 2, c: 3 }, schema), []);
	assert.deepEqual(checkRequired({}, schema), ['a', 'b', 'c']);
});

test('checkRequired: schema without required -> empty', () => {
	assert.deepEqual(checkRequired({}, { type: 'object' }), []);
	assert.deepEqual(checkRequired({}, {}), []);
});

test('formatPriorOutputs: empty -> placeholder message', () => {
	assert.match(formatPriorOutputs({}), /no prior outputs/);
});

test('formatPriorOutputs: long output -> truncated with marker', () => {
	const long = 'x'.repeat(2000);
	const formatted = formatPriorOutputs({ 'big': long });
	assert.match(formatted, /truncated/);
	assert.ok(formatted.length < 2200);
});

test('buildMessages: system message exists + user message carries the structured sections', () => {
	registerTestSkill();
	const input = baseInput(scriptedProvider([]).provider);
	const messages = buildMessages(input, 'desc');
	assert.equal(messages.length, 2);
	assert.equal(messages[0]!.role, 'system');
	assert.match(messages[0]!.content as string, /SHAPE RESOLVER/);
	assert.equal(messages[1]!.role, 'user');
	const user = messages[1]!.content as string;
	assert.match(user, /## TASK/);
	assert.match(user, /submit_skill_args/);
});
