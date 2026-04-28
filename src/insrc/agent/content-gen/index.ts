/**
 * Multi-pass content generator (plans/content-generator.md).
 *
 * Reusable module any agent can call to produce long-form markdown
 * docs on models with short output windows. Decomposes generation
 * into:
 *
 *   Pass 1 -- OUTLINE       (small, schema-bound, single LLM call)
 *   Pass 2 -- SECTION BODY  (per-section, parallel-by-default)
 *   STITCH                  (deterministic compose into final doc)
 *
 * Solves four pain points of the single-pass approach the code-
 * analyzer's L/XL/XXL+ synthesise hit (F10 -- "Unterminated string
 * in JSON at position 13186" on devstral): hard truncation, no
 * partial salvage, no streaming UX, no per-section caching.
 *
 * # Sequencing
 *
 * Commit 1 -- outline pass + types + module surface (shipped).
 * Commit 2 (THIS commit) -- section pass, parallel scheduler, stitch,
 *                           and the full `generateMultiPass()` entry.
 * Commit 3              -- optional section-level caching layer.
 *
 * No agent consumes the module yet. Code-analyzer Phase 5.C is the
 * first migrator and lands AFTER commit 2 (i.e. as a follow-up). At
 * lower tiers (S/M) the legacy single-pass synthesise stays the
 * default per the plan -- multi-pass is overhead for short docs.
 */

import type { LLMProvider } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import { generateOutline } from './outline.js';
import { runSections, DEFAULT_SECTION_BUDGET_TOKENS } from './section.js';
import { stitch } from './stitch.js';
import type {
	GenerateMultiPassInput,
	GenerateMultiPassResult,
	SectionResult,
} from './types.js';

const log = getLogger('content-gen');

export type {
	SectionPlan,
	OutlineResult,
	SectionResult,
	SectionBuildArgs,
	GenerateMultiPassInput,
	GenerateMultiPassResult,
} from './types.js';
export {
	generateOutline,
	type GenerateOutlineInput,
	type GenerateOutlineResult,
} from './outline.js';
export { runSections, DEFAULT_SECTION_BUDGET_TOKENS } from './section.js';
export { stitch } from './stitch.js';
export { OUTLINE_SCHEMA } from './schema.js';

/**
 * Run the full two-pass content generation: outline -> per-section
 * bodies -> stitched markdown. Per the plan, returns even on
 * degradation -- caller inspects `result.degraded` to decide
 * whether to warn the user.
 *
 * Throws AbortError if `input.signal` fires before the first
 * provider call returns. Once at least one section starts, abort
 * is honoured at section boundaries (the in-flight provider call
 * runs to completion before the loop exits).
 */
export async function generateMultiPass(
	input: GenerateMultiPassInput,
	provider: LLMProvider,
): Promise<GenerateMultiPassResult> {
	if (input.signal?.aborted) {
		throw new Error('generateMultiPass: aborted before pass 1');
	}

	// ----- Pass 1: outline ---------------------------------------------------
	const outlineInput: Parameters<typeof generateOutline>[0] = {
		system: input.outline.system,
		user:   input.outline.user,
	};
	if (input.outline.maxSections !== undefined) {
		(outlineInput as { maxSections: number }).maxSections = input.outline.maxSections;
	}
	if (input.outline.maxTokens !== undefined) {
		(outlineInput as { maxTokens: number }).maxTokens = input.outline.maxTokens;
	}
	const outlineRes = await generateOutline(outlineInput, provider);
	let outlineDegraded = outlineRes.degraded;
	if (outlineDegraded) {
		log.warn({ note: outlineRes.note }, 'multipass: outline degraded; proceeding with fallback outline');
	}

	if (input.signal?.aborted) {
		throw new Error('generateMultiPass: aborted between outline and sections');
	}

	// ----- Pass 2: sections --------------------------------------------------
	const defaultBudgetTokens = input.section.defaultBudgetTokens ?? DEFAULT_SECTION_BUDGET_TOKENS;
	const parallel = input.parallel ?? true;
	const sectionResults: SectionResult[] = await runSections(
		{
			outline: outlineRes.outline,
			build: input.section.build,
			defaultBudgetTokens,
			parallel,
			...(input.signal !== undefined ? { signal: input.signal } : {}),
			...(input.onSectionComplete !== undefined ? { onSectionComplete: input.onSectionComplete } : {}),
		},
		provider,
	);

	// ----- Stitch ------------------------------------------------------------
	const markdown = stitch(outlineRes.outline, sectionResults);
	const sectionDegraded = sectionResults.some(r => r.fallback);
	const degraded = outlineDegraded || sectionDegraded;
	if (degraded) {
		log.info(
			{ outlineDegraded, sectionDegraded, count: sectionResults.length },
			'multipass: degraded result',
		);
	}

	return {
		outline: outlineRes.outline,
		sections: sectionResults,
		markdown,
		degraded,
	};
}
