/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: working-memory incremental updater. Fires 3 layer-update
 * LLM calls (summary / recent / semantic) and asserts each returns a
 * non-null bundle with the updated layer present.
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/08-wm-updater.ts
 */

import { incrementalUpdate } from '../../src/insrc/agent/working-memory/updater.js';
import { createBudget, countTokens } from '../../src/insrc/agent/context/budget.js';
import type { MemoryShapeBundle } from '../../src/insrc/agent/working-memory/shaper.js';
import type { WorkingMemoryEntry } from '../../src/insrc/agent/working-memory/types.js';
import { buildOllama, parseArgs, runTrials, combineChecks, type TrialResult } from './_lib.js';

const PRIOR_BUNDLE: MemoryShapeBundle = {
	system:   'You analyze data structures against schema definitions.',
	summary:  'The user is investigating mismatches between JSON test fixtures and the Pydantic INGRN model.',
	recent:   '- 14 JSON fixtures located in test/integration/data/BB/GRN.\n- 18 INGRN fields, 6 validators.',
	semantic: '- INGRN validators include: receipt_date coercion, items list-length cap, supplier_id range check.',
	code:     '',
};

const NEW_ENTRY: WorkingMemoryEntry = {
	todoId:    'todo-2-coverage',
	objective: 'Determine which INGRN validators are exercised by the fixtures',
	detail:    `# Validator coverage\n\nExamined the 14 fixtures against 6 INGRN validators:\n- receipt_date coercion: exercised by 14/14 (all have ISO string)\n- items list-length cap: exercised by 3/14 (only 3 fixtures have >5 items)\n- supplier_id range check: exercised by 14/14\n- notes-length cap: never exercised (no fixture has notes >200 chars)\n- batch_id format: never exercised (only present in 6 fixtures; none with format violation)\n- currency enum: never exercised (only 6/14 set currency)\n\n**3 of 6 validators have zero exercise from the fixture set.**`,
	findings:  { perRoot: [], fallback: undefined },
};

const NEXT_OBJECTIVE = 'Propose 3 new fixtures that would exercise the un-tested validators.';

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	const budget = createBudget(16_384);

	const exit = await runTrials({
		name: 'working-memory incremental updater (3 LLM calls)',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			try {
				const result = await incrementalUpdate(provider, {
					priorBundle:   PRIOR_BUNDLE,
					priorEntries:  [],
					newEntry:      NEW_ENTRY,
					nextObjective: NEXT_OBJECTIVE,
					budget,
				});
				const dur = Date.now() - t0;
				const b = result.bundle;

				const layerTokens = {
					summary:  countTokens(b.summary),
					recent:   countTokens(b.recent),
					semantic: countTokens(b.semantic),
				};
				const overBudget: string[] = [];
				if (layerTokens.summary  > budget.summary)  { overBudget.push('summary'); }
				if (layerTokens.recent   > budget.recent)   { overBudget.push('recent'); }
				if (layerTokens.semantic > budget.semantic) { overBudget.push('semantic'); }

				// Did `semantic` mention any term from NEXT_OBJECTIVE?
				// (the semantic layer's job is to surface bullets relevant
				// to the upcoming TODO)
				const semanticHits = ['validator', 'fixture', 'untested', 'un-tested'].some(
					t => b.semantic.toLowerCase().includes(t.toLowerCase()),
				);

				const checks = [
					b.summary.trim().length === 0  ? 'summary layer empty' : null,
					b.recent.trim().length === 0   ? 'recent layer empty'  : null,
					b.semantic.trim().length === 0 ? 'semantic layer empty' : null,
					overBudget.length > 0 ? `over budget: ${overBudget.join(',')}` : null,
					semanticHits ? null : 'semantic layer did not surface NEXT-objective-relevant content',
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${summary}; tokens={s:${layerTokens.summary}/${budget.summary},r:${layerTokens.recent}/${budget.recent},sem:${layerTokens.semantic}/${budget.semantic}}`,
					durationMs: dur,
					details: args.verbose ? {
						summary:  b.summary.slice(0, 200),
						recent:   b.recent.slice(0, 200),
						semantic: b.semantic.slice(0, 200),
					} : undefined,
				};
			} catch (err) {
				return {
					outcome:    'fail',
					summary:    `incrementalUpdate threw: ${(err as Error).message}`,
					durationMs: Date.now() - t0,
				};
			}
		},
	});

	process.exit(exit);
}

void main();
