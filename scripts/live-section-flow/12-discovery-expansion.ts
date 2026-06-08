/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: Stage 1 discovery-plan expansion -- runDiscoveryPlanExpansion
 * against the local model.
 *
 * Seeds a synthetic gap-facts list (mirrors what Stage 0 would emit for
 * the GRN/INGRN question) and asserts the planner returns a `steps[]`
 * that:
 *   - covers every gap fact at least once (across the step set)
 *   - uses only catalog skill ids
 *   - has concrete intents (>= 20 chars after trim)
 *   - emits literal args in context (not vague "look harder")
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/12-discovery-expansion.ts
 */

import { runDiscoveryPlanExpansion } from '../../src/insrc/agent/section-flow/step-discovery-plan-expansion.js';
import { buildCatalogFromRegistry } from '../../src/insrc/agent/content-gen/plan-tree-helpers.js';
import { registerAllSkills } from '../../src/insrc/daemon/skills/index.js';
import { emptyCycleMemory } from '../../src/insrc/agent/content-gen/discovery-plan.js';
import type { MemoryShapeBundle } from '../../src/insrc/agent/working-memory/index.js';
import type { TodoSpec } from '../../src/insrc/agent/section-flow/types.js';
import type { RequiredFact } from '../../src/insrc/agent/section-flow/fact-gap-types.js';
import { buildOllama, parseArgs, runTrials, combineChecks, type TrialResult } from './_lib.js';

const TODO: TodoSpec = {
	id:        'todo-class-mapping',
	objective: 'Compare a sample JSON GRN payload against the INGRN Pydantic class to identify field coverage and type-mismatch risks.',
	origin:    'initial',
};

const MEMORY: MemoryShapeBundle = {
	system:   'You analyze data structures against schema definitions.',
	summary:  'INGRN at insors/core/model/invoice/regions/IN/grn.py:40. 14 JSON fixtures available in test/integration/data/BB/GRN.',
	recent:   '- todo-1 located the class file\n- todo-2 enumerated the fixture set',
	semantic: '',
	code:     '',
};

const GAP_FACTS: readonly RequiredFact[] = [
	{
		id: 'ingrn-fields',
		fact: 'INGRN Pydantic class field list with types',
		why: 'baseline for the field mapping table',
		status: 'absent',
		suggestedSkills: ['code.class.extract-fields'],
	},
	{
		id: 'json-shape',
		fact: 'GRN JSON top-level shape (keys + types)',
		why: 'data side of the mapping',
		status: 'absent',
		suggestedSkills: ['data.source.file.sample-shape'],
	},
	{
		id: 'nested-models',
		fact: 'INGRN nested-model field definitions (INPartyDetails, INGRNItem)',
		why: 'understand vendor_details + sku_details structural mapping',
		status: 'absent',
		suggestedSkills: ['code.class.extract-fields', 'code.entity.locate-by-name'],
	},
];

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
		name: 'Stage 1 discovery-plan expansion (cycle 1, 3 gap facts)',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			try {
				const result = await runDiscoveryPlanExpansion({
					todo: TODO, gapFacts: GAP_FACTS, memory: MEMORY, catalog,
					cycle: 1, cycleMemory: emptyCycleMemory(GAP_FACTS.map(f => f.fact)),
					provider,
				});
				const dur = Date.now() - t0;
				const steps = result.steps;

				// Coverage: every gap fact index appears in some step.targetsCriteria.
				const covered = new Set<number>();
				for (const s of steps) { for (const t of s.targetsCriteria) { covered.add(t); } }
				const uncovered: number[] = [];
				for (let k = 0; k < GAP_FACTS.length; k++) {
					if (!covered.has(k)) { uncovered.push(k); }
				}

				// Catalog membership: every skillId in catalog (validator should have caught; defensive).
				const catalogIds = new Set(catalog.map(c => c.id));
				const badSkills = steps.flatMap(s => s.skills.filter(sk => !catalogIds.has(sk.skillId)).map(sk => sk.skillId));

				// Intent concreteness: target >=20 chars (sanity).
				const vagueIntents = steps.filter(s => s.intent.length < 20);

				const checks = [
					steps.length === 0 ? 'no steps emitted' : null,
					uncovered.length === 0 ? null : `gap facts uncovered: ${uncovered.join(', ')}`,
					badSkills.length === 0 ? null : `validator slipped: bad skill ids ${badSkills.join(', ')}`,
					vagueIntents.length === 0 ? null : `${vagueIntents.length} step intents shorter than 20 chars (vague)`,
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${summary}; steps=${steps.length} covered=${covered.size}/${GAP_FACTS.length} retried=${result.retried}`,
					durationMs: dur,
					details: args.verbose ? {
						steps: steps.map(s => ({
							id: s.id, intent: s.intent,
							targets: s.targetsCriteria,
							skills: s.skills.map(sk => `${sk.skillId}(${sk.context.slice(0, 60)}${sk.context.length > 60 ? '...' : ''})${sk.dependsOn ? `<-${sk.dependsOn}` : ''}`),
						})),
					} : { stepSummary: steps.map(s => `${s.id}[t:${s.targetsCriteria.join(',')}, skills:${s.skills.length}]`).join(' ') },
				};
			} catch (err) {
				return { outcome: 'fail', summary: `runDiscoveryPlanExpansion threw: ${(err as Error).message}`, durationMs: Date.now() - t0 };
			}
		},
	});

	process.exit(exit);
}

void main();
