/**
 * L2 runtime -- P7.4.
 *
 * Per agentic-skills-architecture.md §"L2 runtime", this is the
 * component between the orchestrator and an L2 skill body.
 * Responsibilities:
 *
 *   1. Validate input against the skill's `inputs` schema.
 *   2. Allocate (or accept-inherit) the BudgetTracker. Top-level
 *      calls allocate fresh; nested calls reuse the parent's tracker
 *      (shared per A3).
 *   3. Build per-execution working state + assembled context (via the
 *      substrate runtime when present; fresh otherwise).
 *   4. Build L2Deps wiring callL1 + callL2 with budget accounting,
 *      auto-append to the ledger, depth tracking, and event emission.
 *   5. Invoke the skill body.
 *   6. Validate the output (schema + self-grounding via the validator
 *      in `./grounding.ts`).
 *   7. On success, distill pinned working-state entries into memory
 *      via the substrate's distill engine (same flow as L1).
 *   8. Return an `L2RunResult<O>` that the orchestrator surfaces.
 *
 * The runtime does NOT decide what the skill should do. It enforces
 * caps + provides primitives.
 */

import { getLogger } from '../../../shared/logger.js';

import { validate as validateJsonSchema } from '../json-schema.js';
import { runSkill, type SkillRunnerDeps } from '../invoke.js';
import { createWorkingStateLedger } from '../../substrate/working-state.js';

import type { Session } from '../../../agent/session.js';
import type { LLMProvider } from '../../../shared/types.js';
import type { ProviderAffinity, SkillResult } from '../types.js';

import type {
	AssembledContext,
	MemoryStore,
	WorkingStateLedger,
} from '../../substrate/types.js';
import type { SubstrateRuntime } from '../../substrate/runtime.js';

import { createBudgetTracker } from './budget.js';
import { validateGrounding } from './grounding.js';
import { createL2LlmAccess } from './llm-access.js';
import type {
	BudgetTracker,
	L2Deps,
	L2Event,
	L2Invocation,
	L2Skill,
	SkillBudget,
	SkillOutput,
} from './types.js';
import { BudgetExceededError, L2GroundingError } from './types.js';

const log = getLogger('l2:runtime');

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface L2RunnerDeps {
	readonly session:         Session;
	readonly resolveProvider: (affinity: ProviderAffinity) => LLMProvider;
	readonly substrate?:      SubstrateRuntime;
	readonly signal?:         AbortSignal;
	/**
	 * Sink for L2Event progress notifications. Best-effort: errors
	 * thrown from the sink are swallowed so a slow consumer can't
	 * block the skill. Forward to chat-stream in production; capture
	 * in an array in tests.
	 */
	readonly emit?:           (event: L2Event) => void;
}

export interface RunL2SkillOpts {
	/**
	 * Override the skill's `defaultBudget`. Caller-supplied budget
	 * wins; otherwise the skill's default is used. Nested calls
	 * always inherit the parent's tracker -- this opt only applies at
	 * the top-level call.
	 */
	readonly budget?: SkillBudget;
}

export interface L2RunResult<O> {
	readonly output:      SkillOutput<O>;
	readonly rejected?:   { readonly reason: 'input-validation' | 'output-validation' | 'grounding' | 'budget-exceeded' | 'skill-threw' | 'aborted'; readonly detail: string };
	readonly budgetSpent: ReturnType<BudgetTracker['remaining']>;
}

/**
 * Top-level L2 skill invocation. Allocates a fresh BudgetTracker.
 * For nested calls (from inside another L2 body), `deps.callL2(...)`
 * is the entry point -- it threads the parent's tracker through.
 */
export async function runL2Skill<I, O>(
	skill:      L2Skill<I, O>,
	invocation: L2Invocation<I>,
	runner:     L2RunnerDeps,
	opts?:      RunL2SkillOpts,
): Promise<L2RunResult<O>> {
	const budget = createBudgetTracker({ limit: opts?.budget ?? skill.defaultBudget });
	return runL2SkillInternal(skill, invocation, runner, budget);
}

// ---------------------------------------------------------------------------
// Shared internal runner (top-level + nested call into the same code path)
// ---------------------------------------------------------------------------

async function runL2SkillInternal<I, O>(
	skill:      L2Skill<I, O>,
	invocation: L2Invocation<I>,
	runner:     L2RunnerDeps,
	budget:     BudgetTracker,
): Promise<L2RunResult<O>> {
	const signal = runner.signal ?? new AbortController().signal;
	const emit   = makeEmit(runner.emit);

	// 1. Input schema validation.
	const inputCheck = validateJsonSchema(invocation.input as unknown, skill.inputs);
	if (inputCheck.ok !== true) {
		return rejection<O>('input-validation', `input failed schema: ${inputCheck.errors.join('; ')}`, budget);
	}

	// 2. Substrate prep (when present) -- gives us context + working state.
	//    When absent, build an in-process ledger + empty context.
	const substratePrep = await prepareSubstrate(skill, invocation, runner);
	const workingState  = substratePrep?.workingState ?? createWorkingStateLedger();
	const context       = substratePrep?.context       ?? emptyContext();
	const memory: MemoryStore = runner.substrate?.memory ?? throwingMemoryStore();

	// 3. Build the LLM wrapper (token-accounted via budget).
	const provider   = runner.resolveProvider('cloud');   // L2 default; per-skill override TBD
	const providerId = providerIdOf(provider);
	const llm        = createL2LlmAccess({ provider, providerId, budget, emit });

	// 4. Build callL1 / callL2 with the dispatch wrapping (auto-append + budget).
	const callL1 = makeCallL1(runner, workingState, budget, signal, emit);
	const callL2 = makeCallL2(runner, workingState, budget, signal, emit);

	// 5. Build deps + invoke.
	const deps: L2Deps = {
		session: runner.session,
		workingState,
		context,
		memory,
		budget,
		llm,
		signal,
		emit,
		callL1,
		callL2,
	};

	let output: SkillOutput<O>;
	try {
		output = await skill.run(invocation, deps);
	} catch (err) {
		if (err instanceof BudgetExceededError) {
			return rejection<O>('budget-exceeded', err.message, budget);
		}
		if (signal.aborted) {
			return rejection<O>('aborted', 'aborted', budget);
		}
		const msg = (err as Error).message ?? String(err);
		log.warn({ skillId: skill.id, err: msg }, 'l2:runtime skill threw');
		await settleSubstrate(substratePrep, false);
		emit({ kind: 'returning', success: false, at: Date.now() });
		return rejection<O>('skill-threw', msg, budget);
	}

	// 6. Output schema validation.
	const outCheck = validateJsonSchema({
		value:      output.value,
		evidence:   output.evidence,
		confidence: output.confidence,
		...(output.notes !== undefined ? { notes: output.notes } : {}),
	} as unknown, skill.outputs);
	if (outCheck.ok !== true) {
		await settleSubstrate(substratePrep, false);
		emit({ kind: 'returning', success: false, at: Date.now() });
		return rejection<O>('output-validation', `output failed schema: ${outCheck.errors.join('; ')}`, budget);
	}

	// 7. Self-grounding validation (A1).
	try {
		validateGrounding(output, {
			mode:         skill.selfGroundingMode ?? 'structured',
			workingState,
			skillId:      skill.id,
		});
	} catch (err) {
		if (err instanceof L2GroundingError) {
			await settleSubstrate(substratePrep, false);
			emit({ kind: 'returning', success: false, at: Date.now() });
			return rejection<O>('grounding', `${err.message}: ${err.issues.join('; ')}`, budget);
		}
		throw err;
	}

	// 8. Distill pinned working-state entries (per the skill's memorySchema).
	await settleSubstrate(substratePrep, true);

	emit({ kind: 'returning', success: true, at: Date.now() });

	return {
		output,
		budgetSpent: budget.remaining(),
	};
}

// ---------------------------------------------------------------------------
// Substrate plumbing
// ---------------------------------------------------------------------------

type SubstratePrep = Awaited<ReturnType<SubstrateRuntime['prepareForSkill']>>;

async function prepareSubstrate<I, O>(
	skill:      L2Skill<I, O>,
	invocation: L2Invocation<I>,
	runner:     L2RunnerDeps,
): Promise<SubstratePrep | undefined> {
	if (runner.substrate === undefined) { return undefined; }
	// The substrate runtime's prepareForSkill takes a Skill-shaped
	// object. L2Skill's optional substrate-facing fields are the same
	// shape as L1's SubstrateSkillExtension, so we cast and the
	// runtime reads the optional fields off.
	const skillForSubstrate = skill as unknown as Parameters<SubstrateRuntime['prepareForSkill']>[0];
	return runner.substrate.prepareForSkill(skillForSubstrate, {
		task:    invocation.input,
		session: runner.session,
		...(runner.signal !== undefined ? { signal: runner.signal } : {}),
	});
}

async function settleSubstrate(prep: SubstratePrep | undefined, success: boolean): Promise<void> {
	if (prep === undefined) { return; }
	try {
		await prep.complete(success);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'l2:settle substrate complete threw');
	}
}

function emptyContext(): AssembledContext {
	return {
		slots:      new Map(),
		task:       undefined,
		session:    undefined,
		budgetUsed: {},
		notes:      [],
	};
}

function throwingMemoryStore(): MemoryStore {
	return {
		scope() {
			throw new Error('l2:runtime: memory not available without a substrate runtime');
		},
	};
}

function providerIdOf(provider: LLMProvider): string {
	const fields = provider as unknown as { id?: string; providerId?: string };
	return fields.providerId ?? fields.id ?? 'unknown-provider';
}

// ---------------------------------------------------------------------------
// callL1 / callL2 wrappers (budget + ledger + emit)
// ---------------------------------------------------------------------------

let CALL_SEQ = 0;
function nextCallId(): string {
	CALL_SEQ = (CALL_SEQ + 1) & 0xffff;
	return `l2-call-${Date.now()}-${CALL_SEQ}`;
}

function makeCallL1(
	runner:       L2RunnerDeps,
	workingState: WorkingStateLedger,
	budget:       BudgetTracker,
	signal:       AbortSignal,
	emit:         (event: L2Event) => void,
): L2Deps['callL1'] {
	return async function callL1<I, O>(id: string, input: I): Promise<SkillResult<O>> {
		if (signal.aborted) {
			throw new Error(`callL1('${id}'): aborted`);
		}
		budget.checkWallclock();
		budget.reserveSubCall();

		const callId = nextCallId();
		emit({ kind: 'sub-call-started', callId, targetSkill: id, at: Date.now() });

		const start = Date.now();
		const innerRunner: SkillRunnerDeps = {
			session:         runner.session,
			resolveProvider: runner.resolveProvider,
			...(runner.substrate !== undefined ? { substrate: runner.substrate } : {}),
			...(runner.signal    !== undefined ? { signal:    runner.signal    } : {}),
		};

		try {
			const result = await runSkill<I, O>(id, input, innerRunner);
			const ref = workingState.append({
				source:  { kind: 'sub-call', skillId: id, callRef: callId },
				payload: result,
				claims:  [`sub-call:${id}`],
				confidence: confidenceToNumber(result.confidence),
			});
			emit({ kind: 'ledger-grew', count: 1, at: Date.now() });
			void ref;
			emit({
				kind:       'sub-call-finished',
				callId,
				success:    true,
				durationMs: Date.now() - start,
				at:         Date.now(),
			});
			return result;
		} catch (err) {
			emit({
				kind:       'sub-call-finished',
				callId,
				success:    false,
				durationMs: Date.now() - start,
				at:         Date.now(),
			});
			throw err;
		}
	};
}

function makeCallL2(
	runner:       L2RunnerDeps,
	workingState: WorkingStateLedger,
	budget:       BudgetTracker,
	signal:       AbortSignal,
	emit:         (event: L2Event) => void,
): L2Deps['callL2'] {
	return async function callL2<I, O>(
		invocation: L2Invocation<I>,
		opts:       { readonly id: string },
	): Promise<SkillOutput<O>> {
		if (signal.aborted) {
			throw new Error(`callL2('${opts.id}'): aborted`);
		}
		budget.checkWallclock();
		budget.reserveSubCall();
		budget.pushDepth();

		const callId = nextCallId();
		emit({ kind: 'sub-call-started', callId, targetSkill: opts.id, at: Date.now() });

		const start = Date.now();
		try {
			// Look up the L2 skill from the registry.
			const skill = lookupL2Skill<I, O>(opts.id);
			const sub: L2RunResult<O> = await runL2SkillInternal(skill, invocation, runner, budget);

			const ref = workingState.append({
				source:  { kind: 'sub-call', skillId: opts.id, callRef: callId },
				payload: sub.output,
				claims:  [`sub-call:${opts.id}`],
				confidence: confidenceToNumber(sub.output.confidence),
			});
			emit({ kind: 'ledger-grew', count: 1, at: Date.now() });
			void ref;
			emit({
				kind:       'sub-call-finished',
				callId,
				success:    sub.rejected === undefined,
				durationMs: Date.now() - start,
				at:         Date.now(),
			});

			if (sub.rejected !== undefined) {
				throw new Error(`callL2('${opts.id}') rejected: ${sub.rejected.reason}: ${sub.rejected.detail}`);
			}
			return sub.output;
		} catch (err) {
			emit({
				kind:       'sub-call-finished',
				callId,
				success:    false,
				durationMs: Date.now() - start,
				at:         Date.now(),
			});
			throw err;
		} finally {
			budget.popDepth();
		}
	};
}

function confidenceToNumber(c: 'high' | 'medium' | 'low'): number {
	switch (c) {
		case 'high':   return 0.9;
		case 'medium': return 0.6;
		case 'low':    return 0.3;
	}
}

// ---------------------------------------------------------------------------
// Registry lookup (forward-decl; wired by P7.6)
// ---------------------------------------------------------------------------

import { getL2Skill } from './registry.js';

function lookupL2Skill<I, O>(id: string): L2Skill<I, O> {
	const skill = getL2Skill(id);
	if (skill === undefined) {
		throw new Error(`l2:callL2 unknown L2 skill id '${id}'`);
	}
	return skill as L2Skill<I, O>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmit(sink: ((event: L2Event) => void) | undefined): (event: L2Event) => void {
	if (sink === undefined) { return () => undefined; }
	return (event: L2Event) => {
		try { sink(event); }
		catch (err) {
			log.debug({ err: (err as Error).message }, 'l2:emit sink threw -- swallowed');
		}
	};
}

function rejection<O>(
	reason: NonNullable<L2RunResult<O>['rejected']>['reason'],
	detail: string,
	budget: BudgetTracker,
): L2RunResult<O> {
	return {
		output:      {
			value:      undefined as unknown as O,
			evidence:   [],
			confidence: 'low',
			notes:      [`rejected: ${reason}: ${detail}`],
		},
		rejected:    { reason, detail },
		budgetSpent: budget.remaining(),
	};
}
