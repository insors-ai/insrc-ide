/**
 * `code:analyze` -- Flow-2 cross-agent dispatch entry
 * (plans/analyzers/code-analyzer.md Phase 3.6).
 *
 * Sibling analyzer families (data-analyzer, deployment-analyzer)
 * call this tool with a pre-built `AnalysisTask[]`. The Code
 * Analyzer skips its plan step + user-facing gates, runs each
 * task through `runAnalyzer`, and returns a structured result
 * the caller can fold into its own report.
 *
 * Caps + envelopes (per design §13.4):
 *   - Soft cap   16 tasks  (Flow 1 also caps here, but Flow 1 fires
 *                          a user gate; Flow 2 silently trims).
 *   - Hard cap   24 tasks.
 *   - Wall clock 60 s overall envelope. Tasks run concurrently;
 *                whatever lands inside the envelope is returned with
 *                `truncated: true`.
 *
 * Differences from Flow 1:
 *   - No planner LLM call (caller hands the task list).
 *   - No reviewer LLM call (the calling family runs its own review
 *     against the returned findings -- redundant cloud cost
 *     otherwise).
 *   - No present gate (no user in the loop).
 *   - No TodoList side-effects (Flow 2 results are caller-private).
 *
 * The result rolls per-task answers into one stitched markdown
 * `report` so the caller can splice it directly under a "Code
 * findings (code-analyzer)" subsection of its own write-up.
 */

import { runAnalyzer } from '../../agent/tasks/code-analyzer/analyzer/runner.js';
import { registerTool } from '../tools/registry.js';
import {
	CROSS_AGENT_DEPTH_FIELD,
	exceedsCrossAgentDepth,
	readCrossAgentDepth,
	toolUnavailable,
} from '../../shared/cross-agent.js';
import { getLogger } from '../../shared/logger.js';
import type {
	AnalysisTask,
	AnalysisKind,
	AnalysisScope,
	AnalyzerResult,
	CodeCitation,
	Confidence,
	Finding,
} from '../../agent/tasks/code-analyzer/types.js';
import type { ScopeSize } from '../../shared/classify.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../tools/types.js';

const log = getLogger('code-analyzer:flow2');

// ---------------------------------------------------------------------------
// Caps + envelope
// ---------------------------------------------------------------------------

const FLOW2_SOFT_CAP = 16;
const FLOW2_HARD_CAP = 24;
const FLOW2_TOTAL_TIMEOUT_MS = 60_000;
/** Per-task wall clock at the runner level. The overall 60 s envelope
 *  is the binding cap; each task is given a generous 45 s slot since
 *  the runner itself may already be near-done by then. */
const FLOW2_PER_TASK_WALLCLOCK_MS = 45_000;

// ---------------------------------------------------------------------------
// Wire shape (matches plan §3.6 + slot for future tier hint)
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
	/** Stitched per-task markdown the caller can splice into its report. */
	readonly report: string;
	readonly findings: readonly Finding[];
	readonly citations: readonly CodeCitation[];
	readonly confidence: Confidence;
	/**
	 * True when:
	 *   - the input task list was trimmed to fit the hard cap,
	 *   - the 60 s envelope expired before all tasks finished,
	 *   - any individual `runAnalyzer` returned truncated=true.
	 */
	readonly truncated: boolean;
	/** Number of tasks dropped to fit the hard cap. */
	readonly droppedTasks: number;
	/** Number of tasks that didn't finish inside the 60 s envelope. */
	readonly timedOutTasks: number;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const codeAnalyzeTool: Tool = {
	id: 'code:analyze',
	description:
		'Cross-agent Flow-2 dispatch: run a sibling-supplied AnalysisTask[] through the Code Analyzer\'s per-task tool loop. Skips planning + reviews + gates -- caller does its own review against the returned findings. 60 s envelope. Returns a structured payload with stitched report + findings + citations.',
	inputSchema: {
		type: 'object',
		properties: {
			tasks: {
				type: 'array',
				description: `Caller-supplied task list. Hard cap ${FLOW2_HARD_CAP}; entries past that are dropped silently and \`truncated\` is set.`,
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
				description: 'Optional sizing hint for the per-task analyzer playbook. Defaults to M when omitted; cross-agent calls usually arrive narrow so S/M is typical.',
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

		// Silent trim past hard cap.
		const droppedTasks = Math.max(0, allTasks.length - FLOW2_HARD_CAP);
		const tasks = allTasks.slice(0, FLOW2_HARD_CAP);
		if (droppedTasks > 0) {
			log.info({ requested: allTasks.length, kept: tasks.length, dropped: droppedTasks }, 'code:analyze: trimmed task list to hard cap');
		}

		const callerCtx = input['callerContext'] as RawCallerContext | undefined;
		const callerAgent = typeof callerCtx?.agent === 'string' ? callerCtx.agent : undefined;
		const tier: ScopeSize = isScopeSize(input['tier']) ? input['tier'] as ScopeSize : 'M';
		log.info(
			{ taskCount: tasks.length, dropped: droppedTasks, tier, callerAgent: callerAgent ?? null },
			'code:analyze: starting Flow-2 dispatch',
		);

		// ----- Run tasks under the 60 s envelope -----------------------------
		const provider = deps.session.resolver.resolve('code-analyzer', 'analyzer');
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

		const runs = tasks.map(async (task): Promise<{
			task: AnalysisTask;
			outcome: AnalyzerResult | null;
			truncated: boolean;
			error?: string;
		}> => {
			try {
				const result = await runAnalyzer(task, {
					provider,
					session: deps.session,
					signal: overallSignal.ctrl.signal,
					wallClockMs: FLOW2_PER_TASK_WALLCLOCK_MS,
					tier,
				});
				return { task, outcome: result.result, truncated: result.truncated };
			} catch (err) {
				const message = (err as Error).message ?? String(err);
				log.warn({ task: shortTitle(task), err: message }, 'code:analyze: task threw');
				return { task, outcome: null, truncated: false, error: message };
			}
		});

		const settled = await Promise.allSettled(runs);
		clearTimeout(overallSignal.tid);
		const elapsed = Date.now() - startedAt;
		const envelopeExceeded = elapsed >= FLOW2_TOTAL_TIMEOUT_MS;

		// ----- Aggregate -----------------------------------------------------
		const completed: { task: AnalysisTask; outcome: AnalyzerResult }[] = [];
		const failed: { task: AnalysisTask; reason: string }[] = [];
		let perTaskTruncated = false;
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
			if (v.truncated) {
				perTaskTruncated = true;
			}
			completed.push({ task: v.task, outcome: v.outcome });
		}

		const truncated = droppedTasks > 0 || timedOutTasks > 0 || perTaskTruncated;
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
 * under a "Code findings (code-analyzer)" subsection -- per §3.6 the
 * `callerContext.agent` ends up here as a labelling hint.
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

/**
 * Register `code:analyze`. Called from the cross-agent index after
 * the lookup tools (code:locate / code:trace / code:describe).
 */
export function registerCodeAnalyzeFlow2Tool(): void {
	registerTool(codeAnalyzeTool);
}
