/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import { homedir } from 'os';
import { delimiter, join, relative } from 'path';
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
 * The daemon always runs from the cloned install at ~/.insrc/daemon/. The
 * install path runs `linkNodeModules` so node_modules is reachable from
 * the compiled entry; the local out/insrc/ build is for compile-checking
 * only and shouldn't be spawned (gulp doesn't populate node_modules
 * there). The shape stays a discriminated `{ path, isDev }` so callers
 * that distinguish dev from cloned (logging, error messages) keep
 * compiling.
 */
export function resolveDaemonEntry(): { path: string; isDev: boolean } {
	return { path: DAEMON_ENTRY_CLONED, isDev: false };
}

// ---------------------------------------------------------------------------
// Ensure / install / update
// ---------------------------------------------------------------------------

export interface EnsureDaemonResult {
	/** True when an installable daemon is present on disk. */
	readonly ok: boolean;
	/**
	 * True when this call advanced the daemon's code on disk -- a fresh
	 * install, or a `git pull` that fast-forwarded the checkout. The
	 * caller uses this to decide whether to keep talking to a
	 * pre-existing daemon process (which still holds the old code in
	 * Node's ESM module cache) or kill it so the next spawn picks up
	 * fresh bytes. Stale-daemon-after-pull was the silent-failure mode
	 * caught while testing the analyzer's Phase 2.A; see commit
	 * 2dea43ccb15 follow-up.
	 */
	readonly updated: boolean;
}

/**
 * Build fingerprint stored at `<DAEMON_OUT>/.buildinfo.json` after every
 * successful tsc + linkNodeModules. Records the git commit SHA the build
 * was made from. On the next `ensureClonedDaemon()` call, we compare the
 * stamped SHA to the current `git HEAD`; mismatch = rebuild, regardless
 * of whether the most recent `git pull` advanced HEAD.
 *
 * This is the load-bearing "is the build current?" signal. Pre-fix we
 * trusted the (before-pull, after-pull) SHA delta as a rebuild
 * trigger -- but that mistakes "git is up to date" for "the on-disk
 * `out/` is up to date". A partial build from a prior interrupted IDE
 * run, or a manual `git pull` outside the IDE that skipped tsc, both
 * leave inconsistent `out/` artifacts that the SHA-delta check
 * cheerfully waves through. The fingerprint catches both.
 */
const BUILD_FINGERPRINT_FILE = join(DAEMON_OUT, '.buildinfo.json');

interface BuildFingerprint {
	readonly commitSha: string;
	readonly builtAt: string;
}

async function readBuildFingerprint(): Promise<string | null> {
	try {
		const raw = await fs.promises.readFile(BUILD_FINGERPRINT_FILE, 'utf8');
		const parsed = JSON.parse(raw) as Partial<BuildFingerprint>;
		return typeof parsed.commitSha === 'string' && parsed.commitSha.length > 0
			? parsed.commitSha
			: null;
	} catch {
		return null;
	}
}

async function writeBuildFingerprint(commitSha: string): Promise<void> {
	const payload: BuildFingerprint = {
		commitSha,
		builtAt: new Date().toISOString(),
	};
	await fs.promises.writeFile(BUILD_FINGERPRINT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

async function currentHeadSha(logService: ILogService): Promise<string> {
	const result = await run(logService, 'git', ['rev-parse', 'HEAD'], DAEMON_DIR);
	return result.stdout.trim();
}

/**
 * Ensure a runnable daemon is installed at DAEMON_ENTRY_CLONED, with
 * `out/` matching `git HEAD`.
 *
 * Flow:
 *   1. First run (no DAEMON_ENTRY_CLONED on disk) -- clone, install,
 *      build, stamp fingerprint. `updated: true`.
 *   2. autoUpdate enabled -- `git fetch + checkout + pull`. Logs
 *      whether the pull advanced HEAD (informational only; not the
 *      rebuild trigger).
 *   3. Read `out/.buildinfo.json`. If missing or commitSha != HEAD,
 *      wipe `out/`, run npm install + tsc + linkNodeModules, stamp a
 *      new fingerprint. `updated: true`. Catches: prior IDE crash
 *      mid-build, manual git pull outside the IDE, partial tsc
 *      output, deleted-source-file leaving stale `.js`.
 *   4. Fingerprint matches HEAD -- safe to skip rebuild.
 *      `updated: false`.
 *
 * `updated` is the trigger the caller (InsrcDaemonMainService) uses
 * to decide whether to terminate a running daemon process whose ESM
 * module cache predates the new build. Stamping always implies the
 * caller MUST kill+respawn.
 */
export async function ensureClonedDaemon(
	logService: ILogService,
	autoUpdate: boolean,
	repoConfig?: DaemonRepoConfig,
): Promise<EnsureDaemonResult> {
	const resolved = resolveRepoConfig(repoConfig);

	// First-install path -- clone + build + stamp fingerprint.
	if (!fs.existsSync(DAEMON_ENTRY_CLONED)) {
		const ok = await install(logService, resolved);
		return { ok, updated: ok };
	}

	// Optional pull. Failure is non-fatal -- we keep going to the
	// fingerprint check, which will rebuild if needed. The pull
	// outcome itself is no longer the rebuild trigger.
	if (autoUpdate) {
		try {
			await pullLatest(logService, resolved);
		} catch (err) {
			logService.warn(`${UPDATE_LOG_HEAD} pull failed, keeping existing source:`, (err as Error).message);
		}
	}

	// Fingerprint check -- the load-bearing rebuild trigger.
	const headSha = await currentHeadSha(logService).catch(() => '');
	if (headSha.length === 0) {
		logService.warn(`${UPDATE_LOG_HEAD} could not read HEAD; assuming current build is fine`);
		return { ok: true, updated: false };
	}
	const buildSha = await readBuildFingerprint();
	if (buildSha === headSha) {
		logService.info(`${UPDATE_LOG_HEAD} daemon build at ${headSha.slice(0, 12)} matches HEAD`);
		return { ok: true, updated: false };
	}

	if (buildSha === null) {
		logService.info(`${UPDATE_LOG_HEAD} build fingerprint missing; rebuilding at ${headSha.slice(0, 12)}`);
	} else {
		logService.info(`${UPDATE_LOG_HEAD} build at ${buildSha.slice(0, 12)} differs from HEAD ${headSha.slice(0, 12)}; rebuilding`);
	}

	try {
		await rebuild(logService, headSha);
		return { ok: true, updated: true };
	} catch (err) {
		logService.error(`${UPDATE_LOG_HEAD} rebuild failed:`, (err as Error).message);
		return { ok: false, updated: false };
	}
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

	const headSha = await currentHeadSha(logService).catch(() => '');
	if (headSha.length > 0) {
		await writeBuildFingerprint(headSha);
	}
	logService.info(`${UPDATE_LOG_HEAD} daemon installed at ${headSha.slice(0, 12) || '(unknown sha)'}`);
	return true;
}

async function pullLatest(logService: ILogService, config: DaemonRepoConfig): Promise<void> {
	logService.info(`${UPDATE_LOG_HEAD} pulling daemon updates (branch ${config.repoBranch})`);

	// Ensure the checkout tracks the configured daemon branch. Older
	// installs may have been cloned against a different default branch.
	await run(logService, 'git', ['fetch', 'origin', config.repoBranch], DAEMON_DIR);
	await run(logService, 'git', ['checkout', config.repoBranch], DAEMON_DIR);
	await run(logService, 'git', ['pull', '--ff-only', 'origin', config.repoBranch], DAEMON_DIR);
}

/**
 * Wipe `out/` and run a clean npm install + tsc + symlink, then stamp
 * the fingerprint. The wipe is the defensive bit: it kills stale `.js`
 * files left behind by a deleted-source-file or a previous interrupted
 * tsc run. With incremental builds + .tsbuildinfo, tsc itself can
 * happily skip re-emitting individual files; the only safe assumption
 * is that any `out/` content from before this rebuild is suspect.
 */
async function rebuild(logService: ILogService, headSha: string): Promise<void> {
	logService.info(`${UPDATE_LOG_HEAD} clean-rebuilding daemon at ${headSha.slice(0, 12)}`);
	await fs.promises.rm(DAEMON_OUT, { recursive: true, force: true });
	await run(logService, 'npm', ['install', '--legacy-peer-deps'], DAEMON_SRC);
	await run(logService, 'npx', ['tsc'], DAEMON_SRC);
	await linkNodeModules(logService);
	if (!fs.existsSync(DAEMON_ENTRY_CLONED)) {
		throw new Error(`build completed but entry missing: ${DAEMON_ENTRY_CLONED}`);
	}
	await writeBuildFingerprint(headSha);
	logService.info(`${UPDATE_LOG_HEAD} daemon rebuilt at ${headSha.slice(0, 12)}`);
}

// ---------------------------------------------------------------------------
// Daemon process termination
// ---------------------------------------------------------------------------

const PID_FILE = join(INSRC_DIR, 'daemon.pid');
const SOCK_FILE = join(INSRC_DIR, 'daemon.sock');
/**
 * How long we wait after SIGTERM before escalating to SIGKILL.
 * 5 s was too tight -- the daemon's `shutdown()` waits for
 * `queueDone` (the indexer + cross-file resolver queue) to drain,
 * which can take 17-45 s on a sizable repo. Live testing
 * 2026-04-29 showed every IDE restart triggering a SIGKILL whose
 * silent exit produced no crash trace + lost in-flight chat
 * sessions.
 *
 * 30 s gives typical drains room to finish. The daemon-side
 * `shutdown()` ALSO has its own hard-exit backstop (~20 s) so
 * it force-exits before this grace window expires whenever
 * possible.
 */
const TERMINATE_GRACE_MS = 30_000;
const TERMINATE_POLL_MS = 100;

/**
 * Terminate the daemon process referenced by `~/.insrc/daemon.pid`.
 *
 * Used by the IDE's connect path when a `git pull` advanced the
 * daemon's on-disk code: Node's ESM module cache holds the bytes
 * loaded at process start, so even though the rebuilt files are now
 * on disk, the running daemon can't see them. Killing it here lets
 * the next spawn pick up the fresh code.
 *
 * Sends SIGTERM, polls for exit, escalates to SIGKILL after the
 * grace window, and clears the pid + socket files unconditionally
 * (a stale pid file from a long-dead process would otherwise block
 * the next spawn with "already running -- exiting"). Best-effort:
 * any failure is logged and swallowed -- the only correctness
 * concern is that the next spawn finds no live process holding the
 * socket.
 */
export async function gracefullyTerminateDaemon(logService: ILogService): Promise<void> {
	let pid: number | undefined;
	try {
		const raw = await fs.promises.readFile(PID_FILE, 'utf8');
		const parsed = Number(raw.trim());
		if (Number.isFinite(parsed) && parsed > 0) {
			pid = parsed;
		}
	} catch {
		// No pid file -- no daemon to terminate.
		return;
	}

	if (pid === undefined) {
		await cleanupLockFiles();
		return;
	}

	if (!isProcessAlive(pid)) {
		logService.info(`${UPDATE_LOG_HEAD} stale pid file (${pid} is dead); cleaning up`);
		await cleanupLockFiles();
		return;
	}

	logService.info(`${UPDATE_LOG_HEAD} terminating daemon pid=${pid}`);
	try {
		process.kill(pid, 'SIGTERM');
	} catch (err) {
		logService.warn(`${UPDATE_LOG_HEAD} SIGTERM failed: ${(err as Error).message}`);
	}

	const deadline = Date.now() + TERMINATE_GRACE_MS;
	while (Date.now() < deadline) {
		await new Promise<void>(r => setTimeout(r, TERMINATE_POLL_MS));
		if (!isProcessAlive(pid)) {
			logService.info(`${UPDATE_LOG_HEAD} daemon pid=${pid} exited`);
			await cleanupLockFiles();
			return;
		}
	}

	logService.warn(`${UPDATE_LOG_HEAD} graceful shutdown timed out; SIGKILL pid=${pid}`);
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		/* probably already dead */
	}
	await cleanupLockFiles();
}

function isProcessAlive(pid: number): boolean {
	try {
		// Signal 0 = existence check, no actual signal delivered.
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function cleanupLockFiles(): Promise<void> {
	await Promise.all([
		fs.promises.rm(PID_FILE, { force: true }).catch(() => { }),
		fs.promises.rm(SOCK_FILE, { force: true }).catch(() => { }),
	]);
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
