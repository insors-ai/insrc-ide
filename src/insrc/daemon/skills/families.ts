/**
 * The complete enumeration of skill families. Lives separately from
 * types.ts so the registry's runtime check (registry.ts step 2) and
 * the tool config's default-enabled list (config.ts) read from the
 * same source of truth. Mirrors the `code` / `data` enabledCategories
 * oversight from 2026-04-30 -- if these two callers ever drift, the
 * default-enabled families won't include a skill family that the
 * registry knows about, and lookups silently fail.
 */

import type { SkillFamily } from './types.js';

export const ALL_SKILL_FAMILIES: readonly SkillFamily[] = [
  'source-introspection',
  'source-sampling',
  'comparison-diff',
  'code-binding',
  'lineage',
  'quality-profile',
  'distribution',
  'dependency',
  'sensitivity',
  'drift',
  'timeseries',
  'synthesis',
  'meta',
] as const;
