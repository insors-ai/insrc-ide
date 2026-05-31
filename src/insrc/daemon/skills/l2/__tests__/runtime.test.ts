/**
 * L2 runtime unit tests -- P7.7.
 *
 * Deterministic fakes only. Live LLM testing for L2 lands with the
 * pilot skill in a separate phase.
 *
 * Coverage:
 *   - End-to-end happy path: runtime invokes the body, validates
 *     output, returns the L2RunResult.
 *   - Input schema validation rejects on bad input.
 *   - Output schema validation rejects on bad output shape.
 *   - Grounding rejection on dangling LedgerRef.
 *   - Budget: token overflow inside the skill body surfaces as
 *     budget-exceeded rejection.
 *   - Budget: callL1 reserves a sub-call slot.
 *   - Sub-call dispatch: callL1 forwards to runSkill + appends to
 *     ledger + emits start/finish events.
 *   - Nested callL2: depth cap enforced; over-depth throws.
 *   - LLM access: token usage is charged against the budget.
 *   - selfGroundingMode='none' opt-out lets the runtime accept
 *     citation-free output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _resetSkillRegistryForTests, registerSkill } from '../../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../tools/registry.js';
import { _resetL2RegistryForTests, registerL2Skill } from '../registry.js';
import { runL2Skill } from '../runtime.js';
import { DefaultSkillAuditLog } from '../../audit.js';
import { DefaultAccessStore, DefaultAccessAuditLog } from '../../../../shared/access.js';

import type { LLMProvider } from '../../../../shared/types.js';
import type { Session } from '../../../../agent/session.js';
import type { Skill, SkillResult } from '../../types.js';
import type {
	L2Deps,
	L2Event,
	L2Invocation,
	L2Skill,
	SkillBudget,
	SkillOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function fakeSession(): Session {
	const stub: Record<string, unknown> = {
		id: 'test-session',
		repoPath: '/repo/test',
		closureRepos: ['/repo/test'],
		startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

function fakeProvider(opts?: {
	readonly response?: string;
	readonly usageTokens?: number;
}): LLMProvider {
	const text  = opts?.response ?? 'ok';
	const usage = opts?.usageTokens;
	return {
		complete: async () => ({
			text,
			stopReason: 'end_turn' as const,
			...(usage !== undefined
				? { usage: { inputTokens: Math.floor(usage / 2), outputTokens: usage - Math.floor(usage / 2) } }
				: {}),
		}),
		stream:   async function* () { yield ''; },
		embed:    async () => [],
		supportsTools: false,
	};
}

const STANDARD_BUDGET: SkillBudget = {
	maxTokens:      10_000,
	maxSubCalls:    8,
	maxWallclockMs: 30_000,
	maxDepth:       3,
};

function makeL2Skill<O>(opts: {
	readonly id?:       string;
	readonly run:       L2Skill<{ q: string }, O>['run'];
	readonly outputs?:  Record<string, unknown>;
	readonly selfGroundingMode?: 'structured' | 'none';
	readonly defaultBudget?: SkillBudget;
}): L2Skill<{ q: string }, O> {
	return {
		id:            opts.id ?? 'test.l2.fixture',
		name:          'L2 test fixture',
		description:   'unit test fixture',
		family:        'meta',
		owner:         'data-analyzer',
		version:       1,
		inputs:        {
			type: 'object',
			properties: { q: { type: 'string', minLength: 1 } },
			required: ['q'],
		},
		outputs:       opts.outputs ?? {
			type: 'object',
			properties: {
				// Permissive: tests pass plain strings / numbers / objects as value.
				evidence:   { type: 'array' },
				confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
				notes:      { type: 'array' },
			},
			required: ['value', 'evidence', 'confidence'],
		},
		defaultBudget: opts.defaultBudget ?? STANDARD_BUDGET,
		...(opts.selfGroundingMode !== undefined ? { selfGroundingMode: opts.selfGroundingMode } : {}),
		run:           opts.run,
	};
}

// Run-around the test isolation: reset the global skill + tool + L2
// registries before each test.
function setup(): void {
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	_resetL2RegistryForTests();
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('runtime: happy path -- skill returns grounded output', async () => {
	setup();
	const skill = makeL2Skill<{ x: number }>({
		async run(_inv: L2Invocation<{ q: string }>, deps: L2Deps): Promise<SkillOutput<{ x: number }>> {
			const ref = deps.workingState.append({
				source: { kind: 'internal' }, payload: { src: 'x' }, claims: [], confidence: 0.9,
			});
			return {
				value:      { x: 42 },
				evidence:   [{ claim: 'x = 42 per fixture', citations: [ref] }],
				confidence: 'high',
			};
		},
	});

	const result = await runL2Skill(skill, { input: { q: 'test' }, invocationContext: {} }, {
		session:         fakeSession(),
		resolveProvider: () => fakeProvider(),
	});

	assert.equal(result.rejected, undefined);
	assert.equal(result.output.value.x, 42);
	assert.equal(result.output.confidence, 'high');
	assert.equal(result.output.evidence.length, 1);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('runtime: input schema rejection surfaces as input-validation', async () => {
	setup();
	const skill = makeL2Skill<unknown>({
		async run(): Promise<SkillOutput<unknown>> {
			throw new Error('should not be called');
		},
	});

	const result = await runL2Skill(skill,
		// Wrong shape -- missing required field `q`.
		{ input: {} as unknown as { q: string }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider() },
	);

	assert.ok(result.rejected, 'expected rejection');
	assert.equal(result.rejected.reason, 'input-validation');
});

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

test('runtime: output schema rejection on missing required field', async () => {
	setup();
	const skill = makeL2Skill({
		// outputs schema requires `value` -- skill returns without it.
		outputs: {
			type: 'object',
			properties: { value: { type: 'number' }, evidence: { type: 'array' }, confidence: { type: 'string' } },
			required: ['value', 'evidence', 'confidence'],
		},
		async run(): Promise<SkillOutput<unknown>> {
			return {
				evidence:   [],
				confidence: 'high',
			} as unknown as SkillOutput<unknown>;
		},
	});

	const result = await runL2Skill(skill,
		{ input: { q: 'test' }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider() },
	);

	assert.ok(result.rejected);
	assert.equal(result.rejected.reason, 'output-validation');
});

// ---------------------------------------------------------------------------
// Grounding rejection
// ---------------------------------------------------------------------------

test('runtime: dangling LedgerRef -> grounding rejection', async () => {
	setup();
	const skill = makeL2Skill<{ x: number }>({
		async run(): Promise<SkillOutput<{ x: number }>> {
			return {
				value:      { x: 1 },
				evidence:   [{ claim: 'phantom', citations: ['ghost-ref'] }],
				confidence: 'high',
			};
		},
	});

	const result = await runL2Skill(skill,
		{ input: { q: 'test' }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider() },
	);

	assert.ok(result.rejected);
	assert.equal(result.rejected.reason, 'grounding');
	assert.match(result.rejected.detail, /does not resolve/);
});

test('runtime: selfGroundingMode=none accepts citation-free output', async () => {
	setup();
	const skill = makeL2Skill<{ x: number }>({
		selfGroundingMode: 'none',
		async run(): Promise<SkillOutput<{ x: number }>> {
			return {
				value:      { x: 1 },
				evidence:   [],
				confidence: 'high',
			};
		},
	});

	const result = await runL2Skill(skill,
		{ input: { q: 'test' }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider() },
	);
	assert.equal(result.rejected, undefined);
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

test('runtime: token overflow inside body -> budget-exceeded rejection', async () => {
	setup();
	const skill = makeL2Skill<unknown>({
		defaultBudget: { maxTokens: 50, maxSubCalls: 8, maxWallclockMs: 30_000, maxDepth: 3 },
		async run(_inv: L2Invocation<{ q: string }>, deps: L2Deps): Promise<SkillOutput<unknown>> {
			// Force a charge that exceeds the budget.
			await deps.llm.complete([{ role: 'user', content: 'hi' }], { maxTokens: 100 });
			return { value: 'x', evidence: [], confidence: 'high' };
		},
	});

	const result = await runL2Skill(skill,
		{ input: { q: 'test' }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider({ usageTokens: 100 }) },
	);

	assert.ok(result.rejected);
	assert.equal(result.rejected.reason, 'budget-exceeded');
});

test('runtime: subCalls cap enforced via callL1', async () => {
	setup();

	// Register an L1 fixture skill that returns a trivial result.
	const l1: Skill<unknown, unknown> = {
		id:               'test.l1.no-op',
		name:             'no-op',
		description:      'returns ok',
		family:           'meta',
		owner:            'data-analyzer',
		version:          1,
		inputs:           { type: 'object' },
		outputs:          { type: 'object' },
		toolDeps:         [],
		providerAffinity: 'auto',
		async execute(): Promise<SkillResult<unknown>> {
			return { value: 'ok', confidence: 'high', toolCalls: [] };
		},
	};
	registerSkill(l1);

	const skill = makeL2Skill<unknown>({
		defaultBudget: { maxTokens: 10_000, maxSubCalls: 2, maxWallclockMs: 30_000, maxDepth: 3 },
		async run(_inv: L2Invocation<{ q: string }>, deps: L2Deps): Promise<SkillOutput<unknown>> {
			// Make 3 sub-calls; cap is 2, so the third throws BudgetExceededError.
			await deps.callL1('test.l1.no-op', {});
			await deps.callL1('test.l1.no-op', {});
			await deps.callL1('test.l1.no-op', {});  // throws
			return { value: 'should not return', evidence: [], confidence: 'high' };
		},
	});

	const result = await runL2Skill(skill,
		{ input: { q: 'test' }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider() },
	);

	assert.ok(result.rejected);
	assert.equal(result.rejected.reason, 'budget-exceeded');
});

// ---------------------------------------------------------------------------
// Sub-call dispatch (callL1)
// ---------------------------------------------------------------------------

test('runtime: callL1 dispatches + auto-appends to ledger + emits events', async () => {
	setup();
	const l1: Skill<unknown, unknown> = {
		id: 'test.l1.echo', name: 'echo', description: 'echoes input',
		family: 'meta', owner: 'data-analyzer', version: 1,
		inputs: { type: 'object' }, outputs: { type: 'object' },
		toolDeps: [], providerAffinity: 'auto',
		async execute(input): Promise<SkillResult<unknown>> {
			return { value: { echoed: input }, confidence: 'high', toolCalls: [] };
		},
	};
	registerSkill(l1);

	const events: L2Event[] = [];
	const ledgerCountsBeforeAndAfter: number[] = [];

	const skill = makeL2Skill<unknown>({
		async run(_inv: L2Invocation<{ q: string }>, deps: L2Deps): Promise<SkillOutput<unknown>> {
			ledgerCountsBeforeAndAfter.push(deps.workingState.list().length);
			const r = await deps.callL1('test.l1.echo', { x: 99 });
			ledgerCountsBeforeAndAfter.push(deps.workingState.list().length);
			// Cite the auto-appended sub-call ledger entry.
			const last = deps.workingState.list()[deps.workingState.list().length - 1]!;
			return {
				value:      r.value,
				evidence:   [{ claim: 'echo returned', citations: [last.ref] }],
				confidence: 'high',
			};
		},
	});

	const result = await runL2Skill(skill,
		{ input: { q: 'test' }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider(),
		  emit: (e) => events.push(e) },
	);

	assert.equal(result.rejected, undefined);
	assert.equal(ledgerCountsBeforeAndAfter[0], 0, 'ledger empty before sub-call');
	assert.equal(ledgerCountsBeforeAndAfter[1], 1, 'sub-call result auto-appended');
	assert.ok(events.some(e => e.kind === 'sub-call-started'));
	assert.ok(events.some(e => e.kind === 'sub-call-finished'));
	assert.ok(events.some(e => e.kind === 'returning'));
});

// ---------------------------------------------------------------------------
// Nested callL2 + depth cap
// ---------------------------------------------------------------------------

test('runtime: nested callL2 chain respects depth cap', async () => {
	setup();

	// Register a recursive L2 skill.
	const recursive: L2Skill<{ q: string }, unknown> = makeL2Skill({
		id:            'test.l2.recursive',
		defaultBudget: { maxTokens: 10_000, maxSubCalls: 50, maxWallclockMs: 30_000, maxDepth: 3 },
		async run(inv, deps): Promise<SkillOutput<unknown>> {
			// Recurse depth times until depth cap.
			await deps.callL2<{ q: string }, unknown>(
				{ input: { q: inv.input.q }, invocationContext: {} },
				{ id: 'test.l2.recursive' },
			);
			return { value: 'done', evidence: [], confidence: 'high' };
		},
		selfGroundingMode: 'none',
	});
	registerL2Skill(recursive);

	const result = await runL2Skill(recursive,
		{ input: { q: 'test' }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider() },
	);

	// Top-level call rejects because the recursive callL2 chain blows depth.
	assert.ok(result.rejected);
});

// ---------------------------------------------------------------------------
// LLM token accounting
// ---------------------------------------------------------------------------

test('runtime: LLM token usage is charged against the budget', async () => {
	setup();
	const skill = makeL2Skill<unknown>({
		defaultBudget: { maxTokens: 1_000, maxSubCalls: 8, maxWallclockMs: 30_000, maxDepth: 3 },
		async run(_inv: L2Invocation<{ q: string }>, deps: L2Deps): Promise<SkillOutput<unknown>> {
			await deps.llm.complete([{ role: 'user', content: 'hi' }]);
			return { value: 'x', evidence: [], confidence: 'high' };
		},
		selfGroundingMode: 'none',
	});

	const result = await runL2Skill(skill,
		{ input: { q: 'test' }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider({ usageTokens: 250 }) },
	);

	assert.equal(result.rejected, undefined);
	// 250 tokens charged; 750 remain.
	assert.equal(result.budgetSpent.tokens, 750);
});

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

test('runtime: returning event fires on success and failure', async () => {
	setup();

	const successEvents: L2Event[] = [];
	const failEvents: L2Event[] = [];

	const okSkill = makeL2Skill<unknown>({
		async run(): Promise<SkillOutput<unknown>> {
			return { value: 'ok', evidence: [], confidence: 'high' };
		},
	});
	const failSkill = makeL2Skill<unknown>({
		id: 'test.l2.fail',
		async run(): Promise<SkillOutput<unknown>> {
			throw new Error('boom');
		},
	});

	await runL2Skill(okSkill,
		{ input: { q: 'test' }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider(),
		  emit: (e) => successEvents.push(e) },
	);
	await runL2Skill(failSkill,
		{ input: { q: 'test' }, invocationContext: {} },
		{ session: fakeSession(), resolveProvider: () => fakeProvider(),
		  emit: (e) => failEvents.push(e) },
	);

	const okReturning   = successEvents.find(e => e.kind === 'returning');
	const failReturning = failEvents.find(e => e.kind === 'returning');
	assert.ok(okReturning && okReturning.kind === 'returning' && okReturning.success === true);
	assert.ok(failReturning && failReturning.kind === 'returning' && failReturning.success === false);
});
