# Brainstorm -- Detailed UI <-> Daemon Flow

Every user action across every brainstorm pane, traced end-to-end:
UI element -> RPC call -> daemon handler -> daemon-emitted next task/gate
-> pane that renders it.

All daemon references are to
`src/insrc/daemon/controllers/brainstorm/base.ts`.

Wire contract: UI calls `chatService.replyToGate(gateId, action, feedback)`.
That becomes an RPC `chat.reply` to the daemon, which feeds `gateReply`
into `runControlledPipeline.dispatch()` (line ~280). `dispatch` looks up
`this.state.lastStep` and routes to the matching `after*` handler.

---

## 1. Gate: `idea` -- single-idea review

**Built by:** `buildSingleIdeaGate` (line 729)
**Rendered by:** `BrainstormIdeasPane`
**`structured`:** `{ phase: 'ideation', itemType: 'idea', itemId, item: idea, progress }`

### Actions

| Button     | Input? | UI dispatch                                  |
|------------|:------:|----------------------------------------------|
| Approve    | no     | `replyToGate(gate, 'approve', undefined)`    |
| Reject     | no     | `replyToGate(gate, 'reject', undefined)`     |
| Skip       | no     | `replyToGate(gate, 'skip', undefined)`       |
| Park       | no     | `replyToGate(gate, 'park', undefined)`       |
| Diverge...   | yes    | `replyToGate(gate, 'diverge', feedback?)`    |
| Discuss...   | yes    | `replyToGate(gate, 'discuss', feedback?)`    |

### Handler: `afterSingleIdeaReview(gateReply)` (line 800)

Resolves `idea = reviewQueue[currentReviewIndex]`. If `!idea` -> returns
`resolveReviewQueue()` (see section 7).

#### `approve`
```
idea.status = 'accepted'
currentReviewIndex++
lastStep = 'idea-review'
return [buildSingleIdeaGate()]
```
-> Next `idea` gate -> **IdeasPane** (re-renders with next idea, OR if queue
exhausted `resolveReviewQueue()` kicks in -- see section 7).

#### `reject`
```
idea.status = 'rejected'
currentReviewIndex++
return [buildSingleIdeaGate()]
```
-> same as approve. Next `idea` gate -> IdeasPane.

#### `skip`
```
idea.status = 'skipped'
currentReviewIndex++
return [buildSingleIdeaGate()]
```
-> Next `idea` gate -> IdeasPane. Note: skipped ideas eventually become
`proposed` again in `resolveReviewQueue()` if nothing else is left.

#### `park`
```
idea.status = 'parked'
parkedIds.push(id)
currentReviewIndex++
return [buildSingleIdeaGate()]
```
-> Next `idea` gate -> IdeasPane. Parked ideas come back at end of queue.

#### `diverge`
```
recentFeedback = feedback || 'Diverge on: <title>'
idea.status = 'accepted'            // keeps the original accepted too
lastStep = 'idea-diverge-single'
return [{
  kind: 'llm',
  systemPrompt: getDivergePrompt(),
  userMessage: "## Original Idea ... ## Direction ... Generate variations ...",
  providerHint: 'local',
  stateKey: 'divergeSingleOutput',
}]
```
-> LLM runs -> `afterDivergeSingle` (line 907):
```
parseIdeaList(output) -> new ideas appended to state.ideas + reviewQueue
currentReviewIndex++
return [buildSingleIdeaGate()]
```
-> Next `idea` gate -> IdeasPane. Queue now has the variations after the
current position, so the next gates walk through them.

#### `discuss`
```
focusedIdeaId = idea.id
discussionMessages = []
if (feedback) discussionMessages.push({ role: 'user', content: feedback })
lastStep = 'idea-discuss-search'
return [{
  kind: 'rpc', rpcMethod: 'search.query',
  rpcParams: { text: title+body, limit: 10, filter: 'code' },
  stateKey: 'discussSearchOutput',
}]
```
-> Search RPC runs -> `afterIdeaDiscussSearch` (line 959):
```
focusedIdeaContext = <parsed entities as markdown>
lastStep = 'idea-discuss'
return [buildIdeaDiscussGate()]
```
-> Emits an `idea-discussion` gate -> **IdeaChatPane** (see section 3).

> **`currentReviewIndex` is NOT advanced on `discuss`.** When the user
> later exits the discussion with `accept`/`reject`/`back`, the daemon
> comes back to the same idea at the same queue position.

---

## 2. Gate: `idea-list` -- bulk review

**Built by:** `buildIdeaListGate` (line 1824)
**Rendered by:** `BrainstormIdeaListPane`
**`structured`:** `{ phase: 'ideation', itemType: 'idea-list' }`
Presented when queue is consumed without auto-converge triggering.

### Actions

| Button            | Input?  | UI dispatch                                          |
|-------------------|:-------:|------------------------------------------------------|
| Accept remaining  | no      | `replyToGate(gate, 'accept-remaining', undefined)`   |
| Diverge           | opt     | `replyToGate(gate, 'diverge', feedback?)`            |
| Converge now      | no      | `replyToGate(gate, 'converge', undefined)`           |
| *(per-item)* Discuss | implicit | `replyToGate(gate, 'discuss', ideaId)`            |

### Handler: `afterIdeaList(gateReply)` (line 643)

#### `accept-remaining` (or undefined)
Calls `handleIdeaApprove()` (section 8). Depending on threshold:
- `acceptedCount >= 8` OR `round >= 2`:
  ```
  mode = 'converge'
  lastStep = 'converge-cluster'
  return [buildConvergeClusterTask()]  // LLM task
  ```
  -> LLM runs -> `afterConvergeCluster` -> `converge-promote` -> eventually
  `validate-convergence` gate -> **ThemesPane** (section 4).
- otherwise:
  ```
  return [buildIdeaListGate()]  // stay on list until threshold met
  ```
  -> Another `idea-list` gate -> IdeaListPane.

#### `diverge`
```
rejected = ideas where status='rejected'
recentFeedback = "User rejected N ideas..." (+ user's feedback text)
ideas = ideas.filter(status !== 'rejected')
       .map(i => user-added/commented -> reset to 'proposed' for next round)
nextIdeaIndex = max(index) + 1
round += 1
return this.startIdeationRound()  // re-enters with new ideas generation
```
-> Generates another round of ideas -> eventually back to `idea` gate ->
IdeasPane.

#### `converge`
Similar to `accept-remaining` but always forces
`mode='converge'` + `converge-cluster`. -> ThemesPane after LLM.

#### `discuss` (clicking a row)
```
ideaId = gateReply.feedback                    // id comes in as feedback
focusedIdeaId = ideaId
discussionMessages = []
lastStep = 'idea-discuss-search'
return [{ kind: 'rpc', rpcMethod: 'search.query', ... }]
```
-> Same chain as section 1 discuss -> `idea-discussion` gate -> IdeaChatPane.

---

## 3. Gate: `idea-discussion` -- focused discussion

**Built by:** `buildIdeaDiscussGate` (line 1873)
**Rendered by:** `BrainstormIdeaChatPane`
**`structured`:** `{ phase: 'ideation', itemType: 'idea-discussion', itemId,
item: idea, messages: state.discussionMessages }`

### Actions

| Button        | Input? | UI dispatch                                  |
|---------------|:------:|----------------------------------------------|
| Accept        | no     | `replyToGate(gate, 'accept', undefined)`     |
| Reject        | no     | `replyToGate(gate, 'reject', undefined)`     |
| Refine...       | yes    | `replyToGate(gate, 'refine', text)`          |
| Discuss... (respond) | yes | `replyToGate(gate, 'respond', text)`       |
| Back          | no     | `replyToGate(gate, 'back', undefined)`       |

### Handler: `afterIdeaDiscuss(gateReply)` (line 982)

```
idea = ideas.find(id === focusedIdeaId)
if (!idea) return exitDiscussion()
```

#### `back` (or undefined)
```
return exitDiscussion()
```
`exitDiscussion` (line 1117) clears `focusedIdeaId` + `discussionMessages`,
then returns **either** `[buildSingleIdeaGate()]` (if
`sequentialReview`) **or** `[buildIdeaListGate()]`. So user lands back on
IdeasPane or IdeaListPane.

#### `accept`
```
idea.status = 'accepted'
return exitDiscussion()
```
-> same routing as `back`.

#### `reject`
```
idea.status = 'rejected'
return exitDiscussion()
```
-> same routing as `back`.

#### `respond` / `refine`
```
userMsg = gateReply.feedback
addDiscussionMessage('user', userMsg)
return [{
  kind: 'llm',
  systemPrompt: getDiscussRespondPrompt(),
  userMessage: buildDiscussionContext(idea, userMsg),
  stateKey: 'discussRespondOutput',
}]
```
-> LLM runs -> `afterIdeaDiscussRespond` (line 1039):
```
parse output as JSON { response, updatedIdea? }
if updatedIdea: apply title/body to idea
addDiscussionMessage('assistant', response)
return [buildIdeaDiscussGate()]
```
-> Same `idea-discussion` gate rebuilt with **updated
`discussionMessages`** in `structured` -> IdeaChatPane re-renders with the
new assistant response visible.

> **Currently-broken user-visible symptom** (feedback item #4): the
> rebuilt gate's `discussionMessages` is carried in `structured.messages`,
> and the session service puts it in `gate.extra.messages`. If the pane
> doesn't read `extra.messages` and feed it to the card widget as
> `messages`, the assistant reply never appears on screen. Verify
> IdeaChatPane wires this path end-to-end.

---

## 4. Gate: `convergence-review`

**Built by:** `buildValidateConvergenceTask` (line 1998)
**Rendered by:** `BrainstormThemesPane`
**`structured`:** `{ phase: 'convergence', itemType: 'convergence-review' }`
**cyclic:** `{ maxRounds: 3, retryActions: ['edit'], skipActions: ['diverge'] }`

### Actions

| Button      | Input? | UI dispatch                               |
|-------------|:------:|-------------------------------------------|
| Approve     | no     | `replyToGate(gate, 'approve', undefined)` |
| Request edits | yes  | `replyToGate(gate, 'edit', text)`         |
| Back to ideation | yes | `replyToGate(gate, 'diverge', text)`     |

### Handler: `afterValidateConvergence(gateReply)` (line 1193)

Parses JSON feedback for optional `comments[themeIdx]` and
`priorities[themeIdx]` (from the themes tab). Applies comments/priorities
to `state.themes[idx]`.

#### `approve`
```
apply promotions -> state.requirements
apply merges -> state.ideas[i].promotedTo / mergedInto
if (skipPerThemeSpec()): lastStep = 'assemble-spec'; return [buildAssembleSpecTask()]
else: specThemeQueue = themes.map((_, idx) => idx); return nextThemeSpec()
```
`nextThemeSpec` (line 1271):
- If queue empty -> `buildAssembleSpecTask` (no gate -- just LLM then finalize).
- Else pop first index, run `search-theme-context` (RPC) -> `generate-theme-spec`
  (LLM) -> `review-theme-spec` (LLM) -> **`theme-spec-review` gate** (section 5).

#### `edit`
```
key = `convergence-${round}`
rounds = (editRounds[key] ?? 0) + 1
if (rounds > 3): force proceed to nextThemeSpec()
else:
  editRounds[key] = rounds
  recentFeedback = gateReply.feedback
  pendingPromotions = []; pendingMerges = []
  lastStep = 'converge-cluster'
  return [buildConvergeClusterTask()]
```
-> LLM re-clusters -> `converge-promote` -> another `convergence-review`
gate (up to 3 rounds) -> ThemesPane re-renders.

#### `diverge`
```
pendingPromotions = []; pendingMerges = []
recentFeedback = gateReply.feedback
mode = 'diverge'
round += 1
return this.startIdeationRound()
```
-> Back to ideation LLM -> eventually `idea` gate -> IdeasPane.

---

## 5. Gate: `theme-spec` -- per-theme spec review (new)

**Built by:** `buildThemeSpecReviewTask` (line 1406)
**Rendered by:** `BrainstormThemeDetailsPane`
**`structured`:** `{ phase: 'specify', itemType: 'theme-spec', itemId,
item: { themeIndex, themeName, themeId, content }, progress: { current, total, remaining } }`
**cyclic:** `{ maxRounds: 3, retryActions: ['edit'], skipActions: [] }`

### Actions

| Button         | Input? | UI dispatch                                |
|----------------|:------:|--------------------------------------------|
| Approve        | no     | `replyToGate(gate, 'approve', undefined)`  |
| Request edits  | yes    | `replyToGate(gate, 'edit', text)`          |

### Handler: `afterThemeSpecReview(gateReply)` (line ~1456)

#### `approve` (or undefined)
```
return nextThemeSpec()
```
-> Either the **next `theme-spec` gate** (next theme in the queue) -> same
pane -> or `assemble-spec` -> `finalize` -> **`presentation` gate** (section 6).

#### `edit`
```
key = `theme-spec-<themeId or themeIndex>`
rounds = editRounds[key] ?? 0
if (rounds >= 3): return nextThemeSpec()  // safety rail
editRounds[key] = rounds + 1
drop the last specSections entry (the one being edited)
recentFeedback = "Edit request for <themeName>:\n<user feedback>"
lastStep = 'generate-theme-spec'
return [buildGenerateThemeSpecTask(themeIdx)]
```
-> LLM regenerates the section -> `afterGenerateThemeSpec` pushes it to
`specSections` -> `review-theme-spec` (LLM polish) -> `afterReviewThemeSpec`
emits another `theme-spec` gate -> ThemeDetailsPane re-renders.

---

## 6. Gate: `presentation` -- final

**Built by:** `buildPresentationTask` (line 2204)
**Rendered by:** `BrainstormPresentationPane`
**`structured`:** `{ phase: 'finalize', itemType: 'presentation' }`
**gate.content:** rendered HTML of the assembled spec.

### Actions

| Button        | Input? | UI dispatch                                    |
|---------------|:------:|------------------------------------------------|
| Save...         | yes    | `replyToGate(gate, 'save', JSON.stringify({ format, path }))` |
| Discard (skip)| no     | `replyToGate(gate, 'skip', undefined)`         |

### Handler: `afterPresentation(gateReply)` (line ~1415)

#### `save`
```
parse feedback as JSON { format, path }
call saveArtifact(config)  // writes file to disk
return null                 // session ends
```
-> Chat stream ends, pane can close.

#### `skip`
```
return null                 // session ends, no file written
```

---

## 7. Queue exhaustion -- `resolveReviewQueue` (line 929)

Triggered when `afterSingleIdeaReview` finds `idea` undefined at the
current queue index (i.e. queue consumed).

```
1. parked ideas with status='parked' -> re-populate reviewQueue with them,
   reset currentReviewIndex=0, clear parkedIds.
2. if no parked items: turn all 'skipped' -> 'proposed', then call
   handleIdeaApprove().
```

`handleIdeaApprove` sets all `proposed` -> `accepted` and checks the
auto-converge threshold (see section 8).

---

## 8. `handleIdeaApprove` (line 1130)

```
ideas = ideas.map(i => i.status==='proposed' ? {...i, status:'accepted'} : i)
accepted = ideas.filter(status==='accepted').length
if (accepted >= AUTO_CONVERGE_THRESHOLD(=8) || round >= 2):
  mode = 'converge'
  lastStep = 'converge-cluster'
  return [buildConvergeClusterTask()]
else:
  lastStep = 'idea-list'
  return [buildIdeaListGate()]
```

So after ideation, the next gate is **either** `idea-list` (if we haven't
hit threshold and round is 1) **or** directly `convergence-review`.

---

## 9. Transition summary (pane routing)

```
IdeasPane  --approve/reject/skip/park/diverge->  IdeasPane
          \
           ----discuss->  (daemon runs search RPC)  ->  IdeaChatPane
                                                  (accept/reject/back) ->  IdeasPane or IdeaListPane
                                                  (respond/refine) -> IdeaChatPane (updated messages)

IdeasPane (queue exhausted) -> resolveReviewQueue ->
     -> IdeasPane (if parked)
     -> IdeaListPane  (if round 1 and accepted < 8)
     -> ThemesPane    (otherwise)

IdeaListPane
  accept-remaining | converge  -> ThemesPane
  diverge                       -> IdeasPane (next round)
  discuss(id)                  -> IdeaChatPane

ThemesPane
  approve -> ThemeDetailsPane (first of N) OR PresentationPane (if skipPerThemeSpec)
  edit    -> ThemesPane (re-cluster, up to 3 times)
  diverge -> IdeasPane (next round)

ThemeDetailsPane
  approve -> ThemeDetailsPane (next theme) OR PresentationPane (when queue empty)
  edit    -> ThemeDetailsPane (regenerate this theme, up to 3 times)

PresentationPane
  save -> session ends
  skip -> session ends
```

---

## 10. Known bugs / open items mapped to handlers

| Feedback item                                    | Handler involved                              | Probable gap                                                                                                        |
|--------------------------------------------------|-----------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| Discuss: "nothing changed"                       | `afterSingleIdeaReview case 'discuss'`        | Pre-`6133ba3` daemon doesn't emit structured -> browser kind='unknown' -> flow contribution (pre-fallback) drops.     |
| Discuss: no agent reply shown                    | `afterIdeaDiscussRespond`                     | The rebuilt gate carries `discussionMessages` under `structured.messages`; IdeaChatPane must read `gate.extra.messages` and pass as `messages` to BrainstormCardWidget. |
| Refined idea comes back unchanged                | `afterRefineIdeas` / `afterIdeaDiscussRespond`| Either the refine LLM task isn't applying feedback to the idea body, or the gate is re-emitting the pre-refine idea. Trace `applyIdeaReview` / `refined output parsing`. |
| Diverge "DOING NOTHING"                          | `afterSingleIdeaReview case 'diverge'`        | Daemon LLM is running (`providerHint: 'local'`). If the local model is missing / mis-configured the LLM task errors and the pipeline stalls. Needs UI error surfacing. |
| Intent classification validation gate            | `chat-handler.ts:597` (progress "Intent: X")  | No daemon-side confirmation step exists -- classification flows straight into the agent pipeline. Adding user-approval would require a new pre-agent gate.             |
| Mid-turn classification correction               | same                                          | Same as above; user has to kill the stream + re-send.                                                               |

---

## 11. Reject / Diverge / Discuss -- LLM context and response handling

Deep-dive on the three handlers that shipped the recent "nothing
happens" / "same ideas again" complaints.

### 11.1 reject -- no LLM

Handler: `afterSingleIdeaReview case 'reject'` ([base.ts:818](src/insrc/daemon/controllers/brainstorm/base.ts#L818)).

```ts
case 'reject':
  idea.status = 'rejected';
  recordQnA(state, 'idea-review', 'user',
    `Review idea ${ideaLabel}`,
    `Rejected: ${gateReply.feedback || 'No reason given'}`);
  break;
// fall-through to advance:
currentReviewIndex++;
lastStep = 'idea-review';
return [buildSingleIdeaGate()];
```

**No LLM call.** The user's reject feedback is committed to the QnA log
(a session-level audit trail) and then discarded from the flow. It is
**not** fed back into:

- the next single-idea gate,
- the next ideation round's generation LLM,
- the refine / enhance LLMs,
- the per-idea discussion context.

The only place any rejection reason ever reaches the LLM is through
`afterIdeaList case 'diverge'` ([base.ts:670](src/insrc/daemon/controllers/brainstorm/base.ts#L670)), which bulk-stringifies rejected idea titles
into `recentFeedback` before starting a new ideation round. That path is
only reached from the `idea-list` gate, and only when the user explicitly
clicks "Back to diverge" there.

**Why it explains "rejected ideas come back unchanged"**:
In single-idea review the reject feedback doesn't propagate, so the next
round's idea-generation LLM has no signal about *why* the user rejected
an idea -- it just sees a pool of remaining ideas and the original
problem statement. Variations of the same theme often resurface.

**Concrete fix path:**
On reject, also stash the feedback into `state.recentFeedback` (or a new
`rejectedWithReason` map keyed by idea id) and include it in the user
message of the subsequent ideation-round LLM task built by
`buildGenerateIdeasTask` / `buildDivergeTask`. Something like
`"## Prior rejections\n- [3] X (reason: ...)\n..."`.

---

### 11.2 diverge -- narrow LLM context + queue-tail insertion

Handler: `afterSingleIdeaReview case 'diverge'` ([base.ts:840](src/insrc/daemon/controllers/brainstorm/base.ts#L840)).

Task emitted to the LLM:

| Field        | Value                                                                                                      |
|--------------|------------------------------------------------------------------------------------------------------------|
| kind         | `'llm'`                                                                                                    |
| providerHint | `'local'` (Ollama)                                                                                         |
| systemPrompt | `getDivergePrompt()` (category-specific prompt template)                                                   |
| userMessage  | (see below)                                                                                                |
| stateKey     | `'divergeSingleOutput'`                                                                                    |

```
## Original Idea
[<idx>] <title>: <body>

## Direction
<gateReply.feedback or "Generate 3-5 variations or alternatives.">

Generate variations as a numbered list: [N] Title. Description
```

**Context that is NOT passed:**

- `state.input.message` (the problem statement).
- Accepted, rejected or parked ideas so far.
- `state.focusedIdeaContext` (code entity context from prior searches).
- The review verdict / rationale already attached to the idea.
- Any cross-round history.

The LLM sees one idea and a direction string. The diverge is
deliberately narrow; whether that's the right scope is a separate design
question.

Response handler: `afterDivergeSingle` ([base.ts:907](src/insrc/daemon/controllers/brainstorm/base.ts#L907)).

```ts
newIdeas = parseIdeaList(output, round, nextIdeaIndex, repoPath, _entityIndex);
for (const idea of newIdeas) {
  state.ideas.push(idea);
  state.reviewQueue.push(idea.id);       // APPEND TO END
}
state.nextIdeaIndex += newIdeas.length;
state.currentReviewIndex++;              // advance past original
return [buildSingleIdeaGate()];
```

`parseIdeaList` (shared with seed-idea parsing) regex-matches
`^\s*\[N\]\s*Title. Description`. If Ollama's output drifts -- missing
the `[N]` prefix, plain prose, code fences only, JSON -- the parse
returns an empty array and no ideas are added. The handler doesn't
log the failure, doesn't surface it to the user, and still advances
the queue.

**Two ways "diverge does nothing" happens:**

1. Ollama is down / the model returns an error -> LLM task fails ->
   pipeline proceeds with `state.currentReviewIndex++` but no new ideas
   appended. Queue advances to the next unrelated idea.
2. Ollama returns text but not in `[N] Title. Description` format ->
   `parseIdeaList` returns `[]` -> same silent advance.

**Visible bug even on the happy path:**

Variations are appended to the **end** of `reviewQueue`. With
`currentReviewIndex++` also advancing past the original idea, the user
now sees `reviewQueue[currentIndex]` = the *next original idea*, not any
of the variations they just asked for. The variations surface only
after the rest of the queue has been consumed. The user's click
appears to "do nothing" because the pane's next card is unrelated to
what they diverged from.

**Concrete fix paths:**

1. Surface LLM task failures on the card (the `submitting` timeout is
   the generic catch, but the `TaskResult.error` field can be shown
   specifically).
2. Insert variations **immediately after** the current queue position
   (`reviewQueue.splice(currentReviewIndex + 1, 0, ...newIds)`) instead
   of `push(...)` at the tail, so the next card is a variation of the
   idea the user diverged from.
3. Alternatively: emit an intermediate confirmation gate ("Generated 5
   variations -- review now / defer") before advancing, so the user gets
   feedback that their click produced something.

---

### 11.3 discuss -- rich context, two-task chain, response path

The discuss flow is the richest. Two separate backend steps happen
before the user can even see the discussion pane, then each user
message runs one more LLM round-trip.

#### Step A -- `discuss` click on the `idea` gate

Handler: `afterSingleIdeaReview case 'discuss'` ([base.ts:869](src/insrc/daemon/controllers/brainstorm/base.ts#L869)).

```ts
state.focusedIdeaId = idea.id;
state.discussionMessages = [];
if (gateReply.feedback) {
  state.discussionMessages.push({
    role: 'user',
    content: gateReply.feedback,
    timestamp: new Date().toISOString(),
  });
}
state.lastStep = 'idea-discuss-search';
return [{
  kind: 'rpc',
  rpcMethod: 'search.query',
  rpcParams: { text: (idea.title + '. ' + idea.body).slice(0, 200), limit: 10, filter: 'code' },
  stateKey: 'discussSearchOutput',
}];
```

**Not an LLM call.** It's an entity-search RPC. `currentReviewIndex` is
**not** advanced -- when the user later exits, they come back to the
same idea.

Response handler: `afterIdeaDiscussSearch` ([base.ts:959](src/insrc/daemon/controllers/brainstorm/base.ts#L959)) parses the entity
results and stringifies them:

```
[<kind>] <name> - <signature> (<file>)
<body (300 char truncation)>

[<kind>] <name> ...
```

Stored in `state.focusedIdeaContext`. Then emits `buildIdeaDiscussGate`.

#### Step B -- per-message (`respond` / `refine` on the discussion gate)

Handler: `afterIdeaDiscuss case 'respond'/'refine'` ([base.ts:1008](src/insrc/daemon/controllers/brainstorm/base.ts#L1008)).

```ts
addDiscussionMessage('user', userMsg);          // append to state.discussionMessages
return [{
  kind: 'llm',
  systemPrompt: getDiscussRespondPrompt(),
  userMessage: buildDiscussionContext(idea, userMsg),
  stateKey: 'discussRespondOutput',
}];
```

`buildDiscussionContext` ([base.ts:1086](src/insrc/daemon/controllers/brainstorm/base.ts#L1086)) assembles:

```
## Original Problem
<state.input.message>

## Idea Being Discussed
[<idx>] <title>: <body>
Verdict: <reviewVerdict>                       // if present
Rationale: <reviewRationale>                   // if present

## Relevant Code
<focusedIdeaContext>                           // from step A

## Discussion History
User: ...
Assistant: ...
User: ...

## Current Message
<new user msg>
```

Everything the idea carries + all prior turns. Provider is **not
hinted** on this task, so `runControlledPipeline` resolves the default
chat provider (cloud or local depending on routing config).

Response handler: `afterIdeaDiscussRespond` ([base.ts:1039](src/insrc/daemon/controllers/brainstorm/base.ts#L1039)).

```ts
// Expect JSON wrapped in optional code fences:
//   { "response": "<markdown>", "updatedIdea"?: { "title": "...", "body": "..." } }
try {
  const parsed = JSON.parse(stripFences(output));
  if (parsed?.response) {
    responseText = parsed.response;
    if (parsed.updatedIdea) {
      idea.title = parsed.updatedIdea.title ?? idea.title;
      idea.body  = parsed.updatedIdea.body  ?? idea.body;
      addDiscussionMessage('assistant', `[Idea updated: ${idea.title}]`);
    }
  }
} catch {
  // Plain text response, no idea update.
}
addDiscussionMessage('assistant', responseText);
recordQnA(state, 'idea-discuss', 'system', ..., responseText.slice(0, 300));
state.lastStep = 'idea-discuss';
return [buildIdeaDiscussGate()];
```

The rebuilt `idea-discussion` gate carries the updated
`state.discussionMessages` in its `structured.messages` field. On the
wire:

```
gate.context.structured = {
  phase: 'ideation',
  itemType: 'idea-discussion',
  itemId, item: idea,
  messages: [ { role: 'user', content: ... }, { role: 'assistant', content: ... }, ... ],
}
```

Session service (`brainstormSessionServiceImpl._ingestGate`) extracts
non-well-known fields into `snapshot.extra`, so `messages` lands at
`gate.extra.messages` on the browser side.

**Known failure modes for the assistant reply not showing:**

1. **LLM returns malformed JSON.** The `catch {}` drops the parse,
   `responseText` stays as the raw LLM output, and that raw output gets
   appended as the assistant message. The response IS produced -- this
   path never swallows the reply.
2. **`BrainstormIdeaChatPane` not reading `gate.extra.messages`.** If the
   pane doesn't pass `messages` into the `BrainstormCardWidget`'s
   `CardData`, the card renders the idea but not the discussion
   history -- even though the daemon sent it. This is the most likely
   cause of the user-visible "no agent reply" symptom.
3. **Daemon on pre-`6133ba3` commit.** Before that commit the
   `buildIdeaDiscussGate` didn't carry `structured` at all, the session
   service classifies the gate as `'unknown'`, the flow contribution
   drops it, and the user stays on IdeasPane in Waiting... forever. This
   is the "discuss does nothing" symptom from the original test.

**Concrete fix paths:**

- Verify `BrainstormIdeaChatPane._renderGate` reads
  `gate.extra?.messages` and threads it as the `messages` prop into
  `BrainstormCardWidget`. The widget's `_renderDiscussion` expects
  `data.messages: CardDiscussionMessage[]`; any mismatch of shape
  (`{role, content}` on both sides) or failure to pass the array
  through yields the observed blank area.
- Surface daemon-side LLM errors on the idea-discussion card. If
  `afterIdeaDiscussRespond` receives `completed.success === false`,
  today it still calls `addDiscussionMessage('assistant', output)`
  which may be empty. Should append a visible `[error: <message>]`
  line so the user sees the LLM failed rather than the reply vanishing.

---

## 12. What the UI is responsible for, per pane

- **IdeasPane**: render `gate.item` as an idea card. Reply to gate with
  approve/reject/skip/park (no input) or diverge/discuss (text feedback
  via inline prompt). No other state.
- **IdeaListPane**: render `sessionService.ideas` as a list. Reply with
  accept-remaining / diverge / converge / discuss(idea.id as feedback).
- **IdeaChatPane**: render `gate.item` as the focused idea + discussion
  history from `gate.extra.messages`. Reply with accept/reject/back or
  refine/respond (text feedback).
- **ThemesPane**: render `sessionService.themes` as cards. Reply with
  approve/edit/diverge (text feedback for edit/diverge).
- **ThemeDetailsPane**: render `gate.item.content` as preformatted
  markdown. Reply with approve/edit (text feedback for edit).
- **PresentationPane**: render `gate.content` as HTML. Reply with save
  (JSON `{format, path}` as feedback) or skip.
