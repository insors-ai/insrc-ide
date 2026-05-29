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
| **P3** | Async indexer + queue + context-builder DAG (D15) | Bootstrap moves off the registration hot path; multi-builder skill migrations become possible. | deferred (future) |
| **P4** | Context providers (D5a) | `provider:active-session`, `provider:code-kg`, `provider:user-config` flow into context slots. | done |
| **P5** | Feedback bus + user-assertion classifier (D6, D8, D14) | User assertions land via the classifier; downstream consumers' `applyFeedback` fires. | deferred (future) |
| **P6+** | Remaining skill migrations + L2 framework | Per [`plans/agentic-skills-architecture.md`](../agentic-skills-architecture.md) + [`plans/code-analyzer-migration.md`](../code-analyzer-migration.md). | deferred (future) |

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
| P1.2 | Sync lifecycle runner | done | [`lifecycle-runner.ts`](../../src/insrc/daemon/substrate/lifecycle-runner.ts); `fireTrigger` dispatches matching builders sequentially. |
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

### P4 done criteria — verified

- [x] All P4 components compile clean.
- [x] P4 unit tests pass (13/13).
- [x] No regressions across the substrate + skills suites.
- [x] Skills without provider slots are unaffected (provider routing is `fromOwner`-prefix opt-in).
- [x] Status table updated; decision row D5a marked landed.

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

## Decisions departing from the substrate doc (tracked per phase)

MVP cuts captured against their landing phase, not as flat "deferred to next iteration" items.

| # | Substrate doc says | P0 / P1 behavior | Lands in |
|---|---|---|---|
| 1 | Lance index for `byEmbedding` | P2: `byEmbedding` routes through Lance when an `Embedder` is wired; falls back to empty when not (legacy P0/P1 behavior preserved) | P2 — done |
| 2 | Context providers (D5a) | P4: `provider:user-config` / `provider:code-kg` / `provider:active-session` are first-class, registered, slot-routable; `source.kind: 'provider'` stamping enforced by the registry. Per-skill consumption opt-in. | P4 — done |
| 3 | Async indexer + queue (D15) | `bootstrap` runs synchronously at registration | P3 |
| 4 | Context builder DAG (D15) | Single-builder skill migrations only; no topological ordering | P3 |
| 5 | User-assertion classifier (D6) | User assertions enter via direct test writes to `class-aliases` namespace | P5 |
| 6 | Feedback bus + fan-out (D8) | `applyFeedback` hook registered but never fired | P5 |
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
