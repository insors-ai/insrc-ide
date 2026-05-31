# Skill plan: `code.meta.select-scope` (A5 demotion + goal consumption)

**Status:** draft (2026-05-31)
**Owner:** subhagho@gmail.com
**Skill family:** `meta`
**Tier:** L1 (capability skill -- explicitly an arg-filling utility per A5)
**Substrate owner id:** `skill:code.meta.select-scope`

**Why this skill -- and the A5 framing.**

Per [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) priority #6 + [`plans/agentic-skills-architecture.md`](../../agentic-skills-architecture.md) §A5 -- this is the companion to #5. A5 calls out two changes here:

> **select-scope demoted:**
>   - Not the primary routing mechanism -- classify-question's goals are.
>   - Continues to exist as an arg-filling utility, primarily because local LLMs consistently miss nested arg shapes.
>   - L2 skills don't call select-scope. They consume the goal directly.

And:

> For **L1 skills** (which take typed args): select-scope runs as a utility step to fill `input: I` based on `(goal, connection roster, skill's input schema)`.

The skill's *job* doesn't change -- it still fills `args` for each candidate. What changes is the **input signal it works from**: the new `goal` field from classify-question is now the primary direction (with description + input schema as structural backup). Before A5, select-scope had `(question, rationale, mustHaveScope, description, inputSchema)` to work with; the rationale was about *why* the skill was picked, not *what* it should do. The goal IS the what.

**What this enables vs the previous shape:**

- **Local-model arg-shape reliability** (the A5 motivation): a verbose `goal` like "Diff the parseConfig function body between git ref v1.5 and HEAD; return the structural delta (signature change, body added/removed/changed lines)" gives select-scope enough rope to fill `{ entityRef, baseRef: 'v1.5', headRef: 'HEAD' }` without inventing fields.
- **Clearer prompt**: removing the goal-vs-rationale ambiguity in the LLM's task. Rationale stays (informational), goal becomes load-bearing.
- **Tighter audit**: the filled args carry the goal that motivated them; downstream consumers can correlate `(skillId, args, goal)` for debugging without re-deriving from the question text.

## Depends on

- [`plans/agentic-skills-architecture.md`](../../agentic-skills-architecture.md) §A5
- [`plans/skills/code/code.meta.classify-question.md`](code.meta.classify-question.md) -- emits the `goal` this skill now consumes
- [`plans/skills/substrate-implementation-status.md`](../substrate-implementation-status.md) -- substrate P0-P5 done

## Changes

### 1. `goal` becomes required

`CandidateIn.goal` was an optional pass-through after the #5 migration. This migration makes it required (interface + JSON schema). The previous optional shape was an interim to avoid breaking pipeline order during #5; #6 closes the loop.

### 2. Prompt update -- goal is primary direction

Each rendered candidate block now leads with the goal (not the rationale). The system prompt gains a hard rule:

> The candidate's `goal` is the primary direction for filling args. Read it carefully -- it tells you what the skill should achieve and (usually) hints at the concrete scope (which file, which entity, which ref). The `inputSchema` tells you the *structure* of the args; the goal tells you the *content*. The `rationale` is informational; do not rely on it as the primary signal.

### 3. Skill description -- explicit demotion

The skill's `description` field gets a one-line note that it's an arg-filler utility (not a routing decision), L1-only, and L2 skills consume the goal directly.

### 4. Substrate-facing declaration (ownership only)

Same shape as classify-question: declare `ownerId` + an empty `observations` namespace for future L2 distillation. No `contextSlots` -- caching the LLM-driven arg-fill is not useful (questions vary turn-to-turn).

### 5. Backwards compatibility

The interim "optional goal" from #5 is intentionally tightened to "required goal" -- callers that produced classify output without goals would have been broken anyway since classify validation now enforces it. Any other consumer that passes through candidates from classify-question gets the goal for free.

## Tests

- Update existing tests to pass `goal` on every candidate (currently they omit it -- pre-#6 they were valid; post-#6 they would fail input validation).
- New tests:
  1. **goal required**: missing `goal` on a candidate -> input validation fails before LLM call.
  2. **goal rendered**: the rendered LLM user message includes the goal text for each candidate (substring check).
  3. **goal flows to args**: a goal that explicitly names a file path (e.g. "for src/User.ts") leads the LLM to fill `file: '/repo/alpha/src/User.ts'` (this is a soft assertion -- the existing fake-provider pattern returns canned LLM output, so the test just verifies the goal is in the prompt + the resulting `args` parse correctly).

## What's intentionally NOT in this migration

- **L2 dispatch wiring** -- L2 skills bypass select-scope per A5; that wiring is the L2 runtime's job (separate scope).
- **`data.meta.select-scope`** -- same A5 demotion applies on the data side; separate per-skill pass (paired with `data.meta.classify-question` which is also pending).
- **Caching** -- same rationale as #5 (LLM output varies per turn).

## Risks

- **Token usage rise.** Each candidate's prompt block now includes the goal (~50-150 tokens). Acceptable -- the model is cloud + small-tier.
- **Existing test fixtures need updating.** All `code.meta.test.ts` select-scope fixtures get a `goal` field. Mechanical change.
