/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * runHandoff end-to-end test.
 *
 * Stands up a real tmp git repo (one commit), wires runHandoff with
 * the scripted-agent so we don't need a real `claude` CLI, and
 * asserts the full round-trip: spec assembled + persisted, worktree
 * created off HEAD, scripted agent's stdout audited against
 * DEBUG-SESSION's required sections, diff computed.
 *
 * Three verdicts get exercised end-to-end (accept / revise-edits /
 * revise-major) so the routing path the CLI will take in Day 5 is
 * pinned at the orchestrator boundary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHandoff, type ScriptedAgentFn } from '../index.js';
import type { MemoryRef, ScopePayload } from '../types.js';

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'insrc-handoff-e2e-'));
	const run = (args: string[]) => {
		const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	};
	run(['init', '-q']);
	run(['config', 'user.email', 'e2e@example.com']);
	run(['config', 'user.name',  'E2E Test']);
	run(['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(dir, 'a.txt'), 'initial\n');
	run(['add', '.']);
	run(['commit', '-q', '-m', 'init']);
	return dir;
}

function makeScope(repoPath: string): ScopePayload {
	return {
		repoId:          repoPath,
		repoPath,
		inScopeGlobs:    ['**/*.txt'],
		outOfScopePaths: [],
		riskHints:       'low',
	};
}

const MEM: MemoryRef[] = [];

const FILLED_DELIVERABLE = [
	'# Debug Session Deliverable',
	'',
	'## Reproduce',
	'reproduced the issue',
	'## Localize',
	'narrowed to a.txt',
	'## Hypothesize',
	"a.txt's last line needs newline normalisation",
	'## Test',
	'tested the fix',
	'## Conclude',
	'applied the fix and validated',
].join('\n');

const MISSING_TWO_SECTIONS = [
	'# Debug Session Deliverable',
	'',
	'## Reproduce',
	'reproduced',
	'## Conclude',
	'concluded',
].join('\n');

const PLACEHOLDER_SECTION = [
	'## Reproduce', '<TODO>',
	'## Localize', 'narrowed',
	'## Hypothesize', 'hypothesised',
	'## Test', 'tested',
	'## Conclude', 'concluded',
].join('\n');

function scripted(stdout: string): ScriptedAgentFn {
	return async () => ({ stdout, stderr: '', exitCode: 0, durationMs: 10 });
}

function withRepo(fn: (repoPath: string, persistRoot: string) => Promise<void>): Promise<void> {
	const repoPath    = initRepo();
	const persistRoot = mkdtempSync(join(tmpdir(), 'insrc-handoff-e2e-root-'));
	return fn(repoPath, persistRoot).finally(() => {
		rmSync(repoPath,    { recursive: true, force: true });
		rmSync(persistRoot, { recursive: true, force: true });
	});
}

// ---------------------------------------------------------------------------
// Happy path -- accept
// ---------------------------------------------------------------------------

test('runHandoff: filled deliverable + no failing criteria -> verdict accept; spec persisted; worktree created', async () => {
	await withRepo(async (repoPath, persistRoot) => {
		const result = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix the flake',
			scope:         makeScope(repoPath),
			memoryRefs:    MEM,
			agent:         'scripted-agent',
			scriptedAgent: scripted(FILLED_DELIVERABLE),
			persistRoot,
			sessionId:     'sess-accept',
			specIdOverride: 'spec-accept-1',
		});

		// 1. Spec assembled + persisted
		assert.equal(result.spec.specId, 'spec-accept-1');
		const specPath = join(persistRoot, 'sess-accept', 'spec-accept-1.md');
		const metaPath = join(persistRoot, 'sess-accept', 'spec-accept-1.meta.json');
		assert.equal(existsSync(specPath), true);
		assert.equal(existsSync(metaPath), true);
		assert.equal(readFileSync(specPath, 'utf8'), result.spec.specMd);

		// 2. Worktree created
		assert.equal(existsSync(result.worktreePath), true);
		assert.equal(readFileSync(join(result.worktreePath, 'a.txt'), 'utf8'), 'initial\n');

		// 3. Verdict accept
		assert.equal(result.audit.verdict, 'accept');
		assert.equal(result.audit.parse.allRequiredFilled, true);

		// 4. Clean diff (worktree unchanged because scripted agent didn't edit)
		assert.equal(result.diff, '');
	});
});

test('runHandoff: scripted agent modifies the worktree -> diff captures the change', async () => {
	await withRepo(async (repoPath, persistRoot) => {
		const sessionId = 'sess-mutate';
		const worktreePath = join(persistRoot, sessionId, 'worktree');

		// Scripted agent that ALSO writes a file into the worktree as a
		// side effect. Mimics what a real claude --print would do via
		// the Edit tool.
		const scriptedThatMutates: ScriptedAgentFn = async () => {
			appendFileSync(join(worktreePath, 'a.txt'), 'fix line\n');
			return { stdout: FILLED_DELIVERABLE, stderr: '', exitCode: 0, durationMs: 10 };
		};

		const result = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repoPath),
			memoryRefs:    MEM,
			agent:         'scripted-agent',
			scriptedAgent: scriptedThatMutates,
			persistRoot,
			sessionId,
			specIdOverride: 'spec-mut-1',
		});

		assert.equal(result.audit.verdict, 'accept');
		assert.match(result.diff, /^diff --git a\/a\.txt b\/a\.txt/m);
		assert.match(result.diff, /\+fix line/);
	});
});

// ---------------------------------------------------------------------------
// revise-edits
// ---------------------------------------------------------------------------

test('runHandoff: placeholder section in deliverable -> verdict revise-edits with fill hint', async () => {
	await withRepo(async (repoPath, persistRoot) => {
		const result = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repoPath),
			memoryRefs:    MEM,
			agent:         'scripted-agent',
			scriptedAgent: scripted(PLACEHOLDER_SECTION),
			persistRoot,
			sessionId:     'sess-edits',
			specIdOverride: 'spec-edits-1',
		});
		assert.equal(result.audit.verdict, 'revise-edits');
		assert.match(result.audit.reason, /Reproduce/);
		assert.equal(result.audit.editHints.length, 1);
		assert.match(result.audit.editHints[0]!, /Fill the empty '## Reproduce'/);
	});
});

// ---------------------------------------------------------------------------
// revise-major
// ---------------------------------------------------------------------------

test('runHandoff: required sections missing -> verdict revise-major; "Add the missing" hints land first', async () => {
	await withRepo(async (repoPath, persistRoot) => {
		const result = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repoPath),
			memoryRefs:    MEM,
			agent:         'scripted-agent',
			scriptedAgent: scripted(MISSING_TWO_SECTIONS),
			persistRoot,
			sessionId:     'sess-major',
			specIdOverride: 'spec-major-1',
		});
		assert.equal(result.audit.verdict, 'revise-major');
		assert.match(result.audit.reason, /'## Localize'/);
		assert.match(result.audit.reason, /'## Hypothesize'/);
		assert.match(result.audit.reason, /'## Test'/);
		// "Add the missing" hints prepend the editHints list.
		assert.match(result.audit.editHints[0]!, /^Add the missing '## /);
	});
});

// ---------------------------------------------------------------------------
// Cleanup contract
// ---------------------------------------------------------------------------

test('runHandoff: forceCleanup=true -> worktree removed after the call returns', async () => {
	await withRepo(async (repoPath, persistRoot) => {
		const result = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repoPath),
			memoryRefs:    MEM,
			agent:         'scripted-agent',
			scriptedAgent: scripted(FILLED_DELIVERABLE),
			persistRoot,
			sessionId:     'sess-cleanup',
			specIdOverride: 'spec-cleanup-1',
			forceCleanup:  true,
		});
		assert.equal(existsSync(result.worktreePath), false);
	});
});

// ---------------------------------------------------------------------------
// agent='scripted-agent' contract
// ---------------------------------------------------------------------------

test('runHandoff: scripted-agent without scriptedAgent fn throws', async () => {
	await withRepo(async (repoPath, persistRoot) => {
		await assert.rejects(
			() => runHandoff({
				templateId: 'DEBUG-SESSION',
				intent:     'fix',
				scope:      makeScope(repoPath),
				memoryRefs: MEM,
				agent:      'scripted-agent',
				// scriptedAgent: undefined
				persistRoot,
				sessionId:  'sess-bad',
			}),
			/requires scriptedAgent/,
		);
	});
});

// ---------------------------------------------------------------------------
// Deliverable sink precedence: file > stdout
// ---------------------------------------------------------------------------

test('runHandoff: <worktree>/spec-deliverable.md takes precedence over stdout (real-agent simulation)', async () => {
	await withRepo(async (repoPath, persistRoot) => {
		const sessionId    = 'sess-file-wins';
		const worktreePath = join(persistRoot, sessionId, 'worktree');

		// Scripted agent that returns USELESS stdout but writes the
		// real deliverable to the worktree (mimicking what claude-code
		// actually does -- the spec template tells the agent to write
		// to spec-deliverable.md).
		const scriptedSplit: ScriptedAgentFn = async () => {
			writeFileSync(join(worktreePath, 'spec-deliverable.md'), FILLED_DELIVERABLE);
			return { stdout: 'BOGUS STDOUT WITHOUT SECTIONS', stderr: '', exitCode: 0, durationMs: 10 };
		};

		const result = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repoPath),
			memoryRefs:    MEM,
			agent:         'scripted-agent',
			scriptedAgent: scriptedSplit,
			persistRoot,
			sessionId,
			specIdOverride: 'spec-file-1',
		});
		// File wins -> the 5 sections in the file drive the audit to accept.
		assert.equal(result.audit.verdict, 'accept',
			`expected accept (file deliverable found); got ${result.audit.verdict} reason=${result.audit.reason}`);
	});
});

test('runHandoff: persists <specId>.deliverable.md + <specId>.audit.json after the run', async () => {
	await withRepo(async (repoPath, persistRoot) => {
		const result = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repoPath),
			memoryRefs:    MEM,
			agent:         'scripted-agent',
			scriptedAgent: scripted(FILLED_DELIVERABLE),
			persistRoot,
			sessionId:     'sess-persist',
			specIdOverride: 'spec-persist-1',
		});

		const dir       = join(persistRoot, 'sess-persist');
		const delivPath = join(dir, 'spec-persist-1.deliverable.md');
		const auditPath = join(dir, 'spec-persist-1.audit.json');
		assert.equal(existsSync(delivPath), true, 'deliverable.md must be persisted');
		assert.equal(existsSync(auditPath), true, 'audit.json must be persisted');

		const written = readFileSync(delivPath, 'utf8');
		assert.equal(written, FILLED_DELIVERABLE);

		const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as { verdict: string; spawn: { exitCode: number; durationMs: number; stdoutLen: number; stderrLen: number } };
		assert.equal(audit.verdict,           result.audit.verdict);
		assert.equal(audit.spawn.exitCode,    0);
		assert.equal(audit.spawn.stdoutLen,   FILLED_DELIVERABLE.length);
	});
});
