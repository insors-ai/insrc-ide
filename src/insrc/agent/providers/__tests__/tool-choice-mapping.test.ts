/**
 * Cross-provider `toolChoice` mapping tests (Plan 2 Phase 1a).
 *
 * Pins each provider's adapter against its native API shape so the
 * substrate's specific-tool forcing semantics work uniformly. If a
 * provider's wire format changes, this test catches the drift before
 * a consumer's failure-recovery path silently breaks.
 *
 * Each provider gets a focused matrix:
 *   - 'auto' | 'required' | 'none' | { name } when tools present
 *   - undefined when no toolChoice supplied
 *   - undefined when tools absent (no provider accepts toolChoice
 *     without tools)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _toAnthropicToolChoiceForTest as toAnthropic } from '../anthropic.js';
import { _toOpenAIToolChoiceForTest    as toOpenAI }    from '../openai.js';
import { _toMistralToolChoiceForTest   as toMistral }   from '../mistral.js';
import { _toGeminiToolConfigForTest    as toGemini }    from '../gemini.js';
import { _toOllamaToolChoiceForTest    as toOllama }    from '../ollama.js';

// Synthetic tools list -- shape doesn't matter, only length.
const TOOLS = [{ type: 'function' }];

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

test('anthropic: auto -> { type: "auto" }', () => {
	assert.deepEqual(toAnthropic('auto', TOOLS as any), { type: 'auto' });
});
test('anthropic: required -> { type: "any" }', () => {
	assert.deepEqual(toAnthropic('required', TOOLS as any), { type: 'any' });
});
test('anthropic: none -> { type: "none" }', () => {
	assert.deepEqual(toAnthropic('none', TOOLS as any), { type: 'none' });
});
test('anthropic: { name } -> { type: "tool", name }', () => {
	assert.deepEqual(
		toAnthropic({ name: 'submit_plan' }, TOOLS as any),
		{ type: 'tool', name: 'submit_plan' },
	);
});
test('anthropic: undefined -> undefined', () => {
	assert.equal(toAnthropic(undefined, TOOLS as any), undefined);
});
test('anthropic: tools empty -> undefined (no toolChoice without tools)', () => {
	assert.equal(toAnthropic('required', []), undefined);
	assert.equal(toAnthropic('required', undefined), undefined);
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

test('openai: auto -> "auto" (bare string)', () => {
	assert.equal(toOpenAI('auto', TOOLS), 'auto');
});
test('openai: required -> "required"', () => {
	assert.equal(toOpenAI('required', TOOLS), 'required');
});
test('openai: none -> "none"', () => {
	assert.equal(toOpenAI('none', TOOLS), 'none');
});
test('openai: { name } -> { type: "function", function: { name } }', () => {
	assert.deepEqual(
		toOpenAI({ name: 'submit_plan' }, TOOLS),
		{ type: 'function', function: { name: 'submit_plan' } },
	);
});
test('openai: undefined -> undefined', () => {
	assert.equal(toOpenAI(undefined, TOOLS), undefined);
});
test('openai: tools empty -> undefined', () => {
	assert.equal(toOpenAI('required', []), undefined);
	assert.equal(toOpenAI('required', undefined), undefined);
});

// ---------------------------------------------------------------------------
// Mistral (same wire shape as OpenAI)
// ---------------------------------------------------------------------------

test('mistral: matches OpenAI shape for all forms', () => {
	assert.equal(toMistral('auto',     TOOLS), 'auto');
	assert.equal(toMistral('required', TOOLS), 'required');
	assert.equal(toMistral('none',     TOOLS), 'none');
	assert.deepEqual(
		toMistral({ name: 'submit_plan' }, TOOLS),
		{ type: 'function', function: { name: 'submit_plan' } },
	);
	assert.equal(toMistral(undefined,  TOOLS), undefined);
	assert.equal(toMistral('required', []),    undefined);
});

// ---------------------------------------------------------------------------
// Gemini (different shape -- functionCallingConfig.mode)
// ---------------------------------------------------------------------------

test('gemini: auto -> functionCallingConfig.mode = AUTO', () => {
	assert.deepEqual(
		toGemini('auto', TOOLS),
		{ functionCallingConfig: { mode: 'AUTO' } },
	);
});
test('gemini: required -> functionCallingConfig.mode = ANY', () => {
	assert.deepEqual(
		toGemini('required', TOOLS),
		{ functionCallingConfig: { mode: 'ANY' } },
	);
});
test('gemini: none -> functionCallingConfig.mode = NONE', () => {
	assert.deepEqual(
		toGemini('none', TOOLS),
		{ functionCallingConfig: { mode: 'NONE' } },
	);
});
test('gemini: { name } -> mode ANY + allowedFunctionNames', () => {
	assert.deepEqual(
		toGemini({ name: 'submit_plan' }, TOOLS),
		{ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['submit_plan'] } },
	);
});
test('gemini: undefined / no tools -> undefined', () => {
	assert.equal(toGemini(undefined,  TOOLS), undefined);
	assert.equal(toGemini('required', []),    undefined);
	assert.equal(toGemini('required', undefined), undefined);
});

// ---------------------------------------------------------------------------
// Ollama (OpenAI-shape pass-through; per-model compliance best-effort)
// ---------------------------------------------------------------------------

test('ollama: bare-string forms pass through (OpenAI shape)', () => {
	assert.equal(toOllama('auto',     TOOLS), 'auto');
	assert.equal(toOllama('required', TOOLS), 'required');
	assert.equal(toOllama('none',     TOOLS), 'none');
});
test('ollama: { name } -> { type: "function", function: { name } }', () => {
	assert.deepEqual(
		toOllama({ name: 'submit_plan' }, TOOLS),
		{ type: 'function', function: { name: 'submit_plan' } },
	);
});
test('ollama: undefined / no tools -> undefined', () => {
	assert.equal(toOllama(undefined,  TOOLS), undefined);
	assert.equal(toOllama('required', []),    undefined);
});

// ---------------------------------------------------------------------------
// Cross-provider consistency check
// ---------------------------------------------------------------------------

test('cross-provider: { name } produces a non-undefined mapping in EVERY provider', () => {
	// Substrate's specific-tool forcing must work uniformly. If any
	// provider returns undefined for { name }, that breaks the
	// substrate's failure-recovery semantics for that provider.
	const choice = { name: 'submit_plan' };
	assert.notEqual(toAnthropic(choice, TOOLS as any), undefined);
	assert.notEqual(toOpenAI(choice,    TOOLS),         undefined);
	assert.notEqual(toMistral(choice,   TOOLS),         undefined);
	assert.notEqual(toGemini(choice,    TOOLS),         undefined);
	assert.notEqual(toOllama(choice,    TOOLS),         undefined);
});

test('cross-provider: every provider refuses toolChoice when tools list is empty', () => {
	// All providers reject `tool_choice` without `tools` server-side;
	// our adapters drop the field client-side to avoid a wasted error.
	assert.equal(toAnthropic('required', []), undefined);
	assert.equal(toOpenAI('required',    []), undefined);
	assert.equal(toMistral('required',   []), undefined);
	assert.equal(toGemini('required',    []), undefined);
	assert.equal(toOllama('required',    []), undefined);
});
