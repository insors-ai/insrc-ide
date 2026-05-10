# Intent classification consolidation

**Status:** draft (2026-05-11)
**Owner:** subhagho@gmail.com
**Standing rule:** **every code path that needs to know the user's intent goes through `resolveIntent(session, message)`. There is no other legal way.**

## Why

We have **seven separate classification entry points** in `src/insrc/`. Each carries its own LLM prompt, its own rules, and its own subset of context (active repo / prior intent tag / slash-command list / continuation hints). They drift independently. The most recent symptom: a `/code-analyze` follow-up of "elaborate on the core filesystem design/architecture" was classified as `research` because it ran through the *decomposer*'s rules ("Informational questions ('what is X', 'how does X work') are 'research' intent") instead of the *classifier*'s sharpened rules (which had the right "in-repo question = code-analysis" tiebreaker plus the active-repo signal).

### Current state -- seven paths

| # | Module | Purpose | Sees active repo? | Sees prior intent? | Notes |
|---|---|---|---|---|---|
| 1 | `agent/decompose.ts` | Splits messages, picks intent | No | No | Causes the bug; runs first |
| 2 | `agent/classify/intent.ts` (`classifyPrimaryIntent`) | Picks intent | Yes | No | Best rules; only runs on fallback |
| 3 | `agent/classify/index.ts` (`classify`) | Generic LLM classifier | Via context | No | Substrate for #2 |
| 4 | `agent/classify/scope.ts` (`classifyScope`) | Scope tier (S..XXXXL) | Via context | No | Orthogonal axis; fine to keep |
| 5 | `agent/intent/resolver.ts` (`resolveIntent`) | Tag-reuse + cold-classify | Yes | **Yes** | Lowest-risk path; **not wired in** |
| 6 | `agent/intent/enhancer.ts` | Rewrites question with prior facts | Yes | Yes | Consumes intent; doesn't pick it |
| 7 | `agent/prefix.ts` (`parsePrefix`) | `/intent <name>` overrides | n/a | n/a | Currently short-circuits before classify |

### Current dispatch matrix

```
chat-handler.runChatMessage
  /code-analyze X     ─→ runCodeAnalyzerSlash    skips ALL classification
  /data-analyze X     ─→ runDataAnalyzerSlash    skips ALL classification
  /intent <name> X    ─→ parsePrefix             override; skips classifier
  /<other slash> X    ─→ slashIdToIntent map     skips classifier
                X     ─→ decompose (LLM)         if confidence > 0.6 keeps decomposer's intent
                                                 ─→ else falls through to classifyPrimaryIntent
```

### Where the rules diverge

- **decompose.ts** has a hardcoded "Informational questions ... are 'research' intent" rule with no active-repo signal. Misclassifies in-repo "elaborate on X" / "describe X" / "explain X" prompts.
- **classify/intent.ts** + **INTENT_CLASSES** has the inverse rule: "research is EXTERNAL-ONLY; in-repo questions default to code-analysis". With the active-repo prior block.
- **resolver.ts** has continuation-detection (`looksLikeContinuation`) for follow-ups like "now show me HDFS Core" but is never called.
- **chat-handler slash paths** stamp no `[intent:current]` tag (or stamp inconsistently — only the Phase 4 fix to `/code-analyze` does this), starving the next turn of intent context.

---

## Goals

1. **One funnel for intent.** Every chat path -- regular, every slash, resume, re-run -- calls exactly one function: `resolveIntent(session, message)`. Returns `ResolvedIntent`.
2. **Decomposer stops classifying.** It still splits messages into primary + attached actions; the intent of each action comes from the resolver.
3. **One source of truth for intent semantics.** `INTENT_CLASSES` + `buildClassifierContext` are the only place rules ("what is research?", "what is code-analysis?", "in-repo prior") live.
4. **Slash commands skip the LLM but not the funnel.** They feed `resolveIntent` a synthetic `ResolvedIntent { source: 'slash-forced' }`, which still stamps the `[intent:current]` tag so the *next* turn benefits.
5. **Tag stamping happens exactly once per turn**, by `resolveIntent`. No manual `setTag(INTENT_TAG_CURRENT, ...)` anywhere else.
6. **Memory-augmented classifier context.** The cold-classify path sees a compact memory context derived from the session: top-3 most-relevant prior turns (user requests + assistant responses, sorted by recency) plus top-3 most-relevant *segments* of prior assistant responses (chunked, embedded, retrieved by ANN). Whole responses never reach the prompt; only the matched segment excerpts do.
7. **Relationship-typed classifier output.** When the memory context surfaces a related prior, the classifier emits a `relationship` field with a typed enum (`NEW` / `FOLLOWUP` / `DRILL_DOWN` / `RESPONSE_TO` / `CONTINUATION` / `CORRECTION` / `COMPARE_WITH` / `TANGENT`) plus citation refs back to the memory items it leaned on. Downstream consumers (orchestrator, enhancer, todos pane) use the relationship to decide whether to reuse prior facts, re-stamp tags, or treat the turn as a fresh start.

## Non-goals

- This plan does NOT change the multi-action decomposition feature (primary + attached actions, file refs, dependencies, format directives). That stays.
- This plan does NOT change scope classification (`classifyScope`). That's a separate axis -- size of work, not type of work.
- This plan does NOT touch the question-enhancer. It's a downstream consumer of the resolver's output and stays as-is.
- This plan does NOT change agent dispatch (controllers, runControlledPipeline, runTaskPipeline). The intent-to-controller routing is unchanged; only how intent gets *picked* changes.

---

## Architecture

### The contract

```ts
// agent/intent/resolver.ts -- the only legal entry point for intent.
export async function resolveIntent(
  session: Session,
  rawMessage: string,
  opts?: ResolveIntentOpts,
): Promise<ResolvedIntent>;

interface ResolveIntentOpts {
  /** Slash-forced intent: skip classifier; stamp tag with this id. */
  readonly slashForced?: Intent | undefined;
  /** Override (from `/intent <name>` prefix): skip classifier; stamp tag. */
  readonly explicitOverride?: Intent | undefined;
}

interface ResolvedIntent {
  readonly id:               Intent;
  readonly source:
    | 'slash-forced'         // /code-analyze, /data-analyze, /design, etc.
    | 'override'             // /intent <name>
    | 'tag'                  // continuation heuristic + prior tag reuse
    | 'classified-fresh'     // cold LLM classify, no prior tag
    | 'classified-shifted';  // cold LLM classify, intent shifted from prior
  readonly previousIntent?:  Intent | undefined;
  readonly confidence:       'high' | 'medium' | 'low';
  readonly reasoning:        string;
  readonly message:          string;     // prefixes stripped
  readonly scope?:           ScopeSize | undefined;  // when classifier ran
  /**
   * Typed relationship to prior session activity. Populated when the
   * cold-classify path's memory retrieval found ≥1 relevant turn or
   * segment AND the LLM concluded a relationship exists. Always
   * present on the cold path (defaults to { kind: 'NEW' }); always
   * `undefined` on the slash-forced / override / tag-reuse paths.
   */
  readonly relationship?:    IntentRelationship | undefined;
}

/**
 * Memory-citation backed relationship classification. Distinct from
 * the `source` field above: `source` describes HOW the resolver
 * arrived at this intent; `relationship` describes how this PROMPT
 * relates to prior conversation activity.
 */
interface IntentRelationship {
  readonly kind:
    | 'NEW'           // independent of any prior turn
    | 'FOLLOWUP'      // continues / refines a prior user request
    | 'DRILL_DOWN'    // zooms into a specific entity / topic from a prior assistant response
    | 'RESPONSE_TO'   // answers a clarification the assistant asked (gate reply, etc.)
    | 'CONTINUATION'  // literal "continue" / "go on" / "more"
    | 'CORRECTION'    // corrects / overrides a prior response
    | 'COMPARE_WITH'  // relates current request to a prior one for comparison
    | 'TANGENT';      // unrelated topic in the same session (route as NEW; tracked for analytics)
  readonly confidence: 'high' | 'medium' | 'low';
  readonly reasoning:  string;
  readonly citations:  readonly MemoryCitation[];   // 0..N items the LLM leaned on
}

interface MemoryCitation {
  readonly kind:        'turn' | 'segment';
  readonly id:          string;     // turnId or segmentId
  readonly excerpt:     string;     // ≤240 chars, the snippet shown in the prompt
  readonly recencyRank: number;     // 1 = most recent
  readonly relevance:   number;     // 0..1 ANN score (1 = same vector)
}
```

### Internal flow

```
resolveIntent(session, rawMessage, opts)
  ├─ if opts.slashForced: synthesize ResolvedIntent{ source: 'slash-forced' }
  │     → stamp [intent:current] = slashForced
  │     → return                                                       (NO memory retrieval)
  ├─ parsePrefix(rawMessage)
  │     ├─ if intentOverride: synthesize ResolvedIntent{ source: 'override' }
  │     │     → stamp tag → return                                     (NO memory retrieval)
  ├─ readIntentTag(session) → priorId
  ├─ if priorId && looksLikeContinuation(message): reuse
  │     → ResolvedIntent{ id: priorId, source: 'tag' }
  │     → refresh tag timestamp → return                               (NO memory retrieval; fast path)
  └─ cold path:
        ├─ memory  = retrieveClassifierMemory(session, message)         (Phase 3)
        │             ├─ ANN search turn_vec → top-3 hits, sort by recency
        │             ├─ ANN search response_segment_vec → top-3 hits
        │             └─ render compact memory-context block
        ├─ result  = classifyPrimaryIntent(message, session, memory)    (Phase 4)
        │             → returns { id, scope, confidence, reasoning,
        │                          relationship: { kind, citations[] } }
        └─ ResolvedIntent{ id, source: 'classified-fresh' | 'classified-shifted',
                            relationship: result.relationship }
              → stamp tag → return
```

`classifyPrimaryIntent` is the only caller of the underlying generic `classify()` for intent. The decomposer never calls it; nothing calls `classify()` for intent except this one function. Memory retrieval runs ONLY on the cold path -- the fast paths (slash-forced / override / tag-reuse) skip it because they already know the answer and don't need expensive ANN lookups.

### Decomposer's new role

```ts
// agent/decompose.ts -- splits a message into primary + attached actions.
export async function decompose(
  message: string,
  provider: LLMProvider,
  conversationHistory?: ...,
): Promise<DecomposeResult>;

// Action shape no longer carries an `intent` field. Caller resolves
// each action's intent via resolveIntent(session, action.action) in
// parallel after decompose returns.
```

The decomposer's system prompt drops:
- The hardcoded intent list
- The "Informational questions are research" rule
- The "primary research" examples
- The output schema's `intent` field

What stays:
- Primary / attached structural splitting
- Relation types (augment / append / format / depends / parallel)
- File reference extraction
- Output format directives
- `commandHint` for infra/deploy

### chat-handler.ts dispatch (after consolidation)

```ts
// 1. Family-direct slashes -- forced intent, but go through resolver.
if (slashCommand === 'code-analyze') {
  const resolved = await resolveIntent(session, prompt, { slashForced: 'code-analysis' });
  return runCodeAnalyzerSlash(active, ..., resolved);
}
if (slashCommand === 'data-analyze') {
  const resolved = await resolveIntent(session, prompt, { slashForced: 'data-analysis' });
  return runDataAnalyzerSlash(active, ..., resolved);
}

// 2. Intent slashes -- /design, /plan, /implement, etc.
if (intentSlashShortcut) {
  const resolved = await resolveIntent(session, prompt, { slashForced: intentSlashShortcut });
  // ... single-action flow, no decompose call
}

// 3. Regular chat path.
const decomposed = await decompose(message, decomposeProvider, history);
const actions = [decomposed.primary, ...decomposed.attached];
const resolvedActions = await Promise.all(
  actions.map(a => resolveIntent(session, a.action))
);
// Pair each action with its resolved intent; route as before.
```

`resolveIntent` is the only function that touches `[intent:current]`. Every path that reaches it stamps the tag, so the next turn always has a prior to reuse.

---

## Phase 1 -- resolver becomes the canonical entry

`agent/intent/resolver.ts`:

- Add `ResolveIntentOpts` to the public signature with `slashForced` + `explicitOverride`.
- When `slashForced` is set, synthesize a `ResolvedIntent` with `source: 'slash-forced'`, confidence `'high'`, reasoning `'forced by slash command'`. No LLM call. Stamp tag.
- When `explicitOverride` is set, same shape with `source: 'override'`.
- Move the prefix parsing inside resolveIntent (so callers don't need to call `parsePrefix` separately).
- Rest of the function (tag-reuse fast path + cold-classify) is unchanged.

Tests:
- slashForced bypasses classifier entirely; tag is stamped; confidence is 'high'.
- explicitOverride bypasses classifier entirely; tag is stamped.
- existing tag-reuse + classified-fresh + classified-shifted paths still work.

## Phase 2 -- response-segment substrate

The classifier's memory needs **per-segment** recall of prior assistant responses, not whole-response recall. The existing `turn_vec` table embeds whole turns; we add a sibling table that embeds chunks of assistant responses so the classifier sees only the relevant excerpt, not the entire prior reply.

### 2.1 New Lance table -- `response_segment_vec`

`src/insrc/db/lance/response-segment-vec.ts` (new). Mirrors the `turn-vec` / `artifact-vec` shape:

```ts
export interface ResponseSegmentVecRow {
  id:          string;             // ${turnId}:${segmentIdx}
  embedding:   Float32Array | number[];
  sessionId:   string;
  turnId:      string;             // FK to LMDB turns row
  segmentIdx:  number;             // 0-based position inside the response
  text:        string;             // the segment itself, ≤2 KB
  timestamp:   bigint;             // ms epoch (epoch of the source turn)
}

export interface ResponseSegmentVecHit {
  id, sessionId, turnId, segmentIdx, text, timestamp,
  distance: number;
}

export async function upsertResponseSegmentVec(row): Promise<void>;
export async function upsertResponseSegmentVecBatch(rows: readonly Row[]): Promise<void>;
export async function queryResponseSegmentVec(
  embedding: number[],
  opts: { sessionId: string; k?: number },
): Promise<readonly ResponseSegmentVecHit[]>;
export async function deleteResponseSegmentsForSession(sessionId: string): Promise<number>;
```

Standard insrc Lance patterns: lazy table cache, mergeInsert upsert, sessionId filter, k-NN ANN.

### 2.2 Segment chunker

`src/insrc/agent/intent/response-chunker.ts` (new):

```ts
/** Split an assistant response into ≤N-token semantic chunks for
 *  per-segment retrieval. Splits on:
 *    1. ## / ### markdown headings (highest priority)
 *    2. blank lines (paragraph boundaries)
 *    3. token-budget cap (fallback)
 *  Each chunk gets a stable `segmentIdx` so we can dedupe upserts. */
export function chunkResponseForRetrieval(
  text: string,
  opts?: { maxCharsPerChunk?: number; minCharsPerChunk?: number },
): readonly { idx: number; text: string }[];
```

Defaults: `maxCharsPerChunk: 1500`, `minCharsPerChunk: 200` (collapses tiny tail chunks into the previous chunk).

### 2.3 Indexing hook

In `src/insrc/daemon/chat-handler.ts:persistTurn` (or wherever the assistant response is written to LMDB), after the LMDB write add:

```ts
const chunks = chunkResponseForRetrieval(finalOutput);
const rows = await Promise.all(chunks.map(async c => ({
  id:         `${turnId}:${c.idx}`,
  embedding:  await embedQuery(c.text),
  sessionId:  session.id,
  turnId,
  segmentIdx: c.idx,
  text:       c.text,
  timestamp:  BigInt(Date.now()),
})));
await upsertResponseSegmentVecBatch(rows.filter(r => r.embedding.length > 0));
```

Best-effort: embed failures (Ollama down) drop the row but the LMDB write isn't blocked. Mirrors the spill-writer pattern from Phase 2 of conversation-flow-refinement.

### 2.4 Cleanup

- `Session.close()` calls `deleteResponseSegmentsForSession(session.id)` alongside the existing `purgeSession` for spilled artifacts.

### 2.5 Tests

- chunker: heading-split, paragraph-split, fallback token-budget cap, idx stability.
- vec table: round-trip upsert + query, sessionId scoping, delete-by-session count.
- indexing: assistant response with N chunks → N rows in the vec table; embed failure drops the row.

**Estimate: 2 days.** Independent of Phase 1; can ship in parallel.

## Phase 3 -- classifier memory retrieval helper

`src/insrc/agent/intent/classifier-memory.ts` (new):

```ts
export interface ClassifierMemory {
  /** Top-3 turn hits, sorted by recency (most recent first). */
  readonly turns:    readonly TurnMemoryHit[];
  /** Top-3 response-segment hits, sorted by relevance (best first). */
  readonly segments: readonly SegmentMemoryHit[];
}

export interface TurnMemoryHit {
  readonly turnId:       string;
  readonly role:         'user' | 'assistant';
  readonly excerpt:      string;     // ≤240 chars from the turn body
  readonly timestamp:    number;     // epoch ms
  readonly recencyRank:  number;     // 1 = most recent
  readonly relevance:    number;     // 0..1 ANN score (1 = identical vector)
}

export interface SegmentMemoryHit {
  readonly segmentId:    string;     // ${turnId}:${segmentIdx}
  readonly turnId:       string;
  readonly text:         string;     // the chunk text, possibly trimmed to 800 chars for prompt
  readonly timestamp:    number;
  readonly recencyRank:  number;
  readonly relevance:    number;
}

export async function retrieveClassifierMemory(
  session: Session,
  message: string,
  opts?: { turnsK?: number; segmentsK?: number },
): Promise<ClassifierMemory>;
```

Algorithm:

1. `embedQuery(message)` → `queryVec` (single embed call, reused for both ANN searches).
2. Parallel:
   - `searchTurnVecs(queryVec, { sessionId, k: 6 })` → top-6 turn hits.
   - `queryResponseSegmentVec(queryVec, { sessionId, k: 6 })` → top-6 segment hits.
3. For turns:
   - Hydrate text from LMDB (`getTurn(turnId)` + role + content). Trim to 240 chars at sentence boundary.
   - Sort by recency (descending timestamp), keep top-3.
4. For segments:
   - Already have text. Trim to 800 chars at sentence boundary.
   - Keep top-3 by relevance (already sorted by ANN distance).
5. Stamp `recencyRank` (1 = most recent) on both lists.
6. Return both. Empty session → `{ turns: [], segments: [] }`.

**Failure modes (each degrades silently):**
- `embedQuery` fails (Ollama down) → return empty memory; classifier runs without context.
- Lance query fails → return empty memory; same.
- LMDB hydrate misses a turnId (race with delete) → drop that hit, keep the others.

The retrieval helper writes a single info-level log line summarizing what it pulled (`turns: 3, segments: 2, embedMs: 12, lanceMs: 8`) so the daemon log can be correlated with the classifier's downstream LLM call via `llmCallId`.

### Tests

- happy path with seeded turn_vec + segment_vec → returns 3+3 hits in expected order.
- empty session → empty memory, no throw.
- embed failure → empty memory, no throw.
- LMDB hydrate misses a turnId → drops that hit cleanly.
- recencyRank stamped correctly.

**Estimate: 1.5 days.** Depends on Phase 2's segment substrate.

## Phase 4 -- classifier upgrade: memory context + relationship enum + citations

### 4.1 Update `INTENT_CLASSES` consumer

`src/insrc/agent/classify/intent.ts:classifyPrimaryIntent`:

- New optional argument `memory?: ClassifierMemory`. When supplied, the user-prompt builder appends a `## Recent context` section AFTER the existing `## Context` (active repo + tiebreaker + slash list).
- Memory section format (compact):

  ```
  ## Recent context
  ### Recent turns (3, sorted by recency)
  [t1] (1.2 min ago, USER, relevance 0.91, id=turn-abc)
        > /code-analyze describe what this repo does
  [t2] (1.2 min ago, ASSISTANT, relevance 0.82, id=turn-abc)
        > Apache Hadoop is an open-source framework for distributed storage ...
  [t3] (12 min ago, USER, relevance 0.42, id=turn-xyz)
        > how do I set up the indexer
  ### Relevant segments from prior responses (3, by relevance)
  [s1] (turn-abc segment 4, relevance 0.94)
        > HDFS Core (`hadoop-hdfs-project/hadoop-hdfs`) is the distributed
        > filesystem layer responsible for block storage and replication ...
  [s2] (turn-abc segment 7, relevance 0.78)
        > The NameNode owns the filesystem namespace and the file→block ...
  [s3] (turn-def segment 2, relevance 0.66)
        > YARN handles cluster resource scheduling ...
  ```

  Each `[tN]` and `[sN]` is a stable citation key the LLM can reference in its `relationship.citations` array.

### 4.2 Update the classifier's output schema

`src/insrc/agent/classify/index.ts`:

- The generic `classify()` accepts an optional `relationshipEnum?: readonly string[]` field on `ClassifyInput`. When present, the system prompt includes a relationship section and the JSON schema gains a `relationship` block.
- New schema (when `relationshipEnum` is supplied):

  ```json
  {
    "id":         "<class id>",
    "confidence": 0.0-1.0,
    "reasoning":  "<one sentence>",
    "scope":      "<S|M|L|XL|XXL|XXXL|XXXXL>",
    "relationship": {
      "kind":       "NEW|FOLLOWUP|DRILL_DOWN|RESPONSE_TO|CONTINUATION|CORRECTION|COMPARE_WITH|TANGENT",
      "confidence": 0.0-1.0,
      "reasoning":  "<one sentence>",
      "citations":  ["t1", "s2", "s3"]   // refs into the memory section
    }
  }
  ```

- System-prompt addition (only when `relationshipEnum` is supplied):

  ```
  ## Relationship to prior conversation
  In addition to picking the intent class, classify how this prompt
  relates to the recent context above:

  - NEW           -- independent; ignore the recent context.
  - FOLLOWUP      -- continues / refines a prior USER request (rephrasing,
                     elaborating, narrowing, broadening).
  - DRILL_DOWN    -- zooms into a specific entity / module / topic that a
                     prior ASSISTANT response surfaced (cite the segment).
  - RESPONSE_TO   -- answers a clarification or gate the assistant asked.
  - CONTINUATION  -- literal "continue", "go on", "more", "next".
  - CORRECTION   -- corrects / overrides a prior assistant claim.
  - COMPARE_WITH  -- explicit comparison to an earlier topic.
  - TANGENT       -- new topic in the same session, no relevant prior.

  Citations: the `relationship.citations` array MUST list the [tN] /
  [sN] keys you actually used to decide. Empty if NEW or TANGENT.
  ```

- Validation: the classifier's parser (1) checks the relationship.kind is one of the enum values; (2) drops citation keys that don't appear in the memory section (defensive against hallucinated refs); (3) defaults to `{ kind: 'NEW', confidence: 0.5, reasoning: '...', citations: [] }` if the relationship block is missing/malformed.

### 4.3 Wire into `resolveIntent`

`src/insrc/agent/intent/resolver.ts:resolveIntent` (cold path only):

```ts
const memory = await retrieveClassifierMemory(session, message);
const result  = await classifyPrimaryIntent(message, session, memory);
const resolved: ResolvedIntent = {
  id:           result.intent,
  source:       previousIntent ? 'classified-shifted' : 'classified-fresh',
  ...,
  relationship: hydrateRelationshipCitations(result.relationship, memory),
};
```

`hydrateRelationshipCitations` translates the LLM's `["t1", "s2"]` keys into full `MemoryCitation[]` objects (looking up the actual turn id / segment id / excerpt from the memory bundle the resolver has in hand).

### 4.4 Tests

- Classifier sees memory section in the user prompt body (snapshot test on the assembled messages).
- LLM emits relationship → classifier returns it → resolver hydrates citations.
- Citation keys not in the memory section get filtered (defensive).
- Empty memory → relationship defaults to `{ kind: 'NEW' }`.
- Snapshot test: memory section format matches the spec for [tN] / [sN] keys.
- The memory block does NOT appear on the slash-forced / override / tag-reuse paths.

**Estimate: 2 days.** Depends on Phase 3.

## Phase 5 -- decomposer stops classifying    (was Phase 2)

`agent/decompose.ts`:

- Delete `ALL_INTENTS` constant.
- Rewrite `DECOMPOSE_SYSTEM`: drop intent rules / examples / "Informational questions" line; drop the `intent` field from the output schema.
- Replace with a tighter system prompt that asks ONLY for structural decomposition (primary + attached + relation + refs + format + commandHint).
- Update parsers (`parseAction`, `parsePrimaryAttached`) to read actions without an `intent` field. Action carries `action`, `subject`, `relation`, etc., but NOT `intent`.
- Update `DecomposedAction` interface accordingly.

Tests:
- Decomposer returns structured actions with no intent field.
- Multi-action splitting still works ("design X then implement it" → 2 actions, depends relation).
- File ref extraction still works.
- The rule from the bug ("Informational questions ... are research") is gone -- explicit test that the prompt does NOT contain the string.

## Phase 6 -- chat-handler routes everything through resolveIntent    (was Phase 3)

`daemon/chat-handler.ts`:

- Family-direct slash dispatchers (`runCodeAnalyzerSlash`, `runDataAnalyzerSlash`): call `resolveIntent(session, prompt, { slashForced: 'code-analysis' | 'data-analysis' })` BEFORE dispatching to the orchestrator. Pass the resolved object into the orchestrator (replaces the existing tag-stamping I added in Phase 4 of conversation-flow-refinement).
- Intent slashes: same -- call `resolveIntent(..., { slashForced: <intent> })`.
- Regular chat path: call `decompose(...)` for structural split; then for each action call `resolveIntent(session, action.action)` in `Promise.all`. Pair actions with their resolved intents.
- Delete the fallback `classifyPrimaryIntent` call (line 1803). Resolver handles all intent resolution now.
- Delete any direct `setTag(INTENT_TAG_CURRENT, ...)` calls scattered through the file (the orchestrator's `buildInitialTasks` had one; remove). Resolver is the only writer.

Tests:
- /code-analyze X stamps tag; orchestrator receives ResolvedIntent.
- Regular chat with single action calls resolver once.
- Regular chat with multi-action calls resolver N times in parallel.
- Follow-up turn after /code-analyze: tag is present; resolver hits the fast path with continuation heuristic.

## Phase 7 -- prune redundant code    (was Phase 4)

- `agent/classify/intent.ts:classifyPrimaryIntent` becomes private (or moves into `agent/intent/resolver.ts`). Only resolver calls it.
- Remove any standalone `parsePrefix` consumer in chat-handler -- resolver handles prefixes now.
- Remove the orchestrator's `INTENT_TAG_CURRENT` / `INTENT_TAG_TIMESTAMP` writes from `buildInitialTasks` (made redundant by the slash-forced resolver path).

Tests:
- All existing intent / classify / resolver tests still pass.
- New integration test: a 2-turn session where turn 1 is `/code-analyze describe this repo` and turn 2 is `elaborate on the core filesystem design`. Assert turn 2 resolves to `code-analysis` via the tag-reuse fast path (no LLM classify call). This is the regression test for the bug that triggered this plan.

## Phase 8 -- documentation + rule enforcement    (was Phase 5)

- Add a one-paragraph "Intent classification" section to `CLAUDE.md`: states the rule. Lists `resolveIntent` as the only legal entry point.
- Add a `// CLAUDE: do not classify intent here -- call resolveIntent(session, message) instead.` banner comment at the top of any module that previously had its own classification (decompose, classify/intent, etc.).
- Lint rule (or PR-review checklist item): no new code path may import `classify` for intent purposes; only the resolver may.

## Phase 9 -- regression suite    (was Phase 6)

- Test: every chat-handler dispatch path stamps the `[intent:current]` tag exactly once.
- Test: any file under `src/insrc/agent/` other than `intent/resolver.ts` that imports `classifyPrimaryIntent` fails CI (grep-based assert).
- Test: the decomposer's system prompt does not contain any intent-classification rules (grep-based assert).
- Test: the cold-classify path emits a `relationship` field on every result; the slash-forced / override / tag-reuse paths emit `relationship: undefined`.
- Test: the response-segment vec table is purged when the session closes (no leak across sessions).
- Test: assistant responses with markdown headings produce one segment per heading; small tail chunks are coalesced.
- Test: when the LLM returns citations referring to keys not in the memory section, those citations are dropped (defensive).
- 2-turn integration test (the regression for the trigger bug):
  - Turn 1: `/code-analyze describe what this repo does` -- assistant emits a multi-section report including a "## HDFS Core" section.
  - Turn 2: regular chat (no slash): `elaborate on the core filesystem design/architecture`.
  - Assert: turn 2 resolves to `code-analysis` (NOT research).
  - Assert: turn 2's `relationship` is `DRILL_DOWN` (or `FOLLOWUP`) with at least one segment citation pointing back to turn 1's HDFS section.

---

## Sequencing

Phases 1, 2, 5 can ship in parallel; phases 3, 4, 6 are sequential gates. Suggested order:

1. **Phase 1** (resolver gains slash-forced path) -- 1 day. Independently testable. Standalone -- no dependencies.
2. **Phase 2** (response-segment vec substrate) -- 2 days. Independently testable. Standalone.
3. **Phase 3** (classifier memory retrieval helper) -- 1.5 days. Depends on Phase 2.
4. **Phase 4** (classifier memory context + relationship enum + citations) -- 2 days. Depends on Phase 3.
5. **Phase 5** (decomposer prompt rewrite) -- 1-2 days. Locks the trigger bug fix in. Standalone.
6. **Phase 6** (chat-handler rewires) -- 2 days. The big surgery. Depends on Phases 1, 4, 5.
7. **Phase 7** (prune dead code) -- 0.5 day. Depends on Phase 6.
8. **Phase 8** (docs / rule enforcement) -- 0.5 day. Depends on Phase 6.
9. **Phase 9** (regression suite) -- 1.5 days. Depends on all of the above.

Total estimate: **12-14 days** of focused work (~doubles from the original 6-7 because of the memory-augmented classifier).

---

## Standing rule (record this in CLAUDE.md after Phase 8)

> **All intent classification goes through `resolveIntent(session, message)`. No other module classifies user-message intent. The decomposer splits structure only; it does not pick intents. Slash-forced paths still call `resolveIntent` with `{ slashForced }` so the `[intent:current]` tag stays consistent across paths and the next turn can reuse it. The cold-classify path inside the resolver pulls a memory context (top-3 most-relevant prior turns + top-3 most-relevant prior response segments via ANN) and emits a typed `relationship` (NEW / FOLLOWUP / DRILL_DOWN / RESPONSE_TO / CONTINUATION / CORRECTION / COMPARE_WITH / TANGENT) with citation refs. New code that wants to know the intent of a user message imports `resolveIntent` from `agent/intent/resolver.ts` -- no exceptions. New code that wants to know how the prompt relates to prior turns reads `resolved.relationship` -- no parallel relationship classifiers.**

This rule is recorded in:
- `CLAUDE.md` (top-level project conventions)
- This plan (`plans/intent-classification-consolidation.md`)
- The Claude Code agent's persistent memory at `~/.claude/projects/.../memory/`
