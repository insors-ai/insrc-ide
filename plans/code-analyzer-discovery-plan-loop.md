# Discovery-plan loop for the code-analyzer

## Motivation

Phase F validation (run on 2026-05-19 against Hadoop, tier-XL) shipped
the per-tier prompts (`plans/code-analyzer-scope-tier-prompts.md`) and
revealed four structural failure modes the prompt-only fix can't close:

1. **Bimodal gather investigation.** Sections produced 1, 6, 6, 1, 29,
   1, 3, 1 skill calls. Per-tier prompts pushed the floor up (run #6
   was 1, 1, 1) but the variance is huge -- the local LLM still
   decides for itself when to stop.
2. **Off-topic rich-evidence gathers.** §2 (tech-stack) and §7
   (namenode-persistence) ran the section budget to the wall (32 / 32
   iter) but the evidence didn't focus on the section's specific
   topic -- e.g. §7 wrote a gap paragraph from 30 evidence entries
   because none of them covered NameNode persistence specifically.
3. **Recurring arg-shape errors.** `code.source.file.describe` called
   with `path` instead of `file`; `code.source.module.describe`
   called with no args. Documented in skill-glossary, model still
   hallucinates the wrong shape under pressure.
4. **Patch loop doesn't converge.** Reviewer flags 6 items; patch
   addresses 1-2; reviewer flags 6 fresh items in the patched draft.
   §1 of Phase F shipped at low confidence with all 6 fix items
   unaddressed.

The common root cause: the local LLM has too much autonomy in
deciding what to investigate and the cloud has no per-step steering.

This plan rebuilds the per-section loop around a **cloud-driven
discovery plan**: cloud expands each planned section into ordered
multi-skill steps, local executes them as instructed, structured
outputs aggregate into a ledger, cloud reviews and asks for more
discovery if needed (up to 3 cycles), then local writes prose from
the final ledger.

## Decisions (settled via Q&A 2026-05-20)

| # | Decision |
|---|---|
| 1 | Step contains multiple skills; cloud names which + order + context. Local may invoke additional skills if it judges them necessary. |
| 2 | Step output is structured: `{ facts: string[], citations: Citation[] }`. Citation is a structured object (`{ path, startLine?, endLine?, entityId?, label?, repoPath? }`), not a string. |
| 3 | Final write phase: local LLM consumes the retained ledger and emits markdown with inline citations. |
| 4 | Post-cycle: cloud emits `{ keep: stepOutputIds[], new_steps: DiscoveryStep[] }`. Patch loop is REMOVED (no per-item fixes). |
| 5 | Cycle reviewer sees: this cycle's new outputs + `CycleMemory` (not the retained ledger raw entries). Kept items never round-trip back to the LLM. |
| 6 | Discovery loop terminates on `cycle == 3` OR `new_steps` empty. |
| 7 | Final prose review: prose-only. Reviewer doesn't see the ledger. Writer's anti-hallucination contract is the only grounding enforcement. |
| 8 | Per-tier checklist (`coverage-angles/{xl,l,m,s}.md`) drives BOTH the Stage 1 section plan AND the Stage 2 discovery-plan expansion. |
| 9 | Cloud sees skill SUMMARIES; orchestrator injects relevant skill schemas when forwarding the step to the local LLM (so local has authoritative arg shapes at invoke time). |
| 10 | `CycleMemory` shape: `{ priorAsks, criteriaCoverage, scratchpad }`. Stored on per-section orchestrator state. Patterned after `PriorContext` / `summarizePriorContext` (familiar code shape, no LanceDB / no session tags). |

## Architecture

```
                  ╔════════════════════════════════════════════════════╗
                  ║  Per-section discovery loop (max 3 cycles)         ║
                  ╠════════════════════════════════════════════════════╣

   Stage 1: cloud planActions (existing, tier-aware)
            └─► sections: PlannedAction[]
                 │
   ┌───────────► │  for each section:
   │             ▼
   │     Stage 2: cloud expandDiscoveryPlan(section, cycle, cycleMemory)
   │            (per-tier checklist injected; skill summaries in prompt)
   │            └─► discoveryPlan: { steps: DiscoveryStep[] }
   │                 │
   │                 ▼
   │     Stage 3: orchestrator executes each step:
   │            for each step:
   │                local.executeStep(step, schemas)
   │                └─► stepOutput: {
   │                       stepId, status, facts, citations,
   │                       extraSkillsCalled?, durationMs
   │                    }
   │                 │
   │                 ▼
   │     Stage 4: orchestrator aggregates step outputs of THIS cycle
   │            └─► cycleOutputs: StepOutput[]
   │                 │
   │                 ▼
   │     Stage 5: cloud reviewCycle(cycleOutputs, cycleMemory)
   │            └─► { keep: stepIds[], new_steps: [], scratchpad?: string }
   │                 │
   │                 ▼
   │     orchestrator updates:
   │       retainedLedger += stepOutputs[keep]
   │       cycleMemory.priorAsks += new_steps (next cycle's asks)
   │       cycleMemory.criteriaCoverage = recompute from retainedLedger
   │       cycleMemory.scratchpad = cloud's scratchpad (overwrite each cycle)
   │
   │     if new_steps.length == 0 OR cycle == 3 -> exit loop
   └─────└── else loop with new_steps
                 │
                 ▼
         Stage 6: local writeSection(retainedLedger)
                  └─► prose: markdown
                 │
                 ▼
         Stage 7: cloud reviewProse(prose)  // prose-only, no ledger sent
                  └─► verdict: accept | redraft
                 │
                 ▼ (if redraft: one redraft attempt; ship the better one)
         section shipped
                  ╚════════════════════════════════════════════════════╝
```

## Type additions (`agent/content-gen/discovery-plan.ts`)

```typescript
/** A skill invocation the cloud is directing the local LLM to make. */
export interface PlannedSkillCall {
  /** Catalog skill id, e.g. 'code.entity.locate-by-name'. */
  readonly skillId: string;
  /**
   * Semantic context the cloud emits in plain language -- "the NameNode
   * class FSDirectory", "the hadoop-hdfs-project/hadoop-hdfs module".
   * Local LLM resolves to args at invoke time using the schema the
   * orchestrator injects.
   */
  readonly context: string;
  /**
   * Optional id of a prior PlannedSkillCall within the same step whose
   * output feeds this one (e.g. summary depends on locate-by-name
   * emitting an entityId). When set, local executes them in dependency
   * order regardless of array index.
   */
  readonly dependsOn?: string;
  /** Stable local id within the step (cloud-emitted; e.g. "s1.a"). */
  readonly id: string;
}

/** One discovery step -- a multi-skill investigation with one purpose. */
export interface DiscoveryStep {
  readonly id:        string;                    // "step-1", "step-2", ...
  readonly intent:    string;                    // 1-sentence: "investigate NameNode metadata persistence"
  readonly skills:    readonly PlannedSkillCall[];
  /**
   * Which section review criteria this step targets, by index into
   * the section's reviewCriteria array. Used by the orchestrator to
   * compute `CycleMemory.criteriaCoverage` mechanically.
   */
  readonly targetsCriteria: readonly number[];
}

export interface DiscoveryPlan {
  readonly steps:     readonly DiscoveryStep[];
  readonly cycle:     1 | 2 | 3;
}

/** Structured citation, replacing the string-based citation today. */
export interface Citation {
  readonly path:       string;
  readonly startLine?: number;
  readonly endLine?:   number;
  readonly entityId?:  string;          // 32-char hex when from locate-by-name / file.describe
  readonly label?:     string;          // class / function name; writer styles as `label`
  readonly repoPath?:  string;          // workspace root, for multi-repo runs
}

/** Output of executing one step. Replaces today's EvidenceEntry per step. */
export interface StepOutput {
  readonly stepId:      string;
  readonly status:      'ok' | 'partial' | 'failed';   // partial = some skills returned empty
  readonly facts:       readonly string[];
  readonly citations:   readonly Citation[];
  /** Skills the local LLM added beyond the cloud's plan (if any). */
  readonly extraSkillsCalled?: readonly string[];
  readonly durationMs:  number;
}

/** Cloud reviewer's response after seeing this cycle's outputs. */
export interface CycleReviewResponse {
  /** Ids of step outputs the cloud judged on-topic + useful -- promoted to ledger. */
  readonly keep:         readonly string[];
  /** Steps the cloud wants executed next cycle (empty = terminate). */
  readonly new_steps:    readonly DiscoveryStep[];
  /** Cloud's free-form note carried forward (~300 chars). Optional. */
  readonly scratchpad?:  string;
}

/** Cycle memory carried across cycles, on per-section orchestrator state. */
export interface CycleMemory {
  readonly priorAsks: readonly {
    readonly cycle:            1 | 2 | 3;
    readonly steps:            readonly { readonly id: string; readonly intent: string }[];
  }[];
  readonly criteriaCoverage: readonly {
    readonly criterion:     string;
    readonly status:        'covered' | 'partial' | 'open';
    readonly contributingStepIds: readonly string[];
  }[];
  readonly scratchpad: string;
}
```

## Module layout

```
src/insrc/agent/content-gen/
  discovery-plan.ts                  ← types + the cloud-side expand/review entrypoints
  discovery-plan-prompts.ts          ← prompt assembly (calls into prompts/loader)
  __tests__/
    discovery-plan.test.ts
    cycle-memory.test.ts

src/insrc/agent/tasks/code-analyzer/
  execute-step.ts                    ← local-side step executor (replaces gather-evidence in the new flow)
  cycle-memory.ts                    ← CycleMemory helpers (summarize / coverage compute)
  __tests__/
    execute-step.test.ts

src/insrc/agent/tasks/code-analyzer/prompts/
  flow/
    discovery-expand/system.md       ← cloud Stage 2 prompt
    discovery-review/system.md       ← cloud Stage 5 prompt
    execute-step/system.md           ← local Stage 3 prompt (per step)
    prose-review/system.md           ← cloud Stage 7 prompt (prose-only)
  sections/
    skill-catalog-cloud.md           ← cloud-facing skill summaries (NEW)
    step-output-format.md            ← anti-hall rules for step output (NEW; reuses citation-rules)
    cycle-memory-format.md           ← how to read the CycleMemory block (NEW)
    (existing) coverage-angles/{xl,l,m,s}.md  ← reused unchanged
    (existing) compliance.md, error-catalog.md, gap-paragraph-template.md, citation-rules.md
```

## Stage details

### Stage 1: section plan (unchanged)

`planActions` with the existing `planner-context/{tier}.md` injection.
Output: sections with `{ id, title, objective, reviewCriteria }`.

### Stage 2: discovery-plan expansion (NEW)

Cloud call per section. Input:
- Section's `{ title, objective, reviewCriteria }`
- Repo summary (same as Stage 1)
- Tier checklist (`coverage-angles/{tier}.md`)
- Cloud-facing skill catalog (`skill-catalog-cloud.md` — summaries only)
- `cycleMemory` (empty for cycle 1; populated for cycle 2+)
- Cycle number

Output: `DiscoveryPlan` (structured JSON via responseFormat schema).

Cloud is instructed: emit 2-10 steps; each step has 1-5 skills with
context; for cycle 2+, target criteria with `status: open` first.

### Stage 3: per-step local execution (NEW)

Orchestrator iterates the discovery plan. For each step:
- Inject the SCHEMAS for the specific skills the cloud named
  (orchestrator reads them from the registry at execute time, so
  local LLM has authoritative arg shapes).
- Prompt local LLM with the step's intent + skill list + context.
- Local LLM emits `skill_invoke` calls, executes any extras it
  decides are needed.
- After execution: local LLM emits structured `StepOutput`
  (responseFormat schema), with facts + structured citations.

Local executes deterministically per step (no "decide when to stop"
loop; the step ends when local has emitted output).

### Stage 4: aggregation (mechanical)

`stepOutputs` = list of StepOutput from cycle N's execution.
No LLM call; orchestrator just collects.

### Stage 5: cycle review (NEW)

Cloud call. Input:
- This cycle's `stepOutputs` (raw)
- `cycleMemory` (formatted via `summarizeCycleMemory`)
- Section context (title, objective, criteria)

Output: `CycleReviewResponse`.

Orchestrator updates state:
- `retainedLedger += stepOutputs.filter(o => o.stepId in keep)`
- `cycleMemory.priorAsks.push({ cycle, steps: new_steps.map(idIntent) })`
- `cycleMemory.criteriaCoverage = computeCoverage(retainedLedger, section.reviewCriteria)`
  (mechanical: for each criterion, find step outputs whose
  `targetsCriteria` includes its index; status = ok/partial/open)
- `cycleMemory.scratchpad = response.scratchpad ?? cycleMemory.scratchpad`

If `new_steps.length === 0 || cycle === 3`: exit loop.

### Stage 6: write (existing, lightly rewired)

Local LLM call. Input:
- Section objective + criteria
- `retainedLedger` (the kept step outputs)
- Existing writer system prompt (compliance + anti-hall/writer +
  citation-rules + error-catalog + gap-paragraph-template +
  output-format/write)

Output: section markdown with inline citations rendered from
structured Citation objects.

### Stage 7: prose review (NEW; lighter than today's reviewAction)

Cloud call. Input: section prose only.
Output: `{ verdict: 'accept' | 'redraft', notes?: string[] }`.

If `redraft`: ONE re-write call (same input as Stage 6 plus the
reviewer's notes), then pick the better draft via the existing
heuristic (citation density tiebreaker).

## Skill catalog presentation to cloud

`sections/skill-catalog-cloud.md` (NEW, ~3KB):
- Group skills by family (source-introspection, etc.)
- For each: id + one-line summary + "needs: <what context to provide>"
- Example entries:
  ```
  - `code.source.repo.describe` -- list top-level modules sorted by file count.
    Needs: nothing (uses session repo).
  - `code.source.module.describe` -- summarise a module (directory of source files).
    Needs: the module's path or name.
  - `code.entity.locate-by-name` -- find entities matching an exact name.
    Needs: the entity name; optionally a kinds filter (class / function / ...).
  - `code.entity.summary` -- read an entity's body + metadata.
    Needs: an entityId from a prior locate-by-name or file.describe.
  - `code.entity.callers` -- entities that call the target.
    Needs: an entityId.
  ```
- Standard chains documented (Chain A name-known, Chain B
  module-down — same content as `skill-glossary.md` reframed for
  cloud audience).

This is INFORMATIONAL for the cloud. The orchestrator handles arg
shapes at execute time — cloud just picks skills + provides context.

## Migration

Removed (deprecated by the new flow):
- `agent/tasks/code-analyzer/gather-evidence.ts` (replaced by `execute-step.ts`)
- `agent/tasks/code-analyzer/write-section.ts patchSectionItemwise`
  + `patchSectionWithTools` (no patch loop)
- `agent/tasks/code-analyzer/pick-best-draft.ts` (no rounds to pick between -- only one drafted section)
- `agent/content-gen/review-action.ts WorkItemKind` + most of `validateReview`
  (review changes from item-list to cycle-review shape)
- Prompt files:
  - `flow/patch/{fix,add}/system.md`
  - `sections/role-patch-{fix,add}.md`
  - `sections/output-format/patch-{fix,add}.md`
  - `sections/coverage-angles-patch/{xl,l,m,s}.md`
  - `sections/error-catalog.md` ← kept (writer + reviewer still use it)
  - `sections/gap-paragraph-template.md` ← kept (writer still uses it)
  - `sections/anti-hallucination/patch.md` ← removed (no patch flow)

Retained:
- `agent/tasks/code-analyzer/write-from-evidence.ts` writeSectionFromEvidence
  → drives Stage 6; consumes the new structured-citation ledger
  format (small refactor: render `[label](path:file#L1-L20)` from
  Citation object, not the string-keyed evidence today)
- `agent/content-gen/plan-actions.ts` planActions → drives Stage 1 unchanged
- `prompts/loader.ts` → unchanged, used by all new prompt files
- Tier-aware infrastructure (Phase D) → unchanged

## Migration phases

1. **Phase α — types + helpers** (no behaviour change). Define
   `DiscoveryStep`, `Citation`, `StepOutput`, `CycleReviewResponse`,
   `CycleMemory`. Implement `summarizeCycleMemory`, `computeCoverage`.
   Tests: ~15 unit tests.

2. **Phase β — execute-step** (new module, not wired). Implement
   `executeStep(step, schemas, provider, session)` that runs the
   local LLM in step-execution mode (single LLM call per step, with
   the cloud-named skills available + skill schemas injected) and
   emits a `StepOutput`. Tests via fake provider: ~10 tests.

3. **Phase γ — discovery-plan expand + review** (new cloud calls,
   not wired). Implement `expandDiscoveryPlan(input)` and
   `reviewCycle(input)` calling Anthropic with the new prompts +
   structured-output schemas. Tests via fake provider: ~12 tests.

4. **Phase δ — orchestrator wiring** behind feature flag
   `INSRC_ANALYZER_FLOW = 'discovery'` (default still `gather-write`).
   Implement `runDiscoveryFlow(action)`: cycles 1-3, ledger
   retention, terminal write + prose review. Tests: 4-5 integration
   tests via fake providers covering happy path + each termination
   condition + redraft.

5. **Phase ε — Citation struct migration**. Switch
   `writeSectionFromEvidence` to consume structured Citation
   objects. Snapshot tests update.

6. **Phase ζ — empirical validation** at scale. Same Hadoop
   tier-XL run as Phase F. Compare:
   - Sections at low / medium / high confidence
   - Soft-stop rate (now should be 0 -- cloud sets the step count)
   - Invalid-input rate (now should be near 0 -- cloud only picks
     well-formed skills)
   - Wall-clock vs Phase F (cloud calls go up; local convergence
     should be faster per section)
   - Token-cost vs Phase F (with the caching changes already
     landed, cloud cost dominates)

7. **Phase η — cleanup**. Delete deprecated files (patch loop +
   pick-best-draft + redundant prompt MDs). Update README +
   `prompts/README.md`.

## Test strategy

- **Type-level tests** for `CycleMemory` and `computeCoverage` (15
  unit tests). Catches structural drift; cheap to run.
- **execute-step unit tests** via fake provider: 10 tests covering
  happy path, partial step (skill returned empty), failed step
  (skill threw), local-LLM-emitted-extra-skills, schema mismatch.
- **discovery-plan tests** via fake provider: 12 tests covering
  cycle-1 expand, cycle-2 expand with cycleMemory, review with
  keep+new_steps, review with keep-only (termination), review
  schema-violation path.
- **Integration tests** with three fake providers (cloud planner,
  local executor, cloud reviewer): 5 tests covering full
  discovery-flow happy path, cycle-3 termination, early
  termination on empty new_steps, redraft path, all-rounds-low
  fallback.
- **Snapshot tests** for the four new flow prompts
  (discovery-expand / discovery-review / execute-step /
  prose-review) per tier where applicable.

## Risks + open notes

- **Cloud cost.** Cycle = 1 cloud call (expand) + N local calls (one
  per step) + 1 cloud call (review). For 12 sections × 3 cycles +
  prose review × 12 + Stage 1 planner ≈ 84 cloud calls vs run #6's
  ~12. Token caching (already landed) softens this; the bigger
  payload is the per-cycle review (sees raw step outputs ≈ ~4KB
  each × N steps).
- **Local LLM step-execution failure modes.** If local refuses to
  invoke any skill, or invokes them with bad args, the step fails.
  Need a tight retry policy per step (1 retry max).
- **Convergence floor.** Even with cloud steering, the local LLM
  might emit weak `StepOutput`s. The retained ledger might still
  be thin. The cycle reviewer + new_steps pattern is the safety
  net.
- **Schema drift on responseFormat.** Both `DiscoveryPlan` and
  `CycleReviewResponse` are JSON-Schema-pinned. Reviewer's
  existing `correctiveSuggestion` retry pattern (`review-action.ts`)
  should be reused for both new cloud calls.
- **Feature flag fence.** `INSRC_ANALYZER_FLOW=discovery` gates the
  new path. The old gather-write flow stays the default until ζ
  validation passes.

## Out of scope

- Data-analyzer adopting the same flow (separate effort).
- Pre-execution skill chaining (e.g. plan a single step that runs
  locate-by-name THEN immediately summary on the result without a
  round-trip to local LLM). Would speed things up but complicates
  the step shape.
- A fourth cycle / dynamic max-cycles. Hard cap = 3 for this plan.
