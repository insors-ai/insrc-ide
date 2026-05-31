/**
 * BudgetTracker -- P7.2.
 *
 * Per agentic-skills-architecture.md §A3: hard caps on tokens, sub-
 * calls, wallclock, and depth. The tracker is shared across the
 * entire call tree under a top-level L2 invocation -- sub-L2 calls
 * receive the SAME instance (no per-skill allocation), so sub-skills
 * can query `remaining()` and adapt.
 *
 * Caps THROW `BudgetExceededError` when breached. The L2 runtime
 * catches at the top level and surfaces a low-confidence result with
 * a `budget-exceeded` note; nested skills see the throw from
 * `deps.callL2(...)` / `deps.llm.complete(...)` and can handle it
 * (e.g. degrade to a simpler path) or propagate.
 */

import type { BudgetSnapshot, BudgetTracker, SkillBudget } from './types.js';
import { BudgetExceededError, DEFAULT_MAX_DEPTH } from './types.js';

// ---------------------------------------------------------------------------

export interface CreateBudgetTrackerOpts {
	readonly limit: SkillBudget;
	/** Wallclock baseline. Defaults to Date.now() at construction. */
	readonly startedAt?: number;
}

export function createBudgetTracker(opts: CreateBudgetTrackerOpts): BudgetTracker {
	const limit:    SkillBudget = opts.limit;
	const startedAt: number     = opts.startedAt ?? Date.now();
	const maxDepth: number      = limit.maxDepth ?? DEFAULT_MAX_DEPTH;

	let tokensUsed   = 0;
	let subCallsUsed = 0;
	let depth        = 0;

	function snapshot(): BudgetSnapshot {
		return {
			tokens:      Math.max(0, limit.maxTokens   - tokensUsed),
			subCalls:    Math.max(0, limit.maxSubCalls - subCallsUsed),
			wallclockMs: Math.max(0, limit.maxWallclockMs - (Date.now() - startedAt)),
			depth,
		};
	}

	return {
		limit,
		remaining: snapshot,

		chargeTokens(n: number): void {
			if (n <= 0) { return; }
			tokensUsed += n;
			if (tokensUsed > limit.maxTokens) {
				throw new BudgetExceededError(
					`token budget exceeded: used ${tokensUsed} > limit ${limit.maxTokens}`,
					limit, snapshot(), 'tokens',
				);
			}
		},

		reserveSubCall(): void {
			subCallsUsed += 1;
			if (subCallsUsed > limit.maxSubCalls) {
				throw new BudgetExceededError(
					`sub-call budget exceeded: used ${subCallsUsed} > limit ${limit.maxSubCalls}`,
					limit, snapshot(), 'subCalls',
				);
			}
		},

		pushDepth(): void {
			// Check first so a failed push doesn't leave depth in an
			// invalid state. The caller's popDepth() in a finally is
			// then guaranteed to balance.
			if (depth + 1 > maxDepth) {
				throw new BudgetExceededError(
					`depth limit exceeded: at ${depth + 1} > maxDepth ${maxDepth}`,
					limit, snapshot(), 'depth',
				);
			}
			depth += 1;
		},

		popDepth(): void {
			if (depth > 0) { depth -= 1; }
		},

		checkWallclock(): void {
			const elapsed = Date.now() - startedAt;
			if (elapsed > limit.maxWallclockMs) {
				throw new BudgetExceededError(
					`wallclock budget exceeded: elapsed ${elapsed}ms > limit ${limit.maxWallclockMs}ms`,
					limit, snapshot(), 'wallclock',
				);
			}
		},
	};
}
