/**
 * executeStep -- Phase 8 per-task orchestrator-driven driver.
 *
 * Mirrors [plans/code-analyzer-execute-step-per-result-summarization.md]
 * Phase 8:
 *
 *  - The orchestrator OWNS the loop, not the model. We iterate over
 *    `step.skills` (already chosen + ordered by the cloud planner) and
 *    make ONE provider call per task.
 *  - Each call's user prompt names the EXACT skill to invoke + inlines
 *    the skill's arg schema. The model's job is to emit one
 *    `skill_invoke` tool_use block with correct args. Nothing else.
 *  - When a task has `dependsOn` set, the orchestrator surfaces the
 *    prior task's raw tool_result text in the per-task prompt so the
 *    model can pull chained handles (entityId, etc.) from it verbatim.
 *  - `tool_choice: 'required'` is passed on every call so the model
 *    can't punt to acknowledgement prose. A one-shot retry catches
 *    providers that don't honor the constraint.
 *  - Termination is deterministic: loop ends after the last task.
 *    No agentic "STOP when done" contract; no `maxIterations` cap.
 *  - Per-result summarization runs unchanged, capturing one
 *    `EvidenceEntry` per task.
 *
 * Phases 2.5 + 7 (in-place tool_result stubbing, eviction window) are
 * REMOVED. The conversation is single-turn per task, so there is no
 * multi-turn context to compact.
 */

import type { LLMProvider, LLMMessage, ToolDefinition, ToolCall } from '../../../shared/types.js';
import type { Session } from '../../session.js';
import type { RepoSizeSummary } from '../../../daemon/repo-summary.js';
import { formatRepoSizeSummary } from '../../../daemon/repo-summary.js';
import { getTool } from '../../../daemon/tools/registry.js';
import { getSkill } from '../../../daemon/skills/index.js';
import { executeTool } from '../../tools/executor.js';
import { getLogger } from '../../../shared/logger.js';
import { loadFlowPrompt } from './prompts/loader.js';
import { summarizeResult } from './summarize-result.js';
import type { EvidenceEntry } from './summarize-result.js';

import type {
	Citation,
	DiscoveryStep,
	PlannedSkillCall,
	StepOutput,
} from '../../content-gen/discovery-plan.js';

const log = getLogger('code-analyzer:execute-step');

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ExecuteStepInput {
	readonly provider:        LLMProvider;
	readonly session:         Session;
	readonly step:            DiscoveryStep;
	/** Optional repo-size summary; if present, formatted and embedded
	 *  into the {{REPO_CONTEXT}} slot of the system prompt. */
	readonly repoSizeSummary?: RepoSizeSummary | undefined;
	/** Max tokens per per-task call. Default 1024 -- the model only needs
	 *  to emit one tool_use block, no narrative budget required. */
	readonly maxTokens?:      number | undefined;
	readonly onProgress?:     ((message: string) => void) | undefined;
	/** Section-level review criteria, passed through to the summarizer
	 *  so it can score the relevance of each skill result. Falls back
	 *  to a single criterion derived from `step.intent` if absent. */
	readonly criteria?:       readonly string[] | undefined;
}

/** Number of retries when a per-task call returns zero toolCalls
 *  (provider didn't honor `tool_choice: required`, or model emitted
 *  prose anyway). After this many retries with a sterner suffix, the
 *  task is skipped and the step continues with partial evidence. */
const PER_TASK_EMPTY_RETRIES = 1;

export async function executeStep(input: ExecuteStepInput): Promise<StepOutput> {
	const t0 = Date.now();

	const invokeT = getTool('skill_invoke');
	if (invokeT === undefined) {
		log.warn({ stepId: input.step.id }, 'executeStep: skill_invoke not registered; emitting failed StepOutput');
		return emptyFailedStep(input.step.id, Date.now() - t0);
	}
	const tools: ToolDefinition[] = [
		{ name: invokeT.id, description: invokeT.description, inputSchema: invokeT.inputSchema },
	];

	const plannedSkillIds  = new Set(input.step.skills.map(s => s.skillId));
	const calledSkillIds:  string[]            = [];
	const evidence:        EvidenceEntry[]     = [];
	/** Map of taskId -> raw tool_result text, used to surface chain
	 *  dependencies (task N's `dependsOn` references a prior task's id). */
	const resultsById:    Map<string, string> = new Map();
	const maxTokens   = input.maxTokens ?? 1024;
	const criteria    = (input.criteria !== undefined && input.criteria.length > 0)
		? input.criteria
		: inferCriteriaForStep(input.step);

	for (let i = 0; i < input.step.skills.length; i++) {
		const task = input.step.skills[i]!;
		const priorResultText = resolvePriorResult(task, resultsById, i, input.step.skills);

		input.onProgress?.(`  [${input.step.id}/task ${i + 1}/${input.step.skills.length}] ${task.skillId}`);

		const callOutcome = await callPerTask({
			provider:   input.provider,
			session:    input.session,
			step:       input.step,
			task,
			priorTaskAndResult: priorResultText !== null ? { priorTask: resolvePriorTask(task, i, input.step.skills), priorResultText } : null,
			tools,
			maxTokens,
			repoSizeSummary: input.repoSizeSummary,
		});

		if (callOutcome === null) {
			// Per-task call produced no tool call even after retry. Skip
			// the task and continue -- partial evidence beats no evidence.
			log.warn(
				{ stepId: input.step.id, taskId: task.id, skillId: task.skillId },
				'executeStep: per-task call returned no toolCalls after retry; skipping task',
			);
			continue;
		}

		const { toolCall, resultText } = callOutcome;
		calledSkillIds.push(task.skillId);
		resultsById.set(task.id, resultText);

		try {
			const args = (toolCall.input['args'] as Record<string, unknown> | undefined) ?? {};
			const entry = await summarizeResult(input.provider, {
				skillId:    task.skillId,
				args,
				resultText,
				objective:  input.step.intent,
				criteria,
			});
			evidence.push(entry);
		} catch (err) {
			log.warn(
				{ err: (err as Error).message, skillId: task.skillId, stepId: input.step.id },
				'executeStep: summarizeResult failed -- skipping evidence entry',
			);
		}
	}

	const extraSkillsCalled = [...new Set(calledSkillIds.filter(id => !plannedSkillIds.has(id)))];
	const facts             = uniqueFlattenFacts(evidence);
	const citations         = mergeCitations(evidence);
	const status            = determineStatus({
		evidenceCount:      evidence.length,
		facts,
		citations,
		calledSkillIds,
		plannedSkillCount:  input.step.skills.length,
	});

	log.info(
		{
			stepId:           input.step.id,
			plannedTaskCount: input.step.skills.length,
			calledSkillCount: calledSkillIds.length,
			evidenceCount:    evidence.length,
			factCount:        facts.length,
			citationCount:    citations.length,
			status,
			durationMs:       Date.now() - t0,
		},
		'executeStep: complete',
	);

	return {
		stepId:    input.step.id,
		status,
		facts,
		citations,
		...(extraSkillsCalled.length > 0 ? { extraSkillsCalled } : {}),
		durationMs: Date.now() - t0,
	};
}

// ---------------------------------------------------------------------------
// Internals -- per-task call with one-shot retry
// ---------------------------------------------------------------------------

interface CallOutcome {
	readonly toolCall:   ToolCall;
	readonly resultText: string;
}

interface PerTaskCallInput {
	readonly provider:        LLMProvider;
	readonly session:         Session;
	readonly step:            DiscoveryStep;
	readonly task:            PlannedSkillCall;
	readonly priorTaskAndResult: { priorTask: PlannedSkillCall; priorResultText: string } | null;
	readonly tools:           ToolDefinition[];
	readonly maxTokens:       number;
	readonly repoSizeSummary?: RepoSizeSummary | undefined;
}

/**
 * Make one (or two on retry) calls to the provider for `task`. Two
 * retry triggers share the same budget:
 *
 *   1. Empty toolCalls (provider violated `tool_choice: required`).
 *   2. Tool dispatched but the skill runner rejected the args
 *      (`result.isError === true`). The runner's error response
 *      typically includes the corrective schema; we surface that
 *      back to the model in the next attempt's prompt suffix so it
 *      can emit valid args.
 *
 * Returns the (last) dispatched tool's raw result text + tool_call
 * shape -- even if it's an error -- or null if the model violated
 * `tool_choice: required` on every attempt.
 */
async function callPerTask(input: PerTaskCallInput): Promise<CallOutcome | null> {
	let lastErrorFeedback: string | null = null;
	let lastErroredOutcome: CallOutcome | null = null;

	for (let attempt = 0; attempt <= PER_TASK_EMPTY_RETRIES; attempt++) {
		const messages = buildPerTaskMessages({
			stepIntent:         input.step.intent,
			task:               input.task,
			priorTaskAndResult: input.priorTaskAndResult,
			repoSizeSummary:    input.repoSizeSummary,
			retryAttempt:       attempt,
			...(lastErrorFeedback !== null ? { lastErrorFeedback } : {}),
		});

		const resp = await input.provider.complete(messages, {
			maxTokens:  input.maxTokens,
			tools:      input.tools,
			toolChoice: 'required',
		});

		const toolCalls = resp.toolCalls ?? [];
		if (toolCalls.length === 0) {
			log.warn(
				{ stepId: input.step.id, taskId: input.task.id, attempt, textLen: (resp.text ?? '').length },
				'callPerTask: provider returned no toolCalls; will retry if attempts remain',
			);
			lastErrorFeedback = 'Your previous response had no tool_use block. You MUST emit exactly one `skill_invoke` tool_use block on this turn.';
			continue;
		}

		// We instructed the model to emit exactly one tool_use; if it
		// emitted more than one, the first is the canonical reply.
		const toolCall = toolCalls[0]!;
		const result = await executeTool(toolCall, { session: input.session });
		const resultText = typeof result.content === 'string'
			? result.content
			: JSON.stringify(result.content);

		if (result.isError === true) {
			log.warn(
				{ stepId: input.step.id, taskId: input.task.id, attempt, errLen: resultText.length },
				'callPerTask: tool dispatch returned isError; will retry with corrective schema if attempts remain',
			);
			lastErroredOutcome = { toolCall, resultText };
			lastErrorFeedback  = `Your previous skill_invoke call was rejected by the skill runner. Read the error below and re-emit the call with CORRECT args.\n\n--- Error from prior attempt ---\n${resultText}\n--- End error ---`;
			continue;
		}

		return { toolCall, resultText };
	}

	// All attempts exhausted. If the last attempt errored but did
	// produce a tool_use, return THAT outcome so the summarizer at
	// least sees the error text (status will reflect partial). If the
	// last attempt produced no tool_use at all, return null and let
	// the caller skip the task.
	return lastErroredOutcome;
}

// ---------------------------------------------------------------------------
// Internals -- per-task chain resolution
// ---------------------------------------------------------------------------

/** Look up the raw tool_result text of the task `currentTask.dependsOn`
 *  if set, else null. The orchestrator surfaces this in the per-task
 *  user prompt so the model can pull chained handles verbatim. */
function resolvePriorResult(
	currentTask:  PlannedSkillCall,
	resultsById:  ReadonlyMap<string, string>,
	currentIndex: number,
	allTasks:     readonly PlannedSkillCall[],
): string | null {
	if (currentTask.dependsOn !== undefined) {
		return resultsById.get(currentTask.dependsOn) ?? null;
	}
	// No explicit dependsOn: still pass the immediately-prior task's
	// result so the model has SOME continuity. This is cheap and helps
	// the model when the planner forgot to mark a dependency.
	if (currentIndex > 0) {
		const prev = allTasks[currentIndex - 1]!;
		return resultsById.get(prev.id) ?? null;
	}
	return null;
}

function resolvePriorTask(
	currentTask:  PlannedSkillCall,
	currentIndex: number,
	allTasks:     readonly PlannedSkillCall[],
): PlannedSkillCall {
	if (currentTask.dependsOn !== undefined) {
		const found = allTasks.find(t => t.id === currentTask.dependsOn);
		if (found !== undefined) return found;
	}
	return allTasks[currentIndex - 1]!;
}

// ---------------------------------------------------------------------------
// Internals -- per-task message builder
// ---------------------------------------------------------------------------

interface BuildPerTaskMessagesInput {
	readonly stepIntent:       string;
	readonly task:             PlannedSkillCall;
	readonly priorTaskAndResult: { priorTask: PlannedSkillCall; priorResultText: string } | null;
	readonly repoSizeSummary?: RepoSizeSummary | undefined;
	readonly retryAttempt:     number;
	/** On retry attempts, the verbatim text we want the model to read
	 *  in order to correct its prior emission. Set by `callPerTask` to
	 *  either "no tool_use block emitted" or "skill runner rejected
	 *  these args + here's the corrective schema". */
	readonly lastErrorFeedback?: string;
}

export function buildPerTaskMessages(input: BuildPerTaskMessagesInput): LLMMessage[] {
	const system = buildStepSystemPrompt(input.repoSizeSummary);
	const user   = buildPerTaskUserPrompt(input);
	return [
		{ role: 'system', content: system },
		{ role: 'user',   content: user   },
	];
}

function buildStepSystemPrompt(repoSizeSummary: RepoSizeSummary | undefined): string {
	const repoContext = (repoSizeSummary !== undefined && !repoSizeSummary.empty)
		? '\n\n## Repository under analysis\n' + formatRepoSizeSummary(repoSizeSummary, 'detailed')
		: '';
	return loadFlowPrompt('execute-step', { REPO_CONTEXT: repoContext });
}

function buildPerTaskUserPrompt(input: BuildPerTaskMessagesInput): string {
	const { stepIntent, task, priorTaskAndResult, retryAttempt, lastErrorFeedback } = input;
	const skillSchemaText = renderSkillSchema(task.skillId);

	const parts: string[] = [];
	parts.push('## Step context');
	parts.push(stepIntent.trim());
	parts.push('');
	parts.push('## Task to execute now');
	parts.push(`Skill:  \`${task.skillId}\``);
	parts.push(`Target: ${task.context.trim()}`);
	if (task.dependsOn !== undefined) {
		parts.push('');
		parts.push(`This task chains off prior task \`${task.dependsOn}\`. Pull the`);
		parts.push('relevant handle (entityId, path, etc.) from its result below.');
	}
	parts.push('');
	parts.push(`## Skill schema for \`${task.skillId}\` (your \`args\` field must match this)`);
	parts.push('```json');
	parts.push(skillSchemaText);
	parts.push('```');
	parts.push('');
	parts.push('**Derive the `args` from the Target above** -- the natural-language target');
	parts.push('describes what to look up; translate it into the args field using the schema.');
	parts.push('Example: a target like "the FSDirectory class" with a skill whose schema');
	parts.push('requires `name: string` becomes `args: { "name": "FSDirectory" }`.');
	parts.push('Empty `args: {}` is almost always wrong -- the schema\'s `required` field tells you');
	parts.push('which keys MUST be populated.');

	if (priorTaskAndResult !== null) {
		parts.push('');
		parts.push('## Prior task that just completed');
		parts.push(`Skill: \`${priorTaskAndResult.priorTask.skillId}\``);
		parts.push(`Target: ${priorTaskAndResult.priorTask.context.trim()}`);
		parts.push('');
		parts.push('### Raw result of prior task');
		parts.push('```');
		parts.push(priorTaskAndResult.priorResultText);
		parts.push('```');
	}

	parts.push('');
	parts.push('## Output');
	parts.push('Emit exactly one `skill_invoke` tool_use block now. The `input.skillId`');
	parts.push(`must be \`${task.skillId}\` and the \`input.args\` must satisfy the schema above.`);
	if (retryAttempt > 0) {
		parts.push('');
		parts.push('## RETRY NOTICE');
		if (lastErrorFeedback !== undefined && lastErrorFeedback.length > 0) {
			parts.push(lastErrorFeedback);
		} else {
			parts.push('Your previous response had no tool_use block. You MUST emit a');
			parts.push('`skill_invoke` tool_use block on this turn. Do not narrate, do not');
			parts.push('explain -- just emit the structured tool_use call.');
		}
	}
	return parts.join('\n');
}

/**
 * Look up the registered SKILL's input schema (from the skills registry,
 * NOT the tools registry) and format it as a JSON string for inlining
 * into the per-task user prompt.
 *
 * The skills registry holds the actual analyzer skills like
 * `code.entity.locate-by-name` and their concrete arg schemas
 * (`Skill.inputs`). The tools registry only holds the THREE meta-tools
 * (`skill_invoke`, `skill_describe`, `skill_load_page`); the meta-tool's
 * `args` field is declared as `{type: 'object'}` with no constraints,
 * which is useless to inline -- the model satisfies it with `args: {}`.
 *
 * Falls back to a minimal placeholder schema only when the skillId
 * isn't registered at all (shouldn't happen in production: the planner
 * names skills from the closed catalog).
 */
function renderSkillSchema(skillId: string): string {
	const skill = getSkill(skillId);
	if (skill !== undefined) {
		return JSON.stringify(skill.inputs, null, 2);
	}
	// Defensive fallback: skill not found in skills registry. Try the
	// tools registry (covers the meta-tool case where skillId might be
	// 'skill_invoke' itself), else emit an explicit "unknown" marker so
	// the failure is loud in the prompt rather than a silent empty
	// schema the model would happily satisfy with `args: {}`.
	const tool = getTool(skillId);
	if (tool !== undefined) {
		return JSON.stringify(tool.inputSchema, null, 2);
	}
	return JSON.stringify({
		_note: `Skill '${skillId}' is not registered. Emit args as best you can; the runner will reject invalid input.`,
		type: 'object',
	}, null, 2);
}

// ---------------------------------------------------------------------------
// Internals -- progress helpers
// ---------------------------------------------------------------------------

/**
 * Compact one-line rendering of an arguments object for surfacing in
 * the chat stream. Strings are quoted + truncated at 30 chars;
 * numbers / booleans render bare; arrays as `[N]`; nested objects as
 * `{K keys}`. Total length capped at ~80 chars (then suffixed with
 * `...`).
 */
export function formatArgsInline(args: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(args)) {
		if (typeof v === 'string')      parts.push(`${k}="${v.length > 30 ? v.slice(0, 30) + '...' : v}"`);
		else if (typeof v === 'number') parts.push(`${k}=${v}`);
		else if (typeof v === 'boolean')parts.push(`${k}=${v}`);
		else if (Array.isArray(v))      parts.push(`${k}=[${v.length}]`);
		else if (v && typeof v === 'object') parts.push(`${k}={${Object.keys(v as Record<string, unknown>).length} keys}`);
		else                            parts.push(`${k}=?`);
		if (parts.join(', ').length > 80) { parts.push('...'); break; }
	}
	return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Internals -- criteria inference
// ---------------------------------------------------------------------------

/**
 * Derive 2-3 review criteria from `step.intent` for the summarizer.
 * Used when the caller doesn't pass section-level criteria through.
 * Heuristic: phrase the intent as a question + name "specific entities
 * and counts" + name "verbatim citations" so the summarizer scores by
 * the same shape the cycle-reviewer scores by.
 */
function inferCriteriaForStep(step: DiscoveryStep): readonly string[] {
	return [
		`answer the step intent: ${step.intent.trim()}`,
		'name specific entities, file paths, or counts from the skill result',
		'carry citations verbatim from the skill output',
	];
}

// ---------------------------------------------------------------------------
// Internals -- evidence aggregation
// ---------------------------------------------------------------------------

function uniqueFlattenFacts(evidence: readonly EvidenceEntry[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const e of evidence) {
		for (const f of e.facts) {
			const key = f.trim().toLowerCase();
			if (key.length === 0 || seen.has(key)) continue;
			seen.add(key);
			out.push(f);
		}
	}
	return out;
}

/**
 * Merge citations across all captured EvidenceEntry objects into the
 * structured Citation[] shape the writer expects. Deduplicate on
 * `(path, startLine, endLine)`. Parses the legacy `path:foo.ts#L1-L20`
 * strings into structured Citation objects when present.
 */
function mergeCitations(evidence: readonly EvidenceEntry[]): Citation[] {
	const seen = new Set<string>();
	const out: Citation[] = [];
	for (const e of evidence) {
		const fromObjs = e.citationObjs ?? [];
		if (fromObjs.length > 0) {
			for (const c of fromObjs) {
				const key = citationKey(c);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(c);
			}
		} else {
			for (const s of e.citations) {
				const c = parseLegacyCitation(s);
				if (c === null) continue;
				const key = citationKey(c);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(c);
			}
		}
	}
	return out;
}

function citationKey(c: Citation): string {
	return `${c.path}|${c.startLine ?? ''}|${c.endLine ?? ''}`;
}

/**
 * Parse a `path:foo.ts#L1-L20` (or `path:foo.ts#L42`) legacy citation
 * string into a structured `Citation`. Returns `null` for shapes that
 * don't match.
 */
function parseLegacyCitation(s: string): Citation | null {
	if (s.length === 0) return null;
	const stripped = s.startsWith('path:') ? s.slice('path:'.length) : s;
	const hashIdx  = stripped.lastIndexOf('#L');
	if (hashIdx === -1) {
		return { path: stripped };
	}
	const path  = stripped.slice(0, hashIdx);
	const range = stripped.slice(hashIdx + 2);
	const dash  = range.indexOf('-L');
	if (dash === -1) {
		const start = Number.parseInt(range, 10);
		if (Number.isFinite(start)) return { path, startLine: start };
		return { path };
	}
	const start = Number.parseInt(range.slice(0, dash), 10);
	const end   = Number.parseInt(range.slice(dash + 2), 10);
	const cite: { -readonly [K in keyof Citation]: Citation[K] } = { path };
	if (Number.isFinite(start)) cite.startLine = start;
	if (Number.isFinite(end))   cite.endLine   = end;
	return cite;
}

// ---------------------------------------------------------------------------
// Internals -- status determination
// ---------------------------------------------------------------------------

function determineStatus(args: {
	readonly evidenceCount:     number;
	readonly facts:             readonly string[];
	readonly citations:         readonly Citation[];
	readonly calledSkillIds:    readonly string[];
	readonly plannedSkillCount: number;
}): 'ok' | 'partial' | 'failed' {
	if (args.evidenceCount === 0) return 'failed';
	if (args.citations.length === 0) return 'partial';
	if (args.calledSkillIds.length < args.plannedSkillCount) return 'partial';
	return 'ok';
}

function emptyFailedStep(stepId: string, durationMs: number): StepOutput {
	return {
		stepId,
		status:    'failed',
		facts:     [],
		citations: [],
		durationMs,
	};
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _buildPerTaskMessagesForTest    = buildPerTaskMessages;
export const _buildStepSystemPromptForTest   = buildStepSystemPrompt;
export const _buildPerTaskUserPromptForTest  = buildPerTaskUserPrompt;
export const _renderSkillSchemaForTest       = renderSkillSchema;
export const _determineStatusForTest         = determineStatus;
export const _inferCriteriaForStepForTest    = inferCriteriaForStep;
export const _uniqueFlattenFactsForTest      = uniqueFlattenFacts;
export const _mergeCitationsForTest          = mergeCitations;
export const _parseLegacyCitationForTest     = parseLegacyCitation;
export const _PER_TASK_EMPTY_RETRIES_FOR_TEST = PER_TASK_EMPTY_RETRIES;
