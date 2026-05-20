/**
 * CycleMemory helpers -- Phase α of
 * plans/code-analyzer-discovery-plan-loop.md.
 *
 * Two pure functions, no I/O, easy to unit-test:
 *
 *   - `summarizeCycleMemory(mem)`  -- renders a CycleMemory into a
 *      compact prompt block for the cloud cycle-reviewer (cycle 2+).
 *      Pattern mirrors `agent/intent/summarize-prior-context.ts`:
 *      structured state in, prompt-ready string out.
 *
 *   - `computeCoverage(ledger, reviewCriteria)` -- mechanical map
 *      from retained step outputs onto the section's review criteria,
 *      producing `criteriaCoverage` entries. Pure function; no LLM
 *      judgment.
 *
 * Both are pure -- no side effects, no provider calls.
 */

import type {
	CycleMemory,
	DiscoveryStep,
	StepOutput,
} from '../../content-gen/discovery-plan.js';

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
 *       step-1: investigate NameNode metadata persistence
 *       step-2: ...
 *
 *   ## Criteria coverage (after cycle N)
 *
 *     [covered]  "Names NameNode core classes" -- step-1, step-4
 *     [partial]  "Explains block placement" -- step-2
 *     [open]     "Covers HA failover patterns"
 *     [open]     "Identifies lease management"
 *
 *   ## Scratchpad (carry-forward note from previous review)
 *
 *     The codebase uses an unusual EditLog format -- flag for the writer.
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
 *   For each criterion (by index in `reviewCriteria`):
 *     - collect step outputs where the originating step's
 *       `targetsCriteria` includes this criterion's index
 *     - if no contributing outputs   -> open
 *     - if all contributing outputs are 'failed'  -> open
 *     - if any 'ok' contributing output           -> covered
 *     - otherwise (only 'partial' contributing)   -> partial
 *
 * The caller passes `stepsById` so we can resolve the originating step
 * for each output. Steps may come from any cycle (the retained ledger
 * is the union of kept outputs across all cycles).
 */
export function computeCoverage(
	retainedLedger:  readonly StepOutput[],
	reviewCriteria:  readonly string[],
	stepsById:       ReadonlyMap<string, DiscoveryStep>,
): CycleMemory['criteriaCoverage'] {
	return reviewCriteria.map((criterion, idx) => {
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
