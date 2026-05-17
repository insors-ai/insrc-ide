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

#### H.1 Trim the deprecated text-only path

[`expandThenReview`](src/insrc/agent/content-gen/review-action.ts) was originally marked deprecated as "no production callers." That was wrong: the **data-analyzer** orchestrator (`runFollowupExpandReviewSynthesise`) still uses it. Migrating the data-analyzer to the new patch loop is out of scope for this plan, so H.1 is *partial*:

  - The code-analyzer orchestrator no longer calls `expandThenReview` (Phase F.5 replaced it with the 3-round patch loop).
  - `expandThenReview` is kept alive in `review-action.ts` for the data-analyzer caller. The Phase E bridge (collapse `workItems[]` to a hint string) lives inside it.
  - The legacy reviewer test suite that tested the 2-round contract via `expandThenReview` is dropped; the 3-round patch loop is exercised through `apply-patches`, `pick-best-draft`, and (eventually) the orchestrator integration test. The `plan-expand-review-integration.test.ts` was rewritten to test `planActions` + `reviewAction` directly without the wrapper.

Full deletion lands when the data-analyzer migration ships in a follow-up plan.

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

## Live retest 2026-05-16 (run #2)

After Phases E-J shipped (commits `e6a1f6f5afc` → `590cc5dc40e`), a second `/code-analyze` run was driven against the same Hadoop repo. The planner produced 8 sections (vs 12 in the first run -- different scope tier). All 8 sections shipped with content; **0 placeholder kills** (vs 11/12 in the first run). Report at `~/.insrc/tmp/<sessionId>/reports/turn-1.md`, 21,778 bytes (~4.5x the first run's 4,801).

### Macro outcomes

| Metric | Run #1 (2026-05-16 #1) | Run #2 (2026-05-16 #2) |
|---|---|---|
| Sections shipped | 1 / 12 (rest were placeholders) | **8 / 8** |
| Report size | 4,801 bytes | **21,778 bytes** |
| `firstTurnFramingDetected` rate | ~100% | **0%** |
| Transition-phrase nudge fires | n/a | 0 (never needed -- J.1 prompt rewrite is sufficient) |
| Patch-protocol compliance | n/a | **1 / 7 patch calls** (14%; target was ≥70%) |
| F.4 redraft fallback fires | n/a | **6 / 7 patch calls** (target was <30%) |
| Real (non-degraded) accept verdicts | n/a | **0 / 8 sections** |
| Sections where shipping went through the picker | n/a | 2 / 8 (sections 3, 4) |
| Sections shipped via degraded soft-accept | n/a | 5 / 8 (sections 1, 2, 6, 7, 8) |
| Sections that shipped a worse round-2 over a better round-1 because of the degraded short-circuit | n/a | **2 / 8** (sections 5, 7) |

### Per-section table

| # | Section | Round | Reason | Conf | Notes |
|---|---|---|---|---|---|
| 1 | Hadoop Project Scope & Mission | 2 | accept@round2 (degraded) | medium | Patch produced 2 of 6 items; reviewer JSON parse failed twice |
| 2 | HDFS NameNode | 1 | accept@round1 (degraded) | high | No patch round ran; degraded soft-accept |
| 3 | Hadoop Common Utilities | 1 | **picker: paragraph-count** | medium | Patch failed R2 + R3; round 1 won correctly |
| 4 | MapReduce Batch Processing | 1 | **picker: citation-count** | **low** | 1 fix item still pending; confidence reflects it |
| 5 | YARN Resource Management | 2 | accept@round2 (degraded) | medium | **Lost content**: 1186-char redraft shipped over 3659-char round 1 |
| 6 | Language Composition | 1 | accept@round1 (degraded) | high | 960 chars / 0 citations; misleading "high" confidence |
| 7 | Module Hierarchy | 2 | accept@round2 (degraded) | medium | **Lost content**: 1080-char redraft shipped over 5130-char round 1 |
| 8 | Codebase Scale | 1 | accept@round1 (degraded) | high | 6810 chars; degraded soft-accept harmless here (no patch round) |

### Wins (don't regress these)

- **Subject-framing prompt landed everywhere.** `firstTurnFramingDetected: false` on all 8 sections. No "I will investigate..." openers.
- **Transition-phrase nudge never fired** -- the prompt rewrite alone was enough for the writer (round 1) loop.
- **Picker correctly defends against regressions** when it gets to run. Sections 3 and 4 both shipped round-1 over weaker patch rounds.
- **No placeholder kills.** The whole point of Phase G's redesign held up under the patch protocol's near-total failure.
- **Confidence H/M/L semantics are right** (`confidence: low` on section 4 because there's a `fix` item pending; medium on picker wins with no fix pending).
- **TodoList per-round trace persists.** `reviewRounds` array with workItems + itemStatuses serialises cleanly through `updateItemMeta`.

### Failure clusters surfaced

Three issues, ranked by severity:

1. **P0 -- Degraded soft-accept short-circuits the picker** (sections 5, 7). The reviewer's structured output exceeds the 800-token output cap, both attempts return malformed JSON, the soft-accept path returns `verdict='accept'` with `workItems=[]`, and the orchestrator's `acceptIdx >= 0` short-circuit ships that round's draft -- bypassing the picker that would have chosen the better round. Net effect: a thinner, citation-poor F.4 redraft beats a richer round 1.
2. **P0 -- Patch protocol systemically fails** (6 of 7 patch calls produced 0 patch blocks). The model emits prose narration where the prompt asks for fenced `patch:<id>` blocks. The orchestrator parses 0 blocks, marks all items `skipped`, falls back to F.4 redraft. The redraft is consistently shorter than round 1 (231 / 363 / 988 / 1080 / 1186 chars vs round 1 averaging 2-5k). The picker rescues shipping by choosing round 1, but the work-item list never gets addressed.
3. **P1 -- Reviewer max_tokens crisis** (every section). `DEFAULT_MAX_TOKENS=800` was sized for the old `{verdict, refine.hint}` shape. The new schema's six work items each carrying `id+kind+where+issue+action` fields easily exceed 800 output tokens; truncation lands mid-string; the validator rejects; one retry fails the same way; soft-accept fires. We hit this on every reviewer call. Cause of #1 above.

### Compounded findings

The transition-phrase pattern J.2 was meant to catch did sneak back in -- but through a different surface than the writer-turn nudge can see. The `patch:wi-N` block bodies contain phrases like "Next, I will examine the MapReduce module" -- they get pasted into the section verbatim by `applyPatches`. The nudge scans the outer turn text, not patch-body content, so it doesn't catch this. Fixable at the patch-prompt layer (see L.2 below).

---

## Follow-up plan (run #2 fix batch)

Five new phases organized by severity. The dependency order is K → L → M → N → O. K is P0 reliability; L addresses the patch protocol viability that drove most of the run's degraded outcomes; M-O are quality improvements that ride on top.

### Phase K -- reliability P0 (must land before the next retest)

#### K.1 Picker excludes degraded-accept candidates

**Why:** [pick-best-draft.ts](src/insrc/agent/tasks/code-analyzer/pick-best-draft.ts) is only invoked when no round verdicted `accept`. The orchestrator's `acceptIdx = candidates.findIndex(c => c.review.verdict === 'accept')` short-circuit doesn't distinguish a real accept from a degraded soft-accept. The soft-accept path in [reviewAction](src/insrc/agent/content-gen/review-action.ts) returns `verdict='accept', workItems=[], degraded=true` -- and the orchestrator treats it identically to a real accept.

**Fix:** the short-circuit must require `review.verdict === 'accept' && review.degraded === false`. Degraded accepts fall through to the picker. The picker then scores every round (including the degraded one) and chooses by the existing lexicographic order. A round with content but a degraded review usually wins on text-length / paragraphs.

**Test:** add a test in `pick-best-draft.test.ts` exercising the "two rounds, first verdicted needs-work cleanly, second verdicted degraded-accept" case -- the picker should fire and pick the better round, not the degraded one.

**Impact:** sections 5 and 7 of run #2 would have shipped round 1's 3659- and 5130-char drafts instead of the 1186- and 1080-char redrafts.

#### K.2 Raise the reviewer output budget

**Why:** the live run had **every** reviewer call hit `stopReason: max_tokens` at some point. Output cap of 800 is wrong for the new schema -- one workItem already runs ~400-500 chars formatted as JSON; six items × ~450 chars ≈ 900 tokens before `accepted.markdown` polish.

**Fix:** [review-action.ts](src/insrc/agent/content-gen/review-action.ts) `DEFAULT_MAX_TOKENS` from 800 → **2500**. Test that the existing reviewer tests still pass with the higher cap (provider stubs ignore maxTokens, so this is paperwork).

**Side effect:** higher cost per review call. Worth it -- a broken reviewer is far worse than a slightly more expensive one. Phase K.3 below compresses the schema to claw back some of the budget.

#### K.3 Compact the workItem field shape

**Why:** the `issue` and `action` fields are free-form sentences with no length cap. The reviewer routinely writes 200-char `action` strings. Six items × 200 char actions ≈ 1200 chars on action alone.

**Fix:** add `maxLength` to the schema (`issue`: 150, `action`: 150). Update the system prompt to make the cap explicit -- "Keep `issue` and `action` to one short sentence (≤150 chars each)." Validator already enforces non-empty; extend it to enforce ≤200 chars (a touch above the soft target to allow some slack).

**Side effect:** the reviewer occasionally needs more nuance than 150 chars allows. Acceptable trade -- the writer doesn't read prose nuance well anyway; a shorter directive is more likely to be obeyed.

#### K.4 Distinguish degraded soft-accept from real accept in metrics + UI

**Why:** the per-section log line emits `shipDecisionReason: 'accept@round2'` whether the accept was a real or degraded one. The TodoList persisted `reviewRounds[i].verdict === 'accept'` regardless. The user can't tell from the report or TodoList whether the reviewer actually approved the draft or crashed and we shipped by default.

**Fix:** propagate `review.degraded` into the orchestrator's per-round trace and the section-complete log line. Add `degradedReviews: number` to the section summary (count of rounds where the review was degraded). Confidence semantics adjust:
- Real `accept @ round 1` → high
- Real `accept @ round 2/3` → medium
- Degraded `accept` at ANY round → medium (not high; reviewer didn't actually approve)
- All `needs-work` + no `fix` pending → medium
- All `needs-work` + `fix` pending → low

**TodoList:** add `degraded: true` flag to the per-round entry in `reviewRounds`. The workbench can render a small "review crashed" icon next to that round.

#### K.5 Confidence label honesty in the section footer

When a section's shipping decision involved a degraded review, append a one-line note above the existing footer:

```
_Note: the reviewer's structured response was malformed on this section.
The draft shipped without a verified accept._
```

This is informational, not alarming. It tells the user "treat this section's reviewer-approval as soft."

---

### Phase L -- patch protocol viability

The whole structured-review design hinges on the patch loop working. Run #2 showed the patch loop emitting **zero patch blocks 6 out of 7 times**. Until that's fixed, the picker is doing all the work and Phases E-G are wasted.

#### L.1 Inspect what the model actually emits in place of patch blocks

**Before changing prompts**, dump a failed patch loop's raw LLM output. The orchestrator already logs the request/response shape via `llm-io`. Pull a failed section's response text and answer:

- Does the model emit prose with NO fenced blocks? (most likely)
- Does it emit prose with markdown headers / bullets but no fences? (possible)
- Does it emit fenced blocks with the wrong tag pattern? (e.g. `\`\`\`wi-1` without the `patch:` prefix)
- Does it emit fenced blocks with content but wrong delimiters?

The fix depends on the answer. If it's "no fences at all," the prompt isn't landing. If it's "wrong delimiter shape," the parser regex is too tight. If it's "the model wrote the patches in the prose itself," then we need a different parsing strategy.

This is the **single most important investigation** in the fix batch. Without this data, every L.2-L.4 fix is a guess.

#### L.2 Patch-body terminal-artifact rule

Independent of L.1: the patch protocol prompt doesn't tell the model that the **patch body is a standalone paragraph that will be inserted verbatim**. The model carries over its writer-prompt habit of ending each paragraph with a transition ("Next, I will examine X"). Those transitions get pasted into the section.

**Fix:** add a `## Patch body content` block to `PATCH_SYSTEM_PROMPT_INTRO` with concrete WRONG/RIGHT examples (mirroring J.1's structure but applied to patch bodies):

```
The patch body becomes a STANDALONE paragraph in the final report.
It is a terminal artifact -- there is no "next" inside the patch body.
Do NOT include transition phrases. Do NOT promise further investigation.

  WRONG: "The HDFS module contains 707 files including DFSConfigKeys.
  Next, I will examine the MapReduce module."
  RIGHT: "The HDFS module contains 707 files including
  [`DFSConfigKeys`](path:.../DFSConfigKeys.java#L1-L2034), which
  defines the configuration keys that govern block placement,
  replication factor, and the heartbeat interval."
```

This is the root-cause fix surfacing in run #2 (where the transition phrases leaked from section 1's patches into the shipped draft). Regex-strip in `applyPatches` would be a weak band-aid; the prompt is the right layer.

#### L.3 Round-curated patch prompts (R3 escalation)

Run #2 confirmed: when round 2's patch loop bailed, round 3 saw the **exact same patch prompt** and bailed identically. No "this is your last attempt, the previous patch produced zero blocks" signal.

**Fix:** parameterise `PATCH_SYSTEM_PROMPT_INTRO` with a `round` argument. Round 3's variant prepends an escalation note:

```
This is your THIRD attempt. The previous patch round produced zero
fenced blocks -- the orchestrator interpreted that as silent failure
and ran a redraft fallback. The redraft did not satisfy the reviewer
either. You MUST emit `patch:<id>` or `skip:<id>` fenced blocks for
each work item. If you cannot address an item, emit a `skip:` block
with a one-sentence reason. Silence is the worst possible response.
```

This makes the round-3 prompt actively escalate, not just retry.

#### L.4 Patch-body sanitization as defense in depth

After L.1 + L.2 land, if the live retest still shows transition phrases in patch bodies, add a sanitizer in [apply-patches.ts](src/insrc/agent/tasks/code-analyzer/apply-patches.ts):

- Reject patch bodies whose final sentence matches the J.2 transition regex.
- Mark the item `partial` with reason `"writer announced an action; body sanitized"`.

This is defense in depth, not the primary fix. The prompt change (L.2) should suffice on most runs.

---

### Phase M -- F.4 redraft prompt curation

The F.4 redraft fallback uses the **same writer prompt** as round 1 with a `## Reviewer hint` block prepended. Run #2 showed every F.4 redraft producing a meaningfully shorter draft than round 1 (231-1186 chars vs round 1's 2-5k). The hint focuses the model narrowly; the writer prompt's "open with a topic sentence about the SUBJECT" doesn't override the "answer the hint" pull.

#### M.1 New "recovery" writer prompt variant

`writeSectionWithTools` gains a third entry-point mode (`mode: 'fresh' | 'recovery'`). Recovery mode swaps `SYSTEM_PROMPT_INTRO` for `RECOVERY_SYSTEM_PROMPT_INTRO`, which differs from the writer prompt in three places:

- "This is a recovery pass. The patch loop attempted to revise an existing draft and could not. Produce a **fresh, comparably-full draft** of the section, NOT a narrow answer to the reviewer's hints."
- "Treat the reviewer hints as constraints, not as the topic. The section objective and review criteria remain the primary target."
- "Match the original draft's length and density (similar paragraph count, similar citation density). Do not produce a stub."

Plus the F.4 redraft path passes the round-1 draft length / paragraph count as soft targets in the user message:

```
## Recovery context
- The original draft was ~3,500 chars across 5 paragraphs with 9 citations.
- The patch loop tried to address: <hint>
- Produce a fresh draft of comparable scope (NOT a narrow answer).
```

#### M.2 Cumulative-evidence pruning for the reviewer

Run #2's section 7 round-2 review user message was over 16 KB just on evidence (15 cumulative skill calls). Most of round 2's skill calls duplicate round 1's findings. Trim:

- Round 2 review: send round-1 evidence + only round-2's NEW (non-duplicate) calls.
- Round 3 review: send a compressed summary of round-1+round-2 evidence ("21 skill calls covered: module.describe ×8, entity.summary ×7, file.describe ×6") + round-3's new calls verbatim.

This cuts the reviewer's input by 30-60% on rounds 2/3 without dropping signal.

---

### Phase N -- writer-quality nudges

#### N.1 Enforce entity-level drill-down when section needs concrete citations

Section 3 of run #2 had 5 paragraphs and 3207 chars but **0 citations** because the writer only called `code.source.module.describe` -- which returns aggregate stats but no entity-level file:line anchors.

**Fix in the writer system prompt:** add a "citation density requirement":

```
A section's review criteria include "names concrete entities with
file paths." `module.describe` returns module-level stats only --
file:line citations come from `entity.summary`, `file.describe`,
or `class.locate-references`. If your investigation has not made
at least one entity-level skill call by your third turn, you MUST
do so before closing.
```

This is a soft mandate, not a hard one -- the loop doesn't enforce it -- but it makes the requirement explicit so the model's stop heuristic factors it in.

#### N.2 Reviewer round-awareness

Currently every review pass is fresh -- the cloud reviewer doesn't know it asked for X in round 1. Run #2 showed reviewer work-item lists drifting between rounds for the same section.

**Fix:** when round 2's review fires, prepend round 1's reviewer work-item list to the user message under a `## Previous review (round 1)` block. The reviewer sees what it asked for last time, and can judge whether round 2 addressed it. Same pattern for round 3.

This adds ~1 KB to the round-2/3 user message but gives the reviewer continuity that the writer already has (via priorDescribedSkills + cumulative skill calls).

---

### Phase O -- cosmetic cleanups

#### O.1 verdictLabel doubling

Milestone label `accept@round2@round2` appears when the accept-short-circuit branch fires because `shipDecisionReason` already contains `'accept@roundN'` and the label-builder appends `'@roundN'` again. Trivial fix: drop the `@round` suffix from the accept branch's `shipDecisionReason` string, OR strip a trailing `@round\d+` from the label-builder. Picker-path labels (`paragraph-count@round1`) render correctly.

#### O.2 Better "section drafting complete" milestone string

Run #2's milestone strings are dense but cryptic for non-developers. Compose a clearer line per section:

```
[5/8] "YARN Resource Management" -- shipped round 1 (picker: citation-count;
       5 reviewer follow-ups remain unaddressed; confidence: medium)
```

Lift the unaddressed-count and confidence into the milestone so the chat panel surfaces them without the user having to read the report footer.

---

## Run #2 success criteria (re-run after K-L land)

- 8/8 sections shipped with content (regression check; achieved in run #2).
- ≥1 section achieves a **non-degraded** accept (real reviewer approval, not soft-accept).
- Patch-protocol compliance ≥50% (target stretched from 70% pending L.1 findings; if L.1 shows the model is fundamentally fighting the protocol, this target may go up or the design changes).
- F.4 redraft fallback fires on <50% of patch calls (target was 30%; relaxed pending L.1).
- 0 sections ship a worse later round over a better earlier round (K.1 guarantees this).
- Median F.4 redraft length ≥80% of round-1 median length (M.1 closes the gap).
- 0 transition phrases in any shipped patch body (L.2 + L.4).

---

## Live retest 2026-05-17 (run #3)

After Phases K-O shipped (commits `72170527cb0` -> `34abb836389`), a third `/code-analyze` run drove against the same Hadoop repo. Planner produced 12 sections. All 12 shipped with content. Report at `~/.insrc/tmp/<sessionId>/reports/turn-2.md`, **40,419 bytes** (1.9x run #2 / 8.4x run #1).

### Macro outcomes vs prior runs

| Metric | Run #1 | Run #2 | Run #3 |
|---|---|---|---|
| Sections shipped | 1 / 12 placeholders | 8 / 8 | **12 / 12** |
| Report size | 4,801 B | 21,778 B | **40,419 B** |
| Real (non-degraded) accepts | 0 | 0 | **3** (sections 9, 10, 11) |
| Patch protocol producing blocks | n/a | 1 section | **2 sections** (5, 12) |
| Sections losing content to degraded short-circuit | n/a | 2 (5, 7) | **0** (K.1 working) |
| Sections with degraded review | n/a | 5 / 8 | 3 / 12 (3, 4, 7) |
| `firstTurnFramingDetected` rate | ~100% | 0% | **0%** |
| Transition-phrase nudge fires | n/a | 0 | 0 |
| verdictLabel doubling occurrences | n/a | 5 / 8 milestones | **0 / 12** (O.1) |

### Run #3 per-section table

| # | Section | R | Reason | Conf | Patch R2 | Patch R3 | Notes |
|---|---|---|---|---|---|---|---|
| 1 | HDFS NameNode | 3 | citation-count | low | 0/6 | 0/4 | recovery redraft 2280/7 won |
| 2 | Common Filesystem | 1 | citation-count | medium | 0/5 | 0/5 | round 1 (2682/6) beat redrafts (778/0, 1060/3) |
| 3 | MapReduce Client | 1 | sole-candidate (degraded) | medium | – | – | reviewer crashed; shipped round 1 |
| 4 | YARN ResourceMgr | 2 | citation-count (degraded) | medium | 0/5 | 0/5 | recovery redraft 6213 chars |
| 5 | YARN Protocol Records | 2 | text-length | low | **1/5** | **3/5** | **both patches emitted** |
| 6 | HDFS Client I/O | 3 | citation-count | medium | 0/5 | 0/5 | thin throughout (919->1026) |
| 7 | Common Utilities | 1 | paragraph-count (degraded) | medium | 0/5 | – | F.4 produced 0-char redraft |
| 8 | MapReduce Task | 3 | citation-count | medium | 0/5 | 0/5 | strong recovery (2108/6) |
| 9 | YARN Web UI | 2 | **accept@round2** | medium | **4/5** | – | first real accept; patch worked |
| 10 | HDFS Testing | 2 | **accept@round2** | medium | 0/4 | – | real accept via F.4 redraft |
| 11 | MapReduce Testing | 2 | **accept@round2** | medium | 0/4 | – | real accept via F.4 redraft |
| 12 | Repo Build | 1 | paragraph-count | medium | **1/5** | **3/5** | both patches emitted; round 1 won |

### What landed

- **K.1 (degraded-accept exclusion)**: **0 sections** lost content to a degraded short-circuit (vs 2 in run #2). Picker fires correctly whenever the only accept is degraded.
- **K.2 (raised reviewer maxTokens 800 -> 2500)**: most reviewer calls landed valid JSON; the few that didn't were schema violations, not truncation (see Phase P below).
- **K.4 (degraded flag through trace + confidence)**: `degraded` propagates through `reviewRounds[i]`, `degradedReviews` counter on the section log line, and the confidence downgrade. Sections 3 / 4 / 7 correctly show `confidence: medium` despite being on the degraded path.
- **L.3 (round-3 escalation)** when accepted: sections 5 R3 and 12 R3 both emitted 3-4 patch blocks with **zero skill calls** -- the "skill calls are optional" clause is the key driver of patch protocol success on substantive sections.
- **M.1 (recovery prompt)** when accepted: sections 4 / 8 / 10 produced recovery redrafts 2.3-2.8x larger than round 1, with comparable or better citation density. Sections 9, 10, 11 reached real accepts via the F.4 path.
- **N.2 (reviewer round-awareness)**: no reviewer drift observed across rounds in any section. priorReviews block landed cleanly.
- **O.1 + O.2**: milestone format clean (`accept @ round 2`, `paragraph-count @ round 1`) with confidence + unaddressed count surfaced inline.

### What did not land

The structural failure clusters from run #2 narrowed but did not close:

- **L.2 prompt rewrite did not fix substantive-round-1 patches**. The model still treats the per-item interleaving prompt as a TODO list ("For wi-1, I will... For wi-2, I will... Let me gather evidence") and runs out of iterations before emitting blocks. The R3 escalation works because the "skill calls are optional" clause overrides the gather instinct -- but only on R3 today.
- **N.1 entity-drill-down rule (soft mandate)** -- ~50% of sections closed round 1 with only `code.source.module.describe` calls and 0 citations. The soft "MUST call entity-level skill before closing" rule was ignored.
- **Writer voluntary-early-close** -- sections 6, 7, 8, 9, 10 closed round 1 after 1-3 tool calls. The "When to stop" rule fires too eagerly. Round 1 thinness is what later triggered F.4 reliance.
- **K.3 length cap blocking the reviewer** -- sections 4 R3 and 7 R2 both had reviewer JSON rejected because `workItems[i].action` exceeded 200 chars. The validator's max-length check is now BLOCKING valid review output; the cap should soft-truncate, not reject.
- **Reviewer hallucinating `kind`** outside the fix|enhance|add|trim enum -- sections 3 / 4 R3 retry / 7 all hit `workItems[0].kind must be one of fix|enhance|add|trim`. The reviewer is inventing kinds like `clarify` / `restructure`. Either widen the enum or strengthen prompt + auto-retry with a corrective re-prompt that names the violating value.
- **F.4 empty redraft** -- section 7's recovery redraft produced `textLength: 0`. New failure mode. The recovery preamble's "produce a fresh comparably-full draft" instruction didn't reach the model under whatever context primed an empty response.
- **Writer-side duplicate paragraphs** -- section 2 round 1 had paragraphs 2 and 3 as near-duplicates of each other (same "module contains 297 files..." opener). The interleaved-investigation loop re-narrated already-seen evidence after eviction.

The plan's K-O batch closed the most-acute reliability issues (degraded-accept short-circuit, picker correctness, milestone clarity). The remaining failures cluster around the **writer's tool-call discipline** and the **reviewer's schema discipline** -- both addressable through Phase P.

### Out-of-band fix landed after the run

Run #3's reviewer-misses were appended into the section markdown via `buildSectionFooter` (G.3) and the K.5 degraded-review note. That mixed two audiences (report reader vs operator). Both surfaces were removed after the run (commit `e7baa080483`):

- `buildSectionFooter` deleted from `pick-best-draft.ts` and its tests.
- The orchestrator's picker branch ships `winner.markdown` verbatim with no overlay.
- Reviewer misses now live only in: the per-section log line, the TodoList `reviewRounds[]` trace, and the chat-panel milestone.

`shipDecisionReason` still appends `(degraded review)` suffix when relevant, but that's a log/milestone artifact -- never in section content.

---

## Follow-up plan (run #3 fix batch -- Phase P)

Six fixes targeting the failure clusters above, ordered by impact. P.1 + P.2 are the biggest leverage; P.3-P.6 are quality nudges.

### P.1 Raise tool-call cap to 32

**Why:** `DEFAULT_MAX_TOOL_CALLS = 10` in [write-section.ts](src/insrc/agent/tasks/code-analyzer/write-section.ts) was sized when writers commonly stopped at 5-7 calls. Run #3 showed:

  - Substantive round 1s (sections 1, 4, 11, 12) hit the cap at 10 with the model still actively calling tools.
  - Patch loops on substantive sections (4 R3 spammed 10 entity.summary calls before being cut off; 11 R2 made 6 calls but never emitted a block) needed more space to gather AND emit.
  - Recovery redrafts (4 R2 produced 6213 chars hitting the cap, 8 R3 produced 2108 chars hitting the cap) wanted more room to match round-1 density.

**Fix:** raise `DEFAULT_MAX_TOOL_CALLS` from 10 to **32**. Same value applied to both `writeSectionWithTools` and `patchSectionWithTools`. The global `getToolSettings().loop.maxIterations = 25` is still honored as a hard ceiling; the per-call override pushes it to 32 only for code-analyzer sections.

**Side effect:** longer per-section runs (~3x worst case). Acceptable for the accuracy-over-speed principle. Phase I instrumentation already tracks per-section `toolCallCount` so we can measure the new average.

### P.2 Patch prompt: bring "skill calls are optional" forward to R2

**Why:** the [PATCH_SYSTEM_PROMPT round 3 escalation](src/insrc/agent/tasks/code-analyzer/write-section.ts) clause "Skill calls are optional this round. If the previous rounds gathered the evidence already, just write the patch body from what is in your context" is the single highest-leverage line in the patch prompt -- it's what enabled sections 5 R3, 9 R2, 12 R3 to emit blocks. Today it only fires on round 3. Run #3 showed substantive round-1 drafts produce 0 patch blocks on R2 because the model gathers indefinitely; bringing the clause forward gives R2 the same out.

**Fix:** add a "Skill calls are usually unnecessary" section to the base patch prompt (the round-agnostic body). Frame it as:

```
You already have round-1's skill-call evidence in your conversation
history. The patch body should USUALLY emit from that existing
context. Only call a skill when the work item explicitly requires
new evidence (e.g. an `add` item asking for a topic round 1 did not
investigate). Gathering more evidence is the most common failure
mode of this loop -- the cap will kill the loop before you emit
the patch.
```

Keep the L.3 R3 escalation block on top of this -- R3 still gets a stronger nudge ("you MUST emit blocks, silence is the worst response").

### P.3 K.3 length cap: soft-truncate instead of validator-reject

**Why:** sections 4 R3 and 7 R2 had reviewer JSON rejected because `action` exceeded 200 chars. The validator currently returns a hard error -> retry -> if retry also too long, soft-accept with `workItems=[]`. That throws away a perfectly usable review.

**Fix:** in [review-action.ts validator](src/insrc/agent/content-gen/review-action.ts) -- when `issue.length > 200` or `action.length > 200`, **truncate to 200 chars with an ellipsis** and add a note to `notes[]` flagging that the field was truncated. Validator no longer rejects on length. The schema's `maxLength` becomes advisory (the cloud LLM still tries to respect it via the schema hint, but exceeding it doesn't break the flow).

### P.4 Reviewer structured-output reliability: JSON Schema in prompt + corrective retries

**Why:** the 2026-05-17 reviewer-failure analysis showed that **100% of first-attempt failures (27/27) in run #3 were `kind` enum violations** -- Haiku invented kinds like `clarify` / `restructure` outside our `fix|enhance|add|trim` enum. 90% of all reviewer calls failed on first try; 10% ended in soft-accept after the retry also failed. The reviewer's `opts.responseFormat` is currently dropped on the floor in every cloud provider (Anthropic / OpenAI / Gemini / Mistral) -- the schema travels into `complete()` but never reaches the API.

The sister codebase `insors-extraction` (which never sees malformed responses despite complex nested JSON) uses a single battle-tested pattern across all providers via the `instructor` library:

  - Anthropic: `instructor.from_anthropic(client, mode=ANTHROPIC_JSON)`
  - OpenAI:    `instructor.from_openai(client)` (default JSON mode)
  - Ollama:    `instructor.from_openai(client, mode=Mode.JSON)` against Ollama's OpenAI shim
  - Gemini:    hand-rolled but identical -- `_format_schema_for_prompt` serializes Pydantic schema as JSON Schema text in a fenced block in the system prompt, parses + validates with Pydantic, retries on `ValidationError`.

All four converge on the same recipe: **JSON Schema as JSON text in the system prompt + retry with the specific Pydantic ValidationError as a corrective user message**, with `max_retries=3`. NOT `tool_use`, NOT server-side schema enforcement.

**Fix (provider-agnostic -- lives entirely in [review-action.ts](src/insrc/agent/content-gen/review-action.ts), works across every LLMProvider):**

1. **Inject the schema as JSON Schema text into the system prompt.** Replace the current prose description of the schema (`"The schema is fixed: { verdict, workItems, accepted?, notes? }"` plus a bulleted enum list) with a fenced ```json block containing `JSON.stringify(REVIEW_ACTION_SCHEMA, null, 2)`. The kind enum and required fields are encoded in a format every cloud LLM is trained to obey strictly (JSON Schema is a recognized constraint format in their training data, where prose lists read as "examples").

   Concretely the system prompt gains a section like:

   ```
   ## Response schema (JSON Schema)

   Your response MUST validate against this JSON Schema. The `kind` enum
   is CLOSED -- only the listed values are valid.

   ```json
   {
     "type": "object",
     "properties": {
       "verdict": { "type": "string", "enum": ["accept", "needs-work"] },
       "workItems": {
         "type": "array", "minItems": 0, "maxItems": 6,
         "items": {
           "type": "object",
           "properties": {
             "id":     { "type": "string", "minLength": 1, "maxLength": 16 },
             "kind":   { "type": "string", "enum": ["fix", "enhance", "add", "trim"] },
             "where":  { "type": "string", "minLength": 1, "maxLength": 64 },
             "issue":  { "type": "string", "minLength": 1, "maxLength": 200 },
             "action": { "type": "string", "minLength": 1, "maxLength": 200 }
           },
           "required": ["id", "kind", "where", "issue", "action"]
         }
       },
       ...
     },
     "required": ["verdict"]
   }
   ```
   ```

2. **Corrective retry with the specific violation surfaced.** When `validateReview` rejects, the retry user message names the EXACT violating value (not just the validation rule). Today's retry message is:

   > "Your previous response was rejected: \`workItems[0].kind\` must be one of fix|enhance|add|trim. Return ONLY the JSON object..."

   The new retry message reads back the bad value AND points to a corrective mapping:

   > "Your previous response had `workItems[0].kind = \"clarify\"` which is not in the allowed enum. The closed enum is `fix | enhance | add | trim`. The closest valid kind for an item describing 'clarify the X claim' is **enhance** (kind=enhance is for correct-but-thin content; clarification is enhancement). Re-emit the JSON with `workItems[0].kind = \"enhance\"` (or another valid value if more appropriate). Return ONLY the corrected JSON."

   The validator needs to grow a small "extractViolation" helper that pulls the offending value out of the parsed JSON for any constraint type (enum / minLength / maxLength / type / required) and a tiny lookup table for closest-valid suggestions (only for the `kind` enum -- the others don't need suggestions).

3. **Raise max retries from 2 → 3** to match the `insors-extraction` pattern. The added cost is one possible extra cloud call per section; in run #3 even with 90% first-try failures the total cloud time was 7 minutes -- one more retry on rare cases is trivial.

**Provider coverage matrix:**

This fix lives in the caller-side prompt construction, so all cloud providers are covered uniformly through the existing `LLMProvider` interface. No per-provider plumbing required for Anthropic / OpenAI / Gemini / Mistral. Side benefit: when the planner or other strict-JSON callers (`plan-actions.ts`, `relationship.ts`, etc.) adopt the same `responseFormat.schema` shape, they get the same reliability without further work.

  - **Anthropic (Haiku)** -- Phase P.4 main target. Schema in prompt + corrective retry brings 90% first-try failure → near 0%.
  - **OpenAI / Azure OpenAI** -- the schema-in-prompt pattern works identically. (Future option: add native `response_format: { type: 'json_schema', json_schema: ... }` for GPT-4.1+ if available, but the prompt-based fix is already sufficient.)
  - **Gemini** -- prompt-based works as in `insors-extraction`'s manual implementation. (Future option: native `response_schema` parameter for Gemini 1.5+.)
  - **Mistral** -- prompt-based works the same way; Mistral has `response_format: { type: 'json_object' }` but not schema-aware enforcement, so prompt remains primary.
  - **Ollama (local)** -- already wired via [providers/ollama.ts](src/insrc/agent/providers/ollama.ts) (relays `responseFormat.schema` to Ollama's native `format` parameter). This means local-LLM reviewers get the strongest enforcement automatically. No change needed; the prompt-side schema injection complements it.

**Expected impact:**

  - First-try reviewer failure rate: **90% → <10%** (matches `insors-extraction`'s observed reliability on complex nested JSON).
  - Soft-accept degraded reviews: **10% → near 0%** (combined with P.3 soft-truncate on length caps).
  - Total cloud time per run: slightly LOWER despite raised retries (fewer retries actually fire; the ones that do are more likely to succeed without a third).
  - Operator visibility: degraded reviews still surface via `degradedReviews` count + `confidence: medium` downgrade -- but they'll be rare instead of routine.

This is the upstream root-cause fix. The prior P.4 sketch (name the violation in retry) is subsumed; the JSON-Schema-in-prompt is the load-bearing change.

**Critical: also REMOVE the prose structure descriptions from the system prompt.**

The current SYSTEM_PROMPT in [review-action.ts](src/insrc/agent/content-gen/review-action.ts) carries the schema in three overlapping forms:

  1. A prose "Verdict rules:" section listing accept / needs-work semantics
  2. A prose "Work-item kinds:" section describing each kind verbally
  3. A prose "Work-item field rules:" section listing field constraints (id / where / issue / action / evidenceRefs)
  4. A prose "Hard rules:" section that includes `"The schema is fixed: { verdict, workItems, accepted?, notes? }"`

Once the JSON Schema block lands, **keep ONLY the semantic guidance the schema cannot express** -- which is the *intent* of each kind (when to pick `fix` vs `enhance` vs `add` vs `trim`) and the workflow rules (`each item atomic`, `cap at 6`, `pick the 6 most important`). DELETE:

  - All field-shape prose (id / where / issue / action / evidenceRefs structural rules) -- the JSON Schema's `properties` / `required` / `maxLength` / `minLength` cover it.
  - The "verdict rules" prose enumeration of `accept` vs `needs-work` requirements (`workItems MUST be empty` / `MUST be non-empty`) -- the schema enforces it.
  - The "Hard rule 2" line about the schema shape -- redundant with the schema block.
  - The "Hard rule 3" line about `accept` vs `needs-work` workItems -- redundant.

Duplicated structure information between prose and schema is a known source of LLM confusion: the model has to reconcile two descriptions of the same constraint, and when they drift even slightly the model picks whichever it thinks fits better. Single source of truth (the JSON Schema block) avoids the drift.

The resulting reviewer system prompt is roughly:
  - Role + responsibilities (you review one section)
  - Inputs (what you'll receive)
  - Verdict semantics (when to accept vs needs-work) -- SEMANTIC ONLY, no shape
  - Kind selection guidance (when each kind applies) -- SEMANTIC ONLY, no shape
  - Workflow rules (atomic items, max 6, pick most important)
  - Output expectations (JSON only, no fences, no preamble)
  - The JSON Schema block (the SHAPE)

Expect the prompt to shrink by ~30%. The same de-duplication should apply to any other strict-JSON caller (`plan-actions.ts`, etc.) when they adopt the JSON-Schema-in-prompt pattern.

**Out-of-scope here:** wiring `opts.responseFormat.schema` through each cloud provider as native API parameters (Anthropic's tool-use trick, OpenAI's `response_format`, Gemini's `response_schema`). Worth doing eventually for defense in depth, but the prompt-based approach is what `insors-extraction` validated at production scale on the same providers, and it's a one-place fix in `review-action.ts`.

### P.5 N.1 entity-drill-down: harden from soft mandate to loop-level rule

**Why:** the [N.1 "Citation density requirement" prompt section](src/insrc/agent/tasks/code-analyzer/write-section.ts) tells the writer to call an entity-level skill before closing if it's only used module.describe by turn 3. Run #3 showed ~50% of sections ignore the rule. Soft mandates in long prompts have weak compliance.

**Fix:** enforce at the loop level via `interceptToolCall`. Track per-loop `moduleDescribeCallCount`. If the writer attempts to emit `end_turn` after only module.describe calls AND citationCount in the produced text is 0 AND the action's review criteria mention "entities" / "classes" / "implementations" / "specific" / "file:line", the loop injects a synthetic user turn: `Your draft has no clickable citations and you have only called code.source.module.describe. The section criteria require concrete entity references. Call code.entity.summary or code.source.file.describe for at least one entity before closing.` One-shot per loop (similar to J.2 transition-phrase nudge).

### P.6 Writer voluntary-early-close hard floor

**Why:** sections 6, 7, 8, 9, 10 of run #3 closed round 1 after 1-3 tool calls. The "When to stop" rule reads "When every review criterion is addressed by a paragraph in your investigation" but the writer self-assesses with no verification.

**Fix:** loop-level minimum-iterations guard in `writeSectionWithTools`. If the writer attempts `end_turn` before `min(3, criteria.length)` `skill_invoke` calls have been made, inject a synthetic user turn: `You have closed after N skill calls; the section has M review criteria. Make at least one skill call per criterion before closing.` Triggers only once per loop. Recovery mode (M.1) doubles the floor since recovery drafts should match round-1's depth.

### P.7 F.4 redraft empty-output guard

**Why:** section 7's F.4 redraft returned `textLength: 0`. The picker still ran but had only round 1 as a usable candidate, and that round 1 was already thin.

**Fix:** when `writeSectionWithTools` returns `markdown.length === 0` in recovery mode, log it loudly (`error` level, not `warn`) AND retry once with a re-prompted variant: `Your previous response was empty. The recovery context requires a fresh comparably-full draft. Begin with the section's topic sentence about the SUBJECT, not a preamble.` If the retry is also empty, accept the empty draft (picker handles it).

### P.8 Writer-side duplicate-paragraph detection

**Why:** section 2 round 1 had paragraphs 2 and 3 as near-duplicates. The interleaved-investigation loop re-narrates already-seen evidence after eviction.

**Fix:** in the loop's paragraph-flush step ([loop.ts](src/insrc/agent/tools/loop.ts), after `sectionParagraphs.push(currentTurnText.trim())`), compare the new paragraph against the previous one. If the trigram-shingle Jaccard similarity is > 0.7, drop the new paragraph and emit a synthetic user turn: `The paragraph you just wrote is nearly identical to your previous one. State a NEW fact from the latest tool result, not a restatement of prior analysis.` One-shot per loop.

### P.9 Picker: replace lexicographic comparator with weighted-score + absolute-target normalization

**Why:** run #4 section 1 surfaced a real picker miscall. The reviewer flagged 6 items in round 1; round 2 addressed 5; round 3 addressed all 5 of its incoming items. But **none** of the items were kind=`fix` -- they were all `enhance` / `add` / `trim`. The current picker's `fixItemsAddressed` counter (in [pick-best-draft.ts](src/insrc/agent/tasks/code-analyzer/pick-best-draft.ts) `countFixItemsAddressed`) only counts `fix` kinds, so all three rounds tied at 0 there and the comparator fell through to `citationCount`. Round 1's heavy entity drill-down had produced ~13 citations; rounds 2/3's patches replaced paragraphs and ended up with fewer citations. **Round 1 shipped over two rounds that successfully addressed the reviewer's actual feedback.**

The root cause is two design choices in the current picker:
  1. `fixItemsAddressed` ignores `enhance` / `add` / `trim` -- they get zero credit even when the patch loop addresses them cleanly. The reviewer asks for them as "concrete heterogeneous changes" (Phase E semantics) so they're substantive, not optional.
  2. **Lexicographic ordering** means the first non-tied signal decides everything. The signal can be a 5-item-addressed gap and the picker still falls through to citation-count if both rounds have `fixItemsAddressed = 0`. The signals don't *compose*.
  3. **Citation count is a raw tally**, not a quality measure. 12 citations to trivial classes < 4 citations to load-bearing entities, but the picker can't see that. At the citation densities Phase P is producing (8-15/section), the count is noise.

**Fix:** replace the lexicographic comparator with a **weighted sum** over four signals, all normalized to 0-1 via **absolute targets** (not max-across-candidates -- absolute is more stable, doesn't amplify small differences, and reflects "what's good enough" rather than "what's best in the pile").

#### Signal weights

| Weight | Signal | Target (full credit at) |
|---|---|---|
| **4** | `weightedItemsAddressed` -- all kinds, inner weights below | 10 |
| **3** | `citationDiversity` -- unique cited files | 8 |
| **2** | `paragraphCount` | 6 |
| **1** | `textLength` -- final tie-breaker | 3000 |

#### Inner weights for `weightedItemsAddressed`

```
fix     = 3   (factual error; gates correctness)
add     = 2   (missing required topic)
enhance = 2   (correct but thin; the most common reviewer ask)
trim    = 1   (mechanical deletion)
```

For round N's patch: sum `kind_weight(prior_item.kind)` over every item with `status === 'addressed'`. Round 1 always scores 0 here (no prior round to address).

#### Absolute normalization

For each signal: `normalized = min(raw_value / target, 1.0)`. Cap at 1.0 -- exceeding the target doesn't earn extra credit. This means once a round hits "good enough" on a signal, the comparator stops favoring further investment on that axis and the next-priority signal takes over.

#### Score + reason

```
score = 4 * normalized(weightedItemsAddressed)
      + 3 * normalized(citationDiversity)
      + 2 * normalized(paragraphCount)
      + 1 * normalized(textLength)
// max possible: 10.0
```

Winner = round with highest score. `shipDecisionReason` becomes the signal that contributed the most points to the winner (its `weight * normalized` term), surfaced for log + milestone visibility.

#### Worked example (section 1 of run #4)

| Round | weighted-items | citation-diversity | paragraphs | length |
|---|---|---|---|---|
| 1 | 0 | 13 -> capped at 1.0 | 5 -> 0.83 | 2500 -> 0.83 |
| 2 | 5 enhances * 2 = 10 -> 1.0 | 8 -> 1.0 | 4 -> 0.67 | 2200 -> 0.73 |
| 3 | 5 enhances * 2 = 10 -> 1.0 | 6 -> 0.75 | 3 -> 0.50 | 1900 -> 0.63 |

Scores:
  - R1 = 4*0 + 3*1.0 + 2*0.83 + 1*0.83 = **5.49**
  - R2 = 4*1.0 + 3*1.0 + 2*0.67 + 1*0.73 = **9.06**
  - R3 = 4*1.0 + 3*0.75 + 2*0.50 + 1*0.63 = **7.88**

**Round 2 wins.** The picker correctly recognises that addressing reviewer feedback (5 items * weight-2) outweighs round 1's citation density advantage.

#### Why absolute over max-across-candidates

Max-across normalization (every signal divided by the per-batch max) can amplify trivial differences. If R1=13 citations and R2=11, max-across gives R1=1.0, R2=0.85 -- looks like a 15% gap, but it's two citations. Absolute targets cap at 1.0 once "good enough" is reached, letting the next-priority signal break the tie. This is more stable when all three rounds are in a similar quality band.

#### Migration

`pickBestRound` becomes a pure refactor of the picker function; the result shape changes only slightly:

```ts
export interface PickResult {
  readonly winnerIdx:           number;
  readonly winner:              RoundCandidate;
  readonly reason:              ShipDecisionReason;   // signal with highest contribution
  readonly scores:              readonly RoundScore[]; // per-candidate breakdown
}

interface RoundScore {
  readonly round:                       1 | 2 | 3;
  readonly weightedItemsAddressed:      number;   // raw
  readonly citationDiversity:           number;   // raw (unique files)
  readonly paragraphCount:              number;   // raw
  readonly textLength:                  number;   // raw
  readonly normalized: { weightedItems: number; citations: number; paragraphs: number; length: number };
  readonly totalScore:                  number;   // 0-10
}
```

Existing tests need updating (~14 picker tests will need new expected values; the reason names change to `weighted-items-addressed` / `citation-diversity` / `paragraph-count` / `text-length`). The orchestrator's call site is unchanged.

#### Tunable

The four signal weights (4/3/2/1), the four inner work-item weights (fix/add/enhance/trim), and the four targets (10/8/6/3000) all become module-level constants in `pick-best-draft.ts` so they can be tuned without rewriting logic.

---

## Run #3 performance profile (deferred -- Phase Q)

Mined from `/tmp/.insrc/agent.2.log` after run #3 completed. **Accuracy fixes (Phases P) ship first; performance optimization (Phase Q) is deferred.**

### Hotspot ladder

| Phase | Time | % of run |
|---|---|---|
| **Local LLM (devstral writer + patcher + redraft)** | **147.4 min** | **92.6%** |
| Cloud reviewer (anthropic Haiku) | 6.9 min | 4.3% |
| Planner (anthropic) | 0.3 min | 0.2% |
| Stitching + persist | <1 s | 0% |

Total runtime: **159 min** for 12 sections. 97% of wall time is LLM I/O; the local model is the floor.

### Per-call latency

- **Local**: 377 calls, median 12.9s, mean 23.5s, **p95 84.7s**. Top-10 slowest local calls together = **22.8 min** (14% of run); slowest single call = 190s. Tail-dominated.
- **Cloud reviewer**: 58 calls, median 7.2s, mean 7.4s, p95 9.9s. Tight distribution.

### Per-section spread (8x variance)

| Section | Time | Notes |
|---|---|---|
| 9 YARN Web UI | 3:48 | best case: 2 rounds, patch hit on R2 |
| 4 YARN ResourceMgr | 29:50 | worst case: hit cap twice + recovery + R3 escalation (18% of run) |

Worst-case sections all hit the tool-call cap on multiple rounds AND ran F.4 recovery on top. Best-case sections accepted on round 2.

### Skill-call distribution

```
code.source.module.describe   47   <-- most-used by 25%+
code.entity.summary           37
code.source.file.describe     24
code.entity.callees            4
code.entity.callers            2
```

Module-level skills account for ~40% of all calls -- confirms N.1's diagnosis (writer over-relies on aggregate stats). Phase P.5 (loop-level entity-drill-down enforcement) reduces this skew.

### Why this is deferred behind accuracy

The accuracy work in Phases K-O has narrowed failure modes meaningfully but Phase P still has 8 outstanding fixes. Running a perf pass *before* P lands would:
  - Optimize for the wrong failure shape (the writer's call patterns change once P.5/P.6 land).
  - Conflate accuracy regressions with perf gains in any A/B comparison.
  - Risk shipping a faster-but-worse run.

The accuracy floor is what determines whether the report ships content at all. Speed is a second-order concern once content quality is at a usable bar.

---

## Phase Q -- performance optimization (deferred until Phase P lands)

Constraint baseline: **single Ollama instance, single loaded local model serializes inference**. Parallel section execution against the same local model is a false economy. The realistic levers:

### Q.1 Skill-call memoization at the loop level

**Why:** the writer sometimes issues the same `skill_invoke({skillId, args})` twice in a section. Section 12 of run #3 made 9 consecutive `code.source.module.describe` calls, several likely with overlapping/duplicate args. Each duplicate is a wasted ~15-25s round trip through Ollama.

**Fix:** in [runToolLoop](src/insrc/agent/tools/loop.ts), cache `(toolName, JSON.stringify(input))` -> result for the lifetime of the loop. On a cache hit, skip the dispatch entirely and synthesise the cached `tool_result` back to the model. The cache lives in loop state only -- not across sections.

**Expected impact:** 4-6 fewer skill calls per chatty section. At 20s/call avg, that's ~1.5 min/section saved on the chatty cluster (sections 4, 11, 12). Total: 5-10 min off the run.

### Q.2 Eviction-threshold tightening on patch + redraft rounds

**Why:** the eviction trigger today is 70% of `maxInputTokens` (16000 -> ~11200 tokens). On substantive sections in round 2/3, the working set carries round-1's full evidence plus new patch-loop tool_results -- close to the threshold but rarely tipping it during the loop. Higher input = slower per-token generation, especially on devstral.

**Fix:** lower the eviction threshold to **50% (~8000)** for round 2/3 patch + recovery contexts. Round 1 keeps the current 70% (it's gathering fresh and doesn't have a backlog).

**Expected impact:** trims ~30-40% off input tokens on later rounds -> ~10-15% per-call latency reduction on round 2/3.

### Q.3 Evict the `tool_use.input` block too, not just `tool_result.content`

**Why:** today eviction stubs only the `tool_result.content` field of evicted skill calls. The accompanying `tool_use.input` (the args block: full module paths, entity ids, etc) stays verbatim. Full module paths can run 200-500 chars; many such inputs add up.

**Fix:** in [maybeEvict](src/insrc/agent/tools/loop.ts), when stubbing a tool_result, also rewrite the matching `tool_use.input` to a one-key summary like `{ "_summary": "code.source.module.describe(hadoop-hdfs)" }` retaining the skill id but dropping the full args.

**Expected impact:** ~5-10% extra input shrink stacked on top of Q.2.

### Q.4 Cumulative-skill-call compression for the WRITER context (not just reviewer)

**Why:** M.2 already lands evidence compression for the cloud reviewer's input -- older rounds collapsed to one-line summaries on round-2/3 reviews. The same compression could apply to the local WRITER's context window in the patch loop. Today the patcher's `messages` include all prior round's tool_use + tool_result blocks verbatim.

**Fix:** when entering `patchSectionWithTools` for round 2 or 3, pre-compress prior-round tool_use/tool_result blocks in `priorSkillCalls` to summaries before they enter the working message set. The local model sees "(round 1 evidence summarised: 8 skill calls covering modules X, Y, Z)" instead of the raw payloads.

**Expected impact:** ~20-30% input shrink on round 2/3 patches.

### Q.5 Multi-model routing for mechanical turns (if RAM permits)

**Why:** the truncation reality (writer needs ~1500-token output budget) blocks shrinking the big prose turns. But the **mechanical** turns -- the patch-loop announcement ("For wi-1, I will...") and the skill-arg construction -- output only ~50-150 tokens. Routing those to a smaller / faster local model (qwen3-coder, codellama-7b) loaded alongside devstral would clip several seconds per call.

**Fix:** plumb a second `LLMProvider` through writeSectionWithTools / patchSectionWithTools, route specific call types to it. Detection: turns where the previous tool result was a small (<200 byte) primitive skill response (e.g., a single entity.summary) tend to be mechanical announcements.

**Caveats:**
  - Requires loading two models in Ollama simultaneously (~30GB RAM for devstral 22B + qwen3 7B).
  - Per-section gain depends heavily on how many mechanical vs substantive turns happen; estimate: 10-20% on chatty sections.

**Expected impact:** conditional on RAM + the routing heuristic landing cleanly. Could be the biggest single lever, could be moderate. Worth measuring.

### Q.6 (deprioritised) parallel sections against the local model

**Cut.** Ollama serializes per loaded model; running section N+1 in parallel with section N just queues both on the same backend. Real parallelism would require multiple models or a different inference backend (vLLM, TGI). Not viable in the current single-model Ollama setup.

### Realistic Phase Q ceiling

With Q.1-Q.5 landing (assuming Q.5's multi-model routing is feasible):

- **Q.1 alone**: 5-10 min off (~5%)
- **Q.2 + Q.3 + Q.4 stacked**: 15-25% per-call latency reduction on round 2/3 -> ~20 min off total
- **Q.5 conditional**: another 10-20% if multi-model lands cleanly

Combined: **159 min run could become ~95-115 min** for the same 12 sections. Below that requires a faster local model.

The plan stays accuracy-first. Phase Q is a follow-up once Phases P metrics are landed and validated.

---

## Phase R -- per-item patch loop (eliminates the ghost-ID failure mode)

### R.1 Iterate per work item; orchestrator controls IDs end-to-end -- **SHIPPED** (default ON)

Implemented as `patchSectionItemwise` in `src/insrc/agent/tasks/code-analyzer/write-section.ts`, wired into the orchestrator behind `INSRC_ANALYZER_PATCH_MODE` (default `itemwise`; set to `legacy` for the old fenced-block path during rollback). Test coverage: `src/insrc/agent/tasks/code-analyzer/__tests__/patch-section-itemwise.test.ts` (17 tests). Run #6 still in progress against the legacy code; R.1 applies on next daemon restart.


**Why:** runs #4-#6 surfaced a recurring failure: the writer emits fenced `patch:<id>` blocks but with IDs that don't match the reviewer's `workItems[].id` values (`patch:wi_1` with underscore, `patch:1` renumbered, `patch:enhance-paragraph-1` semantically named, `patch:wi-A` relettered, etc.). The applier walks the workItems list, looks up each item's id in the parsed block map, finds nothing, marks all items `skipped: 'no patch emitted'`. Symptoms:

  - `patchBlocks: N` (N > 0) -- the writer DID emit blocks
  - `itemsAddressed: 0`, `itemsSkipped: workItems.length` -- but none matched
  - `patchProtocolFollowed: true` -- because blocks were emitted (misleading)
  - F.4 redraft fallback does NOT fire (the protocol-followed flag bypasses it)
  - The picker sees identical R2/R3 content (since no patches applied) and reports `'tied'` (or under the old picker, would arbitrarily lex-pick R1)

Observed prevalence:
  - Run #4: section 4 R2/R3, section 5 R2, section 6 R2/R3 -- 5 patch attempts
  - Run #5: section 1 R3, section 3 R3 -- 2 patch attempts (qwen3-coder also affected; not model-specific)
  - Run #6: section 1 R2, section 2 R2/R3 -- 3 patch attempts

The root cause is the **fenced-block ID protocol itself**. The writer has to (a) read the work-items list, (b) remember each id verbatim, (c) emit a fenced block with the id as the info-string tag. Any of those steps can drift -- and they do drift consistently across both devstral and qwen.

**Fix:** invert the loop. Instead of one giant patch call where the writer must emit fenced blocks for every item, iterate **per work item** inside the orchestrator. The orchestrator already has the IDs (from the reviewer's structured response); the writer never needs to handle them.

#### New flow

```ts
async function patchSectionItemwise(input: PatchSectionItemwiseInput): Promise<PatchSectionOutput> {
  let workingDraft = input.draftMarkdown;
  const statuses: WorkItemStatus[] = [];
  // Address `fix` items first (correctness gate), then add/enhance/trim
  const ordered = orderByPriority(input.workItems);
  for (const item of ordered) {
    const status = await applyOneItem(workingDraft, item, input);
    workingDraft  = status.patchedDraft;
    statuses.push(status.itemStatus);
  }
  return { markdown: workingDraft, itemStatuses: statuses, ... };
}

async function applyOneItem(draft, item, ctx): Promise<{ patchedDraft, itemStatus }> {
  switch (item.kind) {
    case 'trim': {
      // No LLM call needed -- just delete the targeted paragraph.
      const newDraft = deleteParagraph(draft, item.where);
      return { patchedDraft: newDraft, itemStatus: { id: item.id, status: 'addressed' } };
    }
    case 'fix':
    case 'enhance': {
      const newPara = await localLLM.complete(buildEnhancePrompt(draft, item, ctx));
      if (newPara.trim().length === 0) {
        return { patchedDraft: draft, itemStatus: { id: item.id, status: 'skipped', reason: 'empty response' } };
      }
      const newDraft = replaceParagraph(draft, item.where, newPara);
      return { patchedDraft: newDraft, itemStatus: { id: item.id, status: 'addressed' } };
    }
    case 'add': {
      // Allow 1-2 skill calls in this item's sub-loop (it may need new evidence)
      const newPara = await localLLM.completeWithSkills(buildAddPrompt(draft, item, ctx), {
        maxToolCalls: 3,
        skills: ['code.entity.summary', 'code.source.file.describe', ...],
      });
      // ... same shape: empty -> skipped, otherwise insert at anchor
    }
  }
}
```

#### Per-item prompt template (fix / enhance)

```
You are revising paragraph 3 of this section. The reviewer flagged:

  Issue:  {item.issue}
  Action: {item.action}

Current paragraph 3:
{paragraphs[3]}

Other paragraphs (read-only context):
{paragraphs[1..N except 3]}

Output ONLY the replacement paragraph text. No fences, no preamble,
no "here is the patch" line -- just the new paragraph as plain
markdown. Preserve any clickable citations the original paragraph
carried; add new ones where the action asks for them. Stay focused
on the action: do not edit other content.
```

#### Per-item prompt template (add)

```
You are adding a new paragraph to this section. The reviewer flagged
a missing topic:

  Issue:  {item.issue}
  Action: {item.action}
  Anchor: insert after paragraph {anchor-index}

Existing section paragraphs (read-only context):
{all paragraphs}

You may make up to 2 skill_invoke calls if you need NEW evidence
the existing paragraphs do not cover. After gathering, output ONLY
the new paragraph -- no fences, no preamble.
```

#### Per-item handling by kind

| Kind | LLM call needed | Orchestrator action |
|---|---|---|
| `fix`     | yes (no skills) | replace paragraph at `where` |
| `enhance` | yes (no skills) | replace paragraph at `where` |
| `add`     | yes (1-2 skills allowed) | insert after anchor |
| `trim`    | **no** | delete paragraph at `where` |

#### Properties

- **Ghost-IDs impossible by construction** -- the writer never handles IDs. The orchestrator looks up each item.id, drives the call, slots the response in.
- **No fenced-block protocol** -- replaced by plain prose output. No `patch:<id>` parser, no info-string tag matching.
- **Status tracking trivial** -- orchestrator owns the loop, sees each response, knows immediately whether to mark addressed / partial / skipped.
- **`trim` is free** -- no LLM call, just a paragraph delete. Sections of all-`trim` items cost nothing.
- **Per-item failure is bounded** -- if item 3 returns empty / garbage, items 4-6 still get a fair try. Today's batch-emit pattern fails all items together when the batch protocol breaks.
- **`fix` items can be sequenced first** so a downstream `enhance` failure doesn't block the correctness gate.
- **Smaller per-call latency** -- each call has a much smaller prompt (one item + draft + tight prose context) and a much smaller expected output (one paragraph, ~200-500 chars). qwen at ~12s/call x 6 items = ~72s per patch round. devstral at ~30-60s/short-call x 6 = 3-6 min per patch round. Both compare favourably to today's "one big call that gathers + emits" pattern (current devstral ranges: 60s - 6min, with frequent cap-hits).

#### Cost trade-offs

- **N LLM calls per round** instead of 1: more requests, but each smaller (less prompt + less output). Total tokens roughly comparable; cloud cost neutral; wall-clock often LOWER because no single giant call.
- **`add` items may make 1-2 skill calls** within their sub-loop, so the budget per round needs to accommodate `add_count * 2` extra skill calls. With the P.1 cap of 32 per loop the budget is plenty.
- **No batched announce/emit** so the model can't make the gather-then-stall mistake. Each call is laser-focused on one prose change.

#### What gets retired

- `patchSectionWithTools` becomes the legacy entry point (or gets refactored into `patchSectionItemwise`).
- `PATCH_SYSTEM_PROMPT_INTRO` (the big "for each work item: announce, gather, emit fenced block" prompt) becomes obsolete.
- `parsePatches` / fenced-block parser is no longer needed for the patch loop (could keep for legacy).
- `applyPatches`'s block-matching logic simplifies to direct `where`-based replace/insert/delete.
- L.2 (per-item interleaving prompt rewrite), L.3 (R3 escalation), L.4 (transition-phrase sanitizer in patch bodies) all become unnecessary -- the per-item prompt has no room for those failure modes.

#### What stays

- The reviewer's structured workItems output (Phase E) -- unchanged.
- The 3-round loop (Phase F.5) -- still bounded retries.
- The picker (Phase G + P.9) -- still chooses best-of-rounds, and the picker's weighted-items-addressed signal now ALWAYS gets accurate counts (no more "patches emitted but skipped" inflation).
- The F.4 recovery redraft -- still fires when a patch round produces ZERO addressed items (which under R.1 means the per-item loop genuinely failed, not a protocol drift).

#### Migration

R.1 replaces the patch protocol wholesale. Rollout:
  1. Implement `patchSectionItemwise` alongside `patchSectionWithTools`.
  2. Gate the orchestrator on `analyzerConfig.useItemwisePatch` (default `false`).
  3. Run a side-by-side live test (one section per side) to compare.
  4. If itemwise wins on ghost-ID elimination + similar accept rate, flip the default.
  5. Delete `patchSectionWithTools` and the related prompts.

Estimated work: ~400-600 lines (new entry point + per-item prompts + orchestrator wiring + tests). Picker, reviewer, recovery all unchanged.

#### Out-of-scope here

- Migrating the data-analyzer to itemwise (separate plan -- data-analyzer doesn't use the workItem schema yet).
- Per-section parallelism (deferred under Phase Q).

---

## Run #3 success criteria (re-run after P lands)

- 12/12 sections shipped (regression check).
- ≥6 sections achieve a non-degraded accept (vs 3 in run #3).
- Patch-protocol compliance ≥40% (vs ~17% in run #3 with current cap).
- Median round-1 textLength ≥2000 chars (vs ~1500 in run #3 -- P.6 closes the gap).
- 0 reviewer rejections due to K.3 length cap (P.3 fixes this).
- 0 reviewer rejections due to kind-enum hallucination unrecovered (P.4 retry fixes most).
- 0 sections with duplicate-paragraph regressions (P.8).

---

## Out of scope (for the K-O follow-up batch)

- Replacing the reviewer with a local model (Decision 3 above). Worth measuring on a future run, not this plan.
- Changing the 6-item cap. The cap is a heuristic; the K.2/K.3 output-budget fixes assume the cap stays.
- ~~Reviewer round 3. The cap stays at 2.~~ (Updated in the locked decisions: 3 rounds shipped in Phase F.)
- Migrating the `data-analyzer` reviewer. This plan touches the code-analyzer path only. The data-analyzer (`runFollowupExpandReviewSynthesise` in the same orchestrator) uses `expandThenReview` and would need its own pass.

## Rollback plan

- Phase E: pure additive (schema + prompt). Reverting drops the `workItems` field; downstream code reads `refine.hint` as today.
- Phase F: keep the old `writeSectionWithTools({ refineHint, ... })` round-2 call path next to the new `patchSectionWithTools` path; gate on a private flag during Phase I retest. Once retest passes, delete the old path.
- Phase G: the placeholder kill (Fix 11.5) is the only thing that gets deleted. Reverting one commit restores it.

## Open questions

- **How does the writer's `where` field resolve to a paragraph index?** If the reviewer says "paragraph 3" and the writer's `applyPatches` reads from a renumbered draft, the mapping has to be stable. Phase F.3 takes the simple approach (split on `\n\n`, 1-indexed); document this in the reviewer prompt so the reviewer counts the same way.
- **What if the round-2 writer wants to add a new item that wasn't in the reviewer's list?** Today the answer is "no" -- the patch loop is strictly over the reviewer's items. If retest shows the writer reasonably wants to fix things the reviewer missed, we'd add a `discretionary` slot in PatchSectionOutput. Skip for now.
- **Does the work-item list survive into the report itself?** No. Items are TodoList-only. The report is for the human reader; the TodoList is for the operator/dev. Phase G.3 footer is the only user-visible surface.
