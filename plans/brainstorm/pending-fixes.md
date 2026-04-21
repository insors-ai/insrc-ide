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
| 7 | Phase 2 -- session resume                                     | P1       | daemon+UI| **DONE** (7a real chat.resumeFromCheckpoint + rehydrate from checkpoint; 7b controller.buildResumeTask rebuilds gate task for gate-emitting lastStep; 7c resume-confirm gate with retry/abandon for in-flight lastStep -- G2; 7d Runs sidebar resumeRun does agent.resume + chatService.resumeFromCheckpoint handshake; 7e schemaVersion-stamped checkpoints, agent.resume refuses drift -- I2. Residual: parametric in-flight retry -- refine-ideas/theme-spec -- abandon only; tracked under 7f below.) |
| 8 | Intent-confirm gate vs. "Intent" progress pill confusion      | P2       | UI       | **DONE** (8a dedicated pane + 8c brainstorm default-on + 8d decomposer confidence threaded; 8b pill hold deferred) |
| 9 | Idea card: references show but aren't clickable / navigable   | P1       | UI       | **DONE** (9a URL opener + 9b unresolved chip; 9c discussion pane refs verified via shared card widget) |
| 10| Idea structure + prompts: title-only cards under-explain ideas| P1       | daemon+UI| **DONE** (rich prompt format w/ Title/Body/Rationale; parseIdeaList multi-line aware; Idea.summary/rationale added; card renders summary + reviewer notes + rationale) |
| 11| Post-ideation flow (converge / themes / spec / presentation)   | P1       | daemon+UI| **partial** (warning strip now rendered by shared base; ideation end-to-end verified on 2026-04-21 through auto-converge; convergence-review gate bug surfaced -- see Item 13) |
| 12| Intent-confirm should render inline in chat panel, not as its own pane | P1 | UI | **DONE** (flow contribution skips dedicated routing; chat-panel gate widget now renders body + labels + needsInput input / intent-dropdown; dedicated pane + input files deleted) |
| 13| Convergence gate emitted with unknown itemType -- routing breaks silently | P0 | daemon | **DONE** (`buildValidateConvergenceTask` emits `structured { phase: 'convergence', itemType: 'convergence-review', item.themes }`; presentation gate also got a structured payload) |
| 14| Add Idea form fails: daemon doesn't register `brainstorm.addIdea` RPC    | P1 | daemon | **DONE** (`injectedIdeas` queue on session; `brainstorm.addIdea` RPC; `getInjectedIdeas` threaded through `TaskOrchestratorDeps`; controller drains and splices into reviewQueue at currentReviewIndex+1 so next card is the user's idea) |
| 15| Clicking a ref in the idea card replaces the brainstorm pane -- user stranded | P1 | UI | **DONE** (card's code/doc ref click now uses `SIDE_GROUP`; brainstorm pane stays visible, file opens in a split) |
| 16| Closing / stopping a brainstorm session doesn't actually stop the stream  | P1 | daemon+UI | **partial** (16a gate rejection already wired; 16c pipeline abort checks + try/catch around gateTaskResult; 16d guardedSend wrapper silences late daemon→client messages; 16b LLM provider abort-signal plumbing deferred) |
| 17| Brainstorm LLM tasks ignore `models.agents.brainstorm.*` config overrides | P1 | daemon | **DONE** (Task gains `resolverAgent` + `resolverStep`; `executeLlmTask` calls `session.resolver.resolveOrNull()` before falling back to `providerHint`; all 12 brainstorm LLM tasks tagged with step names: seed/diverge/enhance/review/refine/cluster/promote/theme-spec/theme-spec-review/assemble/discuss) |
| 18| Duplicate / near-duplicate ideas surface in the review queue              | P1 | daemon | **partial** (18a prompt-level dedup shipped; 18b embedding-based dedup **deferred** pending 18a field-test results; 18c "similar-to" chip sits behind 18b) |
| 19| No UX feedback after `+ Add Idea` submit -- user can't tell if it worked  | P1 | UI | **DONE** (19a inline success banner confirms "Idea X added. Auto-accepted..."; 19b daemon progress event deferred -- UI banner covers the user need) |
| 20| User-added idea still requires Approve click -- should be auto-accepted   | P1 | daemon | **DONE** (20a: injected-ideas drain sets `status: 'accepted'` and skips the reviewQueue; user ideas now go straight into the accepted pool for clustering / convergence) |
| 21| Chat-panel Stop/Cancel button doesn't actually cancel (close-tab does)    | P1 | UI | **DONE** (Stop button handler now runs `cancelStream()` AND `closeSession()` when a brainstorm is active, matching tab-close behaviour) |
| 22| Progress bar stays stuck on last step after session cancel / close        | P1 | UI | **DONE** (`cancelStream` + `closeSession` now fire synthetic `streamEnd` event; chatView listens to brainstorm session deactivation and hides the bar) |
| 23| Step Provider Settings still uses old Claude-focused framework            | P1 | UI | **DONE** (23a editor rebuilt w/ per-row provider+model dropdowns, orphan-binding detection; 23b `mergeAgents` runs migration on every load -- `claude:*` -> `{provider: 'anthropic'}`, unknown strings dropped, logs counts; 23c parseBinding's silent "unknown string -> local" fallback replaced with a loud log + active-provider fallback; 23d dropdown restricted to Local + active cloud; 23e editor always writes StepBinding objects) |
| 24| Intent / sub-intent classification should persist as a chat message       | P2 | UI | **DONE** (`_ingestIntentAnnouncement` no longer suppressed during brainstorm; splits headline / subintent / reasoning into a formatted assistant message) |
| 25| Unify chat-panel Cancel and Pane-close into a single handler              | P1 | UI | **DONE** (new `IInsrcChatService.cancelBrainstormSession(reason)` does cancel + close + streamEnd + `onRequestCloseBrainstormPanes`; flow contribution listens and closes every brainstorm editor; both UI entry points call this method with the same confirm modal) |
| 26| Step Providers pane empty even when Model Providers is configured         | P1 | daemon+UI | **DONE** (26b shared `agent-steps.ts` catalog; 26a `setProvidersConfig` seeds via `buildDefaultAgentBindings` on active-cloud switch; 26c `loadConfig` seeds on stale-config load; 26d editor empty state now points at Model Providers with an Open button) |
| 27| Step Providers editor: styling + Clear-button-as-icon polish              | P2 | UI | **DONE** (CSS moved to `setupWizard.css`; inline styles stripped from rows, headers, active-banner, empty state; Clear became icon-only `trash` codicon) |
| 28| Step Providers editor: changing provider collapses the expanded section   | P1 | UI | **DONE** (agent body opens with `display: block` + chevron rotated when `_expandedAgent === agentName` so rebuilds preserve the user's position) |
| 29| Intent-confirm gate only fires for brainstorm -- other intents bypass user confirmation | P0 | daemon | **DONE** (policy flipped: every classification fires the gate unless `classifier.confirmIntent: false`; `gateFired` decision line logged on every classify) |
| 30| Requirements/Designer validate gate has `kind=unknown phase=waiting` (same class as Item 13) | P0 | daemon | **DONE** (all 4 designer gate tasks now emit structured payloads with `itemType` = `designer-validate-requirements` / `-sketch` / `-detail` / `designer-save`; chatView's phase-based suppression narrowed so non-brainstorm sessions render their gates) |
| 31| Stream inactivity timeout leaves the daemon session alive + 10m window too short | P0 | UI      | **DONE** (`onDidError` now runs unified `cancelBrainstormSession` teardown, skipping the confirm dialog; `STREAM_INACTIVITY_TIMEOUT_MS` bumped 10m -> 30m to stop false-positiving on long cloud agent turns) |
| 32| Long agent steps feel disconnected -- user waits minutes on a single progress line with no token-level presence | P1 | daemon+UI | **open** |

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

### Status (2026-04-21 investigation)

Effectively subsumed by Item 0 (DONE). [base.ts:1117-1140](../../src/insrc/daemon/controllers/brainstorm/base.ts#L1117-L1140)
now chains into the LLM response task before emitting
`buildIdeaDiscussGate()` when the last entry in
`state.discussionMessages` is from the user. So the wiring is there
and exercised by Item 0's auto-reply path.

What remains is a **pure manual verification** -- zero code work
unless the test fails. Run it as part of the next brainstorm smoke
pass and close this item.

### Manual verification steps

1. Start a brainstorm session, approve/reject a few ideas.
2. Click **Discuss...** on an idea, type a question in the opening
   prompt, submit.
3. `IdeaChatPane` should show `messages count=2` on first render
   (user prompt + agent response). No second click required.
4. If `messages count=1`: the auto-reply chain regressed. Trace
   `extra.messages` at `brainstormSessionServiceImpl._ingestGate`
   and re-check [base.ts:1124 onwards](../../src/insrc/daemon/controllers/brainstorm/base.ts#L1124).

### Remaining work

None (assuming verification passes). Close the item after one
successful discuss turn.

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

## 7. Phase 2 -- session resume (P1)

Already fully planned in [idea-feedback.md section Phase 2](idea-feedback.md).
Decisions F1/G2/H1/I2 locked.

### Status (2026-04-21 investigation)

**Shipped:**
- Per-session checkpoint file layout (P2.3 goal) -- files now named
  `${controllerId}-${sessionId}.json`, one file per session, overwritten
  in place. See [task.ts checkpointState](../../src/insrc/daemon/task.ts#L814).
- `agent.list` RPC returns these entries with `sessionId`,
  `controllerId`, `createdAt`.
- `agent.resume` RPC at
  [daemon/index.ts:257-283](../../src/insrc/daemon/index.ts#L257-L283)
  finds the matching checkpoint by `sessionId`, parses it, returns
  `{ ok, sessionId, controllerId, message }`.
- `agent.discard` RPC deletes the checkpoint file (satisfies F1 --
  End-Session deletes checkpoint).

**Not shipped:**

**7a. `chat.resume` doesn't rehydrate the brainstorm controller.**
[chatResume at chat-handler.ts:281](../../src/insrc/daemon/chat-handler.ts#L281)
loads chat history but doesn't reconstitute the brainstorm
controller's `BrainstormState` from the checkpoint. After resume the
daemon has no controller in memory -- the next gate reply has nothing
to drive. `agent.resume`'s return message literally says
`"Resume via chat.resume with sessionId=..."` but chat.resume
doesn't honour that contract.

**7b. No re-emission of the most recent pending gate.** P2.2 goal #1
requires that after rehydrate, the daemon re-emits the gate the
user was on so the UI reopens the right pane. Today even if 7a
landed, there's no reply path -- the controller's pipeline would
advance from whatever `lastStep` the checkpoint recorded without
re-showing the gate.

**7c. G2 mid-LLM-task resume (retry / abandon choice).** When the
checkpoint captures a session that was in the middle of an LLM call
(not at a gate), P2.0 G2 says the user picks retry-from-last-step
vs abandon. Nothing implements this branch today -- the checkpoint
doesn't even record "was mid-LLM" vs "was at gate".

**7d. Runs sidebar -> resumeSession(id) plumbing.** P2.2 goal #4
requires the Runs sidebar to call `chatService.resumeSession(id)`
which would RPC `chat.resume` and re-hook the stream. The Runs
sidebar currently calls `agent.resume` and surfaces the message
back to the user; it doesn't wire into the chat service.

**7e. Schema-drift refusal (I2).** No check in `agent.resume` that
the checkpoint's schema matches the current `BrainstormState`
shape. If we ship a controller change between save and resume,
rehydrate will silently deserialize a broken state.

### Remaining work (scope)

All of 7a-7e are daemon+UI. 7a is the unblocker; 7b-7e depend on
it. Estimate: 7a alone is a day of work (controller factory that
takes a state snapshot, plumbing through `chat.resume`). 7b-7e are
smaller deltas on top.

### Priority

**P1.** The bar has shifted -- brainstorm sessions routinely run
20-60+ minutes across convergence + theme-spec + presentation, and
losing one to a daemon restart, pane-close misclick, or stream
timeout wipes out substantial user investment. With Item 31 now
auto-terminating sessions on stream timeout, resume becomes the
recovery path users need. Treat 7a as a near-term blocker, not a
nice-to-have.

### Status (2026-04-21, commit `86d3c586fee`)

All five subtasks shipped:

- **7a** done. New `chat.resumeFromCheckpoint` stream handler in
  [chat-handler.ts](../../src/insrc/daemon/chat-handler.ts) loads the
  checkpoint, validates schemaVersion, ensures the session is in the
  pool (DB restore on cold daemon), picks the right brainstorm
  subclass from stamped `state.category`, seeds the store, and runs
  the pipeline with a single `initialTasks` entry so `buildInitialTasks`
  is skipped (we're not starting fresh).
- **7b** done. `BrainstormControllerBase.buildResumeTask()` dispatches
  on `state.lastStep`. Gate-emitting lastSteps (idea-review,
  idea-list, idea-discuss, validate-convergence, theme-spec-review,
  presentation) rebuild the exact gate task the user was on.
- **7c** done. In-flight lastSteps (everything else) emit a
  `resume-confirm` gate (inline in the chat panel, no dedicated pane
  per Item 12's policy) with retry / abandon actions. `afterResumeConfirm`
  rebuilds the in-flight task on retry via `rebuildInFlightTask(step)`.
- **7d** done. [agentRunServiceImpl.resumeRun](../../src/vs/workbench/contrib/insrc/electron-sandbox/agentRunServiceImpl.ts)
  does the two-step handshake: `agent.resume` validates, then
  `chatService.resumeFromCheckpoint(sessionId, repo)` opens the
  stream. Throws with the daemon's reason/message on schema-drift so
  the Runs sidebar surfaces it.
- **7e** done. Checkpoint body stamps `schemaVersion: CHECKPOINT_SCHEMA_VERSION`
  (currently 1). `agent.resume` refuses mismatches upfront with
  `{ ok: false, reason: 'schema-drift', ... }` (decision I2).

### 7f. Residual: parametric in-flight retry (deferred)

`rebuildInFlightTask` covers all no-param builders:
`search-context, generate-ideas, enhance-ideas-search, review-ideas,
converge-cluster, converge-promote, assemble-spec, finalize`.

Parametric builders are NOT yet retry-able:
- `enhance-ideas-llm` -- needs the search output from the prior step.
- `refine-ideas` -- needs the review output string.
- `idea-diverge-single`, `idea-discuss-search`, `idea-discuss-respond` --
  need the focused idea context.
- `search-theme-context`, `generate-theme-spec`, `review-theme-spec` --
  need the theme index + prior spec section.

For these, the resume-confirm gate still fires but Retry falls
through to `markSessionComplete` (same effect as Abandon). A
follow-up would snapshot the builder's input (review output, theme
index, spec section) under a dedicated `state.resumeInputs` map at
the point the in-flight step launches, so Retry can call the
builder with the same args. Deferred -- the no-param builders cover
most of the session's time; parametric steps are shorter and
losing them to Abandon is acceptable for now.

### Planned: future schemaVersion bump

The plan guards resume against schema drift but doesn't say *when* to
bump the constant. Rules of thumb for bumping `CHECKPOINT_SCHEMA_VERSION`
in [task.ts](../../src/insrc/daemon/task.ts):

- Removing or renaming a field on `BrainstormState` (the old
  checkpoint can't deserialise cleanly).
- Changing the type of a field (e.g. `lastStep: string` -> enum).
- Changing the shape of an embedded type (`Idea`, `Theme`, etc.).

Safe to leave schemaVersion alone for: adding new optional fields,
adding new dispatch cases, renaming internal methods.

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

### Remaining work (2026-04-21 investigation)

Items 13 + 30 fixed the structured-gate bug that was blocking
convergence/presentation rendering. The *panes themselves* have still
not been re-exercised with real data since those fixes landed. Each
sub-item below is a separate mini-task:

**11a. `BrainstormThemesPane` (convergence-review).** Grep confirms
no `warning` field handling in
[themesPane.ts](../../src/vs/workbench/contrib/insrc/browser/brainstorm/step/themesPane.ts).
Add it -- parallel to the ideas pane's Item 3 warning strip -- so
failed cluster/promote tasks surface as a card warning rather than
silently missing themes.

**11b. `BrainstormThemeDetailsPane` (theme-spec).** Same pattern --
no warning strip. Also needs a Discuss/Refine affordance equivalent
to the idea cards so the user can ask for revisions without bailing
to a new session. Currently the pane is display-only.

**11c. `BrainstormPresentationPane` (final output).** Needs manual
verification that it renders the assembled document correctly from
the new structured fields (post clean-slate commit). No code read
required; just a live run through converge -> themes -> spec ->
presentation.

**11d. Theme-spec warning strip.** The theme-spec builder walks each
accepted theme and calls an LLM per theme. If any one theme-spec
call fails, today there's no propagation -- the final assembled
output silently omits that theme. Wire the same `warning` field the
ideas pane uses so the user sees "theme X: spec generation failed"
on the theme-details card.

### Required test scenario

One focused brainstorm session driving the flow through every pane:
1. 3 seed ideas -> approve all.
2. Force converge (not auto).
3. Step through: convergence-review pane -> theme-details for each
   theme -> presentation.
4. Capture renderer + agent logs.
5. File sub-issues per pane for whatever renders wrong.

Do NOT block on 11a-d landing first -- run the test session, find
what's actually broken, then scope. Paper-plan gaps above are
hypothesis, not confirmed bugs.

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

### Status (2026-04-21 investigation)

**Shipped (16a, 16c, 16d):**
- 16a: [channel.ts:37-44](../../src/insrc/daemon/channel.ts#L37-L44)
  registers an `abort` listener that rejects every pending gate with
  `new Error('connection lost')` and clears the resolver/rejector
  maps. Pipeline's `await resolveGate(...)` breaks cleanly.
- 16c: [task.ts:588,614,635](../../src/insrc/daemon/task.ts#L588)
  checks `deps.abortController?.signal.aborted` before starting a
  task, mid-task, and after gate resolution -- bails with a clean
  "aborted by user" progress event.
- 16d: `guardedSend` wrapper in chat-handler makes post-abort
  `send()` calls no-op instead of surfacing "no stream handle"
  warnings.

**Still open: 16b -- LLM provider abort-signal plumbing.**

Blocker confirmed: [CompletionOpts in shared/types.ts:44-50](../../src/insrc/shared/types.ts#L44-L50)
does not have a `signal?: AbortSignal` field. None of the five
providers (ollama, anthropic, openai, gemini, mistral) accept an
abort signal. When the user cancels mid-turn, in-flight token
streams keep running to completion on the provider side, burning
cloud tokens and delaying the teardown.

**16b scope:**

1. Add `signal?: AbortSignal | undefined` to
   [`CompletionOpts`](../../src/insrc/shared/types.ts#L44).
2. Plumb `signal` through each provider's `complete()` +
   `stream()`:
   - **ollama**: `undici` fetch accepts `signal` natively; pass it
     through.
   - **anthropic** / **openai** / **gemini** / **mistral**: each
     SDK's request options takes a signal. Check per-SDK version
     for the right field name.
3. `executeLlmTask` in task.ts passes `deps.session.abortController.signal`
   into `provider.complete(..., { signal })`.
4. On abort, providers should throw an `AbortError` -- caller catches
   and treats it as a clean cancel, not a failure-to-retry.

**16b verification:**
- Start a long brainstorm turn (e.g. enhance with 20 ideas).
- Mid-stream, cancel the chat panel. Daemon log shows the LLM call
  raising `AbortError` within 100ms of the cancel, not at natural
  completion minutes later.
- Cloud billing dashboard shows reduced token usage on cancelled
  turns vs today's "runs to completion regardless" baseline.

### Severity

**P1.** The user explicitly said "stopping isn't working". With
16a/c/d shipped the UI stops responding to the stale stream, but
16b is the last gap: daemon-side LLM work still runs to completion
on every abandoned turn, wasting cloud tokens.

---

## 17. Brainstorm LLM tasks ignore `models.agents.brainstorm.*` config overrides (P1)

### Observation (2026-04-21)

User asked whether the brainstorming flow respects per-step model
settings. It does not.

### Current behavior

[executeLlmTask in task.ts:1276-1278](../../src/insrc/daemon/task.ts#L1276-L1278)
picks the provider with:

```ts
const provider = task.providerHint === 'claude' && session.claudeProvider
  ? session.claudeProvider
  : session.ollamaProvider;
```

- Only two outcomes: Claude (when `task.providerHint === 'claude'`
  AND the session has a Claude provider bound) or Ollama.
- The `ProviderResolver` on the session (which knows about
  `models.agents.<agent>.<step>` config overrides) is never consulted
  for brainstorm LLM tasks.
- Consequence: settings like `models.agents.brainstorm.seed`,
  `models.agents.brainstorm.review`, `models.agents.brainstorm.refine`
  in `~/.insrc/config.json` (or the Model Providers pane) are
  silently ignored. The user can configure them but they have no
  effect.

### Other agents do it right

- **Planner**
  ([steps.ts:210](../../src/insrc/agent/planner/steps.ts#L210),
  [steps.ts:418](../../src/insrc/agent/planner/steps.ts#L418))
  uses `ctx.providers.resolve('planner', 'enhance')` /
  `.resolveOrNull('planner', 'detail')`.
- **Pair**
  ([steps.ts:398](../../src/insrc/agent/tasks/pair/steps.ts#L398))
  uses `ctx.providers.resolveOrNull('pair', 'validate')`.
- **Designer** / CLI / **Classifier** all use the resolver.

### Root cause

The brainstorm controller was written against the task-pipeline
abstraction, and the pipeline's LLM executor (`executeLlmTask`) never
got wired to the resolver. Brainstorm tasks today carry only a
coarse `providerHint: 'local' | 'claude'` which maps 1:1 to the two
session-level providers.

### Fix

**17a. Extend the `Task` shape with per-step agent metadata.** Add:

```ts
export interface Task {
  // ... existing
  /** Agent id for per-step provider lookup. */
  agentIdForResolver?: string;
  /** Step name for per-step provider lookup. */
  stepName?: string;
}
```

(Names kept distinct from the existing `agentId` / `intent` fields
because `agentId` already has a different meaning in executeAgentTask.)

**17b. `executeLlmTask` consults the resolver first.**

```ts
const resolver = deps.session.resolver;
const override = task.agentIdForResolver && task.stepName
  ? resolver.resolveOrNull(task.agentIdForResolver, task.stepName)
  : null;
const provider = override
  ?? (task.providerHint === 'claude' && session.claudeProvider ? session.claudeProvider : session.ollamaProvider);
```

Order: explicit per-step override > providerHint > session default.

**17c. Brainstorm controller populates the new fields.** Each task
`buildGenerateIdeasTask`, `buildEnhanceIdeasTask`,
`buildReviewIdeasTask`, `buildRefineIdeasTask`,
`buildConvergeClusterTask`, `buildConvergePromoteTask`,
`buildGenerateThemeSpecTask`, `buildAssembleDocumentTask`,
`buildDiscussRespondTask`, `buildDivergeSingleTask` sets:

```ts
agentIdForResolver: 'brainstorm',
stepName: 'seed' | 'enhance' | 'review' | 'refine' | 'cluster' | 'promote' | 'theme-spec' | 'assemble' | 'discuss' | 'diverge',
```

(Names chosen to match the canonical step names already used by
other agents' per-step configs.)

**17d. Keep `providerHint` as fallback** so existing behaviour is
preserved for tasks / controllers that haven't opted into the
resolver path yet.

### Verification

- Set `models.agents.brainstorm.review = 'anthropic:claude-opus-4-7'`
  in `~/.insrc/config.json`.
- Start a brainstorm turn; observe the Claude call log -- it should
  log `model: claude-opus-4-7` for the review step, not the default
  haiku.
- Remove the override; the next brainstorm uses whatever the
  session default is.
- Tasks without `agentIdForResolver` / `stepName` (designer,
  planner, etc. — they already use the resolver at the call site)
  are unaffected.

### Dependencies

None. Daemon-only change. No UI, no protocol.

### Severity

**P1.** Configuration that the Model Providers pane presents to the
user as a working control is silently ignored. Classic "surprising
defaults" bug that erodes trust in the config.

---

## 18. Duplicate / near-duplicate ideas surface in the review queue (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"in some cases duplicate/near-duplicate
ideas are showing up, the review step should filter/combine these"*

Observed in round 1 of a design brainstorm -- after refine, the queue
contained titles with heavy overlap (e.g. "Rule-Based Assignment with
LLM Augmentation", "Rule-Based Assignment with LLM Validation",
"Hybrid Rule-LLM Assignment with Dynamic Constraints", "Constraint-
Driven Assignment with LLM Override", "Contraint Engine for
Assignment"). The user was forced to approve/reject each one even
though two or three were substantively the same idea.

### Current state

Dedupe exists in a narrow band:
- [afterRefineIdeas](../../src/insrc/daemon/controllers/brainstorm/base.ts)
  dedups refined ideas against prior-round survivors AND rejected
  titles via an **exact 60-char title-prefix match**
  (`title.slice(0, 60).toLowerCase().trim()`). That only catches
  clones, not paraphrases.
- No dedup runs between ideas WITHIN the same refined batch. Two
  refined titles with slightly different wording both pass.
- No semantic dedup (embedding similarity, LLM-based grouping).

### Fix

**18a. Prompt-level dedup instruction in REFINE_IDEAS_SYSTEM.** Add:

> Before emitting the final numbered list, check every pair of
> ideas. If two ideas describe the same core concept (even with
> different wording), **merge them** into a single idea that
> captures the shared intent and note the union of their tags /
> refs. Do not emit near-duplicates.

Cheap, no infra change, catches most cases because the LLM already
has the full idea set in context.

**18b. Post-parse similarity dedup.** After `parseIdeaList` runs on
the refine output, run a fuzzy-similarity pass on the accepted pool:
- Embed each title + body via the local embedding model.
- Compare pairwise cosine similarity. Above threshold (~0.88) merge
  the pair: keep the higher-verdict one, roll tags/refs from the
  dropped one.
- Emit a progress event "Merged N duplicate ideas" so the user sees
  it happened.

Bigger change but catches cases 18a misses.

**18c. User-level signal on the card.** When two surviving ideas
still look similar (below the dedup threshold but above a soft
threshold like 0.75), render a "similar to idea [N]" chip on the
card so the user can make an informed approve/reject decision
without having to scroll.

### Recommendation

Ship **18a** now (one-line prompt change) and **18b** with the
embedding-based pass as a follow-on. **18c** only if 18a+18b don't
meaningfully reduce the complaint.

### Verification

- Run a brainstorm with a prompt that historically produces
  near-duplicates (e.g. "rule vs LLM assignment engine").
- Round-1 refined output has zero pairs with > 0.88 cosine
  similarity on title+body embeddings.
- User sees at most 1-2 "similar to" chips across the pool.

### Status (2026-04-21 investigation)

**Shipped: 18a.** Prompt-level dedup instruction added to
`REFINE_IDEAS_SYSTEM`. Catches the easy cases where the LLM has the
whole set in context and just needs to be told not to emit
near-duplicates.

**Deferred: 18b.** Embedding-based similarity dedup. Plan kept for
when the cost/benefit is re-evaluated but not on the active queue.
Requires:
- A post-parse pass in
  [`afterRefineIdeas`](../../src/insrc/daemon/controllers/brainstorm/base.ts)
  that runs after the exact-title dedup.
- For each accepted idea, embed `${title}\n${body}` via the local
  embedding model (`embedQuery` already available from
  `../../indexer/embedder.js`).
- Pairwise cosine similarity; merge pairs above 0.88 (keep
  higher-verdict / earlier idea, roll tags/refs from the drop).
- Emit `progress step="Merged N duplicate ideas"` so the user sees
  the work happened.
- Cache embeddings on the `Idea` record so cross-round dedup in
  later rounds doesn't re-embed.

Cost: +1 local embedding call per refined idea per round. Trigger
to un-defer: if 18a's prompt-level dedup proves insufficient
across several test sessions and users keep seeing duplicate pairs.

**Still open: 18c.** "Similar to idea [N]" chip on the card. For
pairs between the soft threshold (0.75) and the hard merge
threshold (0.88), leave both ideas in the queue but render a chip
on the card: `similar to idea #3: "..."`. Click to navigate to the
sibling card.

Note: 18c's original spec depended on 18b's pairwise pass to compute
similarity scores. With 18b deferred, 18c either (a) waits alongside
18b, or (b) computes its own lightweight similarity (e.g. trigram
Jaccard on titles) as a zero-embed alternative. If 18a proves
enough, both stay deferred.

### Remaining work (scope)

No active work on 18. 18a is shipping; 18b is deferred; 18c sits
behind 18b. Re-open when test sessions surface duplicate pairs 18a
misses.

---

## 19. No UX feedback after `+ Add Idea` submit -- user can't tell if it worked (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"no user feedback when an new idea is
added, user has no clue if the idea was added, failed or what
happened"*

### Current behavior

- User clicks `+ Add Idea` on `BrainstormIdeasPane`.
- Form opens, user fills title + body, clicks Add.
- `_submitAddIdea` calls `brainstorm.addIdea` RPC, await completes.
- Form closes silently (or stays open with an error row on failure).
- The new idea is queued on the daemon; it appears as the NEXT card
  after the user resolves the current gate. The user sees a new card
  **some time later** (could be minutes if the current gate is
  waiting on an LLM call) and has no way to connect that card to
  their earlier Add Idea click.

### Root cause

`_submitAddIdea` at
[ideasPane.ts:364-368](../../src/vs/workbench/contrib/insrc/browser/brainstorm/step/ideasPane.ts#L364-L368)
returns after the RPC resolves but doesn't surface success. The form
closes, no toast, no inline confirmation.

### Fix

**19a. Inline success state in the Add Idea form.** On RPC success,
replace the form contents with:

> ✓ Idea "<title>" queued. It will appear next in your review.

Auto-dismiss after 2-3 s. On failure, keep the existing amber error
row but change the text to include a retry hint.

**19b. Daemon progress event on addIdea.** `brainstormAddIdea` RPC
handler emits a progress event on the session stream:

```ts
send({ id: activeRequestId, stream: 'progress', data: { message: `Idea queued: "${title.slice(0, 60)}"` } });
```

This makes the addition visible in the progress bar regardless of
which pane the user is on.

**19c. Upsert the idea immediately in the session service.** Today
the session service only learns about the new idea when the next
`idea` gate carries it. Instead, wire the RPC result back to the
browser so `BrainstormSessionService` adds the idea to its
observable list immediately -- the idea list gate (if open) re-
renders with the new entry.

### Recommendation

Ship **19a + 19b**. 19c is only needed if we later add a "list of
queued ideas" UI; optional.

### Verification

- Click `+ Add Idea`, fill title + body, submit.
- Form shows "✓ Idea 'X' queued..." for ~2 s then closes.
- Chat progress bar briefly shows `Idea queued: "X"`.
- Next card-transition shows the user's idea.

---

## 20. User-added idea still requires Approve click -- should be auto-accepted (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"new idea shows up at the end of the
queue for user approval again, user has added the idea so should be
auto approved"*

### Current behavior

When the user adds an idea via `+ Add Idea`:
- Controller creates the idea with `source: 'user'` and
  `reviewVerdict: 'user'`, but `status: 'proposed'`.
- The idea is spliced into `reviewQueue` at
  `currentReviewIndex + 1`, so the next card shown after the
  current gate resolves is the user's idea.
- The card lands with the normal action row
  (Approve / Reject / Diverge / Skip / Park / Discuss) -- forcing
  the user to click Approve on an idea they JUST authored.

From the log:

```
12:30:42  idea insert id=392c077e idx=10 status=proposed title="Contraint Engine for Assignment"
12:30:42  gate received kind=idea ...
12:31:33  click action=approve
```

The user waited through the gate and clicked Approve just to pass
their own idea through.

### Root cause

`next()` in
[base.ts](../../src/insrc/daemon/controllers/brainstorm/base.ts)
(injected-ideas drain block) sets `status: 'proposed'`. The review
flow then treats it like any other proposed idea.

### Fix

**20a. Skip the review gate for user-added ideas.** In the injected-
ideas drain:

```ts
const idea: Idea = {
  // ... existing fields
  status: 'accepted',   // was 'proposed'
  source: 'user',
  reviewVerdict: 'user',
  // ... existing
};
this.state.ideas.push(idea);
// Do NOT push into reviewQueue -- the idea is already accepted.
```

With status=accepted and not queued for review, the idea simply
joins the accepted pool and participates in downstream convergence /
clustering alongside LLM-generated ideas.

**20b. Render an inline marker in the idea list panel.** When the
user lands on `BrainstormIdeaListPane` or the convergence review,
user-added ideas carry a small "👤 user-added" badge so they're
easy to spot. (The session service already exposes `source`; just
render it when present.)

**20c. Preserve the "user wanted to add this and see it considered"
contract.** Even without a review card, the next LLM-driven step
(cluster / promote) sees the user idea in the accepted pool. In
round N+1 refine, the Phase 1 feedback delivers the idea's origin
to the refine LLM: "idea [N] was user-contributed -- do not
remove".

### Recommendation

Ship **20a** immediately. **20b** is a small UI polish once Item 20a
lands. **20c** is already implicit -- the refine prompt rule for
`reviewVerdict: 'user'` exists.

### Verification

- Click `+ Add Idea`, submit.
- No review card for the user's idea appears.
- The idea shows up in the accepted-pool list in the next
  `idea-list` or convergence-review pane with a user-added badge.
- Clustering / promotion runs with the user idea included.

---

## 21. Chat-panel Stop/Cancel button doesn't actually cancel (close-tab does) (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"the stop/cancel button in the chat
panel does not work. user has to close the brainstorming tab to
cancel. both should function identically"*

### Current behavior

Two cancel paths exist:
1. **Brainstorm tab close** -- `BrainstormStepInputBase.closeHandler`
   → `chatService.cancelStream()` → daemon `chat.cancel` RPC →
   abortController fires → pipeline cleanup (Items 16a/c/d verified
   working on 2026-04-21).
2. **Chat panel Stop button** -- this is the round-icon button on
   the chat view composer while a stream is in flight. Supposed to
   call the same `chatService.cancelStream()`.

Path 2 is not actually cancelling the brainstorm's daemon-side work.
The button either no-ops or only abandons the client's view of the
stream without asking the daemon to stop.

### Root cause (hypothesis -- needs log-trace confirmation)

The chat panel's stop button most likely calls `cancelStream()` but
the brainstorm session's active requestId differs from the chat
panel's tracked stream id. When the cancel RPC goes out it
references a stream that's already "done" from the chat panel's
perspective (because the first brainstorm gate arrived and the view
considered the initial send finished), while the brainstorm
controller keeps running under the same session id.

OR: the chat panel's stop button is gated on `isStreaming` state
that flips false as soon as a gate is rendered -- so the button
disappears or becomes a no-op while gates are in flight.

Needs:
- Repro with logging.
- Trace `chatView`'s stop-button click handler.
- Compare to the brainstorm tab's close-handler path (which we know
  works after Item 16).

### Fix

**21a. Single source of truth for "is the session working?".**
Drive the chat-panel stop button visibility + click action from
`brainstormSessionService.isSessionActive` OR a new "session is
working" flag on `IInsrcChatService` that stays true for the full
brainstorm lifecycle, not just while streaming deltas.

**21b. Cancel calls the same RPC path.** The chat-panel stop button
calls `chatService.cancelStream()` which goes through
`chat.cancel` → `abortController.abort()` → Items 16a/c/d fire.
Today's brainstorm tab close uses the same path, so once the
chat-panel stop is pointed at `cancelStream()` unconditionally
(not gated on local streaming state), both paths converge.

**21c. Post-cancel session close.** Brainstorm tab-close path
today also calls `chatService.closeSession()`. Chat-panel stop
should do the same: cancel AND close, so the session goes back to
`(none)` and the user can start a fresh brainstorm.

### Verification

- Start brainstorm, progress bar shows "Generating ideas...".
- Click chat panel Stop button.
- Daemon log shows `controlled pipeline: aborted by user`.
- Brainstorm pane closes or shows a cancelled state.
- No `no stream handle for id=N` warnings.
- Same subsequent behaviour as tab-close.

### Severity

**P1.** User explicitly called out the inconsistency. Two cancel
UIs with different behaviour is a trust issue -- user can't
predict what the Stop button does.

---

## 22. Progress bar stays stuck on last step after session cancel / close (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"the progress is not getting reset on
cancel. check the attached image"*

Screenshot shows the chat composer with a persistent progress
indicator above it: `◦ Clustering ideas into themes (round 1)...`.
The user had already closed the brainstorm pane / cancelled the
session. The progress indicator never cleared.

### Current behavior

- Daemon emits progress events continuously during a turn:
  `send({ stream: 'progress', data: { message: '...' } })`.
- Chat view listens, updates `this._progressBar` and
  `this._progressText` via `_showProgress(step, status)`.
- On cancel / close:
  - Daemon pipeline aborts (Item 16 verified working).
  - `guardedSend` drops any further progress messages from the
    daemon side (Item 16d).
  - BUT: the last progress event already rendered on the bar stays
    visible. Nothing clears `_progressBar` / `_progressText`.
- `_onStreamEnd` exists and presumably hides the progress bar, but
  it's triggered by a `streamEnd` event from the daemon. On cancel,
  the daemon never emits `streamEnd` (it's short-circuited by the
  abort), so the client's stream-end handler never fires, so the
  bar never hides.

### Root cause

Cancel / close terminates the stream handle on the browser side
immediately, but the chat view's progress indicator is only cleared
when:
- The daemon emits a fresh `streamEnd` event (doesn't happen on
  abort), OR
- A new chat.send starts and clobbers the text (only happens when
  the user sends another message).

There's no "session ended / cancelled" signal on the browser side
that clears the progress chrome.

### Fix

**22a. Clear progress on `cancelStream()`.** In
[chatServiceImpl.cancelStream](../../src/vs/workbench/contrib/insrc/electron-sandbox/chatServiceImpl.ts),
after `_finishStream()` fires, also emit a synthetic
`streamEnd` event on the event channel so the chat view's
`_onStreamEnd` path clears the progress bar. Alternatively, call a
new `chatService.resetProgress()` that the chat view listens to.

**22b. Clear progress on session close.** Same as 22a but triggered
when `closeSession(sessionId)` is called (brainstorm tab close
path).

**22c. Clear progress when brainstorm session ends.** The browser's
`IInsrcBrainstormSessionService.onDidChange` fires when
`isSessionActive` flips false. `chatView` already listens; make the
handler also clear the progress indicator.

**22d. Defensive auto-clear.** If the chat view hasn't received any
event (delta / progress / gate) for N seconds and `isStreaming`
is false, clear the progress bar. Catches race conditions where
22a/b/c don't fire.

### Recommendation

Ship **22a + 22b** -- they close the "user clicked cancel" and
"user closed the brainstorm tab" paths which cover ~all observed
cases. **22c** is a small safety net. **22d** is a belt-and-
suspenders fallback; defer unless a new "stuck progress" report
shows up after 22a+b.

### Verification

- Start brainstorm, let it reach `Clustering ideas into themes
  (round 1)...`
- Click Cancel (either chat-panel Stop button after Item 21 fix OR
  brainstorm tab close).
- Progress bar disappears within ~1 s.
- Send a new chat message -- no stale progress text leaks into the
  new turn.

### Severity

**P1.** Visual artifact that makes the UI look broken -- the user
thinks something is still running even though it isn't. Compounds
with Item 21 (cancel button not working) -- together they make the
"stop a brainstorm" UX feel completely unreliable.

---

## 23. Step Provider Settings still uses old Claude-focused framework (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"the step provider settings need to
be updated to use the new configuration model, still using the old
claude focused framework"*

### Current state

The editor at
[stepProviderEditorPane.ts](../../src/vs/workbench/contrib/insrc/browser/setup/stepProviderEditorPane.ts)
was written when the config had two provider tiers: local (Ollama)
and Claude. It hard-codes a picker list:

```ts
const PROVIDERS = ['local', 'claude:fast', 'claude:standard', 'claude:powerful'];
```

and writes the selected label as a raw string into
`models.agents.<agent>.<step>` (line 225). It reads by
`.startsWith('claude')` for display.

The new config schema (already shipped) supports five providers --
`local`, `anthropic`, `openai`, `gemini`, `mistral` -- with a single
active cloud provider selected in the Model Providers pane. Per-step
bindings are typed as:

```ts
type AgentStepConfig = Record<string, string | StepBinding>;
interface StepBinding { provider: ProviderName; model?: string; }
```

### Impact analysis -- bigger than "stale UI"

Tracing the runtime consumer
([parseBinding in config.ts:269-298](../../src/insrc/agent/config.ts#L269-L298))
against the strings the editor actually writes reveals that the
**editor has been silently broken end-to-end**, not just out of
date:

1. `parseBinding` accepts string form with a whitelist:
   `'local'` → local provider, `'openai' | 'anthropic' | 'gemini' |
   'mistral'` → that provider's default model, or a `StepBinding`
   object.
2. **Anything else** hits the fallback branch at line 285:
   `return { provider: 'local', model: binding };` -- i.e. treats
   the string as a *local* model name.
3. The editor writes `'claude:fast'`, `'claude:standard'`,
   `'claude:powerful'` -- none of which are in parseBinding's
   whitelist. Every claude-tier binding the user ever set has been
   silently routed back to the **local** provider with an invalid
   model name.

Net: the step editor wrote junk the runtime couldn't resolve. Users
who pinned `brainstorm.review` to "claude:powerful" got local
inference with a bogus model string. No error, no warning -- just a
quiet misroute.

The legacy "read-tolerance" suggested in the original Item 23b
draft (migrate claude:fast-style strings to `{ provider: 'anthropic',
model }`) isn't backwards-compat -- it's a **bug fix that has to
run once on existing configs to delete the poisoned writes**.

### Fix (widened scope)

**23a. Rebuild the step-provider editor around the new schema.**
Replace the flat picker with:
- A provider dropdown per step row (options: Local + whichever cloud
  provider is the current active one per Model Providers pane).
- A model dropdown populated from that provider's
  `providers.<name>.enabled` list.
- Writes `models.agents.<agent>.<step>` as
  `{ provider: '<name>', model: '<model>' }`.

**23b. One-shot migration pass for poisoned writes** -- NOT a
read-tolerance layer. In `mergeConfig` at load time:

```ts
function migratePoisonedAgentBindings(agents: AgentProviderConfigs): { migrated: number; dropped: number } {
  const VALID_STRING_SHORTHANDS = new Set(['local', 'anthropic', 'openai', 'gemini', 'mistral']);
  let migrated = 0, dropped = 0;
  for (const agent of Object.keys(agents)) {
    const steps = agents[agent];
    if (!steps) continue;
    for (const step of Object.keys(steps)) {
      const v = steps[step];
      if (typeof v !== 'string') continue;                    // StepBinding -- fine
      if (VALID_STRING_SHORTHANDS.has(v)) continue;            // known shorthand -- fine
      if (v.startsWith('claude:')) {
        // claude:fast / claude:standard / claude:powerful -- legacy
        // editor output. Migrate to anthropic default. Safe because
        // anthropic is the only historical cloud.
        steps[step] = { provider: 'anthropic', model: undefined } as StepBinding;
        migrated++;
      } else {
        // Unknown string -- was being mis-routed to local with an
        // invalid model. Drop the binding; runtime will fall back
        // to active-provider default.
        delete steps[step];
        dropped++;
      }
    }
  }
  return { migrated, dropped };
}
```

Log the counts on startup
(`log.info({ migrated, dropped }, 'step-binding migration')`). If
`migrated + dropped > 0`, write the migrated config back to disk.

**23c. Tighten `parseBinding`.** The silent "unknown string ->
local" fallback at
[config.ts:285](../../src/insrc/agent/config.ts#L285) is the reason
the editor's broken writes went undetected. Change the string
branch to a strict whitelist + explicit `fallbackBinding` on
mismatch, AND log a warning so future editor regressions are loud:

```ts
if (typeof binding === 'string') {
  if (binding === 'local') return { provider: 'local', ... };
  if (binding === 'anthropic' || binding === 'openai' || binding === 'gemini' || binding === 'mistral') {
    return ...;
  }
  log.warn({ binding }, 'parseBinding: unknown string shorthand -- using active-provider default');
  return fallbackBinding(config);   // no more silent mis-route to local
}
```

**23d. Honor the active-provider constraint from the Model Providers
pane.** The provider dropdown in the new editor should only offer
Local + whichever cloud provider is currently active. If a binding
references a now-inactive cloud (e.g. user switched active from
anthropic to gemini but a step still points at anthropic), render
the row with an amber warning "binding references anthropic -- active
cloud is now gemini. Reassign or clear."

**23e. Deprecate string shorthand for NEW writes.** The runtime
keeps accepting `'local' | 'anthropic' | 'openai' | 'gemini' |
'mistral'` as string shorthand (convenient in hand-edited config
files), but the editor MUST write `StepBinding` objects for new /
edited entries. Round-tripping through the editor normalises every
entry to the object form. This prevents a future regression where
someone rebuilds the editor and accidentally reintroduces string-
writes.

### Dependencies

- Model Providers config schema (stable, shipped).
- Item 17 (per-step resolver) -- already shipped. Verifying 23 end-
  to-end requires both 17 and 23 in the same build.

### Verification

1. **Migration runs once and cleans a poisoned config.** Seed
   `~/.insrc/config.json` with
   `models.agents.brainstorm.review = 'claude:powerful'`. Start
   the daemon. Log line: `step-binding migration migrated=1 dropped=0`.
   Re-read the config -- the entry is now
   `{ provider: 'anthropic', model: null }`.
2. **Editor writes the new shape.** Open Step Settings from the
   status-bar popup. Pick "openai / gpt-4o-mini" for
   `brainstorm.review`. Save. `~/.insrc/config.json` shows
   `{ provider: 'openai', model: 'gpt-4o-mini' }`.
3. **Daemon picks up the binding.** Trigger a brainstorm review
   step -- claude log (module: 'openai', model: 'gpt-4o-mini')
   instead of haiku.
4. **parseBinding no longer silently misroutes.** Write a bogus
   string (e.g. `'weird-value'`) directly into config. Daemon log
   shows `parseBinding: unknown string shorthand -- using
   active-provider default` and routes to active-cloud default
   rather than to local.

### Severity

**P1.** Dual bug: (a) core configuration surface that silently
ignores 3 of 4 cloud providers, (b) existing configs contain
poisoned entries that the runtime silently mis-routes. Users who
think they've configured a step for Claude have instead been
running on local inference with an invalid model string.

---

## 24. Intent / sub-intent classification should persist as a chat message (P2)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"P2: the intent/sub-intent detection
should be displayed in the user chat panel, once confirmed: Chat
message should be sent to user (no user action required)"*

### Current state

Classification surfaces in two transient places:

1. **Intent progress pill** -- `send({ stream: 'progress', message:
   'Intent: brainstorm/design (...)' })` at
   [task.ts:547](../../src/insrc/daemon/task.ts) and
   [chat-handler.ts:601](../../src/insrc/daemon/chat-handler.ts#L601).
   The chat view displays this as a small pill at the top of the
   composer that gets overwritten by the next progress event.
2. **Intent-confirm gate** (Item 5 / 8) -- modal gate asking the
   user to Proceed / Use-different-intent / Cancel. Shows
   confidence + reasoning. But once resolved the UI is gone; the
   chat transcript has no record of what was classified.

After the user clicks Proceed, the chat panel carries on with the
turn but there's no persistent record of "we classified this as
brainstorm/design" in the transcript. Ten minutes later the user
has no way to see how the turn was routed.

### Desired behaviour

- **On every classification** (not just when the confirm gate
  fires): the chat panel should render an assistant-style message
  like:
  > **Detected intent:** brainstorm → design
  > _User is describing the architectural shape of a task
  > assignment system..._
  ...that stays in the transcript as a normal message (persisted
  with the turn).
- **No user action required** -- the message appears automatically
  as soon as the classifier emits the decision.
- **When the confirm gate fires and the user clicks Proceed**, the
  existing intent gate disappears but the persistent message stays.

Today there's already a dedupe-guarded `_ingestIntentAnnouncement`
in `chatView` that emits a transient assistant message -- but it's
suppressed while brainstorm is active
([chatView.ts:394](../../src/vs/workbench/contrib/insrc/browser/chat/chatView.ts#L394)):

```ts
if (this._shouldSuppressMessagesForBrainstorm()) { return; }
```

So the moment the classifier decides "brainstorm", the message gets
swallowed. That's the regression to fix.

### Fix

**24a. Do not suppress the Intent-announcement message.** Even
during brainstorm lock, the "Detected intent: brainstorm/design"
assistant message should appear in the transcript. It's exactly
the kind of meta-info the user wants to see.

**24b. Persist the classification via the turn's chat history.**
Today the chat panel renders the message client-side only; it's
not stored with the conversation turn. Extend
[session.history](../../src/insrc/daemon) to accept a
`classification` metadata field and surface it when reloading
history. Alternatively, just render it as a normal assistant
message (daemon-side) so it rides the standard persistence path.

**24c. Richer render -- include confidence + reasoning.** Today the
message is a one-liner ("Detected intent: brainstorm/design.").
Expand to:
> **Detected intent:** brainstorm → design (confidence 0.87)
> Reasoning: User is describing the architectural shape of a task
> assignment system—inputs, tool integrations, decision logic flow,
> and batch processing mode—rather than specifying what tasks to
> assign or how to code it.

### Dependencies

None. Pure UI change; daemon already emits the reasoning in the
progress event.

### Severity

**P2.** Nice-to-have transparency. Users can live without it today
because the intent-confirm gate (Items 5 / 8) already shows the
classification at decision time. But once the gate is resolved, the
record is gone.

---

## 25. Unify chat-panel Cancel and Pane-close into a single handler (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"looks like the chat panel cancel is
triggering a different flow than the Pane close. here's how the
flow should work (one single handler for close/cancel). Popup modal
for user confirmation to cancel, yes - handle close (stream,
progress, pane, chat panel)"*

### Current state

Two independent close paths today:

1. **Pane close** -- `BrainstormStepInputBase.closeHandler`
   → shows VS Code confirm dialog -> calls `chatService.cancelStream()`
   + `chatService.closeSession()` sequentially.

2. **Chat panel Cancel button** -- `chatView` cancel handler
   (Item 21) → calls `chatService.cancelStream()`
   + `chatService.closeSession()` IF brainstorm is active; no
   confirmation dialog.

Even though both paths now call the same two underlying methods,
the ORDER, the presence-of-confirmation, and the per-path
side-effects (closeHandler writes a session-abandoned QnA entry,
chat cancel doesn't) diverge. Observed in the log: the chat-panel
cancel aborted the brainstorm pipeline AND then aborted a
`controller: designer` pipeline that wasn't even expected to be
running. The pane-close path doesn't cause that.

### Desired behaviour

One shared handler. Call it `cancelActiveBrainstorm(reason)`:

1. Check if a brainstorm is active. If not, fall back to plain
   `cancelStream()`.
2. Show the confirm modal: "Cancel brainstorm? You'll lose the
   current session."
3. On Yes:
   - `daemonService.rpc('chat.cancel', { sessionId })` → pipeline
     aborts (Item 16a/c/d already wired).
   - Clear progress chrome (Item 22 already wired).
   - Close the brainstorm pane (via the flow contribution's
     close-all).
   - Close the session
     (`daemonService.rpc('chat.close', { sessionId })`).
   - Emit the `session-abandoned` QnA event for audit.
4. On No: no-op.

Both the pane-close X button and the chat-panel Cancel button call
`cancelActiveBrainstorm('user-cancel')`.

### Fix

**25a. Extract a single method on `IInsrcChatService`:**
`cancelBrainstormSession(reason: string): Promise<boolean>` that
does steps 1-4 above.

**25b. Wire both UI entry points to it.**
- `BrainstormStepInputBase.closeHandler` calls it instead of
  calling cancelStream + closeSession.
- `chatView` cancel-btn handler calls it instead of its current
  inline sequence.

**25c. Close the brainstorm pane as part of the handler.** Today
only the pane-close path naturally closes the pane (since the user
clicked the pane's X). When cancel is invoked from the chat panel,
the pane stays open -- stranded on whatever gate the session was
last showing. The unified handler must close the pane explicitly
(e.g. via the editor group's `closeEditor` on the brainstorm
input).

**25d. Investigate the `controller: designer aborted` log.** The
chat-panel cancel in the observed test triggered an abort on a
designer pipeline. That's a separate-but-related concern:
- Either the brainstorm turn was chaining into a designer turn
  (surprising -- brainstorm produces a spec and then maybe the user
  expects designer as a follow-up?), OR
- The session pool has stale controller state from a prior run.

Either way, the unified cancel should handle ALL active pipelines
on the session, not just the brainstorm one.

### Dependencies

Builds on Items 16 + 21. No new RPCs needed -- uses existing
`chat.cancel` + `chat.close`.

### Verification

- Start a brainstorm. Click the chat panel's Cancel button ->
  confirm modal appears -> Yes -> pane closes, chat panel unlocks,
  progress bar clears. No daemon warnings.
- Start a brainstorm. Click the brainstorm pane's X -> same
  modal, same result.
- Close behaviour is byte-identical between the two paths --
  verified by diffing the daemon log for both scenarios.

### Severity

**P1.** User explicitly called out the inconsistency and the
requested fix. Also uncovered a surprising side-effect
(`designer aborted by user`) that suggests cancel is touching more
than just the visible brainstorm session.

### Update (2026-04-21 verification)

Verified end-to-end on 2026-04-21. Pane-close path emits:
```
closeHandler.showConfirm sessionActive=true
closeHandler.confirm ... confirmed=true
controlled pipeline: gate aborted by user
[brainstorm:flow] closing 1 brainstorm editor(s) in group 0
brainstorm:session session changed <sid> -> (none)
closeHandler cancelBrainstormSession resolved
```

Clean. Unified handler covers cancel + close + pane-close + session
reset. The `designer aborted by user` log from an earlier session
reappeared again on 2026-04-21 at 13:53:49 -- still unexplained.
Tracked as sub-concern 25d; root cause is a separate rabbit hole
from the UX unification Item 25 closes.

---

## 26. Step Providers pane shows "No agent step providers configured" even with an active cloud (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"model providers already set, not
being picked up by the step settings. check the images"*

Screenshots captured:
1. **Step Providers pane** -- renders the empty state:
   > No agent step providers configured. The daemon seeds defaults
   > on first use.
2. **Model Providers pane** -- Anthropic is the active cloud, 2
   models enabled (claude-sonnet-4-6 default, claude-haiku-4-5 also
   enabled), API key is marked Active.

Every prerequisite for useful step bindings is in place. The step
editor still says "no bindings configured."

### Root cause

The daemon comment the empty state quotes -- "The daemon seeds
defaults on first use" -- is aspirational. There is no seed step
today.

Specifically:
- [providers.ts:setProvidersConfig](../../src/insrc/daemon/providers.ts#L210)
  clears `agents = {}` whenever the user switches active cloud
  (line 225). So every time the user picks / switches the active
  provider in Model Providers, any prior agent bindings are
  deliberately wiped. That's the locked plan behavior -- a switched
  cloud can't reuse its predecessor's model strings.
- But nothing then RE-populates `agents` with defaults for the
  newly-active cloud. The map stays empty until some code writes
  into it. The old step-provider editor (pre-rebuild) had a "first
  use" flow that seeded; the rebuild from Item 23a dropped it.
- The step-editor UI lists whatever's in `providers.agents`. Empty
  map -> empty state -> user dead-ends.

### Fix

**26a. Daemon-side seed.** After `setProvidersConfig` clears
`agents`, immediately seed default bindings for the new active
cloud:

```ts
// Pseudo-code -- real list of agents/steps comes from a shared
// definitions table (see 26b).
const defaults = buildDefaultAgentBindings(nextModels.activeProvider);
nextModels.agents = defaults;
```

Where `buildDefaultAgentBindings(activeCloud)` returns a map like:

```ts
{
  brainstorm: {
    seed:          { provider: 'local' },
    enhance:       { provider: 'local' },
    review:        { provider: activeCloud },
    refine:        { provider: activeCloud },
    cluster:       { provider: activeCloud },
    promote:       { provider: activeCloud },
    'theme-spec':  { provider: 'local' },
    'theme-spec-review': { provider: activeCloud },
    assemble:      { provider: 'local' },
    discuss:       { provider: activeCloud },
    diverge:       { provider: 'local' },
  },
  planner: { ... },
  pair: { ... },
  designer: { ... },
  // ... every agent with per-step LLM tasks
}
```

Policy: "expensive / quality-critical" steps (review, refine,
cluster, promote, discuss) default to the active cloud; generative
seed / enhance / diverge / theme-spec default to local. This matches
the current hard-coded `providerHint` choices in the brainstorm
controller (Item 17) -- the seed just codifies them as explicit
bindings the user can override.

**26b. Shared step-definitions table.** The seed needs the same
agent/step list the editor walks when showing rows. Extract the
list into a shared typed constant (`src/insrc/shared/agent-steps.ts`)
that both daemon seed AND editor consume. Single source of truth,
no more "editor knows about `review` but seed doesn't" drift.

**26c. First-load seed for stale configs.** Users who already set
up Model Providers before this change won't trigger
`setProvidersConfig` again. In `loadConfig`, after the migration
pass (Item 23b) runs, if `activeProvider` is set AND `agents` is
empty, populate with defaults and write back. Log `{ seeded: true,
activeProvider }` so the one-time fill is visible.

**26d. Step editor surfaces the right prompt when truly empty.**
Even after 26a-c, if the user hasn't picked an active cloud, the
editor's empty state should point to the right action:
> "No active cloud provider. Open **Model Providers** to pick one,
> then this page will populate."
...instead of "The daemon seeds defaults on first use" (which is
now misleading).

### Verification

1. Fresh config, no Model Providers set. Open Step Providers --
   the pane shows the revised empty state with a link to Model
   Providers (26d).
2. Open Model Providers, pick Anthropic, save. Switch to Step
   Providers -- rows populated with the default bindings (26a).
3. Edit `brainstorm.review` from `anthropic` to `local` and save.
   Switch to a different active cloud in Model Providers and back
   -- the review step resets to the new active cloud's default
   (26a's agents = {} on switch, then 26a's seed re-populates).
4. Pre-existing config (set up under an earlier build) has
   `activeProvider: 'anthropic'` but `agents: {}`. Restart daemon.
   Log shows `step-bindings seeded activeProvider=anthropic`. Open
   Step Providers -- populated (26c).

### Dependencies

Builds on Items 17 (per-step resolver), 23 (editor rebuild + migration).
Item 23's migration drops poisoned bindings; Item 26's seed then
fills the resulting blank slate.

### Severity

**P1.** Users who configured Model Providers and expected Step
Settings to work end up at a dead-end empty screen. Complete loss
of the step-settings surface for every new user.

### Update (2026-04-21 verification)

Seed verified working in the daemon log:
```
14:39:01  config reloaded
14:39:01  config.write path=models.agents.brainstorm.seed value={"provider":"anthropic","model":"claude-sonnet-4-6"}
```

The editor writes the StepBinding object cleanly. The daemon
reloads in-memory config. Item 17's resolver picks up the new
binding on the next brainstorm turn's seed step. Seed-on-load and
seed-on-active-cloud-switch both confirmed during interactive
testing on 2026-04-21.

---

## 27. Step Providers editor: styling + Clear-button polish (P2)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"the step provider views are not
styled properly, also the clear button should just be a icon"*

### Current state

The rebuilt editor (Item 23a) uses inline styles and native
`<select>` elements. It's functional but visually rough vs. the
rest of the insrc UI:
- Inline styles everywhere instead of CSS classes -> no theme
  adaptation, no hover transitions, no focus rings consistent with
  the Model Providers pane.
- Row grid columns (160/130/1fr/auto) don't align with any other
  insrc settings page.
- "Clear" button is a text button. The rest of the insrc UI uses
  icon buttons for row-scoped actions (see IdeasPane / RunsView).

### Fix

**27a. Move all styles to a dedicated `.css` class sheet.**
`stepProviderEditor.css` (new) with `.insrc-sp-*` selectors.
`stepProviderEditorPane.ts` drops inline `.style.*` assignments in
favour of those classes.

**27b. Clear button becomes an icon button.** Replace the text
button with a trash-can codicon button, tooltip "Clear binding".
Use the same affordance as other icon actions in the contrib.

**27c. Align row layout with the Model Providers pane.** Same
column widths, same vertical rhythm, same selects. Aim for visual
consistency so a user can move between the two panes without
relearning the layout.

### Severity

**P2.** Cosmetic. Doesn't block functionality; waited behind the
correctness fixes.

---

## 28. Step Providers editor: changing provider collapses the expanded section (P1)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"changing the provider collapse the
view, it sets a default mode but the user needs to navigate back
to the element to change the model. should not collapse view"*

### Current behavior

The editor listens to `configService.onDidChangeConfig` -> re-runs
`_loadTable()` -> `dom.clearNode(this._tableBody)` -> rebuilds
from scratch. Every agent section is collapsed by default (only
`_expandedAgent` is remembered, but the rebuild discards expansion
state per-row). When the user changes a provider -> a write -> a
config event -> the whole table redraws collapsed. The user's
progression is lost.

### Root cause

`_loadTable()` wipes `_sections` and re-creates DOM. Nothing
restores the previously-expanded agent.

### Fix

**28a. Preserve expansion state across reloads.** `_expandedAgent`
IS stored on the instance. When `_loadTable()` re-renders, after
building all sections re-expand whichever agent name matches
`_expandedAgent`. Simple state capture.

**28b. Skip the full re-render for in-place edits.** When the
config change came from THIS pane's own write, the table doesn't
need a full rebuild -- we already know which row changed. Option:
- Track the (agent, step, new binding) locally, update that one
  row's provider/model select, skip the onDidChangeConfig handler
  for this change.
- Easier: gate the handler on a "pending own write" flag. Set the
  flag around `setConfigValue`; the incoming event fires, the
  flag is hot, handler skips the rebuild; flag clears.

**28c. Also fix the accordion's "only one at a time" rule.** The
current `_toggleSection` collapses the previously-open section
when a new one is opened. That's fine by itself, but compounds
with 28a -- if the user edits in one section then expands another,
the edit triggers a rebuild that forgets BOTH previously-expanded
sections. Make the table support multiple expanded sections OR at
least restore whichever was last expanded before the write.

### Recommendation

Ship 28a first (minimal change -- restore `_expandedAgent` on
rebuild). If 28a alone doesn't feel right -- e.g. if the user
reports "scroll position also jumps" -- then add 28b (skip rebuild
on own writes).

### Severity

**P1.** Every provider change requires the user to click the
agent section header twice more (find it, re-expand) to keep
working. This makes the editor painful to use.

---

## 29. Intent-confirm gate only fires for brainstorm -- other intents bypass user confirmation (P0)

### Observation (2026-04-21 live test)

User feedback (direct quote): *"it bypassed the intent confirmation"*
and *"can't proceed with testing as it detected the wrong intent
and moved forward without user gate"*

### Reproduction

1. User typed: `"Barinstorm around building a smart task assignment
   agent..."` (typo in "Brainstorm" -> "Barinstorm").
2. Classifier matched on keywords like "assignment", "agent", and
   the structured bullet-list format -> picked `requirements`
   intent with high confidence.
3. Intent-confirm gate policy
   ([chat-handler.ts:613-628](../../src/insrc/daemon/chat-handler.ts#L613-L628))
   only triggers when:
   - `classifier.confirmIntent === true` in config, OR
   - classified intent IS brainstorm, OR
   - confidence < 0.4.
4. Intent was `requirements` with confidence >= 0.4 and no explicit
   `confirmIntent: true` in config -> gate skipped -> pipeline
   launched the requirements/designer agent immediately.
5. User had no chance to say "no, I meant brainstorm."

Log trace:
```
14:41:20  progress step="Intent: requirements"
14:41:20  progress step="Running requirements agent..."
```
No intent-confirm gate between those two lines.

### Root cause

Item 8c's default-brainstorm-only rule was designed to reduce
confirmation fatigue. It assumes non-brainstorm intents are less
ambiguous. They aren't -- typos, stream-of-consciousness prompts,
and similar structured inputs all mis-classify.

### Fix

**29a. Fire the gate on EVERY classification output.** Per user
direction on 2026-04-21 -- confirmation is the default for every
classified intent, no per-intent carve-outs. Any turn that reaches
the classifier emits an intent-confirm gate before the agent
pipeline launches. The user can opt out globally by setting
`classifier.confirmIntent: false` in config; that setting is the
only way to skip the gate.

Policy matrix:

| `classifier.confirmIntent` | Fire gate? |
|----|----|
| `true` (or unset -- the default) | yes, always |
| `false` | only if confidence < 0.4 |

This replaces the prior per-intent allow list. Simpler contract
and no mis-classification can bypass the user's review.

**29b. Show the gate with ALL alternatives surfaced.** Today the
intent-confirm gate shows one intent + reasoning. For prompts that
classify ambiguously, show the top 2-3 candidate intents with
their confidences so the user can pick directly instead of typing
in the "use-intent" field.

**29c. Add a daemon log line when the gate is skipped.** Right now
a bypass is invisible in the log -- users can't tell "should there
have been a gate here?" from the trace. Log
`{ intent, confidence, confirmSetting, gateFired: false, reason }`
on every classification decision.

### Verification

- Type "Barinstorm around X" -> classifier picks `requirements`
  (or whatever) -> intent-confirm gate fires -> user can proceed /
  use-intent / cancel.
- Set `classifier.confirmIntent: false` -> only low-confidence
  turns (< 0.4) trigger the gate.
- Ask "what does function foo do?" (research intent, high
  confidence) -> no gate, direct research flow. (Confirms the
  cheap-intent exception.)

### Severity

**P0.** User explicitly stopped testing because of this. Every
mis-classified turn today is a non-recoverable detour -- the user
cancels, fixes the typo, retries. Adds friction to every interaction.

---

## 30. Requirements / Designer validate gate has `kind=unknown phase=waiting` (P0)

### Observation (2026-04-21 live test)

After the misfire in Item 29, the requirements agent (designer)
reached its validation step and tried to open the validation gate.
Monitor trace:

```
14:42:33  progress step="Requirements Validation"
14:42:33  gate received kind=unknown phase=waiting gateId=task-1-1776762753924 itemId=- actions=[execute,reject] extras=[] sessionActive=false
14:42:33  [brainstorm:flow] route kind=unknown sessionId=...
14:42:33  [brainstorm:flow] unknown gate kind "unknown" (gateId=task-1-...); ignoring
```

Same class as Item 13 (convergence gate dropped silently). The
gate's task doesn't carry a `structured.itemType`, so
`classifyGate` in the browser's session service defaults to
`'unknown'` -> flow contribution logs a warning and ignores ->
user has no UI for the validation decision -> agent silently
blocks waiting for a gate reply that can never come.

### Root cause (hypothesis)

The designer agent's `buildValidateRequirementsTask` (or equivalent
-- needs file lookup) emits a gate task without a
`structured: { phase, itemType, item, ... }` payload. Matches the
historic pattern Item 13 fixed for convergence-review; the same
fix pattern applies here.

### Fix

**30a. Find and annotate every designer-emitted gate.** Likely
builders:
- `buildValidateRequirementsTask` (requirements-extraction gate).
- `buildReviewDesignTask` (designer sketch review gate).
- Whatever builds the `task-1-<timestamp>` gate id the log
  captured.

Each needs:
```ts
structured: {
  phase: 'extract' | 'design' | 'review' | 'finalize',   // per agent stage
  itemType: '<well-known-name>',
  item: { ... },
}
```

**30b. Register matching kinds in the browser session service.**
`classifyGate` at
[brainstormSessionServiceImpl.ts:25](../../src/vs/workbench/contrib/insrc/browser/brainstorm/brainstormSessionServiceImpl.ts#L25)
maps itemType -> BrainstormGateKind. Add the new designer /
requirements item types. Or -- better -- generalise the flow
contribution so non-brainstorm agents can contribute their own
kind -> pane map without a central switch statement.

**30c. Fail loud instead of silent drop.** When the flow
contribution gets an unknown gate kind on a non-brainstorm session,
at minimum emit a visible error toast. Today the `warn`-level log
is invisible to the user and the turn hangs forever.

### Scope

This isn't brainstorm-specific; it surfaces every time an agent
emits a gate without structured payload. Ship the generic pattern
with one designer case concrete (30a for requirements validate),
leave other agents / gates for follow-up.

### Severity

**P0.** The current behaviour is "the turn silently hangs forever
with no UI." Any agent that doesn't opt into the structured-gate
contract is broken end-to-end.

---

## 31. Stream inactivity timeout leaves the daemon session alive + 10m window too short (P0)

### Observation (2026-04-21 live test)

Two bugs in one:

1. **Timeout window too short.** `STREAM_INACTIVITY_TIMEOUT_MS = 600_000`
   (10 minutes) at
   [daemonServiceImpl.ts:42](../../src/vs/workbench/contrib/insrc/electron-sandbox/daemonServiceImpl.ts#L42)
   tripped on legitimate long-running cloud agent turns (planner loops,
   delegate plan-execute chains, brainstorm enhance with a big idea set).
   A 10-minute stall is normal when a step is doing one heavyweight cloud
   call.

2. **Timeout path didn't tear the session down.** When the timer fired,
   it called `this._onDidError.fire(new Error('Stream inactivity timeout'))`
   and disposed the *local* stream handle -- but the chat service's
   `handle.onDidError` at
   [chatServiceImpl.ts:473](../../src/vs/workbench/contrib/insrc/electron-sandbox/chatServiceImpl.ts#L473)
   only ran `_finishStream()` (local cleanup) and fired an inline error
   event. **No `chat.cancel` / `chat.close` RPCs went to the daemon.**
   Result: daemon session stayed alive with a stalled turn, UI thought
   stream was done, user had a half-dead session that would keep
   surfacing stale RPC responses.

### Fix

Both in one commit.

**31a. Bump the timeout.** `STREAM_INACTIVITY_TIMEOUT_MS` 600_000 ->
1_800_000 (30 minutes). Comment notes why -- long cloud turns are
legitimate; shorter windows false-positive.

**31b. Teardown path on error.** `handle.onDidError` now calls
`this.cancelBrainstormSession(` `stream-error:${err.message}` `)` --
the same unified teardown the cancel button and brainstorm pane-close
use (runs `chat.cancel` + `chat.close` + clears local state + fires
`streamEnd` + `onRequestCloseBrainstormPanes` + `onDidChangeSession(undefined)`).
Skips the confirm dialog (nothing to confirm -- session is already
gone). Fires the inline error event first so the "Error: Stream
inactivity timeout" still renders in the transcript before teardown
clears the progress bar.

### Verification

- Stop a brainstorm mid-turn, wait 30+ min: timeout fires, session
  closes end-to-end (chat.close RPC in daemon log, session reset in
  UI, brainstorm panes close, progress bar clears).
- Normal 15-minute cloud turn: no false-positive timeout.
- Compile + build: verified 2026-04-21 via `scripts/build.sh`.

### Status

**DONE** (commit `d8183158c3c`, 2026-04-21). Files touched:
`src/vs/workbench/contrib/insrc/electron-sandbox/daemonServiceImpl.ts`
(constant + comment), `src/vs/workbench/contrib/insrc/electron-sandbox/chatServiceImpl.ts`
(onDidError teardown).

---

## 32. Long agent steps feel disconnected -- no token-level presence during multi-minute waits (P1)

### Observation (2026-04-21 live test)

During a brainstorm session, the user waits multiple minutes between
gate interactions while seeing only a single progress-bar line like
`"Enhancing ideas with code context..."`. The agent is doing real
work but the chat panel has zero presence -- no token stream, no
per-item progress, no sense of how close the step is to completion.

Monitor trace from the test session (brainstorm, design category, ~1500
token first idea set):

```
16:24:20  progress "Generating ideas..."       (seed = Claude Sonnet 4.6)
16:25:28  progress "Searching codebase..."     (+68s, nothing visible)
16:25:30  progress "Enhancing ideas..."        (local Ollama)
16:29:59  progress "Reviewing ideas..."        (+4m29s, nothing visible)
16:30:35  progress "Refining ideas..."         (+36s, nothing visible)
16:31:35  idea insert idx=1                    (+60s, first interaction)
```

Between 16:24:20 and 16:31:35, the user stares at a progress-bar label
for **seven minutes** with zero per-token or per-item feedback. The
session felt disconnected -- "is it stuck? is it working? am i close?"

### Root cause

Today the brainstorm controller emits one `progress` event per step
transition (seed, enhance, review, refine, etc.) and the daemon LLM
wrapper already receives streamed tokens but doesn't surface them.
`chat.send` only emits `delta` events for the *final* assistant
message of a classic chat turn. Agent-step LLM calls are treated as
opaque synchronous computations from the client's perspective.

The chat panel's progress indicator renders one line at a time;
each new progress event overwrites the old one. The transcript
gets nothing until the step completes and (sometimes) a gate fires.

### Fix sketch

Goal: restore presence without flooding the transcript. Two layers:

**32a. Sub-step progress events (small / safe).** Brainstorm
controller emits counted sub-progress inside each LLM step that
iterates over a list -- e.g. `review` already loops per idea, emit
`Reviewing idea 3/5: <title>`. Same for `refine` (per round + per
idea), `theme-spec` (per theme), `enhance` (per idea enrichment).
Changes a 4-minute silent wait into a 4-minute count-up with
titles the user can read. Daemon-side only; no transport changes.

**32b. Transient token stream into the chat panel (bigger).** The
LLM wrapper already has streamed output. Add an optional "live
step" channel that surfaces tokens from **every** agent step --
generative (seed, diverge, refine, theme-spec, assemble, discuss)
AND structured (review, cluster, promote, classify, enhance,
theme-spec-review) -- into a transient assistant bubble in the chat
transcript. The user's feedback was explicit: *every* step should
show its output, not just the prose ones. Structured-JSON steps
still stream their raw token output so the user sees presence; the
UI doesn't try to pretty-print mid-stream.

Characteristics:

- Visually distinct (dimmed / italic / with a spinner indicator and
  a step-name label like `[review]`, `[seed]`) so users can tell
  it's not the final output and which step is speaking.
- Replaced atomically when the step completes -- either removed, or
  compressed to a one-line summary ("review: 5 ideas reviewed, 2
  improved").
- **NOT persisted** to conversation history (no `saveTurn`).
- Multiple concurrent steps (rare but possible during diverge or
  parallel reviewer passes) each get their own transient bubble
  keyed by `(agent, step, iteration)`.

Transport: reuse the existing `delta` event but tag it with a
`channel: 'live-step' | 'final'` plus `step: { agent, name, iter? }`
so the panel can route it to a transient widget vs. the persistent
transcript, and group tokens by step. Requires:
- Daemon: new fields on `IpcStreamMessage.data` for delta events
  (`channel`, `step`); `executeLlmTask` wraps each LLM call with a
  stream-emitter that pipes tokens into `send({ stream: 'delta',
  data: { channel: 'live-step', step: { agent, name }, text } })`.
- Browser daemonService: parse `channel` + `step` and forward.
- Browser chatService: route live-step deltas to a separate event
  (`onDidReceiveLiveStep(event: { step, text })`) the chat panel
  can subscribe to; existing `onDidReceiveEvent` keeps getting only
  the `final` channel so the persistent transcript is unchanged.
- chatView: transient bubble widget that grows with tokens, clears
  on step completion; one bubble per live step, step-name label in
  the bubble header.

Opt-out: a per-step `liveStream: false` flag in `AGENT_STEP_CATALOG`
for steps where surfacing the raw output is actively noisy (none
today -- default is stream). Leaves the escape hatch in the catalog
for future tuning without another schema change.

Out of scope for 32: persisting the live output, user-editable
live-step content, pausing/resuming step streams, pretty-formatting
structured JSON mid-stream.

### Scope

32a is self-contained per-controller work; 32b touches the transport
layer and adds a UI widget. Ship 32a first (restores count-up
presence) and land 32b as a follow-up if 32a doesn't fully close
the disconnection gap.

### Severity

**P1.** Not a correctness bug -- the session works -- but the UX is
jarring enough that users reported it as "very disconnected" during
live testing. Long multi-minute waits with no presence erode trust
and make the agent feel stuck.

### Recommendation

Start with 32a. Measure whether per-item count-up is enough before
committing to the full transient-widget plumbing. Don't do both in
the same pass.

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
