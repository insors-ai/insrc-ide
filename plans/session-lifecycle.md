# Plan: Session Lifecycle Refactor

Consolidates session creation, persistence, resume, and discard into
one clean flow. Today we have a cascade of fragile fallbacks accreted
during Item 7's live testing -- each patch working around the fact
that sessions aren't first-class entities with persisted metadata.
Rip out the fallbacks, make session metadata authoritative from
create-time onward, and add an explicit discard that purges every
byte a session left behind.

Related plans:
- [brainstorm/pending-fixes.md Item 7](brainstorm/pending-fixes.md) --
  session resume plumbing. Marked DONE but this plan supersedes the
  fallback chain that shipped.
- [chat-implementation.md](chat-implementation.md) -- original chat
  RPC surface; session DB schema is defined there.

## Status

| Phase | Scope                                    | Status |
|-------|------------------------------------------|--------|
| 1     | Atomic DB persistence on chat.start      | **DONE** (commit `a872e1d4682`) |
| 2     | agent.list reads from DB                 | **DONE** (commit `d40e17c82b7`) |
| 3     | chat.resumeFromCheckpoint DB+checkpoint join | **DONE** (commit `d40e17c82b7`) |
| 4     | agent.discard full purge                 | **DONE** (commit `d40e17c82b7`) |
| 5     | Trash button on Runs sidebar             | **DONE** (commit `d40e17c82b7`) |
| 6     | Remove Item 7 stopgap code               | **DONE** (absorbed into Phase 3) |

All six phases shipped. Legacy checkpoints (pre-Phase-1, no DB row)
error cleanly on resume with a "Discard to clean up" message; the
user runs Discard from the sidebar trash button and moves on.

---

## Goals

1. **Atomic session creation.** `chat.start` persists a complete
   session row to Kuzu *before* returning. The row includes: id,
   repo, agent, category (optional), status, createdAt, lastActivity.
   No downstream path ever needs a fallback to reconstruct repo.
2. **Single source of truth for session metadata.** The Kuzu
   `sessions` table owns the identity + repo + agent. The checkpoint
   file owns the ephemeral pipeline state. Neither tries to store
   both.
3. **Resume is a pure join.** `agent.resume` reads the DB row for
   metadata, opens the checkpoint for state, returns both. No
   `restoreOrCreate`, no RPC `repoPath` hints, no browser-side
   `_activeRepo` fallback.
4. **Delete is a one-shot.** A new user-visible affordance ("Discard
   Run") removes the DB row, turns, summary, checkpoint, and any
   in-memory session from the pool. Nothing left to accumulate.
5. **Restart-safe.** A fresh daemon enumerates sessions from the DB
   (not the checkpoint directory). Sessions without checkpoints
   appear as `status: 'completed'`; with checkpoints, `'paused'`;
   with a never-ended stream, `'active'` (resumed or not).

---

## Current state audit

### What exists today

**Session creation** ([chat-sessions.ts](../src/insrc/daemon/chat-sessions.ts)):
- `pool.create(repoPath)` generates a UUID, builds a `Session` object,
  adds to in-memory map. **Does not write to DB.**
- `pool.restore(sessionId)` reads Kuzu `sessions` row + turns for
  history rehydration. Requires a pre-existing DB row.
- `pool.restoreOrCreate(sessionId, fallbackRepoPath)` (added during
  Item 7 live testing) -- falls back to creating a fresh Session
  when the DB row is missing. **Stopgap. Delete after this refactor.**

**Session DB persistence** ([db/conversations.ts](../src/insrc/db/conversations.ts)):
- `saveSession({ id, repo, summary }, vector?)` upserts the
  `sessions` table row. Called:
  - Only when a turn completes with enough content to generate a
    summary (see `persistTurn` in chat-handler).
  - So a brainstorm that opens, generates a checkpoint, and never
    finishes a turn leaves **no DB row**.
- `saveTurn(turn)` writes each user/assistant turn.
- `getSessionById(db, id)` reads the row.

**Checkpoint persistence** ([daemon/task.ts](../src/insrc/daemon/task.ts)):
- `checkpointState(controllerId, stateStore, results, sessionId?)`
  writes `~/.insrc/checkpoints/<controller>-<sessionId>.json`. Called
  after any task with `persisted: true` completes. Captures
  `stateStore.snapshot()` plus a schema version, controller id,
  session id, timestamp.
- Schema version is checked on resume (decision I2, Item 7).
- No DB involvement.

**Resume** ([daemon/index.ts `agent.resume`](../src/insrc/daemon/index.ts#L273)
+ [chat-handler.ts `chatResumeFromCheckpoint`](../src/insrc/daemon/chat-handler.ts)):
- `agent.resume` validates schema, returns `{ sessionId, controllerId }`.
- `chat.resumeFromCheckpoint` then:
  1. Parses the checkpoint.
  2. Tries `pool.restoreOrCreate(sessionId, hintedRepoPath)` with
     three sources of `hintedRepoPath`:
     - `brainstormState.input.repoPath` (currently hardcoded empty
       in `initState` until the yet-unshipped fix lands).
     - RPC `repoPath` param from browser.
     - Browser's `this._activeRepo` (cleared on stream-error, so
       often empty after IDE restart).
  3. Picks the brainstorm subclass from `state.category`.
  4. Seeds the store, calls `controller.buildResumeTask()`.
  5. Runs the pipeline.

**Discard** ([daemon/index.ts `agent.discard`](../src/insrc/daemon/index.ts#L316)):
- Matches `-${id}.json` checkpoint files, unlinks them.
- **Does not touch** Kuzu sessions, turns, summaries, or the
  in-memory pool entry.
- User has no affordance to trigger this beyond the pane-close
  dialog (which also has F1 semantics muddled with teardown).

**Agent list** ([daemon/index.ts `agent.list`](../src/insrc/daemon/index.ts#L217)):
- **Reads the checkpoint directory, not the DB.** A session that has
  a DB row but no checkpoint is invisible to the Runs sidebar.
- Extracts metadata from the checkpoint body with a bunch of nested
  gymnastics (`raw.state.brainstormState.input.repoPath` etc.). If
  `initState` hardcoded empty, the repo comes back empty.

**Browser** ([chatServiceImpl.ts](../src/vs/workbench/contrib/insrc/electron-sandbox/chatServiceImpl.ts)):
- `startSession(repoPath)` → RPC `chat.start` → sets `_activeSessionId`
  + `_activeRepo`, persists via `storageService`.
- `resumeSession(sessionId)` → RPC `chat.restore` → sets state.
- `resumeFromCheckpoint(sessionId, repoPath)` (Item 7) → falls back
  to `_activeRepo` if empty → opens `chat.resumeFromCheckpoint`
  stream.
- `cancelBrainstormSession(reason, opts?)` (Item 25 + Item 7) →
  clears `_activeRepo` unconditionally even on stream-error.

### Problems

**P1. Sessions are lazy DB citizens.** A session's DB row only
appears after `persistTurn` runs (typically after the first turn
completes). Brainstorms that never complete a turn are invisible to
any code path that joins through Kuzu.

**P2. Repo is stamped in three places, none reliable.**
- `session.repoPath` (on the in-memory Session) -- ephemeral.
- `brainstormState.input.repoPath` (checkpoint body) -- hardcoded
  empty today.
- Kuzu `sessions.repo` -- missing for lazy sessions.

Each site is broken for at least one real flow, so we accreted the
restoreOrCreate + fallback chain to paper over the gap.

**P3. `agent.list` ignores the DB.** The Runs sidebar shows one row
per checkpoint file. A session with a DB row + turns but no live
checkpoint (e.g. completed cleanly, then finalize wrote the last
checkpoint, then the pipeline's session-end cleanup unlinked the
file) disappears from the list entirely. The same session may still
be resumable via history.

**P4. Discard is surgical-but-shallow.** `agent.discard` deletes
only the checkpoint. Kuzu `sessions`, `turns`, and `summaries`
survive. Over time every torn-down session leaves zombie rows.

**P5. Stream-error teardown wipes the repo.** `cancelBrainstormSession`
clears `_activeRepo` even when the user wasn't the one ending the
session. Next IDE start has no memory of the repo -- breaking the
last-ditch resume fallback.

**P6. initState hardcodes `repoPath: ''`.** Direct bug, compounding
P2.

### What Item 7 shipped (now considered stopgap)

- `pool.restoreOrCreate(sessionId, fallback)` -- delete.
- `chat.resumeFromCheckpoint` RPC `repoPath` param -- delete.
- Browser `this._activeRepo` fallback in `resumeFromCheckpoint` --
  delete.
- The fallback chain at all three layers is symptomatic of P1/P2.
  After this refactor the Kuzu row is authoritative and no fallback
  is necessary.

What Item 7 shipped that stays:

- schemaVersion-stamped checkpoints + I2 drift refusal.
- `buildResumeTask()` / `afterResumeConfirm` / resume-confirm gate /
  in-flight vs gate-emitting step classification.
- Per-gate-task `persisted: true` flags.
- Per-session checkpoint filename.
- `Session.id` == `ActiveSession.id` synchronisation.

---

## Design

### Kuzu sessions table: required columns

Today's schema (see [db/schema.ts](../src/insrc/db/schema.ts)):
```
id: STRING (PK)
repo: STRING
summary: STRING
seenEntities: STRING
createdAt: STRING
expiresAt: STRING
vector: FLOAT[]
```

Add:
- `agent: STRING` -- controller id (`brainstorm`, `designer`,
  `planner`, ...). Default `'chat'` when `chat.start` is called
  without an intent hint.
- `category: STRING` -- sub-category (`design`, `requirements`,
  etc.) for agents that have them. Empty for others.
- `status: STRING` -- `active` | `paused` | `completed` |
  `discarded`. Default `active` at create; updated by pipeline
  transitions.
- `lastActivityAt: STRING` -- ISO. Bumped on each checkpoint write.

Migration: new columns are nullable / default-empty so existing
rows keep working. Schema diff applied lazily on next
`initDb` call (same pattern as other schema evolutions).

### chat.start: atomic create-and-persist

Replace [pool.create](../src/insrc/daemon/chat-sessions.ts#L80)'s
no-DB path with:

```ts
async create(repoPath: string, opts?: { agent?: string; category?: string }): Promise<string> {
  const sessionId = randomUUID();
  const config = await loadConfigForRepo(repoPath);
  const session = new Session({ repoPath, config, id: sessionId });
  await session.init();

  // Persist the session row immediately so downstream resumes / lists
  // have a reliable source of metadata. Status starts as 'active';
  // the pipeline will flip it to 'paused' on checkpoint or 'completed'
  // on finalize.
  const db = await getDb();
  await saveSession(db, {
    id: sessionId,
    repo: repoPath,
    summary: '',
    agent: opts?.agent ?? 'chat',
    category: opts?.category ?? '',
    status: 'active',
    lastActivityAt: new Date().toISOString(),
  });

  // Pool entry as before.
  const active: ActiveSession = { ... };
  this.sessions.set(sessionId, active);
  return sessionId;
}
```

**Why agent/category at create time?** Two reasons:
- Runs sidebar can group/render without reading the checkpoint.
- Brainstorm sub-controllers are picked by category; the DB row
  tells resume which subclass to instantiate without reading state.

The current flow doesn't actually know `agent` at start -- the
classifier runs mid-turn. Options:
- **Option A (simpler):** call chat.start with `agent: 'chat'`;
  update the row via a new `session.setAgent(id, agent, category)`
  call from the classifier / controller dispatch path.
- **Option B (cleaner):** restructure the flow so classification
  happens before session "activates" as a specific agent -- the
  chat panel stays generic until the intent is confirmed, then
  the session's row gets agent/category stamped. This is a bigger
  change.

Start with A. Re-evaluate after Phase 1.

### Checkpoint: keep state, drop metadata

Checkpoint body stays: schemaVersion, controller, sessionId, state,
results, timestamp. The existing `saveSession` + new
`setAgent` / `setStatus` calls carry all the metadata; the
checkpoint is pure state.

Consequence: `agent.list` reads the DB (not the checkpoint dir)
for the list; the checkpoint merely serves as "paused" state
evidence (file present) vs "completed" (file absent).

### chat.resumeFromCheckpoint: pure join

```ts
export const chatResumeFromCheckpoint: StreamHandler = async (params, send, signal) => {
  const { sessionId } = params as { sessionId: string };

  // 1. Pull session metadata from DB -- single authoritative source.
  const db = await getDb();
  const row = await getSessionById(db, sessionId);
  if (!row) {
    emitError(`Session ${sessionId} not in DB -- may be a pre-refactor checkpoint; use Discard`);
    return;
  }

  // 2. Restore the in-memory Session. No fallback needed -- DB has repo.
  const pool = getPool();
  if (!pool.get(sessionId)) await pool.restore(sessionId);
  const active = pool.get(sessionId)!;

  // 3. Load checkpoint (for state snapshot). May be absent for
  //    completed sessions -- in which case, nothing to resume.
  const checkpoint = await loadCheckpoint(row.agent, sessionId);
  if (!checkpoint) {
    emitMessage('Session already complete -- nothing to resume.');
    return;
  }
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    emitError('schema-drift: discard the run and start fresh');
    return;
  }

  // 4. Pick the controller subclass from row.agent + row.category.
  const controller = await resolveControllerForResume(row, active.session);

  // 5. Seed store, rehydrate, kick off pipeline.
  const stateStore = createTaskStateStore(checkpoint.state);
  controller.restoreState(stateStore);
  const resumeTask = controller.buildResumeTask();

  emitIntentProgress(row.agent, row.category);
  await runControlledPipeline(controller, stubInput(active), {
    ..deps,
    stateStore,
    initialTasks: [resumeTask],
  });
};
```

No `restoreOrCreate`, no `repoPath` hint, no fallback chain. If
the DB row is missing, the session is unresumable -- the user
sees a "Discard" action in the Runs sidebar and moves on.

### chat.start: agent stamp path

Two stamping call sites:

1. **Immediate stamp** in `chat.start` when the user starts a new
   chat (`agent='chat'`).
2. **Classifier stamp** after `resolveController` picks a brainstorm
   subclass. New helper:
   ```ts
   await setSessionAgent(db, sessionId, 'brainstorm', category);
   ```
   Called from `resolveController` once the category is known.

### agent.list: read from DB

Replace today's checkpoint-dir enumeration with a DB query:

```ts
'agent.list': async () => {
  const db = await getDb();
  const sessions = await listSessions(db, { statuses: ['active', 'paused'] });
  const out: AgentRunInfo[] = [];
  for (const s of sessions) {
    const hasCheckpoint = await checkpointExists(s.agent, s.id);
    out.push({
      id: s.id,
      agent: s.agent || 'unknown',
      status: hasCheckpoint ? 'paused' : 'active',
      repo: s.repo,
      step: hasCheckpoint ? (await peekCheckpointStep(s.agent, s.id)) : undefined,
      createdAt: s.createdAt,
      ...(s.summary ? { summary: s.summary } : {}),
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
},
```

`peekCheckpointStep` loads only `state.brainstormState.lastStep`
(one grep, not the full JSON parse) so the sidebar renders fast
even with many sessions.

### agent.discard: full purge

```ts
'agent.discard': async (params) => {
  const { id } = params as { id: string };
  const db = await getDb();

  // 1. Checkpoint file.
  await deleteCheckpoint(id);

  // 2. Kuzu row + turns + summary.
  await deleteSession(db, id);       // new helper: rm sessions row + turns
  // (turns go via same transaction; seen in db/conversations.ts)

  // 3. In-memory pool entry, if the daemon has it active.
  const pool = getPool();
  pool.drop(id);                     // new method: close channel, remove from map

  // 4. Mark status (in case UI is cached briefly).
  return { ok: true, deleted: 1 };
},
```

### Browser: resume is simple

```ts
async resumeFromCheckpoint(sessionId: string): Promise<void> {
  if (!this.daemonService.isConnected) throw new Error('Not connected');
  if (this._isStreaming) throw new Error('Already streaming');

  // The daemon's handler reads all the metadata from the DB -- we
  // don't need to hint repo at all.
  this._activeSessionId = sessionId;
  this._messages = await this.loadHistory(sessionId);
  // _activeRepo is populated by chat.restore when the stream opens,
  // or via a small sync RPC -- no storage fallback needed.
  this._persistState();
  this._onDidChangeSession.fire(sessionId);

  this._isStreaming = true;
  this._pendingContent = '';
  this._streamHandle = this.daemonService.stream('chat.resumeFromCheckpoint', { sessionId });
  this._wireStreamHandle(this._streamHandle);
}
```

Delete `effectiveRepo` logic. Delete `chat.restore` priming. The
daemon is authoritative; the browser trusts it.

### cancelBrainstormSession: stop wiping _activeRepo on stream-error

Only clear `_activeRepo` when `opts.discardCheckpoint === true`
(user explicitly ended). Stream-error keeps the repo so the user
can reopen the IDE and resume.

Even better: after this refactor, `_activeRepo` is no longer
required for resume at all -- remove it as a cross-session
persisted field entirely. Keep it only as in-memory current-repo
tracking.

### Runs sidebar: discard affordance

Add a second inline button next to the play button on each row:
a trash icon that calls `agentRunService.discardRun(id)` after
a confirm dialog. Dialog text:

> **Discard run {id}?**
> This permanently deletes the session's history, checkpoint, and
> any notes. The run will disappear from this sidebar and cannot
> be recovered.
> [Cancel] [Discard]

---

## Migration plan

### Phase 1: atomic session persistence

1. `db/schema.ts`: add columns `agent`, `category`, `status`,
   `lastActivityAt` to the `sessions` table definition.
2. `db/conversations.ts`: extend `saveSession` to take the new
   fields; add `setSessionAgent(id, agent, category)` +
   `setSessionStatus(id, status)` + `bumpLastActivity(id)` helpers.
3. `daemon/chat-sessions.ts::pool.create`: write a DB row
   immediately on session creation (`agent: 'chat'`, status
   `active`).
4. `daemon/task.ts::resolveController` (brainstorm branch):
   after category classification, call
   `setSessionAgent(sessionId, 'brainstorm', category)`.
5. `daemon/task.ts::checkpointState`: after writing the checkpoint,
   call `bumpLastActivity` + `setSessionStatus(id, 'paused')`.
6. `daemon/task.ts::runControlledPipeline` end: on clean exit with
   `isSessionComplete()`, call `setSessionStatus(id, 'completed')`.
7. Existing rows without the new columns get sensible defaults
   (Kuzu's nullable-column behaviour).

**Ship and test:** start a brainstorm -> confirm DB has a row
immediately with agent/category/status. Close IDE -> DB status
is `paused`. Reopen -> row visible via `agent.list` DB query.

### Phase 2: agent.list via DB

1. Replace `agent.list` body with a DB query over sessions
   (filter `statuses in ['active', 'paused']`).
2. Join: checkpoint existence + peek-at-lastStep. Return current
   `AgentRunInfo` shape.
3. Verify the Runs sidebar renders the same entries as Phase 1,
   now sourced from DB.

### Phase 3: chat.resumeFromCheckpoint via DB

1. Rewrite the handler to read `getSessionById(db, sessionId)`
   first; the DB row is authoritative for repo / agent / category.
2. Remove `pool.restoreOrCreate`, `hintedRepoPath` RPC param,
   browser-side `effectiveRepo` fallback.
3. Remove `initState`'s hardcoded `repoPath: ''` -- pull from
   `input.session?.repoPath`, which is now reliably populated
   since sessions always have a Session object with the right
   repoPath.
4. Browser: `cancelBrainstormSession` only clears `_activeRepo`
   when `discardCheckpoint: true`.
5. Verify: cold daemon, cold IDE, click Resume -> pane opens.

### Phase 4: agent.discard full purge

1. Daemon: `agent.discard` additionally removes the Kuzu session
   row + turns + summary, and calls `pool.drop(id)` to evict any
   in-memory entry.
2. Browser: new `discardRun` wiring already exists via
   `agentRunService.discardRun`; ensure the inline trash button
   on Runs sidebar rows calls it with a confirm dialog.
3. Verify: discard a session -> Kuzu row gone, checkpoint gone,
   session not in `agent.list`.

### Phase 5: Legacy checkpoint handling

A small migration to deal with the pre-refactor checkpoints
sitting in `~/.insrc/checkpoints/` (like the `3466c2dd-...` file
we've been smoke-testing):

- On daemon start, scan the checkpoint dir. For any file whose
  `sessionId` is not in the Kuzu `sessions` table, add a stub
  row: `id=<sessionId>`, `repo=?`, `agent=<file-prefix>`,
  `status='paused'`, `createdAt=<file.mtime>`. If `repo` can't
  be recovered (state doesn't have it), write empty string and
  mark the row with an additional flag `needsRepoPrompt: true`
  OR (simpler) just show it in Runs sidebar with "Discard only"
  semantics (play button greyed out, trash button active).
- OR: zero-effort path -- daemon on start logs the stale files
  and the user runs a one-shot CLI `insrc agent prune` to rm
  them. Document this in release notes; skip the migration.

Recommendation: **zero-effort path** for Phase 5. Pre-refactor
checkpoints are a one-time cohort; forcing a discard is
acceptable.

### Phase 6: remove stopgap code

Once Phases 1-4 are verified, delete:
- `pool.restoreOrCreate`.
- `chat.resumeFromCheckpoint` RPC `repoPath` param.
- Browser `effectiveRepo` fallback chain.
- Browser `chat.restore` prime call on resume path.
- `initState`'s empty-string `repoPath` hardcode.

Net removal: ~80 lines across 3 files.

---

## Verification

1. **Atomic create.** `chat.start` returns a sessionId; immediately
   `getSessionById(db, id)` returns a row with agent/repo/status.
2. **Agent stamp.** After category classification, the DB row has
   `agent='brainstorm'`, `category='design'`.
3. **Checkpoint bumps DB.** After each gate task completes, DB
   `lastActivityAt` is newer than before and `status='paused'`.
4. **Completion.** After presentation save-success, checkpoint
   deleted AND `status='completed'` in DB.
5. **Resume cold.** IDE close + daemon restart + click Resume ->
   pane reopens on the exact same card. Browser needs nothing
   beyond sessionId.
6. **Discard.** Click trash in Runs sidebar -> confirm -> DB row,
   turns, summary, checkpoint all gone; Runs sidebar updates.
7. **Legacy checkpoint.** Pre-refactor file in checkpoint dir is
   either migrated (if Phase 5 opts in) or cleaned via manual
   discard; no half-working resume attempts.
8. **Schema drift still refused.** Bump schemaVersion in a
   checkpoint -> resume returns "discard only" error path.

---

## Out of scope

- Exporting / importing sessions across machines.
- Non-brainstorm resume (designer / planner / tester) -- those
  agents don't yet write per-gate checkpoints. Cover them if the
  per-gate pattern generalises (likely -- but design per-agent
  before landing).
- Session archival / expiration beyond the existing 30-day TTL
  on `sessions.expiresAt`.
- Compression of old checkpoints.

---

## Risks

- **Kuzu schema migration** -- adding columns has worked before on
  this codebase but the migration path is untested at scale. If a
  column default isn't honoured by an older daemon, old rows
  become unreadable. Mitigation: add columns as nullable; read
  with `?? default` coalescing everywhere.
- **Classifier stamp timing** -- Option A (stamp post-classification)
  means a crash between `chat.start` and classification leaves
  `agent='chat'` on a row that was actually a brainstorm. Effect:
  Runs sidebar shows it as a generic chat; Resume won't know which
  controller to pick. Acceptable: user can Discard. If painful,
  fall through to Option B later.
- **Legacy checkpoint abandonment** -- Phase 5's "zero-effort"
  path means users with active pre-refactor brainstorms lose them.
  Mitigation: release-notes warning + provide `insrc agent prune`
  so they can clean up.

---

## Open questions

1. **Does `chat.start` deserve an `intent` hint?** Today the user
   types free-form; the classifier derives intent. If we want to
   start an explicit brainstorm without classification (e.g. from
   a "New Brainstorm" button), the hint would let us skip the
   classifier and pass `agent='brainstorm'` directly. Nice-to-have;
   file under future work.

2. **Who owns session status transitions?** Currently spread across
   the pipeline (`checkpointState` → `paused`, `markSessionComplete`
   → `completed`). Could centralise in a lifecycle service. Skip
   for now; inline is simple enough.

3. **Does discard need an "are you sure?" confirm?** Yes, per the
   Runs sidebar design above. Keep the dialog text clear that this
   is irreversible.
