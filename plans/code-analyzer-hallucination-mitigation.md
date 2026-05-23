# code-analyzer: hallucination mitigation

**Date opened:** 2026-05-23
**Status:** SHIPPED 2026-05-23 -- Phases 10/11/12 implemented in a
single commit. Phase 12 ships behind
`INSRC_ANALYZER_WRITER_MODE=structured` (default off); Phases 10 + 11
are on by default.
**Parent context:** ships on top of Phase 9
([plans/code-analyzer-execute-step-per-result-summarization.md](./code-analyzer-execute-step-per-result-summarization.md)).
Phase 9 fixed the section-count cap; this plan addresses *what the
sections then contain*.

## Implementation deltas

A couple of structural deltas vs the proposed plan:

- **Boilerplate paragraph is INSTRUCTED, not memorised.** The
  investigation revealed that the recurring "the gather phase
  opened the top-level module entries but did not reach the routing
  layer" paragraph is templated by
  [`gap-paragraph-template.md`](../src/insrc/agent/tasks/code-analyzer/prompts/sections/gap-paragraph-template.md)
  + endorsed by 3 other prompt files (anti-hallucination/writer,
  output-format/write, prose-review). The writer model was
  *following instructions correctly* -- the prompt stack itself was
  the source of the boilerplate. Phase 10.A therefore flips the
  entire prompt stack to "OMIT, do not narrate the gap" rather than
  just adding a banned-phrase deny-list.
- **Prompt-file layout differs from the plan.** Plan referenced
  `prompts/sections/writer/system.md` + `writer/redraft.md`; the
  actual layout is `prompts/flow/write/system.md` (composed from
  `prompts/sections/*.md` includes). The same Phase 10.A edits land
  on the actual includes (`gap-paragraph-template.md`,
  `anti-hallucination/writer.md`, `output-format/write.md`,
  `flow/prose-review/system.md`, plus `error-catalog.md` which was
  missed by the original plan listing).
- **Phase 11.A landed in `write-from-evidence.ts`, not a separate
  validator module.** The function `validateCitationCoverage(prose)
  -> { ok, nonTrivialParagraphs, uncitedParagraphs[] }` lives
  alongside the existing `extractCitations` helper. Same effect,
  fewer files.
- **Phase 11.B reviewer prompt is `prompts/flow/claim-grounding/
  system.md`.** Plan said `prompts/sections/claim-grounding/...` --
  the actual location matches the flow-level prompt convention
  (every cloud reviewer pass has its own `flow/<name>/system.md`).
- **Phase 12 renderer is its own module** (`write-from-evidence-
  structured.ts`) rather than additional functions inside
  `write-from-evidence.ts`. The entry point in the legacy module
  branches on the env var and delegates. Keeps the freeform-mode
  file unchanged in size; the structured codepath is isolated for
  easy revert.
- **Pre-existing test breakage in `discovery-flow.test.ts` is
  unrelated to this work.** The test fixture `LOCAL_STEP_OUTPUT_JSON`
  doesn't shape-match what `executeStep` expects from the local
  provider (the test was returning structured JSON text as a tool
  response, but `callPerTask` requires a `tool_use` block). This
  failure is reproducible with `git stash` against `main` and is
  out of scope here.

## Test coverage shipped

| Phase | New test files | Tests added |
|---|---|---|
| 10.A.1 | `__tests__/meta-narrative-detector.test.ts` | 7 |
| 10.B | `agent/content-gen/__tests__/verify-planned-actions.test.ts` | 8 |
| 11.B | `__tests__/claim-grounding-reviewer.test.ts` | 9 |
| 12 | `__tests__/write-from-evidence-structured.test.ts` | 10 |
| 10.A (regen) | `__tests__/write-prompt-snapshot.test.ts` (assertion update + golden regen) | 5 |
| 10.A (regen) | `__tests__/patch-prompt-snapshot.test.ts` (assertion update + golden regen) | 28 |

**Total: 67 tests pass in the affected suites.** Daemon build clean.

## Why

The Phase 9 drill-down run validated section breadth (12 sections vs
the prior 4) but surfaced three distinct hallucination categories in
the generated prose. Each comes from a different layer (planner /
writer / reviewer) and needs a different fix.

### Observed failure modes

**(A) Section-framing hallucination -- planner invents a section that
doesn't match the codebase, writer fills with plausible-but-wrong
detail.**

Concrete example from the NameNode drill-down §6 "Caching Layer & In-
Memory Structures":

  - Invented `cacheReadWriteLock` (no such lock in `FSDirectory`).
  - Claimed "LRU eviction policies and size-based bounds on `INodeMap`"
    (NameNode keeps all metadata in memory; INodeMap doesn't evict).
  - Cited `CacheableIPList.refresh` as cache invalidation evidence
    (that class is for IP allowlists, not namespace cache).

Root cause: the planner picked a generic section title from a taxonomy
("Caching Layer") that doesn't correspond to a real subsystem in HDFS.
The writer was then asked to draft a section on a subsystem that
doesn't exist, and filled the gap with reasonable-sounding details.

**(B) Boilerplate insertion -- writer model memorizes a template
paragraph and pastes it into unrelated sections.**

Concrete example: the paragraph "*The available evidence does not
surface the request-routing subsystem. The gather phase opened the
top-level module entries but did not reach the routing layer.*"
appeared verbatim across multiple unrelated sections in *both* runs
(the HDFS overview run and the NameNode drill-down run -- routing
isn't even a NameNode concern). This is a writer-model template
behavior, not evidence-driven content.

**(C) Meta-statement hallucination -- writer makes authoritative-
sounding claims about the codebase shape that were never verified.**

Concrete examples:

  - §10 "Test Suite & Validation" claimed "no test classes matching
    the pattern `*Test` were found in the NameNode test directory"
    (wrong convention direction -- HDFS uses `Test*` prefix; the
    statement is false but plausible).
  - §6 mixed real evidence-anchored claims with invented-without-
    evidence claims (`cacheReadWriteLock`) in the same paragraph,
    making post-hoc filtering hard.

Root cause: the writer is told to compose prose around evidence
entries, but nothing forces every assertion in the prose to map back
to a specific evidence entry. The model adds "color" claims as filler.

### Goals

1. Stop the planner from producing sections that don't correspond
   to real subsystems.
2. Stop the writer from emitting memorized boilerplate paragraphs.
3. Stop the writer from emitting un-grounded factual claims.

All three should be evaluable on the same HDFS NameNode drill-down
re-run that exposed the failures.

## Phases

The phases are ordered by **engineering cost** ascending. Phase 10
(banned-phrases) is one prompt edit. Phase 12 (structured writer) is a
real refactor.

### Phase 10 -- banned-phrase deny-list + planner pre-flight probe

**Why first.** Banned-phrase is a one-line prompt edit that kills the
recurring boilerplate (Category B) immediately. Planner pre-flight is
a small wrapper that kills the most common Category A failure (cache
layer for a no-cache codebase) for ~12 extra cheap cloud calls per
report.

**What changes.**

**10.A -- "No meta-narrative" semantic rule in the writer prompt.**

A phrase-level deny-list is fragile -- the local executor model will
change (devstral → qwen3-coder → next) and the specific boilerplate
templates each model memorizes will change with it. A fixed string
list goes stale. Even within one model, small rephrasings ("the
exploration phase only surveyed the top-level modules" vs "the gather
phase opened the top-level module entries") evade exact-match
filtering.

The durable fix is a **semantic rule** in the writer prompt, framed
as an instruction the model must interpret on every draft, not a
string match against known-bad text.

  - In [`prompts/sections/writer/system.md`](../src/insrc/agent/tasks/code-analyzer/prompts/sections/writer/system.md):
    add a "Subject discipline" subsection with the rule:

    > Every sentence you emit MUST be about the *subject under
    > review* (the classes, files, methods, behaviours, data flows of
    > the codebase). No sentence may be about the *analysis process
    > itself* -- do NOT describe what the gather phase did or didn't
    > do, what skills you ran or couldn't run, what evidence was or
    > wasn't surfaced, what the index contained, or which aspects
    > weren't reached. If you have no concrete evidence for an aspect
    > implied by the section title, OMIT that paragraph entirely.
    > Shorter is fine; meta-narration is not.

  - Add the same guidance to the redraft prompt
    [`prompts/sections/writer/redraft.md`](../src/insrc/agent/tasks/code-analyzer/prompts/sections/writer/redraft.md).

**10.A.1 -- Tripwire regex (detector, not preventer).**

The semantic rule above is a soft defense -- the model can still
violate it. To detect when that happens, ship a small post-draft
regex check on a non-exhaustive list of *historical* boilerplate
signatures observed in live runs:

  - In [`agent/tasks/code-analyzer/write-from-evidence.ts`](../src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts):
    add `detectMetaNarrative(prose): { hit: boolean; matches: string[] }`.
  - Patterns (start conservative, append as new ones are observed):
      - `/gather phase (only|opened|surveyed|did not)/i`
      - `/did not (reach|surface|enter|cover) the .{0,40} (layer|subsystem)/i`
      - `/(this is a gap|not a claim about the codebase|evidence does not surface)/i`
  - On hit: log a warning, force `proseVerdict: 'redraft'` with the
    matched excerpt as a `notes[]` entry to the redraft prompt
    ("rewrite this section without the meta-narration paragraph
    quoted above"). Do NOT auto-strip -- redraft so the model can
    salvage real content.
  - These regexes are a tripwire, not a fence. Their job is to
    catch when the semantic rule fails, surface the failure, and
    trigger redraft. The phrase list is expected to evolve; check
    it in like any other test fixture and update as new patterns
    are observed.

**Why this two-layer design.** The semantic rule does the actual
work and is model-agnostic. The regex tripwire is a guardrail that
catches regressions when the rule fails (whether due to a model
swap, a prompt revision, or a new boilerplate pattern). The
tripwire's *job* is to be updated -- it's a known-failure detector,
not a comprehensive filter.

**10.B -- Planner pre-flight probe.**

  - In [`daemon/controllers/code-analyzer-orchestrator.ts`](../src/insrc/daemon/controllers/code-analyzer-orchestrator.ts)
    around line 720 (right after `planActions` returns the action
    list): introduce `verifyPlannedActions(actions, deps)`.
  - For each action, extract candidate entity names from its `title`
    + `objective` (NER-light: capitalized multi-word tokens, dotted
    java identifiers, file extensions).
  - Run `code.entity.locate-by-name` on the top-2 candidates per
    action. If ALL candidates return 0 matches AND the action's title
    is concrete (i.e. contains at least one named entity), DROP the
    action and log a warning. Loose titles ("Operational
    Observability") that don't name a specific entity skip the check.
  - The verification adds ~12 locate-by-name calls per report (one
    cycle of the existing skill, no LLM round-trip needed).

**Files changed.**

  - `src/insrc/agent/tasks/code-analyzer/prompts/sections/writer/system.md`
  - `src/insrc/agent/tasks/code-analyzer/prompts/sections/writer/redraft.md`
  - `src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts`
    (`detectMetaNarrative` regex tripwire + integration)
  - `src/insrc/daemon/controllers/code-analyzer-orchestrator.ts`
    (`verifyPlannedActions` pre-flight probe)
  - `src/insrc/agent/tasks/code-analyzer/__tests__/meta-narrative-detector.test.ts`
    (new unit test for the tripwire patterns; fixture file holds
    the regex set so it's easy to extend)
  - `src/insrc/daemon/controllers/__tests__/code-analyzer-orchestrator.test.ts`
    (new unit test for `verifyPlannedActions`)
  - This plan doc (status update on completion)

**Validation.**

  - Semantic rule + tripwire: re-run the NameNode drill-down;
    expect (a) zero hits from the tripwire regex set, AND (b) when
    the tripwire is *deliberately* fed prior bad prose (from the
    earlier runs' meta-narrative paragraphs), it catches and
    triggers redraft. Both signals matter -- a clean re-run with a
    silent tripwire isn't enough; the tripwire must also be shown
    to fire on known-bad input.
  - Pre-flight probe: re-run with a forced "Caching Layer" section
    in the planner output (mock or via a tier-XL on HDFS where the
    cache title kept coming up); expect that section to be dropped
    with a logged warning.

**Risks.**

| Risk | Likelihood | Mitigation |
|---|---|---|
| Semantic rule is too abstract and the model ignores it | medium | The tripwire regex set is the safety net -- catches model violations and triggers redraft. Phase 11's citation-per-paragraph adds a second hard constraint. Phase 12 is the structural fix. |
| Tripwire regex set goes stale as new boilerplate patterns emerge | high | Expected. The tripwire's design treats this as a maintenance task -- patterns live in a fixture file, added as observed. The semantic rule in the prompt is what's expected to do the work; the tripwire just catches regressions. |
| Tripwire over-matches legitimate prose ("the gather phase" used factually) | low | Patterns target the *meta-narrative* shape ("gather phase did not reach X"), not bare keyword matches. False-positive rate stays low because legit code-analysis prose doesn't describe the analysis tooling itself. |
| Pre-flight probe drops a legitimate section whose entity is mis-named in the title | low | Only drop when ALL top-2 candidates miss AND the title is concrete. Section titles like "Operational Observability" (no concrete entity) skip the probe by design. |
| Pre-flight latency adds noticeable wall-clock to plan stage | low | `locate-by-name` is millisecond-level on the LMDB+Lance graph -- 12 of them is well under 1s total. |

### Phase 11 -- citation-required prose + claim-grounding reviewer pass

**Why second.** Phase 10 catches the easy cases (templated boilerplate,
missing entities). Phase 11 catches the harder case (Category C): a
paragraph that's *mostly* evidence-anchored but slips in an unfounded
side claim. Two complementary checks: writer-side (every paragraph
must have a citation) and reviewer-side (a dedicated pass that scores
each claim's evidence backing).

**What changes.**

**11.A -- Citation-per-paragraph rule.**

  - In the writer system prompt: "Every paragraph of the section MUST
    contain at least one citation link (the `[path:...](...)` format).
    Paragraphs without citations will be rejected during review."
  - In [`agent/tasks/code-analyzer/write-from-evidence.ts`](../src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts):
    add `validateCitationCoverage(prose)` -- splits on `\n\n`, checks
    each paragraph contains `](path:` substring; rejects the draft
    and triggers redraft if any non-trivial paragraph fails (skip
    short transition paragraphs, ≤80 chars).
  - This is a hard structural check, not a prompt suggestion.

**11.B -- Claim-grounding reviewer pass.**

  - New file `agent/tasks/code-analyzer/claim-grounding-reviewer.ts`
    exposing `reviewClaimsGrounding(prose, evidence, cloudProvider)`.
  - Cloud call: emit list of bare factual claims extracted from the
    prose (one cloud call per section, structured JSON output:
    `{claims: [{text: string, evidenceMatch: 'high'|'medium'|'low'}]}`).
  - The reviewer is given (a) the full prose, (b) the section's
    captured EvidenceEntry array (from execute-step), (c) the
    section's `reviewCriteria`. It scores how well each extracted
    claim is backed by an evidence entry.
  - If any claim scores "low" AND the verdict is otherwise "accept",
    OVERRIDE to "redraft" with the un-grounded claims listed in
    `notes`.
  - The redraft prompt receives the un-grounded claims as targeted
    corrections.

**11.C -- Wire the new reviewer into the orchestrator.**

  - In [`code-analyzer-orchestrator.ts`](../src/insrc/daemon/controllers/code-analyzer-orchestrator.ts)
    around the existing prose-review verdict step (~line 1100, the
    `proseVerdict` event emit): after the existing reviewer runs and
    before the verdict is committed, run `reviewClaimsGrounding`.
    Merge the two verdicts: `accept` only if BOTH the existing
    reviewer AND the claim-grounding pass return clean.

**Files changed.**

  - `src/insrc/agent/tasks/code-analyzer/prompts/sections/writer/system.md`
  - `src/insrc/agent/tasks/code-analyzer/prompts/sections/writer/redraft.md`
  - `src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts`
  - `src/insrc/agent/tasks/code-analyzer/claim-grounding-reviewer.ts` (new)
  - `src/insrc/agent/tasks/code-analyzer/prompts/sections/claim-grounding/system.md` (new)
  - `src/insrc/daemon/controllers/code-analyzer-orchestrator.ts`
  - `src/insrc/agent/tasks/code-analyzer/__tests__/claim-grounding.test.ts` (new)
  - This plan doc

**Validation.**

  - Citation-per-paragraph: re-run NameNode drill-down; grep for
    paragraphs without `](path:` -- expect ≤ trivial transition lines.
  - Claim-grounding: synthesize a prose draft that mixes real evidence
    with `cacheReadWriteLock`-style hallucinations and feed it to the
    new reviewer -- expect the false claims to be flagged "low" and
    the verdict to flip to redraft.

**Risks.**

| Risk | Likelihood | Mitigation |
|---|---|---|
| Citation-per-paragraph rejects legitimate intro/transition paragraphs | medium | Length threshold (≤80 chars skips the check) handles transitions. Also allow paragraphs ending with `:` (intro to a list) to skip. |
| Claim-grounding adds 1 cloud call per section (+12 per report) and meaningful latency | medium | Acceptable cost (~3-5s per call, parallelizable across sections). The dominant cost remains the gather phase. |
| Reviewer over-flags claims that are *implied* by evidence but not literally stated | medium | The 'medium' verdict bin is a safety valve -- we only override to redraft on 'low' (clearly unsupported). |
| The reviewer is itself an LLM and could hallucinate ungroundings | low | The redraft path is a soft correction (asks the writer to revise), not a hard delete. Worst case: a legitimate claim gets rephrased with a tighter citation. |

### Phase 12 -- structured evidence-anchored writer

**Why third (and most ambitious).** Phases 10+11 catch known failure
patterns reactively. Phase 12 is the structural fix: change the
writer from "compose prose freely" to "compose prose where every
sentence ties to a specific evidence entry, by construction."

**What changes.**

**12.A -- New writer output schema.**

  - Replace the current freeform-prose write with a structured
    output: `{ paragraphs: [{narrative: string, evidenceRefs:
    string[]}] }` where `evidenceRefs` lists the
    `EvidenceEntry.id`s the narrative is grounded in.
  - A thin renderer in `write-from-evidence.ts` then assembles
    paragraphs into prose, splicing citations from the referenced
    EvidenceEntry's `citations` array into the narrative at render
    time -- the writer doesn't insert citations directly; the
    renderer does, drawing from real evidence-entry citations.
  - Hard constraint: a paragraph with zero `evidenceRefs` is rejected
    (no narrative without grounding).

**12.B -- Render-time citation injection.**

  - Renderer takes the `narrative` text + the cited EvidenceEntry's
    citation list, and:
      - Anchors the first sentence's terminating period with one
        primary citation from the first ref.
      - Appends supporting citations from the remaining refs at
        natural break points (sentence boundaries).
      - Refuses to render if a ref doesn't resolve to a real
        EvidenceEntry (catches model fabricating evidence-ids).

**12.C -- Migration.**

  - Phases 10+11 stay in place; Phase 12 replaces the writer prompt
    but keeps the same reviewer + claim-grounding stack.
  - Roll out behind `INSRC_ANALYZER_WRITER_MODE=structured` initially;
    default to existing freeform mode. Live runs validate before
    flipping the default.

**Non-goals for Phase 12.**

  - Not redesigning the reviewer.
  - Not changing how evidence is gathered or summarized -- the
    EvidenceEntry shape stays the same.
  - Not addressing planner section-framing (Phase 10.B already does
    this).

**Files changed.**

  - `src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts`
    (new structured-mode codepath; legacy mode kept behind env var)
  - `src/insrc/agent/tasks/code-analyzer/prompts/sections/writer/structured-system.md` (new)
  - `src/insrc/agent/tasks/code-analyzer/__tests__/structured-writer.test.ts` (new)
  - This plan doc

**Validation.**

  - Live re-run of HDFS NameNode drill-down with
    `INSRC_ANALYZER_WRITER_MODE=structured`. Expect:
      - Every paragraph in every section has ≥1 evidence ref.
      - §6 Caching Layer either gets dropped by Phase 10.B's
        pre-flight (if it has no anchoring entity) OR contains no
        hallucinated structures because the structured writer cannot
        invent `cacheReadWriteLock` without an EvidenceEntry to
        reference.

**Risks.**

| Risk | Likelihood | Mitigation |
|---|---|---|
| Structured output is harder for the local model to emit reliably | medium | The current writer already emits prose under a `responseFormat` schema. Tightening it from `{prose: string}` to `{paragraphs: [...]}` is a JSON-schema change, not a new modality. Fallback to legacy mode on schema-parse failure. |
| Loss of narrative cohesion (paragraphs become evidence-blob-shaped) | medium | The `narrative` field is still freeform prose; only the structural skeleton (paragraph → refs) is constrained. Stylistic flow is preserved. |
| Renderer's citation-splicing produces awkward placement | low | First-cut renderer uses simple rules (one citation per sentence boundary). Can be refined empirically. |
| Doubles writer prompt complexity | low | Migration is behind env var; rollback is the env var flip. |

## Cross-cutting risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase 10 catches the easy cases and people declare victory before Phase 11/12 ship | medium | Plan doc keeps all three phases visible. Validation criteria for Phase 10 explicitly do not include claim-grounding. |
| Combined latency (Phase 10 probe + Phase 11 reviewer + Phase 12 structured emit) makes the analyzer noticeably slower | medium | Each phase adds bounded latency (Phase 10: <1s, Phase 11: ~12 parallel cloud calls, Phase 12: same wall-clock as today's writer). Total: report goes from ~25 min to ~28 min. Acceptable. |
| Reviewer-of-reviewer architecture turns into reviewer-of-reviewer-of-reviewer creep | low | Phase 11 explicitly says "merge with existing reviewer", not "add a third reviewer stage". Cap the chain at 2. |

## Validation checklist

- [ ] Phase 10.A shipped: writer system + redraft prompts updated
      with the "Subject discipline" semantic rule.
- [ ] Phase 10.A.1 shipped: `detectMetaNarrative` tripwire integrated;
      unit test verifies it fires on prior-run boilerplate samples.
- [ ] Phase 10.B shipped: `verifyPlannedActions` lands a section
      dropped when its entity isn't located.
- [ ] NameNode drill-down re-run: tripwire regex set returns 0 hits
      on the fresh report AND fires correctly on injected bad prose.
- [ ] Phase 11.A shipped: citation-per-paragraph validator wired.
- [ ] Phase 11.B+C shipped: claim-grounding reviewer flips verdict
      to redraft on a synthetic hallucinated draft.
- [ ] NameNode drill-down re-run with 10+11: §6 Caching Layer
      either dropped or contains no `cacheReadWriteLock`-class claims.
- [ ] Phase 12 shipped behind `INSRC_ANALYZER_WRITER_MODE=structured`.
- [ ] Live structured-mode run: zero paragraphs without evidence refs.
- [ ] Default writer mode flipped to structured after stability proven.

## Open questions

- **Should Phase 10.B drop sections silently or surface them to the
  user as "skipped, no anchor found"?** Leaning toward surfacing --
  user can re-prompt with a different section name if intentional.
- **For Phase 11, does the claim-grounding reviewer run on the
  redraft too, or only on the original draft?** Both, to prevent
  hallucinations from being introduced *by* the redraft. Cap loop at
  2 redraft attempts.
- **Phase 12 + local model: does qwen3-coder reliably emit the
  structured output, or do we need to route the writer to cloud?**
  Empirical; ship behind env var and validate. If unreliable, fall
  back to cloud writer for structured mode only.
