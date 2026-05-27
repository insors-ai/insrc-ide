/**
 * Per-skill arg-rename rules for the pre-dispatch tool-call guard
 * (`tool-call-guard.ts` Stage 2).
 *
 * Each entry maps a recurring wrong arg name to the skill's actual
 * arg name, derived from real `runSkill: invalid-input` failures
 * observed in production logs. The pipeline applies the rename
 * silently before dispatch, saving the round-trip the model would
 * otherwise pay re-emitting the call after seeing the skill
 * runner's error.
 *
 * ## Maintenance
 *
 * This is **data**, not code. New patterns get added as one-line
 * entries when production logs show a recurring failure. The cost
 * per entry is one unit test pinning the rename; nothing else needs
 * to change.
 *
 * ## Selection criteria
 *
 * A pattern earns an entry when:
 *   1. It's been observed ≥3 times in production logs (one-off
 *      hallucinations don't deserve maintenance), AND
 *   2. The rename is semantically unambiguous (i.e. the wrong name
 *      has no plausible other meaning that we'd be hiding by
 *      silently rewriting).
 *
 * If criterion 2 is in doubt, the rename does NOT go here — Stage
 * 4's pre-dispatch schema check will produce a targeted corrective
 * prompt instead, letting the model re-emit with the right name.
 *
 * ## What's NOT here
 *
 * - Missing-required-arg patterns. The dominant log failure
 *   ("missing required property 'entityId'") is a Stage-4
 *   concern, not Stage 2 — the model didn't pass the arg under
 *   any name, so there's nothing to rename.
 * - Renames that depend on the value's content (e.g. coercing
 *   `path: '...'` to `file: '...'` for one skill and to
 *   `modulePath: '...'` for another). Each skill's entry stands
 *   alone; cross-skill disambiguation isn't a rename concern.
 */

/**
 * Map from skill id to a wrong-arg → right-arg dictionary.
 * Renames are applied silently before dispatch.
 */
export const SKILL_ARG_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
	// ---- Entity skills: all take `entityId` (32-char hex). Common
	// short / snake_case variants the model picks instead.
	'code.entity.summary':            Object.freeze({
		id:           'entityId',
		entity_id:    'entityId',
		entity:       'entityId',
	}),
	'code.entity.callers':            Object.freeze({
		id:           'entityId',
		entity_id:    'entityId',
		entity:       'entityId',
	}),
	'code.entity.callees':            Object.freeze({
		id:           'entityId',
		entity_id:    'entityId',
		entity:       'entityId',
	}),

	// ---- Source-file skill: takes `file` (absolute path). The plan
	// docs called out `path` as the dominant wrong-name; logs show
	// "unexpected property 'path'" alongside "missing required property
	// 'file'" -- direct empirical confirmation.
	'code.source.file.describe':      Object.freeze({
		path:         'file',
		file_path:    'file',
		filePath:     'file',
		repo_path:    'repoPath',
	}),

	// ---- Source-module skill: takes `modulePath` + `repoPath`.
	'code.source.module.describe':    Object.freeze({
		path:         'modulePath',
		module_path:  'modulePath',
		module:       'modulePath',
		dir:          'modulePath',
		repo_path:    'repoPath',
	}),

	// ---- Source-repo skill: takes `repoPath`.
	'code.source.repo.describe':      Object.freeze({
		path:         'repoPath',
		repo_path:    'repoPath',
		repo:         'repoPath',
	}),

	// ---- Class skills: take `className`. Drop the underscore form;
	// model also picks `class_name`, `name`, `clazz`.
	'code.class.extract-fields':      Object.freeze({
		class_name:   'className',
		clazz:        'className',
		name:         'className',      // Haiku live repro 2026-05-26: bleeds locate-by-name arg shape
		repo_path:    'repoPath',
	}),
	'code.class.locate-references':   Object.freeze({
		class_name:   'className',
		clazz:        'className',
		name:         'className',      // Haiku live repro 2026-05-26: bleeds locate-by-name arg shape
		repo_path:    'repoPath',
	}),

	// ---- Locate-by-name: takes `name` + optional `kinds` array.
	// `kinds` scalar→array is handled by the Stage-3 type-coercer,
	// not here. Rename targets are short / snake variants of the
	// other args.
	'code.entity.locate-by-name':     Object.freeze({
		entity_name:  'name',
		names:        'name',            // Haiku pluralisation (live repro 2026-05-26)
		query:        'name',            // Haiku conflates with search verbs
		identifier:   'name',
		repo_path:    'repoPath',
		kind:         'kinds',           // scalar `kind` -> array `kinds` (Stage 3 then wraps it)
	}),

	// ---- Vector search: takes `query` + closure args.
	'code.entity.search-by-vector':   Object.freeze({
		q:            'query',
		text:         'query',
		repo_path:    'repoPath',
	}),

	// ---- Source grep: takes `path` (absolute file or directory) +
	// `pattern`. The LLM has tried half a dozen path-y aliases across
	// live runs; collapse them all here.
	'code.source.grep':               Object.freeze({
		file:         'path',
		filePath:     'path',
		file_path:    'path',
		filePattern:  'path',           // Haiku live repro 2026-05-26
		files:        'path',
		paths:        'path',
		directory:    'path',
		dir:          'path',
		repo:         'path',
		repoPath:     'path',
		repo_path:    'path',
		query:        'pattern',
		search:       'pattern',
		regex:        'pattern',
	}),

});

/**
 * Look up renames for one skill. Returns an empty object when
 * the skill has no registered rename rules — caller treats that
 * as a no-op.
 */
export function getArgRenames(skillId: string): Readonly<Record<string, string>> {
	return SKILL_ARG_RENAMES[skillId] ?? {};
}

/**
 * Apply per-skill arg renames to a tool-call's input. Returns
 * the rewritten input + a list of human-readable notes describing
 * each rename. When no renames apply, returns the input unchanged
 * with an empty notes array.
 *
 * Conflict resolution: if the input already contains the target
 * arg, the rename is SKIPPED (we won't overwrite a value the
 * model explicitly set). A note records the skip so it's
 * traceable.
 */
export function applyArgRenames(
	input:    Record<string, unknown>,
	renames:  Readonly<Record<string, string>>,
): { readonly input: Record<string, unknown>; readonly notes: readonly string[] } {
	const renameKeys = Object.keys(renames);
	if (renameKeys.length === 0) {
		return { input, notes: [] };
	}

	const next: Record<string, unknown> = { ...input };
	const notes: string[] = [];

	for (const wrong of renameKeys) {
		if (!(wrong in next)) continue;
		const right = renames[wrong]!;

		if (right in next) {
			// Don't overwrite a value the model already set on the
			// right key. Note the conflict but leave both keys -- the
			// downstream schema check will reject 'wrong' as an
			// unexpected property and the model will see both names
			// in its corrective context.
			notes.push(`skipped rename '${wrong}' -> '${right}' (target already present)`);
			continue;
		}

		next[right] = next[wrong];
		delete next[wrong];
		notes.push(`renamed arg '${wrong}' -> '${right}'`);
	}

	return { input: next, notes };
}
