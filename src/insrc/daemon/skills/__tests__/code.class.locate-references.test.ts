/**
 * Tests for `code.class.locate-references` (code-analyzer-skills.md
 * Phase 3.2). The second cross-owner code-binding skill, mirror of
 * §3.1 but for in-edge walking instead of field extraction.
 *
 * Coverage:
 *   - happy path: locate hit + refs hit -> { found: true, references }
 *   - typed-refusal: locate miss -> { found: false, nearest } with
 *     high confidence (the *refusal* itself is reliable; missing
 *     class is a lookup outcome, not an error)
 *   - locate-tool error -> low confidence + clear note
 *   - refs-tool error after a successful locate -> low confidence
 *   - empty references -> medium confidence (class exists, unused)
 *   - truncated flag carries through from the refs tool
 *   - kinds filter forwards to the refs call
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
import type { ToolCall } from '../../../shared/types.js';

const SKILL_ID = 'code.class.locate-references';

interface LocateRefsValue {
	readonly found:    boolean;
	readonly entityId?: string;
	readonly className?: string;
	readonly path?:     string;
	readonly line?:     number;
	readonly references?: ReadonlyArray<Record<string, unknown>>;
	readonly truncated?: boolean;
	readonly counts?:   Record<string, number>;
	readonly nearest?:  ReadonlyArray<Record<string, unknown>>;
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

function locatePayload(opts: { entityId?: string; path?: string; line?: number; kind?: string } = {}): unknown {
	return {
		found:    true,
		entityId: opts.entityId ?? 'a'.repeat(32),
		path:     opts.path ?? '/repo/src/F.ts',
		line:     opts.line ?? 5,
		language: 'typescript',
		kind:     opts.kind ?? 'class',
	};
}

function refsPayload(opts: {
	className?: string;
	references?: Array<Record<string, unknown>>;
	truncated?: boolean;
	counts?: Record<string, number>;
} = {}): unknown {
	return {
		entityId:   'a'.repeat(32),
		className:  opts.className ?? 'Foo',
		references: opts.references ?? [],
		truncated:  opts.truncated ?? false,
		counts:     opts.counts ?? { CALLS: 0, INHERITS: 0, IMPLEMENTS: 0, REFERENCES: 0 },
	};
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('happy path: locate + refs both succeed -> found: true with references and high confidence', async () => {
	setup();

	const refs = [
		{
			kind: 'INHERITS', fromEntityId: 'b'.repeat(32),
			fromPath: '/repo/AuthHandler.ts', fromLine: 10,
			snippet: 'class AuthHandler extends BaseHandler {',
		},
		{
			kind: 'CALLS', fromEntityId: 'c'.repeat(32),
			fromPath: '/repo/invoke.ts', fromLine: 22,
			snippet: 'function invoke() {',
		},
	];
	const fakeTools: FakeToolMap = {
		code_class_locate:     okTool(locatePayload()),
		code_class_references: okTool(refsPayload({
			className: 'BaseHandler',
			references: refs,
			counts: { CALLS: 1, INHERITS: 1, IMPLEMENTS: 0, REFERENCES: 0 },
		})),
	};

	const { result } = await runSkillIsolated<unknown, LocateRefsValue>(
		SKILL_ID,
		{ className: 'BaseHandler' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.found, true);
	assert.equal(result.value.className, 'BaseHandler');
	assert.equal(result.value.references?.length, 2);
	assert.equal(result.value.counts?.['CALLS'],    1);
	assert.equal(result.value.counts?.['INHERITS'], 1);
});

test('happy path: forwards repoPath / language / kinds to the underlying tools', async () => {
	setup();

	let lastLocate: ToolCall | null = null;
	let lastRefs:   ToolCall | null = null;
	const fakeTools: FakeToolMap = {
		code_class_locate: (call) => {
			lastLocate = call;
			return okTool(locatePayload());
		},
		code_class_references: (call) => {
			lastRefs = call;
			return okTool(refsPayload());
		},
	};

	await runSkillIsolated<unknown, LocateRefsValue>(
		SKILL_ID,
		{
			className: 'Foo',
			repoPath:  '/repo/alpha',
			language:  'typescript',
			kinds:     ['INHERITS', 'IMPLEMENTS'],
		},
		{ fakeTools },
	);

	assert.ok(lastLocate !== null);
	assert.equal((lastLocate! as ToolCall).input['repoPath'], '/repo/alpha');
	assert.equal((lastLocate! as ToolCall).input['language'], 'typescript');

	assert.ok(lastRefs !== null);
	assert.deepEqual((lastRefs! as ToolCall).input['kinds'], ['INHERITS', 'IMPLEMENTS']);
});

// ---------------------------------------------------------------------------
// Typed refusal
// ---------------------------------------------------------------------------

test('typed refusal: locate miss -> { found: false, nearest } with high confidence', async () => {
	setup();
	let refsCalled = false;
	const fakeTools: FakeToolMap = {
		code_class_locate: okTool({
			found: false,
			nearest: [
				{ className: 'INPurchaseOrder', score: 0.92, entityId: 'a'.repeat(32) },
			],
		}),
		code_class_references: () => {
			refsCalled = true;
			return okTool({});
		},
	};

	const { result } = await runSkillIsolated<unknown, LocateRefsValue>(
		SKILL_ID,
		{ className: 'INPurchaseOrders' },
		{ fakeTools },
	);

	assert.equal(result.value.found, false);
	assert.equal(result.value.nearest?.length, 1);
	assert.equal(result.confidence, 'high');
	assert.equal(refsCalled, false, 'must not call code_class_references when locate misses');
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test('locate-tool error -> low confidence with the underlying message', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate:     errTool('graph store unavailable'),
		code_class_references: okTool({}),
	};
	const { result } = await runSkillIsolated<unknown, LocateRefsValue>(
		SKILL_ID,
		{ className: 'Anything' },
		{ fakeTools },
	);
	assert.equal(result.confidence, 'low');
	assert.equal(result.value.found, false);
	assert.ok((result.notes ?? []).some(n => n.includes('graph store unavailable')));
});

test('refs-tool error after successful locate -> low confidence, no fabricated refs', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate:     okTool(locatePayload()),
		code_class_references: errTool('cursor read failed'),
	};
	const { result } = await runSkillIsolated<unknown, LocateRefsValue>(
		SKILL_ID,
		{ className: 'Foo' },
		{ fakeTools },
	);
	assert.equal(result.confidence, 'low');
	assert.equal(result.value.found, false);
	assert.ok((result.notes ?? []).some(n => n.includes('cursor read failed')));
});

test('locate returns a malformed payload -> low confidence, refusal shape', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate: { content: '???', isError: false, data: { weird: true } },
		code_class_references: okTool({}),
	};
	const { result } = await runSkillIsolated<unknown, LocateRefsValue>(
		SKILL_ID,
		{ className: 'X' },
		{ fakeTools },
	);
	assert.equal(result.confidence, 'low');
	assert.equal(result.value.found, false);
});

// ---------------------------------------------------------------------------
// Confidence + truncation shaping
// ---------------------------------------------------------------------------

test('empty references -> confidence: medium (class exists, unused)', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate:     okTool(locatePayload()),
		code_class_references: okTool(refsPayload({ className: 'Lonely', references: [] })),
	};
	const { result } = await runSkillIsolated<unknown, LocateRefsValue>(
		SKILL_ID,
		{ className: 'Lonely' },
		{ fakeTools },
	);
	assert.equal(result.value.found, true);
	assert.equal(result.value.references?.length, 0);
	assert.equal(result.confidence, 'medium');
});

test('truncated flag carries through to the SkillResult envelope', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate:     okTool(locatePayload()),
		code_class_references: okTool(refsPayload({
			references: [{
				kind: 'CALLS', fromEntityId: 'b'.repeat(32),
				fromPath: '/repo/c.ts', fromLine: 1,
			}],
			truncated: true,
			counts: { CALLS: 200, INHERITS: 0, IMPLEMENTS: 0, REFERENCES: 0 },
		})),
	};
	const { result } = await runSkillIsolated<unknown, LocateRefsValue>(
		SKILL_ID,
		{ className: 'Hot' },
		{ fakeTools },
	);
	assert.equal(result.value.found, true);
	assert.equal(result.value.truncated, true);
	// SkillResult envelope also surfaces truncated for envelope consumers.
	assert.equal(result.truncated, true);
});
