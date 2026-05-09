/**
 * Tests for the legacy AnalysisTask -> skill plan shim
 * (code-analyzer-skills.md Phase 9.1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	analysisTaskToSkillPlan,
	extractEntityName,
	extractDocPath,
	ANALYSIS_KIND_SKILL_DEFAULTS,
} from '../legacy-shim.js';
import type { AnalysisTask } from '../types.js';

const REPO = '/repo/alpha';

function makeTask(opts: Partial<AnalysisTask> & { kind: AnalysisTask['kind']; question: string }): AnalysisTask {
	return {
		itemId:     opts.itemId     ?? 'item-x',
		question:   opts.question,
		kind:       opts.kind,
		origin:     opts.origin     ?? 'plan',
		retryCount: opts.retryCount ?? 0,
		...(opts.scope !== undefined ? { scope: opts.scope } : {}),
		...(opts.hint  !== undefined ? { hint:  opts.hint  } : {}),
	};
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('extractEntityName: picks the last identifier-shaped token', () => {
	assert.equal(extractEntityName('Where is parseConfig defined?'), 'defined');
	assert.equal(extractEntityName('class User'), 'User');
	assert.equal(extractEntityName('show me compute()'), 'compute');
});

test('extractEntityName: falls back to whole question when no identifier', () => {
	assert.equal(extractEntityName('???'), '???');
});

test('extractDocPath: detects .md / .markdown paths', () => {
	assert.equal(extractDocPath('Compare User class to docs/user.md spec'), 'docs/user.md');
	assert.equal(extractDocPath('see /docs/api.markdown'), '/docs/api.markdown');
	assert.equal(extractDocPath('no doc here'), undefined);
});

// ---------------------------------------------------------------------------
// Per-kind shims
// ---------------------------------------------------------------------------

test('locate -> code.entity.locate-by-name', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({ kind: 'locate', question: 'Find the parseConfig function' }),
		{ repoPath: REPO },
	);
	assert.ok(plan);
	assert.equal(plan.steps.length, 1);
	assert.equal(plan.steps[0]!.skillId, 'code.entity.locate-by-name');
	assert.equal(plan.steps[0]!.args['name'], 'function');  // last identifier in question
	assert.equal(plan.steps[0]!.args['repoPath'], REPO);
});

test('describe with entityIds -> code.entity.summary', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({
			kind: 'describe', question: 'describe X',
			scope: { entityIds: ['a'.repeat(32)] },
		}),
		{ repoPath: REPO },
	);
	assert.equal(plan?.steps[0]!.skillId, 'code.entity.summary');
	assert.equal(plan?.steps[0]!.args['entityId'], 'a'.repeat(32));
});

test('describe with paths -> code.source.file.describe', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({
			kind: 'describe', question: 'describe',
			scope: { paths: [`${REPO}/src/User.ts`] },
		}),
		{ repoPath: REPO },
	);
	assert.equal(plan?.steps[0]!.skillId, 'code.source.file.describe');
	assert.equal(plan?.steps[0]!.args['file'], `${REPO}/src/User.ts`);
});

test('describe with packages -> code.source.module.describe', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({
			kind: 'describe', question: 'describe',
			scope: { packages: [`${REPO}/src/orm`] },
		}),
		{ repoPath: REPO },
	);
	assert.equal(plan?.steps[0]!.skillId, 'code.source.module.describe');
	assert.equal(plan?.steps[0]!.args['modulePath'], `${REPO}/src/orm`);
});

test('describe with empty scope -> code.source.repo.describe', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({ kind: 'describe', question: 'describe the repo' }),
		{ repoPath: REPO },
	);
	assert.equal(plan?.steps[0]!.skillId, 'code.source.repo.describe');
	assert.equal(plan?.steps[0]!.args['repoPath'], REPO);
});

test('trace direction=both -> callers + callees', () => {
	const eid = 'a'.repeat(32);
	const plan = analysisTaskToSkillPlan(
		makeTask({
			kind: 'trace', question: 'trace',
			scope: { entityIds: [eid] },
		}),
		{ repoPath: REPO },
	);
	assert.equal(plan?.steps.length, 2);
	const ids = plan!.steps.map(s => s.skillId).sort();
	assert.deepEqual(ids, ['code.entity.callees', 'code.entity.callers']);
});

test('trace direction=callers -> only callers', () => {
	const eid = 'a'.repeat(32);
	const plan = analysisTaskToSkillPlan(
		makeTask({
			kind: 'trace', question: 'trace',
			scope: { entityIds: [eid], direction: 'callers' },
		}),
		{ repoPath: REPO },
	);
	assert.equal(plan?.steps.length, 1);
	assert.equal(plan?.steps[0]!.skillId, 'code.entity.callers');
});

test('trace without entityId -> null', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({ kind: 'trace', question: 'trace' }),
		{ repoPath: REPO },
	);
	assert.equal(plan, null);
});

test('compare with two targets -> code.compare.signature', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({
			kind: 'compare', question: 'compare A and B',
			scope: { targets: ['a'.repeat(32), 'b'.repeat(32)] },
		}),
		{ repoPath: REPO },
	);
	assert.equal(plan?.steps[0]!.skillId, 'code.compare.signature');
});

test('compare with doc-path in question -> code.compare.impl-vs-doc', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({
			kind: 'compare', question: 'Compare User class to docs/user.md',
			scope: { entityIds: ['a'.repeat(32)] },
		}),
		{ repoPath: REPO },
	);
	assert.equal(plan?.steps[0]!.skillId, 'code.compare.impl-vs-doc');
	assert.equal(plan?.steps[0]!.args['docPath'], 'docs/user.md');
});

test('compare without targets or doc-path -> null', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({ kind: 'compare', question: 'compare them' }),
		{ repoPath: REPO },
	);
	assert.equal(plan, null);
});

test('free-form -> null (route via meta-skills pipeline)', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({ kind: 'free-form', question: 'anything' }),
		{ repoPath: REPO },
	);
	assert.equal(plan, null);
});

test('empty repoPath -> null', () => {
	const plan = analysisTaskToSkillPlan(
		makeTask({ kind: 'describe', question: 'describe' }),
		{ repoPath: '' },
	);
	assert.equal(plan, null);
});

// ---------------------------------------------------------------------------
// Manifest invariants
// ---------------------------------------------------------------------------

test('ANALYSIS_KIND_SKILL_DEFAULTS lists every emitted skillId per kind', () => {
	// 'free-form' is intentionally empty (route via meta-skills pipeline).
	assert.deepEqual(ANALYSIS_KIND_SKILL_DEFAULTS['free-form'], []);
	// Each non-free-form kind must list at least one skillId.
	for (const k of ['locate', 'describe', 'trace', 'compare'] as const) {
		assert.ok(ANALYSIS_KIND_SKILL_DEFAULTS[k].length > 0, `${k} must have at least one default skillId`);
	}
});
