# Plan: Pending Brainstorm Fixes

Consolidates every open issue from the last feedback rounds plus the
newly-surfaced sub-classifier bug. Items are grouped by scope and
ordered by impact on the user flow.

Related plans:
- [idea-feedback.md](idea-feedback.md) -- Phase 1 (done, committed) and
  Phase 2 resume (deferred until Phase 1 is field-tested).
- [flow.md](../../design/brainstorm/flow.md) -- source of the UX-gap
  catalog in section 11.

## Summary table

| # | Item                                                          | Priority | Scope    |
|---|---------------------------------------------------------------|----------|----------|
| 0 | Discuss: agent doesn't respond to the opening prompt          | P0       | daemon   |
| 1 | Brainstorm sub-classifier: LLM with keyword fallback          | P0       | daemon   |
| 2 | Diverge variation placement (user doesn't see their variations)| P1      | daemon   |
| 3 | LLM failure surfacing (diverge + discuss)                     | P1       | daemon+UI|
| 4 | Verify discuss reply end-to-end (superseded by item 0)        | P1       | verify   |
| A | Phase 1 feedback reset runs too early (self-inflicted)        | P0       | daemon   |
| B | Round auto-bump skips the idea-list gate                      | P0       | daemon   |
| C | Round-transition index reuse + rejected-idea regeneration     | P1       | daemon   |
| D | Round-2 prompt redesign: typed feedback sections + refine-first intent | P1 | daemon |
| 5 | Intent validation gate (pre-launch)                           | P2       | daemon+UI|
| 6 | Mid-turn intent correction                                    | P2       | daemon+UI|
| 7 | Phase 2 -- session resume                                     | P3       | daemon+UI|

Items A, B, C were identified during a live trace on 2026-04-20 -- all
three were reproducible in a single brainstorm session and all three are
small daemon-side fixes. Details below.

---

## 0. Discuss: agent doesn't respond to the opening prompt (P0)

### Problem

When the user clicks **Discuss...** on an idea card, types a prompt, and
submits, the daemon:

1. Accepts the reply (`afterSingleIdeaReview case 'discuss'`).
2. Pushes the user's text into `state.discussionMessages` as a `user`
   role entry.
3. Runs a code-search RPC.
4. On completion (`afterIdeaDiscussSearch` at
   [base.ts:959](../../src/insrc/daemon/controllers/brainstorm/base.ts#L959))
   **immediately emits `buildIdeaDiscussGate()`** -- the discussion gate
   -- with `structured.messages = state.discussionMessages` which at this
   point contains ONLY the user's opening message.

The UI dutifully routes the new gate to `IdeaChatPane` and renders the
card with that one message. No agent response. The user sees their own
prompt echoed back and nothing else.

To get a reply they would have to click **Respond** or **Refine** on
the new pane and send ANOTHER message -- only then does the LLM fire.

### Confirmed in log trace (2026-04-20 21:04):

```
21:04:43.728  [pane:idea] replyToGate resolved action=discuss
21:04:43.729  progress step="Searching codebase for ..."
21:04:47.221  progress step="Discussing idea [3]"
21:04:47.226  gate received kind=idea-discussion extras=[messages]
21:04:47.236  [pane:idea-discussion] parsed messages count=1   <-- only the user's msg
```

~4 s from click to gate arrival: just the code-search RPC. Zero LLM
time. The assistant message is missing because no assistant LLM task
ran before the gate was emitted.

### Fix (daemon-side)

Edit `afterIdeaDiscussSearch` so it chains into the response-LLM task
instead of emitting the gate directly:

```ts
private afterIdeaDiscussSearch(completed: TaskResult): Task[] {
  // ... existing code that stores focusedIdeaContext ...

  // NEW: if there's an unanswered user message (the one that opened
  // the discussion), run the LLM response task first and only emit
  // the discussion gate after the assistant reply is in state.
  const msgs = this.state.discussionMessages ?? [];
  const lastIsUser = msgs.length > 0 && msgs[msgs.length - 1].role === 'user';
  if (lastIsUser) {
    const idea = this.state.ideas.find(i => i.id === this.state.focusedIdeaId);
    if (idea) {
      this.state.lastStep = 'idea-discuss-respond';
      return [{
        index: this.taskCounter++,
        description: 'Responding to your question...',
        kind: 'llm',
        intent: 'brainstorm',
        systemPrompt: this.getDiscussRespondPrompt(),
        userMessage: this.buildDiscussionContext(idea, msgs[msgs.length - 1].content),
        stateKey: 'discussRespondOutput',
      }];
    }
  }

  // No pending user message -- emit the gate as before.
  this.state.lastStep = 'idea-discuss';
  return [this.buildIdeaDiscussGate()];
}
```

`afterIdeaDiscussRespond` already appends the assistant reply to
`state.discussionMessages` and calls `buildIdeaDiscussGate()`. So with
this change the sequence becomes: search -> LLM respond -> gate with
both messages. User opens the discussion pane and sees the reply
immediately.

### UI contract (unchanged)

Daemon emits gate -> UI renders it. No UI change required; the "no
response" symptom will disappear once the daemon stops emitting the
discussion gate prematurely.

### Verification

- Click Discuss on an idea, enter a question, submit.
- Pane opens with `messages count=2` instead of `1`.
- Discussion section shows both the user's prompt and the agent's
  reply.

### Companion issue: diverge variation placement (see section 2)

Diverge does NOT have this exact bug -- it already runs an LLM task
before advancing. But it has a symptomatically similar UX flaw:
variations are appended to the queue tail and `currentReviewIndex++`
skips past the original, so the user's click of Diverge appears to
produce nothing visible even when the LLM ran successfully. See
section 2 below; the fix there is independent.

---

## 1. Brainstorm sub-classifier: LLM with keyword fallback (P0)

### Problem

`src/insrc/agent/classifier/brainstorm-category.ts` uses whole-word
keyword matching with a strict score threshold. Natural-language
prompts ("brainstorm around building a task-assignment agent"...) hit
zero keywords and always fall to `'general'`, bypassing the
category-specific controllers entirely.

This is also inconsistent with the project's own policy
([design/agent.html:834](../../design/agent.html)): top-level intent
classification uses an LLM because "keywords are brittle and
ambiguous". The sub-classifier violates that policy.

### Goal

Replace the sub-classifier with an LLM-first implementation matching
`src/insrc/agent/classifier/llm-classify.ts`. Keyword matching becomes
the fallback when the local LLM is unavailable.

### Implementation

1. **New file** `src/insrc/agent/classifier/llm-brainstorm-category.ts`:

   ```ts
   export async function classifyBrainstormCategory(
     message: string,
     provider: LLMProvider,
   ): Promise<{
     category: BrainstormCategory;
     confidence: number;
     reasoning: string;
   }> { ... }
   ```

   System prompt: enumerate the five categories with one-sentence
   descriptions of each, demand strict JSON output
   `{ category, confidence: 0..1, reasoning: "one sentence" }`.

2. **Rename** current `brainstorm-category.ts`
   -> `keyword-brainstorm-category.ts`. Export its
   `detectBrainstormCategory` as `keywordDetectBrainstormCategory`.

3. **New entry point** `classifyBrainstormCategoryHybrid(message, provider)`:
   - If `provider` is defined and reachable: call the LLM classifier.
   - On confidence >= 0.6: return LLM result.
   - On low confidence or LLM error: fall back to
     `keywordDetectBrainstormCategory` and return `{ category, confidence: 0.3, reasoning: 'keyword fallback' }`.
   - Log both results for observability.

4. **Wire into `task.ts:1352-1360`:**
   ```ts
   async function resolveController(agentId: string, task?: Task, deps?: TaskDeps): Promise<TaskController | null> {
     if (agentId === 'brainstorm' && task) {
       const msg = task.userMessage ?? task.description ?? '';
       const provider = deps?.session?.resolver.resolve('classifier', 'classify');
       const { category } = await classifyBrainstormCategoryHybrid(msg, provider);
       cacheKey = `brainstorm:${category}`;
     }
     // ...
   }
   ```

   `resolveController` signature grows a third param (deps) so the
   classifier provider can be threaded in from the running pipeline.

5. **Keyword list update (fallback only):** expand synonyms to capture
   "agent / tool / workflow / service / pipeline / endpoint / function /
   story / backlog / mvp / prototype / specify / architect / architecting"
   -- so even the fallback covers more natural language. But keep
   `MIN_SCORE` strict -- we want the LLM to be the primary path.

6. **Debug logging:** emit an `Intent: brainstorm/<category>` progress
   event with the confidence + reasoning. The UI chat panel already
   renders this as an assistant message; users see the reasoning.

### Verification

- Prompts that previously landed on `general`:
  - "Brainstorm around building a smart task assignment agent" -> should
    land on `implementation` or `design` (LLM's call).
  - "Brainstorm a testing approach for our new API" -> `testing`.
  - "Brainstorm the requirements for an audit log feature" -> `requirements`.
  - "Brainstorm fun features for the next hackathon" -> `general`
    (genuinely generic).
- With the daemon's classifier provider unreachable (pull the plug on
  Ollama), the keyword fallback fires and logs a warning. No silent
  regression.

---

## 2. Diverge variation placement (P1)

### Problem (from flow.md section 11.2)

`afterSingleIdeaReview case 'diverge'`:
- New variations are `push`ed to the **tail** of `state.reviewQueue`.
- `state.currentReviewIndex++` advances past the original idea.
- Next card is the next unrelated idea in the queue, not the variations
  the user just asked for.
- User's click appears to "do nothing" even when it worked.

### Fix

`afterDivergeSingle` (line 907). Replace the tail append with a splice
at `currentReviewIndex + 1`:

```ts
private afterDivergeSingle(completed: TaskResult): Task[] {
  if (completed.success && completed.output) {
    const newIdeas = parseIdeaList(completed.output, this.state.round,
      this.state.nextIdeaIndex, this.state.input.repoPath || 'unknown',
      this._entityIndex);

    for (const idea of newIdeas) { this.state.ideas.push(idea); }
    this.state.nextIdeaIndex += newIdeas.length;

    // Splice variations in right after the current index so the next
    // card the user sees IS a variation of the idea they diverged on,
    // instead of an unrelated queue entry.
    const insertAt = this.state.currentReviewIndex + 1;
    this.state.reviewQueue.splice(insertAt, 0,
      ...newIdeas.map(i => i.id));
  }
  this.state.currentReviewIndex++;
  this.state.lastStep = 'idea-review';
  return [this.buildSingleIdeaGate()];
}
```

Also: when `newIdeas.length === 0` (parse failure), surface an inline
warning on the NEXT idea card rather than silently advancing -- see
item 3.

### Verification

- Diverge on idea A with "emphasize X". Next card should be a variation
  of A that touches X.
- Diverge with feedback = "" (empty). Should still produce variations
  via the default-prompt path; same next-card-is-variation behavior.
- Diverge when local LLM returns junk / parse yields 0 ideas. Surface
  the failure (item 3); do not silently skip.

---

## 3. LLM failure surfacing (P1)

### Problem

Two handlers fail silently today:

- `afterDivergeSingle`: if `parseIdeaList` returns empty, no new ideas
  are queued, `currentReviewIndex++` still runs, user sees the next
  unrelated idea with no indication that the diverge flopped.
- `afterIdeaDiscussRespond`: if the LLM task errored (`completed.success
  === false`), `responseText = completed.output` which may be empty.
  Assistant message gets appended with empty content -- visual no-op
  in IdeaChatPane.

### Fix

Two pieces.

#### 3a. Add a `warning` field to `BrainstormGateSnapshot`

File: `src/vs/workbench/contrib/insrc/common/brainstormSessionService.ts`.

```ts
export interface BrainstormGateSnapshot {
  // ... existing fields
  /** Transient warning/error string to surface above the card. Cleared
   *  on the next gate. */
  readonly warning?: string | undefined;
}
```

Session service extracts it from `gate.extra.warning`.

#### 3b. Daemon emits warnings

On `afterDivergeSingle` with 0 parsed ideas:

```ts
this.state.pendingWarning = 'The local LLM returned no usable variations. Try again or adjust your diverge direction.';
```

Next `buildSingleIdeaGate` includes `structured.warning =
state.pendingWarning` and clears the field.

On `afterIdeaDiscussRespond` with `!completed.success` OR empty
`responseText`:

```ts
this.addDiscussionMessage('assistant',
  `[Error: the agent could not respond. ${completed.error ?? 'no output'}]`);
```

So the failure is visible inside the discussion history itself, not a
banner.

#### 3c. UI renders the warning

`BrainstormCardWidget` gets an optional `warning` prop in `CardData`.
If present, render a small amber strip at the top:

```html
<div class="insrc-brainstorm-card-warning">
  <span class="codicon codicon-warning"></span>
  <span>{warning}</span>
</div>
```

Plus CSS.

### Verification

- Disable Ollama -> diverge -> warning appears on the next card.
- Induce an error on the discuss LLM task -> `[Error: ...]` appears
  inline in the discussion history.

---

## 4. Verify discuss reply end-to-end (P1)

### Problem

The daemon code emits assistant replies during discussion via
`state.discussionMessages`, and `buildIdeaDiscussGate` carries them in
`structured.messages`. The new `BrainstormIdeaChatPane` reads
`gate.extra.messages` and passes them to `BrainstormCardWidget.messages`.

This wiring was written in the clean-slate commit
`75b7c9e0844` but has NOT been exercised end-to-end yet. Per round-4
testing, this was the "discuss shows no agent reply" symptom -- the
fix is assumed landed but needs verification.

### Task

No code change if it works. Steps:

1. Restart daemon (post-`91447f761ad`).
2. Reload workbench.
3. Start brainstorm -> approve/reject a few ideas -> click Discuss...
   on one with a question in the prompt.
4. After the daemon LLM replies, `IdeaChatPane` should show the
   assistant response in the discussion section.
5. If it doesn't: trace `extra.messages` at
   `brainstormSessionServiceImpl._ingestGate` -> check that
   `ideaChatPane._renderGate` passes them to `BrainstormCardWidget` --
   the expected message shape is `{ role, content }`.

If broken: fix is a single call-site; already documented in
`flow.md` section 11.3 "Known failure modes".

---

## A. Phase 1 feedback reset runs too early (P0)

### Problem

Phase 1's whole point is: when the user rejects an idea with a reason (or
the template "no reason given" reject), that reason appears in the next
round's generation prompt under `## Prior Feedback on Earlier Ideas`.
Confirmed broken during a live trace: the user rejected idx=6, round
bumped to 2, and round 2's very first (and only) new idea came back with
the **same title as the rejected round-1 idx=6** -- "Ground complexity
estimation in observable metrics". The LLM regenerated the rejected
content because it never saw the rejection in its prompt.

### Root cause

`startIdeationRound` in
[base.ts:413-432](../../src/insrc/daemon/controllers/brainstorm/base.ts#L413)
resets every idea's `feedback[]` to `[]` at the **beginning** of the
round, **before** `buildGenerateIdeasTask` runs:

```ts
private startIdeationRound(): Task[] {
  for (const i of this.state.ideas) {
    i.feedback = [];                        // <-- too early
  }
  if (this.state.round > 1) {
    this.state.lastStep = 'search-context';
    return [this.buildSearchContextTask()];
  }
  this.state.lastStep = 'generate-ideas';
  return [this.buildGenerateIdeasTask()];
}
```

On round 2, execution order is:

1. `startIdeationRound` clears all `idea.feedback[]` -> arrays are now `[]`
2. `buildSearchContextTask` runs (round > 1)
3. `afterSearchContext` -> returns `buildGenerateIdeasTask`
4. `buildGenerateIdeasTask` synthesizes `## Prior Feedback` from
   `state.ideas.filter(i => (i.feedback ?? []).length > 0)` -> **empty**
5. Round 2 LLM prompt omits the feedback block entirely.

I.e. Phase 1 neutralises itself every time it runs.

### Fix

Move the reset from `startIdeationRound` into the bottom of
`buildGenerateIdeasTask`, so the feedback is consumed into the prompt
first and then cleared afterwards:

```ts
private buildGenerateIdeasTask(): Task {
  // ... existing body that reads state.ideas[*].feedback into the
  //     "## Prior Feedback on Earlier Ideas" block ...

  const task: Task = { /* ... */ };

  // Now that the feedback has been stringified into userMessage, clear
  // it so the next round starts with empty arrays. New feedback from
  // round N's review gates will accumulate fresh.
  for (const i of this.state.ideas) {
    i.feedback = [];
  }

  return task;
}
```

And remove the reset loop from `startIdeationRound`.

**Alternative (safer against retries):** keep the reset where it is but
flip the order: call `buildGenerateIdeasTask()` first, then reset, then
return the task. This keeps all the state manipulation in one place and
doesn't require knowing internal order-of-operations.

### Verification

- Round 1: reject idx=6 with empty text, click through the rest, let
  round 2 trigger. Round-2 generation prompt (viewable in the ollama log
  line that shows `messages[0].content`) should contain:
  ```
  ## Prior Feedback on Earlier Ideas
  - [6] "Ground complexity estimation ..."
        reject: Rejected without a stated reason. (default)
  ```
- The LLM should not regenerate the rejected idea verbatim. (Soft check
  -- LLMs may still do this, but the block being present is the
  necessary condition we're testing.)

---

## B. Round auto-bump skips the idea-list gate (P0)

### Problem

Per the flow-map (`flow.md` section 1 and section 7), when the review queue
exhausts without the auto-converge threshold being met, the controller
is supposed to emit an `idea-list` gate so the user can choose:
**Accept remaining**, **Diverge**, **Converge now**. In live testing
with 5 accepted + 1 rejected, the system jumped straight to round 2
generation without ever showing the idea-list gate.

### Root cause

`handleIdeaApprove` in
[base.ts:1185-1200](../../src/insrc/daemon/controllers/brainstorm/base.ts#L1185):

```ts
private handleIdeaApprove(): Task[] {
  this.state.ideas = this.state.ideas.map(i =>
    i.status === 'proposed' ? { ...i, status: 'accepted' as const } : i,
  );

  const acceptedCount = this.state.ideas.filter(i => i.status === 'accepted').length;
  if (acceptedCount >= AUTO_CONVERGE_THRESHOLD || this.state.round >= 2) {
    this.state.mode = 'converge';
    this.state.lastStep = 'converge-cluster';
    return [this.buildConvergeClusterTask()];
  }

  this.state.round += 1;               // <-- auto bump
  return this.startIdeationRound();    // <-- straight to next round
}
```

Two branches: converge (if threshold met or round >= 2), or auto bump
round and re-ideate. There's no path that asks the user what they want.

The `idea-list` gate is emitted in exactly three places
(line 675, 692, 1182), none of which are reachable from the
`resolveReviewQueue -> handleIdeaApprove` flow. So under the default
`sequentialReview: true`, the user walks through per-idea gates and
-- when the queue exhausts -- the controller silently decides for them.

### Fix

Make `handleIdeaApprove` emit the idea-list gate on the non-converge
path. The user then explicitly picks:
- **Accept remaining** -> still calls `handleIdeaApprove` but now with
  the threshold check re-run against the full accepted pool (so
  accept-remaining alone doesn't loop forever; threshold-or-bump decision
  lives on the `accept-remaining` branch).
- **Diverge** -> existing `afterIdeaList case 'diverge'` already bumps
  the round.
- **Converge now** -> forces converge regardless of threshold.

Proposed code:

```ts
private handleIdeaApprove(): Task[] {
  this.state.ideas = this.state.ideas.map(i =>
    i.status === 'proposed' ? { ...i, status: 'accepted' as const } : i,
  );

  const acceptedCount = this.state.ideas.filter(i => i.status === 'accepted').length;
  if (acceptedCount >= AUTO_CONVERGE_THRESHOLD || this.state.round >= 2) {
    this.state.mode = 'converge';
    this.state.lastStep = 'converge-cluster';
    return [this.buildConvergeClusterTask()];
  }

  // Round 1 and below the auto-converge threshold: ask the user via
  // the idea-list gate instead of silently bumping the round. The
  // user picks accept-remaining / diverge / converge from there.
  this.state.lastStep = 'idea-list';
  return [this.buildIdeaListGate()];
}
```

And `afterIdeaList case 'accept-remaining'` can keep calling
`handleIdeaApprove` (recursive-safe: the second call will hit the
threshold-or-round branch since round hasn't changed -- which means it
just... goes to idea-list again. So we need a third branch.)

Actually simpler: make `accept-remaining` on the list gate bump the
round directly (since that was the user's explicit "yes, go ahead"):

```ts
// afterIdeaList:
if (gateReply.action === 'accept-remaining') {
  // Mark all proposed as accepted, then advance the round (converging
  // if the threshold is now met, otherwise triggering the next ideation
  // round).
  this.state.ideas = this.state.ideas.map(i =>
    i.status === 'proposed' ? { ...i, status: 'accepted' as const } : i,
  );
  const acceptedCount = this.state.ideas.filter(i => i.status === 'accepted').length;
  if (acceptedCount >= AUTO_CONVERGE_THRESHOLD || this.state.round >= 2) {
    this.state.mode = 'converge';
    this.state.lastStep = 'converge-cluster';
    return [this.buildConvergeClusterTask()];
  }
  this.state.round += 1;
  return this.startIdeationRound();
}
```

So the split is: `handleIdeaApprove` (invoked when queue empties) now
just emits the idea-list gate. `afterIdeaList` handlers own the actual
round-advance decisions based on the user's choice.

### Verification

- Reproduce: run a brainstorm, click through all idea cards, reject the
  last one.
- Expected: idea-list gate fires -> ThemesPane routes elsewhere --
  actually `idea-list` routes to `BrainstormIdeaListPane` today.
- User picks `Accept remaining` -> round bumps OR converge fires.

---

## C. Round-transition index reuse + rejected-idea regeneration (P1)

### Problem

After round 1 ended with idx=6 rejected, round 2's refine step emitted
a new idea at **idx=6** (collision), with the **same title** as the
rejected idea. Two issues chained:

1. **Index is reused** even though round-1 idx=6 still exists in
   `state.ideas` (as a rejected entry).
2. The rejected title gets regenerated verbatim because the dedup check
   in `afterRefineIdeas` filters against `priorSurvivors` (non-rejected
   only), not against the full pool.

### Root cause

`afterRefineIdeas` at
[base.ts:614-669](../../src/insrc/daemon/controllers/brainstorm/base.ts#L614):

```ts
const priorSurvivors = this.state.ideas.filter(
  i => i.round < this.state.round && i.status !== 'rejected',
);

// Dedup refinedIdeas against priorSurvivors by title prefix so
// paraphrased round-1 ideas don't appear twice.
const priorTitleKeys = new Set(
  priorSurvivors.map(i => i.title.slice(0, 60).toLowerCase().trim()),
);
const uniqueRefined = refinedIdeas.filter(i => {
  const key = i.title.slice(0, 60).toLowerCase().trim();
  return !priorTitleKeys.has(key);
});

// Renumber refined ideas
const startIndex = priorSurvivors.length > 0
  ? Math.max(...priorSurvivors.map(i => i.index)) + 1
  : 1;
for (let i = 0; i < uniqueRefined.length; i++) {
  uniqueRefined[i]!.index = startIndex + i;
  // ...
}

this.state.ideas = [...priorSurvivors, ...uniqueRefined];
this.state.nextIdeaIndex = Math.max(...this.state.ideas.map(i => i.index), 0) + 1;
```

Bugs:

- `priorSurvivors` excludes `rejected` ideas. If idx=6 was rejected,
  `max(priorSurvivors.index) = 5`, `startIndex = 6`. Refined idea gets
  idx=6, colliding with the (now removed-from-survivors) rejected idea.
- `priorTitleKeys` is built from survivors only. A refined idea with
  the same title as a rejected one passes the dedup check and gets
  emitted. This is precisely the "rejected ideas come back" regression
  Phase 1 was supposed to prevent.
- `state.ideas = [...priorSurvivors, ...uniqueRefined]` **replaces** the
  full `state.ideas` with survivors + refined. Rejected ideas from
  prior rounds are **dropped entirely**. So the audit trail of "user
  rejected this" is lost from `state.ideas` (it still lives in
  `state.qna`, but any later lookup of `state.ideas.find(i => i.id === x)`
  for a rejected idea will fail).

### Fix

Three edits in `afterRefineIdeas`:

1. **Keep rejected ideas in state.ideas.** Carry them forward so they
   persist across rounds:

   ```ts
   const priorRejected = this.state.ideas.filter(
     i => i.round < this.state.round && i.status === 'rejected',
   );
   ```

   and at the end:

   ```ts
   this.state.ideas = [...priorRejected, ...priorSurvivors, ...uniqueRefined];
   ```

2. **Dedup against rejected titles too.** A refined idea with the same
   prefix as a rejected idea should be dropped:

   ```ts
   const dedupKeys = new Set([
     ...priorSurvivors.map(i => i.title.slice(0, 60).toLowerCase().trim()),
     ...priorRejected.map(i => i.title.slice(0, 60).toLowerCase().trim()),
   ]);
   const uniqueRefined = refinedIdeas.filter(i =>
     !dedupKeys.has(i.title.slice(0, 60).toLowerCase().trim()),
   );
   ```

3. **Compute startIndex against the full pool** (survivors + rejected),
   so indices never collide:

   ```ts
   const maxPriorIdx = Math.max(
     0,
     ...priorSurvivors.map(i => i.index),
     ...priorRejected.map(i => i.index),
   );
   const startIndex = maxPriorIdx + 1;
   ```

With these changes, rejected indices are reserved and rejected titles
are excluded from regeneration. Combined with fix A (prior feedback
actually reaches the LLM), the rejected-idea-comes-back bug is cured
from both sides: the LLM sees the rejection reason AND any paraphrase
that slips past is dropped by dedup.

### Verification

- Reject idx=6, let round 2 happen. Inspect the post-refine state:
  - `state.ideas` contains idx=6 (rejected) + new round-2 ideas at idx 7+.
  - No refined idea has idx=6.
  - No refined idea has the same title as the rejected idx=6.
- `state.qna` trail still contains the original rejection event.

### Open question

The live trace showed round 2 producing **only one** new idea. Expected
4-8 from the diverge-technique LLM prompt. Candidates:
1. LLM under-generated (prompt or model flake).
2. Claude review marked most as "weak" and the review step flags
   "all weak -> skip refine, re-run ideation" (`afterReviewIdeas` at
   [base.ts:597-611](../../src/insrc/daemon/controllers/brainstorm/base.ts#L597))
   but that specific re-run was not observed in the log.
3. Refine LLM dropped most, returning only one idea.
4. Dedup filter removed most as title-matches of priorSurvivors.

Needs the raw Ollama response text for round 2 generate+refine to root-
cause. Not blocking the A/B/C fixes since all three are independently
reproducible.

---

## D. Round-2 prompt redesign: refine + extend, typed feedback (P1)

### Problem

Round 2's current goal is "generate 4-8 NEW ideas using creative
techniques". That framing doesn't match how users actually use round 2
-- they rejected some ideas (wanting them gone for good), flagged
others for deeper exploration (wanting variations that follow their
direction), and kept the rest. The LLM should respond to those signals
type-by-type, not just keep firehosing fresh concepts.

Observed in the current prompt:

- `## Prior Feedback on Earlier Ideas` (my Phase 1 block) is flat:
  ```
  - [6] "Ground complexity estimation..."
        reject: Rejected without a stated reason. (default)
  - [4] "Enrich task schema..."
        diverge: make it pluggable per domain
  ```
  The LLM has to infer what to do with each action name. "reject" is
  NOT phrased as "do not regenerate this"; "diverge" is NOT phrased as
  "produce 2-3 variations incorporating the direction". No per-type
  instruction.
- `## Techniques to Apply` and the system prompt
  (`DIVERGE_*_SYSTEM`) both push the LLM toward "produce new ideas via
  creative techniques". Nothing about refining specific flagged ideas.
- `state.recentFeedback` (bulk diverge text from the idea-list gate)
  lands in `## User Direction` as a raw paragraph. Useful but not
  attached to specific ideas.

### Desired behaviour (from user, 2026-04-20)

Round 2 should:

1. Feed rejected ideas to the LLM with explicit instruction: "the user
   doesn't want similar concepts -- avoid these."
2. Feed diverged ideas with the user's per-idea direction and instruct:
   "produce 2-3 variations of this specific idea incorporating that
   direction."
3. Treat discussed ideas as already-resolved -- by round 2 the
   discussion has ended with accept or reject (once Bug 0 is fixed),
   so no separate handling is needed. The discussion transcript lives
   in `state.qna` for reference; `buildQnAContext` already threads it
   into the prompt.
4. Leave accepted ideas untouched (they stay in the pool).
5. Only produce entirely new ideas via techniques IF a gap remains that
   none of the directions or existing accepted ideas cover.

### Root cause / design gap

- `buildGenerateIdeasTask` ([base.ts:1783](../../src/insrc/daemon/controllers/brainstorm/base.ts#L1783))
  doesn't partition feedback by action. One flat block, LLM guesses.
- `DIVERGE_*_SYSTEM` prompts don't describe the "refine specific
  ideas" responsibility -- they only talk about techniques and net-new
  ideas.
- Per-idea diverge direction lives in `idea.feedback[]` (Phase 1,
  blocked by fix A) and simultaneously in `state.recentFeedback` (bulk
  rollup from the idea-list gate). The two sources of truth risk
  contradiction once both round paths trigger diverge.

### Fix

Restructure the round-2 user message with typed sub-sections and
rewrite the diverge system prompts to respect them. All changes in the
daemon.

**1. Split feedback in `buildGenerateIdeasTask`** (after fixes A and C
land, rejected ideas are retained in `state.ideas` and their
`feedback[]` is populated):

```ts
// After the existing "## Existing Accepted Ideas" block, replace the
// single "## Prior Feedback" block with typed sections:

const rejected = this.state.ideas.filter(i =>
  i.status === 'rejected' && (i.feedback ?? []).some(f => f.action === 'reject'),
);
if (rejected.length > 0) {
  const lines = rejected.map(i => {
    const rej = (i.feedback ?? []).find(f => f.action === 'reject');
    const suffix = rej?.templated
      ? '-- no reason given'
      : `-- reason: ${rej?.reason ?? 'unspecified'}`;
    return `- [${i.index}] "${i.title}" ${suffix}`;
  }).join('\n');
  userMessage += `\n\n## Rejected Ideas (do NOT propose similar concepts)\n${lines}`;
}

const divergeEntries = this.state.ideas.flatMap(i =>
  (i.feedback ?? [])
    .filter(f => f.action === 'diverge')
    .map(f => ({ idea: i, feedback: f })),
);
if (divergeEntries.length > 0) {
  const lines = divergeEntries.map(({ idea, feedback }) =>
    `- from [${idea.index}] "${idea.title}": direction: ${feedback.reason}${feedback.templated ? ' (default)' : ''}`,
  ).join('\n');
  userMessage += `\n\n## Directions to Explore (produce 2-3 variations of each, incorporating the direction)\n${lines}`;
}

// Techniques block now becomes the "fallback for gaps" section.
userMessage += `\n\n## Additional Techniques (use ONLY if a gap remains after the directions above)\n${techniqueBlock}`;

// Drop `state.recentFeedback` -> `## User Direction` section on
// round > 1 -- per-idea diverge feedback supersedes it. Keep only if
// the bulk-diverge-from-idea-list path is exercised; in that case, the
// per-idea feedback already captures the same text.
```

**2. Rewrite `DIVERGE_*_SYSTEM` prompts** (one per category):

```
You are refining a brainstorm pool based on the user's feedback from
the previous round.

Priority order, top to bottom:

1. DIRECTIONS TO EXPLORE: for each "from [N] <Title>" the user flagged,
   produce 2-3 variations of THAT specific idea that incorporate the
   user's direction. Stay close to the original's scope and intent;
   reshape along the direction.

2. REJECTED IDEAS: do not regenerate anything similar to the rejected
   ideas. If the user gave a reason, internalise it; if they gave no
   reason, assume the concept itself was unwelcome.

3. NEW IDEAS (optional, fallback only): if the directions above don't
   cover a gap in the problem space, propose 1-2 entirely new ideas
   using the techniques section. Do not produce more than 2 new ideas
   without a clear gap justification.

The EXISTING ACCEPTED IDEAS stay in the pool unchanged -- do not
restate or slightly rephrase them.

For each idea you output:
- Title (1 line)
- Body (1-2 sentences)
- Tags
- inspiredBy: the index of the original idea if this is a variation,
  empty if it's a new idea.

Output format: JSON array of { title, body, tags, inspiredBy? }.
```

Apply analogous edits to `DIVERGE_DESIGN_SYSTEM`,
`DIVERGE_IMPLEMENTATION_SYSTEM`, `DIVERGE_TESTING_SYSTEM`,
`DIVERGE_REQUIREMENTS_SYSTEM`.

**3. Deprecate `state.recentFeedback` for the non-bulk path.** Phase 1
already records per-idea diverge feedback in `idea.feedback[]`. The
`recentFeedback` field becomes useful only for the bulk-diverge-from-
idea-list path (a single "here is the shape of my critique of this
whole round" paragraph). Keep the field but rename its prompt slot to
`## Overall Direction (bulk)` and include it only when populated from
the bulk path.

### Interaction with fix A (feedback reset ordering)

The typed structure works only because `idea.feedback[]` is still
populated when `buildGenerateIdeasTask` runs. Fix A must land first,
otherwise the Rejected and Directions sections will be empty on every
round.

### Interaction with fix C (rejected ideas retained)

Rejected ideas must be kept in `state.ideas` across rounds for the
Rejected section to find them. Fix C does this.

### Verification

- Round 1: reject idx=3 with reason "too narrow"; diverge idx=4 with
  direction "pluggable per domain"; approve idx 1, 2, 5, 6.
- Trigger round 2 (via `idea-list -> Diverge` or `-> Accept remaining`
  once B is fixed).
- Round-2 `buildGenerateIdeasTask` user message should contain:
  ```
  ## Rejected Ideas (do NOT propose similar concepts)
  - [3] "Bulk spreadsheet upload" -- reason: too narrow

  ## Directions to Explore (produce 2-3 variations of each, incorporating the direction)
  - from [4] "Enrich task schema...": direction: pluggable per domain

  ## Additional Techniques (use ONLY if a gap remains after the directions above)
  ### What-if inversion
  ...
  ```
- Output: at least 2-3 ideas with `inspiredBy: 4` (variations of the
  diverged idea), zero with `inspiredBy: 3` (rejected), 0-2 with
  `inspiredBy: null` (new).

### Open question

The current diverge `idea.feedback[]` supports multiple entries per
idea (each discuss turn pushes an entry -- decision D1). When collapsing
into the Directions block, do we:
- Concatenate all `discuss`-action entries per idea as context? or
- Only use the `diverge` entry (the single "I want to extend this")?

Recommend: only `diverge` for the Directions block. `discuss` entries
are resolved by the time round 2 runs (idea ends up accepted/rejected);
their transcripts are still available via `state.qna -> buildQnAContext`
for the LLM to consult.

---

## 5. Intent validation gate (P2)

### Problem

The classifier (top-level intent and brainstorm sub-category) can still
be wrong. Users have no way to review the classification before the
agent pipeline launches.

### Fix

New daemon-side gate that fires **after** classification and **before**
the first agent task.

New gate kind `intent-confirm` with:
- `structured.phase = 'classify'`
- `structured.itemType = 'intent-confirm'`
- `structured.item = { intent, subCategory?, confidence, reasoning }`
- `gateActions = ['proceed', 'use-intent', 'cancel']`

Flow:
- `proceed`: existing agent pipeline runs.
- `use-intent` (needsInput, user types a different intent name):
  re-dispatch with the override. If the new intent is brainstorm, run
  sub-category classification again on the user's message.
- `cancel`: abort the turn cleanly.

New browser pane `BrainstormIntentConfirmPane` (or folded into a more
generic `IntentConfirmPane` if we later extend this to non-brainstorm
intents -- start brainstorm-scoped to keep scope tight).

Settings: `insrc.classifier.confirmIntent` (boolean, default false).
When true, the gate fires on every turn that classifies above
confidence `0.4`. Low-confidence turns always prompt.

### Dependencies

- Depends on item 1 (sub-classifier with LLM) -- the confidence+reasoning
  fields the gate displays only have meaning with the LLM classifier.

---

## 6. Mid-turn intent correction (P2)

### Problem

Even with item 5, once the agent pipeline is running the user has no
way to say "this isn't what I meant". The only escape is
cancel-stream, which kills the turn without context.

### Fix

Add a `Redirect` action on `IdeasPane` (and eventually every brainstorm
pane) in the header. Clicking it:
1. Calls `chatService.cancelStream()` to halt the daemon pipeline.
2. Opens a prompt "Re-classify this turn as which intent?" with a
   dropdown of the 11 known intents + a free-text refinement field.
3. Calls a new RPC `chat.redirect({ sessionId, intent, subCategory?, refinedMessage })`
   that rebuilds the task pipeline with the user's chosen intent.

The daemon handler hydrates the new pipeline with the prior context
(codebaseFindings, entityIndex, etc.) so nothing is re-searched.

### Dependencies

- Depends on item 5 -- if the pre-launch gate exists, mid-turn correction
  is much rarer. Item 5 is the prevention, item 6 is the escape hatch.

---

## 7. Phase 2 -- session resume (P3)

Already fully planned in [idea-feedback.md section Phase 2](idea-feedback.md).
Decisions F1/G2/H1/I2 locked. Implementation deferred until Phase 1
(feedback capture -- already shipped) is field-tested.

---

## Ordered execution

Recommended sequencing:

1. **Phase A0 (correctness -- ship first, tiny changes).** Items 0, A,
   B, C. Four daemon-only edits, each localised to one handler. These
   restore Phase 1's intended behaviour and fix the round-transition
   data-loss. Until these land, the rest of the work is fighting a
   broken baseline.
2. **Phase A (unblock wider testing).** Items 1, 2, 3, 4. LLM
   sub-classifier + diverge UX + LLM error surfacing + discuss-reply
   verification.
3. **Phase B (prevention + escape hatches).** Items 5, 6. Depends on
   Phase A for the LLM-backed classifier.
4. **Phase C (resilience).** Item 7 (session resume).

Phase A0 alone fixes the "rejected ideas come back" regression and the
missing-idea-list-gate jump. Ship first, re-test, then move to Phase A.

## Files to create / modify (Phase A0)

| File                                                | Change                                                                      |
|-----------------------------------------------------|-----------------------------------------------------------------------------|
| src/insrc/daemon/controllers/brainstorm/base.ts     | Item 0: `afterIdeaDiscussSearch` chains to LLM when pending user message.   |
| src/insrc/daemon/controllers/brainstorm/base.ts     | Item A: remove reset from `startIdeationRound`; add reset to `buildGenerateIdeasTask` after userMessage built. |
| src/insrc/daemon/controllers/brainstorm/base.ts     | Item B: `handleIdeaApprove` returns `buildIdeaListGate()` on the non-converge path; round advance moves to `afterIdeaList case 'accept-remaining'`. |
| src/insrc/daemon/controllers/brainstorm/base.ts     | Item C: `afterRefineIdeas` keeps rejected in `state.ideas`, dedups against rejected titles, computes `startIndex` against the full pool. |
| src/insrc/daemon/controllers/brainstorm/base.ts     | Item D: `buildGenerateIdeasTask` emits typed sub-sections (Rejected / Directions / Additional Techniques) instead of flat `## Prior Feedback`. |
| src/insrc/agent/tasks/brainstorm/prompts/general.ts        | Item D: rewrite `DIVERGE_GENERAL_SYSTEM` to prioritise variations + reject-avoidance over generic technique-driven generation. |
| src/insrc/agent/tasks/brainstorm/prompts/design.ts         | Item D: same rewrite for `DIVERGE_DESIGN_SYSTEM`. |
| src/insrc/agent/tasks/brainstorm/prompts/implementation.ts | Item D: same rewrite for `DIVERGE_IMPLEMENTATION_SYSTEM`. |
| src/insrc/agent/tasks/brainstorm/prompts/testing.ts        | Item D: same rewrite for `DIVERGE_TESTING_SYSTEM`. |

Items 0, A, B, C are all in `base.ts`. Item D also touches the four
category prompt files. No UI / type changes required for A0.

## Files to create / modify (Phase A)

| File                                                                 | Change                                                             |
|----------------------------------------------------------------------|--------------------------------------------------------------------|
| src/insrc/agent/classifier/llm-brainstorm-category.ts (new)          | LLM-based sub-classifier                                           |
| src/insrc/agent/classifier/keyword-brainstorm-category.ts (renamed)  | Was `brainstorm-category.ts`; keeps keyword matcher as fallback    |
| src/insrc/agent/classifier/classify-brainstorm-category.ts (new)     | Hybrid entrypoint (LLM first, keyword fallback)                    |
| src/insrc/daemon/task.ts                                             | `resolveController` calls hybrid classifier                        |
| src/insrc/daemon/controllers/brainstorm/base.ts                      | Splice fix in `afterDivergeSingle`; pendingWarning threading       |
| src/insrc/agent/tasks/brainstorm/agent-state.ts                      | Add optional `pendingWarning` field                                |
| src/vs/workbench/contrib/insrc/common/brainstormSessionService.ts    | `warning` field on `BrainstormGateSnapshot`                        |
| src/vs/workbench/contrib/insrc/browser/brainstorm/brainstormSessionServiceImpl.ts | Extract `warning` from `extra`                          |
| src/vs/workbench/contrib/insrc/browser/brainstorm/brainstormCardWidget.ts        | Render the warning strip                                |
| src/vs/workbench/contrib/insrc/browser/brainstorm/step/ideasPane.ts              | Pass `warning` to `CardData`                            |
| src/vs/workbench/contrib/insrc/browser/brainstorm/media/brainstorm.css           | `.insrc-brainstorm-card-warning` style                  |

## Verification

### Phase A0

1. **Item 0** (discuss auto-reply): click Discuss on an idea, submit
   text. First rendering of IdeaChatPane shows `messages count=2`
   (user + agent). No second click required.
2. **Item A** (feedback reset): after round 1, reject idx=N. Round-2
   generation prompt (ollama log) contains `## Prior Feedback on
   Earlier Ideas` with the rejected idea listed. The LLM should not
   regenerate the rejected title verbatim.
3. **Item B** (idea-list gate): run a short brainstorm, click through
   all round-1 ideas with at least one reject, final reject. The
   `idea-list` gate fires -> `BrainstormIdeaListPane` opens. User picks
   one of accept-remaining / diverge / converge.
4. **Item C** (index reuse): reject idx=N in round 1. Let round 2 run.
   The new idea does not reuse idx=N and does not have the same title
   as the rejected one.

### Phase A

1. **Sub-classifier** (item 1): the four test prompts above land on the
   expected categories; `Intent: brainstorm/<category>` progress event
   shows LLM reasoning.
2. **Variation placement** (item 2): diverge -> next card IS the
   variation.
3. **LLM failure surfacing** (item 3): Ollama stopped -> diverge ->
   warning strip on the card. Discuss with errored LLM -> `[Error: ...]`
   in discussion history.
4. **Discuss reply** (item 4): send a respond message, assistant reply
   appears in the discussion area.
