# Code-analyzer migration onto substrate + agentic-skills

**Status:** draft (2026-05-29)
**Owner:** subhagho@gmail.com
**Standing position:** the code-analyzer is the priority migration target for the substrate + agentic-skills framework. Its pipeline has more surface area, more prompts, more grounding-pingpong, and more hallucination failure modes than the data-analyzer. The same L1-substrate-consumer + L2-agentic-skill model applies; the migration sequence and concrete pieces are code-analyzer-specific.

**This doc depends on:**
- [`plans/memory-context-substrate.md`](plans/memory-context-substrate.md) — the memory/context/working-state framework (D1–D15 + D5a).
- [`plans/agentic-skills-architecture.md`](plans/agentic-skills-architecture.md) — the L1/L2 skill model (A1–A6).

This doc applies those to the code-analyzer specifically: which L1 skills to migrate, which context builders the indexer runs, which assertion subjects matter for code work, which L2 skill is the pilot, and the phasing.

## Why the code-analyzer is higher priority than the data-analyzer

The substrate + L2 design was motivated by data-analyzer failures (the GRN run). But the code-analyzer is the larger problem:

1. **More prompts.** [`prompts/sections/`](src/insrc/agent/tasks/code-analyzer/prompts/sections/) + [`prompts/flow/`](src/insrc/agent/tasks/code-analyzer/prompts/flow/) hold ~40 prompt files. Each is a place where a prompt-engineered example bleeds into model behavior (the HDFS-path hallucination we just fixed was one of these).
2. **More LLM round-trips per question.** The code-analyzer pipeline runs discovery → discovery-review → planner → execute-step → write-from-evidence → claim-grounding-reviewer → review-action → meta-narrative-detector. Each section iterates the writer + grounding loop. Total LLM calls per analysis: typically 50+.
3. **Deeper structural knowledge available.** The code KG (entities + relations + traversal + entity-vec) is already a rich indexed substrate. The code-analyzer leaves much of it on the table; bootstrap-time context builders could pre-warm what each skill needs.
4. **Higher hallucination surface.** Citations are file paths + line ranges. Inventing a plausible-looking citation is much easier in the code domain than in the data domain (where "schema-derived facts" are concrete). The writer reaches for credible-sounding paths.
5. **30 code-* skills** ([`daemon/skills/built-ins/code.*.ts`](src/insrc/daemon/skills/built-ins/)) are heavyweight LLM-touching capabilities. Most are stateless; bootstrap caching + alias learning would substantially compound.
6. **User assertions matter more.** Coding style rules, naming conventions, test frameworks, dependency policies — these are exactly what user assertions are for. The code-analyzer is where users naturally state "do not use `hasattr`" or "we use vitest."

## Current pipeline (one-page survey)

```
User question
   │
   ▼
intent resolver (resolveIntent)               ← agent/intent/resolver.ts
   │
   ▼
chat-handler → code-analyzer orchestrator    ← daemon/controllers/code-analyzer-orchestrator.ts
   │
   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Discovery loop                                                  │
│  - planner-discovery (LLM-driven, tool-calling)                  │
│  - discovery-review                                              │
│  - verify-planned-actions (entity probe + vector fallback)       │
│                                                                   │
│  Produces: a Plan with N actions (one per section to write)      │
└──────────────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Plan-actions (content-gen/plan-actions.ts)                      │
│  - LLM picks actions per scope tier                              │
│  - Action = { id, title, objective, reviewCriteria, budget }     │
└──────────────────────────────────────────────────────────────────┘
   │
   ▼
For each action (in topological order):
   │
   ├─▶ execute-step                          ← agent/tasks/code-analyzer/execute-step.ts
   │   - skills-pipeline: code.meta.classify-question → code.meta.select-scope
   │   - dispatch L1 skills via tool calls (code.entity.* / code.source.* / ...)
   │   - skill results → evidence ledger (this analysis only)
   │
   ├─▶ write-from-evidence                   ← agent/tasks/code-analyzer/write-from-evidence.ts
   │   - LLM writer, given objective + reviewCriteria + evidence
   │   - emits markdown
   │
   ├─▶ claim-grounding-reviewer              ← agent/tasks/code-analyzer/claim-grounding-reviewer.ts
   │   - LLM reviewer, structured verdict (accept | needs-work + workItems)
   │   - if needs-work: refinement loop (1-3 iterations)
   │
   └─▶ meta-narrative-detector
       - catches "as an AI..." style drift
```

Resulting report: stitched markdown of N sections + drill-down.

## Specific failure modes (from observed runs)

1. **Citation hallucination.** Writer reaches for `path:hadoop-hdfs/.../HdfsServerConstants.java#L42-L58` (or similar plausible-but-not-real paths) when its evidence is thin. We just patched the prompt examples; the deeper fix is the writer being an L2 skill that self-grounds against its own evidence ledger before emitting.
2. **Empty-evidence acceptance.** Refinement loop runs out, grounding-reviewer eventually accepts an "honest empty" stance ("the evidence ledger contains no entries for this directory"). Useless final report.
3. **Prompt-example bleed.** The writer's system prompt teaches URI shape via concrete examples. The model treats examples as priors. (HDFS purge done; risk pattern remains.)
4. **Discovery-loop empty-tool-calls exhaustion.** planner-discovery exhausts its turn cap because the LLM emits empty tool-call rounds. Pipeline degrades silently.
5. **Stateless skill calls.** `code.entity.locate-by-name` runs against the entity-vec index every time. `code.source.module.describe` re-parses + re-summarizes per call. Both could warm from bootstrap.
6. **30+ LLM calls per analysis.** Most are the meta + write + review cycles. With L2 self-grounding, this drops by an order of magnitude.
7. **No learning across sessions.** A user correcting "no, the test framework here is vitest" doesn't carry to the next session. With Type 4 user assertions (D6 + D14), it does.

The substrate + L2 model addresses all seven by design.

## Mapping current pipeline onto substrate + L2

| Current piece | Substrate / L2 equivalent |
|---|---|
| Discovery flow + planner-discovery loop | Becomes part of the pilot L2 skill's internal planning step. Same idea (LLM picks evidence buckets); now within one budgeted execution, not a separate orchestrator phase. |
| plan-actions | Stays as a planner; emits an `Action[]` plan. Each Action becomes one L2 skill invocation, with the action's `objective` + `reviewCriteria` flowing in as `invocationContext.goal` + `invocationContext.reviewCriteria` (A2 + A5). |
| code.meta.classify-question | Evolved per A5 to emit `goal: string` per candidate. Stays as an L1 helper. |
| code.meta.select-scope | Demoted to L1 arg-filler utility per A5. Called by the L2 runtime to fill L1 skill args when the L2 hasn't computed them. |
| Per-section execute-step | Becomes the L2 skill's body. classify + select + dispatch + reflect + draft all happen inside one logical execution with a single budget. |
| write-from-evidence (per section) | Subsumed into the L2 skill's `draft` step. Self-grounding (A1) replaces the separate grounding-reviewer pingpong. |
| claim-grounding-reviewer | Becomes belt-and-suspenders. The L2 skill's self-grounding runs first. The external reviewer becomes a sanity check, not the load-bearing error catch. |
| meta-narrative-detector | Stays — same idea, same scope. Can be invoked from the L2 self-grounding step. |
| cycle-memory | Per-execution working state ledger handles this; no separate primitive. |
| summarize-result | Stays — orchestrator-level summary still useful. |
| Evidence ledger (analysis-scoped) | Becomes the substrate's working state ledger (per-execution). Pinned entries distill to memory per D3. |
| Prior-facts injection (turn-based memory) | Continues via existing intent-resolver + classifier memory; substrate-assembled context slots provide an additional channel for slow-changing context. |

## Code-analyzer-specific context builders (Type 1)

Built at indexing time by the substrate's lifecycle runner; DAG-ordered (D15). Each becomes a memory namespace under `skill:<id>` or the indexer's own owner.

| Builder | Output | Triggered by | DependsOn |
|---|---|---|---|
| `language-detection` | per-file language tag | repo-add, reindex | (none) |
| `manifest-parse` | dependency manifests (package.json, go.mod, etc.) | repo-add, reindex | (none) |
| `module-summary` | per-module digest (entity count, key types, exports) | repo-add, reindex | `language-detection`, `manifest-parse` |
| `entity-name-index` | name embeddings for fuzzy-match (extends existing entity-vec) | repo-add, reindex, entity-set-change | `language-detection` |
| `module-dependency-graph` | import edges between modules | repo-add, reindex | `module-summary` |
| `cyclic-deps` | detected cycles | repo-add, reindex | `module-dependency-graph` |
| `complexity-metrics` | per-entity complexity scores | repo-add, reindex | `language-detection` |
| `unused-exports` | exported entities with zero in-repo callers | repo-add, reindex | `entity-name-index` |
| `test-framework-detection` | detected framework (vitest/jest/pytest/junit/...) | repo-add, reindex | `manifest-parse` |
| `naming-convention-detection` | tabs/spaces, indent width, naming style | repo-add, reindex | `language-detection` |

Most of these *already exist* as runtime skill calls (`code.quality.cyclic-deps`, `code.quality.complexity`, etc.). Migrating them to bootstrap-time context builders moves the work from per-question latency to indexing latency.

## Code-analyzer-specific assertion routing (D14)

These are the `assertionInterests` worth declaring on code-analyzer skills + their related codegen / refactor / pair-coding skills. Each subject lands as a `kind: constraint` entry per D6/D7.

| Subject | Relevant owners |
|---|---|
| `python-code-style` | codegen.python.*, refactor.python.*, code.review.python |
| `javascript-code-style` | codegen.js.*, refactor.js.*, code.review.js |
| `naming-convention` | codegen.*, refactor.* |
| `test-framework` | codegen.*, code.review.*, test.* |
| `commit-format` | git-ops, pair |
| `error-handling-pattern` | codegen.*, refactor.* |
| `dependency-policy` | codegen.*, refactor.*, code.audit.* |
| `architecture-pattern` | designer, plan |
| `prefer-pattern` | codegen.*, designer |

User asserts "always use vitest" → classifier picks `test-framework` → routes to `codegen.*` and `test.*` owners → future codegen knows the convention.

## Code-analyzer L1 skill migrations (priority order)

Migrating an L1 skill = declaring `ownerId`, `schemaVersion`, `interestedTriggers`, `contextSlots`, `memorySchema`, optionally `contextBuilders` + `assertionInterests` + `applyFeedback`.

| Priority | Skill | Why first |
|---|---|---|
| 1 | `code.entity.locate-by-name` | Most-called skill in the pipeline. Has an existing index (entity-vec); rewiring to substrate context slots is mechanical + big latency win. |
| 2 | `code.source.module.describe` | Heavy LLM work today; full bootstrap to memory (module-summary builder) is high-value. |
| 3 | `code.source.file.describe` | Same story per-file. |
| 4 | `code.meta.classify-question` | Evolve per A5 to emit goals. |
| 5 | `code.meta.select-scope` | Demote to L1 arg-filler utility per A5. |
| 6 | `code.entity.summary` | Cacheable per-entity. |
| 7 | `code.quality.complexity` | Pre-compute at indexing time. |
| 8 | `code.quality.cyclic-deps` | Same. |
| 9 | `code.quality.duplication` | Same. |
| 10 | `code.quality.unused-exports` | Same. |

Skills lower-priority because they're either lower-frequency, can't reasonably precompute (`code.repo.git-status` is always live), or already cached at the tool layer (`code.entity.callers` hits the LMDB graph directly).

## Pilot L2 skill: `code.answer-question`

**Strawman pilot.** Takes a code-domain question + active repo context, plans its own discovery against the code KG + context builders, drafts an answer, self-grounds against its working-state ledger, returns. Mirrors the data-analyzer pilot (`data.answer-question`) in shape.

**Invocation:**
```ts
{
  input: {
    question: string;
    activeRepoPath: string;
    scopeTier?: 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL' | 'XXXXL';
  },
  invocationContext: {
    goal?: string;                  // when called by a planner: per-action goal (A5)
    reviewCriteria?: readonly string[];
    intent?: ResolvedIntent;
    // ... freeform per A2
  }
}
```

**Internal flow:**
1. Plan: identify evidence buckets needed. Consult substrate context slots (module summaries, entity-name index, test-framework detection, etc.).
2. Dispatch L1 sub-calls in batches (warm-hits return from context slots in ms; cold calls run + write back).
3. Reflect: do I have what I need? If not, can more sub-calls help? Or is the gap durable?
4. Draft: emit `value: { sections: [...] }` with explicit gap callouts where evidence is thin.
5. Self-ground: A1 — every claim's citation must resolve to a ledger entry. Drop unsupported claims; don't fabricate paths.
6. Return.

**Alternative pilots worth considering:**
- `code.audit-module` — focused on auditing one module. Narrower scope. Easier to test.
- `code.explain-architecture` — module-tree walk + summarize. Heavy on the planner step.

I'd start with `code.audit-module` if we want a narrower pilot that exercises the substrate + L2 model on a contained surface, then graduate to `code.answer-question` for the full open-ended use case.

## Migration phases

Phase numbering aligns with the agentic-skills doc's migration plan; concrete deliverables are code-analyzer-specific.

**Phase 0 — Substrate primitives ready.** Prerequisite — landed via `plans/memory-context-substrate.md`.

**Phase 1 — Migrate the top-3 code L1 skills.**
- `code.entity.locate-by-name`, `code.source.module.describe`, `code.source.file.describe`.
- Each declares substrate-facing fields + a `contextBuilders` spec.
- Indexer dispatches the relevant builders; bootstrap fills memory.
- Existing pipeline still uses these skills via the old code-path; substrate enrichment is transparent (cache reads).
- Measure: cold-vs-warm per-skill latency, indexing-time inflation, hit rate on context-slot reads.

**Phase 2 — Implement code-analyzer-specific context builders.**
- Implement `language-detection`, `manifest-parse`, `module-summary`, `test-framework-detection`, `naming-convention-detection`.
- DAG dependencies declared per D15.
- Verify Phase 1 skills benefit (warm hits dominate).
- Measure: end-to-end question latency before/after.

**Phase 3 — Migrate `code.meta.classify-question` to emit goals (A5).**
- Output schema gains `goal: string` per candidate.
- Existing pipeline keeps consuming the skill ids; the goals are added without breaking the contract.
- Tests update.

**Phase 4 — Pilot L2 skill `code.audit-module`.**
- Implement the L2 skill body per A1–A4.
- Wire as an opt-in path behind a feature flag.
- Existing per-section pipeline stays as default.
- Use live local-LLM integration tests (A6).
- Measure: tokens per audit, sections with real evidence, citation-hallucination rate. Compare to the legacy pipeline on the same module.

**Phase 5 — Skills act on feedback + user assertions.**
- Implement `applyFeedback` on the migrated L1 skills.
- Implement `assertionInterests` declarations for codegen/refactor skills (D14).
- User assertions land via the substrate's classifier (D6); subsequent runs see them.
- Measure: improvement on questions touching previously-corrected concepts.

**Phase 6 — Replace writer + grounding-review pingpong with L2 self-grounding (CLEAN CUTOVER).**

- `code.answer-question` L2 skill shipped in P9 (2026-06-01).
- This phase wires it into the IDE chat surface and deletes the legacy pipeline. **No feature flag.** The L2 path becomes the only path; the legacy writer + grounding-review code is removed in the same commit.
- Concretely:
  - `runDiscoveryFlow` (the per-section orchestrator entry) is rewritten to call `runL2Skill('code.answer-question', ...)` and stitch its `sections[]` into the section markdown. The cycle / retain-step / prose-redraft machinery is dropped.
  - **Deleted** (no longer reachable, no feature-flag fallback):
    - `agent/tasks/code-analyzer/write-from-evidence.ts` (the writer)
    - `agent/tasks/code-analyzer/claim-grounding-reviewer.ts` (review pingpong)
    - `agent/tasks/code-analyzer/meta-narrative-detector.ts` (folded into L2 grounding)
    - The cycle loop + redraft branches inside `discovery-flow.ts` (the file itself becomes a thin adapter or is deleted in favour of a direct call from the orchestrator).
    - Associated tests + prompt templates (`prompts/code-analyzer/claim-grounding.*`, `prompts/code-analyzer/meta-narrative.*`, etc.).
  - **Folded into the L2 skill** before deletion:
    - meta-narrative regex → optional sanity check inside `code.answer-question`'s grounding step (drop sections whose body matches the patterns AND have only weak ledger anchors). If A1 grounding already covers the failure modes, the meta-narrative check stays deleted.
    - claim-grounding-reviewer's responsibility is fully replaced by the L2 runtime's `validateGrounding` (A1).
- Live integration test for the new orchestrator path on a fixture repo (structural assertions per A6).
- Risk acknowledgement: the discovery-plan-loop's multi-cycle gather-then-write is not reproduced in the L2 skill v1. The first cut is single-pass classify → select → dispatch → draft → ground. Multi-cycle reflect is a follow-up if section quality regresses materially on large modules.

**Phase 7 — Cross-domain L2.**
- Build `data.entity.match-to-class` — the L2 skill we missed during the GRN run. Calls both `data.*` L1 skills and `code.*` L1 skills internally.
- Data-analyzer + code-analyzer can both invoke it.

**Phase 8 — Cleanup.**
- Drop the legacy per-section pipeline.
- Promote L2 path from feature-flagged to default.
- Delete unused code paths.

Each phase is independently shippable + rollback-safe.

## Risks

- **Bootstrap cost.** Repo-add + reindex events trigger many context builders. On large repos (10k+ entities, 1k+ modules), this is non-trivial work. Mitigation: builders run in background per D15; the daemon surfaces "indexing in progress" so the user sees the catching-up state.
- **Loss of fine-grained section authority.** The current per-section pipeline gives explicit control over what each section says. Folding into one L2 skill could blur boundaries. Mitigation: the L2 skill's output schema still emits a `sections` array; section objectives + reviewCriteria flow as `invocationContext` (A2).
- **Pilot scope creep.** `code.audit-module` is narrower than `code.answer-question`; the narrower scope is the point. Resist adding "and also handle other-question-shapes" until the narrow pilot succeeds.
- **Local-model viability for L2.** The data-analyzer run showed qwen3-coder is unreliable for nested tool-call payloads. Likely also unreliable for L2 internal planning prompts. Phase 4 pilot probably needs cloud LLM. Worth flagging that the local-first ethos has a qualifier here.
- **Existing prompt-engineering investment.** [`prompts/sections/*`](src/insrc/agent/tasks/code-analyzer/prompts/sections/) + [`prompts/flow/*`](src/insrc/agent/tasks/code-analyzer/prompts/flow/) hold a lot of accumulated tuning. Migration shouldn't blanket-discard. The L2 skill's planning prompt should borrow heavily from `prompts/flow/discovery-expand` + `prompts/flow/discovery-review`. The L2 skill's draft prompt should borrow from `prompts/flow/write-structured`. Self-grounding logic should borrow from `prompts/sections/anti-hallucination/reviewer.md`.

## What this doc is NOT committing to

- Exact L2 skill input/output schemas (illustrative).
- Whether `code.audit-module` or `code.answer-question` ships first as the pilot (strawman is audit-module).
- Whether the legacy per-section pipeline gets dropped in Phase 7 or kept indefinitely as a fallback.
- The exact context-builder DAG (the table above is the starting set; implementation will refine).
- Performance numbers / target latencies.

Substrate + agentic-skills decisions are locked. This doc applies them to the code-analyzer and sequences the work. Implementation-time questions will surface as they arise.
