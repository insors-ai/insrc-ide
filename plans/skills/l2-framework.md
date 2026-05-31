# P7 — L2 framework core

**Status:** draft (2026-05-31)
**Owner:** subhagho@gmail.com
**Tier:** new (this is the L2 layer the substrate enables)

**Goal:** ship the L2 runtime + types + budget + self-grounding + registry. No pilot skill yet -- pilot lands in a separate scope (P8 or follow-up session).

## Depends on
- [`plans/agentic-skills-architecture.md`](../agentic-skills-architecture.md) §"L2 skill contract" + §"L2 runtime" + §A1–A6
- [`plans/memory-context-substrate.md`](../memory-context-substrate.md) (substrate primitives -- working state, context assembler, memory store)
- All P0-P5 substrate work + all L1 skill migrations (done)

## Concrete interface decisions (closing the doc's open ends)

The agentic-skills doc's L2Skill snippet is illustrative. Locking the shape:

### `L2Skill<I, O>` (final)

```ts
interface L2Skill<I, O> {
  readonly id:            string;
  readonly description:   string;
  readonly family:        SkillFamily;
  readonly owner:         string;
  readonly version:       number;

  readonly inputs:        JsonSchema;
  readonly outputs:       JsonSchema;     // MUST declare `evidence` + `value` per A1

  readonly defaultBudget: SkillBudget;

  // The skill body. Distinct method name from L1's `execute` so the
  // registry + runtime can dispatch correctly.
  run(invocation: L2Invocation<I>, deps: L2Deps): Promise<SkillOutput<O>>;

  // Optional, same shape as L1.
  readonly preconditions?: readonly Precondition[];
  readonly toolDeps?:      readonly string[];
  readonly skillDeps?:     readonly string[];

  // A1 opt-out for genuinely citation-free outputs.
  readonly selfGroundingMode?: 'structured' | 'none';   // default 'structured'

  // Optional substrate-facing declarations (same shape as L1's
  // SubstrateSkillExtension). The runtime threads `deps.context`
  // + working state through these slots.
  readonly ownerId?:            OwnerId;
  readonly schemaVersion?:      number;
  readonly interestedTriggers?: readonly BootstrapTriggerKind[];
  readonly contextSlots?:       readonly ContextSlotRequest[];
  readonly memorySchema?:       readonly NamespaceSpec[];
  readonly assertionInterests?: readonly AssertionInterest[];
  applyFeedback?(events: readonly FeedbackEvent[], deps: FeedbackHandlerDeps): Promise<void>;
}
```

### `SkillOutput<V>` (A1 contract)

```ts
interface SkillOutput<V> {
  readonly value:    V;                              // the typed payload
  readonly evidence: readonly Evidence[];            // per-claim citations
  readonly confidence: 'high' | 'medium' | 'low';
  readonly notes?:   readonly string[];
}

interface Evidence {
  readonly claim:     string;                        // human-readable claim
  readonly citations: readonly LedgerRef[];          // refs into the working state
}
```

The runtime validates `evidence` structural shape + every `LedgerRef` resolves to an actual ledger entry. **Quality** of the citation is the skill's responsibility (A1 doctrine: substrate validates structure, skill owns quality).

### `L2Invocation<I>` (A2)

```ts
interface L2Invocation<I> {
  readonly input:             I;                     // typed, validated
  readonly invocationContext: InvocationContext;    // freeform
}

type InvocationContext = Readonly<Record<string, unknown>>;
```

### `SkillBudget` + `BudgetTracker`

```ts
interface SkillBudget {
  readonly maxTokens:      number;       // sum across call tree (A3)
  readonly maxSubCalls:    number;       // L1+L2, shared across tree (A3)
  readonly maxWallclockMs: number;
  readonly maxDepth?:      number;       // default 4
}

interface BudgetTracker {
  readonly limit:    SkillBudget;
  remaining(): SkillBudget;
  // Charge `n` tokens. Throws BudgetExceededError if over.
  chargeTokens(n: number): void;
  // Reserve a sub-call. Throws if over maxSubCalls.
  reserveSubCall(): void;
  // Throw if depth >= maxDepth.
  pushDepth(): void;
  popDepth(): void;
  // Wallclock check; throws if past deadline.
  checkWallclock(): void;
}
```

**Shared across call tree:** all nested `callL2(...)` use the *same* tracker -- they pass-through, not allocate-fresh. Sub-skills query `deps.budget.remaining()` and adapt.

### `L2Deps`

```ts
interface L2Deps {
  readonly session:      Session;
  readonly workingState: WorkingStateLedger;
  readonly context:      AssembledContext;
  readonly memory:       MemoryStore;
  readonly budget:       BudgetTracker;
  readonly callL1:       <I, O>(id: string, input: I) => Promise<SkillResult<O>>;
  readonly callL2:       <I, O>(invocation: L2Invocation<I>, opts: { id: string }) => Promise<SkillOutput<O>>;
  readonly llm:          L2LlmAccess;
  readonly signal:       AbortSignal;
  readonly emit:         (event: L2Event) => void;
}
```

### `L2LlmAccess`

```ts
interface L2LlmAccess {
  // Token-accounted wrapper around the active provider.
  complete(messages: readonly LLMMessage[], opts: LLMCallOpts): Promise<LLMResponse>;
  // Provider id for telemetry / debugging.
  readonly providerId: string;
}
```

The wrapper:
1. Resolves the active provider via `resolveProvider(affinity)`.
2. Calls `provider.complete(messages, opts)`.
3. Charges `response.usage.totalTokens` against the budget (throws `BudgetExceededError` after the call if over -- can't pre-charge unknown token counts).
4. Emits a custom `L2Event` for telemetry.

### `L2Event` (per A4)

Exactly the 9 kinds in the doc. The runtime auto-emits `sub-call-started` / `sub-call-finished` / `ledger-grew` / `returning`. Skill emits `plan-step` / `draft-emitted` / `self-ground-flagged` / `message` / `custom`.

## Runtime decisions

### Sub-call dispatch

- `deps.callL1(id, input)`: forwards to existing `runSkill(id, input, runnerDeps)` from `daemon/skills/invoke.ts`. Auto-appends the result to the working state with `source: { kind: 'sub-call', skillId: id, callRef: <auto-id> }`. Charges 1 against `maxSubCalls`. Emits `sub-call-started` + `sub-call-finished`.
- `deps.callL2(invocation, opts)`: recursive `runL2Skill(skill, invocation, runnerDeps)` with the SAME budget tracker (shared per A3). Increments depth before dispatch; decrements after. Throws `BudgetExceededError` if depth >= `maxDepth`. Auto-append + emit.

### Cancellation

`deps.signal` is the orchestrator's signal. Sub-calls inherit it. The runtime checks `signal.aborted` before every sub-call dispatch + before final return.

### Output validation (A1)

After the skill returns, the runtime:
1. Validates the output shape against the skill's `outputs` schema.
2. If `selfGroundingMode !== 'none'`, verifies `evidence` is an array + every `LedgerRef` in `citations` resolves to a real entry in the current execution's working state.
3. Rejects with a structured error on either failure (skill cannot complete with malformed output).

### Budget enforcement

- `BudgetExceededError` thrown from any `chargeTokens` / `reserveSubCall` / `pushDepth` / `checkWallclock`.
- The runtime catches it in `runL2Skill`'s catch block, surfaces it as a low-confidence result with a `budget-exceeded` note. The skill body sees the error if it's the one calling `deps.callL2` / `deps.llm.complete`.

### Registry decision

**Unified registry with kind-discriminator.** The existing `daemon/skills/registry.ts` becomes the home for both L1 and L2 skills. The skill object's shape distinguishes them: L2 skills have a `run` method instead of `execute`, plus a `defaultBudget`. The registry stores either; the dispatch layer (`runSkill` for L1, `runL2Skill` for L2) inspects the object and routes correctly.

This avoids registry-splitting churn. Trade-off: one shared catalog, but classify-question already filters by family + owner, so cross-tier discovery works.

## Components

| # | Component | File path | Depends on |
|---|---|---|---|
| P7.1 | L2 types | `src/insrc/daemon/skills/l2/types.ts` | substrate types |
| P7.2 | BudgetTracker | `src/insrc/daemon/skills/l2/budget.ts` | P7.1 |
| P7.3 | L2LlmAccess | `src/insrc/daemon/skills/l2/llm-access.ts` | P7.1, P7.2 |
| P7.4 | L2 runtime | `src/insrc/daemon/skills/l2/runtime.ts` | P7.1, P7.2, P7.3 |
| P7.5 | Grounding validator | `src/insrc/daemon/skills/l2/grounding.ts` | P7.1 |
| P7.6 | Registry adapter | `src/insrc/daemon/skills/registry.ts` (modify) + `src/insrc/daemon/skills/l2/registry.ts` | P7.1 |
| P7.7 | Unit tests | `src/insrc/daemon/skills/l2/__tests__/*.test.ts` | all of above |

## Out of scope for P7 core

- **Pilot L2 skill** (`code.audit-module` strawman). Separate phase.
- **Chat-stream wire format for L2Event.** A4 explicitly leaves the wire format to the chat-stream layer.
- **Live LLM testing of the runtime.** Deterministic fakes only; the pilot phase exercises real providers per A6.
- **L2 dispatch from existing L1 callers.** The runtime is opt-in; existing call paths are unchanged.
- **Crash-resume.** Per L2 runtime doc §"crash-resume scope": deferred to the agent framework checkpoint layer.

## Tests (P7.7)

Deterministic-fake-driven:
1. **Budget basics:** chargeTokens / reserveSubCall / pushDepth / popDepth + over-limit throws.
2. **Sub-call dispatch:** callL1 forwards to runSkill + auto-appends to ledger + decrements subCalls.
3. **callL2 + depth cap:** nested calls increment depth; over-depth throws.
4. **Shared budget across tree:** parent's budget shrinks when sub-L2 calls llm.
5. **Self-grounding:** missing evidence rejected; dangling LedgerRef rejected; `selfGroundingMode: 'none'` opt-out.
6. **Event emission:** sub-call-started/finished + ledger-grew + returning all fire.
7. **Cancellation:** signal.aborted causes next sub-call to throw.
8. **Output validation:** JSON-schema rejection on malformed output.

## Risks

- **Token usage estimation accuracy.** Charging only after `complete()` returns means we may overrun maxTokens by one call. Acceptable per the doc; production telemetry can flag patterns where budgets need bumping.
- **Local-model viability.** Per A6 + risks: L2 likely cloud-bound at first. The runtime doesn't assume cloud, but the pilot will need to handle local-model JSON-emission unreliability.
- **Auto-append discipline.** The runtime appends sub-call results to the ledger; if a skill author also appends manually, duplicates result. Convention: skills DO NOT manually append sub-call results -- only application-specific observations / plan-steps.
