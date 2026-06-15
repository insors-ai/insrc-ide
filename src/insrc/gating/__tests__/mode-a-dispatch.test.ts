/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mode A dispatch tests + end-to-end runHandoff Mode-A integration.
 *
 * Pins these behaviours:
 *   - awaitModeAResolution returns the IDE verdict when
 *     resolveModeAPrompt is called.
 *   - awaitModeAResolution times out to a deny verdict carrying a
 *     timeout stopReason.
 *   - resolveModeAPrompt on an unknown gateId returns false (and the
 *     prompt-awaiter stays pending until its own timeout).
 *   - cancelAllModeAPrompts resolves every pending entry with a deny
 *     stopReason.
 *   - runHandoff with `modeAGate: true` emits the
 *     `mode-a-gate-request` event, blocks until resolved, emits
 *     `mode-a-gate-resolved` and proceeds on allow.
 *   - runHandoff with `modeAGate: true` aborts the pipeline on deny --
 *     no `worktree-created` event fires.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	awaitModeAResolution,
	resolveModeAPrompt,
	cancelAllModeAPrompts,
	_pendingCountForTest,
	_resetForTest,
} from '../mode-a-dispatch.js';
import { runHandoff } from '../../handoff/index.js';
import type { HandoffEvent, MemoryRef, ScopePayload } from '../../handoff/types.js';

beforeEach(() => _resetForTest());

// -- Dispatch primitives ------------------------------------------------------

test('awaitModeAResolution: resolves with the IDE-supplied verdict', async () => {
	const promise = awaitModeAResolution('g-1');
	assert.equal(_pendingCountForTest(), 1);
	assert.equal(resolveModeAPrompt('g-1', { verdict: 'allow' }), true);
	const r = await promise;
	assert.equal(r.verdict, 'allow');
	assert.equal(_pendingCountForTest(), 0);
});

test('awaitModeAResolution: default-deny on timeout with descriptive stopReason', async () => {
	const r = await awaitModeAResolution('g-timeout', 30);
	assert.equal(r.verdict, 'deny');
	assert.match(r.stopReason ?? '', /timeout/);
	assert.equal(_pendingCountForTest(), 0);
});

test('resolveModeAPrompt: unknown gateId returns false; existing promise stays pending until its own timeout', async () => {
	assert.equal(resolveModeAPrompt('never-registered', { verdict: 'allow' }), false);
	const promise = awaitModeAResolution('g-2', 25);
	assert.equal(resolveModeAPrompt('also-never-registered', { verdict: 'allow' }), false);
	const r = await promise;
	assert.equal(r.verdict, 'deny');
});

test('cancelAllModeAPrompts: every pending entry resolves with deny + stopReason', async () => {
	const p1 = awaitModeAResolution('g-c1');
	const p2 = awaitModeAResolution('g-c2');
	assert.equal(_pendingCountForTest(), 2);
	cancelAllModeAPrompts('daemon shutting down');
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.equal(r1.verdict, 'deny');
	assert.equal(r1.stopReason, 'daemon shutting down');
	assert.equal(r2.verdict, 'deny');
	assert.equal(_pendingCountForTest(), 0);
});

test('resolveModeAPrompt: a second call for the same gateId is a no-op', async () => {
	const promise = awaitModeAResolution('g-double');
	assert.equal(resolveModeAPrompt('g-double', { verdict: 'allow' }), true);
	assert.equal(resolveModeAPrompt('g-double', { verdict: 'deny' }), false);
	const r = await promise;
	assert.equal(r.verdict, 'allow');  // first verdict wins
});

// -- runHandoff integration ---------------------------------------------------

function withRepo(): { repo: string; persistRoot: string; cleanup: () => void } {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-modea-repo-'));
	execSync('git init -q', { cwd: repo });
	execSync('git config user.email test@local && git config user.name Test', { cwd: repo });
	execSync('git commit -q --allow-empty -m init', { cwd: repo });
	const persistRoot = mkdtempSync(join(tmpdir(), 'insrc-modea-persist-'));
	return {
		repo,
		persistRoot,
		cleanup: () => {
			rmSync(repo, { recursive: true, force: true });
			rmSync(persistRoot, { recursive: true, force: true });
		},
	};
}

const FILLED_DELIVERABLE = [
	'# Debug Session Deliverable',
	'',
	'## Reproduce', 'r',
	'## Localize', 'l',
	'## Hypothesize', 'h',
	'## Test', 't',
	'## Conclude', 'c',
].join('\n');

const SAMPLE_SCOPE = (repo: string): ScopePayload => ({
	repoId: repo, repoPath: repo,
	inScopeGlobs: ['**'], outOfScopePaths: [],
	riskHints: 'low',
});

const SAMPLE_MEM: readonly MemoryRef[] = [];

test('runHandoff: modeAGate=true emits gate-request -> awaits IDE allow -> emits gate-resolved -> proceeds to worktree', async () => {
	const ctx = withRepo();
	try {
		const events: HandoffEvent[] = [];
		const promise = runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         SAMPLE_SCOPE(ctx.repo),
			memoryRefs:    SAMPLE_MEM,
			agent:         'scripted-agent',
			scriptedAgent: () => ({ stdout: FILLED_DELIVERABLE, stderr: '', exitCode: 0, durationMs: 0 }),
			persistRoot:   ctx.persistRoot,
			sessionId:     'sess-mode-a-allow',
			specIdOverride: 'spec-mode-a-allow',
			onEvent:       e => events.push(e),
			modeAGate:     true,
			modeATimeoutMs: 30_000,
		});

		// Wait for the gate to be emitted, then settle it.
		const start = Date.now();
		while (Date.now() - start < 5000) {
			const req = events.find(e => e.kind === 'mode-a-gate-request');
			if (req !== undefined) {
				assert.equal(req.kind, 'mode-a-gate-request');
				if (req.kind === 'mode-a-gate-request') {
					assert.equal(resolveModeAPrompt(req.gateId, { verdict: 'allow' }), true);
				}
				break;
			}
			await new Promise(r => setTimeout(r, 20));
		}

		await promise;

		const stageKinds = events.map(e => e.kind).filter(k =>
			k !== 'agent-stdout-chunk' && k !== 'agent-stderr-chunk');
		assert.deepStrictEqual(stageKinds, [
			'spec-assembling',
			'spec-ready',
			'mode-a-gate-request',
			'mode-a-gate-resolved',
			'worktree-created',
			'spawned',
			'agent-completed',
			'auditing',
			'audit-ready',
			'handoff-final',
		]);

		const resolved = events.find(e => e.kind === 'mode-a-gate-resolved');
		assert.ok(resolved !== undefined);
		if (resolved?.kind === 'mode-a-gate-resolved') {
			assert.equal(resolved.verdict, 'allow');
		}
	} finally {
		ctx.cleanup();
	}
});

test('runHandoff: modeAGate=true with deny stops the pipeline before worktree-created', async () => {
	const ctx = withRepo();
	try {
		const events: HandoffEvent[] = [];
		const promise = runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         SAMPLE_SCOPE(ctx.repo),
			memoryRefs:    SAMPLE_MEM,
			agent:         'scripted-agent',
			scriptedAgent: () => ({ stdout: FILLED_DELIVERABLE, stderr: '', exitCode: 0, durationMs: 0 }),
			persistRoot:   ctx.persistRoot,
			sessionId:     'sess-mode-a-deny',
			specIdOverride: 'spec-mode-a-deny',
			onEvent:       e => events.push(e),
			modeAGate:     true,
			modeATimeoutMs: 30_000,
		});

		const start = Date.now();
		while (Date.now() - start < 5000) {
			const req = events.find(e => e.kind === 'mode-a-gate-request');
			if (req !== undefined) {
				if (req.kind === 'mode-a-gate-request') {
					assert.equal(resolveModeAPrompt(req.gateId, { verdict: 'deny', stopReason: 'user cancelled' }), true);
				}
				break;
			}
			await new Promise(r => setTimeout(r, 20));
		}

		await assert.rejects(promise, /user cancelled|Mode A: user denied/);

		const stageKinds = events.map(e => e.kind).filter(k =>
			k !== 'agent-stdout-chunk' && k !== 'agent-stderr-chunk');
		assert.deepStrictEqual(stageKinds, [
			'spec-assembling',
			'spec-ready',
			'mode-a-gate-request',
			'mode-a-gate-resolved',
			'handoff-error',
		]);

		const err = events.find(e => e.kind === 'handoff-error');
		if (err?.kind === 'handoff-error') {
			assert.equal(err.stage, 'spec-assemble');
		}

		// No worktree event implies no worktree was created.
		const wt = events.find(e => e.kind === 'worktree-created');
		assert.equal(wt, undefined);
	} finally {
		ctx.cleanup();
	}
});

test('runHandoff: modeAGate=false (default) skips the gate entirely', async () => {
	const ctx = withRepo();
	try {
		const events: HandoffEvent[] = [];
		await runHandoff({
			templateId:    'DEBUG-SESSION',
			intent:        'fix',
			scope:         SAMPLE_SCOPE(ctx.repo),
			memoryRefs:    SAMPLE_MEM,
			agent:         'scripted-agent',
			scriptedAgent: () => ({ stdout: FILLED_DELIVERABLE, stderr: '', exitCode: 0, durationMs: 0 }),
			persistRoot:   ctx.persistRoot,
			sessionId:     'sess-mode-a-off',
			specIdOverride: 'spec-mode-a-off',
			onEvent:       e => events.push(e),
		});

		const kinds = events.map(e => e.kind);
		assert.equal(kinds.includes('mode-a-gate-request'), false);
		assert.equal(kinds.includes('mode-a-gate-resolved'), false);
		assert.equal(kinds.includes('handoff-final'), true);
	} finally {
		ctx.cleanup();
	}
});
