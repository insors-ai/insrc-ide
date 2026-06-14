/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 4 Day 2 cross-agent contract.
 *
 * Same spec fixture, same scripted-deliverable behaviour, two
 * different spawn paths (claude-code, codex) -- runHandoff produces
 * the same AuditResult and the same RunHandoffResult shape. Pins
 * agent-agnostic guarantees so future agent additions (or
 * agent-specific drift) can't silently diverge.
 *
 * Real `claude` / `codex` CLIs aren't required: each test points
 * `claudeBinPath` / `codexBinPath` at a tiny shell script that
 * echoes the provided deliverable to stdout. This is the same
 * pattern Phase 2a Day 5 used for the scripted-agent flow.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHandoff } from '../index.js';
import type { MemoryRef, ScopePayload } from '../types.js';

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'insrc-cross-agent-'));
	const run = (args: string[]) => {
		const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	};
	run(['init', '-q']);
	run(['config', 'user.email', 'x@example.com']);
	run(['config', 'user.name',  'Cross Agent Test']);
	run(['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(dir, 'a.txt'), 'initial\n');
	run(['add', '.']);
	run(['commit', '-q', '-m', 'init']);
	return dir;
}

function writeStub(dir: string, name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, `#!/usr/bin/env bash\n${body}`);
	chmodSync(file, 0o755);
	return file;
}

function makeScope(repoPath: string): ScopePayload {
	return { repoId: repoPath, repoPath, inScopeGlobs: ['**'], outOfScopePaths: [], riskHints: 'low' };
}
const MEM: MemoryRef[] = [];

const FILLED = [
	'## Reproduce', 'a', '## Localize', 'b', '## Hypothesize', 'c', '## Test', 'd', '## Conclude', 'e',
].join('\n');

const PARTIAL = ['## Reproduce', 'real', '## Conclude', 'real'].join('\n');

/**
 * Run runHandoff once per agent with the same scripted deliverable;
 * return the AuditResult.verdict for each so the caller can assert
 * they agree.
 */
async function runBothAgents(deliverable: string): Promise<{ claude: string; codex: string }> {
	const repo = initRepo();
	const root = mkdtempSync(join(tmpdir(), 'insrc-cross-agent-root-'));
	const stubDir = mkdtempSync(join(tmpdir(), 'insrc-cross-agent-stubs-'));
	const deliverableEscaped = deliverable.replace(/'/g, "'\"'\"'");
	const stubBody = `printf '%s' '${deliverableEscaped}'\n`;

	try {
		const claudeBin = writeStub(stubDir, 'claude.sh', stubBody);
		const codexBin  = writeStub(stubDir, 'codex.sh',  stubBody);

		const claudeRes = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repo),
			memoryRefs:    MEM,
			agent:         'claude-code',
			sessionId:     'cross-claude',
			persistRoot:   root,
			specIdOverride: 'spec-cross-c',
			claudeBinPath: claudeBin,
		});

		const codexRes = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repo),
			memoryRefs:    MEM,
			agent:         'codex',
			sessionId:     'cross-codex',
			persistRoot:   root,
			specIdOverride: 'spec-cross-x',
			codexBinPath:  codexBin,
		});

		return { claude: claudeRes.audit.verdict, codex: codexRes.audit.verdict };
	} finally {
		rmSync(repo,    { recursive: true, force: true });
		rmSync(root,    { recursive: true, force: true });
		rmSync(stubDir, { recursive: true, force: true });
	}
}

test('cross-agent: filled deliverable -> both agents reach verdict accept', async () => {
	const out = await runBothAgents(FILLED);
	assert.equal(out.claude, 'accept');
	assert.equal(out.codex,  'accept');
});

test('cross-agent: partial deliverable (missing sections) -> both agents reach verdict revise-major', async () => {
	const out = await runBothAgents(PARTIAL);
	assert.equal(out.claude, 'revise-major');
	assert.equal(out.codex,  'revise-major');
});

// ---------------------------------------------------------------------------
// Hook config writers are per-agent BUT both consume the same hook binary
// ---------------------------------------------------------------------------

test('cross-agent: hookBinPath set for both agents -> each writes its own per-agent hook config', async () => {
	const repo    = initRepo();
	const root    = mkdtempSync(join(tmpdir(), 'insrc-cross-agent-hook-'));
	const stubDir = mkdtempSync(join(tmpdir(), 'insrc-cross-agent-hookstubs-'));
	const stubBody = `printf '%s' '${FILLED.replace(/'/g, "'\"'\"'")}'\n`;
	const fakeHook = '/abs/path/insrc-permission-hook.js';

	try {
		const claudeBin = writeStub(stubDir, 'claude.sh', stubBody);
		const codexBin  = writeStub(stubDir, 'codex.sh',  stubBody);

		const c = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repo),
			memoryRefs:    MEM,
			agent:         'claude-code',
			sessionId:     'hook-claude',
			persistRoot:   root,
			specIdOverride: 'spec-hook-c',
			claudeBinPath: claudeBin,
			hookBinPath:   fakeHook,
		});

		const x = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repo),
			memoryRefs:    MEM,
			agent:         'codex',
			sessionId:     'hook-codex',
			persistRoot:   root,
			specIdOverride: 'spec-hook-x',
			codexBinPath:  codexBin,
			hookBinPath:   fakeHook,
		});

		// Claude writes .claude/settings.json into its worktree.
		const claudeHooks = join(c.worktreePath, '.claude', 'settings.json');
		// Codex writes .codex/hooks.json into its worktree.
		const codexHooks  = join(x.worktreePath, '.codex',  'hooks.json');
		const { existsSync, readFileSync } = await import('node:fs');
		assert.equal(existsSync(claudeHooks), true);
		assert.equal(existsSync(codexHooks),  true);

		// Both reference the same hook binary.
		const claudeBlock = JSON.parse(readFileSync(claudeHooks, 'utf8')) as { hooks: { PreToolUse: { command: string }[] } };
		const codexBlock  = JSON.parse(readFileSync(codexHooks,  'utf8')) as { event: string; command: string }[];
		assert.equal(claudeBlock.hooks.PreToolUse[0]!.command, fakeHook);
		for (const e of codexBlock) assert.equal(e.command, fakeHook);
	} finally {
		rmSync(repo,    { recursive: true, force: true });
		rmSync(root,    { recursive: true, force: true });
		rmSync(stubDir, { recursive: true, force: true });
	}
});
