/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import * as cp from 'child_process';
import * as fs from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ILogService } from '../../log/common/log.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ensureClonedDaemon, gracefullyTerminateDaemon, resolveDaemonEntry } from './insrcDaemonInstaller.js';

// ---------------------------------------------------------------------------
// IInsrcDaemonMainService -- runs in the main process with full Node.js access
// ---------------------------------------------------------------------------

export const IInsrcDaemonMainService = createDecorator<IInsrcDaemonMainService>('insrcDaemonMainService');

export interface IInsrcDaemonMainService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<'connected' | 'disconnected'>;
	readonly onDidReceiveMessage: Event<string>;
	readonly isConnected: boolean;

	connect(): Promise<void>;
	sendMessage(data: string): Promise<void>;
	disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSRC_DIR = join(homedir(), '.insrc');
const SOCK_FILE = join(INSRC_DIR, 'daemon.sock');

const SPAWN_CONNECT_MAX_WAIT_MS = 10_000;
const SPAWN_CONNECT_POLL_MS = 500;

/** Reconnect backoff schedule (seconds) */
const RECONNECT_BACKOFF_S = [0, 5, 5, 10, 10, 10, 10, 10, 30];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class InsrcDaemonMainService extends Disposable implements IInsrcDaemonMainService {
	declare readonly _serviceBrand: undefined;

	private _connected = false;
	private _socket: net.Socket | undefined;
	private _buffer = '';

	private _reconnectAttempt = 0;
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private _intentionalDisconnect = false;

	private readonly _onDidChangeState = this._register(new Emitter<'connected' | 'disconnected'>());
	readonly onDidChangeState: Event<'connected' | 'disconnected'> = this._onDidChangeState.event;

	private readonly _onDidReceiveMessage = this._register(new Emitter<string>());
	readonly onDidReceiveMessage: Event<string> = this._onDidReceiveMessage.event;

	get isConnected(): boolean { return this._connected; }

	constructor(
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
	}

	// ---------------------------------------------------------------------------
	// connect() -- try socket first, auto-spawn detached if not running
	// ---------------------------------------------------------------------------

	async connect(): Promise<void> {
		if (this._connected && this._socket) {
			return;
		}

		// Run the installer FIRST -- not after a failed connect. The
		// pre-fix flow short-circuited the install step when the
		// daemon was already running, which silently turned a user's
		// `git push + IDE restart` workflow into a no-op for daemon
		// updates: the on-disk code stayed at the previously-built
		// SHA, the running daemon kept its (now stale) ESM module
		// cache, and bug fixes that landed since the last cold-start
		// never reached the daemon process.
		//
		// Always run the install/update path, even in dev. The
		// cloned copy is how real users get the daemon; if we skip
		// the install step in dev the clone/pull/build logic rots
		// until the next release. Dev still spawns from the dev
		// build for fast iteration; the clone just validates that
		// the install path still works against the current repo.
		const entry = resolveDaemonEntry();
		const autoUpdate = this.configurationService.getValue<string>('insrc.daemon.autoUpdate') !== 'never';
		const repoUrl = this.configurationService.getValue<string>('insrc.daemon.repoUrl');
		const repoBranch = this.configurationService.getValue<string>('insrc.daemon.repoBranch');
		const installResult = await ensureClonedDaemon(this.logService, autoUpdate, {
			repoUrl: repoUrl ?? '',
			repoBranch: repoBranch ?? '',
		});
		if (!installResult.ok) {
			if (!entry.isDev) {
				throw new Error('Failed to install daemon -- see Output > insrc for details');
			}
			this.logService.warn('[insrc] cloned-daemon install failed; continuing from dev build');
		}

		// If the installer pulled new commits, terminate any running
		// daemon so the next spawn picks up the rebuilt bytes. Node's
		// ESM module cache holds the version that was on disk at
		// process start; rebuilding the files doesn't reload the
		// running daemon, and the pre-fix flow happily kept talking
		// to a daemon process whose loaded modules predated the pull.
		if (installResult.updated) {
			this.logService.info('[insrc] Daemon code updated; restarting daemon to pick up fresh build...');
			await gracefullyTerminateDaemon(this.logService);
			// Detach the IDE-side socket reference too -- the daemon
			// it pointed at is gone.
			this._detachSocket();
			this._setConnected(false);
		} else {
			// No new code on disk -- safe to reuse the existing daemon
			// process if one is up.
			try {
				await this._connectToSocket();
				return;
			} catch {
				// Daemon not running; fall through to spawn.
			}
		}

		this.logService.info(`[insrc] Spawning daemon (${entry.isDev ? 'dev build' : 'cloned install'})...`);
		await this._spawnAndAwaitConnect(entry.path);
	}

	/**
	 * Spawn a detached daemon (if not already running under another
	 * orphaned PID) and poll the socket until we can connect or the
	 * 10 s deadline elapses. Throws on timeout.
	 *
	 * Used by `connect()` (initial bring-up) and the reconnect loop
	 * after a daemon crash. Without the reconnect-loop call, a daemon
	 * that died after the IDE was already connected leaves the IDE
	 * stuck retrying `_connectToSocket()` against a dead socket forever
	 * -- observed live during code-analyzer testing 2026-04-29: the
	 * daemon process disappeared post-completion and the IDE logged
	 * 41 reconnect attempts (and counting) without ever respawning.
	 */
	private async _spawnAndAwaitConnect(entryPath: string): Promise<void> {
		this._spawnDetachedDaemon(entryPath);

		const deadline = Date.now() + SPAWN_CONNECT_MAX_WAIT_MS;
		while (Date.now() < deadline) {
			await new Promise<void>(r => setTimeout(r, SPAWN_CONNECT_POLL_MS));
			try {
				await this._connectToSocket();
				this.logService.info('[insrc] Connected to daemon after spawn');
				return;
			} catch {
				// Not ready yet
			}
		}

		throw new Error('Daemon failed to start within 10 s');
	}

	// ---------------------------------------------------------------------------
	// sendMessage() -- write raw JSON line to socket
	// ---------------------------------------------------------------------------

	async sendMessage(data: string): Promise<void> {
		if (!this._socket || !this._connected) {
			throw new Error('Not connected to daemon');
		}
		this._socket.write(data + '\n');
	}

	// ---------------------------------------------------------------------------
	// disconnect()
	// ---------------------------------------------------------------------------

	async disconnect(): Promise<void> {
		this._intentionalDisconnect = true;
		this._detachSocket();
		this._setConnected(false);
	}

	// ---------------------------------------------------------------------------
	// Socket connection management
	// ---------------------------------------------------------------------------

	private _connectToSocket(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const socket = net.createConnection(SOCK_FILE);

			const onError = (err: NodeJS.ErrnoException) => {
				socket.removeAllListeners();
				socket.destroy();
				reject(err);
			};

			socket.once('error', onError);

			socket.once('connect', () => {
				socket.removeListener('error', onError);
				this._attachSocket(socket);
				resolve();
			});
		});
	}

	private _attachSocket(socket: net.Socket): void {
		this._detachSocket();

		this._socket = socket;
		this._buffer = '';
		this._reconnectAttempt = 0;
		this._setConnected(true);

		socket.on('data', (chunk: Buffer) => {
			this._buffer += chunk.toString();
			this._processBuffer();
		});

		socket.on('error', (err: NodeJS.ErrnoException) => {
			this.logService.warn('[insrc] Socket error:', err.message);
			this._handleDisconnect();
		});

		socket.on('close', () => {
			this._handleDisconnect();
		});
	}

	private _detachSocket(): void {
		if (this._socket) {
			this._socket.removeAllListeners();
			this._socket.destroy();
			this._socket = undefined;
			this._buffer = '';
		}
	}

	private _processBuffer(): void {
		const lines = this._buffer.split('\n');
		this._buffer = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim()) {
				continue;
			}
			// Forward raw JSON lines to the sandbox via event
			this._onDidReceiveMessage.fire(line);
		}
	}

	// ---------------------------------------------------------------------------
	// Disconnect + reconnect
	// ---------------------------------------------------------------------------

	private _handleDisconnect(): void {
		if (!this._connected) {
			return;
		}

		this._setConnected(false);
		this._detachSocket();

		if (!this._intentionalDisconnect) {
			this._scheduleReconnect();
		}
	}

	private _scheduleReconnect(): void {
		if (this._reconnectTimer !== undefined) {
			return;
		}

		const delaySec = this._reconnectAttempt < RECONNECT_BACKOFF_S.length
			? RECONNECT_BACKOFF_S[this._reconnectAttempt]!
			: RECONNECT_BACKOFF_S[RECONNECT_BACKOFF_S.length - 1]!;

		this._reconnectAttempt++;
		this.logService.info(`[insrc] Reconnecting in ${delaySec} s (attempt ${this._reconnectAttempt})...`);

		this._reconnectTimer = setTimeout(async () => {
			this._reconnectTimer = undefined;
			// First try the cheap path -- daemon may just have rebooted
			// or socket may have transiently dropped.
			try {
				await this._connectToSocket();
				this.logService.info('[insrc] Reconnected to daemon');
				return;
			} catch {
				// Daemon is genuinely dead. Fall through to respawn.
			}

			// Daemon process is gone. Without this branch the IDE used
			// to retry `_connectToSocket` against a dead socket forever
			// (observed live: 41+ reconnect attempts after daemon
			// crash). Respawn via the same path `connect()` uses on
			// initial bring-up. Skip the install-update step -- the
			// installer already ran on initial connect and re-running it
			// here on every disconnect would re-pull / re-build on a
			// loop if git fetch ever flakes.
			try {
				const entry = resolveDaemonEntry();
				this.logService.info(`[insrc] Daemon process gone; respawning (${entry.isDev ? 'dev build' : 'cloned install'})...`);
				await this._spawnAndAwaitConnect(entry.path);
				this.logService.info('[insrc] Reconnected to daemon (respawned)');
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logService.warn(`[insrc] Respawn failed: ${msg}; will retry`);
				this._scheduleReconnect();
			}
		}, delaySec * 1000);
	}

	// ---------------------------------------------------------------------------
	// Daemon spawn (detached, survives IDE close)
	// ---------------------------------------------------------------------------

	private _spawnDetachedDaemon(entryPath: string): void {
		// Capture stderr to /tmp/.insrc/daemon.stderr.log so any
		// unhandled-exception trace from Node lands somewhere we can
		// grep post-crash. The previous `stdio: 'ignore'` swallowed
		// the trace entirely -- when the daemon died there was no
		// diagnostic record and we had to guess. Append mode so we
		// keep the trail across respawns.
		//
		// /tmp/.insrc/ is also the daemon's own logDir (PATHS.logDir);
		// daemon startup creates it, but we may spawn before that
		// happens, so ensure it from this side too.
		const stderrLogPath = '/tmp/.insrc/daemon.stderr.log';
		let stderrFd: number | undefined;
		try {
			fs.mkdirSync('/tmp/.insrc', { recursive: true });
			stderrFd = fs.openSync(stderrLogPath, 'a');
		} catch (err) {
			this.logService.warn(`[insrc] could not open daemon stderr log (${stderrLogPath}): ${(err as Error).message}; falling back to ignore`);
		}

		const child = cp.spawn(process.execPath, [entryPath], {
			// Index 0 = stdin, 1 = stdout, 2 = stderr. Pass the open
			// fd for stderr; ignore the rest. spawn dups our fd into
			// the child, so we can close ours immediately after.
			stdio: ['ignore', 'ignore', stderrFd ?? 'ignore'],
			detached: true,
			env: {
				...process.env,
				// process.execPath in an Electron main process is the Electron
				// binary, not Node. Without this flag Electron runs the daemon
				// JS as a full Electron app (renderer, GPU process, ...) and
				// the daemon code never actually executes. Setting it makes
				// the binary behave like plain Node for this child.
				ELECTRON_RUN_AS_NODE: '1',
				INSRC_LOG_LEVEL: 'info',
			},
		});
		if (stderrFd !== undefined) {
			try { fs.closeSync(stderrFd); } catch { /* nothing */ }
		}
		child.unref();
		this.logService.info(`[insrc] Spawned detached daemon process: ${entryPath} (stderr -> ${stderrLogPath})`);
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	private _setConnected(connected: boolean): void {
		if (this._connected !== connected) {
			this._connected = connected;
			this._onDidChangeState.fire(connected ? 'connected' : 'disconnected');
		}
	}

	// ---------------------------------------------------------------------------
	// Dispose -- closes sockets only, daemon keeps running
	// ---------------------------------------------------------------------------

	override dispose(): void {
		this._intentionalDisconnect = true;

		if (this._reconnectTimer !== undefined) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}

		this._detachSocket();
		this._setConnected(false);

		super.dispose();
	}
}
