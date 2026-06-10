/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stage 1 of the fact-gap-driven task loop -- Phase gamma of
 * plans/section-flow-fact-gap-loop.md.
 *
 * One LLM call per cycle. Takes the TODO + gap-facts list (Stage 0
 * output, filtered to absent + partial) + memory + catalog +
 * cycleMemory and returns a `DiscoveryStep[]` plan for the cycle.
 *
 * On cycle 1 the cycleMemory is empty; the planner sees just the gap
 * facts and decides initial discovery. On cycle 2+ the cycleMemory
 * renders prior asks + coverage so the planner avoids re-asking for
 * what's already been tried.
 *
 * Validator enforces (per the followup-quality contract, Decision #13):
 *   - JSON schema fit (existing DISCOVERY_PLAN_SCHEMA's `steps` shape)
 *   - Each step.id unique within the plan
 *   - Each PlannedSkillCall.skillId in the supplied catalog
 *   - Each step.targetsCriteria is a non-empty subset of valid fact
 *     indices (0..gapFacts.length-1)
 *   - Each step has at least one PlannedSkillCall
 *
 * Retry policy: 1 corrective on validation failure (with the rejection
 * reason quoted verbatim). Second failure throws (Q9 recoverable; the
 * orchestrator's L2 fallback takes over).
 */

import type { CatalogSkill } from '../content-gen/plan-tree-runner.js';
import type {
	CycleMemory,
	DiscoveryStep,
	PlannedSkillCall,
} from '../content-gen/discovery-plan.js';
import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { MemoryShapeBundle } from '../working-memory/index.js';
import type { RequiredFact } from './fact-gap-types.js';
import type { TodoSpec } from './types.js';
import { summarizeCycleMemory } from './cycle-memory.js';
import { getLogger } from '../../shared/logger.js';
import { getPromptRegistry } from '../prompts/registry.js';
import type { DiscoveryPlanExpansionWriterInput } from '../prompts/writers/discovery-plan-expansion.js';

const log = getLogger('section-flow:discovery-plan-expansion');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiscoveryPlanExpansionInput {
	readonly todo:        TodoSpec;
	/**
	 * The gap facts (absent + partial) the planner should target. The
	 * orchestrator filters the FactGapAnalysis via `gapFacts(analysis)`
	 * before calling. `targetsCriteria` in the emitted steps indexes
	 * INTO this array (NOT the full requiredFacts array).
	 */
	readonly gapFacts:    readonly RequiredFact[];
	readonly memory:      MemoryShapeBundle;
	readonly catalog:     readonly CatalogSkill[];
	readonly cycle:       1 | 2 | 3;
	readonly cycleMemory: CycleMemory;
	readonly provider:    LLMProvider;
}

export interface DiscoveryPlanExpansionResult {
	readonly steps:               readonly DiscoveryStep[];
	readonly retried:             boolean;
	readonly firstFailureReason?: string | undefined;
}

const MAX_EXPANSION_TOKENS = 3072;

export async function runDiscoveryPlanExpansion(
	input: DiscoveryPlanExpansionInput,
): Promise<DiscoveryPlanExpansionResult> {
	if (input.gapFacts.length === 0) {
		throw new Error('runDiscoveryPlanExpansion: gapFacts is empty; orchestrator should take the trivial fast-path instead');
	}
	const catalogIds = new Set(input.catalog.map(c => c.id));
	const maxFactIdx = input.gapFacts.length - 1;

	const firstAttempt = await callExpansion(input, false, undefined);
	const firstValidation = validate(firstAttempt.raw, catalogIds, maxFactIdx);
	if (firstValidation.ok) {
		log.info({
			todoId:    input.todo.id,
			cycle:     input.cycle,
			stepCount: firstValidation.steps.length,
			gapCount:  input.gapFacts.length,
		}, 'discovery-plan expansion: first-attempt validated');
		return { steps: firstValidation.steps, retried: false };
	}

	log.warn({ todoId: input.todo.id, cycle: input.cycle, reason: firstValidation.reason }, 'discovery-plan expansion: first-attempt rejected; retrying with corrective hint');

	const retry = await callExpansion(input, true, firstValidation.reason);
	const retryValidation = validate(retry.raw, catalogIds, maxFactIdx);
	if (!retryValidation.ok) {
		throw new Error(`discovery-plan expansion validation failed after retry: ${retryValidation.reason}`);
	}
	log.info({ todoId: input.todo.id, cycle: input.cycle, stepCount: retryValidation.steps.length }, 'discovery-plan expansion: retry validated');
	return {
		steps:              retryValidation.steps,
		retried:            true,
		firstFailureReason: firstValidation.reason,
	};
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface ExpansionRaw {
	readonly raw: string;
}

async function callExpansion(
	input:              DiscoveryPlanExpansionInput,
	isRetry:            boolean,
	priorFailureReason: string | undefined,
): Promise<ExpansionRaw> {
	const writer = getPromptRegistry().get<DiscoveryPlanExpansionWriterInput, readonly LLMMessage[]>('discovery-plan-expansion');
	const messages = [...writer.build({
		todo:               input.todo,
		gapFacts:           input.gapFacts,
		memory:             input.memory,
		catalog:            input.catalog,
		cycle:              input.cycle,
		cycleMemory:        input.cycleMemory,
		isRetry,
		priorFailureReason,
	})];
	const response = await input.provider.complete(messages, {
		maxTokens:       MAX_EXPANSION_TOKENS,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	return { raw: response.text };
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

function buildExpansionUser(
	input:              DiscoveryPlanExpansionInput,
	isRetry:            boolean,
	priorFailureReason: string | undefined,
): string {
	const memBlock      = renderMemory(input.memory);
	const catalogBlock  = renderCatalogSummary(input.catalog);
	const factsBlock    = renderGapFacts(input.gapFacts);
	const cycleMemBlock = summarizeCycleMemory(input.cycleMemory);
	const retryAddendum = isRetry
		? [
			'',
			'## RETRY CORRECTION',
			`Your previous plan was rejected: ${priorFailureReason ?? 'unknown'}`,
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

function renderMemory(memory: MemoryShapeBundle): string {
	const lines: string[] = [];
	if (memory.system.length > 0)   { lines.push('### system\n' + memory.system); }
	if (memory.summary.length > 0)  { lines.push('### summary\n' + memory.summary); }
	if (memory.recent.length > 0)   { lines.push('### recent\n' + memory.recent); }
	if (memory.semantic.length > 0) { lines.push('### semantic\n' + memory.semantic); }
	if (memory.code.length > 0)     { lines.push('### code\n' + memory.code); }
	return lines.length > 0 ? lines.join('\n\n') : '(empty -- this is the first TODO of the report)';
}

function renderGapFacts(gapFactList: readonly RequiredFact[]): string {
	if (gapFactList.length === 0) { return '(no gap facts)'; }
	const lines: string[] = [];
	for (let i = 0; i < gapFactList.length; i++) {
		const f = gapFactList[i]!;
		lines.push(`[${i}] ${f.id} (${f.status})`);
		lines.push(`    fact: ${f.fact}`);
		lines.push(`    why:  ${f.why}`);
		if (f.suggestedSkills !== undefined && f.suggestedSkills.length > 0) {
			lines.push(`    suggested: ${f.suggestedSkills.join(', ')}`);
		}
	}
	return lines.join('\n');
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationOk {
	readonly ok:    true;
	readonly steps: readonly DiscoveryStep[];
}

interface ValidationErr {
	readonly ok:     false;
	readonly reason: string;
}

type ValidationResult = ValidationOk | ValidationErr;

function validate(raw: string, catalogIds: ReadonlySet<string>, maxFactIdx: number): ValidationResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch (err) {
		return { ok: false, reason: `JSON parse failed: ${(err as Error).message}` };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, reason: 'response is not a JSON object' };
	}
	const obj = parsed as Record<string, unknown>;
	const stepsRaw = obj['steps'];
	if (!Array.isArray(stepsRaw)) {
		return { ok: false, reason: '`steps` must be an array' };
	}
	if (stepsRaw.length === 0) {
		return { ok: false, reason: '`steps` must have at least one entry' };
	}
	if (stepsRaw.length > 12) {
		return { ok: false, reason: `steps has ${stepsRaw.length} entries; cap is 12` };
	}

	const seenStepIds = new Set<string>();
	// Earlier-step skill-id index, used to validate cross-step `dependsOn`
	// (the "stepId.skillId" form). Built as we coerce each step so step N
	// can declare a dep on any (step 0..N-1)'s skills.
	const earlierStepSkills = new Map<string, ReadonlySet<string>>();
	const steps: DiscoveryStep[] = [];
	for (let i = 0; i < stepsRaw.length; i++) {
		const sRaw = stepsRaw[i];
		if (sRaw === null || typeof sRaw !== 'object' || Array.isArray(sRaw)) {
			return { ok: false, reason: `steps[${i}] is not an object` };
		}
		const coerced = coerceStep(sRaw as Record<string, unknown>, i, catalogIds, maxFactIdx, earlierStepSkills);
		if (typeof coerced === 'string') {
			return { ok: false, reason: coerced };
		}
		if (seenStepIds.has(coerced.id)) {
			return { ok: false, reason: `steps[${i}].id "${coerced.id}" duplicates an earlier step` };
		}
		seenStepIds.add(coerced.id);
		earlierStepSkills.set(coerced.id, new Set(coerced.skills.map(s => s.id)));
		steps.push(coerced);
	}
	return { ok: true, steps };
}

export function coerceStep(
	raw:                Record<string, unknown>,
	idx:                number,
	catalogIds:         ReadonlySet<string>,
	maxFactIdx:         number,
	earlierStepSkills:  ReadonlyMap<string, ReadonlySet<string>>,
): DiscoveryStep | string {
	const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
	if (id.length === 0) {
		return `steps[${idx}].id missing or empty`;
	}
	const intent = typeof raw['intent'] === 'string' ? raw['intent'].trim() : '';
	if (intent.length < 5) {
		return `steps[${idx}].intent must be a concrete sentence (min 5 chars; got ${intent.length})`;
	}
	const skillsRaw = raw['skills'];
	if (!Array.isArray(skillsRaw) || skillsRaw.length === 0) {
		return `steps[${idx}].skills must be a non-empty array`;
	}
	if (skillsRaw.length > 6) {
		return `steps[${idx}].skills has ${skillsRaw.length} entries; cap is 6`;
	}
	const seenSkillIds = new Set<string>();
	const skills: PlannedSkillCall[] = [];
	for (let j = 0; j < skillsRaw.length; j++) {
		const skRaw = skillsRaw[j];
		if (skRaw === null || typeof skRaw !== 'object' || Array.isArray(skRaw)) {
			return `steps[${idx}].skills[${j}] is not an object`;
		}
		const sk = skRaw as Record<string, unknown>;
		const skId = typeof sk['id'] === 'string' ? sk['id'].trim() : '';
		if (skId.length === 0) {
			return `steps[${idx}].skills[${j}].id missing or empty`;
		}
		if (seenSkillIds.has(skId)) {
			return `steps[${idx}].skills[${j}].id "${skId}" duplicates an earlier skill in the same step`;
		}
		seenSkillIds.add(skId);
		const skillId = typeof sk['skillId'] === 'string' ? sk['skillId'].trim() : '';
		if (skillId.length === 0) {
			return `steps[${idx}].skills[${j}].skillId missing or empty`;
		}
		if (!catalogIds.has(skillId)) {
			return `steps[${idx}].skills[${j}].skillId "${skillId}" is not in the SKILL CATALOG; pick a real catalog id`;
		}
		const context = typeof sk['context'] === 'string' ? sk['context'].trim() : '';
		if (context.length === 0) {
			return `steps[${idx}].skills[${j}].context missing or empty`;
		}
		const dependsOnRaw = sk['dependsOn'];
		const dependsOn = typeof dependsOnRaw === 'string' && dependsOnRaw.trim().length > 0
			? dependsOnRaw.trim()
			: undefined;
		if (dependsOn !== undefined) {
			const depCheck = validateDependsOn(dependsOn, skId, seenSkillIds, earlierStepSkills);
			if (depCheck !== undefined) {
				return `steps[${idx}].skills[${j}].dependsOn ${depCheck}`;
			}
		}
		skills.push({
			id: skId, skillId, context,
			...(dependsOn !== undefined ? { dependsOn } : {}),
		});
	}

	const tcRaw = raw['targetsCriteria'];
	if (!Array.isArray(tcRaw) || tcRaw.length === 0) {
		return `steps[${idx}].targetsCriteria must be a non-empty array of fact indices`;
	}
	const targetsCriteria: number[] = [];
	const seenTC = new Set<number>();
	for (let k = 0; k < tcRaw.length; k++) {
		const v = tcRaw[k];
		if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > maxFactIdx) {
			return `steps[${idx}].targetsCriteria[${k}] = ${String(v)} is not a valid fact index (0..${maxFactIdx})`;
		}
		if (seenTC.has(v)) { continue; }   // silently dedupe
		seenTC.add(v);
		targetsCriteria.push(v);
	}

	return { id, intent, skills, targetsCriteria };
}

/**
 * Validate a `dependsOn` value. Two forms are accepted:
 *
 *   1. Intra-step: bare skill id of an earlier skill in THIS step
 *      (e.g. `"s1.a"` referenced from `s1.b`). Today's behaviour --
 *      the orchestrator pulls the within-step skillOutput.
 *
 *   2. Cross-step: `"stepId.skillId"` where `stepId` is an earlier
 *      step in the plan AND `skillId` is one of that step's skills
 *      (e.g. `"step-1.s1.b"` referenced from a skill in step-2).
 *      The orchestrator forwards the matching raw skill output from
 *      the per-TODO `crossStepRawOutputs` cache into the dependent
 *      step's priorOutputs.
 *
 * Returns `undefined` when valid, or a short error suffix that the
 * caller wraps with the location prefix.
 */
export function validateDependsOn(
	dependsOn:          string,
	currentSkillId:     string,
	seenSkillIdsInStep: ReadonlySet<string>,
	earlierStepSkills:  ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
	if (dependsOn === currentSkillId) {
		return `"${dependsOn}" must not reference itself`;
	}
	// Intra-step match wins. Our intra-step convention uses ids like
	// `"s1.a"` which themselves contain dots, so we MUST try the
	// full-string match against the current step's seen ids before
	// any cross-step parsing.
	if (seenSkillIdsInStep.has(dependsOn)) {
		return undefined;
	}
	// Cross-step form: "<stepId>.<skillId>". Split on the FIRST dot.
	// skillId may itself contain dots (e.g. `"step-1.s1.a"` ->
	// stepId="step-1", skillId="s1.a").
	const dotIdx = dependsOn.indexOf('.');
	if (dotIdx === -1) {
		return `"${dependsOn}" must reference an earlier skill id in the same step OR use the "stepId.skillId" cross-step form`;
	}
	const stepId  = dependsOn.slice(0, dotIdx);
	const skillId = dependsOn.slice(dotIdx + 1);
	if (stepId.length === 0 || skillId.length === 0) {
		return `"${dependsOn}" is not a valid "stepId.skillId" reference`;
	}
	const earlierSkills = earlierStepSkills.get(stepId);
	if (earlierSkills === undefined) {
		return `"${dependsOn}" references step "${stepId}" which is not an earlier step in this plan (or is the current step)`;
	}
	if (!earlierSkills.has(skillId)) {
		return `"${dependsOn}" references skill "${skillId}" which is not in step "${stepId}"`;
	}
	return undefined;
}

function stripFences(text: string): string {
	let out = text.trim();
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	}
	return out.trim();
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _validateForTest             = validate;
export const _coerceStepForTest           = coerceStep;
export const _renderGapFactsForTest       = renderGapFacts;
export const _renderCatalogSummaryForTest = renderCatalogSummary;
export const _stripFencesForTest          = stripFences;
export const _validateDependsOnForTest    = validateDependsOn;
