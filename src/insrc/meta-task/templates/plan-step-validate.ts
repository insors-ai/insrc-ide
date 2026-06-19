/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P4 validate -- deterministic Phase2Runner for the /plan meta-task
 * template (M4.a Phase 3).
 *
 * No cloud LLM call. The legacy planner did its dependency check
 * inline in `validatePlanStep`; the meta-task framework's O1
 * `Phase2Runner` escape hatch lets us replicate that as a pure
 * helper that emits a `Phase2Out`:
 *
 *   - Pass  -> { kind: 'deliverable', body: '<validation report markdown>' }
 *   - Fail  -> { kind: 'abort', resolution: 'plan-revisable',
 *                reason: '<cycle path | missing dependency target>',
 *                hint:   '<how to fix>' }
 *
 * Reads the P3 draft deliverable from `ctx.deliverables.get(3)`,
 * `parseStepsJson` -> `buildPlan` -> `detectCycles` (legacy helper).
 *
 * The category supplied to `buildPlan` here is `'implementation'` --
 * a deterministic placeholder used only for the description string.
 * P6 synth rebuilds the plan with the real category pulled from P1's
 * analysis. Validation result is independent of category.
 */

import { detectCycles } from '../../agent/planner/engine.js';
import type { Phase2Runner } from '../types.js';
import { buildPlan, parseStepsJson } from './plan-helpers.js';


/** 1-based step index of the upstream P3 draft step. */
const P3_DRAFT_STEP_INDEX = 3;


export const planValidateRunner: Phase2Runner = async (ctx) => {
	const draftBody = ctx.deliverables.get(P3_DRAFT_STEP_INDEX);
	if (draftBody === undefined) {
		return {
			kind:       'abort',
			resolution: 'user-required',
			reason:     `P4 validate: missing P3 draft deliverable at stepIndex ${P3_DRAFT_STEP_INDEX} -- orchestrator state corrupt`,
		};
	}

	const rawSteps = parseStepsJson(draftBody);
	if (rawSteps.length === 0) {
		return {
			kind:       'abort',
			resolution: 'plan-revisable',
			reason:     'P4 validate: P3 draft produced zero steps',
			hint:       'Re-run /plan with a sharper intent or split the request into smaller plans.',
		};
	}

	// Surface duplicate-title risk early (not a hard fail; legacy didn't check
	// this either, but a duplicate-title plan is usually a sign of LLM confusion).
	const titles = rawSteps.map(s => s.title);
	const dupes  = titles.filter((t, i) => titles.indexOf(t) !== i);

	// Build a typed Plan so we can run the legacy engine helpers.
	const plan = buildPlan('<plan-validate>', 'P4 validate scratch', rawSteps, 'implementation');

	const cyclePath = detectCycles(plan);
	if (cyclePath !== null) {
		const pathStr = cyclePath
			.map(id => plan.steps.find(s => s.id === id)?.title ?? id)
			.join(' -> ');
		return {
			kind:       'abort',
			resolution: 'plan-revisable',
			reason:     `P4 validate: dependency cycle detected: ${pathStr}`,
			hint:       'Re-order the steps so the cycle is broken. The plan-revision flow lets you provide guidance.',
		};
	}

	// Check that every dependsOnIdx points to a step that exists. parseStepsJson
	// can leak in entries with out-of-range indices; buildPlan silently drops
	// those. Surface the drop as a soft warning in the deliverable body so the
	// user understands.
	let droppedDepCount = 0;
	for (let i = 0; i < rawSteps.length; i++) {
		const idxs = rawSteps[i]!.dependsOnIdx ?? [];
		for (const idx of idxs) {
			if (idx < 0 || idx >= rawSteps.length || idx === i) {
				droppedDepCount += 1;
			}
		}
	}

	// Detect "phantom" steps the cloud LLM emitted as title-only without a
	// description -- legacy didn't reject these but they're a sign the LLM
	// truncated mid-output.
	const phantomSteps = rawSteps.filter(s => (s.description ?? '').trim().length === 0);

	// Pass: emit a markdown report.
	const lines: string[] = [];
	lines.push('# Validation pass');
	lines.push('');
	lines.push(`- Step count: ${rawSteps.length}`);
	lines.push('- Dependency cycles: none');
	lines.push(`- Dropped malformed dependsOnIdx entries: ${droppedDepCount}`);
	if (phantomSteps.length > 0) {
		lines.push(`- WARNING: ${phantomSteps.length} step(s) with empty description -- P6 synth will keep them but their bodies may be thin.`);
	}
	if (dupes.length > 0) {
		lines.push(`- WARNING: duplicate step titles detected: ${[...new Set(dupes)].join(', ')}`);
	}
	lines.push('');
	lines.push('## Step list (validated)');
	for (let i = 0; i < rawSteps.length; i++) {
		const s = rawSteps[i]!;
		lines.push(`${i + 1}. **${s.title}** -- ${s.description || '_(no description)_'}`);
	}

	return { kind: 'deliverable', body: lines.join('\n') };
};
