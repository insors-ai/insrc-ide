/**
 * discovery-plan-expansion writer v1 -- Stage 1 of the section-flow
 * per-TODO loop. Cloud LLM expands the gap-facts list into an ordered
 * set of discovery steps.
 *
 * Migrated from `agent/section-flow/step-discovery-plan-expansion.ts`'s
 * inline EXPANSION_ROLE + buildExpansionUser as part of Phase 0 of
 * `plans/section-flow-architecture-redesign.md`. Behaviour-preserving.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { CycleMemory } from '../../content-gen/discovery-plan.js';
import type { MemoryShapeBundle } from '../../working-memory/index.js';
import type { RequiredFact } from '../../section-flow/fact-gap-types.js';
import type { TodoSpec } from '../../section-flow/types.js';
import { summarizeCycleMemory } from '../../section-flow/cycle-memory.js';
import { renderFactGaps } from '../composers/fact-gaps.js';
import type { PromptWriter } from '../types.js';

export interface DiscoveryPlanExpansionWriterInput {
	readonly todo:                 TodoSpec;
	readonly gapFacts:             readonly RequiredFact[];
	readonly memory:               MemoryShapeBundle;
	readonly catalog:              readonly CatalogSkill[];
	readonly cycle:                1 | 2 | 3;
	readonly cycleMemory:          CycleMemory;
	readonly isRetry:              boolean;
	readonly priorFailureReason:   string | undefined;
}

const EXPANSION_ROLE = [
	'You are the DISCOVERY PLAN EXPANDER for one cycle of one TODO of an',
	'investigation report. Given a list of FACTS still missing from working',
	'memory, you emit an ordered set of discovery STEPS the orchestrator',
	'will execute to acquire them.',
	'',
	'Each step is a multi-skill investigation with one purpose. Each skill',
	'invocation inside a step names a catalog skill id AND provides plain-',
	'language context (the args resolver translates the context to args at',
	'execute time using the skill schema).',
	'',
	'You emit a SINGLE JSON object: { "steps": [...] }. No prose, no',
	'markdown fences, no preamble.',
].join('\n');

function renderMemory(memory: MemoryShapeBundle): string {
	const lines: string[] = [];
	if (memory.system.length > 0)   { lines.push('### system\n' + memory.system); }
	if (memory.summary.length > 0)  { lines.push('### summary\n' + memory.summary); }
	if (memory.recent.length > 0)   { lines.push('### recent\n' + memory.recent); }
	if (memory.semantic.length > 0) { lines.push('### semantic\n' + memory.semantic); }
	if (memory.code.length > 0)     { lines.push('### code\n' + memory.code); }
	return lines.length > 0 ? lines.join('\n\n') : '(empty -- this is the first TODO of the report)';
}

function renderCatalogSummary(catalog: readonly CatalogSkill[]): string {
	if (catalog.length === 0) { return '## SKILL CATALOG (empty)'; }
	const lines: string[] = [`## SKILL CATALOG (${catalog.length} skills available)`];
	for (const s of catalog) {
		const desc = s.description.replace(/\s+/g, ' ').trim().slice(0, 120);
		lines.push(`- \`${s.id}\` -- ${desc}`);
	}
	return lines.join('\n');
}

function buildExpansionUser(input: DiscoveryPlanExpansionWriterInput): string {
	const memBlock      = renderMemory(input.memory);
	const catalogBlock  = renderCatalogSummary(input.catalog);
	const factsBlock    = renderFactGaps(input.gapFacts);
	const cycleMemBlock = summarizeCycleMemory(input.cycleMemory);
	const retryAddendum = input.isRetry
		? [
			'',
			'## RETRY CORRECTION',
			`Your previous plan was rejected: ${input.priorFailureReason ?? 'unknown'}`,
			'Emit a new plan that satisfies every rule below.',
			'',
		].join('\n')
		: '';

	const lines: string[] = [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## WORKING MEMORY (L1-L5 bundle)',
		memBlock,
		'',
		'## GAP FACTS (acquire these; indices are stable for targetsCriteria)',
		factsBlock,
	];
	if (cycleMemBlock.length > 0) {
		lines.push('');
		lines.push('## PRIOR CYCLE CONTEXT');
		lines.push('');
		lines.push(cycleMemBlock);
	}
	lines.push('');
	lines.push(`## CYCLE: ${input.cycle}`);
	lines.push('');
	lines.push('## OUTPUT SHAPE');
	lines.push('');
	lines.push('{');
	lines.push('  "steps": [');
	lines.push('    {');
	lines.push('      "id": "step-1",                          // kebab-case, unique within the plan');
	lines.push('      "intent": "one-sentence purpose -- what fact does this step acquire?",');
	lines.push('      "skills": [');
	lines.push('        {');
	lines.push('          "id": "s1.a",                        // stable id within the step');
	lines.push('          "skillId": "<catalog skill id>",     // MUST be in the SKILL CATALOG below');
	lines.push('          "context": "concrete arg context -- include literal values (class name, file path, connection id) the args resolver needs",');
	lines.push('          "dependsOn": "s1.a"                  // optional; when this call needs another\'s output');
	lines.push('        }');
	lines.push('      ],');
	lines.push('      "targetsCriteria": [0, 2]                // indices into GAP FACTS above');
	lines.push('    }');
	lines.push('  ]');
	lines.push('}');
	lines.push('');
	lines.push('## RULES');
	lines.push('  - Emit 1-8 steps. Cover every gap fact at least once (across the step set).');
	lines.push('  - Each step has 1-6 skills.');
	lines.push('  - Every `skillId` MUST appear in the SKILL CATALOG section below.');
	lines.push('  - Each `targetsCriteria` is a non-empty array of indices into GAP FACTS.');
	lines.push('  - `intent` is a concrete sentence naming the specific fact being acquired (and, on cycle 2+, what the prior attempt missed).');
	lines.push('  - `context` for each skill call carries the literal args the skill needs -- pulled from prior outputs / memory / gap-fact suggestedSkills.');
	lines.push('  - `dependsOn` is set whenever a call chains off another\'s output. Two forms:');
	lines.push('      * INTRA-STEP (same step): bare skill id of an earlier skill in this step.');
	lines.push('        Example: step-1 has skills `s1.a` (locate-by-name) and `s1.b` (extract-fields with `dependsOn: "s1.a"`).');
	lines.push('        Within a step, raw skill outputs flow forward unconditionally -- use intra-step for tightly coupled chains.');
	lines.push('      * CROSS-STEP (different steps): `"<stepId>.<skillId>"` of an EARLIER step\'s skill.');
	lines.push('        Example: step-1 has `s1.a` (locate-by-name); step-2 has `s2.a` (entity.summary) with `dependsOn: "step-1.s1.a"`.');
	lines.push('        Only DECLARED cross-step deps are forwarded into the next step\'s priorOutputs; this is how you carry a hex entityId, file path, or other lookup-derived value across step boundaries without losing it to summarisation.');
	lines.push('      * Prefer the intra-step form when a tight chain fits in one step (cap = 6 skills). Use cross-step when the chain spans logically separate steps OR when the same prior output feeds two downstream steps.');
	lines.push('      * The dep value MUST point at an earlier-declared skill. Never invent a step or skill id that hasn\'t been declared above.');
	if (input.cycle > 1) {
		lines.push('  - Cycle 2+: DO NOT re-emit a step whose (skillId, context) pair matches an already-attempted step in PRIOR CYCLE CONTEXT with failed / open coverage. Try a different angle.');
	}
	lines.push(retryAddendum);
	lines.push('');
	lines.push(catalogBlock);
	lines.push('');
	lines.push('## TASK');
	lines.push('Emit the JSON object now. Begin with "{" and end with "}".');
	return lines.join('\n');
}

export const discoveryPlanExpansionWriterV1: PromptWriter<DiscoveryPlanExpansionWriterInput, readonly LLMMessage[]> = {
	id:      'discovery-plan-expansion',
	version: 1,
	tier:    'cloud',
	summary: 'Stage 1: expand the gap-facts list into an ordered set of discovery steps.',

	build(input: DiscoveryPlanExpansionWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: EXPANSION_ROLE },
			{ role: 'user',   content: buildExpansionUser(input) },
		];
	},
};
