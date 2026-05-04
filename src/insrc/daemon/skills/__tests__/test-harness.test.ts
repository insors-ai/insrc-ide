/**
 * Tests for the skill smoke-test harness itself.
 *
 * Specifically: confirms that `runSkillIsolated`'s tool-call dispatch
 * validates the call's `input` against the registered tool's
 * `inputSchema` when a real tool definition is available. This is the
 * gate that catches "skill passes a field the tool's schema doesn't
 * accept" regressions like the 5f.2 drift.volume bug (skill threaded
 * `where` to a tool whose schema was `additionalProperties: false`,
 * smoke gate missed it because the harness used to relay all inputs
 * straight through to the fake handler).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerSkill } from '../registry.js';
import { registerTool } from '../../tools/registry.js';
import { runSkillIsolated, type FakeToolMap } from '../test-harness.js';
import type { Skill, SkillResult } from '../types.js';
import type { Tool } from '../../tools/types.js';

// A tool with a strict input schema -- only `connectionId` is allowed.
const STRICT_TOOL: Tool = {
	id: 'test_strict_tool',
	description: 'Test tool with additionalProperties: false',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['connectionId'],
		properties: {
			connectionId: { type: 'string' },
		},
	},
	requiresApproval: false,
	async execute() {
		return { output: 'should-not-run', format: 'text' as const, success: true };
	},
};

// A skill that intentionally passes a field the tool's schema rejects.
const BAD_SKILL: Skill<{ id: string }, { ran: boolean }> = {
	id: 'test.bad-input.smoke',
	name: 'Test: passes invalid input to a strict tool',
	description: 'Regression test for the harness input-schema validator.',
	family: 'source-introspection',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: { id: { type: 'string' } },
		required: ['id'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: { ran: { type: 'boolean' } },
		required: ['ran'],
		additionalProperties: false,
	},
	toolDeps: ['test_strict_tool'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['test_strict_tool'],
			reason: 'skill body calls it',
		},
	],
	async execute(input, deps): Promise<SkillResult<{ ran: boolean }>> {
		const tool = await deps.runTool({
			id: 'call-1',
			name: 'test_strict_tool',
			input: {
				connectionId: input.id,
				phantomField: 'should-be-rejected-by-schema-validator',
			},
		});
		return {
			value: { ran: !tool.isError },
			confidence: tool.isError ? 'low' : 'high',
			notes: tool.isError ? [tool.content] : [],
			toolCalls: [],
		};
	},
};

registerTool(STRICT_TOOL);
registerSkill(BAD_SKILL as unknown as Skill);

test('harness rejects schema-invalid tool input when the real tool is registered', async () => {
	const fakeTools: FakeToolMap = {
		test_strict_tool: { content: 'fake-output', isError: false },
	};
	const out = await runSkillIsolated('test.bad-input.smoke', { id: 'conn-1' }, { fakeTools });

	// The fake handler should NOT have run -- the harness should have
	// short-circuited with a schema-validation error before dispatch.
	// The skill catches the error (isError: true) and returns ran: false.
	assert.equal(out.result.value.ran, false, 'skill should observe isError from harness validation');
	assert.equal(out.result.confidence, 'low');
	const note = out.result.notes?.[0] ?? '';
	assert.match(
		note,
		/tool 'test_strict_tool' input schema rejected/,
		`expected schema-rejection note, got: ${note}`,
	);
	assert.match(note, /phantomField/, 'rejection message should name the offending field');
});
