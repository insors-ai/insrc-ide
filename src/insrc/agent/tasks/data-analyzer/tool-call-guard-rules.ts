/**
 * Per-skill arg-rename rules for the data-analyzer pre-dispatch
 * tool-call guard (Phase B of plans/analyzers/data-analyzer-parity.md).
 *
 * The data side starts with an **empty** rename map -- there is no
 * production observation history to draw from yet. Entries get
 * added empirically when a recurring pattern shows up in live
 * `data-analyzer:tool-call-guard: pre-dispatch schema check rejected`
 * log lines, same as the code side did.
 *
 * ## Selection criteria
 *
 * A rename earns an entry when:
 *   1. It has been observed >= 3 times in production logs, AND
 *   2. The rename is semantically unambiguous (i.e. the wrong name
 *      has no plausible other meaning that we'd be hiding by silently
 *      rewriting).
 *
 * Caveat for the data side: the 108-skill registry has many
 * overlapping arg names (`column` on profile skills vs `field` on
 * validation skills). A rename rule that's right for one skill could
 * silently corrupt input to another. ALWAYS check the skill's full
 * input schema before adding a rule -- if the "wrong" name is also a
 * valid arg on a related skill, the rule belongs only on the skill
 * id where it's unambiguous, never as a global remap.
 *
 * ## What's NOT here
 *
 * - Missing-required-arg patterns. The session-default injection
 *   path (Stage 3.5) handles `connectionId` + `schema` + `database`
 *   without needing per-skill renames. Other missing args are a
 *   Phase-D corrective concern, not Stage-2 rename concern.
 * - Cross-skill remaps that depend on value content. Each skill's
 *   entry stands alone; cross-skill disambiguation isn't a rename
 *   concern.
 */

/**
 * Map from skill id to a wrong-arg -> right-arg dictionary.
 * Renames are applied silently before dispatch. **Starts empty;**
 * populated from live failures.
 */
export const DATA_SKILL_ARG_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({});

/**
 * Look up renames for one data skill. Returns an empty object when
 * the skill has no registered rename rules -- caller treats that as
 * a no-op.
 */
export function getDataSkillArgRenames(skillId: string): Readonly<Record<string, string>> {
	return DATA_SKILL_ARG_RENAMES[skillId] ?? {};
}
