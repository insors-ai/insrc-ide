/**
 * Barrel export + central registration entrypoint for prompt writers.
 *
 * Callers import everything they need from `agent/prompts/index.js`:
 *
 *   import { getPromptRegistry, registerAllPromptWriters } from '.../prompts/index.js';
 *
 * The `registerAllPromptWriters` function is called once at startup
 * (mirrors `registerAllSkills`) and registers every writer that
 * ships in this codebase. Per-phase plan migrations add their
 * register calls here.
 */

export type {
	PromptWriter,
	PromptWriterMetadata,
	PromptRegistry,
	PromptListFilter,
	PromptTier,
} from './types.js';
export {
	PromptNotRegisteredError,
	PromptAlreadyRegisteredError,
} from './types.js';

export {
	getPromptRegistry,
	_resetPromptRegistryForTest,
	_setPromptRegistryForTest,
} from './registry.js';

// Composition helpers re-exported for direct use by writers + tests.
export { renderAntiFabricationRules } from './composers/anti-fabrication.js';
export { renderSkillSchema }          from './composers/skill-schema.js';
export { renderFactGaps }             from './composers/fact-gaps.js';
export { renderToc }                  from './composers/toc.js';

import { getPromptRegistry } from './registry.js';
import { shapeResolverWriterV1 }            from './writers/shape-resolver.js';
import { factGapAnalysisWriterV1 }          from './writers/fact-gap-analysis.js';
import { buildContextWriterV1 }             from './writers/build-context.js';
import { sketchWriterV1 }                   from './writers/sketch.js';
import { decideNextStepWriterV1 }           from './writers/decide-next-step.js';
import { summarizeStepWriterV1 }            from './writers/summarize-step.js';
import {
	sectionReviewWriterV1,
	sectionReviseWriterV1,
} from './writers/section-review.js';
import { sectionSynthWriterV2 }             from './writers/section-synth.js';
import {
	memoryShapeWriterV1,
	memoryShapeMapWriterV1,
	memoryShapeReduceWriterV1,
} from './writers/memory-shape.js';
import { memoryUpdateWriterV1 }             from './writers/memory-update.js';
import { bulletExtractorWriterV1 }          from './writers/bullet-extractor.js';

/**
 * Register every PromptWriter that ships with the codebase. Mirrors
 * `registerAllSkills` in the skills module. Idempotent only if the
 * registry is freshly reset between calls; calling twice without a
 * reset will throw `PromptAlreadyRegisteredError`.
 *
 * Phase 0 ships shape-resolver migrated. Subsequent phases add their
 * writers here.
 */
export function registerAllPromptWriters(): void {
	const r = getPromptRegistry();
	r.register(shapeResolverWriterV1);
	r.register(factGapAnalysisWriterV1);
	r.register(buildContextWriterV1);
	r.register(sketchWriterV1);
	r.register(decideNextStepWriterV1);
	r.register(summarizeStepWriterV1);
	r.register(sectionReviewWriterV1);
	r.register(sectionReviseWriterV1);
	r.register(sectionSynthWriterV2);
	r.register(memoryShapeWriterV1);
	r.register(memoryShapeMapWriterV1);
	r.register(memoryShapeReduceWriterV1);
	r.register(memoryUpdateWriterV1);
	r.register(bulletExtractorWriterV1);
	// Phase 4 batch 4.2 deleted the cycle-review-v2 + discovery-plan-
	// expansion writers along with the cycle loop they served; the
	// dynamic decide-next-step loop replaces them.
	// The remaining section-flow prompts (step-investigation-plan,
	// step-report-assemble, step-report-review) sit outside the core
	// per-TODO loop (whole-report-level orchestration). Migrating
	// them is a follow-up; not blocking Phase 4 since they're not on
	// the dynamic-flow critical path.
}
