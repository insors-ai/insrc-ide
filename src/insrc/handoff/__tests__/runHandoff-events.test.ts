/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 2b daemon-bridge groundwork: runHandoff event emission.
 *
 * Pins the contract that the `handoff.run` stream IPC and any future
 * in-process subscribers (chat-renderer, TUI) rely on -- which
 * HandoffEvents fire, in what order, with what shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHandoff, type ScriptedAgentFn } from '../index.js';
import type { HandoffEvent, MemoryRef, ScopePayload } from '../types.js';

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'insrc-handoff-events-'));
	const run = (args: string[]) => {
		const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	};
	run(['init', '-q']);
	run(['config', 'user.email', 'evt@example.com']);
	run(['config', 'user.name',  'Events Test']);
	run(['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(dir, 'a.txt'), 'initial\n');
	run(['add', '.']);
	run(['commit', '-q', '-m', 'init']);
	return dir;
}

function withRepo(fn: (repoPath: string, persistRoot: string) => Promise<void>): Promise<void> {
	const repo = initRepo();
	const root = mkdtempSync(join(tmpdir(), 'insrc-handoff-events-root-'));
	return fn(repo, root).finally(() => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});
}

function makeScope(repoPath: string): ScopePayload {
	return { repoId: repoPath, repoPath, inScopeGlobs: ['**'], outOfScopePaths: [], riskHints: 'low' };
}
const MEM: MemoryRef[] = [];

const FILLED = [
	'## Reproduce', 'a', '## Localize', 'b', '## Hypothesize', 'c', '## Test', 'd', '## Conclude', 'e',
].join('\n');

const PARTIAL = ['## Reproduce', 'a', '## Conclude', 'b'].join('\n');

function scripted(stdout: string): ScriptedAgentFn {
	return async () => ({ stdout, stderr: '', exitCode: 0, durationMs: 10 });
}

// ---------------------------------------------------------------------------
// Happy-path event sequence
// ---------------------------------------------------------------------------

test('runHandoff: emits the expected event sequence on a happy-path accept run', async () => {
	await withRepo(async (repo, persistRoot) => {
		const events: HandoffEvent[] = [];
		const result = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repo),
			memoryRefs:    MEM,
			agent:         'scripted-agent',
			scriptedAgent: scripted(FILLED),
			persistRoot,
			sessionId:     'sess-events',
			specIdOverride: 'spec-events-1',
			onEvent:       e => events.push(e),
		});

		// Order is fixed; assert via kind sequence so the test stays
		// resilient to minor payload changes.
		const kinds = events.map(e => e.kind);
		assert.deepEqual(kinds, [
			'spec-assembling',
			'spec-ready',
			'worktree-created',
			'spawned',
			'agent-completed',
			'auditing',
			'audit-ready',
			'handoff-final',
		]);

		// Sanity-check key payload fields.
		const specReady = events.find(e => e.kind === 'spec-ready');
		assert.equal(specReady?.kind, 'spec-ready');
		if (specReady?.kind === 'spec-ready') {
			assert.equal(specReady.specId,     'spec-events-1');
			assert.equal(specReady.templateId, 'DEBUG-SESSION');
			assert.ok(specReady.preview.length > 0);
		}
		const audit = events.find(e => e.kind === 'audit-ready');
		assert.equal(audit?.kind, 'audit-ready');
		if (audit?.kind === 'audit-ready') {
			assert.equal(audit.verdict, 'accept');
			assert.equal(audit.diffBytes, 0);
		}
		const final = events.find(e => e.kind === 'handoff-final');
		assert.equal(final?.kind, 'handoff-final');
		if (final?.kind === 'handoff-final') {
			assert.equal(final.verdict,       'accept');
			assert.equal(final.worktreePath,  result.worktreePath);
		}
	});
});

// ---------------------------------------------------------------------------
// Verdict propagation
// ---------------------------------------------------------------------------

test('runHandoff: revise-major run still emits the full happy-path event sequence (verdict carried on the events)', async () => {
	await withRepo(async (repo, persistRoot) => {
		const events: HandoffEvent[] = [];
		await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repo),
			memoryRefs:    MEM,
			agent:         'scripted-agent',
			scriptedAgent: scripted(PARTIAL),
			persistRoot,
			sessionId:     'sess-evt-rm',
			specIdOverride: 'spec-evt-rm',
			onEvent:       e => events.push(e),
		});
		const kinds = events.map(e => e.kind);
		assert.deepEqual(kinds, [
			'spec-assembling', 'spec-ready', 'worktree-created', 'spawned',
			'agent-completed', 'auditing', 'audit-ready', 'handoff-final',
		]);
		const audit = events.find(e => e.kind === 'audit-ready');
		const final = events.find(e => e.kind === 'handoff-final');
		assert.equal(audit?.kind === 'audit-ready' && audit.verdict, 'revise-major');
		assert.equal(final?.kind === 'handoff-final' && final.verdict, 'revise-major');
	});
});

// ---------------------------------------------------------------------------
// Error-path events
// ---------------------------------------------------------------------------

test('runHandoff: worktree stage failure -> handoff-error event with stage="worktree"', async () => {
	const persistRoot = mkdtempSync(join(tmpdir(), 'insrc-handoff-events-err-'));
	const nonGit       = mkdtempSync(join(tmpdir(), 'insrc-handoff-events-nongit-'));
	try {
		const events: HandoffEvent[] = [];
		await assert.rejects(() => runHandoff({
			templateId:     'DEBUG-SESSION',
			intent:         'fix',
			scope:          { repoId: nonGit, repoPath: nonGit, inScopeGlobs: ['**'], outOfScopePaths: [], riskHints: 'low' },
			memoryRefs:     MEM,
			agent:          'scripted-agent',
			scriptedAgent:  scripted(FILLED),
			persistRoot,
			sessionId:      'sess-err',
			specIdOverride: 'spec-err',
			onEvent:        e => events.push(e),
		}));

		// spec-assembling + spec-ready always succeed; the error fires on worktree.
		const kinds = events.map(e => e.kind);
		assert.deepEqual(kinds, ['spec-assembling', 'spec-ready', 'handoff-error']);
		const err = events[2]!;
		assert.equal(err.kind === 'handoff-error' && err.stage, 'worktree');
	} finally {
		rmSync(nonGit,      { recursive: true, force: true });
		rmSync(persistRoot, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Listener exception safety
// ---------------------------------------------------------------------------

test('runHandoff: an onEvent listener that THROWS does not break the pipeline', async () => {
	await withRepo(async (repo, persistRoot) => {
		let calls = 0;
		const result = await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         makeScope(repo),
			memoryRefs:    MEM,
			agent:         'scripted-agent',
			scriptedAgent: scripted(FILLED),
			persistRoot,
			sessionId:     'sess-throwy',
			specIdOverride: 'spec-throwy',
			onEvent:       () => { calls++; throw new Error('listener-bomb'); },
		});
		// The handoff still completed end-to-end.
		assert.equal(result.audit.verdict, 'accept');
		// The listener was called at least once per stage transition.
		assert.ok(calls >= 8);
	});
});
