# Plans backlog

Tracks backlogged design + implementation items surfaced during other work but
not currently active. Items are in priority order. New items append to the
appropriate priority bucket; reordering is explicit.

Each item should capture: where it surfaced, what direction was already locked
(if any), and what's still needed before it can be picked up.

---

## High priority

### 1. Memory + Context system design

**Status**: design exercise needed before implementation.
**Surfaced in**: O4 of `/plan` template design ([design/meta-task-plan.html](../design/meta-task-plan.html)).

**Problem**: the framework's `memory` slot (chat turn ANN) + the auto-memory
file aren't reliable enough for durable user preferences in real-world usage.
Preferences get lost over time even when forced to memory. The information needs
to be more structured:

- **Contextualized**: categorized by template, plan category, repo scope —
  not just blob text in a turn history.
- **Captured at the right moments**: plan-revision feedback, explicit user
  preference signals, gate-time corrections.
- **Retrieved deterministically** via the context builder, not best-effort ANN.
- **Editable by the user**: human-readable storage (YAML), not hidden binary
  state, so the user can grep / curate directly.

**Direction locked during O4 conversation** (in [design/meta-task-plan.html](../design/meta-task-plan.html) §8):

- Local LLM is the curator on both ends (capture + retrieval) — fits the
  existing "librarian vs reasoner" role split.
- New `ContextRequest` slot: `kind: 'preferences'`.
- Storage: `~/.insrc/preferences/` YAML files scoped by `global` / per-repo /
  per-template / `(template, category)`.
- Inline capture during retrieval: local LLM looks at recent corrective turns +
  flags candidate preferences for user confirmation. Re-derivation each fetch
  beats cache invalidation.
- Two capture channels: explicit (`/prefs save <text>` or "save as preference?"
  prompt at plan-revision time) + implicit (the inline candidate-flagging during
  retrieval).

**Still needs**:

- Own design doc at `design/memory-context.html` covering: capture trigger
  semantics, scope axes, YAML schema, retrieval flow, supersede/retire mechanism,
  privacy/scope of the implicit-capture turn-scan (this session / recent / all).
- Own plan at `plans/memory-context.md` covering implementation milestones.
- Decision: is this a prerequisite for `/plan` M4.a, or can M4.a ship with the
  preferences slot stubbed and the implementation land in parallel?

**Why it's high priority**: real-world reliability problem reported by the user.
Affects every meta-task template (not just `/plan`) — `/design`, `/implement`,
`/migrate`, `/review` all benefit from durable preference context.

---

## Medium priority

(empty)

---

## Low priority

(empty)

---

## Closed / migrated

Items that have moved into a design doc or active plan can be moved here with
a pointer, or removed entirely. Keep the list short.

(empty)
