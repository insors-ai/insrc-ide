# Code Analyzer -- structured review + work-item iteration

**Status:** ready
**Owner:** subhagho@gmail.com
**Surfaced:** 2026-05-16, during the live retest of `code-analyzer-interleaved-investigation.md` against the Hadoop repo.
**Predecessor:** [code-analyzer-interleaved-investigation.md](code-analyzer-interleaved-investigation.md) (Phases A-D landed in `06cec111236`).

---

## Context

The interleaved-investigation plan (A-D) fixed the writer side: paragraphs now interleave with tool calls, skills emit full-fidelity output, and the loop is eviction-aware. The live retest against `hadoop/` (12 sections, ~300 LLM calls) confirmed the writer side works -- every section produced real prose (textLength 800-2200 chars, 3-6 paragraphs, real DAO references for the one section that shipped).

**But the final report contained 11/12 placeholders** -- text like `_This section could not be drafted -- the writer failed both attempts._`. Cause: the round-1/round-2 review handling drops every draft that doesn't land an `accept` on round 2. With a strict cloud reviewer (Haiku) and a local writer (devstral-small-2), the cloud reviewer found something to refine on almost every section, round 2 produced a *shorter* draft (4/5 times in the retest -- median textLength dropped 56%), and the orchestrator threw both drafts away.

Detailed flow review documented in chat 2026-05-16. The ten distinct bugs in the round-1/2 handling collapse into one root cause:

> The reviewer hands back a single verbatim natural-language hint, the writer redrafts from scratch trying to address it, and the orchestrator binary-judges the second draft as ship-or-kill. There is no notion of "partial progress," no notion of "the issues are heterogeneous and need different treatments," and no way for the writer to make any of the existing draft survive into round 2.

Specifically:

- **The reviewer's hint is interpretive.** A sentence like "cite specific implementations (e.g., DatanodeManager, BlockPlacementPolicy, or heartbeat/block replication)" packs 3+ asks. The local writer picks a subset, the reviewer flags the rest as a fresh gap, round-2 verdicts refine, orchestrator kills the section.
- **Round 2 is a full redraft.** [write-section.ts:260-268](src/insrc/agent/tasks/code-analyzer/write-section.ts#L260-L268) wires the hint into a fresh investigation; round-1's draft is *not* in the round-2 prompt. The local model interprets "address this hint" as "write a new, narrower investigation," which is why round 2 trends shorter.
- **Round-2 verdict is binary ship-or-kill.** [code-analyzer-orchestrator.ts:862-865](src/insrc/daemon/controllers/code-analyzer-orchestrator.ts#L862-L865) (Fix 11.5) replaces draft2 with the placeholder when verdict is `refine`. Even when draft1 was solid, even when draft2 addressed *some* of the hint, the section dies.
- **Round 2's draft is always shipped, never compared to round 1.** [code-analyzer-orchestrator.ts:865](src/insrc/daemon/controllers/code-analyzer-orchestrator.ts#L865) ships `draft2.markdown` unconditionally on accept -- regardless of whether draft1 was longer / had more citations.

---

## Guiding principle: structured progress, not binary verdicts

The reviewer is judging *content*, not just *correctness*. Real editorial review produces a punch-list of heterogeneous changes: this paragraph is wrong, that one is thin, this section needs a topic added, that section needs to be cut. The writer addresses the list item by item. Some items get addressed, some get partial-progress, some get skipped with a reason. The final ship decision is a policy over the item statuses, not a single bit.

This plan rebuilds the reviewer + round-2 writer + ship decision around that model.

Specifically:

- **The reviewer emits a typed work-item list, not a hint string.** Each item has a kind (`fix` / `enhance` / `add` / `trim`), a where (paragraph or anchor), the issue, and the requested action.
- **The round-2 writer iterates over the work items.** For each item it decides which skills (if any) to call and patches the relevant paragraph. Output is patched-draft1 + per-item status.
- **The ship decision is policy over statuses, not verdict.** A section ships as long as the writer either addressed or honestly-skipped every `fix` item. `enhance` / `add` / `trim` items can remain partially-addressed without killing the section.
- **No more placeholder kill.** Replaced with "ship the best draft, flag unaddressed items in the TodoList ticket."

The trade-off: more structured output from the reviewer (slightly higher token cost per review) and more complex round-2 writer (must read its own draft + patch it). Worth it -- the current behaviour ships an empty report.

---

## Decisions (locked)

1. **Patch by default, redraft only when patch quality is bad.** Patch preserves what was good in round 1 -- that's the common case. Redraft is the escape hatch when (a) the writer doesn't follow the patch protocol at all, or (b) the patched draft is materially *worse* than the input draft on the G.2 picker signals. Most rounds should patch.
2. **3 rounds max** (initial draft + up to two patch passes). Round 1: write -> review. Round 2: patch -> review. Round 3: patch -> review. Ship the best-of-three by the G.2 picker. The third round catches the case where round 2 addressed half the items and round 3 can clear the rest; without it we'd ship draft2 with known-unaddressed `fix` items.
3. **Reviewer stays cloud (Haiku-class).** Structured-list output is easier than prose judgement, so a local reviewer is plausible, but cloud is still better at spotting factual issues. Revisit after the structured-review path lands.

---

## Plan

Six phases, ordered by dependency. Each is independently shippable. The plan is written for 3 rounds throughout; "round 2" and "round 3" use the same `patchSectionWithTools` entry point with different inputs.

### Phase E -- structured reviewer output

**Goal:** the reviewer emits a typed work-item list, replacing the single `refine.hint` string.

#### E.1 Define the work-item schema

**Location:** new types in [src/insrc/agent/content-gen/review-action.ts](src/insrc/agent/content-gen/review-action.ts).

```ts
export type WorkItemKind = 'fix' | 'enhance' | 'add' | 'trim';

export interface ReviewWorkItem {
  readonly id:       string;              // 'wi-1', 'wi-2', ...
  readonly kind:     WorkItemKind;
  readonly where:    string;              // 'paragraph 3' | 'section opening' | 'end of section'
  readonly issue:    string;              // one-sentence problem statement
  readonly action:   string;              // one-sentence concrete fix
  readonly evidenceRefs?: readonly string[]; // optional: ['evidence[2]'] referencing the evidence block
}

export interface ReviewActionResult {
  readonly verdict:    'accept' | 'needs-work';
  readonly workItems:  readonly ReviewWorkItem[];   // empty when verdict='accept'
  readonly accepted?:  { readonly markdown: string }; // optional polished rewrite (accept only)
  readonly notes:      readonly string[];
  readonly degraded:   boolean;
}
```

Kind semantics (these go into the reviewer system prompt as the taxonomy):

| Kind | Meaning | Typical writer action |
|---|---|---|
| `fix` | Factually wrong / unsupported claim in the draft | Call a skill to verify, then correct or remove the claim |
| `enhance` | Claim is correct but thin (missing citations, vague) | Call a skill for concrete evidence, then thicken the paragraph |
| `add` | Required coverage missing (a topic the criteria require) | Run a small sub-investigation, then add a new paragraph |
| `trim` | Redundant / off-topic content | Edit in place, no skill call needed |

The verdict shifts from `accept` / `refine` to `accept` / `needs-work` -- `needs-work` *always* carries `workItems` (validator enforces non-empty when verdict is `needs-work`). `accept` *always* carries empty `workItems`.

#### E.2 Rewrite the reviewer system prompt

**Location:** [review-action.ts:272-310](src/insrc/agent/content-gen/review-action.ts#L272-L310) (`SYSTEM_PROMPT`).

New prompt explicitly teaches the work-item taxonomy + bounded scope. Key rules:

- Each work item is **atomic** -- one paragraph or one anchor, one issue, one action. If you have three asks for the same paragraph, emit three items.
- `where` MUST point at something in the draft (paragraph N, "section opening", "section closing") -- not a vague region.
- `action` MUST be a single concrete step. Never list alternatives ("cite X or Y or Z" -> three items, one per cite).
- `fix` items are reserved for *factual* problems (the draft says something the evidence doesn't support). Stylistic issues use `enhance`. This matters because `fix` items gate shipping (Phase G).
- Cap total work items at 6 per round. If there are more than 6 issues, the reviewer picks the most-important 6. The cap is a soft signal to the writer that round 2 is bounded, not a deep restructure.
- `accept` is unchanged -- ship with optional polish. `accepted.markdown` MUST preserve clickable citations (kept from current prompt).

#### E.3 Update the JSON schema + validator

**Location:** [src/insrc/agent/content-gen/schema.ts](src/insrc/agent/content-gen/schema.ts) (`REVIEW_ACTION_SCHEMA`) and [review-action.ts:439-491](src/insrc/agent/content-gen/review-action.ts#L439-L491) (`validateReview`).

- Add `workItems` to the schema (array of typed work items, max 6).
- Validator enforces: `accept` -> `workItems.length === 0`; `needs-work` -> `workItems.length >= 1`; every item has all required fields; kind is one of the four; id is unique within the list.
- On validator failure: same retry-once-then-soft-accept pattern as today, but soft-accept emits `verdict: 'accept', workItems: []` so downstream code never sees a malformed list.

#### E.4 Persist the work-item list on the TodoList ticket

**Location:** [code-analyzer-orchestrator.ts:875-901](src/insrc/daemon/controllers/code-analyzer-orchestrator.ts#L875-L901).

Replace the `failureReason: review.refine.hint` line with a structured persistence: store the round-1 work-items + the round-2 statuses (Phase F). Surfaces in the TodoList ticket as a checklist the user can see.

---

### Phase F -- round-2 writer as work-item iterator

**Goal:** round 2 patches draft1 by iterating the work items, not redrafting from scratch.

#### F.1 New entry point: `patchSectionWithTools`

**Location:** new function in [src/insrc/agent/tasks/code-analyzer/write-section.ts](src/insrc/agent/tasks/code-analyzer/write-section.ts), alongside `writeSectionWithTools`.

```ts
export interface PatchSectionInput {
  // ... same provider/session/action/repoContext/repoSizeSummary as WriteSectionInput
  readonly draftMarkdown:        string;
  readonly workItems:            readonly ReviewWorkItem[];
  readonly priorDescribedSkills: ReadonlySet<string>;
  readonly priorSkillCalls:      readonly CapturedSkillCall[]; // so reviewer can score across rounds
}

export interface WorkItemStatus {
  readonly id:        string;
  readonly status:    'addressed' | 'partial' | 'skipped';
  readonly reason?:   string;            // required when status != 'addressed'
}

export interface PatchSectionOutput extends WriteSectionOutput {
  readonly itemStatuses: readonly WorkItemStatus[];
}
```

#### F.2 Patch protocol -- the writer's contract

The writer system prompt for the patch loop differs from the original investigation prompt:

```
You are revising a section draft. You will receive:
  - The current draft markdown (numbered paragraphs).
  - A list of work items the reviewer flagged.
  - The tools you used during the first draft (so you know what skills exist).

For each work item in order:
  1. State which paragraph(s) you will touch and what kind of change (fix/enhance/add/trim).
  2. Call any skills you need to gather evidence for the change.
  3. Emit the patched paragraph(s) in a fenced block tagged with the item id:
     ```patch:wi-3
     <new paragraph content>
     ```
     For `add`: tag the block with the anchor: ```patch:wi-3 after=paragraph-5
     For `trim`: emit an empty block (deletion).
  4. If you cannot address the item, emit:
     ```skip:wi-3
     <one-sentence reason>
     ```

After the last item, emit a single closing paragraph (no fenced block) summarising what changed.
```

Parsing: the orchestrator (or a helper in `write-section.ts`) walks the final assistant turns and extracts `patch:<id>` / `skip:<id>` blocks. The patches are applied to draft1 in order; the result is patched-draft + the per-item status list.

#### F.3 Patch application

**Location:** new helper `applyPatches(draft, patches)` in [src/insrc/agent/tasks/code-analyzer/](src/insrc/agent/tasks/code-analyzer/) (own file, easy to test).

- Parse draft1 into a list of paragraphs (split on `\n\n`).
- For each patch:
  - `fix` / `enhance`: replace the targeted paragraph (resolved from `where`).
  - `add`: insert after the anchor paragraph.
  - `trim`: delete the targeted paragraph.
- If a `where` field can't be resolved to a paragraph index, fall back to "append the patch to the end of the section" and mark the item `status: 'partial', reason: 'where unresolved'`.
- Re-join paragraphs into markdown.

#### F.4 Redraft escape hatch -- quality-driven, not just protocol-driven

The redraft escape hatch fires in *either* of two cases:

1. **Protocol non-compliance:** the writer's output contains no `patch:<id>` / `skip:<id>` blocks at all. The model didn't follow the patch contract.
2. **Quality regression:** the patched draft scores materially worse than the input draft on the G.2 picker signals (zero `fix` items addressed *and* citation count dropped *and* paragraph count dropped). The writer "patched" the draft into something worse.

In either case, fall back to a fresh `writeSectionWithTools` call with the work-item list compressed into a hint string (concatenate the `action` fields). Accept whatever prose comes back as the round-N draft; it then competes against earlier rounds in the G.2 picker. Log the fallback at `warn` level with the case reason so we can measure protocol-compliance and patch-quality over time.

Patch should be the common case. If retest shows redraft fallback firing on >30% of rounds, revisit the patch protocol design (Phase F.2).

#### F.5 Orchestrator wires F.1 in place of round-2 and round-3 redrafts

**Location:** [code-analyzer-orchestrator.ts:828-865](src/insrc/daemon/controllers/code-analyzer-orchestrator.ts#L828-L865).

Replace the entire round-2 block with a 3-round loop:

```ts
let drafts: { round: 1 | 2 | 3; draft: WriteOrPatchOutput; review: ReviewActionResult }[] = [];
let current = await writeSectionWithTools({ ... });
let review  = await reviewDraft(current);
drafts.push({ round: 1, draft: current, review });

for (let r = 2; r <= 3 && review.verdict === 'needs-work'; r++) {
  current = await patchSectionWithTools({
    draftMarkdown:        current.markdown,
    workItems:            review.workItems,
    priorDescribedSkills: current.describedSkills,
    priorSkillCalls:      current.skillCalls,
    // ... rest
  });
  review = await reviewDraft(current);
  drafts.push({ round: r, draft: current, review });
}
```

After the loop, hand `drafts` + `review` to Phase G's ship decision. The orchestrator has every round's draft + statuses for the picker.

---

### Phase G -- ship decision policy

**Goal:** replace the placeholder kill with a policy over work-item statuses + a best-of-rounds picker.

#### G.1 Ship policy

**Location:** [code-analyzer-orchestrator.ts:857-865](src/insrc/daemon/controllers/code-analyzer-orchestrator.ts#L857-L865) (delete Fix 11.5).

```
# After the 3-round loop in F.5, `drafts` holds every round's output.
# Each entry: { round: 1|2|3, draft, review }.

# Short-circuit: if any round verdict'd accept, ship that round's draft.
acceptRound = drafts.find(d => d.review.verdict === 'accept')
if acceptRound:
    ship acceptRound.draft.markdown (or review.accepted?.markdown if present)
    return

# All rounds verdict'd needs-work. Pick the best draft (G.2).
winner = bestOfRounds(drafts)                       # see G.2
ship winner.draft.markdown + footer (G.3)
```

No section ever ships as a placeholder. The worst case is "ship round 1 with a footer listing unaddressed items."

#### G.2 Best-of-rounds picker

The picker scores every draft (up to 3) on objective signals, not the cloud reviewer's verdict, and returns the winner. Order of preference:

1. **Cumulative `fix` items addressed**: the draft that addressed the most `fix` items across its inbound work-list wins (correctness wins). Round 3's input was round 2's leftovers, so the cumulative count rolls forward.
2. **Citation count**: prefer the draft with more `[label](path:file#Lstart-Lend)` links (the existing `countCitations` regex).
3. **Paragraph count**: prefer the draft with more paragraphs (more coverage).
4. **Text length**: tie-breaker.

If a later round regressed on every signal (`fix` count = 0 addressed, fewer citations, fewer paragraphs, shorter), it loses to the earlier round even though the loop ran. This is what defends against the "round 2 makes things worse" pattern we saw on 2026-05-16.

The picker is pure code, easy to test. Logs which signal drove the choice + which round won so we can audit on metrics runs.

#### G.3 Section footer for unaddressed items

When any work items remain unaddressed (`skipped` or `partial`), append a small footer to the section:

```
---
_Reviewer flagged 3 follow-ups that this draft did not fully address: enhance paragraph 2 with concrete file:line refs; add coverage of rack-awareness; fix the claim about replication factor defaults. See the TodoList item for details._
```

The footer is informational, not a placeholder. The section *content* is still the best draft.

#### G.4 TodoList ticket carries the full record

**Location:** [code-analyzer-orchestrator.ts:875-901](src/insrc/daemon/controllers/code-analyzer-orchestrator.ts#L875-L901).

The ticket meta gets:

```ts
{
  // ... existing fields
  reviewRounds: [
    { round: 1, workItems: [...], itemStatuses: undefined },  // round 1 has no statuses (initial draft)
    { round: 2, workItems: [...], itemStatuses: [...] },      // patch input + outcomes
    { round: 3, workItems: [...], itemStatuses: [...] },      // present only if 3 rounds ran
  ],
  rounds:             1 | 2 | 3,
  shippedDraft:       'round1' | 'round2' | 'round3',          // which draft won G.2
  shipDecisionReason: string,                                  // 'fix-items-addressed' | 'citation-count' | ...
}
```

The TodoList view can render this as a checklist with strike-through on addressed items.

---

### Phase H -- migration + cleanup

#### H.1 Delete the deprecated text-only path

[`expandThenReview`](src/insrc/agent/content-gen/review-action.ts#L168-L266) is already marked deprecated (no production callers). Delete it; the test that asserts the 2-round contract moves to cover `patchSectionWithTools` instead.

#### H.2 Update the existing reviewer tests

**Location:** [src/insrc/agent/content-gen/__tests__/](src/insrc/agent/content-gen/__tests__/).

- `validateReview` tests: drop `refine.hint` cases, add `needs-work` + `workItems` cases.
- `buildReviewMessages` snapshot: regenerate.
- Add a test that the validator rejects `accept` with non-empty `workItems` and `needs-work` with empty `workItems`.

#### H.3 Confidence semantics

[code-analyzer-orchestrator.ts:867-873](src/insrc/daemon/controllers/code-analyzer-orchestrator.ts#L867-L873) (Fix 11.6) currently keys confidence off verdict + rounds. New scheme:

| Outcome | Confidence |
|---|---|
| `accept` round 1 | `high` |
| `accept` round 2 or 3 | `medium` |
| All rounds `needs-work` but all `fix` items addressed | `medium` |
| All rounds `needs-work` and some `fix` items unaddressed | `low` |

Stops conflating "all items addressed but reviewer is picky" with "factually wrong."

---

### Phase I -- instrumentation + retest

#### I.1 Per-section metrics extension

**Location:** [code-analyzer:write-section](src/insrc/agent/tasks/code-analyzer/write-section.ts) log line (Phase D.1) extended with:

- `roundsRun: 1 | 2 | 3`
- `workItemsR1: number` (work items reviewer asked for after round 1)
- `workItemsR2: number` (after round 2, present only if 3 rounds ran)
- `itemsAddressedR2: number`
- `itemsAddressedR3: number`
- `fixItemsUnaddressedFinal: number` (count remaining after the last round)
- `shippedDraft: 'round1' | 'round2' | 'round3'`
- `shipDecisionReason: string`
- `patchProtocolFollowedR2: boolean | undefined`
- `patchProtocolFollowedR3: boolean | undefined`
- `redraftFallbackFired: boolean` (true if F.4 escape hatch fired in any round)
- `redraftFallbackReason: 'protocol' | 'quality' | undefined`

#### I.2 Update `scripts/analyzer-metrics.ts`

Add columns for the new metrics. The aggregates section gets:

- rounds distribution (% of sections that stopped at round 1 / 2 / 3)
- patch-protocol compliance rate (rounds 2 + 3 combined)
- redraft-fallback rate, split by reason (protocol vs quality)
- cumulative `fix`-item address rate
- shipped-draft distribution (% from round 1 / 2 / 3)

#### I.3 Live retest against the same Hadoop run

Same 12-section plan as 2026-05-16. Success criteria:

- 12/12 sections ship with content (not 1/12).
- ≥80% of `fix` items addressed by the time the loop terminates.
- Patch protocol followed on ≥70% of round-2 + round-3 runs.
- Redraft fallback fires on <30% of rounds.
- The winning draft is not always round 1 (i.e. the iteration is doing real work) and not always the last round (i.e. the picker is rejecting regressions).

If the local model can't follow the patch protocol (F.4 fallback fires on >30% of rounds), revisit F.2 -- simpler protocol or move the patch loop to the cloud reviewer.

---

### Phase J -- writer-prompt fixes for framing-collapse + transition-phrase terminal

**Goal:** the round-1 writer stops collapsing into pure framing / process-narration when the loop runs short. Two distinct fixes from the 2026-05-16 trace investigation, both affect *all* rounds (round 1 + the new patch rounds), and both are independent of the structured-review work in Phases E-G -- this phase can ship first.

**Trigger evidence:** in the 2026-05-16 Hadoop run, two specific collapse shapes recurred:
- **Mode A -- premature exit on a transition phrase.** Writer produced one solid paragraph with citations, then emitted "Let me now investigate the distinction between unit and integration tests..." as its final prose. `stop_reason: end_turn` fired; no follow-up tool call. (Section 8 R2.)
- **Mode B -- framing-only.** Writer opened with "I will investigate Hadoop's configuration management, security mechanisms, and high-availability mechanisms by examining..." -- 443 chars of framing -- called `skill_describe` once, never invoked a skill, ended. (Section 11 R2.)

Both modes violate the writer's *own* prompt rules ([write-section.ts:194-195](src/insrc/agent/tasks/code-analyzer/write-section.ts#L194-L195) explicitly forbids "Let me check...", "I'll now investigate...", "Next, I need to..."). Root cause: the "first turn: paragraph framing what you'll investigate" instruction at [write-section.ts:134-135](src/insrc/agent/tasks/code-analyzer/write-section.ts#L134-L135) is a *positive* shape example, whereas the don't-narrate-process rule is *negative*. Positive examples win over negative warnings for small models.

#### J.1 Subject-framing rewrite of the system prompt

**Location:** [write-section.ts:115-229](src/insrc/agent/tasks/code-analyzer/write-section.ts#L115-L229) (`SYSTEM_PROMPT_INTRO`).

Rewrite the turn-shape section so framing is about the *subject*, not the act of investigating:

```
First turn:    Open with a topic sentence about the SUBJECT you are
               about to describe. Do NOT narrate your process. Then a
               tool call.

               WRONG: "I will investigate the test architecture by
               examining unit and integration test modules across HDFS,
               MapReduce, and YARN..."
               RIGHT: "The test architecture spans three repository
               module trees (HDFS, MapReduce, YARN), with each tree
               carrying its own `src/test/java/` hierarchy and a
               distinct cluster-simulation fixture."

  Mid turn:    Each paragraph states a SPECIFIC fact from the previous
               tool result -- entity name, file path with line range,
               a count or a quoted constant. The paragraph is the
               persistent record of what you learned. Then either
               another tool call or no tool call.

  Final turn:  A closing paragraph naming the most important takeaway
               from the investigation as a whole. NO tool call. The
               loop exits here.

               If you have more to investigate, DO NOT close. Make
               the next tool call instead. Never write "Let me now
               investigate X" as a closing -- if X is worth
               investigating, call the tool. If it isn't, omit X.
```

Key changes vs current prompt:
- "Frame what you'll investigate" -> "open with a topic sentence about the SUBJECT." Removes the meta-narration template.
- WRONG/RIGHT examples for the first turn make the prohibition concrete.
- "If you have more to investigate, DO NOT close" explicitly disarms the transition-phrase terminal pattern.
- "What NOT to write" section keeps the forbidden-phrase list but adds: "These phrases also MUST NOT appear as the last sentence of any turn -- if you write one, the next thing you emit must be the announced tool call, not `end_turn`."

#### J.2 Transition-phrase nudge (orchestrator-side guardrail)

**Location:** [src/insrc/agent/tools/loop.ts](src/insrc/agent/tools/loop.ts) (the `runToolLoop` core).

Defence in depth in case the prompt rewrite alone isn't enough. After each assistant turn, inspect the turn's final paragraph: if it ends with a transition phrase (`Let me`, `I'll now`, `Next, I`, `I will now`, case-insensitive, anchored at start of last paragraph), the loop does NOT exit even if `stop_reason: end_turn` fired. Instead it:

1. Emits a synthetic user message: `Your last paragraph announced an action ("<first 80 chars of the trailing line>") but you did not execute it. Either make the tool call you announced, or rewrite the closing paragraph without the announcement.`
2. Loops once more.

The nudge fires at most once per section (a counter on the loop state). If the model emits a second transition-phrase ending after the nudge, the loop accepts the output as-is -- we don't want to fight the model into an infinite loop.

The nudge is OFF for `patchSectionWithTools` (Phase F) because the patch protocol's output shape doesn't have a "closing paragraph" -- it has `patch:<id>` blocks, so transition-phrase detection wouldn't make sense.

#### J.3 Test coverage

**Location:** [src/insrc/agent/tools/__tests__/loop.test.ts](src/insrc/agent/tools/__tests__/loop.test.ts).

Three tests:
1. Loop accepts a final turn whose last paragraph does NOT match the transition pattern (no nudge fired).
2. Loop fires the nudge exactly once on a transition-phrase ending, then exits after the model's next response.
3. Loop accepts a second transition-phrase ending without infinite-looping (nudge limit honored).

#### J.4 Instrumentation

**Location:** [code-analyzer:write-section](src/insrc/agent/tasks/code-analyzer/write-section.ts) log line (Phase D.1).

Add:
- `transitionPhraseNudgeFired: boolean`
- `firstTurnFramingDetected: boolean` -- regex against the first turn's text matching the WRONG-pattern in J.1 ("I will investigate...", "Let me start by..."). Lets us measure whether the prompt rewrite landed.

#### J.5 Standalone retest

This phase is shippable independently of Phases E-G. If retested against the same Hadoop run *before* the structured-review work lands, success looks like:
- `firstTurnFramingDetected` drops well below 50% (it was ~100% in the 2026-05-16 run).
- Mode-A collapses (transition-phrase as terminal) drop to zero on round 1 -- the round-1 loop has no `refineHint` pressure, so the prompt rewrite alone should land.
- Median round-1 textLength does not drop (this is a defence: the prompt rewrite shouldn't make sections *shorter*).

If those metrics improve, ship J standalone. The structured-review work in E-G then layers on top to fix the round-2-specific kills.

---

## Out of scope

- Replacing the reviewer with a local model (Decision 3 above). Worth measuring on a future run, not this plan.
- Changing the 6-item cap. The cap is a heuristic; revisit if retest shows we're frequently hitting it.
- Reviewer round 3. The cap stays at 2.
- Migrating the `data-analyzer` reviewer. This plan touches the code-analyzer path only. The data-analyzer (`runFollowupExpandReviewSynthesise` in the same orchestrator) uses `expandThenReview` and would need its own pass.

## Rollback plan

- Phase E: pure additive (schema + prompt). Reverting drops the `workItems` field; downstream code reads `refine.hint` as today.
- Phase F: keep the old `writeSectionWithTools({ refineHint, ... })` round-2 call path next to the new `patchSectionWithTools` path; gate on a private flag during Phase I retest. Once retest passes, delete the old path.
- Phase G: the placeholder kill (Fix 11.5) is the only thing that gets deleted. Reverting one commit restores it.

## Open questions

- **How does the writer's `where` field resolve to a paragraph index?** If the reviewer says "paragraph 3" and the writer's `applyPatches` reads from a renumbered draft, the mapping has to be stable. Phase F.3 takes the simple approach (split on `\n\n`, 1-indexed); document this in the reviewer prompt so the reviewer counts the same way.
- **What if the round-2 writer wants to add a new item that wasn't in the reviewer's list?** Today the answer is "no" -- the patch loop is strictly over the reviewer's items. If retest shows the writer reasonably wants to fix things the reviewer missed, we'd add a `discretionary` slot in PatchSectionOutput. Skip for now.
- **Does the work-item list survive into the report itself?** No. Items are TodoList-only. The report is for the human reader; the TodoList is for the operator/dev. Phase G.3 footer is the only user-visible surface.
