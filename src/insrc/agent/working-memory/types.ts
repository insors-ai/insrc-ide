/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Working-memory data types for the planner-section-task-separation
 * orchestrator (plans/planner-section-task-separation.md).
 *
 * One `WorkingMemoryEntry` is written per completed TODO. The `detail`
 * slot holds the section markdown (the actual report contribution).
 * The `findings` slot holds per-reviewable-root verdicts + cycle
 * accounting (Q6) and the L2-fallback flag (Q10) -- structurally
 * separate from the section text so downstream review steps can
 * detect under-evidenced sections without parsing markdown.
 *
 * Lifetime per Q1: one directory per report run, ephemeral by default,
 * persisted only when the run completes successfully. Crash recovery
 * per Q9: per-TODO atomic write; mid-iteration crash loses only the
 * in-flight TODO.
 */

/**
 * Origin of a TODO entry. `report-review-escalation` is the Q7
 * `revise-structural` path: TODOs appended mid-run by the report
 * reviewer to close a scope gap.
 */
export type TodoOrigin = 'initial' | 'report-review-escalation';

/**
 * Verdict the section orchestrator reached for one reviewable root.
 *
 * - `accept`        -- reviewer returned `accept` on first pass or after
 *                      <= 3 followup cycles (Q3 / Q6).
 * - `force-accept`  -- followup cap hit (cycles_consumed === 3 with the
 *                      reviewer still wanting followups); orchestrator
 *                      force-accepts with `exhausted: true`.
 * - `L2-fallback`   -- the per-root branch could not produce a coherent
 *                      finding even after the cap; orchestrator
 *                      delegated to the L2 fallback skill (Q10).
 */
export type RootVerdict = 'accept' | 'force-accept' | 'L2-fallback';

export interface PerRootFinding {
	/** Stable id of the reviewable root (top-level child of the section task tree). */
	readonly rootId: string;
	readonly verdict: RootVerdict;
	/**
	 * Followup cycles consumed (Q6c). 0 means the initial review accepted
	 * outright. Cap is 3; if the reviewer wanted a 4th cycle, the
	 * orchestrator force-accepts and sets `exhausted: true`.
	 */
	readonly cyclesConsumed: number;
	/**
	 * True iff the followup cap was hit AND the reviewer still wanted
	 * more cycles. Lets section review (Q5) and final report review (Q7)
	 * detect under-evidenced sections downstream.
	 */
	readonly exhausted: boolean;
	/** Findings text for this root (cited evidence, conclusions, gaps). */
	readonly content: string;
}

export interface WorkingMemoryFindings {
	readonly perRoot: readonly PerRootFinding[];
	/**
	 * Set to 'L2' when the entire TODO degraded to a single L2
	 * `<owner>.answer-question` call after section-tree failure. Per
	 * Q10, this is the runtime floor -- the run never regresses below
	 * legacy behavior. Surfaced as a status note on the TodoList per Q8.
	 */
	readonly fallback?: 'L2' | undefined;
}

export interface WorkingMemoryEntry {
	/** Matches the investigation plan's TODO id (Q1 schema decision). */
	readonly todoId: string;
	/**
	 * Copy of the TODO's `objective` string. Duplicated here (vs joined
	 * back via id) so a cold-rebuilt shaping run can read entries without
	 * round-tripping through the orchestrator state.
	 */
	readonly objective: string;
	/**
	 * The section markdown -- the actual report contribution. Memory
	 * shaping (P1.c) reads this concatenated across entries as the
	 * accumulated working-memory text.
	 */
	readonly detail: string;
	readonly findings: WorkingMemoryFindings;
	/** Unix ms timestamp when the entry was atomically committed. */
	readonly completedAt: number;
	readonly origin: TodoOrigin;
}

/**
 * The on-disk metadata block written ahead of the markdown body. Keep
 * this minimal and serialisable -- everything goes through one JSON
 * stringify/parse round-trip.
 */
export interface WorkingMemoryEntryMetadata {
	readonly todoId: string;
	readonly objective: string;
	readonly findings: WorkingMemoryFindings;
	readonly completedAt: number;
	readonly origin: TodoOrigin;
}
