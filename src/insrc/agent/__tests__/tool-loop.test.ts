/**
 * tool-loop substrate tests (Plan 2 Phase 1b).
 *
 * Uses a fake LLMProvider whose `complete` returns canned
 * `LLMResponse`s in sequence. Tests cover:
 *   - All four ToolLoopResult kinds (terminated / no-tools /
 *     exhausted / provider-error)
 *   - Each failure-mode handler in both 'retry' and 'terminate'
 *     modes
 *   - Termination protocol (clean / schema-violation)
 *   - Serial-only dispatch (multi-tool batch -> retry)
 *   - Degenerate-repeat detection
 *   - Turn-cap exhaustion
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runToolLoop, type ToolLoopPolicy, type TerminationTool } from '../tool-loop.js';
import type {
	LLMProvider,
	LLMMessage,
	LLMResponse,
	CompletionOpts,
	ToolCall,
	ToolDefinition,
	ToolResult,
} from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeProvider(script: readonly LLMResponse[]): {
	provider: LLMProvider;
	calls:    { messages: readonly LLMMessage[]; opts: CompletionOpts | undefined }[];
} {
	const calls: { messages: readonly LLMMessage[]; opts: CompletionOpts | undefined }[] = [];
	let idx = 0;
	const provider: LLMProvider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse> {
			calls.push({ messages: [...messages], opts });
			const r = script[idx++];
			if (r === undefined) {
				throw new Error(`fake provider out of canned responses (idx=${idx - 1})`);
			}
			return r;
		},
		async *stream() { return; },
		async embed() { return []; },
	};
	return { provider, calls };
}

function toolUse(name: string, input: Record<string, unknown>, id = 'tc1'): ToolCall {
	return { id, name, input };
}

function resp(opts: { text?: string; toolCalls?: ToolCall[] }): LLMResponse {
	const toolCalls = opts.toolCalls;
	return {
		text:       opts.text ?? '',
		stopReason: (toolCalls && toolCalls.length > 0) ? 'tool_use' : 'end_turn',
		...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
	};
}

const TOOL_FOO: ToolDefinition = { name: 'foo', description: 'foo tool', inputSchema: { type: 'object' } };
const TOOL_BAR: ToolDefinition = { name: 'bar', description: 'bar tool', inputSchema: { type: 'object' } };

function okDispatch(_call: ToolCall): Promise<ToolResult> {
	return Promise.resolve({ toolCallId: _call.id, content: 'ok', isError: false });
}
function errDispatch(msg: string) {
	return (_call: ToolCall): Promise<ToolResult> =>
		Promise.resolve({ toolCallId: _call.id, content: msg, isError: true });
}
function throwingDispatch(msg: string) {
	return (_call: ToolCall): Promise<ToolResult> => Promise.reject(new Error(msg));
}

function basePolicy<T>(over: Partial<ToolLoopPolicy<T>> = {}): ToolLoopPolicy<T> {
	return {
		maxTurns:   3,
		toolChoice: 'auto',
		...over,
	} as ToolLoopPolicy<T>;
}

const SEED: readonly LLMMessage[] = [
	{ role: 'system', content: 'you are a test bot' },
	{ role: 'user',   content: 'do the thing' },
];

// ---------------------------------------------------------------------------
// 1. ToolLoopResult.kind = 'no-tools'
// ---------------------------------------------------------------------------

test('no-tools: toolChoice=auto + model emits text -> kind=no-tools', async () => {
	const { provider } = fakeProvider([resp({ text: 'just text answer' })]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy({ toolChoice: 'auto' }),
	});
	assert.equal(out.kind, 'no-tools');
	if (out.kind === 'no-tools') {
		assert.equal(out.finalText, 'just text answer');
		assert.equal(out.turnCount, 1);
	}
});

// ---------------------------------------------------------------------------
// 2. ToolLoopResult.kind = 'terminated'
// ---------------------------------------------------------------------------

test('terminated: terminationTool fires + validates + returns payload', async () => {
	const submit: TerminationTool<{ value: number }> = {
		name:        'submit_plan',
		description: 'submit',
		inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
		validate(input): { value: number } | string {
			const v = (input as Record<string, unknown>)['value'];
			if (typeof v !== 'number') return 'value must be number';
			return { value: v };
		},
	};
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('foo', {}, 't1')] }),
		resp({ toolCalls: [toolUse('submit_plan', { value: 42 }, 't2')] }),
	]);
	const out = await runToolLoop<{ value: number }>({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy<{ value: number }>({ terminationTool: submit, toolChoice: 'auto' }),
	});
	assert.equal(out.kind, 'terminated');
	if (out.kind === 'terminated') {
		assert.deepEqual(out.payload, { value: 42 });
		assert.equal(out.turnCount, 2);
	}
});

test('terminated: schema-violation on first attempt -> retry-with-correction -> success', async () => {
	const submit: TerminationTool<{ value: number }> = {
		name:        'submit_plan',
		description: 'submit',
		inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
		validate(input): { value: number } | string {
			const v = (input as Record<string, unknown>)['value'];
			if (typeof v !== 'number') return 'value must be number';
			return { value: v };
		},
	};
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('submit_plan', { value: 'not-a-number' }, 't1')] }),
		resp({ toolCalls: [toolUse('submit_plan', { value: 7 }, 't2')] }),
	]);
	const out = await runToolLoop<{ value: number }>({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy<{ value: number }>({
			terminationTool:    submit,
			toolChoice:         'auto',
			onSchemaViolation:  'retry-with-correction',
		}),
	});
	assert.equal(out.kind, 'terminated');
});

test('terminated: schema-violation + onSchemaViolation=terminate -> exhausted', async () => {
	const submit: TerminationTool<{ value: number }> = {
		name:        'submit_plan',
		description: 'submit',
		inputSchema: { type: 'object' },
		validate: () => 'always fails',
	};
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('submit_plan', {}, 't1')] }),
	]);
	const out = await runToolLoop<{ value: number }>({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy<{ value: number }>({
			terminationTool:    submit,
			toolChoice:         'auto',
			onSchemaViolation:  'terminate',
		}),
	});
	assert.equal(out.kind, 'exhausted');
	if (out.kind === 'exhausted') {
		assert.match(out.reason, /schema-violation-terminated/);
	}
});

// ---------------------------------------------------------------------------
// 3. ToolLoopResult.kind = 'exhausted' (multiple paths)
// ---------------------------------------------------------------------------

test('exhausted: turn-cap reached without termination', async () => {
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('foo', { a: 1 })] }),
		resp({ toolCalls: [toolUse('foo', { a: 2 })] }),
		resp({ toolCalls: [toolUse('foo', { a: 3 })] }),
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy({ maxTurns: 3, toolChoice: 'auto' }),
	});
	assert.equal(out.kind, 'exhausted');
	if (out.kind === 'exhausted') {
		assert.equal(out.reason, 'turn-cap');
		assert.equal(out.turnCount, 3);
	}
});

test('exhausted: empty-tool-calls under toolChoice=required + onEmptyToolCalls=terminate', async () => {
	const { provider } = fakeProvider([resp({ text: 'I refuse' })]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy({
			toolChoice:        'required',
			onEmptyToolCalls:  'terminate',
		}),
	});
	assert.equal(out.kind, 'exhausted');
	if (out.kind === 'exhausted') {
		assert.match(out.reason, /empty-tool-calls-terminated/);
	}
});

test('exhausted: empty-tool-calls retry-with-correction recovers next turn', async () => {
	// Turn 1: empty (under required) -> corrective + continue.
	// Turn 2: tool dispatched.
	// Turn 3: tool again (script ends here -> turn-cap exhausts).
	const { provider, calls } = fakeProvider([
		resp({ text: 'no tools this time' }),
		resp({ toolCalls: [toolUse('foo', { a: 1 })] }),
		resp({ toolCalls: [toolUse('foo', { a: 2 })] }),
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy({ toolChoice: 'required', maxTurns: 3 }),
	});
	// Verify the corrective fired -- turn 2's prompt contains the
	// "no tool_use block" message.
	const secondTurn = calls[1]!.messages;
	const last = secondTurn[secondTurn.length - 1]!;
	const content = typeof last.content === 'string' ? last.content : '';
	assert.match(content, /no tool_use block/);
	// Loop hits turn-cap after 3 cloud calls.
	assert.equal(out.kind, 'exhausted');
	if (out.kind === 'exhausted') {
		assert.equal(out.reason, 'turn-cap');
	}
});

test('exhausted: degenerate-repeat (same tool + same args twice) -> exit', async () => {
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('foo', { a: 1 })] }),
		resp({ toolCalls: [toolUse('foo', { a: 1 })] }),   // same call
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy({ maxTurns: 5, toolChoice: 'auto' }),
	});
	assert.equal(out.kind, 'exhausted');
	if (out.kind === 'exhausted') {
		assert.match(out.reason, /degenerate-repeat: foo/);
	}
});

test('exhausted: degenerate-repeat disabled -> loop continues', async () => {
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('foo', { a: 1 })] }),
		resp({ toolCalls: [toolUse('foo', { a: 1 })] }),
		resp({ toolCalls: [toolUse('foo', { a: 1 })] }),
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy({ maxTurns: 3, toolChoice: 'auto', stopOnDegenerateRepeat: false }),
	});
	assert.equal(out.kind, 'exhausted');
	if (out.kind === 'exhausted') {
		assert.equal(out.reason, 'turn-cap');   // not degenerate-repeat
	}
});

// ---------------------------------------------------------------------------
// 4. ToolLoopResult.kind = 'provider-error'
// ---------------------------------------------------------------------------

test('provider-error: provider.complete throws -> bubbles up', async () => {
	const provider: LLMProvider = {
		supportsTools: true,
		async complete() { throw new Error('boom'); },
		async *stream() { return; },
		async embed() { return []; },
	};
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy(),
	});
	assert.equal(out.kind, 'provider-error');
	if (out.kind === 'provider-error') {
		assert.equal(out.err.message, 'boom');
		assert.equal(out.turnCount, 0);
	}
});

// ---------------------------------------------------------------------------
// Failure modes -- targeted
// ---------------------------------------------------------------------------

test('multi-tool-batch (serial-only enforcement) -> reject + retry corrective', async () => {
	const { provider, calls } = fakeProvider([
		resp({ toolCalls: [toolUse('foo', {}, 'a'), toolUse('bar', {}, 'b')] }),
		resp({ toolCalls: [toolUse('foo', {})] }),
		resp({ text: 'done' }),
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO, TOOL_BAR],
		dispatchTool: okDispatch,
		policy:   basePolicy({ maxTurns: 5, toolChoice: 'auto' }),
	});
	// Corrective fired on turn 1; turn 2 succeeds.
	const secondTurn = calls[1]!.messages;
	const last = secondTurn[secondTurn.length - 1]!;
	const content = typeof last.content === 'string' ? last.content : '';
	assert.match(content, /substrate dispatches one tool per turn/);
	// Final outcome depends on turn 3's response (text -> no-tools).
	assert.equal(out.kind, 'no-tools');
});

test('unknown-tool: feed-error-back -> continue with corrective tool_result', async () => {
	const { provider, calls } = fakeProvider([
		resp({ toolCalls: [toolUse('not.a.real.tool', {})] }),
		resp({ toolCalls: [toolUse('foo', {})] }),
		resp({ text: 'done' }),
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy({ maxTurns: 5, toolChoice: 'auto' }),
	});
	// Verify a tool_result was pushed with isError + corrective text.
	const turn2 = calls[1]!.messages;
	const lastBlock = turn2[turn2.length - 1]!;
	if (Array.isArray(lastBlock.content)) {
		const trBlock = lastBlock.content.find(b => b.type === 'tool_result');
		assert.ok(trBlock);
		if (trBlock && trBlock.type === 'tool_result') {
			assert.match(trBlock.content as string, /not in the catalog/);
		}
	}
	assert.equal(out.kind, 'no-tools');
});

test('unknown-tool: terminate -> exhausted', async () => {
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('not.real', {})] }),
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy({ onUnknownTool: 'terminate', toolChoice: 'auto' }),
	});
	assert.equal(out.kind, 'exhausted');
	if (out.kind === 'exhausted') {
		assert.match(out.reason, /unknown-tool: not\.real/);
	}
});

test('dispatch-error: thrown error -> feed-error-back path', async () => {
	const { provider, calls } = fakeProvider([
		resp({ toolCalls: [toolUse('foo', {})] }),
		resp({ text: 'recovered' }),
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: throwingDispatch('something broke'),
		policy:   basePolicy({ toolChoice: 'auto' }),
	});
	// Should reach turn 2 with a tool_result + isError in transcript.
	assert.ok(calls.length >= 2);
	assert.equal(out.kind, 'no-tools');
});

test('dispatch-error: terminate path -> exhausted', async () => {
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('foo', {})] }),
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: throwingDispatch('boom'),
		policy:   basePolicy({ onDispatchError: 'terminate', toolChoice: 'auto' }),
	});
	assert.equal(out.kind, 'exhausted');
	if (out.kind === 'exhausted') {
		assert.match(out.reason, /dispatch-error: boom/);
	}
});

test('tool isError=true result -> still gets fed back; loop continues', async () => {
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('foo', {})] }),
		resp({ text: 'kept going' }),
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: errDispatch('skill rejected'),
		policy:   basePolicy({ toolChoice: 'auto' }),
	});
	assert.equal(out.kind, 'no-tools');
});

// ---------------------------------------------------------------------------
// Wiring details -- transcript shape, provider opts
// ---------------------------------------------------------------------------

test('provider receives the termination pseudo-tool in its tools list', async () => {
	const submit: TerminationTool<{ x: number }> = {
		name:        'submit_plan',
		description: 'submit',
		inputSchema: { type: 'object' },
		validate: () => ({ x: 1 }),
	};
	const { provider, calls } = fakeProvider([
		resp({ toolCalls: [toolUse('submit_plan', {})] }),
	]);
	await runToolLoop<{ x: number }>({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy<{ x: number }>({ terminationTool: submit }),
	});
	const optTools = calls[0]!.opts?.tools ?? [];
	assert.equal(optTools.length, 2);
	assert.ok(optTools.some(t => t.name === 'submit_plan'));
	assert.ok(optTools.some(t => t.name === 'foo'));
});

test('toolChoice forwarded to provider verbatim', async () => {
	const { provider, calls } = fakeProvider([resp({ text: 'ok' })]);
	await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy({ toolChoice: { name: 'foo' } }),
	});
	assert.deepEqual(calls[0]!.opts?.toolChoice, { name: 'foo' });
});

test('transcript grows: assistant turn + tool_result appended for each cycle', async () => {
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('foo', {}, 'a1')] }),
		resp({ text: 'ok' }),
	]);
	const out = await runToolLoop({
		provider,
		messages: SEED,
		tools:    [TOOL_FOO],
		dispatchTool: okDispatch,
		policy:   basePolicy({ toolChoice: 'auto' }),
	});
	// Seed: 2 messages. After turn 1: +1 assistant +1 tool_result. After turn 2: +1 assistant.
	// = 2 + 2 + 1 = 5 messages in final transcript.
	assert.equal(out.transcript.length, 5);
	const assistantTurns = out.transcript.filter(m => m.role === 'assistant');
	assert.equal(assistantTurns.length, 2);
});
