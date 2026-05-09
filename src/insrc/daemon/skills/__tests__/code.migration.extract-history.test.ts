/**
 * Tests for `code.migration.extract-history` (code-analyzer-skills.md
 * Phase 3.5).
 *
 * Coverage:
 *   - happy path: every migration has a parsed op -> high
 *   - mixed: some execute_raw fall-through -> medium
 *   - mostly-raw: > 50% execute_raw -> low
 *   - detected: false -> { found: false, reason: 'no-migrations-detected' }
 *     with high confidence (the *refusal* itself is reliable)
 *   - tool error -> low confidence with the underlying message
 *   - malformed walk payload -> low confidence, refusal shape
 *   - tool + repoPath forwarded to code_migration_walk
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
import { _scoreConfidenceForTest as scoreConfidence } from '../built-ins/code.migration.extract-history.js';

const SKILL_ID = 'code.migration.extract-history';

interface ExtractHistoryValue {
	readonly found:    boolean;
	readonly tool?:    string;
	readonly migrations?: ReadonlyArray<Record<string, unknown>>;
	readonly reason?:  string;
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

function walkPayload(opts: {
	detected?: boolean;
	tool?: string;
	migrations?: Array<{ id: string; label?: string; path?: string; operations: Array<Record<string, unknown>> }>;
} = {}): unknown {
	const detected = opts.detected ?? true;
	return {
		detected,
		...(detected && opts.tool !== undefined ? { tool: opts.tool } : {}),
		migrations: (opts.migrations ?? []).map(m => ({
			id:         m.id,
			label:      m.label ?? m.id,
			path:       m.path  ?? `/repo/migrations/${m.id}.sql`,
			operations: m.operations,
		})),
	};
}

// ---------------------------------------------------------------------------
// Pure helper: scoreConfidence
// ---------------------------------------------------------------------------

test('scoreConfidence: empty migrations array -> high (tool found, just no files yet)', () => {
	assert.equal(scoreConfidence([]), 'high');
});

test('scoreConfidence: all parsed ops -> high', () => {
	const m = [{ id: 'x', label: '', path: '', operations: [{ kind: 'create_table' as const, table: 'u' }] }];
	assert.equal(scoreConfidence(m), 'high');
});

test('scoreConfidence: every migration has at least one parsed op -> high', () => {
	const m = [
		{ id: 'a', label: '', path: '', operations: [{ kind: 'create_table' as const, table: 'u' }, { kind: 'execute_raw' as const, raw: 'GRANT' }] },
		{ id: 'b', label: '', path: '', operations: [{ kind: 'add_column' as const, table: 'u', column: 'x' }] },
	];
	assert.equal(scoreConfidence(m), 'high');
});

test('scoreConfidence: some all-raw migrations + some parsed -> medium', () => {
	const m = [
		{ id: 'a', label: '', path: '', operations: [{ kind: 'create_table' as const, table: 'u' }] },
		{ id: 'b', label: '', path: '', operations: [{ kind: 'execute_raw' as const, raw: 'GRANT' }] },
	];
	// Only one of two migrations has a parsed op; raw share is 50%; not >50% -> medium
	assert.equal(scoreConfidence(m), 'medium');
});

test('scoreConfidence: mostly-raw (>50%) -> low', () => {
	const m = [
		{ id: 'a', label: '', path: '', operations: [
			{ kind: 'execute_raw' as const, raw: 'GRANT' },
			{ kind: 'execute_raw' as const, raw: 'REVOKE' },
			{ kind: 'execute_raw' as const, raw: 'COMMENT' },
		] },
		{ id: 'b', label: '', path: '', operations: [
			{ kind: 'create_table' as const, table: 'u' },
		] },
	];
	// 3 of 4 raw = 75%, NOT every migration parses (b parses, a is all-raw) -> low
	assert.equal(scoreConfidence(m), 'low');
});

// ---------------------------------------------------------------------------
// End-to-end
// ---------------------------------------------------------------------------

test('happy path: every migration has parsed ops -> { found: true, migrations } with high confidence', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_migration_walk: okTool(walkPayload({
			detected: true, tool: 'prisma-migrate',
			migrations: [
				{ id: '20240601120000', operations: [{ kind: 'create_table', table: 'users' }] },
				{ id: '20240615133000', operations: [{ kind: 'add_column', table: 'users', column: 'email', type: 'TEXT' }] },
			],
		})),
	};
	const { result } = await runSkillIsolated<unknown, ExtractHistoryValue>(
		SKILL_ID,
		{ tool: 'auto', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.confidence, 'high');
	assert.equal(result.value.found, true);
	assert.equal(result.value.tool, 'prisma-migrate');
	assert.equal(result.value.migrations?.length, 2);
});

test('typed refusal: detected: false -> { found: false, reason } with high confidence', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_migration_walk: okTool({ detected: false, migrations: [] }),
	};
	const { result } = await runSkillIsolated<unknown, ExtractHistoryValue>(
		SKILL_ID,
		{ tool: 'auto', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.confidence, 'high');
	assert.equal(result.value.found, false);
	assert.equal(result.value.reason, 'no-migrations-detected');
});

test('mixed parse coverage -> medium with explanatory note', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_migration_walk: okTool(walkPayload({
			tool: 'rails',
			migrations: [
				{ id: 'a', operations: [{ kind: 'create_table', table: 'u' }] },
				{ id: 'b', operations: [{ kind: 'execute_raw', raw: 'GRANT' }] },
			],
		})),
	};
	const { result } = await runSkillIsolated<unknown, ExtractHistoryValue>(
		SKILL_ID,
		{ tool: 'rails', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.value.found, true);
	assert.equal(result.confidence, 'medium');
	assert.ok((result.notes ?? []).some(n => n.includes('execute_raw')));
});

test('mostly-raw -> low confidence', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_migration_walk: okTool(walkPayload({
			tool: 'prisma-migrate',
			migrations: [
				{ id: 'a', operations: [
					{ kind: 'execute_raw', raw: 'GRANT' },
					{ kind: 'execute_raw', raw: 'REVOKE' },
					{ kind: 'execute_raw', raw: 'COMMENT' },
				] },
				{ id: 'b', operations: [{ kind: 'create_table', table: 'u' }] },
			],
		})),
	};
	const { result } = await runSkillIsolated<unknown, ExtractHistoryValue>(
		SKILL_ID,
		{ tool: 'auto', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.value.found, true);
	assert.equal(result.confidence, 'low');
});

test('tool-error path -> low confidence', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_migration_walk: errTool('readdir failed'),
	};
	const { result } = await runSkillIsolated<unknown, ExtractHistoryValue>(
		SKILL_ID,
		{ tool: 'auto', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.confidence, 'low');
	assert.equal(result.value.found, false);
	assert.ok((result.notes ?? []).some(n => n.includes('readdir failed')));
});

test('malformed payload -> low confidence with refusal shape', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_migration_walk: { content: '???', isError: false, data: { weird: true } },
	};
	const { result } = await runSkillIsolated<unknown, ExtractHistoryValue>(
		SKILL_ID,
		{ tool: 'auto', repoPath: '/repo' },
		{ fakeTools },
	);
	assert.equal(result.confidence, 'low');
	assert.equal(result.value.found, false);
});

test('forwards tool + repoPath to code_migration_walk', async () => {
	setup();
	const seen: { tool?: unknown; repoPath?: unknown } = {};
	const fakeTools: FakeToolMap = {
		code_migration_walk: (call) => {
			seen.tool     = call.input['tool'];
			seen.repoPath = call.input['repoPath'];
			return okTool({ detected: false, migrations: [] });
		},
	};
	await runSkillIsolated<unknown, ExtractHistoryValue>(
		SKILL_ID,
		{ tool: 'rails', repoPath: '/r' },
		{ fakeTools },
	);
	assert.equal(seen.tool, 'rails');
	assert.equal(seen.repoPath, '/r');
});
