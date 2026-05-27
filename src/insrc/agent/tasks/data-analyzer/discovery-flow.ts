/**
 * runDataDiscoveryFlow -- multi-cycle discovery for the data analyzer
 * (Phase C.2 of plans/analyzers/data-analyzer-parity.md).
 *
 * Mirrors agent/tasks/code-analyzer/discovery-flow.ts but adapted
 * for data tasks. Per-task structure:
 *
 *   cycle 1:
 *     cloud.expandDataDiscoveryPlan(task, cycle=1, emptyCycleMemory)
 *     local.executeDataStep × N steps
 *     cloud.reviewDataCycle(stepOutputs, cycleMemory)
 *       -> { keep, new_steps, scratchpad }
 *     retainedLedger += keptStepOutputs
 *     cycleMemory.priorAsks += { cycle: 1, steps }
 *     cycleMemory.scratchpad = response.scratchpad ?? carry-forward
 *
 *   cycle 2 / 3 (if new_steps from prior cycle is non-empty):
 *     local.executeDataStep × new_steps
 *     cloud.reviewDataCycle(...)
 *     retainedLedger += newly-kept
 *
 *   terminate (cycle == maxCycles OR empty new_steps).
 *
 * Returns the retained `ExecuteDataStepOutput[]` for Phase E's
 * evidence-anchored writer to consume. The write phase + prose
 * review + redraft loop live in Phase E (write-from-evidence.ts +
 * claim-grounding-reviewer.ts), not here.
 *
 * Plan SCS analog for data: per-step connection-scope check. The
 * planner is given the task's scope (allowed connection ids); if a
 * planned step's skill args reference a connection NOT in the scope
 * closure, the step is rejected before execution. The check is
 * applied AFTER guard's session-default inject so the planner doesn't
 * have to repeat the connectionId on every call -- the guard fills
 * it in from the task scope.
 */

import type { LLMProvider, LLMMessage } from '../../../shared/types.js';
import type { Session } from '../../session.js';
import { getLogger } from '../../../shared/logger.js';
import { listSkills } from '../../../daemon/skills/registry.js';
import {
	type CycleMemory,
	type CycleReviewResponse,
	type DiscoveryPlan,
	type DiscoveryStep,
	type PlannedSkillCall,
	type StepOutput,
	emptyCycleMemory,
	DISCOVERY_PLAN_SCHEMA,
	CYCLE_REVIEW_RESPONSE_SCHEMA,
} from '../../content-gen/discovery-plan.js';

import {
	executeDataStep,
	type ExecuteDataStepOutput,
} from './execute-step.js';
import type { DataSessionDefaults } from './tool-call-guard.js';
import type {
	ConnectionSummary,
	DataAnalysisTask,
	DataEvidenceEntry,
} from './types.js';

const log = getLogger('data-analyzer:discovery-flow');

const PLANNER_MAX_TOKENS = 3000;
const REVIEWER_MAX_TOKENS = 2000;
const MAX_ATTEMPTS = 3;
const SKILL_CATALOG_MAX_LEN = 80; // truncate each skill description

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunDataDiscoveryFlowInput {
	readonly localProvider:    LLMProvider;
	readonly cloudProvider:    LLMProvider;
	readonly session:          Session;
	readonly task:             DataAnalysisTask;
	readonly connections:      readonly ConnectionSummary[];
	readonly sessionDefaults?: DataSessionDefaults | undefined;
	/** Hard cap on cycles. Default 3. */
	readonly maxCycles?:       number | undefined;
	readonly onProgress?:      ((msg: string) => void) | undefined;
}

export interface DataDiscoveryFlowResult {
	readonly retainedSteps:    readonly ExecuteDataStepOutput[];
	/**
	 * Flat aggregation of all retained evidence across kept steps.
	 * Phase E's writer consumes this directly to render prose +
	 * inline citations.
	 */
	readonly retainedEvidence: readonly DataEvidenceEntry[];
	readonly cyclesRun:        number;
	readonly perCycleSummary:  readonly {
		readonly cycle:       1 | 2 | 3;
		readonly stepsRun:    number;
		readonly keptIds:     readonly string[];
		readonly newStepsAsk: number;
	}[];
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runDataDiscoveryFlow(
	input: RunDataDiscoveryFlowInput,
): Promise<DataDiscoveryFlowResult> {
	const maxCycles = Math.min(input.maxCycles ?? 3, 3) as 1 | 2 | 3;
	const perCycleSummary: {
		cycle:       1 | 2 | 3;
		stepsRun:    number;
		keptIds:     readonly string[];
		newStepsAsk: number;
	}[] = [];
	const retainedSteps: ExecuteDataStepOutput[] = [];
	const stepsById: Map<string, DiscoveryStep> = new Map();
	// Reuse code-side emptyCycleMemory helper. It needs `reviewCriteria`
	// which on the data side we derive from the task's question + scope.
	// One synthetic criterion is enough for cycle bookkeeping; the
	// reviewer doesn't gate on criteria coverage on the data side.
	let cycleMemory: CycleMemory = emptyCycleMemory([input.task.question]);
	let stepsToRun: readonly DiscoveryStep[] = [];

	const allowedConnections = new Set(
		input.task.scope?.connections ?? input.connections.map(c => c.id),
	);

	for (let c = 1; c <= maxCycles; c++) {
		const cycle = c as 1 | 2 | 3;
		input.onProgress?.(`  [${input.task.itemId}] data discovery cycle ${cycle}/${maxCycles}`);

		// Cycle 1: get the initial plan from the cloud planner.
		// Cycle 2/3: use the new_steps the prior cycle's reviewer emitted.
		if (cycle === 1) {
			const plan = await expandDataDiscoveryPlan(input, cycle, cycleMemory);
			stepsToRun = plan.steps;
		}

		// Plan-SCS analog: drop any step whose first skill targets a
		// connection outside the task scope. The session-default inject
		// (Phase B guard) won't help -- if the planner explicitly named
		// a foreign connectionId, that's a scope leak we should reject.
		stepsToRun = filterStepsToScope(stepsToRun, allowedConnections);

		for (const s of stepsToRun) stepsById.set(s.id, s);

		// Execute each step on the local provider (multi-turn-safe). The
		// per-step tool-loop uses the Phase D guard (Stage 4 corrective)
		// to handle LLM arg mistakes inline.
		const cycleOutputs: ExecuteDataStepOutput[] = [];
		for (const step of stepsToRun) {
			input.onProgress?.(`  [${input.task.itemId}/${step.id}] ${step.intent}`);
			const out = await executeDataStep({
				provider:    input.localProvider,
				session:     input.session,
				step,
				...(input.sessionDefaults !== undefined ? { sessionDefaults: input.sessionDefaults } : {}),
				connections: input.connections,
				...(input.onProgress      !== undefined ? { onProgress:      input.onProgress      } : {}),
			});
			cycleOutputs.push(out);
		}

		// Cloud reviews this cycle's outputs.
		const review = await reviewDataCycle(input, cycle, cycleOutputs, cycleMemory);

		const keptSet = new Set(review.keep);
		const keptThisCycle = cycleOutputs.filter(o => keptSet.has(o.stepId));
		retainedSteps.push(...keptThisCycle);

		perCycleSummary.push({
			cycle,
			stepsRun:    stepsToRun.length,
			keptIds:     keptThisCycle.map(o => o.stepId),
			newStepsAsk: review.new_steps.length,
		});

		const nextScratchpad = review.scratchpad ?? cycleMemory.scratchpad;
		cycleMemory = {
			priorAsks: [
				...cycleMemory.priorAsks,
				{ cycle, steps: stepsToRun.map(s => ({ id: s.id, intent: s.intent })) },
			],
			criteriaCoverage: cycleMemory.criteriaCoverage,
			scratchpad: nextScratchpad,
		};

		log.info({
			itemId:         input.task.itemId,
			cycle,
			stepsRun:       stepsToRun.length,
			kept:           keptThisCycle.length,
			newStepsAsk:    review.new_steps.length,
			retainedTotal:  retainedSteps.length,
		}, 'discovery-flow: cycle complete');

		if (review.new_steps.length === 0) {
			input.onProgress?.(`  [${input.task.itemId}] cycle ${cycle} terminated -- reviewer accepted current ledger`);
			break;
		}
		if (cycle === maxCycles) {
			input.onProgress?.(`  [${input.task.itemId}] cycle cap reached (${maxCycles})`);
			break;
		}
		stepsToRun = review.new_steps;
	}

	const retainedEvidence: DataEvidenceEntry[] = retainedSteps.flatMap(s => [...s.evidence]);

	return {
		retainedSteps,
		retainedEvidence,
		cyclesRun:       perCycleSummary.length,
		perCycleSummary,
	};
}

// ---------------------------------------------------------------------------
// Plan-SCS analog: connection-scope filter
// ---------------------------------------------------------------------------

/**
 * Drop steps whose first skill targets a connection outside the
 * task's allowed scope. Conservative: only checks `args.connectionId`
 * literally referenced in the planned skill call's args field if
 * present; the executor's Phase-B guard fills missing connectionId
 * from session-defaults, so unfilled steps survive this filter and
 * inherit the active task's connection at dispatch time.
 */
function filterStepsToScope(
	steps:               readonly DiscoveryStep[],
	allowedConnections:  ReadonlySet<string>,
): readonly DiscoveryStep[] {
	if (allowedConnections.size === 0) return steps;
	const out: DiscoveryStep[] = [];
	for (const step of steps) {
		const offending = findScopeViolation(step.skills, allowedConnections);
		if (offending !== null) {
			log.warn(
				{
					stepId:               step.id,
					offendingConnectionId: offending,
					allowedConnections:    [...allowedConnections],
				},
				'discovery-flow: dropping step that targets out-of-scope connection (Plan-SCS analog)',
			);
			continue;
		}
		out.push(step);
	}
	return out;
}

function findScopeViolation(
	skills:             readonly PlannedSkillCall[],
	allowedConnections: ReadonlySet<string>,
): string | null {
	for (const sk of skills) {
		// PlannedSkillCall.context is free-form text; we can't reliably
		// extract connectionId from it. The reviewer's `keep` decision
		// is the authoritative check on whether the step produced
		// relevant evidence; this filter is a cheap pre-gate that only
		// fires when the planner LITERALLY names a foreign connection
		// in the step intent or context. Look for `connectionId: "X"`
		// patterns and `connection X` mentions.
		const ctx = sk.context.toLowerCase();
		const match = ctx.match(/connection\s*(?:id)?[\s:=]+['"]?([a-z0-9_-]+)['"]?/i);
		if (match !== null) {
			const named = match[1]!;
			if (!allowedConnections.has(named)) {
				return named;
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Planner -- expandDataDiscoveryPlan (cloud LLM)
// ---------------------------------------------------------------------------

async function expandDataDiscoveryPlan(
	input:       RunDataDiscoveryFlowInput,
	cycle:       1 | 2 | 3,
	cycleMemory: CycleMemory,
): Promise<DiscoveryPlan> {
	const messages = buildPlannerMessages(input, cycle, cycleMemory);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await input.cloudProvider.complete(messages, {
				maxTokens:      PLANNER_MAX_TOKENS,
				temperature:    0,
				responseFormat: { schema: DISCOVERY_PLAN_SCHEMA },
			});
			const parsed = parseJsonStrict(response.text);
			if (parsed === null) {
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			const validated = validateDiscoveryPlan(parsed, cycle);
			if (validated !== null) {
				return validated;
			}
		} catch (err) {
			log.warn({ attempt, err: (err as Error).message }, 'expandDataDiscoveryPlan: provider error');
			if (attempt === MAX_ATTEMPTS) break;
		}
	}
	log.warn({ itemId: input.task.itemId, cycle }, 'expandDataDiscoveryPlan: all attempts failed -- fallback plan');
	return fallbackPlan(input, cycle);
}

function buildPlannerMessages(
	input:       RunDataDiscoveryFlowInput,
	cycle:       1 | 2 | 3,
	cycleMemory: CycleMemory,
): LLMMessage[] {
	const system = [
		'You are decomposing a data-analysis question into discovery STEPS.',
		'Each step names ONE concrete sub-investigation; each step contains',
		'1-6 typed skill calls that pull the data needed to answer that sub-',
		'investigation. The orchestrator runs the steps in order, summarises',
		'each result, then asks YOU again whether to keep / extend / stop.',
		'',
		'Output STRICT JSON matching the response schema (no prose, no',
		'preamble). Skill ids MUST come from the data-skill catalog below.',
		'',
		'## Available data skills',
		buildSkillCatalogSummary(),
		'',
		'## Connection-scope contract',
		'The task names which connection(s) are in scope. Every skill call',
		'MUST target an in-scope connection. The orchestrator silently',
		'injects the active connectionId when omitted; you do NOT need to',
		'repeat it on every skill call unless the skill takes multiple',
		'connection args.',
	].join('\n');

	const userLines: string[] = [];
	userLines.push('## Task to investigate');
	userLines.push(`question: ${input.task.question}`);
	userLines.push(`kind:     ${input.task.kind}`);
	if (input.task.hint !== undefined && input.task.hint.length > 0) {
		userLines.push(`hint:     ${input.task.hint}`);
	}
	userLines.push('');

	if (input.task.scope !== undefined) {
		userLines.push('## Scope');
		if (input.task.scope.connections !== undefined && input.task.scope.connections.length > 0) {
			userLines.push(`connections: ${input.task.scope.connections.join(', ')}`);
		}
		if (input.task.scope.targets !== undefined && input.task.scope.targets.length > 0) {
			userLines.push(`targets:     ${input.task.scope.targets.join(', ')}`);
		}
		userLines.push('');
	}

	if (input.connections.length > 0) {
		userLines.push('## Active connections in this session');
		for (const conn of input.connections) {
			const prodTag = conn.prod ? ' [PROD]' : '';
			const piiTag  = conn.hasPiiConfig ? ' [PII]' : '';
			userLines.push(`  - ${conn.id} (${conn.family}/${conn.kind})${prodTag}${piiTag}`);
		}
		userLines.push('');
	}

	userLines.push(`## Cycle ${cycle} of 3`);
	if (cycle > 1 && cycleMemory.priorAsks.length > 0) {
		userLines.push('');
		userLines.push('## Prior cycles');
		for (const ask of cycleMemory.priorAsks) {
			userLines.push(`cycle ${ask.cycle}: ${ask.steps.map(s => `${s.id} (${s.intent})`).join('; ')}`);
		}
		if (cycleMemory.scratchpad.length > 0) {
			userLines.push('');
			userLines.push('## Reviewer scratchpad');
			userLines.push(cycleMemory.scratchpad);
		}
	}

	userLines.push('');
	userLines.push('## Response schema');
	userLines.push('Your response MUST be strict JSON matching:');
	userLines.push('```json');
	userLines.push(JSON.stringify(DISCOVERY_PLAN_SCHEMA, null, 2));
	userLines.push('```');
	userLines.push('');
	userLines.push(`Set \`cycle: ${cycle}\` in your response.`);

	return [
		{ role: 'system', content: system },
		{ role: 'user',   content: userLines.join('\n') },
	];
}

function fallbackPlan(input: RunDataDiscoveryFlowInput, cycle: 1 | 2 | 3): DiscoveryPlan {
	// The planner failed catastrophically. Fall back to "list connections"
	// so the loop terminates with at least one piece of evidence. The
	// reviewer will likely emit empty new_steps next and the discovery
	// flow ends gracefully.
	return {
		cycle,
		steps: [{
			id:              'step-fallback-1',
			intent:          `Inventory connections (fallback for: ${input.task.question})`,
			skills: [
				{
					id:      'sf.a',
					skillId: 'data.source.rdbms.list-tables',
					context: 'list tables in the active session connection',
				},
			],
			targetsCriteria: [0],
		}],
	};
}

// ---------------------------------------------------------------------------
// Reviewer -- reviewDataCycle (cloud LLM)
// ---------------------------------------------------------------------------

async function reviewDataCycle(
	input:        RunDataDiscoveryFlowInput,
	cycle:        1 | 2 | 3,
	cycleOutputs: readonly ExecuteDataStepOutput[],
	cycleMemory:  CycleMemory,
): Promise<CycleReviewResponse> {
	const messages = buildReviewerMessages(input, cycle, cycleOutputs, cycleMemory);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await input.cloudProvider.complete(messages, {
				maxTokens:      REVIEWER_MAX_TOKENS,
				temperature:    0,
				responseFormat: { schema: CYCLE_REVIEW_RESPONSE_SCHEMA },
			});
			const parsed = parseJsonStrict(response.text);
			if (parsed === null) {
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			const validated = validateCycleReview(parsed, cycleOutputs);
			if (validated !== null) {
				return validated;
			}
		} catch (err) {
			log.warn({ attempt, err: (err as Error).message }, 'reviewDataCycle: provider error');
			if (attempt === MAX_ATTEMPTS) break;
		}
	}
	log.warn({ itemId: input.task.itemId, cycle }, 'reviewDataCycle: all attempts failed -- keep all ok outputs, terminate loop');
	return {
		keep:      cycleOutputs.filter(o => o.status === 'ok').map(o => o.stepId),
		new_steps: [],
	};
}

function buildReviewerMessages(
	input:        RunDataDiscoveryFlowInput,
	cycle:        1 | 2 | 3,
	cycleOutputs: readonly ExecuteDataStepOutput[],
	_cycleMemory: CycleMemory,
): LLMMessage[] {
	const system = [
		'You are reviewing one cycle of data-analysis discovery steps.',
		'For each step output, decide:',
		'  - keep: stepIds whose evidence is on-topic, concrete, and adds',
		'           value toward answering the task question.',
		'  - new_steps: discovery steps for the NEXT cycle that fill gaps',
		'               the kept steps left open. Empty array = terminate',
		'               the loop (current ledger is sufficient).',
		'  - scratchpad: optional 1-2 sentence note carried into the next',
		'                cycle (qualitative judgments the planner should',
		'                see).',
		'',
		'Heuristics for keep:',
		'  - status: ok and citations.length > 0 -> almost always keep.',
		'  - status: partial -> keep only if at least one fact is concrete',
		'    and on-topic.',
		'  - status: failed -> never keep.',
		'',
		'Heuristics for new_steps:',
		'  - Ask for drills that target specific gaps in the kept evidence',
		'    (a value not yet measured, a relationship not yet traced).',
		'  - Do NOT re-ask for evidence the kept ledger already supplies.',
		'  - Empty array is the correct answer when the ledger is good',
		'    enough to answer the task. Be willing to terminate.',
		'',
		'Output STRICT JSON matching the response schema (no prose).',
	].join('\n');

	const userLines: string[] = [];
	userLines.push('## Task under review');
	userLines.push(`question: ${input.task.question}`);
	userLines.push(`kind:     ${input.task.kind}`);
	userLines.push('');
	userLines.push(`## Cycle ${cycle} step outputs`);
	for (const out of cycleOutputs) {
		userLines.push('');
		userLines.push(`### ${out.stepId}  (status: ${out.status}; calls: ${out.calledSkillIds.length}; evidence: ${out.evidence.length}; durationMs: ${out.durationMs})`);
		for (const ev of out.evidence) {
			userLines.push(`  - skill \`${ev.skillId}\` (confidence: ${ev.confidence})`);
			for (const f of ev.facts.slice(0, 4)) {
				userLines.push(`    fact: ${f}`);
			}
			for (const cit of ev.citations.slice(0, 3)) {
				userLines.push(`    cite: ${formatDataCitationForReview(cit)}`);
			}
		}
	}
	userLines.push('');
	userLines.push('## Response schema');
	userLines.push('```json');
	userLines.push(JSON.stringify(CYCLE_REVIEW_RESPONSE_SCHEMA, null, 2));
	userLines.push('```');

	return [
		{ role: 'system', content: system },
		{ role: 'user',   content: userLines.join('\n') },
	];
}

function formatDataCitationForReview(cit: DataEvidenceEntry['citations'][number]): string {
	switch (cit.kind) {
		case 'rdbms':       return `rdbms ${cit.connectionId}${cit.schema ? '.' + cit.schema : ''}.${cit.table}${cit.column ? '.' + cit.column : ''}`;
		case 'kv':          return `kv ${cit.connectionId} ${cit.keyPattern}${cit.fieldPath ? ' ' + cit.fieldPath : ''}`;
		case 'file-source': return `file ${cit.connectionId} ${cit.path}${cit.column ? ' col=' + cit.column : ''}`;
		case 'code-ref':    return `code ${cit.path}${cit.lineStart ? ':L' + cit.lineStart : ''}${cit.lineEnd ? '-L' + cit.lineEnd : ''}`;
	}
}

// ---------------------------------------------------------------------------
// Skill catalog summary (for the planner prompt)
// ---------------------------------------------------------------------------

function buildSkillCatalogSummary(): string {
	const skills = listSkills().filter(s => s.id.startsWith('data.'));
	// Group by family (data.<family>.*).
	const byFamily: Map<string, { id: string; desc: string }[]> = new Map();
	for (const s of skills) {
		const parts = s.id.split('.');
		const family = parts[1] ?? 'misc';
		const desc = (s.description ?? '').split('\n')[0]!.trim().slice(0, SKILL_CATALOG_MAX_LEN);
		const list = byFamily.get(family);
		if (list === undefined) {
			byFamily.set(family, [{ id: s.id, desc }]);
		} else {
			list.push({ id: s.id, desc });
		}
	}
	const lines: string[] = [];
	for (const [family, entries] of [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		lines.push(`### data.${family}.*`);
		for (const e of entries.sort((a, b) => a.id.localeCompare(b.id))) {
			lines.push(`  - ${e.id}${e.desc ? '  — ' + e.desc : ''}`);
		}
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON parsing + schema validation
// ---------------------------------------------------------------------------

function parseJsonStrict(raw: string): Record<string, unknown> | null {
	// Strip fence first (Haiku live repro pattern).
	const stripped = stripJsonCodeFence(raw);
	try {
		const v = JSON.parse(stripped);
		if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
			return v as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function stripJsonCodeFence(raw: string): string {
	const trimmed = raw.trim();
	const fenceOpen = /^```(?:json)?\s*\n?/i;
	const fenceClose = /\n?```\s*$/;
	if (!fenceOpen.test(trimmed)) return trimmed;
	return trimmed.replace(fenceOpen, '').replace(fenceClose, '').trim();
}

function validateDiscoveryPlan(raw: Record<string, unknown>, expectedCycle: 1 | 2 | 3): DiscoveryPlan | null {
	const stepsRaw = raw['steps'];
	if (!Array.isArray(stepsRaw)) return null;
	const steps: DiscoveryStep[] = [];
	for (const s of stepsRaw) {
		const parsed = validateDiscoveryStep(s);
		if (parsed === null) return null;
		steps.push(parsed);
	}
	if (steps.length === 0) return null;
	return { cycle: expectedCycle, steps };
}

function validateDiscoveryStep(raw: unknown): DiscoveryStep | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const o = raw as Record<string, unknown>;
	const id = o['id'];
	const intent = o['intent'];
	const skillsRaw = o['skills'];
	const targetsRaw = o['targetsCriteria'];
	if (typeof id !== 'string' || id.length === 0) return null;
	if (typeof intent !== 'string' || intent.length === 0) return null;
	if (!Array.isArray(skillsRaw)) return null;
	const skills: PlannedSkillCall[] = [];
	for (const skRaw of skillsRaw) {
		if (typeof skRaw !== 'object' || skRaw === null) return null;
		const sk = skRaw as Record<string, unknown>;
		const skId = sk['id'];
		const skSkillId = sk['skillId'];
		const skContext = sk['context'];
		if (typeof skId !== 'string' || typeof skSkillId !== 'string' || typeof skContext !== 'string') return null;
		const skDependsOn = sk['dependsOn'];
		const planned: PlannedSkillCall = (typeof skDependsOn === 'string' && skDependsOn.length > 0)
			? { id: skId, skillId: skSkillId, context: skContext, dependsOn: skDependsOn }
			: { id: skId, skillId: skSkillId, context: skContext };
		skills.push(planned);
	}
	if (skills.length === 0) return null;
	const targets: number[] = Array.isArray(targetsRaw)
		? targetsRaw.filter((t): t is number => typeof t === 'number' && Number.isInteger(t))
		: [];
	return { id, intent, skills, targetsCriteria: targets };
}

function validateCycleReview(
	raw:           Record<string, unknown>,
	cycleOutputs:  readonly ExecuteDataStepOutput[],
): CycleReviewResponse | null {
	const keepRaw = raw['keep'];
	const newStepsRaw = raw['new_steps'];
	if (!Array.isArray(keepRaw)) return null;
	if (!Array.isArray(newStepsRaw)) return null;
	const validIds = new Set(cycleOutputs.map(o => o.stepId));
	const keep = keepRaw.filter((k): k is string => typeof k === 'string' && validIds.has(k));
	const new_steps: DiscoveryStep[] = [];
	for (const s of newStepsRaw) {
		const parsed = validateDiscoveryStep(s);
		if (parsed === null) return null;
		new_steps.push(parsed);
	}
	const scratchpadRaw = raw['scratchpad'];
	const scratchpad = (typeof scratchpadRaw === 'string' && scratchpadRaw.length > 0) ? scratchpadRaw : undefined;
	return scratchpad !== undefined
		? { keep, new_steps, scratchpad }
		: { keep, new_steps };
}

// `StepOutput` re-exported for symmetry with the code side (callers
// may want to type cycle outputs uniformly without importing from
// content-gen directly).
export type { StepOutput };

// Test exports.
export const _buildSkillCatalogSummaryForTest = buildSkillCatalogSummary;
export const _filterStepsToScopeForTest       = filterStepsToScope;
export const _findScopeViolationForTest       = findScopeViolation;
export const _validateDiscoveryPlanForTest    = validateDiscoveryPlan;
export const _validateCycleReviewForTest      = validateCycleReview;
export const _stripJsonCodeFenceForTest       = stripJsonCodeFence;
