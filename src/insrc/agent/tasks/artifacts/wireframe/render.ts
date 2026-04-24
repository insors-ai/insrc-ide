/**
 * Wireframe SVG renderer.
 *
 * Deterministic, pure function: WireframeSpec -> SVG string. No
 * randomness, no dates in the output, no layout heuristics beyond the
 * row/cell model. The stage-2 LLM pass produces the spec; this
 * module turns it into the SVG that the binder substitutes into
 * `@@SOURCE@@` for the wireframe kind.
 *
 * The visual style is deliberately low-fidelity -- boxes + labels,
 * dashed separators, a mono-ish font. Users iterate via the
 * regenerate flow; the renderer itself makes no styling decisions
 * beyond consistent boxes.
 *
 * Canvas sizing is derived from the spec's layout:
 *   - desktop: 960 x sum(rowHeights)
 *   - tablet:  720 x sum(rowHeights)
 *   - mobile:  360 x sum(rowHeights)
 *
 * 'auto' rows get a default 80 px unless they contain children rows,
 * in which case they size to fit their children (plus nesting
 * padding).
 */

import type {
	WireframeCell,
	WireframeCellKind,
	WireframeLayout,
	WireframeRow,
	WireframeSpec,
} from '../../../../shared/artifacts.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const LAYOUT_WIDTH: Record<WireframeLayout, number> = {
	desktop: 960,
	tablet: 720,
	mobile: 360,
};

const AUTO_ROW_HEIGHT = 80;
const NESTED_PADDING = 8;
const CELL_PADDING = 6;
const STROKE = 1;

const FILL_FOR_KIND: Record<WireframeCellKind, string> = {
	header:      '#2a2d3a',
	nav:         '#1f2330',
	sidebar:     '#1f2330',
	footer:      '#2a2d3a',
	content:     '#12151e',
	placeholder: '#0f1117',
};

const STROKE_FOR_KIND: Record<WireframeCellKind, string> = {
	header:      '#4fc3f7',
	nav:         '#8b8fa8',
	sidebar:     '#8b8fa8',
	footer:      '#4fc3f7',
	content:     '#e2e4ed',
	placeholder: '#8b8fa8',
};

// ---------------------------------------------------------------------------
// XML escape (SVG text nodes)
// ---------------------------------------------------------------------------

const XML_ESCAPES: Readonly<Record<string, string>> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&apos;',
};
const XML_ESCAPE_RE = /[&<>"']/g;

function xml(s: string): string {
	return s.replace(XML_ESCAPE_RE, ch => XML_ESCAPES[ch] ?? ch);
}

// ---------------------------------------------------------------------------
// Sizing pass -- resolves 'auto' heights
// ---------------------------------------------------------------------------

interface SizedRow {
	readonly height: number;
	readonly cells: readonly SizedCell[];
}

interface SizedCell {
	readonly kind: WireframeCellKind;
	readonly label: string;
	readonly widthRatio: number;
	readonly children?: readonly SizedRow[] | undefined;
}

function defaultLabel(kind: WireframeCellKind): string {
	switch (kind) {
		case 'header':      return 'Header';
		case 'nav':         return 'Navigation';
		case 'content':     return 'Content';
		case 'sidebar':     return 'Sidebar';
		case 'footer':      return 'Footer';
		case 'placeholder': return '';
	}
}

function sizeCell(c: WireframeCell): SizedCell {
	const sized: SizedCell = {
		kind: c.kind,
		label: (c.label ?? defaultLabel(c.kind)).trim(),
		widthRatio: typeof c.widthRatio === 'number' && c.widthRatio > 0 ? c.widthRatio : 1,
		children: c.children?.map(sizeRow),
	};
	return sized;
}

function sizeRow(r: WireframeRow): SizedRow {
	const cells = r.cells.map(sizeCell);
	if (r.height === 'auto') {
		// Auto rows with nested children size to fit; otherwise use default.
		let maxChildHeight = 0;
		for (const cell of cells) {
			if (cell.children) {
				let h = NESTED_PADDING * 2;
				for (const nested of cell.children) { h += nested.height; }
				if (h > maxChildHeight) { maxChildHeight = h; }
			}
		}
		return { height: maxChildHeight > 0 ? maxChildHeight : AUTO_ROW_HEIGHT, cells };
	}
	return { height: r.height, cells };
}

// ---------------------------------------------------------------------------
// Rendering pass -- emits SVG text
// ---------------------------------------------------------------------------

interface RenderContext {
	readonly width: number;
	parts: string[];
}

function drawCell(
	ctx: RenderContext,
	cell: SizedCell,
	x: number,
	y: number,
	width: number,
	height: number,
): void {
	const fill = FILL_FOR_KIND[cell.kind];
	const stroke = STROKE_FOR_KIND[cell.kind];
	// Use a dashed border for placeholder so the user can tell the
	// renderer chose a generic box vs. a labelled region.
	const strokeDash = cell.kind === 'placeholder' ? ' stroke-dasharray="4 3"' : '';
	ctx.parts.push(
		`<rect x="${x + STROKE / 2}" y="${y + STROKE / 2}" width="${width - STROKE}" height="${height - STROKE}" ` +
			`fill="${fill}" stroke="${stroke}" stroke-width="${STROKE}"${strokeDash} />`,
	);

	if (cell.label !== '') {
		const tx = x + CELL_PADDING;
		const ty = y + CELL_PADDING + 10; // baseline for 11px text
		ctx.parts.push(
			`<text x="${tx}" y="${ty}" fill="${stroke}" font-family="monospace" font-size="11">` +
				`${xml(cell.label)}</text>`,
		);
	}

	if (cell.children) {
		const innerX = x + NESTED_PADDING;
		const innerY = y + NESTED_PADDING + (cell.label !== '' ? 14 : 0);
		const innerW = width - 2 * NESTED_PADDING;
		drawRows(ctx, cell.children, innerX, innerY, innerW);
	}
}

function drawRow(ctx: RenderContext, row: SizedRow, x: number, y: number, width: number): void {
	const totalRatio = row.cells.reduce((sum, c) => sum + c.widthRatio, 0) || 1;
	let cursorX = x;
	for (const cell of row.cells) {
		const cellWidth = (width * cell.widthRatio) / totalRatio;
		drawCell(ctx, cell, cursorX, y, cellWidth, row.height);
		cursorX += cellWidth;
	}
}

function drawRows(
	ctx: RenderContext,
	rows: readonly SizedRow[],
	x: number,
	y: number,
	width: number,
): void {
	let cursorY = y;
	for (const row of rows) {
		drawRow(ctx, row, x, cursorY, width);
		cursorY += row.height;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a WireframeSpec to an SVG string. Output is a stand-alone
 * `<svg>…</svg>` fragment with no surrounding HTML; the binder drops
 * it into the wireframe template's `@@SOURCE@@` slot verbatim.
 */
export function renderWireframe(spec: WireframeSpec): string {
	const width = LAYOUT_WIDTH[spec.layout];
	const sizedRows = spec.rows.map(sizeRow);
	const totalHeight = sizedRows.reduce((sum, r) => sum + r.height, 0) || AUTO_ROW_HEIGHT;

	const ctx: RenderContext = { width, parts: [] };
	drawRows(ctx, sizedRows, 0, 0, width);

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${totalHeight}" ` +
			`width="${width}" height="${totalHeight}" role="img" aria-label="Wireframe">` +
		`<rect x="0" y="0" width="${width}" height="${totalHeight}" fill="#0f1117" />` +
		ctx.parts.join('') +
		`</svg>`
	);
}
