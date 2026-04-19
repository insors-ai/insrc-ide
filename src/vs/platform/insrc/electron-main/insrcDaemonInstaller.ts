/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import { homedir } from 'os';
import { delimiter, join, relative } from 'path';
import { FileAccess } from '../../../base/common/network.js';
import { ILogService } from '../../log/common/log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Defaults when no configuration is supplied. Actual values should come
// from the caller via insrc.daemon.repoUrl / insrc.daemon.repoBranch so
// forks and private mirrors can point the installer elsewhere.
const DEFAULT_REPO_URL = 'https://github.com/insors-ai/insrc-ide.git';
const DEFAULT_REPO_BRANCH = 'release/1.96';

const INSRC_DIR = join(homedir(), '.insrc');
export const DAEMON_DIR = join(INSRC_DIR, 'daemon');

export interface DaemonRepoConfig {
	readonly repoUrl: string;
	readonly repoBranch: string;
}

function resolveRepoConfig(config: DaemonRepoConfig | undefined): DaemonRepoConfig {
	return {
		repoUrl: config?.repoUrl || DEFAULT_REPO_URL,
		repoBranch: config?.repoBranch || DEFAULT_REPO_BRANCH,
	};
}
const DAEMON_SRC = join(DAEMON_DIR, 'src', 'insrc');
const DAEMON_OUT = join(DAEMON_DIR, 'out', 'insrc');
const DAEMON_ENTRY_CLONED = join(DAEMON_OUT, 'daemon', 'index.js');

const INSTALL_PROCESS_TIMEOUT_MS = 30 * 60_000;  // 30 min cap for clone/install/build
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
export async function ensureClonedDaemon(
	logService: ILogService,
	autoUpdate: boolean,
	repoConfig?: DaemonRepoConfig,
): Promise<boolean> {
	const resolved = resolveRepoConfig(repoConfig);
	if (!fs.existsSync(DAEMON_ENTRY_CLONED)) {
		return install(logService, resolved);
	}
	if (autoUpdate) {
		try {
			await update(logService, resolved);
		} catch (err) {
			logService.warn(`${UPDATE_LOG_HEAD} update failed, keeping existing install:`, (err as Error).message);
		}
	}
	return true;
}

async function install(logService: ILogService, config: DaemonRepoConfig): Promise<boolean> {
	logService.info(`${UPDATE_LOG_HEAD} installing daemon to ${DAEMON_DIR} (branch ${config.repoBranch} of ${config.repoUrl})`);

	await fs.promises.mkdir(INSRC_DIR, { recursive: true });

	// Wipe any partial / old install
	if (fs.existsSync(DAEMON_DIR)) {
		await fs.promises.rm(DAEMON_DIR, { recursive: true, force: true });
	}

	// Shallow clone -- fast enough for a first-time install on a typical
	// connection. Branch is pinned to where the daemon source lives;
	// upstream `main` doesn't carry the insrc tree. Subsequent `git pull
	// --ff-only` works against shallow clones. If a caller wants full
	// history they can `git fetch --unshallow` inside DAEMON_DIR.
	await run(logService, 'git', ['clone', '--branch', config.repoBranch, '--depth', '1', '--single-branch', config.repoUrl, DAEMON_DIR]);
	await run(logService, 'npm', ['install', '--legacy-peer-deps'], DAEMON_SRC);
	await run(logService, 'npx', ['tsc'], DAEMON_SRC);
	await linkNodeModules(logService);

	if (!fs.existsSync(DAEMON_ENTRY_CLONED)) {
		logService.error(`${UPDATE_LOG_HEAD} build completed but entry missing: ${DAEMON_ENTRY_CLONED}`);
		return false;
	}

	logService.info(`${UPDATE_LOG_HEAD} daemon installed`);
	return true;
}

async function update(logService: ILogService, config: DaemonRepoConfig): Promise<void> {
	logService.info(`${UPDATE_LOG_HEAD} checking for daemon updates (branch ${config.repoBranch})`);

	// Ensure the checkout tracks the configured daemon branch. Older
	// installs may have been cloned against a different default branch.
	await run(logService, 'git', ['fetch', 'origin', config.repoBranch], DAEMON_DIR);
	await run(logService, 'git', ['checkout', config.repoBranch], DAEMON_DIR);

	const before = await run(logService, 'git', ['rev-parse', 'HEAD'], DAEMON_DIR);
	await run(logService, 'git', ['pull', '--ff-only', 'origin', config.repoBranch], DAEMON_DIR);
	const after = await run(logService, 'git', ['rev-parse', 'HEAD'], DAEMON_DIR);

	if (before.stdout.trim() === after.stdout.trim()) {
		logService.info(`${UPDATE_LOG_HEAD} daemon already up to date`);
		return;
	}

	logService.info(`${UPDATE_LOG_HEAD} rebuilding daemon`);
	await run(logService, 'npm', ['install', '--legacy-peer-deps'], DAEMON_SRC);
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

/**
 * Resolve a command (git / npm / npx) to an absolute path before spawning.
 * Electron-main's `process.env.PATH` often excludes nvm-installed Node tools
 * because the GUI process doesn't source ~/.bashrc. We look in the usual
 * places so the install step works for users whose Node lives under nvm.
 */
function resolveCommand(command: string): string {
	// Already an absolute path.
	if (command.startsWith('/')) { return command; }

	const candidates: string[] = [];
	const pathEntries = (process.env['PATH'] || '').split(delimiter).filter(Boolean);
	for (const dir of pathEntries) {
		const expanded = dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
		candidates.push(join(expanded, command));
	}

	// Common nvm locations even when the user's PATH is stripped.
	const nvmDir = process.env['NVM_DIR'] || join(homedir(), '.nvm');
	const nvmVersions = join(nvmDir, 'versions', 'node');
	if (fs.existsSync(nvmVersions)) {
		try {
			for (const version of fs.readdirSync(nvmVersions).sort().reverse()) {
				candidates.push(join(nvmVersions, version, 'bin', command));
			}
		} catch { /* ignore */ }
	}

	for (const path of ['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin']) {
		candidates.push(join(path, command));
	}

	for (const candidate of candidates) {
		try {
			const stat = fs.statSync(candidate);
			if (stat.isFile()) { return candidate; }
		} catch { /* not here */ }
	}

	// Fall back to the original name and let spawn fail with its native error.
	return command;
}

function run(logService: ILogService, command: string, args: string[], cwd?: string): Promise<RunResult> {
	return new Promise<RunResult>((resolve, reject) => {
		const resolved = resolveCommand(command);
		logService.info(`${UPDATE_LOG_HEAD} $ ${command} ${args.join(' ')}${cwd ? ` (cwd: ${cwd})` : ''}${resolved !== command ? ` [resolved: ${resolved}]` : ''}`);

		const child = cp.spawn(resolved, args, {
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
