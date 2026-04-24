/**
 * Tests for agent/tasks/artifacts/sanitise.ts.
 *
 * Uses Node's built-in `node:test` module -- no new dep needed.
 * Run locally:
 *     cd src/insrc
 *     npx tsx --test agent/tasks/artifacts/__tests__/sanitise.test.ts
 *
 * Or the daemon-wide helper (plans/artifact-tasks.md testing strategy):
 *     npm test --prefix src/insrc
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { escapeMermaidSource, sanitiseSlotValue } from '../sanitise.js';

// Build control-char test inputs programmatically so the test source
// stays ASCII-clean. String literals with raw control bytes would
// round-trip through editor tooling unreliably.
const CH_01 = String.fromCharCode(0x01);
const CH_08 = String.fromCharCode(0x08);
const CH_0E = String.fromCharCode(0x0e);
const CH_1F = String.fromCharCode(0x1f);

describe('sanitiseSlotValue', () => {
	it('escapes the HTML-significant set (&, <, >, ", \', /)', () => {
		assert.equal(sanitiseSlotValue('<b>'), '&lt;b&gt;');
		assert.equal(sanitiseSlotValue('"attr"'), '&quot;attr&quot;');
		assert.equal(sanitiseSlotValue("a'b"), 'a&#39;b');
		assert.equal(sanitiseSlotValue('a&b'), 'a&amp;b');
		assert.equal(sanitiseSlotValue('path/x'), 'path&#47;x');
	});

	it('strips javascript: URL prefixes', () => {
		assert.equal(sanitiseSlotValue('javascript:alert(1)'), 'alert(1)');
		// Case-insensitive + whitespace tolerant -- matches the regex.
		assert.equal(sanitiseSlotValue('JavaScript :evil'), 'evil');
		assert.equal(sanitiseSlotValue('JAVASCRIPT:bad'), 'bad');
	});

	it('strips ASCII control chars other than tab / LF', () => {
		// U+0001 / U+001F / U+000E are the three representative control
		// bytes we want stripped. Tab + LF should survive.
		const withControls = `a${CH_01}b${CH_1F}c${CH_0E}d`;
		assert.equal(sanitiseSlotValue(withControls), 'abcd');
		assert.equal(sanitiseSlotValue('a\tb\nc'), 'a\tb\nc');
	});

	it('leaves plain text untouched', () => {
		assert.equal(
			sanitiseSlotValue('generated at 2026-04-24'),
			'generated at 2026-04-24',
		);
	});

	it('chains the three passes (control strip -> js neutralise -> HTML escape)', () => {
		// Backspace (U+0008) between `img` and `onerror`; we expect
		// (a) the control byte to be stripped, (b) the javascript:
		// prefix to be neutralised, (c) angle brackets HTML-escaped.
		const input = `javascript:<img${CH_08}onerror="x">`;
		const out = sanitiseSlotValue(input);
		assert.ok(!/javascript:/i.test(out), 'javascript: prefix removed');
		assert.ok(!out.includes('<'), 'angle brackets escaped');
		assert.ok(!out.includes(CH_08), 'control char stripped');
	});
});

describe('escapeMermaidSource', () => {
	it('only escapes &, <, > (narrow set so Mermaid parses the raw text)', () => {
		assert.equal(
			escapeMermaidSource('A-->B'),
			'A--&gt;B',
		);
		assert.equal(
			escapeMermaidSource('User->>System: login'),
			'User-&gt;&gt;System: login',
		);
	});

	it('does NOT touch quotes, slashes, or apostrophes (Mermaid uses them)', () => {
		const s = `classDiagram\n  A : +foo() "B's"\n  C --|> D`;
		const out = escapeMermaidSource(s);
		assert.ok(out.includes(`"B's"`), 'apostrophe preserved');
		assert.ok(out.includes('"'), 'double-quote preserved');
		assert.ok(out.includes('|'), 'pipe preserved');
	});

	it('is idempotent-safe only once (double-escape produces &amp;lt;)', () => {
		// This is intentional -- sanitise.ts runs once per bind, the
		// binder's contract. Documenting it here so a future edit
		// doesn't accidentally introduce double-escape protection.
		const once = escapeMermaidSource('a<b>c');
		const twice = escapeMermaidSource(once);
		assert.equal(once, 'a&lt;b&gt;c');
		assert.equal(twice, 'a&amp;lt;b&amp;gt;c');
	});
});
