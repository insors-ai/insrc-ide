/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

// ---------------------------------------------------------------------------
// Stream message types (discriminated union)
// ---------------------------------------------------------------------------

/** Full action metadata as emitted by the daemon. */
export interface DaemonGateAction {
	readonly name: string;
	readonly label?: string;
	readonly hint?: string;
	readonly needsInput?: boolean;
	/**
	 * Phase 5 of plans/access-gate.md: when the daemon offers an
	 * "Approve scope" button on an fs-path / cloud-resource gate it
	 * pre-computes the parent prefix and stamps it here. The
	 * workbench echoes the prefix back via replyToGate; the daemon's
	 * gate dispatcher uses it to call AccessStore.approvePrefix.
	 */
	readonly prefix?: string;
}

export type DaemonStreamMessage =
	| { readonly type: 'delta'; readonly content: string }
	| {
		readonly type: 'gate';
		readonly gateId: string;
		/** Flat action names for backwards-compat. */
		readonly actions: string[];
		/** Rich action objects with labels + hints + needsInput flags. */
		readonly actionDetails?: DaemonGateAction[];
		readonly title: string;
		readonly content: string;
		readonly structured?: Record<string, unknown>;
	}
	| { readonly type: 'progress'; readonly step: string; readonly status: string }
	| { readonly type: 'checkpoint'; readonly sessionId: string; readonly data: unknown }
	| { readonly type: 'context.set'; readonly key: string; readonly value: unknown }
	| { readonly type: 'context.clear'; readonly key: string }
	/**
	 * Item 32b: live-step token stream. Emitted by the daemon's
	 * `executeLlmTask` whenever an LLM step produces output; `done: true`
	 * signals the step finished so the UI can collapse the transient
	 * bubble. Keyed by `(agent, step)` on the UI side.
	 */
	| {
		readonly type: 'liveStep';
		readonly agent: string;
		readonly step: string;
		readonly text: string;
		readonly done?: boolean;
	}
	/**
	 * Todos framework stream event (plans/todo-framework.md Phase 2).
	 * Emitted by every list / item mutation -- the browser-side
	 * `IInsrcTodosService` subscribes to `todos.subscribe` and
	 * dispatches on `kind` to update its cache. `list` carries the
	 * full snapshot so subscribers don't need a follow-up read.
	 */
	| {
		readonly type: 'todos';
		readonly kind: TodoStreamEventKind;
		readonly list: unknown;  // TodoList -- typed loosely to avoid coupling boundaries
	};

/** Kinds emitted on the todos stream. Mirrors daemon-side TodoStreamEventKind. */
export type TodoStreamEventKind =
	| 'listCreated' | 'listUpdated' | 'listArchived' | 'listDeleted'
	| 'itemCreated' | 'itemUpdated' | 'itemRemoved'
	| 'commentAdded' | 'commentUpdated' | 'commentRemoved';

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
