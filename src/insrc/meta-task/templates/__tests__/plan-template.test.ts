/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * /plan template scripted-cloud integration tests (M4.a Phase 4).
 *
 * Pins the contract end-to-end: scripted cloud responses for the 4
 * LLM-driven steps (P1, P2, P3, P5) plus the 2 deterministic runners
 * (P4 validate, P6 synth) produce a final round-trippable plan markdown.
 *
 * Plan ref: plans/meta-task-plan.md Phase 4.
 *
 * Covers:
 *   - listTemplates() includes 'plan' after registry bootstrap.
 *   - planTemplate.plan() returns 6 step descriptors with the right
 *     names + phase2 references on P4 + P6.
 *   - Per-step phase2SystemPrelude wired (verified by inspecting the
 *     phase-2 prompts the scripted cloud receives).
 *   - Memory-context M3 owner registration: subjects matching plan
 *     interests route to agent:meta-task:plan via the AssertionIndex.
 *   - End-to-end run through scripted cloud yields a completed
 *     meta-task whose synthesis body parses back via fromMarkdown.
 *   - Cycle-path: scripted P3 emits a cyclic plan -> P4 aborts
 *     plan-revisable -> meta-task ends aborted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMProvider, LLMResponse } from '../../../shared/types.js';
import { runMetaTask } from '../../orchestrator.js';
import { MetaTaskEmitter, type OutboundMessage } from '../../event-emitter.js';
import { PATHS } from '../../../shared/paths.js';
import { listTemplates, type MetaTaskTemplate } from '../../templates/index.js';
import { planTemplate } from '../plan.js';
import { fromMarkdown } from '../../../agent/planner/markdown.js';
import {
	_resetSubstrateRuntimeForTests,
	getSubstrateRuntime,
	initSubstrateRuntime,
	registerAgentChatOwner,
} from '../../../daemon/substrate/singleton.js';
import { registerKnownTemplatesWithSubstrate } from '../../templates/index.js';
import type { Plan } from '../plan-types.js';

// Bootstrap the template registry so listTemplates() resolves both.
import '../../templates/index.js';


// ---------------------------------------------------------------------------
// Helpers (mirror orchestrator.test.ts patterns)
// ---------------------------------------------------------------------------

interface RecordedCall { messages: { role: string; content: string }[]; opts: unknown }
interface RecordingCloud extends LLMProvider { calls: RecordedCall[] }

function recordingCloud(responses: readonly string[]): RecordingCloud {
	let idx = 0;
	const calls: RecordedCall[] = [];
	return {
		calls,
		async complete(messages: unknown, opts: unknown): Promise<LLMResponse> {
			calls.push({ messages: messages as RecordedCall['messages'], opts });
			const text = responses[idx++] ?? '';
			return { text, stopReason: 'end_turn' };
		},
		stream(): AsyncIterable<string> { return (async function* () { yield ''; })(); },
		async embed(): Promise<number[]> { return []; },
	};
}

function noopProvider(): LLMProvider {
	return {
		async complete() { throw new Error('noopProvider.complete: should not be invoked'); },
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
	};
}

class FakeTodosApi {
	calls: string[] = [];
	private listCounter = 0;
	private itemCounter = 0;
	async createList(opts: { title: string }): Promise<{ id: string }> {
		this.calls.push(`createList:${opts.title}`);
		return { id: `list-${++this.listCounter}` };
	}
	async addItem(listId: string, opts: { title: string }): Promise<{ id: string }> {
		this.calls.push(`addItem:${listId}:${opts.title}`);
		return { id: `item-${++this.itemCounter}` };
	}
	async markInProgress(id: string): Promise<unknown> { this.calls.push(`markInProgress:${id}`); return {}; }
	async markComplete(id: string):   Promise<unknown> { this.calls.push(`markComplete:${id}`);   return {}; }
	async markBlocked(id: string, reason: string): Promise<unknown> { this.calls.push(`markBlocked:${id}:${reason}`); return {}; }
	async updateListBody(id: string, _body: string): Promise<unknown> { this.calls.push(`updateListBody:${id}`); return {}; }
}

function setupEnv(): { home: string; restore: () => void } {
	const home = mkdtempSync(join(tmpdir(), 'mt-plan-'));
	const restoreHome = process.env.HOME;
	process.env.HOME = home;
	const originalMeta = PATHS.meta;
	(PATHS as { meta: string }).meta = join(home, '.insrc', 'meta');
	return {
		home,
		restore: () => {
			(PATHS as { meta: string }).meta = originalMeta;
			if (restoreHome !== undefined) { process.env.HOME = restoreHome; }
			try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

function makeEmitter(): { emit: MetaTaskEmitter; todos: FakeTodosApi; events: OutboundMessage[] } {
	const events: OutboundMessage[] = [];
	const todos = new FakeTodosApi();
	const emit  = new MetaTaskEmitter({
		send: m => events.push(m),
		todos: todos as unknown as MetaTaskEmitter['todos'],
	});
	return { emit, todos, events };
}


// ---------------------------------------------------------------------------
// Scripted cloud bodies for the 4 LLM-driven steps
// ---------------------------------------------------------------------------

const P1_ANALYSIS_BODY = JSON.stringify({
	category:    'implementation',
	subCategory: 'new-feature',
	goals:       ['ship a token-bucket rate limiter', 'document operational defaults'],
	constraints: ['no new dependencies'],
	scope:       'medium',
});

const P2_GATHER_BODY = `# Codebase Context

## Relevant Entities
- src/v1/sessions.ts: existing request handler we'll wrap

## Prior Decisions / Memory
- Token-bucket discussed at architecture sync 2026-04-12

## Config / Conventions
- 60s default window per the existing auth middleware`;

const P3_DRAFT_BODY = JSON.stringify([
	{ title: 'Define limiter config schema', description: 'Add TokenBucketConfig type with rate + burst fields', dependsOnIdx: [],  complexity: 'low'    },
	{ title: 'Implement bucket primitive',   description: 'Pure data class with `tryConsume(n)` API',           dependsOnIdx: [0], complexity: 'medium' },
	{ title: 'Wire to /v1/sessions',         description: 'Add middleware that calls the limiter per request',  dependsOnIdx: [1], complexity: 'medium' },
	{ title: 'Document defaults',            description: 'Update API docs with the new rate-limit headers',    dependsOnIdx: [2], complexity: 'low'    },
]);

const P5_DETAIL_BODY = JSON.stringify([
	{ stepIndex: 0, data: { filePaths: ['src/limiter/types.ts'] } },
	{ stepIndex: 1, data: { filePaths: ['src/limiter/bucket.ts'] } },
	{ stepIndex: 2, data: { filePaths: ['src/v1/sessions.ts'] } },
	{ stepIndex: 3, data: { filePaths: ['docs/api/rate-limits.md'] } },
]);

function plan6StepCloudScript(): readonly string[] {
	return [
		// Per-step: phase-1 ask (declare sufficient -> skip fetcher), then phase-2 body.
		// P1
		JSON.stringify({ kind: 'sufficient' }),
		JSON.stringify({ kind: 'deliverable', body: P1_ANALYSIS_BODY }),
		// P2
		JSON.stringify({ kind: 'sufficient' }),
		JSON.stringify({ kind: 'deliverable', body: P2_GATHER_BODY }),
		// P3
		JSON.stringify({ kind: 'sufficient' }),
		JSON.stringify({ kind: 'deliverable', body: P3_DRAFT_BODY }),
		// P4: phase-1 ask (cloud declares sufficient even though P4 won't use it)
		JSON.stringify({ kind: 'sufficient' }),
		// P4's phase-2 is the Phase2Runner -- NO cloud call.
		// P5
		JSON.stringify({ kind: 'sufficient' }),
		JSON.stringify({ kind: 'deliverable', body: P5_DETAIL_BODY }),
		// P6: phase-1 ask, then NO cloud call (Phase2Runner).
		JSON.stringify({ kind: 'sufficient' }),
	];
}


// ---------------------------------------------------------------------------
// Shape sanity
// ---------------------------------------------------------------------------

test('planTemplate: declares 6 step descriptors with correct names + phase2 wiring', () => {
	const plan = planTemplate.plan({
		intent: 'x', repoPath: '/r', inScopeGlobs: ['**'], outOfScopePaths: [],
	});
	assert.equal(plan.steps.length, 6);
	const names = plan.steps.map(s => s.name);
	assert.deepEqual(names, ['P1 analyze', 'P2 gather', 'P3 draft', 'P4 validate', 'P5 detail', 'P6 synth']);

	// P4 + P6 use the escape hatch; the others go through the default LLM path.
	assert.ok(plan.steps[3]!.phase2 !== undefined, 'P4 must wire phase2 runner');
	assert.ok(plan.steps[5]!.phase2 !== undefined, 'P6 must wire phase2 runner');
	assert.equal(plan.steps[0]!.phase2, undefined, 'P1 should NOT have a runner');
	assert.equal(plan.steps[1]!.phase2, undefined, 'P2 should NOT have a runner');
	assert.equal(plan.steps[2]!.phase2, undefined, 'P3 should NOT have a runner');
	assert.equal(plan.steps[4]!.phase2, undefined, 'P5 should NOT have a runner');

	// Each LLM step ships a per-step prelude.
	assert.ok(plan.steps[0]!.phase2SystemPrelude !== undefined);
	assert.ok(plan.steps[1]!.phase2SystemPrelude !== undefined);
	assert.ok(plan.steps[2]!.phase2SystemPrelude !== undefined);
	assert.ok(plan.steps[4]!.phase2SystemPrelude !== undefined);
});

test('planTemplate: registered in builtin manifest -- listTemplates() returns it', () => {
	const ids = listTemplates().map((t: MetaTaskTemplate) => t.id);
	assert.ok(ids.includes('plan'),   `expected 'plan' in builtin templates, got ${ids.join(', ')}`);
	assert.ok(ids.includes('review'), 'review still registered');
});


// ---------------------------------------------------------------------------
// Memory-context M3: assertion routing
// ---------------------------------------------------------------------------

test('planTemplate: M3 owner registration -- test-policy routes to agent:meta-task:plan', async () => {
	_resetSubstrateRuntimeForTests();
	const dir = mkdtempSync(join(tmpdir(), 'plan-route-'));
	try {
		const runtime = initSubstrateRuntime({
			localProvider: noopProvider(),
			workspaceId:   'plan-route',
			rootDir:       dir,
		});
		registerAgentChatOwner(runtime);
		registerKnownTemplatesWithSubstrate();

		const owners = getSubstrateRuntime().assertionIndex
			.lookup('test-policy').map(m => m.owner);
		assert.ok(owners.includes('agent:meta-task:plan'),
			`expected 'agent:meta-task:plan' in matches, got ${owners.join(', ')}`);
		assert.ok(owners.includes('agent:chat'), 'chat owner still routed (M-C M1)');
	} finally {
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});


// ---------------------------------------------------------------------------
// End-to-end scripted-cloud round trip
// ---------------------------------------------------------------------------

test('runMetaTask /plan: scripted-cloud round-trip across all 6 steps', async () => {
	const env = setupEnv();
	try {
		const { emit, todos } = makeEmitter();
		const cloud = recordingCloud(plan6StepCloudScript());
		const result = await runMetaTask({
			templateId: 'plan',
			intent:     'ship a token-bucket rate limiter for /v1/sessions',
			scope: {
				intent: 'ship a token-bucket rate limiter for /v1/sessions',
				repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId: 'sess-plan-1',
			emit, cloud,
			embed: async () => [],
			allocId: () => 'mt-plan-1',
		});

		assert.equal(result.outcome, 'completed', 'meta-task should complete end-to-end');
		assert.equal(result.deliverables.size, 6, 'all 6 step deliverables persisted');

		// Sanity-check per-step content.
		assert.match(result.deliverables.get(1)!, /new-feature/);
		assert.match(result.deliverables.get(2)!, /Codebase Context/);
		assert.match(result.deliverables.get(3)!, /TokenBucketConfig|tryConsume/);
		assert.match(result.deliverables.get(4)!, /Validation pass/);
		assert.match(result.deliverables.get(5)!, /filePaths/);
		const synth = result.deliverables.get(6)!;
		assert.match(synth, /^---/m);                                 // YAML frontmatter
		assert.match(synth, /implementation plan/);

		// Round-trip via fromMarkdown -- the deliverable contract per design §5.
		const reconstructed = fromMarkdown<unknown>(synth) as Plan;
		assert.equal(reconstructed.steps.length, 4);
		assert.equal(reconstructed.steps[0]!.title, 'Define limiter config schema');
		assert.equal(reconstructed.steps[3]!.title, 'Document defaults');

		// TodoList lifecycle: createList + 6 addItems + 6 markCompletes.
		assert.equal(todos.calls.filter(c => c.startsWith('createList:')).length, 1);
		assert.equal(todos.calls.filter(c => c.startsWith('addItem:')).length,    6);
		assert.equal(todos.calls.filter(c => c.startsWith('markComplete:')).length, 6);
	} finally { env.restore(); }
});


// ---------------------------------------------------------------------------
// Cycle path: P4 validate aborts on a cyclic P3 draft
// ---------------------------------------------------------------------------

test('runMetaTask /plan: cycle in P3 draft -> P4 aborts plan-revisable', async () => {
	const env = setupEnv();
	try {
		const cyclicDraft = JSON.stringify([
			{ title: 'a', description: 'A', dependsOnIdx: [2] },
			{ title: 'b', description: 'B', dependsOnIdx: [0] },
			{ title: 'c', description: 'C', dependsOnIdx: [1] },
		]);

		const { emit, todos } = makeEmitter();
		const cloud = recordingCloud([
			// P1
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: P1_ANALYSIS_BODY }),
			// P2
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: 'gather body' }),
			// P3 (cyclic)
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: cyclicDraft }),
			// P4 phase-1 ask (the runner fires after; no phase-2 cloud call).
			JSON.stringify({ kind: 'sufficient' }),
		]);

		const result = await runMetaTask({
			templateId: 'plan',
			intent:     'cyclic',
			scope: { intent: 'cyclic', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [] },
			sessionId: 'sess-plan-2',
			emit, cloud,
			embed: async () => [],
			allocId: () => 'mt-plan-2',
		});

		assert.equal(result.outcome, 'aborted');
		assert.match(result.abortReason ?? '', /plan-revisable/);
		assert.match(result.abortReason ?? '', /cycle/);
		assert.ok(todos.calls.some(c => c.startsWith('markBlocked:')));
	} finally { env.restore(); }
});


// ---------------------------------------------------------------------------
// Per-step prelude reaches the cloud (verifies Phase 4's prelude addendum)
// ---------------------------------------------------------------------------

test('runMetaTask /plan: per-step phase2SystemPrelude reaches the cloud LLM', async () => {
	const env = setupEnv();
	try {
		const { emit } = makeEmitter();
		const cloud = recordingCloud([
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: P1_ANALYSIS_BODY }),
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: 'gather' }),
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: '[]' }),     // P3 emits empty -> P4 aborts
			JSON.stringify({ kind: 'sufficient' }),                  // P4 phase-1
		]);

		await runMetaTask({
			templateId: 'plan',
			intent:     'prelude check',
			scope: { intent: 'prelude check', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [] },
			sessionId: 'sess-plan-3',
			emit, cloud,
			embed: async () => [],
			allocId: () => 'mt-plan-3',
		});

		// The phase-2 prompts (even-indexed cloud calls from 1) carry the
		// per-step prelude. Pull the P1 phase-2 prompt.
		const p1Phase2 = cloud.calls[1]!;
		const prompt = p1Phase2.messages.find(m => m.role === 'user')?.content ?? '';
		// PLAN_ANALYZE prelude mentions "CATEGORY" and the closed-enum list.
		assert.match(prompt, /CATEGORY/);
		assert.match(prompt, /implementation \| migration \| test/);

		// P3 phase-2 prompt carries the combined draft prelude.
		const p3Phase2 = cloud.calls[5]!;
		const p3Prompt = p3Phase2.messages.find(m => m.role === 'user')?.content ?? '';
		assert.match(p3Prompt, /refined, production-ready/i);
	} finally { env.restore(); }
});
