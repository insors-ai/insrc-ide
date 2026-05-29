# Substrate implementation status

**Status:** living document (started 2026-05-29)
**Owner:** subhagho@gmail.com
**Purpose:** track what's actually been built versus the locked design in [`plans/memory-context-substrate.md`](../memory-context-substrate.md) and [`plans/agentic-skills-architecture.md`](../agentic-skills-architecture.md). MVP scope captured here; this doc evolves as more of the substrate lands.

This is the only doc that should change shape over time as implementation progresses. The framework + per-skill design docs stay stable; this one tracks state.

## MVP scope (Iteration 0)

Minimum viable slice that supports migrating one real L1 skill (`code.class.extract-fields`) end-to-end with live tests against the indexed Hadoop repo. Validates the framework on real data without burning weeks on full-substrate implementation.

**In scope (MVP):**

- File-backed **memory store** (per the substrate doc's directory layout) with `byKey`, `prefix`, and `filter` queries. No `byEmbedding` yet.
- In-process **working-state ledger** with `append`, `pin`, `list`, `get`, `size`. No checkpoint / restore.
- **Context assembler** with the four query modes, but only memory-source slots — no providers (D5a deferred).
- **Lifecycle runner** that dispatches `bootstrap` synchronously at skill registration time. No async indexing queue, no DAG scheduling.
- **Owner registry** extending the existing skill registry — no new registration mechanism.
- Substrate-facing fields on the existing `Skill<I, O>` interface (`ownerId`, `schemaVersion`, `interestedTriggers`, `contextSlots`, `memorySchema`, optional `applyFeedback`, optional `contextBuilders`).
- **Manual conflict resolution** per D4 default policy (constraint > fact > hint > confidence > recency). No per-namespace merge override yet.
- One migrated skill: **`code.class.extract-fields`** per [`plans/skills/code/code.class.extract-fields.md`](code/code.class.extract-fields.md).
- **Tests** against the indexed Hadoop repo: integration tests hit real LMDB graph + real entity-vec; unit tests use fake tools.

**Explicitly out of scope (Iteration 0 limitations):**

| Component | Reason deferred | Workaround in MVP |
|---|---|---|
| Lance index for `byEmbedding` | Substantial integration with existing Lance code | `byEmbedding` queries return empty; all lookups go via `byKey` / `prefix` |
| Context providers (D5a) | Adds an orthogonal layer; not load-bearing for first skill | Slots that would target providers in the design fall back to inline computation or skip the slot |
| Async indexer + queue | Adds scheduling complexity | `bootstrap` runs synchronously at registration; daemon startup is slower but correct |
| Context builder DAG (D15) | Topological sort + parallelism not needed for one builder | Single-builder skill migrations supported; multi-builder dependencies deferred |
| User-assertion classifier (D6) | Substantial new component | User assertions enter via direct memory writes from chat-handler for now |
| Feedback bus + fan-out (D8) | Best-effort but still needs the wiring | `applyFeedback` hook present but no dispatcher emits to it yet |
| File sharding (`<aa>/<bb>` two-level shard) | Premature for one-skill scope | Files land flat under the namespace; revisit when entry count grows |
| Spill policy for large entries | Not triggered by the first skill | Entries stay inline; revisit when an entry exceeds ~64KB |
| Schema migration (D9) | First version of every schema | No migration path needed yet; revisit on first `schemaVersion` bump |
| Crash-resume checkpointing | D12 explicitly defers to agent framework's checkpoint.ts | In-memory working state lost on crash; acceptable for MVP |
| Cross-owner cold-path reads with allow-list | Not needed for one skill | All reads via declared `contextSlots`; cross-owner declared at registration |

## Component status

Updated as components land. Status values: `not-started` / `in-progress` / `done` / `deferred`.

| Component | Status | Notes |
|---|---|---|
| MVP scope locked | done | This doc. |
| File-backed memory store | not-started | Files under `~/.insrc/context/<workspace>/<owner>/<namespace>/`. |
| Working-state ledger | not-started | In-process Map-backed. |
| Context assembler (memory-only) | not-started | Four query modes minus `byEmbedding`. |
| Lifecycle runner (sync) | not-started | `bootstrap` runs at registration. |
| Skill interface extensions | not-started | Add fields to existing `Skill<I, O>`. |
| `code.class.extract-fields` migration | not-started | Per-skill design at [`code/code.class.extract-fields.md`](code/code.class.extract-fields.md). |
| Hadoop integration tests | not-started | Need to confirm Hadoop repo path + verify it's indexed. |
| Unit tests with fake tools | not-started | Existing skill test harness pattern. |

## Decisions departing from the substrate doc

MVP cuts that depart from the locked substrate design — captured here so we don't forget what we punted on.

| # | MVP behavior | Substrate doc says | Why deferred |
|---|---|---|---|
| 1 | No `byEmbedding` query support | Lance index is canonical for embedding-backed lookups | Lance integration is its own iteration; semantic recall on memory waits |
| 2 | No context providers | First-class read-only sources for context only (D5a) | Orthogonal to memory; one skill doesn't need them |
| 3 | Synchronous bootstrap at registration | Indexer dispatches `BootstrapTrigger` events; async DAG (D15) | Scheduling adds complexity; sync is fine for first skill |
| 4 | Files flat under namespace, no sharding | Two-level hex shard prevents file-count blowup | One skill won't hit the threshold |
| 5 | No `applyFeedback` dispatch | Best-effort fire-and-forget bus (D8) | Feedback bus is its own iteration; hook is present, dispatcher comes later |
| 6 | User assertions enter via direct writes | Classifier (D6) processes chat turns | Classifier is substantial; direct writes unblock the skill |
| 7 | No spill for >64KB entries | Spill to content-addressed file with pointer | First skill's entries are small; revisit when needed |

## Skills migrated so far

| Skill | Status | Notes |
|---|---|---|
| `code.class.extract-fields` | not-started | Per [`code/code.class.extract-fields.md`](code/code.class.extract-fields.md). |

## Next iteration backlog

Beyond MVP, in roughly-prioritized order. Reordered + scoped as we go.

1. **Lance index integration** — enables `byEmbedding` queries. Unlocks semantic recall (class-name fuzzy match, observation similarity, etc.).
2. **Async indexer + queue** — bootstrap moves off the registration hot path; can be done in background. Required before adding the heavy bootstrap builders.
3. **Context builder DAG (D15)** — topo-sort + parallel-within-level execution. Required before multi-builder skill migrations.
4. **User-assertion classifier (D6)** — three-layer pipeline (heuristic → LLM → user-confirm). Required for `kind: constraint` entries to flow from chat.
5. **Feedback bus** — fire-and-forget dispatch to `applyFeedback`. Required for confidence-update feedback loops.
6. **Context providers (D5a)** — `provider:user-config`, `provider:code-kg`, `provider:active-session`. Required when skills need external read-only sources.
7. **File sharding** — `<aa>/<bb>` two-level hex shard. Triggered when a single namespace approaches ~10k entries.
8. **Spill policy** — content-addressed files for >64KB entries. Triggered when first skill writes a large value.
9. **Schema migration (D9 wipe-and-rebootstrap)** — needed at first `schemaVersion` bump.
10. **Subsequent skill migrations** — driven by [`plans/code-analyzer-migration.md`](../code-analyzer-migration.md) priority order (`code.source.module.describe` next, then file describe, then meta-skills).

## Test infrastructure decisions

- **Live tests against the Hadoop repo.** Tests assume Hadoop is already indexed in a known location. CI / dev-machine prerequisite, documented per-test.
- **Local LLM tests** apply only to skills that touch the LLM directly (none in MVP — `code.class.extract-fields` has no LLM call). Live local-LLM coverage starts when L2 skills land.
- **Unit tests stay on the fake-provider / fake-tool pattern.** Substrate primitives get unit tests with in-memory fakes.
- **Integration tests** use real LMDB graph + real Lance (for entity-vec, which exists today even though substrate's own Lance integration is deferred).

## Test fixture: indexed Hadoop repo

Confirmed available; substrate tests should target this workspace.

| Field | Value |
|---|---|
| Workspace path | `/Users/subhagho/work/projects/insors/hadoop` |
| Status | `ready` (last indexed `2026-05-08`) |
| Workspace kind | `workspace` (per repo registry) |
| Source | `~/.insrc/graph.lmdb` repo-registry rows |
| Helper script | [`scripts/dump-repos.ts`](../../scripts/dump-repos.ts) |

Verified test-target classes (via [`scripts/dump-hadoop-classes.ts`](../../scripts/dump-hadoop-classes.ts) — `findEntitiesByName` against the LMDB graph):

| Class name | Hits | Notes |
|---|---|---|
| `NameNode` | 1 | Single-match success path |
| `DataNode` | 1 | Single-match success path |
| `HdfsServerConstants` | 1 | Likely large field set — graph-walk extraction path |
| `FSDirectory` | 1 | Likely large field set |
| `BlockManager` | 1 | Single-match success path |
| `Configuration` | 2 | **Ambiguity test fixture** — hadoop-common vs hadoop-yarn-services |
| `JobTracker` | 1 | Single-match success path |

The 2-hit `Configuration` case provides a natural multi-match ambiguity fixture for testing the `found: false, ambiguity: { kind: 'multiple-matches' }` path of `code.class.extract-fields`.

## Open implementation questions

- **Workspace identity for tests.** Hadoop's workspace-id (hash of repo path) differs from a test harness's. Tests can run in-process and pin the workspace-id manually; substrate file paths key off `(workspace, owner, namespace, key)` so tests just use the Hadoop workspace-id directly.
- **Daemon process boundary.** MVP substrate lives inside the daemon. Tests invoke the substrate's primitives directly from in-process tests (no daemon spawn); existing skill registration runs synchronously at test setup.
- **Schema versioning of memory entries.** MVP starts at `schemaVersion: 1` everywhere. Confirmed no existing daemon-internal "context schema version" concept to collide with.
