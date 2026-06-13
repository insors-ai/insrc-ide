/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc handoff` CLI tests.
 *
 * Use the runHandoffCli test seam + scripted-agent so we don't need
 * the real claude CLI. Each test stands up a tmp git repo, points
 * --scripted-deliverable at a fixture file, and asserts the exit
 * code + the stdout summary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHandoffCli } from '../handoff.js';

interface CapturedIo {
	stdout: string;
	stderr: string;
}

function captureIo(): { io: { stdout: (s: string) => void; stderr: (s: string) => void }; captured: CapturedIo } {
	const captured: CapturedIo = { stdout: '', stderr: '' };
	return {
		io: {
			stdout: s => { captured.stdout += s; },
			stderr: s => { captured.stderr += s; },
		},
		captured,
	};
}

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'insrc-handoff-cli-'));
	const run = (args: string[]) => {
		const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	};
	run(['init', '-q']);
	run(['config', 'user.email', 'cli@example.com']);
	run(['config', 'user.name',  'CLI Test']);
	run(['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(dir, 'a.txt'), 'initial\n');
	run(['add', '.']);
	run(['commit', '-q', '-m', 'init']);
	return dir;
}

function makePersistRoot(): string {
	return mkdtempSync(join(tmpdir(), 'insrc-handoff-cli-root-'));
}

function writeDeliverable(dir: string, name: string, content: string): string {
	const file = join(dir, name);
	writeFileSync(file, content);
	return file;
}

const FILLED = [
	'# Debug Session Deliverable',
	'',
	'## Reproduce',     'reproduced',
	'## Localize',      'localized',
	'## Hypothesize',   'hypothesised',
	'## Test',          'tested',
	'## Conclude',      'concluded',
].join('\n');

const PARTIAL = [
	'## Reproduce',     'reproduced',
	'## Localize',      '<TODO>',
	'## Hypothesize',   'hypothesised',
	'## Test',          'tested',
	'## Conclude',      'concluded',
].join('\n');

const MISSING_SECTIONS = [
	'## Reproduce', 'reproduced',
	'## Conclude',  'concluded',
].join('\n');

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

test('handoff CLI: unknown template -> exit 3', async () => {
	const { io, captured } = captureIo();
	const code = await runHandoffCli({
		template: 'NOT-A-TEMPLATE', intent: 'x', repo: '/r', agent: 'scripted-agent',
	}, io);
	assert.equal(code, 3);
	assert.match(captured.stderr, /unknown template/);
});

test('handoff CLI: unknown agent -> exit 3', async () => {
	const { io, captured } = captureIo();
	const code = await runHandoffCli({
		template: 'DEBUG-SESSION', intent: 'x', repo: '/r', agent: 'bogus',
	}, io);
	assert.equal(code, 3);
	assert.match(captured.stderr, /unknown agent/);
});

test('handoff CLI: scripted-agent without --scripted-deliverable -> exit 3', async () => {
	const { io, captured } = captureIo();
	const code = await runHandoffCli({
		template: 'DEBUG-SESSION', intent: 'x', repo: '/r', agent: 'scripted-agent',
	}, io);
	assert.equal(code, 3);
	assert.match(captured.stderr, /requires --scripted-deliverable/);
});

test('handoff CLI: --scripted-deliverable points at missing file -> exit 3', async () => {
	const { io, captured } = captureIo();
	const code = await runHandoffCli({
		template: 'DEBUG-SESSION', intent: 'x', repo: '/r', agent: 'scripted-agent',
		scriptedDeliverable: '/nope/missing-' + Date.now(),
	}, io);
	assert.equal(code, 3);
	assert.match(captured.stderr, /cannot read --scripted-deliverable/);
});

// ---------------------------------------------------------------------------
// Verdict-driven exit codes
// ---------------------------------------------------------------------------

test('handoff CLI: filled deliverable -> exit 0 (accept) with reason + diff sections in stdout', async () => {
	const repo  = initRepo();
	const root  = makePersistRoot();
	const fix   = mkdtempSync(join(tmpdir(), 'insrc-handoff-cli-fix-'));
	const delivPath = writeDeliverable(fix, 'd.md', FILLED);
	try {
		const { io, captured } = captureIo();
		const code = await runHandoffCli({
			template: 'DEBUG-SESSION', intent: 'fix', repo,
			agent: 'scripted-agent', scriptedDeliverable: delivPath,
			persistRoot: root, sessionId: 'cli-accept',
			forceCleanup: true,
		}, io);
		assert.equal(code, 0);
		assert.match(captured.stdout, /audit verdict:\s+accept/);
		assert.match(captured.stdout, /All required sections filled/);
		assert.match(captured.stdout, /diff:/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
		rmSync(fix,  { recursive: true, force: true });
	}
});

test('handoff CLI: placeholder section -> exit 1 (revise-edits) with hint in stdout', async () => {
	const repo  = initRepo();
	const root  = makePersistRoot();
	const fix   = mkdtempSync(join(tmpdir(), 'insrc-handoff-cli-fix-'));
	const delivPath = writeDeliverable(fix, 'd.md', PARTIAL);
	try {
		const { io, captured } = captureIo();
		const code = await runHandoffCli({
			template: 'DEBUG-SESSION', intent: 'fix', repo,
			agent: 'scripted-agent', scriptedDeliverable: delivPath,
			persistRoot: root, sessionId: 'cli-edits',
			forceCleanup: true,
		}, io);
		assert.equal(code, 1);
		assert.match(captured.stdout, /audit verdict:\s+revise-edits/);
		assert.match(captured.stdout, /Fill the empty '## Localize'/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
		rmSync(fix,  { recursive: true, force: true });
	}
});

test('handoff CLI: required sections missing -> exit 2 (revise-major)', async () => {
	const repo  = initRepo();
	const root  = makePersistRoot();
	const fix   = mkdtempSync(join(tmpdir(), 'insrc-handoff-cli-fix-'));
	const delivPath = writeDeliverable(fix, 'd.md', MISSING_SECTIONS);
	try {
		const { io, captured } = captureIo();
		const code = await runHandoffCli({
			template: 'DEBUG-SESSION', intent: 'fix', repo,
			agent: 'scripted-agent', scriptedDeliverable: delivPath,
			persistRoot: root, sessionId: 'cli-major',
			forceCleanup: true,
		}, io);
		assert.equal(code, 2);
		assert.match(captured.stdout, /audit verdict:\s+revise-major/);
		assert.match(captured.stdout, /Add the missing '## /);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
		rmSync(fix,  { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Orchestration failure (e.g. invalid repo)
// ---------------------------------------------------------------------------

test('handoff CLI: --repo points at a non-git directory -> exit 4 with "handoff failed"', async () => {
	const root = makePersistRoot();
	const nonGit = mkdtempSync(join(tmpdir(), 'insrc-handoff-cli-nongit-'));
	const fix    = mkdtempSync(join(tmpdir(), 'insrc-handoff-cli-fix-'));
	const delivPath = writeDeliverable(fix, 'd.md', FILLED);
	try {
		const { io, captured } = captureIo();
		const code = await runHandoffCli({
			template: 'DEBUG-SESSION', intent: 'fix', repo: nonGit,
			agent: 'scripted-agent', scriptedDeliverable: delivPath,
			persistRoot: root, sessionId: 'cli-nongit',
			forceCleanup: true,
		}, io);
		assert.equal(code, 4);
		assert.match(captured.stderr, /handoff failed/);
	} finally {
		rmSync(nonGit, { recursive: true, force: true });
		rmSync(root,   { recursive: true, force: true });
		rmSync(fix,    { recursive: true, force: true });
	}
});
