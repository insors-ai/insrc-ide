/**
 * Tests for `code.orm.resolve-model` (code-analyzer-skills.md Phase 3.3).
 *
 * Coverage:
 *   - happy path (single match) -> { found: true, model } with
 *     normalised columns / relations and synthesised single-column
 *     unique indexes from `isUnique`
 *   - typo / unknown name -> { found: false, nearest } with the
 *     three closest models by Levenshtein + prefix-overlap
 *   - empty repo / no models scanned -> empty nearest, low/medium
 *     signal but a clean refusal
 *   - multi-dialect ambiguity -> { found: false, ambiguity:
 *     { kind: 'multiple-matches', alternatives: ['<dialect>:<name>'] } }
 *   - tool-error path -> low confidence with the underlying message
 *   - malformed payload -> low confidence, refusal shape
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../index.js';
import {
	getSkill,
	_resetSkillRegistryForTests,
} from '../registry.js';
import { runSkillIsolated, type FakeToolMap } from '../test-harness.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';

const SKILL_ID = 'code.orm.resolve-model';

interface ResolveModelValue {
	readonly found:    boolean;
	readonly model?:   Record<string, unknown>;
	readonly nearest?: ReadonlyArray<Record<string, unknown>>;
	readonly ambiguity?: Record<string, unknown>;
}

function setup(): void {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
	assert.ok(getSkill(SKILL_ID), `${SKILL_ID} must be in the registry`);
}

function okTool(data: unknown): { content: string; isError: false; data: unknown } {
	return { content: '```json\n' + JSON.stringify(data) + '\n```', isError: false, data };
}

function errTool(msg: string): { content: string; isError: true } {
	return { content: msg, isError: true };
}

function scanPayload(opts: {
	models?: Array<{ name: string; dialect: string; table?: string; columns?: unknown[]; relations?: unknown[]; path?: string; line?: number }>;
	detected?: string[];
} = {}): unknown {
	const detected = opts.detected ?? (opts.models ? Array.from(new Set(opts.models.map(m => m.dialect))) : []);
	return {
		detected: { orms: detected },
		models: (opts.models ?? []).map(m => ({
			name:      m.name,
			...(m.table !== undefined ? { table: m.table } : {}),
			columns:   m.columns ?? [],
			relations: m.relations ?? [],
			path:      m.path ?? '/repo/schema.prisma',
			line:      m.line ?? 1,
			dialect:   m.dialect,
		})),
	};
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('happy path: single match -> { found: true, model } with high confidence', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_orm_scan: okTool(scanPayload({
			models: [
				{
					name: 'User', dialect: 'prisma', table: 'users',
					columns: [
						{ name: 'id', type: 'Int', isPrimary: true },
						{ name: 'email', type: 'String', isUnique: true },
					],
					relations: [{ kind: 'has_many', target: 'Post' }],
					path: '/repo/prisma/schema.prisma', line: 5,
				},
			],
		})),
	};

	const { result } = await runSkillIsolated<unknown, ResolveModelValue>(
		SKILL_ID,
		{ orm: 'prisma', model: 'User', repoPath: '/repo' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.found, true);
	const model = result.value.model!;
	assert.equal(model['name'], 'User');
	assert.equal(model['table'], 'users');
	assert.equal((model['columns'] as unknown[]).length, 2);
	assert.equal((model['relations'] as unknown[]).length, 1);

	// Synthesised unique index from isUnique.
	const indexes = model['indexes'] as Array<Record<string, unknown>>;
	assert.equal(indexes.length, 1);
	assert.deepEqual(indexes[0]!['columns'], ['email']);
	assert.equal(indexes[0]!['unique'], true);
});

// ---------------------------------------------------------------------------
// Typed refusal -- nearest match
// ---------------------------------------------------------------------------

test('typed refusal: typo near a real model -> { found: false, nearest } with high confidence', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_orm_scan: okTool(scanPayload({
			models: [
				{ name: 'PurchaseOrder', dialect: 'prisma' },
				{ name: 'Invoice',       dialect: 'prisma' },
			],
		})),
	};
	const { result } = await runSkillIsolated<unknown, ResolveModelValue>(
		SKILL_ID,
		{ orm: 'prisma', model: 'PurchaseOrders', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.confidence, 'high');
	assert.equal(result.value.found, false);
	const nearest = result.value.nearest as Array<Record<string, unknown>>;
	assert.ok(nearest.length >= 1);
	assert.equal(nearest[0]!['name'], 'PurchaseOrder');
});

test('typed refusal: empty repo -> empty nearest, friendly note', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_orm_scan: okTool(scanPayload({ models: [], detected: [] })),
	};
	const { result } = await runSkillIsolated<unknown, ResolveModelValue>(
		SKILL_ID,
		{ orm: 'auto', model: 'Order', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.value.found, false);
	assert.deepEqual(result.value.nearest, []);
	assert.ok((result.notes ?? []).some(n => n.includes('No ORM detected')));
});

// ---------------------------------------------------------------------------
// Ambiguity
// ---------------------------------------------------------------------------

test('multi-dialect tie -> { found: false, ambiguity: multiple-matches }', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_orm_scan: okTool(scanPayload({
			models: [
				{ name: 'User', dialect: 'prisma' },
				{ name: 'User', dialect: 'typeorm' },
			],
		})),
	};
	const { result } = await runSkillIsolated<unknown, ResolveModelValue>(
		SKILL_ID,
		{ orm: 'auto', model: 'User', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.value.found, false);
	const ambig = result.value.ambiguity!;
	assert.equal(ambig['kind'], 'multiple-matches');
	const alts = ambig['alternatives'] as string[];
	assert.deepEqual(alts.sort(), ['prisma:User', 'typeorm:User']);
	// notes should hint at the disambiguation move.
	assert.ok((result.notes ?? []).some(n => n.includes('Pass a specific dialect')));
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test('tool-error path -> low confidence with the underlying message', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_orm_scan: errTool('schema.prisma read failed'),
	};
	const { result } = await runSkillIsolated<unknown, ResolveModelValue>(
		SKILL_ID,
		{ orm: 'prisma', model: 'User', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.confidence, 'low');
	assert.equal(result.value.found, false);
	assert.ok((result.notes ?? []).some(n => n.includes('schema.prisma read failed')));
});

test('malformed scan payload -> low confidence, refusal shape', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_orm_scan: { content: '???', isError: false, data: { weird: true } },
	};
	const { result } = await runSkillIsolated<unknown, ResolveModelValue>(
		SKILL_ID,
		{ orm: 'auto', model: 'User', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.confidence, 'low');
	assert.equal(result.value.found, false);
});

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

test('forwards orm + repoPath inputs to code_orm_scan', async () => {
	setup();
	const seen: { orm?: unknown; repoPath?: unknown } = {};
	const fakeTools: FakeToolMap = {
		code_orm_scan: (call) => {
			seen.orm      = call.input['orm'];
			seen.repoPath = call.input['repoPath'];
			return okTool(scanPayload({ models: [{ name: 'X', dialect: 'prisma' }] }));
		},
	};
	await runSkillIsolated<unknown, ResolveModelValue>(
		SKILL_ID,
		{ orm: 'prisma', model: 'X', repoPath: '/r' },
		{ fakeTools },
	);
	assert.equal(seen.orm, 'prisma');
	assert.equal(seen.repoPath, '/r');
});

// ---------------------------------------------------------------------------
// Plan SCS Phase 4: closure-default scanning
// ---------------------------------------------------------------------------

test('closure default: scans every repo in the session closure', async () => {
	setup();
	const seenRepoPaths: string[] = [];
	const fakeTools: FakeToolMap = {
		code_orm_scan: (call) => {
			const rp = call.input['repoPath'] as string;
			seenRepoPaths.push(rp);
			// Each repo "contains" a uniquely-named model so we can
			// confirm both scans were merged.
			const name = rp === '/repos/active' ? 'ActiveModel' : 'DepModel';
			return okTool(scanPayload({ models: [{ name, dialect: 'prisma', path: `${rp}/schema.prisma` }] }));
		},
	};

	// No explicit repoPath -> default 'closure' scope -> scans both.
	const { result } = await runSkillIsolated<unknown, ResolveModelValue>(
		SKILL_ID,
		{ orm: 'auto', model: 'DepModel' },
		{
			fakeTools,
			extraSessionFields: {
				repoPath:     '/repos/active',
				closureRepos: ['/repos/active', '/repos/dep'],
			},
		},
	);
	assert.deepEqual(seenRepoPaths.sort(), ['/repos/active', '/repos/dep']);
	assert.equal(result.value.found, true);
	assert.equal(result.value.model?.['name'], 'DepModel');
});

test('explicit repoPath overrides closure scope', async () => {
	setup();
	const seenRepoPaths: string[] = [];
	const fakeTools: FakeToolMap = {
		code_orm_scan: (call) => {
			seenRepoPaths.push(call.input['repoPath'] as string);
			return okTool(scanPayload({ models: [{ name: 'X', dialect: 'prisma' }] }));
		},
	};

	await runSkillIsolated<unknown, ResolveModelValue>(
		SKILL_ID,
		{ orm: 'auto', model: 'X', repoPath: '/repos/just-this-one' },
		{
			fakeTools,
			extraSessionFields: {
				repoPath:     '/repos/active',
				closureRepos: ['/repos/active', '/repos/dep'],
			},
		},
	);
	assert.deepEqual(seenRepoPaths, ['/repos/just-this-one']);
});

test('multi-repo same-name model -> ambiguity refusal', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_orm_scan: (call) => {
			const rp = call.input['repoPath'] as string;
			// Same model name, different dialects across repos -> the
			// merged matches set has two entries -> ambiguity path.
			const dialect = rp === '/repos/active' ? 'prisma' : 'typeorm';
			return okTool(scanPayload({ models: [{ name: 'User', dialect, path: `${rp}/x` }] }));
		},
	};
	const { result } = await runSkillIsolated<unknown, ResolveModelValue>(
		SKILL_ID,
		{ orm: 'auto', model: 'User' },
		{
			fakeTools,
			extraSessionFields: {
				repoPath:     '/repos/active',
				closureRepos: ['/repos/active', '/repos/dep'],
			},
		},
	);
	assert.equal(result.value.found, false);
	const amb = result.value.ambiguity as Record<string, unknown> | undefined;
	assert.ok(amb !== undefined, 'expected ambiguity payload');
	assert.equal(amb['kind'], 'multiple-matches');
});
