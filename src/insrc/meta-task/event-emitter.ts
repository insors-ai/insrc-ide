/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Emission shim that maps orchestrator activity onto the existing chat-panel
 * surfaces (design §10). Mirrors the code-analyzer orchestrator's emission set:
 *
 *   - `liveStep({agent, step, text, done?})` -> chat activity-console bubble
 *   - `progress({step, status})`             -> always-visible top progress bar
 *   - `todos` mutations via TodosApi         -> TodoList workbench pane
 *
 * Gates land in M5 (abort gate framework). For M2 the plan-approval is auto-accepted.
 *
 * Plan ref: [`plans/meta-tasks.md`](../../../plans/meta-tasks.md) M2.4.
 */

import type { TodosApi } from '../daemon/todos-api.js';
import type { IpcStreamKind } from '../shared/types.js';
import type { Heartbeat } from './heartbeat.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('meta-task:emit');

/** Bare shape of an IPC stream message; the daemon's `IpcServer` fills in `id`. */
export interface OutboundMessage {
	readonly stream: IpcStreamKind;
	readonly data:   unknown;
}

export type Send = (msg: OutboundMessage) => void;


// ---------------------------------------------------------------------------
// MetaTaskEmitter -- one per orchestrator run. Holds the send fn + TodosApi
// scoped to the meta-task family.
// ---------------------------------------------------------------------------

export interface MetaTaskEmitterOpts {
	readonly send:  Send;
	readonly todos: TodosApi;
	/** Optional heartbeat that should be poked on every emission so it
	 *  doesn't fire redundant ticks. Wired in M2.5 once the orchestrator
	 *  instantiates a Heartbeat per active step. */
	readonly heartbeat?: Heartbeat | undefined;
}

export class MetaTaskEmitter {
	readonly todos: TodosApi;

	private readonly _send: Send;
	private readonly _heartbeat: Heartbeat | undefined;
	private _aborted = false;

	constructor(opts: MetaTaskEmitterOpts) {
		this._send      = opts.send;
		this.todos      = opts.todos;
		this._heartbeat = opts.heartbeat;
	}

	/** Stop emitting -- called when the orchestrator's abort signal fires. */
	abort(): void {
		this._aborted = true;
	}

	get aborted(): boolean {
		return this._aborted;
	}

	// -- liveStep --

	/**
	 * Emit a token chunk into an activity-console bubble.
	 *
	 * @param step   The bubble label. Convention:
	 *               `meta-task:<template> / <stepName>: <substate>`
	 *               (e.g. `meta-task:review / R1 analyze: phase-2 task`).
	 * @param text   The token chunk to append. Empty string + `done: true`
	 *               removes the bubble.
	 * @param done   When true, the bubble is removed from chat after this
	 *               emission. Match the bubble lifetime to the step's phase.
	 */
	liveStep(step: string, text: string, done = false): void {
		if (this._aborted) { return; }
		this._heartbeat?.updateStatus(step);
		const data: { agent: string; step: string; text: string; done?: true } = {
			agent: 'meta-task',
			step,
			text,
		};
		if (done) { data.done = true; }
		this._send({ stream: 'liveStep', data });
	}

	// -- progress (top progress bar) --

	/**
	 * Emit a `{step, status}` event to the always-visible top progress bar.
	 * Used for: lifecycle stage transitions, retry-counter updates, heartbeats.
	 */
	progress(step: string, status: string): void {
		if (this._aborted) { return; }
		this._heartbeat?.updateStatus(`${step}: ${status}`);
		this._send({ stream: 'progress', data: { step, status } });
	}

	// -- done / error -- terminal stream signals --

	/** Signal successful run end. */
	done(payload: Record<string, unknown> = {}): void {
		if (this._aborted) { return; }
		this._send({ stream: 'done', data: payload });
	}

	/** Signal terminal error. `recoverable` indicates whether resume is possible. */
	error(message: string, recoverable = false): void {
		// Always emit error -- even past abort the caller wants the cause.
		try {
			this._send({ stream: 'error', data: { error: message, recoverable } });
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'error emit failed');
		}
	}
}
