/**
 * Skill registry.
 *
 * One place to register, look up, and list skills. Mirrors the tool
 * registry in `daemon/tools/registry.ts` -- same lookup-time settings
 * gate pattern (so IDE-pushed `enabledSkillFamilies` changes take
 * effect without daemon restart) and same `_resetRegistryForTests`
 * escape hatch.
 *
 * Registration is strict: id format violations, sub-skill cycle
 * detection, missing sub-skill deps, and cross-owner-dep violations
 * all throw at registration time. These are programmer errors; the
 * daemon should fail to start on a misregistered skill rather than
 * silently swallow the misconfiguration. Mirrors the `data` /
 * `code` enabledCategories oversight from 2026-04-30 -- catch the
 * mistake at build, not at runtime when the LLM has already
 * fabricated an answer around the missing tool.
 */

import { getLogger } from '../../shared/logger.js';
import { getToolSettings } from '../tools/config.js';
import { ALL_SKILL_FAMILIES } from './families.js';
import type { Skill, SkillFamily, SkillOwner } from './types.js';

const log = getLogger('skills-registry');

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** id -> highest registered version. */
const byId = new Map<string, Skill>();
/** "id@v" -> Skill. Allows version-pinned lookup. */
const byIdAndVersion = new Map<string, Skill>();
/** family -> list of latest-version skills. Rebuilt on each register. */
const byFamily = new Map<SkillFamily, Skill[]>();
/** owner -> list of latest-version skills. Rebuilt on each register. */
const byOwner = new Map<SkillOwner, Skill[]>();

// ---------------------------------------------------------------------------
// Naming validator
// ---------------------------------------------------------------------------

/**
 * Skill id grammar:
 *   - 2-4 dot-separated segments
 *   - each segment: lowercase ASCII letter, then [a-z0-9-]*
 *   - segments cannot start with a hyphen
 *   - total length <= 64
 *
 * Examples (valid):
 *   data.profile.numeric
 *   code.class.extract-fields
 *   data.lineage.read-write-callsites
 *   data.meta.classify-question
 *
 * Examples (invalid -- caught here):
 *   data_profile_numeric           (underscores reserved for tool ids)
 *   data:profile:numeric           (colons retired 2026-04-30)
 *   Data.Profile.Numeric           (uppercase)
 *   data..numeric                  (empty segment)
 *   data.profile.numeric.float64.gauss   (5 segments; clarity > depth)
 */
const SKILL_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/;

export function isValidSkillId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && SKILL_ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSkill(skill: Skill): void {
  // 1. Id format.
  if (!isValidSkillId(skill.id)) {
    throw new Error(`registerSkill: invalid id '${skill.id}' (must match dotted-lowercase grammar)`);
  }

  // 2. Family enum membership. The runtime enum is enforced at the type
  // level, but we double-check because `JSON.parse(...)` -driven
  // registrations from future external sources would bypass the type.
  if (!ALL_SKILL_FAMILIES.includes(skill.family)) {
    throw new Error(`registerSkill: ${skill.id} declares unknown family '${skill.family}'`);
  }

  // 3. Version sanity.
  if (!Number.isInteger(skill.version) || skill.version < 1) {
    throw new Error(`registerSkill: ${skill.id} has invalid version ${skill.version}`);
  }

  // 4. Sub-skill deps must already be registered (forces topological
  //    registration order; surfaces typos).
  for (const depId of skill.skillDeps ?? []) {
    if (!byId.has(depId)) {
      throw new Error(
        `registerSkill: ${skill.id} declares skillDep '${depId}' which is not registered yet ` +
        `(register dependencies before composites)`,
      );
    }
  }

  // 5. Cross-owner discipline. A skill that calls a sub-skill owned by
  //    a different analyzer must opt in via the cross-owner-allowed
  //    precondition. Skills calling `shared` sub-skills are exempt.
  const hasCrossOwnerMarker = (skill.preconditions ?? []).some(p => p.kind === 'cross-owner-allowed');
  for (const depId of skill.skillDeps ?? []) {
    const dep = byId.get(depId)!;   // checked in step 4
    if (dep.owner !== skill.owner && dep.owner !== 'shared' && !hasCrossOwnerMarker) {
      throw new Error(
        `registerSkill: ${skill.id} (owner=${skill.owner}) calls cross-owner skill ` +
        `'${depId}' (owner=${dep.owner}) but lacks cross-owner-allowed precondition`,
      );
    }
  }

  // 6. Cycle detection.
  if (createsCycle(skill.id, skill.skillDeps ?? [])) {
    throw new Error(`registerSkill: ${skill.id} would create a sub-skill cycle`);
  }

  // 7. Inputs / outputs schemas must at least have a top-level `type`.
  const inputType = skill.inputs['type'];
  if (typeof inputType !== 'string' && !Array.isArray(inputType)) {
    throw new Error(`registerSkill: ${skill.id} input schema lacks a 'type' keyword`);
  }
  const outputType = skill.outputs['type'];
  if (typeof outputType !== 'string' && !Array.isArray(outputType)) {
    throw new Error(`registerSkill: ${skill.id} output schema lacks a 'type' keyword`);
  }

  // 8. Commit. byIdAndVersion is the authoritative store; byId tracks
  //    latest-version pointers; family / owner indices are derived.
  const versionedKey = `${skill.id}@${skill.version}`;
  if (byIdAndVersion.has(versionedKey)) {
    log.warn({ id: skill.id, version: skill.version }, 'overwriting skill registration');
  }
  byIdAndVersion.set(versionedKey, skill);

  const existing = byId.get(skill.id);
  if (existing === undefined || existing.version < skill.version) {
    byId.set(skill.id, skill);
    rebuildIndices();
  }

  log.info(
    {
      id: skill.id,
      version: skill.version,
      family: skill.family,
      owner: skill.owner,
      toolDeps: skill.toolDeps.length,
      skillDeps: skill.skillDeps?.length ?? 0,
    },
    'skill registered',
  );
}

function createsCycle(newSkillId: string, deps: readonly string[]): boolean {
  // DFS over the existing dependency graph; if any descendant of `deps`
  // resolves back to `newSkillId`, registering would close a cycle.
  const stack: string[] = [...deps];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === newSkillId) { return true; }
    if (visited.has(cur)) { continue; }
    visited.add(cur);
    const skill = byId.get(cur);
    if (skill?.skillDeps !== undefined) {
      for (const d of skill.skillDeps) { stack.push(d); }
    }
  }
  return false;
}

function rebuildIndices(): void {
  byFamily.clear();
  byOwner.clear();
  for (const skill of byId.values()) {
    const fam = byFamily.get(skill.family) ?? [];
    fam.push(skill);
    byFamily.set(skill.family, fam);

    const own = byOwner.get(skill.owner) ?? [];
    own.push(skill);
    byOwner.set(skill.owner, own);
  }
}

// ---------------------------------------------------------------------------
// Lookup (settings-gated)
// ---------------------------------------------------------------------------

/**
 * Resolve a skill id (optionally version-pinned). Honors the
 * settings-time family gate -- a skill in a disabled family looks
 * unregistered. This is the same pattern the tool registry uses so an
 * IDE settings push immediately cuts off skills without restarting
 * the daemon.
 *
 * Distinct from the cross-agent-tool oversight from 2026-04-30: the
 * default-enabled family list (config.ts `enabledSkillFamilies`)
 * ships with EVERY family in `ALL_SKILL_FAMILIES`. CI gate enforces
 * the two stay in sync.
 */
export function getSkill(id: string, version?: number): Skill | undefined {
  const skill = version !== undefined
    ? byIdAndVersion.get(`${id}@${version}`)
    : byId.get(id);
  if (skill === undefined) { return undefined; }
  if (!isFamilyEnabled(skill.family)) { return undefined; }
  return skill;
}

/** Bypasses the settings gate. Used by registration-time integrity checks. */
export function getSkillUnchecked(id: string, version?: number): Skill | undefined {
  return version !== undefined
    ? byIdAndVersion.get(`${id}@${version}`)
    : byId.get(id);
}

export function listSkillsByFamily(family: SkillFamily): Skill[] {
  if (!isFamilyEnabled(family)) { return []; }
  return [...(byFamily.get(family) ?? [])];
}

export function listSkillsByOwner(owner: SkillOwner): Skill[] {
  return (byOwner.get(owner) ?? []).filter(s => isFamilyEnabled(s.family));
}

export function listSkills(): Skill[] {
  return [...byId.values()].filter(s => isFamilyEnabled(s.family));
}

function isFamilyEnabled(family: SkillFamily): boolean {
  const enabled = getToolSettings().enabledSkillFamilies;
  // When the settings haven't been pushed yet, the field is undefined;
  // default to enabled-for-all. The settings setter writes the
  // ALL_SKILL_FAMILIES default at startup so this branch is the
  // pre-startup fallback.
  if (enabled === undefined || enabled.length === 0) { return true; }
  return enabled.includes(family);
}

// ---------------------------------------------------------------------------
// Test reset
// ---------------------------------------------------------------------------

export function _resetSkillRegistryForTests(): void {
  byId.clear();
  byIdAndVersion.clear();
  byFamily.clear();
  byOwner.clear();
}
