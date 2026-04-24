# Plan: Session-Scoped TODO Framework

A first-class TODO primitive that rides on top of chat sessions. Every
session can own zero or more TODO lists; every list owns an ordered
sequence of items. Agent families (implementation, brainstorm, designer,
planner, tester, research, debugging, deployment, ...) can create and
mutate lists, the user can view them in the UI, and both sides see the
same state because it's persisted on the session row, not scattered
across agent-specific state blobs.

Today each agent invents its own progress bookkeeping (delegate plan
steps, brainstorm review queues, designer validate gates, etc.). None
of it is uniformly visible to the user, resumable across daemon
restarts, or reusable by the next agent in a handoff chain. This plan
unifies that pattern into one framework the agents consume.

## Related plans

- [session-lifecycle.md](session-lifecycle.md) -- defines the session
  row this framework attaches to.
- [prompt-notepad.md](prompt-notepad.md) -- user's surface for
  composing prompts **and for creating / editing user-owned TODO
  lists** (Phase 9). The notepad writes to the same todo tables
  the agents do; lists with `owner === 'user'` render in the
  notepad, lists with any other owner render in the todos pane.
  Agents never see user-owned lists in their reads -- the user
  must explicitly `transfer` a list or `forwardToAgent` snapshots
  to bring them into agent view. Phase 8 consolidates the shared
  pane-infra between the two surfaces.
- [brainstorm/pending-fixes.md](brainstorm/pending-fixes.md) -- Items
  53 (handoff) and 54 (save-error surface) both would have been
  simpler with a shared TODO primitive carrying the post-handoff
  plan between agents.

## Status

| Phase | Scope                                                                  | Status |
|-------|------------------------------------------------------------------------|--------|
| 0     | Central agent-family registry (prerequisite, replaces variant refs)    | done (`11b338dab98`) |
| 1     | Data model + shared types + DB schema                                  | done (`11b338dab98`) |
| 2     | Daemon RPC surface (todos.list/create/update/archive)                  | done (`5fa4e5c3e0c`) |
| 2b    | `agent.discard` integration                                            | done (`5fa4e5c3e0c`) |
| 3     | Agent hooks (read/mutate todos from any controller)                    | done (`5fa4e5c3e0c`) |
| 4     | Browser service + event stream                                         | done (`a3896790a20`) |
| 5a    | Todos editor pane (EditorInput + EditorPane, per session)              | done (`66547d52e98`) |
| 5b    | Inline chat todos widget (agent-owned lists in transcript)             | done (`66547d52e98`) |
| 5c    | Runs sidebar badge (pending-item count, click-to-open)                 | done (`66547d52e98`) |
| 5d    | Comments: append-only user annotations on agent items                  | done (`66547d52e98`) |
| 6     | Migration proof: port the delegate variant's plan list first           | done (`ab919c5580f`) |
| 7     | Broader family adoption (brainstorm / designer / planner)              | pending |
| 8     | Factor shared pane-scaffolding + markdown widget with notepad          | pending |
| 9     | User-owned TODOs in notepad + `withTodo` sub-agent invocation          | done (`ce5ed510690` + `0b8f5dac19f` + unified-notepad pane follow-up) |

**Pending follow-ups (not formal phases):**
- Per-family `withTodo` consumers -- Phase 9 landed the RPC + types
  + browser wiring; every `todos.forwardToAgent` currently returns
  a stub `in_progress` response. Each family needs its own handler
  reading `input.todos`. Plan body says planner is the first
  consumer.
- Proper `todos.deleteList` RPC -- the unified notepad's "Delete"
  button currently archives as a stand-in.
- "Last forwarded to X" hint on items (UX gap; meta-driven badge).

---

## Goals

1. **Session-owned, session-scoped.** A TODO list is identified by
   `(sessionId, listId)`. List lifetime tracks the session. Discarding
   a session purges its lists (same purge path as
   `plans/session-lifecycle.md` Phase 4).
2. **Multiple lists per session.** A session may have several
   concurrent lists: an agent's execution plan, a user-authored
   punchlist, a handoff carry-over from the previous agent. Lists do
   not merge -- each has its own id, title, and source.
3. **First-class state machine.** Lists have a status; items have a
   status; transitions are explicit and validated. No string grep
   over free-form labels to infer "is this done".
4. **Observable.** Every mutation fires an event the UI can subscribe
   to; no polling. The browser-side session service exposes a live
   view keyed by sessionId.
5. **Family-agnostic.** A single module owns the persistence + state
   transitions. Any agent family (brainstorm, implementation,
   designer, ..., future ones) can read + mutate via the same API
   without inventing its own list format.
6. **Resume-safe.** State survives daemon restart. Inclusion in the
   session checkpoint is considered but rejected -- see the
   persistence section; lists go straight to LanceDB so they're
   durable even without a checkpoint.
7. **Bounded growth.** A unified cleanup API deletes lists by
   session id, age, status, or source (AND'ed filters). Default
   retention drops archived lists after 90 days; user can override.
   No schema-level append-only accumulation.
8. **Ownership is explicit and enumerable.** Every list is owned by
   exactly one of: an **agent family** (`'brainstorm'`,
   `'implementation'`, `'designer'`, `'research'`, `'debugging'`,
   `'deployment'`, ...), the special `'user'` owner, or `'system'`
   (daemon maintenance). Ownership lives at the family level for
   agent-owned lists, never the variant level: `'implementation'`
   covers both pair and delegate (scope-driven runtime variants,
   not owners); `'brainstorm'` covers its sub-categories the same
   way. The canonical set of owners is the `TodoOwner` union
   exported by `shared/todos.ts` (= `AgentFamily | 'user'`, with
   `'system'` already inside `AgentFamily`).

   Only the current owner can mutate the list. Writable surfaces
   are split by ownership:

   - **Agent-owned lists**: mutated by the owning family's
     controllers via `deps.todos` (Phase 3). The **todos pane is
     a read-only review surface** for agent-authored work -- no
     edit / reorder / transfer affordances. Users can only
     **comment** on items on agent-owned lists (see Goal 9).
   - **User-owned lists**: mutated by the user via the existing
     **prompt notepad** (see the notepad section below). Agents
     cannot see user-owned lists in their reads; the user must
     explicitly forward items via `withTodo` (see Goal 11) or
     transfer a whole list via the standard `transfer` RPC.

   A list can be handed off from one owner to another via
   `transfer` -- that's the only way to flip ownership. Transfer
   is permanent: the new owner accepts full write authority, the
   prior owner loses write access (but keeps read access + the
   audit trail in `list.transfers`). Transfer applies to both
   user→agent handoffs and agent→agent handoffs.
9. **User feedback on agent-owned lists flows through comments.**
   The user can't mutate state on lists they don't own, but can
   **append comments** on any agent-owned item. Comments are
   append-only, author is `'user'`, and the owning agent reads
   them on its next turn to decide what to do (rewrite the item,
   skip it, acknowledge, etc.). Comments are the only structured
   user→agent signal *on agent-owned lists*; "agent asks user to
   do something" goes through the existing chat-gate mechanism,
   not todos.

   Two other user→agent signals exist alongside comments:

   - **`transfer`** -- user hands off an entire list to an agent
     family (permanent ownership flip; see Goal 8).
   - **`withTodo`** -- user forwards one or more snapshots of
     user-owned items to an agent, which spawns a new agent run;
     per-item status comes back asynchronously (see Goal 11).
10. **Lists can form a parent-child tree.** A list may have a
   `parentListId` pointing to another list in the same session.
   This lets an agent family model hierarchical work (planner
   emits a top-level plan; the implementation family picks it
   up and creates one child list per plan step to track
   execution sub-tasks; a brainstorm theme-spec session spawns
   a child list per theme). Ownership is per-list, so children
   can have different owner families than their parent -- a
   handoff can transfer a child without affecting its parent.
   The tree is strictly within a single session (`sessionId`
   matches parent + child) and forbidden from forming cycles.

11. **`withTodo` -- sub-agent invocation with snapshot items.**
   When the user (or another agent) wants a specific agent to
   act on a set of items without handing off a whole list, they
   call the `withTodo` primitive:

   ```
   todos.forwardToAgent -> {
     targetFamily: AgentFamily,
     items:        readonly TodoSnapshot[],  // title + description + meta, no ids
     sessionId:    string,
   } -> TodoInvocationResult
   ```

   - Kicks off a **new agent run** on the target family, with
     `input.todos = items`.
   - Receiving agent runs normally; its steps may consume the
     snapshots, decide **per item** whether to copy into its
     own list or handle inline.
   - Each snapshot crosses the boundary **detached** -- no
     source id, no back-reference. The receiver can't read the
     source list (if the caller was `'user'`, that list is
     invisible to agents anyway).
   - The run emits a `TodoInvocationResult` with one
     `TodoInvocationResponseItem` per snapshot, keyed by
     `sourceRef` (correlation id the caller supplied), carrying
     a `status: TodoItemStatus` and optional target ids + note.
   - The caller uses each response item's `status` to update
     its own source item (e.g. user's item flips to
     `in_progress` when the agent accepts it, `completed`
     when the agent finishes).

   `withTodo` is orthogonal to `transfer`: transfer hands off
   an entire list with ownership flipping permanently; withTodo
   kicks off an agent task and reports back without changing
   ownership of anything on the caller's side.

## Non-goals

- Cross-session todo aggregation (e.g. "all my pending items across
  every session"). Lists die with the session by design.
- Multi-user concurrent editing. One daemon, one user.
- Arbitrary list hierarchies / sub-lists. Items are flat within a
  list. Hierarchy should be modeled as separate lists with
  `parentListId` if the use case emerges; deferred until a caller
  actually asks.

---

## Data model

```ts
// shared/todos.ts -- zero dependencies, consumed by daemon + browser.

export type TodoItemStatus =
  | 'pending'        // not started
  | 'in_progress'    // actively being worked on
  | 'blocked'        // can't proceed; `blockedReason` required
  | 'completed'
  | 'cancelled';     // user / agent gave up

export type TodoListStatus =
  | 'active'         // lists with at least one non-terminal item
  | 'completed'      // every item terminal (completed / cancelled)
  | 'archived';      // user hid it; still readable but not surfaced

export interface TodoItem {
  readonly id: string;            // ULID, globally unique
  readonly listId: string;        // parent list
  readonly title: string;         // short one-line imperative
  readonly description?: string | undefined;  // optional multi-line
  readonly status: TodoItemStatus;
  readonly order: number;         // fractional index for insert-between reorder
  readonly createdAt: string;     // ISO
  readonly updatedAt: string;     // ISO; bumped on any field change
  readonly completedAt?: string | undefined;
  readonly blockedReason?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  /** Free-form structured metadata the creating agent can stash.
   *  Opaque to the framework; JSON-serializable. */
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  /** Append-only user annotations on this item (Phase 5d). The
   *  owning agent reads these on its next turn and decides how
   *  to act. Never mutated by agents; only the author (`'user'`)
   *  can edit or delete their own comment. */
  readonly comments?: readonly TodoComment[] | undefined;
}

export interface TodoComment {
  readonly id: string;            // ULID
  readonly itemId: string;        // parent item
  /** Author. Currently always `'user'`; typed broadly so a future
   *  phase could allow cross-agent comments (e.g. reviewer agent
   *  annotating another agent's list) without a schema change. */
  readonly author: TodoOwner | 'user';
  readonly body: string;          // free-text, markdown-rendered in UI
  readonly createdAt: string;
  readonly editedAt?: string | undefined;
  /** True once the owning agent has read the comment in one of
   *  its turns. Agents are expected to toggle this when they
   *  process the comment; the UI renders unread-by-agent comments
   *  with an "unread" affordance so the user can see whether the
   *  agent has picked it up. */
  readonly agentAcknowledged?: boolean | undefined;
}

/**
 * Owners of a TODO list.
 *
 * - **Agent families** (`AgentFamily` from `shared/agent-registry.ts`):
 *   `'chat' | 'implementation' | 'brainstorm' | 'designer' |
 *    'planner' | 'tester' | 'research' | 'debugging' |
 *    'deployment' | 'system'`. Ownership is at the FAMILY level;
 *   variants (pair/delegate under `'implementation'`; the five
 *   brainstorm sub-categories) are private to the controller and
 *   never surface as owners.
 * - **`'user'`**: the user owns the list, edited via the prompt
 *   notepad. Agents cannot read user-owned lists in their normal
 *   session queries; the user must explicitly `transfer` a list
 *   or `forwardToAgent` snapshots to bring them into an agent's
 *   view.
 *
 * Only the current owner can write. `'system'` is reserved for
 * framework-generated lists (e.g. a daemon-maintained "sessions
 * with expiring checkpoints" list if that ever becomes useful);
 * no one but the daemon writes to these.
 */
import type { AgentFamily } from './agent-registry.js';
export type TodoOwner = AgentFamily | 'user';

export interface TodoList {
  readonly id: string;            // ULID, globally unique
  readonly sessionId: string;     // FK on Session.id
  /** Optional parent in the list tree. When set, the list is a
   *  child of the referenced list. Parent and child must share
   *  `sessionId`. Used to model hierarchical agent work
   *  (planner plan → per-step execution lists → per-step
   *  subtasks). Cycles are rejected at create / reparent time. */
  readonly parentListId?: string | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: TodoListStatus;
  /** Current owner. Determines who can mutate the list. */
  readonly owner: TodoOwner;
  /** Original creator -- preserved across transfers so the audit
   *  trail survives. `owner` may differ from `source` if the list
   *  has been transferred. */
  readonly source: TodoOwner;
  /** Chronological history of ownership changes, newest last.
   *  Every entry records WHO handed it off, to WHOM, and WHY
   *  (free-text reason). Useful for UI ("brainstorm → design
   *  handoff: continuing the spec work") and for debugging. */
  readonly transfers: readonly TodoTransfer[];
  /** Optional agent-authored narrative above the items -- e.g. a
   *  one-paragraph summary of what this list represents or a
   *  pointer to the spec/ticket. Always read-only from the UI. */
  readonly body?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly TodoItem[];
}

export interface TodoTransfer {
  readonly from: TodoOwner;
  readonly to: TodoOwner;
  readonly reason: string;
  readonly at: string;            // ISO timestamp
  /** If the handoff was initiated by a handler inside an agent
   *  (e.g. brainstorm's post-save handoff-proposal flow),
   *  `initiator` records that. Defaults to the `from` owner. */
  readonly initiator?: TodoOwner | undefined;
}

// ---------------------------------------------------------------------------
// withTodo primitive -- snapshot forwarding + per-item response.
// Goal 11. Used by `todos.forwardToAgent`.
// ---------------------------------------------------------------------------

/**
 * Detached copy of a TodoItem sent to a sub-agent via `withTodo`.
 * Deliberately no `id` or `listId` -- the receiving agent never
 * links back to the source. The caller supplies `sourceRef` so it
 * can correlate the response item to the source TodoItem in its
 * own list.
 */
export interface TodoSnapshot {
  readonly sourceRef: string;     // caller-chosen correlation key
  readonly title: string;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * One entry per snapshot in the `withTodo` response. Uses the same
 * `TodoItemStatus` vocabulary as the framework -- the caller
 * applies this status to the source item (`updateItem(sourceId,
 * { status })`), so the user's list reflects how the sub-agent
 * disposed of each forwarded item.
 */
export interface TodoInvocationResponseItem {
  readonly sourceRef: string;
  readonly status: TodoItemStatus;
  /** Required when `status === 'blocked'`. Mirrors the item's
   *  blockedReason field on the caller's side. */
  readonly blockedReason?: string | undefined;
  /** Populated when the agent persisted a copy into its own list
   *  (i.e. the agent decided to "own" the item). The caller can
   *  link back to the agent's target in the UI. */
  readonly targetListId?: string | undefined;
  readonly targetItemId?: string | undefined;
  /** Optional free-text context from the agent. */
  readonly note?: string | undefined;
}

export interface TodoInvocationResult {
  readonly items: readonly TodoInvocationResponseItem[];
}
```

## Ownership + authorization

Every mutation RPC takes an implicit caller identity derived from
its entry point:

- Calls originating from a `TaskController` via `deps.todos` inherit
  the controller's **family** (`'brainstorm'`, `'implementation'`,
  `'designer'`, ...). Variants (pair/delegate, brainstorm
  sub-categories) never appear as owners -- the `deps.todos`
  wrapper maps them to their family id at call time.
- Calls originating from the browser via `IInsrcTodosService` (user
  action in the UI -- notepad or todos pane) carry the caller
  identity `'user'`.
- Calls originating inside the daemon's own background maintenance
  (retention job, `agent.discard` sweep) carry `'system'`.

The daemon enforces write + read authority at the RPC boundary.
Reads are gated, not just writes, because user-owned lists are
private to the user:

| Caller    | Can read                                 | Can write lists                 | Can comment |
|-----------|------------------------------------------|---------------------------------|-------------|
| `'user'`  | every list in session                    | lists with `owner === 'user'` (notepad UI) | yes -- any item on any readable list |
| agent X   | every list **except** `owner === 'user'` | lists with `owner === X`        | yes -- `ackComment` on comments on items in lists it owns |
| `'system'`| every list                               | no lists (only `todos.cleanup`) | no |

Write-permission violations return `{ error: 'owner_mismatch', list: TodoList }`.
Read-permission violations simply omit the forbidden lists from
the result (so agents naturally never see user-owned lists).

The todos **pane** (Phase 5a) remains read-only even though the
user has write capability -- edit affordances live in the **prompt
notepad** (the user's scratch / punchlist surface). The pane's
purpose is "review what agents are doing", not "manage my own
todos". Different surfaces, same data model, same database.

**Comment calls** are unrestricted by ownership: the user can
append / edit / delete comments on any readable item; agents can
`ackComment` on items on their own lists.

### Transfer (handoff / handover)

Transfers flip list ownership permanently. Use transfer when a
piece of work is done on one owner's side and another owner
takes it over wholesale (e.g. user hands a punchlist to an
implementation agent; planner hands its plan to implementation;
implementation hands an unresolved list back to the user). The
current owner calls:

```
todos.transfer -> {
  listId: string,
  to: TodoOwner,     // 'user' | '<agent family>' | 'system'
  reason: string,    // free-text; required. Shows in the UI history.
} -> TodoList
```

Rules:
- Caller must be the current `owner`. User-owned lists can be
  transferred by the user via the notepad UI; agent-owned lists
  by the owning agent's controller; user can also receive lists
  back from agents.
- `to` must be a valid `TodoOwner` (`AgentFamily | 'user'`).
  Transfer to an unknown owner is rejected.

**Transfer vs `withTodo`:** use `transfer` when the target
should take over the work; use `withTodo` (Goal 11) when the
caller stays owner of the source list and just wants a sub-agent
to act on some items and report back.
- **The target family does NOT need to be currently running on
  the session.** Transfer to a dormant family is valid: the list
  simply sits waiting for the next session turn that spins up
  one of that family's controllers. When family X activates for
  any reason on this session (classified intent, user `/intent`
  override, handoff proposal), its controller sees pending lists
  owned by X and can resume work. Lists stuck with a dormant
  owner that never activates on this session are eventually
  archived by the retention job.
- Appends a `TodoTransfer` record to `list.transfers` with `from =
  previous owner`, `to`, `reason`, `at = now`. Atomic with the
  owner field update.
- Emits a `'listUpdated'` stream event carrying the new snapshot.

Transfer **does not** mutate item state -- in-progress items stay
in-progress across the handoff; the new owner decides how to
proceed. Transfer also does not archive the list; explicit archive
is a separate op the current owner performs.

### Pending-owner UI

When a list's `owner` is an agent that isn't currently active on
the session, both the editor pane and the inline chat widget
render a "⏳ waiting for <owner>" hint on the card header. The
hint clears when the target agent next activates.

### Typical ownership flows

- **Brainstorm → Designer handoff**: when the user picks
  "Continue with Designer" on the post-save handoff gate (Item 53),
  the brainstorm controller creates/amends a list tracking open
  design questions and transfers ownership to `'designer'` with
  `reason: 'post-save handoff from brainstorm/design'` before
  finishing. The Designer agent picks up write authority; the
  user watches the handoff happen via the inline chat widget +
  the todos pane.
- **Planner → Implementation handoff**: the Planner publishes a
  plan-step list while it owns the session; the implementation
  agent calls `todos.transfer(listId, 'implementation', 'plan
  execution takeover')` at session start. Internally, the
  implementation controller picks pair (single scope) or
  delegate (batch scope) based on classification; ownership
  stays at the family level throughout the handoff and
  execution.
- **User → sub-agent invocation via `withTodo`**: user selects
  one or more items from a user-owned list and picks a target
  family (e.g. `'research'`). Fires
  `todos.forwardToAgent({ targetFamily: 'research', items })`,
  which spawns a target-family agent run with the items as
  detached snapshots. **The user's list does not change
  ownership; items stay in the notepad.** Per-item status flips
  via `TodoInvocationResponseItem` updates once the agent
  reports back (e.g. `in_progress` while the agent works,
  `completed` or `blocked` once it finishes). This is the only
  user→agent path from the notepad.
- **Agent completes + hands to system**: when an agent finishes
  its work, it either archives the list itself or transfers to
  `'system'`, which keeps the list queryable for retention /
  audit but prevents further writes until another agent claims
  it.

## List hierarchy

Lists form a forest within a session: any list may have a
`parentListId` pointing at another list in the same session.
Agents use this to express "this group of sub-tasks belongs to
that larger piece of work".

### Invariants

- `parent.sessionId === child.sessionId`. Cross-session linking
  is rejected.
- No cycles. On `todos.create` / `todos.reparent`, walk up from
  the proposed parent; reject if the walk reaches the child's
  own id.
- `parentListId` references an existing list. Dangling parent
  refs (parent deleted, child left orphaned) are caught by
  cleanup (see below).
- No depth limit imposed at the framework level. **The UI does
  not render nesting** (see UI rendering below) so arbitrary
  depth is fine from a display standpoint.

### Ownership in a tree

Each list in the tree has its own `owner`; parent and child
ownership are **independent**. Typical patterns:

- **Same-owner subtree**: the implementation family owns a
  top-level plan list plus one child-per-step that it authors as
  work progresses. All nodes have `owner: 'implementation'`.
  Internally the family may be running pair or delegate on any
  given turn; ownership doesn't flip.
- **Cross-owner handoff**: planner owns the top-level plan
  (`owner: 'planner'`); the implementation family creates child
  execution lists under that plan (`owner: 'implementation'`).
  Transferring the root plan back to `'planner'` doesn't affect
  the implementation children -- each node keeps its own writer.
- **User-visible boundary**: the pane renders the whole tree
  regardless of owner mix; family ownership badges appear
  per-node so the user sees where one family's authority ends
  and another's begins.

### Cascade behavior

| Operation on parent | Effect on children                                   |
|---------------------|------------------------------------------------------|
| `archive`           | Children are **not** archived. They remain active and visible; the parent is just hidden. UI auto-promotes orphaned children to top-level rendering. |
| `unarchive`         | No effect on children (they were never archived).    |
| `transfer`          | No effect on children. Each list owns its own transfer state. |
| `todos.cleanup` with matching filter | Children matching the same filter are deleted too; children that don't match are reparented to the grandparent (or promoted to root if no grandparent). Avoids dangling refs. |
| `agent.discard` session purge | Entire session tree deleted (all lists, all depths). |

### UI rendering -- flat with references, NOT nested

Nesting can be multi-level and agent plans can fan out wide; any
attempt to render the tree inline would quickly become unreadable
(horizontal indent grows, layout breaks at 3+ levels, users lose
which card belongs to which). Instead, the UI renders the session's
lists as a **flat stack** -- every list is a top-level card
regardless of depth -- and each card surfaces its hierarchy
context as cross-reference links:

- **Parent link** in the card header (when `parentListId` is set):
  `↑ parent: <parent title> [jump]`. Clicking scrolls the pane to
  the parent card.
- **Child references** in a card footer:
  `↓ children (3): <c1 title> · <c2 title> · <c3 title>`.
  Each title is a link that scrolls to that child card.
- **Grandchildren don't appear transitively** -- only direct
  children of a card. To see a grandchild, user jumps to the
  child card and reads ITS children list.

Sort order in the flat stack: root lists first (no `parentListId`),
then children grouped under their parent (adjacent to the parent
card but not indented), then grandchildren adjacent to their
parent child, and so on. Roughly a DFS flattening, with the
cross-reference links making the hierarchy legible.

No indentation, no tree-connector lines, no collapse-all-children
action. The card is the unit; links navigate between cards.

A child whose `parentListId` points to a deleted or never-created
parent is treated as root-level (render at top; no "missing
parent" error). Cleanup's retention job periodically rewrites
these so the `parentListId` field is nulled rather than
dangling.

### RPC

```
todos.reparent          -> { listId, newParentListId: string | null } -> TodoList
```

- `listId` must be owned by caller.
- `newParentListId`: pass `null` to promote the list to a root;
  pass a string to graft under the given parent. Parent need not
  be owned by the caller -- you can re-home a list under someone
  else's parent (and you'd likely also `transfer` soon after).
- Validates `sessionId` match + cycle freedom.
- Emits `'listUpdated'` with the new `parentListId`.

`todos.create` gains an optional `parentListId` param; when
supplied it applies the same validation as `reparent`.

## State transitions

### Item transitions

```
pending     -> in_progress | cancelled
in_progress -> blocked | completed | cancelled | pending  (back-to-queue)
blocked     -> in_progress | pending | cancelled
completed   -> (terminal)
cancelled   -> (terminal)
```

Rules enforced by the framework:
- `blocked` requires `blockedReason` (non-empty).
- `completed` sets `completedAt` automatically.
- Transition to `cancelled` is always allowed from any non-terminal.
- No transition *out* of `completed` or `cancelled` (re-open =
  create a new item).

### List transitions

- `active` -> `completed` fires automatically when every item enters
  a terminal state. Agents can nudge it back to `active` by
  re-adding a non-terminal item.
- `active` / `completed` -> `archived` only by explicit user/RPC
  call. Archived lists stop appearing in the default sidebar view.
- `archived` -> `active` by explicit unarchive.

### Ordering

`TodoItem.order` is a rational number (Python-style fractional
indexing). Insert-between uses `(prev.order + next.order) / 2`. Bulk
rewrite is fine when the step size drops below an epsilon; worker
code should handle the "rebalance" case rather than leak fractional
precision to callers.

---

## Persistence

### Option A: LanceDB tables (chosen)

Two new tables next to `conversation_turns` / `sessions`:

```
todo_lists:
  id             STRING  PK
  session_id     STRING  FK -> sessions.id
  parent_list_id STRING  FK -> todo_lists.id (nullable; NULL for root lists)
  title          STRING
  description    STRING
  status         STRING  -- TodoListStatus
  owner          STRING  -- TodoOwner (current writer)
  source         STRING  -- TodoOwner (original creator, immutable)
  transfers_json STRING  -- JSON array of TodoTransfer
  created_at     STRING
  updated_at     STRING
  vector         VECTOR  -- future: semantic search across lists

todo_items:
  id              STRING  PK
  list_id         STRING  FK -> todo_lists.id
  title           STRING
  description     STRING
  status          STRING  -- TodoItemStatus
  order_key       DOUBLE
  created_at      STRING
  updated_at      STRING
  completed_at    STRING
  blocked_reason  STRING
  tags_json       STRING  -- JSON array
  meta_json       STRING  -- JSON object
  vector          VECTOR
```

Pros:
- Durable without piggybacking on the checkpoint file (which is
  ephemeral and gets deleted on clean session complete).
- Plays nicely with `session-lifecycle.md` Phase 4 discard: delete
  rows where `session_id = $1`.
- Can be queried without thawing the controller state.

### Option B: In the session checkpoint state blob (rejected)

Rejected because: checkpoints are ephemeral and deleted on clean
session complete (`markSessionComplete` in brainstorm), but TODO
lists outlive the agent run -- a brainstorm may hand off to a design
session that imports the TODO list from the brainstorm's checkpoint
that no longer exists.

### Option C: In-memory only (rejected)

Rejected because it loses state across daemon restart.

---

## Daemon RPC surface

Add a new `todos.*` namespace to [daemon/index.ts](../src/insrc/daemon/index.ts):

```
todos.listForSession    -> { sessionId, includeArchived?: boolean }  -> TodoList[]
todos.create            -> { sessionId, title, description?, owner,
                             parentListId?: string,
                             items?: Array<{title, description?, tags?, meta?}> } -> TodoList
todos.update            -> { listId, patch: { title?, description?, status? } } -> TodoList
todos.transfer          -> { listId, to: TodoOwner, reason: string } -> TodoList
todos.reparent          -> { listId, newParentListId: string | null } -> TodoList
todos.archive           -> { listId } -> TodoList
todos.unarchive         -> { listId } -> TodoList
todos.addItem           -> { listId, title, description?, insertAfterItemId?, tags?, meta? } -> TodoItem
todos.updateItem        -> { itemId, patch: { title?, description?, status?,
                             blockedReason?, tags?, meta? } } -> TodoItem
todos.reorderItem       -> { itemId, insertAfterItemId: string | null } -> TodoItem
todos.removeItem        -> { itemId } -> { ok: true }
todos.clearCompleted    -> { listId } -> TodoList

todos.cleanup           -> CleanupQuery -> { deletedListCount, deletedItemCount }

todos.addComment        -> { itemId, body } -> TodoComment
todos.editComment       -> { commentId, body } -> TodoComment
todos.deleteComment     -> { commentId } -> { ok: true }
todos.ackComment        -> { commentId } -> TodoComment

todos.forwardToAgent    -> { targetFamily: AgentFamily, sessionId, items: TodoSnapshot[] }
                        -> TodoInvocationResult    (see Goal 11)
```

**Authorization** (see Ownership section above): every mutation
except `todos.listForSession` checks the caller identity against
the list's current `owner`. On mismatch: respond with
`{ error: 'owner_mismatch', list }` and do not mutate.

**Size caps**: enforced at RPC boundary (Phase 2 validation).
- Max items per list: **200**. `todos.addItem` returns
  `{ error: 'list_full', list }` when the cap is hit.
- Max lists per session: **50** (same error shape as above).
- Max body length: 32 KiB per `TodoList.body`, 8 KiB per
  `TodoItem.description`. Above the limit the RPC rejects with
  `'field_too_large'`.

**`todos.create`** sets the initial `owner` from the `owner`
parameter (agent callers default to their own id if omitted; user
callers may only set `'user'`). Both `source` and the first entry
in `transfers` history are seeded from the same value, so the
audit trail always starts with the creator.

### Cleanup query

One unified delete endpoint with a structured filter, not a grab-bag
of `deleteBySessionId` / `deleteOlderThan` / `deleteByStatus`
methods. Filters AND together; a filter is omitted means "don't
constrain on this axis". At least one filter must be non-empty (no
unbounded delete-everything).

```ts
export interface CleanupQuery {
  /** Delete lists belonging to these sessions (and their items). */
  sessionIds?: readonly string[];
  /** Delete lists older than this absolute ISO timestamp
   *  (comparison on `updatedAt`, not `createdAt` -- we keep lists
   *  the user recently touched). */
  updatedBefore?: string;
  /** Delete lists older than this many days (computed at query
   *  time; convenience over `updatedBefore`). */
  olderThanDays?: number;
  /** Restrict to lists in these terminal states (default: deletes
   *  any state when other filters match). Prevents accidental purge
   *  of active work when an age filter is all the user supplied. */
  statuses?: readonly TodoListStatus[];
  /** Restrict to lists produced by these agent sources
   *  (e.g. only purge stale `'brainstorm'` lists). */
  sources?: readonly string[];
  /** Dry run: return the count that WOULD be deleted without
   *  actually deleting. */
  dryRun?: boolean;
}
```

**Safety rails:**
- `updatedBefore` and `olderThanDays` require at least one of
  `sessionIds` / `statuses` / `sources` alongside them -- an
  age-only query is rejected (too easy to wipe everything).
- Default retention policy runs daily at daemon startup + every 24h:
  `{ statuses: ['archived'], olderThanDays: 90 }`. Archived +
  untouched for 90 days is safe to drop. Configurable via
  `cleanup.todos.retentionDays` in `~/.insrc/config.json`.
- Always emits a `'listDeleted'` stream event per deleted list so
  subscribed UIs prune their caches.
- Participates in the `agent.discard` purge path from
  [session-lifecycle.md](session-lifecycle.md) Phase 4 -- discarding
  a session calls `todos.cleanup({ sessionIds: [id] })` as part of
  the same RPC so nothing lingers.

Every mutation also fires a `todos.update` stream event carrying
the mutated list snapshot, so live UIs stay in sync without
re-polling.

### Stream event shape

Reuse the existing `IpcStreamKind` pattern (see `shared/types.ts`).
Add:

```
export type IpcStreamKind = ...previous... | 'todos';

// data shape
{
  kind: 'listCreated' | 'listUpdated' | 'listArchived' | 'listDeleted'
      | 'itemCreated' | 'itemUpdated' | 'itemRemoved',
  list: TodoList,  // full snapshot, always
}
```

Full snapshot per event (cheap; max tens of items per list).
Lets subscribers treat the event as "here is the current state"
without needing a separate refresh RPC after each mutation.

---

## Agent integration

A single helper exposed to any `TaskController`:

```ts
// daemon/todos-api.ts -- thin wrapper over the LanceDB layer.

export interface TodosApi {
  createList(opts: CreateListOpts): Promise<TodoList>;
  addItem(listId: string, opts: AddItemOpts): Promise<TodoItem>;
  markInProgress(itemId: string): Promise<TodoItem>;
  markComplete(itemId: string): Promise<TodoItem>;
  markBlocked(itemId: string, reason: string): Promise<TodoItem>;
  /** Hand ownership to another agent or to the user. Caller must
   *  currently own the list. */
  transfer(listId: string, to: TodoOwner, reason: string): Promise<TodoList>;
  /** Move a list under a different parent (or to root with null). */
  reparent(listId: string, newParentListId: string | null): Promise<TodoList>;
  list(sessionId: string): Promise<TodoList[]>;
}
```

`deps.todos.createList` automatically stamps `owner` with the
caller controller's **family** (`brainstorm` / `implementation` /
`designer` / ...), not its variant -- pair and delegate both
stamp `owner: 'implementation'`; brainstorm sub-categories all
stamp `owner: 'brainstorm'`. Explicit `owner` override is
allowed only for `'system'` callers.

Plumbed onto `TaskOrchestratorDeps` so every controller can call
`deps.todos.createList({ title: 'Review ideas', source: 'brainstorm', ... })`
without a direct DB import.

### Migration -- Phase 6 proof

Port the delegate variant of the `implementation` family
([`agent/tasks/delegate/agent.ts`](../src/insrc/agent/tasks/delegate/agent.ts))
as the reference migration. The list is owned by the family
(`owner: 'implementation'`); the delegate variant is an
internal runtime detail, not a separate owner. Delegate's plan
is the cleanest existing shape -- ordered list of steps with
status (pending → in-progress → done) and a known UI widget --
so porting it validates the framework handles the hardest case
today. Other families follow in Phase 7 once the pattern is
proven.

---

## Browser integration

New browser service: `IInsrcTodosService` (mirrors the pattern of
`IInsrcBrainstormSessionService`).

```ts
export interface IInsrcTodosService {
  readonly lists: readonly TodoList[];          // current session's lists
  readonly onDidChange: Event<void>;
  readonly onDidChangeList: Event<TodoList>;    // granular

  // List read-only. Agents own mutations via `deps.todos` on the
  // daemon side. Exposing no list-mutation methods here prevents
  // accidental UI paths that would hit the daemon's
  // `owner_mismatch` rejection.
  listsForSession(sessionId: string, includeArchived?: boolean): Promise<readonly TodoList[]>;

  // Comments: the ONE user → agent write channel. Append-only
  // from the user's side; own-comment edit/delete allowed.
  addComment(itemId: string, body: string): Promise<TodoComment>;
  editComment(commentId: string, body: string): Promise<TodoComment>;
  deleteComment(commentId: string): Promise<void>;
}
```

Under the hood:
1. On `IInsrcChatService.onDidChangeSession`, call
   `todos.listForSession` and seed the in-memory cache.
2. On each `todos` stream event, update the cache + fire
   `onDidChange` / `onDidChangeList`.
3. Expose through DI to the UI.

### UI: dedicated Todos editor pane (read-only review)

The todos surface is a **per-session editor pane** (not a sidebar
view). It's a **read-only review surface**: the user opens it to
inspect what agents have planned and how they're progressing,
never to edit. All agent-side write operations (add/reorder/
status cycle/archive) are driven by the agents themselves through
the daemon RPC, not by user actions in this pane.

Pattern matches the brainstorm step panes (`BrainstormIdeasPane`,
`BrainstormThemeDetailsPane`, etc.): a dedicated `EditorInput` +
`EditorPane` pair keyed by `sessionId`, opened via the editor
service, owning its own tab in the editor group.

Key design choices:
- **One pane per session, many lists inside, flat render with
  cross-references.** A chat session routinely has multiple todo
  lists open simultaneously (an agent's execution plan + a
  brainstorm handoff carry-over + a planner's step list), and
  agents can nest sub-lists under a parent via `parentListId`.
  The pane renders every list as a top-level card regardless of
  depth; parent / child relationships surface as **links** in
  each card's header and footer (see "UI rendering" under List
  hierarchy). No indentation, no nested-tree drawing, no
  collapse-all-children -- those don't scale past two levels.
  Opening the pane for a session that already has one focuses
  the existing tab (`matches()` on the `EditorInput`, same
  convention as the brainstorm pane).
- **Every list is collapsible.** Each list card has a chevron in
  the header; clicking toggles between a compact header-only
  view (title + owner badge + pending count + kebab menu) and
  the expanded items list. State persists per-list, per-session
  in `storageService` so reopening the pane restores the user's
  collapse choices.
  - **Default collapsed**: lists where every item is terminal
    (completed/cancelled) OR lists owned by `'system'`.
  - **Default expanded**: agent-owned lists with at least one
    non-terminal item.
  - Keyboard: `Space` on a focused header toggles.
- **No edit affordances anywhere.** No `✎` buttons, no `+ Add
  item` rows, no drag handles for reorder, no status-cycle on
  click. Status badges, titles, descriptions render as plain
  text. Kebab menu offers only read-only actions:
  copy-to-clipboard (the full list as markdown), view-transfer-
  history, jump-to-agent (focus the chat panel with the agent
  that owns this list).
- **Live updates.** Subscribes to `IInsrcTodosService.onDidChange` /
  `onDidChangeList` so an agent's mutation lands in the pane
  without a refresh; `onDidChangeList` carries the list id so
  we can re-render just that card, preserving the collapse state
  of the others.
- **Activity-console palette.** Header / row background reuse the
  same tokens as `.insrc-chat-live-console` so visually the pane
  reads as an agent work surface rather than a generic form.
- **User scratch has its own pane.** Users compose their own
  notes and prompts in the prompt notepad
  ([plans/prompt-notepad.md](prompt-notepad.md)), which is a
  separate editor pane. The two are intentionally distinct --
  the todos pane is for "what is the agent doing", the notepad
  is for "what am I drafting".

#### DOM sketch

```
┌─────────────────────────────────────────────────────────────────┐
│  TODOS · <session title>                          (read-only)   │
├─────────────────────────────────────────────────────────────────┤
│  ▼ [planner]  Caching layer design plan            4 pending    │
│    [done]      write problem statement                          │
│    [done]      enumerate cache types                            │
│    [in-prog]   design key/invalidation approach                 │
│    [pending]   write migration plan                             │
│    ↓ children (2): Implement key/invalidation · Migration tasks │
│    [⋮ copy as markdown · view history · focus agent]            │
│                                                                 │
│  ▼ [implementation]  Implement key/invalidation  1 pending · 💬1│
│    ↑ parent: Caching layer design plan [jump]                   │
│    [done]      content-hash helper                              │
│    [done]      epoch counter on index commit                    │
│    [in-prog]   wire into Kuzu query path         💬 1 (unacked) │
│      ↳ (user) "consider stale-while-revalidate for              │
│               vector search; strict for Cypher"                 │
│      + Add comment                                              │
│                                                                 │
│  ▶ [implementation]  Migration tasks                 complete   │
│    ↑ parent: Caching layer design plan [jump]                   │
│                                                                 │
│  ▶ [brainstorm] Cache layer spec -- design session   complete   │
│     (collapsed: every item terminal; click to expand)           │
│                                                                 │
│  ▶ [system]   Post-session cleanup                   (system)   │
└─────────────────────────────────────────────────────────────────┘
```

Every card is top-level indent regardless of its depth in the
tree. The `↑ parent:` link on a child card and the
`↓ children (N):` link row on a parent card let the user walk
the hierarchy by clicking without any nested rendering.

`▼` / `▶` indicates the collapse state. All list / item structure
is read-only from the UI; the kebab menu offers copy-as-markdown,
view-transfer-history, and focus-agent-in-chat actions. No `+ New
list` button; no `[pending]` → `[in-prog]` click cycle; no inline
title editors; no drag handles. Agents drive all list mutations
through the daemon RPC.

The **one user-write affordance** is comments. `+ Add comment`
under every item lets the user append a markdown note; `💬 N`
on the item header counts comments with `(unacked)` when at
least one isn't yet acknowledged by the owning agent. The user
can also edit / delete their own comments via a kebab on each
comment row (not shown in sketch).

#### Files + wiring

Mirrors the brainstorm pane scaffolding at
`src/vs/workbench/contrib/insrc/browser/brainstorm/step/`:

- `browser/todos/todosInput.ts` -- `TodosEditorInput extends EditorInput`
  keyed on `sessionId`. Resource URI like
  `insrc-todos:///session/<id>`.
- `browser/todos/todosPane.ts` -- `TodosEditorPane extends EditorPane`.
  Subscribes to the todos service and renders the DOM tree above.
- `browser/todos/todosListWidget.ts` -- per-list widget handling
  inline edits, drag/drop, owner-enforced read-only styling.
- `browser/todos/media/todos.css` -- activity-console-aligned
  styles.
- Editor registration in `browser/insrc.contribution.ts` (pair
  with the existing brainstorm inputs).

#### How the pane opens

Three paths:
1. **Command palette + command**: `insrc.openTodos` opens the pane
   for the active chat session. Bound to the Runs sidebar row
   context menu so right-clicking a run -> "Open Todos" jumps
   straight in.
2. **Button on the chat panel**: small `notebook-edit` codicon in
   the chat header opens the pane for the current session.
3. **Auto-open on agent handoff**: when an agent creates a list
   and transfers to the user (or vice versa), the daemon emits a
   `'listCreated'` / `'listUpdated'` event with a `suggestOpenUI:
   true` hint; the UI contribution opens the pane so the user
   sees the new list immediately.

### Notepad = user-owned todos surface

The prompt notepad ([plans/prompt-notepad.md](prompt-notepad.md))
is **where the user creates and edits their own TODO lists**.
The notepad hosts user-owned items; the todos pane hosts
agent-owned items. Same data model (`TodoList` + `TodoItem` +
`TodoComment`), same LanceDB tables, same state machine --
the surface you edit them in differs by owner.

| Surface | Owner | Read/write for user | Agent visibility |
|---|---|---|---|
| Todos pane | agents | **read-only** (comments only) | agents see everything they own (and across families) |
| Prompt notepad | `'user'` | **read/write** | **invisible to agents** -- must be forwarded via `transfer` or `withTodo` |

Each surface has one audience. "Can I edit this?" is answered
by which surface you're in, not by ownership flags inside a
single pane: the todos pane is stateless about edits (it never
writes), the notepad is stateless about agent work (it never
shows it).

#### How user-owned TODOs reach an agent

**Only one mechanism from the notepad: `withTodo` forwarding.**
User items never leave the user's list. The notepad's
`Forward selected` and `Forward all` buttons call
`todos.forwardToAgent({ targetFamily, sessionId, items:
snapshots })`, which spawns a fresh agent run on the chosen
family with detached item snapshots as input. The user's
source items stay in place; per-item status flows back as
`TodoInvocationResponseItem` entries which the notepad
applies via `updateItem(sourceId, { status })`. So a user can
watch items march through `pending` → `in_progress` →
`completed` (or land on `blocked`) from the agent's side
while keeping full editorial control.

**Why no user→agent transfer from the notepad:** transfer
flips ownership permanently, which makes the list disappear
from the user's view. The user's items are a personal
punchlist; they should always be visible and editable by the
user regardless of whether agents have been invoked on them.
Transfer remains a valid primitive at the API level (used
between agents for handoff / handover -- e.g. planner →
implementation) but no notepad affordance exposes it for
user-owned lists.

#### Shared infrastructure (Phase 8)

Keeping them separate doesn't mean duplicating everything. Phase
7 consolidates the bits they genuinely share:

- **Editor-pane scaffolding helper.** Both panes implement
  `EditorInput` + `EditorPane` + a Monaco-based markdown widget.
  Extract a `browser/shared/workspacePaneBase.ts` they both
  extend so the boilerplate (open via editor service, match by
  sessionId, dispose handling) lives once.
- **Markdown widget.** Whatever renderer / editor Monaco config
  the notepad uses for its composition surface should be the
  same module the todos pane uses to render `body` + item
  descriptions. Phase 8 extracts `browser/shared/markdownWidget.ts`.
- **Styling tokens.** One palette definition shared by both
  panes so they visually belong to the same product family
  without hard-linking their DOM trees.

Non-shared (kept separate on purpose):
- Data model -- notepad content stays in `IStorageService` (or
  a dedicated notepad table); todos lists live in their own
  LanceDB tables. No cross-table joins.
- Commands -- `insrc.promptNotepad.*` stay notepad-only;
  `insrc.todos.*` stay todos-only.
- Ownership -- notepad is user-only; todos are agent-only.
  Neither concept leaks across.

#### Commands (todos-only)

| Command                | Behavior                                               |
|------------------------|--------------------------------------------------------|
| `insrc.todos.open`     | Open the todos pane for the active session.            |
| `insrc.todos.focusAgent` | Focus the chat panel scrolled to the agent owning the currently-selected list. |
| `insrc.todos.copyList` | Copy the currently-selected list to clipboard as markdown. |

The existing `insrc.promptNotepad.*` commands remain unchanged
and tied to the prompt-notepad pane.

### UI: inline chat todos widget

When an agent creates or mutates a list, the chat panel renders
a **live todos card** inline in the transcript so the user sees
the agent's plan + progress without switching panes. Same update
surface as live-step bubbles (Item 32b/55) but persistent and
structured.

Why inline *and* a dedicated pane:
- The **editor pane** (Phase 5a) is the full workspace: all
  lists, edit-in-place, reorder, transfer, archive.
- The **inline chat widget** is conversational presence: when the
  agent is actively working on a list, the user sees it flow by
  in the chat, same place as the agent's other output. The user
  sees "the agent just marked step 3 done" without opening the
  todos pane.

#### Event → widget mapping

The browser subscribes to the same `'todos'` stream events
(`listCreated`, `listUpdated`, `itemCreated`, `itemUpdated`,
`itemRemoved`, `listArchived`, `listDeleted`) and decides which
to surface inline:

| Event          | Inline behavior                                    |
|----------------|----------------------------------------------------|
| `listCreated`  | New card appears as an assistant-side message.     |
| `itemCreated`  | Append item row inside the existing card (in place, same DOM node keyed by listId). |
| `itemUpdated`  | Re-render the affected row; no new message.        |
| `listUpdated`  | Re-render the card header (title / owner / transfer history). |
| `itemRemoved`  | Strike-through then fade-out of the row.           |
| `listArchived` | Shrink card to a compact "archived" footer banner. |
| `listDeleted`  | Remove card entirely.                              |

The "re-render in place" rule mirrors how live-step bubbles
accumulate tokens without creating a new chat message per chunk.
Cards survive across subsequent user turns so scroll-back shows
the history of an agent's plan execution.

Suppression rules:
- Lists with `owner === 'system'` do not render inline
  (maintenance-only).
- Agents with a session-lock (brainstorm) already render gate
  cards in the chat; the todos widget slots alongside them
  without competing for the same render path.
- Every inline widget is read-only. No user mutation affordances.
  Same rule as the editor pane.

#### DOM sketch (inline)

```
─── assistant ─────────────────────────────────────────────────
 [implementation] Implement refine-theme-spec              ▼
 owner: implementation  ·  4 items  ·  1 pending  ·  [Open todos]
 ↑ parent: Caching layer design plan                [jump]
 ──────────────────────────────────────────────────────────────
   ✓   parse Claude review JSON
   ✓   add `refine-theme-spec` prompt
   ▸   wire dispatch case               (in progress)
   ○   update pending-fixes.md          (pending)
 ↓ children (2): Migration tasks · Regression tests [expand]
───────────────────────────────────────────────────────────────
```

- Header: agent badge + list title + expand/collapse chevron.
- Status line: owner / N items / N pending / link to open the
  full editor pane.
- Parent / child rows: same flat-with-references model as the
  editor pane. `↑ parent:` row appears only when `parentListId`
  is set. `↓ children (N):` row appears only when the list has
  children; it lists direct children only (no transitive
  descendants).
- `[jump]` / per-child links scroll the chat transcript to the
  card for that list, if it has been rendered; otherwise
  `[Open todos]` focuses the pane on that list.
- Item rows: compact — icon + title only. Descriptions hidden;
  click to expand a row to see description + meta.
- `[Open todos]` button pops the editor pane focused on this
  list.
- No mutation affordances inline. The only interactive element
  is the expand/collapse chevron, the cross-reference links, and
  the `[Open todos]` link.

#### Collapse / dedup

- Each list appears ONCE in the chat, at the position of its
  `listCreated` event. Subsequent updates do NOT add new messages
  -- they mutate the existing DOM node keyed by `listId`.
- User can manually collapse a card via the chevron; collapsed
  state persists per-list for the session (same `storageService`
  store as the editor pane).
- When a list reaches `status: 'completed'`, the card auto-
  collapses to just the header row with a ✓ badge. Click to
  expand.

#### Implementation

New file: `browser/chat/chatTodosWidget.ts`.

- Mirrors the pattern of the live-step bubble code
  (`chatView._liveStepBubbles` map keyed by `<agent>:<step>`).
  Todos uses a `_todoCards: Map<listId, { el, body }>` keyed by
  list id.
- chatView's event handler adds a `case 'todos':` that routes to
  the widget.
- The widget imports `IInsrcTodosService` only for the
  read-side event stream + `openPane(listId)` helper (delegates
  to the editor service).

#### CSS

- New `.insrc-chat-todos-card` class. Box + thin border matching
  the live-console look, but with a stronger header (it's a
  persistent chat message, not a transient presence indicator).
- Status icons reuse the codicons already in the brainstorm card
  widget (`circle-large-outline` for pending, `play` for
  in-progress, `check` for completed, `warning` for blocked,
  `close` for cancelled).

### UI: sidebar badge (secondary)

Alongside the full editor pane, keep a lightweight indicator in
the Runs sidebar row: a `<span class="todos-pill">3</span>` showing
pending-item count for that run, clickable to open the pane. No
inline editing in the sidebar -- all edits go through the editor
pane.

---

## Rollout phases

### Phase 0 -- Prerequisite: central agent-family registry

Today agent ids live in six scattered places, and the vocabulary
mixes two distinct taxonomies (family vs variant) with no
disambiguation. This phase introduces a single **AgentFamily**
registry, replaces every variant-level reference in the codebase
with its family id, and reserves variants as private runtime
detail inside each family's controller(s).

#### Canonical families

Ten families. The registry is the single source of truth; any new
family name must be added here first before it can be referenced
anywhere else.

```ts
// src/insrc/shared/agent-registry.ts
export type AgentFamily =
  | 'chat'
  | 'implementation'  // variants: pair (single), delegate (batch)
  | 'brainstorm'      // variants: requirements/general/design/implementation/testing
  | 'designer'
  | 'planner'
  | 'tester'
  | 'research'
  | 'debugging'
  | 'deployment'
  | 'system';

export interface AgentFamilyMeta {
  readonly id: AgentFamily;
  readonly displayName: string;
  readonly category: 'coding' | 'spec' | 'exec' | 'infra' | 'meta';
  /** Icon hint for UI. Codicon name or empty for text-only badge. */
  readonly icon?: string;
  /** Human-readable one-liner used in pane hints / transfer
   *  history rows. */
  readonly description: string;
}

export const AGENT_REGISTRY: Readonly<Record<AgentFamily, AgentFamilyMeta>> = { ... };
```

#### Scope: rename variants to families, no legacy references

Every variant reference in the codebase migrates to the family id.
The six affected sites:

1. **`shared/agent-steps.ts`** -- `AGENT_STEP_CATALOG` entry for
   `'pair'` renamed to `'implementation'`; delegate steps folded
   into the same entry. Variant info lives on individual steps
   via a new `variant?: 'pair' | 'delegate'` field if a step is
   variant-specific.
2. **`config/paths.ts`** + **`config/frontmatter.ts`** -- the
   config-directory whitelist drops `'pair'` / `'delegate'` and
   gains `'implementation'` (plus the new families: `'research'`,
   `'debugging'`, `'deployment'`). Daemon-boot migration merges
   any existing `~/.insrc/pair/` + `~/.insrc/delegate/` contents
   into `~/.insrc/implementation/` (idempotent).
3. **`daemon/task.ts` -- `resolveController()` switch** -- keyed
   on the task's intent (not agent id), so this layer stays
   intent-driven. But the `TaskController.id` it constructs gets
   family-level stamping (see site 5).
4. **`agent/tasks/shared/artifact-save.ts`** -- agent-id keyed
   map (`'designer' | 'planner' | 'tester-plan' | 'tester-report'
   | 'brainstorm'`) stays as-is; none of its entries are
   variant-level, so no change needed beyond validation that the
   keys match `AgentFamily` members (plus `'tester-plan'` /
   `'tester-report'` which are artifact sub-types, not families).
5. **`agent/tasks/*/agent.ts` -- per-agent `AgentDefinition.id`
   constants** -- `tasks/pair/agent.ts` and `tasks/delegate/
   agent.ts` both change their `id` to `'implementation'`, plus
   gain a new `variant: 'pair' | 'delegate'` field for internal
   disambiguation. The framework keys persistence, live-step
   routing, etc. off `(id, variant)` instead of `id` alone.
6. **`agent/index.ts` -- run-registry filters** -- filters like
   `e.agentId === 'pair'` / `'delegate'` become
   `e.agentId === 'implementation'` (plus variant check where
   needed). On daemon boot, persisted rows with
   `agentId: 'pair' | 'delegate'` are migrated in-place to
   `{ agentId: 'implementation', variant: 'pair' | 'delegate' }`.

#### Prompt file names stay variant-level (b-pragmatic)

System prompt file names (`pair-analyze.md`, `pair-propose-${mode}.md`,
`pair-validate.md`, ...) are **prompt assets**, not agent ids.
They remain variant-named and live under the family's config
directory. Renaming them would churn user customizations for no
semantic gain. Similarly, internal controller state keys
(`PAIR_MODE: 'implement' | 'refactor' | 'debug' | 'explore'`)
are runtime implementation details and stay as-is.

#### Migrations (daemon-boot, idempotent)

- **Session rows**: scan `conversation_sessions` / run registry
  for `agentId IN ('pair', 'delegate')`; rewrite to
  `{ agentId: 'implementation', variant: <prior> }`. One-shot,
  no-op on second run.
- **Config directories**: if `~/.insrc/pair/` or
  `~/.insrc/delegate/` exists, copy their contents into
  `~/.insrc/implementation/` (no overwrite on conflict --
  log and skip), then remove the old directories. One-shot.

#### Variant disambiguation helper

A small helper `resolveVariant(family: AgentFamily, ctx):
Variant | undefined` handles the two places ownership is at the
family level but behavior differs per variant (scope routing,
prompt loading). Keeps variant logic internal to each family's
controller module rather than leaking into the framework.

#### Blocks

- Phase 1 (`TodoOwner = AgentFamily` imports the registry).
- Phase 2 (`todos.transfer` target validation walks
  `AGENT_REGISTRY`).
- Phase 3 (`deps.todos` wrapper stamps caller's family id, never
  variant).

No user-visible behavior change; a functional refactor with
migration. Validated by the existing intent / classifier /
agent-run tests.

### Phase 1 -- Types + schema (daemon-only, no UI)

- `shared/todos.ts`: `TodoItem`, `TodoList`, `TodoComment`,
  `TodoTransfer`, status types, owner type, state transition
  table.
- `db/todos.ts`: LanceDB create / query / update helpers. Runs
  `createTodoListsTable` + `createTodoItemsTable` + (Phase 5d)
  `createTodoCommentsTable` at daemon startup if missing (mirrors
  the existing `conversations.ts` pattern). `parent_list_id`
  column + index for fast child enumeration.
- Cycle-detection helper that walks the `parentListId` chain
  from a proposed parent and rejects if the walk reaches the
  target child.
- No RPC yet, no UI. Unit tests for state transitions,
  ordering, cycle detection, and tree queries.

### Phase 2 -- Daemon RPC + stream events

- `todos.*` methods in [daemon/todos-rpc.ts](../src/insrc/daemon/todos-rpc.ts)
  and registered in [daemon/index.ts](../src/insrc/daemon/index.ts)
  (`listForSession`, `create`, `update`, `archive`, `unarchive`,
  `transfer`, `reparent`, `addItem`, `updateItem`, `reorderItem`,
  `removeItem`, `clearCompleted`, `cleanup`). Owner-authorization
  happens inside each handler based on an explicit `caller` param
  (default `'user'`).
- `cleanup` filter validation -- reject unbounded /
  delete-everything queries; age-only queries require at least one
  of `sessionIds` / `statuses` / `sources` alongside them. Non-system
  callers may only filter by `sessionIds` (the agent.discard shape).
- Stream events flow through an in-process bus (`EventEmitter`)
  inside `todos-rpc.ts`. The `todos.subscribe` streaming RPC holds
  a socket open and flushes every event with
  `IpcStreamMessage.stream === 'todos'`. Subscribers see full
  `TodoStreamEvent` objects (`kind` + full list snapshot).
  `cleanup` emits one `listDeleted` per deleted list so UI caches
  can prune cleanly.
- Daily retention job scheduled at daemon boot via
  `scheduleTodosRetention(db)` -- drops archived lists untouched
  for >90 days (`statuses: ['archived'], olderThanDays: 90`).
  Retention days overridable by the future `cleanup.todos.retentionDays`
  config field (not wired yet).

The `todos-api.ts` wrapper (direct in-process access for controllers
via `deps.todos`) and `TaskOrchestratorDeps.todos` plumbing land in
Phase 3. Browser service (`IInsrcTodosService`) consumes the RPC
surface in Phase 4.

### Phase 2b -- `agent.discard` integration

- Thread `todos.cleanup({ sessionIds: [id] })` into the existing
  session-discard purge path (see `plans/session-lifecycle.md`
  Phase 4). Covers discard-from-Runs-sidebar, daemon self-cleanup
  on completed sessions, and the dispose path. One discard, zero
  leftover rows.

### Phase 3 -- Agent hooks (read/mutate todos from any controller)

- `daemon/todos-api.ts` -- thin `TodosApi` wrapper over the
  LanceDB layer (see "Agent integration" above), exposed on
  `TaskOrchestratorDeps.todos` so every `TaskController` can
  call `deps.todos.createList(...)`, `addItem`, `markComplete`,
  etc., without a direct DB import.
- Caller identity auto-stamped from the controller's family id
  (Phase 0 registry). Variants never leak into the `owner` /
  `source` fields; pair and delegate controllers both stamp
  `'implementation'`.
- `todos.transfer` / `todos.reparent` / `todos.addItem` /
  `todos.updateItem` accessible from controller code via the
  same wrapper, with automatic authorization stamping.
- Still headless -- no rendered UI surface in this phase;
  validated by daemon-side integration tests that spin up a
  controller, mutate via `deps.todos`, and verify rows + stream
  events.

### Phase 4 -- Browser service

- `IInsrcTodosService` + impl in
  `electron-sandbox/todosServiceImpl.ts`.
- Session-change and stream-event wiring.
- Still headless -- no rendered UI. Verified via the developer
  console. Ownership-enforcement happens server-side; this layer
  just calls RPCs and surfaces the `owner_mismatch` error to
  callers as a typed reject.

### Phase 5a -- Todos editor pane

- `TodosEditorInput` + `TodosEditorPane` + `TodosListWidget`
  under `browser/todos/`. Same scaffolding as the brainstorm
  step panes; pane subscribes to `IInsrcTodosService` and
  re-renders on `onDidChange` / `onDidChangeList` /
  `onDidRemoveList`.
- Registered in `insrc.contribution.ts` with an `insrc-todos`
  URI scheme. Keyed by sessionId so the editor group dedupes
  duplicate opens.
- Opens via `insrc.todos.open` command (active-session scope).
  `suggestOpenUI` daemon hint and chat-panel header button
  wiring are follow-up work, not required for the read-only
  surface itself.
- **Read-only throughout.** No `+ Add item`, no drag handles,
  no status-cycle on click, no title editors, no archive /
  transfer / reparent affordances. The kebab menu on each list
  card surfaces only read-only actions: copy-as-markdown,
  view-transfer-history, focus-agent-in-chat. Matches the
  "agents own todos, user reviews them" split documented in
  the UI rendering section.
- Each list card is collapsible (chevron in the header).
  Default-collapsed: every item terminal OR `system`-owned.
  Default-expanded: agent-owned list with non-terminal items.
  Collapse state persists per-list in `storageService`.
- Styled from the activity-console palette.

### Phase 5b -- Inline chat todos widget

- `browser/chat/chatTodosWidget.ts`: a `_todoCards` Map keyed by
  list id, same in-place-update pattern as live-step bubbles.
- `chatView` handler adds a `case 'todos':` that routes to the
  widget.
- Renders a compact card (header + status line + item rows) when
  an agent-owned list is created; re-renders the affected row on
  item updates without creating a new chat message.
- Auto-collapse on `status: 'completed'`.
- "Open todos" button jumps to the editor pane for that list.
- "Request transfer" button invokes
  `IInsrcTodosService.transfer(listId, 'user', reason)`.
- User-owned and system-owned lists do NOT render inline.
- CSS class `.insrc-chat-todos-card` paired to the live-console
  palette with a stronger header treatment.

### Phase 5c -- Runs sidebar badge

- Adds a `<span class="todos-pill">N</span>` to each Runs row
  showing the pending-item count for that session.
- Click opens the todos editor pane for that run.
- Pill updates live via `onDidChange` from the todos service.

### Phase 5d -- Comments

- `TodoComment` type in `shared/todos.ts` + item `comments`
  field wiring.
- `todo_comments` LanceDB table (one row per comment, FK to
  `itemId`).
- Four RPCs: `addComment`, `editComment`, `deleteComment`,
  `ackComment`. Authorization:
  - `addComment`: any caller (user + agents) for items on a
    readable list.
  - `editComment` / `deleteComment`: author only.
  - `ackComment`: current owner of the parent list only.
- Stream events extend `'todos'` kind list with `commentAdded`,
  `commentUpdated`, `commentRemoved`.
- Browser service gains comment methods.
- Editor pane renders comments below each item; "Add comment"
  link under every item (user-visible). Comments in a collapsed
  list trigger a badge on the list header so the user can see
  there's outstanding user → agent signal.
- Inline chat widget shows a `💬 N` count on items with
  comments; clicking jumps to the pane focused on that item.
- Unread-by-agent styling: comments without `agentAcknowledged`
  render with a subtle border / "unacked" label until the agent
  processes them.

### Phase 6 -- Migration proof (delegate variant's plan list)

- Port the delegate variant's (of the `implementation` family)
  plan-step list into the framework. List `owner` is
  `'implementation'`; variant info (`'delegate'`) lives in the
  controller, not on the list.
- Remove the bespoke in-memory plan tracking inside the delegate
  codepath.
- Verify the plan-step UX (progress indicator on the current
  step) still works via the generic todos pane.
- This is the reference migration: it proves the framework
  handles the hardest existing shape (ordered steps with status
  + a UI widget). Other families follow in Phase 7.

### Phase 7 -- Broader family adoption

- Brainstorm: surface the review queue / theme-spec queue as TODO
  lists.
- Designer: validate gates become TODO items.
- Planner: its output lands directly into a TODO list the
  `implementation` family can consume as input (handoff flow per
  Item 53).

### Phase 8 -- Factor shared scaffolding with the prompt notepad

Consolidate the infrastructure the todos pane and the prompt
notepad both need, without merging their behaviour:

- Extract `browser/shared/workspacePaneBase.ts` with the
  `EditorInput` + `EditorPane` boilerplate (match-by-sessionId,
  dispose handling, live-update subscription wiring) both panes
  extend. Prompt notepad + todos pane refactored to use it.
- Extract `browser/shared/markdownWidget.ts` -- the Monaco-backed
  markdown composition/rendering surface. Both panes import the
  same widget; notepad uses the read/write variant, todos uses
  the read-only variant.
- Share a single palette-variable module so the two panes stay
  visually consistent without cross-linking their DOM classes.
- **Data model note**: after Phase 9, both surfaces share the
  same todos tables (list / items / comments). The notepad just
  filters to `owner === 'user'`, the pane filters to
  `owner !== 'user'`. No separate notepad table.

### Phase 9 -- User-owned TODOs in the notepad + `withTodo` invocation

Lands the user-side of the framework:

- **Registry**: add `'user'` to `TodoOwner`
  (= `AgentFamily | 'user'` in `shared/todos.ts`).
- **Daemon RPC**: relax `guardListMutation` + `guardListCreation`
  in [todos-rpc.ts](../src/insrc/daemon/todos-rpc.ts) so callers
  with `caller: 'user'` can create, update, add items to,
  archive, and transfer lists where `owner === 'user'`. Agent-
  owned lists stay locked to their family.
- **Read-visibility filter**: `listForSession` + any broad read
  path filter out `owner === 'user'` when the caller is an
  agent family. `'system'` sees everything; `'user'` sees
  everything. Applied both at the RPC layer and inside
  `TodosApi.listForSession` so `deps.todos` reads are safe.
- **Browser service**: expose list / item write methods on
  `IInsrcTodosService` (`createList`, `addItem`, `updateItem`,
  `archive`, `transfer`, etc. -- the full set Phase 5d left out).
  Todos pane stays read-only regardless; the methods are used
  only from the notepad UI.
- **Notepad UI**: extend the existing
  [browser/notepad/](../src/vs/workbench/contrib/insrc/browser/notepad/)
  surface with a "My TODOs" section that lists the user's
  `owner === 'user'` lists for the active session and lets
  the user create / edit / reorder / archive / delete items.
  Compose alongside (not replacing) the existing markdown
  prompt composer.
- **withTodo primitive**:
  - New daemon RPC `todos.forwardToAgent({ targetFamily,
    sessionId, items: TodoSnapshot[] })` in
    [todos-rpc.ts](../src/insrc/daemon/todos-rpc.ts).
  - Spawns a fresh `runAgent` call with `input.todos = items`
    (snapshots, no source ids). Handled by the target
    family's AgentDefinition; its steps consume `ctx.todos`
    + `input.todos` and emit a `TodoInvocationResult` in the
    run result.
  - `AgentDefinition` gains a conventional entry point: if
    `input.todos` is a non-empty `TodoSnapshot[]`, the agent
    routes to its `withTodo` handling step. For this phase, a
    single convention (the planner agent is the simplest
    first consumer): reads the snapshots, creates an agent-
    owned list tracking its work, emits per-snapshot
    `TodoInvocationResponseItem` entries as it processes.
  - Browser `IInsrcTodosService.forwardToAgent(...)` wraps
    the RPC; the notepad's `Forward selected to <agent>`
    button calls it and applies the response statuses via
    `updateItem` on the source items.
- **Plan doc**: this phase replaces any residual "user cannot
  own lists" / "user-only surface is the todos pane comments"
  language that Phases 0-8 left behind.

Build gates after each sub-chunk (registry + RPC relaxation,
browser service, notepad UI, withTodo pipeline).

---

## Future work

Deferred work that's architected around but not shipped in v1.

### Item dependency graph

"Can't start B until A completes." Useful for agent plans where
step ordering carries semantic weight (delegate plan steps have
natural dependencies). v1 interim convention is to use `blocked`
+ `blockedReason: 'waiting on <item-id>'`; the framework doesn't
parse or validate these.

A future phase could add:
- `TodoItem.dependsOn?: readonly string[]` -- ids of other items
  in the same list that must be in `completed` before this one
  can leave `pending`.
- Topological cycle detection at RPC validation time.
- UI affordance on a blocked item showing "waiting on: <ids>"
  with click-to-scroll-to-dependency.

Out-of-scope until at least one agent demonstrates a concrete
need that the `blocked` + free-text pattern doesn't serve.

## Open questions

All design questions resolved in the 2026-04-23 pass. If new ones
surface during Phase 1 implementation they'll land here.
