/**
 * LMDB-backed plan + plan-step persistence.
 *
 * Phase 2.5 of plans/storage-migration-lmdb-lance.md. Public surface
 * preserved verbatim from the prior DuckDB implementation:
 *   - savePlan / getPlan / getActivePlan
 *   - updateStepState (with state-machine validation)
 *   - getNextStep (next unblocked pending step)
 *   - deletePlan / deletePlansForRepo
 *   - resetStaleLocks (crash recovery)
 *   - isValidTransition (pure helper)
 *
 * Storage:
 *   - `plan` sub-DB:      utf8 plan_id           -> msgpack(PlanRow)
 *   - `plan_step` sub-DB: (utf8 plan_id, \0, u32 idx BE) -> msgpack(PlanStepRow)
 *
 * Plan-graph edges are NOT in the unified `out_edge` / `in_edge` sub-DBs
 * (those are keyed by u64 entity IDs; plan/step IDs are utf8 strings):
 *   - CONTAINS (plan -> step) is implicit in the `plan_step` composite key
 *     -- a prefix scan on `(plan_id)` returns all steps for the plan, in
 *     `idx` order (BE u32 sorts numerically).
 *   - STEP_DEPENDS_ON is the `dependsOn: string[]` array stored on the
 *     PlanStepRow itself.
 *
 * The `db: DbClient` parameter is kept (vestigial) -- Phase 5.x removes
 * it from callers.
 */

import type { Plan, PlanStep, PlanStepStatus, PlanStatus } from '../../shared/types.js';
import {
	getGraphStore,
	withWriteTxn,
	type GraphStore,
} from '../../db/graph/store.js';
import {
	encodePlanStepKey,
	encodePlanStepPrefix,
	prefixSuccessor,
} from '../../db/graph/keys.js';
import {
	encodePlanRow,
	decodePlanRow,
	encodePlanStepRow,
	decodePlanStepRow,
	type PlanRow,
	type PlanStepRow,
	type PlanStepStatus as RowPlanStepStatus,
	type PlanStepComplexity as RowPlanStepComplexity,
	type PlanStatus as RowPlanStatus,
} from '../../db/graph/codec.js';

type DbClient = unknown;

// ---------------------------------------------------------------------------
// State machine (pure)
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<PlanStepStatus, PlanStepStatus[]> = {
	pending:     ['in_progress', 'skipped'],
	in_progress: ['done', 'failed', 'skipped', 'pending'], // pending = crash recovery
	done:        ['pending'],   // only via /plan undo
	failed:      ['in_progress'], // retry
	skipped:     ['pending'],   // revert skip
};

export function isValidTransition(from: PlanStepStatus, to: PlanStepStatus): boolean {
	return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Save plan + steps
// ---------------------------------------------------------------------------

export async function savePlan(_db: DbClient, plan: Plan): Promise<void> {
	const now = Date.now();
	await withWriteTxn(s => {
		const planRow: PlanRow = {
			id:        plan.id,
			repoPath:  plan.repoPath,
			title:     plan.title,
			status:    plan.status as RowPlanStatus,
			createdAt: parseTs(plan.createdAt) || now,
			updatedAt: now,
		};
		s.plan.put(plan.id, encodePlanRow(planRow));

		for (const step of plan.steps) {
			const row: PlanStepRow = {
				id:          step.id,
				planId:      plan.id,
				idx:         step.idx,
				title:       step.title,
				description: step.description,
				checkpoint:  step.checkpoint,
				status:      step.status as RowPlanStepStatus,
				complexity:  step.complexity as RowPlanStepComplexity,
				fileHint:    step.fileHint || '',
				notes:       step.notes || '',
				dependsOn:   step.dependsOn ?? [],
				createdAt:   parseTs(step.createdAt) || now,
				updatedAt:   now,
				startedAt:   parseTs(step.startedAt),
				doneAt:      parseTs(step.doneAt),
			};
			s.planStep.put(encodePlanStepKey(plan.id, step.idx), encodePlanStepRow(row));
		}
	});
}

// ---------------------------------------------------------------------------
// Get plan + active plan
// ---------------------------------------------------------------------------

export async function getPlan(_db: DbClient, planId: string): Promise<Plan | null> {
	const store = await getGraphStore();
	const buf = store.plan.get(planId);
	if (buf === undefined) return null;
	const planRow = decodePlanRow(buf as Buffer);
	const steps: PlanStep[] = [];
	for (const row of iterPlanSteps(store, planId)) {
		steps.push(rowToStep(row));
	}
	return rowToPlan(planRow, steps);
}

export async function getActivePlan(_db: DbClient, repoPath: string): Promise<Plan | null> {
	const store = await getGraphStore();
	let best: PlanRow | null = null;
	for (const { value } of store.plan.getRange()) {
		const row = decodePlanRow(value as Buffer);
		if (row.repoPath !== repoPath || row.status !== 'active') continue;
		if (best === null || row.createdAt > best.createdAt) {
			best = row;
		}
	}
	if (best === null) return null;
	return getPlan(_db, best.id);
}

// ---------------------------------------------------------------------------
// Update step state (with state-machine validation + side effects)
// ---------------------------------------------------------------------------

export async function updateStepState(
	_db: DbClient,
	stepId: string,
	newStatus: PlanStepStatus,
	note?: string,
): Promise<{ ok: boolean; error?: string }> {
	let result: { ok: boolean; error?: string } = { ok: false, error: 'step not found' };

	await withWriteTxn(s => {
		const found = findStepById(s, stepId);
		if (found === null) return;
		const { row, key } = found;

		const currentStatus = row.status as PlanStepStatus;
		if (!isValidTransition(currentStatus, newStatus)) {
			result = { ok: false, error: `invalid transition: ${currentStatus} -> ${newStatus}` };
			return;
		}

		const now = Date.now();
		const updatedNotes = note
			? row.notes ? `${row.notes}\n[${new Date(now).toISOString()}] ${note}` : `[${new Date(now).toISOString()}] ${note}`
			: row.notes;

		const next: PlanStepRow = { ...row, status: newStatus as RowPlanStepStatus, notes: updatedNotes, updatedAt: now };
		if (newStatus === 'in_progress') {
			next.startedAt = now;
		} else if (newStatus === 'done' || newStatus === 'skipped') {
			next.doneAt = now;
		} else if (newStatus === 'pending') {
			// Revert: clear started_at + done_at
			next.startedAt = 0;
			next.doneAt = 0;
		}
		s.planStep.put(key, encodePlanStepRow(next));

		// Side effects: maybe complete the parent plan, or re-activate it
		if (newStatus === 'done' || newStatus === 'skipped') {
			maybeCompletePlanInTxn(s, row.planId, now);
		}
		if (newStatus === 'pending') {
			reactivatePlanInTxn(s, row.planId, now);
		}

		result = { ok: true };
	});

	return result;
}

// ---------------------------------------------------------------------------
// Next unblocked step
// ---------------------------------------------------------------------------

export async function getNextStep(_db: DbClient, planId: string): Promise<PlanStep | null> {
	const store = await getGraphStore();
	// Build a status map for the whole plan up-front so dependency
	// checks don't re-scan per step
	const stepStatusById = new Map<string, PlanStepStatus>();
	const stepsInOrder: PlanStepRow[] = [];
	for (const row of iterPlanSteps(store, planId)) {
		stepStatusById.set(row.id, row.status as PlanStepStatus);
		stepsInOrder.push(row);
	}

	for (const row of stepsInOrder) {
		if (row.status !== 'pending') continue;
		const blocking = row.dependsOn.filter(depId => {
			const st = stepStatusById.get(depId);
			return st !== 'done' && st !== 'skipped';
		});
		if (blocking.length === 0) {
			// Strip dependsOn for the returned shape (callers don't need it)
			const out = rowToStep(row);
			out.dependsOn = [];
			return out;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Delete plan + cascade
// ---------------------------------------------------------------------------

export async function deletePlan(_db: DbClient, planId: string): Promise<void> {
	await withWriteTxn(s => {
		// Walk the plan_step prefix and drop each step row
		const prefix = encodePlanStepPrefix(planId);
		const succ = prefixSuccessor(prefix);
		const stepKeys: Buffer[] = [];
		for (const { key } of s.planStep.getRange({ start: prefix, end: succ })) {
			stepKeys.push(key as Buffer);
		}
		for (const k of stepKeys) s.planStep.remove(k);
		s.plan.remove(planId);
	});
}

export async function deletePlansForRepo(_db: DbClient, repoPath: string): Promise<void> {
	const store = await getGraphStore();
	const planIds: string[] = [];
	for (const { key, value } of store.plan.getRange()) {
		const row = decodePlanRow(value as Buffer);
		if (row.repoPath === repoPath) planIds.push(key as string);
	}
	for (const id of planIds) {
		await deletePlan(_db, id);
	}
}

// ---------------------------------------------------------------------------
// Reset stale in_progress locks (crash recovery)
// ---------------------------------------------------------------------------

export async function resetStaleLocks(_db: DbClient, planId: string): Promise<number> {
	let resetCount = 0;
	await withWriteTxn(s => {
		const now = Date.now();
		const prefix = encodePlanStepPrefix(planId);
		const succ = prefixSuccessor(prefix);
		const stale: { key: Buffer; row: PlanStepRow }[] = [];
		for (const { key, value } of s.planStep.getRange({ start: prefix, end: succ })) {
			const row = decodePlanStepRow(value as Buffer);
			if (row.status === 'in_progress') {
				stale.push({ key: key as Buffer, row });
			}
		}
		for (const { key, row } of stale) {
			const next: PlanStepRow = {
				...row,
				status:    'pending',
				startedAt: 0,
				updatedAt: now,
				notes:     row.notes
					? `${row.notes}\n[${new Date(now).toISOString()}] reset stale in_progress lock`
					: `[${new Date(now).toISOString()}] reset stale in_progress lock`,
			};
			s.planStep.put(key, encodePlanStepRow(next));
			resetCount++;
		}
	});
	return resetCount;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function* iterPlanSteps(store: GraphStore, planId: string): Generator<PlanStepRow> {
	const prefix = encodePlanStepPrefix(planId);
	const succ = prefixSuccessor(prefix);
	for (const { value } of store.planStep.getRange({ start: prefix, end: succ })) {
		yield decodePlanStepRow(value as Buffer);
	}
}

function findStepById(s: GraphStore, stepId: string): { row: PlanStepRow; key: Buffer } | null {
	// O(N) over plan_step. plan/step counts stay in the dozens to low
	// hundreds in practice. Tier-2 perf if it becomes hot: a
	// `step_id -> (plan_id, idx)` index sub-DB.
	for (const { key, value } of s.planStep.getRange()) {
		const row = decodePlanStepRow(value as Buffer);
		if (row.id === stepId) return { row, key: key as Buffer };
	}
	return null;
}

function maybeCompletePlanInTxn(s: GraphStore, planId: string, now: number): void {
	const prefix = encodePlanStepPrefix(planId);
	const succ = prefixSuccessor(prefix);
	let allTerminal = true;
	for (const { value } of s.planStep.getRange({ start: prefix, end: succ })) {
		const row = decodePlanStepRow(value as Buffer);
		if (row.status !== 'done' && row.status !== 'skipped') {
			allTerminal = false;
			break;
		}
	}
	if (!allTerminal) return;
	const buf = s.plan.get(planId);
	if (buf === undefined) return;
	const planRow = decodePlanRow(buf as Buffer);
	if (planRow.status === 'completed') return;
	const next: PlanRow = { ...planRow, status: 'completed', updatedAt: now };
	s.plan.put(planId, encodePlanRow(next));
}

function reactivatePlanInTxn(s: GraphStore, planId: string, now: number): void {
	const buf = s.plan.get(planId);
	if (buf === undefined) return;
	const planRow = decodePlanRow(buf as Buffer);
	if (planRow.status === 'active') return;
	const next: PlanRow = { ...planRow, status: 'active', updatedAt: now };
	s.plan.put(planId, encodePlanRow(next));
}

function rowToPlan(planRow: PlanRow, steps: PlanStep[]): Plan {
	return {
		id:        planRow.id,
		repoPath:  planRow.repoPath,
		title:     planRow.title,
		status:    planRow.status as PlanStatus,
		steps,
		createdAt: formatTs(planRow.createdAt),
		updatedAt: formatTs(planRow.updatedAt),
	};
}

function rowToStep(row: PlanStepRow): PlanStep {
	const step: PlanStep = {
		id:          row.id,
		planId:      row.planId,
		idx:         row.idx,
		title:       row.title,
		description: row.description,
		checkpoint:  row.checkpoint,
		status:      row.status as PlanStepStatus,
		complexity:  row.complexity as PlanStep['complexity'],
		fileHint:    row.fileHint || '',
		notes:       row.notes,
		dependsOn:   row.dependsOn,
		createdAt:   formatTs(row.createdAt),
		updatedAt:   formatTs(row.updatedAt),
	};
	if (row.startedAt > 0) step.startedAt = formatTs(row.startedAt);
	if (row.doneAt > 0) step.doneAt = formatTs(row.doneAt);
	return step;
}

function parseTs(s: string | undefined): number {
	if (s === undefined || s === '') return 0;
	const n = Date.parse(s);
	return Number.isFinite(n) ? n : 0;
}

function formatTs(ms: number): string {
	if (ms === 0) return '';
	return new Date(ms).toISOString();
}
