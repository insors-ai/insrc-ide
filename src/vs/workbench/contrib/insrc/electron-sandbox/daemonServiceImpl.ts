/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
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

const RPC_TIMEOUT_MS = 30_000;
// Long-running cloud agent turns (planner loops, delegate plan-execute
// chains, large codegen validations) can genuinely stall mid-step for
// many minutes. A 30-minute window is long enough that real work rarely
// trips it but short enough that a truly-dead stream doesn't leave the
// UI stuck indefinitely. On fire, the chat service tears down the full
// session (same path as pane-close / cancel button) since a stream that
// hasn't emitted for 30 minutes is effectively dead.
const STREAM_INACTIVITY_TIMEOUT_MS = 1_800_000;

// ---------------------------------------------------------------------------
// Pending request / stream bookkeeping
// ---------------------------------------------------------------------------

interface PendingRpc {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// InsrcStreamHandle -- disposable event-based stream
// ---------------------------------------------------------------------------

class InsrcStreamHandle extends Disposable implements IInsrcStreamHandle {

	private readonly _onMessage = this._register(new Emitter<DaemonStreamMessage>());
	readonly onMessage: Event<DaemonStreamMessage> = this._onMessage.event;

	private readonly _onDidEnd = this._register(new Emitter<void>());
	readonly onDidEnd: Event<void> = this._onDidEnd.event;

	private readonly _onDidError = this._register(new Emitter<Error>());
	readonly onDidError: Event<Error> = this._onDidError.event;

	private _inactivityTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		readonly id: number,
		private readonly _onDisposed: (id: number) => void,
	) {
		super();
		this._resetInactivityTimer();
	}

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
				// Daemon sends { text, format }, not { content }
				return { type: 'delta', content: String(data?.['text'] ?? data?.['content'] ?? '') };
			case 'gate': {
				const actions = data?.['actions'];
				const actionNames: string[] = [];
				const actionDetails: Array<{ name: string; label?: string; hint?: string; needsInput?: boolean; prefix?: string }> = [];
				if (Array.isArray(actions)) {
					for (const a of actions) {
						if (typeof a === 'string') {
							actionNames.push(a);
							actionDetails.push({ name: a });
						} else if (a && typeof a === 'object') {
							const o = a as Record<string, unknown>;
							const name = typeof o['name'] === 'string' ? o['name'] as string : '';
							if (!name) { continue; }
							actionNames.push(name);
							const entry: { name: string; label?: string; hint?: string; needsInput?: boolean; prefix?: string } = { name };
							if (typeof o['label'] === 'string') { entry.label = o['label'] as string; }
							if (typeof o['hint'] === 'string') { entry.hint = o['hint'] as string; }
							if (o['needsInput'] === true) { entry.needsInput = true; }
							if (typeof o['prefix'] === 'string') { entry.prefix = o['prefix'] as string; }
							actionDetails.push(entry);
						}
					}
				}
				const structured = data?.['structured'] as Record<string, unknown> | undefined;
				return {
					type: 'gate',
					gateId: String(data?.['gateId'] ?? ''),
					actions: actionNames,
					actionDetails,
					title: String(data?.['title'] ?? ''),
					content: String(data?.['content'] ?? ''),
					...(structured ? { structured } : {}),
				};
			}
			case 'progress':
				// Daemon sends { message }, not { step, status }
				return { type: 'progress', step: String(data?.['step'] ?? data?.['message'] ?? ''), status: String(data?.['status'] ?? '') };
			case 'liveStep':
				// Item 32b: forward agent/step metadata so the chat panel can
				// key transient bubbles by (agent, step) and collapse them
				// when `done: true` arrives.
				return {
					type: 'liveStep',
					agent: String(data?.['agent'] ?? ''),
					step: String(data?.['step'] ?? ''),
					text: String(data?.['text'] ?? ''),
					...(data?.['done'] === true ? { done: true } : {}),
				};
			case 'checkpoint':
				return { type: 'checkpoint', sessionId: String(data?.['sessionId'] ?? ''), data: data?.['data'] };
			case 'context.set':
				return { type: 'context.set', key: String(data?.['key'] ?? ''), value: data?.['value'] };
			case 'context.clear':
				return { type: 'context.clear', key: String(data?.['key'] ?? '') };
			case 'todos': {
				const kindRaw = data?.['kind'];
				const list = data?.['list'];
				if (typeof kindRaw !== 'string') {
					return undefined;
				}
				switch (kindRaw) {
					case 'listCreated': case 'listUpdated': case 'listArchived': case 'listDeleted':
					case 'itemCreated': case 'itemUpdated': case 'itemRemoved':
					case 'commentAdded': case 'commentUpdated': case 'commentRemoved':
						return { type: 'todos', kind: kindRaw, list };
					default:
						return undefined;
				}
			}
			case 'handoff':
				// External-agent handoff event (plans/external-agent-integration.md
				// Phase 2b). The daemon's `handoff.run` IPC carries a 9-variant
				// HandoffEvent on `msg.data`; the typed discriminated union lives
				// in common/handoffService.ts, so we carry the payload opaquely
				// here and the workbench-side handoff service dispatches on it.
				return { type: 'handoff', event: data };
			case 'assertion-confirm': {
				// memory-context M1.6.b. Daemon sends
				// `{ kind: 'pending', payload: PendingConfirmEvent }`.
				// Drop frames missing required fields rather than
				// rendering an empty toast.
				const payload = data?.['payload'] as Record<string, unknown> | undefined;
				if (typeof payload?.['key'] !== 'string' ||
					typeof payload?.['turnId'] !== 'string' ||
					typeof payload?.['subject'] !== 'string' ||
					typeof payload?.['canonicalText'] !== 'string') {
					return undefined;
				}
				return {
					type: 'assertion-confirm',
					key: payload['key'] as string,
					turnId: payload['turnId'] as string,
					subject: payload['subject'] as string,
					canonicalText: payload['canonicalText'] as string,
					rawSpan: typeof payload['rawSpan'] === 'string' ? payload['rawSpan'] as string : payload['canonicalText'] as string,
					confidence: typeof payload['confidence'] === 'number' ? payload['confidence'] as number : 0.6,
					polarity: typeof payload['polarity'] === 'string' ? payload['polarity'] as string : 'preference',
					scope: typeof payload['scope'] === 'string' ? payload['scope'] as string : 'workspace',
				};
			}
			default:
				return undefined;
		}
	}
}

// ---------------------------------------------------------------------------
// DaemonService implementation (sandbox -- proxies to main process)
// ---------------------------------------------------------------------------

export class InsrcDaemonServiceImpl extends Disposable implements IInsrcDaemonService {
	declare readonly _serviceBrand: undefined;

	private _nextId = 1;
	private _connected = false;

	private readonly _pendingRpcs = new Map<number, PendingRpc>();
	private readonly _activeStreams = new Map<number, InsrcStreamHandle>();

	private readonly _onDidChangeState = this._register(new Emitter<'connected' | 'disconnected'>());
	readonly onDidChangeState: Event<'connected' | 'disconnected'> = this._onDidChangeState.event;

	private readonly _channel: IChannel;

	get isConnected(): boolean { return this._connected; }

	constructor(
		@ILogService private readonly logService: ILogService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		this._channel = mainProcessService.getChannel('insrcDaemon');

		// Listen for state changes from main process
		this._register(this._channel.listen<'connected' | 'disconnected'>('onDidChangeState')(state => {
			const wasConnected = this._connected;
			this._connected = state === 'connected';
			if (wasConnected !== this._connected) {
				this.logService.info('[insrc] Daemon state changed:', state);
				this._onDidChangeState.fire(state);

				if (!this._connected) {
					this._handleDisconnect();
				}
			}
		}));

		// Listen for raw messages from main process and dispatch
		this._register(this._channel.listen<string>('onDidReceiveMessage')(line => {
			try {
				this.logService.debug('[insrc] raw message from daemon:', line.substring(0, 300));
				const msg = JSON.parse(line) as IpcResponse | IpcStreamMessage;
				this._dispatchMessage(msg);
			} catch {
				this.logService.warn('[insrc] Invalid JSON from daemon:', line.substring(0, 200));
			}
		}));

		// Auto-connect on instantiation
		this.connect().then(
			() => this.logService.info('[insrc] Auto-connected to daemon'),
			(err) => this.logService.warn('[insrc] Auto-connect failed, will retry on demand:', (err as Error).message),
		);
	}

	// ---------------------------------------------------------------------------
	// connect() -- delegates to main process
	// ---------------------------------------------------------------------------

	async connect(): Promise<void> {
		await this._channel.call<void>('connect', []);
		this._connected = true;
		this._onDidChangeState.fire('connected');
	}

	// ---------------------------------------------------------------------------
	// rpc() -- send request via main process, dispatch response locally
	// ---------------------------------------------------------------------------

	async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, token?: CancellationToken): Promise<T> {
		if (!this._connected) {
			throw new Error('Not connected to daemon -- call connect() first');
		}

		const reqId = this._nextId++;
		const req: IpcRequest = { id: reqId, method, params };

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pendingRpcs.delete(reqId);
				reject(new Error(`RPC timeout: ${method} (${RPC_TIMEOUT_MS} ms)`));
			}, RPC_TIMEOUT_MS);

			this._pendingRpcs.set(reqId, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer,
			});

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

			// Send via main process
			this._channel.call<void>('sendMessage', [JSON.stringify(req)]);
		});
	}

	// ---------------------------------------------------------------------------
	// stream() -- returns event-based disposable handle
	// ---------------------------------------------------------------------------

	stream(method: string, params: Record<string, unknown>): IInsrcStreamHandle {
		if (!this._connected) {
			throw new Error('Not connected to daemon -- call connect() first');
		}

		const reqId = this._nextId++;
		const handle = new InsrcStreamHandle(reqId, (id) => {
			this._activeStreams.delete(id);
		});

		this._activeStreams.set(reqId, handle);

		const req: IpcRequest = { id: reqId, method, params, stream: true };
		this.logService.info('[insrc] stream() sending id=' + reqId + ' method=' + method + ' activeStreams=' + this._activeStreams.size);
		this._channel.call<void>('sendMessage', [JSON.stringify(req)]);

		return handle;
	}

	// ---------------------------------------------------------------------------
	// Message dispatch
	// ---------------------------------------------------------------------------

	private _dispatchMessage(msg: IpcResponse | IpcStreamMessage): void {
		if ('stream' in msg && typeof (msg as IpcStreamMessage).stream === 'string') {
			const streamMsg = msg as IpcStreamMessage;
			this.logService.debug('[insrc] stream msg id=' + streamMsg.id + ' stream=' + streamMsg.stream + ' activeStreams=' + this._activeStreams.size);
			const handle = this._activeStreams.get(streamMsg.id);
			if (handle) {
				handle.handleMessage(streamMsg);
			} else {
				this.logService.warn('[insrc] no stream handle for id=' + streamMsg.id);
			}
			return;
		}

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

	private _handleDisconnect(): void {
		for (const [id, pending] of this._pendingRpcs) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Connection to daemon lost'));
			this._pendingRpcs.delete(id);
		}

		for (const [, handle] of this._activeStreams) {
			handle.handleConnectionLost();
		}
	}

	// ---------------------------------------------------------------------------
	// Dispose
	// ---------------------------------------------------------------------------

	override dispose(): void {
		for (const [, pending] of this._pendingRpcs) {
			clearTimeout(pending.timer);
			pending.reject(new Error('DaemonService disposed'));
		}
		this._pendingRpcs.clear();

		for (const [, handle] of this._activeStreams) {
			handle.dispose();
		}
		this._activeStreams.clear();

		this._channel.call<void>('disconnect', []);

		super.dispose();
	}
}
