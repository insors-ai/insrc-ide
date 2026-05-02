/**
 * Skills bootstrap barrel.
 *
 * One entry point the daemon's `index.ts` calls after the tool
 * registry has been populated. Skills depend on tools (via
 * `toolDeps`) so the order is fixed: tools first, then skills.
 *
 * Composite skills depend on atomic skills via `skillDeps`; the
 * registry's registration-time check enforces that atomic
 * registrations run first. For v1 the bundled built-ins fit on one
 * page (the data-lineage migration target); future per-family
 * build-outs from plans/analyzers/data-analyzer-skills.md plug in
 * here in topological order.
 */

import { getLogger } from '../../shared/logger.js';
import { listSkills } from './registry.js';
import { registerDataLineageSkill } from './built-ins/data-lineage.js';
import { registerDataSourceRdbmsDescribeTableSkill } from './built-ins/data.source.rdbms.describe-table.js';
import { registerDataSourceFileDescribeSkill } from './built-ins/data.source.file.describe.js';
import { registerDataSourceFileSampleRowsSkill } from './built-ins/data.source.file.sample-rows.js';
import { registerDataSourceFileSampleShapeSkill } from './built-ins/data.source.file.sample-shape.js';

const log = getLogger('skills-bootstrap');

export function registerAllSkills(): void {
  // Atomic skills first.
  registerDataLineageSkill();
  // Phase 1.1 -- data-analyzer-skills.md
  registerDataSourceRdbmsDescribeTableSkill();
  // Phase 1.3 + 2.3 -- one skill spans all 12 file kinds via the
  // consolidated DuckDB-backed driver.
  registerDataSourceFileDescribeSkill();
  registerDataSourceFileSampleRowsSkill();
  registerDataSourceFileSampleShapeSkill();

  // Composite skills go here once any are registered. Empty in v1.

  log.info({ registered: listSkills().length }, 'skill registry populated');
}

// Public surface re-exports so consumers don't need to know the
// internal file layout.
export { runSkill } from './invoke.js';
export type { SkillRunnerDeps, SkillRunnerToolCtx } from './invoke.js';
export { getSkill, listSkills, listSkillsByFamily, listSkillsByOwner } from './registry.js';
export { assertFeasible } from './feasibility.js';
export { DefaultSkillAuditLog } from './audit.js';
export type { SkillAuditLog } from './audit.js';
export type {
  Feasibility,
  Precondition,
  PreconditionFailure,
  ProviderAffinity,
  RunSkillOpts,
  Skill,
  SkillConfidence,
  SkillContext,
  SkillDeps,
  SkillEvent,
  SkillFamily,
  SkillOwner,
  SkillResult,
  SkillSubSkillSummary,
  SkillToolCallSummary,
  SkillToolResult,
} from './types.js';
export { SkillInvocationError } from './types.js';
