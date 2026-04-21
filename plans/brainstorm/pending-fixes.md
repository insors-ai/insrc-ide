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

| # | Item                                                          | Priority | Scope    | Status |
|---|---------------------------------------------------------------|----------|----------|--------|
| 0 | Discuss: agent doesn't respond to the opening prompt          | P0       | daemon   | **DONE** |
| 1 | Brainstorm sub-classifier: LLM with keyword fallback          | P0       | daemon   | **DONE** |
| 2 | Diverge variation placement (user doesn't see their variations)| P1      | daemon   | **DONE** |
| 3 | LLM failure surfacing (diverge + discuss)                     | P1       | daemon+UI| **DONE** |
| 4 | Verify discuss reply end-to-end (superseded by item 0)        | P1       | verify   | deferred (manual test post-build) |
| A | Phase 1 feedback reset runs too early (self-inflicted)        | P0       | daemon   | **DONE** |
| B | Round auto-bump skips the idea-list gate                      | P0       | daemon   | **DONE** |
| C | Round-transition index reuse + rejected-idea regeneration     | P1       | daemon   | **DONE** |
| D | Round-2 prompt redesign: typed feedback sections + refine-first intent | P1 | daemon | **DONE** |
| 5 | Intent validation gate (pre-launch)                           | P2       | daemon+UI| **DONE** (daemon gate emission in chat-handler; dedicated pane built under Item 8a; default policy updated under Item 8c; decomposer confidence threaded under Item 8d) |
| 6 | Mid-turn intent correction                                    | P2       | daemon+UI| **DONE** (daemon `chat.redirect` RPC; `IInsrcChatService.redirect()` in browser; shared `attachRedirectAction` helper; Redirect header button on every brainstorm pane; inline picker with intent dropdown + optional refinement + error surface) |
| 7 | Phase 2 -- session resume                                     | P3       | daemon+UI| **partial** (checkpoint per-session + `agent.resume` read; full rehydrate deferred per idea-feedback.md) |
| 8 | Intent-confirm gate vs. "Intent" progress pill confusion      | P2       | UI       | **DONE** (8a dedicated pane + 8c brainstorm default-on + 8d decomposer confidence threaded; 8b pill hold deferred) |
| 9 | Idea card: references show but aren't clickable / navigable   | P1       | UI       | **DONE** (9a URL opener + 9b unresolved chip; 9c discussion pane refs verified via shared card widget) |
| 10| Idea structure + prompts: title-only cards under-explain ideas| P1       | daemon+UI| **DONE** (rich prompt format w/ Title/Body/Rationale; parseIdeaList multi-line aware; Idea.summary/rationale added; card renders summary + reviewer notes + rationale) |
| 11| Post-ideation flow (converge / themes / spec / presentation)   | P1       | daemon+UI| **partial** (warning strip now rendered by shared base; ideation end-to-end verified on 2026-04-21 through auto-converge; convergence-review gate bug surfaced -- see Item 13) |
| 12| Intent-confirm should render inline in chat panel, not as its own pane | P1 | UI | **DONE** (flow contribution skips dedicated routing; chat-panel gate widget now renders body + labels + needsInput input / intent-dropdown; dedicated pane + input files deleted) |
| 13| Convergence gate emitted with unknown itemType -- routing breaks silently | P0 | daemon | **DONE** (`buildValidateConvergenceTask` emits `structured { phase: 'convergence', itemType: 'convergence-review', item.themes }`; presentation gate also got a structured payload) |
| 14| Add Idea form fails: daemon doesn't register `brainstorm.addIdea` RPC    | P1 | daemon | **DONE** (`injectedIdeas` queue on session; `brainstorm.addIdea` RPC; `getInjectedIdeas` threaded through `TaskOrchestratorDeps`; controller drains and splices into reviewQueue at currentReviewIndex+1 so next card is the user's idea) |
| 15| Clicking a ref in the idea card replaces the brainstorm pane -- user stranded | P1 | UI | **DONE** (card's code/doc ref click now uses `SIDE_GROUP`; brainstorm pane stays visible, file opens in a split) |
| 16| Closing / stopping a brainstorm session doesn't actually stop the stream  | P1 | daemon+UI | **partial** (16a gate rejection already wired; 16c pipeline abort checks + try/catch around gateTaskResult; 16d guardedSend wrapper silences late daemon→client messages; 16b LLM provider abort-signal plumbing deferred) |

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

### Analysis after A/B/C/D fixes landed

The pre-fix prompt pushed the LLM toward net-new ideas + techniques.
With broken feedback (fix A not applied) the LLM had no guidance and
likely paraphrased round-1 accepted ideas -- those paraphrases then hit
the dedup filter and disappeared, leaving very few survivors. Net
symptom: "round 2 produced only one idea."

With the A+D fixes in place the round-2 prompt now:
- Contains the rejected list with an explicit "do NOT propose similar"
  instruction (fix A delivers the feedback into the prompt; fix D types
  it as rejected).
- Contains the diverge list with per-idea direction + "produce 2-3
  variations" instruction (fix D).
- Treats techniques as fallback only.

Expected outcome: round-2 yield should climb from 1 to 4-8 (with at
least 2-3 of those being `inspiredBy` a specific diverged idea).

**Status:** monitor next round-2 run. If yield is still <= 2, check the
raw Ollama response text to pick between candidates 1/2/3. Dedup
(candidate 4) should no longer be the dominant filter because the
prompt now steers the LLM away from paraphrase.

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

## 8. Intent-confirm gate vs. "Intent" progress pill confusion (P2)

### Observation (2026-04-20 live test)

User reported: *"the intent classification showed up temporarily for
approval but automatically disappeared and moved to the next step
without user acceptance."*

### Root cause

There are two distinct things the UI renders during classification and
the user mistook one for the other:

1. **`Intent: <intent>` progress pill** (non-interactive).
   [chat-handler.ts:597](../../src/insrc/daemon/chat-handler.ts#L597)
   emits `send({ stream: 'progress', data: { message: 'Intent: ...' } })`,
   then `resolveController` emits a second one with the sub-category
   and reasoning. The chat panel renders each progress event as a small
   pill that disappears when the next progress event arrives. There is
   no approval button on a pill.

2. **Intent-confirm gate** (interactive, my Item 5 addition at
   [chat-handler.ts:614-664](../../src/insrc/daemon/chat-handler.ts#L614)).
   Fires when `classifier.confirmIntent=true` in config OR
   `classifiedConfidence < 0.4`. In the observed run the decomposer
   took the primary/attached path which hard-codes
   `classifiedConfidence = 1.0`, so `shouldPrompt=false` and no gate
   was ever emitted. What the user saw was the pill in #1.

### User expectation

The pill flashing with reasoning text looks like "intent was approved
somewhere I didn't click". Two complaints conflated:
- "It auto-approved without me." (UX: no visible approve/reject affordance on the pill)
- "The panel flashed and disappeared." (UX: pill animation timing)

### Fix options

**8a. Dedicated pane.** The Item 5 plan noted a
`BrainstormIntentConfirmPane` was deferred. Build it so when the gate
fires, the workbench opens a clearly-labeled pane with Proceed /
Use-different-intent / Cancel buttons. Today the gate renders in the
generic chat-panel widget which is visually indistinguishable from
other gate widgets.

**8b. Make the pill non-dismissible and add a "Confirm" affordance
when the gate is enabled.** Currently pills just re-render on each
progress event. When `classifier.confirmIntent=true`, hold the pill
until the gate resolves.

**8c. Make `classifier.confirmIntent` default to true for brainstorm
turns specifically.** The brainstorm intent is the one most likely
to be mis-classified sub-category-wise (design vs implementation vs
requirements), and the user has repeatedly flagged sub-classification
mistakes as a trust issue. Default opt-in for brainstorm only keeps
the other 14 intents at current behavior.

**8d. Primary/attached path should not hard-code confidence=1.0.**
The decomposer output carries per-action confidence. Today
[chat-handler.ts ~556](../../src/insrc/daemon/chat-handler.ts#L556)
uses `action.confidence`, but the primary/attached branch at
~549 unconditionally sets `classifiedConfidence = 1.0` as if the
decomposition were ground truth. Thread the decomposer's confidence
through so sub-0.4 primary intents trigger the gate.

### Recommendation

Ship 8a + 8c + 8d together. 8a makes the gate readable; 8c makes it
fire for the most-contested intent by default; 8d closes the hole
where primary/attached hides low-confidence classifications.

---

## 9. Idea card references show but are not clickable (P1)

### Observation (2026-04-20 live test)

User reported: *"refs are showing, but user can't click or navigate
to them."*

### Where "refs" are coming from

Two different display paths currently render references; the user
can see text that looks like a ref in either:

- **Card `_renderReferences`** (clickable path). Filters via
  [isOpenableRef](../../src/vs/workbench/contrib/insrc/browser/brainstorm/brainstormCardWidget.ts#L368):
  keeps refs with absolute paths (`/...` or `C:/...`) or `type === 'url'`.
  Click handler only opens `type === 'code' | 'doc'` via
  `editorService.openEditor` -- **`type === 'url'` click is a no-op**,
  which is the likely click-does-nothing case.
- **LLM-emitted `refs:` suffix in the body / title** (non-clickable).
  The daemon's `parseIdeaParts` pulls `refs: entity1, entity2` out of
  the LLM line into a tag list, but any refs that fail
  `resolveRefs` (i.e. the entity name isn't in the repo's
  `EntityIndex`) are dropped, and the stringified refs never make it
  into the clickable `references` array. The LLM may still write the
  raw names into the body as prose, and those bare words look like
  refs to a user.

### Root causes

**9a. `type: 'url'` refs have no click handler.** Only code/doc paths
are routed through `openEditor`. URLs should route through
`openerService.open()` so clicking an `https://...` ref opens the
browser.

**9b. Refs that fail entity resolution are silently dropped.** The
user then sees an idea body that mentions `AgentRouter.dispatch` but
no clickable link, because `entityIndex['AgentRouter.dispatch']` had
no hit. The daemon should still emit a ref with `type: 'code'` and
the raw name, and the UI should render it as a non-clickable
greyed-out chip with a tooltip "couldn't resolve this entity" --
which is less surprising than dropping it entirely.

**9c. References are only rendered on the card, not on the
idea-discussion pane.** The discussion gate carries `idea.references`
via `structured.item`, and `ideaChatPane` passes them into the card
widget, so that path should work. Verify on a discussion card that
refs are rendered; if not, it's a symptom of 9a or 9b.

### Fix

- Extend the click handler to:
  ```ts
  if (ref.type === 'code' || ref.type === 'doc') { /* openEditor */ }
  else if (ref.type === 'url') { this.openerService.open(ref.path); }
  ```
- Drop the "absolute path required" strictness in `isOpenableRef` for
  refs that came from the daemon's `resolveRefs` (those already have
  absolute paths); keep it for the fallback raw-string path.
- Add a non-clickable chip rendering for unresolved entity names, so
  the user at least knows the idea references them.

### Verification

- Approve an idea that has a code ref; click -> editor opens at that
  file.
- Diverge on an idea whose body mentions a type that doesn't exist in
  the repo; the card should render that name as a greyed-out chip
  with a tooltip, NOT as a dead blue link.

---

## 10. Idea structure + prompts: title-only cards under-explain ideas (P1)

### Observation (2026-04-20 live test)

User reported: *"the Idea structure needs to be enhanced along with
the LLM directives to generate ideas, title/description (description
needs to be verbose enough to explain the idea to the user, one line
summaries as is being displayed today doesn't provide enough context)"*

### Current state

- `Idea.title` is one short line extracted from the first period
  (~80 char cap) by [parseIdeaParts](../../src/insrc/agent/tasks/brainstorm/ideas.ts#L234).
- `Idea.body` is literally the full raw line the LLM produced,
  including the title text. On the card, `_renderBody` sets
  `textContent = data.body`, which often just repeats the title.
- The seed prompts ask for ideas in the form
  `[1] Idea text -- tags: tag1 -- refs: entity1`. There's no
  structured section for `title`, `summary`, `motivation`, or
  `expected_outcome`. The LLM is free to cram everything into one
  sentence.
- Claude review produces `reviewTitle`, `reviewDescription`, and
  `reviewRationale`, but only `reviewVerdict` and `reviewRationale`
  are rendered in the UI (and only the latter as a "Review:" strip).
  `reviewDescription` is NOT currently shown.

### Root causes

**10a. Prompt contract.** Current seed prompts across all five
categories output a single-line idea. The card has no richer fields
to display because the data model doesn't capture them.

**10b. Data model.** `Idea` has `title` + `body` but not
`summary`, `motivation`, or `expectedOutcome`. Adding them would let
the card render a 2-3 paragraph description instead of the 80-char
title.

**10c. Card rendering.** Even with `reviewDescription` already in
the model, the card doesn't render it. Low-effort fix.

### Fix

**10a. Update the seed/diverge prompts** for all five categories
(`general`, `design`, `implementation`, `testing`, `requirements`).
Change the output contract from:

```
[N] Idea text -- tags: ... -- refs: ...
```

to JSON with explicit fields:

```json
{
  "title": "short descriptive title",
  "summary": "2-3 sentences explaining what the idea is and why it's interesting",
  "rationale": "1-2 sentences on the motivation / tradeoffs",
  "tags": [...],
  "refs": [...]
}
```

Update `parseIdeaList` to handle JSON output. Keep a fallback
regex-parse for line-format responses so existing behaviour doesn't
break mid-migration.

**10b. Extend `Idea`** with `summary?: string` and `rationale?: string`
fields (`body` stays for backwards-compat + raw text audit).

**10c. Update `BrainstormCardWidget`** to render `summary` under the
title as the primary body text (larger type), then the rationale as a
secondary paragraph. If `summary` is missing (e.g. migrated older
ideas), fall back to `body`.

**10d. Render `reviewDescription`** when present -- separate section
"Reviewer notes" below the summary, before the rationale/references.

### Verification

- Generate ideas -> each card shows Title + 2-3 sentence Summary +
  optional Rationale + optional Reviewer notes + References.
- Regenerate with the same prompt in an older build that lacks
  Item 10's changes -> card still renders via `body` fallback.

---

## 11. Post-ideation flow not yet updated / tested (P1)

### Observation (2026-04-20 live test)

User reported: *"the rest of the flow hasn't been updated"*

In the 2026-04-20 session the user ran through ideation end-to-end
(round 1: 8 seed ideas + 3 diverge variations + 1 discuss + 1 reject)
and reached auto-converge. The logs show:

```
23:41:20  progress step="Clustering ideas into themes (round 1)..."
23:42:15  progress step="Evaluating promotions..."
23:42:42  progress step="Convergence Review (round 1)"
```

i.e. the daemon ran cluster -> promote -> convergence-review, but the
user did not call out successful rendering of any of these downstream
panes. The work historically focused on ideation panes (`IdeasPane`,
`IdeaChatPane`, `IdeaListPane`); the convergence / theme-details /
presentation panes have not been re-validated after the recent
Items 0-D / 1-6 changes.

### Known pane kinds and their routing status

| Gate kind               | Pane class                   | Status   |
|-------------------------|------------------------------|----------|
| `idea`                  | `BrainstormIdeasPane`        | verified |
| `idea-list`             | `BrainstormIdeaListPane`     | verified |
| `idea-discussion`       | `BrainstormIdeaChatPane`     | verified |
| `convergence-review`    | `BrainstormThemesPane`       | NOT verified post-Item changes |
| `theme-spec`            | `BrainstormThemeDetailsPane` | NOT verified post-Item changes |
| `presentation`          | `BrainstormPresentationPane` | NOT verified post-Item changes |

### Known gaps to investigate

**11a.** Convergence-review likely still uses the legacy
content-plus-tabs rendering and may not surface the new `warning`
field from Item 3 if a cluster task fails.

**11b.** Theme-details pane needs a discuss / refine affordance
equivalent to the idea cards. Current status: unknown.

**11c.** Presentation pane may still expect the old
`assembledOutput`-in-content shape rather than the new structured
fields added during the clean-slate commit.

**11d.** Per-theme spec builder walks each accepted theme; if the
flow errors out during `theme-spec` (e.g. Ollama returns malformed
JSON) there's no equivalent of Item 3's warning strip on the
theme-details pane.

### Required

A focused follow-on test session that drives the flow through
convergence + presentation with logs captured, then a new sub-plan
covering all gaps surfaced. Do NOT re-use the existing Phase A0 / A
/ B phasing -- this is its own phase (call it Phase D: post-ideation
flow validation).

### Recommendation

Next test session: run a minimal brainstorm (3 seed ideas, approve
all, force converge), step through every downstream pane, capture
renderer + agent logs. Then file sub-issues per pane.

### Update (2026-04-21 test run)

Ideation end-to-end verified:

- Rich-format titles rendering cleanly ("Context-Aware Assignment
  Service with Selective Caching" rather than the old "-- smart-agen"
  truncation).
- Bug 0 confirmed: first-render of `IdeaChatPane` showed
  `messages count=3` (user prompt + agent response + idea-update marker).
- Item 2 splice confirmed: diverge on idx=6 -> next card was idx=7
  variation, not an unrelated later idea.
- Item 1 LLM sub-classifier returned `design` with reasoning on a
  prompt that the keyword matcher would have bucketed to `general`.

Blockers surfaced (tracked as items 12 + 13 below):

- The intent-confirm dedicated pane took over the editor area for a
  simple yes/no/override prompt -- user wants this inline in the chat
  panel. See Item 12.
- The first convergence gate (post-auto-converge) arrived with
  `kind=unknown phase=waiting`, so the flow contribution dropped it:
  `[brainstorm:flow] unknown gate kind "unknown" (gateId=ctrl-22-...);
  ignoring`. The user never saw the convergence-review pane. See
  Item 13 -- this is P0 because it silently breaks the rest of the
  flow.

---

## 12. Intent-confirm should render inline in the chat panel (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"intent confirm should be in the chat
panel itself rather than opening a new pane"*

### Current behavior

Item 8a shipped a dedicated `BrainstormIntentConfirmPane` that opens
as its own editor when the intent-confirm gate arrives. From the
2026-04-21 log trace:

```
00:18:44.813  gate received kind=intent-confirm phase=classify ...
00:18:44.813  [brainstorm:flow] route kind=intent-confirm ...
00:18:44.818  [brainstorm:pane:intent-confirm] createEditor
00:18:44.822  [brainstorm:flow] openEditor resolved editor=insrc.brainstormIntentConfirmPane
```

This is heavier than the decision warrants -- Proceed / Use-different-intent /
Cancel fits cleanly in a chat gate widget. Opening a full-pane editor for it:

- moves the user away from the chat transcript they were just looking at
- requires the flow contribution to then swap panes again when the idea gate arrives
- leaks brainstorm-specific UI into non-brainstorm-looking territory for what is
  ultimately a classify-step question

### Fix direction

**12a. Skip the dedicated pane; render `intent-confirm` as a gate in
the chat panel.** The generic chat-panel gate widget already renders
gates with buttons + optional text input. Two options for handing off:

- **Option A (minimal):** remove `'intent-confirm'` from the
  brainstorm flow contribution's routing map so the gate is left for
  the generic chat widget to handle. Keep the sub-classification
  setup the way Item 8c does (brainstorm default-on). Delete the
  dedicated pane and input.

- **Option B (keep pane as an option):** leave the pane registered
  but don't open it on-arrival. Add a setting
  `classifier.confirmIntentUI: 'chat' | 'pane'` (default `'chat'`).
  The flow contribution consults the setting. Useful only if someone
  explicitly wants the pane form; probably YAGNI.

Recommend **Option A**. Item 8a turned out to be over-engineered for
this user's workflow.

**12b. Enhance the chat-panel gate widget with an intent dropdown on
the `use-intent` action.** The existing chat-panel gate widget
renders `needsInput: true` actions as a plain text field. For
`use-intent` the daemon lists 15 valid intents; a free-text field
gives the user no hints and risks typos. Make the chat-panel gate
widget look for a `structured.item.choices: string[]` field on the
gate and render a dropdown when present. The daemon adds
`choices: VALID_INTENTS` to the `use-intent` action's structured
payload.

### Implementation

1. Remove `case 'intent-confirm': ...` from
   `brainstormFlowContribution._inputFor` so the kind falls through
   to the generic chat gate.
2. Delete `BrainstormIntentConfirmPane` + `BrainstormIntentConfirmInput`
   + the editorPane registration in `insrc.contribution.ts`.
3. (Optional, nice-to-have) daemon adds `choices: VALID_INTENTS` to
   the `use-intent` gate action so the chat-panel widget can render a
   dropdown.

### Verification

- Classify a brainstorm turn -> intent-confirm gate renders in the
  chat panel (no new editor opens).
- Proceed -> turn continues; Cancel -> turn aborts; Use-different-intent
  -> re-classifies with the override.

---

## 13. Convergence gate emitted with unknown itemType -- routing breaks silently (P0)

### Observation (2026-04-21 live test)

After auto-converge triggered, the daemon ran
`Clustering ideas into themes (round 1)...` ->
`Evaluating promotions...` -> `Convergence Review (round 1)` and
then emitted a gate the flow contribution couldn't route:

```
00:41:43.821  gate received kind=unknown phase=waiting gateId=ctrl-22-1776712303814 itemId=- actions=[approve,edit,diverge] extras=[] sessionActive=true
00:41:43.821  [brainstorm:flow] route kind=unknown sessionId=...
00:41:43.822  [warning] [brainstorm:flow] unknown gate kind "unknown" (gateId=ctrl-22-...); ignoring
00:41:43.823  [brainstorm:session] phase changed -> waiting
```

The gate was dropped, no pane opened, the user was stranded on the
ideas pane with no indication that the convergence step had even
started. Phase rolled back to `waiting`. Session effectively dead.

### Root cause (hypothesis)

The daemon-side converge-review builder in
[base.ts](../../src/insrc/daemon/controllers/brainstorm/base.ts) emits
a gate without setting `structured.itemType = 'convergence-review'`
(or sets an empty / wrong value). The browser's
`classifyGate(itemType)` defaults to `'unknown'` and the flow
contribution logs + ignores.

Needs confirmation by reading the actual convergence-review
gate-build code path + comparing to the `itemType: 'convergence-review'`
string the browser-side `classifyGate` expects.

Related: `phase=waiting` on the gate is also wrong -- for a
convergence-review it should be `phase=convergence`. Likely the
same bug (structured payload not populated).

### Fix

1. Find the daemon-side convergence-review gate emit and ensure the
   task carries `structured = { phase: 'convergence', itemType:
   'convergence-review', item: {...themeList...}, ... }`.
2. Verify themes are populated on the gate (session service needs
   `item.themes: Theme[]` to upsert during ingest -- see
   `_applyGateItem kind === 'convergence-review'` branch).
3. Add defensive logging: when the flow contribution drops a gate,
   also log the `structured` payload keys so it's clear why
   classifyGate picked 'unknown'.

### Verification

- Run brainstorm through to auto-converge -> convergence-review gate
  arrives with `kind=convergence-review phase=convergence`.
- Flow contribution opens `BrainstormThemesPane`.
- Themes are visible in the pane (not just the raw gate content).

### Severity

**P0.** Every brainstorm session that auto-converges hits this
immediately after ideation. Without a fix the entire post-ideation
flow is unreachable from the UI.

---

## 14. Add Idea form fails: daemon doesn't register `brainstorm.addIdea` RPC (P1)

### Observation (2026-04-21 live test)

User clicked `+ Add Idea` on `BrainstormIdeasPane`, entered a title
and body, submitted the form. The form rendered an error row:

> Couldn't add idea: unknown method: brainstorm.addIdea

Screenshot captured by user.

### Root cause (confirmed)

- [ideasPane.ts:367](../../src/vs/workbench/contrib/insrc/browser/brainstorm/step/ideasPane.ts#L367)
  calls `this.daemonService.rpc('brainstorm.addIdea', { sessionId, title, body })`.
- `grep brainstorm\. src/insrc/` returns zero RPC handlers registered
  under that prefix. The daemon never registered a
  `brainstorm.addIdea` handler.
- Net: the form UI is live but the wire on the other end is cut.

### Fix

Daemon-side:

1. Add a handler in `src/insrc/daemon/chat-handler.ts` (export
   `brainstormAddIdea: RpcHandler`) that:
   - Resolves the session by `sessionId`.
   - Reaches the active brainstorm controller (if the controller is
     not the active intent, reject).
   - Pushes a synthetic user-contributed idea into `state.ideas`
     with `source: 'user'`, `status: 'proposed'`, and appends to
     `state.reviewQueue`.
   - Writes a checkpoint (via the same persistence path already used
     by the task pipeline).
   - Returns `{ ok: true, ideaId: <new-id> }` so the UI can show a
     success toast or close the form.

2. Register in `src/insrc/daemon/index.ts` rpc map:
   `'brainstorm.addIdea': brainstormAddIdea`.

3. Scheme: the controller needs a method like
   `injectUserIdea(title, body)` that inserts the idea without a
   full ideation round. Today the closest path is a user-edit action
   on an existing idea; we need a new code path that adds a brand-new
   idea. Matches the UI contract the ideasPane already expects.

### UI follow-up

- On success: close the form and let the next gate tick pick up the
  new idea. Alternatively, emit a progress event
  `"Idea added: <title>"` and include the new idea in the session
  service's `ideas` list immediately.
- On failure (other than "unknown method"): keep the current amber
  error row in the form. Clear it on next submit attempt.

### Verification

- With a brainstorm turn active, click `+ Add Idea`, fill the form,
  submit.
- Form closes without the amber error.
- The new idea appears in the review queue; card shows it with
  `source: user`.

### Severity

**P1.** The `+ Add Idea` button is a core user-contribution path.
Broken since the clean-slate commit that added the button but didn't
register the RPC.

---

## 15. Clicking a ref in the idea card replaces the brainstorm pane -- user stranded (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"links shown in the idea card when
clicked opens the target in the same pane as the session, can't go
back to brainstorming anymore"*

### Current behavior

In [brainstormCardWidget.ts::_renderReferences](../../src/vs/workbench/contrib/insrc/browser/brainstorm/brainstormCardWidget.ts#L205)
the click handler for `type === 'code' | 'doc'` refs calls:

```ts
this.editorService.openEditor({
  resource: uri,
  options: {
    selection: ref.line ? { startLineNumber: ref.line, startColumn: 1 } : undefined,
  },
});
```

With no target group argument, `openEditor` defaults to the
`ACTIVE_GROUP` (the currently-focused editor group). When the
brainstorm pane is open in that group -- which it always is when the
user is looking at a card -- the new file editor **replaces** the
brainstorm pane in that slot. The card disappears. The brainstorm
session is technically still alive in the session service, but the
user has no UI affordance to return to it:

- The editor-tabs history has the brainstorm input just one Back step
  away, but VS Code's Ctrl+Tab / "Go Back" UX is not obvious for
  users who don't know the shortcuts.
- Reopening via the command palette would require the user to know
  the input ID.
- Closing the file editor doesn't auto-restore the brainstorm pane --
  VS Code just shows whatever was in the group before.

Net: a single ref click feels like it ends the brainstorm session
from the user's perspective.

### Root cause

The click handler uses `editorService.openEditor(...)` with no
`groupId` / `group` option, so the ref always lands in the same
group as the brainstorm pane. The URL-type handler (Item 9a) is fine
because `openerService.open()` launches an external browser; it's
the code/doc file-open path that traps.

### Fix

**15a. Open refs in the SIDE_GROUP (split editor).** Pass
`SIDE_GROUP` as the second argument to `openEditor`:

```ts
import { SIDE_GROUP, ACTIVE_GROUP } from '../../../../services/editor/common/editorService.js';

this.editorService.openEditor({
  resource: uri,
  options: {
    selection: ref.line ? { startLineNumber: ref.line, startColumn: 1 } : undefined,
    preserveFocus: false,
  },
}, SIDE_GROUP);
```

This creates a split to the right of the brainstorm pane. The card
stays visible on the left; the referenced file opens alongside. If
the user clicks another ref on the same card, it reuses the same side
group (VS Code behaviour -- subsequent SIDE_GROUP opens hit the same
split).

**15b. Alternative: modifier-key hint in ref tooltip.** Browsers use
Cmd/Ctrl-click to force a new tab; add the same affordance so a
plain click opens in-place and Cmd/Ctrl-click opens in a new group.
Users who don't know the modifier still get the in-place trap unless
we pair this with 15a as the default.

### Recommendation

Ship **15a**. The brainstorm flow owns its pane -- the user has
clearly signalled they want to stay in it. Opening refs in a side
group lets them inspect the code AND continue reviewing cards.

### Verification

- Open a brainstorm session, walk to an idea with clickable refs.
- Click a ref -- a split opens to the right, brainstorm pane stays
  visible.
- Click the next idea's Approve button -- still works without
  re-opening anything.

---

## 16. Closing / stopping a brainstorm session doesn't actually stop the stream (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"stopping a brainstorming session
isn't working"*

Monitor trace shows repeated warnings after the user tried to stop:

```
11:29:53.745  [warning] [insrc] no stream handle for id=20
11:29:53.745  [warning] [insrc] no stream handle for id=20
11:29:53.745  [warning] [insrc] no stream handle for id=20
11:29:58.573  [warning] [insrc] no stream handle for id=20
11:30:51.124  [warning] [insrc] no stream handle for id=20
11:30:51.124  [warning] [insrc] no stream handle for id=20
```

This means:

- The client's stream handle for request id=20 was cleaned up
  (either a cancel or a pane close).
- But messages keep flowing from the daemon (likely daemon-side gate
  re-emits, progress events, or follow-up tasks) and the client
  can't route them anywhere, so they drop with a warning.
- The session wasn't cleanly torn down -- the daemon controller is
  still running, still generating, still trying to drive a gate the
  user no longer has UI for.

### Prior state of close-handling

Today the flow is:

1. User closes the brainstorm pane via the editor close button.
2. `BrainstormStepInputBase.closeHandler` shows the
   "Cancel session?" confirm dialog.
3. On confirm, it calls `chatService.cancelStream()` and
   `chatService.closeSession(sessionId)`.
4. `cancelStream()` RPCs `chat.cancel` which aborts the session's
   AbortController.

Where it breaks:

- `chat.cancel` aborts the AbortController, but the brainstorm
  controller's task pipeline doesn't systematically honour the abort
  signal at every await point. Specifically:
  - `registerExternalGate` promises don't reject on abort today;
    they only resolve when the user clicks a gate button OR when
    `resolveGate` is called from the reply handler. Abort doesn't
    free them.
  - In-flight LLM calls (`provider.complete(...)`) may not be passed
    the abort signal; they keep streaming tokens after cancel.
  - The controller's state store keeps running -- next gate emits
    land on a detached stream handle.

### Fix

Multi-part -- each piece blocks one of the stuck edges.

**16a. Reject `registerExternalGate` promises on abort.**
`DaemonChannel.registerExternalGate` takes a resolve + reject pair.
When the session's AbortController fires, iterate the open-gates
map and reject each with `{ action: 'cancel', reason: 'aborted' }`.
The controller's pipeline loop checks for this and breaks.

**16b. Wire `AbortSignal` into LLM provider calls.** `provider.complete`
accepts options; extend those to include the session's signal.
`OllamaProvider` / `AnthropicProvider` pass it through to the
underlying fetch/SDK so token streams stop on abort.

**16c. Controller abort check.** In `runControlledPipeline`, after
every `await`, check `deps.session.abortController.signal.aborted`
and bail with a clean "cancelled by user" progress event + no more
task emissions.

**16d. Daemon `chat.cancel` also closes the session channel.**
After aborting, also invalidate the session's daemon channel so any
late `send({...})` calls from the controller are no-op, not
"no stream handle" warnings.

### Verification

- Start a brainstorm session, close the pane via the X button,
  confirm cancel.
- No `no stream handle` warnings flood the IDE log afterwards.
- Daemon log shows `brainstorm agent cancelled (user closed pane)`
  within 1-2 s of the close.
- Opening a new chat.send turn works immediately (not blocked
  waiting for the prior session to drain).

### Severity

**P1.** The user explicitly said "stopping isn't working". Every
abandoned brainstorm session today leaks daemon-side work, cloud
LLM calls, and log noise until the daemon is restarted.

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
