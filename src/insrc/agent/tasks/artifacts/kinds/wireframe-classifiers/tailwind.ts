/**
 * Tailwind utility-class extractor.
 *
 * Tailwind is special among the supported libraries: it doesn't
 * bring its own JSX tags. Instead it adds layout signal via
 * `className` utility tokens. The walker calls `extractTailwindLayout`
 * on a JSX tag's className prop string; a non-null result signals
 * "this tag is a layout container by way of its utility classes",
 * with the inferred direction + (optional) column count.
 */

import type { TailwindLayoutHint } from './types.js';

const FLEX_ROW_TOKENS = new Set([
	'flex',
	'inline-flex',
	'flex-row',
	'flex-row-reverse',
]);

const FLEX_COL_TOKENS = new Set([
	'flex-col',
	'flex-col-reverse',
]);

const GRID_TOKEN = 'grid';

// `grid-cols-N` with N up to 12 (Tailwind's stock scale).
const GRID_COLS_RE = /^grid-cols-(\d+)$/;

/**
 * Inspect a className string for layout-shaping utility tokens.
 * Returns `null` when no layout signal is present (the tag is not
 * a Tailwind layout container).
 *
 * Precedence:
 *   1. `grid` token + optional `grid-cols-N` -> direction='grid'
 *   2. `flex-col` / `flex-col-reverse` -> direction='column'
 *   3. `flex` / `flex-row` / `inline-flex` -> direction='row'
 *
 * Tokens that don't shape layout (colours, spacing, typography,
 * borders, hover states, responsive prefixes) are ignored.
 */
export function extractTailwindLayout(className: string | undefined): TailwindLayoutHint | null {
	if (className === undefined || className.trim() === '') { return null; }
	const tokens = className.split(/\s+/).filter(t => t !== '');

	let isGrid = false;
	let cols: number | undefined;
	let isFlexCol = false;
	let isFlex = false;

	for (const raw of tokens) {
		// Strip Tailwind responsive / state prefixes ("md:", "hover:", etc.).
		const t = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;

		if (t === GRID_TOKEN) { isGrid = true; continue; }
		const gridMatch = GRID_COLS_RE.exec(t);
		if (gridMatch !== null) {
			isGrid = true;
			const n = Number(gridMatch[1]);
			if (Number.isFinite(n) && n > 0 && n <= 24) { cols = n; }
			continue;
		}
		if (FLEX_COL_TOKENS.has(t)) { isFlexCol = true; isFlex = true; continue; }
		if (FLEX_ROW_TOKENS.has(t)) { isFlex = true; continue; }
	}

	if (isGrid) {
		return cols !== undefined ? { direction: 'grid', cols } : { direction: 'grid' };
	}
	if (isFlexCol) { return { direction: 'column' }; }
	if (isFlex) { return { direction: 'row' }; }
	return null;
}
