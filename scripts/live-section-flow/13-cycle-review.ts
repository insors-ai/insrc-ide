/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: Stage 3 cycle review -- runCycleReview against the local model.
 *
 * Two scenarios:
 *   - **All covered:** step outputs cover every gap fact; reviewer should
 *     keep everything and emit `new_steps: []` (terminate).
 *   - **Partial coverage:** one fact uncovered; reviewer should keep the
 *     successful outputs AND emit at least one `new_steps[]` entry
 *     targeting the open gap, with concrete intent + catalog skill +
 *     literal context args.
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/13-cycle-review.ts
 */

import { runCycleReview } from '../../src/insrc/agent/section-flow/step-cycle-review.js';
import { buildCatalogFromRegistry } from '../../src/insrc/agent/content-gen/plan-tree-helpers.js';
import { registerAllSkills } from '../../src/insrc/daemon/skills/index.js';
import { emptyCycleMemory, type DiscoveryStep, type StepOutput } from '../../src/insrc/agent/content-gen/discovery-plan.js';
import type { TodoSpec } from '../../src/insrc/agent/section-flow/types.js';
import type { RequiredFact } from '../../src/insrc/agent/section-flow/fact-gap-types.js';
import { buildOllama, parseArgs, runTrials, combineChecks, type TrialResult } from './_lib.js';

const TODO: TodoSpec = {
	id:        'todo-class-mapping',
	objective: 'Compare a sample JSON GRN payload against the INGRN Pydantic class.',
	origin:    'initial',
};

const GAP_FACTS: readonly RequiredFact[] = [
	{ id: 'ingrn-fields', fact: 'INGRN field list', why: 'mapping baseline', status: 'absent' },
	{ id: 'json-shape',   fact: 'GRN JSON shape',   why: 'data side',         status: 'absent' },
	{ id: 'nested',       fact: 'nested INGRN models', why: 'vendor/items', status: 'absent' },
];

const STEPS_THIS_CYCLE: readonly DiscoveryStep[] = [
	{
		id: 'step-1',
		intent: 'locate INGRN class and extract its field list',
		skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }],
		targetsCriteria: [0],
	},
	{
		id: 'step-2',
		intent: 'sample one GRN JSON file shape',
		skills: [{ id: 's2.a', skillId: 'data.source.file.sample-shape', context: 'path=test/integration/data/BB/GRN/grn-basic.json' }],
		targetsCriteria: [1],
	},
	{
		id: 'step-3',
		intent: 'extract nested model definitions',
		skills: [{ id: 's3.a', skillId: 'code.class.extract-fields', context: 'className=INPartyDetails' }],
		targetsCriteria: [2],
	},
];

// "All covered" scenario: every step has concrete facts
const OUTPUTS_ALL_COVERED: readonly StepOutput[] = [
	{ stepId: 'step-1', status: 'ok', facts: ['INGRN has 21 fields: vendor:INPartyDetails, buyer:Optional[...], items:Optional[List[INGRNItem]]'], citations: [{ path: 'insors/.../grn.py', startLine: 40, endLine: 207 }], durationMs: 1500 },
	{ stepId: 'step-2', status: 'ok', facts: ['JSON top-level: grn_number(str), grn_date(object), vendor_details(object), sku_details(object), grn_amount(number)'], citations: [{ path: 'test/integration/data/BB/GRN/grn-basic.json' }], durationMs: 500 },
	{ stepId: 'step-3', status: 'ok', facts: ['INPartyDetails has taxDetails, businessIdentifiers, complianceDetails. INGRNItem has sku_code, sku_description, received/accepted_quantity, unit_price, SGST/CGST/IGST'], citations: [{ path: 'insors/.../party_details.py', startLine: 243 }], durationMs: 1200 },
];

// "Partial coverage" scenario: step-3 failed (nested model extraction didn't work)
const OUTPUTS_PARTIAL: readonly StepOutput[] = [
	OUTPUTS_ALL_COVERED[0]!,
	OUTPUTS_ALL_COVERED[1]!,
	{ stepId: 'step-3', status: 'failed', facts: [], citations: [], durationMs: 100 },
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
		name: 'Stage 3 cycle review (all-covered + partial scenarios)',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			const isPartial = i % 2 === 1;
			const outputs = isPartial ? OUTPUTS_PARTIAL : OUTPUTS_ALL_COVERED;
			const label = isPartial ? 'partial' : 'all-covered';

			try {
				const result = await runCycleReview({
					todo: TODO, gapFacts: GAP_FACTS,
					stepsThisCycle: STEPS_THIS_CYCLE,
					cycleOutputs: outputs,
					cycleMemory: emptyCycleMemory(GAP_FACTS.map(f => f.fact)),
					cycle: 1, catalog, provider,
				});
				const dur = Date.now() - t0;
				const resp = result.response;

				const catalogIds = new Set(catalog.map(c => c.id));
				const badSkills = resp.new_steps.flatMap(s => s.skills.filter(sk => !catalogIds.has(sk.skillId)).map(sk => sk.skillId));

				const checks = [
					// All-covered: expect keep populated + new_steps empty (terminate)
					!isPartial && resp.new_steps.length > 0
						? `all-covered scenario should terminate (new_steps empty); got ${resp.new_steps.length} new_steps`
						: null,
					// Partial: expect keep populated (failed step ideally dropped) + at least one new_step targeting the open gap (fact index 2)
					isPartial && resp.new_steps.length === 0
						? 'partial scenario terminated without retry; expected at least one new_step targeting open gap'
						: null,
					isPartial && resp.new_steps.length > 0 && !resp.new_steps.some(s => s.targetsCriteria.includes(2))
						? 'partial scenario new_steps do not target the open gap fact (index 2 = nested-models)'
						: null,
					badSkills.length === 0 ? null : `bad skills slipped through: ${badSkills.join(', ')}`,
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${label}; ${summary}; keep=${resp.keep.length} new_steps=${resp.new_steps.length} dropped=${result.droppedStepIds.length} retried=${result.retried}`,
					durationMs: dur,
					details: args.verbose ? {
						mode: label,
						keep: resp.keep,
						new_steps: resp.new_steps.map(s => ({
							id: s.id, intent: s.intent, targets: s.targetsCriteria,
							skills: s.skills.map(sk => `${sk.skillId}(${sk.context.slice(0, 60)})`),
						})),
						scratchpad: resp.scratchpad,
						droppedStepIds: result.droppedStepIds,
					} : { mode: label, keep: resp.keep.join(','), newCount: resp.new_steps.length },
				};
			} catch (err) {
				return { outcome: 'fail', summary: `${label}; runCycleReview threw: ${(err as Error).message}`, durationMs: Date.now() - t0 };
			}
		},
	});

	process.exit(exit);
}

void main();
