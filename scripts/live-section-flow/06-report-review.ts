/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: step-report-review -- final report review + revise loop.
 *
 * `runReportReview` internally assembles the report from entries and
 * then runs the review/revise cycle (cap-2). To exercise the Q7
 * scope-gap escape we seed the question with TWO halves but only
 * provide entries covering ONE -- a strong push toward
 * revise-structural / scope-gap.
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/06-report-review.ts
 */

import { runReportReview } from '../../src/insrc/agent/section-flow/step-report-review.js';
import type { WorkingMemoryEntry } from '../../src/insrc/agent/working-memory/types.js';
import { buildOllama, parseArgs, runTrials, combineChecks, checkNonEmpty, type TrialResult } from './_lib.js';

const QUESTION = 'Analyze how the JSON test fixtures in test/integration/data/BB/GRN map to the Pydantic INGRN class, AND check whether the validators in the INGRN class are exercised by the existing pytest test suite.';

const ENTRIES: readonly WorkingMemoryEntry[] = [
	{
		todoId:    'todo-1-mapping',
		objective: 'Map fixtures to INGRN fields',
		detail:    `# GRN payload → INGRN mapping\n\nWe located 14 JSON fixture files and matched them against the 18 INGRN class fields. 13 fields have full coverage; 4 are present in 6/14 fixtures.\n\n| Field | Coverage |\n|---|---|\n| grn_number | 14/14 |\n| supplier_id | 14/14 |\n| notes | 6/14 |\n`,
		findings:  { perRoot: [], fallback: undefined },
	},
];

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	const exit = await runTrials({
		name: 'step-report-review',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			try {
				const result = await runReportReview({
					question: QUESTION,
					entries:  ENTRIES,
					provider,
				});
				const dur = Date.now() - t0;

				const structural = result.structuralRevisePayload;
				const checks = [
					checkNonEmpty(result.finalReport, 'finalReport'),
					// The deliberate scope-gap (validator-coverage half) should
					// have been flagged at least once. If structuralReviseUsed
					// is false, that's a degraded outcome -- the model missed
					// the gap but the report still ships.
					result.structuralReviseUsed
						? null
						: 'reviewer did not fire revise-structural for the deliberate scope-gap (validator-coverage half ignored)',
					structural !== undefined ? validateStructural(structural) : null,
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${summary}; cycles=${result.cyclesConsumed}, exhausted=${result.exhausted}, structural=${structural?.kind ?? 'none'}`,
					durationMs: dur,
					details: args.verbose ? {
						addedScopeGapTodos: result.addedScopeGapTodos.map(t => `${t.id}: ${t.objective}`),
						structuralReasoning: structural !== undefined && 'reasoning' in structural ? (structural as { reasoning: string }).reasoning : '(none)',
						proposedTodos: structural?.kind === 'scope-gap' ? structural.proposedTodos.map(t => `${t.id}: ${t.objective}`) : undefined,
						finalReport: result.finalReport,
					} : undefined,
				};
			} catch (err) {
				return {
					outcome:    'fail',
					summary:    `runReportReview threw: ${(err as Error).message}`,
					durationMs: Date.now() - t0,
				};
			}
		},
	});

	process.exit(exit);
}

function validateStructural(s: { kind: string }): string | null {
	if (s.kind !== 'scope-gap' && s.kind !== 'section-contradiction') {
		return `unknown structural.kind: ${s.kind}`;
	}
	return null;
}

void main();
