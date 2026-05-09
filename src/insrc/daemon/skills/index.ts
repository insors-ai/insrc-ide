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
import { registerDataCodeDeadCodeSkill } from './built-ins/data.code.dead-code.js';
import { registerCodeClassExtractFieldsSkill } from './built-ins/code.class.extract-fields.js';
import { registerCodeClassLocateReferencesSkill } from './built-ins/code.class.locate-references.js';
import { registerCodeOrmResolveModelSkill } from './built-ins/code.orm.resolve-model.js';
import { registerCodeMigrationExtractHistorySkill } from './built-ins/code.migration.extract-history.js';
import { registerCodeSourceFileDescribeSkill } from './built-ins/code.source.file.describe.js';
import { registerCodeSourceModuleDescribeSkill } from './built-ins/code.source.module.describe.js';
import { registerCodeSourceRepoDescribeSkill } from './built-ins/code.source.repo.describe.js';
import { registerDataSourceRdbmsDescribeTableSkill } from './built-ins/data.source.rdbms.describe-table.js';
import { registerDataSourceRdbmsListTablesSkill } from './built-ins/data.source.rdbms.list-tables.js';
import { registerDataSourceRdbmsListIndexesSkill } from './built-ins/data.source.rdbms.list-indexes.js';
import { registerDataSourceRdbmsSampleRowsSkill } from './built-ins/data.source.rdbms.sample-rows.js';
import { registerDataSourceRdbmsSampleDistinctSkill } from './built-ins/data.source.rdbms.sample-distinct.js';
import { registerDataSourceFileDescribeSkill } from './built-ins/data.source.file.describe.js';
import { registerDataSourceFileSampleRowsSkill } from './built-ins/data.source.file.sample-rows.js';
import { registerDataSourceFileSampleShapeSkill } from './built-ins/data.source.file.sample-shape.js';
import { registerDataSourceKvScanKeysSkill } from './built-ins/data.source.kv.scan-keys.js';
import { registerDataSourceKvGetValueSkill } from './built-ins/data.source.kv.get-value.js';
import { registerDataSourceKvSampleShapeSkill } from './built-ins/data.source.kv.sample-shape.js';
import { registerDataSourceKvListNamespacesSkill } from './built-ins/data.source.kv.list-namespaces.js';
import { registerDataSourceKvDescribeNamespaceSkill } from './built-ins/data.source.kv.describe-namespace.js';
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
import { registerDataPiiDetectPatternsKvSkill } from './built-ins/data.pii.detect-patterns.kv.js';
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
import { registerDataSynthHistogramBlockSkill } from './built-ins/data.synth.histogram-block.js';
import { registerDataMetaFeasibilityCheckSkill } from './built-ins/data.meta.feasibility-check.js';
import { registerDataMetaCalibrateConfidenceSkill } from './built-ins/data.meta.calibrate-confidence.js';
import { registerDataMetaClassifyQuestionSkill } from './built-ins/data.meta.classify-question.js';
import { registerDataMetaSelectScopeSkill } from './built-ins/data.meta.select-scope.js';
import { registerDataQualityValidityRdbmsSkill } from './built-ins/data.quality.validity.rdbms.js';
import { registerDataQualityValidityFileSkill } from './built-ins/data.quality.validity.file.js';
import { registerDataDistributionHistogramRdbmsSkill } from './built-ins/data.distribution.histogram.rdbms.js';
import { registerDataDistributionHistogramFileSkill } from './built-ins/data.distribution.histogram.file.js';
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
  // Phase 8.1 of plans/storage-migration-lmdb-lance.md -- the
  // headline value-delivery the LMDB substrate move was built to
  // unblock. Pure-graph reachability over the typed unreachable()
  // primitive.
  registerDataCodeDeadCodeSkill();
  // code-analyzer-skills.md Phase 3.1 -- the first cross-owner
  // code-binding skill. Composes code_class_locate + code_class_fields;
  // typed `{ found, nearest }` discriminator codifies the
  // 2026-04-30 hallucinated-class fix structurally.
  registerCodeClassExtractFieldsSkill();
  // code-analyzer-skills.md Phase 3.2 -- the second cross-owner
  // code-binding skill. Composes code_class_locate +
  // code_class_references; same typed-refusal discriminator as §3.1.
  registerCodeClassLocateReferencesSkill();
  // code-analyzer-skills.md Phase 3.3 -- the ORM model resolver.
  // Wraps code_orm_scan with name filtering + uniform output shape.
  // Unblocks data-analyzer §3.3 and all of data-analyzer Phase 4
  // (lineage / cardinality / quality skills that need a model ->
  // table -> column mapping).
  registerCodeOrmResolveModelSkill();
  // code-analyzer-skills.md Phase 3.5 -- migration history extraction.
  // Wraps code_migration_walk with a typed { found, reason } refusal
  // shape. Last cross-owner skill on the critical path -- closes out
  // the prerequisites blocking data-analyzer skills routing
  // flag-default-on cutover.
  registerCodeMigrationExtractHistorySkill();
  // code-analyzer-skills.md Phase 1 -- source-introspection skills.
  // Pure-graph wrappers; the indexer is the source of truth and
  // these expose typed views on top of it for the future Phase 7.1 /
  // 7.2 LLM-routed planner.
  registerCodeSourceFileDescribeSkill();
  registerCodeSourceModuleDescribeSkill();
  registerCodeSourceRepoDescribeSkill();
  // Phase 1.1 + 2.1 -- RDBMS source-introspection + sampling.
  registerDataSourceRdbmsDescribeTableSkill();
  registerDataSourceRdbmsListTablesSkill();
  registerDataSourceRdbmsListIndexesSkill();
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
  // Phase 1.2 -- KV introspection (list / describe namespaces).
  registerDataSourceKvListNamespacesSkill();
  registerDataSourceKvDescribeNamespaceSkill();
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
  // Phase 5b (Family-5 distribution shape) -- histogram + outlier
  // detection variants. Histogram is a thin pass-through over the
  // server-side `db_*_histogram` tools (Phase 0.2). Outlier skills
  // are hybrid: bounds from server-side aggregate, examples +
  // estimated counts from a 50-row sample.
  registerDataDistributionHistogramRdbmsSkill();
  registerDataDistributionHistogramFileSkill();
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
  registerDataPiiDetectPatternsKvSkill();

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
  // 6.9 synth.histogram-block renders the 5b.1 histogram output as
  // an ASCII bar chart inside a fenced code block.
  registerDataSynthHistogramBlockSkill();
  // 5e.3 sensitivity.policy-check composes pii.column-classifier
  // across columns vs the connection's declared PII list.
  registerDataSensitivityPolicyCheckRdbmsSkill();
  // Phase 7 meta skills -- 7.3 / 7.4 are deterministic helpers; 7.1
  // (classify-question) is the LLM-routed router consumed by the
  // planner rewrite (Phase 8.1) when it lands.
  registerDataMetaFeasibilityCheckSkill();
  registerDataMetaCalibrateConfidenceSkill();
  registerDataMetaClassifyQuestionSkill();
  registerDataMetaSelectScopeSkill();

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
