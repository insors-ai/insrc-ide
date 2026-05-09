/**
 * Tests for the five Phase 6 synthesis renderers:
 *   - code.synth.entity-card
 *   - code.synth.findings-table
 *   - code.synth.callgraph-mermaid
 *   - code.synth.module-tree
 *   - code.synth.architecture-overview
 *
 * Pure-template skills -- no DB, no tool calls. We assert on the
 * shape of the rendered markdown rather than diff against a fixture
 * (which would be brittle for renderers that may evolve).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../index.js';
import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import { runSkillIsolated } from '../test-harness.js';

function setup(): void {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
}

// ---------------------------------------------------------------------------
// 6.1 entity-card
// ---------------------------------------------------------------------------

test('entity-card: renders header + location + signature + excerpt + neighbours', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.entity-card',
		{
			entityId: 'a'.repeat(32),
			name: 'compute',
			kind: 'function',
			language: 'typescript',
			file: '/repo/src/compute.ts',
			startLine: 5,
			endLine: 25,
			signature: 'compute(x: number): number',
			isExported: true,
			isAsync: true,
			excerpt: 'export async function compute(x: number) {\n  return x + 1;\n}',
			callers: [
				{ id: 'b'.repeat(32), name: 'main', file: '/repo/src/main.ts', startLine: 10 },
			],
			callees: [],
		},
		{},
	);
	const md = result.value.markdown;
	assert.match(md, /### `compute` \(function\) -- exported, async/);
	assert.match(md, /\/repo\/src\/compute\.ts:5/);
	assert.match(md, /Signature:.*compute\(x: number\): number/);
	assert.match(md, /```ts\n[\s\S]*compute\(x: number\)/);
	assert.match(md, /Callers \(1\)/);
	assert.ok(!md.includes('Callees ('));    // empty list -> section omitted
});

test('entity-card: caps neighbours at 10 with "+ N more" tail', async () => {
	setup();
	const callers = Array.from({ length: 15 }, (_, i) => ({
		id: String(i).padStart(32, '0'),
		name: `caller${i}`,
	}));
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.entity-card',
		{
			entityId: 'a'.repeat(32), name: 'hot', kind: 'function',
			language: 'typescript', file: '/repo/h.ts',
			startLine: 1, endLine: 5,
			callers,
		},
		{},
	);
	assert.match(result.value.markdown, /\.\.\. 5 more/);
});

// ---------------------------------------------------------------------------
// 6.2 findings-table
// ---------------------------------------------------------------------------

test('findings-table: groups by severity (critical -> info)', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.findings-table',
		{
			title: 'Quality scan',
			findings: [
				{ severity: 'low',      message: 'minor',    file: '/r/a.ts', line: 3 },
				{ severity: 'critical', message: 'kaboom',   file: '/r/b.ts', line: 7 },
				{ severity: 'medium',   message: 'thinking', category: 'complexity' },
			],
		},
		{},
	);
	const md = result.value.markdown;
	assert.match(md, /## Quality scan/);
	assert.match(md, /\*\*Total: 3\*\*/);
	const criticalIdx = md.indexOf('### Critical');
	const mediumIdx   = md.indexOf('### Medium');
	const lowIdx      = md.indexOf('### Low');
	assert.ok(criticalIdx >= 0 && mediumIdx > criticalIdx && lowIdx > mediumIdx,
		'sections must appear critical -> medium -> low');
});

test('findings-table: empty findings -> "No findings."', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.findings-table',
		{ findings: [] },
		{},
	);
	assert.match(result.value.markdown, /No findings\./);
});

test('findings-table: pipe characters in messages are escaped', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.findings-table',
		{ findings: [{ severity: 'high', message: 'use a || b not a | b' }] },
		{},
	);
	assert.match(result.value.markdown, /a \\\|\\\| b not a \\\| b/);
});

// ---------------------------------------------------------------------------
// 6.3 callgraph-mermaid
// ---------------------------------------------------------------------------

test('callgraph-mermaid: emits graph LR with focal + neighbours', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.callgraph-mermaid',
		{
			focal:   { id: 'f'.repeat(32), name: 'compute' },
			callers: [{ id: 'a'.repeat(32), name: 'main' }],
			callees: [{ id: 'b'.repeat(32), name: 'helper' }],
		},
		{},
	);
	const md = result.value.markdown;
	assert.match(md, /```mermaid\ngraph LR/);
	assert.match(md, /-->/);
	assert.match(md, /<b>compute<\/b>/);
});

test('callgraph-mermaid: caps neighbours at 30 with "+N more" annotation', async () => {
	setup();
	const callers = Array.from({ length: 35 }, (_, i) => ({ id: String(i).padStart(32, '0'), name: `c${i}` }));
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.callgraph-mermaid',
		{ focal: { id: 'f'.repeat(32), name: 'hot' }, callers },
		{},
	);
	assert.match(result.value.markdown, /\+5 more/);
});

// ---------------------------------------------------------------------------
// 6.4 module-tree
// ---------------------------------------------------------------------------

test('module-tree: top modules verbatim, rest collapsed', async () => {
	setup();
	const modules = Array.from({ length: 15 }, (_, i) => ({
		path:        `/repo/m${i}`,
		fileCount:   20 - i,
		entityCount: 100 - i,
	}));
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.module-tree',
		{ repoPath: '/repo', modules },
		{},
	);
	const md = result.value.markdown;
	// First module ('m0') in the verbatim slice; last verbatim is m9.
	assert.match(md, /m0\//);
	assert.match(md, /m9\//);
	// Collapsed marker for m10..m14
	assert.match(md, /\.\.\. 5 more modules/);
});

test('module-tree: empty list -> "No modules."', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.module-tree',
		{ repoPath: '/repo', modules: [] },
		{},
	);
	assert.match(result.value.markdown, /No modules\./);
});

// ---------------------------------------------------------------------------
// 6.5 architecture-overview
// ---------------------------------------------------------------------------

test('architecture-overview: full input -> all sections present', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.architecture-overview',
		{
			repoPath: '/repo/alpha',
			fileCount: 150,
			entityCount: 1200,
			kindCounts: { function: 800, class: 50, method: 320, file: 150 },
			languages: [
				{ language: 'typescript', fileCount: 100, entityCount: 800 },
				{ language: 'python',     fileCount: 50,  entityCount: 400 },
			],
			topModules: [
				{ path: '/repo/alpha/src/orm',  fileCount: 30, entityCount: 200 },
				{ path: '/repo/alpha/src/util', fileCount: 20, entityCount: 80 },
			],
			orms: ['prisma', 'typeorm'],
			migrationTool: 'prisma-migrate',
			cycleCount: 0,
		},
		{},
	);
	const md = result.value.markdown;
	assert.match(md, /^# Architecture overview/);
	assert.match(md, /## Scale/);
	assert.match(md, /\*\*150\*\* indexed files/);
	assert.match(md, /## Languages/);
	assert.match(md, /typescript.*100 files/);
	assert.match(md, /## Top modules/);
	assert.match(md, /src\/orm/);
	assert.match(md, /## Data tooling/);
	assert.match(md, /prisma, typeorm/);
	assert.match(md, /## Health/);
	assert.match(md, /No file-level import cycles/);
});

test('architecture-overview: cycleCount > 0 -> warning emitted', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, { markdown: string }>(
		'code.synth.architecture-overview',
		{
			repoPath: '/repo',
			fileCount: 5,
			entityCount: 10,
			kindCounts: {},
			languages: [],
			topModules: [],
			cycleCount: 3,
		},
		{},
	);
	assert.match(result.value.markdown, /\*\*3\*\* file-level import cycle/);
});
