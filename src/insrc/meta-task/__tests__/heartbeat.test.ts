/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Heartbeat tests. Inject a fake clock + fake interval scheduler so we can
 * step the timer deterministically without sleeping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Heartbeat, composeStatus } from '../heartbeat.js';


class FakeScheduler {
	now = 0;
	cb: (() => void) | undefined = undefined;
	periodMs = 0;
	setInterval = (cb: () => void, ms: number): unknown => {
		this.cb = cb;
		this.periodMs = ms;
		return 'handle';
	};
	clearInterval = (_handle: unknown): void => {
		this.cb = undefined;
	};
	/** Advance the clock by `ms`, firing the scheduled callback in `intervalMs` slices. */
	advance(ms: number): void {
		const end = this.now + ms;
		while (this.now < end) {
			const step = Math.min(this.periodMs, end - this.now);
			this.now += step;
			if (this.cb !== undefined && step === this.periodMs) {
				this.cb();
			}
		}
	}
}


test('Heartbeat: silent run fires tick every intervalMs', () => {
	const sched = new FakeScheduler();
	const ticks: string[] = [];
	const hb = new Heartbeat({
		intervalMs:      1000,
		longThresholdMs: 1_000_000,
		onTick:          s => ticks.push(s),
		now:             () => sched.now,
		setInterval:     sched.setInterval,
		clearInterval:   sched.clearInterval,
	});
	hb.start('initial');
	sched.advance(3000);
	assert.equal(ticks.length, 3);
	assert.equal(ticks[0], 'initial');
	hb.stop();
});


test('Heartbeat: updateStatus suppresses the next tick when called within window', () => {
	const sched = new FakeScheduler();
	const ticks: string[] = [];
	const hb = new Heartbeat({
		intervalMs:      1000,
		longThresholdMs: 1_000_000,
		onTick:          s => ticks.push(s),
		now:             () => sched.now,
		setInterval:     sched.setInterval,
		clearInterval:   sched.clearInterval,
	});
	hb.start('initial');
	sched.advance(500);
	hb.updateStatus('mid');         // resets the silence window
	sched.advance(500);             // 1000ms elapsed since start; tick fires
	// Activity was 500ms ago; tick should NOT fire.
	assert.equal(ticks.length, 0);
	sched.advance(1000);            // another tick window; nothing else has emitted
	assert.equal(ticks.length, 1);
	assert.equal(ticks[0], 'mid');
	hb.stop();
});


test('Heartbeat: long-threshold suffix appended after long silence', () => {
	const sched = new FakeScheduler();
	const ticks: string[] = [];
	const hb = new Heartbeat({
		intervalMs:      100,
		longThresholdMs: 500,
		onTick:          s => ticks.push(s),
		now:             () => sched.now,
		setInterval:     sched.setInterval,
		clearInterval:   sched.clearInterval,
	});
	hb.start('thinking');
	sched.advance(400);  // < threshold; no suffix
	assert.ok(ticks.every(t => !t.includes('consider /abort')));
	sched.advance(200);  // total 600 > threshold; subsequent ticks suffixed
	assert.ok(ticks.at(-1)!.includes('consider /abort'));
	hb.stop();
});


test('Heartbeat: stop() is idempotent', () => {
	const sched = new FakeScheduler();
	const hb = new Heartbeat({
		intervalMs: 100,
		onTick:     () => undefined,
		now:        () => sched.now,
		setInterval:   sched.setInterval,
		clearInterval: sched.clearInterval,
	});
	hb.start('s');
	hb.stop();
	hb.stop();  // no throw
});


test('Heartbeat: start() is idempotent', () => {
	const sched = new FakeScheduler();
	const ticks: string[] = [];
	const hb = new Heartbeat({
		intervalMs: 100,
		onTick:     s => ticks.push(s),
		now:        () => sched.now,
		setInterval:   sched.setInterval,
		clearInterval: sched.clearInterval,
	});
	hb.start('first');
	hb.start('second-ignored');
	sched.advance(100);
	assert.equal(ticks[0], 'first');
	hb.stop();
});


// ---------------------------------------------------------------------------
// composeStatus -- formatting.
// ---------------------------------------------------------------------------

test('composeStatus: substate + elapsed seconds', () => {
	assert.equal(composeStatus({ substate: 'phase-2 task: thinking', elapsedMs: 47_500 }),
		'phase-2 task: thinking (47s)');
});

test('composeStatus: minutes + seconds for >= 60s', () => {
	assert.equal(composeStatus({ substate: 'phase-2 task', elapsedMs: 2 * 60_000 + 7 * 1000 }),
		'phase-2 task (2m 07s)');
});

test('composeStatus: bare elapsed when substate empty', () => {
	assert.equal(composeStatus({ substate: '', elapsedMs: 3_200 }), '(3s)');
});

test('composeStatus: floors fractional seconds', () => {
	assert.equal(composeStatus({ substate: 'x', elapsedMs: 999 }), 'x (0s)');
});
