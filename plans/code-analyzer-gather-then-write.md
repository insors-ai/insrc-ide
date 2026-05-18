# Code Analyzer -- gather then write (architectural pivot)

**Status:** ready
**Owner:** subhagho@gmail.com
**Surfaced:** 2026-05-18, during the run #9 output review (devstral + R.1 + S.1 + S.2 produced 88KB report with 20+ verbatim paragraph duplicates inside a single section).
**Supersedes:** the per-turn write-then-tool loop introduced in [`code-analyzer-interleaved-investigation.md`](code-analyzer-interleaved-investigation.md) Phase A-D. The patch-loop work in [`code-analyzer-structured-review.md`](code-analyzer-structured-review.md) Phases E-S is preserved on top of the new write phase.

---

## Context

The interleaved-investigation design (write a paragraph → call a tool → write the next paragraph → call another tool, all in one loop) reached its quality ceiling in run #9. Section 2 ("Main Extraction Pipelines") emitted **the same anchor paragraph 20+ times verbatim** before the loop stopped. Root-cause trace from the log:

```
toolCallCount:        55
skillsCalled:         code.source.module.describe × 52
paragraphCount:       52       (1 paragraph per turn)
evictionsApplied:     56       (eviction fired on every turn)
inputTokensFinal:     19316    (above the 11200 = maxInputTokens * 0.7 threshold)
```

The loop:
1. Model emits anchor paragraph (e.g. *"The db submodule contains 32 files... I will inspect..."*) and is added to section markdown.
2. Tool result returns.
3. Eviction stubs older `tool_result` blocks because input tokens exceeded the threshold.
4. Next turn the model can no longer see the prior tool results that proved it already documented the module. Its own prior paragraphs all end with *"I will inspect X next"*, which it reads as "we're still at the start". It re-emits the anchor.
5. Repeat 50+ times.

The duplication is a SYMPTOM. The structural cause is that **prose generation and tool gathering share the same loop**, so the loop's eviction strategy (which is reasonable for plain investigation) destroys the working memory that prose generation needs.

Treating the symptom (raise the eviction threshold, dedup paragraphs by similarity, track redundant tool calls) keeps the architecture and adds heuristics on top. The cleaner fix is to separate the two phases entirely.

---

## Locked decisions

1. **Two phases per section: gather, then write.** Investigation never emits prose for the report. Writing happens once per section in a single LLM call with all evidence visible.
2. **Stop criterion for the gather phase is model-driven.** Model emits a sentinel ("evidence-complete" or similar) when it judges it has enough for the section's objective + criteria. The orchestrator still imposes a hard iteration cap as a backstop.
3. **Evidence summaries are structured, not free-form.** Each tool call produces a small typed `EvidenceEntry` (skill id, args, key facts, citation refs). Free-form prose is reserved for the write phase.
4. **Gather phase runs on the local model.** It's tactical "pick the next tool" reasoning, the same kind the local model already handles in the patch loop.
5. **Write phase runs on the local model (initial).** Start here for cost / speed. If quality is poor on substantive sections, the immediate fallback is to flip the write step to the cloud (the planner / reviewer already use Anthropic; a third cloud step would not be architecturally novel).
6. **R.1 itemwise patching is preserved.** Reviewer's workItems still drive per-item edits on the Phase W output -- cheap, incremental, already shipped (Phase R.1 of structured-review). The alternative ("re-gather + re-write") is heavier; defer until itemwise + the new write phase have been measured. **Note**: if the new write phase + itemwise patching still produces low quality on R2/R3, the next step is to swap R2/R3 from itemwise patching to a full re-gather + re-write pass.
7. **Reviewer is unchanged.** The structured workItems contract from Phase E of structured-review survives wholesale.
8. **Picker, F.4 fallback, all P/R/S guardrails preserved.** They operate on the Phase W output regardless of how that output was produced.

---

## Architecture

### Phase G -- Gather (replaces the per-turn write inside `writeSectionWithTools`)

```ts
async function gatherEvidence(input: GatherInput): Promise<EvidenceLedger>
```

- Tool-loop driven by the LOCAL model. Same `skill_invoke` / `skill_describe` / `skill_load_page` meta-tools as today.
- Model prompt instructs: "Decide which skills to call. After each result, emit ONE structured summary (JSON). When you have enough to write the section per the objective + criteria, emit `{ "evidence_complete": true }`."
- Each turn the model is required to emit EXACTLY ONE JSON object: either a tool call descriptor OR an evidence-complete sentinel. NO free-form prose. The loop parses the JSON; non-JSON output is rejected with a corrective re-prompt (mirroring the structured-output pattern from review-action.ts).
- Evidence summary shape:

  ```ts
  interface EvidenceEntry {
    readonly skillId:    string;
    readonly args:       Record<string, unknown>;
    readonly facts:      readonly string[];   // 1-3 key facts the model extracted from the result
    readonly citations:  readonly string[];   // `path:foo.ts#L1-L20` -- carried into the write phase verbatim
    readonly confidence: 'high' | 'medium' | 'low';
  }
  ```

- Eviction policy: `EvidenceLedger` is the persistent state across turns. Full tool-result blocks CAN be evicted under memory pressure -- but the structured summary lives on. The model always sees its own ledger and the most recent N tool results.
- Stop conditions, in order:
  1. Model emits `evidence_complete: true`.
  2. `maxIterations` cap reached (default 32; was 64 in the interleaved loop because writing happened inside it, so half the budget went to prose).
  3. Iteration produces no progress (consecutive empty / errored tool calls); orchestrator force-stops with a warning.
- Output: `EvidenceLedger` = ordered `EvidenceEntry[]` + every captured tool-call trace + the `evidence_complete` flag.

### Phase W -- Write (one shot per section)

```ts
async function writeSectionFromEvidence(input: WriteInput): Promise<WriteOutput>
```

- Single LLM call. Local model. Receives:
  - section title, objective, review criteria
  - the full `EvidenceLedger` from Phase G
  - repo summary block
- Prompt instructs: "Write the complete section markdown. Cover the objective. Use the evidence below. Cite every fact via the citation strings provided. NO process narration. NO `I will...` sentences. Output ONLY the section markdown."
- Output: `markdown` (the complete section) + token usage + a list of citations the model actually used (for the picker / reviewer).
- This is where prose lives. No tool calls. No paragraph accumulation. One write, one section.

### Phase R -- Review (unchanged)

Reviewer (cloud) scores the section against criteria + emits `workItems[]`. Same shape as today.

### Phase P -- Patch (R.1 itemwise, preserved)

Each work item drives a focused single-item patch via `patchSectionItemwise` (already shipped). The Phase W output is the draft being patched. The orchestrator-owned ID protocol stays the same; ghost-IDs remain impossible by construction.

**Re-write fallback** (if quality degrades): replace Phase P with "re-gather + re-write" for R2/R3 -- pass the reviewer's workItems as additional gather hints, then run a fresh W call. Heavier (one extra G + one extra W per round) but architecturally clean. **Not implemented in this plan; documented as the next move if the itemwise patching keeps producing the run-#9-style "patch round did nothing useful" outcomes after the gather/write split.**

---

## What gets retired

- `writeSectionWithTools` interleaved loop (`agent/tasks/code-analyzer/write-section.ts`'s tool-loop path). The function NAME survives as the entry point but its body becomes `gatherEvidence` + `writeSectionFromEvidence`.
- The `pushParagraph` helper + `jaccardTrigramSimilarity` (P.8). Dedup was a symptom-level fix; with prose only generated in Phase W, there's no place duplicates can come from.
- The eviction-threshold + `maxInputTokens` tuning. Phase G holds structured summaries (~100-200 chars each), so even 50+ entries fit in 10K tokens. Phase W is a single call with the whole ledger.
- The transition-phrase nudge (P.5) and recovery-mode preamble for F.4 redrafts. F.4 fires when patching produces zero addressed items; under R.1 it triggers a fresh write pass -- but the write pass now takes the ledger from a fresh gather, no recovery context needed.

---

## What stays

- Skill catalog, skill_invoke / skill_describe protocol, skill spill+page mechanism.
- Reviewer + structured workItems (Phase E of structured-review).
- 3-round outer loop: G/W → review → if needs-work, itemwise patch (R2) → review → patch (R3) → review → picker.
- F.4 fallback semantics: when patching produces zero addressed items, redraft = re-gather + re-write (this is the natural recovery path under the new architecture).
- The picker (Phase G + P.9 of structured-review).
- S.1 (schema-on-invalid-input feedback) -- still applies to gather-phase tool calls.
- S.2 (think:false for qwen tool calls) -- still applies to both gather and write.
- All of Phase B (session-delete) -- unrelated.

---

## Implementation outline

Three deliverables, can ship as three PRs:

### Deliverable 1: Phase G

`agent/tasks/code-analyzer/gather-evidence.ts` -- new module:

- `gatherEvidence(input)` entry point
- JSON-only tool-loop driver. Reuses `runToolLoop` from `agent/tools/loop.ts` BUT bypasses its prose accumulation. The loop sees the model emit a JSON envelope each turn, parses it, dispatches the tool, captures the summary, repeats.
- Strict-JSON parsing with corrective retry (1 attempt) -- mirrors `review-action.ts` Phase P.4.
- Tests: 6-8 tests covering happy path, evidence-complete sentinel, malformed JSON retry, iteration cap, empty-progress force-stop, eviction of full tool-result blocks.

### Deliverable 2: Phase W

`agent/tasks/code-analyzer/write-from-evidence.ts` -- new module:

- `writeSectionFromEvidence(input)` entry point
- Single `provider.complete()` call. No tools. No loop.
- Prompt template: section card (title / objective / criteria) + repo summary + structured evidence ledger.
- Output post-processing: strip the same paragraph artifacts that `stripParagraphArtifacts` handles in `patchSectionItemwise` (here-is-the-draft openers, fenced wrappers).
- Tests: 4-6 tests covering output cleanliness, citation preservation, empty-evidence handling, oversized-evidence truncation policy.

### Deliverable 3: Orchestrator wiring

`daemon/controllers/code-analyzer-orchestrator.ts` -- replace the call to `writeSectionWithTools` with `gatherEvidence` + `writeSectionFromEvidence`. The patch-loop call site (R.1 itemwise) is unchanged. Add a feature flag (`INSRC_ANALYZER_WRITE_MODE=gather-write|interleaved-legacy`) defaulting to `gather-write` so the old path stays one env-var away during the transition.

Cleanup pass (Deliverable 4, optional follow-up): delete the legacy interleaved path + retired helpers once 2-3 live runs confirm parity / improvement.

---

## Open questions

1. **Evidence ledger size cap?** A pathological section could produce 50+ entries × 200 chars = 10K chars of evidence. Fits comfortably in any model's context, but the WRITE phase prompt also includes objective + criteria + repo summary. Need to verify the total fits under the local model's `maxInputTokens` budget. Likely no-op (current local model has 16K-32K), but flag the math.

2. **Citation preservation in Phase W.** Reviewer scores partly on citation density / diversity. The write phase must surface a meaningful fraction of the ledger's citations into the prose. Prompt has to be explicit; tests must check it.

3. **`evidence_complete` decision quality.** If the local model stops too early, sections under-cover their objective. If too late, we revert to "burn tool calls for no reason" mode. Watch the median `iterations` per section in the first run and tune the prompt if the local model is consistently early-stopping. The 32-iteration cap is the safety rail in either direction.

4. **Per-section parallelism?** Phase G + Phase W per section are independent of other sections' G+W. Today the orchestrator runs sections serially. Worth considering parallel section drafting once correctness is established. Out of scope for this plan; flag for after the first clean run.

---

## Out of scope

- Cloud write phase (locked decision 5 says local first; cloud is the fallback if quality is poor).
- Re-gather + re-write for R2/R3 (locked decision 6 keeps itemwise; documented as the next move if needed).
- Multi-pass evidence gathering inside a single Phase G call (e.g., "gather, summarize, gather more"). Today's Phase G is one continuous loop ending in evidence-complete; treating it as a fixed pipeline of sub-phases is over-engineering for v1.
- Cross-section evidence sharing. Each section gathers independently. Optimization for a future plan.

---

## Follow-up optimizations (TODO -- ship after current architecture is validated end-to-end)

### Collapse the 2-call gather pattern into 1 call via `record_evidence` synthetic tool

**Motivation:** Phase G today runs TWO LLM calls per iteration -- (a) tool-decision (model picks `skill_invoke` / `skill_describe` / `skill_load_page` via Ollama's native tool calling) and (b) summarize-result (separate constrained-JSON call via `responseFormat: { schema }` that extracts facts + citations from the raw skill output). Per the run #11 numbers, this is the dominant gather-phase cost -- section 1 spent 40 minutes on 18 iterations × ~2 calls each. Cutting to 1 call per iteration would roughly halve gather latency.

**Proposed change:** expose summarization as a synthetic `record_evidence` tool the model picks alongside the skill meta-tools. The orchestrator implements it as a ledger append -- no LLM call required. Ollama's native tool-calling enforces the input schema (facts, citations, confidence), so we keep the structured-output guarantee.

```ts
{
  name: 'record_evidence',
  description: 'Capture structured facts + citations from the previous skill_invoke result.',
  inputSchema: {
    type: 'object',
    properties: {
      facts:      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
      citations:  { type: 'array', items: { type: 'string' } },
      confidence: { enum: ['high', 'medium', 'low'] },
    },
    required: ['facts', 'citations', 'confidence'],
  },
}
```

Each iteration becomes: model emits `record_evidence(...)` for the result it just saw (orchestrator appends, no LLM); same turn or next, model emits `skill_invoke(...)` for the next investigation; eventually model emits `EVIDENCE_COMPLETE` text without tool calls -> stop.

**Expected outcome:** ~50% reduction in gather latency. Run #11 section 1's 36 LLM calls (18 iterations × 2) -> 18 calls. The full run's total cut from ~5h projected to ~2.5h.

**Risk:** the model now picks from 4 tools (3 skill meta-tools + record_evidence) and must remember to record before invoking again. Could be worse if devstral fumbles the new pattern; could be a big win if it doesn't. Mitigation: keep the 2-call path one env-var away (`INSRC_ANALYZER_GATHER_SUMMARIZE_MODE=separate-call|tool-call`, default `tool-call` once validated).

**Trigger:** implement once current gather-write architecture has 2-3 clean runs confirming the structural fix holds. Don't compound architecture changes mid-test.

---

## Rollback

- Feature flag `INSRC_ANALYZER_WRITE_MODE=interleaved-legacy` flips back to the old path with no rebuild.
- The legacy interleaved path stays in `write-section.ts` alongside the new gather/write functions through Deliverable 3.
- Deliverable 4 (cleanup) only fires after 2-3 successful runs confirm parity. Even after cleanup, reverting requires only the deleted file -- one revert commit, no schema changes.

---

## Success criteria

For the first run on `insors-extraction` (the run #9 repo, same prompt):

- 12/12 sections shipped.
- **0 sections with duplicate-paragraph regressions** (run #9 had section 2 with 20+ duplicates).
- Median paragraph count per section: 5-10 (run #9: 52 in section 2 due to duplication).
- Median tool calls per section in Phase G: 8-15 (run #9: 55 in section 2 due to the duplication loop).
- ≥6 sections achieve a non-degraded R1 accept after itemwise patching.
- Picker decision rate: `weighted-items-addressed` ≥ 70% of sections (run #9 already at 80%+ on this signal).
- Median run time: comparable to run #9 (~4.7 hours). Phase G is faster per turn (no prose generation), Phase W adds one big call per section. Net should be a wash or slightly faster.

If any of these regress vs run #9, the locked decisions get revisited.
