/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import * as cp from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ILogService } from '../../log/common/log.js';

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
const DAEMON_ENTRY = join(INSRC_DIR, 'daemon', 'index.js');

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

		try {
			await this._connectToSocket();
			return;
		} catch {
			// Daemon not running
		}

		this.logService.info('[insrc] Daemon not running, spawning detached process...');
		this._spawnDetachedDaemon();

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
			try {
				await this._connectToSocket();
				this.logService.info('[insrc] Reconnected to daemon');
			} catch {
				this._scheduleReconnect();
			}
		}, delaySec * 1000);
	}

	// ---------------------------------------------------------------------------
	// Daemon spawn (detached, survives IDE close)
	// ---------------------------------------------------------------------------

	private _spawnDetachedDaemon(): void {
		const child = cp.spawn(process.execPath, [DAEMON_ENTRY], {
			stdio: 'ignore',
			detached: true,
			env: {
				...process.env,
				INSRC_LOG_LEVEL: 'info',
			},
		});
		child.unref();
		this.logService.info('[insrc] Spawned detached daemon process');
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
