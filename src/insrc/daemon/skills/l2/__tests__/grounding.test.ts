/**
 * Self-grounding validator unit tests -- P7.7.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkingStateLedger } from '../../../substrate/working-state.js';
import { validateGrounding } from '../grounding.js';
import { L2GroundingError, type SkillOutput } from '../types.js';

test('grounding: empty evidence array is valid (no claims to ground)', () => {
	const ws = createWorkingStateLedger();
	const out: SkillOutput<unknown> = {
		value:      { x: 1 },
		evidence:   [],
		confidence: 'high',
	};
	validateGrounding(out, { mode: 'structured', workingState: ws, skillId: 'test' });
});

test('grounding: citations resolve to ledger entries -> valid', () => {
	const ws = createWorkingStateLedger();
	const ref1 = ws.append({ source: { kind: 'internal' }, payload: { x: 1 }, claims: [], confidence: 0.9 });
	const ref2 = ws.append({ source: { kind: 'internal' }, payload: { y: 2 }, claims: [], confidence: 0.9 });

	const out: SkillOutput<unknown> = {
		value:    { ok: true },
		evidence: [{ claim: 'x is 1', citations: [ref1] }, { claim: 'y is 2', citations: [ref1, ref2] }],
		confidence: 'high',
	};
	validateGrounding(out, { mode: 'structured', workingState: ws, skillId: 'test' });
});

test('grounding: missing evidence field rejected', () => {
	const ws = createWorkingStateLedger();
	const out = { value: { x: 1 }, confidence: 'high' } as unknown as SkillOutput<unknown>;
	assert.throws(
		() => validateGrounding(out, { mode: 'structured', workingState: ws, skillId: 'test' }),
		(err: unknown) => err instanceof L2GroundingError && err.issues.some(i => /evidence must be an array/.test(i)),
	);
});

test('grounding: dangling LedgerRef rejected', () => {
	const ws = createWorkingStateLedger();
	const out: SkillOutput<unknown> = {
		value:    { x: 1 },
		evidence: [{ claim: 'phantom', citations: ['does-not-exist'] }],
		confidence: 'high',
	};
	assert.throws(
		() => validateGrounding(out, { mode: 'structured', workingState: ws, skillId: 'test' }),
		(err: unknown) => err instanceof L2GroundingError && err.issues.some(i => /does not resolve/.test(i)),
	);
});

test('grounding: empty claim string rejected', () => {
	const ws = createWorkingStateLedger();
	const ref = ws.append({ source: { kind: 'internal' }, payload: {}, claims: [], confidence: 0.9 });
	const out: SkillOutput<unknown> = {
		value:    { x: 1 },
		evidence: [{ claim: '', citations: [ref] }],
		confidence: 'high',
	};
	assert.throws(
		() => validateGrounding(out, { mode: 'structured', workingState: ws, skillId: 'test' }),
		(err: unknown) => err instanceof L2GroundingError && err.issues.some(i => /must be a non-empty string/.test(i)),
	);
});

test('grounding: selfGroundingMode none -> always passes', () => {
	const ws = createWorkingStateLedger();
	const out = { value: 42, confidence: 'high' } as unknown as SkillOutput<unknown>;
	// Even malformed output passes when opted out.
	validateGrounding(out, { mode: 'none', workingState: ws, skillId: 'test' });
});

test('grounding: multiple issues aggregated in single throw', () => {
	const ws = createWorkingStateLedger();
	const out: SkillOutput<unknown> = {
		value:    {},
		evidence: [
			{ claim: '', citations: ['ghost-1'] },
			{ claim: 'real claim', citations: ['ghost-2'] },
		],
		confidence: 'high',
	};
	assert.throws(
		() => validateGrounding(out, { mode: 'structured', workingState: ws, skillId: 'test' }),
		(err: unknown) => err instanceof L2GroundingError && err.issues.length >= 3,
	);
});
