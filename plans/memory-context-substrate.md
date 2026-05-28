# Memory + Context substrate

**Status:** draft (2026-05-28)
**Owner:** subhagho@gmail.com
**Standing position:** **memory and context are a core framework, not features of any single skill or agent.** Every skill and every agent inherits the same three-layer model: persistent **memory** (cross-session), assembled **context** (per-execution, read-only briefing), and mutable **working state** (per-execution scratch). Each layer has its own lifecycle, ownership rules, and persistence guarantees. Skills and agents declare what they consume + produce; the substrate provides the rest.

This doc covers the substrate only — not skill execution semantics, not agent loop logic, not orchestrator-level behavior. Those live in their respective docs and depend on this one.

Companion: [`plans/agentic-skills-architecture.md`](plans/agentic-skills-architecture.md) (the L1/L2 skill model that consumes this substrate).

## Why this is a substrate, not a skill feature

If memory and context are added per-skill, three things go wrong:

1. **Each skill reimplements the wheel.** Bootstrap, feedback, conflict resolution, freshness — every skill author solves the same problems with slightly different answers, and they don't compose.
2. **Cross-skill learning is impossible.** When the user corrects `supplier → vendor_details`, only the skill that owns the alias benefits. Every other skill in the workspace re-makes the same mistake until it too gets corrected.
3. **Skills can't be tested for memory/context behavior in isolation.** Bootstrap → execute → feedback round-trips become integration tests instead of unit tests.

Making memory/context a substrate means:
- One implementation, every skill / agent uses it.
- One ownership model — clear rules about which owner sees which entries.
- One feedback bus — corrections fan out to *every* affected owner, not just the one that emitted the last claim.
- One testing harness — the substrate has its own tests; skills test their consumption + production against fakes.

It also means this layer ships before any agent that depends on it, and it can evolve independently.

## What the substrate provides

```
┌────────────────────────────────────────────────────────────────────┐
│  CONSUMERS: skills (L1, L2), agents (Pair, Delegate, Designer,     │
│  Brainstorm, planners, classifiers, etc.)                          │
└────────┬────────────────┬─────────────────┬────────────────────────┘
         │                │                 │
   reads context    writes working    applies feedback
         │                │                 │
         ▼                ▼                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  SUBSTRATE                                                          │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
│  │ Memory store     │  │ Context assembler│  │ Working state   │  │
│  │ - per (workspace,│  │ - projects memory│  │ ledger          │  │
│  │   owner, ns)     │  │   + task + sess  │  │ - per execution │  │
│  │ - files + Lance  │  │ - typed briefing │  │ - distill on    │  │
│  │   index          │  │ - budget-aware   │  │   return        │  │
│  └──────────────────┘  └──────────────────┘  └─────────────────┘  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
│  │ Feedback bus     │  │ Lifecycle runner │  │ Owner registry  │  │
│  │ - fan-out events │  │ - bootstrap      │  │ - schema decls  │  │
│  │ - fire-and-forget│  │ - applyFeedback  │  │ - context       │  │
│  │ - in-process     │  │ - build DAG      │  │   builders      │  │
│  └──────────────────┘  └──────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Context types — the orthogonal axis

The memory / context / working-state model is about *persistence*. There's a second axis that matters at least as much: **what nature of knowledge does this context entry represent?** Three types so far, each with a distinct origin, refresh model, and authority:

### Type 1 — Static scan (workspace structure)

Knowledge derived from the workspace as it exists. Produced during indexing. Refreshable by re-scanning. High authority (directly observed). Represents the *structural reality* of the workspace at a point in time.

Examples:
- The code knowledge graph: entities, relations, manifests (already in the system today via `indexer/`).
- File trees, module summaries, dependency manifests.
- A data connection's schema, sample-shape, column inventory.
- Detected stylistic facts: "this repo uses vitest", "the test directory is `tests/`", "indentation is tabs".

How it's produced:
- During indexing (initial repo-add, re-index, scheduled refresh), agents/skills can register **context builders** that the indexer dispatches.
- A context builder is a typed extractor: input is a slice of the workspace (file, module, repo) the indexer hands it; output is a set of typed memory entries scoped to that builder's owner.
- The indexer orchestrates: scheduling, budgeting, dependency ordering (e.g., language detection before module summaries), and incremental update when files change.

Storage: workspace memory, `kind: 'fact'`, sourced as `{ kind: 'bootstrap', trigger: ... }`. Eligible for refresh-on-rescan.

### Type 2 — External inputs

Knowledge sourced from outside the workspace. Web searches, library/dependency documentation, package registries, MCP servers, external APIs.

Examples:
- Library docs (npm registry, PyPI, JavaDoc, Go pkg docs).
- API specs from MCP servers.
- Web-searched answers to "what's the default behavior of FunctionX in libraryY?"
- Vendor docs for an external service the workspace integrates with.

How it's produced:
- Two modes: **fetched on-demand at context-assembly time** (cheap, fresh, but blocks execution) or **pre-fetched and cached** (warm, possibly stale).
- A fetch needs explicit authorization (network access, MCP server registration).
- Sourced via the context-provider mechanism (D5a) — providers are the registration point for "this is an external source I can ask."

Storage:
- Cached results live in workspace memory tagged as `kind: 'fact'` with a content-derived freshness signal (etag, version, fetch time + TTL).
- On-demand fetches don't persist by default but can opt in to caching.
- Provenance is mandatory: every external-input entry carries the source identifier + fetch time + version pin if available.

Authority: variable per source. Official docs > LLM-summarized docs > random web. The provider declares its trust profile so the conflict-resolution policy can weight accordingly.

### Type 4 — User assertions (classified)

Knowledge stated directly by the user in chat or via explicit input. Authoritative when accepted; rejected when the classifier decides the statement is task-local, ambiguous, or not a durable rule. Distinct from observations because the originator is a human and the conflict-resolution authority is highest.

Examples (with classifier outcome):

| Assertion | Classified | Meaning |
|---|---|---|
| "do not use `hasattr` in code" | **yes** (accept) | Durable workspace rule; codegen / refactor skills avoid `hasattr` going forward. |
| "commit after every change" | **no** (reject) | Not a durable rule. Could be conversational, task-local, or contradicting a prior accepted rule. Not stored as a constraint. |

How they're produced:
- Originates in chat input (a user turn), or via explicit "remember this" affordances.
- A **user-assertion classifier** evaluates each candidate and emits `accept` / `reject` plus a structured payload (subject, polarity, scope, target owners).
- Accepted assertions are written to memory as `kind: 'constraint'` with `source: { kind: 'user-asserted', turnId: ... }`.
- Rejected assertions are discarded (or logged for audit, never promoted).

Storage: workspace memory when accepted, scoped to the owners the classifier determines the assertion applies to. A "no `hasattr`" rule routes to codegen-related owners; a "commit format" rule routes to git-ops owners.

Authority: `constraint` tier, top of the conflict-resolution stack. Aging only happens via explicit re-assertion or contradiction.

### Type 3 — Observations (runtime-derived)

Knowledge discovered through execution — behaviors, side effects, pattern recognition across sub-calls. Not part of the workspace structure (won't show up in a static scan), not external (won't be in any docs).

Examples (user's framing):
- "Process X fails if allocated memory is less than 1 GB."
- "DuckDB connection Y crashes when intermediate results exceed 488 MiB" (this run, observed today).
- "Function Z is called with null in this codebase" (observed across multiple runs but not statically declared).
- "Test suite W is flaky when run in parallel."

How it's produced:
- Originates in **working state** during execution. A consumer (skill or agent) notices a pattern across sub-call results, errors, or LLM reasoning steps.
- The consumer decides whether to **distill** the observation into memory or let it expire with the working state.
- Distilled observations land in memory as `kind: 'hint'` (or `'constraint'` if confirmed by a user). They carry `source: { kind: 'observation', ledgerRef: ..., executionRef: ... }` so the originating run is traceable.

Lifecycle:
- Observations are **softer** than scan facts. They age faster, get superseded easier, can be invalidated by re-observation.
- A given observation may be re-discovered in multiple executions before it "settles" — the substrate's conflict resolution should handle this via confidence accumulation rather than overwrite (an observation seen 5 times is more confident than the same observation seen once).
- Observations can also be **invalidated** — e.g., "the 488 MiB cap was bumped to 2 GB" should invalidate the prior observation rather than silently coexist with it.

Authority: lower than scan or external by default. An observation contradicting a scan fact is a sign the scan is stale, but the resolution policy should prefer the scan unless the observation accumulates enough confirmations.

### Interaction with existing concepts

| Existing concept | How types overlay |
|---|---|
| Memory triarchy (`fact` / `hint` / `constraint`) | Type 1 → typically `fact`. Type 2 → `fact` for versioned/cached docs, `hint` for LLM-summarized. Type 3 → typically `hint`, promoted to `constraint` on user confirmation (which lands as a Type 4). Type 4 → always `constraint` when accepted. |
| Workspace isolation (D5) | Applies to Type 1, Type 3, Type 4 (memory-stored). Type 2 may originate cross-workspace by nature but each workspace's *cache* is isolated. |
| Context providers (D5a) | Are the mechanism for Type 2. Other types don't need providers — they live in memory. |
| Bootstrap hook | Is the mechanism for Type 1. Renamed conceptually to "context builder" — produces memory entries scoped to its owner. |
| Working state | Is where Type 3 originates. Distillation is the bridge from working state → memory. |
| Feedback bus | Targets Type 1, Type 3, Type 4 (the workspace-memory entries). Type 2 doesn't get feedback events — providers aren't owners. |
| User-assertion classifier | New component; the mechanism for Type 4. Decides accept/reject + routes to relevant owners. |

### Resolved follow-ups

All typology-specific follow-ups surfaced here are closed in the decisions log:
- User-assertion classifier — D6.
- Owner routing for accepted assertions — D14 (skills/tools declare `assertionInterests`).
- Assertion contradiction — D7 (last one wins).
- Observation accumulation — D13 (tiered, saturating confidence within tier, TTL reset).
- Observation invalidation — D11 + D7 (supersession on contradicting re-observation).
- Context builder dependency ordering — D15 (substrate-managed DAG).

---

## Non-goals

- **Not** chat session memory (turns, conversations, todos). That layer exists, lives in [`db/conversations.ts`](src/insrc/db/conversations.ts), and stays unchanged.
- **Not** the L2 agent loop, planner, or grounding-review machinery. The substrate is consumed by them; it doesn't replace them.
- **Not** a general-purpose RAG layer. Memory is structured + typed per-owner, not free-form embedded blobs.
- **Not** a global "user profile." Memory is strictly workspace-scoped (D5). Cross-workspace mirroring or sharing is not provided.

---

## Core abstractions

### Owner identity

Every memory entry is owned. Every context assembly is for an owner. Owners are namespaces — they isolate one consumer's data from another's.

```ts
type OwnerId = string;                  // e.g. 'skill:data.source.file.describe'
                                        //   or 'agent:pair'
                                        //   or 'classifier:intent'
                                        //   or 'orchestrator:data-analyzer'
```

Naming convention: `<kind>:<id>` where `kind` distinguishes class of consumer. Skills, agents, classifiers, orchestrators, indexers — anything that holds memory has an owner.

An owner declares a **schema** + a **version**. The schema describes the shape of memory entries the owner writes. The version is bumped on breaking changes; the substrate wipes the affected namespace and re-runs bootstrap (D9; in-place migration is deferred to a later phase).

### Memory store

Append-mostly, key-value over typed namespaces. Each owner gets a sub-namespace; conflicts within an owner are the owner's problem.

```ts
interface MemoryStore {
  // Owner + namespace identifies a logical collection. Examples:
  //   ('skill:data.source.file.describe', 'schema-by-connection')
  //   ('skill:data.source.file.describe', 'aliases')
  //   ('agent:pair', 'past-proposals')
  scope(owner: OwnerId, namespace: string): MemoryNamespace;
}

interface MemoryNamespace {
  // Single-key access — opens the entry file by path.
  get<T>(key: string): Promise<MemoryEntry<T> | undefined>;
  put<T>(key: string, value: T, meta: WriteMeta): Promise<void>;  // atomic temp+rename
  delete(key: string): Promise<void>;

  // Range / prefix scan — directory listing under the namespace.
  scan<T>(prefix: string, opts?: ScanOpts): AsyncIterable<MemoryEntry<T>>;

  // Embedding-backed lookup. Two-step: Lance ANN returns file path
  // refs, substrate reads the files. Only entries from namespaces
  // with an indexing policy other than `never` are findable here.
  searchByEmbedding<T>(
    queryEmbedding: Float32Array,
    opts: AnnOpts,
  ): Promise<readonly MemoryEntry<T>[]>;
}

interface MemoryEntry<T> {
  readonly key:        string;
  readonly value:      T;
  readonly kind:       'fact' | 'hint' | 'constraint';
  readonly source:     EntrySource;              // bootstrap / cold-execute / feedback / user-asserted
  readonly confidence: number;                   // 0..1
  readonly writtenAt:  number;                   // unix ms
  readonly expiresAt?: number;                   // optional TTL
  readonly supersedes?: readonly string[];      // older keys this entry replaces
}

interface WriteMeta {
  readonly kind:       'fact' | 'hint' | 'constraint';
  readonly source:     EntrySource;
  readonly confidence: number;
  readonly ttlMs?:     number;
  readonly embedding?: Float32Array;
}

type EntrySource =
  | { kind: 'bootstrap';     trigger: BootstrapTrigger }
  | { kind: 'cold-execute';  ownerId: OwnerId; at: number }
  | { kind: 'observation';   ledgerRef: LedgerRef; executionRef: ExecutionRef; tier: 'system-constraint' | 'pattern' | 'incidental' }
  | { kind: 'feedback';      event: FeedbackEventRef }
  | { kind: 'user-asserted'; turnId: string; classifierDecisionRef?: MemoryEntryRef };
```

The trichotomy (`fact` / `hint` / `constraint`) is a property of every memory entry. It drives conflict resolution + freshness:

- **fact**: derived from external truth. Stale-detectable; recomputable. Lowest authority on conflict — the source can be reread.
- **hint**: statistical or pattern-based. Soft signal. Loses to constraint, ties with other hints (resolution: highest confidence).
- **constraint**: external authority — usually user. Wins conflict; ages only on explicit recontradiction.

### Context assembler

Builds the per-execution briefing. **Read-only.** Skills/agents never mutate context directly; they mutate memory (via working state) and let the next execution's assembler re-project.

```ts
interface ContextAssembler {
  // Build a context object for one execution.
  assemble(req: AssembleRequest): Promise<AssembledContext>;
}

interface AssembleRequest {
  readonly owner:      OwnerId;             // who is running
  readonly task:       TaskInput;            // the args / question / objective
  readonly session:    SessionRef;           // active connections, intent, prior turn refs
  readonly budget:     ContextBudget;       // tokens / entry count / size cap
  readonly slots:      readonly ContextSlotRequest[];  // typed slots the consumer declares
}

interface ContextSlotRequest {
  readonly name:       string;               // e.g. 'connection-schema'
  readonly fromOwner:  OwnerId;             // which owner's memory to project from
  readonly namespace:  string;
  readonly query:      ContextQuery;        // key | prefix | embedding | filter
  readonly limit?:     number;
  readonly required?:  boolean;             // throw if empty?
}

interface AssembledContext {
  readonly slots:      ReadonlyMap<string, readonly MemoryEntry<unknown>[]>;
  readonly task:       TaskInput;
  readonly session:    SessionRef;
  readonly budgetUsed: ContextBudgetSnapshot;
  readonly notes:      readonly string[];   // assembly diagnostics (slot was truncated, etc.)
}
```

Key properties:

- **Typed slots.** Consumers declare *what* they need; the assembler decides *how* to fill it (within budget). No free-form "give me everything you've got."
- **Cross-owner read by request only.** A skill can read another skill's memory — but it must declare the slot upfront. No ad-hoc cross-owner traversal during `execute()`.
- **Budget enforced at assembly time.** Truncation is visible in `notes`. Slots can be marked required; missing-required throws before execution.
- **Reproducibility.** Given the same `(memory snapshot, AssembleRequest)`, the result is byte-identical. Caching + replay are first-class.

### Working state ledger

Mutable, per-execution scratch. Owned by the running consumer. Distilled into memory on return.

```ts
interface WorkingStateLedger {
  // Append-only mutation. Throws on hard cap (D12).
  append(entry: LedgerEntry): LedgerRef;

  // Query / project.
  list(filter?: LedgerFilter): readonly LedgerEntry[];
  get(ref: LedgerRef): LedgerEntry | undefined;

  // Mark which entries should be distilled to memory on return.
  // Default policy: no entries auto-distill (per-namespace D3 may override).
  pin(ref: LedgerRef, target: DistillTarget): void;

  // Current size — entry count + estimated bytes. Used by the
  // consumer to react before the hard cap fires (D12).
  size(): { entries: number; bytes: number };
}

interface LedgerEntry {
  readonly ref:        LedgerRef;
  readonly source:     LedgerSource;      // sub-call result, LLM output, internal claim
  readonly payload:    unknown;
  readonly claims:     readonly string[]; // factual claims this entry supports
  readonly confidence: number;
  readonly at:         number;
}

interface DistillTarget {
  readonly owner:      OwnerId;            // which memory namespace to write to
  readonly namespace:  string;
  readonly key:        string;
  readonly kind:       'fact' | 'hint' | 'constraint';
  readonly ttlMs?:     number;
}
```

Distillation rules:

- **Default `on-pin` per namespace (D3).** Anything that becomes memory must be explicitly pinned, unless the target namespace opts into `'always-on-success'`. This keeps memory growth bounded + intentional.
- **Distillation runs only on successful return.** A skill that crashes leaves no memory residue (working state is discarded, pinned entries are not promoted).
- **Pinned writes go through the normal memory-store conflict resolution (D4).** A pinned `fact` doesn't silently overwrite a `constraint`.

### Distillation atomicity + cancellation

- **Per-entry, not all-or-nothing.** Pinned writes happen one at a time. If one fails (e.g., disk full mid-distill), prior pins in the same return are already on disk; subsequent pins are skipped. The substrate logs the partial-distill outcome but does not roll back.
- **Cancellation during distill** is honored between writes, not within a single write. A `rename(2)` is atomic; the substrate doesn't interrupt it. If the consumer is cancelled mid-distill, already-committed pins stay; remaining pins are dropped.
- **No distill ordering guarantee** across pins from the same return. Consumers must not depend on pin order. If ordering matters (e.g., two writes in one namespace that must be applied in sequence), the consumer encodes the ordering in the values themselves (e.g., monotonic version numbers) or refactors into separate sequential `put` calls outside the working-state pin path.

### Feedback bus

Carries `FeedbackEvent`s from consumers (grounding-review verdicts, user corrections, downstream rejections) back to the owners whose memory entries (or executions) are implicated.

```ts
interface FeedbackBus {
  emit(event: FeedbackEvent): Promise<void>;

  // Owners register handlers at startup.
  subscribe(owner: OwnerId, handler: FeedbackHandler): Unsubscribe;
}

interface FeedbackEvent {
  readonly id:           string;            // unique; for replay-safety
  readonly kind:         'accepted' | 'refined' | 'rejected' | 'user-correction';
  readonly targetOwner:  OwnerId;           // who this feedback is about
  readonly executionRef: ExecutionRef;      // optional — which past execution
  readonly memoryRefs:   readonly MemoryEntryRef[];  // which memory entries were involved
  readonly payload:      unknown;           // event-kind-specific
  readonly source:       FeedbackSource;    // who emitted (which consumer)
  readonly at:           number;
}
```

Delivery semantics: **best-effort fire-and-forget** (D8). In-process dispatch only. No persistence, no ack, no replay. Handler crashes are logged and ignored. Handlers don't need to be idempotent. Crash mid-dispatch loses in-flight events.

The bus is **fan-out by target owner**, not broadcast. Only owners whose data was implicated get the event. Per-target ordering is preserved; cross-target ordering is not.

### Lifecycle runner

The substrate-owned glue that calls owner-declared hooks at the right times.

```ts
interface LifecycleHooks {
  // Called when external state changes the owner is interested in.
  // Owners declare interest in trigger kinds; the runner dispatches.
  bootstrap?(trigger: BootstrapTrigger, deps: BootstrapDeps): Promise<void>;

  // Called when feedback events for this owner arrive.
  applyFeedback?(events: readonly FeedbackEvent[], deps: FeedbackDeps): Promise<void>;

  // Context builders may be registered separately via the builder
  // registry (D15); they're dispatched by the lifecycle runner on
  // matching BootstrapTriggers, in DAG topological order.

  // (v1: no migrate hook. Schema bumps wipe + re-bootstrap per D9.
  // An upgrade-path API will be designed later.)
}

interface OwnerDeclaration {
  readonly id:                   OwnerId;
  readonly schemaVersion:        number;
  readonly interestedTriggers:   readonly BootstrapTrigger['kind'][];
  readonly hooks:                LifecycleHooks;
  readonly contextSlots:         readonly ContextSlotSpec[];   // slot specs this owner declares + reads
  readonly memorySchema:         readonly NamespaceSpec[];     // namespaces this owner writes
}
```

Owners register at daemon startup via a registry (same model as today's skill / tool registries).

---

## Retrieval design

How does data actually move from memory + providers + working state into the consumer's hands? This section is the substrate's query + assembly pipeline.

### Query modes

A slot's query is one of four primitive shapes. The substrate executes them against the slot's declared source (memory namespace or provider).

```ts
type ContextQuery =
  | { kind: 'byKey';       key: string }                              // exact lookup
  | { kind: 'prefix';      prefix: string; ascending?: boolean }      // range scan
  | { kind: 'byEmbedding'; embedding: Float32Array; topK: number }    // ANN via Lance
  | { kind: 'filter';      predicate: EntryPredicate };               // typed filter
```

- **byKey** — sub-millisecond file open + read. Default for "I know which entry I want" (`schema-by-connection` keyed by `connectionId`).
- **prefix** — directory listing under the namespace's sharded tree. Default for grouped entries (`aliases` keyed by `connectionId:userTerm`).
- **byEmbedding** — two-step: Lance ANN search returns file refs, substrate reads the files. Lance is an index, not a store (see "Indexing framework"). Only entries in namespaces with an `indexing` policy other than `never` can be found this way.
- **filter** — falls back to a scan + predicate. Most expensive; should usually be combined with a prefix narrowing.

The same shapes work for memory and providers. A provider that can't honor a query kind (e.g., a config-file provider that doesn't support embeddings) declares its supported kinds at registration; the assembler refuses incompatible slot requests at registration time, not at runtime.

### Variable substitution in queries

Slots are declared at registration; query parameters depend on the task. The substrate resolves parameters at assemble time via a typed function:

```ts
// Registration:
{
  name: 'cached-schema',
  fromOwner: 'skill:data.source.file.describe',
  namespace: 'schema-by-connection',
  query: (req: AssembleRequest) => ({ kind: 'byKey', key: req.task.connectionId }),
}
```

Function-form (not string templating) so it's typed, composable, and trivially testable. The cost: slot specs aren't pure data; serializing them for replay requires capturing the closure (handled by recording the resolved query value, not the function).

### Ranking

When a query returns more than one entry, the substrate ranks them with a default policy and a per-slot override option.

**Default rank (descending priority):**
1. Trichotomy kind: `constraint` > `fact` > `hint`.
2. Confidence (numeric, higher first).
3. Recency (`writtenAt`, more recent first).
4. For `byEmbedding` queries, the entry's similarity score is a multiplier on the rank score.

The default covers the cases that matter today. Per-slot override is a `rank: (entries) => readonly Entry[]` function, used when a slot has bespoke needs (e.g., a categorical-profile slot ranking by distinct-value count rather than recency).

Provider-sourced entries participate in the same ranking as memory-sourced entries within a single slot. Since slots are single-source (see below), this is per-slot only, not cross-source.

### Single-source slots

Each slot reads from exactly one source: either one memory namespace OR one provider. Two reasons:

- **Simplicity.** Cross-source ranking would require normalizing trust + provenance across heterogeneous origins. Punting that to the consumer keeps the substrate small.
- **Explicit consumer reasoning.** If a consumer wants both memory + provider evidence, it declares two slots and merges in its body. The merge intent is visible in code, not buried in the substrate.

The cost is verbosity — a consumer that pulls from 5 owners declares 5 slots. Tolerable.

### Limit + budget enforcement

Two budget tiers, both checked during assembly.

**Per-slot limit.** Each slot may declare `limit?: number` (max entries). Truncation happens after ranking; the assembler annotates `notes` with truncation count.

**Overall context budget** (D2: caller-owned). Caller passes a token budget; substrate estimates per-entry token cost (chars / 3 by default) and enforces. Two policies for cross-slot pressure:

- **Proportional truncation** (default): each slot loses entries proportional to its current consumption.
- **Slot priority** (opt-in): each slot declares a priority (`required` > `preferred` > `optional`); the assembler truncates optional first, then preferred, then required. Required slots that can't fit produce an `AssemblyError`, not a silent truncation.

The assembler always annotates which slots were truncated and by how much — that's part of `AssembledContext.notes`.

### Freshness handling

- **Memory entries with `expiresAt`:** skipped during retrieval, never surfaced. The substrate may emit an `expiry:swept` event for downstream cleanup but otherwise silently ignores them.
- **Stale (not expired):** memory entries don't track stale-but-not-expired state at the substrate layer. Staleness is the indexer's problem — when the indexer detects an upstream change (file mtime, connection config edit, repo branch change), it re-triggers bootstrap for the affected namespace per D11.
- **Provider freshness:** entirely the provider's responsibility. Providers may cache internally; substrate doesn't try.

### Caching the assembled context

For reproducibility + cheap re-assembly, the substrate caches assembled context by:

```
cache_key = hash(workspaceId, owner, normalized_AssembleRequest, memory_version)
```

Where `memory_version` is a workspace-scoped monotonically-increasing counter that bumps on any memory write. If two assemble calls in a session use the same task + same memory state, the second hits cache.

Cache eviction: LRU with a small bound (e.g., 32 entries per workspace). Provider-sourced slots are *not* cached at the assembler level (the provider may have side-effects or non-deterministic responses). A slot that includes any provider source disables cache for the whole assembly.

### Working state retrieval (in-execution)

Separate API on `WorkingStateLedger`. Different rules from context assembly:

- Reads scoped to the current execution's ledger only.
- No budget enforcement (in-process memory; cheap).
- No trichotomy ranking (ledger entries don't have kind until pinned).
- Filter-only query: `ledger.list((entry) => predicate(entry))`.
- Sub-millisecond.

Working state is the consumer's scratchpad; it's not subject to the assembly-pipeline rules.

### Hot-path memory access during execution (Q8 — proposed)

Cold-path memory access mid-execution (a skill body calling `deps.memory.scope(owner, namespace).get(key)` outside a pre-declared slot) is **allowed but accounted**:

- The substrate decrements the caller's remaining context budget by the read's estimated token cost.
- If budget is exhausted, the call returns `undefined` and a `notes` entry is appended to the execution's ledger.
- Cross-owner cold-path reads (consumer reads another owner's memory) require the consumer's registration to declare a `coldPathOwners: readonly OwnerId[]` allow-list. Without the declaration, cross-owner cold reads throw.

This lets consumers handle dynamic lookups (e.g., an L2 agent that discovers it needs additional context mid-loop) without forcing every potential lookup into the slot declaration.

### Telemetry

Every retrieval step emits a structured event:

```
context:slot-fill   { owner, slot, source, count, truncated, latencyMs }
memory:read         { owner, namespace, queryKind, hit, latencyMs }
provider:read       { providerId, slot, latencyMs, errored }
context:cache-hit   { cacheKey } / context:cache-miss
ledger:query        { owner, matchCount, latencyMs }
```

Aggregated per execution + emitted on completion as `context:assembly-summary`.

### Reproducibility

Snapshot model: `(memoryVersion, AssembleRequest)` uniquely determines the assembled context (when all sources are memory; provider reads break determinism). The substrate supports a `replay(snapshot) → AssembledContext` API for debugging + golden-file testing.

For runs with provider reads, the provider's response can be recorded at first call and replayed later (via a `replayMode: 'record' | 'playback'` flag on the assembler). Same pattern as `recordReplay` in the existing test harness.

---

## How consumers inherit the framework

Every consumer (skill, agent, classifier, etc.) declares itself to the substrate at registration. The substrate then mediates every memory read, context assemble, working-state write, and feedback delivery for that consumer.

```ts
// Example: an L1 skill registration.
registerSkill({
  id: 'data.source.file.describe',
  owner: 'skill:data.source.file.describe',
  schemaVersion: 1,
  interestedTriggers: ['connection-add', 'refresh'],
  contextSlots: [
    { name: 'cached-schema', fromOwner: 'skill:data.source.file.describe',
      namespace: 'schema-by-connection', query: { byKey: '$connectionId' } },
    { name: 'aliases',       fromOwner: 'skill:data.source.file.describe',
      namespace: 'aliases',              query: { prefix: '$connectionId:' } },
  ],
  memorySchema: [
    { namespace: 'schema-by-connection', valueType: 'SchemaDescription', ttl: '24h' },
    { namespace: 'aliases',              valueType: 'Alias',              ttl: 'until-contradicted' },
  ],
  hooks: {
    bootstrap: async (trigger, deps) => { /* ... */ },
    applyFeedback: async (events, deps) => { /* ... */ },
  },
  execute: async (input, deps) => {
    // deps.context is already assembled; deps.workingState is a fresh ledger
    const cached = deps.context.slots.get('cached-schema')?.[0];
    if (cached !== undefined && !isStale(cached)) {
      return { value: cached.value, confidence: 'high', notes: ['from cache'] };
    }
    // cold path
    const fresh = await deps.runTool('db_file_describe', { connectionId: input.connectionId });
    const ref = deps.workingState.append({ source: 'tool:db_file_describe', payload: fresh, ... });
    deps.workingState.pin(ref, {
      owner: 'skill:data.source.file.describe',
      namespace: 'schema-by-connection',
      key: input.connectionId,
      kind: 'fact',
      ttlMs: 24 * 60 * 60 * 1000,
    });
    return { value: fresh, confidence: 'high', notes: [] };
  },
});
```

The substrate handles:
- Context assembly before `execute()` runs (slots already populated).
- Working state creation + size enforcement (D12).
- Distillation of pinned entries on successful return.
- Feedback dispatch when downstream events implicate this skill (D8 fire-and-forget).
- Schema-bump wipe + re-bootstrap (D9).

The consumer body only deals with: read slots, do work, write to working state with appropriate pins, return.

---

## Cross-cutting concerns

### Cancellation

Every memory read, context assemble, and feedback dispatch respects an `AbortSignal`. The substrate propagates cancellation from the orchestrator down.

### Telemetry

Every substrate operation emits a structured log line via the existing `pino` logger:

- `memory:read` — owner, namespace, key, hit/miss, latency
- `memory:write` — owner, namespace, key, kind, source
- `context:assemble` — requesting owner, slot count, budget used, truncations
- `working-state:append` — owner, source kind, claim count
- `working-state:distill` — owner, pin count, write count
- `feedback:dispatch` — target owner, event kind, latency
- `lifecycle:bootstrap` / `lifecycle:applyFeedback` / `lifecycle:context-builder`
- `schema:wipe` — owner, namespace, prior version, new version, files discarded

### Isolation

- **Workspace isolation is absolute (D5).** Memory is keyed by `(workspace, owner, namespace, key)`. A workspace cannot read another workspace's memory. No cross-workspace mirroring or sharing.
- **Cross-owner reads require declared slots** (D14 routing + standard context-slot declaration). A consumer cannot dynamically pick "give me everything from owner X." Cross-owner permissions are static, declared at registration.
- **Cross-workspace shared *context*** (not memory) is provided via context providers (D5a) — read-only, no write-back.

### Persistence cadence

Three different cadences for three different layers:

- **Memory writes**: durable immediately via file temp+rename. POSIX guarantees per-entry atomicity. No cross-entry transactions.
- **Working state**: in-memory only by default; lost on crash. Long-running L2 skills + agents have crash-resume via the agent framework's existing [`checkpoint.ts`](src/insrc/agent/framework/checkpoint.ts) (independent concern). The substrate itself doesn't checkpoint working state.
- **Feedback events**: not persisted (D8). Fire-and-forget; lost on crash mid-dispatch. Emitters with genuinely uncrashable events handle their own persistence (e.g., chat turns are already persisted, so user-correction events re-derive on next start).

---

## Storage substrate

**Files are canonical. Lance is an index.** No row store. Every memory entry is a file on disk. The substrate owns a directory tree; the file system provides per-entry atomicity (POSIX rename), durability, inspectability, and portability. Lance maintains a vector index over the subset of files that opted into embedding search — pointing at file paths, never holding payload.

Why not LMDB:
- **Inspectable.** A user (or a future agent debugging itself) can `ls`, `cat`, `grep` the memory store. No daemon required.
- **Portable.** The substrate's state survives the daemon. Backups, sync, sharing, archival all work with standard tooling.
- **Composable.** File watchers, IDE indexing, git, ripgrep all operate natively on the substrate's storage. No translation layer.
- **No transactional bloat.** Each entry is its own write; large entries don't compete with small ones for transaction space.
- **Lifecycle clarity.** TTL eviction = file deletion. Re-indexing = directory scan. Schema migration = file rewrite. Operations map to file operations.

What we give up:
- Cross-entry transactions. Memory writes don't need them (each entry is independent; idempotent feedback handlers absorb partial-failure cases). If a future use needs cross-entry atomicity, it's the consumer's problem to model it.
- Compact binary encoding. Entries are slightly larger on disk. For context (mostly text + structured data), the overhead is negligible.

### Directory layout

```
~/.insrc/context/<workspace-id>/
  <owner-id>/
    <namespace>/
      <aa>/<bb>/                  # sharded by first 4 hex of entry-id hash
        <entry-id>.<ext>           # the entry, with metadata as frontmatter or top-level keys
      .meta/
        schema-version             # current schemaVersion for this namespace
        policy.json                # indexing policy, autoDistill, TTL, valueType
      .index/
        embeddings.lance           # vector index (id, embedding, facets) — no payload
        manifest.json              # index metadata, last-rebuild timestamp
```

- **`workspace-id`** is the hash of the workspace root path (same scheme used elsewhere in the daemon today).
- **`owner-id`** is the registered consumer id (D1: `<kind>:<id>`).
- **`namespace`** is the namespace declared by the owner.
- **Two-level shard (`<aa>/<bb>`)** prevents single-directory file-count blowup. macOS APFS / ext4 handle ~10k files per directory comfortably; 4 hex chars of sharding gives 65k subdirectories, each comfortably holding thousands of entries.
- **`.meta/`** holds substrate-level bookkeeping (schema version, policy). Not user-content.
- **`.index/`** holds the Lance index, which is itself a small directory of files. See "Indexing framework."

### File format

Per namespace, declared at registration:

- **JSON** (default) — small structured entries (aliases, cache rows, observations as structured claims).
- **Markdown** — long-form text entries (module summaries, drafted analyses) with YAML frontmatter for metadata.
- **Binary** (opaque blob + sidecar `.meta.json`) — embeddings, parquet samples, anything not human-readable.

JSON entry shape:
```json
{
  "_meta": {
    "kind": "constraint",
    "confidence": 0.95,
    "writtenAt": 1779970000000,
    "expiresAt": null,
    "source": { "kind": "user-asserted", "turnId": "t-42" },
    "supersedes": []
  },
  "value": { ... typed payload defined by namespace.valueType ... }
}
```

Markdown frontmatter is the same `_meta` block in YAML, body is the content.

### Atomicity + concurrency

- **Writes:** temp file + atomic `rename(2)`. POSIX guarantees readers see either the old or the new version, never partial.
- **Reads:** open + read + close. No locks. Stale-read tolerated by the substrate's confidence-based ranking.
- **Concurrent writes to the same entry:** last-rename wins. Conflict resolution at the substrate level (D4) is applied *before* writes are committed — the substrate reads the current entry, applies the merge policy, writes the result.
- **Deletes:** `unlink(2)`. The indexer's eviction step also drops the Lance row. If only the file is deleted (not via substrate API), the next `byEmbedding` hit returns a `not-found` and the substrate quietly drops the orphan index entry.

### Schema migration

Each namespace's `.meta/schema-version` holds the current version. On bump (v1; see D9):
- Substrate deletes the namespace directory tree (entries + Lance index entries).
- Substrate re-triggers `bootstrap` with `BootstrapTrigger.kind: 'schema-bump'`.
- Bootstrap re-derives from current source-of-truth.

Per-namespace, not workspace-wide. A bump to one namespace doesn't disturb others. v1 has no in-place migrate hook — accepted cost is loss of user assertions and accumulated observation confidence in the affected namespace (see D9 for the full cost analysis).

### Reuse of existing daemon storage

- The chat-system's auto-memory (`~/.claude/.../memory/`) is already this shape — markdown files + frontmatter + a `MEMORY.md` index. The substrate inherits the same pattern.
- The existing `db/graph/` LMDB store stays for the code knowledge graph (entities + relations + traversal). The code KG is not memory in the substrate's sense — it's a domain-specific index that pre-existed and serves a different access pattern.
- Lance reuses the existing `db/lance/` connection layer; new tables for substrate indexes follow the same pattern as `entity_vec` / `turn_vec`.

---

## Indexing framework

Vector indexing is a separate concern from memory writes. A dedicated **Indexer** component maintains the Lance vector index over a *subset* of memory entries, decoupled from the write path.

### Why decoupled

- **Embedding generation is expensive.** Calling the local Ollama embed model on every file write would block the write path. Decoupling lets writes complete sub-ms while embeddings backfill on a queue.
- **Not every entry needs embedding.** A schema-cache entry keyed by connectionId is looked up by `byKey` (which is a file open by path), not by semantic search. Indexing it wastes vector space. A user alias might need both. The policy is per-namespace.
- **Lance is replaceable.** If the index gets corrupted, falls behind, or needs re-tuning, the substrate drops the `.index/` directory and rebuilds by scanning the namespace's files. Files are the source of truth; Lance is a cache that happens to use ANN.
- **Eviction is independent.** A cold entry can lose its Lance row (cheap embedding storage savings) while its file stays on disk.

### Indexing policy

Declared per namespace at registration:

```ts
interface NamespaceSpec {
  readonly namespace: string;
  readonly valueType: string;
  readonly autoDistill: 'on-pin' | 'always-on-success' | 'never';
  readonly indexing: IndexingPolicy;
  readonly ttl?: string;
}

type IndexingPolicy =
  | { kind: 'never' }                         // never index; byEmbedding queries against this ns return empty
  | { kind: 'always' }                        // every put produces an embedding-index entry
  | { kind: 'on-flag' }                       // entry write opts in via WriteMeta.indexable: true
  | { kind: 'derived'; from: (entry: MemoryEntry<unknown>) => string };
  // `derived` lets a namespace embed a projection of the entry (e.g., the column name)
  // rather than the full payload. Returned string is what gets embedded.
```

Recommended defaults:

| Namespace shape | Recommended policy |
|---|---|
| Cache keyed by id (schemas, sample-shapes) | `never` — looked up by key, no semantic value |
| Aliases / synonyms | `derived` over the user-term — the surface form is what users will fuzzy-match |
| User assertions | `always` — semantic recall is the primary lookup mode |
| Observations | `derived` over the claim text |
| Static scan entities | `derived` over name + summary |

### Indexer component

```ts
interface Indexer {
  // Called by the substrate after a successful file write.
  enqueue(entry: MemoryEntry<unknown>, policy: IndexingPolicy): Promise<void>;

  // Called explicitly to rebuild from the files (after corruption,
  // schema bump, or policy change). Scans the namespace directory tree.
  rebuild(owner: OwnerId, namespace: string, opts: RebuildOpts): Promise<RebuildReport>;

  // Called on entry deletion / expiry.
  evict(ref: MemoryEntryRef): Promise<void>;

  // Search API used by retrieval.
  search(
    owner: OwnerId,
    namespace: string,
    queryEmbedding: Float32Array,
    opts: AnnOpts,
  ): Promise<readonly IndexHit[]>;
}

interface IndexHit {
  readonly id:           MemoryEntryRef;     // → file path (resolvable to the entry file)
  readonly similarity:   number;
  readonly facets:       IndexedFacets;      // kind, confidence, writtenAt — for client-side filter
}
```

The indexer runs as a background worker:
- File writes return immediately; the indexer's `enqueue` is fire-and-forget.
- A queue worker batches embeddings (the Ollama embed model is cheaper per-call when batched).
- The queue itself is a sidecar file (`.index/queue.jsonl` append-only), durable across daemon restarts.
- An "indexed-at" timestamp in the entry's `_meta` indicates index status; consumers can filter by this if they need synchronous indexing guarantees.
- Optional `inotify` / `FSEvents` watcher on the namespace directory catches writes that bypassed the substrate API (e.g., a user manually editing an entry file) — those re-trigger indexing.

### Rebuild + reindexing

Triggers:
- **Schema bump** on a namespace: substrate drops the namespace's `.index/` directory + re-enqueues every entry file.
- **Policy change** (e.g., a namespace flips from `never` to `always`): same mechanism.
- **External file edits** detected via `inotify` / `FSEvents`: per-entry re-index.
- **Manual** via daemon RPC for debugging.

Rebuild is a streaming directory walk; it doesn't block reads (the existing Lance index keeps serving from the old `.index/`). When the rebuild completes, the new index swaps atomically via directory rename.

### Eviction

Cold entries (low confidence + old + not recently read) are candidates for Lance eviction. The entry file stays on disk. Future `byEmbedding` queries on the same vector won't find the entry until it's re-promoted (via re-read, re-write, or explicit pin).

Eviction policy is configurable per namespace. Default: LRU on read-time, bounded by total Lance row count per `(workspace, owner)`.

File-level eviction (the entry file itself) is governed by the namespace's TTL and the conflict resolution policy. The substrate sweeps expired files on a background timer; user-asserted constraints never auto-expire.

### Sizing

Per-workspace Lance footprint is roughly:
```
≈ indexed_entry_count × (4 bytes × embedding_dim + ~80 bytes facets)
```
For a 768-dim embedding and ~100k indexed entries: ~310 MB. The bound is `indexed_entry_count`, which the policy controls. Without the index-not-store discipline, the same data with payloads inline would easily 10x that.

---

---

## Worked example: the `supplier → vendor_details` correction

End-to-end trace, with the substrate doing the load-bearing work.

1. **Turn 1 (cold).** User asks "review the GRN data, focus on supplier coverage."
   - Orchestrator → `data.answer-question` L2 skill.
   - Skill body asks the context assembler for an `'aliases'` slot from `'skill:data.source.file.describe'`. Empty (cold workspace).
   - Skill body calls L1 `data.profile.categorical.file` with `column: 'supplier'`.
   - L1 skill receives empty cached schema → tool call → tool errors `unknown column 'supplier'`.
   - L1 returns `confidence: low` with a `notes: ['unknown column supplier; available columns: [grn_number, vendor_details, ...]']`.
2. **Turn 2 (user correction).** User: "no, I meant vendor_details."
   - Intent resolver tags this as `user-correction` referencing the prior turn.
   - Chat handler emits a `FeedbackEvent { kind: 'user-correction', targetOwner: 'skill:data.source.file.describe', payload: { from: 'supplier', to: 'vendor_details', connectionId: '...' } }`.
   - Feedback bus fans out to the target owner.
   - `applyFeedback` handler writes a memory entry into the `aliases` namespace with `kind: 'constraint'`, `source: { kind: 'user-asserted', turnId: '...' }`.
3. **Turn 3 (hot).** User asks a similar question about the supplier on the same connection.
   - Context assembler populates the `'aliases'` slot. Now non-empty.
   - L2 skill's planner sees the alias entry → translates `supplier` → `vendor_details` in its dispatched L1 calls.
   - Underlying tool calls succeed; report contains real `vendor_details` analysis.
4. **Indefinitely.** The alias persists. Every future question about supplier in this workspace skips the failure mode. No new code shipped; the correction was *learned*.

The L2 skill, the L1 skill, the assembler, the feedback bus, the memory store — each did its part, none were specific to this fix.

---

## Decisions log

All design decisions surfaced during the iteration. Each is the substrate's locked-in answer; refinements come during implementation, not via this doc.

**Quick reference:**

| # | Decision | One-line summary |
|---|---|---|
| D1 | Owner granularity | Owner = registered consumer id (`<kind>:<id>`). Hierarchy below via namespaces. |
| D2 | Context budget ownership | Caller sets the budget per invocation; consumer's declared default is the fallback. |
| D3 | Distillation strictness | Namespace-level policy. Default `on-pin`. |
| D4 | Conflict resolution | Layered default (`constraint > fact > hint`, confidence, recency) + per-namespace merge override. |
| D5 | Cross-workspace memory | None. Memory is strictly workspace-scoped. |
| D5a | Context providers | Read-only external sources for context only; distinct from memory. |
| D6 | User-assertion classifier | Three-layer pipeline (heuristic → LLM → user-confirm), substrate component. |
| D7 | Assertion contradiction | Last one wins; prior marked `supersededBy`. |
| D8 | Feedback delivery | Best-effort fire-and-forget. No journal, no ack, no replay. |
| D9 | Schema migration | Wipe + re-bootstrap (v1). No in-place migrate hook. |
| D10 | Per-owner encryption | Not required. OS file permissions are the boundary. |
| D11 | Invalidation | No event class. Indexer-led re-bootstrap on existing triggers + TTLs + supersession. |
| D12 | Working-state size cap | Soft warn (1k / 50 MB), hard cap (10k / 500 MB), per-skill overrides. |
| D13 | Observation accumulation | Tiered (`system-constraint` / `pattern` / `incidental`), saturating confidence within tier, TTL reset on re-observation. |
| D14 | Assertion routing | Skills/tools declare `assertionInterests`; no separate registry. |
| D15 | Context builder ordering | Substrate-managed DAG. `dependsOn`, topo-sort, parallel within level. |


### D1 — Owner granularity = registered consumer id

Owner is the registered id of a skill, agent, classifier, orchestrator, etc. — same id you'd use to look it up in its registry. One owner per registered consumer.

- **Rejected:** per-(consumer, connection) — bloat, loses cross-connection learnings.
- **Rejected:** per-skill-family — too coarse, conflict surface too wide.
- **Adopted:** one owner per registered consumer; hierarchy below it lives in namespaces.

Namespaces inside an owner are the right place to model finer granularity (e.g., `schema-by-connection` keyed by connection-id; `aliases` keyed by `connection-id:user-term`).

### D2 — Context budget owned by the caller

The consumer's caller (orchestrator → L2; L2 → L1) sets the context budget at invocation time. The consumer may declare a *default* at registration, but the caller's override wins.

- Unit: tokens (estimated via the existing chars-per-token ratio used elsewhere in the codebase, default 3).
- Substrate enforces: when a slot would exceed remaining budget, it truncates + annotates `notes` with the truncation.
- Why caller-owned: only the caller knows the downstream LLM call's overall envelope. The consumer can't decide what fraction belongs to context.

### D3 — Distillation policy is namespace-level, default `on-pin`

A namespace declares its distillation policy at registration:

- `autoDistill: 'on-pin'` (default) — strict, nothing distills without explicit `workingState.pin()`. Use for constraints, aliases, anything user-asserted.
- `autoDistill: 'always-on-success'` — every working-state entry tagged with this namespace's `DistillTarget` shape promotes on successful return. Use for derived caches (schema-by-connection, sample-shapes).
- `autoDistill: 'never'` — namespace is read-only from working state; only `bootstrap` / `applyFeedback` write here. Use for indexer-managed namespaces.

Skills authors don't have to remember to pin caches; they pick the policy at the namespace level once.

### D4 — Conflict resolution is layered with per-namespace override

Default conflict policy (applied when a `put` targets an existing key):

```
trichotomy_priority: constraint > fact > hint
then: higher confidence wins
then: more recent (writtenAt) wins
ties: existing entry kept
```

A namespace can override by registering a `merge(prev: MemoryEntry, next: MemoryEntry) → MemoryEntry` function. This is for namespaces that need bespoke logic (incrementing counters, append-on-collision, etc.).

The default covers the cases that matter today: user constraints don't get clobbered by cache refreshes; freshest authoritative cache wins among facts; hints stay informational.

### D15 — Context builder dependency ordering: substrate-managed DAG

Each context builder declares its dependencies on other builders. The substrate constructs a DAG at startup, topo-sorts, and executes builders level-by-level (parallel within a level).

**Spec:**
```ts
interface ContextBuilderSpec {
  id: string;                                       // 'language-detection', 'module-summary'
  ownerId: OwnerId;                                 // which owner registered this builder
  triggers: readonly BootstrapTrigger['kind'][];    // 'repo-add' | 'reindex' | 'refresh' | ...
  dependsOn: readonly string[];                     // builder ids that must complete first
  build(input: BuilderInput, deps: BuilderDeps): Promise<BuilderResult>;
}
```

**Registration:** builders register the same way other consumers do. The substrate constructs the DAG from the full set of registered specs at startup.

**Execution on a `BootstrapTrigger`:**
1. Select builders matching the trigger.
2. Topo-sort the matched subset by `dependsOn`.
3. Run level-by-level; parallel within a level.
4. Each builder's outputs are normal memory writes — downstream builders read via the standard memory store API; no special handoff bridge.

**Cycles** are caught at startup. The substrate refuses to boot if the registered DAG has a cycle, with a startup-time error naming the offending edges.

**Incremental updates:**
- Indexer identifies the set of dirty inputs (changed files, edited connection configs, etc.).
- Substrate marks every builder whose outputs depend on those inputs as dirty.
- Re-run only the dirty subgraph, in topo order. Independent subgraphs aren't touched.

**No special memoization layer.** Outputs are memory writes. Downstream builders read what they need via the same `MemoryStore` API every other consumer uses. Consistency comes for free from the substrate's existing write-before-dependent-read ordering.

**Rejected alternatives:**
- Indexer-managed phases (over-serializes — every builder pays the cost of the slowest in its phase).
- Pull-on-demand (more flexible but harder to reason about parallelism, incremental updates, and cycle detection).

### D14 — Assertion routing: per-skill/tool declared interests, no separate registry

The registry of "who cares about which assertion subject" IS the skill / tool catalog. No new abstraction.

**Declaration.** Each skill / tool declares its assertion interests as part of its normal registration:

```ts
registerSkill({
  id: 'codegen.python.generate',
  // ... existing fields ...
  assertionInterests: [
    { subjectPattern: 'python-code-style', description: 'Python language style rules; affects generated code.' },
    { subjectPattern: 'naming-convention', description: 'Identifier naming conventions for generated Python.' },
  ],
});
```

The substrate builds the lookup index from every registered consumer's `assertionInterests` at startup. No admin file, no central editor, no separate registry table.

**Lookup (classifier consults at routing time):**
1. LLM (D6 Layer 2) emits a normalized subject.
2. Substrate looks up: exact match on `subjectPattern`, then embedding similarity against `description`.
3. Returns matched skills / tools as `targetOwners` hints to the classifier.
4. LLM has final say; can subset, all, or none.

**Multi-skill / tool overlap:** route to all matching. Each one's `acceptAssertion()` hook (D6) filters per-target. Priority is informational ordering only, not exclusion.

**No-match → reject** with audit trail recording the unmatched subject. Recurring unmatched subjects are a signal that some skill / tool should declare interest.

**Specificity is the win.** Routing is to concrete skills / tools (`codegen.python.generate`, `git_commit`, etc.), not aggregated owners. An assertion lands exactly where it applies. Verbose-by-design: a new skill that wants to respect existing rules declares its interests itself.

**Agents and non-skill consumers may also declare interests** when relevant; the routing model doesn't restrict to L1/L2 skill tier.

### D13 — Observation accumulation: tiered lifecycle by significance

Observations carry a `significance` tier set at distillation time. Each tier has its own lifecycle. No uniform TTL.

**Tiers:**

| Tier | TTL | Initial confidence | Use case |
|---|---|---|---|
| `system-constraint` | None (permanent until contradicted) | 0.8 | Hard constraints discovered through execution. Memory caps, rate limits, hard input bounds. |
| `pattern` | 30 days, reset on re-observation | 0.5 | Repeatable behaviors that hold but could change. Schema patterns, skill-confidence regularities. |
| `incidental` | 1 day, reset on re-observation | 0.3 | One-off discoveries that may not generalize. Last-query metrics, single-run timings. |

**On re-observation within the same tier:**
- `confidence = 1 - (1 - prior.confidence) × 0.7` (saturating; ~30% closer to 1.0 per re-observation).
- TTL reset to the tier's default.
- `seenCount += 1` (informational).

**Cross-tier re-observation** (distiller chooses a higher tier on the same `(subject, claim)`):
- Treated as supersession (D7). Old entry → `supersededBy`. New entry's tier is final.
- No silent auto-promotion. A `pattern` doesn't become `system-constraint` just because it was re-observed many times — promotion requires a deliberate distillation choice.

**Contradiction** (same subject, different claim): supersession per D7, unaffected by tier.

**Distillation default:** `pattern` (the safe middle). Explicit tier required for `system-constraint` and `incidental`. L1 skills typically distill as `pattern`; L2 skills + agents make deliberate choices.

**Identity:** observations carry structured `{subject, claim, tier, confidence, seenCount}` in their memory entry payload. Same `(normalized subject, claim)` = same observation regardless of distiller.

**Substrate provides this as the default merge for `kind: hint` entries with `source.kind: 'observation'`.** Namespaces can override via D4's per-namespace merge function for special cases.

### D12 — Working-state size cap: soft warn + hard cap, per-skill override

Two thresholds on every L2 / agent execution's working-state ledger, both configurable at registration:

**Soft warn (default: 1,000 entries OR 50 MB aggregate).** Substrate emits `working-state:soft-warn` telemetry on threshold crossing. Skill body can also query `deps.workingState.size()` and react. Append still succeeds.

**Hard cap (default: 10,000 entries OR 500 MB aggregate).** `workingState.append()` throws beyond this. Skill body must handle — typically by distilling + pinning what matters then returning early with a degraded result.

**No default eviction.** Silent data loss in a working ledger is a debug nightmare. A skill that genuinely wants LRU semantics opts in via registration (`workingStateEviction: 'lru'`).

**Per-skill overrides.** A long-running corpus-wide analyzer declares higher caps; a tight one declares lower. Both soft and hard thresholds are independently overridable.

**Independent from the context/LLM budget** (D2). Working-state size caps in-memory scratch; D2 caps tokens / sub-calls / wall-clock. A skill can exhaust one before the other.

### D11 — Invalidation: no event class; indexer triggers re-bootstrap

No `InvalidationEvent` class. Two mechanisms cover the staleness story without inventing a new delivery channel:

**1. Indexer-led re-bootstrap on known triggers.** The indexer already watches workspace files + connection-registry state for the code KG. The substrate piggybacks on the same triggers: when the indexer detects a change that affects a substrate namespace (declared at registration via `interestedTriggers`), the substrate fires `bootstrap()` for the affected `(owner, namespace)` and the namespace re-derives from source. The trigger plumbing already exists; this is reuse, not new infrastructure.

**2. TTLs for slow-moving sources the indexer doesn't watch.** External-input caches (library docs, external API responses), opportunistic refresh of derived facts, etc. Coarse but adequate.

**Observation invalidation (T3b also closed here):** observations aren't derived from a single source the indexer can watch, so re-bootstrap doesn't help. Instead, observations are invalidated through the standard supersession path (D4 + D7): a new contradicting observation lands → conflict resolution picks the newer/higher-confidence entry → the prior is marked `supersededBy` and drops out of active queries. The "DuckDB OOMs above 488 MiB" case is resolved by a future observation of "DuckDB OOMs above 2 GB" winning by recency and overriding.

**What's deliberately not covered:**
- Real-time invalidation across complex dependency chains (e.g., "this observation depended on a transitive fact that changed"). Out of scope; TTLs catch it eventually.
- Push-based invalidation from external providers (the provider can model its own caching as it pleases; substrate doesn't try).

### D10 — Per-owner encryption: not required

The substrate stores files unencrypted. The daemon runs as the local user on the user's own machine; OS file permissions are the security boundary. No multi-tenant model, no remote storage, no cross-user access — encryption would add complexity without addressing a real threat.

If a future deployment introduces a threat model that warrants encryption (shared workstation, remote backup syncing sensitive context to untrusted storage, etc.), it gets designed at that time. Substrate APIs are encryption-agnostic, so a future plug-in encryption layer can wrap them without an interface change.

### D9 — Schema migration: wipe + re-bootstrap (v1)

On a namespace's `schemaVersion` bump, the substrate wipes the namespace's files + Lance index entries and re-triggers bootstrap. No in-place migration in v1.

**What this means concretely:**
- The `Lifecycle.migrate?()` hook is removed from the v1 surface.
- A namespace bump → substrate deletes `~/.insrc/context/<workspace-id>/<owner-id>/<namespace>/`, drops the namespace's Lance rows, re-enqueues bootstrap with `BootstrapTrigger.kind: 'schema-bump'`.
- Bootstrap runs against the current source-of-truth (workspace files, connection metadata, etc.). Static-scan facts re-derive cleanly.

**What's lost on wipe** (acknowledged cost):
- **User assertions** (Type 4 `constraint`s). Sticky, irrecoverable from a re-scan. The user has to re-state them.
- **Observations** (Type 3 distilled to `hint`). Accumulated confidence resets. The system has to re-observe.
- **External-input caches** (Type 2). Fine — re-fetched lazily on next read.
- **Static scan** (Type 1). Fine — fully re-derived from the workspace.

**Why this is acceptable for now:**
- Schema bumps should be rare and intentional.
- An upgrade story (selective preservation of `constraint`s, observation-confidence carryover, etc.) will be designed later when the cost of wiping is felt.
- Until then, schema bumps are documented as breaking for accumulated state.

**Operationally:**
- The substrate logs the wipe with the wiped namespace, prior schemaVersion, new schemaVersion, and counts of files/Lance rows discarded. Audit trail for "why did my preferences disappear?"
- A daemon-RPC `substrate.pendingSchemaBumps()` lists namespaces about to be wiped on next bump so an operator can capture state externally before pulling the trigger.

### D8 — Feedback delivery: best-effort fire-and-forget

This is an IDE-embedded daemon, not a distributed system. Enterprise-grade reliability (event journals, ack stores, dead-letter handling, replay on restart) isn't warranted for the failure modes we actually see.

**The contract:**
- Emit dispatches the event to every named target owner's `applyFeedback` handler.
- Dispatch is in-process. No persistence, no ack tracking, no replay.
- If the daemon crashes mid-dispatch, the event is lost. Accepted.
- If a handler throws, the substrate logs the error and continues. The event is lost for that target; other targets still get it.
- No retry, no backoff, no dead-letter queue.

**Multi-target fan-out** is parallel: each target's handler runs independently. One slow handler doesn't block others. One handler crashing doesn't affect others.

**Ordering within a single target** is emit-order. The substrate's dispatcher serializes per-target so handlers see events in the order they arrived. (Cross-target ordering isn't guaranteed and consumers shouldn't rely on it.)

**Graceful shutdown** flushes the in-memory dispatch queue before exit — cheap defensive measure, not a guarantee. Forced kills lose the queue.

**For events the system genuinely can't lose** (rare; almost nothing qualifies):
- Persistence is the emitter's responsibility. Example: user corrections from chat are already persisted as turns in the conversations table; the feedback event is derivable from the turn on next daemon start if the substrate state is behind.
- Memory writes themselves stay atomic (temp+rename). The fragility is in the *event*, not the resulting memory state.

**Handlers don't need to be idempotent.** Simpler code. Replay-related discipline drops away.

### D7 — Assertion contradiction: last one wins

When a newly accepted user assertion contradicts an existing constraint on the same `(subject, targetOwner)`, the new one replaces the old. No user confirmation prompt; no merge attempt.

**Detection.** After the classifier accepts an assertion and before the substrate persists it:
- For each `targetOwner` in the payload, the substrate scans the owner's `user-assertions` namespace for constraints with the same `subject`.
- A constraint is treated as contradicted when any of `polarity`, `scope`, or the value-set in the payload differs from the new assertion.

**Resolution.** Newer wins by `writtenAt`. Specifically:
- The substrate marks each contradicted entry with `supersededBy: <new-entry-ref>`.
- The new entry is written as the active constraint.
- The substrate emits a `classifier:user-assertion`/`decisions` audit record capturing the supersession (prior ref, new ref, owner, subject).

**Visibility of superseded entries.**
- Files stay on disk for audit. Reading by direct key still works.
- Default queries (`byKey`, `prefix`, `byEmbedding`, `filter`) filter out entries with `supersededBy` set unless the consumer explicitly opts in via `ScanOpts.includeSuperseded: true`.
- The Lance index drops the embedding row for superseded entries on next sweep — they don't surface in semantic search.

**Refinements vs contradictions.** A new assertion that's strictly *more specific* than the prior (e.g., prior "no `hasattr`"; new "no `hasattr` except in test files") is still treated as a contradiction at the broad-subject level. The user can express coexistence by structuring the new assertion to target a narrower namespace or owner — e.g., a scope-specific subject. The substrate doesn't try to detect partial overlap.

**Why not ask-user-on-conflict.** It splits the human/system contract: every assertion would need a follow-up. The classifier already has a user-confirmation fallback (D6 Layer 3) for low-confidence cases. If the new assertion was confident enough to accept, the user is presumed to know they're overriding the prior — and if not, the audit trail makes it discoverable. Cheaper interaction model, recoverable through audit.

### D6 — User-assertion classifier: three-layer pipeline

The classifier is a substrate-level component that processes user turns, detects assertion-shaped spans, decides accept vs reject per candidate, and routes accepted assertions to the relevant owners.

**Pipeline (per user turn):**

1. **Detection** — heuristic scan for assertion-shaped spans. Single turn can yield zero, one, or many candidates. A "remember this" / "always" / "never" / "use X for Y" / "do not Z" phrase pattern is the trigger.
2. **Layer 1 — Heuristic classification.** Cheap rules with high signal:
   - Imperative form + general phrasing + no task-specific anchors → high-confidence **accept**.
   - Clear task-local language ("fix this bug", "for this PR") → high-confidence **reject**.
   - Ambiguous (most cases) → defer to Layer 2.
3. **Layer 2 — LLM classifier.** Triggered on Layer 1 ambiguity. Single call that produces both the decision (accept/reject) AND a structured payload (see below). Returns a confidence score. Decision is cached by `hash(span)` so identical assertions don't re-LLM.
4. **Layer 3 — User confirmation.** Triggered when LLM confidence is still below a threshold. Surfaces a soft prompt: "Should I remember this as a workspace rule?" with explicit accept / dismiss / refine actions. User dismiss locks "reject" in the cache; accept locks "accept."

**Structured payload (LLM output, layer 2):**
```ts
interface UserAssertionPayload {
  text:           string;                      // verbatim assertion span
  subject:        string;                      // what the rule is about
  polarity:       'do' | 'avoid' | 'value-set' | 'preference';
  scope:          'workspace' | 'session' | 'task';
  targetOwners:   readonly OwnerId[];          // which owners this applies to
  confidence:     number;
  reason?:        string;                      // why this classification
}
```

**Owner routing:** see D14 for the full mechanism. Summary:
- The classifier names `targetOwners` per the LLM's understanding of the subject.
- The substrate consults the union of every skill/tool's declared `assertionInterests` (D14) — no separate registry, just the catalog.
- For each named target, the substrate writes a `kind: constraint` entry to the owner's `user-assertions` namespace.
- Owners may implement an optional `acceptAssertion(payload): boolean | TransformedPayload` hook to validate or refine before persistence. Returning false rejects the assertion for that owner.

**Audit trail:**
- The classifier is an owner: `classifier:user-assertion`. Its own namespace `decisions` records every classified span with its decision, classifier layer that decided, LLM confidence, target owners, and turn id.
- This is read-only feedback for tuning + debugging. Memory entries elsewhere have `source.kind: 'user-asserted'` pointing back to a `decisions` ref.

**Where it lives:**
- The classifier interface is substrate-defined.
- The default implementation lives in the daemon (`daemon/substrate/classifiers/user-assertion.ts`).
- Replaceable: tests inject a fake classifier; future product changes can swap the LLM model or heuristics without touching the rest of the substrate.

**Run cadence:**
- Substrate runs the classifier on every user turn that the intent resolver flags as containing potential assertion text (a cheap pre-filter).
- Off the hot path of user-facing responses: the classifier runs async, posts to the substrate. The user's current turn is not blocked.

### D5a — Context providers: first-class, read-only, slot-source-distinct

Carved out of D5 when memory got pinned to workspace-only. Need a way to flow read-only external data into context without changing memory semantics.

**Mechanism:** context providers are first-class registered components, queryable via the same `ContextSlotRequest` syntax as memory but routed differently.

```ts
interface ContextProvider {
  readonly id: string;                                // 'user-config', 'mcp:linear', 'code-kg'
  readonly schemaVersion: number;
  read(slot: ContextSlotRequest, deps: ProviderDeps): Promise<readonly MemoryEntry<unknown>[]>;
}
```

Slot request points at `'provider:<id>'` instead of an owner id; assembler routes to the right backend.

**Rules:**
- **Read-only.** Providers don't accept writes, don't accept feedback events, don't participate in distillation.
- **One slot, one source.** Memory OR a provider, not fused. Consumer declares two slots if it wants both.
- **Provider entries tagged in context.** `source.kind: 'provider:<id>'` so consumers can tell what came from where; grounding-review knows it can't correct provider data.
- **No feedback dispatch to providers.** Not owners. Corrections route back to the consumer that requested the provider data.
- **Synchronous during assembly.** Providers must answer cheaply or pre-fetch on a background schedule. Slow providers block context assembly, which blocks execution.

**Day-one providers:**
- `provider:user-config` — `~/.insrc/config.json`.
- `provider:code-kg` — the LMDB+Lance code knowledge graph.
- `provider:active-session` — in-memory session state (active connections, intent tag, prior turn refs).

**Deliberately not on day one:**
- `provider:chat-memory` — value unclear, blast radius high.
- `provider:mcp:<id>` — defer to MCP-integration work.

### D5 — Memory is workspace-scoped, never shared

Memory entries are keyed by `(workspaceId, owner, namespace, key)`. Memory never crosses workspace boundaries. No user-scope, no org-scope, no cross-workspace mirroring.

- **Rejected:** per-owner opt-in for user-scope (proposed earlier; struck down). The premise that "some learnings are mine, some belong to the repo" still holds, but the substrate doesn't try to model the distinction in *memory*. If something is genuinely personal-and-portable, it lives outside the substrate (in a user-config file, in the chat-system memory, etc.) and enters the system as context, not as memory.
- **Rejected:** per-entry opt-in. Same reason.
- **Adopted:** strict workspace isolation. Two workspace directories never see each other's substrate state.

**Carved-out and answered separately:** can *context* be assembled from sources outside the workspace's memory store (user config, external providers)? Yes — see D5a (context providers).

### Remaining open

None at the design level. D1 through D15 are locked. Two items are *intentionally deferred* to a future design pass:
- D9's upgrade-path story (selective preservation across schema bumps).
- D10's encryption-when-warranted story (current threat model doesn't require it).

Implementation-time questions (concrete API shapes, exact threshold tuning, telemetry-event schemas) are not in scope for this design doc and will surface as they arise.

---

## Agents vs skills: same substrate, different patterns

The substrate is the same. Agents and skills differ in *how* they use it, not what they use.

### Skill pattern (L1 or L2)

- **Memory:** small, structured, per-skill caches + aliases. Bootstrap populates; feedback refines.
- **Context:** assembled per `execute()`, scoped to one task.
- **Working state:** ephemeral. L1 typically appends one or two entries (the tool result). L2 accumulates more but still bounded to one logical execution.
- **Distillation:** small. A few cache writes per execution.

### Agent pattern (Pair, Delegate, Designer, Brainstorm, planner)

Agents have *long-running sessions* with multiple user-facing turns. The substrate handles them differently in three ways:

**1. Sessions are owners.** A live Pair session has its own owner id, e.g., `agent:pair:session:<sessionId>`. It owns memory entries scoped to that session — accumulated proposals, current diff hypothesis, todo list, gate decisions. When the session ends, its memory is preserved (audit trail) but the owner is marked terminal — no new writes, no further feedback dispatch.

**2. Working state spans turns, not just one execute().** Skills get a fresh working-state ledger per call. Agents need continuity. Two options:

  - **Per-turn working state, distilled aggressively to session memory.** Each turn loads relevant slice of session memory into context, makes decisions, distills the new findings back. Clean lifecycle but requires distill discipline.
  - **Per-session working state held by the runtime across turns.** Simpler from the agent body's perspective; substrate has to manage the lifecycle (when to checkpoint, when to discard).

  Proposal: **per-turn distill-to-session pattern.** It composes naturally with skill semantics and forces explicit thinking about what should persist. The cost is some boilerplate per agent.

**3. Cross-agent learning via shared owners.** Two Pair sessions in the same workspace shouldn't be isolated forever — patterns learned in one ("user prefers small commits", "the test framework here is vitest not jest") should carry to the next. Mechanism:

  - **Per-session owner** (`agent:pair:session:abc`) for session-scoped state.
  - **Per-workspace owner** (`agent:pair:workspace`) for learnings that should compound across sessions.
  - The agent body explicitly distills "this is a session-only fact" vs "this is a workspace-level learning" via the `DistillTarget.owner` field.

  This is the substrate's affordance for the "compounding intelligence" story to apply at the agent level, not just at the skill level.

### What the substrate doesn't dictate

- **The agent's own loop.** A Pair session runs through 7 steps; that lives in the agent definition, not the substrate. The substrate just provides the memory + context + working-state machinery the steps consume.
- **Channel semantics.** The substrate has no notion of user-facing channels (REPL, chat-stream, gates). Agents handle that.
- **Checkpointing for crash-resume.** The agent framework already has crash-resume via [`checkpoint.ts`](src/insrc/agent/framework/checkpoint.ts). The substrate's working-state checkpoint is a *different* concern (within-execution durability for very long L2 calls). They don't conflict; agents can use both.

### Worked example: Pair session absorbing a workspace-level learning

1. **Session 1, turn 4.** User rejects a Pair proposal: "no, we use `vitest` here, not `jest`."
2. Pair's review-gate step receives the rejection. The step body classifies it as a workspace-level preference (not session-only). It calls `workingState.pin(rejectionEntry, { owner: 'agent:pair:workspace', namespace: 'test-framework-prefs', key: '$workspaceId', kind: 'constraint' })`.
3. On step return, substrate distills the pin → memory write in `agent:pair:workspace`/`test-framework-prefs` with `source: { kind: 'user-asserted', turnId: '...' }`.
4. **Weeks later, Session 7, turn 1.** New Pair session in the same workspace. The agent's analyze step declares a context slot reading `agent:pair:workspace`/`test-framework-prefs`. Slot is populated with the prior learning.
5. Agent body sees the constraint, frames the analysis around vitest from the start. No second correction needed.

This is the agent equivalent of the supplier→vendor_details example earlier. Same substrate primitives; different owner hierarchy.

---

## Relationship to agentic-skills doc

The substrate ships before the L1/L2 framework. Once it's in:

- `plans/agentic-skills-architecture.md` section "L1 skill evolution: bootstrap + ongoing context" reduces to "L1 skills declare an OwnerDeclaration to the substrate; the substrate handles bootstrap + feedback. The L1 skill body reads context slots and writes pinned working-state entries."
- The L2 evidence ledger described there becomes a specialized view of the substrate's working state.
- The L2 deps `context: SkillContextStore` becomes the substrate's `AssembledContext`.

The substrate also lets non-skill consumers (intent classifier, planners, the data-analyzer orchestrator itself) participate in the same memory + feedback ecosystem. That's a meaningful expansion of where the agentic-skills doc currently draws its boundary.

---

## Putting it together: end-to-end entry lifecycle

A worked trace of how one memory entry flows through every part of the substrate.

**Production paths** (how an entry comes into existence):

1. **Bootstrap path (Type 1 — static scan).** Indexer fires a `BootstrapTrigger`. Substrate runs the matching context builders in DAG order (D15). Each builder writes memory entries via `MemoryNamespace.put`. Distillation policy: `'never'` for indexer-managed namespaces (D3) — the indexer is the only producer.

2. **Cold-execute path.** A consumer's `execute()` hits a cache miss, calls its underlying tool, writes the result to working state, and pins it with `DistillTarget`. On successful return, substrate distills per the namespace's `autoDistill` policy. Entry lands as `kind: fact`, `source: { kind: 'cold-execute', ... }`.

3. **Observation path (Type 3).** An L2 skill notices a pattern in its working state, distills as `kind: hint` with `source: { kind: 'observation', tier, ... }`. Tier set per D13. Same-subject-same-claim re-observation updates confidence via D13's saturating formula.

4. **User-assertion path (Type 4).** User turn flows through the classifier (D6). Accepted assertion → substrate looks up `assertionInterests` (D14) → writes `kind: constraint` to each named owner's `user-assertions` namespace. Contradictions resolved last-wins per D7.

5. **Feedback path.** Downstream consumer emits `FeedbackEvent`. Bus fans out (D8, fire-and-forget) to target owners' `applyFeedback` handlers, which can mutate confidence / supersede / add aliases.

6. **External-input path (Type 2).** Consumer reads via a context provider (D5a). Provider returns transient entries (uncached) or writes to the namespace's cache (provider's choice; substrate doesn't enforce).

**Consumption path:**

1. Caller invokes a consumer with a task and a context budget (D2).
2. Substrate's context assembler builds an `AssembledContext`:
   - For each declared `ContextSlotRequest`, query the source (memory namespace or provider) using the declared `ContextQuery` mode.
   - Apply the trichotomy + confidence + recency ranking (D4). For embedding queries, multiply by similarity.
   - Enforce per-slot limits + overall budget; truncations annotated in `notes`.
3. Consumer's `execute()` runs with the assembled context as input + a fresh working state ledger.
4. Mid-execution, the consumer may make cold-path memory reads (accounted against budget; cross-owner reads require the declared `coldPathOwners` allow-list).
5. On successful return, substrate distills pinned working-state entries to memory per D3.

**Maintenance paths:**

1. **TTL sweep.** Background timer scans expired entries (skips `system-constraint` observations and user-asserted constraints). Files deleted; Lance rows dropped.
2. **Schema bump.** Substrate deletes the affected namespace + Lance entries, re-triggers bootstrap with `BootstrapTrigger.kind: 'schema-bump'` per D9.
3. **External-source change** (file mtime, connection config edit). Indexer's existing watchers fire `BootstrapTrigger.kind: 'refresh'` (or similar). Substrate re-runs the affected context builders per D11.

The entire lifecycle of any single entry is traceable through these paths. No path requires special handling outside the substrate primitives.

---

## What this doc is NOT committing to

- Exact `MemoryStore` / `ContextAssembler` / `WorkingStateLedger` API shape (illustrative TypeScript signatures throughout).
- Whether owners get programmatic vs declarative registration (current draft is declarative; could go either way).
- Performance numbers, exact threshold tuning, sharding constants beyond the rough sizing in "Indexing framework."
- Wire format details for `FeedbackEvent` (mostly moot under D8 — no persistence, no cross-version replay).
- The agent-side L1/L2 framework that consumes this substrate. See [`plans/agentic-skills-architecture.md`](plans/agentic-skills-architecture.md).

All 15 design decisions (D1–D15) are locked. This doc is ready to inform implementation. Implementation phases will sequence: substrate primitives first (memory store + context assembler + working state + indexer), then lifecycle runner (bootstrap + feedback + context builders + classifier), then consumer-side adoption (skills declare interests, agents declare session/workspace owners).
