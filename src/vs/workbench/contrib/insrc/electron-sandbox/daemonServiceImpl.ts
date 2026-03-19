/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-import-patterns
import * as net from 'net';
// eslint-disable-next-line local/code-import-patterns
import * as cp from 'child_process';
// eslint-disable-next-line local/code-import-patterns
import { homedir } from 'os';
// eslint-disable-next-line local/code-import-patterns
import { join } from 'path';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInsrcDaemonService, type DaemonStreamMessage, type IInsrcStreamHandle } from '../common/daemonService.js';

// ---------------------------------------------------------------------------
// IPC protocol types (mirrors src/insrc/shared/types.ts)
// ---------------------------------------------------------------------------

interface IpcRequest {
	id: number;
	method: string;
	params: unknown;
	stream?: boolean;
}

interface IpcResponse {
	id: number;
	result?: unknown;
	error?: string;
}

interface IpcStreamMessage {
	id: number;
	stream: string;
	data: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSRC_DIR = join(homedir(), '.insrc');
const SOCK_FILE = join(INSRC_DIR, 'daemon.sock');
const DAEMON_ENTRY = join(INSRC_DIR, 'daemon', 'index.js');

const RPC_TIMEOUT_MS = 30_000;
const STREAM_INACTIVITY_TIMEOUT_MS = 60_000;
const SPAWN_CONNECT_MAX_WAIT_MS = 10_000;
const SPAWN_CONNECT_POLL_MS = 500;

/** Reconnect backoff schedule (seconds), modeled after VS Code's PersistentConnection */
const RECONNECT_BACKOFF_S = [0, 5, 5, 10, 10, 10, 10, 10, 30];

// ---------------------------------------------------------------------------
// Pending request / stream bookkeeping
// ---------------------------------------------------------------------------

interface PendingRpc {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// InsrcStreamHandle - disposable event-based stream
// ---------------------------------------------------------------------------

class InsrcStreamHandle extends Disposable implements IInsrcStreamHandle {
	private readonly _store = this._register(new DisposableStore());

	private readonly _onMessage = this._store.add(new Emitter<DaemonStreamMessage>());
	readonly onMessage: Event<DaemonStreamMessage> = this._onMessage.event;

	private readonly _onDidEnd = this._store.add(new Emitter<void>());
	readonly onDidEnd: Event<void> = this._onDidEnd.event;

	private readonly _onDidError = this._store.add(new Emitter<Error>());
	readonly onDidError: Event<Error> = this._onDidError.event;

	private _inactivityTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		readonly id: number,
		private readonly _onDisposed: (id: number) => void,
	) {
		super();
		this._resetInactivityTimer();
	}

	/** Called by the connection when a stream message arrives */
	handleMessage(msg: IpcStreamMessage): void {
		this._resetInactivityTimer();

		if (msg.stream === 'done') {
			this._onDidEnd.fire();
			this.dispose();
			return;
		}

		if (msg.stream === 'error') {
			const data = msg.data as { error?: string } | undefined;
			this._onDidError.fire(new Error(data?.error ?? 'Stream error'));
			this.dispose();
			return;
		}

		const parsed = this._parseStreamData(msg);
		if (parsed) {
			this._onMessage.fire(parsed);
		}
	}

	/** Called when the underlying connection drops */
	handleConnectionLost(): void {
		this._onDidError.fire(new Error('Connection to daemon lost'));
		this.dispose();
	}

	override dispose(): void {
		if (this._inactivityTimer !== undefined) {
			clearTimeout(this._inactivityTimer);
			this._inactivityTimer = undefined;
		}
		this._onDisposed(this.id);
		super.dispose();
	}

	private _resetInactivityTimer(): void {
		if (this._inactivityTimer !== undefined) {
			clearTimeout(this._inactivityTimer);
		}
		this._inactivityTimer = setTimeout(() => {
			this._onDidError.fire(new Error('Stream inactivity timeout'));
			this.dispose();
		}, STREAM_INACTIVITY_TIMEOUT_MS);
	}

	private _parseStreamData(msg: IpcStreamMessage): DaemonStreamMessage | undefined {
		const data = msg.data as Record<string, unknown> | undefined;
		switch (msg.stream) {
			case 'delta':
				return { type: 'delta', content: String(data?.['content'] ?? '') };
			case 'gate':
				return { type: 'gate', gateId: String(data?.['gateId'] ?? ''), actions: (data?.['actions'] as string[]) ?? [] };
			case 'progress':
				return { type: 'progress', step: String(data?.['step'] ?? ''), status: String(data?.['status'] ?? '') };
			case 'checkpoint':
				return { type: 'checkpoint', sessionId: String(data?.['sessionId'] ?? ''), data: data?.['data'] };
			case 'context.set':
				return { type: 'context.set', key: String(data?.['key'] ?? ''), value: data?.['value'] };
			case 'context.clear':
				return { type: 'context.clear', key: String(data?.['key'] ?? '') };
			default:
				return undefined;
		}
	}
}

// ---------------------------------------------------------------------------
// DaemonService implementation (Electron desktop only)
// ---------------------------------------------------------------------------

export class InsrcDaemonServiceImpl extends Disposable implements IInsrcDaemonService {
	declare readonly _serviceBrand: undefined;

	private _nextId = 1;
	private _connected = false;
	private _socket: net.Socket | undefined;
	private _buffer = '';

	/** Pending RPC responses keyed by request id */
	private readonly _pendingRpcs = new Map<number, PendingRpc>();

	/** Active stream handles keyed by request id */
	private readonly _activeStreams = new Map<number, InsrcStreamHandle>();

	/** Reconnect state */
	private _reconnectAttempt = 0;
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private _intentionalDisconnect = false;

	private readonly _onDidChangeState = this._register(new Emitter<'connected' | 'disconnected'>());
	readonly onDidChangeState: Event<'connected' | 'disconnected'> = this._onDidChangeState.event;

	get isConnected(): boolean { return this._connected; }

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	// ---------------------------------------------------------------------------
	// connect() - try socket first, auto-spawn detached if not running
	// ---------------------------------------------------------------------------

	async connect(): Promise<void> {
		if (this._connected && this._socket) {
			return;
		}

		try {
			await this._connectToSocket();
			return;
		} catch {
			// Daemon not running - spawn it
		}

		this.logService.info('[insrc] Daemon not running, spawning detached process...');
		this._spawnDetachedDaemon();

		// Poll until the socket is available
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
	// rpc() - multiplexed JSON-RPC over persistent connection
	// ---------------------------------------------------------------------------

	async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, token?: CancellationToken): Promise<T> {
		this._ensureSocket();

		const reqId = this._nextId++;
		const req: IpcRequest = { id: reqId, method, params };

		return new Promise<T>((resolve, reject) => {
			// Timeout
			const timer = setTimeout(() => {
				this._pendingRpcs.delete(reqId);
				reject(new Error(`RPC timeout: ${method} (${RPC_TIMEOUT_MS} ms)`));
			}, RPC_TIMEOUT_MS);

			this._pendingRpcs.set(reqId, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer,
			});

			// CancellationToken
			if (token && token !== CancellationToken.None) {
				if (token.isCancellationRequested) {
					clearTimeout(timer);
					this._pendingRpcs.delete(reqId);
					reject(new Error(`RPC cancelled: ${method}`));
					return;
				}
				const onCancel = token.onCancellationRequested(() => {
					clearTimeout(timer);
					this._pendingRpcs.delete(reqId);
					onCancel.dispose();
					reject(new Error(`RPC cancelled: ${method}`));
				});
			}

			this._socket!.write(JSON.stringify(req) + '\n');
		});
	}

	// ---------------------------------------------------------------------------
	// stream() - returns event-based disposable handle
	// ---------------------------------------------------------------------------

	stream(method: string, params: Record<string, unknown>): IInsrcStreamHandle {
		this._ensureSocket();

		const reqId = this._nextId++;
		const handle = new InsrcStreamHandle(reqId, (id) => {
			this._activeStreams.delete(id);
		});

		this._activeStreams.set(reqId, handle);

		const req: IpcRequest = { id: reqId, method, params, stream: true };
		this._socket!.write(JSON.stringify(req) + '\n');

		return handle;
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
		// Tear down any previous socket
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
			try {
				const msg = JSON.parse(line) as IpcResponse | IpcStreamMessage;
				this._dispatchMessage(msg);
			} catch {
				this.logService.warn('[insrc] Invalid JSON from daemon:', line.substring(0, 200));
			}
		}
	}

	private _dispatchMessage(msg: IpcResponse | IpcStreamMessage): void {
		// Stream message - has `stream` field, no `result`/`error`
		if ('stream' in msg && typeof (msg as IpcStreamMessage).stream === 'string') {
			const streamMsg = msg as IpcStreamMessage;
			const handle = this._activeStreams.get(streamMsg.id);
			if (handle) {
				handle.handleMessage(streamMsg);
			}
			return;
		}

		// RPC response
		const res = msg as IpcResponse;
		const pending = this._pendingRpcs.get(res.id);
		if (!pending) {
			return;
		}

		clearTimeout(pending.timer);
		this._pendingRpcs.delete(res.id);

		if (res.error) {
			pending.reject(new Error(res.error));
		} else {
			pending.resolve(res.result);
		}
	}

	// ---------------------------------------------------------------------------
	// Disconnect + reconnect
	// ---------------------------------------------------------------------------

	private _handleDisconnect(): void {
		if (!this._connected) {
			return; // Already handling
		}

		this._setConnected(false);
		this._detachSocket();

		// Reject all pending RPCs
		for (const [id, pending] of this._pendingRpcs) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Connection to daemon lost'));
			this._pendingRpcs.delete(id);
		}

		// Notify all active streams
		for (const [, handle] of this._activeStreams) {
			handle.handleConnectionLost();
		}

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

	private _ensureSocket(): void {
		if (!this._socket || !this._connected) {
			throw new Error('Not connected to daemon - call connect() first');
		}
	}

	private _setConnected(connected: boolean): void {
		if (this._connected !== connected) {
			this._connected = connected;
			this._onDidChangeState.fire(connected ? 'connected' : 'disconnected');
		}
	}

	// ---------------------------------------------------------------------------
	// Dispose - closes sockets only, daemon keeps running
	// ---------------------------------------------------------------------------

	override dispose(): void {
		this._intentionalDisconnect = true;

		if (this._reconnectTimer !== undefined) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}

		// Reject pending RPCs
		for (const [, pending] of this._pendingRpcs) {
			clearTimeout(pending.timer);
			pending.reject(new Error('DaemonService disposed'));
		}
		this._pendingRpcs.clear();

		// Dispose active streams
		for (const [, handle] of this._activeStreams) {
			handle.dispose();
		}
		this._activeStreams.clear();

		this._detachSocket();
		this._setConnected(false);

		super.dispose();
	}
}
