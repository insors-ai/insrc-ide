/**
 * Tests for `code.class.extract-fields` (code-analyzer-skills.md
 * Phase 3.1). The skill is the first cross-owner code-binding skill
 * and the prerequisite the data-analyzer §3.1 wrapper rides.
 *
 * Coverage:
 *   - happy path: locate hit + fields hit -> { found: true, fields }
 *   - typed-refusal: locate miss -> { found: false, nearest } with
 *     high confidence (the *refusal* itself is reliable; missing
 *     class is a lookup outcome, not an error)
 *   - locate-tool error -> low confidence + clear note
 *   - fields-tool error after a successful locate -> low confidence,
 *     no fabricated field list
 *   - empty fields -> medium confidence (class exists but no fields)
 *   - isAbstract carries through from locate to the output
 *
 * No daemon, no DB. We use `runSkillIsolated` from the skill test
 * harness with `fakeTools` shaping the canned `code_class_locate` /
 * `code_class_fields` responses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerAllSkills } from '../index.js';
import {
	getSkill,
	_resetSkillRegistryForTests,
} from '../registry.js';
import { runSkillIsolated, type FakeToolMap } from '../test-harness.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import type { ToolCall } from '../../../shared/types.js';

const SKILL_ID = 'code.class.extract-fields';

interface ExtractFieldsValue {
	readonly found:    boolean;
	readonly entityId?: string;
	readonly className?: string;
	readonly language?: string;
	readonly path?:     string;
	readonly line?:     number;
	readonly kind?:     string;
	readonly isAbstract?: boolean;
	readonly source?:   string;
	readonly fields?:   ReadonlyArray<Record<string, unknown>>;
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

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('happy path: locate + fields both succeed -> found: true with fields and high confidence', async () => {
	setup();

	const locatePayload = {
		found:      true,
		entityId:   'abc123def456abc123def456abc123de',
		path:       '/repo/src/User.ts',
		line:       12,
		language:   'typescript',
		kind:       'class',
	};
	const fieldsPayload = {
		entityId:  'abc123def456abc123def456abc123de',
		className: 'User',
		language:  'typescript',
		source:    'body',
		fields: [
			{
				name: 'id', type: 'string',
				declaredAt: { path: '/repo/src/User.ts', line: 13 },
			},
			{
				name: 'email', type: 'string', nullable: true,
				declaredAt: { path: '/repo/src/User.ts', line: 14 },
			},
		],
	};

	const fakeTools: FakeToolMap = {
		code_class_locate: okTool(locatePayload),
		code_class_fields: okTool(fieldsPayload),
	};

	const { result } = await runSkillIsolated<unknown, ExtractFieldsValue>(
		SKILL_ID,
		{ className: 'User' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.found, true);
	assert.equal(result.value.entityId, locatePayload.entityId);
	assert.equal(result.value.className, 'User');
	assert.equal(result.value.path, '/repo/src/User.ts');
	assert.equal(result.value.line, 12);
	assert.equal(result.value.kind, 'class');
	assert.equal(result.value.source, 'body');
	assert.equal(result.value.fields?.length, 2);
});

test('happy path: forwards repoPath + language to the locate call', async () => {
	setup();

	let lastLocateCall: ToolCall | null = null;
	const fakeTools: FakeToolMap = {
		code_class_locate: (call) => {
			lastLocateCall = call;
			return okTool({
				found: true, entityId: 'a'.repeat(32),
				path: '/p/F.ts', line: 1, language: 'typescript', kind: 'class',
			});
		},
		code_class_fields: okTool({
			entityId: 'a'.repeat(32),
			className: 'Foo',
			language: 'typescript',
			source: 'body',
			fields: [],
		}),
	};

	await runSkillIsolated<unknown, ExtractFieldsValue>(
		SKILL_ID,
		{ className: 'Foo', repoPath: '/repo/alpha', language: 'typescript' },
		{ fakeTools },
	);

	assert.ok(lastLocateCall !== null);
	assert.equal((lastLocateCall! as ToolCall).input['className'], 'Foo');
	assert.equal((lastLocateCall! as ToolCall).input['repoPath'], '/repo/alpha');
	assert.equal((lastLocateCall! as ToolCall).input['language'], 'typescript');
});

// ---------------------------------------------------------------------------
// Typed refusal -- the 2026-04-30 fix
// ---------------------------------------------------------------------------

test('typed refusal: locate miss -> { found: false, nearest } with high confidence', async () => {
	setup();
	const locatePayload = {
		found: false,
		nearest: [
			{ className: 'INPurchaseOrder', score: 0.92, entityId: 'a'.repeat(32) },
			{ className: 'PurchaseOrder',   score: 0.81, entityId: 'b'.repeat(32) },
		],
	};
	const fakeTools: FakeToolMap = {
		code_class_locate: okTool(locatePayload),
		code_class_fields: okTool({}), // must NOT be called
	};

	const { result } = await runSkillIsolated<unknown, ExtractFieldsValue>(
		SKILL_ID,
		{ className: 'INPurchaseOrders' },
		{ fakeTools },
	);

	assert.equal(result.value.found, false);
	assert.equal(result.value.nearest?.length, 2);
	assert.equal(result.confidence, 'high',
		'refusal itself should be high-confidence -- the lookup ran cleanly, the class just is not there');
	assert.ok((result.notes ?? []).some(n => n.includes('not found')),
		'should explain that the class was not found');
});

test('typed refusal: locate miss with no candidates -> empty nearest, still no fields call', async () => {
	setup();
	let fieldsCalled = false;
	const fakeTools: FakeToolMap = {
		code_class_locate: okTool({ found: false, nearest: [] }),
		code_class_fields: () => {
			fieldsCalled = true;
			return okTool({});
		},
	};

	const { result } = await runSkillIsolated<unknown, ExtractFieldsValue>(
		SKILL_ID,
		{ className: 'Nope' },
		{ fakeTools },
	);

	assert.equal(result.value.found, false);
	assert.deepEqual(result.value.nearest, []);
	assert.equal(fieldsCalled, false, 'must not call code_class_fields when locate misses');
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test('locate-tool error -> low confidence with the underlying message in notes', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate: errTool('graph store unavailable'),
		code_class_fields: okTool({}), // must NOT be called
	};

	const { result } = await runSkillIsolated<unknown, ExtractFieldsValue>(
		SKILL_ID,
		{ className: 'Anything' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'low');
	assert.equal(result.value.found, false);
	assert.deepEqual(result.value.nearest, []);
	assert.ok((result.notes ?? []).some(n => n.includes('graph store unavailable')));
});

test('fields-tool error after successful locate -> low confidence, no fabricated fields', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate: okTool({
			found: true, entityId: 'a'.repeat(32),
			path: '/repo/F.ts', line: 5, language: 'typescript', kind: 'class',
		}),
		code_class_fields: errTool('entity row decode failed'),
	};

	const { result } = await runSkillIsolated<unknown, ExtractFieldsValue>(
		SKILL_ID,
		{ className: 'Foo' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'low');
	assert.equal(result.value.found, false,
		'must not return found: true if field extraction failed -- callers might trust the empty fields list');
	assert.ok((result.notes ?? []).some(n => n.includes('entity row decode failed')));
});

test('locate returns a malformed payload -> low confidence, refusal shape', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate: { content: '???', isError: false, data: { weird: true } },
		code_class_fields: okTool({}),
	};

	const { result } = await runSkillIsolated<unknown, ExtractFieldsValue>(
		SKILL_ID,
		{ className: 'X' },
		{ fakeTools },
	);

	assert.equal(result.confidence, 'low');
	assert.equal(result.value.found, false);
});

// ---------------------------------------------------------------------------
// Confidence shaping
// ---------------------------------------------------------------------------

test('empty fields + unreadable source path -> confidence: low (file-read fallback failed)', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate: okTool({
			found: true, entityId: 'a'.repeat(32),
			path: '/repo/Marker.ts', line: 1, language: 'typescript', kind: 'interface',
		}),
		code_class_fields: okTool({
			entityId: 'a'.repeat(32),
			className: 'Marker',
			language: 'typescript',
			source: 'body',
			fields: [],
		}),
	};
	const { result } = await runSkillIsolated<unknown, ExtractFieldsValue>(
		SKILL_ID,
		{ className: 'Marker' },
		{ fakeTools },
	);
	assert.equal(result.value.found, true);
	assert.equal(result.value.fields?.length, 0);
	// With the file-read fallback in place, an empty field set + an
	// unreadable source path means we lost the structural data AND
	// can't even quote raw source -- the honest signal is 'low'.
	// (When the file IS readable, confidence stays 'medium' -- covered
	// by the dedicated fallback test.)
	assert.equal(result.confidence, 'low');
});

test('empty fields + readable source file -> bodyExcerpt populated, confidence medium', async () => {
	setup();
	// Write a real fixture file so the disk-fallback succeeds.
	const dir = mkdtempSync(join(tmpdir(), 'insrc-extract-fields-fb-'));
	try {
		const path = join(dir, 'Marker.ts');
		writeFileSync(path, 'export interface Marker {\n  // intentionally fieldless marker\n}\n');

		const fakeTools: FakeToolMap = {
			code_class_locate: okTool({
				found: true, entityId: 'a'.repeat(32),
				path, line: 1, language: 'typescript', kind: 'interface',
			}),
			code_class_fields: okTool({
				entityId: 'a'.repeat(32),
				className: 'Marker',
				language: 'typescript',
				source: 'body',
				fields: [],
			}),
		};
		const { result } = await runSkillIsolated<unknown, ExtractFieldsValue & {
			bodyExcerpt?: string;
			bodyExcerptSource?: string;
		}>(
			SKILL_ID,
			{ className: 'Marker' },
			{ fakeTools },
		);
		assert.equal(result.value.found, true);
		assert.equal(result.value.fields?.length, 0);
		assert.equal(result.value.bodyExcerptSource, 'file-fallback');
		assert.match(result.value.bodyExcerpt ?? '', /Marker/);
		assert.equal(result.confidence, 'medium');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('non-empty fields -> no bodyExcerpt (structural data wins)', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate: okTool({
			found: true, entityId: 'a'.repeat(32),
			path: '/repo/Real.ts', line: 1, language: 'typescript', kind: 'class',
		}),
		code_class_fields: okTool({
			entityId: 'a'.repeat(32),
			className: 'Real',
			language: 'typescript',
			source: 'graph',
			fields: [{ name: 'id', declaredAt: { path: '/repo/Real.ts', line: 2 } }],
		}),
	};
	const { result } = await runSkillIsolated<unknown, ExtractFieldsValue & {
		bodyExcerpt?: string;
		bodyExcerptSource?: string;
	}>(
		SKILL_ID,
		{ className: 'Real' },
		{ fakeTools },
	);
	assert.equal(result.value.fields?.length, 1);
	// Even though /repo/Real.ts doesn't exist on disk, we should NOT
	// have attempted the fallback because fields was already populated.
	assert.equal(result.value.bodyExcerpt, undefined);
	assert.equal(result.value.bodyExcerptSource, undefined);
	assert.equal(result.confidence, 'high');
});

test('isAbstract from locate carries through to the output', async () => {
	setup();
	const fakeTools: FakeToolMap = {
		code_class_locate: okTool({
			found: true, entityId: 'a'.repeat(32),
			path: '/repo/Base.java', line: 4, language: 'java', kind: 'class',
			isAbstract: true,
		}),
		code_class_fields: okTool({
			entityId: 'a'.repeat(32),
			className: 'BaseHandler',
			language: 'java',
			source: 'graph',
			fields: [{ name: 'logger', declaredAt: { path: '/repo/Base.java', line: 5 } }],
		}),
	};
	const { result } = await runSkillIsolated<unknown, ExtractFieldsValue>(
		SKILL_ID,
		{ className: 'BaseHandler' },
		{ fakeTools },
	);
	assert.equal(result.value.found, true);
	assert.equal(result.value.isAbstract, true);
});
