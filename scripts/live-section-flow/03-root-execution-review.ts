/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: step-root-execution per-root review.
 *
 * The reviewable-root review is an opaque internal call -- there is
 * no public export for the single review() function. To exercise it
 * we run a minimal `executeReviewableRoots` with a synthetic
 * single-root tree, a scripted leaf executor that returns a fixed
 * aggregate output, and assert:
 *   - the review verdict is one of the three accepted values, and
 *   - the parser handled the response (parse failures default to
 *     `accept` and we'd see that in the trace).
 *
 * Also covers GAP B at the integration level: when the model emits a
 * `followup` with `suggested_leaves[]` containing an unknown skill id,
 * the parser drops it (logged warn). To trigger this branch
 * reproducibly the test seeds the aggregate output with text that
 * tends to push qwen toward a followup verdict ("incomplete",
 * "missing", etc.).
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/03-root-execution-review.ts
 */

import { executeReviewableRoots } from '../../src/insrc/agent/section-flow/step-root-execution.js';
import { buildCatalogFromRegistry } from '../../src/insrc/agent/content-gen/plan-tree-helpers.js';
import { registerAllSkills } from '../../src/insrc/daemon/skills/index.js';
import type { MemoryShapeBundle } from '../../src/insrc/agent/working-memory/index.js';
import type { TodoSpec } from '../../src/insrc/agent/section-flow/types.js';
import type { PlannedTree } from '../../src/insrc/agent/content-gen/plan-tree.js';
import { buildOllama, parseArgs, runTrials, combineChecks, type TrialResult } from './_lib.js';

const TODO: TodoSpec = {
	id:        'todo-grn-mapping',
	objective: 'Compare a sample JSON GRN payload against the INGRN pydantic class.',
	origin:    'initial',
};

const MEMORY: MemoryShapeBundle = {
	system: '', summary: '', recent: '', semantic: '', code: '',
};

// Synthetic 1-root composition. Real fix-and-iterate runs would use a
// catalog-validated tree; here we just need a valid PlannedTree shape.
const SYNTHETIC_TREE: PlannedTree = {
	intentBrief: 'live test: one root, one leaf',
	root: {
		id: 'root', title: 'root', objective: 'analyse', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
		children: [
			{
				id: 'discover', title: 'discover', objective: 'find facts',
				kind: 'composition', composition: 'sequence', inputs: {}, emit: 'section',
				children: [
					{
						id: 'leaf1', title: 'sample read', objective: 'read a sample',
						kind: 'leaf', skill: 'shared.compare.fields-vs-shape', inputs: {}, emit: 'intermediate',
					},
				],
			},
		],
	},
};

// Aggregate output the reviewer sees -- intentionally vague so the
// reviewer is more likely to choose `followup` (so we can also
// exercise the suggested_leaves coercion path).
const AGGREGATE = `# Findings\n\nWe loaded one sample payload but did not have time to enumerate every field. The pydantic class definition was not retrieved.`;

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	registerAllSkills();
	const catalog = buildCatalogFromRegistry({ owners: ['data-analyzer', 'shared'], includeL2Fallback: true });
	console.log(`(catalog built: ${catalog.length} skills available)`);

	const exit = await runTrials({
		name: 'step-root-execution per-root review',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			try {
				const result = await executeReviewableRoots({
					todo:        TODO,
					tree:        SYNTHETIC_TREE,
					memory:      MEMORY,
					executeLeaf: async () => AGGREGATE,    // canned leaf output
					provider,
					catalog,
				});
				const dur = Date.now() - t0;
				const findings = result.findings.perRoot;
				const first = findings[0];
				const verdict = first?.verdict ?? '(none)';
				const cycles  = first?.cyclesConsumed ?? 0;
				const knownVerdicts: readonly string[] = ['accept', 'followup', 'revise-major', 'exhausted', 'force-accept'];
				const verdictOk = knownVerdicts.includes(verdict);

				const checks = [
					verdictOk ? null : `unknown verdict: ${verdict}`,
					findings.length > 0 ? null : 'no per-root findings produced',
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${summary}; verdict=${verdict}, cycles=${cycles}, reopen=${result.reopenRequested}`,
					durationMs: dur,
					details: args.verbose ? {
						verdicts:  findings.map(f => `${f.rootId}=${f.verdict}`),
						content:   findings.map(f => `${f.rootId}: ${f.content.slice(0, 120)}`),
					} : undefined,
				};
			} catch (err) {
				return {
					outcome:    'fail',
					summary:    `executeReviewableRoots threw: ${(err as Error).message}`,
					durationMs: Date.now() - t0,
				};
			}
		},
	});

	process.exit(exit);
}

void main();
