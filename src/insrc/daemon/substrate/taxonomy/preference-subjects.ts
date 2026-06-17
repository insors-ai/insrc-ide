/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Closed-enum taxonomy of subjects the user-assertion classifier routes preferences into
 * (G3 of design/memory-context.html). The LLM is JSON-schema-constrained to emit one of
 * these values; owners declare `assertionInterests` referencing these strings; the
 * `AssertionIndex` performs exact-match routing.
 *
 * Adding a new subject is a code change here + a re-registration of owners that want the
 * new subject in their interests. Deliberately NOT config-extensible -- free-form subject
 * space would force fuzzy routing, trading determinism for flexibility (the wrong tradeoff
 * under accuracy-first per CLAUDE.md / AGENTS.md).
 *
 * 12 starting categories. Sub-categorization happens via scope axes (G4 `categories`,
 * `repoPaths` on the entry value), not via hierarchical subject strings.
 */

export type PreferenceSubject =
	| 'code-style'             // naming, formatting, structural conventions
	| 'test-policy'            // coverage, test types, fixtures, mocking
	| 'documentation-policy'   // docstrings, comments, design docs, READMEs
	| 'commit-policy'          // granularity, messages, signing, branches
	| 'dependency-policy'      // libraries, versions, vendoring
	| 'architecture-policy'    // patterns, layering, dep direction
	| 'tooling-policy'         // build, linter / formatter, CI choices
	| 'security-policy'        // auth, secrets, validation, audit
	| 'data-policy'            // schema, migrations, retention
	| 'workflow-policy'        // PR review, deployment, hotfix procedure
	| 'communication-policy'   // chat tone, verbosity, format
	| 'escalation-policy';     // when to ask user vs proceed

/** Runtime-accessible list of all valid subjects (drives JSON schema constraint + validation). */
export const PREFERENCE_SUBJECTS: readonly PreferenceSubject[] = [
	'code-style',
	'test-policy',
	'documentation-policy',
	'commit-policy',
	'dependency-policy',
	'architecture-policy',
	'tooling-policy',
	'security-policy',
	'data-policy',
	'workflow-policy',
	'communication-policy',
	'escalation-policy',
] as const;

/**
 * Short human-readable description per subject. Used by:
 *   - the JSON schema constraint sent to the LLM (helps it pick the right category)
 *   - the `/prefs` UX (`design/preference-taxonomy.html` follow-up doc renders these)
 */
export const PREFERENCE_SUBJECT_DESCRIPTIONS: Readonly<Record<PreferenceSubject, string>> = {
	'code-style':           'Naming, formatting, structural conventions.',
	'test-policy':          'Test coverage, test types, fixtures, mocking rules.',
	'documentation-policy': 'Docstrings, comments, design docs, READMEs.',
	'commit-policy':        'Commit granularity, messages, signing, branches.',
	'dependency-policy':    'Which libraries / versions to prefer or avoid; vendoring rules.',
	'architecture-policy':  'Patterns, layering, dependency direction.',
	'tooling-policy':       'Build system, linter / formatter, CI tool choices.',
	'security-policy':      'Authentication, secrets handling, input validation, audit logging.',
	'data-policy':          'Schema design, migrations, data retention.',
	'workflow-policy':      'PR review, deployment cadence, hotfix procedure.',
	'communication-policy': 'Chat tone, verbosity, output format preferences.',
	'escalation-policy':    'When to ask the user vs proceed autonomously.',
};

/** Type predicate: narrows an arbitrary string to `PreferenceSubject` when valid. */
export function isPreferenceSubject(value: string): value is PreferenceSubject {
	return (PREFERENCE_SUBJECTS as readonly string[]).includes(value);
}

/**
 * Per G7, the relationship of a new assertion to an existing same-subject same-owner entry.
 * Layer 2 LLM emits one of these in its structured output; the substrate runtime routes:
 *
 *   - 'independent'    -> new entry, normal flow
 *   - 'exact'          -> refresh existing (writtenAt + confidence saturating), append
 *                         re-assertion timestamp to history. No new entry.
 *   - 'refinement'     -> new entry with supersedes:[existingRef]; old confidence decays
 *                         by `refinementDecay`.
 *   - 'weakening'      -> same shape; decay by `weakeningDecay`.
 *   - 'contradiction'  -> same shape; decay by `contradictionDecay`.
 */
export type AssertionRelationship =
	| { readonly kind: 'independent' }
	| { readonly kind: 'exact';         readonly existingRef: string }
	| { readonly kind: 'refinement';    readonly existingRef: string }
	| { readonly kind: 'weakening';     readonly existingRef: string }
	| { readonly kind: 'contradiction'; readonly existingRef: string };

/** Set of relationship kinds that produce a *new* entry (vs in-place refresh). */
export const RELATIONSHIPS_THAT_SUPERSEDE: ReadonlySet<AssertionRelationship['kind']> = new Set([
	'refinement',
	'weakening',
	'contradiction',
]);
