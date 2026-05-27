/**
 * executeDataStep -- per-discovery-step orchestrator for the data
 * analyzer (Phase C.1 of plans/analyzers/data-analyzer-parity.md).
 *
 * Mirrors agent/tasks/code-analyzer/execute-step.ts but produces
 * data-shaped evidence: `DataEvidenceEntry[]` typed against
 * `DataCitation` (rdbms / kv / file-source / code-ref), not the
 * code-side `EvidenceEntry`.
 *
 * Per-task flow (one LLM call per planned skill):
 *  - Build a per-task prompt that names the EXACT skill to invoke
 *    and inlines the skill's arg schema. The model's job is to
 *    emit one `skill_invoke` tool_use block with correct args.
 *  - `tool_choice: 'required'` is passed on every call so the model
 *    can't punt to acknowledgement prose. A one-shot retry catches
 *    providers that don't honor the constraint.
 *  - Dispatcher routes through the Phase-B silent guard
 *    (`runDataAnalyzerGuard`) before reaching runSkill. Rename /
 *    type-coerce / session-default inject apply silently; Stage-4
 *    typed-corrective is deferred to Phase D (lands on TOP of this
 *    tool-loop once it does).
 *  - On successful dispatch, the raw skill result is summarised
 *    into one `DataEvidenceEntry` via `summarizeResult` (Phase A).
 *
 * Termination is deterministic: loop ends after the last planned
 * task. No agentic "STOP when done" contract; no `maxIterations`
 * cap. If a task's per-call retry budget exhausts (empty toolCalls
 * even with `tool_choice: required`), the task is skipped and the
 * step continues with whatever evidence has accumulated. Partial
 * evidence beats no evidence.
 */

import type {
	LLMProvider,
	LLMMessage,
	ToolDefinition,
	ToolCall,
	ToolResult,
} from '../../../shared/types.js';
import type { Session } from '../../session.js';
import { getTool } from '../../../daemon/tools/registry.js';
import { getSkill } from '../../../daemon/skills/index.js';
import { executeTool } from '../../tools/executor.js';
import { runToolLoop } from '../../tool-loop.js';
import { getLogger } from '../../../shared/logger.js';
import { summarizeResult } from './summarize-result.js';
import { runDataAnalyzerGuard, type DataSessionDefaults } from './tool-call-guard.js';
import type { DataEvidenceEntry, ConnectionSummary } from './types.js';
import type {
	DiscoveryStep,
	PlannedSkillCall,
} from '../../content-gen/discovery-plan.js';

const log = getLogger('data-analyzer:execute-step');

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ExecuteDataStepInput {
	readonly provider:        LLMProvider;
	readonly session:         Session;
	readonly step:            DiscoveryStep;
	/**
	 * Session-derived defaults passed to the Phase-B guard. Most
	 * commonly `{ connectionId }` pulled from the active analyzer
	 * task scope; `schema` + `database` plumbed when the
	 * select-scope / discovery planner produces a richer scope.
	 */
	readonly sessionDefaults?: DataSessionDefaults | undefined;
	/**
	 * Optional active-connections summary. If present, formatted and
	 * embedded into the system prompt so the LLM sees what
	 * connection ids are valid for the args it emits. Mirrors the
	 * code-side's `repoSizeSummary` slot.
	 */
	readonly connections?:    readonly ConnectionSummary[] | undefined;
	/** Max tokens per per-task call. Default 1024 -- the model only
	 *  needs to emit one tool_use block, no narrative budget required. */
	readonly maxTokens?:      number | undefined;
	readonly onProgress?:     ((message: string) => void) | undefined;
	/** Section-level review criteria, passed through to the summarizer
	 *  so it can score the relevance of each skill result. Falls back
	 *  to a single criterion derived from `step.intent` if absent. */
	readonly criteria?:       readonly string[] | undefined;
}

/**
 * Output of one executed DiscoveryStep on the data side. Mirrors
 * the code-side StepOutput shape but carries `DataEvidenceEntry[]`
 * directly instead of separately-flattened facts + citations.
 * Discovery-flow (Phase C.2) consumes the evidence array directly
 * to feed the cycle reviewer.
 */
export interface ExecuteDataStepOutput {
	readonly stepId:           string;
	readonly status:           'ok' | 'partial' | 'failed';
	readonly evidence:         readonly DataEvidenceEntry[];
	readonly calledSkillIds:   readonly string[];
	readonly extraSkillsCalled?: readonly string[] | undefined;
	readonly durationMs:       number;
}

/** Number of retries when a per-task call returns zero toolCalls. */
const PER_TASK_EMPTY_RETRIES = 1;

export async function executeDataStep(input: ExecuteDataStepInput): Promise<ExecuteDataStepOutput> {
	const t0 = Date.now();

	const invokeT = getTool('skill_invoke');
	if (invokeT === undefined) {
		log.warn({ stepId: input.step.id }, 'executeDataStep: skill_invoke not registered; emitting failed StepOutput');
		return {
			stepId:         input.step.id,
			status:         'failed',
			evidence:       [],
			calledSkillIds: [],
			durationMs:     Date.now() - t0,
		};
	}
	const tools: ToolDefinition[] = [
		{ name: invokeT.id, description: invokeT.description, inputSchema: invokeT.inputSchema },
	];

	const plannedSkillIds = new Set(input.step.skills.map(s => s.skillId));
	const calledSkillIds:  string[]              = [];
	const evidence:        DataEvidenceEntry[]   = [];
	const resultsById:     Map<string, string>   = new Map();
	const maxTokens = input.maxTokens ?? 1024;
	const criteria  = (input.criteria !== undefined && input.criteria.length > 0)
		? input.criteria
		: inferCriteriaForStep(input.step);

	for (let i = 0; i < input.step.skills.length; i++) {
		const task = input.step.skills[i]!;
		const priorResultText = resolvePriorResult(task, resultsById, i, input.step.skills);

		input.onProgress?.(`  [${input.step.id}/task ${i + 1}/${input.step.skills.length}] ${task.skillId}`);

		const callOutcome = await callPerTask({
			provider:           input.provider,
			session:            input.session,
			step:               input.step,
			task,
			priorTaskAndResult: priorResultText !== null
				? { priorTask: resolvePriorTask(task, i, input.step.skills), priorResultText }
				: null,
			tools,
			maxTokens,
			connections:        input.connections,
			sessionDefaults:    input.sessionDefaults,
		});

		if (callOutcome === null) {
			log.warn(
				{ stepId: input.step.id, taskId: task.id, skillId: task.skillId },
				'executeDataStep: per-task call returned no toolCalls after retry; skipping task',
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
				'executeDataStep: summarizeResult failed -- skipping evidence entry',
			);
		}
	}

	const extraSkillsCalled = [...new Set(calledSkillIds.filter(id => !plannedSkillIds.has(id)))];
	const citationCount     = evidence.reduce((sum, e) => sum + e.citations.length, 0);
	const status            = determineStatus({
		evidenceCount:     evidence.length,
		citationCount,
		calledSkillIds,
		plannedSkillCount: input.step.skills.length,
	});

	log.info(
		{
			stepId:           input.step.id,
			plannedTaskCount: input.step.skills.length,
			calledSkillCount: calledSkillIds.length,
			evidenceCount:    evidence.length,
			citationCount,
			status,
			durationMs:       Date.now() - t0,
		},
		'executeDataStep: complete',
	);

	return {
		stepId:           input.step.id,
		status,
		evidence,
		calledSkillIds,
		...(extraSkillsCalled.length > 0 ? { extraSkillsCalled } : {}),
		durationMs:       Date.now() - t0,
	};
}

// ---------------------------------------------------------------------------
// Per-task call (one LLM round-trip with one-shot retry via runToolLoop)
// ---------------------------------------------------------------------------

interface CallOutcome {
	readonly toolCall:   ToolCall;
	readonly resultText: string;
}

interface PerTaskCallInput {
	readonly provider:           LLMProvider;
	readonly session:            Session;
	readonly step:               DiscoveryStep;
	readonly task:               PlannedSkillCall;
	readonly priorTaskAndResult: { priorTask: PlannedSkillCall; priorResultText: string } | null;
	readonly tools:              ToolDefinition[];
	readonly maxTokens:          number;
	readonly connections?:       readonly ConnectionSummary[] | undefined;
	readonly sessionDefaults?:   DataSessionDefaults | undefined;
}

async function callPerTask(input: PerTaskCallInput): Promise<CallOutcome | null> {
	const messages = buildPerTaskMessages({
		stepIntent:         input.step.intent,
		task:               input.task,
		priorTaskAndResult: input.priorTaskAndResult,
		connections:        input.connections,
		retryAttempt:       0,
	});

	// Dispatcher routes the LLM's emitted skill_invoke call through
	// the Phase-B silent guard. Rename / coerce / inject apply
	// silently; Stage-4 reject is suppressed (Phase D will turn it on).
	const dispatcher = async (toolCall: ToolCall): Promise<ToolResult> => {
		const guarded = runDataAnalyzerGuard(toolCall, input.sessionDefaults);
		if (guarded.kind === 'rejected') {
			log.warn(
				{
					stepId: input.step.id,
					taskId: input.task.id,
					reason: guarded.reason,
				},
				'callPerTask: pre-dispatch guard rejected the call; feeding corrective back',
			);
			return {
				toolCallId: toolCall.id,
				content:    guarded.correctiveResult.content,
				isError:    true,
			};
		}
		const dispatchCall = guarded.kind === 'coerced' ? guarded.call : toolCall;
		if (guarded.kind === 'coerced') {
			log.info(
				{
					stepId: input.step.id,
					taskId: input.task.id,
					notes:  guarded.notes,
				},
				'callPerTask: pre-dispatch guard coerced the call before dispatch',
			);
		}
		return executeTool(dispatchCall, { session: input.session });
	};

	const outcome = await runToolLoop({
		provider:     input.provider,
		messages,
		tools:        input.tools,
		dispatchTool: dispatcher,
		policy: {
			maxTurns:               1 + PER_TASK_EMPTY_RETRIES,
			toolChoice:             'required',
			maxTokens:              input.maxTokens,
			stopOnFirstDispatch:    true,
			onEmptyToolCalls:       'retry-with-correction',
			onUnknownTool:          'feed-error-back',
			onDispatchError:        'feed-error-back',
			stopOnDegenerateRepeat: false,
		},
		label: 'data-execute-step:per-task',
	});

	if (outcome.kind === 'dispatched') {
		return {
			toolCall:   outcome.call,
			resultText: outcome.result.content,
		};
	}
	// 'exhausted' with a last dispatch is still usable -- partial evidence
	// beats none. Surface the last result for summarizer to extract from.
	if (outcome.kind === 'exhausted' && outcome.lastDispatch !== undefined) {
		log.warn(
			{
				stepId: input.step.id,
				taskId: input.task.id,
				reason: outcome.reason,
			},
			'callPerTask: tool-loop exhausted; returning last errored outcome (if any)',
		);
		return {
			toolCall:   outcome.lastDispatch.call,
			resultText: outcome.lastDispatch.result.content,
		};
	}
	return null;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

interface BuildPerTaskMessagesInput {
	readonly stepIntent:         string;
	readonly task:               PlannedSkillCall;
	readonly priorTaskAndResult: { priorTask: PlannedSkillCall; priorResultText: string } | null;
	readonly connections?:       readonly ConnectionSummary[] | undefined;
	readonly retryAttempt:       number;
	readonly lastErrorFeedback?: string;
}

function buildPerTaskMessages(input: BuildPerTaskMessagesInput): LLMMessage[] {
	const system = buildSystemPrompt(input.connections);
	const user   = buildPerTaskUserPrompt(input);
	return [
		{ role: 'system', content: system },
		{ role: 'user',   content: user   },
	];
}

function buildSystemPrompt(connections: readonly ConnectionSummary[] | undefined): string {
	const connectionsBlock = (connections !== undefined && connections.length > 0)
		? '\n\n## Active data connections\n' + formatConnections(connections)
		: '';
	return [
		'You are executing ONE data-analysis skill invocation as part of a',
		'multi-step discovery flow. The orchestrator has already chosen the',
		'skill; your job is to emit one `skill_invoke` tool_use block whose',
		'`input.skillId` matches the named skill and whose `input.args`',
		'satisfies that skill\'s declared input schema.',
		'',
		'Rules:',
		'  - Emit EXACTLY ONE `skill_invoke` block. No prose. No explanation.',
		'  - The `input.skillId` MUST match the skill id named in the task.',
		'  - The `input.args` MUST be a JSON object matching the schema.',
		'  - When the task supplies a `Target` description, translate it into',
		'    concrete args using the schema -- e.g. a target like "table',
		'    `orders` in connection `pg-primary`" with a schema requiring',
		'    `{ connectionId, table }` becomes',
		'    `args: { "connectionId": "pg-primary", "table": "orders" }`.',
		'  - Empty `args: {}` is almost always wrong -- consult the schema\'s',
		'    `required` field to see which keys MUST be populated.',
		connectionsBlock,
	].join('\n');
}

function formatConnections(connections: readonly ConnectionSummary[]): string {
	return connections.map(c => {
		const prodTag = c.prod ? ' [PROD]' : '';
		const piiTag  = c.hasPiiConfig ? ' [PII]' : '';
		const label   = c.label !== undefined ? ` "${c.label}"` : '';
		return `- \`${c.id}\` (${c.family}/${c.kind})${label}${prodTag}${piiTag}`;
	}).join('\n');
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
		parts.push('relevant handle (connectionId, table name, column, key pattern, etc.)');
		parts.push('from its result below.');
	}
	parts.push('');
	parts.push(`## Skill schema for \`${task.skillId}\` (your \`args\` field must match this)`);
	parts.push('```json');
	parts.push(skillSchemaText);
	parts.push('```');
	parts.push('');
	parts.push('**Derive the `args` from the Target above** -- the natural-language target');
	parts.push('describes what to inspect; translate it into the args field using the schema.');

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

function renderSkillSchema(skillId: string): string {
	const skill = getSkill(skillId);
	if (skill === undefined) {
		return `{ "_skill_not_found": "${skillId}" }`;
	}
	try {
		return JSON.stringify(skill.inputs, null, 2);
	} catch {
		return `{ "_schema_render_failed": "${skillId}" }`;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferCriteriaForStep(step: DiscoveryStep): readonly string[] {
	return [step.intent];
}

function resolvePriorTask(
	current:  PlannedSkillCall,
	index:    number,
	siblings: readonly PlannedSkillCall[],
): PlannedSkillCall {
	if (current.dependsOn !== undefined) {
		const found = siblings.find(s => s.id === current.dependsOn);
		if (found !== undefined) return found;
	}
	// Fall back to the immediately-preceding task.
	return siblings[Math.max(0, index - 1)]!;
}

function resolvePriorResult(
	current:     PlannedSkillCall,
	resultsById: ReadonlyMap<string, string>,
	index:       number,
	siblings:    readonly PlannedSkillCall[],
): string | null {
	if (current.dependsOn !== undefined) {
		const v = resultsById.get(current.dependsOn);
		if (v !== undefined) return v;
	}
	// Auto-thread: if the prior sibling produced a result, surface it.
	if (index > 0) {
		const prior = siblings[index - 1]!;
		const v = resultsById.get(prior.id);
		if (v !== undefined) return v;
	}
	return null;
}

interface DetermineStatusInput {
	readonly evidenceCount:     number;
	readonly citationCount:     number;
	readonly calledSkillIds:    readonly string[];
	readonly plannedSkillCount: number;
}

function determineStatus(input: DetermineStatusInput): 'ok' | 'partial' | 'failed' {
	if (input.calledSkillIds.length === 0) return 'failed';
	if (input.evidenceCount === 0)         return 'failed';
	if (input.citationCount === 0)         return 'partial';
	if (input.calledSkillIds.length < input.plannedSkillCount) return 'partial';
	return 'ok';
}

// Test exports.
export const _buildPerTaskMessagesForTest = buildPerTaskMessages;
export const _determineStatusForTest      = determineStatus;
export const _renderSkillSchemaForTest    = renderSkillSchema;
