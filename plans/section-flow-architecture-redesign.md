# Section-flow architecture redesign

## Status

Draft — written 2026-06-10, no code yet. Plan is the contract; phases
land one at a time with validation gates between them.

## Motivation

Seven live runs of the GRN-vs-INGRN section-flow investigation
(commits `883eaaf66e0` through `d07f070aa75`) exposed three structural
fault lines that no amount of prompt-tuning or skill-catalog
expansion will close:

1. **Local-tier context exhaustion.** qwen3.6 at numCtx 16k holds the
   system prompt + skill catalog + prior outputs + the actual task
   in a single buffer. The 6th run hit shapeMemory's chunked
   map-reduce path at 17,361 tokens because the working-memory
   bundle alone exceeded the local window. Every subsequent step
   fights for token headroom.

2. **Plan-first orchestration brittle to mid-investigation
   information.** Today the cloud emits a full discovery plan for the
   cycle (Stage 1), the orchestrator iterates it leaf-by-leaf, then
   the cycle reviewer judges in bulk (Stage 3). When a step's output
   invalidates downstream steps -- e.g. `code.entity.summary` returns
   empty because the planner didn't realise locate-by-name had to
   run first -- the cycle reviewer is the *only* feedback channel,
   and it operates one cycle late. The 5th-7th runs saw
   `extract-ingrn-fields` recycle into L2 fallback because three
   cycles of pre-baked steps couldn't adapt to the locate failure
   in step 1.

3. **Hardcoded caps were a control-flow shortcut, not a correctness
   guarantee.** The 3-cycle × 5-step × 6-skill × 1-recycle caps were
   tuned for the original synchronous-cloud loop; under load they
   trigger L2 fallback before the investigation has any real chance
   of converging. Removing the caps without a different
   convergence signal would blow indefinitely; adding any cap forces
   us back into "the budget ran out, fallback to L2" rather than "we
   reached a real conclusion."

## Design principle: correctness over cost

The user is explicit: correctness matters more than per-run token /
latency cost. Where today's flow chose plan-first batching to amortise
cloud calls, the redesigned flow chooses step-at-a-time interaction
because the cloud sees each result before committing the next step.
Where today's local LLM swallowed an oversized context, the
redesigned flow paginates memory through a persistent artifact store
so the local LLM sees only what it explicitly asked for.

Concrete consequence: per-TODO cloud-call count goes up (estimated
3-5× from today's 6-8). That's accepted. Per-TODO latency goes up
proportionally. That's accepted. What we get back is the ability to
ground every step in the actual outputs of prior steps -- not a
summarisation of them -- and a planner that can see and respond to
each individual failure.

## Testing strategy

Two test tiers, both required for every phase that introduces or
modifies an LLM-interacting component:

**Tier A: unit tests with mocked providers (fast, deterministic, CI-default).**

Today's pattern: a scripted `LLMProvider` returns a fixed sequence of
canned responses. These exist to verify code paths -- branching,
schema validation, error handling, plumbing between modules -- and
they MUST stay because they're the only way to drive CI in under a
minute. Every phase keeps its existing unit tests and adds new ones
for new code paths.

**Tier B: real-Ollama integration tests (slow, opt-in, gates merge).**

The redesign is fundamentally about how the local LLM behaves under
real constraints: tight context window, qwen3.6's tool-arg
fabrication patterns, the recency-weighted attention quirks the
hardened shape-resolver had to work around. Mocked providers can't
reproduce any of that. Every PromptWriter introduced in this redesign
ships with at least one integration test that:

  - Hits `localhost:11434` against `qwen3.6:35b-a3b` (the production
    local model).
  - Uses `temperature: 0` + a fixed seed for reproducibility -- same
    model + same prompt + same seed yields the same tokens, so
    failures aren't flakes.
  - Asserts STRUCTURAL properties of the output (valid JSON shape,
    valid artifact ids referenced, action discriminator within the
    allowed enum, closure markers conform to the fixed vocabulary)
    rather than exact-match strings. Real LLMs phrase things
    differently; the contract is the shape, not the wording.
  - Uses fixture artifact stores + TOCs derived from REAL prior live
    runs (the GRN investigation's outputs become the fixture corpus
    -- "given THIS TOC and THIS gap list, does decide-next-step pick
    a sane next action?").

Opt-in: tests gated on `process.env.INSRC_TEST_OLLAMA === '1'` AND
a startup probe to `localhost:11434` confirming the target model is
loaded. Skip cleanly when either fails -- no false failures in
environments without Ollama. New npm script: `npm run test:ollama`.

**What integration tests catch that unit tests cannot:**

  - Whether the prompt actually elicits the structured output we want
    from the real model. The 5th-7th GRN runs all surfaced prompt
    issues unit tests never flagged because the mocked provider
    just returned whatever the scripted-response array said.
  - Whether the local model can find a specific artifact id in a
    realistically-sized TOC. (Phase 1: critical -- the TOC IS the
    interface to the artifact store.)
  - Whether build-context (Phase 3) actually picks the right
    artifacts to fetch, or omits the fetch when nothing relevant
    exists. The omission case is the one mocked tests can't
    distinguish from a degenerate "always emit []" prompt.
  - Whether decide-next-step (Phase 4) actually terminates when the
    TOC shows full coverage vs scheduling redundant steps. This
    behaviour is entirely emergent from the prompt + the model.
  - Whether goal-aware summary generation (Phase 1, consolidated
    into review/decide) actually produces closure markers in the
    fixed vocabulary, or invents adjacent variants.

**Fixture corpus.**

Carved from the 5th-7th live runs by replaying their daemon logs:

  - `fixtures/grn-locate-ingrn/` -- the TOC + gap list at the
    moment TODO 2's locate-by-name returned the real entityId.
    Used to validate Phase 3's build-context (does it fetch the
    artifact containing the hex id?) and Phase 4's decide-next-step
    (does it schedule extract-fields next?).
  - `fixtures/grn-classfields-fabrication/` -- the TOC + gap list at
    the moment qwen3.6 was fabricating classFields from JSON keys.
    Used to validate the hardened shape-resolver still refuses to
    fabricate AND the new build-context fetches the
    code.class.extract-fields artifact when it exists.
  - `fixtures/grn-l2-trigger/` -- the TOC + gap list one step before
    TODO 1 exhausted into L2 fallback. Used to validate that with
    `shared.fs.list-files` now in the catalog (which it wasn't in
    runs 5-7), the dynamic flow's decide-next-step schedules it
    instead of cycling.

The corpus grows over time: every regression-worthy live-run scenario
becomes a fixture. Fixtures are checked in as JSON files (TOC + gap
list + expected structural assertions); the actual LLM responses
are not pinned because they vary.

**Snapshot updates.**

If real-Ollama tests produce a structurally-valid output that doesn't
match the existing assertions, the developer must explicitly update
the assertions with a CHANGELOG entry on the relevant PromptWriter's
version. No silent snapshot rewrites. Snapshot drift is the kind of
quiet regression we cannot tolerate.

Each phase's "Tests" subsection below uses `(unit)` / `(integration)`
tags to flag which tier each test belongs to.

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│  Per-TODO orchestrator loop                                  │
│                                                              │
│  ┌──────────────────────┐                                    │
│  │  Stage 0: fact-gap   │   (unchanged from today)            │
│  │  analysis (cloud)    │                                    │
│  └──────────┬───────────┘                                    │
│             ▼                                                │
│  ┌──────────────────────┐                                    │
│  │  Stage 1: sketch     │   (cloud emits N-step sketch +      │
│  │  (cloud)             │    a convergence predicate)         │
│  └──────────┬───────────┘                                    │
│             ▼                                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Step loop (no fixed cap; convergence-driven)         │   │
│  │                                                      │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │   │
│  │  │ Decide   │->│ Build    │->│ Shape    │           │   │
│  │  │ next     │  │ context  │  │ resolve  │           │   │
│  │  │ step     │  │ (local)  │  │ (local)  │           │   │
│  │  │ (cloud)  │  └──────────┘  └────┬─────┘           │   │
│  │  └─▲────────┘                     ▼                 │   │
│  │    │                       ┌──────────┐             │   │
│  │    │                       │ Execute  │             │   │
│  │    │                       │ skill    │             │   │
│  │    │                       └────┬─────┘             │   │
│  │    │              ┌─────────────▼───────┐           │   │
│  │    └──────────────│ Persist + TOC entry │           │   │
│  │                   └─────────────────────┘           │   │
│  │                                                      │   │
│  │  Convergence check on every iteration:               │   │
│  │    - all fact gaps closed       → terminate          │   │
│  │    - N consecutive no-progress  → terminate          │   │
│  │    - hard ceiling (safety net)  → escalate cloud     │   │
│  └──────────────────────────────────────────────────────┘   │
│             │                                                │
│             ▼                                                │
│  ┌──────────────────────┐                                    │
│  │  Stage 6: synthesis  │   (unchanged; reads artifact       │
│  │  (cloud)             │    store via TOC + selective       │
│  └──────────────────────┘    fetch)                          │
└──────────────────────────────────────────────────────────────┘
```

## Phases

Seven phases, each independently shippable behind a feature flag
(`INSRC_SECTION_FLOW_MODE` env: `static` keeps today's behaviour,
`dynamic` opts into the new architecture). Phase 0 is the foundation
the rest builds on (PromptWriter abstraction). Phases 1-3 are
preconditions for Phase 4 (the orchestrator rewrite). Phase 5
finishes the convergence story. Phase 6 is continuous prompt work,
made tractable by Phase 0.

### Phase 0: PromptWriter abstraction

Every prompt in section-flow today is hand-rolled string
concatenation buried inside its step module: `buildMessages` in
shape-resolve, `buildUserPrompt` in step-fact-gap-analysis,
`buildPlanExpansionPrompt` in step-discovery-plan-expansion, and so
on. Each is custom; each one is a refactor's worth of risk to touch;
there is no way to:

  - Run two versions of a prompt side by side.
  - Roll back a prompt change without a code revert.
  - Diff "what prompt did this run actually send" across days.
  - A/B-test a new prompt against the established one.
  - Reuse common blocks (TOC rendering, schema rendering, anti-
    fabrication rules) across prompts without copy-paste.

Phase 6 (continuous prompt rework) is fundamentally a maintenance
exercise on top of the PromptWriter interface. Without it, Phase 6
is "edit a function in step-X.ts and pray." With it, prompts become
first-class versioned objects.

**Surface:**

```ts
// Each prompt is a typed builder, registered at startup.
interface PromptWriter<TInput, TOutput = readonly LLMMessage[]> {
  readonly id:       string;             // stable id, e.g. "shape-resolver"
  readonly version:  number;             // bumped on incompatible changes
  readonly tier:     'local' | 'cloud';  // routes provider selection
  readonly summary:  string;             // one-line "what this prompt does"

  build(input: TInput): TOutput;

  // Optional: typed response schema when the call expects JSON / tool_use.
  readonly responseFormat?: JSONSchema | undefined;
}

interface PromptRegistry {
  register<TInput, TOutput>(writer: PromptWriter<TInput, TOutput>): void;
  // Resolve by id. The registry honours version pinning when the orchestrator
  // requests a specific version; default is `latest`.
  get<TInput, TOutput>(id: string, version?: number): PromptWriter<TInput, TOutput>;
  // For telemetry / debugging.
  list(filter?: { tier?: 'local' | 'cloud' }): readonly PromptWriterMetadata[];
}

interface PromptWriterMetadata {
  readonly id:      string;
  readonly version: number;
  readonly tier:    'local' | 'cloud';
  readonly summary: string;
}
```

**Versioning rules:**

- Backwards-compatible additions (a new optional output field, a
  reworded instruction line that doesn't change behaviour) -> same
  version.
- Breaking changes (input shape change, output schema change, a
  semantic instruction rewrite) -> bump version. The old version
  STAYS registered until callers have migrated.
- The orchestrator pins versions in config so a fresh prompt
  experiment doesn't silently roll out:
  ```
  promptVersions:
    shape-resolver:   2
    decide-next-step: 1
    sketch:           latest    # opt-in to the moving edge
  ```
- A `PROMPT_VERSION_LOG` artifact persists alongside the run's
  artifact store: which writer id ran at which version for every
  cloud / local call. Trivial post-hoc reconstruction.

**Composition helpers (the reuse story):**

Common blocks become standalone functions that writers compose:

```ts
// Reusable across writers.
const tocBlock        = renderToc(input.toc, { maxTokens: 6000 });
const factGapsBlock   = renderFactGaps(input.factGaps);
const schemaBlock     = renderSkillSchema(input.skill);
const antiFabBlock    = renderAntiFabricationRules();    // already shipped in
                                                          // commit e4f8ca7e41b
```

Each writer's `build` method composes these. Today's giant inline
strings shrink to 20-line composers; the actual prompt content lives
in small, individually-testable rendering functions.

**Implementation strategy:**

1. Define the `PromptWriter` / `PromptRegistry` interfaces in a new
   module (`src/insrc/agent/prompts/`).
2. Migrate ONE existing prompt as the pilot -- shape-resolver is the
   right choice because it's already isolated and well-tested.
3. After the pilot validates, migrate the rest one by one:
   `fact-gap-analysis`, `discovery-plan-expansion`, `cycle-review`,
   `section-review`, `section-synth`, `working-memory-shape`,
   `bullet-extractor`. Each migration is a pure refactor: same
   strings, same behaviour, different call-site shape. Tests pin the
   string-equivalent output of the new writer against the old
   `buildMessages` helper to catch behaviour drift.
4. Once all today's prompts are migrated, future prompts (sketch,
   decide-next-step, build-context per Phases 3-5) are PromptWriters
   from day one.

**Tests:**

- (unit) Registry round-trip: register, get by id, get by id+version,
  list with filter.
- (unit) Version routing: register v1 and v2; pinning to v1 returns
  v1; default returns v2.
- (unit) Telemetry: invoke writer; PROMPT_VERSION_LOG entry captures
  id+version.
- (unit) Per-writer migration tests: assert each migrated writer
  produces the SAME message array as today's hand-rolled
  `buildMessages` helper for a fixed input. Locks the migration as
  behaviour-preserving.
- (integration) For each migrated writer, run the produced messages
  against real Ollama (when tier='local') or the cloud sandbox (when
  tier='cloud') and assert the response satisfies the existing
  `responseFormat` schema. Catches the case where a migrated writer
  changes whitespace or block order in a way that breaks the model's
  output, which the string-equivalence test cannot detect.

**Validation gate:** the existing static-mode flow runs end-to-end
using migrated PromptWriters and produces a report indistinguishable
from before the migration. Same prompts, just better plumbed.

### Phase 1: Physical artifact store + TOC

The first and load-bearing change. Every skill output gets persisted
to disk and exposed to LLMs through a 128-token summary in the
Table-of-Contents block, NOT inline in priorOutputs.

**Disk layout:**

```
~/.insrc/tmp/<sessionUuid>/artifacts/
  <runId>/
    <todoSlug>/
      <stepId>/
        <skillCallId>.payload.json   # raw skill output, full
        <skillCallId>.meta.json      # metadata + summary
```

**Artifact record:**

```ts
interface Artifact {
  readonly id:             string;     // "art-<8-char-hex>", short for prompts
  readonly summary:        string;     // 128 tokens, claim-shaped (see below)
  readonly mimeType:       'application/json' | 'text/plain' | 'text/markdown';
  readonly sizeBytes:      number;
  readonly createdAt:      number;
  readonly todoId:         string;
  readonly stepId:         string;
  readonly skillCallId:    string;
  readonly skillId:        string;
  readonly payloadPath:    string;
}
```

**Claim-shaped, goal-aware summary -- the load-bearing detail.**

The summary is the ONLY way the LLM decides whether to fetch the full
artifact AND the primary signal the orchestrator reads to detect
convergence (see Phase 5). A topic-shaped summary ("file listing data")
is useless. A claim-shaped summary names what the artifact concretely
contains. A goal-aware summary ALSO names which gap facts the artifact
serves -- so the TOC functions as a coverage map, not just a content
index.

  - WRONG (topic): `"List of files in a directory"`
  - WRONG (content but goal-blind): `"25 JSON file paths under test/integration/data/BB/GRN"`
  - RIGHT: `"25 JSON file paths under test/integration/data/BB/GRN; first 3: 176050.json, 176055.json, 176060.json; CLOSES gap 'enumerate-grn-json-fixtures' fully"`
  - RIGHT: `"INGRN class at insors/core/model/invoice/regions/IN/grn.py:40-207; entityId b2097ef0...8442; 21 declared fields including vendor (required INPartyDetails), buyer (Optional), items (Optional[List[INGRNItem]]); CLOSES 'ingrn-fields' fully; PARTIALLY supports 'json-to-class-mapping'"`

The closure suffix uses a small fixed vocabulary so the orchestrator
can mechanically scan it: `CLOSES gap-X fully`, `PARTIALLY supports
gap-X`, or absent if the artifact has no relevance to the active gap
list. The reviewer/decider that emits the summary already knows the
gap list (it sees the same context); annotating is cheap for it and
extremely valuable downstream.

**Where summary generation happens -- folded into the next cloud
turn, NOT a separate call.**

Today's flow ALREADY runs `summarizeResult` as a cloud call per step
([step-discovery-execute.ts:139](src/insrc/agent/section-flow/step-discovery-execute.ts#L139)).
The redesign eliminates that dedicated call and folds summary
emission into the next cloud reviewer/decider turn that was going to
run anyway:

  - **Static mode (during Phases 1-3 rollout):** the cycle reviewer
    sees the raw skill outputs from this cycle's N steps in its
    prompt (replacing the pre-summarised `EvidenceEntry` block) and
    emits `stepSummaries: { stepId: claim-shaped-with-closure-marker }`
    as a new field in its response, alongside its existing
    `keep` / `new_steps` / `scratchpad` fields.
  - **Dynamic mode (Phase 4 onward):** `decide-next-step` sees the
    single just-completed step's raw output and emits
    `lastStepArtifactSummary: string` in its response.

Net effect on cloud call count per cycle: today's `N × summarize +
1 × review = N + 1` calls collapses to `1` call (review-with-
summaries). For N=5 that's 6 → 1, a 5× reduction in cloud round-trips
per cycle plus the latency win of removing N sequential blocking
calls.

The bonus: summaries written by the reviewer are inherently relevance-
aware because the reviewer's whole job is to judge relevance to the
TODO's gaps. A separate summarizer call has only the artifact in
front of it; the reviewer has the artifact + the gap list + the
investigation state.

**Graceful degrade:** if the reviewer response is missing or has
malformed `stepSummaries` entries for some steps, the orchestrator
falls back to a structural summary (`"<skillId> output: <first 80
chars of raw payload>"`) for the affected artifacts. The TOC still
gets entries; only the closure markers are missing for those rows.
Forward progress is never blocked on summary correctness.

**Retrieval primitive:**

A new skill, `shared.memory.get-artifact({id})`, returns the full
payload as text. The orchestrator MAY also pre-fetch artifacts when a
step's `dependsOn` declares them -- same selective forwarding pattern
as the cross-step priors work but now pulling from disk instead of
in-memory cache.

**Why the orchestrator MAY pre-fetch but not MUST:** the LLM-driven
"decide next step" turn (Phase 4) sees the TOC and can request the
fetch explicitly. The pre-fetch shortcut is for declared, deterministic
dependencies; the explicit-request path covers everything else.

**TOC block in the LLM context:**

```
## TABLE OF CONTENTS (artifacts available; call shared.memory.get-artifact({id}) to fetch)

art-3a2f1b: 25 JSON file paths under test/integration/data/BB/GRN; first 3: 176050.json, ...
art-8c4d29: INGRN class at insors/core/model/invoice/regions/IN/grn.py:40-207; entityId b2097ef0...
art-7b1e88: Sample shape of 25 GRN JSON files: 10 top-level fields (grn_number VARCHAR, ...)
...
```

**Bounded by design:** the TOC grows linearly with steps run, but
each entry is 128 tokens (40-60 words). 50 steps × 128 tokens = 6.4k
tokens of TOC; still bounded under the local 16k window when paired
with selective payload fetches.

**Tests:**

- (unit) Round-trip: persist artifact, list TOC, fetch by id, content
  matches.
- (unit) Summary failure path: degraded structural summary written
  when the review/decide turn omits the `stepSummaries` entry for
  a step.
- (unit) TOC truncation: when total summary tokens exceed budget,
  oldest artifacts roll out of the TOC but remain on disk and
  reachable by id (the LLM can still ask for them; just doesn't see
  them by default).
- (unit) Disk GC: artifacts older than session age cleaned by a
  maintenance pass; cross-session retention is out of scope (see
  below).
- (integration) The goal-aware summary contract: feed real Ollama
  the consolidated review-with-summaries prompt against a fixture
  that has a known-relevant artifact (e.g., a `list-files` output
  for a gap that asks "enumerate the JSON fixtures"). Assert the
  emitted summary contains a `CLOSES gap-X fully` marker for the
  matching gap id and DOES NOT invent gap ids outside the fixture's
  active gap list.
- (integration) Summary refusal: same prompt with an artifact that
  is genuinely irrelevant to any active gap. Assert the summary
  carries NO closure markers, not a fabricated `PARTIALLY supports`.

**Validation gate:** a controlled run where every skill output is
persisted, the TOC is computed end-to-end, and a synthetic "fetch
artifact X" query through the retrieval skill returns the exact
bytes. This is purely a plumbing check; the existing flow ignores
the artifact store until Phase 4.

### Phase 2: Tier-split memory layout

Today the same `MemoryShapeBundle` (system / summary / recent /
semantic / code) is built once and handed to every prompt regardless
of tier. Local and cloud see the same shape; cloud just has more
headroom for it.

The redesign emits two shapes from one shaping call:

```ts
interface MemoryBundle {
  readonly local:  LocalMemoryView;
  readonly cloud:  CloudMemoryView;
}

interface LocalMemoryView {
  readonly system:         string;   // <= 200 tokens; project + subject
  readonly currentTodo:    string;   // <= 200 tokens; objective + status
  readonly toc:            string;   // bounded; see Phase 1
  readonly recentSteps:    string;   // last 2 steps' summaries inline
  // No semantic / code blocks at the local tier by default -- too costly
  // for context, low signal for tool-arg synthesis. Fetched explicitly
  // via TOC ids when the model needs them.
}

interface CloudMemoryView {
  readonly system:         string;
  readonly summary:        string;   // working-memory shaped summary (today's path)
  readonly recent:         string;   // last 5 steps full
  readonly semantic:       string;   // top-K ANN entity context
  readonly code:           string;   // top-K code entity context
  readonly toc:            string;   // full TOC (no truncation; cloud has the window)
  readonly factLedger:     string;   // current retained gap analysis
}
```

**Why two shapes:** the cloud needs to make planning decisions over
the full investigation state; it must see the semantic / code context
and the full TOC. The local LLM is doing one focused thing per step
(build context, then resolve args); it does not need the historic
semantic block, which today gets dropped on the floor anyway because
the local prompt has no room for it.

**Implementation:** the existing working-memory `shaper.ts` already
emits a structured bundle. Extending it to emit two views from one
shaping call avoids re-running the expensive map-reduce twice. Both
views can share the system + TOC blocks; only the heavier sections
differ.

**Tests:**

- (unit) Local view bounded under a configurable token budget
  (default 6k); truncation kicks in oldest-first on `recentSteps`,
  not on `system` or `currentTodo`.
- (unit) Cloud view contains all of today's bundle sections plus the
  new TOC.
- (unit) Shape map-reduce path tested with synthetic working-memory
  of varying sizes.
- (integration) Drive shapeMemory through real Ollama against a
  fixture working-memory bundle large enough to force chunked
  map-reduce. Assert the consolidated output is valid JSON with all
  expected fields populated. Catches the regression we just shipped
  numCtx wiring for -- the exact scenario where mocked tests said
  "OK" and the live run hit the chunking path mid-investigation.

**Validation gate:** the existing prompts switched to receive either
the `local` or `cloud` view. Token-count metric collected per prompt
type and compared to today; local prompts MUST drop materially (the
whole point); cloud prompts MAY grow slightly (TOC added).

### Phase 3: Build-context sub-step

Before today's shape-resolver runs, a new local-tier turn decides
which artifacts the model needs to load via the TOC.

**Input the build-context LLM sees:**

```
## STEP TO EXECUTE
{step.intent}

## SKILL TO INVOKE
{step.skillId}: {skill.description}

## SKILL INPUT SCHEMA
{schema}

## CURRENT TODO OBJECTIVE
{todo.objective}

## TABLE OF CONTENTS
{toc}

## TASK
Decide which artifacts (by id) you need to read before resolving the
skill's args. Emit:
  { "fetch": ["art-3a2f1b", "art-8c4d29"], "notes": "<why>" }
```

**Then:** the orchestrator fetches the named artifacts, appends them
to the shape-resolver's `priorOutputs`, and shape-resolver runs as
today.

**Why this is right under "correctness over cost":** the LLM
explicitly identifies its dependency rather than the orchestrator
guessing or the shape-resolver tripping over the missing data later.
Empty `fetch: []` is allowed (the step might need no artifacts);
shape-resolver still runs.

**Tool access during build-context:** the LLM gets read access to
`shared.fs.list-files` and `shared.fs.peek` during this turn. If the
TOC doesn't have what it needs and the answer lives in an unindexed
file (a config, a fixture), the LLM can pull it inline. Output of
those fs calls becomes new artifacts in the store so they're reusable.

**Failure handling:** if build-context emits an invalid artifact id,
the orchestrator surfaces a corrective hint and retries once. If the
second attempt is still invalid, build-context is skipped (treated as
`fetch: []`) and shape-resolver runs with the bare priorOutputs --
preserving forward progress even when build-context misfires.

**Tests:**

- (unit) build-context emits valid fetch list given a TOC + step.
- (unit) Invalid id triggers one retry then graceful degrade.
- (unit) Tool-access path: build-context calls fs.peek, the resulting
  artifact gets persisted with claim-shaped summary, TOC updated.
- (integration) Against `fixtures/grn-locate-ingrn/`: build-context
  is asked to prepare args for `code.class.extract-fields(INGRN)`.
  The TOC contains the locate-by-name artifact carrying the hex
  entityId. Assert build-context picks THAT artifact id (not the
  unrelated repo-describe artifact also in the TOC), and that
  shape-resolver's subsequent call goes through cleanly with the
  real hex id.
- (integration) Against a fixture with NO relevant artifact in the
  TOC: assert build-context emits `fetch: []` rather than picking
  the closest-named artifact arbitrarily (the canonical
  hallucination from the 6th run's compare-skill calls).

**Validation gate:** trace a complete TODO end-to-end. Every step
that needs a hex entityId for `code.entity.summary` MUST get its
entityId via build-context's explicit fetch of the locate-by-name
artifact. Zero shape-resolver "missing entityId" retries should fire
in the happy path.

### Phase 4: Dynamic flow (orchestrator rewrite)

Today's `todo-orchestrator.ts` cycle loop is replaced with a
step-at-a-time interaction.

**Loop structure:**

```ts
async function runTodo(todo: TodoSpec, ...): Promise<TodoResult> {
  const factGaps = await runFactGapAnalysis(...);   // unchanged
  const sketch   = await runSketch(todo, factGaps); // Stage 1, cloud
  let   stepIdx  = 0;
  let   noProgressCount = 0;

  while (stepIdx < SAFETY_CEILING) {
    const decision = await decideNextStep({
      todo, factGaps, sketch, toc, lastResult: prevResult,
    });
    if (decision.action === 'terminate') { break; }
    if (decision.action === 'replan-sketch') {
      sketch = await runSketch(...);   // cloud regenerates
      continue;
    }
    // decision.action === 'execute-step'
    const ctx        = await buildContext(decision.step, toc);   // local
    const args       = await resolveSkillShape(decision.step, ctx);
    const output     = await invokeSkill(decision.step.skillId, args);
    // The NEXT decide-next-step call will see this raw output and emit
    // a goal-aware summary in its response; the orchestrator writes it
    // into the artifact's metadata at that point. Persistence itself
    // is summary-less here (placeholder summary 'pending' until the
    // next cloud turn lands).
    const artifact   = await artifactStore.persist(output, ...);
    toc.add(artifact);

    // Convergence: read closure markers off the TOC directly. The
    // markers were emitted by the PREVIOUS decide-next-step turn for
    // the artifact added one iteration ago. No additional LLM call.
    const coverage = computeCoverageFromToc(toc, factGaps);
    if (coverage.allClosed) {
      verdict = 'covered';
      break;
    }
    // No-progress accounting: did the LAST artifact (the one whose
    // summary just landed in the previous decide turn) carry any
    // closure markers?
    if (toc.lastArtifactHasNoMarkers()) {
      noProgressCount += 1;
      if (noProgressCount >= NO_PROGRESS_BUDGET) { break; }
    } else {
      noProgressCount = 0;
    }
    stepIdx += 1;
  }

  return await synthesizeSection(todo, toc, factGaps);
}
```

**The cloud's "decide next step" turn:**

This is the new heart of the orchestrator. The cloud sees:

  - The user question.
  - The current TODO's objective + remaining fact gaps.
  - The original sketch (for reference; not a hard constraint).
  - The TOC (every prior artifact's summary).
  - **The raw output of the most-recently-executed step**, awaiting
    its summary.

It emits a structured decision AND the summary for the most-recent
step (consolidating today's separate `summarizeResult` call):

```ts
type NextStepDecision =
  | { action: 'execute-step', step: PlannedStep, reasoning: string,
      lastStepArtifactSummary?: string }   // claim-shaped + closure markers
  | { action: 'replan-sketch', reason: string,
      lastStepArtifactSummary?: string }
  | { action: 'terminate', verdict: 'covered' | 'unrecoverable',
      reason: string,
      lastStepArtifactSummary?: string };
```

`lastStepArtifactSummary` is OPTIONAL only on the very first turn
(when there's no prior step to summarise). Every other turn MUST
emit it; the orchestrator writes it into the prior artifact's
metadata and updates the TOC. Missing-or-malformed summaries degrade
to the structural fallback per Phase 1's graceful-degrade contract.

**Why the sketch still matters:** the cloud emits a 3-5-step
sketch up-front so the loop has a default direction. The
decide-next-step turn defaults to the sketch's next step unless the
last result invalidates it ("locate-by-name returned not-found, the
next step needs to change"). The sketch + dynamic-override pattern
gives both predictability AND adaptation -- the planner doesn't
restart its reasoning from scratch every iteration.

**Replacing today's cycle review:** there is no cycle anymore.
"Should we keep the step's output?" doesn't exist as a separate
question because everything is persisted regardless. "Should we
emit new steps?" becomes the decide-next-step turn itself. The
cycle reviewer's third question -- "have we made enough progress?"
-- becomes the convergence check below.

**Tests:**

- (unit) Happy path: decide-next-step follows the sketch; loop
  terminates on factGaps closure (via TOC marker scan).
- (unit) Replan path: a step returns empty; decide-next-step emits
  `replan-sketch`; new sketch arrives; loop continues.
- (unit) Tool retry path: shape-resolver omits an arg; decide-next-
  step sees the failure in lastResult and inserts a locate-by-name
  step.
- (unit) Mock the cloud to terminate on step 1 + ensure synthesis
  runs over the (small) TOC.
- (unit) Summary-write-back: orchestrator takes
  `lastStepArtifactSummary` from the decide turn and updates the
  PRIOR artifact's metadata + TOC entry. Confirm one-iteration lag
  is correctly handled.
- (integration, decide-next-step) Against `fixtures/grn-l2-trigger/`:
  decide-next-step sees a fixture where TOC coverage is complete.
  Assert it emits `action: 'terminate', verdict: 'covered'` rather
  than scheduling redundant steps -- the exact failure mode that
  caused runs 5-7 to over-schedule entityId-summary calls.
- (integration, decide-next-step) Against
  `fixtures/grn-classfields-fabrication/`: a fixture where the
  PRIOR step's output is the compare-skill failure. Assert
  decide-next-step inserts an `extract-fields` step instead of
  retrying the compare blindly. Validates the "see the actual
  result before deciding" promise.
- (integration, sketch) Real-Ollama-equivalent sketch generation
  (cloud-tier, so against the cloud sandbox not Ollama): assert the
  emitted sketch is 3-5 steps, all skillIds are catalog-valid, no
  intra-sketch dependency cycles.

**Validation gate:** rerun the GRN analysis in dynamic mode.
Acceptance: TODO 2 (`locate-ingrn-pydantic-class`) and TODO 4
(`extract-ingrn-fields`) -- both of which L2-fallback'd in runs 5/6
and got partial-acceptance in run 7 -- MUST produce sections backed
by real `code.class.extract-fields` outputs, not L2 hallucination.
Token cost MAY rise materially; that is acceptable.

### Phase 5: Convergence signals (replaces hardcoded caps)

The dynamic loop terminates on whichever of these fires first:

1. **Fact-gap closure (read off the TOC).** Because each artifact's
   summary carries closure markers (`CLOSES gap-X fully` /
   `PARTIALLY supports gap-X`; emitted by the reviewer/decider per
   Phase 1), the orchestrator can compute coverage by scanning the
   TOC mechanically -- no LLM call needed. Every gap fact in the
   active list with at least one `CLOSES ... fully` annotation is
   covered. When all gaps are covered, the loop terminates with
   `verdict: 'covered'`. Cheapest possible signal: pure structural
   scan, deterministic, runs every step.

   An OPTIONAL terminate-time sanity check (one cloud call,
   *before* synthesis) re-asks fact-gap analysis whether the markers
   agree with the underlying artifacts. Catches the case where a
   reviewer over-claims closure. Single check, not periodic.

2. **N consecutive no-progress steps.** A step "contributes evidence"
   when its artifact's summary has at least one closure marker (any
   `CLOSES` or `PARTIALLY supports`). A step without markers is a
   no-progress step. N defaults to 3 (configurable via
   `INSRC_NO_PROGRESS_BUDGET`). When the budget burns, the loop
   terminates with `verdict: 'unrecoverable'` and the cloud's
   `decide-next-step` is asked one final time whether to escalate
   (replan-sketch) or accept the partial result.

3. **Safety ceiling.** A hard cap (default 50 steps per TODO, env-
   configurable) that exists ONLY to prevent runaway loops if both
   signals above fail. When this fires, treat it as a bug and log
   loudly. Under correct conditions it should never fire.

**Why this is different from today's caps:** the caps today are
*timing* (3 cycles × 5 steps) -- they bound work mechanically.
The new signals are *outcome-based* -- they bound work by whether
we're making real progress. A run that converges cleanly in 4 steps
terminates at 4. A run that genuinely needs 30 steps gets them.

**Tests:**

- (unit) Convergence path: synthetic 5-step plan covering all gaps
  via TOC markers -> terminates with `covered`. No LLM calls beyond
  the per-step decide turns.
- (unit) No-progress path: rig 3 consecutive artifacts with no
  closure markers -> terminates with `unrecoverable`.
- (unit) Safety ceiling: rig a loop that always returns "in-progress"
  -> ceiling fires at 50; warning logged.
- (unit) Marker-scan correctness: build a TOC with mixed `CLOSES`
  and `PARTIALLY supports` markers and confirm `computeCoverage`
  reports the right gap-by-gap closure status.
- (integration) Terminate-time sanity check: against a fixture where
  TOC markers report "covered" but one marker is fabricated (gap-id
  not in the active list), confirm the sanity-check cloud call
  catches the discrepancy and refuses to terminate with `covered`.

**Validation gate:** a full GRN run with caps removed must not
trigger the safety ceiling. Mean steps-per-TODO logged; we should
see 4-15 (vs today's 5-15 across cycles, but those 5-15 today often
end in L2).

### Phase 6: Prompt rework (against the PromptWriter interface)

Ongoing throughout phases 1-5; called out separately because every
architectural change exposes new prompt issues and we want a single
tracking surface.

**Now feasible because of Phase 0.** Each prompt change is a new
PromptWriter version (`shape-resolver` v2, v3, ...). Old versions
stay registered and runnable; rollback is config-only; A/B comparisons
between versions are first-class.

**Prompts to revisit, with the architectural lens:**

- **Fact-gap analysis** (cloud): unchanged surface, but the prompt's
  "required-facts" output should mention TOC ids when a fact is
  derivable from an existing artifact (Phase 1 enables this). New
  version when TOC references land.
- **Sketch** (cloud, NEW writer): replaces today's discovery-plan
  expansion. Smaller surface (3-5 steps, not 1-12) and explicitly
  framed as "default direction, not a contract."
- **Decide-next-step** (cloud, NEW writer): the load-bearing new
  prompt. Should explicitly say: "you may default to the next sketch
  step; you may insert a new step; you may terminate; you may
  replan." Worked examples for each branch.
- **Build-context** (local, NEW writer): worked examples of fetching
  artifacts by TOC id; explicit "omit fetch when no artifact is
  relevant"; tool access to shared.fs.* explained.
- **Shape-resolver** (local): the hardened anti-fabrication block
  already shipped (commit `e4f8ca7e41b`) carries forward; minor
  adjustments to reference TOC artifacts as the canonical source of
  prior-output data. Becomes shape-resolver v2.
- **Section synthesis** (cloud): adjusted to read the artifact
  store as the source of evidence, not a retained ledger of
  summarised facts. New version.
- **Working-memory shape** (local map + cloud reduce): tier-split
  per Phase 2; local prompt drops the semantic + code sections.
  Two distinct writers (`memory-shape.local`, `memory-shape.cloud`)
  rather than one writer with branching internals.
- **Bullet extraction** (local): unchanged for now; bullets become
  one of several artifact types in the store.

Each prompt change ships as a new PromptWriter version behind the
same `INSRC_SECTION_FLOW_MODE` flag so static-mode prompts (which
just pin to v1 of every writer) stay frozen during the dynamic-mode
rollout.

## Out of scope (intentional)

- **Cross-session artifact retention.** Each session's artifacts live
  under `~/.insrc/tmp/<sessionUuid>/`. GC at session end. Sharing
  artifacts across sessions is a separate problem (bullet cache and
  Lance ANN already cover the semantic-recall case for prompts
  across sessions).

- **Multi-TODO parallelism.** TODOs still run sequentially. The
  dynamic flow is per-TODO; running multiple TODOs concurrently is a
  separate orchestration question.

- **Skill catalog redesign / shared.fs.* migration.** Tracked by
  `plans/shared-fs-skills-and-namespace-cleanup.md`. Independent.

- **Provider routing changes.** Already in flight; the dynamic flow
  uses the same provider-resolution logic.

- **Replacing the working-memory bundle on disk.** Today's per-TODO
  WorkingMemoryEntry on disk is the right shape (section markdown +
  findings); the artifact store is additive, not a replacement.

## Risk

- **Phase 4 is large.** Rewriting todo-orchestrator is a multi-file
  change. Mitigation: feature flag, parallel old code path, validate
  in dynamic mode without disturbing static mode users.

- **Decide-next-step prompt is load-bearing.** The cloud's ability
  to pick the right next step on incomplete information is the
  whole correctness claim. Mitigation: rigorous prompt testing
  using recorded conversations from prior live runs as fixtures.

- **Artifact store correctness.** Persisted-then-corrupted artifacts
  would be catastrophic. Mitigation: write-tmp-then-rename
  (same pattern as working-memory-store today), checksum on read,
  reject malformed metadata.

- **Latency rise will be visible to users.** Per-TODO time will go
  up; the user's "correctness over cost" directive makes this
  acceptable, but worth surfacing in the UI (a progress indicator
  that distinguishes "thinking" from "working").

- **Backward compatibility.** Static mode must keep working unchanged
  during the rollout. All new schemas (Artifact, MemoryBundle.local /
  .cloud) live alongside existing types; no breaking renames. Phase 0
  migrations are pure refactors with per-writer assertion tests
  pinning string-equivalence to the pre-migration helpers.

- **Phase 0 migration scope.** Migrating every existing prompt to the
  PromptWriter interface touches ~8 step modules. Mitigation: pilot
  on shape-resolver first; only proceed to the rest once the pilot
  validates in a static-mode live run.

- **Integration-test infrastructure cost.** Real-Ollama tests run
  ~5-30s per prompt under qwen3.6:35b-a3b. The full integration
  suite for the redesign (estimated 20-40 integration tests across
  all phases when complete) is ~5-15 min on a warm Ollama. Default
  CI runs the unit suite only; integration tests run on a dedicated
  nightly job + pre-merge for any PR touching a prompt or
  PromptWriter. Mitigation: per-test Ollama warmup via `keep_alive:
  24h` (already used by the OllamaProvider) so subsequent calls hit
  the loaded model without reload latency.

- **Fixture corpus maintenance.** Fixtures derived from live runs
  drift as the catalog evolves (new skills, renamed skills, prompt
  changes). Mitigation: each fixture file carries a `derivedFromRun`
  field naming the daemon log it came from + the date; an annual
  regeneration pass refreshes the corpus from the most-recent live
  runs.

## Sequencing

1. **Phase 0** (PromptWriter abstraction + real-Ollama test
   harness) -- the FIRST thing that ships. Every prompt added or
   modified in Phases 1-5 needs the interface to exist. The
   integration test harness (`npm run test:ollama`, the gating
   env var, the Ollama-presence probe, the fixture-corpus loader)
   ALSO lands here so subsequent phases inherit it. Pure refactor
   of today's static-mode prompts; no behaviour change; locks in
   versioning + rollback semantics + the test contract before the
   dynamic-flow work begins.
2. **Phase 1** (artifact store + TOC) -- foundational for memory
   redesign; ships against the PromptWriter from Phase 0.
3. **Phase 2** (tier-split memory layout) -- close behind; cheap
   given Phase 1. New `memory-shape.local` / `memory-shape.cloud`
   writers.
4. **Phase 3** (build-context sub-step) -- requires Phases 1+2. New
   `build-context` writer.
5. **Phase 4** (dynamic flow) -- the big one; requires Phases 1-3.
   New `sketch` + `decide-next-step` writers.
6. **Phase 5** (convergence signals) -- locks in once Phase 4 is
   stable. No new prompts; uses existing writers' outputs.
7. **Phase 6** (prompt rework) -- continuous after Phase 0, formalised
   here. Each prompt iteration is a version bump.

Each phase commits behind a feature flag, ships to release/1.96, and
gets validated against the GRN data analysis before the next phase
starts. No "big bang" merge.

## Tracking

Insert a Status block here once Phase 1 ships:

```
Status: 2026-MM-DD -- Phase 1 shipped (commit <hash>); artifact store
        validated against synthetic round-trip. Phase 2 in progress.
```

Close the plan when all six phases have validated.
