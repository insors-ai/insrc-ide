import type { DbClient } from '../../db/client.js';
import type { Plan, PlanStep, PlanStepStatus, PlanStatus } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Plan persistence layer -- DuckDB graph operations.
//
// Plans live in DuckDB indefinitely (NOT subject to session TTL).
// Pruned only via explicit /plan delete.
//
// Graph shape (in the unified `relation` table):
//   plan -> plan_step  via kind='CONTAINS'
//   plan_step -> plan_step  via kind='STEP_DEPENDS_ON'
//
// Column-name mapping: JS-side types use camelCase; SQL columns are
// snake_case (repoPath / repo_path, createdAt / created_at, etc.).
// All mapping happens here so callers are unaware.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// State machine — valid transitions
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
// Save plan + steps + edges
// ---------------------------------------------------------------------------

export async function savePlan(db: DbClient, plan: Plan): Promise<void> {
  const now = new Date().toISOString();

  // Upsert Plan row
  await db.duck.exec(
    `INSERT INTO plan (id, repo_path, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       repo_path = excluded.repo_path,
       title = excluded.title,
       status = excluded.status,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [plan.id, plan.repoPath, plan.title, plan.status, plan.createdAt || now, now],
  );

  // Upsert PlanStep rows + CONTAINS edges
  for (const step of plan.steps) {
    await db.duck.exec(
      `INSERT INTO plan_step
         (id, plan_id, idx, title, description, checkpoint, status, complexity,
          file_hint, notes, created_at, updated_at, started_at, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         plan_id = excluded.plan_id,
         idx = excluded.idx,
         title = excluded.title,
         description = excluded.description,
         checkpoint = excluded.checkpoint,
         status = excluded.status,
         complexity = excluded.complexity,
         file_hint = excluded.file_hint,
         notes = excluded.notes,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         started_at = excluded.started_at,
         done_at = excluded.done_at`,
      [
        step.id, plan.id, step.idx, step.title, step.description, step.checkpoint,
        step.status, step.complexity, step.fileHint || '', step.notes || '',
        step.createdAt || now, now, step.startedAt || '', step.doneAt || '',
      ],
    );

    // CONTAINS edge: plan -> plan_step
    await db.duck.exec(
      `INSERT INTO relation (src, dst, kind) VALUES (?, ?, 'CONTAINS')
       ON CONFLICT (src, dst, kind) DO NOTHING`,
      [plan.id, step.id],
    );
  }

  // STEP_DEPENDS_ON edges: plan_step -> plan_step
  for (const step of plan.steps) {
    for (const depId of step.dependsOn) {
      await db.duck.exec(
        `INSERT INTO relation (src, dst, kind) VALUES (?, ?, 'STEP_DEPENDS_ON')
         ON CONFLICT (src, dst, kind) DO NOTHING`,
        [step.id, depId],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Get plan with steps and dependency graph
// ---------------------------------------------------------------------------

export async function getPlan(db: DbClient, planId: string): Promise<Plan | null> {
  const planRows = await db.duck.query<{
    id: string; repo_path: string; title: string; status: string;
    created_at: string; updated_at: string;
  }>(
    `SELECT id, repo_path, title, status, created_at, updated_at
     FROM plan WHERE id = ?`,
    [planId],
  );
  if (planRows.length === 0) return null;
  const pr = planRows[0]!;
  const plan: Plan = {
    id:        pr.id,
    repoPath:  pr.repo_path,
    title:     pr.title,
    status:    pr.status as PlanStatus,
    steps:     [],
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
  };

  // Steps via the CONTAINS edge
  const stepRows = await db.duck.query<{
    id: string; plan_id: string; idx: number; title: string; description: string;
    checkpoint: boolean; status: string; complexity: string;
    file_hint: string; notes: string;
    created_at: string; updated_at: string; started_at: string; done_at: string;
  }>(
    `SELECT s.id, s.plan_id, s.idx, s.title, s.description, s.checkpoint,
            s.status, s.complexity, s.file_hint, s.notes,
            s.created_at, s.updated_at, s.started_at, s.done_at
     FROM relation r
     JOIN plan_step s ON s.id = r.dst
     WHERE r.src = ? AND r.kind = 'CONTAINS'
     ORDER BY s.idx`,
    [planId],
  );

  // Dependencies for this plan's steps (joined to bound the query)
  const depRows = await db.duck.query<{ fromId: string; toId: string }>(
    `SELECT dr.src AS "fromId", dr.dst AS "toId"
     FROM relation cr
     JOIN relation dr ON dr.src = cr.dst
     WHERE cr.src = ? AND cr.kind = 'CONTAINS' AND dr.kind = 'STEP_DEPENDS_ON'`,
    [planId],
  );

  const depMap = new Map<string, string[]>();
  for (const row of depRows) {
    if (!depMap.has(row.fromId)) depMap.set(row.fromId, []);
    depMap.get(row.fromId)!.push(row.toId);
  }

  for (const sr of stepRows) {
    plan.steps.push({
      id:          sr.id,
      planId:      sr.plan_id,
      idx:         sr.idx,
      title:       sr.title,
      description: sr.description,
      checkpoint:  sr.checkpoint,
      status:      sr.status as PlanStepStatus,
      complexity:  sr.complexity as PlanStep['complexity'],
      fileHint:    sr.file_hint || '',
      notes:       sr.notes,
      dependsOn:   depMap.get(sr.id) ?? [],
      createdAt:   sr.created_at,
      updatedAt:   sr.updated_at,
      startedAt:   sr.started_at || undefined,
      doneAt:      sr.done_at || undefined,
    });
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Get active plan for a repo
// ---------------------------------------------------------------------------

export async function getActivePlan(db: DbClient, repoPath: string): Promise<Plan | null> {
  const rows = await db.duck.query<{ id: string }>(
    `SELECT id FROM plan
     WHERE repo_path = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [repoPath],
  );
  if (rows.length === 0) return null;
  return getPlan(db, rows[0]!.id);
}

// ---------------------------------------------------------------------------
// Update step state
// ---------------------------------------------------------------------------

export async function updateStepState(
  db: DbClient,
  stepId: string,
  newStatus: PlanStepStatus,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const rows = await db.duck.query<{ status: string; notes: string }>(
    `SELECT status, notes FROM plan_step WHERE id = ?`,
    [stepId],
  );
  if (rows.length === 0) return { ok: false, error: 'step not found' };

  const currentStatus = rows[0]!.status as PlanStepStatus;
  if (!isValidTransition(currentStatus, newStatus)) {
    return { ok: false, error: `invalid transition: ${currentStatus} -> ${newStatus}` };
  }

  const now = new Date().toISOString();
  const existingNotes = rows[0]!.notes || '';
  const updatedNotes = note
    ? existingNotes ? `${existingNotes}\n[${now}] ${note}` : `[${now}] ${note}`
    : existingNotes;

  // Build SET fields conditionally on the new status. Each branch
  // produces the minimal UPDATE; same row only touched once.
  if (newStatus === 'in_progress') {
    await db.duck.exec(
      `UPDATE plan_step
       SET status = ?, notes = ?, updated_at = ?, started_at = ?
       WHERE id = ?`,
      [newStatus, updatedNotes, now, now, stepId],
    );
  } else if (newStatus === 'done' || newStatus === 'skipped') {
    await db.duck.exec(
      `UPDATE plan_step
       SET status = ?, notes = ?, updated_at = ?, done_at = ?
       WHERE id = ?`,
      [newStatus, updatedNotes, now, now, stepId],
    );
  } else if (newStatus === 'pending') {
    // Revert: clear started_at + done_at.
    await db.duck.exec(
      `UPDATE plan_step
       SET status = ?, notes = ?, updated_at = ?, started_at = '', done_at = ''
       WHERE id = ?`,
      [newStatus, updatedNotes, now, stepId],
    );
  } else {
    // failed
    await db.duck.exec(
      `UPDATE plan_step
       SET status = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      [newStatus, updatedNotes, now, stepId],
    );
  }

  // If all steps are done/skipped, mark plan as completed
  if (newStatus === 'done' || newStatus === 'skipped') {
    await maybeCompletePlan(db, stepId);
  }
  // If reverting a step to pending, re-activate the plan
  if (newStatus === 'pending') {
    await reactivatePlan(db, stepId);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Get next unblocked step
// ---------------------------------------------------------------------------

export async function getNextStep(db: DbClient, planId: string): Promise<PlanStep | null> {
  const pendingRows = await db.duck.query<{
    id: string; plan_id: string; idx: number; title: string; description: string;
    checkpoint: boolean; status: string; complexity: string;
    file_hint: string; notes: string;
    created_at: string; updated_at: string; started_at: string; done_at: string;
  }>(
    `SELECT s.id, s.plan_id, s.idx, s.title, s.description, s.checkpoint,
            s.status, s.complexity, s.file_hint, s.notes,
            s.created_at, s.updated_at, s.started_at, s.done_at
     FROM relation r
     JOIN plan_step s ON s.id = r.dst
     WHERE r.src = ? AND r.kind = 'CONTAINS' AND s.status = 'pending'
     ORDER BY s.idx`,
    [planId],
  );

  for (const sr of pendingRows) {
    // Count dependencies that are NOT yet terminal
    const blockingRows = await db.duck.query<{ blocking: number }>(
      `SELECT COUNT(*)::INTEGER AS blocking
       FROM relation dr
       JOIN plan_step d ON d.id = dr.dst
       WHERE dr.src = ? AND dr.kind = 'STEP_DEPENDS_ON'
         AND d.status <> 'done' AND d.status <> 'skipped'`,
      [sr.id],
    );
    const blocking = Number(blockingRows[0]?.blocking ?? 0);

    if (blocking === 0) {
      return {
        id:          sr.id,
        planId:      sr.plan_id,
        idx:         sr.idx,
        title:       sr.title,
        description: sr.description,
        checkpoint:  sr.checkpoint,
        status:      sr.status as PlanStepStatus,
        complexity:  sr.complexity as PlanStep['complexity'],
        fileHint:    sr.file_hint || '',
        notes:       sr.notes,
        dependsOn:   [],  // not needed for next-step context
        createdAt:   sr.created_at,
        updatedAt:   sr.updated_at,
        startedAt:   sr.started_at || undefined,
        doneAt:      sr.done_at || undefined,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Delete plan and all its steps/edges
// ---------------------------------------------------------------------------

export async function deletePlan(db: DbClient, planId: string): Promise<void> {
  // Delete STEP_DEPENDS_ON edges between steps of this plan. We need
  // to identify the steps via the CONTAINS edge first.
  await db.duck.exec(
    `DELETE FROM relation WHERE kind = 'STEP_DEPENDS_ON' AND (
        src IN (SELECT dst FROM relation WHERE src = ? AND kind = 'CONTAINS')
        OR dst IN (SELECT dst FROM relation WHERE src = ? AND kind = 'CONTAINS')
     )`,
    [planId, planId],
  );

  // Delete CONTAINS edges
  await db.duck.exec(
    `DELETE FROM relation WHERE src = ? AND kind = 'CONTAINS'`,
    [planId],
  );

  // Delete step rows
  await db.duck.exec(`DELETE FROM plan_step WHERE plan_id = ?`, [planId]);

  // Delete plan row
  await db.duck.exec(`DELETE FROM plan WHERE id = ?`, [planId]);
}

/**
 * Delete every plan (and its steps + edges) belonging to a repo. Called
 * by the `repo.remove` cleanup so plans don't linger when the repo is
 * detached.
 */
export async function deletePlansForRepo(db: DbClient, repoPath: string): Promise<void> {
  const rows = await db.duck.query<{ id: string }>(
    `SELECT id FROM plan WHERE repo_path = ?`,
    [repoPath],
  );
  for (const row of rows) {
    await deletePlan(db, row.id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function maybeCompletePlan(db: DbClient, stepId: string): Promise<void> {
  // Find the plan that contains this step
  const rows = await db.duck.query<{ plan_id: string }>(
    `SELECT plan_id FROM plan_step WHERE id = ?`,
    [stepId],
  );
  if (rows.length === 0) return;
  const planId = rows[0]!.plan_id;

  // Count steps not yet terminal
  const remaining = await db.duck.query<{ remaining: number }>(
    `SELECT COUNT(*)::INTEGER AS remaining
     FROM relation r
     JOIN plan_step s ON s.id = r.dst
     WHERE r.src = ? AND r.kind = 'CONTAINS'
       AND s.status <> 'done' AND s.status <> 'skipped'`,
    [planId],
  );
  const count = Number(remaining[0]?.remaining ?? 0);

  if (count === 0) {
    const now = new Date().toISOString();
    await db.duck.exec(
      `UPDATE plan SET status = 'completed', updated_at = ? WHERE id = ?`,
      [now, planId],
    );
  }
}

/** Re-activate a plan when a step is reverted to pending. */
async function reactivatePlan(db: DbClient, stepId: string): Promise<void> {
  const rows = await db.duck.query<{ plan_id: string }>(
    `SELECT plan_id FROM plan_step WHERE id = ?`,
    [stepId],
  );
  if (rows.length === 0) return;
  const planId = rows[0]!.plan_id;
  const now = new Date().toISOString();
  await db.duck.exec(
    `UPDATE plan SET status = 'active', updated_at = ? WHERE id = ? AND status <> 'active'`,
    [now, planId],
  );
}

/**
 * Reset stale in_progress locks to pending.
 * Called on session start to recover from crashes.
 */
export async function resetStaleLocks(db: DbClient, planId: string): Promise<number> {
  const now = new Date().toISOString();
  const stepRows = await db.duck.query<{ id: string }>(
    `SELECT s.id
     FROM relation r
     JOIN plan_step s ON s.id = r.dst
     WHERE r.src = ? AND r.kind = 'CONTAINS' AND s.status = 'in_progress'`,
    [planId],
  );

  for (const row of stepRows) {
    await db.duck.exec(
      `UPDATE plan_step
       SET status = 'pending', started_at = '', updated_at = ?,
           notes = notes || ?
       WHERE id = ?`,
      [now, `\n[${now}] reset stale in_progress lock`, row.id],
    );
  }

  return stepRows.length;
}
