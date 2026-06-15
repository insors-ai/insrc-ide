/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the §4.4 provider routing helper.
 *
 * Pinned:
 *   - explicit setting overrides the active provider in both directions.
 *   - `'auto'` + active anthropic -> claude-code (Mode A goal: same vendor).
 *   - `'auto'` + any non-anthropic provider -> codex.
 *   - `'auto'` + no active provider -> codex (default).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickAgent } from '../pick-agent.js';

test('pickAgent: explicit "claude-code" beats any active provider', () => {
	assert.equal(pickAgent('claude-code', 'openai'), 'claude-code');
	assert.equal(pickAgent('claude-code', 'anthropic'), 'claude-code');
	assert.equal(pickAgent('claude-code', 'gemini'), 'claude-code');
	assert.equal(pickAgent('claude-code', 'mistral'), 'claude-code');
	assert.equal(pickAgent('claude-code', null), 'claude-code');
});

test('pickAgent: explicit "codex" beats any active provider', () => {
	assert.equal(pickAgent('codex', 'openai'), 'codex');
	assert.equal(pickAgent('codex', 'anthropic'), 'codex');
	assert.equal(pickAgent('codex', 'gemini'), 'codex');
	assert.equal(pickAgent('codex', 'mistral'), 'codex');
	assert.equal(pickAgent('codex', null), 'codex');
});

test('pickAgent: "auto" + active anthropic -> claude-code', () => {
	assert.equal(pickAgent('auto', 'anthropic'), 'claude-code');
});

test('pickAgent: "auto" + active openai -> codex', () => {
	assert.equal(pickAgent('auto', 'openai'), 'codex');
});

test('pickAgent: "auto" + active gemini / mistral -> codex (codex handles non-Anthropic providers)', () => {
	assert.equal(pickAgent('auto', 'gemini'), 'codex');
	assert.equal(pickAgent('auto', 'mistral'), 'codex');
});

test('pickAgent: "auto" + no active provider -> codex (default)', () => {
	assert.equal(pickAgent('auto', null), 'codex');
});
