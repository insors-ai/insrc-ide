/**
 * Tests for agent/tasks/artifacts/wireframe/render.ts.
 *
 * SVG renderer is a pure, deterministic function -- same input
 * should always produce the same output. No snapshot framework here;
 * we assert on specific structural properties of the SVG.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { renderWireframe } from '../wireframe/render.js';
import type { WireframeSpec } from '../../../../shared/artifacts.js';

// ---------------------------------------------------------------------------
// Small helpers -- count occurrences of a substring
// ---------------------------------------------------------------------------

function countOf(s: string, needle: string): number {
	let n = 0;
	let from = 0;
	while (true) {
		const i = s.indexOf(needle, from);
		if (i < 0) { return n; }
		n++;
		from = i + needle.length;
	}
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEADER_ONLY: WireframeSpec = {
	layout: 'desktop',
	rows: [{ height: 48, cells: [{ kind: 'header', label: 'Dashboard' }] }],
};

const CLASSIC_LAYOUT: WireframeSpec = {
	layout: 'desktop',
	rows: [
		{ height: 56, cells: [{ kind: 'header', label: 'Header' }] },
		{
			height: 'auto',
			cells: [
				{ kind: 'nav',     label: 'Nav',     widthRatio: 1 },
				{ kind: 'content', label: 'Content', widthRatio: 4 },
				{ kind: 'sidebar', label: 'Sidebar', widthRatio: 1 },
			],
		},
		{ height: 48, cells: [{ kind: 'footer', label: 'Footer' }] },
	],
};

const NESTED: WireframeSpec = {
	layout: 'tablet',
	rows: [
		{
			height: 'auto',
			cells: [{
				kind: 'content',
				label: 'Parent',
				children: [
					{ height: 40, cells: [{ kind: 'header', label: 'Inner' }] },
					{ height: 40, cells: [{ kind: 'placeholder' }] },
				],
			}],
		},
	],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderWireframe', () => {
	it('produces a single <svg>...</svg> root element', () => {
		const svg = renderWireframe(HEADER_ONLY);
		assert.ok(svg.startsWith('<svg '), `expected <svg> prefix, got: ${svg.slice(0, 40)}`);
		assert.ok(svg.endsWith('</svg>'), 'expected </svg> suffix');
		assert.equal(countOf(svg, '<svg '), 1);
		assert.equal(countOf(svg, '</svg>'), 1);
	});

	it('is deterministic across repeated calls (same spec -> same SVG)', () => {
		const a = renderWireframe(CLASSIC_LAYOUT);
		const b = renderWireframe(CLASSIC_LAYOUT);
		assert.equal(a, b);
	});

	it('uses the layout width for desktop/tablet/mobile', () => {
		const desktop = renderWireframe({ ...HEADER_ONLY, layout: 'desktop' });
		const tablet = renderWireframe({ ...HEADER_ONLY, layout: 'tablet' });
		const mobile = renderWireframe({ ...HEADER_ONLY, layout: 'mobile' });
		assert.match(desktop, /viewBox="0 0 960 /);
		assert.match(tablet, /viewBox="0 0 720 /);
		assert.match(mobile, /viewBox="0 0 360 /);
	});

	it('emits one <rect> per cell plus one full-canvas background', () => {
		// CLASSIC_LAYOUT has: 1 header + 3 inner (nav/content/sidebar)
		// + 1 footer = 5 cells. Plus the canvas background = 6 rects.
		const svg = renderWireframe(CLASSIC_LAYOUT);
		assert.equal(countOf(svg, '<rect '), 6);
	});

	it('XML-escapes cell labels so angle brackets can\'t break out', () => {
		const spec: WireframeSpec = {
			layout: 'desktop',
			rows: [{ height: 48, cells: [{ kind: 'header', label: '<script>alert(1)</script>' }] }],
		};
		const svg = renderWireframe(spec);
		assert.ok(!svg.includes('<script>'), 'raw <script> should not appear');
		assert.ok(svg.includes('&lt;script&gt;'), 'escaped form should appear');
	});

	it('defaults auto rows to 80px when the row has no children', () => {
		const spec: WireframeSpec = {
			layout: 'desktop',
			rows: [{ height: 'auto', cells: [{ kind: 'content', label: 'X' }] }],
		};
		const svg = renderWireframe(spec);
		// Canvas height reflects the auto-row resolution.
		assert.match(svg, /viewBox="0 0 960 80"/);
	});

	it('renders nested children inside a parent cell', () => {
		const svg = renderWireframe(NESTED);
		// Parent cell + header + placeholder + canvas bg = 4 rects.
		assert.equal(countOf(svg, '<rect '), 4);
		// Nested labels present in <text>.
		assert.ok(svg.includes('>Inner<'), 'Inner label present');
		assert.ok(svg.includes('>Parent<'), 'Parent label present');
	});

	it('uses a dashed stroke on placeholder cells only', () => {
		const svg = renderWireframe({
			layout: 'desktop',
			rows: [{
				height: 60,
				cells: [
					{ kind: 'header', label: 'H' },
					{ kind: 'placeholder' },
				],
			}],
		});
		assert.equal(countOf(svg, 'stroke-dasharray='), 1);
	});

	it('sums row heights into the SVG canvas height', () => {
		const svg = renderWireframe({
			layout: 'desktop',
			rows: [
				{ height: 56, cells: [{ kind: 'header' }] },
				{ height: 120, cells: [{ kind: 'content' }] },
				{ height: 48, cells: [{ kind: 'footer' }] },
			],
		});
		// 56 + 120 + 48 = 224
		assert.match(svg, /viewBox="0 0 960 224"/);
	});
});
