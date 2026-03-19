# Brainstorm Interaction Model — Per-Idea Discussion Flow

## Context

The current brainstorm flow presents all ideas in a single gate card with batch approve/reject toggles. This creates several UX problems:

1. Users can't discuss or refine individual ideas before deciding
2. Batch review is overwhelming for 10+ ideas
3. User feedback (comments, edits) gets lost in the merge pipeline
4. The approve/reject binary doesn't capture nuance ("this is good but needs X")

## Proposed Flow

### Phase 1: Idea Generation (unchanged)

```
generate-ideas → enhance-ideas-search → enhance-ideas-llm → review-ideas (Claude) → refine-ideas
```

Same pipeline as today. Produces a refined, reviewed idea list.

### Phase 2: Idea List Gate (new interaction model)

After refine, present a **selectable idea list** — not a batch review card.

```
┌─────────────────────────────────────────────────┐
│ 💡 Ideas — Round 1 (8 ideas)                    │
│                                                 │
│  ● [1] Multi-stage search pipeline      strong  │
│  ● [2] Context window management        strong  │
│  ● [3] Intent classifier routing       moderate │
│  ○ [4] Graph relationship expansion      strong  │  ← discussed, accepted
│  ● [5] Prompt sub-question gen          moderate │
│  ○ [6] Confidence-based filtering        strong  │  ← discussed, accepted
│  ● [7] Feedback loop search              strong  │
│  ● [8] /find /explain shortcuts           user   │
│                                                 │
│  ● = pending   ○ = discussed                    │
│                                                 │
│ [Accept remaining]  [Diverge]  [Converge now]   │
└─────────────────────────────────────────────────┘
```

Each idea is clickable. Clicking opens a **discussion sub-flow** for that idea.

### Phase 3: Per-Idea Discussion (new)

When user clicks on an idea, the gate card transitions to a **focused discussion view**:

```
┌─────────────────────────────────────────────────┐
│ Discussing: [3] Intent classifier routing       │
│ Verdict: moderate                               │
│ Rationale: "Feasible but partially exists..."   │
│                                                 │
│ ┌─ Code Context ──────────────────────────────┐ │
│ │ [function] categorizeTask (classifier.ts)   │ │
│ │ [interface] ClassificationResult            │ │
│ │ [type] Intent                               │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ 💬 Discussion:                                  │
│ ┌─────────────────────────────────────────────┐ │
│ │ (type your thoughts, questions, direction)  │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ [Accept]  [Reject]  [Refine]  [Back to list]    │
└─────────────────────────────────────────────────┘
```

**Actions in discussion view:**
- **Accept** — Mark idea as accepted, return to list
- **Reject** — Mark idea as rejected (removed), return to list
- **Refine** — Send user's discussion text + idea + code context to local LLM → returns improved version → user can accept/reject the refinement
- **Back to list** — Return without deciding (idea stays pending)

**Discussion messages** flow through `chat.inject`:
- User types in the discussion input → `chat.inject` RPC
- Controller receives injected message, associates with the focused idea
- Optionally triggers a local LLM response (contextual to this idea)
- Response streams back as a chat message within the discussion view

### Phase 4: List Resolution

From the list view, global actions:
- **Accept remaining** — Accept all pending ideas, proceed
- **Diverge** — Generate more ideas (rejected ideas inform the gap analysis)
- **Converge now** — Accept all pending + already accepted, start convergence

After resolution, the flow continues as today: converge → theme spec → assemble → present.

## Implementation

### Controller State Changes

```typescript
// New fields on BrainstormState
focusedIdeaId?: string | undefined;       // ID of idea currently being discussed
discussionMessages?: Array<{              // Messages in current discussion
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}> | undefined;
```

### New Steps in Dispatch

| Step | Kind | Description |
|------|------|-------------|
| `idea-list` | gate (transform) | Present selectable idea list, wait for user action |
| `idea-discuss` | gate (transform) | Focused discussion view for one idea |
| `idea-discuss-respond` | llm | Local LLM responds to user's discussion message |
| `idea-discuss-refine` | llm | Local LLM refines idea based on discussion |
| `idea-discuss-search` | rpc | Vector search for focused idea's code context |

### Flow State Machine

```
afterRefineIdeas
    │
    ▼
idea-list (gate)
    │
    ├─ action='discuss' + ideaId  ──→ idea-discuss-search (RPC)
    │                                      │
    │                                      ▼
    │                                idea-discuss (gate)
    │                                      │
    │                                      ├─ action='accept'  ──→ idea-list
    │                                      ├─ action='reject'  ──→ idea-list
    │                                      ├─ action='refine'  ──→ idea-discuss-refine (LLM) ──→ idea-discuss
    │                                      ├─ action='back'    ──→ idea-list
    │                                      └─ inject message   ──→ idea-discuss-respond (LLM) ──→ idea-discuss
    │
    ├─ action='accept-remaining'   ──→ handleIdeaApprove (as today)
    ├─ action='diverge'            ──→ startIdeationRound (as today)
    └─ action='converge'           ──→ convergence phase (as today)
```

### Input Area Context Banner

When an idea is selected for discussion, the **main chat input area** gains a **context banner** above the text input box:

```
┌─────────────────────────────────────────────────┐
│ 📌 Discussing: [3] Intent classifier routing    │
│    moderate — "Feasible but partially exists..." │
│    tags: routing, intent-classification          │
│                                              [✕] │
├─────────────────────────────────────────────────┤
│ Type your message...                            │
└─────────────────────────────────────────────────┘
```

**How it works:**
- When the controller enters `idea-discuss` state, it sends a `context.set` stream message with the focused idea object
- The webview renders the idea as a compact context banner above the input
- Every `chat.inject` message automatically includes the idea context (id, text, verdict, code refs) — the controller doesn't need to re-fetch it
- When the user returns to the list (`action='back'` or `action='accept'`), the controller sends `context.clear` and the banner disappears
- The `[✕]` dismiss button sends `action='back'` to return to the idea list

**Stream protocol:**
```typescript
// Brainstorm session lifecycle
{ stream: 'brainstorm.session', data: {
  brainstormId: string;
  chatSessionId: string;
  category: BrainstormCategory;
  prompt: string;
  status: 'active' | 'suspended' | 'completed';
  resumedFrom?: string;    // brainstormId if this is a resume
}}

// Set context banner (idea focus)
{ stream: 'context.set', data: {
  ideaId: string;
  ideaIndex: number;
  text: string;
  verdict: 'strong' | 'moderate' | 'user';
  rationale: string;
  tags: string[];
  codeRefs: string[];
}}

// Clear context banner
{ stream: 'context.clear', data: {} }
```

### Backend Session Handling (chat-handler.ts)

When the decomposer identifies `intent: 'brainstorm'`:

1. **Create new chat session** — new session ID, tagged with `type: 'brainstorm'`
2. **Emit `brainstorm.session` stream** — tells the UI this is a brainstorm session
3. **On each step completion** — checkpoint written to `sessions/<id>/brainstorm.json`
4. **On complete** — mark checkpoint `completed: true`

**On session open** (existing `chat.open` RPC):
- If `brainstorm.json` exists and `completed: false` → resume the brainstorm pipeline
- If `completed: true` → read-only, show the final output

### UI Session Handling (chatPanel.ts / chat.html)

**On `brainstorm.session` stream received:**
- Show session banner at top of chat: "Brainstorm: \<prompt snippet\>"
- Session appears in the session list sidebar like any other chat session

**On session open (reconnect / reopen):**
- Daemon detects brainstorm checkpoint → resumes pipeline → re-emits last gate card
- UI renders gate card as normal — no special handling needed

**Controller-side:** Every injected message received while `focusedIdeaId` is set gets the idea prepended to the LLM prompt automatically — the user's message is always grounded in the idea they're discussing.

### Gate Card Changes (Webview)

**Idea List Gate:**
- Each idea rendered as a clickable row (not toggle)
- Visual status: ● pending, ○ discussed/accepted, ✕ rejected
- Click on row → sends `gateReply` with `action: 'discuss'` and `feedback: ideaId`
- Verdict badge (strong/moderate/user) shown per row
- Bottom action bar: Accept remaining, Diverge, Converge now

**Discussion Gate:**
- Header: idea text, verdict, rationale (mirrors the context banner but expanded)
- Code context panel (collapsed, from per-idea search)
- Discussion history (messages exchanged so far)
- Input is the main chat input with the context banner active (not a separate input)
- Action bar: Accept, Reject, Refine, Back to list

### Key Design Decisions

1. **Discussion is per-idea, not per-theme** — Users think in terms of ideas during ideation. Themes come later in convergence.

2. **Discussion state is transient** — `discussionMessages` is cleared when returning to the list. The final accepted/rejected/refined state is what matters.

3. **Refine within discussion uses local LLM** — No Claude call for per-idea refinement. Keep it fast and cheap. Claude reviews the full batch only once (after generate).

4. **Injected messages during discussion go to the focused idea** — Controller knows `focusedIdeaId` and routes accordingly.

5. **The list gate is re-enterable** — User can discuss multiple ideas across multiple list → discuss → list cycles before resolving.

6. **Discussed ideas keep their verdict** — If Claude said "moderate", the discussion refine can upgrade it but doesn't reset the review.

## Migration

- The `buildIdeaReviewGate()` method is replaced by `buildIdeaListGate()`
- `afterIdeaReview()` is replaced by `afterIdeaList()` + `afterIdeaDiscuss()`
- Gate tab rendering in `chat.html` gains a new mode: `selectable-list` (clickable rows)
- Existing batch toggles (approve/reject per item) are removed
- Comment fields per item are removed (replaced by free-text discussion)

## Files

| File | Change |
|------|--------|
| `src/daemon/controllers/brainstorm/base.ts` | New steps: `idea-list`, `idea-discuss`, `idea-discuss-respond`, `idea-discuss-refine`, `idea-discuss-search`. New handlers. Replace `buildIdeaReviewGate` with `buildIdeaListGate`. |
| `src/agent/tasks/brainstorm/agent-state.ts` | Add `focusedIdeaId`, `discussionMessages` fields |
| `src/agent/tasks/brainstorm/prompts.ts` | Add `DISCUSS_RESPOND_SYSTEM`, `DISCUSS_REFINE_SYSTEM` prompts |
| `src/daemon/task.ts` | Support `selectable-list` gate tab type |
| `vscode-insrc/src/webview/chat.html` | Selectable list rendering, discussion view, context banner above input, `context.set`/`context.clear` handlers |
| `vscode-insrc/src/ui/chatPanel.ts` | Handle discuss action, wire inject during discussion, forward `context.set`/`context.clear` to webview |

## Persistence Model

Brainstorm sessions are long-running (10–30 minutes) and span multiple LLM calls, gate interactions, and discussion loops. A crash, restart, or accidental tab close should not lose progress.

### Session Lifecycle

When the intent classifier identifies a `brainstorm` intent, a **new chat session** is created automatically. The brainstorm owns the entire session — no mixing with other intents.

- Brainstorm state is checkpointed against the chat session ID
- One brainstorm per chat session, always
- If the user sends a brainstorm prompt in an existing non-brainstorm session, the daemon creates a new chat session and redirects
- Resume = reopen the chat session

### Checkpoint Strategy

The controller writes a **checkpoint after every state-changing step** — same pattern as the agent framework's `checkpoint.ts`.

```typescript
interface BrainstormCheckpoint {
  /** Chat session ID (brainstorm owns the session). */
  sessionId: string;
  /** Controller state (full BrainstormState snapshot). */
  state: BrainstormState;
  /** The lastStep value — determines which handler runs on resume. */
  lastStep: string;
  /** Task counter — so resumed tasks get unique indices. */
  taskCounter: number;
  /** ISO timestamp of last checkpoint. */
  timestamp: string;
  /** Whether the session completed (finalized). */
  completed: boolean;
}
```

### Storage Location

```
~/.insrc/sessions/<sessionId>/brainstorm.json
```

- Lives alongside the existing chat session data (turns, etc.)
- One file, overwritten atomically on each checkpoint (tmp + rename)
- Completed sessions pruned after 7 days by daemon on startup
- Active (incomplete) sessions kept indefinitely

### Checkpoint Timing

| Event | Checkpoint? | Why |
|-------|-------------|-----|
| `buildInitialTasks()` | Yes | Session created |
| After every `next()` call that returns tasks | Yes | State changed |
| After gate reply processed | Yes | User input captured |
| After `finalize()` | Yes | Mark completed |
| During discussion (after each response) | Yes | Discussion messages captured |

### Resume Flow

On resume (daemon restart, VS Code reconnect, user reopens the session):

1. `chatPanel.ts` restores session ID from `globalState`
2. Sends `chat.open` RPC with session ID (existing flow)
3. Daemon detects `brainstorm.json` checkpoint exists for this session
4. Reconstructs `BrainstormControllerBase` with restored state
5. Re-emits the last gate card (if `lastStep` was a gate step)
6. If `lastStep` was an LLM step, re-runs it (LLM calls are not cached)

```
┌─────────────┐     ┌──────────┐     ┌──────────────────────────┐
│ VS Code     │────→│ Daemon   │────→│ sessions/<id>/            │
│ opens       │     │ finds    │     │   brainstorm.json         │
│ session     │←────│ re-emits │     │   turns.json (chat data)  │
│ gate card   │     │ last gate│     └──────────────────────────┘
└─────────────┘     └──────────┘
```

### What's NOT Persisted

- Streaming delta state (partial LLM output) — if interrupted mid-stream, the task re-runs
- Webview DOM state — rebuilt from the checkpoint's gate content
- `themeSearchContext` — re-fetched on the next theme spec step

### Crash Recovery

If the daemon crashes mid-LLM-call:
1. Daemon restarts, loads checkpoint (last good state)
2. `lastStep` points to the step that was in progress
3. `next()` is called with a synthetic failed `TaskResult`
4. Controller can retry or skip based on the step type

If the daemon crashes mid-gate:
1. Checkpoint already written (gate is a step boundary)
2. Resume re-emits the gate card
3. User sees the same gate they were looking at — no data loss

### Implementation Notes

- **Atomic writes**: Use `writeFileSync` to a temp file, then `renameSync` — prevents half-written checkpoints
- **Session pruning**: `daemon/lifecycle.ts` prunes completed sessions older than 7 days on startup
- **Chat session binding**: The brainstorm session ID matches the chat session ID — the chat panel already persists session IDs in `globalState`
- **Discussion messages**: Part of `BrainstormState`, so they're checkpointed automatically when the state is saved

### Files

| File | Change |
|------|--------|
| `src/daemon/controllers/brainstorm/base.ts` | Write checkpoint after each `next()` return |
| `src/daemon/controllers/brainstorm/checkpoint.ts` | New: `BrainstormCheckpoint`, `saveCheckpoint()`, `loadCheckpoint()` — uses existing framework checkpoint pattern |
| `src/daemon/task.ts` | Call `controller.checkpoint?.()` after each task completes |
| `src/daemon/chat-handler.ts` | Create new chat session on brainstorm intent; detect checkpoint on session open → resume |
| `src/daemon/lifecycle.ts` | Prune completed brainstorm checkpoints older than 7 days on startup |

## Verification

1. Start brainstorm → ideas generated → list gate appears with clickable rows
2. Click idea → discussion view opens with code context
3. Type discussion message → LLM responds contextually
4. Click Refine → idea text updated → shown in discussion view
5. Click Accept → return to list, idea marked ○
6. Click Accept remaining → all pending accepted, flow continues
7. Click Diverge → new round generates ideas, list re-presented
8. Click Converge → convergence phase starts
9. Verify: accepted ideas carry through to convergence unchanged
10. Verify: rejected ideas excluded from convergence
11. Kill daemon mid-discussion → restart → resume → same gate card appears
12. Kill daemon mid-LLM-call → restart → resume → task re-runs, result appears
13. Close VS Code → reopen → resume → session continues from last checkpoint
14. Verify: completed sessions pruned after 7 days
