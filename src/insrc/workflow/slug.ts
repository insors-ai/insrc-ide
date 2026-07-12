/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Slug derivation for workflow artifacts. Turns a natural-language
 * focus into a filesystem-safe identifier used for
 * `docs/defines/<slug>.md`, `docs/designs/<slug>/`, and the
 * `epic:<slug>` GitHub label.
 *
 * ## Approach
 *
 * 1. Lowercase.
 * 2. Strip a small set of high-frequency stopwords (the / a / and /
 *    for / of / to / in / on / with / as / at) — recall the analyze
 *    doc-mention exploration uses a similar tail; keep this list
 *    short so distinctive terms survive.
 * 3. Tokenise on any non-alphanumeric run.
 * 4. Keep the first `MAX_TOKENS` distinctive words.
 * 5. Join with `-`.
 * 6. Truncate to `MAX_LENGTH` chars.
 *
 * Collisions with existing on-disk slugs are detected by the
 * caller (via `checkCollision`), not by the derivation itself —
 * derivation is pure so tests are deterministic.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_TOKENS = 6;
const MAX_LENGTH = 60;
const MIN_LENGTH = 3;

const STOPWORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else',
	'for', 'of', 'to', 'in', 'on', 'at', 'by', 'with', 'as',
	'is', 'are', 'be', 'been', 'was', 'were',
	'that', 'this', 'these', 'those',
	'we', 'i', 'you', 'they', 'it',
]);

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Pure derivation. Throws if the focus yields a slug shorter than
 *  `MIN_LENGTH` — usually means the focus was all-stopwords or all
 *  punctuation, and the caller should reprompt for a clearer ask. */
export function deriveSlug(focus: string): string {
	if (typeof focus !== 'string' || focus.length === 0) {
		throw new Error('deriveSlug: focus is empty');
	}
	const tokens = focus
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(t => t.length > 0)
		.filter(t => !STOPWORDS.has(t))
		.slice(0, MAX_TOKENS);
	const slug = tokens.join('-').slice(0, MAX_LENGTH);
	if (slug.length < MIN_LENGTH) {
		throw new Error(
			`deriveSlug: focus '${focus}' produced a slug too short ` +
			`(${slug.length} < ${MIN_LENGTH} chars). Rephrase with more distinctive nouns.`,
		);
	}
	return slug;
}

// ---------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------

/** Collision-check helpers. The caller decides how to resolve —
 *  prompt the user in CLI mode, or return an error in MCP mode. */
export interface CollisionCheckResult {
	readonly slug:      string;
	/** All paths (relative to `repoPath`) that would clash with
	 *  this slug. */
	readonly conflicts: readonly string[];
	/** A suggested variant that doesn't collide. Slug with a
	 *  numeric suffix (`-2`, `-3`, ...) if the base collides.
	 *  Same as `slug` when there are no conflicts. */
	readonly suggested: string;
}

/** Check whether the derived slug clashes with any existing
 *  workflow artifact under the repo. Returns a suggested unique
 *  variant.
 *
 *  Paths checked:
 *    - `docs/defines/<slug>.md`
 *    - `docs/designs/<slug>/` (directory)
 *    - `plans/<slug>/` (directory)
 *
 *  If any exists, we probe `<slug>-2`, `<slug>-3`, ... until we
 *  find a free one.
 */
export function checkCollision(
	repoPath: string,
	slug:     string,
): CollisionCheckResult {
	const conflicts: string[] = [];
	for (const p of pathsForSlug(slug)) {
		if (existsSync(join(repoPath, p))) conflicts.push(p);
	}
	if (conflicts.length === 0) {
		return { slug, conflicts: [], suggested: slug };
	}
	let n = 2;
	// Cap the search so a pathological caller can't spin here forever.
	while (n < 1_000) {
		const candidate = `${slug}-${n}`;
		const hits: string[] = [];
		for (const p of pathsForSlug(candidate)) {
			if (existsSync(join(repoPath, p))) hits.push(p);
		}
		if (hits.length === 0) {
			return { slug, conflicts, suggested: candidate };
		}
		n += 1;
	}
	throw new Error(
		`checkCollision: could not find a free slug variant for '${slug}' ` +
		`under ${repoPath} (probed up to -1000).`,
	);
}

function pathsForSlug(slug: string): readonly string[] {
	return [
		`docs/defines/${slug}.md`,
		`docs/designs/${slug}`,
		`plans/${slug}`,
	];
}
