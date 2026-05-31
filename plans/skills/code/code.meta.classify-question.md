# Skill plan: `code.meta.classify-question` (A5 evolution)

**Status:** draft (2026-05-31)
**Owner:** subhagho@gmail.com
**Skill family:** `meta`
**Tier:** L1 (capability skill -- but classify-question is the bridge to L2 dispatch per A5)
**Substrate owner id:** `skill:code.meta.classify-question`

**Why this skill -- and how it differs from the cache-wiring migrations.**

Per [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) priority #5 + [`plans/agentic-skills-architecture.md`](../../agentic-skills-architecture.md) §A5 -- this is NOT a cache-wiring migration. It's a *schema evolution*:

> **A5:** classify-question becomes the bridge between the user's intent and per-skill goals. Each routed skill receives a *goal*, not just a skill id. The skill itself is responsible for planning how to achieve the goal.
>
> "Analyze file abc" is directionless; "Identify the join keys between this file's records and the GRN domain model's expected structure, focusing on field name overlap" is a goal a skill can plan against.

The user-visible change is one extra field on every candidate:

```ts
// Before A5:
interface Candidate {
  skillId:       string;
  rationale:     string;          // why this skill applies
  mustHaveScope: MustHaveScope;
}

// After A5:
interface Candidate {
  skillId:       string;
  rationale:     string;
  goal:          string;          // NEW -- natural-language instruction for this skill
  mustHaveScope: MustHaveScope;
}
```

**What this enables:**

- **L2 dispatch path** (A5 + agentic-skills-architecture §"L2 skill contract"): when classify-question's output flows to an L2 skill, the L2 runtime sets `invocationContext.goal` directly from the classify output. The L2 skill's planning step consumes it. **No separate arg-filling step** -- the L2 skill plans how to fulfill the goal.
- **L1 dispatch path**: `code.meta.select-scope` (priority #6, the next migration) consumes the goal alongside the connection roster + the skill's input schema to fill `input: I`. The L1 skill ignores `invocationContext` and works from the filled args as before. The goal is what gives select-scope direction beyond the catalog rationale.
- **Audit + debug**: every dispatched skill carries a record of *why it was called for THIS turn*, in natural language. Trail is recoverable from the classify output without re-deriving from the question text.

**Why caching is not added here**

Cache wins on classify-question would be near-zero: questions vary turn-to-turn. The substrate ownership declaration lands so D14 routing + future observation distillation know who the owner is, but no `contextSlots` are wired today.

## Depends on

- [`plans/agentic-skills-architecture.md`](../../agentic-skills-architecture.md) §A5 -- the evolution spec.
- [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) priority #5.
- [`plans/skills/substrate-implementation-status.md`](../substrate-implementation-status.md) -- substrate P0-P5 done; this is P6+ skill work.
- Sibling (NOT migrated here): `data.meta.classify-question` has the same shape. A5 applies to it too; that's a separate per-skill pass.

## Changes

### 1. Output schema

`OUTPUT_SCHEMA.properties.candidates.items.properties` gains `goal: { type: 'string', minLength: 1, maxLength: 500 }`. `required` becomes `['skillId', 'rationale', 'goal', 'mustHaveScope']`.

### 2. TypeScript types

`Candidate` interface gains `readonly goal: string`.

### 3. System prompt

Add a paragraph explaining what `goal` is + the contract:

> Every candidate MUST include a `goal` -- a natural-language instruction that tells the routed skill WHAT to achieve, not just THAT it should be called. Bad: "Analyze file abc". Good: "Enumerate the field metadata for class abc's User definition; focus on which fields are exported vs internal." The goal is what makes the skill plan against direction instead of guessing.

### 4. Few-shot examples

Every example in `FEW_SHOT` gets a `goal` on each candidate. Example shape:

```
{
  "skillId": "code.source.file.describe",
  "rationale": "Single-file enumeration of declared entities + imports.",
  "goal": "Enumerate every entity declared in src/User.ts plus its imports; return the structured surface so the caller can decide what to drill into.",
  "mustHaveScope": "repo+file"
}
```

The goal is verbose-by-design -- the LLM benefits from seeing rich examples of what a goal looks like (instruction + reasoning + scope hint).

### 5. Parser / validator

`parseAndValidate` adds a goal check: `typeof goal === 'string' && goal.length >= 1`. Failure path is the same as other validation failures (one retry; if retry also bad, low confidence with diagnostic note).

### 6. Substrate-facing declaration (light)

```ts
ownerId:            'skill:code.meta.classify-question',
schemaVersion:      1,
interestedTriggers: ['repo-add', 'reindex', 'manual'],
contextSlots:       [],       // no caching
memorySchema: [
  { namespace:   'observations',
    valueType:   'WorkspacePatternObservation',
    autoDistill: 'never',
    indexing:    { kind: 'never' },
    ttl:         '30d' },     // for future L2 distillation: "questions about X always route through Y first"
],
assertionInterests: [],
```

No `contextSlots` (caching not useful). No `assertionInterests` (no user-asserted facts route here yet). `observations` namespace declared for the eventual L2 path where the pipeline learns routing patterns.

## Tests

- All existing fake-provider fixtures in `code.meta.test.ts` add `goal` to each candidate.
- Two new tests:
  1. **goal validation**: a candidate without `goal` -> rejected on first pass, retry, then low confidence.
  2. **goal short-circuit**: empty-string `goal` -> rejected.
- A goal-content smoke test isn't possible without a live LLM -- the goal's *quality* is the LLM's responsibility (per A1 self-grounding). Structural validation only.

## What's intentionally NOT in this migration

- **Caching** -- questions vary turn-to-turn; cache hit rate would be near zero.
- **L2 dispatch wiring** -- the L2 runtime that consumes `invocationContext.goal` doesn't exist yet (per agentic-skills-architecture.md "L2 runtime" section). When the runtime lands, it picks up the goal directly from classify output.
- **`data.meta.classify-question` migration** -- separate per-skill pass.
- **`code.meta.select-scope` migration** (priority #6) -- separate, depends on this one shipping (select-scope reads the goal as a routing signal).

## Risks

- **Token usage rise.** Each candidate gains ~50-150 tokens of goal text. With up to 4 candidates per response that's ~200-600 extra output tokens per classify call. Acceptable: the model is cloud + small-tier already; this is the marginal cost of A5's win.
- **Goal-quality drift on local-model fallback.** classify-question is `providerAffinity: 'cloud'` -- local models would struggle with the instruction-shaping. We're not touching that affinity; if the daemon ever forces local, the goals degrade but the structure still validates.
- **Compatibility with existing callers.** Adding a field to the output is non-breaking for callers that ignore unknown fields. Code-analyzer's planner currently reads `candidates[].skillId` + `rationale` + `mustHaveScope`; it'll see the new `goal` field but ignoring it is fine until select-scope migration consumes it.
