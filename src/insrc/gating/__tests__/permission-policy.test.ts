/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	evaluatePermission,
	matchGlob,
	matchCommand,
	matchRule,
	type ToolRequest,
} from '../permission-policy.js';
import type { PermissionsBlock } from '../../handoff/types.js';

const EMPTY: PermissionsBlock = { allow: [], prompt: [], deny: [] };

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test('evaluatePermission: deny > prompt > allow', () => {
	const policy: PermissionsBlock = {
		allow:  [{ tool: 'Edit' }],
		prompt: [{ tool: 'Edit' }],
		deny:   [{ tool: 'Edit' }],
	};
	assert.equal(evaluatePermission(policy, { tool: 'Edit', input: {} }), 'deny');
});

test('evaluatePermission: prompt wins when no deny matches', () => {
	const policy: PermissionsBlock = {
		allow:  [{ tool: 'Edit' }],
		prompt: [{ tool: 'Edit' }],
		deny:   [{ tool: 'Bash' }],
	};
	assert.equal(evaluatePermission(policy, { tool: 'Edit', input: {} }), 'prompt');
});

test('evaluatePermission: allow when no deny or prompt matches', () => {
	const policy: PermissionsBlock = {
		allow:  [{ tool: 'Edit', paths: ['src/**'] }],
		prompt: [{ tool: 'Bash' }],
		deny:   [],
	};
	const req: ToolRequest = { tool: 'Edit', input: { file_path: 'src/foo.ts' } };
	assert.equal(evaluatePermission(policy, req), 'allow');
});

test('evaluatePermission: fail-safe default is prompt when no rule matches', () => {
	assert.equal(evaluatePermission(EMPTY, { tool: 'AnyTool', input: {} }), 'prompt');
});

// ---------------------------------------------------------------------------
// Tool matching
// ---------------------------------------------------------------------------

test("matchRule: '*' tool wildcard matches any tool", () => {
	assert.equal(matchRule({ tool: '*' }, { tool: 'AnyTool', input: {} }), true);
});

test('matchRule: case-sensitive tool match', () => {
	assert.equal(matchRule({ tool: 'Edit' }, { tool: 'edit', input: {} }), false);
	assert.equal(matchRule({ tool: 'Edit' }, { tool: 'Edit', input: {} }), true);
});

test('matchRule: rule without paths or commands matches on tool alone', () => {
	assert.equal(matchRule({ tool: 'Bash' }, { tool: 'Bash', input: { command: 'anything' } }), true);
});

// ---------------------------------------------------------------------------
// Path glob
// ---------------------------------------------------------------------------

test('matchGlob: literal path equality', () => {
	assert.equal(matchGlob('src/foo.ts', 'src/foo.ts'), true);
	assert.equal(matchGlob('src/foo.ts', 'src/bar.ts'), false);
});

test('matchGlob: single * does not cross /', () => {
	assert.equal(matchGlob('src/*.ts', 'src/foo.ts'),     true);
	assert.equal(matchGlob('src/*.ts', 'src/nested/x.ts'), false);
});

test('matchGlob: ** crosses /', () => {
	assert.equal(matchGlob('src/**/*.ts',  'src/nested/deep/foo.ts'), true);
	assert.equal(matchGlob('**/foo.ts',    'src/nested/foo.ts'),      true);
	assert.equal(matchGlob('**/foo.ts',    'foo.ts'),                 true);
	assert.equal(matchGlob('**/infra/**',  'src/infra/aws/main.tf'),  true);
});

test('matchGlob: ? matches a single non-slash char', () => {
	assert.equal(matchGlob('src/?.ts', 'src/a.ts'),  true);
	assert.equal(matchGlob('src/?.ts', 'src/ab.ts'), false);
	assert.equal(matchGlob('src/?.ts', 'src//.ts'),  false);
});

test('matchGlob: regex meta chars are escaped (e.g. dots, parens)', () => {
	assert.equal(matchGlob('foo.bar', 'foo.bar'), true);
	assert.equal(matchGlob('foo.bar', 'fooXbar'), false);
});

test('matchRule: paths match against file_path or path on the request input', () => {
	const rule = { tool: 'Edit', paths: ['src/**'] };
	assert.equal(matchRule(rule, { tool: 'Edit', input: { file_path: 'src/foo.ts' } }), true);
	assert.equal(matchRule(rule, { tool: 'Edit', input: { path:      'src/foo.ts' } }), true);
	assert.equal(matchRule(rule, { tool: 'Edit', input: { file_path: 'test/foo.ts' } }), false);
});

// ---------------------------------------------------------------------------
// Command match
// ---------------------------------------------------------------------------

test('matchCommand: plain substring', () => {
	assert.equal(matchCommand('git push', 'git push origin main'), true);
	assert.equal(matchCommand('git push', 'git pull'),             false);
});

test('matchCommand: glob with *', () => {
	assert.equal(matchCommand('git push *', 'git push origin'), true);
	assert.equal(matchCommand('git push *', 'git pull'),        false);
});

test('matchRule: commands matched only against Bash-style command field', () => {
	const rule = { tool: 'Bash', commands: ['git push'] };
	assert.equal(matchRule(rule, { tool: 'Bash', input: { command: 'git push origin main' } }), true);
	assert.equal(matchRule(rule, { tool: 'Bash', input: { command: 'npm test' } }),             false);
});

// ---------------------------------------------------------------------------
// Realistic mixed slate
// ---------------------------------------------------------------------------

test("evaluatePermission: mixed policy -- Edit src/** allowed, Bash 'git push' prompted, WebFetch denied", () => {
	const policy: PermissionsBlock = {
		allow:  [{ tool: 'Edit', paths: ['src/**', 'test/**'] }],
		prompt: [{ tool: 'Bash', commands: ['git push', 'npm publish'] }],
		deny:   [{ tool: 'WebFetch' }, { tool: 'Bash', commands: ['sudo'] }],
	};
	assert.equal(evaluatePermission(policy, { tool: 'Edit',     input: { file_path: 'src/foo.ts' } }),         'allow');
	assert.equal(evaluatePermission(policy, { tool: 'Edit',     input: { file_path: 'docs/x.md' } }),          'prompt');
	assert.equal(evaluatePermission(policy, { tool: 'Bash',     input: { command:   'git push origin main' } }), 'prompt');
	assert.equal(evaluatePermission(policy, { tool: 'Bash',     input: { command:   'npm test' } }),           'prompt');
	assert.equal(evaluatePermission(policy, { tool: 'Bash',     input: { command:   'sudo rm -rf /' } }),      'deny');
	assert.equal(evaluatePermission(policy, { tool: 'WebFetch', input: { url: 'https://x' } }),                'deny');
});

test("evaluatePermission: deny on a Bash 'sudo' rule wins even when the same tool has an allow rule for the same command", () => {
	const policy: PermissionsBlock = {
		allow:  [{ tool: 'Bash', commands: ['sudo restart'] }],
		prompt: [],
		deny:   [{ tool: 'Bash', commands: ['sudo'] }],
	};
	assert.equal(evaluatePermission(policy, { tool: 'Bash', input: { command: 'sudo restart' } }), 'deny');
});
