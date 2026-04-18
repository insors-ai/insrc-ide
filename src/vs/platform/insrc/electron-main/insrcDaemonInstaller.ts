/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import { homedir } from 'os';
import { join, relative } from 'path';
import { FileAccess } from '../../../base/common/network.js';
import { ILogService } from '../../log/common/log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_URL = 'https://github.com/insors-ai/insrc-ide.git';

const INSRC_DIR = join(homedir(), '.insrc');
export const DAEMON_DIR = join(INSRC_DIR, 'daemon');
const DAEMON_SRC = join(DAEMON_DIR, 'src', 'insrc');
const DAEMON_OUT = join(DAEMON_DIR, 'out', 'insrc');
const DAEMON_ENTRY_CLONED = join(DAEMON_OUT, 'daemon', 'index.js');

const INSTALL_PROCESS_TIMEOUT_MS = 10 * 60_000;  // 10 min cap for clone/install/build
const UPDATE_LOG_HEAD = '[insrc-installer]';

// ---------------------------------------------------------------------------
// Public: resolve the daemon entry to spawn
// ---------------------------------------------------------------------------

/**
 * In dev, the IDE gulp compile populates out/insrc/ with both JS and node_modules.
 * Use that when available; otherwise fall back to the cloned install under ~/.insrc/daemon/.
 */
export function resolveDaemonEntry(): { path: string; isDev: boolean } {
	const devPath = FileAccess.asFileUri('insrc/daemon/index.js').fsPath;
	if (fs.existsSync(devPath)) {
		return { path: devPath, isDev: true };
	}
	return { path: DAEMON_ENTRY_CLONED, isDev: false };
}

// ---------------------------------------------------------------------------
// Ensure / install / update
// ---------------------------------------------------------------------------

/**
 * Ensure a runnable daemon is installed at DAEMON_ENTRY_CLONED.
 * Installs on first run, optionally updates otherwise.
 * Returns true when an installable daemon is present; false on failure.
 */
export async function ensureClonedDaemon(logService: ILogService, autoUpdate: boolean): Promise<boolean> {
	if (!fs.existsSync(DAEMON_ENTRY_CLONED)) {
		return install(logService);
	}
	if (autoUpdate) {
		try {
			await update(logService);
		} catch (err) {
			logService.warn(`${UPDATE_LOG_HEAD} update failed, keeping existing install:`, (err as Error).message);
		}
	}
	return true;
}

async function install(logService: ILogService): Promise<boolean> {
	logService.info(`${UPDATE_LOG_HEAD} installing daemon to ${DAEMON_DIR}`);

	await fs.promises.mkdir(INSRC_DIR, { recursive: true });

	// Wipe any partial / old install
	if (fs.existsSync(DAEMON_DIR)) {
		await fs.promises.rm(DAEMON_DIR, { recursive: true, force: true });
	}

	// Clone full history so subsequent `git pull` works
	await run(logService, 'git', ['clone', REPO_URL, DAEMON_DIR]);
	await run(logService, 'npm', ['install'], DAEMON_SRC);
	await run(logService, 'npx', ['tsc'], DAEMON_SRC);
	await linkNodeModules(logService);

	if (!fs.existsSync(DAEMON_ENTRY_CLONED)) {
		logService.error(`${UPDATE_LOG_HEAD} build completed but entry missing: ${DAEMON_ENTRY_CLONED}`);
		return false;
	}

	logService.info(`${UPDATE_LOG_HEAD} daemon installed`);
	return true;
}

async function update(logService: ILogService): Promise<void> {
	logService.info(`${UPDATE_LOG_HEAD} checking for daemon updates`);

	const before = await run(logService, 'git', ['rev-parse', 'HEAD'], DAEMON_DIR);
	await run(logService, 'git', ['pull', '--ff-only'], DAEMON_DIR);
	const after = await run(logService, 'git', ['rev-parse', 'HEAD'], DAEMON_DIR);

	if (before.stdout.trim() === after.stdout.trim()) {
		logService.info(`${UPDATE_LOG_HEAD} daemon already up to date`);
		return;
	}

	logService.info(`${UPDATE_LOG_HEAD} rebuilding daemon`);
	await run(logService, 'npm', ['install'], DAEMON_SRC);
	await run(logService, 'npx', ['tsc'], DAEMON_SRC);
	await linkNodeModules(logService);
	logService.info(`${UPDATE_LOG_HEAD} daemon updated`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * ESM resolution can't be swayed by NODE_PATH, so ensure the daemon's
 * node_modules is reachable via the normal upward walk from the compiled
 * entry. Symlink out/insrc/node_modules -> ../../src/insrc/node_modules.
 */
async function linkNodeModules(logService: ILogService): Promise<void> {
	const link = join(DAEMON_OUT, 'node_modules');
	const target = relative(DAEMON_OUT, join(DAEMON_SRC, 'node_modules'));

	try {
		const existing = await fs.promises.lstat(link).catch(() => undefined);
		if (existing) {
			await fs.promises.rm(link, { recursive: true, force: true });
		}
		await fs.promises.symlink(target, link, 'dir');
	} catch (err) {
		logService.warn(`${UPDATE_LOG_HEAD} could not symlink node_modules, daemon may fail to resolve deps:`, (err as Error).message);
		throw err;
	}
}

interface RunResult {
	stdout: string;
	stderr: string;
}

function run(logService: ILogService, command: string, args: string[], cwd?: string): Promise<RunResult> {
	return new Promise<RunResult>((resolve, reject) => {
		logService.info(`${UPDATE_LOG_HEAD} $ ${command} ${args.join(' ')}${cwd ? ` (cwd: ${cwd})` : ''}`);

		const child = cp.spawn(command, args, {
			cwd,
			env: process.env,
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`${command} ${args.join(' ')} timed out after ${INSTALL_PROCESS_TIMEOUT_MS / 1000}s`));
		}, INSTALL_PROCESS_TIMEOUT_MS);

		child.on('error', err => {
			clearTimeout(timer);
			reject(err);
		});

		child.on('exit', code => {
			clearTimeout(timer);
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(new Error(`${command} exited with ${code}: ${stderr.trim() || stdout.trim()}`));
			}
		});
	});
}
