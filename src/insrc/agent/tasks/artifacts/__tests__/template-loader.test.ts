/**
 * Tests for agent/tasks/artifacts/template-loader.ts.
 *
 * Three-layer resolution (repo -> user -> bundled), mtime-keyed
 * cache, and the lint rules. User / repo overrides live under
 * `<root>/.insrc/artifacts/templates/<kind>.html` and
 * `~/.insrc/artifacts/templates/<kind>.html` respectively; we use
 * tmp dirs + `opts.repoRoot` for the repo layer, and leave the
 * user layer out (it'd require fighting `PATHS.insrc`).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	clearTemplateCache,
	lintTemplate,
	listTemplates,
	loadTemplate,
} from '../template-loader.js';

// ---------------------------------------------------------------------------
// Tmp-dir helper -- creates a fake repo root with a template override.
// ---------------------------------------------------------------------------

function makeRepoWithOverride(kind: string, contents: string): string {
	const root = mkdtempSync(join(tmpdir(), 'insrc-tl-'));
	const dir = join(root, '.insrc', 'artifacts', 'templates');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${kind}.html`), contents);
	return root;
}

function cleanup(root: string): void {
	try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

describe('lintTemplate', () => {
	it('accepts a plain template with no script / event handlers / js URLs', () => {
		const issues = lintTemplate('<div class="foo">@@TITLE@@</div>');
		assert.deepEqual(issues, []);
	});

	it('rejects raw <script> tags', () => {
		const issues = lintTemplate('<div><script>x</script></div>');
		assert.equal(issues.length, 1);
		assert.equal(issues[0]?.kind, 'script');
	});

	it('rejects inline event-handler attributes', () => {
		const issues = lintTemplate('<div onclick="x">a</div>');
		assert.equal(issues.length, 1);
		assert.equal(issues[0]?.kind, 'event-handler');
	});

	it('rejects javascript: URLs', () => {
		const issues = lintTemplate('<a href="javascript:x()">link</a>');
		assert.equal(issues.length, 1);
		assert.equal(issues[0]?.kind, 'javascript-url');
	});

	it('reports all three issue kinds when present in one template', () => {
		const issues = lintTemplate(
			'<div onclick="x"><script>y</script><a href="javascript:z"></a></div>',
		);
		const kinds = issues.map(i => i.kind).sort();
		assert.deepEqual(kinds, ['event-handler', 'javascript-url', 'script']);
	});
});

// ---------------------------------------------------------------------------
// Three-layer resolution + mtime-keyed caching
// ---------------------------------------------------------------------------

describe('loadTemplate - three-layer resolution', () => {
	it('prefers the repo override over bundled when repoRoot is supplied', async () => {
		clearTemplateCache();
		const REPO_MARKER = '<!-- repo-layer-ok -->';
		const tpl = `<div data-artifact-id="@@ID@@">${REPO_MARKER} @@TITLE@@ @@SOURCE@@ @@META_LINE@@ @@LEGEND@@ @@GENERATED_AT@@ @@PROVENANCE@@</div>@@RENDERER_SCRIPT@@`;
		const root = makeRepoWithOverride('er', tpl);
		try {
			const loaded = await loadTemplate('er', { repoRoot: root });
			assert.equal(loaded.layer, 'repo');
			assert.ok(loaded.text.includes(REPO_MARKER));
		} finally {
			cleanup(root);
			clearTemplateCache();
		}
	});

	it('falls through to bundled when no override exists', async () => {
		clearTemplateCache();
		const root = mkdtempSync(join(tmpdir(), 'insrc-tl-empty-'));
		try {
			const loaded = await loadTemplate('sequence', { repoRoot: root });
			assert.equal(loaded.layer, 'bundled');
			// Bundled sequence template has the kind-specific class.
			assert.ok(loaded.text.includes('insrc-artifact-sequence'));
		} finally {
			cleanup(root);
			clearTemplateCache();
		}
	});

	it('degrades to bundled when the repo override fails lint', async () => {
		clearTemplateCache();
		const BAD = '<div onclick="alert(1)">@@TITLE@@</div>';
		const root = makeRepoWithOverride('flow', BAD);
		try {
			const loaded = await loadTemplate('flow', { repoRoot: root });
			// Rejected override -> loader falls through to bundled.
			assert.equal(loaded.layer, 'bundled');
		} finally {
			cleanup(root);
			clearTemplateCache();
		}
	});
});

// ---------------------------------------------------------------------------
// listTemplates
// ---------------------------------------------------------------------------

describe('listTemplates', () => {
	it('returns one row per known kind, defaulting to bundled', async () => {
		clearTemplateCache();
		const infos = await listTemplates();
		// All 5 kinds should resolve to bundled in a clean env.
		const kinds = infos.map(i => i.kind).sort();
		assert.deepEqual(kinds, ['deployment', 'er', 'flow', 'sequence', 'wireframe']);
		for (const info of infos) {
			assert.equal(info.layer, 'bundled');
			assert.ok(info.path.endsWith(`${info.kind}.html`));
		}
	});
});
