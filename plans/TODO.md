# Plans backlog

Tracks backlogged design + implementation items surfaced during other work but
not currently active. Items are in priority order. New items append to the
appropriate priority bucket; reordering is explicit.

Each item should capture: where it surfaced, what direction was already locked
(if any), and what's still needed before it can be picked up.

---

## High priority

### 1. Memory + Context system design

**Status**: **design in progress** at [design/memory-context.html](../design/memory-context.html).
Iteration loop active; 9 of 10 open questions (G1-G10) still pending.

**Surfaced in**: O4 of `/plan` template design ([design/meta-task-plan.html](../design/meta-task-plan.html)).

**Problem**: durable user preferences (e.g., "always include unit tests in
implementation plans") get lost over time even when forced to memory. The
framework's `memory` slot (chat turn ANN) + the auto-memory file are
similarity-based recall; high recency or high similarity wins, not high
authority.

**Direction (revised after audit, 2026-06-17)**: the original sketch
(separate preferences subsystem, YAML files) was based on the assumption that
no comparable infrastructure existed. The audit during the design exercise
surfaced an already-implemented memory substrate
([daemon/substrate/](../src/insrc/daemon/substrate/), ~3,300 LOC, P0-P10 done)
plus four overlapping memory subsystems. The substrate already covers ~90% of
the preferences shape — including a user-assertion classifier (D6) that
implements exactly the "preferences from corrective turns" mechanism.

**New direction**: **consolidate around the substrate; don't build parallel
machinery.** Per [design/memory-context.html](../design/memory-context.html):

- Substrate is the canonical memory layer. One memory primitive, one
  classifier, one retrieval contract.
- Chat ↔ substrate: wire chat turns through `runtime.classifyAssertion()`
  (currently not invoked anywhere).
- Meta-task ↔ substrate: templates become first-class substrate owners
  (`agent:meta-task:plan`, etc.); declare `assertionInterests`; new
  `kind: 'preferences'` ContextRequest slot delegates to substrate.
- Legacy `config/` system: deprecate and retire when its callers retire
  (per-meta-task migration schedule).

**Resolved gaps** (folded into the design doc):
- **G1: chat-turn classification trigger** — both passive + targeted, with
  every turn running Layer 2 LLM classification under accuracy-first principle.

**Still open** (G2-G10): UX threshold details, assertion-interest taxonomy,
scope axes serialization, framework-mandatory preference injection,
conversation store tagging, confidence accumulation, implicit-at-retrieval,
L1-L5 budget integration, `config/` migration timing. See design doc §7.

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

---

## Settings to externalize

Values that are currently planned (or already hard-coded) as code constants but
should land in the user settings framework (`insrcConfiguration.ts` /
`~/.insrc/config.json`). New entries append as they surface during design;
remove when the setting is actually wired.

Format: setting key + default + scope + source.

### `insrc.memory.assertionClassifier.autoAcceptThreshold`

- **Default**: `0.85`
- **Type**: number (0..1)
- **Scope**: machine (daemon-side)
- **Source**: G2 of [design/memory-context.html](../design/memory-context.html).
- **Purpose**: Layer 2 classifier confidence above which an `accept` verdict
  auto-persists as `kind: 'constraint'`; below it triggers Layer 3 user
  confirm. Picked as a starting point; tuneable based on early usage.
- **Implementation status**: not yet wired. Add to `insrcConfiguration.ts`
  when the chat ↔ substrate wiring lands (memory-context M1).
