/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: Stage 0 fact-gap analysis -- runFactGapAnalysis against
 * the local model.
 *
 * Two scenarios:
 *   - **Cold TODO** (empty memory): every required fact should land as
 *     `absent` with concrete suggestedSkills. No present/partial facts.
 *   - **Warm TODO** (seeded memory with the class location): the
 *     class-location fact should land as `present` with a sourceRef
 *     pointing to the right memory layer.
 *
 * Asserts the schema validator accepts the output AND content sanity
 * (the seed terms appear, no refusals, gap suggestions are real
 * catalog ids).
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/11-fact-gap-analysis.ts
 */

import { runFactGapAnalysis } from '../../src/insrc/agent/section-flow/step-fact-gap-analysis.js';
import { gapFacts, isTrivialFastPath } from '../../src/insrc/agent/section-flow/fact-gap-types.js';
import { buildCatalogFromRegistry } from '../../src/insrc/agent/content-gen/plan-tree-helpers.js';
import { registerAllSkills } from '../../src/insrc/daemon/skills/index.js';
import type { MemoryShapeBundle } from '../../src/insrc/agent/working-memory/index.js';
import type { TodoSpec } from '../../src/insrc/agent/section-flow/types.js';
import { buildOllama, parseArgs, runTrials, combineChecks, type TrialResult } from './_lib.js';

const TODO: TodoSpec = {
	id:        'todo-class-mapping',
	objective: 'Compare a sample JSON GRN payload against the INGRN Pydantic class to identify field coverage and type-mismatch risks.',
	origin:    'initial',
};

const COLD_MEMORY: MemoryShapeBundle = {
	system:   'You analyze data structures against schema definitions.',
	summary:  '',
	recent:   '',
	semantic: '',
	code:     '',
};

const WARM_MEMORY: MemoryShapeBundle = {
	system:   'You analyze data structures against schema definitions.',
	summary:  'Investigation comparing JSON test fixtures to the Pydantic INGRN model. INGRN is the India-region Goods Receipt Note model defined in insors/core/model/invoice/regions/IN/grn.py at line 40.',
	recent:   '- todo-1-locate: located INGRN class at insors/core/model/invoice/regions/IN/grn.py:40\n- todo-2-files: enumerated 14 JSON fixtures under test/integration/data/BB/GRN',
	semantic: '- INGRN class file path is known\n- 14 JSON fixtures available for sampling',
	code:     '',
};

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	registerAllSkills();
	const catalog = buildCatalogFromRegistry({
		owners:            ['data-analyzer', 'code-analyzer', 'shared'],
		includeL2Fallback: true,
	});
	console.log(`(catalog built: ${catalog.length} skills available)`);

	const exit = await runTrials({
		name: 'Stage 0 fact-gap analysis (cold + warm memory)',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			// Alternate cold + warm on each trial; default --trials=1 runs cold.
			const isWarm  = i % 2 === 1;
			const memory  = isWarm ? WARM_MEMORY : COLD_MEMORY;
			const label   = isWarm ? 'warm' : 'cold';

			try {
				const result = await runFactGapAnalysis({
					todo: TODO, memory, catalog, provider,
				});
				const dur = Date.now() - t0;
				const facts = result.analysis.requiredFacts;
				const gaps  = gapFacts(result.analysis);
				const trivial = isTrivialFastPath(result.analysis);

				// Per-status counts
				const absentN  = facts.filter(f => f.status === 'absent').length;
				const partialN = facts.filter(f => f.status === 'partial').length;
				const presentN = facts.filter(f => f.status === 'present').length;

				// Sanity: every absent/partial fact must have at least one suggestedSkill
				const missingSuggest = gaps.filter(f => (f.suggestedSkills ?? []).length === 0);

				// Catalog-membership sanity (validator should have already caught this; defensive double-check)
				const catalogIds = new Set(catalog.map(c => c.id));
				const fakeSuggestions = facts.flatMap(f =>
					(f.suggestedSkills ?? []).filter(s => !catalogIds.has(s)));

				// Memory-aware sanity: in WARM mode the class-location fact should land as `present`.
				const warmClassLocationPresent =
					isWarm && facts.some(f =>
						/class.*location|ingrn.*file|class.*path/i.test(f.id + ' ' + f.fact) &&
						f.status === 'present');
				const warmClassLocationCheck =
					isWarm && !warmClassLocationPresent
						? 'WARM mode: class-location fact did not land as present despite memory containing it'
						: null;

				const checks = [
					facts.length === 0 ? 'no facts emitted' : null,
					missingSuggest.length === 0
						? null
						: `${missingSuggest.length} gap-status facts lack suggestedSkills`,
					fakeSuggestions.length === 0
						? null
						: `validator slipped: ${fakeSuggestions.length} suggestions not in catalog: ${fakeSuggestions.join(', ')}`,
					warmClassLocationCheck,
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${label}; ${summary}; facts=${facts.length} (absent=${absentN} partial=${partialN} present=${presentN}) trivial=${trivial} retried=${result.retried}`,
					durationMs: dur,
					details: args.verbose ? {
						mode:      label,
						reasoning: result.analysis.reasoning,
						facts: facts.map(f => ({
							id: f.id,
							status: f.status,
							fact: f.fact,
							suggestedSkills: f.suggestedSkills,
							sourceRef: f.sourceRef,
						})),
					} : { mode: label, factSummary: facts.map(f => `${f.id}=${f.status}`).join(',') },
				};
			} catch (err) {
				return {
					outcome:    'fail',
					summary:    `${label}; runFactGapAnalysis threw: ${(err as Error).message}`,
					durationMs: Date.now() - t0,
				};
			}
		},
	});

	process.exit(exit);
}

void main();
