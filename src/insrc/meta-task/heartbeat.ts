/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Step-level heartbeat for long-running meta-task steps.
 *
 * Why: cloud LLM calls can go silent for minutes (long thinking, tool execution). Without
 * periodic IPC traffic the user can't tell a working step from a hung daemon, and some IPC
 * subscribers eventually treat the channel as stalled. The orchestrator runs a `Heartbeat`
 * per active step that emits a `progress` event every 30 s whenever nothing else has
 * emitted within the window.
 *
 * Design ref: [`design/meta-tasks.html`](../../../design/meta-tasks.html) §7.3.
 *
 * Contract:
 *   - `start(initialStatus)` opens the timer; first tick fires after `intervalMs`.
 *   - `updateStatus(s)` resets the silence window and parks `s` as the latest known
 *     substate -- any other emission (liveStep chunk, tool exit, etc.) should call this
 *     to suppress the next would-be heartbeat.
 *   - `stop()` clears the timer; safe to call multiple times.
 *   - At `longThresholdMs` of accumulated silence, the status string is suffixed with
 *     ` -- consider /abort` so the user knows the step is past the soft long-step bound.
 *     Informational only -- nothing automatic happens.
 *
 * No hidden state machine -- just two timestamps and a setInterval.
 */

export interface HeartbeatOpts {
	/** Interval between ticks while silent. Default 30_000 ms. */
	readonly intervalMs?: number | undefined;
	/** Silence duration past which the status string gains the "consider /abort"
	 *  suffix. Default 600_000 ms (10 minutes). */
	readonly longThresholdMs?: number | undefined;
	/** Sink for tick events. Receives the current status string (possibly with
	 *  the long-threshold suffix appended). */
	readonly onTick: (status: string) => void;
	/** Wall-clock source. Override in tests. */
	readonly now?: (() => number) | undefined;
	/** Timer scheduler. Override in tests (FakeTimers). */
	readonly setInterval?: ((cb: () => void, ms: number) => unknown) | undefined;
	readonly clearInterval?: ((handle: unknown) => void) | undefined;
}

const DEFAULT_INTERVAL_MS       = 30_000;
const DEFAULT_LONG_THRESHOLD_MS = 10 * 60_000;
const LONG_SUFFIX               = ' -- consider /abort';

export class Heartbeat {
	private readonly _intervalMs:      number;
	private readonly _longThresholdMs: number;
	private readonly _onTick:          (status: string) => void;
	private readonly _now:             () => number;
	private readonly _setInterval:     (cb: () => void, ms: number) => unknown;
	private readonly _clearInterval:   (handle: unknown) => void;

	private _handle: unknown = undefined;
	private _status: string  = '';
	/** Wall-clock of the last activity (start or updateStatus). Used to compute
	 *  silence duration for the long-threshold suffix. */
	private _lastActivity: number = 0;
	/** True between start() and stop(). */
	private _running: boolean = false;

	constructor(opts: HeartbeatOpts) {
		this._intervalMs      = opts.intervalMs      ?? DEFAULT_INTERVAL_MS;
		this._longThresholdMs = opts.longThresholdMs ?? DEFAULT_LONG_THRESHOLD_MS;
		this._onTick          = opts.onTick;
		this._now             = opts.now             ?? (() => Date.now());
		// Cast to allow the standard library setInterval/clearInterval to substitute
		// the local typed wrappers; runtime types align on both Node + the fake timer.
		this._setInterval     = opts.setInterval     ?? ((cb: () => void, ms: number) => setInterval(cb, ms) as unknown);
		this._clearInterval   = opts.clearInterval   ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
	}

	start(initialStatus: string): void {
		if (this._running) {
			return;
		}
		this._running     = true;
		this._status      = initialStatus;
		this._lastActivity = this._now();
		this._handle = this._setInterval(() => this._tick(), this._intervalMs);
	}

	updateStatus(status: string): void {
		this._status       = status;
		this._lastActivity = this._now();
	}

	stop(): void {
		if (!this._running) {
			return;
		}
		this._running = false;
		if (this._handle !== undefined) {
			this._clearInterval(this._handle);
			this._handle = undefined;
		}
	}

	private _tick(): void {
		// updateStatus could land between ticks; if anything has emitted within
		// the past `intervalMs - 1` we skip this tick to avoid double-emitting.
		// We measure "silence" from `_lastActivity`, not from "last tick", so the
		// tick is a no-op when the host loop has been emitting on its own cadence.
		const elapsedSinceActivity = this._now() - this._lastActivity;
		if (elapsedSinceActivity < this._intervalMs) {
			return;
		}
		const status = elapsedSinceActivity >= this._longThresholdMs
			? this._status + LONG_SUFFIX
			: this._status;
		// Fire the tick. We do NOT reset _lastActivity here -- the tick is the
		// heartbeat, not "activity", so consecutive silent windows keep
		// crossing the long-threshold once met.
		this._onTick(status);
	}
}


// ---------------------------------------------------------------------------
// Status-string composer -- one helper so every emission across the
// orchestrator uses the same shape. Substate + elapsed time (always honest).
// ---------------------------------------------------------------------------

export interface StatusOpts {
	readonly substate: string;          // e.g. "phase-2 task: thinking"
	readonly elapsedMs: number;         // wall-clock since step start
}

/**
 * Compose the heartbeat / progress status string. Format:
 *
 *     "<substate> (<elapsed>)"
 *
 * Elapsed is rendered as integer seconds for < 60 s and `Mm SSs` thereafter.
 * Never emits filler ("still working..." etc.) -- if `substate` is empty,
 * only the elapsed counter is shown so the user sees the bare truth.
 */
export function composeStatus(opts: StatusOpts): string {
	const elapsed = formatElapsed(opts.elapsedMs);
	if (opts.substate.length === 0) {
		return `(${elapsed})`;
	}
	return `${opts.substate} (${elapsed})`;
}

function formatElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) {
		return `${totalSec}s`;
	}
	const mins = Math.floor(totalSec / 60);
	const secs = totalSec % 60;
	return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}
