# Brainstorm Idea Card UX

Scope: the single-idea review card used by `IdeasPane` (and transitionally by
the legacy `BrainstormEditorPane` for idea-discussion gates). This document
covers the layout, the interaction model for each action, the per-action
input flow, loading / submitting state, and the "add idea" entry point.

## Problem

The current card (`BrainstormCardWidget`) has three usability defects:

1. **Input-requiring actions do nothing on click.** `Diverge` and `Discuss`
   are emitted by the backend as actions with `needsInput: true`. The widget
   wires them as single-shot `onAction(name, undefined)` -- the backend
   receives an empty feedback and either falls through to a default prompt or
   (in the `respond` case we removed earlier) silently consumes the action.
   Users can't tell whether the click registered.
2. **Free-text feedback breaks the flow.** A always-visible textarea + send
   button below the card sends `action=discuss` with whatever the user typed.
   That action opens a different gate kind (`idea-discussion`) which falls
   back to the legacy pane. When the user eventually returns to the idea
   review queue, the new card appears to ignore button clicks -- the prior
   discussion flow leaves the user unable to proceed.
3. **No way to add an idea.** The legacy pane had a `+ Add Idea` button; the
   new `IdeasPane` dropped it during migration. Users can't contribute their
   own ideas into the queue.

## Design goals

- **No silent actions.** Every click is either immediate (approve / reject /
  park / skip) or opens a visible input panel (diverge / discuss). Nothing
  dispatches without the user seeing a state change.
- **One input at a time.** The card shows the action-specific prompt inline
  in place of the button row, so there's no competing "generic textarea"
  that confuses the intent of a user's typed message.
- **Feedback fatigue protection.** After any action dispatches, the card
  enters a dimmed "submitting" state until the backend acknowledges with a
  new gate. Prevents double-clicks and "did it work?" uncertainty.
- **Keep the card widget reusable.** Both `IdeasPane` and the legacy pane
  render through `BrainstormCardWidget`. The redesign stays inside that
  widget; the legacy pane inherits the improvements for free during
  migration.

## Card layout

```
┌─ idea card ──────────────────────────────────────────┐
│  Title          [verdict pill]   tag tag tag         │
│                                                      │
│  Body paragraph describing the idea. Can wrap.       │
│                                                      │
│  Review: <rationale>              <- only if present │
│  References:                      <- only if present │
│     foo.ts:42                                        │
│     bar.ts                                           │
│                                                      │
│  ─── Discussion ───────────────── <- only if msgs    │
│  You: ...                                            │
│  Agent: ...                                          │
│                                                      │
│  ─── actions ─────────────────────────────────────── │
│  [ Approve ] [ Reject ] [ Park ] [ Skip ]            │
│  [ Diverge... ] [ Discuss... ]                       │
└──────────────────────────────────────────────────────┘
```

The action row is grouped: single-shot actions on the top line, input-
requiring actions (suffixed "..." to advertise the prompt) on the second
line. Visual weight matches backend semantics:

| Action  | Style                                | needsInput |
|---------|--------------------------------------|------------|
| Approve | Primary, green tint                  | no         |
| Reject  | Red tint                             | no         |
| Park    | Yellow tint                          | no         |
| Skip    | Neutral outline                      | no         |
| Diverge | Blue tint                            | **yes**    |
| Discuss | Link-coloured outline                | **yes**    |

Legacy actions (`reopen`, `accept`, `back`, `split`, `edit`, `refine`,
`respond`) are still rendered when the backend includes them, using the
same styling rules driven by `needsInput`.

## Interaction model

### Single-shot actions (approve, reject, park, skip, ...)

1. User clicks the button.
2. Widget calls `onAction(name, undefined)`.
3. Widget immediately enters `submitting` state (see below).
4. Caller dispatches `chatService.replyToGate(...)`.
5. Next `onDidChangeActiveGate` from the session service renders a new card,
   implicitly clearing the submitting state.

### Input-requiring actions (diverge, discuss, edit, refine, split)

1. User clicks the button.
2. The action row is **replaced** (not shifted) with an inline prompt panel:

   ```
   ┌─ prompt panel ────────────────────────────────────┐
   │  <prompt label>                                   │
   │                                                   │
   │  ┌──────────────────────────────────────────────┐ │
   │  │ <textarea>                                   │ │
   │  └──────────────────────────────────────────────┘ │
   │                                                   │
   │             [ Cancel ]       [ Send ]             │
   └───────────────────────────────────────────────────┘
   ```

   Label comes from the action's `hint` field if the backend provides one,
   otherwise a reasonable per-action default ("What direction should we
   explore?" for diverge, "What would you like to discuss?" for discuss).
3. Textarea autofocuses. `Enter` sends; `Shift+Enter` inserts a newline;
   `Esc` cancels.
4. **Send** calls `onAction(name, text)`. Empty text IS allowed -- the
   backend has defaults for every input-requiring action. We surface empty
   as a dim placeholder but don't block.
5. **Cancel** restores the action row without side effects.
6. On Send, widget enters `submitting` state until next gate arrives.

### Submitting state

Applied after any action dispatch. Visual:

- Card body fades to `opacity: 0.55`.
- Action row (or prompt panel) is replaced by a single waiting line:
  > `Waiting for next idea...` with a spinner codicon.
- Clicks on the card area are no-ops (overlay catches pointer events).

Exits when:
- A new `idea` gate arrives (card re-renders fully).
- The flow contribution routes to a different pane (no exit needed; this
  card is unmounted).
- The daemon stream errors out (`onDidError`) -- TBD how to surface; for
  now falls through to re-rendering the previous card state.

## Add Idea entry point

Owned by `IdeasPane`, not the card widget -- it's a pane-level entry, not
idea-specific.

### Button

Sits in the pane header, right-aligned, next to the category badge:

```
┌─ pane header ───────────────────────────────────────────┐
│ [💡] Ideas    [category]    approved N ...  [+ Add Idea]│
└─────────────────────────────────────────────────────────┘
```

Disabled while the chat session is streaming and there's no active idea
gate (can't add during convergence / spec / finalize phases -- only during
`ideation` gates).

### Form

Click reveals a modal-esque inline form floating above the card area:

```
┌─ Add idea ───────────────────────────────────────────┐
│  Title  ┌──────────────────────────────────────────┐ │
│         │                                          │ │
│         └──────────────────────────────────────────┘ │
│  Body   ┌──────────────────────────────────────────┐ │
│         │                                          │ │
│         │                                          │ │
│         └──────────────────────────────────────────┘ │
│                            [ Cancel ]   [ Add idea ] │
└──────────────────────────────────────────────────────┘
```

- Title is required (Add button disabled when empty).
- Body is optional; defaults to title when empty.
- Submit calls `daemonService.rpc('brainstorm.addIdea', { sessionId, title, body })`.
- RPC resolves with a success / error. On success: close form, toast
  optional (skip initial). On error: show inline error in form, keep open.
- After submit, the backend appends the idea to the review queue. The user
  will see it when they reach it through normal approval flow. We do NOT
  jump focus to the new idea -- that breaks the "reviewer" mental model.

### Validation

- Trim whitespace on title; block if empty.
- Cap title at 200 chars, body at 4000.
- No client-side checks on duplicates; the daemon handles dedup.

## Data contracts

### Widget -> pane

```ts
type CardActionHandler = (
  action: string,          // name from backend, e.g. 'approve', 'diverge'
  feedback: string | undefined,  // textarea content, only for input actions
) => void;
```

One handler per card. The widget no longer carries an `onDiscuss`
side-channel -- discussion messages arrive through the next gate's
`item.messages` / `discussionMessages` payload, not through a separate
code path.

### Pane -> chat service

Input-required actions use the typed feedback verbatim. Single-shot
actions pass `undefined` for feedback:

```ts
chatService.replyToGate(gate.gateId, action, feedback);
```

### Add-idea RPC

Already exists on the daemon: `brainstorm.addIdea` takes
`{ sessionId, title, body }`, returns the new idea's id on success.
No protocol change.

## Scope and non-goals

In scope for this round:

- Card: submitting state, per-action inline prompt, remove standalone
  textarea, grouped button rows.
- IdeasPane: Add Idea button + inline form + RPC wiring.
- Legacy pane inherits the card changes automatically.

Out of scope (tracked separately):

- Tooltip styling. The native `title` attribute renders unstyled; replacing
  it with VSCode's `IHoverService` is a generic workbench concern, not
  brainstorm-specific.
- `IdeaChatPane` for the `idea-discussion` gate kind. The current redesign
  makes the `discuss` action send feedback forward; the actual discussion
  view still lands on the legacy pane until that migration lands.
- Markdown rendering of idea body. Plain text for now.

## Resolved decisions (folded in)

1. **"Submitting" times out after 15s.** If the daemon hasn't replied with a
   new gate in 15 seconds the card restores the previous action row and
   surfaces a small inline warning ("No response from the agent -- try
   again?"). The user can re-click the action. Prevents the card from
   appearing frozen under daemon crashes or disconnects.
2. **Add Idea during non-ideation phases: disabled, not hidden.** The button
   stays visible but disabled, with a tooltip explaining when it becomes
   available. Keeps discoverability without teasing an unusable action.
3. **RPC failures on Add Idea: inline form-level error.** Show the error
   message inside the form (below the fields) and keep the form open so the
   user can retry. If we see repeated failures in telemetry later, promote
   to a workbench toast.
