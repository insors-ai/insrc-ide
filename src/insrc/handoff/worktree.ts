/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Git worktree management for handoffs.
 *
 * Phase 2a uses worktrees to give the external coding agent a
 * sandboxed view of the repo: it edits inside the worktree, the
 * original tree stays untouched until the audit phase (Phase 4)
 * accepts the diff. Design §7.3.
 *
 * On accept, the audit phase computes the diff between the worktree
 * and the original and proposes a merge-back; on reject, the
 * worktree is discarded with `git worktree remove --force`.
 *
 * This module is the thin wrapper over git plumbing. No business
 * logic; callers (spawn modules, CLI handoff command) compose.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { getLogger } from '../shared/logger.js';

const log = getLogger('handoff:worktree');

export interface CreateWorktreeOpts {
	/** Absolute path to the source repo (where `.git` lives). */
	readonly repoPath:     string;
	/** Absolute path where the new worktree should be created. */
	readonly worktreePath: string;
	/** Ref to check out in the worktree. Default: 'HEAD'. */
	readonly ref?:         string | undefined;
	/** When true, fail if the target path already exists; when false, reuse. */
	readonly failIfExists?: boolean | undefined;
}

export interface CreateWorktreeResult {
	readonly worktreePath: string;
	readonly ref:          string;
	readonly action:       'created' | 'reused';
}

export interface RemoveWorktreeOpts {
	readonly repoPath:     string;
	readonly worktreePath: string;
}

export class WorktreeError extends Error {
	constructor(message: string, readonly stderr: string = '') {
		super(message);
		this.name = 'WorktreeError';
	}
}

/**
 * `git worktree add <worktreePath> <ref>` in the source repo. Creates
 * parent directories of `worktreePath` if missing. Idempotent unless
 * `failIfExists` is set.
 */
export async function createWorktree(opts: CreateWorktreeOpts): Promise<CreateWorktreeResult> {
	const ref = opts.ref ?? 'HEAD';

	if (existsSync(opts.worktreePath)) {
		if (opts.failIfExists === true) {
			throw new WorktreeError(`worktree path '${opts.worktreePath}' already exists`);
		}
		log.info({ worktreePath: opts.worktreePath }, 'worktree already exists; reusing');
		return { worktreePath: opts.worktreePath, ref, action: 'reused' };
	}

	// `git worktree add` requires the PARENT of the target to exist; it
	// won't mkdir -p. The handoff-scoped path is `<.insrc>/handoffs/<sid>/worktree`,
	// and we want to ensure the `<sid>/` directory is present.
	await ensureDirExists(dirname(opts.worktreePath));

	const { exitCode, stderr } = await runGit(opts.repoPath, ['worktree', 'add', opts.worktreePath, ref]);
	if (exitCode !== 0) {
		throw new WorktreeError(
			`git worktree add failed (exit ${exitCode}) for ref '${ref}' at '${opts.worktreePath}'`,
			stderr,
		);
	}
	log.info({ worktreePath: opts.worktreePath, ref }, 'worktree created');
	return { worktreePath: opts.worktreePath, ref, action: 'created' };
}

/**
 * `git worktree remove <path> --force`. Force-mode deletes the
 * worktree even when it has uncommitted changes -- handoff acceptance
 * is captured BEFORE this is called.
 */
export async function removeWorktree(opts: RemoveWorktreeOpts): Promise<void> {
	if (!existsSync(opts.worktreePath)) {
		log.info({ worktreePath: opts.worktreePath }, 'worktree path does not exist; nothing to remove');
		return;
	}
	const { exitCode, stderr } = await runGit(opts.repoPath, ['worktree', 'remove', opts.worktreePath, '--force']);
	if (exitCode !== 0) {
		throw new WorktreeError(
			`git worktree remove failed (exit ${exitCode}) for '${opts.worktreePath}'`,
			stderr,
		);
	}
	log.info({ worktreePath: opts.worktreePath }, 'worktree removed');
}

/**
 * Compute the diff between the worktree and the source repo's HEAD.
 * Returns the raw `git diff` output -- callers parse / display.
 */
export async function diffWorktreeAgainstHead(opts: { repoPath: string; worktreePath: string }): Promise<string> {
	const { exitCode, stdout, stderr } = await runGit(opts.worktreePath, ['diff', 'HEAD']);
	if (exitCode !== 0 && exitCode !== 1) {
		// `git diff` exits 0 with no diff and 1 with diff; anything else is an error.
		throw new WorktreeError(`git diff failed (exit ${exitCode}) for worktree '${opts.worktreePath}'`, stderr);
	}
	return stdout;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function ensureDirExists(dir: string): Promise<void> {
	const { mkdir } = await import('node:fs/promises');
	await mkdir(dir, { recursive: true });
}

interface RunResult {
	readonly exitCode: number;
	readonly stdout:   string;
	readonly stderr:   string;
}

function runGit(cwd: string, args: readonly string[]): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, { cwd });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on('error', err => reject(new WorktreeError(`failed to spawn git: ${(err as Error).message}`)));
		child.on('close', (exitCode: number | null) => {
			resolve({ exitCode: exitCode ?? -1, stdout, stderr });
		});
	});
}
