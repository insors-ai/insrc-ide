/**
 * BudgetTracker unit tests -- P7.7.
 *
 * Covers basics + over-limit throws on each cap dimension.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBudgetTracker } from '../budget.js';
import { BudgetExceededError, type SkillBudget } from '../types.js';

const LIMIT: SkillBudget = {
	maxTokens:      1000,
	maxSubCalls:    5,
	maxWallclockMs: 60_000,
	maxDepth:       4,
};

test('budget: fresh tracker reports full remaining', () => {
	const t = createBudgetTracker({ limit: LIMIT });
	const r = t.remaining();
	assert.equal(r.tokens, 1000);
	assert.equal(r.subCalls, 5);
	assert.equal(r.depth, 0);
});

test('budget: chargeTokens decrements + throws over limit', () => {
	const t = createBudgetTracker({ limit: LIMIT });
	t.chargeTokens(400);
	assert.equal(t.remaining().tokens, 600);
	t.chargeTokens(600);
	assert.equal(t.remaining().tokens, 0);
	assert.throws(
		() => t.chargeTokens(1),
		(err: unknown) => err instanceof BudgetExceededError && err.cap === 'tokens',
	);
});

test('budget: reserveSubCall decrements + throws over limit', () => {
	const t = createBudgetTracker({ limit: LIMIT });
	for (let i = 0; i < 5; i++) { t.reserveSubCall(); }
	assert.equal(t.remaining().subCalls, 0);
	assert.throws(
		() => t.reserveSubCall(),
		(err: unknown) => err instanceof BudgetExceededError && err.cap === 'subCalls',
	);
});

test('budget: pushDepth / popDepth + throws over maxDepth', () => {
	const t = createBudgetTracker({ limit: LIMIT });
	for (let i = 0; i < 4; i++) { t.pushDepth(); }
	assert.equal(t.remaining().depth, 4);
	assert.throws(
		() => t.pushDepth(),
		(err: unknown) => err instanceof BudgetExceededError && err.cap === 'depth',
	);
	t.popDepth();
	assert.equal(t.remaining().depth, 3);
});

test('budget: popDepth on zero is a no-op (no throw)', () => {
	const t = createBudgetTracker({ limit: LIMIT });
	t.popDepth();   // not in any frame
	t.popDepth();
	assert.equal(t.remaining().depth, 0);
});

test('budget: maxDepth defaults to 4 when omitted', () => {
	const t = createBudgetTracker({ limit: { ...LIMIT, maxDepth: undefined } });
	for (let i = 0; i < 4; i++) { t.pushDepth(); }
	assert.throws(
		() => t.pushDepth(),
		(err: unknown) => err instanceof BudgetExceededError && err.cap === 'depth',
	);
});

test('budget: wallclock throws once over', () => {
	const now = Date.now();
	const t = createBudgetTracker({ limit: { ...LIMIT, maxWallclockMs: 10 }, startedAt: now - 50 });
	assert.throws(
		() => t.checkWallclock(),
		(err: unknown) => err instanceof BudgetExceededError && err.cap === 'wallclock',
	);
});

test('budget: negative chargeTokens is a no-op (defensive)', () => {
	const t = createBudgetTracker({ limit: LIMIT });
	t.chargeTokens(-5);
	t.chargeTokens(0);
	assert.equal(t.remaining().tokens, 1000);
});
