/**
 * Tests for agent/tasks/artifacts/template-binder.ts.
 *
 * Integration against the bundled templates (the loader reads them
 * from disk; we don't mock it). Verifies:
 *   - every required slot is substituted
 *   - @@RENDERER_SCRIPT@@ differs between embedded + standalone
 *   - slot values pass through the sanitiser / Mermaid-escape
 *   - wireframe kind emits raw SVG into @@SOURCE@@ (no escape)
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { bindTemplate } from '../template-binder.js';

// ---------------------------------------------------------------------------
// Helpers
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
// Tests
// ---------------------------------------------------------------------------

describe('bindTemplate - required slots', () => {
	it('substitutes ID / TITLE / SOURCE / GENERATED_AT / PROVENANCE', async () => {
		const { embedded } = await bindTemplate({
			artifactKind: 'er',
			id: 'abc123',
			source: 'erDiagram\n  USERS { string id PK }',
			sourceKind: 'mermaid',
			title: 'Test title',
			metaLine: 'a meta summary',
			provenance: 'caller-supplied Mermaid source',
			generatedAt: '2026-04-24T10:00:00.000Z',
		});
		assert.ok(embedded.includes('data-artifact-id="abc123"'));
		assert.ok(embedded.includes('Test title'));
		assert.ok(embedded.includes('erDiagram'));
		assert.ok(embedded.includes('2026-04-24T10:00:00.000Z'));
		assert.ok(embedded.includes('caller-supplied Mermaid source'));
		// No un-substituted slot markers left behind.
		assert.equal(countOf(embedded, '@@'), 0);
	});
});

describe('bindTemplate - embedded vs standalone modes', () => {
	it('embedded mode leaves @@RENDERER_SCRIPT@@ empty', async () => {
		const { embedded } = await bindTemplate({
			artifactKind: 'er',
			id: 'id1',
			source: 'erDiagram\n  A { string id PK }',
			sourceKind: 'mermaid',
			title: 'T',
			metaLine: 'm',
			provenance: 'p',
			generatedAt: '2026-04-24T00:00:00.000Z',
		});
		// No <script> tag anywhere in embedded mode.
		assert.equal(countOf(embedded, '<script'), 0);
		assert.equal(countOf(embedded, 'mermaid.min.js'), 0);
	});

	it('standalone mode inlines the Mermaid CDN script with SRI', async () => {
		const { standalone } = await bindTemplate({
			artifactKind: 'er',
			id: 'id1',
			source: 'erDiagram\n  A { string id PK }',
			sourceKind: 'mermaid',
			title: 'T',
			metaLine: 'm',
			provenance: 'p',
			generatedAt: '2026-04-24T00:00:00.000Z',
		});
		assert.match(standalone, /<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@/);
		assert.match(standalone, /integrity="sha384-/);
		assert.match(standalone, /crossorigin="anonymous"/);
		// Plus the runtime-bootstrap inline script from _renderer.html.
		assert.ok(countOf(standalone, '<script') >= 2, 'CDN script + bootstrap script');
	});

	it('wireframe standalone mode does NOT inject the Mermaid CDN (SVG only)', async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';
		const { standalone } = await bindTemplate({
			artifactKind: 'wireframe',
			id: 'w1',
			source: svg,
			sourceKind: 'svg',
			title: 'Wireframe',
			metaLine: 'desktop',
			provenance: 'caller-supplied spec',
			generatedAt: '2026-04-24T00:00:00.000Z',
		});
		assert.ok(!standalone.includes('mermaid.min.js'));
		// Raw SVG is passed through without escape -- it's our own
		// renderer's output, trusted by contract.
		assert.ok(standalone.includes('viewBox="0 0 100 100"'));
	});
});

describe('bindTemplate - slot escaping', () => {
	it('HTML-escapes title / metaLine / provenance through sanitiseSlotValue', async () => {
		const { embedded } = await bindTemplate({
			artifactKind: 'er',
			id: 'id2',
			source: 'erDiagram\n  X { string id PK }',
			sourceKind: 'mermaid',
			title: '<script>alert(1)</script>',
			metaLine: 'meta "quoted"',
			provenance: 'prov <b>',
			generatedAt: '2026-04-24T00:00:00.000Z',
		});
		assert.ok(!embedded.includes('<script>alert'), 'raw <script> injected');
		assert.ok(embedded.includes('&lt;script&gt;'));
		assert.ok(embedded.includes('&quot;quoted&quot;'));
	});

	it('Mermaid-escapes @@SOURCE@@ on diagram kinds (&, <, >)', async () => {
		const source = 'flowchart LR\n  A --> B\n  B --> <C>';
		const { embedded } = await bindTemplate({
			artifactKind: 'flow',
			id: 'id3',
			source,
			sourceKind: 'mermaid',
			title: 'T',
			metaLine: 'm',
			provenance: 'p',
			generatedAt: '2026-04-24T00:00:00.000Z',
		});
		// The --> arrows should be escaped to --&gt;
		assert.ok(embedded.includes('A --&gt; B'));
		// The <C> token should be escaped too.
		assert.ok(embedded.includes('&lt;C&gt;'));
	});

	it('does NOT Mermaid-escape wireframe SVG (sourceKind: svg)', async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="&#123;"/></svg>';
		const { embedded } = await bindTemplate({
			artifactKind: 'wireframe',
			id: 'w2',
			source: svg,
			sourceKind: 'svg',
			title: 'W',
			metaLine: 'm',
			provenance: 'p',
			generatedAt: '2026-04-24T00:00:00.000Z',
		});
		assert.ok(embedded.includes('<svg'), 'raw <svg> must survive for wireframe');
		assert.ok(embedded.includes('fill="&#123;"'), 'SVG entity must survive unchanged');
	});
});

describe('bindTemplate - legend slot', () => {
	it('omitting legend renders the empty string (template retains structure)', async () => {
		const { embedded } = await bindTemplate({
			artifactKind: 'er',
			id: 'id4',
			source: 'erDiagram\n  A { string id PK }',
			sourceKind: 'mermaid',
			title: 'T',
			metaLine: 'm',
			provenance: 'p',
			generatedAt: '2026-04-24T00:00:00.000Z',
		});
		// Slot fully consumed -- no leftover @@LEGEND@@.
		assert.equal(countOf(embedded, '@@LEGEND@@'), 0);
	});
});
