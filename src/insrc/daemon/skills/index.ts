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
import { registerDataSourceRdbmsSampleRowsSkill } from './built-ins/data.source.rdbms.sample-rows.js';
import { registerDataSourceRdbmsSampleDistinctSkill } from './built-ins/data.source.rdbms.sample-distinct.js';
import { registerDataSourceFileDescribeSkill } from './built-ins/data.source.file.describe.js';
import { registerDataSourceFileSampleRowsSkill } from './built-ins/data.source.file.sample-rows.js';
import { registerDataSourceFileSampleShapeSkill } from './built-ins/data.source.file.sample-shape.js';
import { registerDataSourceKvScanKeysSkill } from './built-ins/data.source.kv.scan-keys.js';
import { registerDataSourceKvGetValueSkill } from './built-ins/data.source.kv.get-value.js';
import { registerDataSourceKvSampleShapeSkill } from './built-ins/data.source.kv.sample-shape.js';
import { registerDataProfileNumericRdbmsSkill } from './built-ins/data.profile.numeric.rdbms.js';
import { registerDataProfileCategoricalRdbmsSkill } from './built-ins/data.profile.categorical.rdbms.js';
import { registerDataProfileBooleanRdbmsSkill } from './built-ins/data.profile.boolean.rdbms.js';
import { registerDataQualityCompletenessRdbmsSkill } from './built-ins/data.quality.completeness.rdbms.js';
import { registerDataQualityUniquenessRdbmsSkill } from './built-ins/data.quality.uniqueness.rdbms.js';
import { registerDataPiiDetectPatternsRdbmsSkill } from './built-ins/data.pii.detect-patterns.rdbms.js';
import { registerDataProfileTemporalRdbmsSkill } from './built-ins/data.profile.temporal.rdbms.js';
import { registerDataProfileTextRdbmsSkill } from './built-ins/data.profile.text.rdbms.js';
import { registerDataProfileAutoRdbmsSkill } from './built-ins/data.profile.auto.rdbms.js';

const log = getLogger('skills-bootstrap');

export function registerAllSkills(): void {
  // Atomic skills first.
  registerDataLineageSkill();
  // Phase 1.1 + 2.1 -- RDBMS source-introspection + sampling.
  registerDataSourceRdbmsDescribeTableSkill();
  registerDataSourceRdbmsSampleRowsSkill();
  registerDataSourceRdbmsSampleDistinctSkill();
  // Phase 1.3 + 2.3 -- one skill spans all 12 file kinds via the
  // consolidated DuckDB-backed driver.
  registerDataSourceFileDescribeSkill();
  registerDataSourceFileSampleRowsSkill();
  registerDataSourceFileSampleShapeSkill();
  // Phase 2.2 -- KV sampling (redis / valkey / keydb / mongodb /
  // cassandra / nats / dynamodb / etcd / memcached).
  registerDataSourceKvScanKeysSkill();
  registerDataSourceKvGetValueSkill();
  registerDataSourceKvSampleShapeSkill();
  // Phase 5a (Family-5 univariate profilers). Atomics first, then
  // the auto composite that dispatches by declared SQL type.
  registerDataProfileNumericRdbmsSkill();
  registerDataProfileCategoricalRdbmsSkill();
  registerDataProfileBooleanRdbmsSkill();
  registerDataProfileTemporalRdbmsSkill();
  registerDataProfileTextRdbmsSkill();
  // Phase 5d (quality scorecard) -- atomic dimensions land first;
  // the scorecard composite ships once validity / conformity /
  // consistency are also in.
  registerDataQualityCompletenessRdbmsSkill();
  registerDataQualityUniquenessRdbmsSkill();
  // Phase 5e (sensitivity / PII) -- regex over sampled values;
  // local-affinity (no LLM in the matching path).
  registerDataPiiDetectPatternsRdbmsSkill();

  // Composite skills. Must register AFTER their atomic skillDeps.
  // 5a.6 -- profile.auto dispatches to numeric / categorical /
  // boolean / temporal / text by declared SQL type.
  registerDataProfileAutoRdbmsSkill();

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
