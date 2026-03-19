/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInsrcDaemonService, type StreamDelta } from '../common/daemonService.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';

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
// DaemonService implementation (Electron desktop only)
//
// Uses dynamic require() for Node.js modules since electron-sandbox
// has access to Node.js APIs in the desktop build.
// ---------------------------------------------------------------------------

export class InsrcDaemonServiceImpl extends Disposable implements IInsrcDaemonService {
	declare readonly _serviceBrand: undefined;

	private _nextId = 1;
	private _connected = false;
	private _sockFile: string;

	private readonly _onDidChangeState = this._register(new Emitter<'connected' | 'disconnected'>());
	readonly onDidChangeState: Event<'connected' | 'disconnected'> = this._onDidChangeState.event;

	get isConnected(): boolean { return this._connected; }

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService environmentService: IEnvironmentService,
	) {
		super();
		const path = globalThis._VSCODE_NODE_MODULES['path'] as typeof import('path');
		const os = globalThis._VSCODE_NODE_MODULES['os'] as typeof import('os');
		this._sockFile = path.join(os.homedir(), '.insrc', 'daemon.sock');
	}

	// ---------------------------------------------------------------------------
	// JSON-RPC (single request -> response)
	// ---------------------------------------------------------------------------

	async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const net = globalThis._VSCODE_NODE_MODULES['net'] as typeof import('net');

		return new Promise<T>((resolve, reject) => {
			const socket = net.createConnection(this._sockFile);
			let buffer = '';
			const reqId = this._nextId++;

			socket.on('connect', () => {
				this._setConnected(true);
				const req: IpcRequest = { id: reqId, method, params };
				socket.write(JSON.stringify(req) + '\n');
			});

			socket.on('data', (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}
					try {
						const res = JSON.parse(line) as IpcResponse;
						socket.end();
						if (res.error) {
							reject(new Error(res.error));
						} else {
							resolve(res.result as T);
						}
					} catch {
						socket.end();
						reject(new Error('Invalid response from daemon'));
					}
				}
			});

			socket.on('error', (err: NodeJS.ErrnoException) => {
				this._setConnected(false);
				if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
					reject(new Error('Daemon is not running'));
				} else {
					reject(err);
				}
			});
		});
	}

	// ---------------------------------------------------------------------------
	// Streaming RPC (request -> multiple stream messages -> done)
	// ---------------------------------------------------------------------------

	async *stream(method: string, params: Record<string, unknown>): AsyncIterable<StreamDelta> {
		const net = globalThis._VSCODE_NODE_MODULES['net'] as typeof import('net');
		const socket = net.createConnection(this._sockFile);
		const reqId = this._nextId++;

		const pending: Array<StreamDelta | Error | null> = [];
		let resolve: (() => void) | null = null;

		const enqueue = (item: StreamDelta | Error | null): void => {
			pending.push(item);
			if (resolve) {
				resolve();
				resolve = null;
			}
		};

		const waitForItem = (): Promise<void> => {
			if (pending.length > 0) {
				return Promise.resolve();
			}
			return new Promise<void>(r => { resolve = r; });
		};

		let buffer = '';

		socket.on('connect', () => {
			this._setConnected(true);
			const req: IpcRequest = { id: reqId, method, params, stream: true };
			socket.write(JSON.stringify(req) + '\n');
		});

		socket.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}
				try {
					const msg = JSON.parse(line) as IpcStreamMessage | IpcResponse;

					if ('result' in msg || 'error' in msg) {
						const res = msg as IpcResponse;
						if (res.error) {
							enqueue(new Error(res.error));
						}
						enqueue(null);
						return;
					}

					const streamMsg = msg as IpcStreamMessage;
					if (streamMsg.stream === 'done') {
						enqueue(null);
					} else if (streamMsg.stream === 'error') {
						const data = streamMsg.data as { error?: string };
						enqueue(new Error(data?.error ?? 'Stream error'));
					} else {
						enqueue({
							type: streamMsg.stream,
							data: streamMsg.data as Record<string, unknown>,
						});
					}
				} catch {
					enqueue(new Error('Invalid stream message from daemon'));
				}
			}
		});

		socket.on('error', (err: NodeJS.ErrnoException) => {
			this._setConnected(false);
			enqueue(err);
		});

		socket.on('close', () => {
			enqueue(null);
		});

		try {
			while (true) {
				await waitForItem();
				const item = pending.shift();
				if (item === null || item === undefined) {
					break;
				}
				if (item instanceof Error) {
					throw item;
				}
				yield item;
			}
		} finally {
			socket.end();
		}
	}

	// ---------------------------------------------------------------------------
	// Daemon lifecycle
	// ---------------------------------------------------------------------------

	async ensureDaemon(): Promise<void> {
		try {
			await this.rpc('daemon.status');
			this.logService.info('[insrc] Daemon already running');
			return;
		} catch {
			// Not running, start it
		}

		this.logService.info('[insrc] Starting daemon...');

		const cp = globalThis._VSCODE_NODE_MODULES['child_process'] as typeof import('child_process');
		const path = globalThis._VSCODE_NODE_MODULES['path'] as typeof import('path');
		const os = globalThis._VSCODE_NODE_MODULES['os'] as typeof import('os');

		// In the bundled IDE, the compiled backend is at resources/insrc/daemon/index.js
		const insrcDir = path.join(os.homedir(), '.insrc');
		const daemonEntry = path.join(insrcDir, 'daemon', 'index.js');

		const child = cp.spawn(process.execPath, [daemonEntry], {
			stdio: 'ignore',
			detached: true,
			env: {
				...process.env,
				INSRC_LOG_LEVEL: 'info',
			},
		});

		child.unref();

		const maxRetries = 20;
		for (let i = 0; i < maxRetries; i++) {
			await new Promise(r => setTimeout(r, 500));
			try {
				await this.rpc('daemon.status');
				this.logService.info('[insrc] Daemon started');
				return;
			} catch {
				// Not ready yet
			}
		}

		throw new Error('Daemon failed to start within 10s');
	}

	async stopDaemon(): Promise<void> {
		try {
			await this.rpc('daemon.shutdown');
			this.logService.info('[insrc] Daemon shutdown requested');
		} catch {
			this.logService.warn('[insrc] Could not send shutdown signal');
		}
		this._setConnected(false);
	}

	// ---------------------------------------------------------------------------
	// Internal
	// ---------------------------------------------------------------------------

	private _setConnected(connected: boolean): void {
		if (this._connected !== connected) {
			this._connected = connected;
			this._onDidChangeState.fire(connected ? 'connected' : 'disconnected');
		}
	}

	override dispose(): void {
		this.stopDaemon().catch(() => { /* best effort */ });
		super.dispose();
	}
}
