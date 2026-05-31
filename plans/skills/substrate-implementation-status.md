# Substrate implementation status

**Status:** living document (started 2026-05-29)
**Owner:** subhagho@gmail.com
**Purpose:** track what's actually been built versus the locked design in [`plans/memory-context-substrate.md`](../memory-context-substrate.md) and [`plans/agentic-skills-architecture.md`](../agentic-skills-architecture.md). Phases are sequenced so each one is fully complete (compiling, tested, no regressions) before the next starts.

**Rule:** **do not move from a phase to the next without completing every item in the current phase's "done criteria".** The framework docs lock the eventual shape; this doc tracks how we get there incrementally without leaving dead code or half-wired primitives behind.

**Phase numbering note.** This doc uses `P0` / `P1` / `P2` ... for substrate-component implementation phases (fine-grained — one primitive or one skill migration at a time). The broader migration plan in [`plans/agentic-skills-architecture.md`](../agentic-skills-architecture.md) uses `Phase 0` / `Phase 1` ... for coarser milestones (substrate ships, then L1 migrations, then L2 pilots, etc.). Roughly: this doc's `P0` + `P1` together implement *part of* agentic-skills `Phase 0` and the first slice of `Phase 1`. The rest of agentic-skills `Phase 0` (Lance, async indexer DAG, providers, classifier) lands across this doc's `P2`–`P5`.

## Phase ordering at a glance

| Phase | Scope | What it enables | Status |
|---|---|---|---|
| **P0** | Substrate primitives (no consumers) | Memory store + working-state ledger + skill-interface extensions exist as standalone modules with unit tests. | not-started |
| **P1** | First skill migration (`code.class.extract-fields`, narrow wiring) | The substrate is consumed end-to-end by one real skill; Hadoop integration tests validate against real data. | not-started |
| **P2** | Lance index + `byEmbedding` | Semantic recall (fuzzy name match, observation similarity). | done |
| **P3** | Async indexer + queue + context-builder DAG (D15) | Bootstrap moves off the registration hot path; multi-builder skill migrations become possible. | done (DAG + queue + skip-dependents) |
| **P4** | Context providers (D5a) | `provider:active-session`, `provider:code-kg`, `provider:user-config` flow into context slots. | done |
| **P5** | Feedback bus + user-assertion classifier (D6, D8, D14) | User assertions land via the classifier; downstream consumers' `applyFeedback` fires. | done |
| **P6** | L1 skill migrations (code + data) | All L1 priority migrations done -- 85 skills across both sides. | done |
| **P7** | L2 framework core (runtime + budget + grounding + registry) | Per [`plans/skills/l2-framework.md`](../skills/l2-framework.md). Runtime, BudgetTracker, L2LlmAccess, self-grounding validator, L2 registry all shipped. Pilot L2 skill (code.audit-module / code.answer-question) is its own next phase. | done |
| **P8+** | L2 pilot skill | First pilot per [`plans/code-analyzer-migration.md`](../code-analyzer-migration.md) -- `code.audit-module` strawman, then `code.answer-question`. | not-started |

Phases P2 through P5 are independent and can be reordered based on what next-skill migrations need most. P0 → P1 is the only strict prefix.

---

## P0 — Substrate primitives (no consumers)

**Goal:** build the minimum substrate components as standalone modules with unit tests. No existing skill or daemon behavior changes.

### Components

| # | Component | File path (proposed) | Depends on (within P0) |
|---|---|---|---|
| P0.1 | Memory store (file-backed; `byKey` / `prefix` / `filter` only — no `byEmbedding`) | `src/insrc/daemon/substrate/memory-store.ts` | (none) |
| P0.2 | Working-state ledger (in-process; `append` / `pin` / `list` / `get` / `size`) | `src/insrc/daemon/substrate/working-state.ts` | (none) |
| P0.3 | Skill-interface extension types (optional fields: `ownerId`, `schemaVersion`, `interestedTriggers`, `contextSlots`, `memorySchema`, `contextBuilders`, `assertionInterests`, `applyFeedback`) | `src/insrc/daemon/substrate/types.ts` | (none) |
| P0.4 | Unit tests for P0.1, P0.2 | `src/insrc/daemon/substrate/__tests__/*.test.ts` | P0.1, P0.2 |

### Done criteria for P0

- [ ] All four components compile clean against the existing daemon build (`scripts/build.sh daemon`).
- [ ] P0.4 unit tests pass: write + read + delete + prefix-scan + filter against memory store; append + pin + list + get + size against working-state ledger.
- [ ] No existing skill behavior changes. Full existing test suite still passes.
- [ ] Skill registry continues to accept skills that don't declare the new optional fields.
- [ ] Status table in this doc updated: all P0 components marked `done`.

### Out of scope for P0 (deferred to later phases)

| Component | Deferred to | Why not in P0 |
|---|---|---|
| `byEmbedding` query mode | P2 | Lance integration is its own scope |
| Context assembler | P1 | First needed when a skill consumes the substrate |
| Lifecycle runner | P1 | First needed when a skill registers bootstrap/feedback hooks |
| Context providers | P4 | No primary skill needs them yet |
| Indexer DAG | P3 | Single-builder skills don't need ordering |
| Distillation engine (`autoDistill: 'always-on-success'` policy) | P1 | First needed when a skill pins entries |
| Conflict-resolution merge function override | P1 | Default D4 policy is sufficient for now |

---

## P1 — First skill migration (`code.class.extract-fields`, narrow wiring)

**Goal:** migrate one real L1 skill end-to-end against the substrate, validate with Hadoop integration tests, prove the framework works on real data.

**Prerequisites:** P0 done.

### Components

| # | Component | File path (proposed) | Depends on |
|---|---|---|---|
| P1.1 | Context assembler (memory-only; four query modes minus `byEmbedding`) | `src/insrc/daemon/substrate/context-assembler.ts` | P0.1 |
| P1.2 | Sync lifecycle runner (dispatches `bootstrap` synchronously at skill registration; no DAG) | `src/insrc/daemon/substrate/lifecycle-runner.ts` | P0.1, P0.3, P1.1 |
| P1.3 | Distillation engine (`autoDistill` policy applied on successful skill return; pinned working-state entries land in memory) | `src/insrc/daemon/substrate/distill.ts` | P0.1, P0.2 |
| P1.4 | Skill-runner integration (the existing `daemon/skills/invoke.ts` learns to populate `deps.context` + `deps.workingState` before calling `skill.execute`) | `src/insrc/daemon/skills/invoke.ts` (modify) | P1.1, P1.2, P1.3 |
| P1.5 | `code.class.extract-fields` migration with **narrow slot wiring** — see "P1 narrow wiring" below | `src/insrc/daemon/skills/built-ins/code.class.extract-fields.ts` (modify) | P0.3, P1.4 |
| P1.6 | Unit tests for the migrated skill (fake tools) | `src/insrc/daemon/skills/__tests__/code.class.extract-fields.test.ts` (modify) | P1.5 |
| P1.7 | Hadoop integration tests | `src/insrc/daemon/skills/__tests__/code.class.extract-fields.hadoop.test.ts` (new) | P1.5 |

### P1 narrow wiring — what's actually wired vs full per-skill design

The full per-skill design [`code/code.class.extract-fields.md`](code/code.class.extract-fields.md) declares 7 context slots, 5 memory namespaces, 2 `assertionInterests`, 1 `contextBuilder`. **P1 wires only the subset whose dependencies exist in P0+P1.** The rest stays in the per-skill design as the eventual target; phase annotations clarify what lands when.

**Wired in P1:**

| Slot / namespace / hook | P1 status | Notes |
|---|---|---|
| `contextSlots.cached-extraction` (from own namespace) | wired | Cache hit short-circuit; validates the substrate's memory store + assembler. |
| `contextSlots.class-aliases` (from own namespace) | wired | Tests populate aliases directly via `MemoryStore.put`; classifier (D6) absent in P1. |
| `contextSlots.recent-misses` (from own namespace) | wired | Miss caching for nearest-candidate re-attempts. |
| `memorySchema.extracted-classes` | wired | `autoDistill: 'always-on-success'`. |
| `memorySchema.class-aliases` | wired | `autoDistill: 'on-pin'`; populated by tests + (future) D6 classifier. |
| `memorySchema.recent-misses` | wired | `autoDistill: 'always-on-success'`. |
| Skill registration declares all four full-design `memorySchema` namespaces | wired | Declarations are inert until consumed; reserving the namespace name is cheap. |

**Deferred (declared but inert in P1):**

| Slot / namespace / hook | Deferred to | Why |
|---|---|---|
| `contextSlots.active-closure` (from `provider:active-session`) | P4 | Context providers (D5a) deferred. P1 falls back to inline closure resolution via the existing `resolveSearchScope` helper. |
| `contextSlots.language-by-file` (from `skill:language-detection`) | P3 | `language-detection` itself is a context builder; needs the async indexer DAG. P1 reads the language from the entity record returned by `code_class_locate`. |
| `contextSlots.workspace-patterns` (own namespace, populated by observation distillation) | P5 | Observation distillation hook is present in P1 (`pinObservation` API) but isn't wired into a skill yet. P1 skill body doesn't emit observations. |
| `contextSlots.user-assertions` | P5 | Classifier (D6) deferred. The namespace exists; P1 tests can write to it directly to validate alias resolution works end-to-end. |
| `assertionInterests` declarations | P5 | Registered in P1 but inert until D6 classifier lands. |
| `contextBuilders.prewarm-top` | P3 | Depends on the deferred `entity-name-index` builder. P1 has no bootstrap-time prewarm; cache populates lazily on first call. |
| `applyFeedback` hook | P5 | Hook is present (registered as a function); the feedback bus that calls it lands in P5. |

This split is deliberate: **the skill's substrate-facing declaration matches its eventual target shape in P1**, even though only a subset is consumed. New phases (P3–P5) wire up the deferred slots without re-touching the skill registration.

### Done criteria for P1

- [ ] All P1 components compile clean.
- [ ] Existing `code.class.extract-fields` unit tests pass unchanged (`npx tsx --test src/insrc/daemon/skills/__tests__/code.class.extract-fields.test.ts`).
- [ ] New unit tests verify:
  - Cache hit short-circuit (no tool calls when `extracted-classes` slot returns a fresh entry).
  - Cold path writes back to `extracted-classes` via working-state pin + distillation.
  - Alias resolution: test populates `class-aliases` directly; skill resolves `User` → `UserModel` before locate call.
  - Miss + nearest candidates persisted to `recent-misses`.
  - Multi-match without user-assertion → `found: false, ambiguity` (uses fixture).
- [ ] Hadoop integration tests (P1.7) pass:
  - `NameNode` single-match path returns `found: true` with non-empty fields.
  - `Configuration` ambiguity path returns the two-alternative ambiguity payload (matches the natural Hadoop fixture).
  - Second call to `NameNode` is a cache hit (verifies distillation + assembler integration).
- [ ] Whole-daemon build still clean (`scripts/build.sh daemon` and the full skill test suite).
- [ ] Code-analyzer pipeline still works end-to-end with the migrated skill (manual smoke test, since live LLM testing for the broader pipeline is its own concern).
- [ ] Status table in this doc updated: all P1 components marked `done`.

### Out of scope for P1 (deferred to later phases)

Captured in the "Deferred (declared but inert in P1)" table above. The substrate-doc decisions table below also tracks where each MVP-vs-substrate-doc delta lands.

---

## P2 — Lance index + `byEmbedding`

**Goal:** wire the substrate to LanceDB so `MemoryNamespace.searchByEmbedding` returns real semantic hits, without changing any existing skill behavior or requiring the indexer to be present.

**Prerequisites:** P0, P1 done.

### Components

| # | Component | File path | Depends on |
|---|---|---|---|
| P2.1 | Substrate vector index (one shared `substrate_vec` Lance table with `(workspace_id, owner, namespace)` filter columns) | [`substrate-vec.ts`](../../src/insrc/daemon/substrate/substrate-vec.ts) | (none) |
| P2.2 | Indexing engine (per-namespace policy resolution; embed-then-write hook for memory puts/deletes) | [`indexer.ts`](../../src/insrc/daemon/substrate/indexer.ts) | P2.1, P0.3 |
| P2.3 | Memory store `searchByEmbedding` (wrapper that hooks indexer into `put` / `delete` / `searchByEmbedding`; runtime wires it when an `Embedder` is provided) | [`memory-store-indexed.ts`](../../src/insrc/daemon/substrate/memory-store-indexed.ts) + [`runtime.ts`](../../src/insrc/daemon/substrate/runtime.ts) | P2.2 |
| P2.4 | Unit tests (deterministic fake embedder; per-policy coverage; distance ordering; scope filtering; legacy compat; failure swallow) | [`indexer.test.ts`](../../src/insrc/daemon/substrate/__tests__/indexer.test.ts) | P2.3 |

### Done criteria for P2

- [x] All four components compile clean (`scripts/build.sh daemon`).
- [x] P2.4 unit tests pass: `always` policy embeds + writes Lance row; `never` policy skips embedder; `derived` policy embeds `from(entry)` output; delete removes file + Lance row; `searchByEmbedding` returns hits in distance order; scoping isolates `(owner, namespace)`; runtime without embedder falls back to empty `searchByEmbedding`; flaky embedder failures are swallowed (file write still succeeds).
- [x] No regressions: P0 + P1 substrate suites still green; `code.class.extract-fields` legacy/substrate/Hadoop suites still pass.
- [x] Skill-runner behavior unchanged for skills that don't declare a `byEmbedding` slot (the indexer is purely additive on top of file writes).
- [x] Status table in this doc updated: all P2 components marked `done`.

### Out of scope for P2 (deferred to later phases)

| Component | Deferred to | Why not in P2 |
|---|---|---|
| `on-flag` indexing policy (caller-driven flag) | P3+ | No skill consumer flags entries yet; treating as `never` keeps the policy table honest while avoiding dead code. |
| Async indexer DAG (D15) | P3 | Single embedder, single Lance writer; the synchronous `onPut` hook is sufficient for substrate-scale namespaces. |
| Per-namespace Lance tables | When a single namespace approaches ~1M entries | Shared table cleaner to migrate later; row counts at substrate scale stay well below the threshold. |
| `byEmbedding` integration into `code.class.extract-fields` (fuzzy name match) | P3+ (per-skill migration) | The substrate gains the capability here; consumer wiring lands when a specific skill needs it. |
| Lance index (ANN build) on `substrate_vec` | When per-namespace row counts trigger | Exact KNN is fast at substrate scale; the table seed + mergeInsert path is correct as-is. |
| Eviction / cold-row pruning | P3+ | TTL expiry on the file side drops the canonical row; orphan Lance rows are skipped by the resolver. |

---

## P4 — Context providers (D5a)

**Goal:** route slot requests at `provider:<id>` through a typed read-only provider registry. Add the three day-one providers: `user-config`, `active-session`, `code-kg`. No skill is required to consume them yet -- the substrate gains the capability; per-skill wiring lands when a specific consumer needs it.

**Prerequisites:** P0, P1, P2 done.

### Components

| # | Component | File path | Depends on |
|---|---|---|---|
| P4.1 | `ContextProvider` type + provider registry | [`provider-registry.ts`](../../src/insrc/daemon/substrate/provider-registry.ts) + types.ts | (none) |
| P4.2 | Context assembler routes `provider:*` slots through the registry | [`context-assembler.ts`](../../src/insrc/daemon/substrate/context-assembler.ts) (modify) | P4.1 |
| P4.3 | `provider:user-config` reads `~/.insrc/config.json` | [`providers/user-config.ts`](../../src/insrc/daemon/substrate/providers/user-config.ts) | P4.1 |
| P4.4 | `provider:code-kg` exposes LMDB entity lookups | [`providers/code-kg.ts`](../../src/insrc/daemon/substrate/providers/code-kg.ts) | P4.1 |
| P4.5 | `provider:active-session` exposes a whitelisted set of Session fields | [`providers/active-session.ts`](../../src/insrc/daemon/substrate/providers/active-session.ts) | P4.1 |
| P4.6 | Runtime wires the registry; `prepareForSkill` threads `session` into provider deps | [`runtime.ts`](../../src/insrc/daemon/substrate/runtime.ts) (modify) | P4.2 |
| P4.7 | Unit tests | [`provider-registry.test.ts`](../../src/insrc/daemon/substrate/__tests__/provider-registry.test.ts) | P4.6 |

### Done criteria for P4

- [x] All components compile clean (`scripts/build.sh daemon`).
- [x] P4.7 unit tests pass (13/13): registry round-trip, replacement-on-reregister, non-provider owner falls through, unknown provider returns empty, source-stamping contract, assembler routing, no-registry fallback, mixed memory+provider request, active-session whitelist enforcement + prefix scan + missing-session fallback, user-config nested byKey + missing path.
- [x] No regressions across substrate + extract-fields suites.
- [x] Skills without provider slots are unaffected (`fromOwner: 'provider:'` is opt-in; legacy memory-only paths are unchanged).
- [x] Status table in this doc updated; decision row D5a marked landed.

### Out of scope for P4 (deferred to later phases)

| Component | Deferred to | Why not in P4 |
|---|---|---|
| `code-kg` prefix scan / filter / embedding paths | P6+ (per-skill migration) | LMDB's name index is exact-match; substring scan needs its own API in `db/entities`. Skills wanting fuzzy lookup go through `code_class_locate` until then. |
| `provider:chat-memory` | (Not on day one per D5a) | Value unclear, blast radius high. |
| `provider:mcp:<id>` | MCP-integration work | Defer to that scope. |
| Per-provider timeout enforcement in the registry | When telemetry surfaces a slow provider | Providers are trusted; a misbehaving one blocks assembly. |
| Cross-call caching keyed on provider+slot | When repeated identical assembly shows up | Day-one providers are cheap; caching adds complexity without a measurable win. |
| Skill consumption of provider slots (e.g. `code.class.extract-fields` reading `provider:active-session.closureRepos` instead of `deps.session.closureRepos`) | Per-skill migration follow-ups | The provider is available; consumers opt in when they want to. |

---

## Component status tracker

Updated as each component lands. Status: `not-started` / `in-progress` / `done` / `deferred`.

| Phase | Component | Status | Notes |
|---|---|---|---|
| meta | MVP scope locked | done | This doc. |
| P0.1 | Memory store (files; `byKey`, `prefix`, `filter`) | done | [`memory-store.ts`](../../src/insrc/daemon/substrate/memory-store.ts); D4 default conflict resolution applied as read-before-write. |
| P0.2 | Working-state ledger | done | [`working-state.ts`](../../src/insrc/daemon/substrate/working-state.ts); D12 soft warn + hard cap enforced. |
| P0.3 | Skill-interface extension types | done | [`types.ts`](../../src/insrc/daemon/substrate/types.ts); SubstrateSkillExtension is fully optional, declared but not yet consumed by the skill runner (P1.4). |
| P0.4 | P0 unit tests | done | 27 tests pass: round-trips, key sanitization, prefix scan, filter scan, D4 conflict resolution, file layout, expiry handling, soft warn, hard cap (entries + bytes), ledger isolation. |
| P1.1 | Context assembler (memory only) | done | [`context-assembler.ts`](../../src/insrc/daemon/substrate/context-assembler.ts); four query modes minus `byEmbedding`; D4 ranking + caller-owned budget (D2) with proportional truncation. |
| P1.2 | Sync lifecycle runner | done | [`lifecycle-runner.ts`](../../src/insrc/daemon/substrate/lifecycle-runner.ts); `fireTrigger` dispatches matching builders sequentially. Superseded by P3.1-P3.4 (DAG + queue + skip-dependents) -- same file. |
| P1.3 | Distillation engine | done | [`distill.ts`](../../src/insrc/daemon/substrate/distill.ts); walks pins, looks up the namespace's `autoDistill` policy, writes to memory. |
| P1.4 | Skill-runner integration (`invoke.ts`) | done | Substrate runtime facade ([`runtime.ts`](../../src/insrc/daemon/substrate/runtime.ts)) wires assembler + lifecycle + distill; `runSkill` populates `deps.context` / `deps.workingState` / `deps.memory` when substrate is provided. Skills without substrate-facing declarations are unaffected. |
| P1.5 | `code.class.extract-fields` migration (narrow) | done | 3 context slots wired (cached-extraction / class-aliases / recent-misses); 5 memorySchema namespaces declared; 2 assertionInterests declared. Deferred-component slots return empty and skill body falls through (per the per-skill plan's P1 narrow-wiring table). |
| P1.6 | Skill unit tests | done | 5 substrate-aware tests pass: cache-hit short-circuit, cold-path distillation, alias resolution, miss persistence, legacy-compat (skill works without substrate). |
| P1.7 | Hadoop integration tests | done | 5 integration tests against the real LMDB graph + entity-vec; pass against NameNode / BlockManager / Configuration (multi-match) / nonexistent class; second-call cache-hit verified. |
| P2.1 | Substrate vector index (`substrate_vec` Lance table) | done | [`substrate-vec.ts`](../../src/insrc/daemon/substrate/substrate-vec.ts); one shared table; id derived from `(workspace, owner, namespace, key)`; mergeInsert upserts; per-row delete + per-namespace delete. |
| P2.2 | Indexing engine (per-namespace policy) | done | [`indexer.ts`](../../src/insrc/daemon/substrate/indexer.ts); reads `IndexingPolicy` at write time (`always` / `never` / `derived` wired; `on-flag` deferred); fire-and-forget failure swallow; `Embedder` interface added to types. |
| P2.3 | Memory store `searchByEmbedding` | done | [`memory-store-indexed.ts`](../../src/insrc/daemon/substrate/memory-store-indexed.ts); wraps base store so put/delete mirror into Lance and `searchByEmbedding` routes through `indexer.search()`; runtime opts in via `{ embedder, workspaceId }`. |
| P2.4 | P2 unit tests | done | 8 tests pass: `always`/`never`/`derived` policies, delete cascade, distance ordering, `(owner, namespace)` scope isolation, runtime-without-embedder falls back to empty, embedder-failure swallow. |
| P4.1 | `ContextProvider` type + provider registry | done | [`provider-registry.ts`](../../src/insrc/daemon/substrate/provider-registry.ts); types add `ContextProvider`, `ProviderDeps`, `PROVIDER_OWNER_PREFIX`, `isProviderOwner`, `providerIdOf`, and the `provider` EntrySource variant. |
| P4.2 | Assembler routes `provider:*` slots | done | [`context-assembler.ts`](../../src/insrc/daemon/substrate/context-assembler.ts); per-call `AssembleDeps` plumbs `session` + `signal` into providers; missing-registry callers see empty results (back-compat). |
| P4.3 | `provider:user-config` | done | [`providers/user-config.ts`](../../src/insrc/daemon/substrate/providers/user-config.ts); dot-path byKey + prefix walk + filter walk against `loadConfig()`; mtime stamping; ANN returns empty. |
| P4.4 | `provider:code-kg` | done | [`providers/code-kg.ts`](../../src/insrc/daemon/substrate/providers/code-kg.ts); byKey routes to `findEntitiesByName` scoped by `session.closureRepos`. Prefix / filter / ANN return empty (deferred to per-skill needs). |
| P4.5 | `provider:active-session` | done | [`providers/active-session.ts`](../../src/insrc/daemon/substrate/providers/active-session.ts); whitelisted field surface (id / repoPath / closureRepos / turnIndex / startedAt / permissionMode / intent); non-whitelisted fields are filtered out. |
| P4.6 | Runtime wires registry | done | [`runtime.ts`](../../src/insrc/daemon/substrate/runtime.ts); `CreateSubstrateRuntimeOpts.providers?` seeds the registry; `runtime.providers` is publicly exposed; `prepareForSkill` threads session into the assembler's per-call deps. |
| P4.7 | P4 unit tests | done | 13 tests pass: registry round-trip, replacement, non-provider owner -> [], unknown id -> [], source stamping, assembler routing, no-registry empty fallback, memory+provider coexistence in one request, active-session whitelist + prefix + missing-session, user-config nested byKey + missing path. |
| P3.1 | Topo-sort + cycle detection | done | [`lifecycle-runner.ts`](../../src/insrc/daemon/substrate/lifecycle-runner.ts); Kahn levels + Tarjan SCC; cycles raise `DagCycleError` at registration with rollback. |
| P3.2 | DAG-ordered execution | done | Same file; serial-within-level (parallel-within-level deferred until per-spec `parallelSafe` flag lands). |
| P3.3 | Trigger serialization queue | done | Same file; concurrent `fireTrigger` calls are chained off a tail Promise; `drain()` exposed. |
| P3.4 | Skip-dependents-on-failure | done | Same file; per-builder `BuilderRunResult` with `succeeded`/`failed`/`skipped` + `skippedBecause` lineage; back-compat `failures` preserved. |
| P3.5 | P3 unit tests | done | 13 tests pass: linear / diamond / reverse-registration / cycle / self-loop / validateDag / failure-skip / unrelated-survives / trigger-filter / concurrent-serialization / drain / empty / external-dep-treated-as-satisfied. |
| P5.1 | Feedback bus (D8) | done | [`feedback-bus.ts`](../../src/insrc/daemon/substrate/feedback-bus.ts); subscribe / emit / drain; global serial dispatch (parallel-cross-target deferred to `parallelSafe` flag); per-target ordering via insertion-order snapshots. |
| P5.2 | Assertion-interest index (D14) | done | [`assertion-index.ts`](../../src/insrc/daemon/substrate/assertion-index.ts); exact `subjectPattern` lookup; priority-descending ordering with stable owner-id tiebreak; embedding similarity deferred. |
| P5.3 | User-assertion classifier (D6) | done | [`classifier/user-assertion.ts`](../../src/insrc/daemon/substrate/classifier/user-assertion.ts); Layer 1 heuristic ships in-substrate; Layer 2 LLM + Layer 3 user-confirm are injectable hooks (default no-op defers). |
| P5.4 | Runtime `classifyAssertion` | done | [`runtime.ts`](../../src/insrc/daemon/substrate/runtime.ts); accepted payloads -> resolve targets (payload-explicit, else index lookup) -> persist constraint to `<owner>/user-assertions` -> emit `user-correction` event on bus. |
| P5.5 | Skill registration wires interests + feedback | done | Same file; `assertionInterests` -> index; `applyFeedback` -> bus subscription; deregister unwinds both. |
| P5.6 | P5 unit + integration tests | done | 30 tests pass across 4 files: feedback-bus (8) round-trip / multi-handler / failure-isolation / per-target order / serial dispatch / drain / cross-owner; assertion-index (8) register/lookup/replace/priority/multi-owner; classifier (9) `always` / `never` / `use X for Y` / task-local / no-marker / Layer 2 accept-above-threshold / Layer 3 escalation / Layer 2 reject / default-defer; integration (5) full flow / explicit-target / no-index-match / rejected / no-feedback-handler. |

### P5 done criteria — verified

- [x] All P5 components compile clean.
- [x] P5 unit tests pass (30/30).
- [x] No regressions across substrate + skills suites (128/128 total).
- [x] Status table updated; decision rows D6 / D8 / D14 marked landed.

### P3 done criteria — verified

- [x] All P3 components compile clean.
- [x] P3 unit tests pass (13/13).
- [x] No regressions across substrate + skills suites (98/98 total).
- [x] Status table updated; decision row D15 marked landed.

---

## P5 — Feedback bus + user-assertion classifier (D6, D8, D14)

**Goal:** wire the last three locked decisions -- in-process feedback dispatch (D8), assertion-interest routing (D14), and the three-layer user-assertion classifier (D6) -- and bolt them into the runtime so a user-turn text flows end-to-end: classifier -> assertion-index lookup -> per-target memory write + applyFeedback dispatch.

**Prerequisites:** P0, P1 done. (Independent of P2, P3, P4.)

### Components

| # | Component | File path | Depends on |
|---|---|---|---|
| P5.1 | Feedback bus (D8) | [`feedback-bus.ts`](../../src/insrc/daemon/substrate/feedback-bus.ts) | (none) |
| P5.2 | Assertion-interest index (D14) | [`assertion-index.ts`](../../src/insrc/daemon/substrate/assertion-index.ts) | P0.3 |
| P5.3 | User-assertion classifier (D6) -- interface + Layer 1 heuristic + injectable Layer 2/3 hooks | [`classifier/user-assertion.ts`](../../src/insrc/daemon/substrate/classifier/user-assertion.ts) | (none) |
| P5.4 | Runtime `classifyAssertion` -- classifier output -> index lookup -> memory write + bus dispatch | [`runtime.ts`](../../src/insrc/daemon/substrate/runtime.ts) (modify) | P5.1, P5.2, P5.3 |
| P5.5 | Skill registration wires `assertionInterests` into the index + `applyFeedback` into the bus | [`runtime.ts`](../../src/insrc/daemon/substrate/runtime.ts) (modify) | P5.4 |
| P5.6 | Unit + integration tests | [`feedback-bus.test.ts`](../../src/insrc/daemon/substrate/__tests__/feedback-bus.test.ts), [`assertion-index.test.ts`](../../src/insrc/daemon/substrate/__tests__/assertion-index.test.ts), [`classifier-user-assertion.test.ts`](../../src/insrc/daemon/substrate/__tests__/classifier-user-assertion.test.ts), [`classify-assertion-integration.test.ts`](../../src/insrc/daemon/substrate/__tests__/classify-assertion-integration.test.ts) | P5.5 |

### Done criteria for P5

- [x] All P5 components compile clean (`scripts/build.sh daemon`).
- [x] P5.6 unit tests pass (30/30 across 4 files): feedback-bus (8), assertion-index (8), classifier (9), classify-assertion integration (5).
- [x] No regressions across substrate + skills suites (128/128 total).
- [x] Skills opt in by declaring `assertionInterests` + `applyFeedback`; skills without either are unaffected.
- [x] Status table in this doc updated; decision rows D6 / D8 / D14 marked landed.

### Out of scope for P5 (deferred to later phases)

| Component | Deferred to | Why not in P5 |
|---|---|---|
| Parallel-cross-target fan-out (D8 ships this) | When a `parallelSafe` per-subscription flag lands | CLAUDE.md's "no parallel LLM calls" rule applies to handlers that may reach an LLM; serial-cross-target is the safe default. |
| Embedding-similarity fallback for assertion subjects (D14 step 2) | When a real consumer needs fuzzy routing | Exact `subjectPattern` is enough for the day-one Layer 1 heuristic + LLM-emitted canonical subjects. |
| LLM-backed Layer 2 classifier | When daemon wires the active provider into the classifier | Substrate ships the hook + the deterministic Layer 1; Layer 2 lives outside the substrate primitive. |
| UI-backed Layer 3 user-confirm | When chat-UI integration ships | Same -- substrate ships the hook. |
| `(turnId, span)` decision cache | When telemetry shows repeated identical spans | Premature without data. |
| Classifier-owned `decisions` namespace persistence (D6 audit trail) | When telemetry / UI needs the trail | The `ClassifyResult.decisions` array is the in-memory equivalent; persisting it is its own scope. |
| `acceptAssertion` per-target validation hook (D6) | When a skill needs to refine / reject incoming assertions | `applyFeedback` is the existing hook; `acceptAssertion` is an optional pre-persist filter that can layer on. |
| Full D7 supersession-marking (`supersededBy` on conflicting constraints) | When a real conflict shows up in usage | D4's default conflict resolution (constraint+constraint: confidence -> recency) gives correct behavior; full supersession marking is audit-trail sugar. |

---

### P4 done criteria — verified

- [x] All P4 components compile clean.
- [x] P4 unit tests pass (13/13).
- [x] No regressions across the substrate + skills suites.
- [x] Skills without provider slots are unaffected (provider routing is `fromOwner`-prefix opt-in).
- [x] Status table updated; decision row D5a marked landed.

---

## P3 — Context-builder DAG (D15)

**Goal:** replace the P1 sequential lifecycle runner with a substrate-managed DAG that topo-sorts builders by `dependsOn`, detects cycles at registration time, skips transitive dependents on failure, and serializes concurrent triggers.

**Prerequisites:** P0, P1 done. (Independent of P2, P4.)

### Components

| # | Component | File path | Depends on |
|---|---|---|---|
| P3.1 | Topo-sort (Kahn levels) + cycle detection (Tarjan SCC) | [`lifecycle-runner.ts`](../../src/insrc/daemon/substrate/lifecycle-runner.ts) (rewrite) | P0.3 |
| P3.2 | DAG-ordered execution; serial-within-level | same | P3.1 |
| P3.3 | Trigger serialization queue with `drain()` | same | P3.1 |
| P3.4 | Skip-dependents-on-failure semantics; per-builder `BuilderRunResult`; extended `TriggerReport` | same | P3.2 |
| P3.5 | Unit tests | [`lifecycle-runner.test.ts`](../../src/insrc/daemon/substrate/__tests__/lifecycle-runner.test.ts) | P3.4 |

### Done criteria for P3

- [x] All P3 components compile clean (`scripts/build.sh daemon`).
- [x] P3.5 unit tests pass (13/13): linear / diamond / reverse-registration / cycle / self-loop / validateDag / failure-skip / unrelated-survives / trigger-filter / concurrent-serialization / drain / empty / external-dep-treated-as-satisfied.
- [x] No regressions across substrate + skills suites (98/98 total).
- [x] Per-builder result shape (`BuilderRunResult`) lets callers tell `succeeded` / `failed` / `skipped` apart. Back-compat `failures` array preserved.
- [x] Status table in this doc updated.

### Out of scope for P3 (deferred to later phases)

| Component | Deferred to | Why not in P3 |
|---|---|---|
| Parallel-within-level execution (D15 ships this; substrate runs serial-within-level for now) | When per-builder `parallelSafe` flag lands | CLAUDE.md's "no parallel LLM calls" rule disqualifies blind Promise.all on builders that may reach an LLM. Gated on a per-spec opt-in. |
| Incremental dirty-input tracking | When a real incremental refresh shows up | No consumer fires partial-reindex triggers yet; topo-sort over the full matched subset is fine. |
| Background scheduler / periodic refresh | When a scheduled refresh consumer shows up | Triggers are caller-driven today (manual / repo-add); a scheduler is its own scope. |
| Selective re-run after a builder retry | When user-triggered retry shows up in the UI | Tests can re-fire the whole trigger; selective retry is UI sugar over the same primitive. |

---

### P2 done criteria — verified

- [x] All P2 components compile clean.
- [x] P2.4 unit tests pass (8/8): policy coverage, delete cascade, ordering, scoping, legacy compat, failure swallow.
- [x] No regressions: 35/35 substrate tests (27 P0/P1 + 8 P2) still pass; `code.class.extract-fields` legacy/substrate/Hadoop suites still pass.
- [x] Skill-runner behavior unchanged for skills without an embedder declared.
- [x] Status table updated.

### P1 done criteria — verified

- [x] All P1 components compile clean.
- [x] Existing `code.class.extract-fields` unit tests pass unchanged (11/11).
- [x] New unit tests verify cache-hit short-circuit, cold-path distillation, alias resolution, miss persistence, legacy-compat (5/5).
- [x] Hadoop integration tests pass (5/5): NameNode single-match, second-call cache hit, BlockManager single-match, Configuration ambiguity (returns one of the two real entities), nonexistent-class miss with persisted nearest candidates.
- [x] Whole-daemon build still clean.
- [x] No regressions: 21/21 meta-skill tests + 27/27 P0 substrate tests still pass.
- [x] Status table updated.

### P0 done criteria — verified

- [x] All four components compile clean against the existing daemon build.
- [x] Unit tests pass (27/27).
- [x] No existing skill behavior changes — 21/21 meta-skill tests still pass; no other existing tests touched.
- [x] Skill registry continues to accept skills without the new optional fields (SubstrateSkillExtension is fully optional; not consumed yet).
- [x] Component status table updated.

---

## P6+ — Per-skill L1 migrations (in progress)

The substrate is feature-complete (P0–P5 done). Subsequent work is per-skill L1 migration onto the substrate per [`plans/agentic-skills-architecture.md`](../agentic-skills-architecture.md) §"Migration of existing L1 skills" + the priority order in [`plans/code-analyzer-migration.md`](../code-analyzer-migration.md) §"Code-analyzer L1 skill migrations (priority order)".

Each migration:
1. Per-skill plan in [`plans/skills/code/`](.) or [`plans/skills/data/`](.) (target shape -- contextSlots, memorySchema, assertionInterests).
2. Add substrate-facing declarations to the skill file (mechanical wiring).
3. Rewrite `execute()` to consult `deps.context.slots` before tool/DB calls; pin successful results to working state for distillation.
4. Substrate-aware unit tests + (where applicable) Hadoop integration tests.

### Migrated skills

| # | Skill | Plan doc | Implementation | Tests |
|---|---|---|---|---|
| 1 | `code.class.extract-fields` | [`code/code.class.extract-fields.md`](code/code.class.extract-fields.md) | [`code.class.extract-fields.ts`](../../src/insrc/daemon/skills/built-ins/code.class.extract-fields.ts) | substrate (5), Hadoop (5), legacy (11) |
| 2 | `code.entity.locate-by-name` | [`code/code.entity.locate-by-name.md`](code/code.entity.locate-by-name.md) | [`code.entity.locate-by-name.ts`](../../src/insrc/daemon/skills/built-ins/code.entity.locate-by-name.ts) | substrate (6), Hadoop (6), legacy (22) |
| 3 | `code.source.module.describe` | [`code/code.source.module.describe.md`](code/code.source.module.describe.md) | [`code.source.module.describe.ts`](../../src/insrc/daemon/skills/built-ins/code.source.module.describe.ts) | substrate (5), Hadoop (3), legacy (12). **Measured cold->warm latency drop: ~4.5s -> ~1.0s on Hadoop namenode dir.** |
| 4 | `code.source.file.describe` | [`code/code.source.file.describe.md`](code/code.source.file.describe.md) | [`code.source.file.describe.ts`](../../src/insrc/daemon/skills/built-ins/code.source.file.describe.ts) | substrate (5), Hadoop (3). **Cold->warm: ~104ms -> ~5ms (~20x) on NameNode.java.** This migration also surfaced + fixed a memory-store long-key ENAMETOOLONG bug (substrate fix: hash-fallback filename for keys whose encoded form exceeds 200 bytes; reverse-mapped via `_meta.key`). |
| 7  | `code.entity.summary`           | [`code/code.entity.summary.md`](code/code.entity.summary.md)        | [`code.entity.summary.ts`](../../src/insrc/daemon/skills/built-ins/code.entity.summary.ts)               | substrate (6). out-of-scope + disk-fallback paths intentionally not cached. |
| 8  | `code.quality.complexity`       | [`code/code.quality.suite.md`](code/code.quality.suite.md) (shared) | [`code.quality.complexity.ts`](../../src/insrc/daemon/skills/built-ins/code.quality.complexity.ts)       | substrate (2 of 7 in suite). |
| 9  | `code.quality.cyclic-deps`      | [`code/code.quality.suite.md`](code/code.quality.suite.md) (shared) | [`code.quality.cyclic-deps.ts`](../../src/insrc/daemon/skills/built-ins/code.quality.cyclic-deps.ts)     | substrate (1 of 7 in suite). |
| 10 | `code.quality.duplication`      | [`code/code.quality.suite.md`](code/code.quality.suite.md) (shared) | [`code.quality.duplication.ts`](../../src/insrc/daemon/skills/built-ins/code.quality.duplication.ts)     | substrate (2 of 7 in suite). |
| 11 | `code.quality.unused-exports`   | [`code/code.quality.suite.md`](code/code.quality.suite.md) (shared) | [`code.quality.unused-exports.ts`](../../src/insrc/daemon/skills/built-ins/code.quality.unused-exports.ts) | substrate (1 of 7 in suite) + legacy compat (1). All quality skills: 24h TTL (shorter than 7d -- code quality drifts with edits). |
| 5  | `code.meta.classify-question`   | [`code/code.meta.classify-question.md`](code/code.meta.classify-question.md) (A5 evolution) | [`code.meta.classify-question.ts`](../../src/insrc/daemon/skills/built-ins/code.meta.classify-question.ts) | **NOT a cache wiring -- A5 schema evolution.** Adds `goal: string` to each `Candidate` (natural-language instruction the routed skill plans against). System prompt + few-shot examples + validator all updated to require non-empty goal; one retry on missing. Substrate declaration is "ownership only" (no `contextSlots` -- caching offers near-zero win for question-driven LLM routing). |
| 6  | `code.meta.select-scope`        | [`code/code.meta.select-scope.md`](code/code.meta.select-scope.md) (A5 demotion) | [`code.meta.select-scope.ts`](../../src/insrc/daemon/skills/built-ins/code.meta.select-scope.ts) | **A5 demotion: arg-filler utility, not routing.** Makes `goal` required (was optional pass-through from #5); renders goal prominently in the LLM prompt; system prompt rule explains goal is primary signal for filling args (inputSchema = structure, goal = content). Substrate ownership-only. Tests: 22/22 (existing 20 + 2 new A5: missing-goal-rejected-at-input + goal-renders-before-rationale). |

### Pending priority migrations (from code-analyzer-migration.md)

All 7 code-analyzer L1 migrations done. Remaining migration work (per agentic-skills-architecture.md):

| Priority | Skill | Why |
|---|---|---|
| done | `data.meta.classify-question` | A5 evolution shipped 2026-05-31 (mirrors the code-side migration). |
| done | `data.meta.select-scope`      | A5 demotion shipped 2026-05-31 (mirrors the code-side migration). |
| done | Data L1 skill migrations      | 73 data L1 skills migrated 2026-05-31 across all families (data.source / data.quality / data.profile / data.distribution / data.drift / data.correlation / data.pii / data.dependency / data.cardinality / data.anomaly / data.timeseries / data.sensitivity / data.code / data-lineage). 6 `data.synth.*` skills skipped (synthesis renderers; low cache-hit rate). 24 `.algo.ts` math helpers skipped (no Skill object). |

**L2 framework (P7) shipped** -- the runtime is now available; the pilot L2 skill (`code.audit-module` / `code.answer-question`) is the next phase. See [`plans/skills/l2-framework.md`](l2-framework.md) for the locked interface decisions.

---

## Decisions departing from the substrate doc (tracked per phase)

MVP cuts captured against their landing phase, not as flat "deferred to next iteration" items.

| # | Substrate doc says | P0 / P1 behavior | Lands in |
|---|---|---|---|
| 1 | Lance index for `byEmbedding` | P2: `byEmbedding` routes through Lance when an `Embedder` is wired; falls back to empty when not (legacy P0/P1 behavior preserved) | P2 — done |
| 2 | Context providers (D5a) | P4: `provider:user-config` / `provider:code-kg` / `provider:active-session` are first-class, registered, slot-routable; `source.kind: 'provider'` stamping enforced by the registry. Per-skill consumption opt-in. | P4 — done |
| 3 | Async indexer + queue (D15) | P3: trigger queue serializes concurrent fires; bootstrap still caller-driven (no auto-fire from registration) | P3 — done |
| 4 | Context builder DAG (D15) | P3: Kahn-level topo-sort + Tarjan cycle detection + skip-dependents-on-failure; serial-within-level (parallel-within-level deferred to `parallelSafe` flag) | P3 — done |
| 5 | User-assertion classifier (D6) | P5: three-layer pipeline (Layer 1 heuristic in-substrate; Layer 2 LLM + Layer 3 user-confirm hooks injectable); runtime.classifyAssertion is the entry point | P5 — done |
| 6 | Feedback bus + fan-out (D8) | P5: in-process global-serial dispatch (parallel-cross-target deferred to `parallelSafe` flag); per-target ordering preserved; subscribe via skill `applyFeedback`. D14 assertion routing wires into the same bus. | P5 — done |
| 7 | Two-level hex sharding | Files land flat under namespace | When entry count approaches ~10k per namespace |
| 8 | Spill policy for >64KB entries | Entries stay inline | When first skill writes a large value |
| 9 | Schema migration (D9) wipe-and-rebootstrap | No migration path; all schemas at `v1` | First `schemaVersion` bump |
| 10 | Crash-resume checkpointing | In-memory working state lost on crash | (Permanent — D12 explicitly defers to agent framework) |

---

## Test fixture: indexed Hadoop repo

Confirmed available; P1 integration tests target this workspace.

| Field | Value |
|---|---|
| Workspace path | `/Users/subhagho/work/projects/insors/hadoop` |
| Status | `ready` (last indexed `2026-05-08`) |
| Workspace kind | `workspace` (per repo registry) |
| Source | `~/.insrc/graph.lmdb` repo-registry rows |
| Helper script | [`scripts/dump-repos.ts`](../../scripts/dump-repos.ts) |

Verified test-target classes (via [`scripts/dump-hadoop-classes.ts`](../../scripts/dump-hadoop-classes.ts) — `findEntitiesByName` against the LMDB graph):

| Class name | Hits | P1 test use |
|---|---|---|
| `NameNode` | 1 | Single-match success path (P1.7 happy-path test) |
| `DataNode` | 1 | Single-match alternative |
| `HdfsServerConstants` | 1 | Likely large field set — graph-walk extraction |
| `FSDirectory` | 1 | Likely large field set |
| `BlockManager` | 1 | Single-match alternative |
| `Configuration` | 2 | **Multi-match ambiguity fixture** (P1.7 ambiguity test) |
| `JobTracker` | 1 | Single-match alternative |

The 2-hit `Configuration` case provides the natural multi-match ambiguity fixture for testing the `found: false, ambiguity: { kind: 'multiple-matches' }` path of `code.class.extract-fields`.

---

## Open implementation questions

Resolved during P0/P1 implementation; captured here for visibility.

- **Workspace identity for tests.** Hadoop's workspace-id (hash of repo path) differs from a test harness's. Tests can run in-process and pin the workspace-id manually; substrate file paths key off `(workspace, owner, namespace, key)` so tests use the Hadoop workspace-id directly.
- **Daemon process boundary.** Substrate primitives live inside the daemon. Tests invoke the substrate's primitives directly from in-process tests (no daemon spawn); existing skill registration runs synchronously at test setup.
- **Schema versioning of memory entries.** All schemas start at `v1`. Confirmed no existing daemon-internal "context schema version" concept to collide with.
- **In-process test cleanup.** Each test must create + tear down its own substrate file root (e.g., `/tmp/insrc-substrate-test-<hash>/`) so tests don't pollute the daemon's actual memory store at `~/.insrc/context/`.
