/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Machine-verifier dispatch.
 *
 * Each acceptance criterion of kind `machine` carries a structured
 * `MachineVerifier` descriptor. This module runs them and returns a
 * per-criterion result the judge consumes.
 *
 * Verifier types (design §5.2):
 *   - file-exists  : check `<cwd>/<path>` exists.
 *   - regex-match  : read `<cwd>/<path>`, test the regex against contents.
 *   - shell-exit   : spawn `<command>` in `<cwd>`, check exit code is 0.
 *                    Timeout default 30s; --timeoutMs overrides.
 *
 * Soft criteria (kind === 'soft') are skipped here; the judge marks
 * them as pending so the optional cloud-judge shim or the
 * user-confirmation gate handles them.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

import type { AcceptanceCriterion, MachineVerifier } from '../types.js';

export interface MachineCheckResult {
	readonly criterionId: string;
	readonly kind:        'machine' | 'soft';
	readonly status:      'pass' | 'fail' | 'skipped';
	readonly detail:      string;
	readonly durationMs:  number;
}

export interface RunMachineChecksOpts {
	readonly cwd:        string;
	readonly defaultTimeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Evaluate every criterion in order. Returns one result per
 * criterion (same length as input) so the judge can correlate by
 * index or by criterionId.
 */
export async function runMachineChecks(
	criteria: readonly AcceptanceCriterion[],
	opts:     RunMachineChecksOpts,
): Promise<readonly MachineCheckResult[]> {
	const results: MachineCheckResult[] = [];
	for (const c of criteria) {
		if (c.kind === 'soft' || c.verifier === undefined) {
			results.push({
				criterionId: c.id,
				kind:        c.kind,
				status:      'skipped',
				detail:      c.kind === 'soft'
					? 'soft criterion -- audit-time review or user confirmation'
					: 'machine criterion has no verifier',
				durationMs:  0,
			});
			continue;
		}
		results.push(await runOne(c.id, c.verifier, opts));
	}
	return results;
}

async function runOne(criterionId: string, v: MachineVerifier, opts: RunMachineChecksOpts): Promise<MachineCheckResult> {
	const start = Date.now();
	switch (v.type) {
		case 'file-exists':  return finishSync(criterionId, checkFileExists(v.path, opts.cwd), start);
		case 'regex-match':  return finishSync(criterionId, checkRegexMatch(v.path, v.pattern, opts.cwd), start);
		case 'shell-exit':   return finishAsync(criterionId, await checkShellExit(v, opts), start);
	}
}

function finishSync(criterionId: string, syncResult: { status: 'pass' | 'fail'; detail: string }, start: number): MachineCheckResult {
	return { criterionId, kind: 'machine', status: syncResult.status, detail: syncResult.detail, durationMs: Date.now() - start };
}

function finishAsync(criterionId: string, asyncResult: { status: 'pass' | 'fail'; detail: string }, start: number): MachineCheckResult {
	return { criterionId, kind: 'machine', status: asyncResult.status, detail: asyncResult.detail, durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Verifier impls
// ---------------------------------------------------------------------------

function resolveAgainstCwd(path: string, cwd: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}

function checkFileExists(path: string, cwd: string): { status: 'pass' | 'fail'; detail: string } {
	const abs = resolveAgainstCwd(path, cwd);
	return existsSync(abs)
		? { status: 'pass', detail: `${abs} exists` }
		: { status: 'fail', detail: `${abs} does not exist` };
}

function checkRegexMatch(path: string, pattern: string, cwd: string): { status: 'pass' | 'fail'; detail: string } {
	const abs = resolveAgainstCwd(path, cwd);
	if (!existsSync(abs)) {
		return { status: 'fail', detail: `${abs} does not exist (cannot regex-match)` };
	}
	let re: RegExp;
	try {
		re = new RegExp(pattern, 'm');
	} catch (err) {
		return { status: 'fail', detail: `invalid regex /${pattern}/: ${(err as Error).message}` };
	}
	const body = readFileSync(abs, 'utf8');
	return re.test(body)
		? { status: 'pass', detail: `pattern /${pattern}/ matched in ${abs}` }
		: { status: 'fail', detail: `pattern /${pattern}/ did not match in ${abs}` };
}

function checkShellExit(
	v:    Extract<MachineVerifier, { type: 'shell-exit' }>,
	opts: RunMachineChecksOpts,
): Promise<{ status: 'pass' | 'fail'; detail: string }> {
	const cwd       = v.cwd ?? opts.cwd;
	const timeoutMs = v.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

	return new Promise(resolve => {
		const child = spawn(v.command, { shell: true, cwd });
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);

		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on('error', err => {
			clearTimeout(timer);
			resolve({ status: 'fail', detail: `spawn error for \`${v.command}\`: ${(err as Error).message}` });
		});
		child.on('close', (exitCode: number | null) => {
			clearTimeout(timer);
			if (timedOut) {
				resolve({ status: 'fail', detail: `\`${v.command}\` timed out after ${timeoutMs}ms` });
				return;
			}
			if (exitCode === 0) {
				resolve({ status: 'pass', detail: `\`${v.command}\` exited 0` });
			} else {
				const stderrTail = stderr.trim().length > 0 ? ` (stderr: ${stderr.trim().slice(0, 200)})` : '';
				resolve({ status: 'fail', detail: `\`${v.command}\` exited ${exitCode ?? '-1'}${stderrTail}` });
			}
		});
	});
}
