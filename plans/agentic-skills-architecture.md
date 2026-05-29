# Agentic skills architecture

**Status:** draft (2026-05-28)
**Owner:** subhagho@gmail.com
**Standing position:** **a skill is a self-contained, intent-optimizing agent, not a prompt-shaped tool wrapper.** Given a task + a budget, an L2 skill plans, executes sub-calls, maintains internal state, self-grounds, and returns a result it stands behind. The current `skill = prompt + 1 tool call` model is the bottleneck behind ~every quality problem we've hit in the data-analyzer.

**This doc depends on** [`plans/memory-context-substrate.md`](plans/memory-context-substrate.md) — the shared memory + context + working-state framework every skill and agent inherits. Memory, context assembly, working-state ledgers, bootstrap, feedback, indexing, and the user-assertion classifier live in the substrate. This doc covers only what's specific to the L1/L2 skill model: the agentic runtime, the L1/L2 split, the L2 evidence-ledger discipline that sits on top of working state, and the migration plan to get there.

**Sibling:** [`plans/code-analyzer-migration.md`](plans/code-analyzer-migration.md) — the priority pilot adoption path for this framework. Applies the substrate + L2 model concretely to the code-analyzer, identifies code-specific context builders, L1 skills to migrate, user-assertion routing, and pilot L2 skill choice. Implementation should start there.

**L1 skills evolve too.** Even capability skills become substrate consumers. Each L1 skill declares context builders that the substrate's indexer dispatches at bootstrap time, reads from context slots the substrate assembles per-execution, and pins working-state entries that the substrate distills back to memory. Cold execution is the slow path; warm execution against an already-populated substrate is the norm.

## Why

The current skill substrate (`src/insrc/daemon/skills/`) treats every skill as a stateless `(input, deps) → SkillResult` pure function. The skill body typically:

1. Reads its typed input (already-resolved args).
2. Calls one or two underlying tools via `deps.runTool`.
3. Type-checks the tool result.
4. Returns a typed value with `confidence: 'high'|'medium'|'low'`.

Iteration, judgment, backtracking, and any **awareness of the user's actual intent** live entirely *outside* the skill — in the meta layer (`classify-question` → `select-scope`) and in the grounding-review pingpong.

This model is shipping today but it's hit a ceiling. Concrete failures from the GRN-directory run (2026-05-28):

| Symptom | Why the current model can't fix it |
|---|---|
| Writer kept citing `path:hadoop-hdfs/.../HdfsServerConstants.java` | Writer is a single-shot prompt with no notion of "verify each citation against my evidence before emitting." External grounding-review catches it, hands back a hint, single-shot writer half-fixes it, loop repeats. Two LLM calls per iteration, often 3-4 iterations per section. |
| `data.profile.numeric.file` received `column: 'supplier'` and crashed | The skill's `execute()` sees `{connectionId, column}` with no way to know the column doesn't exist on the connection. It can't consult the schema, can't propose an alternative, can't surface the mismatch. It dispatches blindly and the tool fails with `unknown column 'supplier'`. |
| No `data.source.file.enumerate` skill exists | Listing files in a directory connection needs ≥1 fallback path (driver list → glob → sample-shape filename observations). Nobody wrote a single-shot prompt that reliably does all three, so the capability is just missing. |
| select-scope hallucinates `column: '<UNKNOWN>'` for column-targeted skills | The meta-skill has no programmatic access to the connection's actual columns. It tries to guess from the user's question text. If the guess is wrong, the column-targeted skill has no recovery path. |
| Writer falls into a repetition loop in section 5 | Single-shot generation with `maxTokens: 1200` and nothing to stop it once it runs out of grounded things to say. |
| 30+ LLM round-trips per question on the meta layer | classify + select per section, write + review + refine + re-review per section, all single-shot calls. The meta plumbing is a substitute for in-skill judgment. |

The pattern: **every failure is a place where the skill needed to think for more than one prompt-cycle, and couldn't.**

---

## Goals

1. **Skills can iterate internally.** Plan → tool → reflect → tool → reflect → result, all inside one logical "skill execution," with the orchestrator unaware of the internal turn count.
2. **Skills carry state for the duration of one execution** — provisional findings, a confidence rating per claim, a set of dropped hypotheses. This state is the substrate iteration mutates.
3. **Every claim a skill returns is grounded in its own evidence ledger.** The skill self-checks before returning. The external grounding-review becomes belt-and-suspenders, not the primary error-catch.
4. **Skills know their primary intent.** A skill receives the user's question (or a sub-question), not just an args struct. The skill optimizes for *answering the question*, not for "producing a typed value of shape X."
5. **The L1/L2 split is explicit.** Stateful wrappers around tools (evolved-L1) remain as primitive capabilities. Agentic skills (L2) compose them. Keep both. Don't collapse into a single model.
6. **Cost ceiling per skill is enforced at the runtime.** A budget (tokens / wall-clock / sub-call count) is part of the L2 skill's invocation contract. Runaway loops are killed by the runtime, not by hope.
7. **L1 skills carry persistent context per (workspace, skill).** Built at indexing time, updated by downstream feedback. Cold execution paths are the rare slow case, not the norm.

## Non-goals

- **Not** rewriting L1 skills. They become primitives the L2 layer calls. Their API stays.
- **Not** removing the orchestrator. The data-analyzer / code-analyzer orchestrators still own session lifecycle, IPC, chat-stream framing. They just delegate to one (or a few) L2 skill calls instead of running the classify+select+write+review machinery themselves.
- **Not** introducing a generic AGI agent loop. L2 skills are scoped to a primary intent. They are not free-form ReAct loops; they are domain agents with a stated objective.
- **Not** locking in a UI/chat-stream contract for L2 progress events in this doc. That's a follow-up once the runtime stabilizes.

---

## Two-tier architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  Orchestrator (data-analyzer, code-analyzer)                          │
│  - owns session, IPC, chat-stream                                     │
│  - delegates to ≥1 L2 skill                                           │
└────────────┬──────────────────────────────────────────────────────────┘
             │
             ▼  invokes ≥1 L2 skill with {task, budget, ctx}
┌───────────────────────────────────────────────────────────────────────┐
│  L2 — Agentic skill                                                   │
│  - receives task + budget + assembled context (from substrate)        │
│  - internal loop: plan → call L1/L2 → reflect → revise                │
│  - maintains evidence ledger on top of substrate's working state      │
│  - self-grounds before returning                                      │
│  - returns SkillResult { value, evidence, confidence, notes }         │
└────────────┬──────────────────────────────────────────────────────────┘
             │
             ▼  composes L1 capabilities + nested L2 calls
┌───────────────────────────────────────────────────────────────────────┐
│  L1 — Capability skill (evolved from today's skills)                  │
│  - typed wrapper over 1-2 tool calls                                  │
│  - reads from context slots assembled by the substrate                │
│  - pins working-state entries that distill back to memory             │
│  - parallelizable per (workspace, skill, input-key)                   │
│  - auditable                                                          │
└────────────┬──────────────────────────────────────────────────────────┘
             │ reads context ↑ ↓ pins working-state entries
             ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Memory + Context substrate                                           │
│  See plans/memory-context-substrate.md — D1 through D15 + D5a.        │
│  - memory store (workspace files + Lance index)                       │
│  - context assembler (memory + providers + task → typed briefing)     │
│  - working state ledger (per-execution scratch; distill to memory)    │
│  - lifecycle runner (bootstrap, applyFeedback, context-builder DAG)   │
│  - user-assertion classifier (turns chat → constraint memory)         │
└───────────────────────────────────────────────────────────────────────┘
```

**L1 skills are substrate consumers.** Dispatch interface (`Skill<I, O>`, `execute(input, deps)`) is largely unchanged; the wins come from `deps` now providing substrate-assembled context + a working-state ledger that the substrate distills back to memory. See "L1 skills as substrate consumers" below.

**L2 skills are new.** Different interface, different runtime, different lifecycle. They read from substrate-assembled context like L1 does, but the runtime gives them a *richer* working-state view — the evidence ledger — with self-grounding discipline. See "L2 skill contract."

---

## L2 skill contract

```ts
interface L2Skill<I, O> {
  id: string;                                  // 'data.answer-question'
  description: string;                         // for catalog discovery
  family: SkillFamily;                         // existing taxonomy
  owner: string;                               // 'data-analyzer'
  version: number;

  inputs:  JsonSchema;                         // typed input
  outputs: JsonSchema;                         // typed output

  // Hard caps the runtime enforces. The skill MAY return early with
  // best-effort results when a cap is exhausted; it MUST NOT exceed
  // them.
  defaultBudget: SkillBudget;

  // The skill body. Receives the invocation envelope (A2: typed input
  // + freeform invocationContext) and an L2-specific deps with the
  // agentic primitives (working state, sub-calls, self-grounding).
  run(invocation: L2Invocation<I>, deps: L2Deps): Promise<SkillResult<O>>;

  preconditions?: readonly Precondition[];
  toolDeps?: readonly string[];                // declared L1 tools it may call
  skillDeps?: readonly string[];               // declared L1+L2 skills it may call
}

interface SkillBudget {
  readonly maxTokens:      number;             // sum across the call tree (A3)
  readonly maxSubCalls:    number;             // L1+L2 invocations, shared across call tree (A3)
  readonly maxWallclockMs: number;
  readonly maxDepth?:      number;             // A3: default 4
}

interface L2Deps {
  readonly session:      Session;

  // The substrate's working-state ledger. L2 skills append sub-call
  // results + provisional claims here, pin entries for distillation
  // on return, and self-ground against it before returning (A1).
  readonly workingState: WorkingStateLedger;

  // The substrate-assembled context briefing — typed slots populated
  // from memory + providers + session (per the skill's contextSlots
  // declaration). Distinct from invocationContext (A2).
  readonly context:      AssembledContext;

  // Cold-path memory access; budget-accounted, requires coldPathOwners
  // for cross-owner reads. See substrate doc.
  readonly memory:       MemoryStore;

  readonly budget:       BudgetTracker;        // remaining + accounting (shared, A3)

  // Sub-call dispatch. Both honor + decrement the shared budget.
  // Runtime auto-appends results to workingState (A4 sub-call-finished event).
  readonly callL1: <I, O>(id: string, input: I) => Promise<SkillResult<O>>;
  readonly callL2: <I, O>(invocation: L2Invocation<I>, opts?: SubL2Opts) => Promise<SkillResult<O>>;

  // LLM access. Mediated so the runtime can account tokens against
  // the budget. Same provider abstraction as today.
  readonly llm:    L2LlmAccess;

  // Cancellation. Substrate respects this signal in all memory + context ops.
  readonly signal: AbortSignal;

  // Progress events (chat-stream upstream, A4 taxonomy).
  readonly emit:   (event: L2Event) => void;
}
```

The signature change versus L1: **the skill takes a goal + invocation context, not a resolved args struct** (A5: classify-question emits a `goal` per candidate; A2: caller passes freeform `invocationContext`). The skill's job is planning how to achieve the goal.

---

## L1 skills as substrate consumers

The substrate handles persistence, bootstrap, feedback, indexing, ranking, and conflict resolution. L1 skills register their declarations and consume the substrate's primitives. This section is short by design — most of what would have lived here is now in the substrate doc.

### What changes for an L1 skill

```ts
interface Skill<I, O> {                       // evolved L1 skill
  id: string;                                 // 'data.source.file.describe'

  // Substrate declarations:
  ownerId: OwnerId;                           // D1: typically `skill:<id>`
  schemaVersion: number;                      // D9: bump → wipe + re-bootstrap
  interestedTriggers: readonly BootstrapTrigger['kind'][];
  contextSlots: readonly ContextSlotSpec[];   // what context the substrate assembles for execute()
  memorySchema: readonly NamespaceSpec[];     // namespaces this skill writes (D3 distill policy per namespace)
  assertionInterests?: readonly AssertionInterest[];  // D14: subjects this skill cares about

  // Lifecycle hooks (all optional; the substrate calls them):
  contextBuilders?: readonly ContextBuilderSpec[];     // D15: indexer dispatches via DAG
  applyFeedback?(events, deps): Promise<void>;         // D8 fire-and-forget; no idempotency required

  // Existing entry point, with one addition: deps now includes the
  // substrate-assembled context + a working-state ledger.
  execute(input: I, deps: SkillDeps): Promise<SkillResult<O>>;
}

interface SkillDeps {
  readonly session:      Session;
  readonly context:      AssembledContext;    // substrate-assembled per the slot declarations
  readonly workingState: WorkingStateLedger;  // per-execution; pinned entries distill on return
  readonly runTool:      <I, O>(call: ToolCall) => Promise<SkillToolResult>;
  readonly memory:       MemoryStore;         // cold-path access; budget-accounted (substrate hot-path rule)
  readonly signal:       AbortSignal;
}
```

### What goes in memory (the four context types)

The substrate's type taxonomy maps onto skill memory cleanly:

- **Type 1 — Static scan.** Context builders run at indexing time. Schema caches for file connections, RDBMS table inventories, module digests, language detection. Stored as `kind: fact`, sourced as `{kind: 'bootstrap', ...}`.
- **Type 2 — External inputs.** Library docs, MCP responses, web-search results. Sourced via context providers (D5a); cached as `kind: fact` with provenance.
- **Type 3 — Observations.** Patterns the skill notices at runtime (e.g., "this connection's `vendor_details` field is never null in 100% of sampled rows"). Distilled as `kind: hint` with tier (D13: `system-constraint` / `pattern` / `incidental`).
- **Type 4 — User assertions.** Routed by the substrate's classifier (D6) per the skill's `assertionInterests` (D14). Stored as `kind: constraint`.

### What execute() actually looks like

```ts
execute: async (input, deps) => {
  // Substrate has already assembled the slots. No cold-path tool calls
  // needed if the schema is cached + the user has no relevant aliases.
  const cached  = deps.context.slots.get('cached-schema')?.[0];
  const aliases = deps.context.slots.get('aliases') ?? [];

  // Apply learned aliases to the input (Type 4 user assertion path).
  const resolvedColumn = applyAliases(input.column, aliases) ?? input.column;

  if (cached && !isStale(cached)) {
    return { value: cached.value, confidence: 'high', notes: [] };
  }

  // Cold path: hit the underlying tool.
  const fresh = await deps.runTool({ name: 'db_file_describe',
                                     input: { connectionId: input.connectionId } });

  // Pin to working state; substrate distills on successful return.
  const ref = deps.workingState.append({
    source: { kind: 'tool', toolId: 'db_file_describe' },
    payload: fresh,
    claims: [`schema-of:${input.connectionId}`],
    confidence: 0.9,
  });
  deps.workingState.pin(ref, {
    owner: 'skill:data.source.file.describe',
    namespace: 'schema-by-connection',
    key: input.connectionId,
    kind: 'fact',
  });

  return { value: fresh, confidence: 'high', notes: [] };
}
```

The skill body is small. Caching, alias resolution, distillation, and persistence are substrate concerns.

### Migration of existing L1 skills

For each currently-stateless L1 skill, the work is:
1. Declare `ownerId`, `schemaVersion`, `interestedTriggers`, `contextSlots`, `memorySchema`.
2. Optionally declare `contextBuilders` for static-scan caching at bootstrap time.
3. Optionally declare `assertionInterests` so user-asserted rules can reach the skill.
4. Optionally implement `applyFeedback` for downstream-event-driven refinement.
5. Rewrite `execute()` to consult `deps.context.slots` before calling tools, and to pin tool results into working state.

None of these are mandatory — a stateless L1 skill works as before, with empty slots and no distillation. Adoption is incremental, per-skill.


---

## The evidence ledger (L2's view of working state)

L2 skills don't need a separate primitive. The substrate's **working-state ledger** is exactly what L2 skills require — append-only, mutable, per-execution, distillable to memory on return. The L2 runtime adds two thin layers on top:

1. **Auto-append discipline.** When the L2 body calls `deps.callL1(...)` or `deps.callL2(...)`, the runtime automatically appends the sub-call's result to the working-state ledger with `source: { kind: 'sub-call', skillId, callRef }`. Skill authors don't manually mirror sub-call results into the ledger.
2. **Self-grounding rule (A1).** Substrate validates *structure* — every output declares `evidence: Evidence[]`, every `LedgerRef` in `evidence[].citations` resolves to a real ledger entry. *Quality* (does the citation actually support the claim?) is the skill's responsibility as the domain expert.

That is the entire L2 ledger surface. The substrate's `WorkingStateLedger` interface (see [`plans/memory-context-substrate.md`](plans/memory-context-substrate.md) §"Working state ledger") provides `append`, `list`, `get`, `pin`. L2 reuses it directly.

**Distillation.** Pinned entries on successful return become memory writes per the namespace's D3 policy. An L2 skill that wants to remember "this sub-call yielded a useful profile for this connection" pins the relevant ledger entry to a memory namespace, and the substrate handles the rest.

---

## L2 runtime

The runtime is the new component that lives between the orchestrator and the L2 skill body. Responsibilities:

1. **Budget tracking.** Two separate budgets, both enforced:
   - **Context budget** (substrate D2): tokens for assembled context, owned by the caller (orchestrator), enforced by the substrate's assembler.
   - **Execution budget** (this runtime): `SkillBudget` from the L2 invocation contract — `maxTokens`, `maxSubCalls`, `maxWallclockMs`. Decremented on every LLM token, sub-call, and wall-clock tick.
2. **Sub-call dispatch.** When the L2 body calls `deps.callL1('data.source.file.describe', {...})`, the runtime invokes today's L1 invocation machinery, auto-appends the result to the working-state ledger, and accounts the cost against the execution budget.
3. **Cancellation propagation.** `deps.signal` is wired from the orchestrator's cancellation. Sub-calls inherit. Substrate respects the signal in all memory + context operations.
4. **Crash-resume scope.** Within-execution durability isn't supported by the substrate (D8 fire-and-forget for events; in-memory working state). Long-running L2 calls don't survive daemon restart. Agents that need multi-turn continuity use the existing [`agent/framework/checkpoint.ts`](src/insrc/agent/framework/checkpoint.ts) at the orchestrator layer — a separate concern from the L2 runtime.
5. **Working-state size enforcement** (substrate D12): the runtime surfaces `deps.workingState.size()` to the skill body; hard-cap exceptions are thrown from `append()`.
6. **Progress events.** `deps.emit` flows to chat-stream so the user sees "skill is thinking" milestones, not just final results.
7. **Telemetry.** All sub-calls + LLM calls + ledger appends emit structured log lines (same `pino` model as today). Substrate-level telemetry (`memory:read`, `context:assemble`, etc.) flows alongside.

The runtime does **not** decide what the skill should do. It enforces caps and provides primitives.

---

## Concurrency model

**Within a single L2 call: sequential by default.** The internal loop is `plan → call → reflect → revise → ...`. Each step typically depends on the previous one's output (the ledger contents).

**Exception: independent discovery.** When an L2 skill knows it needs multiple independent facts (e.g., "describe + sample + scorecard"), it can call `Promise.all([callL1(...), callL1(...), callL1(...)])`. This is the L1 batching the user already has — preserved.

**Across L2 calls: parallel allowed.** The orchestrator can invoke 2+ L2 skills concurrently (e.g., one per planned section). Each owns its own ledger; they don't share state.

**Forbidden:** `Promise.all` on calls that reach the LLM provider (per [`no_parallel_llm_calls`](https://example/no-parallel-llm-calls.md) memory). Sub-call dispatch is parallel-safe only when targeting tools, not LLM-bearing L1 skills.

---

## Migration / interop

The L2 layer is **additive**. Today's skills, today's classify/select-scope/grounding-review machinery, today's orchestrators all keep working. The substrate ships first — it's a dependency for everything downstream.

**Phase 0 — Substrate primitives.**
- Implement the memory store, context assembler, working-state ledger, and indexing framework per [`plans/memory-context-substrate.md`](plans/memory-context-substrate.md).
- Implement the lifecycle runner (bootstrap dispatch, applyFeedback routing, context-builder DAG executor per D15).
- Implement the user-assertion classifier (D6) with default heuristics + LLM stub.
- Ship behind no skill / agent changes — just the framework exists. Verify with substrate-internal tests.

> **Fine-grained sequencing:** Phase 0 is implemented as sub-phases `P0`–`P5` in [`plans/skills/substrate-implementation-status.md`](plans/skills/substrate-implementation-status.md). Each sub-phase has explicit done criteria. The first L1 skill migration (this doc's Phase 1, first item) actually lands as the substrate-status doc's `P1`, before all of Phase 0 is complete — by design, validating the substrate against one real skill before building the remaining components (Lance index, providers, classifier, feedback bus).

**Phase 1 — Migrate the loudest L1 skills onto the substrate.**
- Pick 3–4 highest-value skills (`data.source.file.describe`, `data.source.file.sample-shape`, an rdbms equivalent, the codebase entity locator).
- Each declares `ownerId`, `schemaVersion`, `interestedTriggers`, `contextSlots`, `memorySchema`, and a `contextBuilders` spec for the indexer's bootstrap path.
- Rewrite their `execute()` to consult `deps.context.slots` before tool calls.
- Measure: cold-vs-warm latency, indexing time inflation, hit rate on context-slot reads vs cold tool calls.

**Phase 2 — Feedback ingestion (read-only).**
- Grounding-review verdicts and L1 invocation telemetry start producing `FeedbackEvent`s; the substrate's bus dispatches them fire-and-forget (D8).
- Skills can implement `applyFeedback`; for the first release, just log + verify the events are well-formed. No mutation.

**Phase 3 — One pilot L2 skill.**
- **Priority migration target: the code-analyzer.** See [`plans/code-analyzer-migration.md`](plans/code-analyzer-migration.md) for the code-analyzer-specific phasing, context builders, and pilot strawman (`code.audit-module` → `code.answer-question`). The code-analyzer has more prompts, more LLM round-trips per question, and a richer indexed substrate (the code KG) than the data-analyzer; it benefits more from the substrate + L2 model.
- The data-analyzer's `data.answer-question` is a separate pilot that follows the code-analyzer one. Both are L2 skills using the same framework; sequencing puts code-analyzer first.
- Wire the chosen pilot as an opt-in path in its orchestrator behind a feature flag. Existing pipeline stays as default.
- Measure: tokens-per-question, sections-with-real-evidence, citation-hallucination rate.

**Phase 4 — Skills act on feedback.**
- L1 skills implement `applyFeedback` and mutate memory in response to events.
- User assertions routed via the classifier (D6 + D14) land as `kind: constraint` in the right skill's `user-assertions` namespace.
- Observations distilled with explicit tiers (D13).
- Measure: improvement on questions that touch previously-corrected concepts.

**Phase 5 — Replace the writer + grounding loop.**
- If pilots show the loop collapses cleanly, kill the writer + grounding-review pingpong. Sections are produced by L2 skills directly.
- Classify-question + select-scope **stay** as L1 helpers callable by L2 skills.

**Phase 6 — Code-analyzer parity + cross-domain L2.**
- Apply the bootstrap + feedback pattern to code skills.
- Build the first cross-domain L2 skill: `data.entity.match-to-class` (the missing capability we identified during the GRN run). Calls both data.* L1 skills and code.* L1 skills internally.

**Phase 7 — Cleanup.**
- Drop unused dead code from the old pipeline.
- Promote the L2 path from feature-flagged to default.

Each phase is independently shippable + rollback-safe.

---

## Worked example: the GRN question

Today's flow (per section, ×5 sections):
```
classify-question (LLM, ~3-5s)
  → select-scope (LLM, ~3-5s)
    → execute N L1 skills (tool calls, ~100ms each)
      → writer (LLM, local, ~10s)
        → grounding-review (LLM, cloud, ~10s)
          → if reject: refinement (LLM, local) + re-review (LLM)
                 |  iterate up to N times
                 ▼
            section text
```
Total: ~30 LLM calls per section × 5 sections = 150 calls. ~60% of sections returned with hallucinated citations or empty evidence.

L2 flow (one skill, one execution), with the substrate fully wired:
```
data.answer-question( task="how does this data map to the GRN structure",
                     budget={tokens:20000, subCalls:30, wallclockMs:120000} )
  ↓ substrate assembles context per skill's declared slots:
      - cached-schema (from skill:data.source.file.describe / schema-by-connection)
      - aliases       (from skill:data.source.file.describe / aliases)
      - user-asserts  (from skill:data.answer-question / user-assertions)
      - active-conns  (from provider:active-session)
  ↓ runtime invokes skill.run(invocation, deps); deps.context already populated
  ↓ skill internally:
  1. plan: identify what evidence buckets I need
       - directory inventory (TRY)
       - schema describe        ← warm hit from cached-schema slot
       - sample-shape           ← warm hit from prior bootstrap
       - per-field profile (numeric + categorical)
       - quality scorecard      ← warm hit from prior bootstrap
       - cross-ref with code KG (provider:code-kg) → "no GRN class found"
  2. dispatch L1 + L2 calls (parallel where independent)
       - 3 warm reads return from substrate context in <10ms (no DuckDB)
       - 2 cold L1 calls run; results appended to working-state ledger
       - L1 skills pin their tool outputs; substrate distills to memory on return
  3. reflect: I have schema + samples + quality. I do NOT have a
     filename inventory (driver doesn't expose it). I do NOT have
     a code-side GRN class. Both gaps are durable, not iteration-fixable.
  4. draft answer with explicit gap callouts
  5. self-ground every claim against the working-state ledger; drop unsupported ones
  6. return SkillResult{ value: { sections: [...] }, evidence: [refs], notes: [...] }
  ↓ substrate distills pinned working-state entries to memory
  ↓ later, when the reviewer / user accepts:
  → FeedbackEvent{kind:'accepted'} fans out fire-and-forget to every cited skill (D8)
  → each cited skill's applyFeedback bumps confidence on the cited memory entries
```
Total: ~5 LLM calls (1 plan + 1 reflect + 1 draft + 1 self-ground + 1 finalize) + 5 L1 dispatch calls (3 warm hits + 2 cold) = 10 calls, with most of the structural-knowledge work done at indexing time.

The gap-callouts (no filename inventory, no code-side class) become **honest framing** in the report instead of fabricated content from a writer with nothing to say. And the second time the same question is asked, even the 2 cold L1 calls become warm hits — the second run touches the LLM only ~5 times.

If the user later corrects something — "no, supplier is `vendor_details` in this workspace" — the classifier (D6) routes the assertion to `skill:data.source.file.describe`'s `aliases` namespace (D14). Subsequent runs of any skill that declared that slot pick up the constraint automatically.

---

## Decisions log

All L2-framework decisions surfaced during the iteration. Each is the framework's locked-in answer; refinements come during implementation.

**Quick reference:**

| # | Decision | One-line summary |
|---|---|---|
| A1 | Self-grounding | Substrate validates structure (`evidence: Evidence[]` + citation referential integrity); skill is the domain expert and owns quality. |
| A2 | Primary intent | Typed `input: I` for required parameters; freeform `invocationContext` for caller hints. No structured `Intent` coupling. |
| A3 | L2 nesting | Hard depth cap (default 4) + shared `SkillBudget.maxSubCalls` across the entire call tree. Either limit hit throws. |
| A4 | Progress streaming | 9-kind `L2Event` taxonomy + `custom` escape hatch. Runtime auto-emits `sub-call-*`, `ledger-grew`, `returning`; skill emits the rest. Best-effort fire-and-forget. |
| A5 | classify + select-scope | Both stay as L1 helpers. classify-question's output gains `goal: string` per candidate (the routed skill's natural-language objective). L2 skills consume the goal; select-scope demoted to L1 arg-filler utility. |
| A6 | Testing | Live local-LLM integration tests (Ollama qwen3-coder). Canned tool calls OK; canned LLM responses not. Structural assertions only — never exact prose match. |

### A6 — Testing: live local-LLM integration tests, structural assertions only

L2 skills' value is the agentic loop — judgment, planning, retry, self-grounding. Fake providers exercise the skill's code paths but not the LLM behavior the loop depends on. Today's GRN run made this concrete: fake-provider unit tests passed across the meta-skill tool-call migration; the live local run immediately surfaced qwen3-coder omitting `connectionId`, hallucinated HDFS paths, and the 488MiB DuckDB cap. Mocked tests can't catch any of that.

**Lock:** L2 tests are integration tests against a **live local LLM** (qwen3-coder via Ollama). Not against fake providers. Not against cloud (cost + flakiness).

**Test shape:**

- **LLM is real.** Tests boot against a running Ollama instance (CLAUDE.md's existing `source ~/.insors && npx tsx scripts/test-*-live.ts` pattern). CI machines need Ollama installed; tests document this prerequisite.
- **Tool calls may be canned.** The LLM's reasoning is what's being tested, not the underlying tool surface. A test for `data.answer-question` can mock the connection roster + L1 skill responses while keeping the LLM and the L2 runtime live. This separates LLM-judgment failures from environmental setup costs.
- **Assertions are structural.** Output evidence array is non-empty (when inputs warrant); every citation resolves to a ledger entry; output type-checks against the declared schema; key facts from the canned tool results are reflected in the answer. **Never** exact-string match on LLM-generated prose.
- **Property-based when possible.** "If input mentions X, output should mention X-related concept" via embedding-similarity check or substring family, not exact match.
- **Temperature 0** for the lowest stochasticity Ollama / qwen offers. Repeats across multiple runs to detect drift.
- **Sparing use of snapshot tests** for outputs that genuinely should be stable (e.g., the structured `Evidence[]` shape). Never for prose.

**What the substrate-side stays:**

- L1 skill unit tests stay on the fake-provider pattern. L1 is deterministic enough that mocks are useful — they pin tool-call contracts + execute() body logic.
- Substrate primitives (memory store, context assembler, working-state ledger, indexer, classifier) get unit tests with mocks. Their behavior doesn't depend on LLM judgment.

**Infrastructure work this implies:**

- A `daemon/skills-l2/__tests__/live/` directory hosting live L2 integration tests.
- A test harness that wraps `runL2()` with canned-tool injection but a real Ollama provider.
- CI configuration that either runs live tests on machines with Ollama (preferred) or skips them with a clear marker (acceptable for fast PR feedback but not for merge gates).
- Documentation that live tests must be run before any L2 PR ships.

**What this rules out:**

- "Unit-test-style" L2 tests with fake providers as the primary verification mode. Fine for narrow code-path coverage; not sufficient as the only safety net.
- Cloud-LLM-based tests. Cost + flakiness + CI-API-key complexity outweigh any benefit; local LLM exercises the failure modes we actually care about.

### A5 — classify-question emits goals; select-scope is an L1 arg-filling utility

Keep both as L1 helpers but reshape the contract: classify-question becomes the bridge between the user's intent and per-skill goals. Each routed skill receives a *goal*, not just a skill id. The skill itself is responsible for planning how to achieve the goal.

**classify-question — evolved output:**

```ts
interface ClassifyOutput {
  questionType: string;
  candidates: readonly {
    skillId: string;
    goal: string;                            // NEW — natural-language instruction for this skill
    rationale: string;
    mustHaveScope: 'connection' | 'connection+target' | 'connection+target+columns' | 'none';
  }[];
  fallbacks: readonly string[];
  uncertaintyNotes: readonly string[];
}
```

The `goal` is what gives each routed skill direction. "Analyze file abc" is directionless; "Identify the join keys between this file's records and the GRN domain model's expected structure, focusing on field name overlap" is a goal a skill can plan against.

**Dispatch model:**

- **For L2 skills** (which plan their own work): dispatched with `invocationContext.goal` set from the classify output. The L2 skill's planning step consumes the goal and decides how to fulfill it. No separate arg-filling step.
- **For L1 skills** (which take typed args): select-scope runs as a utility step to fill `input: I` based on `(goal, connection roster, skill's input schema)`. The L1 skill ignores `invocationContext` and works from the filled args as before.

**select-scope demoted:**

- Not the primary routing mechanism — classify-question's goals are.
- Continues to exist as an arg-filling utility, primarily because local LLMs consistently miss nested arg shapes. When the cloud model is reliable, select-scope is a safety net. When the local model is in use, it's load-bearing for L1 routing.
- L2 skills don't call select-scope. They consume the goal directly.

**What this changes about the previous A5 (hybrid keep-as-helpers):**

- Both helpers stay. But classify-question's output shape evolves to include goals.
- The "L2 skill MAY call them" framing tightens: L2 skills consume classify-question's goal (from the orchestrator that called classify). They don't call select-scope themselves.
- For L1 dispatch from an L2 skill (`deps.callL1`), select-scope can be optionally invoked under the hood by the L2 runtime if the L2 skill provides a goal-shaped request rather than fully-filled args — TBD as the pilot lands.

**Why this works:**

- classify-question already does the "what skills" decision. Adding per-skill goals is a natural extension; the LLM is already reasoning about why each skill applies.
- L2 skills don't need a separate planning step for "what should I do" — they get the goal directly. Their planning is "how to achieve it."
- L1 skills don't change. select-scope's role narrows but is well-bounded.
- The local-model fragility on arg shapes isn't pretended away — select-scope addresses it explicitly.

### A4 — Streaming intermediate state to chat: core L2Event taxonomy

L2 internal iterations can take 30+ seconds. The runtime surfaces a structured event stream the chat-stream consumer renders as progress. Core kinds + an escape hatch for skill-specific events.

```ts
type L2Event =
  | { kind: 'plan-step';           description: string;                         at: number }
  | { kind: 'sub-call-started';    callId: string; targetSkill: string;         at: number }
  | { kind: 'sub-call-finished';   callId: string; success: boolean; durationMs: number; at: number }
  | { kind: 'ledger-grew';         count: number;                               at: number }
  | { kind: 'draft-emitted';       sectionId?: string;                          at: number }
  | { kind: 'self-ground-flagged'; claim: string;                               at: number }
  | { kind: 'returning';           success: boolean;                            at: number }
  | { kind: 'message';             text: string;                                at: number }
  | { kind: 'custom';              type: string; payload: unknown;              at: number };
```

**Runtime-emitted automatically (skill doesn't have to):**
- `sub-call-started` / `sub-call-finished` — around every `deps.callL1` / `deps.callL2`.
- `ledger-grew` — when entries are appended to the working-state ledger.
- `returning` — just before the skill returns.

**Skill-emitted (when it wants):**
- `plan-step`, `draft-emitted`, `self-ground-flagged`, `message`.
- `custom` for events that don't fit core kinds (UI ignores `type`s it doesn't recognize).

**Delivery:** skill emits via `deps.emit(event)`; runtime forwards to chat-stream. Best-effort fire-and-forget — no persistence, no back-pressure; drops events rather than blocking the skill if the consumer is slow. Per-execution ordering preserved.

**Not locked here:** wire format on the chat-stream side (chat-stream owns its protocol), UI rendering decisions, localization.

### A3 — L2 nesting: hard depth cap + shared call-count budget

Two independent guardrails on L2-to-L2 calls; either limit hit throws.

**Depth cap.** The L2 runtime tracks invocation depth (orchestrator-level call = depth 1; nested L2 calls increment). Default hard cap = **4**. Configurable at the orchestrator level (not per-skill — depth is a property of the *call stack*, not the skill).

**Call-count budget.** The top-level L2 invocation's `SkillBudget.maxSubCalls` is the **single shared counter** across the entire call tree under it. Sub-L2 calls deduct from the parent's remaining budget, not their own. A sub-L2 cannot exceed what the parent has left, regardless of what it declared as its own default.

```ts
interface SkillBudget {
  readonly maxTokens:     number;       // shared across the call tree
  readonly maxSubCalls:   number;       // shared across the call tree
  readonly maxWallclockMs: number;      // shared across the call tree
  readonly maxDepth?:     number;       // default 4
}
```

**Why both:**
- Depth-only doesn't catch fan-out: a skill at depth 2 could spawn 50 sub-calls, each within depth limit.
- Count-only doesn't catch unbounded recursion: a skill at depth 50 might fit within 50 calls.
- Both together bound the call tree from two angles.

**Why shared budget vs subset allocation:** simpler. A sub-skill that "thinks it has 30 calls of budget" but only has 3 remaining will fail differently from one that knows it has 3 remaining. Shared budget makes the limit visible at every level — sub-skills can query `deps.budget.remaining()` and adapt.

**Exceeding either limit** throws from the sub-call dispatch (`deps.callL2(...)` rejects). The parent skill can choose to handle the rejection (e.g., degrade to a simpler path) or propagate it up. The runtime doesn't kill the parent — it just refuses the would-exceed call.

### A2 — Primary intent: typed input + freeform invocation context

Two distinct surfaces, both passed to the L2 skill at invocation:

**Typed input (`input: I`).** Whatever the skill *requires* to run is declared in its `inputs: JsonSchema`. The substrate validates the input against the schema before invocation; missing required fields throw before the skill body runs. This is the contract — the skill cannot function without these.

**Invocation context (`invocationContext: InvocationContext`).** Freeform key-value, passed alongside the typed input:
```ts
type InvocationContext = Readonly<Record<string, unknown>>;
```
The caller stuffs additional context here — primary intent text, prior-turn refs, session hints, orchestration metadata, anything the caller thinks might help the skill optimize. The skill's body introspects the keys it knows about and ignores the rest. No substrate-level schema; no enforcement.

**Combined signature:**
```ts
run(invocation: L2Invocation<I>, deps: L2Deps): Promise<SkillResult<O>>;

interface L2Invocation<I> {
  readonly input:             I;                    // typed, schema-validated
  readonly invocationContext: InvocationContext;   // freeform, untyped
}
```

**Distinction from substrate-assembled context (`deps.context`).** Three different things, easy to confuse:
- `input: I` — the typed args this skill requires. Validated.
- `invocationContext` — caller-provided freeform hints. Not validated.
- `deps.context: AssembledContext` — the substrate's projection of memory + providers + session into typed slots the skill declared at registration.

The first two are caller-facing; the third is substrate-facing. They don't conflict.

**Why no structured `Intent` type:** would over-couple the skill layer to the intent-resolver layer. The skill can look for `invocationContext.intent` if it cares (and many won't) without binding to a specific resolver shape. Different callers can pass different shapes for the same key as long as the skills consuming them agree.

### A1 — Self-grounding: substrate validates structure, skill owns quality

The substrate enforces *structural* compliance. The skill is the domain expert and is the only entity that can speak to *quality*. These are different concerns and don't share an enforcement mechanism.

**Substrate-level (structural — enforced):**
- Every L2 skill's output type is `SkillOutput<V>` with required fields:
  - `value: V` — the typed payload.
  - `evidence: Evidence[]` where `Evidence = { claim: string; citations: readonly LedgerRef[] }`.
- The L2 runtime validates:
  - The output declares an `evidence` field (schema-level).
  - Every `LedgerRef` in `evidence[].citations` resolves to a real entry in the current execution's working-state ledger (referential integrity).
- Validation failure → runtime rejects the return, surfaces an error to the caller. Skill cannot complete with malformed output.

**Skill-level (quality — not enforced):**
- Whether the cited ledger entry *actually supports* the claim is a domain judgment. The substrate can't verify it.
- Whether the skill identified every claim in its `value` and grounded it is a domain judgment. The substrate can't verify it either.
- These are the skill author's responsibility, exercised through internal self-checks before return (a pattern, not a mandate).

**Per-skill opt-out:** `selfGroundingMode: 'none'` for genuinely citation-free outputs (a skill returning a single computed scalar where there's nothing to ground). Default is `'structured'` (the rule above).

**Why this split:** trying to make the substrate validate quality would either force every skill into a rigid claim-tree representation (over-constraining) or have the substrate guess at semantic correctness (impossible). The right division: structure is universal and verifiable; quality is domain-specific and only the skill knows.

---

## Open questions

None remaining at the design level. A1 through A6 are locked. Further questions will surface during implementation.

### Closed by substrate decisions

| Was | Resolved by |
|---|---|
| Persistence cadence + resume model | D8 fire-and-forget; agent-framework checkpoint for multi-turn continuity (separate concern). |
| Bootstrap trigger model | D15 substrate-managed DAG; indexer dispatches `BootstrapTrigger` events. |
| Feedback event delivery semantics | D8 best-effort fire-and-forget. No idempotency required. |
| Context-store ownership across workspaces | D5 absolute workspace isolation; D5a context providers handle cross-workspace read needs. |
| Conflict resolution between bootstrap + feedback | D4 layered policy (`constraint > fact > hint`, then confidence, then recency) + per-namespace merge override. |
| Privacy / sensitivity of persisted context | D10 not required in v1. |

---

## Risks

- **Cost ceiling discipline.** Without strong budget enforcement, an L2 skill in a loop can burn $X per question silently. The runtime must hard-cap aggressively.
- **Debuggability.** Stateful loops are harder to reproduce than today's call-once skills. Every ledger append + sub-call needs structured telemetry, and the eventual chat-stream UX needs to surface a "trace view" so we can post-mortem failures.
- **Local-model viability for L2.** Today's local meta-skill failure (qwen3-coder couldn't emit valid `submit_scope` payloads) suggests L2 skills will be cloud-bound at first. That's fine for Phase 1 but worth flagging — the local-first ethos in CLAUDE.md needs an honest qualifier.
- **Scope creep within a single L2 call.** Without a clear stop condition, an L2 skill keeps "improving" its draft past the point of diminishing returns. The skill body must own its own stop criteria, not lean on the runtime to kill it.

---

## What this doc is NOT yet committing to

- Exact `L2Skill` / `L2Deps` interface shape (the snippets above are illustrative).
- Whether the L2 path replaces or coexists-permanently-with the current pipeline (Phase 5 vs Phase 7 outcome).
- Which L2 skill gets built first as the pilot. (Strawman: `data.answer-question`.)
- Resolution of the six remaining L2-specific open questions above.

Substrate-level decisions are locked (D1–D15 + D5a in [`plans/memory-context-substrate.md`](plans/memory-context-substrate.md)). The next pass on this doc should resolve the L2-specific open questions, then add an interface draft we can implement against.
