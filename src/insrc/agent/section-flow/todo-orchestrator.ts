/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TODO orchestrator (planner-section-task-separation P3.d).
 *
 * Wires the four pieces of P3 into a single function the section-flow
 * orchestrator (lands in P5) calls once per TODO:
 *
 *   1. Section planner (P3.a)         -- emit a PlannedTree.
 *   2. Per-root execution + review    -- run leaves, review per root,
 *      + followup loop (P3.b)            handle followup cycles.
 *   3. Section assembly (P3.c.1)      -- extract candidate markdown.
 *   4. Section review loop (P3.c.2)   -- 3-verdict structured output;
 *                                        revise-edits up to cap-3.
 *
 * Re-plan budget: revise-major escalations from either P3.b or P3.c
 * trigger a fresh section-planner run (capped via `maxReplans`,
 * default 1). When the budget is exhausted -- or when the section
 * planner itself throws -- the orchestrator invokes the caller-
 * supplied L2 fallback (Q10's runtime floor).
 *
 * The L2 fallback signature is intentionally minimal: it takes the
 * TODO + memory bundle and returns the section markdown. The caller
 * binds the actual L2 skill (`data.answer-question` /
 * `code.answer-question`) per-pipeline; this module doesn't decide.
 *
 * Output: a fully-formed `WorkingMemoryEntry` ready for
 * `WorkingMemoryStore.write()` (P1.b). On the success path,
 * `entry.findings` carries the per-root findings; on the L2 path,
 * `entry.findings.fallback === 'L2'` and `perRoot` has a single
 * synthetic `L2-fallback` entry so downstream consumers (Q5 / Q7
 * / Q8) can detect the floor was hit.
 */

import type { LLMProvider } from '../../shared/types.js';
import type { MemoryShapeBundle } from '../working-memory/index.js';
import type {
	PerRootFinding,
	TodoOrigin,
	WorkingMemoryEntry,
	WorkingMemoryFindings,
} from '../working-memory/types.js';
import type { TodoSpec } from './types.js';
import type { ExecuteLeaf } from './step-root-execution.js';
import { runSectionPlanner } from './step-section-planner.js';
import { executeReviewableRoots } from './step-root-execution.js';
import { assembleSection } from './step-section-assembly.js';
import { reviewSection } from './step-section-review.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:todo-orchestrator');

const DEFAULT_MAX_REPLANS = 1;

// ---------------------------------------------------------------------------
// L2 fallback contract
// ---------------------------------------------------------------------------

export interface L2FallbackInput {
	readonly todo:    TodoSpec;
	readonly memory:  MemoryShapeBundle;
	/** Why the orchestrator fell back; useful as L2 prompt context. */
	readonly reason:  string;
}

/**
 * The caller (P5 section-flow orchestrator) supplies this when wiring
 * the TODO orchestrator. Returns the section markdown the L2 skill
 * produced. Implementations are expected to invoke whichever
 * `<owner>.answer-question` skill matches the pipeline.
 */
export type L2Fallback = (input: L2FallbackInput) => Promise<string>;

// ---------------------------------------------------------------------------
// Public input / output
// ---------------------------------------------------------------------------

export interface TodoOrchestratorInput {
	readonly todo:        TodoSpec;
	readonly memory:      MemoryShapeBundle;
	readonly provider:    LLMProvider;
	readonly executeLeaf: ExecuteLeaf;
	readonly l2Fallback:  L2Fallback;
	readonly catalogHint?: string | undefined;
	/** Max revise-major-triggered replans before L2 fallback. Default 1. */
	readonly maxReplans?: number | undefined;
}

export interface TodoOrchestratorTrace {
	readonly replansConsumed:   number;
	readonly l2FallbackUsed:    boolean;
	readonly failureChain:      readonly string[];
}

export interface TodoOrchestratorResult {
	readonly entry:   WorkingMemoryEntry;
	readonly trace:   TodoOrchestratorTrace;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runTodoOrchestrator(
	input: TodoOrchestratorInput,
): Promise<TodoOrchestratorResult> {
	const maxReplans = input.maxReplans ?? DEFAULT_MAX_REPLANS;
	const failureChain: string[] = [];
	let replansConsumed = 0;
	let l2Reason = 'unknown';

	// Re-plan loop. Each iteration is one full attempt at the pipeline
	// (plan -> execute -> assemble -> review). Re-plans only happen on
	// revise-major escalations from per-root or section review; other
	// failures (planner throws, executor errors) skip directly to L2.
	while (true) {
		// 1. Section planner -- throws on validation failure after retry.
		let plan;
		try {
			const plannerInput: Parameters<typeof runSectionPlanner>[0] = {
				todo:     input.todo,
				memory:   input.memory,
				provider: input.provider,
			};
			if (input.catalogHint !== undefined) {
				(plannerInput as { catalogHint?: string }).catalogHint = input.catalogHint;
			}
			plan = await runSectionPlanner(plannerInput);
		} catch (err) {
			const reason = `section planner failed: ${(err as Error).message}`;
			failureChain.push(reason);
			log.warn({ todoId: input.todo.id, reason }, 'section planner exhausted -> L2 fallback');
			l2Reason = reason;
			break;
		}

		// 2. Per-root execution + review + followup loop.
		const execResult = await executeReviewableRoots({
			todo:        input.todo,
			tree:        plan.tree,
			memory:      input.memory,
			executeLeaf: input.executeLeaf,
			provider:    input.provider,
		});

		if (execResult.reopenRequested) {
			const reason = `per-root review revise-major: ${execResult.reopenReason ?? 'no reason'}`;
			failureChain.push(reason);
			if (replansConsumed >= maxReplans) {
				log.warn({ todoId: input.todo.id, replansConsumed, reason }, 'per-root replan budget exhausted -> L2 fallback');
				l2Reason = reason;
				break;
			}
			replansConsumed += 1;
			log.info({ todoId: input.todo.id, replansConsumed, reason }, 'per-root revise-major -> re-planning section tree');
			continue;
		}

		// 3. Assemble candidate section markdown (deterministic).
		const assembly = assembleSection({
			todo:     input.todo,
			tree:     plan.tree,
			findings: execResult.findings,
		});

		// 4. Section review loop (revise-edits cap-3, revise-major escalates).
		const review = await reviewSection({
			todo:      input.todo,
			memory:    input.memory,
			candidate: assembly.markdown,
			findings:  execResult.findings,
			provider:  input.provider,
		});

		if (review.reopenRequested) {
			const reason = `section review revise-major: ${review.reopenReason ?? 'no reason'}`;
			failureChain.push(reason);
			if (replansConsumed >= maxReplans) {
				log.warn({ todoId: input.todo.id, replansConsumed, reason }, 'section review replan budget exhausted -> L2 fallback');
				l2Reason = reason;
				break;
			}
			replansConsumed += 1;
			log.info({ todoId: input.todo.id, replansConsumed, reason }, 'section review revise-major -> re-planning section tree');
			continue;
		}

		// Success path.
		const entry = buildSuccessEntry({
			todo:           input.todo,
			detail:         review.finalMarkdown,
			findings:       execResult.findings,
			sectionExhausted: review.exhausted,
			plannerRetried: plan.retried,
			assemblyFallback: assembly.usedFallback,
		});
		log.info({
			todoId:           input.todo.id,
			replansConsumed,
			rootCount:        execResult.findings.perRoot.length,
			sectionExhausted: review.exhausted,
		}, 'TODO orchestrator success');
		return {
			entry,
			trace: {
				replansConsumed,
				l2FallbackUsed: false,
				failureChain,
			},
		};
	}

	// L2 fallback path.
	const l2Markdown = await input.l2Fallback({
		todo:   input.todo,
		memory: input.memory,
		reason: l2Reason,
	});
	const entry = buildL2Entry({
		todo:     input.todo,
		detail:   l2Markdown,
		l2Reason,
	});
	return {
		entry,
		trace: {
			replansConsumed,
			l2FallbackUsed: true,
			failureChain,
		},
	};
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

interface BuildSuccessEntryInput {
	readonly todo:             TodoSpec;
	readonly detail:           string;
	readonly findings:         WorkingMemoryFindings;
	readonly sectionExhausted: boolean;
	readonly plannerRetried:   boolean;
	readonly assemblyFallback: boolean;
}

function buildSuccessEntry(input: BuildSuccessEntryInput): WorkingMemoryEntry {
	// If section review exhausted the cap, annotate the per-root
	// findings so the final report review (Q7) can flag this section.
	// We don't mutate the per-root entries -- instead we tag the
	// detail with a marker line at the end (visible in the report
	// preview but distinguishable from regular markdown).
	const detailWithMarkers = appendAnnotations(input.detail, {
		sectionExhausted: input.sectionExhausted,
		plannerRetried:   input.plannerRetried,
		assemblyFallback: input.assemblyFallback,
	});

	return {
		todoId:      input.todo.id,
		objective:   input.todo.objective,
		detail:      detailWithMarkers,
		findings:    input.findings,
		completedAt: Date.now(),
		origin:      input.todo.origin as TodoOrigin,
	};
}

interface BuildL2EntryInput {
	readonly todo:     TodoSpec;
	readonly detail:   string;
	readonly l2Reason: string;
}

function buildL2Entry(input: BuildL2EntryInput): WorkingMemoryEntry {
	const l2Finding: PerRootFinding = {
		rootId:         'l2-fallback',
		verdict:        'L2-fallback',
		cyclesConsumed: 0,
		exhausted:      false,
		content:        `L2 fallback invoked. Reason: ${input.l2Reason}`,
	};
	return {
		todoId:      input.todo.id,
		objective:   input.todo.objective,
		detail:      input.detail,
		findings: {
			perRoot:  [l2Finding],
			fallback: 'L2',
		},
		completedAt: Date.now(),
		origin:      input.todo.origin as TodoOrigin,
	};
}

interface Annotations {
	readonly sectionExhausted: boolean;
	readonly plannerRetried:   boolean;
	readonly assemblyFallback: boolean;
}

function appendAnnotations(detail: string, a: Annotations): string {
	const notes: string[] = [];
	if (a.sectionExhausted) {
		notes.push('section-review-exhausted');
	}
	if (a.plannerRetried) {
		notes.push('planner-corrected');
	}
	if (a.assemblyFallback) {
		notes.push('assembly-fallback');
	}
	if (notes.length === 0) {
		return detail;
	}
	return `${detail}\n\n<!-- section-flow: ${notes.join(', ')} -->`;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _buildSuccessEntryForTest  = buildSuccessEntry;
export const _buildL2EntryForTest       = buildL2Entry;
export const _appendAnnotationsForTest  = appendAnnotations;
export const DEFAULT_MAX_REPLANS_VALUE  = DEFAULT_MAX_REPLANS;
