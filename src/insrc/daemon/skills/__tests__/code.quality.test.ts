/**
 * Tests for the four Phase 5 quality / metrics skills:
 *   - code.quality.complexity        (cyclomatic per fn / method)
 *   - code.quality.duplication       (min-hash near-dupe pairs)
 *   - code.quality.unused-exports    (exported entities w/ no in-edges)
 *   - code.quality.cyclic-deps       (file-level IMPORTS SCC > 1)
 *
 * Pure-helper tests for the two algos + end-to-end via
 * runSkillIsolated against an in-memory LMDB graph.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { closeGraphStore, setGraphStorePath } from '../../../db/graph/store.js';
import { upsertEntities } from '../../../db/entities.js';
import { upsertRelations } from '../../../db/relations.js';
import { addRepo } from '../../../db/repos.js';
import { registerAllSkills } from '../index.js';
import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import { runSkillIsolated } from '../test-harness.js';
import { computeCyclomaticComplexity } from '../built-ins/code.quality.complexity.algo.js';
import {
	computeSignature,
	jaccardEstimate,
	_tokenizeForTest as tokenize,
} from '../built-ins/code.quality.duplication.algo.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';

const REPO = '/repo/alpha';

let dir: string;

function mkId(repo: string, file: string, kind: string, name: string): string {
	return createHash('sha256').update(`${repo}\x00${file}\x00${kind}\x00${name}`).digest('hex').slice(0, 32);
}

function ent(opts: {
	kind: EntityKind;
	name: string;
	file?: string;
	body?: string;
	language?: Language;
	startLine?: number;
	isExported?: boolean;
}): Entity {
	const file = opts.file ?? `${REPO}/src/${opts.name}.ts`;
	const e: Entity = {
		id:        mkId(REPO, file, opts.kind, opts.name),
		kind:      opts.kind,
		name:      opts.name,
		language:  opts.language ?? 'typescript',
		repoId:    1,
		repo:      REPO,
		file,
		startLine: opts.startLine ?? 1,
		endLine:   (opts.startLine ?? 1) + 10,
		body:      opts.body ?? '',
		embedding: [],
		indexedAt: '2026-05-09T10:00:00.000Z',
	};
	if (opts.isExported === true) e.isExported = true;
	return e;
}

function fileEnt(file: string): Entity {
	return ent({ kind: 'file', name: file, file });
}

test.beforeEach(async () => {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	dir = mkdtempSync(join(tmpdir(), 'insrc-quality-skills-'));
	setGraphStorePath(join(dir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO, name: '', addedAt: now, status: 'pending' });
	registerAllSkills();
	registerSkillTools();
});

test.afterEach(async () => {
	await closeGraphStore();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5.1 -- complexity algo
// ---------------------------------------------------------------------------

test('complexity.algo: empty body -> cyclomatic 1, level low', () => {
	const r = computeCyclomaticComplexity('', 'typescript');
	assert.equal(r.cyclomatic, 1);
	assert.equal(r.level, 'low');
});

test('complexity.algo: counts if / else if / && / ||', () => {
	const body = `
		function f(a, b) {
			if (a && b) {
				return 1;
			} else if (a || b) {
				return 2;
			}
			return 3;
		}`;
	const r = computeCyclomaticComplexity(body, 'typescript');
	// 1 base + 1 if + 1 else if + 1 && + 1 || = 5
	assert.equal(r.cyclomatic, 5);
});

test('complexity.algo: ?? and ?. are NOT counted as branches', () => {
	const body = `
		function f(a) {
			return a?.foo ?? 'x';
		}`;
	const r = computeCyclomaticComplexity(body, 'typescript');
	assert.equal(r.cyclomatic, 1);
});

test('complexity.algo: keywords inside string literals are ignored', () => {
	const body = `function f() { return "if you do this && or that"; }`;
	const r = computeCyclomaticComplexity(body, 'typescript');
	assert.equal(r.cyclomatic, 1);
});

test('complexity.algo: python elif counted', () => {
	const body = `
def f(a):
    if a > 0:
        return 1
    elif a < 0:
        return -1
    else:
        return 0`;
	const r = computeCyclomaticComplexity(body, 'python');
	// 1 base + if + elif = 3
	assert.equal(r.cyclomatic, 3);
});

test('complexity skill: surfaces histogram + top-N', async () => {
	const simple = ent({
		kind: 'function', name: 'simple',
		body: 'function simple() { return 1; }',
	});
	const complex = ent({
		kind: 'function', name: 'complex',
		body: `function complex(a) {
			if (a > 0) {
				if (a > 10 && a < 100) {
					return 1;
				} else if (a < 0 || a == 0) {
					return 2;
				}
			}
			return 3;
		}`,
	});
	await upsertEntities(null, [simple, complex]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.quality.complexity', { repoPath: REPO }, {},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['entryCount'], 2);
	const top = v['top'] as Array<Record<string, unknown>>;
	assert.equal(top[0]!['name'], 'complex'); // higher cyclomatic
	const hist = v['histogram'] as Record<string, number>;
	assert.equal(hist['low'], 2); // both still under 10
});

// ---------------------------------------------------------------------------
// 5.3 -- duplication algo + skill
// ---------------------------------------------------------------------------

test('duplication.algo: tokenize lower-cases identifiers and drops punctuation', () => {
	const tokens = tokenize('function Foo(x) { return x + 1; }');
	assert.ok(tokens.includes('function'));
	assert.ok(tokens.includes('foo'));
	assert.ok(tokens.includes('return'));
});

test('duplication.algo: identical bodies -> Jaccard ~ 1.0', () => {
	const body = `function helper(a, b) {
		const total = a + b + 1;
		if (total > 100) return 100;
		return total;
	}`;
	const sigA = computeSignature(body)!;
	const sigB = computeSignature(body)!;
	assert.ok(sigA !== null && sigB !== null);
	assert.equal(jaccardEstimate(sigA, sigB), 1);
});

test('duplication.algo: different bodies -> Jaccard well below threshold', () => {
	const a = computeSignature(`function f(x) { return x * 2; }`)!;
	const b = computeSignature(`class Helper { constructor() { this.value = 42; } toString() { return "hello"; } }`)!;
	assert.ok(jaccardEstimate(a, b) < 0.3);
});

test('duplication.algo: numeric literals don\'t perturb fingerprint', () => {
	const a = computeSignature(`function f(x) { if (x > 100) return 200; return 0; }`)!;
	const b = computeSignature(`function f(x) { if (x > 7)   return 999; return 0; }`)!;
	// Tokens: function f x if x 0 return 0 return 0 -- nearly identical.
	assert.ok(jaccardEstimate(a, b) > 0.9);
});

test('duplication skill: detects copy-paste pair above threshold', async () => {
	const original = ent({
		kind: 'function', name: 'original', file: `${REPO}/src/a.ts`,
		body: `function original(x) {
			const total = x + 1;
			if (total > 100) return 100;
			return total;
		}`,
	});
	const copyPasta = ent({
		kind: 'function', name: 'copyPasta', file: `${REPO}/src/b.ts`,
		body: `function copyPasta(x) {
			const total = x + 1;
			if (total > 100) return 100;
			return total;
		}`,
	});
	const unrelated = ent({
		kind: 'function', name: 'unrelated', file: `${REPO}/src/c.ts`,
		body: `class Foo { hello() { return "world"; } }`,
	});
	await upsertEntities(null, [original, copyPasta, unrelated]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.quality.duplication', { repoPath: REPO, threshold: 0.6 }, {},
	);
	const v = result.value as Record<string, unknown>;
	const pairs = v['pairs'] as Array<Record<string, unknown>>;
	assert.ok(pairs.length >= 1);
	const names = new Set([
		(pairs[0]!['a'] as Record<string, unknown>)['name'],
		(pairs[0]!['b'] as Record<string, unknown>)['name'],
	]);
	assert.ok(names.has('original') && names.has('copyPasta'));
});

// ---------------------------------------------------------------------------
// 5.4 -- unused-exports
// ---------------------------------------------------------------------------

test('unused-exports: exported entity with no in-edge -> reported', async () => {
	const exported = ent({ kind: 'function', name: 'unused',  file: `${REPO}/src/u.ts`, isExported: true });
	const used     = ent({ kind: 'function', name: 'used',    file: `${REPO}/src/use.ts`, isExported: true });
	const caller   = ent({ kind: 'function', name: 'caller',  file: `${REPO}/src/c.ts` });
	await upsertEntities(null, [exported, used, caller]);
	await upsertRelations(null, [
		{ kind: 'CALLS', from: caller.id, to: used.id, resolved: true },
	]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.quality.unused-exports', { repoPath: REPO }, {},
	);
	const v = result.value as Record<string, unknown>;
	const unused = v['unused'] as Array<Record<string, unknown>>;
	assert.equal(unused.length, 1);
	assert.equal(unused[0]!['name'], 'unused');
	assert.equal(v['candidateCount'], 2); // both are exported
	assert.equal(v['unusedCount'], 1);
});

// ---------------------------------------------------------------------------
// 5.5 -- cyclic-deps
// ---------------------------------------------------------------------------

test('cyclic-deps: A imports B, B imports A -> 1 cycle of size 2', async () => {
	const a = fileEnt(`${REPO}/src/a.ts`);
	const b = fileEnt(`${REPO}/src/b.ts`);
	const c = fileEnt(`${REPO}/src/c.ts`); // not in cycle
	await upsertEntities(null, [a, b, c]);
	await upsertRelations(null, [
		{ kind: 'IMPORTS', from: a.id, to: b.id, resolved: true },
		{ kind: 'IMPORTS', from: b.id, to: a.id, resolved: true },
		{ kind: 'IMPORTS', from: c.id, to: a.id, resolved: true },
	]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.quality.cyclic-deps', { repoPath: REPO }, {},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['fileCount'], 3);
	assert.equal(v['cycleCount'], 1);
	const cycles = v['cycles'] as Array<Record<string, unknown>>;
	assert.equal(cycles[0]!['size'], 2);
});

test('cyclic-deps: acyclic graph -> no cycles', async () => {
	const a = fileEnt(`${REPO}/src/a.ts`);
	const b = fileEnt(`${REPO}/src/b.ts`);
	await upsertEntities(null, [a, b]);
	await upsertRelations(null, [
		{ kind: 'IMPORTS', from: a.id, to: b.id, resolved: true },
	]);

	const { result } = await runSkillIsolated<unknown, Record<string, unknown>>(
		'code.quality.cyclic-deps', { repoPath: REPO }, {},
	);
	const v = result.value as Record<string, unknown>;
	assert.equal(v['cycleCount'], 0);
});
