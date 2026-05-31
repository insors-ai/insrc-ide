/**
 * L2 skill framework -- type contracts.
 *
 * P7.1 of plans/skills/substrate-implementation-status.md +
 * plans/skills/l2-framework.md.
 *
 * Per agentic-skills-architecture.md §"L2 skill contract":
 *
 * L2 skills are agentic. They take a goal + freeform invocation
 * context, plan internally, dispatch sub-calls (L1 + L2), pin
 * working-state entries that distill into memory on success,
 * self-ground the output against the working-state ledger, and
 * return a structured result the runtime validates.
 *
 * The L2 framework is purely additive. L1 skills are unchanged;
 * existing call paths keep working. L2 is opt-in via the registry's
 * `kind` discriminator.
 */

import type {
	SkillFamily,
	SkillOwner,
	Precondition,
	SkillConfidence,
	SkillResult,
} from '../types.js';
import type {
	AssertionInterest,
	BootstrapTriggerKind,
	ContextSlotRequest,
	FeedbackEvent,
	FeedbackHandlerDeps,
	LedgerRef,
	MemoryStore,
	NamespaceSpec,
	OwnerId,
	WorkingStateLedger,
	AssembledContext,
} from '../../substrate/types.js';
import type { Session } from '../../../agent/session.js';
import type { LLMMessage, LLMResponse } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Invocation envelope (A2)
// ---------------------------------------------------------------------------

/**
 * Caller-provided freeform context. Untyped at the framework level --
 * the skill body introspects whichever keys it knows about and
 * ignores the rest. Common keys callers stuff here: `goal`, `intent`,
 * `priorTurnRefs`, `reviewCriteria`.
 */
export type InvocationContext = Readonly<Record<string, unknown>>;

/**
 * The L2 skill body's only parameter besides `deps`. Per A2:
 *   - `input: I`  is the typed, schema-validated args the skill REQUIRES.
 *   - `invocationContext` is the caller's freeform hints -- nothing the
 *     runtime validates; the skill picks what it cares about.
 */
export interface L2Invocation<I> {
	readonly input:             I;
	readonly invocationContext: InvocationContext;
}

// ---------------------------------------------------------------------------
// Output contract (A1 -- structured self-grounding)
// ---------------------------------------------------------------------------

/**
 * One grounded claim. The skill author writes claims as human-readable
 * sentences and lists every ledger entry that supports them. The
 * runtime validates structural integrity (refs resolve); the skill is
 * the only judge of whether the cited entry ACTUALLY supports the
 * claim (substrate validates structure, skill owns quality).
 */
export interface Evidence {
	readonly claim:     string;
	readonly citations: readonly LedgerRef[];
}

/**
 * Every L2 skill returns this shape. The runtime rejects the return
 * if the citations don't resolve to ledger entries (in
 * `selfGroundingMode: 'structured'`, the default).
 */
export interface SkillOutput<V> {
	readonly value:      V;
	readonly evidence:   readonly Evidence[];
	readonly confidence: SkillConfidence;
	readonly notes?:     readonly string[];
}

export type SelfGroundingMode = 'structured' | 'none';

// ---------------------------------------------------------------------------
// Budget (A3)
// ---------------------------------------------------------------------------

/**
 * Hard caps the runtime enforces. The skill MAY return early when a
 * cap is exhausted; it MUST NOT exceed them. All caps are SHARED
 * across the entire call tree under the top-level invocation -- a
 * sub-L2 deducts from the parent's remaining counts (not its own
 * declared default).
 */
export interface SkillBudget {
	readonly maxTokens:      number;
	readonly maxSubCalls:    number;
	readonly maxWallclockMs: number;
	/** Default 4 (`DEFAULT_MAX_DEPTH`). */
	readonly maxDepth?:      number;
}

export const DEFAULT_MAX_DEPTH = 4;

/**
 * Runtime-managed counter shared across the call tree. Sub-L2 calls
 * receive the SAME tracker -- they don't allocate fresh.
 *
 * Methods THROW `BudgetExceededError` when the cap is hit.
 */
export interface BudgetTracker {
	readonly limit: SkillBudget;
	remaining():    BudgetSnapshot;
	chargeTokens(n: number): void;
	reserveSubCall(): void;
	pushDepth(): void;
	popDepth():  void;
	checkWallclock(): void;
}

export interface BudgetSnapshot {
	readonly tokens:      number;
	readonly subCalls:    number;
	readonly wallclockMs: number;
	readonly depth:       number;
}

/** Thrown when any of the budget caps is breached. */
export class BudgetExceededError extends Error {
	override readonly name = 'BudgetExceededError';
	constructor(
		message: string,
		public readonly limit: SkillBudget,
		public readonly snapshot: BudgetSnapshot,
		public readonly cap: 'tokens' | 'subCalls' | 'wallclock' | 'depth',
	) {
		super(message);
	}
}

// ---------------------------------------------------------------------------
// LLM access (token-accounted)
// ---------------------------------------------------------------------------

export interface L2LlmCallOpts {
	readonly maxTokens?:   number;
	readonly temperature?: number;
	readonly stopSequences?: readonly string[];
	// Pass-through for tool-call protocol skills (classify-question shape).
	// Shapes mirror CompletionOpts; the L2 wrapper forwards as-is.
	readonly tools?:      readonly unknown[];
	readonly toolChoice?: 'auto' | 'required' | 'none' | { readonly name: string };
	// Strict-output hint (passed through to provider.complete).
	readonly responseFormat?: 'json' | { readonly schema: Record<string, unknown> };
}

/**
 * Token-accounted wrapper around the active provider. The runtime
 * charges `response.usage.totalTokens` (or a chars/3 estimate as
 * fallback) against the budget after each call.
 */
export interface L2LlmAccess {
	readonly providerId: string;
	complete(messages: readonly LLMMessage[], opts?: L2LlmCallOpts): Promise<LLMResponse>;
}

// ---------------------------------------------------------------------------
// Event stream (A4)
// ---------------------------------------------------------------------------

export type L2Event =
	| { readonly kind: 'plan-step';           readonly description: string;                                  readonly at: number }
	| { readonly kind: 'sub-call-started';    readonly callId: string; readonly targetSkill: string;          readonly at: number }
	| { readonly kind: 'sub-call-finished';   readonly callId: string; readonly success: boolean; readonly durationMs: number; readonly at: number }
	| { readonly kind: 'ledger-grew';         readonly count:  number;                                       readonly at: number }
	| { readonly kind: 'draft-emitted';       readonly sectionId?: string;                                   readonly at: number }
	| { readonly kind: 'self-ground-flagged'; readonly claim:  string;                                       readonly at: number }
	| { readonly kind: 'returning';           readonly success: boolean;                                     readonly at: number }
	| { readonly kind: 'message';             readonly text:   string;                                       readonly at: number }
	| { readonly kind: 'custom';              readonly type:   string; readonly payload: unknown;            readonly at: number };

// ---------------------------------------------------------------------------
// L2 deps (skill body's only parameter besides `invocation`)
// ---------------------------------------------------------------------------

export interface L2Deps {
	readonly session:      Session;
	readonly workingState: WorkingStateLedger;
	readonly context:      AssembledContext;
	readonly memory:       MemoryStore;
	readonly budget:       BudgetTracker;
	readonly llm:          L2LlmAccess;
	readonly signal:       AbortSignal;
	readonly emit:         (event: L2Event) => void;
	/**
	 * Dispatch an L1 sub-call. Forwards to today's runSkill machinery;
	 * runtime auto-appends the result to the working-state ledger with
	 * `source: { kind: 'sub-call', skillId, callRef }` and decrements
	 * the shared sub-call budget.
	 */
	readonly callL1: <I, O>(id: string, input: I) => Promise<SkillResult<O>>;
	/**
	 * Dispatch a nested L2 sub-call. Shares the SAME BudgetTracker as
	 * the parent (per A3). Increments the call-tree depth before
	 * dispatch; throws `BudgetExceededError` if depth > `maxDepth`.
	 */
	readonly callL2: <I, O>(invocation: L2Invocation<I>, opts: { readonly id: string }) => Promise<SkillOutput<O>>;
}

// ---------------------------------------------------------------------------
// L2 skill
// ---------------------------------------------------------------------------

/**
 * L2 skill shape. Distinct method name (`run`) from L1's `execute` so
 * the unified registry can route by inspecting the object.
 *
 * Optional substrate-facing fields mirror L1's `SubstrateSkillExtension`
 * exactly -- the L2 runtime threads `deps.context` + the working
 * state through these declarations the same way L1 does.
 */
export interface L2Skill<I = unknown, O = unknown> {
	readonly id:            string;
	readonly name:          string;
	readonly description:   string;
	readonly family:        SkillFamily;
	readonly owner:         SkillOwner;
	readonly version:       number;
	readonly inputs:        Record<string, unknown>;
	readonly outputs:       Record<string, unknown>;
	readonly defaultBudget: SkillBudget;

	readonly preconditions?: readonly Precondition[];
	readonly toolDeps?:      readonly string[];
	readonly skillDeps?:     readonly string[];
	readonly selfGroundingMode?: SelfGroundingMode;

	// Substrate-facing declarations (same shape as L1's SubstrateSkillExtension).
	readonly ownerId?:            OwnerId;
	readonly schemaVersion?:      number;
	readonly interestedTriggers?: readonly BootstrapTriggerKind[];
	readonly contextSlots?:       readonly ContextSlotRequest[];
	readonly memorySchema?:       readonly NamespaceSpec[];
	readonly assertionInterests?: readonly AssertionInterest[];
	applyFeedback?(events: readonly FeedbackEvent[], deps: FeedbackHandlerDeps): Promise<void>;

	run(invocation: L2Invocation<I>, deps: L2Deps): Promise<SkillOutput<O>>;
}

/**
 * Type guard. Use this to distinguish L2 from L1 in the unified
 * registry. L1 has `execute`; L2 has `run` + `defaultBudget`.
 */
export function isL2Skill(s: unknown): s is L2Skill {
	if (typeof s !== 'object' || s === null) { return false; }
	const o = s as Record<string, unknown>;
	return typeof o['run'] === 'function' && typeof o['defaultBudget'] === 'object';
}

// ---------------------------------------------------------------------------
// Runtime error shape
// ---------------------------------------------------------------------------

/** Self-grounding rejection: structural shape or dangling LedgerRef. */
export class L2GroundingError extends Error {
	override readonly name = 'L2GroundingError';
	constructor(message: string, public readonly issues: readonly string[]) {
		super(message);
	}
}
