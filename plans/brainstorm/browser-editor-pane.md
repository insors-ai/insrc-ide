# Brainstorm Editor Pane — Native Implementation

## Overview

Brainstorm sessions open in the **main editor panel** (not the chat window). Ideas and themes are presented as **cards**, one at a time, with focused discussion and user feedback per item.

## UX Flow

### Phase 1: Ideation (Seed + Diverge)

```
┌─────────────────────────────────────────────────────────┐
│ [insrc icon] Brainstorm: Cache Strategy    [+ Add Idea] │
│ ─────────────────────────────────────────────────────── │
│                                                         │
│ Idea 3 of 8                              [◀ Prev] [Next ▶] │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ┌ Title ──────────────────────────────────────────┐ │ │
│ │ │ Redis-backed distributed cache with TTL tiers   │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ │                                                     │ │
│ │ ┌ Description ────────────────────────────────────┐ │ │
│ │ │ Use Redis with configurable TTL tiers:          │ │ │
│ │ │ - Hot (5min): frequently accessed entities      │ │ │
│ │ │ - Warm (1hr): graph query results               │ │ │
│ │ │ - Cold (24hr): embedding vectors                │ │ │
│ │ │ Invalidation via pub/sub on index events.       │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ │                                                     │ │
│ │ ┌ References ─────────────────────────────────────┐ │ │
│ │ │ 📄 src/db/search.ts:45 — current query path    │ │ │
│ │ │ 📄 src/indexer/watcher.ts — invalidation events │ │ │
│ │ │ 🔗 Redis TTL documentation                      │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ │                                                     │ │
│ │ ┌ Discussion ─────────────────────────────────────┐ │ │
│ │ │ [Agent] This aligns with the existing watcher   │ │ │
│ │ │ events in indexer. The pub/sub invalidation      │ │ │
│ │ │ would need a new channel per repo.               │ │ │
│ │ │                                                   │ │ │
│ │ │ [You] What about memory overhead for embeddings? │ │ │
│ │ │                                                   │ │ │
│ │ │ [Agent] At 2048 dims * 4 bytes * 10K entities,  │ │ │
│ │ │ cold tier would need ~80MB. Acceptable for most  │ │ │
│ │ │ repos, but consider LRU eviction for large ones. │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ │                                                     │ │
│ │ ┌ Your feedback ──────────────────────────────────┐ │ │
│ │ │ [Type your thoughts or questions...]         [➤] │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ │                                                     │ │
│ │ [✓ Approve] [✗ Reject] [↻ Diverge] [⏭ Skip] [P Park] │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Progress: ✓✓•✗✓○○P    Approved: 4  Rejected: 1  Parked: 1 │
└─────────────────────────────────────────────────────────┘
```

### Flow Rules

1. **One idea at a time** — user sees a single idea card with full detail
2. **Discussion per idea** — user can ask questions, the local LLM responds in context
3. **Actions per idea:**
   - **Approve** — accept idea, move to next
   - **Reject** — discard idea, move to next
   - **Diverge** — ask LLM to generate variations/alternatives, adds to queue
   - **Skip** — move to next without deciding (come back later)
   - **Park** — set aside, review after all others are resolved
4. **Parked ideas** — after all non-parked ideas are resolved, parked ideas are presented again
5. **Add idea** — user can add their own idea at any point via [+ Add Idea] button
6. **Navigation** — Prev/Next arrows to revisit decided ideas (read-only unless user clicks "Reopen")

### Phase 2: Convergence (Themes)

Once all ideas are approved/rejected/parked-resolved:

```
┌─────────────────────────────────────────────────────────┐
│ [insrc icon] Brainstorm: Cache Strategy — Themes        │
│ ─────────────────────────────────────────────────────── │
│                                                         │
│ Theme 1 of 3                                            │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ┌ Theme ──────────────────────────────────────────┐ │ │
│ │ │ Caching Infrastructure                          │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ │                                                     │ │
│ │ ┌ Merged Ideas ───────────────────────────────────┐ │ │
│ │ │ ✓ Redis-backed distributed cache with TTL tiers │ │ │
│ │ │ ✓ In-memory LRU cache for hot entities          │ │ │
│ │ │ ✓ Cache warming on repo index completion        │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ │                                                     │ │
│ │ ┌ Rationale ──────────────────────────────────────┐ │ │
│ │ │ These three ideas form a layered cache strategy  │ │ │
│ │ │ with in-process LRU → Redis → DB fallback.      │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ │                                                     │ │
│ │ ┌ Discussion ─────────────────────────────────────┐ │ │
│ │ │ [Agent] The layered approach minimizes Redis     │ │ │
│ │ │ round-trips for the most common queries.         │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ │                                                     │ │
│ │ ┌ Your feedback ──────────────────────────────────┐ │ │
│ │ │ [Type your thoughts...]                      [➤] │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ │                                                     │ │
│ │ [✓ Approve] [✗ Reject] [↻ Split] [✏ Edit] [⏭ Skip] │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ Progress: •○○    Approved: 0                            │
└─────────────────────────────────────────────────────────┘
```

### Theme Actions
- **Approve** — accept theme grouping
- **Reject** — discard theme (ideas go back to unthemed pool)
- **Split** — break theme into smaller themes
- **Edit** — rename or restructure the theme
- **Skip** — come back later

### Phase 3: Output Generation

Once all themes approved, LLM generates the final document (spec/plan/design based on category). Shown in a preview pane with approve/edit/regenerate actions.

## Architecture

### Components

```
src/vs/workbench/contrib/insrc/browser/brainstorm/
  brainstormEditorInput.ts      — EditorInput (URI: insrc-brainstorm:/{sessionId})
  brainstormEditorPane.ts       — EditorPane with card layout
  brainstormCardWidget.ts       — Reusable card widget (idea or theme)
  brainstormProgressWidget.ts   — Progress bar with status icons
  brainstormRegistration.ts     — Commands, menu contributions
  media/brainstorm.css          — Styles
```

### EditorPane Layout

The `BrainstormEditorPane` extends `EditorPane` and renders:

1. **Header bar** — title, phase label, [+ Add Idea] button
2. **Card area** — single `BrainstormCardWidget` showing current item
3. **Progress bar** — bottom strip with status indicators

### BrainstormCardWidget

Reusable for both ideas and themes:

```typescript
interface CardData {
  id: string;
  title: string;
  body: string;           // markdown, rendered as HTML
  references: CardRef[];  // file paths (clickable) + URLs
  discussion: ChatMessage[];
  status: 'pending' | 'approved' | 'rejected' | 'skipped' | 'parked';
}

interface CardRef {
  type: 'file' | 'url';
  path: string;           // file path or URL
  label: string;          // display text
  line?: number;          // optional line number for file refs
}
```

The widget renders:
- Title section (editable via inline rename)
- Body section (rendered HTML, scrollable)
- References section (clickable links — files open in editor, URLs open in browser)
- Discussion section (chat-like bubbles, scrollable)
- Input area (text input + send button)
- Action buttons (Approve/Reject/Diverge/Skip/Park)

### Data Flow

```
User opens brainstorm → BrainstormEditorPane created
  → chatService.startSession(repo) with intent=brainstorm
  → daemon creates brainstorm controller
  → seed ideas generated
  → stream: progress messages during generation
  → stream: ideas arrive as structured data (not HTML)
  → EditorPane renders first idea card

User discusses idea:
  → input text sent via chatService.sendMessage() with context
  → daemon: local LLM responds in idea context
  → response streamed back, appended to discussion

User clicks Approve:
  → chatService.replyToGate(gateId, 'approve')
  → daemon controller advances to next idea
  → EditorPane updates card with next idea

User clicks Diverge:
  → chatService.replyToGate(gateId, 'diverge', feedback)
  → daemon: LLM generates variations
  → new ideas added to queue
  → card count updated, user stays on current idea

User clicks Park:
  → idea status set to 'parked'
  → move to next pending idea
  → after all others resolved, parked ideas presented again

All ideas resolved:
  → daemon triggers convergence
  → stream: themes arrive as structured data
  → EditorPane switches to theme mode
  → same card-by-card flow for themes

All themes approved:
  → daemon generates final document
  → stream: document preview
  → EditorPane shows preview with Approve/Edit/Regenerate
```

### Stream Message Protocol

New stream message types for brainstorm:

```typescript
// Daemon → IDE stream messages
type BrainstormStreamMessage =
  | { type: 'brainstorm.ideas'; ideas: IdeaData[] }
  | { type: 'brainstorm.themes'; themes: ThemeData[] }
  | { type: 'brainstorm.focus'; itemId: string }
  | { type: 'brainstorm.discussion'; itemId: string; message: ChatMessage }
  | { type: 'brainstorm.status'; itemId: string; status: string }
  | { type: 'brainstorm.progress'; phase: string; counts: ProgressCounts }
  | { type: 'brainstorm.preview'; content: string; format: 'html' | 'markdown' }
  | { type: 'brainstorm.done'; outputPath: string }

interface IdeaData {
  id: string;
  title: string;
  body: string;
  references: CardRef[];
  status: 'pending' | 'approved' | 'rejected' | 'skipped' | 'parked';
  round: number;
  source: 'seed' | 'diverge' | 'user';
}

interface ThemeData {
  id: string;
  name: string;
  rationale: string;
  ideaIds: string[];
  status: 'pending' | 'approved' | 'rejected' | 'skipped';
}

interface ProgressCounts {
  total: number;
  approved: number;
  rejected: number;
  skipped: number;
  parked: number;
  pending: number;
}
```

### Gate Integration

The brainstorm controller sends structured gates, not HTML:

```typescript
// Gate for idea review
{
  type: 'gate',
  gateId: 'idea-review-3',
  title: 'Review Idea: Redis-backed cache',
  actions: ['approve', 'reject', 'diverge', 'skip', 'park'],
  data: {
    phase: 'ideation',
    itemId: 'idea-3',
    itemType: 'idea'
  }
}
```

The EditorPane handles gates by updating the card's action state, not by rendering a gate card in the chat.

### Discussion (Per-Idea Chat)

Each idea card has a mini-chat:

1. User types in the feedback input area
2. Message sent to daemon with context: `{ sessionId, ideaId, message }`
3. Daemon's brainstorm controller routes to local LLM with:
   - Idea content as context
   - Code references resolved from graph
   - Prior discussion messages
4. LLM response streamed back via `brainstorm.discussion` message
5. Appended to the card's discussion section

The discussion is **transient** — cleared when moving to next idea. Only the final verdict (approve/reject) and any feedback text persist in the brainstorm state.

### Add Idea

User clicks [+ Add Idea]:

1. Modal or inline form: title + body (body is optional)
2. New idea added with `source: 'user'`, `status: 'pending'`
3. Inserted into the queue (after current idea)
4. Card count updated
5. Daemon notified via RPC: `brainstorm.addIdea`

### Navigation

- **Prev/Next arrows** — navigate through all ideas
- Decided ideas shown as read-only cards with verdict badge
- **Reopen button** on decided cards — changes status back to pending

### Persistence

- BrainstormState checkpointed after every action (approve/reject/etc.)
- Session ID stored in IStorageService
- Resume: reopen EditorPane → restore state → show next pending idea

## Backend Changes Required

### 1. Idea Data Model Enhancement (`agent/tasks/brainstorm/types.ts`)

Current `Idea.text` is a flat blob — title and body are mixed. Needs structured fields:

```typescript
// BEFORE
interface Idea {
  index: number;
  id: string;
  text: string;               // flat text, no structure
  codeRefs?: string[];        // unstructured strings from enhance step
  // ...
}

// AFTER
interface Idea {
  index: number;
  id: string;
  title: string;              // short descriptive title (1 line)
  body: string;               // detailed description (markdown)
  references: IdeaRef[];      // structured code/doc references
  source: 'seed' | 'diverge' | 'user' | 'refine';
  // ... (status, round, review fields unchanged)
}

interface IdeaRef {
  type: 'code' | 'doc' | 'url';
  path: string;               // file path or URL
  label: string;              // display text ("search.ts:45 -- query executor")
  line?: number;              // line number for code refs
  snippet?: string;           // short code excerpt (2-3 lines)
}
```

**Files affected:**
- `agent/tasks/brainstorm/types.ts` -- add IdeaRef, update Idea interface
- `agent/tasks/brainstorm/prompts.ts` -- update SEED_SYSTEM, DIVERGE_SYSTEM to instruct LLM to output title + body separately
- `agent/tasks/brainstorm/ideas.ts` -- update `parseIdeaList()` to parse structured output (title/body split)
- `agent/tasks/brainstorm/context-builder.ts` -- `formatIdeasForContext()` uses title + body instead of text
- `daemon/controllers/brainstorm/base.ts` -- enhance step populates `references[]` with IdeaRef from vector search results

**LLM output format change (seed/diverge prompts):**

```
### Idea 1
**Title:** Redis-backed distributed cache with TTL tiers
**Body:** Use Redis with configurable TTL tiers for different data types.
Hot tier (5min TTL) for frequently accessed entities, warm tier (1hr)
for graph query results, cold tier (24hr) for embedding vectors.
Invalidation via pub/sub on index events.
**References:** cache invalidation patterns, TTL-based eviction

### Idea 2
**Title:** ...
```

Parser extracts title from `**Title:**` line, body from `**Body:**` block, LLM-suggested reference keywords from `**References:**` line. The enhance step then resolves reference keywords to actual `IdeaRef[]` via vector search.

### 2. Backward Compatibility (`text` field)

The `text` field is used in ~30 places across the codebase. Strategy:
- Keep `text` as a computed getter: `get text(): string { return this.title + '\n' + this.body; }`
- Or add a `toText()` method and migrate callers incrementally
- All new code uses `title` + `body` directly

### 3. Gate Data Format (backward compat)

Gates send both HTML (for chat fallback) and structured data (for editor pane):

```typescript
// In gateTaskResult(), add data field to gate stream message
send({
  id: requestId,
  stream: 'gate',
  data: {
    gateId,
    title,
    actions,
    content: htmlContent,           // existing: HTML for chat view
    structured: {                    // NEW: typed data for editor pane
      phase: 'ideation' | 'convergence' | 'preview',
      ideas: IdeaData[],            // for ideation phase
      currentIndex: number,
      themes: ThemeData[],          // for convergence phase
      preview: string,              // for preview phase
      progress: ProgressCounts
    }
  }
});
```

### 4. Sequential Idea Review (controller state machine)

Current `idea-list` gate sends ALL ideas at once. For the editor pane:

- After refine step, controller enters `idea-review-sequential` mode
- Emits `brainstorm.ideas` stream message with all ideas
- Then emits `brainstorm.focus` with first pending idea ID
- Each gate reply (approve/reject/skip/park) triggers:
  - Update idea status in state
  - Emit `brainstorm.status` with updated status
  - Emit `brainstorm.focus` with next pending idea ID
  - If no more pending ideas: check parked → re-present parked, or proceed to converge
- Diverge action: generates new ideas, adds to queue, emits `brainstorm.ideas` update

State tracking additions:
```typescript
// In BrainstormState
reviewQueue: string[];           // ordered list of idea IDs to review
currentReviewIndex: number;      // index into reviewQueue
parkedIds: string[];             // parked idea IDs (review after others)
```

### 5. New RPCs

| RPC | Params | Description |
|-----|--------|-------------|
| `brainstorm.addIdea` | `{ sessionId, title, body }` | User adds idea, inserted into queue |
| `brainstorm.discuss` | `{ sessionId, ideaId, message }` | Per-idea discussion message |
| `brainstorm.reopen` | `{ sessionId, ideaId }` | Reopen decided idea |
| `brainstorm.skip` | `{ sessionId, ideaId }` | Skip idea (review later) |
| `brainstorm.park` | `{ sessionId, ideaId }` | Park idea (after all others) |

### 6. Spec Panel (right sidebar in editor pane)

The spec builds incrementally during convergence. The controller already generates per-theme spec sections. For the editor pane:

- After each `review-theme-spec` step, emit `brainstorm.spec-section` with the polished section
- Editor pane appends to the spec panel (right side)
- After `assemble-spec`, emit `brainstorm.preview` with the full assembled document

## Implementation Order

### Phase 0: Backend — Idea Data Model
1. Update `Idea` interface: `text` → `title` + `body` + `references: IdeaRef[]`
2. Update seed/diverge prompts: instruct LLM to output title/body/references separately
3. Update `parseIdeaList()` to parse structured output
4. Update `formatIdeasForContext()` to use title + body
5. Backward compat: `get text()` computed getter or `toText()` helper
6. Update enhance step: populate `references[]` with `IdeaRef` from search results
7. Add `source` field: 'seed' | 'diverge' | 'user' | 'refine'

### Phase 1: Backend — Sequential Review + RPCs
8. Add `reviewQueue`, `currentReviewIndex`, `parkedIds` to BrainstormState
9. Add sequential review mode to controller: one gate per idea
10. Add park/skip/reopen status transitions
11. Parked idea re-presentation after queue exhausted
12. Register RPCs: brainstorm.addIdea, brainstorm.discuss, brainstorm.reopen
13. Emit structured stream messages: brainstorm.ideas, brainstorm.focus, brainstorm.status, brainstorm.progress

### Phase 2: Frontend — EditorPane Shell
14. `brainstormEditorInput.ts` — URI scheme `insrc-brainstorm`
15. `brainstormEditorPane.ts` — layout: header + card area + spec panel + progress
16. `brainstormRegistration.ts` — command, EditorPaneDescriptor
17. `media/brainstorm.css` — card styles matching theme

### Phase 3: Frontend — Card Widget
18. `brainstormCardWidget.ts` — renders title, body, references, discussion, input, actions
19. Wire card actions → `chatService.replyToGate()`
20. Wire discussion input → `brainstorm.discuss` RPC
21. References clickable → `IEditorService.openEditor()` for files
22. `brainstormProgressWidget.ts` — progress strip with status icons

### Phase 4: Frontend — Data Flow
23. Subscribe to `brainstorm.*` stream messages in EditorPane
24. Update card on `brainstorm.focus` / `brainstorm.discussion` / `brainstorm.status`
25. Update progress bar on `brainstorm.progress`
26. Phase transition (ideation → convergence → preview)
27. Spec panel: append sections on `brainstorm.spec-section`

### Phase 5: Frontend — Polish
28. [+ Add Idea] form (inline: title + body inputs)
29. Navigation (prev/next with read-only decided cards + reopen)
30. Convergence: theme cards with same one-at-a-time flow
31. Output preview pane with approve/edit/regenerate
32. Resume from checkpoint (BrainstormState → EditorPane restore)

## Dependencies

- `IInsrcChatService` — session management, gate replies, streaming
- `IInsrcDaemonService` — RPC for addIdea, discuss
- `IEditorService` — open file references in editor
- `BrainstormControllerBase` — daemon-side controller (already exists)
- Brainstorm agent modules — prompts, parsing, templates (already exist)

## Files

| File | Type | Description |
|------|------|-------------|
| `browser/brainstorm/brainstormEditorInput.ts` | New | EditorInput for brainstorm URI scheme |
| `browser/brainstorm/brainstormEditorPane.ts` | New | EditorPane with card layout |
| `browser/brainstorm/brainstormCardWidget.ts` | New | Reusable card widget |
| `browser/brainstorm/brainstormProgressWidget.ts` | New | Progress bar strip |
| `browser/brainstorm/brainstormRegistration.ts` | New | Commands + EditorPaneDescriptor |
| `browser/brainstorm/media/brainstorm.css` | New | Styles |
| `browser/insrc.contribution.ts` | Modify | Import brainstorm registration |
| `daemon/controllers/brainstorm/base.ts` | Modify | Emit structured stream messages |
| `daemon/index.ts` | Modify | Register brainstorm.addIdea, brainstorm.discuss RPCs |
