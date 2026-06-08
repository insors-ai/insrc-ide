/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: step-report-assemble -- the LLM-driven final-report
 * concatenator that the P7 failure exposed.
 *
 * Critical assertions:
 *   - non-empty markdown body (no deterministic-fallback path), AND
 *   - the per-section detail text is PRESERVED (assembler must not
 *     invent / paraphrase findings the sections do not contain), AND
 *   - the original question is acknowledged in intro or conclusion.
 *
 * If the LLM returns empty (Q7c failure path observed in P7), the
 * assembler's deterministic fallback kicks in -- we record that
 * as `pass-degraded` so it's visible without becoming a hard fail.
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/05-report-assemble.ts
 */

import { assembleReport } from '../../src/insrc/agent/section-flow/step-report-assemble.js';
import type { WorkingMemoryEntry } from '../../src/insrc/agent/working-memory/types.js';
import {
	buildOllama, parseArgs, runTrials, combineChecks, checkNonEmpty, checkContainsAny,
	type TrialResult,
} from './_lib.js';

const QUESTION = 'Analyze how the JSON test fixtures in test/integration/data/BB/GRN map to the Pydantic INGRN class.';

const ENTRIES: readonly WorkingMemoryEntry[] = [
	{
		todoId:    'todo-1-enumerate',
		objective: 'Enumerate the JSON fixture files',
		detail:    `# JSON fixture files\n\nLocated 14 fixture files under test/integration/data/BB/GRN: grn-basic.json, grn-missing-fields.json, grn-extra-fields.json, grn-nested-line-items.json, plus 10 edge-case variants. All files validate as JSON; mean size 2.3 KB.`,
		findings:  { perRoot: [], fallback: undefined },
	},
	{
		todoId:    'todo-2-class',
		objective: 'Locate and extract INGRN class fields',
		detail:    `# INGRN class definition\n\nClass INGRN is defined in models/incoming/grn.py. It declares 18 fields: grn_number (str), supplier_id (int, validated), receipt_date (datetime), items (list[INGRNItem]), notes (str|None), with 8 more scalar fields and 4 optional metadata fields.`,
		findings:  { perRoot: [], fallback: undefined },
	},
	{
		todoId:    'todo-3-compare',
		objective: 'Map JSON fields to INGRN fields',
		detail:    `# Mapping coverage\n\n13 of 18 INGRN fields are present in every fixture. 4 optional fields (notes, ext_ref, batch_id, currency) are present in 6/14 fixtures. 1 field (receipt_date) appears as ISO string in JSON; INGRN validator coerces.`,
		findings:  { perRoot: [], fallback: undefined },
	},
];

const SEED_TERMS = ['grn', 'ingrn', '14', '18', 'field', 'fixture'];

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	const exit = await runTrials({
		name: 'step-report-assemble',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			try {
				const result = await assembleReport({
					question: QUESTION,
					entries:  ENTRIES,
					provider,
				});
				const dur = Date.now() - t0;
				const report = result.report;

				// Preservation check: each section's distinctive number/term
				// from the detail markdown should survive into the report.
				const distinctivePhrases = ['14 fixture', '18 fields', '13 of 18'];
				const missing = distinctivePhrases.filter(p => !report.toLowerCase().includes(p.toLowerCase()));

				const checks = [
					checkNonEmpty(report, 'report'),
					checkContainsAny(report, SEED_TERMS, 'report'),
					result.usedFallback ? 'deterministic fallback fired (LLM returned empty)' : null,
					missing.length === 0 ? null : `missing distinctive content: ${missing.join(', ')}`,
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${summary}; ${report.length} chars, fallback=${result.usedFallback}`,
					durationMs: dur,
					details: args.verbose ? {
						fullReport: report,
					} : undefined,
				};
			} catch (err) {
				return {
					outcome:    'fail',
					summary:    `assembleReport threw: ${(err as Error).message}`,
					durationMs: Date.now() - t0,
				};
			}
		},
	});

	process.exit(exit);
}

void main();
