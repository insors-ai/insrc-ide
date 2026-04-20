# EditorPane (stage 4)

Requirements EditorPane with three modes: list-review (accordion),
tree-browse (sidebar of the requirements/_index.json tree),
sub-section handoff (deep-link buttons).

## Files

| File | Purpose |
|---|---|
| `src/vs/workbench/contrib/insrc/browser/requirements/requirementsEditorPane.ts` | EditorPane shell + mode switcher |
| `src/vs/workbench/contrib/insrc/browser/requirements/requirementsEditorInput.ts` | `EditorInput` carrier (mode + payload) |
| `src/vs/workbench/contrib/insrc/browser/requirements/requirementsCommands.ts` | Palette entries + `insrc.requirements.continueInNewChat` |
| `src/vs/workbench/contrib/insrc/browser/requirements/listReviewView.ts` | Accordion list-review renderer |
| `src/vs/workbench/contrib/insrc/browser/requirements/treeBrowseView.ts` | Hierarchical tree renderer |
| `src/vs/workbench/contrib/insrc/browser/requirements/handoffView.ts` | Per-sub-section deep-link row renderer |
| `src/vs/workbench/contrib/insrc/browser/insrc.contribution.ts` | Register pane + input + auto-open contribution |
| `src/vs/workbench/contrib/insrc/browser/media/insrc-shared.css` | Extend with `.insrc-accordion-*` classes if not already covered |

Follow the patterns established by
`browser/brainstorm/brainstormEditorPane.ts` and
`browser/models/modelProvidersPane.ts`. Use the shared `insrc-*`
widget classes (`.insrc-card`, `.insrc-chip`, `.insrc-banner`,
`.insrc-btn*`) from `media/insrc-shared.css`.

## Input shape

```typescript
// requirementsEditorInput.ts
import { EditorInput } from '../../../../common/editor/editorInput.js';

export type PaneMode = 'list-review' | 'tree-browse' | 'handoff';

export interface RequirementsInputState {
  mode: PaneMode;
  /** For 'list-review' mode: the gate payload. */
  listPayload?: ListReviewGatePayload;
  /** For 'list-review' mode: a callback to resolve the gate once the
   *  user approves/rejects. The chat service wires this via the
   *  existing gate registration mechanism -- see runner.ts. */
  onListResolve?: (reply: ListReviewGateReply) => void;
  /** For 'tree-browse' + 'handoff': path to requirements/_index.json. */
  indexPath?: string;
  /** For 'handoff': the current sub-epic-list + their parent. */
  handoffPayload?: {
    parentId: string;
    parentTitle: string;
    subEpics: Array<{ id: string; title: string; description: string }>;
  };
}
```

The input carries the current mode + the payload for that mode. The
pane re-renders when `setInput()` is called with a new state.

## Mode 1 -- list-review accordion

Consumes `ListReviewGatePayload` from
`agent/tasks/requirements/types.ts` (see `agent-core.md`):

```typescript
interface ListReviewGatePayload {
  kind: 'sub-epic-list' | 'story-list' | 'feature-list' | 'nfr-list' | 'reconciliation-plan';
  items: ListReviewItem[];
  bulkActions: Array<'approve-all' | 'reject-all' | 'regenerate'>;
}

interface ListReviewGateReply {
  items: Array<{
    id: string;
    decision: 'approve' | 'reject';
    feedback?: string;
    /** For edits: the user's modified title/description. */
    updatedTitle?: string;
    updatedDescription?: string;
  }>;
  bulk?: 'regenerate';  // sent when user clicks Regenerate All
}
```

DOM structure:

```
.insrc-setup
  .insrc-setup-hero
    h1: "Review {kind}"
    p: "{items.length} items proposed. Approve all, reject all, or act per row."
  .insrc-list-review-toolbar
    button.insrc-btn.insrc-btn-primary     [Approve All]
    button.insrc-btn.insrc-btn-secondary   [Reject All]
    button.insrc-btn.insrc-btn-secondary   [Regenerate]
  .insrc-accordion
    for each item:
      .insrc-accordion-row
        .insrc-accordion-header
          codicon-chevron-right (rotates on expand)
          span.title
          span.status-chip (pending / approved / rejected)
          button.approve-btn
          button.reject-btn
          button.feedback-btn
        .insrc-accordion-body (collapsed by default)
          textarea.description (editable)
          textarea.feedback (only visible after feedback button click)
          button.save-edit
  .insrc-list-review-footer
    button.insrc-btn.insrc-btn-primary     [Apply]
```

Behavior:

- Click header -> toggle expand.
- Click approve / reject -> set item's `approved` state; persist in
  memory; chip updates.
- Click feedback -> expand row, show feedback textarea + reject the
  item (feedback + reject go together).
- Edit description in the textarea + click Save -> update
  `updatedTitle` / `updatedDescription` on the item.
- Apply -> send `ListReviewGateReply` via the stored `onListResolve`
  callback. Close the pane. The chat service resumes the agent run.
- Regenerate -> send `bulk: 'regenerate'`. Agent discards the items
  and re-runs the draft step.

## Mode 2 -- tree-browse

Reads `requirements/_index.json` and renders the hierarchy. Useful
for navigating a partially-complete requirements tree across multiple
chat sessions.

DOM:

```
.insrc-setup
  .insrc-setup-hero
    h1: "Requirements Tree"
    p: "{epic count} Epics, {subEpic count} Sub-epics, {story count} Stories"
  .insrc-tree
    for root Epic:
      .insrc-tree-node.kind-epic
        codicon-chevron-down (expanded by default for root)
        span.id: REQ-XXXXXX
        span.title
        chip.status
        children:
          .insrc-tree-node.kind-sub-epic ...
```

Interactions:

- Click node -> `editorService.openEditor(fileUri)` for the doc file.
  Users edit directly in the Monaco editor; no special handling.
- `F2` on selected node -> rename flow: prompt for new title,
  compute new REQ ID, rename file, update index + rewrite all
  `parent`/`children` references, add to index's `renames` map.
- Drag-reorder -> moves children within a parent's `children` array;
  no cross-parent moves in MVP (users should re-author instead).

Edits to doc files are watched via `IFileService.watch` -- changes
outside the pane bubble into `_index.json`'s `updated` timestamp.

## Mode 3 -- handoff

After the main Epic doc is written, the agent emits a handoff payload
listing sub-epics. The pane renders one row per sub-epic with a
"Start chat for this sub-section" button:

```
.insrc-setup
  .insrc-setup-hero
    h1: "Continue in new chats"
    p: "Each sub-section is best handled in its own chat so context
        stays focused. Click a row to start one."
  .insrc-handoff-list
    for each sub-epic:
      .insrc-handoff-row
        span.req-id
        span.title
        p.description
        button.insrc-btn.insrc-btn-primary [Start chat]
```

Button handler calls the `insrc.requirements.continueInNewChat`
command with `{ parentId, subEpicId }`. The command:

1. Calls `chatService.startSession(repoPath)` to create a fresh
   session.
2. Sends an initial message:
   `@requirements continue REQ-{subEpicId} (parent: REQ-{parentId}, kind: sub-epic)`
3. The requirements agent's `initialState(input)` detects the
   `continuation` field and jumps directly to `story-list-author`,
   skipping `scope-analyze` and `breakdown`.

## Auto-open contribution

Pattern matches `BrainstormAutoOpenContribution` and
`ModelProvidersAutoOpenContribution` in `insrc.contribution.ts`.
Listens for two signals:

1. A new event on `IInsrcChatService` -- `onDidRequireRequirementsList`
   -- fired by the chat-service impl when it sees a gate payload of
   type `list-review-requirements`. Opens the pane in list-review
   mode.
2. A new command `insrc.openRequirementsTree` -- opens the pane in
   tree-browse mode for the current repo's `requirements/_index.json`.

## Commands

| Command | Palette? | Handler |
|---|---|---|
| `insrc.openRequirementsTree` | yes | Open pane in tree-browse mode for the active repo |
| `insrc.requirements.continueInNewChat` | no (invoked by UI) | See Mode 3 |
| `insrc.requirements.renameDoc` | no (right-click in tree) | Mode 2 F2 flow |

Palette title: `insrc: Open Requirements Tree`.

## Service-side plumbing

`IInsrcChatService` gains:

```typescript
interface IInsrcChatService {
  // ... existing events
  readonly onDidRequireRequirementsList: Event<{
    payload: ListReviewGatePayload;
    resolve: (reply: ListReviewGateReply) => void;
  }>;
}
```

Chat-service impl intercepts the specific gate kind from the agent's
gate payload. Standard gate is text-based; this is a structured
payload -- the daemon-side channel serializes it as JSON in the
gate's `context` field. The IDE-side chat service detects
`gate.context.kind === 'list-review-requirements'` and fires the
new event instead of rendering the gate inline.

## Verification

- Invoke palette: `insrc: Open Requirements Tree` -> pane opens,
  renders the tree from `_index.json` (or an empty-state message if
  no such file).
- Run the agent end-to-end with a broad-scope prompt -> at
  `breakdown-gate`, the pane auto-opens in list-review mode -> user
  approves items -> gate resolves -> agent advances to scaffold.
- Click "Start chat" on a handoff row -> new chat opens with the
  continuation message -> agent jumps to story-list-author.
- Close the pane mid-review -> gate stays open (no implicit approval
  or rejection) -> reopen tree view -> pane restores to
  list-review mode showing the same items in their previous state.

## Commit boundary for stage 4

1. `requirementsEditorInput.ts` + `requirementsEditorPane.ts` shell
   with empty createEditor.
2. List-review mode rendering + event wiring.
3. Tree-browse mode rendering + file-open on click.
4. Handoff mode rendering + command.
5. Register pane + input + commands in `insrc.contribution.ts`.
6. Chat-service gains `onDidRequireRequirementsList` event + dispatch.
7. Auto-open contribution.
