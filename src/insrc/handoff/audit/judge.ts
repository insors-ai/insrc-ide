/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Audit judge -- combines deliverable parse + machine-check results
 * into a single AuditVerdict.
 *
 * Phase 2a Day 4 (deterministic only). Phase 6 adds:
 *   - reviewSection LLM judgment of the deliverable (extracted in Phase 0)
 *   - verifyCitedSummary against any artifact ids the agent referenced
 *   - cloud cheap-judgment shim for soft criteria
 *
 * For Phase 2a, the verdict is deterministic:
 *
 *   accept       : deliverable fills every required section AND every
 *                  machine criterion either passes or was soft/skipped.
 *
 *   revise-edits : every required section is present at minimum AND
 *                  the agent has actionable feedback to incorporate:
 *                    * any empty/placeholder section, OR
 *                    * any machine criterion failed.
 *                  Soft criteria are still reported pending.
 *
 *   revise-major : structural failure -- one or more REQUIRED sections
 *                  is missing entirely (the agent didn't follow the
 *                  template). Re-running the agent without revising
 *                  the spec is unlikely to help.
 */

import type { AcceptanceCriterion } from '../types.js';
import { parseDeliverableMarkdown, type DeliverableParseResult } from './deliverable-parser.js';
import { runMachineChecks, type MachineCheckResult } from './machine-checks.js';

export type AuditVerdict = 'accept' | 'revise-edits' | 'revise-major';

export interface AuditDeliverableOpts {
	readonly deliverable:        string;
	readonly requiredSections:   readonly string[];
	readonly acceptanceCriteria: readonly AcceptanceCriterion[];
	/** Worktree path; verifiers run there. */
	readonly cwd:                string;
	readonly defaultTimeoutMs?:  number | undefined;
}

export interface AuditResult {
	readonly verdict:          AuditVerdict;
	readonly parse:            DeliverableParseResult;
	readonly machineResults:   readonly MachineCheckResult[];
	/** Short human-readable reason summarising why the verdict came out. */
	readonly reason:           string;
	/** Specific feedback the caller can hand back to the agent on a revise-edits cycle. */
	readonly editHints:        readonly string[];
}

export async function auditDeliverable(opts: AuditDeliverableOpts): Promise<AuditResult> {
	const parse = parseDeliverableMarkdown(opts.deliverable, opts.requiredSections);

	const machineOpts: { cwd: string; defaultTimeoutMs?: number } = { cwd: opts.cwd };
	if (opts.defaultTimeoutMs !== undefined) machineOpts.defaultTimeoutMs = opts.defaultTimeoutMs;
	const machineResults = await runMachineChecks(opts.acceptanceCriteria, machineOpts);

	const machineFails = machineResults.filter(r => r.status === 'fail');
	const hasMissing   = parse.missing.length > 0;
	const hasEmpty     = parse.emptyOrPlaceholder.length > 0;
	const hasFails     = machineFails.length > 0;

	const editHints: string[] = [];
	for (const section of parse.emptyOrPlaceholder) {
		editHints.push(`Fill the empty '## ${section}' section in your deliverable with the work you did.`);
	}
	for (const r of machineFails) {
		editHints.push(`Acceptance criterion '${r.criterionId}' failed: ${r.detail}`);
	}

	let verdict: AuditVerdict;
	let reason: string;

	if (hasMissing) {
		// Missing entire required sections -- structural failure. The
		// agent didn't follow the deliverable structure. Editing won't
		// fix it cleanly; the spec needs a clearer reminder OR a fresh
		// approach.
		verdict = 'revise-major';
		reason  = `Deliverable is missing required sections: ${parse.missing.map(s => `'## ${s}'`).join(', ')}.`;
		// Also emit edit hints so the upstream can decide whether to
		// route as edits anyway.
		for (const section of parse.missing) {
			editHints.unshift(`Add the missing '## ${section}' section to your deliverable.`);
		}
	} else if (hasEmpty || hasFails) {
		verdict = 'revise-edits';
		const parts: string[] = [];
		if (hasEmpty) parts.push(`empty/placeholder sections: ${parse.emptyOrPlaceholder.map(s => `'## ${s}'`).join(', ')}`);
		if (hasFails) parts.push(`${machineFails.length} machine criteria failed`);
		reason = `Revisions needed: ${parts.join('; ')}.`;
	} else {
		verdict = 'accept';
		reason  = 'All required sections filled and all machine criteria pass; soft criteria pending audit-time review.';
	}

	return { verdict, parse, machineResults, reason, editHints };
}
