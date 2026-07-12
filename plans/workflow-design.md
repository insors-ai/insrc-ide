# `design` workflow — HLD + LLD

Plan doc. Status: **design proposal**. Parent: [`plans/meta-workflow-framework.md`](meta-workflow-framework.md). Sibling: [`plans/workflow-define.md`](workflow-define.md).

`design` produces design artifacts at two altitudes matching the
industry-standard **HLD** (High-Level Design) / **LLD** (Low-Level
Design) split, mapped 1:1 to the Epic / Story hierarchy `define`
established:

- **`design.epic` (HLD)** — one per Epic. Establishes the
  framework: architectural choices, shared contracts, cross-Story
  concerns (data flow, error propagation, observability),
  non-functional properties, and Story boundaries (what each
  Story owns vs what's shared).

- **`design.story` (LLD)** — one per Story. Fills in the
  detailed design WITHIN the framework HLD established: the
  Story's specific API, data model changes, algorithm choices,
  error paths, test strategy, and — for `enhancement`-flavor
  Epics — the migration steps.

Both modes are instances of the same fine-grained recipe (meta
doc §3.10). They share the synthesizer scaffolding + a common
`alternatives → judge → detail` pattern; they differ in scope, in
which analyze bundles they lean on, and in what their artifact
sections contain.

## 1. Motivation

Without an HLD, each Story invents its own framework choices. Two
Stories that need to talk to each other end up with incompatible
approaches, and the incompatibility surfaces during `build` when
it's expensive to fix. Without an LLD, `plan` can't produce Tasks
that name concrete surfaces — Tasks become vague ("add filter
support") instead of grounded ("add `filter: TagFilter | null`
parameter to `queryTodos` in `services/todos.ts` and its four
callers listed at LLD §3.2").

Splitting `design` into HLD + LLD forces the framework decisions
to happen once, be reviewed once, and constrain every subsequent
Story-level design that flows from them. It also matches how
engineering teams already write design docs — architecture
review boards read HLDs; individual engineers write LLDs against
their team's HLD.

## 2. Scope

### `design` IS

Both modes share:

- The place where **alternatives are enumerated + judged** against
  the constraints inherited from `define`. Decisions are cited to
  their rationale.
- The place where the **chosen approach is written out** in enough
  detail that `plan` can produce concrete Tasks against it.
- The place where **rollout / migration steps** are sketched (HLD
  covers the whole Epic; LLD covers just this Story's slice).

### `design` IS NOT (scope-boundary HARD RULE)

- **Never breaks scope from `define`.** If the design proposes
  meeting an unstated goal or ignores a stated constraint, that's
  a back-flow signal to `define`, not a design decision.
- **Never enumerates tasks.** No implementation ordering, no
  granular file-by-file changes. That's `plan`. Design lists WHAT
  to build and WHY; plan lists HOW to sequence the building.
- **Never writes code.** Contracts + data models are typed
  interfaces or schemas; no function bodies, no algorithms
  implemented (only chosen + described).
- **Never invents context.** Every design decision must cite the
  Epic constraint or `analyze` bundle it's satisfying / working
  around.

## 3. The two modes at a glance

| Aspect | `design.epic` (HLD) | `design.story` (LLD) |
| :--- | :--- | :--- |
| Input | Whole Epic + all Stories | ONE Story + approved HLD + Epic |
| Analyze focuses | Structural-map on repo/subsystem, capability-discovery on the domain, `import.graph` for the modules the Epic touches | Symbol-locate on named APIs from HLD's contracts, data-model.trace on Story's entities, usage.example on any callers the Story reshapes, `search.text` on distinctive constants |
| Alternatives dimension | Frameworks / patterns / integration approaches | Contract shapes / data models / error strategies |
| Artifact focus | Cross-Story choices, shared contracts, non-functional targets, Story boundaries, rollout overview | This Story's detailed API, data model changes, error paths, test strategy, migration |
| Gate before | Approved Epic | Approved HLD + approved Epic |
| Runs concurrently with | (nothing) — HLD is single-instance per Epic | Other LLDs (one per Story), once HLD is approved |
| Feeds into | Every LLD; also `plan` reads it for cross-cutting context | `plan` for this Story; `test` for verification-strategy inheritance |

## 4. Interface

### 4.1 HLD input

```typescript
interface HldIntent {
    workflow:  'design.epic';
    epicSlug:  string;                       // must match an approved Define artifact
    reasoning: string;
    priorHldRunId?: string;                  // set when re-running after back-flow
    backFlowNotes?: string;                  // human-authored redirect (if re-run)
}
```

### 4.2 LLD input

```typescript
interface LldIntent {
    workflow:  'design.story';
    epicSlug:  string;
    storyId:   string;                       // must be a story id in the Epic
    reasoning: string;
    priorLldRunId?: string;
    backFlowNotes?: string;
}
```

### 4.3 Output

HLD → `docs/designs/<epic-slug>/_hld.md` + `.json`.
LLD → `docs/designs/<epic-slug>/<story-id>.md` + `.json`.

Underscore prefix on `_hld` keeps the HLD visually distinct from
Story LLDs in a directory listing. See §8 for the full storage
layout.

## 5. Recipes

Both modes are fine-grained (§3.10 in meta). They share step
names for the common phases; the parameters + prompts differ.

### 5.1 HLD recipe

```
s1: context.assemble      [deterministic + analyze]   whole-Epic landscape
s2: alternatives.enumerate [LLM]                       2-4 framework choices
s3: alternatives.judge    [LLM]                       score against Epic constraints
s4: framework.write       [LLM]                       chosen framework + shared contracts + Story boundaries
s5: rollout.overview      [LLM]                       phases / migrations / feature flags at Epic scope
s6: checklist.verify      [LLM, forced]               HLD-specific checklist (§9)
```

Six steps. `framework.write` is the biggest — it writes the
chosen framework AND the shared contracts AND the Story
boundaries in one turn because those three are tightly coupled
(you can't describe a shared contract without saying which Story
owns it).

### 5.2 LLD recipe

```
s1: context.assemble       [deterministic + analyze]  Story-focused landscape + HLD extract
s2: alternatives.enumerate  [LLM]                     2-4 contract / data-model shapes
s3: alternatives.judge     [LLM]                      score against Story constraints + HLD
s4: contract.detail        [LLM]                      Story API + data model
s5: error.paths            [LLM]                      error handling + edge cases
s6: test.strategy          [LLM]                      test types + coverage plan for this Story
s7: migration.write        [LLM, conditional]         migration steps (enhancement flavor only)
s8: checklist.verify       [LLM, forced]              LLD-specific checklist (§9)
```

Eight steps but each is small. `migration.write` runs only when
the Epic's `flavor = 'enhancement'`. For `new-capability` Epics
s7 is skipped and there's no migration section in the artifact.

## 6. Step details

### 6.1 s1 `context.assemble` (deterministic + analyze)

Both modes gather context before the LLM sees anything.

**HLD:**

- Reads the approved Epic artifact (all Stories, constraints,
  flavor).
- Fires analyze bundles at the WHOLE-EPIC scope:
  - `structural-map` on the target subsystem (or repo root if
    Epic is workspace-wide).
  - `capability-discovery` on the Epic problem (last chance to
    catch "we're rebuilding something we already have").
  - `import.graph` on the modules the Epic touches — helps HLD
    decide where new modules land relative to existing dep-graph
    hotspots.
  - `convention.detect` on the parent module — HLD's framework
    choices should follow existing conventions unless it
    justifies departing.
  - `manifests.locate` when Epic has an infra dimension.
- If `priorHldRunId` is set: reads the prior HLD + back-flow
  notes.

**LLD:**

- Reads the approved Epic + approved HLD + the specific Story.
- Extracts a **HLD context slice**: which shared contracts THIS
  Story touches, which Story boundaries THIS Story sits within,
  which framework choices apply to it. Not verbatim HLD — a
  filtered projection.
- Fires analyze bundles at the STORY scope:
  - `symbol.locate` on any API names the HLD's shared contracts
    reference (LLD needs to know exact current signatures if
    those APIs already exist).
  - `data-model.trace` on domain entities the Story touches.
  - `usage.example` on functions the Story reshapes.
  - `search.text` on distinctive constants or string literals the
    Story deals with.
  - `test.locate` on the Story's subject — LLD's test strategy
    should extend existing test patterns.

Emits `HldContext` or `LldContext` — typed but similar in shape
(list of prior refs, analyze bundles, back-flow notes).

### 6.2 s2 / s3 `alternatives.enumerate` + `alternatives.judge`

Same pattern in both modes; different dimension of alternatives.

- **s2** enumerates 2-4 alternatives. Schema requires each
  alternative to have: `name`, `oneLineSummary`, `approach`
  (~2 paragraphs), `pros[]`, `cons[]`, `costEstimate`
  (`XS|S|M|L`), `assumptionsRelied` (list of assumption ids from
  Epic + confidence they hold).
- **s3** judges alternatives against constraints. Schema requires
  each judgment to have: `alternativeId`, `constraintScore`
  (per-constraint verdict), `winnerRank`, `rationale`. Framework
  cross-checks that every Epic (or Story) constraint appears in
  every alternative's judgment.

The `alternativesConsidered` section in the artifact preserves
the losers verbatim + why they lost. Auditability > brevity —
future readers should be able to see why the chosen path won.

### 6.3 HLD s4 `framework.write` (LLM)

Reads s1 + s2 + s3. Writes the chosen framework in one LLM turn:

```typescript
{
    frameworkSummary: string;               // one paragraph
    architectureShape: string;              // 2-4 paragraphs
    sharedContracts: {
        id:              string;            // 'sc1', 'sc2', ...
        name:            string;            // e.g. "TaskRegistry API"
        purpose:         string;
        interfaceSketch: string;            // TS interface or schema, TYPE-LEVEL only
        ownedByStory:    string;            // story id -- which Story implements it
        consumedByStories: string[];        // story ids that call it
        assumptions:     string[];          // ids from Epic
    }[];
    storyBoundaries: {
        storyId:  string;
        owns:     string[];                 // shared contract ids
        depends:  string[];                 // shared contract ids consumed
        internal: string;                   // paragraph -- what's private to this Story
    }[];
    nonFunctional: {
        performance?:  string;
        security?:     string;
        observability?:string;
        durability?:   string;
    };
}
```

`interfaceSketch` is TYPE-LEVEL only — TypeScript interface, JSON
schema, or protobuf definition. No function bodies. The
scope-boundary check rejects it if the sketch contains statements
that look like implementation.

### 6.4 HLD s5 `rollout.overview` (LLM)

Reads everything upstream. Writes:

```typescript
{
    phases: {
        name:          string;              // e.g. "Phase A -- foundational contracts"
        includesStories: string[];          // story ids landing in this phase
        rationale:     string;
        backwardCompat: string;             // '' if none needed
        featureFlag:   string | null;       // flag name or null
    }[];
    orderingRationale: string;              // why phases go in this order
    riskyBits: {
        area:       string;
        why:        string;
        mitigation: string;
    }[];
}
```

Framework verifies that every Story appears in exactly one phase.

### 6.5 LLD s4 `contract.detail` (LLM)

Reads s1 + HLD context slice + s2 + s3. Writes:

```typescript
{
    surfaceLevel: 'internal' | 'internal-shared' | 'public';
    api: {                                   // if the Story owns / extends a public API
        name:         string;                // exact identifier the code will use
        signature:    string;                // TypeScript signature or equivalent
        parameters:   {name: string; type: string; purpose: string; optional: boolean}[];
        returns:      {type: string; meaning: string};
        errors:       {type: string; condition: string}[];
        preconditions:  string[];
        postconditions: string[];
    }[];
    dataModel: {
        entity:   string;
        change:   'new' | 'field-add' | 'field-modify' | 'field-remove' | 'invariant-change';
        details:  string;                    // paragraph
        schemaDiff?: string;                 // if applicable, e.g. Prisma diff
        callSites:   string[];               // functions that touch this entity (from analyze bundles)
    }[];
    interactionWithShared: {
        contractId:  string;                 // sharedContract id from HLD
        role:        'implements' | 'consumes';
        howDetails:  string;                 // how THIS Story implements or uses it
    }[];
}
```

Every named API here comes from either s1's analyze bundles
(existing APIs the Story reshapes) or HLD's `sharedContracts`
(APIs the Story owns / consumes as part of the Epic framework).
Invented names are a citation-grounding violation.

### 6.6 LLD s5 `error.paths` (LLM)

Writes:

```typescript
{
    errorCases: {
        scenario:    string;
        detection:   string;                 // how the code notices
        response:    string;                 // what it does
        userImpact:  string;
        recoverable: boolean;
    }[];
    edgeCases: {
        input:    string;
        expected: string;
    }[];
    invariantsToPreserve: {
        text:   string;
        source: Citation;                    // where the invariant is asserted today
    }[];
}
```

For `enhancement` flavor Epics, `invariantsToPreserve` is
particularly load-bearing — it names the current-behaviour
invariants the Story is NOT allowed to break, cited to the
analyze bundles from HLD s1.

### 6.7 LLD s6 `test.strategy` (LLM)

Writes:

```typescript
{
    testLevels: {
        level:      'unit' | 'integration' | 'live' | 'smoke' | 'contract';
        purpose:    string;
        subjects:   string[];                // specific functions / flows to test
        fixturesNeeded?: string[];
    }[];
    acceptanceMapping: {
        criterionId:   string;               // from Epic's acceptance criteria for THIS Story
        provingTests:  string[];             // test level + subject that will prove it
    }[];
    testFramework: string;                   // detected from convention.detect in s1
}
```

The `acceptanceMapping` section is what `test` reads to know
which flows to exercise. Every Story acceptance criterion must
map to at least one proving test; unmatched criteria go into
`openQuestions`.

### 6.8 LLD s7 `migration.write` (LLM, conditional)

Runs only when Epic `flavor = 'enhancement'`. Writes:

```typescript
{
    stateBefore:   string;                  // paragraph -- current behaviour cited to analyze bundles
    stateAfter:    string;                  // paragraph -- post-Story behaviour
    migrationSteps: {
        order:   number;
        action:  string;                    // e.g. "add nullable field", "backfill", "flip default"
        rollbackable: boolean;
        prerequisiteFlags?: string[];
    }[];
    backwardCompat: string;                 // how existing callers keep working
    zeroDowntime:   boolean;
    dataRewriteRequired: boolean;
}
```

For `new-capability` Epics this step is skipped and the artifact
has no `migration` section.

### 6.9 s6/s8 `checklist.verify` (LLM, forced)

HLD's checklist: §9.1. LLD's checklist: §9.2. Both use the same
`{itemId, verdict, evidence, notes?}` result schema. Same rules
on `missed | ambiguous`: scope-boundary items are hard-fail;
others become `openQuestions`.

## 7. Artifact schemas

### 7.1 HLD artifact

```typescript
interface HldArtifact {
    workflow:  'design.epic';
    epicSlug:  string;

    system:  string;
    focus:   string;
    summary: string;

    body: {
        frameworkSummary:   string;
        architectureShape:  string;
        sharedContracts:    SharedContract[];
        storyBoundaries:    StoryBoundary[];
        nonFunctional:      NonFunctional;
        rolloutOverview:    RolloutOverview;
        alternativesConsidered: Alternative[];     // losers preserved
        chosenAlternative:  string;                // id
    };

    citations:     Citation[];
    openQuestions: string[];

    handoff: {
        // Every LLD reads this. Plan reads this too for cross-cutting context.
        frameworkSummary:  string;
        sharedContracts:   SharedContract[];
        storyBoundaries:   StoryBoundary[];
        rolloutOverview:   RolloutOverview;
    };

    meta: {
        workflow:          'design.epic';
        epicSlug:          string;
        runId:             string;
        model:             string;
        toolCalls:         number;
        elapsedMs:         number;
        repoLastIndexedAt: number;
        priorHldRunId?:    string;
        approvedAt?:       string;
        tracker?: TrackerMeta;
        schemaVersion:     1;
    };
}
```

### 7.2 LLD artifact

```typescript
interface LldArtifact {
    workflow:  'design.story';
    epicSlug:  string;
    storyId:   string;

    system:  string;
    focus:   string;
    summary: string;

    body: {
        hldContextSlice:      HldContextSlice;     // which HLD parts this Story leans on
        contractDetails:      ContractDetails;
        dataModelChanges:     DataModelChange[];
        interactionWithShared: SharedInteraction[];
        errorPaths:           ErrorPaths;
        testStrategy:         TestStrategy;
        migration?:           Migration;           // enhancement flavor only
        alternativesConsidered: Alternative[];
        chosenAlternative:    string;
    };

    citations:     Citation[];
    openQuestions: string[];

    handoff: {
        // Plan reads this to enumerate Tasks. Test reads this for
        // the acceptance mapping and error paths.
        contractDetails:  ContractDetails;
        dataModelChanges: DataModelChange[];
        errorPaths:       ErrorPaths;
        testStrategy:     TestStrategy;
        migration?:       Migration;
    };

    meta: {
        workflow:          'design.story';
        epicSlug:          string;
        storyId:           string;
        hldRunId:          string;                 // pins which HLD this LLD is anchored to
        runId:             string;
        model:             string;
        toolCalls:         number;
        elapsedMs:         number;
        repoLastIndexedAt: number;
        priorLldRunId?:    string;
        approvedAt?:       string;
        tracker?:          TrackerMeta;
        schemaVersion:     1;
    };
}
```

`hldRunId` in meta is load-bearing: if HLD is re-approved after
back-flow, existing LLDs whose `hldRunId` doesn't match the new
HLD run are marked **stale** on next `insrc workflow status` and
must be re-run before plan can consume them.

## 8. Storage layout

```
docs/designs/<epic-slug>/
├── _hld.md              # HLD, human-readable
├── _hld.json            # canonical HLD
├── _hld-runs/
│   └── <runId>.jsonl    # per-run log
├── s1.md                # LLD for Story s1
├── s1.json
├── s1-runs/
│   └── <runId>.jsonl
├── s2.md
├── s2.json
└── ...
```

Underscore prefix on `_hld` sorts it first in listings and
signals it's the umbrella. Every LLD file is named after its
Story id (`s1`, `s2`, ... — same ids the Epic uses).

## 9. Verification checklists

### 9.1 HLD checklist (s6)

| ID | Item |
| :--- | :--- |
| `f1` | Does `frameworkSummary` describe the CHOSEN approach, not competing options? |
| `f2` | Does `architectureShape` cite an analyze bundle from s1 for every module it names? |
| `sc1` | Does every `sharedContract` have a story that OWNS it? |
| `sc2` | Every consumer story listed in `consumedByStories` must actually depend on the owning Story per the Epic's `dependsOn` graph, OR the Epic's dependency graph needs an added edge (surfaced as an `openQuestion`). |
| `sc3` | Every `interfaceSketch` is TYPE-LEVEL only (no function bodies, no algorithms). |
| `sb1` | Do `storyBoundaries` cover every Story in the Epic (no orphans)? |
| `sb2` | Does every Story boundary list exactly one owner Story per shared contract it references? |
| `nf1` | Does at least one non-functional property have a specific target (not "fast", but "P50 < 100ms")? |
| `ro1` | Does `rolloutOverview` place every Story in exactly one phase? |
| `ro2` | Does the phase order respect Story `dependsOn` edges? |
| `alt1` | Are 2-4 alternatives considered? |
| `alt2` | Is every alternative scored against every Epic constraint? |
| `alt3` | Is the chosen alternative's rationale grounded in the constraint scores (not vibes)? |
| `sbdry1` | **[HARD]** No implementation (function bodies, algorithm code) anywhere in the artifact. |
| `sbdry2` | **[HARD]** No invented paths / references not in a step output. |
| `sbdry3` | **[HARD]** No task enumeration (that's `plan`). |
| `sbdry4` | **[HARD]** No goal or constraint that isn't in the approved Epic (back-flow instead). |

### 9.2 LLD checklist (s8)

| ID | Item |
| :--- | :--- |
| `cd1` | Does every `api[].signature` reference either an existing symbol (cited to analyze) or a shared contract from HLD? No invented APIs. |
| `cd2` | Are all `api[].parameters` typed (no `any` / `unknown` unless explicitly justified)? |
| `cd3` | Does every `api[].errors` entry have a concrete error type? |
| `dm1` | Does every `dataModel[].callSites` entry come from an analyze bundle in s1? |
| `dm2` | For `enhancement` flavor: every field-modify or invariant-change cites the current-behaviour invariant it might break. |
| `int1` | Every `interactionWithShared` entry references a real `sharedContract.id` from HLD. |
| `int2` | Every shared contract the LLD claims to `implement` matches HLD's `ownedByStory` for this Story. |
| `ep1` | Are `errorCases` distinct from `edgeCases`? |
| `ep2` | Does every `errorCases[].detection` describe HOW code notices (not "the caller passes bad data")? |
| `ep3` | For `enhancement`: every `invariantsToPreserve` is cited to an analyze bundle showing the invariant. |
| `ts1` | Every acceptance criterion for this Story has at least one entry in `acceptanceMapping.provingTests`. |
| `ts2` | `testFramework` matches what `convention.detect` in s1 reported. |
| `mg1` | (enhancement only) Every migration step names whether it's rollbackable. |
| `mg2` | (enhancement only) `backwardCompat` is non-empty for any change that affects an existing public API. |
| `alt1` | Are 2-4 alternatives considered? |
| `alt2` | Is every alternative scored against every Story + Epic constraint AND against the HLD's shared contracts? |
| `sbdry1` | **[HARD]** No implementation body anywhere. |
| `sbdry2` | **[HARD]** No task enumeration. |
| `sbdry3` | **[HARD]** No design decision that contradicts the HLD (back-flow HLD instead). |
| `sbdry4` | **[HARD]** No invented references. |

## 10. Interaction

### 10.1 Gates

- HLD requires **approved Epic**. Refuses if the Epic artifact
  meta has no `approvedAt`.
- LLD requires **approved HLD + approved Epic**. Records the
  HLD's runId in its meta as `hldRunId`.

### 10.2 Approval / rejection

```
insrc workflow approve docs/designs/<epic-slug>/_hld.md
insrc workflow approve docs/designs/<epic-slug>/<story-id>.md
```

Rejection: same as `define`. Downstream (plan / build / test)
treats an unapproved / rejected artifact as absent.

### 10.3 Back-flow

- LLD → HLD: LLD discovers HLD was wrong. The framework marks all
  LLDs anchored to the current HLD as **potentially stale** (they
  might be OK, but the human should re-verify). HLD re-runs with
  `backFlowNotes`.
- LLD → Epic: LLD discovers the Story was framed wrong. Emits a
  back-flow signal targeting `define`. HLD stays; Epic (and
  possibly other Stories) may need to be re-run.
- HLD → Epic: HLD discovers the Epic's constraints or Story
  boundaries were wrong. Back-flow to `define`; all in-progress
  LLDs are invalidated.

### 10.4 Concurrent LLDs

Once HLD is approved, multiple LLDs can run in parallel (one per
Story). Each records its `hldRunId` so future HLD changes can be
detected. LLD runs never contend on the same file — each writes
to `<story-id>.md`.

### 10.5 Tracker integration

Extends the tracker adapter (meta doc §7.4). After an HLD is
approved, the framework can post its summary as a comment on the
Epic issue. After an LLD is approved, its summary posts to the
Story issue. Design docs don't get their OWN tracker issue —
they attach to the Epic / Story issue the tracker push in
`define` already created.

```
insrc workflow post <path-to-design-artifact> --tracker github
```

Read-only from tracker to artifact stays out-of-scope for design
(status of a design doesn't map cleanly to tracker fields).

## 11. Non-negotiables

Same set as `define`. Emphasising two here because they matter
more for design:

- **Alternatives are load-bearing.** Never skip s2 / s3 to save
  turns. The `alternativesConsidered` section is what makes
  design auditable — future readers should be able to see the
  losers + why.
- **HLD is one per Epic; LLD is one per Story.** No "combined HLD
  for a family of Epics"; no "per-Task LLD". Match the Epic /
  Story boundaries strictly.

## 12. What we are NOT doing (yet)

- **Not shipping a HLD-first-review dashboard.** Approval is
  per-artifact via CLI + MCP tool call.
- **Not auto-invalidating LLDs when HLD is re-approved.** Marked
  as stale but not deleted; human decides which to re-run.
- **Not supporting multi-Epic HLDs.** If two Epics share a
  framework decision, each Epic's HLD documents it independently
  (cited to the shared context if needed).
- **Not shipping design-review LLM personas.** The synthesizer +
  s3 judge suffice for now; a "critical reviewer" second-pass is
  a follow-up.
- **Not integrating with existing ARBs / design docs already in
  the repo.** Future work — a `design.import <path>` command that
  ingests an existing markdown design as if it had been produced
  here, so downstream workflows can consume it.

## 13. Open questions

- **How does the LLD detect that its HLD is stale?** Comparing
  `hldRunId` to HLD's current `runId` is straightforward at
  status-check time, but during an active `plan` or `build`, a
  stale LLD could silently mislead. Do we hard-block downstream
  workflows on stale detection, or warn? Current lean: hard-block.
- **When multiple LLDs disagree on how to consume a shared
  contract, who wins?** The one that landed first — HLD's shared
  contract is a fixed target, LLDs consume it as-is. If an LLD
  wants to change the contract, back-flow to HLD.
- **Do we produce a "combined design" markdown for humans who
  want the whole Epic at once?** Nice-to-have; deferred. Could
  be a `insrc workflow render <epic-slug>` command that
  concatenates HLD + all LLDs into one document.
- **How do we handle the case where a new Story is ADDED to an
  approved Epic (post-back-flow)?** The existing HLD may not
  cover it; the new Story's LLD may need an HLD refresh. Current
  lean: any new Story triggers an HLD re-run.
- **What's the format for `nonFunctional` targets — free-text or
  a typed schema?** Typed would let `test` verify them
  mechanically. Deferred until `test` needs it.
