/**
 * Self-grounding validator -- P7.5.
 *
 * Per agentic-skills-architecture.md §A1: the substrate enforces
 * *structural* compliance on every L2 output. The skill is the only
 * judge of whether a citation *actually supports* its claim.
 *
 * What's validated here (structure-only):
 *   1. The output has an `evidence` array (typed via the schema).
 *   2. Every `LedgerRef` in `evidence[].citations` resolves to a real
 *      entry in the current execution's working-state ledger.
 *
 * What's NOT validated (skill's responsibility):
 *   - Semantic accuracy of the claim.
 *   - Whether the cited ledger entry actually supports the claim.
 *   - Whether every claim in `value` was identified + grounded.
 *
 * Per-skill opt-out via `selfGroundingMode: 'none'` for genuinely
 * citation-free outputs (e.g. a skill returning a single computed
 * scalar with nothing to ground). Default is `'structured'`.
 */

import type { WorkingStateLedger } from '../../substrate/types.js';

import type { Evidence, SelfGroundingMode, SkillOutput } from './types.js';
import { L2GroundingError } from './types.js';

// ---------------------------------------------------------------------------

export interface ValidateGroundingOpts {
	readonly mode:         SelfGroundingMode;
	readonly workingState: WorkingStateLedger;
	readonly skillId:      string;
}

/**
 * Validate the structural shape + ledger-ref integrity of an L2
 * skill's output. Throws `L2GroundingError` with one or more issues
 * on failure. No-op when `mode === 'none'`.
 */
export function validateGrounding(
	output: SkillOutput<unknown>,
	opts:   ValidateGroundingOpts,
): void {
	if (opts.mode === 'none') { return; }

	const issues: string[] = [];

	// Structural shape.
	if (!Array.isArray(output.evidence)) {
		issues.push(`output.evidence must be an array; got ${typeof output.evidence}`);
		throw new L2GroundingError(
			`L2 skill '${opts.skillId}' returned output without a valid evidence array`,
			issues,
		);
	}

	// Build the ref set once -- ledger.get is O(1) but we'd call it
	// per citation; one upfront walk is cheaper.
	const knownRefs = new Set<string>();
	for (const entry of opts.workingState.list()) {
		knownRefs.add(entry.ref);
	}

	// Each Evidence entry.
	for (let i = 0; i < output.evidence.length; i++) {
		const e = output.evidence[i] as Evidence | undefined;
		if (e === undefined || typeof e !== 'object') {
			issues.push(`evidence[${i}] is not an object`);
			continue;
		}
		if (typeof e.claim !== 'string' || e.claim.length === 0) {
			issues.push(`evidence[${i}].claim must be a non-empty string`);
		}
		if (!Array.isArray(e.citations)) {
			issues.push(`evidence[${i}].citations must be an array`);
			continue;
		}
		// Empty citations array IS allowed if the skill genuinely has no
		// ledger backing for this claim -- the skill's author surfaces
		// that via the claim text (e.g. "No data found in window X").
		for (let j = 0; j < e.citations.length; j++) {
			const ref = e.citations[j];
			if (typeof ref !== 'string') {
				issues.push(`evidence[${i}].citations[${j}] must be a string LedgerRef`);
				continue;
			}
			if (!knownRefs.has(ref)) {
				issues.push(`evidence[${i}].citations[${j}]='${ref}' does not resolve to any ledger entry`);
			}
		}
	}

	if (issues.length > 0) {
		throw new L2GroundingError(
			`L2 skill '${opts.skillId}' output failed self-grounding (${issues.length} issue(s))`,
			issues,
		);
	}
}
