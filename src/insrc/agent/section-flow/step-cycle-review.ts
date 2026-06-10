/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stage 3 of the fact-gap-driven task loop -- Phase gamma of
 * plans/section-flow-fact-gap-loop.md.
 *
 * One LLM call per cycle. Takes the TODO + gap-facts list + this
 * cycle's StepOutput[] + cycleMemory and emits a
 * `CycleReviewResponse`:
 *
 *   - `keep`: step ids whose outputs are on-topic + useful (promoted
 *             to the retained ledger)
 *   - `new_steps`: discovery steps for the next cycle (empty = done)
 *   - `scratchpad`: optional free-form note carried into next cycle
 *
 * The reviewer is the GAP ANALYZER. It compares the retained ledger
 * (post-keep) against the canonical gapFacts list and decides what
 * remains uncovered.
 *
 * Validator enforces (per Decision #13 followup quality contract):
 *   - JSON schema fit
 *   - `keep` ids subset of this cycle's stepIds
 *   - `new_steps[]` follow the same rules as Stage 1 expansion:
 *     unique ids, skill catalog membership, valid targetsCriteria,
 *     concrete intents, valid `dependsOn`
 *
 * Failure handling for `new_steps[]`: bad entries are DROPPED with
 * a log warning rather than failing the whole review (the cycle
 * loop can still terminate or proceed with a partial set). Bad
 * `keep` ids fail the whole review (they reference outputs we
 * can't promote correctly).
 *
 * Retry policy: 1 corrective on top-level validation failure
 * (parse / shape / bad keep ids). Second failure throws.
 */

import type { CatalogSkill } from '../content-gen/plan-tree-runner.js';
import type {
	CycleMemory,
	CycleReviewResponse,
	DiscoveryStep,
	PlannedSkillCall,
	StepOutput,
} from '../content-gen/discovery-plan.js';
import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { RequiredFact } from './fact-gap-types.js';
import type { TodoSpec } from './types.js';
import { summarizeCycleMemory } from './cycle-memory.js';
import { validateDependsOn } from './step-discovery-plan-expansion.js';
import { getLogger } from '../../shared/logger.js';
import { getPromptRegistry } from '../prompts/registry.js';
import type { CycleReviewWriterInput } from '../prompts/writers/cycle-review.js';

const log = getLogger('section-flow:cycle-review');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CycleReviewInput {
	readonly todo:           TodoSpec;
	/** The gap facts the cycle is targeting (canonical coverage axis). */
	readonly gapFacts:       readonly RequiredFact[];
	/** Steps the orchestrator dispatched THIS cycle (drives keep-id validation). */
	readonly stepsThisCycle: readonly DiscoveryStep[];
	/** Outputs THIS cycle produced. */
	readonly cycleOutputs:   readonly StepOutput[];
	/** Memory snapshot heading into the review (carries priorAsks + coverage). */
	readonly cycleMemory:    CycleMemory;
	readonly cycle:          1 | 2 | 3;
	readonly catalog:        readonly CatalogSkill[];
	readonly provider:       LLMProvider;
}

/**
 * One reviewer-emitted closure claim extracted from `stepSummaries`.
 * The orchestrator reads this list directly to decide convergence
 * signals (Phase 5) without re-parsing the raw summary text.
 *
 * Phase 1 of plans/section-flow-architecture-redesign.md.
 */
export interface ClosureClaim {
	readonly stepId:  string;
	readonly callId:  string;
	/** Gap-fact id the marker referenced. `null` when verdict is `off-topic`. */
	readonly gapId:   string | null;
	readonly verdict: 'closes-fully' | 'partial' | 'off-topic';
}

export interface CycleReviewResult {
	readonly response:           CycleReviewResponse;
	readonly retried:            boolean;
	readonly droppedStepIds:     readonly string[];
	readonly firstFailureReason?: string | undefined;
	/**
	 * Reviewer-emitted per-skill-call goal-aware summary
	 * (`stepSummaries[stepId][callId] = "<claim>. <closure marker>"`).
	 * Empty when the reviewer omitted the field or returned an
	 * unparseable shape -- never raises. The orchestrator writes each
	 * summary back to the matching `artifact_vec` row via
	 * `updateArtifactSummary`.
	 *
	 * Phase 1 of plans/section-flow-architecture-redesign.md (v2
	 * writer).
	 */
	readonly stepSummaries:      Readonly<Record<string, Readonly<Record<string, string>>>>;
	/**
	 * Closure markers extracted from `stepSummaries` via regex scan.
	 * Each entry is one matched marker (a single summary may produce
	 * 0, 1, or many entries). Drives the convergence signal in
	 * Phase 5.
	 */
	readonly closureClaims:      readonly ClosureClaim[];
}

const MAX_REVIEW_TOKENS = 3072;

export async function runCycleReview(input: CycleReviewInput): Promise<CycleReviewResult> {
	const catalogIds   = new Set(input.catalog.map(c => c.id));
	const validStepIds = new Set(input.stepsThisCycle.map(s => s.id));
	const maxFactIdx   = Math.max(0, input.gapFacts.length - 1);
	// new_steps proposed by the reviewer can declare cross-step
	// `dependsOn` pointing at THIS cycle's outputs (raw skill outputs
	// the orchestrator has cached). Build the earlier-step skill index
	// from stepsThisCycle so the validator can verify the reference.
	const earlierStepSkills = new Map<string, ReadonlySet<string>>(
		input.stepsThisCycle.map(s => [s.id, new Set(s.skills.map(sk => sk.id))]),
	);
	const validCallIdsByStep = new Map<string, ReadonlySet<string>>(
		input.stepsThisCycle.map(s => [s.id, new Set(s.skills.map(sk => sk.id))]),
	);
	const gapIds = new Set(input.gapFacts.map(g => g.id));

	const firstAttempt = await callReview(input, false, undefined);
	const firstValidation = validate(firstAttempt.raw, validStepIds, catalogIds, maxFactIdx, earlierStepSkills);
	if (firstValidation.ok) {
		const summaries = extractStepSummaries(firstAttempt.raw, validCallIdsByStep);
		const closureClaims = scanClosureClaims(summaries, gapIds);
		log.info({
			todoId:        input.todo.id,
			cycle:         input.cycle,
			keepCount:     firstValidation.response.keep.length,
			newStepCount:  firstValidation.response.new_steps.length,
			droppedSteps:  firstValidation.droppedStepIds.length,
			summaryCount:  countSummaries(summaries),
			closureCount:  closureClaims.length,
		}, 'cycle review: first-attempt validated');
		return {
			response:        firstValidation.response,
			retried:         false,
			droppedStepIds:  firstValidation.droppedStepIds,
			stepSummaries:   summaries,
			closureClaims,
		};
	}

	log.warn({ todoId: input.todo.id, cycle: input.cycle, reason: firstValidation.reason }, 'cycle review: first-attempt rejected; retrying with corrective hint');

	const retry = await callReview(input, true, firstValidation.reason);
	const retryValidation = validate(retry.raw, validStepIds, catalogIds, maxFactIdx, earlierStepSkills);
	if (!retryValidation.ok) {
		throw new Error(`cycle review validation failed after retry: ${retryValidation.reason}`);
	}
	const retrySummaries = extractStepSummaries(retry.raw, validCallIdsByStep);
	const retryClosure = scanClosureClaims(retrySummaries, gapIds);
	log.info({
		todoId: input.todo.id, cycle: input.cycle,
		keepCount:    retryValidation.response.keep.length,
		summaryCount: countSummaries(retrySummaries),
		closureCount: retryClosure.length,
	}, 'cycle review: retry validated');
	return {
		response:           retryValidation.response,
		retried:            true,
		droppedStepIds:     retryValidation.droppedStepIds,
		firstFailureReason: firstValidation.reason,
		stepSummaries:      retrySummaries,
		closureClaims:      retryClosure,
	};
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface ReviewRaw {
	readonly raw: string;
}

async function callReview(
	input:              CycleReviewInput,
	isRetry:            boolean,
	priorFailureReason: string | undefined,
): Promise<ReviewRaw> {
	const writer = getPromptRegistry().get<CycleReviewWriterInput, readonly LLMMessage[]>('cycle-review');
	const messages = [...writer.build({
		todo:               input.todo,
		gapFacts:           input.gapFacts,
		stepsThisCycle:     input.stepsThisCycle,
		cycleOutputs:       input.cycleOutputs,
		cycleMemory:        input.cycleMemory,
		cycle:              input.cycle,
		catalog:            input.catalog,
		isRetry,
		priorFailureReason,
	})];
	const response = await input.provider.complete(messages, {
		maxTokens:       MAX_REVIEW_TOKENS,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	return { raw: response.text };
}

const REVIEW_ROLE = [
	'You are the CYCLE REVIEWER for one cycle of one TODO of an',
	'investigation report. You see the gap-facts list the cycle is',
	'targeting + the outputs this cycle produced + prior-cycle context,',
	'and you decide three things:',
	'',
	'  - WHICH of this cycle\'s outputs are on-topic + useful (promote to',
	'    the retained ledger via `keep`).',
	'  - WHAT remains uncovered (emit `new_steps` for the next cycle to',
	'    acquire; empty array means we\'re done).',
	'  - OPTIONALLY a brief carry-forward note (`scratchpad`).',
	'',
	'You emit a SINGLE JSON object: { "keep": [...], "new_steps": [...],',
	'"scratchpad"?: "..." }. No prose, no markdown fences, no preamble.',
].join('\n');

function buildReviewUser(
	input:              CycleReviewInput,
	isRetry:            boolean,
	priorFailureReason: string | undefined,
): string {
	const factsBlock     = renderGapFacts(input.gapFacts);
	const outputsBlock   = renderCycleOutputs(input.cycleOutputs, input.stepsThisCycle);
	const cycleMemBlock  = summarizeCycleMemory(input.cycleMemory);
	const catalogBlock   = renderCatalogSummary(input.catalog);
	const retryAddendum  = isRetry
		? [
			'',
			'## RETRY CORRECTION',
			`Your previous response was rejected: ${priorFailureReason ?? 'unknown'}`,
			'Emit a new JSON object that satisfies every rule below.',
			'',
		].join('\n')
		: '';

	const lines: string[] = [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## GAP FACTS (coverage targets; indices are stable for targetsCriteria)',
		factsBlock,
		'',
		`## CYCLE: ${input.cycle}`,
		'',
		'## THIS CYCLE\'S STEP OUTPUTS',
		outputsBlock,
	];
	if (cycleMemBlock.length > 0) {
		lines.push('');
		lines.push('## PRIOR CYCLE CONTEXT');
		lines.push('');
		lines.push(cycleMemBlock);
	}
	lines.push('');
	lines.push('## OUTPUT SHAPE');
	lines.push('');
	lines.push('{');
	lines.push('  "keep": ["step-1", "step-3"],                  // ids from THIS CYCLE\'S step outputs');
	lines.push('  "new_steps": [                                 // empty array = terminate');
	lines.push('    {');
	lines.push('      "id": "step-N",');
	lines.push('      "intent": "concrete sentence -- which gap fact + why prior attempt missed",');
	lines.push('      "skills": [');
	lines.push('        { "id": "sN.a", "skillId": "<catalog id>", "context": "literal args" }');
	lines.push('      ],');
	lines.push('      "targetsCriteria": [0, 1]                   // indices into GAP FACTS');
	lines.push('    }');
	lines.push('  ],');
	lines.push('  "scratchpad": "optional <=300 char carry-forward note"');
	lines.push('}');
	lines.push('');
	lines.push('## RULES');
	lines.push('  - `keep` ids MUST be from THIS CYCLE\'S step outputs only (see above).');
	lines.push('  - `new_steps` items follow the discovery-plan-expansion rules:');
	lines.push('      * each step has a concrete intent sentence');
	lines.push('      * each PlannedSkillCall.skillId MUST be in the SKILL CATALOG');
	lines.push('      * each step.targetsCriteria is a non-empty array of valid fact indices (0..' + String(Math.max(0, input.gapFacts.length - 1)) + ')');
	lines.push('      * context for each skill call carries the literal args (file path / class name / connection id / etc.)');
	lines.push('  - Emit `new_steps: []` to terminate the cycle loop when every gap fact is now covered (or the remaining gaps are unrecoverable with available skills).');
	if (input.cycle > 1) {
		lines.push('  - DO NOT re-emit a step whose (skillId, context) matches an already-attempted step in PRIOR CYCLE CONTEXT with failed/open coverage. Try a different angle (different args, different skill, decomposed sub-fact).');
	}
	lines.push('  - `scratchpad` is optional. Use it for qualitative judgements the mechanical coverage map can\'t capture (e.g. "the class file uses non-standard import paths -- flag for writer").');
	lines.push(retryAddendum);
	lines.push('');
	lines.push(catalogBlock);
	lines.push('');
	lines.push('## TASK');
	lines.push('Emit the JSON object now. Begin with "{" and end with "}".');
	return lines.join('\n');
}

function renderGapFacts(gapFactList: readonly RequiredFact[]): string {
	if (gapFactList.length === 0) { return '(no gap facts)'; }
	const lines: string[] = [];
	for (let i = 0; i < gapFactList.length; i++) {
		const f = gapFactList[i]!;
		lines.push(`[${i}] ${f.id} (${f.status})`);
		lines.push(`    fact: ${f.fact}`);
		lines.push(`    why:  ${f.why}`);
	}
	return lines.join('\n');
}

function renderCycleOutputs(
	outputs:        readonly StepOutput[],
	stepsThisCycle: readonly DiscoveryStep[],
): string {
	if (outputs.length === 0) { return '(no outputs)'; }
	const stepsById = new Map(stepsThisCycle.map(s => [s.id, s] as const));
	const lines: string[] = [];
	for (const out of outputs) {
		const step = stepsById.get(out.stepId);
		const intent = step !== undefined ? step.intent : '(no step definition)';
		lines.push(`### ${out.stepId} (status: ${out.status}) -- ${intent}`);
		if (out.facts.length === 0) {
			lines.push('  facts: (none)');
		} else {
			for (const f of out.facts) {
				lines.push(`  - ${f}`);
			}
		}
		if (out.citations.length > 0) {
			lines.push(`  citations: ${out.citations.length}`);
		}
		lines.push('');
	}
	return lines.join('\n').trimEnd();
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
	readonly ok:              true;
	readonly response:        CycleReviewResponse;
	readonly droppedStepIds:  readonly string[];
}

interface ValidationErr {
	readonly ok:     false;
	readonly reason: string;
}

type ValidationResult = ValidationOk | ValidationErr;

function validate(
	raw:                string,
	validStepIds:       ReadonlySet<string>,
	catalogIds:         ReadonlySet<string>,
	maxFactIdx:         number,
	earlierStepSkills:  ReadonlyMap<string, ReadonlySet<string>>,
): ValidationResult {
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

	// keep: must be an array of strings; every id must be from this cycle.
	const keepRaw = obj['keep'];
	if (!Array.isArray(keepRaw)) {
		return { ok: false, reason: '`keep` must be an array of step ids' };
	}
	const keep: string[] = [];
	const seenKeep = new Set<string>();
	for (let i = 0; i < keepRaw.length; i++) {
		const v = keepRaw[i];
		if (typeof v !== 'string' || v.trim().length === 0) {
			return { ok: false, reason: `keep[${i}] is not a non-empty string` };
		}
		const id = v.trim();
		if (!validStepIds.has(id)) {
			return { ok: false, reason: `keep[${i}] "${id}" is not from this cycle's step outputs (valid: ${[...validStepIds].join(', ') || '(none)'})` };
		}
		if (seenKeep.has(id)) { continue; }   // dedupe silently
		seenKeep.add(id);
		keep.push(id);
	}

	// new_steps: array (may be empty); each entry validated permissively
	// (drop bad entries with warn rather than fail the whole review).
	const newStepsRaw = obj['new_steps'];
	if (!Array.isArray(newStepsRaw)) {
		return { ok: false, reason: '`new_steps` must be an array (use [] to terminate)' };
	}
	if (newStepsRaw.length > 12) {
		return { ok: false, reason: `new_steps has ${newStepsRaw.length} entries; cap is 12` };
	}
	const newSteps: DiscoveryStep[] = [];
	const droppedStepIds: string[] = [];
	const seenNewStepIds = new Set<string>();
	for (let i = 0; i < newStepsRaw.length; i++) {
		const sRaw = newStepsRaw[i];
		if (sRaw === null || typeof sRaw !== 'object' || Array.isArray(sRaw)) {
			log.warn({ idx: i }, 'cycle review: dropping new_steps entry that is not an object');
			droppedStepIds.push(`<idx-${i}>`);
			continue;
		}
		const coerced = coerceNewStep(sRaw as Record<string, unknown>, i, catalogIds, maxFactIdx, seenNewStepIds, earlierStepSkills);
		if (typeof coerced === 'string') {
			log.warn({ idx: i, reason: coerced }, 'cycle review: dropping new_steps entry');
			const rawId = (sRaw as Record<string, unknown>)['id'];
			droppedStepIds.push(typeof rawId === 'string' ? rawId : `<idx-${i}>`);
			continue;
		}
		seenNewStepIds.add(coerced.id);
		newSteps.push(coerced);
	}

	// scratchpad: optional string
	let scratchpad: string | undefined;
	const sp = obj['scratchpad'];
	if (typeof sp === 'string' && sp.trim().length > 0) {
		scratchpad = sp.trim().slice(0, 500);
	}

	const response: CycleReviewResponse = {
		keep,
		new_steps: newSteps,
		...(scratchpad !== undefined ? { scratchpad } : {}),
	};
	return { ok: true, response, droppedStepIds };
}

function coerceNewStep(
	raw:                Record<string, unknown>,
	idx:                number,
	catalogIds:         ReadonlySet<string>,
	maxFactIdx:         number,
	seenStepIds:        ReadonlySet<string>,
	earlierStepSkills:  ReadonlyMap<string, ReadonlySet<string>>,
): DiscoveryStep | string {
	const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
	if (id.length === 0) { return `new_steps[${idx}].id missing or empty`; }
	if (seenStepIds.has(id)) { return `new_steps[${idx}].id "${id}" duplicates an earlier new_step`; }

	const intent = typeof raw['intent'] === 'string' ? raw['intent'].trim() : '';
	if (intent.length < 5) { return `new_steps[${idx}].intent must be a concrete sentence (min 5 chars)`; }

	const skillsRaw = raw['skills'];
	if (!Array.isArray(skillsRaw) || skillsRaw.length === 0) {
		return `new_steps[${idx}].skills must be a non-empty array`;
	}
	if (skillsRaw.length > 6) {
		return `new_steps[${idx}].skills has ${skillsRaw.length} entries; cap is 6`;
	}
	const skills: PlannedSkillCall[] = [];
	const seenSkillIds = new Set<string>();
	for (let j = 0; j < skillsRaw.length; j++) {
		const skRaw = skillsRaw[j];
		if (skRaw === null || typeof skRaw !== 'object' || Array.isArray(skRaw)) {
			return `new_steps[${idx}].skills[${j}] is not an object`;
		}
		const sk = skRaw as Record<string, unknown>;
		const skId = typeof sk['id'] === 'string' ? sk['id'].trim() : '';
		if (skId.length === 0) { return `new_steps[${idx}].skills[${j}].id missing or empty`; }
		if (seenSkillIds.has(skId)) { return `new_steps[${idx}].skills[${j}].id "${skId}" duplicates`; }
		seenSkillIds.add(skId);
		const skillId = typeof sk['skillId'] === 'string' ? sk['skillId'].trim() : '';
		if (skillId.length === 0) { return `new_steps[${idx}].skills[${j}].skillId missing or empty`; }
		if (!catalogIds.has(skillId)) {
			return `new_steps[${idx}].skills[${j}].skillId "${skillId}" is not in the SKILL CATALOG`;
		}
		const context = typeof sk['context'] === 'string' ? sk['context'].trim() : '';
		if (context.length === 0) { return `new_steps[${idx}].skills[${j}].context missing or empty`; }
		const dependsOnRaw = sk['dependsOn'];
		const dependsOn = typeof dependsOnRaw === 'string' && dependsOnRaw.trim().length > 0
			? dependsOnRaw.trim()
			: undefined;
		if (dependsOn !== undefined) {
			const depCheck = validateDependsOn(dependsOn, skId, seenSkillIds, earlierStepSkills);
			if (depCheck !== undefined) {
				return `new_steps[${idx}].skills[${j}].dependsOn ${depCheck}`;
			}
		}
		skills.push({
			id: skId, skillId, context,
			...(dependsOn !== undefined ? { dependsOn } : {}),
		});
	}

	const tcRaw = raw['targetsCriteria'];
	if (!Array.isArray(tcRaw) || tcRaw.length === 0) {
		return `new_steps[${idx}].targetsCriteria must be a non-empty array of fact indices`;
	}
	const targetsCriteria: number[] = [];
	const seenTC = new Set<number>();
	for (let k = 0; k < tcRaw.length; k++) {
		const v = tcRaw[k];
		if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > maxFactIdx) {
			return `new_steps[${idx}].targetsCriteria[${k}] = ${String(v)} is not a valid fact index (0..${maxFactIdx})`;
		}
		if (seenTC.has(v)) { continue; }
		seenTC.add(v);
		targetsCriteria.push(v);
	}

	return { id, intent, skills, targetsCriteria };
}

function stripFences(text: string): string {
	let out = text.trim();
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	}
	return out.trim();
}

// ---------------------------------------------------------------------------
// stepSummaries extraction (lenient -- never throws; Phase 1 v2 writer)
// ---------------------------------------------------------------------------

/**
 * Pull `stepSummaries: { [stepId]: { [callId]: string } }` from the
 * raw response. Lenient on every axis:
 *
 *   - missing / non-object `stepSummaries` -> `{}` (logged once)
 *   - inner non-object -> dropped (logged)
 *   - inner key not in the cycle's declared (stepId, callId) tuples
 *     -> dropped (logged)
 *   - empty / non-string value -> dropped silently
 *
 * Never fails the review. Each accepted entry lands on the artifact
 * row via `updateArtifactSummary`. The closure marker scan runs over
 * the accepted summaries only.
 */
export function extractStepSummaries(
	raw:                 string,
	validCallIdsByStep:  ReadonlyMap<string, ReadonlySet<string>>,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch {
		return {};
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {};
	}
	const ssRaw = (parsed as Record<string, unknown>)['stepSummaries'];
	if (ssRaw === undefined) {
		return {};
	}
	if (ssRaw === null || typeof ssRaw !== 'object' || Array.isArray(ssRaw)) {
		log.warn({}, 'cycle review: stepSummaries is not a JSON object; ignoring');
		return {};
	}
	const out: Record<string, Record<string, string>> = {};
	for (const [stepId, callMapRaw] of Object.entries(ssRaw as Record<string, unknown>)) {
		const validCalls = validCallIdsByStep.get(stepId);
		if (validCalls === undefined) {
			log.warn({ stepId }, 'cycle review: stepSummaries stepId not declared this cycle; dropping');
			continue;
		}
		if (callMapRaw === null || typeof callMapRaw !== 'object' || Array.isArray(callMapRaw)) {
			log.warn({ stepId }, 'cycle review: stepSummaries[stepId] is not an object; dropping');
			continue;
		}
		const innerOut: Record<string, string> = {};
		for (const [callId, valueRaw] of Object.entries(callMapRaw as Record<string, unknown>)) {
			if (!validCalls.has(callId)) {
				log.warn({ stepId, callId }, 'cycle review: stepSummaries callId not declared in this step; dropping');
				continue;
			}
			if (typeof valueRaw !== 'string') {
				continue;
			}
			const trimmed = valueRaw.trim();
			if (trimmed.length === 0) {
				continue;
			}
			innerOut[callId] = trimmed;
		}
		if (Object.keys(innerOut).length > 0) {
			out[stepId] = innerOut;
		}
	}
	return out;
}

/**
 * Scan accepted stepSummaries for closure markers. The vocabulary
 * is fixed (taught in the writer prompt):
 *
 *   - `CLOSES <gap-id> fully`           -> verdict `closes-fully`
 *   - `PARTIALLY supports <gap-id>`     -> verdict `partial`
 *   - `OFF-TOPIC` (or `OFF TOPIC`)      -> verdict `off-topic`, gapId null
 *
 * Multiple markers per summary are allowed (chained with `;`). A
 * marker whose `<gap-id>` isn't in the cycle's gap-fact set is
 * dropped with a log warn -- prevents fabricated coverage claims
 * from reaching the convergence logic.
 *
 * Match is case-insensitive on the keyword; the captured `<gap-id>`
 * is preserved verbatim and compared case-sensitively against the
 * gap-fact id set (matching how the rest of the codebase treats
 * ids).
 */
export function scanClosureClaims(
	summaries: Readonly<Record<string, Readonly<Record<string, string>>>>,
	gapIds:    ReadonlySet<string>,
): readonly ClosureClaim[] {
	const out: ClosureClaim[] = [];
	const reCloses    = /CLOSES\s+([A-Za-z0-9_.-]+)\s+fully/gi;
	const rePartial   = /PARTIALLY\s+supports\s+([A-Za-z0-9_.-]+)/gi;
	const reOffTopic  = /OFF[\s-]TOPIC/gi;
	for (const [stepId, callMap] of Object.entries(summaries)) {
		for (const [callId, summary] of Object.entries(callMap)) {
			let touched = false;
			reCloses.lastIndex = 0;
			rePartial.lastIndex = 0;
			reOffTopic.lastIndex = 0;
			for (let m: RegExpExecArray | null = reCloses.exec(summary); m !== null; m = reCloses.exec(summary)) {
				const gapId = m[1] ?? '';
				if (!gapIds.has(gapId)) {
					log.warn({ stepId, callId, gapId }, 'cycle review: CLOSES marker references unknown gap-id; dropping');
					continue;
				}
				out.push({ stepId, callId, gapId, verdict: 'closes-fully' });
				touched = true;
			}
			for (let m: RegExpExecArray | null = rePartial.exec(summary); m !== null; m = rePartial.exec(summary)) {
				const gapId = m[1] ?? '';
				if (!gapIds.has(gapId)) {
					log.warn({ stepId, callId, gapId }, 'cycle review: PARTIALLY marker references unknown gap-id; dropping');
					continue;
				}
				out.push({ stepId, callId, gapId, verdict: 'partial' });
				touched = true;
			}
			if (reOffTopic.test(summary)) {
				out.push({ stepId, callId, gapId: null, verdict: 'off-topic' });
				touched = true;
			}
			if (!touched) {
				log.warn({ stepId, callId, summary: summary.slice(0, 80) }, 'cycle review: stepSummaries entry has no recognised closure marker');
			}
		}
	}
	return out;
}

function countSummaries(
	summaries: Readonly<Record<string, Readonly<Record<string, string>>>>,
): number {
	let n = 0;
	for (const inner of Object.values(summaries)) {
		n += Object.keys(inner).length;
	}
	return n;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _validateForTest             = validate;
export const _coerceNewStepForTest        = coerceNewStep;
export const _renderCycleOutputsForTest   = renderCycleOutputs;
export const _renderGapFactsForTest       = renderGapFacts;
export const _stripFencesForTest          = stripFences;
export const _extractStepSummariesForTest = extractStepSummaries;
export const _scanClosureClaimsForTest    = scanClosureClaims;
