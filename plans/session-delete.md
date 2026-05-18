# Session deletion -- full purge of all session-keyed data

**Status:** ready
**Owner:** subhagho@gmail.com
**Surfaced:** 2026-05-18, during the run #9 code-analyzer test (devstral + R.1 + S.1 + S.2).

---

## Goal

User can delete a chat session from the Sessions sidebar and have **every** byte of session-keyed data removed -- LMDB rows, LanceDB vectors, checkpoint files, temp-spill directories, todos, response segments, drill-down children. Plus a bulk delete on each time-window group ("Today", "Yesterday", "This week", "Older") in the sidebar.

The existing `agent.discard` RPC is the closest precedent but is scoped to **agent runs** (kills the pool entry + checkpoint files + LMDB cascade) and **does not touch any Lance table**. Today, all four vector tables (`session_vec`, `turn_vec`, `response_segment_vec`, `artifact_vec`) accumulate forever -- a slow leak that becomes a privacy problem when "delete" is presented as an option.

---

## Inventory: what gets created per session

Surveyed 2026-05-18 against the current codebase. Anything missing from this list leaves orphaned data after delete -- this is the contract the implementation must satisfy.

### LMDB sub-DBs (8 stores) -- [src/insrc/db/graph/store.ts](src/insrc/db/graph/store.ts)

| Sub-DB | Key | Value | Cleanup today |
|---|---|---|---|
| `conversation_session` | `sessionId` | `SessionRow` | `deleteSession()` in [db/conversations.ts](src/insrc/db/conversations.ts) |
| `conversation_turn` | `sessionId + u32 idx` | `TurnRow` | cascade in `deleteSession` |
| `conversation_turn_by_repo` | `repo + turnId` | (dupsort idx) | cascade |
| `todo_list` | `listId` | `TodoListRow` | `cleanupSessionTodos()` in [db/todos.ts](src/insrc/db/todos.ts) |
| `todo_list_by_session` | `sessionId + listId` | (dupsort idx) | cascade |
| `todo_item` | `itemId` | `TodoItemRow` | cascade |
| `todo_comment` | `itemId + commentId` | `TodoCommentRow` | cascade |
| *parent edges* (drill-down) | `parentListId` on `todo_list` | -- | needs recursive walk |

### LanceDB vector tables (4 stores) -- [src/insrc/db/lance/*.ts](src/insrc/db/lance/)

| Table | Filter cols available | Cleanup today |
|---|---|---|
| `session_vec` | `id = sessionId`, `repo`, `status` | **none** |
| `turn_vec` | `sessionId`, `id = sessionId:idx`, `tier`, `type` | **none** |
| `response_segment_vec` | `sessionId`, `turnId`, `segmentIdx` | **none** |
| `artifact_vec` | `session_id`, `intent`, `skill_id`, `path` | **none** |

Every one of these is a hard gap that this plan fixes.

### Filesystem artifacts -- [src/insrc/shared/paths.ts](src/insrc/shared/paths.ts)

| Path | Naming | Cleanup today |
|---|---|---|
| `~/.insrc/checkpoints/` | `${agentId}-${sessionId}.json` | `agent.discard` removes by suffix match |
| `~/.insrc/tmp/${sessionId}/` | report files, skill spills | documented as deferred (conversation-flow-refinement Phase 2) |
| `~/.insrc/tmp/code-analysis-report-<hash>.md` | abort placeholders | not session-keyed -- skip |

### IDE Sessions sidebar -- [src/vs/workbench/contrib/insrc/browser/sidebar/sessionsView.ts](src/vs/workbench/contrib/insrc/browser/sidebar/sessionsView.ts)

- Tree hierarchy: Root → Repo → DateGroup → Session → Turn
- Date grouping in `sessionsTreeNodes.ts` lines 79-95 -- `groupSessionsByDate()` produces `Today | Yesterday | This week | Older` based on `session.createdAt`
- Session row renderer at sessionsView.ts lines 47-101 -- accepts a click handler today; **no action affordances yet**
- Chat service surface: `IInsrcChatService` exposes `session.list` + `session.history` RPCs

---

## Locked decisions

1. **Single IPC RPC `session.delete`** -- not a reuse of `agent.discard`. The latter is agent-run-scoped; a chat session can outlive any single agent run, and the cascade is broader. `agent.discard` becomes a thin caller of the new path for the agent-run case.
2. **Lance cleanup is non-optional** -- the new RPC fails atomically if any of the 4 Lance deletes fail. No silent leaks.
3. **Bulk delete is a server-side loop, not a single transaction** -- per-session deletes are independent. Failing one mid-bulk leaves the rest deleted and reports a partial-success count back to the UI.
4. **Confirmation required for both per-session and bulk** -- VS Code-standard `INotificationService` confirm dialog. Bulk shows the count ("Delete 7 sessions in 'This week'?").
5. **Active session in the IDE is OK to delete** -- the delete switches the active session away first (load most-recent surviving or empty). Daemon kills any in-flight agent runs via pool drop.
6. **Strict sessionId scoping** -- delete only purges rows keyed to the selected `sessionId`. Drill-down children that live in a different session (e.g., user drilled down on Session X's report while Session Y was active -- the child got stamped with `sessionId: Y`) are **not** touched. The child keeps a dangling `parentListId` pointing at the deleted parent; the report-pane and todos-pane renderers must tolerate "parent not found" gracefully (treat as orphan / show as top-level).
7. **No undo** -- delete is destructive. Tombstones / soft-delete is out of scope; would double the schema surface.
8. **LanceDB compaction runs after every delete** -- Lance's `delete(predicate)` tombstones rows in the storage format; without a compact pass, disk usage grows even as the table's logical row count shrinks. Each per-session delete and each bulk delete ends with a `table.optimize()` (or equivalent) call across all 4 vector tables. Tomestone density stays bounded; disk reclaim is automatic.
9. **Bulk delete scope = the workspace's repo** -- the Sessions sidebar is organized by Repo → DateGroup → Session for a single workspace. Bulk delete on a DateGroup naturally targets sessions within that workspace + repo. No cross-workspace deletion path.

---

## Phase A -- Lance vector cleanup (foundation)

**Why first**: every higher-level path depends on this. No vector cleanup exists today.

### A.1 Per-table delete helpers

Add four functions, one per Lance table, that accept a `sessionId` and delete every row scoped to it. Reuses the existing `openOrCreateTable` helper from [db/lance/conn.ts](src/insrc/db/lance/conn.ts).

```ts
// db/lance/session-vec.ts
export async function deleteSessionVec(sessionId: string): Promise<number>;

// db/lance/turn-vec.ts (filter: sessionId)
export async function deleteTurnVecsForSession(sessionId: string): Promise<number>;

// db/lance/response-segment-vec.ts (filter: sessionId)
export async function deleteResponseSegmentVecsForSession(sessionId: string): Promise<number>;

// db/lance/artifact-vec.ts (filter: session_id)
export async function deleteArtifactVecsForSession(sessionId: string): Promise<number>;
```

LanceDB `Table.delete(predicate)` takes a SQL-style WHERE; each helper builds the right predicate (note the column-name difference: `sessionId` on three tables, `session_id` on artifact_vec). Returns count of deleted rows for telemetry.

### A.2 Orchestrator helper

Add `deleteSessionFromLance(sessionId)` in a new [db/lance/cleanup.ts](src/insrc/db/lance/cleanup.ts) that calls all four helpers in parallel + sums counts. Single entry point; callers don't have to know about the 4 tables.

### A.3 Compaction helper

Add `compactSessionVecTables()` in the same `cleanup.ts`. Calls `table.optimize()` (or LanceDB's current equivalent of compact-after-delete) on all 4 vector tables. Idempotent; cheap when no tombstones exist; called once at the END of a per-session OR bulk delete. Without this, Lance's storage grows even after logical row counts shrink, defeating the whole purpose of the delete affordance.

### A.4 Tests

Per-helper unit tests against an in-memory LanceDB instance. Insert sentinel rows for sessionA + sessionB, delete sessionA, assert sessionB rows survive + sessionA rows are gone.

---

## Phase B -- `session.delete` IPC RPC (single + bulk)

### B.1 Single-session delete

New handler in [daemon/index.ts](src/insrc/daemon/index.ts) IPC dispatcher. Shape:

```ts
// Request:  { method: 'session.delete', params: { sessionId: string } }
// Response: { deleted: true, counts: { ...per-store counts } }
```

Operations (in order, all best-effort but each failure logged):

1. **Drop from pool** -- `dropSessionFromPool(sessionId)`. Aborts any in-flight agent.
2. **Delete checkpoint files** -- existing pattern from `agent.discard`: `readdir(~/.insrc/checkpoints)` + filter `endsWith('-' + sessionId + '.json')` + unlink each.
3. **Delete in-session TodoLists** -- `cleanupSessionTodos(sessionId)` walks `todo_list_by_session` and removes every list (+ items + comments) whose `sessionId == X`. **No recursion across session boundaries.** Drill-down children that live in another session are left alone -- their `parentListId` will dangle, which the renderers must tolerate (see locked decision 6). A separate maintenance task can sweep dangling-parent lists later if it becomes a real problem; today it's a corner case (user opens a different session BEFORE drilling down).
4. **LMDB cascade** -- `deleteSession(db, sessionId)` (existing; handles `conversation_session` + `conversation_turn` + `conversation_turn_by_repo`).
5. **Lance cleanup** -- `deleteSessionFromLance(sessionId)` (Phase A.2).
6. **Tmp directory** -- `rm -rf ~/.insrc/tmp/${sessionId}/` if exists.
7. **Lance compaction** -- `compactSessionVecTables()` (Phase A.3). Reclaims tombstoned-row disk space; runs once at the end of the per-session path.

Return aggregated counts: `{ checkpoints, todoLists, todoItems, lmdbTurns, lanceSession, lanceTurns, lanceResponseSegments, lanceArtifacts, tmpFiles }`.

### B.2 Bulk delete

```ts
// Request:  { method: 'session.deleteBulk', params: { sessionIds: string[] } }
// Response: { deleted: number, failed: number, errors: { sessionId: string; reason: string }[] }
```

Server-side loop over `B.1` -- but with one optimisation: skip the per-session Lance compaction (step 7) on each iteration and do ONE compact pass at the end of the bulk. Compaction is the expensive part; running it N times is wasteful when one pass at the end achieves the same disk-reclaim with much less work. Per-session errors aggregate into the response.

### B.3 Refactor `agent.discard`

`agent.discard` currently does steps 1-4 of B.1 minus Lance + tmp dir. Make it a thin caller of the new session-delete path so we don't have two purge implementations diverging. The semantic shift (now also deletes vectors) is a small behavior change but matches user expectation -- discarding an agent run should not leave its embedding traces.

---

## Phase C -- IDE: per-session delete action

### C.1 Session row hover affordance

Modify [sessionsView.ts](src/vs/workbench/contrib/insrc/browser/sidebar/sessionsView.ts) `SessionRenderer` (lines 47-101 today) to render a trash-icon button. Default-hidden, visible on row hover (mirror the existing pattern used by other sidebar rows in this codebase if present; otherwise add a CSS rule with `:hover .action-button { visibility: visible }`).

Click handler:
1. Get session info from the renderer's row data (`session.id`, `session.summary` for the confirm message).
2. Show `notificationService.prompt`:
   - Severity: Warning
   - Message: `Delete session "<summary or 'Untitled'>"? This removes all turns, todos, reports, and embeddings.`
   - Choices: `[Delete, Cancel]`
3. On Delete: call new chat-service method `chatService.deleteSession(id)` which dispatches the `session.delete` RPC.
4. On success: the sessions tree refreshes automatically via the existing `onDidChangeSessions` event chain.
5. On failure: `notificationService.error(<reason>)`.

### C.2 Active session handling

If the deleted session is the user's currently-active session in the chat panel:
- Before the RPC: pick a successor (most-recent session that isn't the one being deleted; otherwise empty state).
- After the RPC: load the successor via `chatService.activateSession(successorId)`, or clear the chat panel if there's none.

### C.3 Chat service surface

Extend `IInsrcChatService` with:
```ts
deleteSession(id: string): Promise<void>;
deleteSessionsBulk(ids: readonly string[]): Promise<{ deleted: number; failed: number }>;
```
The IPC client wraps the new RPCs.

---

## Phase D -- IDE: per-time-window-group delete action

### D.1 DateGroup renderer affordance

[sessionsView.ts](src/vs/workbench/contrib/insrc/browser/sidebar/sessionsView.ts) `DateGroupRenderer` (today around line 47) gets the same trash-icon treatment. Row data is a `DateGroupNode` which already knows the set of `SessionInfo` objects under it (from `sessionsTreeNodes.ts:groupSessionsByDate`).

Click handler:
1. Compute the list of session IDs in the group.
2. Show `notificationService.prompt`:
   - Severity: Warning
   - Message: `Delete all 7 sessions in "This week"? This removes all turns, todos, reports, and embeddings.` (count comes from the group)
   - Choices: `[Delete all, Cancel]`
3. On Delete: call `chatService.deleteSessionsBulk(ids)`.
4. Success message via `notificationService.info`: `Deleted N sessions in "This week" (M failed)`.
5. Tree refreshes automatically.

### D.2 Edge cases

- Empty group -- the affordance shouldn't appear (no sessions to delete).
- Active session in the group -- handled by C.2 logic (pick successor before the bulk runs).
- Drill-down children in OTHER sessions -- per locked decision 6, not touched. The bulk delete is just a loop over per-session deletes; each per-session delete is sessionId-scoped.

---

## Phase E -- Tests + telemetry

### E.1 Daemon-side tests

Unit tests in `src/insrc/daemon/__tests__/session-delete.test.ts`:

1. Seed: one session with 3 turns, 2 todo lists (one with a drill-down child), 5 response-segment vectors, 1 artifact vector, 1 checkpoint file, a tmp dir with 2 files.
2. Call `session.delete`.
3. Assert: all 6 stores are empty / file removed, counts match.
4. Repeat with a second session present -- assert that session's data is untouched.

Bulk test:

5. 3 sessions seeded; call `session.deleteBulk` with a list containing one nonexistent id; assert 2 deleted, 1 failed, the surviving sessions are untouched, errors list contains the bad id.

### E.2 IDE-side tests

Renderer test: confirm the trash button appears on hover for session rows + date-group rows, has accessible label, and dispatches the right command on click. Use the existing renderer-test pattern in `sessionsView.test.ts` if it exists, otherwise add it.

### E.3 Telemetry

Log lines in the daemon (existing `getLogger('session-delete')` -- new logger):

- `session.delete: starting` (sessionId)
- `session.delete: complete` (sessionId, counts, durationMs)
- `session.delete: failed` (sessionId, error, durationMs)
- `session.deleteBulk: complete` (count, deleted, failed, durationMs)

No analytics events surfaced to the user; this is purely operational.

---

## Open questions

1. **Dangling `parentListId` cleanup sweep?** Locked decision 6 leaves cross-session drill-down children with a dangling parent reference. A future maintenance task could sweep these up periodically (or surface them as "orphaned" in the todos pane). Not blocking; revisit if it surfaces in real usage.

---

## Rollout

- **Phase A**: ship Lance cleanup helpers + tests. Independently useful (callable from a future repo-purge path). 1 PR.
- **Phase B**: ship `session.delete` + `session.deleteBulk` RPCs + agent.discard refactor. 1 PR. Smoke-test by hand against a dev daemon.
- **Phase C + D + E**: ship UI affordances + tests together. 1 PR. The bulk and per-session affordances share most of the code; splitting them would just churn.

Estimated work: ~600-900 lines (4 Lance helpers + cleanup orchestrator + 2 RPCs + 2 UI renderer changes + chat-service plumbing + tests). Minimal new abstractions; mostly wiring existing helpers together.

---

## Out of scope

- Soft delete / tombstoning / restore.
- Time-based auto-expiry (e.g., "delete sessions older than 30 days"). Adjacent but a different feature.
- Export-before-delete affordance.
- Selective delete (keep some turns, drop others). Sessions are atomic.
- Cleanup of orphaned cross-session drill-down children (see open question 1).

## Required side-work

- **Renderer tolerance for dangling `parentListId`** -- the report pane and todos pane need to gracefully handle a TodoList whose `parentListId` references a list that no longer exists (parent was deleted). Today both panes likely assume the parent is resolvable. Audit the resolution code paths and add a fallback (treat as orphan / hide the parent-link badge). Small but real -- ship it in the same PR as Phase B so the user-visible state is consistent the moment delete becomes available.
