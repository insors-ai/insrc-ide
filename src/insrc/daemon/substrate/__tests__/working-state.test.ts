/**
 * Unit tests for the in-process working-state ledger -- P0.4.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkingStateLedger } from '../working-state.js';
import { WorkingStateHardCapError } from '../types.js';
import type { LedgerSource, WorkingStateEvent, DistillTarget } from '../working-state.js';

// ---------------------------------------------------------------------------

const SUB_CALL: LedgerSource = { kind: 'sub-call', skillId: 'skill:test', callRef: 'call-1' };
const OBS: LedgerSource = { kind: 'observation' };

const PIN_TARGET: DistillTarget = {
	owner: 'skill:test',
	namespace: 'cache',
	key: 'k',
	kind: 'fact',
};

// ---------------------------------------------------------------------------
// append + get
// ---------------------------------------------------------------------------

test('working-state: append + get round-trip', () => {
	const ledger = createWorkingStateLedger();
	const ref = ledger.append({
		source: SUB_CALL,
		payload: { found: true },
		claims: ['locate:hit'],
		confidence: 0.9,
	});

	const got = ledger.get(ref);
	assert.ok(got);
	assert.equal(got.confidence, 0.9);
	assert.deepEqual(got.claims, ['locate:hit']);
});

test('working-state: get returns undefined for unknown ref', () => {
	const ledger = createWorkingStateLedger();
	assert.equal(ledger.get('ledger-nope'), undefined);
});

// ---------------------------------------------------------------------------
// list + filter
// ---------------------------------------------------------------------------

test('working-state: list returns entries in insertion order', () => {
	const ledger = createWorkingStateLedger();
	ledger.append({ source: SUB_CALL, payload: { i: 1 }, claims: [], confidence: 0.9 });
	ledger.append({ source: OBS,      payload: { i: 2 }, claims: [], confidence: 0.5 });
	ledger.append({ source: SUB_CALL, payload: { i: 3 }, claims: [], confidence: 0.9 });

	const all = ledger.list();
	assert.equal(all.length, 3);
	assert.equal((all[0]!.payload as { i: number }).i, 1);
	assert.equal((all[2]!.payload as { i: number }).i, 3);
});

test('working-state: list applies filter', () => {
	const ledger = createWorkingStateLedger();
	ledger.append({ source: SUB_CALL, payload: { i: 1 }, claims: [], confidence: 0.9 });
	ledger.append({ source: OBS,      payload: { i: 2 }, claims: [], confidence: 0.5 });

	const subCalls = ledger.list(e => e.source.kind === 'sub-call');
	assert.equal(subCalls.length, 1);
});

// ---------------------------------------------------------------------------
// pin
// ---------------------------------------------------------------------------

test('working-state: pin captures (ref, target)', () => {
	const ledger = createWorkingStateLedger();
	const ref = ledger.append({ source: SUB_CALL, payload: { x: 1 }, claims: [], confidence: 0.9 });
	ledger.pin(ref, PIN_TARGET);

	const pins = ledger.pins();
	assert.equal(pins.length, 1);
	assert.equal(pins[0]!.ref, ref);
	assert.equal(pins[0]!.target.namespace, 'cache');
});

test('working-state: pin throws on unknown ref', () => {
	const ledger = createWorkingStateLedger();
	assert.throws(() => ledger.pin('ledger-bogus', PIN_TARGET), /unknown ledger ref/);
});

// ---------------------------------------------------------------------------
// size + soft warn
// ---------------------------------------------------------------------------

test('working-state: size tracks entries + bytes', () => {
	const ledger = createWorkingStateLedger();
	const before = ledger.size();
	assert.equal(before.entries, 0);
	assert.equal(before.bytes, 0);

	ledger.append({ source: SUB_CALL, payload: { x: 1 }, claims: [], confidence: 0.9 });
	const after = ledger.size();
	assert.equal(after.entries, 1);
	assert.ok(after.bytes > 0);
});

test('working-state: soft warn fires once on threshold crossing', () => {
	const events: WorkingStateEvent[] = [];
	const ledger = createWorkingStateLedger({
		softWarn: { maxEntries: 3, maxBytes: 1_000_000 },
		onEvent: e => { events.push(e); },
	});

	for (let i = 0; i < 5; i++) {
		ledger.append({ source: SUB_CALL, payload: { i }, claims: [], confidence: 0.9 });
	}

	const warns = events.filter(e => e.kind === 'soft-warn');
	assert.equal(warns.length, 1, 'soft warn fires exactly once');
	assert.ok(warns[0]!.entries >= 3);
});

// ---------------------------------------------------------------------------
// hard cap
// ---------------------------------------------------------------------------

test('working-state: hard cap throws on overflow (entries)', () => {
	const events: WorkingStateEvent[] = [];
	const ledger = createWorkingStateLedger({
		hardCap: { maxEntries: 2, maxBytes: 1_000_000 },
		onEvent: e => { events.push(e); },
	});

	ledger.append({ source: SUB_CALL, payload: { x: 1 }, claims: [], confidence: 0.9 });
	ledger.append({ source: SUB_CALL, payload: { x: 2 }, claims: [], confidence: 0.9 });

	assert.throws(
		() => ledger.append({ source: SUB_CALL, payload: { x: 3 }, claims: [], confidence: 0.9 }),
		WorkingStateHardCapError,
	);

	const hardCapEvents = events.filter(e => e.kind === 'hard-cap');
	assert.equal(hardCapEvents.length, 1);
});

test('working-state: hard cap throws on overflow (bytes)', () => {
	const ledger = createWorkingStateLedger({
		hardCap: { maxEntries: 1_000, maxBytes: 200 },
	});

	// First small entry fits.
	ledger.append({ source: SUB_CALL, payload: 'x', claims: [], confidence: 0.9 });

	// Next big entry blows the cap.
	assert.throws(
		() => ledger.append({
			source: SUB_CALL,
			payload: 'X'.repeat(500),
			claims: [],
			confidence: 0.9,
		}),
		WorkingStateHardCapError,
	);
});

// ---------------------------------------------------------------------------
// Isolation between executions
// ---------------------------------------------------------------------------

test('working-state: two ledgers are independent', () => {
	const a = createWorkingStateLedger();
	const b = createWorkingStateLedger();

	a.append({ source: SUB_CALL, payload: { tag: 'a' }, claims: [], confidence: 0.9 });
	assert.equal(a.size().entries, 1);
	assert.equal(b.size().entries, 0);
});
