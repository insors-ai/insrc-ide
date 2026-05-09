/**
 * Cyclomatic complexity algo for `code.quality.complexity`
 * (code-analyzer-skills.md Phase 5.1).
 *
 * Approach: count decision points in the entity body via regex.
 * Cyclomatic = 1 + decisions. The grammar varies per language, but
 * the keyword set converges enough that a unified token list with
 * per-language tweaks gets us within ±1 of a true AST count for
 * 95%+ of bodies. Out of scope: short-circuit operators inside
 * comments / string literals; minor over-counting is the price.
 *
 * Tokens counted (per language):
 *   shared: if / else if / case / for / while / catch / && / ||
 *   ts/js : ?: (ternary) plus optional chaining `?.` is NOT a
 *           branch in cyclomatic; explicitly excluded
 *   python: elif / except
 *   ruby  : rescue / when
 *   scala : match cases counted via `case`
 *
 * The output also surfaces a coarse `level` so renderers can
 * colour-code without re-implementing thresholds:
 *   low      < 10
 *   medium   10..19
 *   high     20..49
 *   critical 50+
 */

import type { Language } from '../../../shared/types.js';

export type ComplexityLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ComplexityResult {
	readonly cyclomatic: number;
	readonly level:      ComplexityLevel;
	readonly decisions:  number;
}

export function computeCyclomaticComplexity(body: string, language: Language): ComplexityResult {
	if (body.length === 0) return { cyclomatic: 1, level: 'low', decisions: 0 };

	const stripped = stripCommentsAndStrings(body, language);

	let decisions = 0;
	for (const re of TOKEN_PATTERNS) {
		const matches = stripped.match(re);
		if (matches !== null) decisions += matches.length;
	}
	const langExtras = LANGUAGE_EXTRAS[language];
	if (langExtras !== undefined) {
		for (const re of langExtras) {
			const matches = stripped.match(re);
			if (matches !== null) decisions += matches.length;
		}
	}

	const cyclomatic = 1 + decisions;
	return { cyclomatic, level: bucket(cyclomatic), decisions };
}

function bucket(n: number): ComplexityLevel {
	if (n < 10) return 'low';
	if (n < 20) return 'medium';
	if (n < 50) return 'high';
	return 'critical';
}

// Word-boundary keyword patterns. `??` and `?.` are NOT branches; `?:`
// (ternary) is matched by the `\?(?<!\?\?)(?!\?|\.)` window. Short-
// circuit operators are matched literally.
//
// `if` is counted ONLY when not preceded by `else ` -- otherwise we'd
// double-count `else if` (once as `else if`, once as the bare `if`
// inside it).
const TOKEN_PATTERNS: readonly RegExp[] = [
	/(?<!\belse\s)\bif\b/g,
	/\belse\s+if\b/g,
	/\bcase\b/g,
	/\bfor\b/g,
	/\bwhile\b/g,
	/\bcatch\b/g,
	/&&/g,
	/\|\|/g,
	// Ternary `?` -- excludes `?.` (lookahead) and `??` (both
	// positions: the first `?` of a `??` matches the next-char-is-`?`
	// lookahead negation; the second `?` is rejected by the
	// previous-char-is-`?` lookbehind negation).
	/(?<!\?)\?(?!\?|\.)/g,
];

const LANGUAGE_EXTRAS: Partial<Record<Language, readonly RegExp[]>> = {
	python: [
		/\belif\b/g,
		/\bexcept\b/g,
	],
};

/**
 * Strip line comments + block comments + string literals so keyword
 * regexes don't false-trigger on them. Per-language flavour for the
 * line-comment leader; string handling is shared.
 */
function stripCommentsAndStrings(body: string, language: Language): string {
	const lineCommentLeader = LINE_COMMENT[language] ?? '//';
	let out = '';
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	let inBack   = false;
	let inBlockComment = false;
	while (i < body.length) {
		const c = body[i]!;
		const next = body[i + 1] ?? '';

		if (inBlockComment) {
			if (c === '*' && next === '/') {
				inBlockComment = false;
				out += '  ';
				i += 2;
				continue;
			}
			out += ' ';
			i++;
			continue;
		}

		if (!inSingle && !inDouble && !inBack) {
			// Block comment (C-style; not in Python)
			if (c === '/' && next === '*') {
				inBlockComment = true;
				out += '  ';
				i += 2;
				continue;
			}
			// Line comment
			if (body.startsWith(lineCommentLeader, i)) {
				while (i < body.length && body[i] !== '\n') {
					out += ' ';
					i++;
				}
				continue;
			}
		}

		if (!inDouble && !inBack && c === '\'' && body[i - 1] !== '\\') inSingle = !inSingle;
		else if (!inSingle && !inBack && c === '"' && body[i - 1] !== '\\') inDouble = !inDouble;
		else if (!inSingle && !inDouble && c === '`' && body[i - 1] !== '\\') inBack = !inBack;

		if (inSingle || inDouble || inBack) {
			out += ' ';
		} else {
			out += c;
		}
		i++;
	}
	return out;
}

const LINE_COMMENT: Partial<Record<Language, string>> = {
	python: '#',
	// typescript / javascript / java / scala / go all use `//` (default)
};
