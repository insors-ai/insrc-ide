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
import { shapeResolverWriterV1 }    from './writers/shape-resolver.js';
import { factGapAnalysisWriterV1 }  from './writers/fact-gap-analysis.js';

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
	// Phase 0 migration in progress -- the following writers ship in
	// subsequent commits. Each is a behaviour-preserving extraction
	// from its current inline `buildMessages` (or equivalent) helper
	// in the section-flow / working-memory modules:
	//
	//   - discoveryPlanExpansionWriterV1
	//   - cycleReviewWriterV1
	//   - sectionReviewWriterV1
	//   - sectionSynthWriterV1
	//   - memoryShapeWriterV1
	//   - memoryUpdateWriterV1
	//   - bulletExtractorWriterV1
	//   - investigationPlanWriterV1
	//   - reportAssembleWriterV1
	//   - reportReviewWriterV1
	//
	// Until then, those step modules keep their inline prompts; the
	// PromptWriter interface is forward-compatible because each
	// migration is independent.
}
