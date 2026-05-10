/**
 * `code_analyze` -- Flow-2 cross-agent dispatch entry.
 *
 * Sibling analyzer families (data-analyzer, deployment-analyzer)
 * call this tool with a pre-built `AnalysisTask[]`. Each task is
 * mapped via `analysisTaskToSkillPlan` to a list of skill
 * invocations; tasks where the shim returns null (`free-form`) are
 * routed through the meta-skills pipeline instead. Returns a
 * structured result the caller can fold into its own report.
 *
 * Caps + envelopes:
 *   - Soft cap   16 tasks (silently trimmed; `truncated: true`).
 *   - Hard cap   24 tasks.
 *   - Wall clock 60 s overall envelope.
 */

import { registerTool } from '../tools/registry.js';
import { runSkill, type SkillRunnerDeps } from '../skills/invoke.js';
import {
	CROSS_AGENT_DEPTH_FIELD,
	exceedsCrossAgentDepth,
	readCrossAgentDepth,
	toolUnavailable,
} from '../../shared/cross-agent.js';
import { getLogger } from '../../shared/logger.js';
import { analysisTaskToSkillPlan } from '../../agent/tasks/code-analyzer/legacy-shim.js';
import {
	pipelineResultToAcceptedTasks,
	repoContextFromSummary,
	runSkillsPipeline,
	type PerSkillExecution,
	type SkillsPipelineResult,
} from '../../agent/tasks/code-analyzer/skills-pipeline.js';
import type {
	AnalysisTask,
	AnalysisKind,
	AnalysisScope,
	AnalyzerResult,
	CodeCitation,
	Confidence,
	Finding,
	RepoSummary,
} from '../../agent/tasks/code-analyzer/types.js';
import type { LLMProvider } from '../../shared/types.js';
import type { ProviderAffinity, SkillResult } from '../skills/types.js';
import type { ScopeSize } from '../../shared/classify.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../tools/types.js';

const log = getLogger('code-analyzer:flow2');

// ---------------------------------------------------------------------------
// Caps + envelope
// ---------------------------------------------------------------------------

const FLOW2_TRIM_CAP = 16;
const FLOW2_TOTAL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

interface RawTaskInput {
	readonly kind?: unknown;
	readonly question?: unknown;
	readonly scope?: unknown;
	readonly hint?: unknown;
}

interface RawCallerContext {
	readonly agent?: unknown;
}

interface CodeAnalyzeResult {
	readonly report: string;
	readonly findings: readonly Finding[];
	readonly citations: readonly CodeCitation[];
	readonly confidence: Confidence;
	readonly truncated: boolean;
	readonly droppedTasks: number;
	readonly timedOutTasks: number;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const codeAnalyzeTool: Tool = {
	id: 'code_analyze',
	description:
		'Cross-agent Flow-2 dispatch: run a sibling-supplied AnalysisTask[] through the Code Analyzer skills pipeline. Each task is mapped to one or more skill invocations via the legacy shim; free-form tasks fall through to the meta-skills pipeline. 60 s envelope. Returns a structured payload with stitched report + findings + citations.',
	inputSchema: {
		type: 'object',
		properties: {
			tasks: {
				type: 'array',
				description: `Caller-supplied task list. Trim cap ${FLOW2_TRIM_CAP}; entries past that are dropped silently and \`truncated\` is set.`,
				minItems: 1,
				items: {
					type: 'object',
					properties: {
						kind: { type: 'string', enum: ['locate', 'describe', 'trace', 'compare', 'free-form'] },
						question: { type: 'string', minLength: 1 },
						scope: { type: 'object' },
						hint: { type: 'string' },
					},
					required: ['kind', 'question'],
				},
			},
			callerContext: {
				type: 'object',
				description: 'Optional context the calling family uses for citation labelling. `agent` is the family name (e.g. "data-analyzer").',
				properties: {
					agent: { type: 'string' },
				},
			},
			tier: {
				type: 'string',
				enum: ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'],
				description: 'Optional sizing hint reserved for the caller. Currently unused by the skills pipeline; defaults to M when omitted.',
			},
			[CROSS_AGENT_DEPTH_FIELD]: { type: 'number', description: 'Cross-agent recursion depth (set by caller).' },
		},
		required: ['tasks'],
		additionalProperties: false,
	},
	requiresApproval: false,

	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		// ----- Cross-agent depth ----------------------------------------------
		const depth = readCrossAgentDepth(input);
		if (exceedsCrossAgentDepth(depth)) {
			const sentinel = toolUnavailable('cross_agent_depth_exceeded');
			return {
				output: '[code:analyze] unavailable: cross_agent_depth_exceeded',
				format: 'json',
				success: false,
				error: 'cross_agent_depth_exceeded',
				data: sentinel,
			};
		}

		// ----- Validate task list --------------------------------------------
		const tasksRaw = input['tasks'];
		if (!Array.isArray(tasksRaw)) {
			return fail('tasks must be an array');
		}
		const allTasks: AnalysisTask[] = [];
		for (let i = 0; i < tasksRaw.length; i++) {
			const t = parseTask(tasksRaw[i] as RawTaskInput, i);
			if (typeof t === 'string') {
				return fail(`tasks[${i}]: ${t}`);
			}
			allTasks.push(t);
		}
		if (allTasks.length === 0) {
			return fail('tasks array must contain at least one entry');
		}

		const droppedTasks = Math.max(0, allTasks.length - FLOW2_TRIM_CAP);
		const tasks = allTasks.slice(0, FLOW2_TRIM_CAP);
		if (droppedTasks > 0) {
			log.info({ requested: allTasks.length, kept: tasks.length, dropped: droppedTasks }, 'code:analyze: trimmed task list to Flow-2 cap');
		}

		const callerCtx = input['callerContext'] as RawCallerContext | undefined;
		const callerAgent = typeof callerCtx?.agent === 'string' ? callerCtx.agent : undefined;
		const tier: ScopeSize = isScopeSize(input['tier']) ? input['tier'] as ScopeSize : 'M';
		const repoPath = deps.session.repoPath;
		log.info(
			{ taskCount: tasks.length, dropped: droppedTasks, tier, callerAgent: callerAgent ?? null, repoPath },
			'code:analyze: starting Flow-2 dispatch',
		);

		// ----- Per-task skill execution under the 60 s envelope ---------------
		const startedAt = Date.now();
		const overallSignal = (() => {
			const ctrl = new AbortController();
			const tid = setTimeout(() => ctrl.abort(), FLOW2_TOTAL_TIMEOUT_MS);
			deps.signal?.addEventListener('abort', () => {
				clearTimeout(tid);
				ctrl.abort();
			}, { once: true });
			return { ctrl, tid };
		})();

		const runnerDeps = buildSkillRunnerDeps(deps, overallSignal.ctrl.signal);

		const runs = tasks.map(async (task): Promise<{
			task: AnalysisTask;
			outcome: AnalyzerResult | null;
			error?: string;
		}> => {
			try {
				const outcome = await runTaskAsSkillExecutions(task, repoPath, runnerDeps);
				return { task, outcome };
			} catch (err) {
				const message = (err as Error).message ?? String(err);
				log.warn({ task: shortTitle(task), err: message }, 'code:analyze: task threw');
				return { task, outcome: null, error: message };
			}
		});

		const settled = await Promise.allSettled(runs);
		clearTimeout(overallSignal.tid);
		const elapsed = Date.now() - startedAt;
		const envelopeExceeded = elapsed >= FLOW2_TOTAL_TIMEOUT_MS;

		// ----- Aggregate -----------------------------------------------------
		const completed: { task: AnalysisTask; outcome: AnalyzerResult }[] = [];
		const failed: { task: AnalysisTask; reason: string }[] = [];
		let timedOutTasks = 0;
		for (const s of settled) {
			if (s.status === 'rejected') {
				timedOutTasks += 1;
				continue;
			}
			const v = s.value;
			if (v.outcome === null) {
				if (envelopeExceeded) {
					timedOutTasks += 1;
				}
				failed.push({ task: v.task, reason: v.error ?? 'unknown' });
				continue;
			}
			completed.push({ task: v.task, outcome: v.outcome });
		}

		const truncated = droppedTasks > 0 || timedOutTasks > 0;
		const report = stitchFlow2Report(completed, failed, callerAgent);
		const findings = unionFindings(completed.map(c => c.outcome));
		const citations = unionCitations(completed.map(c => c.outcome));
		const confidence = aggregateConfidence(completed.map(c => c.outcome));

		const data: CodeAnalyzeResult = {
			report,
			findings,
			citations,
			confidence,
			truncated,
			droppedTasks,
			timedOutTasks,
		};

		log.info(
			{
				completed: completed.length,
				failed: failed.length,
				timedOutTasks,
				droppedTasks,
				elapsedMs: elapsed,
				confidence,
				truncated,
			},
			'code:analyze: Flow-2 done',
		);

		return {
			output: report,
			format: 'markdown',
			success: completed.length > 0,
			...(completed.length === 0 ? { error: 'no tasks completed inside the 60 s envelope' } : {}),
			data,
		};
	},
};

// ---------------------------------------------------------------------------
// Per-task skill execution
// ---------------------------------------------------------------------------

/**
 * Run a single legacy `AnalysisTask` through the skills pipeline.
 * Tasks where `analysisTaskToSkillPlan` returns null (`free-form` or
 * missing scope) are routed through `runSkillsPipeline` instead.
 */
async function runTaskAsSkillExecutions(
	task: AnalysisTask,
	repoPath: string,
	runnerDeps: SkillRunnerDeps,
): Promise<AnalyzerResult> {
	const plan = analysisTaskToSkillPlan(task, { repoPath });
	let executions: PerSkillExecution[] = [];

	if (plan === null) {
		const repoCtx = repoContextFromSummary(buildRepoSummaryFromPath(repoPath));
		const pipeline = await runSkillsPipeline(
			{ question: task.question, repo: repoCtx },
			{
				session:         runnerDeps.session,
				resolveProvider: runnerDeps.resolveProvider,
				...(runnerDeps.signal !== undefined ? { signal: runnerDeps.signal } : {}),
			},
		);
		executions = [...pipeline.executions];
	} else {
		for (const step of plan.steps) {
			try {
				const result = await runSkill<Record<string, unknown>, unknown>(
					step.skillId,
					step.args,
					runnerDeps,
				);
				executions.push(executionFromSkillResult(step.skillId, step.args, result, false));
			} catch (err) {
				executions.push({
					skillId:       step.skillId,
					args:          step.args,
					resolvedScope: { repoPath },
					value:         null,
					confidence:    'low',
					notes:         [`skill execution threw: ${(err as Error).message}`],
					toolCalls:     [],
					errored:       true,
				});
			}
		}
	}

	return mergeExecutionsToAnalyzerResult(task, executions);
}

function buildRepoSummaryFromPath(repoPath: string): RepoSummary {
	return {
		name: repoPath.split('/').filter(Boolean).pop() ?? '(unknown)',
		rootPath: repoPath,
		primaryLanguages: [],
		topLevelPackages: [],
		closureSize: 1,
		repoSnapshotId: '',
	};
}

function executionFromSkillResult(
	skillId: string,
	args: Record<string, unknown>,
	result: SkillResult<unknown>,
	errored: boolean,
): PerSkillExecution {
	const repoPath = typeof args['repoPath'] === 'string' ? args['repoPath'] : '';
	return {
		skillId,
		args,
		resolvedScope: { repoPath },
		value:         result.value,
		confidence:    result.confidence,
		notes:         result.notes ?? [],
		toolCalls:     result.toolCalls.map(tc => ({
			toolId:     tc.toolId,
			durationMs: tc.durationMs,
			...(tc.error !== undefined ? { error: tc.error } : {}),
		})),
		errored,
	};
}

function mergeExecutionsToAnalyzerResult(
	task: AnalysisTask,
	executions: readonly PerSkillExecution[],
): AnalyzerResult {
	if (executions.length === 0) {
		return {
			itemId:     task.itemId,
			answer:     `Skill plan for \`${task.kind}\` produced no executions.`,
			findings:   [],
			citations:  [],
			confidence: 'low',
			toolCalls:  [],
		};
	}
	const synthetic: SkillsPipelineResult = {
		classify:   { questionType: 'free-form', candidates: [], fallbacks: [], uncertaintyNotes: [] },
		select:     { scoped: [], notes: [] },
		executions,
		finalConfidence: 'low',
		notes: [],
		aborted: false,
	};
	const pairs = pipelineResultToAcceptedTasks(synthetic, task.itemId.length > 0 ? task.itemId : 'flow2');
	const answers: string[] = [];
	const findings: Finding[] = [];
	const citationsSeen = new Set<string>();
	const citations: CodeCitation[] = [];
	const toolCalls: AnalyzerResult['toolCalls'][number][] = [];
	let lowest: Confidence = 'high';
	const rank: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };
	for (const { result } of pairs) {
		answers.push(result.answer);
		for (const f of result.findings) findings.push(f);
		for (const c of result.citations) {
			const key = JSON.stringify(c);
			if (citationsSeen.has(key)) continue;
			citationsSeen.add(key);
			citations.push(c);
		}
		for (const tc of result.toolCalls) toolCalls.push(tc);
		if (rank[result.confidence] < rank[lowest]) lowest = result.confidence;
	}
	return {
		itemId:     task.itemId,
		answer:     answers.join('\n\n'),
		findings,
		citations,
		confidence: lowest,
		toolCalls,
	};
}

function buildSkillRunnerDeps(deps: ToolDeps, signal: AbortSignal): SkillRunnerDeps {
	const session = deps.session;
	const resolveProvider = (affinity: ProviderAffinity): LLMProvider => {
		switch (affinity) {
			case 'local': return session.ollamaProvider;
			case 'cloud': return session.claudeProvider ?? session.ollamaProvider;
			case 'auto':  return session.resolver.resolve('skill', 'default');
		}
	};
	return {
		session,
		resolveProvider,
		toolExecCtx: {
			...(deps.send !== undefined ? { send: deps.send } : {}),
			...(deps.channel !== undefined ? { channel: deps.channel } : {}),
			...(deps.requestId !== undefined ? { requestId: deps.requestId } : {}),
		},
		signal,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message: string): ToolResult {
	return { output: `[code:analyze] ${message}`, format: 'text', success: false, error: message };
}

function isScopeSize(v: unknown): boolean {
	return v === 'S' || v === 'M' || v === 'L' || v === 'XL' || v === 'XXL' || v === 'XXXL' || v === 'XXXXL';
}

function isAnalysisKind(v: unknown): v is AnalysisKind {
	return v === 'locate' || v === 'describe' || v === 'trace' || v === 'compare' || v === 'free-form';
}

function parseTask(raw: RawTaskInput, _index: number): AnalysisTask | string {
	if (raw === null || typeof raw !== 'object') {
		return 'not an object';
	}
	if (!isAnalysisKind(raw.kind)) {
		return `kind must be one of locate | describe | trace | compare | free-form`;
	}
	if (typeof raw.question !== 'string' || raw.question.trim().length === 0) {
		return 'question required';
	}
	const task: AnalysisTask = {
		itemId: '',
		kind: raw.kind,
		question: raw.question.trim(),
		origin: 'plan',
		retryCount: 0,
		...(typeof raw.hint === 'string' && raw.hint.length > 0 ? { hint: raw.hint } : {}),
		...(raw.scope !== undefined ? { scope: raw.scope as AnalysisScope } : {}),
	};
	return task;
}

function shortTitle(task: AnalysisTask): string {
	const q = task.question.trim();
	return q.length > 60 ? q.slice(0, 57) + '...' : q;
}

function unionFindings(outcomes: readonly AnalyzerResult[]): Finding[] {
	const out: Finding[] = [];
	for (const r of outcomes) {
		out.push(...r.findings);
	}
	return out;
}

function unionCitations(outcomes: readonly AnalyzerResult[]): CodeCitation[] {
	const seen = new Set<string>();
	const out: CodeCitation[] = [];
	for (const r of outcomes) {
		for (const c of r.citations) {
			const key = JSON.stringify(c);
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			out.push(c);
		}
	}
	return out;
}

function aggregateConfidence(outcomes: readonly AnalyzerResult[]): Confidence {
	if (outcomes.length === 0) {
		return 'low';
	}
	const order: Confidence[] = ['high', 'medium', 'low'];
	let lowest: Confidence = 'high';
	for (const r of outcomes) {
		if (order.indexOf(r.confidence) > order.indexOf(lowest)) {
			lowest = r.confidence;
		}
	}
	return lowest;
}

/**
 * Render the Flow-2 report. Caller folds this into its own write-up
 * under a "Code findings (code-analyzer)" subsection.
 */
function stitchFlow2Report(
	completed: readonly { task: AnalysisTask; outcome: AnalyzerResult }[],
	failed: readonly { task: AnalysisTask; reason: string }[],
	callerAgent: string | undefined,
): string {
	const lines: string[] = [];
	const agentLabel = callerAgent ? ` (for ${callerAgent})` : '';
	lines.push(`# Code findings${agentLabel}`);
	lines.push('');
	if (completed.length === 0) {
		lines.push('_No tasks completed inside the 60 s envelope._');
		return lines.join('\n') + '\n';
	}
	for (const { task, outcome } of completed) {
		lines.push(`## ${task.kind}: ${shortTitle(task)}`);
		lines.push('');
		lines.push(outcome.answer.trim());
		if (outcome.findings.length > 0) {
			lines.push('');
			lines.push('**Findings:**');
			for (const f of outcome.findings) {
				const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file || '(cross-file)';
				lines.push(`- [${f.severity}] ${f.issue} (${loc})`);
			}
		}
		lines.push('');
	}
	if (failed.length > 0) {
		lines.push('---');
		lines.push('');
		lines.push(`**Tasks that did not finish (${failed.length}):**`);
		for (const f of failed) {
			lines.push(`- \`${shortTitle(f.task)}\` -- ${f.reason}`);
		}
		lines.push('');
	}
	return lines.join('\n').replace(/\s+$/, '') + '\n';
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCodeAnalyzeFlow2Tool(): void {
	registerTool(codeAnalyzeTool);
}
