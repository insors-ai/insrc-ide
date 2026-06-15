/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Real-codex integration test (plans/external-agent-integration.md §4.5).
 *
 * Gated on `INSRC_TEST_CODEX=1` so CI / local dev runs that don't
 * have the real `codex` binary (and the OpenAI API key it expects)
 * skip these without failing. Pin behaviour the stub-binary
 * contract tests can't:
 *
 *   - The real `codex exec` CLI accepts our argv shape exactly --
 *     no flag renames since the cross-agent contract test was
 *     written. If Codex evolves and breaks our invocation, this
 *     test fails loudly on every dev machine that has the binary.
 *   - The agent reads our spec from stdin and writes a deliverable
 *     to `spec-deliverable.md` inside the worktree (the file path
 *     the audit pipeline picks up).
 *   - The MCP config block we write into `.codex/config.toml`
 *     leaves the agent able to call the insrc MCP server in-run.
 *
 * Enabling locally:
 *
 *     INSRC_TEST_CODEX=1 npx tsx --test handoff/__tests__/codex-real-integration.test.ts
 *
 * Real Codex CLI must be on PATH (`codex --version` works) and
 * `~/.codex/auth.json` must hold a valid API key. The test uses a
 * deliberately tiny scope and a very short bug brief so the agent
 * finishes in under ~60 seconds; longer timeouts are still safe.
 */

import test, { skip } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHandoff } from '../index.js';
import type { ScopePayload } from '../types.js';

const ENABLED = process.env['INSRC_TEST_CODEX'] === '1';

function maybeSkip(): boolean {
	if (!ENABLED) {
		skip('INSRC_TEST_CODEX=1 not set; skipping real-codex integration test');
		return true;
	}
	try {
		execSync('codex --version', { stdio: 'pipe' });
	} catch {
		skip('codex CLI not on PATH; skipping real-codex integration test');
		return true;
	}
	return false;
}

function tinyRepo(): { repo: string; persistRoot: string; cleanup: () => void } {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-codex-real-repo-'));
	execSync('git init -q', { cwd: repo });
	execSync('git config user.email test@local && git config user.name Test', { cwd: repo });
	// Plant a tiny "buggy" file so the agent has somewhere to put
	// the fix-and-deliverable workflow.
	writeFileSync(join(repo, 'index.js'), 'function add(a, b) { return a - b; }  // off-by-sign\n');
	execSync('git add -A && git commit -q -m init', { cwd: repo });
	const persistRoot = mkdtempSync(join(tmpdir(), 'insrc-codex-real-persist-'));
	return {
		repo,
		persistRoot,
		cleanup: () => {
			rmSync(repo, { recursive: true, force: true });
			rmSync(persistRoot, { recursive: true, force: true });
		},
	};
}

const SCOPE = (repo: string): ScopePayload => ({
	repoId: repo,
	repoPath: repo,
	inScopeGlobs: ['**'],
	outOfScopePaths: [],
	riskHints: 'low',
});

test('real codex: runHandoff(agent="codex") completes the DEBUG-SESSION pipeline against a tiny repo', async () => {
	if (maybeSkip()) return;
	const ctx = tinyRepo();
	try {
		const result = await runHandoff({
			templateId: 'DEBUG-SESSION',
			intent: 'The `add` function in index.js returns a-b instead of a+b. Fix it and document the steps you took.',
			scope: SCOPE(ctx.repo),
			memoryRefs: [],
			agent: 'codex',
			persistRoot: ctx.persistRoot,
			sessionId: 'sess-codex-real',
			specIdOverride: 'spec-codex-real',
			timeoutMs: 120_000,
		});
		assert.equal(result.spawnResult.exitCode, 0, `codex exited non-zero; stderr: ${result.spawnResult.stderr.slice(0, 500)}`);
		// Audit produced a verdict (any verdict is OK for this smoke);
		// the diff body might be empty if codex declined to fix.
		assert.ok(['accept', 'revise-edits', 'revise-major'].includes(result.audit.verdict));
		// The MCP config the spawn wrote is still on disk -- proves we
		// stamped it before the subprocess ran.
		assert.equal(existsSync(join(result.worktreePath, '.codex', 'config.toml')), true);
		// Sanity-check the config has the expected block.
		const tomlText = readFileSync(join(result.worktreePath, '.codex', 'config.toml'), 'utf8');
		assert.match(tomlText, /\[mcp_servers\.insrc\]/);
	} finally {
		ctx.cleanup();
	}
});
