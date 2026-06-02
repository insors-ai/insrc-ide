/**
 * `data_analyze` -- Flow-2 cross-agent dispatch entry
 * (plans/analyzers/data-analyzer.md Phase 4.3).
 *
 * Mirror of `code_analyze` for the Data Analyzer. Sibling analyzer
 * families (today: code-analyzer; future: deployment-analyzer) call
 * this with a pre-built `DataAnalysisTask[]`. The Data Analyzer skips
 * its plan + review + present gates, runs each task through
 * `runDataAnalyzer`, and returns a structured payload the caller can
 * fold into its own report.
 *
 * Caps + envelope (mirroring code_analyze and the data-analyzer's
 * Flow 1 caps in TIER_CAPS):
 *   - Soft cap   16 tasks  (silent trim; sets `truncated: true`).
 *   - Hard cap   24 tasks  (entries past this dropped before run).
 *   - Wall clock 60 s overall envelope. Tasks run concurrently;
 *                whatever lands inside the envelope is returned with
 *                `truncated: true`.
 *
 * Connection-approval gates STILL fire (per design §13.5: "Flow 2
 * doesn't bypass user consent"). The dispatcher's session.access
 * already has any ephemeral connections seeded by the caller's flow;
 * fresh connections trip the universal access gate UI.
 */

import { runAnswerQuestionTask } from '../../agent/tasks/data-analyzer/answer-question-section.js';
import { loadActiveConnections } from '../../agent/tasks/data-analyzer/load-connections.js';
import { registerTool } from '../tools/registry.js';
import {
	CROSS_AGENT_DEPTH_FIELD,
	exceedsCrossAgentDepth,
	readCrossAgentDepth,
	toolUnavailable,
} from '../../shared/cross-agent.js';
import { getLogger } from '../../shared/logger.js';
import type {
	DataAnalysisTask,
	DataAnalysisKind,
	DataAnalyzerResult,
	DataCitation,
	DataFinding,
} from '../../agent/tasks/data-analyzer/types.js';
import type { ScopeSize } from '../../shared/classify.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../tools/types.js';

const log = getLogger('data-analyzer:flow2');

// ---------------------------------------------------------------------------
// Caps + envelope
// ---------------------------------------------------------------------------

const FLOW2_TRIM_CAP = 16;
const FLOW2_TOTAL_TIMEOUT_MS = 60_000;
// Per-task wall-clock cap was carried via the legacy runDataAnalyzer's
// `wallClockMs` option; the new runDataDiscoveryPipeline relies on the
// overall envelope's AbortController to bound each task. The 45 s
// per-task budget is preserved implicitly by the 60 s envelope and
// serial dispatch (3 tasks × 20 s avg fits inside).

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

interface DataAnalyzeResult {
	/** Stitched per-task markdown the caller can splice into its report. */
	readonly report: string;
	readonly findings: readonly DataFinding[];
	readonly citations: readonly DataCitation[];
	readonly confidence: 'high' | 'medium' | 'low';
	readonly truncated: boolean;
	readonly droppedTasks: number;
	readonly timedOutTasks: number;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const dataAnalyzeTool: Tool = {
	id: 'data_analyze',
	description:
		'Cross-agent Flow-2 dispatch: run a sibling-supplied DataAnalysisTask[] through the Data Analyzer\'s ' +
		'per-task tool loop. Skips planning + reviews + present gates -- caller does its own review against the ' +
		'returned findings. 60 s envelope. Returns a structured payload with stitched report + findings + citations.',
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
						kind: {
							type: 'string',
							enum: ['inspect-schema', 'sample-data', 'sample-shape', 'lineage', 'schema-drift', 'er', 'free-form'],
						},
						question: { type: 'string', minLength: 1 },
						scope: { type: 'object' },
						hint: { type: 'string' },
					},
					required: ['kind', 'question'],
				},
			},
			callerContext: {
				type: 'object',
				description: 'Optional context the calling family uses for citation labelling. `agent` is the family name (e.g. "code-analyzer").',
				properties: {
					agent: { type: 'string' },
				},
			},
			tier: {
				type: 'string',
				enum: ['S', 'M', 'L', 'XL'],
				description: 'Optional sizing hint. Defaults to M; the data-analyzer clamps anything > XL to XL anyway.',
			},
			[CROSS_AGENT_DEPTH_FIELD]: { type: 'number', description: 'Cross-agent recursion depth (set by caller).' },
		},
		required: ['tasks'],
		additionalProperties: false,
	},
	requiresApproval: false,

	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		// Cross-agent depth check -- same envelope as code_analyze.
		const depth = readCrossAgentDepth(input);
		if (exceedsCrossAgentDepth(depth)) {
			const sentinel = toolUnavailable('cross_agent_depth_exceeded');
			return {
				output: '[data_analyze] unavailable: cross_agent_depth_exceeded',
				format: 'json',
				success: false,
				error: 'cross_agent_depth_exceeded',
				data: sentinel,
			};
		}

		const tasksRaw = input['tasks'];
		if (!Array.isArray(tasksRaw)) {
			return fail('tasks must be an array');
		}
		const allTasks: DataAnalysisTask[] = [];
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
			log.info({ requested: allTasks.length, kept: tasks.length, dropped: droppedTasks }, 'data_analyze: trimmed task list to Flow-2 cap');
		}

		const callerCtx = input['callerContext'] as RawCallerContext | undefined;
		const callerAgent = typeof callerCtx?.agent === 'string' ? callerCtx.agent : undefined;
		const tier: ScopeSize = isScopeSize(input['tier']) ? input['tier'] as ScopeSize : 'M';
		log.info(
			{ taskCount: tasks.length, dropped: droppedTasks, tier, callerAgent: callerAgent ?? null },
			'data_analyze: starting Flow-2 dispatch',
		);

		// 60 s overall envelope; per-task wallclock at 45 s.
		// Connection discovery: the discovery pipeline needs the active
		// connection set up front (the legacy runDataAnalyzer used to do
		// this internally via its db_list_connections tool call).
		const connections = await loadActiveConnections(deps.session);
		const startedAt = Date.now();
		const overall = (() => {
			const ctrl = new AbortController();
			const tid = setTimeout(() => ctrl.abort(), FLOW2_TOTAL_TIMEOUT_MS);
			deps.signal?.addEventListener('abort', () => {
				clearTimeout(tid);
				ctrl.abort();
			}, { once: true });
			return { ctrl, tid };
		})();

		// Serial dispatch. DA-D1 of plans/analyzers/data-analyzer-parity.md:
		// NEVER run analyzer tasks in parallel -- each reaches the LLM
		// provider, and the no-parallel-LLM-calls rule (saved-memory
		// "no_parallel_llm_calls.md") forbids it. The previous
		// `Promise.allSettled` violated the rule; the code-analyzer side
		// got bitten by similar parallelism three different times before
		// being headed off.
		//
		// The overall envelope is still enforced by `overall.ctrl.signal`:
		// when the deadline fires, the signal aborts the in-flight task
		// AND every remaining task short-circuits as "envelope exceeded"
		// without starting (no LLM call made).
		const completed: { task: DataAnalysisTask; outcome: DataAnalyzerResult }[] = [];
		const failed: { task: DataAnalysisTask; reason: string }[] = [];
		let perTaskTruncated = false;
		let timedOutTasks = 0;
		for (const task of tasks) {
			if (overall.ctrl.signal.aborted) {
				// Envelope already exceeded -- count this task as a
				// timeout without starting its LLM tool loop.
				timedOutTasks += 1;
				continue;
			}
			try {
				const outcome = await runAnswerQuestionTask({
					session: deps.session,
					task,
					connections,
					...(overall.ctrl.signal ? { signal: overall.ctrl.signal } : {}),
				});
				if (outcome.truncated) {
					perTaskTruncated = true;
				}
				completed.push({ task, outcome: outcome.result });
			} catch (err) {
				const message = (err as Error).message ?? String(err);
				log.warn({ task: shortTitle(task), err: message }, 'data_analyze: task threw');
				if (overall.ctrl.signal.aborted) {
					timedOutTasks += 1;
				} else {
					failed.push({ task, reason: message });
				}
			}
		}
		clearTimeout(overall.tid);
		const elapsed = Date.now() - startedAt;

		const truncated = droppedTasks > 0 || timedOutTasks > 0 || perTaskTruncated;
		const report = stitchFlow2Report(completed, failed, callerAgent);
		const findings = unionFindings(completed.map(c => c.outcome));
		const citations = unionCitations(completed.map(c => c.outcome));
		const confidence = aggregateConfidence(completed.map(c => c.outcome));

		const data: DataAnalyzeResult = {
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
			'data_analyze: Flow-2 done',
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
	return { output: `[data_analyze] ${message}`, format: 'text', success: false, error: message };
}

function isScopeSize(v: unknown): boolean {
	return v === 'S' || v === 'M' || v === 'L' || v === 'XL';
}

function isDataAnalysisKind(v: unknown): v is DataAnalysisKind {
	return v === 'inspect-schema'
		|| v === 'sample-data'
		|| v === 'sample-shape'
		|| v === 'lineage'
		|| v === 'schema-drift'
		|| v === 'er'
		|| v === 'free-form';
}

function parseTask(raw: RawTaskInput, _index: number): DataAnalysisTask | string {
	if (raw === null || typeof raw !== 'object') {
		return 'not an object';
	}
	if (!isDataAnalysisKind(raw.kind)) {
		return 'kind must be one of inspect-schema | sample-data | sample-shape | lineage | schema-drift | er | free-form';
	}
	if (typeof raw.question !== 'string' || raw.question.trim().length === 0) {
		return 'question required';
	}
	const task: DataAnalysisTask = {
		itemId: '',
		kind: raw.kind,
		question: raw.question.trim(),
		origin: 'plan',
		...(typeof raw.hint === 'string' && raw.hint.length > 0 ? { hint: raw.hint } : {}),
		...(raw.scope !== undefined ? { scope: raw.scope as DataAnalysisTask['scope'] } : {}),
	};
	return task;
}

function shortTitle(task: DataAnalysisTask): string {
	const q = task.question.trim();
	return q.length > 60 ? q.slice(0, 57) + '...' : q;
}

function unionFindings(outcomes: readonly DataAnalyzerResult[]): DataFinding[] {
	const out: DataFinding[] = [];
	for (const r of outcomes) {
		out.push(...r.findings);
	}
	return out;
}

function unionCitations(outcomes: readonly DataAnalyzerResult[]): DataCitation[] {
	const seen = new Set<string>();
	const out: DataCitation[] = [];
	for (const r of outcomes) {
		for (const c of r.citations) {
			const key = JSON.stringify(c);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(c);
		}
	}
	return out;
}

function aggregateConfidence(outcomes: readonly DataAnalyzerResult[]): 'high' | 'medium' | 'low' {
	if (outcomes.length === 0) return 'low';
	const order = ['high', 'medium', 'low'] as const;
	let lowest: 'high' | 'medium' | 'low' = 'high';
	for (const r of outcomes) {
		if (order.indexOf(r.confidence) > order.indexOf(lowest)) {
			lowest = r.confidence;
		}
	}
	return lowest;
}

/**
 * Render the Flow-2 report. Caller folds this into its own write-up
 * under a "Data findings (data-analyzer)" subsection -- per §13.6 the
 * `callerContext.agent` ends up in the heading as a labelling hint.
 */
function stitchFlow2Report(
	completed: readonly { task: DataAnalysisTask; outcome: DataAnalyzerResult }[],
	failed: readonly { task: DataAnalysisTask; reason: string }[],
	callerAgent: string | undefined,
): string {
	const lines: string[] = [];
	const agentLabel = callerAgent ? ` (for ${callerAgent})` : '';
	lines.push(`# Data findings${agentLabel}`);
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
				lines.push(`- [${f.severity}] ${f.concern}: ${f.issue}`);
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

export function registerDataAnalyzeFlow2Tool(): void {
	registerTool(dataAnalyzeTool);
}
