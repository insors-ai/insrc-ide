# Plan: executeStep -- per-result summarization + bounded tool-result chunking

Status: drafted 2026-05-21, not yet started.
Owner: code-analyzer flow rework.
Supersedes: Phase β + ε in [plans/code-analyzer-discovery-plan-loop.md](code-analyzer-discovery-plan-loop.md) (the "single closing JSON envelope" design).

## Why

The Phase β `executeStep` design asks the local LLM to:

1. Run N skill_invoke / skill_describe / skill_load_page calls in a tool loop.
2. Hold all N tool_result blocks in its conversation history.
3. Emit ONE final JSON envelope summarizing all of them at the end.

Empirically (live runs against the HDFS corpus, May 2026), step 3 fails ~80%
of the time when the local model is `devstral-small-2:latest` on Ollama:

- Direct HTTP probe of the failing case (29-message conversation, ~10,971
  prompt tokens) reproduces the bug deterministically:
  - `eval_count: 147` (model generated 147 output tokens)
  - `done_reason: stop`
  - `content: ""`, `tool_calls: []`
  - All 147 tokens are dropped by Ollama's chat-template parser for Devstral.
- The failure persists at `num_ctx: 32768` (verified) -- it's not context
  pressure. It's a chat-template / output-grammar mismatch under the
  specific multi-turn pattern that long tool loops produce.
- The simple `mc=2` first inference of each step works 100% of the time
  (also verified, 5/5 probes identical). The failure regime is **deep
  multi-turn conversations** (~6-8k+ input tokens with many tool_use
  ↔ tool_result alternations).

The earlier `gatherEvidence` (legacy path) does not exhibit this failure
because it summarizes each skill result inline -- the model is never asked
to synthesize from a deep conversation. The Phase β optimization that
eliminated per-result summarization was a premature optimization that
exchanges 1 LLM call per skill for an entire step's worth of evidence
being lost when the closing envelope fails.

This plan reverts `executeStep` to gather-evidence's per-result pattern
while keeping the discovery-plan loop's outer architecture (cloud-planned
DiscoverySteps, cycle review, prose review) intact.

## Goals

- Stop asking the local LLM to emit a closing JSON envelope.
- Capture an `EvidenceEntry` immediately after each successful skill_invoke
  result (via a separate `summarizeResult` call), so partial step progress
  is preserved even when the outer tool loop degrades.
- Keep the chunking firewall: each summarizer call sees one bounded
  tool_result (~4KB), never the cumulative conversation. The deep-
  conversation regime that triggers Devstral's empty-text bug is
  unreachable from the summarizer.
- No change to the cycle reviewer, prose reviewer, or cloud-side
  plan expansion. Only `executeStep`'s internals + its `StepOutput`
  aggregation.

## Non-goals

- Replacing the local model. Devstral-Small-2 is fine for the work
  per-skill summarization actually demands (one bounded result at a
  time). This plan removes the workload it can't handle, not the model.
- Reworking `projectValueForLLM` or `safePreview`. The existing 4096-char
  / first-30-items chunking at the skill layer is correct and already
  wired in.
- Bringing back `skill_describe` enforcement (the gather-evidence "must
  describe before invoke" protocol). The static skill-catalog in the
  system prompt already documents arg shapes; we don't need the protocol
  to be load-bearing.

## Chunking flow (what already exists -- no changes needed)

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Skill.execute(args) -> raw value (can be megabytes)                 │
└────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌────────────────────────────────────────────────────────────────────────┐
│ 2. projectValueForLLM                                                  │
│    - First 30 items per top-level array                                │
│    - `__truncated` + `__totalCount` markers                            │
│    - Paging hint with spillId + fieldPath + next pageIndex             │
│    - Full value spilled to disk under SkillSpillRecord.spillId         │
└────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌────────────────────────────────────────────────────────────────────────┐
│ 3. safePreview                                                         │
│    - JSON.stringify(projected, null, 2)                                │
│    - Hard cap at 4096 chars                                            │
│    - Truncate marker if exceeded                                       │
└────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌────────────────────────────────────────────────────────────────────────┐
│ 4. tool_result content (≤4KB markdown)                                 │
└────────────────────────────────────────────────────────────────────────┘
                                  ↓
                ┌─────────────────┴──────────────────┐
                ↓                                    ↓
   appended to the tool-loop          summarizeResult (NEW per skill)
   conversation (so model can         small isolated context:
   pick next tool to call)              system (~500 tok)
                                        + section objective
                                        + review criteria
                                        + skillId + args
                                        + ONE tool_result (≤4KB)
                                        ~2-3k tokens total
                                      Returns EvidenceEntry,
                                      captured immediately.
```

**Key invariant**: the summarizer LLM call is bounded at ~2-3k tokens. The
Devstral empty-text bug requires ~6-8k+ tokens. So summarization is
structurally immune to the bug, regardless of how deep the outer tool
loop grows.

If a skill returns more than the first 30-item page that's relevant, the
**model** asks for the next page via `skill_load_page` in the outer loop.
Each `skill_load_page` result goes through steps 2-4 again -- bounded,
projected, capped -- and is independently summarized into its own
`EvidenceEntry`. Pagination is the model's responsibility; the
summarizer just keeps consuming page-sized tool_results.

## executeStep -- new control flow

Replace the current `runToolLoop` + `parseStepEmission` approach with a
manual loop mirroring `gatherEvidence` (with the discovery-plan plumbing
on top -- step intent, planned tasks, dependsOn). Pseudocode:

```ts
async function executeStep(input): Promise<StepOutput> {
  const evidence: EvidenceEntry[] = [];
  const calledSkillIds: string[] = [];

  const messages = [
    { role: 'system', content: buildStepSystemPrompt(repoSizeSummary) },
    { role: 'user',   content: buildStepUserPrompt(step, repoSizeSummary?.repoPath) },
  ];

  let iter = 0;
  let stopReason: 'completed' | 'no-tools' | 'max-iter' | 'empty-output' = 'max-iter';

  while (iter < MAX_ITERATIONS) {
    const resp = await provider.complete(messages, { tools, maxTokens });
    iter++;

    const text      = (resp.text ?? '').trim();
    const toolCalls = resp.toolCalls ?? [];

    // Stop A: model emitted text without tool calls -> done.
    if (toolCalls.length === 0) {
      stopReason = text.length === 0 ? 'empty-output' : 'no-tools';
      break;
    }

    // Append assistant turn (text + tool_use blocks) before dispatching.
    messages.push({ role: 'assistant', content: assembleAssistantBlocks(text, toolCalls) });

    const toolResultBlocks: ContentBlock[] = [];
    for (const call of toolCalls) {
      // Track which skills got called for status determination.
      if (call.name === 'skill_invoke' && typeof call.input.skillId === 'string') {
        calledSkillIds.push(call.input.skillId);
      }
      const result = await executeTool(call, { session });
      toolResultBlocks.push({
        type:        'tool_result',
        tool_use_id: call.id,
        content:     result.content,
        ...(result.isError === true ? { isError: true } : {}),
      });

      // Per-result summarization -- ONLY for skill_invoke. describe and
      // load_page don't produce evidence (load_page's page IS evidence,
      // but it's also tracked via the same skill_invoke pattern through
      // its parent; tracked separately below if needed).
      if (call.name === 'skill_invoke' && !result.isError) {
        const skillId = String(call.input.skillId);
        const args    = (call.input.args ?? {}) as Record<string, unknown>;
        try {
          const entry = await summarizeResult(provider, {
            skillId,
            args,
            resultText: result.content,
            objective:  step.intent,            // <-- step intent, not section objective
            criteria:   inferCriteriaForStep(step),
          });
          evidence.push(entry);
        } catch (err) {
          log.warn({ err: (err as Error).message, skillId }, 'executeStep: summarizeResult failed -- skipping entry');
        }
      }
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  // Aggregate the captured EvidenceEntry[] into a StepOutput.
  const facts = uniqueFlatten(evidence.map(e => e.facts));
  const citations = mergeCitations(evidence);  // dedup by path+range
  const status = determineStatus({
    facts, citations,
    calledSkillIds,
    plannedSkillCount: step.skills.length,
  });

  return {
    stepId: step.id,
    status,
    facts,
    citations,
    extraSkillsCalled: diff(calledSkillIds, plannedSkillIds),
    durationMs: Date.now() - t0,
  };
}
```

### What goes away

- `runToolLoop` call (manual loop replaces it).
- `parseStepEmission` and its tests.
- The "Final output (your LAST assistant turn) -- emit JSON envelope" block
  in `prompts/flow/execute-step/system.md`.
- The "fail step on parse error" branch -- a step only fails now when zero
  evidence entries got captured.

### What gets added

- `summarizeResult` call after each successful `skill_invoke` (reuses the
  existing `summarizeResult` from `gather-evidence.ts` -- exported and
  factored into a shared helper).
- Aggregation: collect `evidence: EvidenceEntry[]` over the loop, then
  flatten to the `StepOutput { facts, citations }` shape the rest of the
  discovery flow expects.
- `inferCriteriaForStep(step)`: derive 2-3 review criteria from
  `step.intent` + `step.targetsCriteria` (which already exists on
  `DiscoveryStep`). Phase β had no analogue because the closing envelope
  was the model's only output; now the summarizer needs criteria to
  evaluate each skill's relevance.

### Prompt changes

`prompts/flow/execute-step/system.md`:

- Remove the entire "Final output (your LAST assistant turn)" section
  including the envelope schema + hard rules on the envelope.
- Replace with: *"When you've completed the planned tasks (and any
  minimal extras you needed), just stop calling tools. The orchestrator
  is capturing structured evidence from every skill_invoke result as
  you go -- you don't have to summarise at the end."*
- Keep: compliance banner, skill catalog, How the user message is
  structured, DOs / DON'Ts (with `Do NOT call skill_describe more than
  once per skill per step` retained), anti-hallucination block,
  REPO_CONTEXT slot.

`buildStepUserPrompt` -- unchanged. The numbered task list + Chain hints
+ Workspace root directive stay. Only the system prompt loses the
envelope contract.

## Phases

### Phase 1 -- helper extraction (mechanical, no behavior change)

- Move `summarizeResult` out of `gather-evidence.ts` into a shared
  module: `agent/tasks/code-analyzer/summarize-result.ts`.
- Export `EVIDENCE_SUMMARY_SCHEMA` from the same module.
- Update `gather-evidence.ts` to import from the new location.
- Tests: `gather-evidence.test.ts` keeps passing as-is.

### Phase 2 -- rewrite executeStep

- Implement the new manual-loop control flow above.
- Drop `parseStepEmission` + `_buildStepSystemPromptForTest`
  (note: `_buildStepUserPromptForTest` stays).
- Update `prompts/flow/execute-step/system.md` per the prompt-changes
  list.
- Add `inferCriteriaForStep` helper.
- Aggregator: `mergeCitations` + `uniqueFlatten` for facts.

### Phase 2.5 -- compact tool_results in the outer conversation

This phase closes the gap noted in the risks table: even with per-result
summarization preserving evidence, the outer tool-loop conversation
still grows linearly with N tool_result blocks (~4KB each). At 4-5
iterations the conversation is ~10k tokens and Devstral's empty-text
bug starts triggering on the model's NEXT-TOOL-PICKING inference.
Capturing the evidence is safe but the loop can't make further
progress -- the model just stops.

Phase 2.5 keeps the outer conversation slim by REPLACING captured
tool_result blocks with short stub markers, so the active context
size stays roughly constant regardless of iteration count.

**Mechanic.** Each `EvidenceEntry` gets a synthetic id (e.g. `e_3`)
when it's pushed onto `evidence[]`. Immediately after the entry is
captured, the corresponding `tool_result` block in `messages[]` is
rewritten in-place from its full ~4KB content to a compact stub:

```
[skill_invoke #3 -> code.entity.locate-by-name(name="FSDirectory")
 captured as e_3:
   facts:      2 entries
   citations:  1 (path:/repo/.../FSDirectory.java#L1-L400)
   confidence: high
 raw result available via skill_load_page if needed.]
```

The stub is ~200-300 chars vs ~4096 chars for the raw tool_result -- a
~15x compaction. Across a step with 8 tool calls this drops the
outer conversation from ~33KB of tool_results to ~2KB of stubs.

**Sliding window option.** A conservative variant keeps the MOST
RECENT tool_result block uncompacted (so the model picking iteration
N+1's tool sees fresh data for iteration N) and only compacts entries
from iterations N-2 and earlier. This is the "rolling-window of one"
pattern. It costs ~4KB of overhead for marginal safety; recommend
shipping with full compaction first and only adding the window if
empirical results show the model needs the prior raw result.

**Implementation.**

```ts
// After the inner loop's per-call dispatch + summarization:
for (let i = 0; i < toolCalls.length; i++) {
  // ... dispatch ... summarize ...
  if (entry !== undefined) {
    const entryId = `e_${evidence.length}`;  // freshly pushed; .length is 1-based id
    // Rewrite the just-pushed tool_result block to its stub form.
    const tr = toolResultBlocks[i];
    if (tr !== undefined) {
      toolResultBlocks[i] = {
        type:        'tool_result',
        tool_use_id: tr.tool_use_id,
        content:     renderEntryStub(entryId, entry, skillId, args),
      };
    }
  }
}
```

`renderEntryStub` is a pure helper that formats the stub markdown
shown above. The full tool_result content is NOT preserved in
`messages[]` (the on-disk SkillSpillRecord retains the underlying
data via `skill_load_page` if anything ever needs to read it).

**What the model sees.** The next iteration's prompt looks like:

```
<system>
<user: task list, workspace root>
<assistant: text + tool_use s1, s2>
<user: tool_result stub for s1 (e_1, 2 facts), tool_result stub for s2 (e_2, 1 fact)>
<assistant: text + tool_use s3>
<user: tool_result stub for s3 (e_3, 3 facts)>
<assistant: -- about to be generated -->
```

The model sees what skills were called, that evidence was captured
from each, and how rich each capture was. It picks the next tool
based on that meta-information rather than re-reading the raw skill
output. Empirically this is exactly the information it needs --
the raw data is just N variations of "INode found at id X" /
"callers: []" type lookups, useful for evidence extraction but
not for next-step planning.

**Compaction marker schema (stable, parseable).**

```
[evidence e_<id>: <skillId>(<one-line-args>) -> facts=<N> cites=<M> conf=<level>]
[e.g.: evidence e_3: code.entity.locate-by-name(name="FSDirectory") -> facts=2 cites=1 conf=high]
```

Keep it short, structured, and machine-readable for our own log
mining. The model parses it as prose; we parse it as a marker.

**Conversation token-size budget after compaction.**

```
system           ~ 4,000 tokens (catalog + DOs/DONTs, fixed)
user (tasks)     ~   300 tokens
+ per-iteration:
   assistant     ~    80 tokens (text + tool_use blocks)
   tool_results  ~    50 tokens per tool call (the stub)

After 8 iterations with 2 tool calls each (16 captures):
  4000 + 300 + 8*(80 + 2*50)  =  4000 + 300 + 8*180  =  5,740 tokens
```

vs the un-compacted growth:

```
4000 + 300 + 8*(80 + 2*1300)  =  4000 + 300 + 8*2680  =  25,740 tokens
```

That's a 4-5x reduction at iteration 8 -- bringing the outer loop
from a regime where Devstral's empty-text bug triggers (~25k tokens)
into one where it's reliable (~6k tokens), through the whole step.

**Risks.**

- *Model can't see prior raw skill output*: in some cases the model
  may want to refine its next call based on what an earlier skill
  returned (e.g. "I saw entityId X; let me call summary on it").
  The stub carries the captured `facts` + `citations` IDs, which
  is the most useful subset; if the model needs the raw entityId
  it can re-call locate-by-name with a narrower filter. If this
  turns out to be material in practice, switch to sliding-window
  (uncompacted last tool_result).
- *Stub format drift*: the renderer is a fixed helper, tested
  separately. If the marker shape changes, update one place.
- *Compaction interacts with `skill_describe`/`skill_load_page`*:
  describe results are static skill docs (don't compact -- the
  model needs the schema); load_page results ARE evidence (they
  should be summarized + compacted like skill_invoke). Phase 2.5
  applies the compaction only to skill_invoke and skill_load_page
  tool_results; skill_describe results stay as-is.

### Phase 3 -- tests

- New unit tests for `executeStep` covering:
  - Per-skill_invoke result captures an EvidenceEntry.
  - skill_describe / skill_load_page results do NOT produce EvidenceEntry.
  - Error tool_result for skill_invoke does NOT produce EvidenceEntry
    (matches gather-evidence's behavior).
  - Aggregator: 3 entries with overlapping citations -> deduped.
  - Step terminates correctly on no-tools-emitted and on max-iter.
  - Returns `status: failed` only when evidence.length === 0.
- Retire tests that asserted parseStepEmission behavior.
- Add a regression test: when the LLM returns text="" + no toolCalls
  (the Devstral empty-text mode), executeStep still returns whatever
  evidence was captured up to that point -- not `failed` with empty
  arrays. THIS is the key behavioral change.
- Phase 2.5 tests:
  - `renderEntryStub` produces a stable, parseable marker for a known
    entry (golden test).
  - After dispatching a `skill_invoke` and summarizing, the corresponding
    `tool_result` block in `messages[]` is the stub, not the full result.
  - skill_describe `tool_result` blocks are NOT compacted.
  - skill_load_page `tool_result` blocks ARE compacted (treated like
    skill_invoke evidence).
  - End-to-end token-budget test: simulate a step with 8 iterations,
    assert that the outer conversation's total char count stays under
    a hard ceiling (e.g. 25,000 chars / ~8,300 tokens).

### Phase 4 -- live validation against Hadoop

- Build daemon, restart, run the same HDFS analyzer request that's
  been our test corpus.
- Compare against the legacy gather-evidence flow's last successful
  run (sections retained, total evidence count, prose verdicts).
- Acceptance: avg per-step `evidence.length > 0` on at least 60% of
  steps where the cloud's planned skills are well-formed. (Today: 0%
  on the failing pattern.)
- Log new telemetry: `executeStep: completed iter=N stopReason=...
  evidenceCount=N skillsCalledN=N` so we can diff across runs.

### Phase 5 -- cleanup

- Remove dead `parseStepEmission` + `extractJsonObject` if unused
  elsewhere. (Grep first; they're test-exported but the production
  path no longer needs them.)
- Update [plans/code-analyzer-discovery-plan-loop.md](code-analyzer-discovery-plan-loop.md)
  to mark Phase β + ε as superseded.

### Phase 6 -- decouple plan-step count from scope size

The current planner prompts ("Cycle 1: emit 2-10 steps") and the
per-tier coverage menus (S = "near-exhaustive, 8-15 calls", XL =
"6-10 calls for a typical section") couple TWO orthogonal axes:

- **Investigation depth per step** (how zoomed-in each plan step is)
- **Number of plan steps** (how many slices of the section to
  investigate in this cycle)

The bug: as you drill DOWN the scope (XL -> L -> M -> S), the actual
volume of "stuff worth investigating in a section" doesn't shrink --
it just surfaces at a finer granularity. A tier-S section reviewing
ONE file still needs ~6 investigation angles (exported entities,
callers, nested deps, lock model, persistence touches, error paths);
a tier-XL section surveying an architecture also needs ~6
investigation angles (one per major subsystem). What differs is the
ZOOM LEVEL of each step's intent, not the count.

Today's prompts conflate the two and push the cloud toward fewer
steps at higher tiers. That misshapes the plan: XL sections get 2-4
broad steps that each try to cover too much, while S sections get
8+ tightly-scoped steps that re-investigate the same file from
slightly different angles. Both regimes burn budget at the wrong
boundary.

**Reshape:**

1. **Detier the step count.** `prompts/flow/discovery-expand/system.md`
   currently says *"Cycle 1: emit 2-10 steps"*. Replace with:

   > Cycle 1: emit 4-8 steps per cycle, regardless of tier. The cloud
   > picks the count based on `reviewCriteria.length` -- aim for 1-2
   > steps per criterion. Cycle 2+ emits 2-5 steps targeted at
   > criteria still flagged `open` or `partial` in the cycle memory.

   This puts the count under the control of `reviewCriteria` (which
   the section-plan stage already calibrates to the section's
   complexity), not the section's tier.

2. **Reframe coverage-angles MDs as per-step depth menus.** The four
   files at `prompts/sections/coverage-angles/{s,m,l,xl}.md` currently
   read as "section-level investigation budgets". Rewrite each as a
   menu of "per-step investigation depth" -- describing what ONE plan
   step at this tier looks like:

   - **S (file-level)**: each step zooms in on ONE facet of ONE file
     (entities, callers, deps, locking, persistence, error paths).
     Each step calls 2-4 skills at fine granularity (every entity
     summary, every caller).
   - **M (module-level)**: each step zooms in on ONE submodule or
     ONE responsibility. 2-5 skills per step.
   - **L (multi-module)**: each step covers ONE cross-cutting
     concern across the modules in scope. 3-5 skills per step.
   - **XL (large slice)**: each step surveys ONE major subsystem
     or architectural layer. 3-5 skills at coarse granularity
     (module.describe + a few targeted summaries).

3. **Drop the "minimum / target / hard cap call count" language**
   from coverage-angles. Those numbers double-encoded the step count
   via "calls per section". With per-step skill count already capped
   at 1-5 in the discovery-expand prompt, the section-total call
   budget emerges from `step_count × per_step_skills`, which is
   already bounded by `maxIterations`. The MD shouldn't try to set
   another budget.

4. **Keep the "what to look for" lists in each tier's MD.** Those are
   still useful as advisory checklists -- they describe what an
   investigation at this depth would typically surface. Reword them
   from "do X then Y then Z for the section" to "for each plan step
   targeting this section, here are the depths and angles to pick
   from".

5. **planner-context/{s,m,l,xl}.md**: these are the cousin docs that
   describe how the section-PLAN stage uses each tier. Their
   coverage-menu cross-references stay valid (the menus still exist,
   just reframed). Verify the cross-refs land in the right paragraphs
   after the rewrite; tighten if they read awkwardly.

**Files touched:**

- `prompts/flow/discovery-expand/system.md` (planner prompt)
- `prompts/sections/coverage-angles/{s,m,l,xl}.md` (4 menus)
- `prompts/sections/planner-context/{s,m,l,xl}.md` (4 context blocks --
  verify cross-refs only, no semantic change)

**Risks:**

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cloud planner emits the wrong number of steps for a section (too few -> shallow; too many -> over-budget) | medium | The "4-8 per cycle" range is wide; the per-criterion guidance ("1-2 steps per criterion") anchors it to the section's criteria, which the section-plan stage already calibrates. Watch the first live run for distribution of step counts vs criteria counts. |
| Tier-XL sections lose depth because each step now picks coarser tools | low | The coverage-angles XL MD explicitly tells the cloud to use `module.describe` + targeted summaries per step. Same skills as before, just framed at the step level. |
| Tier-S sections lose breadth (only one facet per step) | low | The 4-8 step count per cycle preserves the breadth -- 6 steps × 1 facet each = 6 facets covered, matching today's typical 6-facet S section. |

**Tests:**

- Update existing tests that assert specific step-count language in
  the planner prompt (grep for `2-10` / step-count expectations in
  `__tests__/*discovery*.test.ts`).
- Add a golden test: the discovery-expand system prompt renders the
  same way across all four tiers EXCEPT the coverage-angles section
  (the only tier-conditional part). Catches regressions where someone
  re-introduces tier-conditional step-count language elsewhere.

### Phase 7 -- configurable eviction window (delayed compaction)

**Why.** The Phase 2.5 design rewrites a captured `tool_result` to its stub
*immediately*, in the same iteration the tool was dispatched. The
`trBlock.content = renderEntryStub(...)` mutation happens **before**
`messages.push({ role: 'user', content: toolResultBlocks })`, so the
model never sees the raw tool result in any subsequent inference call --
not even the *next* one. Every concrete handle the raw result carried
(32-char `entityId`, real `spillId`, file path, line range, etc.) is
gone the instant the next tool-picking turn begins.

Empirically (HDFS XL live run, 2026-05-22, post-Phase-6) this is
catastrophic:

- The model wants to chain `locate-by-name → entity.summary` /
  `entity.callers`, all of which take a 32-char hex `entityId`.
- `locate-by-name` returns the `entityId` inline in the raw
  `tool_result` -- but Phase 2.5 evicts that content before the next
  inference runs.
- The model has no in-context source of truth for the id, so it
  invents one (`d71f8c28-d9da-4c1d-bdda-3e1d7f1f9fba`, `0:0:code...`,
  `8e7f7b8e8e7b8e7f...`, etc.).
- Every fake id returns `entity-not-found`. The summarizer records
  that as evidence. The cycle reviewer correctly judges the evidence
  as worthless and returns `keep: []`. Three cycles in a row.
- Net: 500+ inference calls per section to ship a "no evidence
  available" paragraph. Same shape across every section in the run.

The stub also advertises `skill_load_page` as a recovery path
(`"raw result available via skill_load_page if needed"`), but the
`e_N` identifier in the stub is the orchestrator's evidence-array
index, *not* a real `spillId` -- there is nothing to load. The
promise is a lie, and the model burns iterations trying to honor it.

**Reshape.**

Separate the two concerns Phase 2.5 fused:

1. *Capturing structured evidence* (writing `EvidenceEntry` rows for
   the writer + reviewer downstream) -- runs eagerly per result,
   unchanged.
2. *Managing the model's context window* (replacing raw tool_result
   text with a stub) -- now driven by a sliding window.

Add `evictionWindow?: number | undefined` to `ExecuteStepInput`,
default `1`:

- **`evictionWindow = 1`** (default): the most-recent evidence-producing
  tool_result stays raw in the model's context. Everything older is
  stubbed. The model gets exactly one inference turn to extract IDs
  / paths from the raw result before it gets compacted.
- **`evictionWindow = 0`** (legacy): stub immediately, before the next
  inference -- the Phase 2.5 behavior preserved for the devstral
  empty-text scenarios where that workaround was originally added.
- **`evictionWindow = N`** for N > 1: keep the last N raw, useful
  for multi-hop chains (locate → load_page → summary) where the
  model needs handle continuity across several turns.

**Mechanic.**

- The in-place `trBlock.content = renderEntryStub(...)` mutation
  inside the inner for-loop is removed. The `tool_result` block
  ships into `messages[]` with raw content first.
- A new orchestrator-side array `evictableEntries: EvictableEntry[]`
  tracks `{ block, entryId, entry, skillId, args, evicted: boolean }`
  for each evidence-producing call, in insertion order.
- At the top of each `while` iteration -- right before
  `provider.complete(messages, ...)` -- `applyEvictionWindow` walks
  `evictableEntries`, leaves the most-recent `windowSize` untouched,
  and rewrites `block.content` to the stub for everything older
  (only once; the `evicted` flag guards against re-stubbing).
- `skill_describe` results stay raw (schema docs the model needs to
  reference); errored `skill_invoke` results stay raw (so the
  corrective-schema injection from S.1 stays visible). Only
  successful evidence-producing calls are evictable.

**Honest stub format.**

`renderEntryStub` is updated to:

- Stop advertising `skill_load_page` as a recovery path. The line
  `"raw result available via skill_load_page if needed"` is removed.
- Replace it with `"(original tool_result has been evicted from context;
  not recoverable)"`. The promise the orchestrator can keep, kept.
- Surface the captured `facts` + `citations` verbatim inside the stub
  (instead of just counts). After eviction the model still has the
  natural-language facts ("FSDirectory at hadoop-hdfs/.../FSDirectory.java
  lines 86-1563") in scope -- the same content the summarizer wrote.

Example output for `evictionWindow = 1` after iteration 3:

```
<system>
<user: task list, workspace root>

<assistant: iter1 text + tool_use s1>
<user: iter1 tool_result for s1 -- EVICTED stub>

<assistant: iter2 text + tool_use s2>
<user: iter2 tool_result for s2 -- EVICTED stub>

<assistant: iter3 text + tool_use s3>
<user: iter3 tool_result for s3 -- RAW>
<assistant: -- about to be generated -->
```

The model picks iteration 4's tool based on:
- Raw s3 result (most recent, full detail incl. concrete IDs)
- s1/s2 captured-facts stubs (natural-language summaries)
- Its own past assistant turns (text reasoning)

**Why this fixes the run we just watched.** With `evictionWindow = 1`:

- Iter 1: `locate-by-name(FSDirectory)` → raw result with real `entityId`.
- Iter 2: model can read the `entityId` from iter 1's raw output and
  call `entity.summary(entityId="a7f1c83b...")` with a real value.
- Iter 3: iter 1's tool_result is now stubbed (older than window), but
  by then the model has either chained off it or moved on.

The hallucination cascade we watched -- fake spillIds, fake entityIds,
fake hex strings -- becomes unreachable.

**Non-goals for Phase 7.**

- *Spilling raw content on eviction*: would let the model recover
  evicted results via `skill_load_page`. Possible but doubles disk
  writes and adds a backpath layer. Skip until empirical results
  show the window alone isn't enough.
- *Per-skill window overrides*: some skills (`code.source.module.describe`)
  return huge results that probably DO need immediate compaction, while
  others (`code.entity.locate-by-name`) are small and benefit from
  staying raw. Out of scope for Phase 7; revisit if mixed-size results
  cause budget pressure.

**Files touched.**

- `src/insrc/agent/tasks/code-analyzer/execute-step.ts`: add
  `evictionWindow` to `ExecuteStepInput`, refactor inner loop to delay
  eviction, add `applyEvictionWindow` helper, update `renderEntryStub`
  format.
- `src/insrc/agent/tasks/code-analyzer/__tests__/execute-step.test.ts`:
  update existing `renderEntryStub` golden tests for the new format,
  add unit tests for `applyEvictionWindow` covering `window = 0 / 1 / 2`
  and idempotent re-evict.
- This plan doc (Phase 7 section added; Phase 2.5 remains for history).

**Risks.**

| Risk | Likelihood | Mitigation |
|---|---|---|
| `evictionWindow = 1` raises iteration-N input tokens above the devstral empty-text threshold (~6-8k) | medium | The original Phase 2.5 motivation. Default is 1 (so one raw result + N-1 stubs); if devstral regresses, callers (e.g. legacy local-only paths) can pass `evictionWindow = 0` to restore Phase 2.5 behavior. Cloud providers (the current executeStep callsite per Phase 6.5) don't have this failure mode. |
| Eviction stub bloats with long facts/citations lists | low | Each `EvidenceEntry` is capped at 4 facts (`maxItems: 4` in `EVIDENCE_SUMMARY_SCHEMA`) and citations are small path strings. Total stub stays under ~500 chars even for chunky entries (existing `< 400 chars` golden test relaxes to `< 800`). |
| Window setting drifts across callers | low | Single optional field with a documented default; only set explicitly when a chain requires it. Default-1 is the right value for the discovery flow's planned skill chains. |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Doubled LLM cost (~2N inferences per step vs ~N today) | high | Acceptable. Today's N infers produces 0 evidence ~80% of the time; 2N infers producing real evidence is a strict improvement. Mitigate further later via batching or caching if it matters. |
| Summarizer LLM hits the empty-text bug too | low | Each call is ~2-3k tokens, well below the 6-8k threshold. Verified empirically in probe scripts. If it does happen, the entry is dropped (caught in try/catch) and the step proceeds; failure is bounded to one entry, not the whole step. |
| Reviewer reviews garbage EvidenceEntry from off-topic summaries | medium | summarizeResult already emits `confidence: 'low'` when the result is off-topic/empty. Cycle reviewer can filter by confidence in its `keep:` selection. |
| Citations don't dedup cleanly across entries | low | Citation has structured fields (`path`, `startLine`, `endLine`, `entityId`); dedup on `(path, startLine, endLine)` triple. Worst case: a few duplicates, which the writer's existing citation-uniqueness logic already handles. |
| Doubled latency makes section timeouts hit | medium | maxIterations stays at 16 but each iter is ~2 inferences now. Watch wall-clock per step in the live run; lower maxIterations to 10 if needed. |
| Compaction strips a raw detail the model needed for the next call | medium | Stub carries fact-count + citation refs. If empirically a problem, switch to sliding-window (keep last tool_result uncompacted). Worst case the model calls a duplicate skill_describe / re-locates an entity -- bounded cost. |
| EvidenceEntry id collisions across cycles | low | Ids are per-step (`e_<index_within_step>`). Step-scoped, not global. Cycle reviewer never sees the stubs anyway -- it sees the captured EvidenceEntry objects. |

## Open questions

- **inferCriteriaForStep**: where do step-level review criteria come from?
  Options: (a) the cloud's plan emits a `criteria: string[]` on each
  `DiscoveryStep` (small schema addition), (b) derive heuristically from
  `step.intent` + `step.targetsCriteria`, (c) reuse the section-level
  criteria for every step in that section. Lean toward (c) for Phase 1
  shipped, (a) as a follow-up.
- **Summarizer model choice**: provider is currently `input.localProvider`.
  Could route to cloud for higher-quality summaries at higher cost.
  Defer: keep local for now, revisit if quality is a problem post-rollout.

## Validation checklist

- [ ] All existing analyzer tests pass after Phase 1+2.
- [ ] New regression test: empty-text LLM response yields whatever evidence
      was captured, not status='failed' with empty arrays.
- [ ] Phase 2.5 tests pass: tool_results compact to stubs after capture;
      describe results stay full; total outer-conversation token budget
      caps in the simulated 8-iteration test.
- [ ] Live HDFS run: at least 60% of steps have evidence.length > 0.
- [ ] Live HDFS run: outer conversation at iteration 8+ stays under
      ~8k tokens (verified from the daemon log's inputTokens usage).
- [ ] Per-step wall-clock not worse than 2x today's failed-step duration.
- [ ] Phase β / ε docs updated to mark as superseded.
