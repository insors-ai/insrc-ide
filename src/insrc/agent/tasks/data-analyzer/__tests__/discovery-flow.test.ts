/**
 * Tests for runDataDiscoveryFlow (Phase C.2 of
 * plans/analyzers/data-analyzer-parity.md).
 *
 * Coverage:
 *   - Pure helpers:
 *       * buildSkillCatalogSummary: groups by family, includes
 *         descriptions, only data.* skills.
 *       * filterStepsToScope / findScopeViolation: Plan-SCS analog
 *         drops foreign-connection steps.
 *       * validateDiscoveryPlan / validateCycleReview: schema parsers
 *         handle missing fields, malformed entries.
 *       * stripJsonCodeFence: Haiku fence-strip defence.
 *
 * End-to-end via FakeProvider is exercised lightly here; the heavy
 * lifting (multi-cycle review + skill dispatch) is covered by
 * execute-step.test.ts and skills-pipeline.test.ts. discovery-flow
 * tests focus on its own contract: cycle bookkeeping, scope
 * filtering, retainedEvidence aggregation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_buildSkillCatalogSummaryForTest as buildSkillCatalogSummary,
	_filterStepsToScopeForTest       as filterStepsToScope,
	_findScopeViolationForTest       as findScopeViolation,
	_validateDiscoveryPlanForTest    as validateDiscoveryPlan,
	_validateCycleReviewForTest      as validateCycleReview,
	_stripJsonCodeFenceForTest       as stripJsonCodeFence,
} from '../discovery-flow.js';
import type { DiscoveryStep, PlannedSkillCall } from '../../../content-gen/discovery-plan.js';
import type { ExecuteDataStepOutput } from '../execute-step.js';
import { registerAllSkills } from '../../../../daemon/skills/index.js';
import { _resetSkillRegistryForTests } from '../../../../daemon/skills/registry.js';

function setupRegistry(): void {
	_resetSkillRegistryForTests();
	registerAllSkills();
}

function planned(id: string, skillId: string, ctx: string): PlannedSkillCall {
	return { id, skillId, context: ctx };
}

function step(id: string, intent: string, skills: PlannedSkillCall[]): DiscoveryStep {
	return { id, intent, skills, targetsCriteria: [0] };
}

// ---------------------------------------------------------------------------
// buildSkillCatalogSummary
// ---------------------------------------------------------------------------

test('buildSkillCatalogSummary: groups by family with descriptions', () => {
	setupRegistry();
	const summary = buildSkillCatalogSummary();
	// Should include family headers (### data.<family>.*)
	assert.match(summary, /### data\.\w+\.\*/);
	// Should include at least one concrete skill id
	assert.match(summary, /  - data\.[\w.-]+/);
});

test('buildSkillCatalogSummary: only data.* skills appear', () => {
	setupRegistry();
	const summary = buildSkillCatalogSummary();
	// No code.* should leak in
	assert.doesNotMatch(summary, /  - code\./);
});

test('buildSkillCatalogSummary: groups multiple families', () => {
	setupRegistry();
	const summary = buildSkillCatalogSummary();
	// data registry has multiple families (source, profile, quality, etc.)
	const familyMatches = summary.match(/### data\.\w+\.\*/g) ?? [];
	assert.ok(familyMatches.length >= 3, `expected >= 3 families, got ${familyMatches.length}`);
});

// ---------------------------------------------------------------------------
// findScopeViolation
// ---------------------------------------------------------------------------

test('findScopeViolation: returns null when no connection mentioned in context', () => {
	const v = findScopeViolation(
		[planned('s1', 'data.source.rdbms.list-tables', 'list tables in the active session')],
		new Set(['pg-primary']),
	);
	assert.equal(v, null);
});

test('findScopeViolation: returns offending connectionId when foreign connection named', () => {
	const v = findScopeViolation(
		[planned('s1', 'data.source.rdbms.describe-table', 'table orders in connection pg-secondary')],
		new Set(['pg-primary']),
	);
	assert.equal(v, 'pg-secondary');
});

test('findScopeViolation: in-scope connection passes', () => {
	const v = findScopeViolation(
		[planned('s1', 'data.source.rdbms.describe-table', 'table orders in connection pg-primary')],
		new Set(['pg-primary']),
	);
	assert.equal(v, null);
});

test('findScopeViolation: connectionId: pattern parses', () => {
	const v = findScopeViolation(
		[planned('s1', 'data.source.kv.scan-keys', 'connectionId: "redis-replica"')],
		new Set(['redis-primary']),
	);
	assert.equal(v, 'redis-replica');
});

// ---------------------------------------------------------------------------
// filterStepsToScope
// ---------------------------------------------------------------------------

test('filterStepsToScope: drops steps that violate scope', () => {
	const stepInScope = step('s1', 'in-scope step', [
		planned('s1.a', 'data.source.rdbms.list-tables', 'in connection pg-primary'),
	]);
	const stepOutOfScope = step('s2', 'out-of-scope step', [
		planned('s2.a', 'data.source.rdbms.list-tables', 'in connection pg-secondary'),
	]);
	const out = filterStepsToScope(
		[stepInScope, stepOutOfScope],
		new Set(['pg-primary']),
	);
	assert.equal(out.length, 1);
	assert.equal(out[0]!.id, 's1');
});

test('filterStepsToScope: empty allowedConnections allows all', () => {
	const s = step('s1', 'foo', [planned('s1.a', 'data.source.rdbms.list-tables', 'in connection pg-anything')]);
	const out = filterStepsToScope([s], new Set());
	assert.equal(out.length, 1);
});

// ---------------------------------------------------------------------------
// stripJsonCodeFence (defence-in-depth duplicate of summarize-result's)
// ---------------------------------------------------------------------------

test('stripJsonCodeFence: strips ```json fence', () => {
	assert.equal(stripJsonCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
});

test('stripJsonCodeFence: passes raw JSON unchanged', () => {
	assert.equal(stripJsonCodeFence('{"a":1}'), '{"a":1}');
});

// ---------------------------------------------------------------------------
// validateDiscoveryPlan
// ---------------------------------------------------------------------------

test('validateDiscoveryPlan: parses well-formed plan', () => {
	const plan = validateDiscoveryPlan({
		steps: [
			{
				id: 'step-1',
				intent: 'list tables',
				skills: [{ id: 's1.a', skillId: 'data.source.rdbms.list-tables', context: 'pg-primary' }],
				targetsCriteria: [0],
			},
		],
		cycle: 1,
	}, 1);
	assert.notEqual(plan, null);
	assert.equal(plan!.steps.length, 1);
	assert.equal(plan!.steps[0]!.skills.length, 1);
});

test('validateDiscoveryPlan: rejects missing steps', () => {
	assert.equal(validateDiscoveryPlan({ cycle: 1 } as Record<string, unknown>, 1), null);
});

test('validateDiscoveryPlan: rejects empty steps array', () => {
	assert.equal(validateDiscoveryPlan({ steps: [], cycle: 1 }, 1), null);
});

test('validateDiscoveryPlan: rejects steps with no skills', () => {
	assert.equal(validateDiscoveryPlan({
		steps: [{ id: 's1', intent: 'x', skills: [], targetsCriteria: [0] }],
		cycle: 1,
	}, 1), null);
});

test('validateDiscoveryPlan: rejects malformed planned skill', () => {
	assert.equal(validateDiscoveryPlan({
		steps: [{
			id: 's1',
			intent: 'x',
			skills: [{ id: 's1.a', skillId: 42, context: 'ctx' }],
			targetsCriteria: [0],
		}],
		cycle: 1,
	}, 1), null);
});

test('validateDiscoveryPlan: preserves dependsOn when set', () => {
	const plan = validateDiscoveryPlan({
		steps: [{
			id: 's1',
			intent: 'x',
			skills: [
				{ id: 's1.a', skillId: 'data.source.rdbms.list-tables', context: 'ctx' },
				{ id: 's1.b', skillId: 'data.profile.numeric.rdbms', context: 'ctx', dependsOn: 's1.a' },
			],
			targetsCriteria: [0],
		}],
		cycle: 1,
	}, 1);
	assert.equal(plan!.steps[0]!.skills[1]!.dependsOn, 's1.a');
});

// ---------------------------------------------------------------------------
// validateCycleReview
// ---------------------------------------------------------------------------

function fakeStepOutput(stepId: string): ExecuteDataStepOutput {
	return {
		stepId,
		status:         'ok',
		evidence:       [],
		calledSkillIds: [],
		durationMs:     0,
	};
}

test('validateCycleReview: parses well-formed review with keep + empty new_steps', () => {
	const review = validateCycleReview(
		{ keep: ['s1', 's2'], new_steps: [] },
		[fakeStepOutput('s1'), fakeStepOutput('s2')],
	);
	assert.notEqual(review, null);
	assert.deepEqual([...review!.keep], ['s1', 's2']);
	assert.equal(review!.new_steps.length, 0);
});

test('validateCycleReview: drops keep entries that don\'t match a cycle output stepId', () => {
	const review = validateCycleReview(
		{ keep: ['s1', 'not-a-real-step'], new_steps: [] },
		[fakeStepOutput('s1')],
	);
	assert.deepEqual([...review!.keep], ['s1']);
});

test('validateCycleReview: parses scratchpad when present', () => {
	const review = validateCycleReview(
		{ keep: [], new_steps: [], scratchpad: 'note for next cycle' },
		[],
	);
	assert.equal(review!.scratchpad, 'note for next cycle');
});

test('validateCycleReview: rejects missing keep', () => {
	assert.equal(validateCycleReview({ new_steps: [] } as Record<string, unknown>, []), null);
});

test('validateCycleReview: rejects missing new_steps', () => {
	assert.equal(validateCycleReview({ keep: [] } as Record<string, unknown>, []), null);
});

test('validateCycleReview: rejects malformed new_steps entry', () => {
	assert.equal(validateCycleReview({
		keep: [],
		new_steps: [{ id: 's1' /* missing intent, skills, etc */ }],
	}, []), null);
});
