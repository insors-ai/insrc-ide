# Plan: Per-Idea Feedback Capture

Extends the `Idea` data model to carry a structured feedback history and
teaches the daemon to thread that feedback into subsequent ideation LLM
rounds. Addresses the "rejected ideas come back unchanged" and
"variations don't reflect my direction" feedback from testing.

## Decisions (locked)

| Ref | Decision                                                                                       |
|-----|------------------------------------------------------------------------------------------------|
| A1  | Template reject string: `"Rejected without a stated reason."`                                  |
| B   | Only `reject` / `diverge` / `discuss` actions record feedback. (approve/park/skip do not.)     |
| C2  | LLM prompt includes feedback for every idea that has any entry (not filtered by action).       |
| D1  | Each user `respond`/`refine` message during discussion pushes its own feedback entry.          |
| E   | `feedback[]` resets per round. Old feedback lives in `state.qna` for audit only.               |

## Scope summary

- Daemon-side data model change + handler updates + prompt block.
- No protocol change: the `Idea` object already rides in gate
  `structured.item`. Adding a `feedback` field is additive; browser
  tolerates unknown fields.
- Browser panes **do not** need changes for MVP. (Future: IdeaChatPane
  could surface the feedback array to show "why rejected" hints, but
  that's a separate ticket.)

---

## 1. Data model

File: `src/insrc/agent/tasks/brainstorm/types.ts`

### New interface

```ts
/** A single feedback entry captured during review of this idea. */
export interface IdeaFeedback {
  /** Which user action produced this feedback. */
  action: 'reject' | 'diverge' | 'discuss';
  /** User-supplied reason, or the template string when user gave none. */
  reason: string;
  /** True when `reason` is the default template (only set for `reject`
   *  with empty user input). */
  templated: boolean;
  /** Round this feedback was given in. */
  round: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
}
```

### Idea extension

```ts
export interface Idea {
  // ... existing fields
  /** Feedback entries for the CURRENT round. Reset per round so the
   *  LLM prompt sees only currently-applicable feedback. Historical
   *  feedback is kept in state.qna for audit. */
  feedback: IdeaFeedback[];
}
```

**Backwards-compat:** runtime code reads `idea.feedback ?? []` so older
persisted state (no field) still works. Serializer always writes the
field on new ideas so fresh state is well-formed.

### Constants

```ts
export const REJECT_FEEDBACK_TEMPLATE = 'Rejected without a stated reason.';
```

---

## 2. Initialization sites

Every place that constructs an `Idea` initializes `feedback: []`:

| File                                              | Line(s)          | Notes                                     |
|---------------------------------------------------|------------------|-------------------------------------------|
| `agent/tasks/brainstorm/ideas.ts` -> `parseIdeaList` | ~189-198      | Sets `feedback: []` alongside other defaults. |
| `agent/tasks/brainstorm/ideas.ts` -> `applyIdeaSelections` (user-added path)         | ~319           | New user-created ideas get empty feedback.|
| `daemon/controllers/brainstorm/base.ts` -> `processIdeaFeedback` user-added path     | ~1606-1617     | Same.                                     |

---

## 3. Handler updates (daemon)

File: `src/insrc/daemon/controllers/brainstorm/base.ts`

### Helper

Add a private helper once:

```ts
private pushFeedback(
  idea: Idea,
  action: IdeaFeedback['action'],
  rawReason: string | undefined,
): void {
  let reason = (rawReason ?? '').trim();
  let templated = false;
  if (!reason) {
    if (action !== 'reject') {
      // Non-reject feedback with no text is a no-op per decision B.
      return;
    }
    reason = REJECT_FEEDBACK_TEMPLATE;
    templated = true;
  }
  idea.feedback ??= [];
  idea.feedback.push({
    action,
    reason,
    templated,
    round: this.state.round,
    timestamp: new Date().toISOString(),
  });
}
```

### `afterSingleIdeaReview` (~line 800)

```ts
case 'reject':
  idea.status = 'rejected';
  this.pushFeedback(idea, 'reject', gateReply.feedback);    // <-- NEW
  recordQnA(...);
  break;

case 'diverge':
  // existing body
  this.pushFeedback(idea, 'diverge', gateReply.feedback);   // <-- NEW
  // existing return [...]

case 'discuss':
  // existing body, but in addition:
  this.pushFeedback(idea, 'discuss', gateReply.feedback);   // <-- NEW (only if feedback provided)
  // existing return [...]
```

`approve` / `park` / `skip` are untouched (decision B).

### `afterIdeaList` (~line 643)

Per-idea actions from the list gate also record feedback on the target idea:

```ts
if (gateReply.action === 'discuss') {
  const idea = state.ideas.find(...);
  if (!idea) return ...;
  this.pushFeedback(idea, 'discuss', <any user-typed context>);  // NEW
  // existing return [...]
}

if (gateReply.action === 'diverge') {
  // bulk operation; iterate rejected ideas
  for (const i of rejected) {
    this.pushFeedback(i, 'reject', /* no per-item reason */ undefined);
    // templated reason gets pushed
  }
  // ... existing round-bump logic
}
```

### `afterIdeaDiscuss` (~line 982)

Per-message during discussion (decision D1):

```ts
if (gateReply.action === 'respond' || gateReply.action === 'refine') {
  const userMsg = gateReply.feedback ?? '';
  if (userMsg.trim()) {
    this.pushFeedback(idea, 'discuss', userMsg);             // <-- NEW
  }
  addDiscussionMessage('user', userMsg);
  // existing return [{ kind: 'llm', ... }]
}
```

On discussion exit:
```ts
case 'accept':   // no feedback recorded (approve is excluded)
case 'back':     // no feedback recorded
case 'reject':
  idea.status = 'rejected';
  this.pushFeedback(idea, 'reject', gateReply.feedback);     // <-- NEW (template if empty)
  return exitDiscussion();
```

---

## 4. Per-round reset (decision E)

`feedback[]` is reset to `[]` on each idea whenever a new ideation round
starts. Candidate spots:

- **`afterIdeaList case 'diverge'`** (~line 670): already maps ideas and
  mutates round/status; extend to `feedback: []`.
- **`afterValidateConvergence case 'diverge'`** (~line 1240): same, when
  round bumps.
- **`startIdeationRound`** (~line 381): central entry for any new round;
  safest place to unconditionally reset feedback on all retained ideas.

Concrete change in `startIdeationRound`:

```ts
private startIdeationRound(): Task[] {
  // Reset feedback for all ideas entering the new round -- feedback
  // from the previous round is preserved in state.qna for audit but
  // should not leak into the new round's LLM prompt.
  for (const i of this.state.ideas) {
    i.feedback = [];
  }
  // ... existing search / enrichment / generation task build
  return [this.buildGenerateIdeasTask()];
}
```

---

## 5. LLM prompt update

File: `base.ts -> buildGenerateIdeasTask` (~line 1727)

New block appended to `userMessage` after `## Existing Accepted Ideas`
and before `## User Direction`:

```ts
// Synthesize a feedback block from every idea that has feedback this round
const withFeedback = this.state.ideas.filter(i => (i.feedback ?? []).length > 0);
if (withFeedback.length > 0) {
  const block = withFeedback.map(i => {
    const bullets = i.feedback.map(f =>
      `    ${f.action}: ${f.reason}${f.templated ? ' (default)' : ''}`
    ).join('\n');
    return `- [${i.index}] "${i.title}"\n${bullets}`;
  }).join('\n');
  userMessage += `\n\n## Prior Feedback on Earlier Ideas\n${block}`;
}
```

Example of what the LLM ends up seeing on a diverge round:

```
## Existing Accepted Ideas
- [1] Route by role tags
- [4] Use calendar availability

## Prior Feedback on Earlier Ideas
- [3] "Bulk assignment via spreadsheet upload"
    reject: too narrow, need an API path too
- [5] "Assign based on past completion rate"
    reject: Rejected without a stated reason. (default)
    discuss: how would we handle new hires with no history?
- [7] "LLM rewrites task descriptions before assignment"
    diverge: keep the original task text unchanged
```

**Why the action label + templated flag matters:**
- `reject (default)` tells the model "user rejected, but didn't say why --
  avoid merely rephrasing this idea."
- `reject: <reason>` tells the model the concrete concern to address.
- `diverge: <direction>` tells the model what dimension to explore.
- `discuss: <question>` hints at aspects the user wants clarified.

---

## 6. Audit trail untouched

`recordQnA(state, ...)` calls stay exactly as they are -- `state.qna`
continues to accumulate across rounds and serves as the complete audit
trail. The per-round `feedback[]` reset only affects the LLM prompt
context, not the audit history.

---

## 7. UI side -- no changes required for MVP

The current flow contribution + panes don't read `idea.feedback`. Passing
the new field through `structured.item` is harmless -- the browser's
idea parser uses `_asString` / `_asNumber` helpers and ignores unknown
fields.

Optional future work (out of scope for this plan):

- IdeaChatPane: show a "Prior feedback in this round" strip above the
  card.
- IdeasPane: small badge indicating the idea has accumulated N feedback
  entries.
- Feedback audit view: end-of-session summary of every feedback entry
  ever given (reads from `state.qna`).

---

## 8. Ordered change list

1. **types.ts** -- add `IdeaFeedback` interface, add `feedback` field to
   `Idea`, export `REJECT_FEEDBACK_TEMPLATE`.
2. **ideas.ts** -- initialize `feedback: []` in `parseIdeaList` and the
   user-added idea path in `applyIdeaSelections`.
3. **base.ts** -- add `pushFeedback` helper.
4. **base.ts** -- `afterSingleIdeaReview`: call `pushFeedback` in
   `reject` / `diverge` / `discuss` cases.
5. **base.ts** -- `afterIdeaList`: call `pushFeedback` in `discuss` and
   bulk-diverge paths.
6. **base.ts** -- `afterIdeaDiscuss`: call `pushFeedback` on
   `respond` / `refine` / `reject` cases.
7. **base.ts** -- `startIdeationRound`: reset `feedback` on every idea.
8. **base.ts** -- user-added idea construction (~line 1606): add
   `feedback: []`.
9. **base.ts** -- `buildGenerateIdeasTask`: synthesize the
   `## Prior Feedback on Earlier Ideas` block.
10. Build daemon + commit. No UI rebuild needed for this plan.

---

## 9. Verification

After landing:

1. **Reject with reason -> next round.** Kick a brainstorm, reject an
   idea with a concrete reason ("too narrow"), click "Back to diverge"
   on the list. Inspect `buildGenerateIdeasTask` output: the
   `## Prior Feedback` block should contain that rejected idea with its
   user-supplied reason. Next-round ideas should address the concern.
2. **Reject without reason -> template.** Same flow but leave the prompt
   empty. The feedback line should read `reject: Rejected without a stated reason. (default)`.
3. **Per-round reset.** After a diverge round kicks, all ideas' `feedback`
   arrays should be `[]`. `state.qna` should still hold every prior
   feedback entry as a turn record.
4. **Discuss loop.** Send three `respond` messages in discussion. After
   each, inspect the focused idea: `feedback` should grow by one
   `discuss` entry per message. The LLM response should visibly take
   each of those into account (verified by reading the response text).
5. **Approve / park / skip.** After those actions, the idea's `feedback`
   array should be unchanged (empty if nothing else happened to it).

---

## 10. Migration / rollout

- Backwards-compat with existing `~/.insrc/checkpoints/<session>.json`:
  resumed sessions that have no `feedback` field on ideas get `[]` at
  first access. No migration script needed.
- No browser version gate: old browsers ignoring the new field behave as
  before.
- Daemon change alone; user must restart the daemon for these handlers
  to activate (per project deployment rules).

---

# Phase 2: Brainstorm Session Resume

Resume functionality so a brainstorm can survive daemon restart, crash,
or the user accidentally closing the pane. Complements Phase 1 because
the per-round `feedback[]` reset means the state we're persisting is
the authoritative source of truth for "what's applicable now."

## P2.0 Decisions (locked)

| Ref | Decision                                                                                  |
|-----|-------------------------------------------------------------------------------------------|
| F1  | End-Session confirmation (close-pane) deletes the checkpoint. No Runs-sidebar retention.  |
| G2  | Mid-LLM-task resumes surface explicitly -- no silent re-runs. User picks retry / abandon. |
| H1  | `save` failure on the presentation gate keeps the checkpoint so the user can retry.       |
| I2  | Schema drift on resume refuses to rehydrate and prompts the user to discard the checkpoint.|

## P2.1 Current state

- Checkpoints are already written on every `persisted: true` task
  (brainstorm agent task is persisted). File format:
  `{ controller, state: <BrainstormState snapshot>, results, timestamp }`
  under `~/.insrc/checkpoints/<controllerId>-<timestamp>.json`.
- `daemonService.rpc('agent.list')` already returns these as runs; the
  browser's Runs sidebar view already surfaces them.
- `daemonService.rpc('agent.resume', { id })` ([daemon/index.ts:257](src/insrc/daemon/index.ts#L257))
  is a stub: returns `"Use chat.resume with sessionId=..."` without
  actually rehydrating.
- `chat.resume` loads chat-history for continuation but does not
  reconstitute the brainstorm controller.

Net gap: the checkpoint data is there, but nothing reads it to restart
a brainstorm.

## P2.2 Goals

1. **Real `agent.resume`**: given a session id (or controller id),
   load the latest checkpoint, rehydrate the brainstorm controller,
   and re-emit the most recent pending gate so the browser flow
   contribution reopens the right pane.
2. **One checkpoint per session, not per task**: today every task step
   writes a fresh file. Switch to overwriting a single file per session,
   so `agent.list` shows one entry per session, not dozens.
3. **Checkpoint GC**: if the per-session-file change ships, GC becomes
   trivial (delete the one file on `agent.discard` or on session
   completion). Until then, cap the number of retained files per
   controller at 5 to stop unbounded growth.
4. **UI resume affordance**: the Runs sidebar already lists runs and
   calls `agent.resume`. The call needs to return the session id so
   the browser can `chatService.resumeSession(id)` to re-hook the
   stream.

## P2.3 Checkpoint file layout change

File: `src/insrc/daemon/task.ts` -> `checkpointState`

Current:
```ts
const file = join(dir, `${controllerId}-${Date.now()}.json`);
```

Replace with:
```ts
const sessionId = stateStore.get<string>('sessionId') ?? 'default';
const file = join(dir, `${controllerId}-${sessionId}.json`);
```

Consequences:
- Each subsequent step overwrites the same file. Disk doesn't grow.
- `agent.list` aggregates by file -> one entry per live brainstorm.
- `agent.discard` deletes a single known file.

Callers that currently assume timestamp-based filenames (`agent.list`
reader in `daemon/index.ts:230`) continue to work -- they just read
whatever files are in the directory.

**Session id must be written into the store early.** Add at start of
`runControlledPipeline`:
```ts
stateStore.set('sessionId', deps.requestId.sessionId ?? 'default');
```
(requires passing `sessionId` through `TaskOrchestratorDeps` if not
already there; `deps.session.id` already exists in the handler context,
thread it in.)

## P2.4 Real `agent.resume` handler

File: `src/insrc/daemon/index.ts`

```ts
'agent.resume': async (params, channel, send, requestId) => {
  const { id } = params as { id: string };

  // 1. Locate checkpoint by session id (matches <controllerId>-<sessionId>.json).
  const checkpointDir = join(PATHS.insrc, 'checkpoints');
  const files = existsFs(checkpointDir)
    ? readdirSync(checkpointDir).filter(f => f.endsWith(`-${id}.json`))
    : [];
  if (files.length === 0) {
    return { ok: false, message: `No checkpoint for session ${id}` };
  }
  const raw = JSON.parse(readFs(join(checkpointDir, files[0]), 'utf-8'));
  const controllerId = raw.controller as string;

  // 2. Hand off to chat-handler's resume path with the prebuilt state.
  //    chat-handler wires up:
  //      - pre-seeded stateStore from raw.state
  //      - controller instance created via selectController(controllerId)
  //      - runControlledPipeline kicked off with a fake "just resumed" task
  //        that the controller's next() method interprets as "emit last gate"
  return await chatHandler.resumeFromCheckpoint({
    sessionId: id,
    controllerId,
    checkpointState: raw.state,
    deps: { channel, send, requestId },
  });
},
```

`chatHandler.resumeFromCheckpoint` (new):

```ts
async function resumeFromCheckpoint(args): Promise<unknown> {
  const store = createTaskStateStore();
  store.set('brainstormState', args.checkpointState);
  store.set('sessionId', args.sessionId);

  const controller = selectController(args.controllerId);
  // Controller.next() already restores state via store.get<BrainstormState>('brainstormState')
  // (base.ts:~211), so we just need to call it once to prime the flow.

  // Seed a no-op completed result so controller.next() runs and returns
  // the next task based on state.lastStep.
  const priming: TaskResult = {
    index: 0, description: 'Resumed',
    kind: 'transform', output: '', success: true,
  };
  const tasks = controller.next(priming, undefined, store);

  if (!tasks || tasks.length === 0) {
    // Nothing to resume (session was already done).
    args.deps.send({ id: args.deps.requestId, stream: 'done', data: { summary: 'session already complete' } });
    return { ok: true, resumed: false };
  }

  // Continue the pipeline with the restored state + next task set.
  await runControlledPipeline(controller, /*input=*/ {...}, {
    ...args.deps,
    stateStore: store,
    initialTasks: tasks,
  });
  return { ok: true, resumed: true };
}
```

**Key property:** on every brainstorm gate we restore the user to the
exact same pane + gate they were on before. The flow contribution in
the browser already maps gate kinds to panes; nothing new needed there.

## P2.5 Browser wiring

File: `src/vs/workbench/contrib/insrc/common/agentRunService.ts`
+ `electron-sandbox/agentRunServiceImpl.ts`

Today's `resumeRun(runId)` just calls `agent.resume`. It currently
relies on the daemon stub. When the daemon side becomes real, the RPC
will immediately start emitting gate events on the channel, which
`IInsrcChatService` already listens to (via its stream handle).

Required change: **after calling `agent.resume`, the browser must
re-hook the chat stream against this session id.** That's what
`chatService.resumeSession(id)` does today (loads history and subscribes
to future events). Update `agentRunServiceImpl.resumeRun` to call both:

```ts
async resumeRun(runId: string): Promise<void> {
  await this.daemonService.rpc('agent.resume', { id: runId });
  await this.chatService.resumeSession(runId);
}
```

The flow contribution listens to
`IInsrcBrainstormSessionService.onDidChangeActiveGate`, which fires
when the resumed pipeline re-emits its current gate. The matching pane
opens automatically.

## P2.6 GC

Option 1 (preferred, depends on P2.3): one file per session means GC
is just `agent.discard` on the specific id, or deletion on
`session.end`. No sweep needed.

Option 2 (if P2.3 is deferred): retention cap. In `checkpointState`:
```ts
const matching = readdirSync(dir)
  .filter(f => f.startsWith(`${controllerId}-`))
  .sort();
if (matching.length > 5) {
  for (const old of matching.slice(0, matching.length - 5)) {
    try { unlinkSync(join(dir, old)); } catch {}
  }
}
```

## P2.7 Session-end cleanup

Checkpoint deletion is triggered by three explicit signals:

1. **Successful `save`** on the presentation gate -- the artifact was
   written, session is complete. `afterPresentation` case `save`
   marks the session complete *only if* `saveArtifact` resolved without
   throwing; on error (decision H1) the checkpoint is retained so the
   user can retry.
2. **`skip`** on the presentation gate -- session abandoned
   intentionally. Same markSessionComplete path.
3. **User confirms "End Session"** via the brainstorm pane's close
   handler (decision F1). `BrainstormStepInputBase.closeHandler.confirm`
   currently calls `chatService.closeSession()`; extend the close path
   to also call `agent.discard(sessionId)` so the checkpoint file is
   removed.

Implementation: the controller needs a way to signal "delete
checkpoint" to the orchestrator, since the controller doesn't own the
file directly. Add `store.markSessionComplete()` (sets a flag read by
`runControlledPipeline`'s exit path, which unlinks the checkpoint
before returning).

```ts
// base.ts -> afterPresentation
case 'save':
  try {
    await saveArtifact(cfg);
    store.markSessionComplete();          // H1: only on success
    return null;
  } catch (err) {
    this.state.recentFeedback = `Save failed: ${err.message}`;
    // Return the presentation gate again so the user can retry.
    return [this.buildPresentationTask()];
  }
case 'skip':
  store.markSessionComplete();
  return null;
```

Browser close-pane flow:
```ts
// BrainstormStepInputBase.closeHandler.confirm:
if (!confirmed) return ConfirmResult.CANCEL;
try {
  await this._chatService.cancelStream();
  await this._daemonService.rpc('agent.discard', { id: this.sessionId });  // F1
  await this._chatService.closeSession();
} catch { /* best effort */ }
return ConfirmResult.DONT_SAVE;
```

## P2.8 Edge cases

### Resume into a dead gate
User closed the pane long ago; last gate is stale. Controller re-emits
it anyway -- browser opens the pane -- user sees the same card and can
proceed. This is fine.

### Resume into a mid-LLM-task state (decision G2)
Controller's `lastStep` is something like `converge-cluster` and no
gate was checkpointed -- the daemon was killed while an LLM call was
in flight. Per decision G2, we surface this explicitly rather than
silently retry.

Implementation: during resume, after loading the checkpoint, inspect
`state.lastStep`. Classify it:
- **Gate-emitting step** (`idea-review`, `idea-list`, `idea-discuss`,
  `validate-convergence`, `theme-spec-review`, `presentation`): rebuild
  and re-emit the corresponding gate task. Normal flow continues.
- **In-flight step** (everything else: `search-context`, `generate-ideas`,
  `review-ideas`, `refine-ideas`, `converge-cluster`, `converge-promote`,
  `search-theme-context`, `generate-theme-spec`, `review-theme-spec`,
  `assemble-spec`, `finalize`, `idea-diverge-single`,
  `idea-discuss-search`, `idea-discuss-respond`, `enhance-ideas-*`):
  **do not auto-run**. Emit a resume-confirm gate instead.

New gate kind: `resume-confirm` with `structured.phase = 'resume'`,
`itemType = 'resume-confirm'`, context carrying the last known step and
a short human-readable description ("We were clustering themes when the
session stopped."). Actions:
- `retry` -- re-run the in-flight step.
- `abandon` -- discard the checkpoint, end the session.

New browser pane: `BrainstormResumePane` that renders the resume-confirm
gate with a human-readable "Session paused at: <step description>"
message and two buttons. Routes via the flow contribution like any other
gate kind.

The pane widget is small -- text + two buttons + a progress summary
pulled from `state.ideas` / `state.themes` so the user sees what's
already been captured before deciding.

### Resume when daemon restarted on a new commit (decision I2)
Per decision I2, schema drift refuses rehydration rather than limping
along. Implementation: the checkpoint file carries a schema version
tag, bumped whenever the state shape changes materially.

1. Add a top-level `schemaVersion: 1` field to `checkpointState`
   output. Start from 1; bump to 2 on any `BrainstormState` breaking
   change.
2. On resume, compare the checkpoint's `schemaVersion` to the current
   daemon's. If mismatch, **refuse the resume**: return
   ```
   { ok: false, reason: 'schema-drift', message: 'This session was saved
     by an older daemon and can no longer be resumed. Discard?' }
   ```
3. The browser's Runs sidebar surfaces this message inline and offers
   "Discard" (calls `agent.discard`) as the only action. No best-effort
   rehydrate path.

Also validate: if the checkpoint references a `lastStep` value that
`dispatch()` no longer knows, treat it as schema drift and refuse
equivalently.

### Concurrent resume attempts
The daemon currently has no session locking; two concurrent resumes
would race on the checkpoint file. Out of scope for this plan; note it.

## P2.9 Ordered change list (Phase 2)

1. **task.ts**: thread `sessionId` into the state store; change
   `checkpointState` filename to `<controllerId>-<sessionId>.json`;
   stamp `schemaVersion: 1` at the top level of every checkpoint.
2. **task.ts**: add `stateStore.markSessionComplete()` and have
   `runControlledPipeline` unlink the checkpoint file on pipeline
   exit when the flag is set.
3. **daemon/index.ts**: implement real `agent.resume`:
   - Load checkpoint, validate `schemaVersion` (decision I2 -- refuse
     with `{ ok: false, reason: 'schema-drift', message: ... }` on
     mismatch).
   - Classify `state.lastStep` as gate-emitting or in-flight. If
     in-flight (decision G2), hand off to chat-handler with a
     request to emit a `resume-confirm` gate rather than auto-run.
4. **chat-handler.ts**: add `resumeFromCheckpoint` helper. Two paths:
   - gate-emitting step: seed the store, call `controller.next()`
     with a priming result to get the next task list, run the
     pipeline -- normal flow reopens the pane.
   - in-flight step: build a synthetic `resume-confirm` gate task
     and run a single-task pipeline to emit it.
5. **new gate**: define `resume-confirm` gate shape (phase='resume',
   itemType='resume-confirm', actions=['retry','abandon'], context
   carrying `lastStep` + human description).
6. **new browser pane**: `BrainstormResumePane` that renders the
   resume-confirm gate (step label, progress summary, retry + abandon
   buttons). Register input + pane, wire into flow contribution.
7. **base.ts `afterPresentation`**:
   - `save`: on success call `store.markSessionComplete()`; on
     failure (decision H1) return `[buildPresentationTask()]` so the
     user retries, keeping the checkpoint.
   - `skip`: call `store.markSessionComplete()`.
8. **base.ts `afterResumeConfirm`** (new handler for `resume-confirm`):
   - `retry` -> rebuild the in-flight task via a small lookup table
     keyed on `lastStep` and re-queue it.
   - `abandon` -> `store.markSessionComplete()` + return null.
9. **BrainstormStepInputBase.closeHandler** (browser): on confirmed
   end-session, call `daemonService.rpc('agent.discard', { id: sessionId })`
   before closing so the checkpoint is deleted (decision F1).
10. **agentRunServiceImpl.resumeRun** (browser): after `agent.resume`,
    call `chatService.resumeSession(id)` so the stream is re-hooked.
11. Optional: old-checkpoint-retention cap in `checkpointState` as a
    fallback if per-session-file rollout is staged separately.

## P2.10 Verification (Phase 2)

1. **Gate-checkpoint resume.** Start a brainstorm, review 3 ideas,
   kill the daemon mid-gate (while a card is on screen). Restart.
   Runs sidebar lists the session. Click Resume -> IdeasPane (or
   matching pane) reopens with the same card and progress counts.
2. **In-flight resume (G2).** Kill the daemon while a non-gate step
   is running (e.g. `converge-cluster`). Restart. Runs sidebar lists
   the session. Click Resume -> `BrainstormResumePane` opens with
   "Session paused at: clustering themes" and two buttons. Click
   Retry -> the step re-runs and the flow continues. Click Abandon
   -> checkpoint deleted, session ends.
3. **End-session delete (F1).** Mid-session, close the pane via the
   close-handler confirmation. Runs sidebar should NOT list the
   session afterward.
4. **Save retry (H1).** On the presentation gate, make save fail
   (e.g. unwritable path). The presentation gate should re-emit
   (with an error hint in `recentFeedback`). Checkpoint should
   still be present. Retry save with a valid path -> success deletes
   the checkpoint.
5. **Schema-drift refusal (I2).** Manually bump `schemaVersion` in a
   saved checkpoint to a higher number than the daemon knows. Try
   Resume -> Runs sidebar shows a schema-drift message with
   "Discard" as the only available action. Clicking Discard deletes
   the checkpoint.
6. **Mid-discussion resume.** Kill the daemon while `IdeaChatPane`
   is open with a visible discussion history. Resume -> pane
   reopens and `gate.extra.messages` must contain every prior
   turn (from `state.discussionMessages`).
