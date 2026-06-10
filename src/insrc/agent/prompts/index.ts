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
import { discoveryPlanExpansionWriterV1 }   from './writers/discovery-plan-expansion.js';
import { cycleReviewWriterV1 }              from './writers/cycle-review.js';
import {
	sectionReviewWriterV1,
	sectionReviseWriterV1,
} from './writers/section-review.js';
import { sectionSynthWriterV1 }             from './writers/section-synth.js';

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
	r.register(discoveryPlanExpansionWriterV1);
	r.register(cycleReviewWriterV1);
	r.register(sectionReviewWriterV1);
	r.register(sectionReviseWriterV1);
	r.register(sectionSynthWriterV1);
	// Phase 0 migration still pending for the working-memory writers
	// (memory-shape single + map + reduce; memory-update summary +
	// recent + semantic; bullet-extractor). 7 more behaviour-preserving
	// extractions; landing in the next commit.
}
