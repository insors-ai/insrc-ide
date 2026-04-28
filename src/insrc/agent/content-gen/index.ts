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
 * Commit 1 (THIS commit) -- outline pass + types + module surface.
 * Commit 2              -- section pass, parallel scheduler, stitch,
 *                          and the full `generateMultiPass()` entry.
 * Commit 3              -- optional section-level caching layer.
 *
 * No agent consumes the module yet. Code-analyzer Phase 5.C is the
 * first migrator and lands AFTER commit 2; it currently uses the
 * legacy single-pass synthesise (which is fine for S/M tiers and
 * remains the default at lower tiers per the plan).
 */

export type { SectionPlan, OutlineResult } from './types.js';
export {
	generateOutline,
	type GenerateOutlineInput,
	type GenerateOutlineResult,
} from './outline.js';
export { OUTLINE_SCHEMA } from './schema.js';
