/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CycleMemory helpers -- Phase alpha of
 * plans/section-flow-fact-gap-loop.md.
 *
 * Resurrects the helpers from the deleted
 * `agent/tasks/code-analyzer/cycle-memory.ts` (commit c06a3cef579,
 * removed in the section-flow migration). Scoped here to
 * `section-flow/` because the fact-gap loop lives in the per-TODO
 * task flow, not the code-analyzer per-section flow.
 *
 * Two pure functions, no I/O, easy to unit-test:
 *
 *   - `summarizeCycleMemory(mem)` -- renders a CycleMemory into a
 *     compact prompt block for the cloud cycle-reviewer (cycle 2+).
 *     Returns an empty string for fully-empty memory so callers can
 *     skip the block on cycle 1.
 *
 *   - `computeCoverage(retainedLedger, criteria, stepsById)` --
 *     mechanical map from retained step outputs onto the per-TODO
 *     required-fact list (passed as `criteria: string[]` for
 *     type-compat with the prior helper; section-flow callers pass
 *     `requiredFacts.map(f => f.fact)` as the criteria list and
 *     index by position the same way DiscoveryStep.targetsCriteria
 *     does today).
 *
 * Both are pure -- no side effects, no provider calls.
 */

import type {
	CycleMemory,
	DiscoveryStep,
	StepOutput,
} from '../content-gen/discovery-plan.js';

// ---------------------------------------------------------------------------
// summarizeCycleMemory
// ---------------------------------------------------------------------------

/**
 * Render a CycleMemory into a compact prompt block. Returned string is
 * empty when the memory is empty (cycle 1 / initial state) so the
 * caller can decide whether to inject the block or skip it.
 *
 * Shape:
 *
 *   ## Prior cycles -- what you've already asked for
 *
 *     cycle 1 -- 4 steps:
 *       step-1: locate the INGRN class definition
 *       step-2: ...
 *
 *   ## Criteria coverage (after cycle N)
 *
 *     [covered]  "INGRN class field list with types" -- step-1, step-4
 *     [partial]  "Validator rules on INGRN fields" -- step-2
 *     [open]     "JSON nesting depth"
 *     [open]     "Tax field XOR enforcement"
 *
 *   ## Scratchpad (carry-forward note from previous review)
 *
 *     vendor_details has unusual `entries` wrapper -- flag for the writer.
 */
export function summarizeCycleMemory(mem: CycleMemory): string {
	if (
		mem.priorAsks.length === 0 &&
		mem.scratchpad.trim().length === 0 &&
		mem.criteriaCoverage.every(c => c.status === 'open')
	) {
		// Fully empty memory (cycle 1 fresh start) -- caller should
		// skip the block entirely so the prompt doesn't carry dead
		// scaffolding.
		return '';
	}

	const lines: string[] = [];

	if (mem.priorAsks.length > 0) {
		lines.push("## Prior cycles -- what you've already asked for");
		lines.push('');
		for (const ask of mem.priorAsks) {
			lines.push(`cycle ${ask.cycle} -- ${ask.steps.length} step${ask.steps.length === 1 ? '' : 's'}:`);
			for (const s of ask.steps) {
				lines.push(`  ${s.id}: ${s.intent}`);
			}
			lines.push('');
		}
	}

	if (mem.criteriaCoverage.length > 0) {
		lines.push('## Criteria coverage so far');
		lines.push('');
		for (const cov of mem.criteriaCoverage) {
			const tag = cov.status === 'covered' ? '[covered]'
				:        cov.status === 'partial' ? '[partial]'
				:                                   '[open]   ';
			const contrib = cov.contributingStepIds.length > 0
				? ` -- ${cov.contributingStepIds.join(', ')}`
				: '';
			lines.push(`  ${tag}  "${cov.criterion}"${contrib}`);
		}
		lines.push('');
	}

	if (mem.scratchpad.trim().length > 0) {
		lines.push('## Scratchpad (carry-forward note)');
		lines.push('');
		lines.push(mem.scratchpad.trim());
		lines.push('');
	}

	return lines.join('\n').replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// computeCoverage
// ---------------------------------------------------------------------------

/**
 * Recompute `criteriaCoverage` from a retained ledger of step outputs.
 *
 * Mapping (mechanical, no LLM):
 *
 *   For each criterion (by index in `criteria`):
 *     - collect step outputs where the originating step's
 *       `targetsCriteria` includes this criterion's index
 *     - if no contributing outputs                -> open
 *     - if all contributing outputs are 'failed'  -> open
 *     - if any 'ok' contributing output           -> covered
 *     - otherwise (only 'partial' contributing)   -> partial
 *
 * `stepsById` resolves each output's originating step. Steps may come
 * from any cycle (the retained ledger is the union of kept outputs
 * across all cycles).
 *
 * Section-flow callers pass the required-fact list as
 * `criteria: requiredFacts.map(f => f.fact)`. The `DiscoveryStep`
 * type's `targetsCriteria: number[]` indexes into this array the
 * same way the prior code-analyzer flow indexed into `reviewCriteria`.
 */
export function computeCoverage(
	retainedLedger:  readonly StepOutput[],
	criteria:        readonly string[],
	stepsById:       ReadonlyMap<string, DiscoveryStep>,
): CycleMemory['criteriaCoverage'] {
	return criteria.map((criterion, idx) => {
		const contributing = retainedLedger.filter(out => {
			const step = stepsById.get(out.stepId);
			return step !== undefined && step.targetsCriteria.includes(idx);
		});
		const contributingStepIds = contributing.map(c => c.stepId);

		let status: 'covered' | 'partial' | 'open';
		if (contributing.length === 0) {
			status = 'open';
		} else if (contributing.every(c => c.status === 'failed')) {
			status = 'open';
		} else if (contributing.some(c => c.status === 'ok')) {
			status = 'covered';
		} else {
			status = 'partial';
		}

		return { criterion, status, contributingStepIds };
	});
}
