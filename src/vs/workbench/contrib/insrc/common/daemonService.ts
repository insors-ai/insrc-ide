/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

export interface StreamDelta {
	type: string;
	content?: string;
	data?: Record<string, unknown>;
}

export const IInsrcDaemonService = createDecorator<IInsrcDaemonService>('insrcDaemonService');

export interface IInsrcDaemonService {
	readonly _serviceBrand: undefined;

	/** Connection state */
	readonly onDidChangeState: Event<'connected' | 'disconnected'>;
	readonly isConnected: boolean;

	/** JSON-RPC call */
	rpc<T>(method: string, params?: Record<string, unknown>): Promise<T>;

	/** Streaming RPC (for chat, brainstorm, etc.) */
	stream(method: string, params: Record<string, unknown>): AsyncIterable<StreamDelta>;

	/** Start/stop daemon lifecycle */
	ensureDaemon(): Promise<void>;
	stopDaemon(): Promise<void>;
}
