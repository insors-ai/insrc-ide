/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

// ---------------------------------------------------------------------------
// Stream message types (discriminated union)
// ---------------------------------------------------------------------------

export type DaemonStreamMessage =
	| { readonly type: 'delta'; readonly content: string }
	| { readonly type: 'gate'; readonly gateId: string; readonly actions: string[] }
	| { readonly type: 'progress'; readonly step: string; readonly status: string }
	| { readonly type: 'checkpoint'; readonly sessionId: string; readonly data: unknown }
	| { readonly type: 'context.set'; readonly key: string; readonly value: unknown }
	| { readonly type: 'context.clear'; readonly key: string };

// ---------------------------------------------------------------------------
// Stream handle - event-based, disposable
// ---------------------------------------------------------------------------

export interface IInsrcStreamHandle extends IDisposable {
	readonly onMessage: Event<DaemonStreamMessage>;
	readonly onDidEnd: Event<void>;
	readonly onDidError: Event<Error>;
}

// ---------------------------------------------------------------------------
// DaemonService
// ---------------------------------------------------------------------------

export const IInsrcDaemonService = createDecorator<IInsrcDaemonService>('insrcDaemonService');

export interface IInsrcDaemonService {
	readonly _serviceBrand: undefined;

	/** Connection state */
	readonly onDidChangeState: Event<'connected' | 'disconnected'>;
	readonly isConnected: boolean;

	/**
	 * Connect to the daemon. If not running, auto-spawns a detached process
	 * that survives IDE shutdown, then connects.
	 */
	connect(): Promise<void>;

	/**
	 * JSON-RPC call over the persistent connection.
	 * Rejects with TimeoutError after 30 s (default) or on cancellation.
	 */
	rpc<T>(method: string, params?: Record<string, unknown>, token?: CancellationToken): Promise<T>;

	/**
	 * Streaming RPC - returns a disposable handle that fires events.
	 * Caller must dispose the handle when done to free the stream slot.
	 */
	stream(method: string, params: Record<string, unknown>): IInsrcStreamHandle;
}
