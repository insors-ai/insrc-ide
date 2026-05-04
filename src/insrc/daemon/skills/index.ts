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
import { registerDataProfileNumericFileSkill } from './built-ins/data.profile.numeric.file.js';
import { registerDataProfileCategoricalFileSkill } from './built-ins/data.profile.categorical.file.js';
import { registerDataProfileTemporalFileSkill } from './built-ins/data.profile.temporal.file.js';
import { registerDataProfileTextFileSkill } from './built-ins/data.profile.text.file.js';
import { registerDataProfileCategoricalRdbmsSkill } from './built-ins/data.profile.categorical.rdbms.js';
import { registerDataProfileBooleanRdbmsSkill } from './built-ins/data.profile.boolean.rdbms.js';
import { registerDataProfileBooleanFileSkill } from './built-ins/data.profile.boolean.file.js';
import { registerDataQualityCompletenessRdbmsSkill } from './built-ins/data.quality.completeness.rdbms.js';
import { registerDataQualityCompletenessFileSkill } from './built-ins/data.quality.completeness.file.js';
import { registerDataQualityUniquenessRdbmsSkill } from './built-ins/data.quality.uniqueness.rdbms.js';
import { registerDataQualityUniquenessFileSkill } from './built-ins/data.quality.uniqueness.file.js';
import { registerDataPiiDetectPatternsRdbmsSkill } from './built-ins/data.pii.detect-patterns.rdbms.js';
import { registerDataPiiDetectPatternsFileSkill } from './built-ins/data.pii.detect-patterns.file.js';
import { registerDataProfileTemporalRdbmsSkill } from './built-ins/data.profile.temporal.rdbms.js';
import { registerDataProfileTextRdbmsSkill } from './built-ins/data.profile.text.rdbms.js';
import { registerDataProfileAutoRdbmsSkill } from './built-ins/data.profile.auto.rdbms.js';
import { registerDataPiiColumnClassifierRdbmsSkill } from './built-ins/data.pii.column-classifier.rdbms.js';
import { registerDataSynthFieldTableSkill } from './built-ins/data.synth.field-table.js';
import { registerDataSynthSampleTableSkill } from './built-ins/data.synth.sample-table.js';
import { registerDataSynthProfileCardSkill } from './built-ins/data.synth.profile-card.js';
import { registerDataSynthLineageFoldSkill } from './built-ins/data.synth.lineage-fold.js';
import { registerDataQualityScorecardRdbmsSkill } from './built-ins/data.quality.scorecard.rdbms.js';
import { registerDataQualityScorecardFileSkill } from './built-ins/data.quality.scorecard.file.js';
import { registerDataSynthScorecardSkill } from './built-ins/data.synth.scorecard.js';
import { registerDataQualityValidityRdbmsSkill } from './built-ins/data.quality.validity.rdbms.js';
import { registerDataQualityValidityFileSkill } from './built-ins/data.quality.validity.file.js';
import { registerDataDistributionOutliersIqrRdbmsSkill } from './built-ins/data.distribution.outliers-iqr.rdbms.js';
import { registerDataDistributionOutliersIqrFileSkill } from './built-ins/data.distribution.outliers-iqr.file.js';
import { registerDataDistributionOutliersZScoreFileSkill } from './built-ins/data.distribution.outliers-zscore.file.js';
import { registerDataDistributionOutliersMadFileSkill } from './built-ins/data.distribution.outliers-mad.file.js';
import { registerDataDistributionNormalityTestFileSkill } from './built-ins/data.distribution.normality-test.file.js';
import { registerDataDistributionHeavyTailCheckFileSkill } from './built-ins/data.distribution.heavy-tail-check.file.js';
import { registerDataDistributionModesFileSkill } from './built-ins/data.distribution.modes.file.js';
import { registerDataDistributionOutliersZScoreRdbmsSkill } from './built-ins/data.distribution.outliers-zscore.rdbms.js';
import { registerDataDistributionOutliersMadRdbmsSkill } from './built-ins/data.distribution.outliers-mad.rdbms.js';
import { registerDataDependencyCoNullPatternRdbmsSkill } from './built-ins/data.dependency.co-null-pattern.rdbms.js';
import { registerDataDependencyCoNullPatternFileSkill } from './built-ins/data.dependency.co-null-pattern.file.js';
import { registerDataDependencyFunctionalRdbmsSkill } from './built-ins/data.dependency.functional.rdbms.js';
import { registerDataCardinalityJoinKeyRdbmsSkill } from './built-ins/data.cardinality.join-key.rdbms.js';
import { registerDataDistributionNormalityTestRdbmsSkill } from './built-ins/data.distribution.normality-test.rdbms.js';
import { registerDataDistributionHeavyTailCheckRdbmsSkill } from './built-ins/data.distribution.heavy-tail-check.rdbms.js';
import { registerDataSensitivityPolicyCheckRdbmsSkill } from './built-ins/data.sensitivity.policy-check.rdbms.js';
import { registerDataDistributionModesRdbmsSkill } from './built-ins/data.distribution.modes.rdbms.js';
import { registerDataQualityConformityRdbmsSkill } from './built-ins/data.quality.conformity.rdbms.js';
import { registerDataQualityConformityFileSkill } from './built-ins/data.quality.conformity.file.js';
import { registerDataQualityConsistencyRdbmsSkill } from './built-ins/data.quality.consistency.rdbms.js';
import { registerDataQualityConsistencyFileSkill } from './built-ins/data.quality.consistency.file.js';
import { registerDataDriftDistributionRdbmsSkill } from './built-ins/data.drift.distribution.rdbms.js';
import { registerDataDriftDistributionFileSkill } from './built-ins/data.drift.distribution.file.js';
import { registerDataDriftVolumeRdbmsSkill } from './built-ins/data.drift.volume.rdbms.js';
import { registerDataDriftVolumeFileSkill } from './built-ins/data.drift.volume.file.js';
import { registerDataTimeseriesTrendRdbmsSkill } from './built-ins/data.timeseries.trend.rdbms.js';
import { registerDataTimeseriesSeasonalityRdbmsSkill } from './built-ins/data.timeseries.seasonality.rdbms.js';
import { registerDataTimeseriesStationarityRdbmsSkill } from './built-ins/data.timeseries.stationarity.rdbms.js';
import { registerDataTimeseriesGapAnalysisRdbmsSkill } from './built-ins/data.timeseries.gap-analysis.rdbms.js';
import { registerDataCorrelationNumericPairwiseRdbmsSkill } from './built-ins/data.correlation.numeric-pairwise.rdbms.js';
import { registerDataCorrelationNumericPairwiseFileSkill } from './built-ins/data.correlation.numeric-pairwise.file.js';
import { registerDataCorrelationCategoricalPairwiseRdbmsSkill } from './built-ins/data.correlation.categorical-pairwise.rdbms.js';
import { registerDataCorrelationCategoricalPairwiseFileSkill } from './built-ins/data.correlation.categorical-pairwise.file.js';
import { registerDataAnomalyChangePointRdbmsSkill } from './built-ins/data.anomaly.change-point.rdbms.js';

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
  registerDataProfileNumericFileSkill();
  registerDataProfileCategoricalRdbmsSkill();
  registerDataProfileCategoricalFileSkill();
  registerDataProfileBooleanRdbmsSkill();
  registerDataProfileBooleanFileSkill();
  registerDataProfileTemporalRdbmsSkill();
  registerDataProfileTemporalFileSkill();
  registerDataProfileTextRdbmsSkill();
  registerDataProfileTextFileSkill();
  // Phase 5d (quality scorecard) -- atomic dimensions land first;
  // the scorecard composite ships once validity / conformity /
  // consistency are also in.
  registerDataQualityCompletenessRdbmsSkill();
  registerDataQualityCompletenessFileSkill();
  registerDataQualityUniquenessRdbmsSkill();
  registerDataQualityUniquenessFileSkill();
  registerDataQualityValidityRdbmsSkill();
  registerDataQualityValidityFileSkill();
  registerDataQualityConformityRdbmsSkill();
  registerDataQualityConformityFileSkill();
  registerDataQualityConsistencyRdbmsSkill();
  registerDataQualityConsistencyFileSkill();
  // Phase 5b (Family-5 distribution shape) -- outlier detection
  // variants. All hybrid: bounds from server-side aggregate,
  // examples + estimated counts from a 50-row sample.
  registerDataDistributionOutliersIqrRdbmsSkill();
  registerDataDistributionOutliersIqrFileSkill();
  registerDataDistributionOutliersZScoreRdbmsSkill();
  registerDataDistributionOutliersZScoreFileSkill();
  registerDataDistributionOutliersMadRdbmsSkill();
  registerDataDistributionOutliersMadFileSkill();
  registerDataDistributionNormalityTestRdbmsSkill();
  registerDataDistributionNormalityTestFileSkill();
  registerDataDistributionHeavyTailCheckRdbmsSkill();
  registerDataDistributionHeavyTailCheckFileSkill();
  registerDataDistributionModesRdbmsSkill();
  registerDataDistributionModesFileSkill();
  // Phase 5f (drift over windows) -- compares two sample windows
  // of the same column.
  registerDataDriftDistributionRdbmsSkill();
  registerDataDriftDistributionFileSkill();
  registerDataDriftVolumeRdbmsSkill();
  registerDataDriftVolumeFileSkill();
  registerDataAnomalyChangePointRdbmsSkill();
  // Phase 5g (timeseries) -- regression / seasonality / stationarity
  // checks over a temporal axis.
  registerDataTimeseriesTrendRdbmsSkill();
  registerDataTimeseriesSeasonalityRdbmsSkill();
  registerDataTimeseriesStationarityRdbmsSkill();
  registerDataTimeseriesGapAnalysisRdbmsSkill();
  // Phase 5c (cross-column) -- pairwise dependency analyses.
  registerDataDependencyCoNullPatternRdbmsSkill();
  registerDataDependencyCoNullPatternFileSkill();
  registerDataDependencyFunctionalRdbmsSkill();
  registerDataCardinalityJoinKeyRdbmsSkill();
  registerDataCorrelationNumericPairwiseRdbmsSkill();
  registerDataCorrelationNumericPairwiseFileSkill();
  registerDataCorrelationCategoricalPairwiseRdbmsSkill();
  registerDataCorrelationCategoricalPairwiseFileSkill();
  // Phase 5e (sensitivity / PII) -- regex over sampled values;
  // local-affinity (no LLM in the matching path).
  registerDataPiiDetectPatternsRdbmsSkill();
  registerDataPiiDetectPatternsFileSkill();

  // Composite skills. Must register AFTER their atomic skillDeps.
  // 5a.6 -- profile.auto dispatches to numeric / categorical /
  // boolean / temporal / text by declared SQL type.
  registerDataProfileAutoRdbmsSkill();
  // 5e.2 -- pii.column-classifier composes pii.detect-patterns
  // with column-name heuristics for a per-column PII verdict.
  registerDataPiiColumnClassifierRdbmsSkill();
  // Phase 6 -- pure-template synthesis renderers. No tools, no
  // LLM. Take a typed skill output, return a markdown fragment.
  registerDataSynthFieldTableSkill();
  registerDataSynthSampleTableSkill();
  registerDataSynthProfileCardSkill();
  registerDataSynthLineageFoldSkill();
  // 5d.6 quality.scorecard composite -- must register AFTER its
  // skillDeps (completeness + uniqueness atomics).
  registerDataQualityScorecardRdbmsSkill();
  registerDataQualityScorecardFileSkill();
  // 6.8 synth.scorecard renders the scorecard composite's output.
  registerDataSynthScorecardSkill();
  // 5e.3 sensitivity.policy-check composes pii.column-classifier
  // across columns vs the connection's declared PII list.
  registerDataSensitivityPolicyCheckRdbmsSkill();

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
