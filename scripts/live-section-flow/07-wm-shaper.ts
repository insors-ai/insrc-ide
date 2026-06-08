/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: working-memory shaper (initial L1-L5 shape from accumulated
 * memory). Feeds a modest synthetic memory blob + a TODO objective and
 * asserts the result bundle has the 5 fields and each fits its token cap.
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/07-wm-shaper.ts
 */

import { shapeMemory } from '../../src/insrc/agent/working-memory/shaper.js';
import { createBudget, countTokens } from '../../src/insrc/agent/context/budget.js';
import { buildOllama, parseArgs, runTrials, combineChecks, type TrialResult } from './_lib.js';

const MEMORY_TEXT = `# Turn 1: Schema discovery
Located 14 JSON fixtures in test/integration/data/BB/GRN. Mean size 2.3 KB.

# Turn 2: Class location
INGRN class is defined in models/incoming/grn.py with 18 fields and 6 validators.

# Turn 3: Field profile
grn_number, supplier_id, receipt_date, items appear in 14/14 fixtures.
notes, ext_ref, batch_id, currency appear in 6/14 fixtures.
`;

const OBJECTIVE = 'Identify which INGRN validators have no exercise from the JSON fixture set.';

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	const budget = createBudget(16_384);
	const numCtx = 16_384;

	const exit = await runTrials({
		name: 'working-memory shaper',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			try {
				const result = await shapeMemory(provider, {
					memoryText: MEMORY_TEXT,
					objective:  OBJECTIVE,
					budget,
					numCtx,
				});
				const dur = Date.now() - t0;
				const b = result.bundle;
				const layers = [
					{ name: 'system',   text: b.system,   capTokens: budget.system },
					{ name: 'summary',  text: b.summary,  capTokens: budget.summary },
					{ name: 'recent',   text: b.recent,   capTokens: budget.recent },
					{ name: 'semantic', text: b.semantic, capTokens: budget.semantic },
					{ name: 'code',     text: b.code,     capTokens: budget.code ?? 0 },
				];
				const overBudget = layers.filter(l => l.capTokens > 0 && countTokens(l.text) > l.capTokens);
				const populated  = layers.filter(l => l.text.trim().length > 0);

				const checks = [
					populated.length >= 2 ? null : `only ${populated.length} layer(s) populated (expected at least 2)`,
					overBudget.length === 0 ? null : `${overBudget.length} layer(s) over budget: ${overBudget.map(l => l.name).join(',')}`,
					result.trace.retryTriggered ? 'schema retry fired (model emitted wrong shape first try)' : null,
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${summary}; populated=${populated.map(l => l.name).join(',')}, path=${result.trace.path}`,
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
					summary:    `shapeMemory threw: ${(err as Error).message}`,
					durationMs: Date.now() - t0,
				};
			}
		},
	});

	process.exit(exit);
}

void main();
