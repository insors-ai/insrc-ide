/**
 * Tests for the per-skill arg-rename rules (Plan 1 Phase 2).
 *
 * Two responsibilities:
 *   1. Pin every entry in `SKILL_ARG_RENAMES` against regression
 *      via a focused test per skill.
 *   2. Verify `applyArgRenames`'s conflict-resolution behavior
 *      (target already present → skip + note).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	SKILL_ARG_RENAMES,
	getArgRenames,
	applyArgRenames,
} from '../tool-call-guard-rules.js';

// ---------------------------------------------------------------------------
// SKILL_ARG_RENAMES — entry pins (regression guard)
// ---------------------------------------------------------------------------

test('SKILL_ARG_RENAMES: entity skills map id/entity_id/entity → entityId', () => {
	for (const skill of ['code.entity.summary', 'code.entity.callers', 'code.entity.callees']) {
		const renames = SKILL_ARG_RENAMES[skill]!;
		assert.ok(renames, `${skill} should have rename rules`);
		assert.equal(renames['id'],        'entityId');
		assert.equal(renames['entity_id'], 'entityId');
		assert.equal(renames['entity'],    'entityId');
	}
});

test('SKILL_ARG_RENAMES: file.describe maps path → file', () => {
	const renames = SKILL_ARG_RENAMES['code.source.file.describe']!;
	assert.equal(renames['path'],      'file');
	assert.equal(renames['file_path'], 'file');
	assert.equal(renames['filePath'],  'file');
	assert.equal(renames['repo_path'], 'repoPath');
});

test('SKILL_ARG_RENAMES: module.describe maps multiple path-like names → modulePath', () => {
	const renames = SKILL_ARG_RENAMES['code.source.module.describe']!;
	assert.equal(renames['path'],        'modulePath');
	assert.equal(renames['module_path'], 'modulePath');
	assert.equal(renames['module'],      'modulePath');
	assert.equal(renames['dir'],         'modulePath');
	assert.equal(renames['repo_path'],   'repoPath');
});

test('SKILL_ARG_RENAMES: repo.describe maps path/repo_path/repo → repoPath', () => {
	const renames = SKILL_ARG_RENAMES['code.source.repo.describe']!;
	assert.equal(renames['path'],      'repoPath');
	assert.equal(renames['repo_path'], 'repoPath');
	assert.equal(renames['repo'],      'repoPath');
});

test('SKILL_ARG_RENAMES: class skills map class_name/clazz → className', () => {
	for (const skill of ['code.class.extract-fields', 'code.class.locate-references']) {
		const renames = SKILL_ARG_RENAMES[skill]!;
		assert.ok(renames);
		assert.equal(renames['class_name'], 'className');
		assert.equal(renames['clazz'],      'className');
		assert.equal(renames['repo_path'],  'repoPath');
	}
});

test('SKILL_ARG_RENAMES: locate-by-name maps entity_name/repo_path/kind', () => {
	const renames = SKILL_ARG_RENAMES['code.entity.locate-by-name']!;
	assert.equal(renames['entity_name'], 'name');
	assert.equal(renames['repo_path'],   'repoPath');
	assert.equal(renames['kind'],        'kinds');
});

test('SKILL_ARG_RENAMES: search-by-vector maps q/text/repo_path', () => {
	const renames = SKILL_ARG_RENAMES['code.entity.search-by-vector']!;
	assert.equal(renames['q'],         'query');
	assert.equal(renames['text'],      'query');
	assert.equal(renames['repo_path'], 'repoPath');
});

test('SKILL_ARG_RENAMES: unknown skill id → empty rename map', () => {
	assert.deepEqual(getArgRenames('does.not.exist'), {});
});

test('SKILL_ARG_RENAMES: every rename value is camelCase (no snake/kebab targets)', () => {
	// Regression guard against accidentally introducing a rename
	// target that's itself a wrong name.
	for (const [skillId, renames] of Object.entries(SKILL_ARG_RENAMES)) {
		for (const [wrong, right] of Object.entries(renames)) {
			assert.ok(
				!/[_-]/.test(right),
				`${skillId}: rename '${wrong}' -> '${right}' has snake/kebab target`,
			);
			assert.ok(
				!/[A-Z]{2,}/.test(right),
				`${skillId}: rename '${wrong}' -> '${right}' has SCREAMING segment`,
			);
		}
	}
});

test('SKILL_ARG_RENAMES: no self-renames (right === wrong)', () => {
	for (const [skillId, renames] of Object.entries(SKILL_ARG_RENAMES)) {
		for (const [wrong, right] of Object.entries(renames)) {
			assert.notEqual(wrong, right, `${skillId}: self-rename for '${wrong}'`);
		}
	}
});

// ---------------------------------------------------------------------------
// applyArgRenames — conflict resolution and pass-through
// ---------------------------------------------------------------------------

test('applyArgRenames: no matching keys → input unchanged, empty notes', () => {
	const out = applyArgRenames(
		{ entityId: 'abc' },
		{ id: 'entityId' },
	);
	assert.deepEqual(out.input, { entityId: 'abc' });
	assert.equal(out.notes.length, 0);
});

test('applyArgRenames: single rename applied', () => {
	const out = applyArgRenames(
		{ id: 'abc' },
		{ id: 'entityId' },
	);
	assert.deepEqual(out.input, { entityId: 'abc' });
	assert.equal(out.notes.length, 1);
	assert.match(out.notes[0]!, /renamed arg 'id' -> 'entityId'/);
});

test('applyArgRenames: multiple renames applied', () => {
	const out = applyArgRenames(
		{ id: 'abc', repo_path: '/r' },
		{ id: 'entityId', repo_path: 'repoPath' },
	);
	assert.deepEqual(out.input, { entityId: 'abc', repoPath: '/r' });
	assert.equal(out.notes.length, 2);
});

test('applyArgRenames: target already present → skip + note', () => {
	const out = applyArgRenames(
		{ entityId: 'real', id: 'wrong' },
		{ id: 'entityId' },
	);
	// Don't overwrite -- model explicitly set entityId. Keep both
	// so the skill runner's downstream "unexpected property 'id'"
	// error still fires.
	assert.deepEqual(out.input, { entityId: 'real', id: 'wrong' });
	assert.equal(out.notes.length, 1);
	assert.match(out.notes[0]!, /skipped rename 'id' -> 'entityId'/);
	assert.match(out.notes[0]!, /target already present/);
});

test('applyArgRenames: empty rename map → input unchanged, empty notes', () => {
	const out = applyArgRenames({ id: 'abc' }, {});
	assert.deepEqual(out.input, { id: 'abc' });
	assert.equal(out.notes.length, 0);
});

test('applyArgRenames: preserves unrelated args', () => {
	const out = applyArgRenames(
		{ id: 'abc', extraArg: 42, anotherField: 'keep me' },
		{ id: 'entityId' },
	);
	assert.deepEqual(out.input, { entityId: 'abc', extraArg: 42, anotherField: 'keep me' });
});

test('applyArgRenames: rename preserves value identity (no copy)', () => {
	const valueRef = { nested: 'value' };
	const out = applyArgRenames(
		{ id: valueRef },
		{ id: 'entityId' },
	);
	assert.strictEqual(out.input['entityId'], valueRef);
});
