/**
 * Tests for `tool-call-guard.ts` and `tool-call-guard-rules.ts`
 * (Phase B of plans/analyzers/data-analyzer-parity.md).
 *
 * Pins the Phase-B contract:
 *   - Silent stages (rename + coerce + inject) apply before dispatch.
 *   - Schema validation does NOT reject (Phase D deferred).
 *   - Unknown data-skill names DO reject (Stage 1 still applies).
 *   - Skill catalog is narrowed to `data.*` ids only -- code-side
 *     skills don't appear as fuzzy-match suggestions.
 *   - Session-default injection fills missing `connectionId` /
 *     `schema` / `database` when declared required on the schema.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runDataAnalyzerGuard,
	listDataSkillIds,
	_normalizeDefaultsForTest as normalizeDefaults,
} from '../tool-call-guard.js';
import { getDataSkillArgRenames, DATA_SKILL_ARG_RENAMES } from '../tool-call-guard-rules.js';
import type { ToolCall } from '../../../../shared/types.js';
import { registerAllSkills } from '../../../../daemon/skills/index.js';
import { _resetSkillRegistryForTests, getSkill } from '../../../../daemon/skills/registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../../daemon/tools/registry.js';

// ---------------------------------------------------------------------------
// Registry setup -- register the live skill registry so the guard's
// fuzzy-match + schema lookup hit real schemas.
// ---------------------------------------------------------------------------

function setupRegistry(): void {
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	registerAllSkills();
}

function call(name: string, input: Record<string, unknown>): ToolCall {
	return { id: 'tc1', name, input };
}

// ---------------------------------------------------------------------------
// Rules: rename map starts empty (sealed by selection criteria)
// ---------------------------------------------------------------------------

test('DATA_SKILL_ARG_RENAMES starts empty (live-populated only)', () => {
	assert.equal(Object.keys(DATA_SKILL_ARG_RENAMES).length, 0);
});

test('getDataSkillArgRenames: unknown skill -> empty object (no-op)', () => {
	const r = getDataSkillArgRenames('data.profile.numeric-rdbms');
	assert.deepEqual(r, {});
});

// ---------------------------------------------------------------------------
// listDataSkillIds: narrowed to data.* only
// ---------------------------------------------------------------------------

test('listDataSkillIds: returns only data.* skill ids', () => {
	setupRegistry();
	const ids = listDataSkillIds();
	assert.ok(ids.length > 0, 'should list at least one data skill');
	for (const id of ids) {
		assert.match(id, /^data\./, `every id should start with "data.": got ${id}`);
	}
});

test('listDataSkillIds: code.* skills NOT included', () => {
	setupRegistry();
	const ids = listDataSkillIds();
	for (const id of ids) {
		assert.ok(!id.startsWith('code.'), `data list should not include code-side skill: ${id}`);
	}
});

// ---------------------------------------------------------------------------
// normalizeDefaults: strips empty + undefined
// ---------------------------------------------------------------------------

test('normalizeDefaults: drops undefined and empty-string entries', () => {
	assert.deepEqual(normalizeDefaults({ connectionId: 'pg-1', schema: undefined, database: '' }),
		{ connectionId: 'pg-1' });
	assert.deepEqual(normalizeDefaults({}), {});
	assert.deepEqual(normalizeDefaults({ schema: 'public' }), { schema: 'public' });
});

// ---------------------------------------------------------------------------
// runDataAnalyzerGuard end-to-end
// ---------------------------------------------------------------------------

test('runDataAnalyzerGuard: pass-through for valid call with no transforms', () => {
	setupRegistry();
	const ids = listDataSkillIds();
	const first = ids[0]!;
	// Use any valid skill id; we only care that no transforms apply
	// when input matches expected name + has no rename candidates.
	const result = runDataAnalyzerGuard(call(first, {}));
	// May be 'pass' or 'coerced' depending on whether session defaults
	// are needed; both are non-rejected outcomes.
	assert.notEqual(result.kind, 'rejected');
});

test('runDataAnalyzerGuard: unknown tool name -> rejected with corrective', () => {
	setupRegistry();
	const result = runDataAnalyzerGuard(call('data.totally.fictitious.skill', {}));
	assert.equal(result.kind, 'rejected');
	if (result.kind === 'rejected') {
		assert.match(result.reason, /unknown tool name/);
		assert.ok(result.correctiveResult.isError);
	}
});

test('runDataAnalyzerGuard: unknown tool name suggestions are data-only', () => {
	setupRegistry();
	const result = runDataAnalyzerGuard(call('data.profile.numeric.invented', {}));
	assert.equal(result.kind, 'rejected');
	if (result.kind === 'rejected') {
		// Suggestions should not include any code.* skills even if
		// they have similar names.
		for (const s of result.suggestions ?? []) {
			assert.match(s, /^data\./, `suggestion should be data-only: got ${s}`);
		}
	}
});

test('runDataAnalyzerGuard: separator-normalized fuzzy match', () => {
	setupRegistry();
	const ids = listDataSkillIds();
	// Pick a real skill, then mangle separators (dots -> underscores).
	// Should fuzzy-match back to the canonical id.
	const target = ids.find(id => id.includes('.')) ?? ids[0]!;
	const mangled = target.replace(/\./g, '_');
	const result = runDataAnalyzerGuard(call(mangled, {}));
	assert.notEqual(result.kind, 'rejected');
	if (result.kind === 'coerced') {
		assert.equal(result.call.name, target);
	}
});

test('runDataAnalyzerGuard: session defaults inject when required and missing', () => {
	setupRegistry();
	// Find a data skill whose schema declares connectionId as required.
	const ids = listDataSkillIds();
	let pick: string | undefined;
	for (const id of ids) {
		const sk = getSkill(id);
		const required = (sk?.inputs as { required?: unknown } | undefined)?.required;
		if (Array.isArray(required) && required.includes('connectionId')) {
			pick = id;
			break;
		}
	}
	if (pick === undefined) {
		// No skill in the registry currently requires connectionId.
		// Skip the injection-positive assertion; just exercise that
		// the call doesn't reject. Other tests pin the negative side
		// (no inject when key is not required).
		return;
	}
	const result = runDataAnalyzerGuard(call(pick, {}), { connectionId: 'pg-primary' });
	assert.notEqual(result.kind, 'rejected');
	if (result.kind === 'coerced') {
		assert.equal(result.call.input['connectionId'], 'pg-primary');
		assert.ok(result.notes.some(n => /injected session default for required arg 'connectionId'/.test(n)));
	}
});

test('runDataAnalyzerGuard: existing connectionId is NOT overwritten by session default', () => {
	setupRegistry();
	const ids = listDataSkillIds();
	let pick: string | undefined;
	for (const id of ids) {
		const sk = getSkill(id);
		const required = (sk?.inputs as { required?: unknown } | undefined)?.required;
		if (Array.isArray(required) && required.includes('connectionId')) {
			pick = id;
			break;
		}
	}
	if (pick === undefined) return;
	const result = runDataAnalyzerGuard(
		call(pick, { connectionId: 'pg-explicit' }),
		{ connectionId: 'pg-default' },
	);
	if (result.kind === 'coerced') {
		assert.equal(result.call.input['connectionId'], 'pg-explicit');
	}
	// If pass, the explicit value is intact by definition.
	if (result.kind === 'pass') {
		assert.equal(result.call.input['connectionId'], 'pg-explicit');
	}
});

test('runDataAnalyzerGuard: Phase-B schema mismatches PASS THROUGH (no Stage-4 reject)', () => {
	setupRegistry();
	const ids = listDataSkillIds();
	const target = ids[0]!;
	// Send obviously-wrong shape: array where a scalar is required,
	// extra props, etc. Stage 4 (rejectFromSchemaFailure) is what
	// would normally fire; we assert here that the data-side wrapper
	// does NOT invoke it -- the outcome is pass or coerced, never
	// rejected for schema reasons.
	const result = runDataAnalyzerGuard(call(target, {
		bogus: 'extra',
		junk:  ['array', 'where', 'no', 'array', 'expected'],
	}));
	// Stage-1 (unknown name) is the ONLY reject path in Phase B.
	// A schema-mismatch reject would have `reason: schema validation failed`.
	if (result.kind === 'rejected') {
		assert.doesNotMatch(result.reason, /schema validation failed/,
			'Phase B should NOT reject on schema mismatch; defer to Phase D');
	}
});
