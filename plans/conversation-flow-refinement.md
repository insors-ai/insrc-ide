# Plan: Conversation-Flow Refinement (LLM Memory + Follow-Ups)

Refines the chat session so that follow-up turns carry the *facts*
they need from prior turns -- not just tonal continuity. Today every
analyzer slash-command (`/code-analyze`, `/data-analyze`, ...) runs
its meta-skills pipeline cold. The LLM router (`code.meta.classify-
question` + `code.meta.select-scope`) has no memory of:

- the prior turn's intent classification (was the last turn an
  analysis run? a brainstorm? a debug session?),
- the prior turn's *structured outputs* (e.g. the `topModules` list
  the report referenced by friendly labels like "HDFS Core"),
- which file / entity / connection the user was last looking at.

Symptom that prompted this plan (2026-05-10): the user ran
"describe what this repo does" against the hadoop fixture, the
report listed modules including "HDFS Core", and a follow-up
"describe HDFS Core" returned `{ found: false, reason: 'no-files-
in-module' }` -- because `select-scope` had no map from the
friendly label to the actual `modulePath` the prior turn had
surfaced. The skill itself was right to refuse; the meta layer
was starving for context.

Existing `ContextManager` (`src/insrc/agent/context/index.ts`)
already supports the architectural primitives -- L2 rolling
summary, L3a recent turns, L3b semantic history backed by the
`session_vec` Lance table, and a `tags` map for cross-pipeline
references. The refinement is to **use those primitives more
deliberately at the meta-skill layer** + index a class of
artefacts that's currently unindexed (LLM output spills under
`~/.insrc/tmp/`).

---

## Related plans

- [plans/analyzers/code-analyzer-skills.md](./analyzers/code-analyzer-skills.md) -- the skills that run inside each analyzer turn. Phase 7 (LLM-routed meta) is the layer this plan refines.
- [plans/classification-rewrite.md](./classification-rewrite.md) -- the unified `classify({ classes, text })` module. The intent-classification step in this plan is built on top of that.
- [plans/context-aware-provider.md](./context-aware-provider.md) -- the `ContextAwareProvider` wrapping that auto-injects L1-L5 + auto-records turns. Important: the meta skills today bypass this path (they use `runSkill` with raw providers via `resolveProvider`). One question this plan answers is whether they should switch.
- [plans/analyzers/data-analyzer-skills.md](./analyzers/data-analyzer-skills.md) §7.1 -- already declares a `priorContext: { repoPath?, sessionTags? }` input on `data.meta.classify-question`; the field is partially-wired. The code-analyzer mirror dropped it. This plan unifies the shape across both analyzers.

---

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Audit + alignment commits (this doc + the surface-mapping referenced below) | drafted 2026-05-10 |
| 1 | Per-session intent state + persistence | pending |
| 2 | Per-session output spill directory + Lance indexing | pending |
| 3 | Relevance retrieval (intent × semantic × recency) + question-enhancer step | pending |
| 4 | Wire enhancer into the chat-handler + analyzer orchestrators | pending |
| 5 | Cross-intent correlation -- enhancer pulls from prior intents too | pending |
| 6 | Acceptance: HDFS-Core regression test + 3 sibling cases | pending |

---

## Goals

1. **A follow-up turn knows what the prior turn produced.** Specifically: structured outputs (module lists, entity hits, table descriptions, ORM models) the prior turn surfaced via a skill must be indexed and discoverable by the next turn's question-enhancer.
2. **Intent persistence.** The chat session remembers its current intent (code-analysis, data-analysis, brainstorm, debug, ...) and when a user types a short follow-up ("now look at HDFS Core") the session resolves the intent from prior state instead of re-classifying cold.
3. **Cross-intent correlation.** Even when the user switches intent ("now show me the schema for the table this loads from"), the question-enhancer can pull *correlated* prior outputs (e.g. last code-analysis surfaced a `users` table reference, current data-analysis question references that table).
4. **Bounded cost.** The enhancer is one extra LLM call per turn, on the cloud-small-tier (same affinity as classify-question). All retrieval is local (vector ANN + recency math); only the enhancement itself touches the LLM.
5. **Determinism + observability.** Every relevance score is recorded; the audit pane can show "this answer used these prior outputs because of this match score".

---

## Non-goals

- A persistent cross-session memory layer (separate plan; the existing cross-session retrieval already handles a coarser form via L3b).
- Auto-routing follow-up questions to a different analyzer when the intent shifts mid-conversation. The enhancer adds context; the existing router still picks the analyzer.
- Replacing the existing slash-command UX. Slash commands stay; the enhancer fires whether the input came from a slash command or from a free-form chat message.
- A workbench inspector pane for the enhancement traces. Tracing into the existing `skill-trace` panel is in scope; a new pane is not.

---

## Existing primitives (what we build on)

### `ContextManager` (`src/insrc/agent/context/index.ts`)

Already shipped. Layers:
- **L1 system context** -- static; built at session init.
- **L2 rolling summary** -- evicted turns roll up here via `evictToSummary`.
- **L3a recent turns** -- `MAX_RECENT_TURNS` newest-first; `weightedRecent`/`weightedRecentTurns`.
- **L3b semantic history** -- `SemanticHistory.add(turn, embedding)` writes to the `session_vec` Lance table; `retrieve(queryEmbedding)` returns similarity hits.
- **L4 task context** -- code-graph entity fetch via `fetchTaskContext`.
- **Tags map** -- `setTag('[intent:current]', 'code-analysis')` / `getTag(...)`. Already used elsewhere for `[requirements]`, `[plan:id]`, etc. Eviction-resistant: the summary is appended with `tag: (stored)` so the LLM can see the tag still exists after the body falls out of L3a.

Surface gaps:
- `recordTurn` only takes `{ userMessage, assistantResponse, entityIds }`. It doesn't take **structured tool outputs** -- so a skill that emits `{ topModules: [...] }` writes nothing into L3b that the next turn can search by.
- `tags` are written but never queried by the meta skills (no `priorContext` plumbing yet on `code.meta.classify-question` / `code.meta.select-scope`).

### `session_vec` (`src/insrc/db/lance/session-vec.ts`)

Lance table keyed by session id; stores conversation-turn embeddings. Already exists; already populated by `ContextManager.recordTurn`. We'll add **a parallel artifact-vec record** for indexed LLM outputs (separate from turn embeddings).

### Output spills (`~/.insrc/tmp/`)

Today: ad-hoc. The closest established writer is `agent/tools/loop.ts:187` (`tempDir = join(tmpdir(), '.insrc', 'tool-output')`). The orchestrator's synthesise step writes the rendered report markdown into the framework's `TodoList.body` -- it doesn't currently spill to `~/.insrc/tmp/`. This plan introduces a **deliberate spill convention**: every analyzer-pipeline output (per-skill `value` blob + final synthesised report) gets written to `~/.insrc/tmp/<session_id>/<timestamp>-<kind>.json` AND indexed in a new `artifact_vec` Lance table.

### `classify` module (`src/insrc/agent/classify/index.ts`)

The classification-rewrite plan's unified module. Used by intent classification today via the chat-handler's intent dispatcher. We'll reuse it for the **intent-persistence step** (when the enhancer needs to decide whether the follow-up is "still on the prior intent" or has shifted).

### Skill audit ring (`session.skillAudit`)

Capped 1000-entry ring of `SkillEvent`s. Already includes structured `{ skillId, value, confidence, notes, toolCalls }` per `skill-end` event. We'll **reuse it as the in-memory cache** for the most-recent skill outputs (no extra storage; the indexing layer just writes to disk + Lance asynchronously after the event hits the ring).

---

## Architecture

### Step diagram

```
user message arrives
    |
    v
[1] intent-resolver
    - reads session.tag('[intent:current]')
    - if absent OR follow-up text shifts intent: classify(message, classes=[code-analysis, data-analysis, ...])
    - writes back the resolved intent + a confidence
    |
    v
[2] context-retriever
    - queries the artifact_vec Lance table for top-K artifacts by:
        score = w_intent * (intent match) +
                w_semantic * cosine(query_embedding, artifact_embedding) +
                w_recency * exp(-age_seconds / TAU)
    - K capped at 8; per-artifact payload truncated at 2 KB
    |
    v
[3] question-enhancer (LLM, cloud-small)
    - input: original user message + retrieved artifacts + current intent + L3a recent turns (already in context)
    - output: { enhancedQuestion: string, citedArtifactIds: string[], priorContext: PriorContext }
    - falls back to passing the raw message through on failure
    |
    v
[4] dispatch
    - the resolved intent + enhanced question + priorContext threads into the analyzer's
      meta-skills pipeline; the rest is unchanged
    |
    v
[5] artifact spill
    - on each skill-end event, the spill writer drops a JSON to
      ~/.insrc/tmp/<session_id>/<timestamp>-<skillId>.json
    - and writes an artifact_vec Lance row keyed by (session_id, timestamp,
      intent, skill_id, file_path, embedding)
```

### `PriorContext` shape (the bridge)

```ts
export interface PriorContext {
  /** What the resolved intent decided this turn is about. */
  readonly currentIntent: string;
  /** Whether the resolved intent matches the prior turn's. */
  readonly intentChanged: boolean;
  /** Top-K artifacts the retriever pulled. Already ranked. */
  readonly artifacts: readonly RetrievedArtifact[];
  /** Convenience: structured facts mined from artifacts (modules,
   *  entities, tables, ORM models the prior turns surfaced). The
   *  enhancer + the meta skills can read this directly without
   *  re-parsing artifact payloads. */
  readonly facts: PriorFacts;
}

export interface RetrievedArtifact {
  readonly id:        string;     // session_id:timestamp:skill_id
  readonly skillId:   string;
  readonly intent:    string;
  readonly timestamp: number;
  readonly score:     number;     // 0..1; the weighted relevance score
  readonly path:      string;     // ~/.insrc/tmp/<session_id>/...
  /** Inline preview (first ~2 KB of the value blob) so the enhancer
   *  doesn't have to read the disk file just to cite. */
  readonly preview:   string;
}

export interface PriorFacts {
  /** From any prior `code.source.repo.describe` or
   *  `code.source.module.describe` that returned topModules. Indexed
   *  by both `path` and `label` (the synthesise prompt's friendly
   *  label, when one was extracted). */
  readonly modules?: readonly { path: string; label?: string; fileCount?: number }[];
  /** From any prior `code.entity.locate-by-name` /
   *  `code.entity.summary` / `code.class.locate-references` hits. */
  readonly entities?: readonly { entityRef: string; name: string; kind: string; file?: string }[];
  /** From any prior `data.source.rdbms.describe-table` / list-tables. */
  readonly tables?: readonly { connectionId: string; name: string; columns?: string[] }[];
  /** From any prior `code.orm.resolve-model`. */
  readonly ormModels?: readonly { name: string; table?: string; dialect: string }[];
}
```

---

## Phase 1 -- per-session intent state + persistence

### 1.1 Intent state

Add a single `[intent:current]` tag write at every analyzer-pipeline entry.

```ts
// In code-analyzer-orchestrator.ts buildInitialTasks (and the data-analyzer mirror):
session.contextManager.setTag('[intent:current]', 'code-analysis');
session.contextManager.setTag('[intent:current.timestamp]', String(Date.now()));
```

The tag survives L3a eviction because `setTag` appends a `tag: (stored)` line to L2 summary. The body lives in the `tags` Map (in-memory).

### 1.2 Resolver helper

`src/insrc/agent/intent/resolver.ts`:

```ts
import { classify } from '../classify/index.js';
import type { Session } from '../session.js';

export interface ResolvedIntent {
  readonly id: string;            // 'code-analysis' | 'data-analysis' | ...
  readonly source: 'tag' | 'classified-fresh' | 'classified-shifted';
  readonly previousIntent?: string;
  readonly confidence: 'high' | 'medium' | 'low';
}

/**
 * Resolves the intent of an incoming user message:
 *   - If [intent:current] exists AND the message looks continuation-shaped
 *     (short, anaphoric, or invokes nouns from prior turn), reuse the tag.
 *   - Otherwise classify fresh, comparing to the prior tag to flag a
 *     shift (kept on the result for downstream telemetry).
 */
export async function resolveIntent(
  session: Session,
  message: string,
  classes: readonly { id: string; description: string }[],
): Promise<ResolvedIntent>;
```

Cheap LLM call only when the tag-and-anaphora heuristic doesn't trigger. Targets <300 ms p50.

### 1.3 Test

`agent/intent/__tests__/resolver.test.ts`:

- empty session + "describe this repo" -> classified-fresh, code-analysis
- session with `[intent:current]=code-analysis` + "now show me HDFS Core" -> tag-reused, code-analysis (continuation shape)
- session with `[intent:current]=code-analysis` + "what's the schema of the orders table" -> classified-shifted, data-analysis
- session with `[intent:current]=code-analysis` + classifier returns same intent -> tag-reused, code-analysis (no shift)

### 1.4 Acceptance

`session.contextManager.getTag('[intent:current]')` returns the most recently resolved intent at any point in the session. The HDFS-Core regression case now resolves to `code-analysis` from the tag without a fresh classify call.

---

## Phase 2 -- artifact spill + Lance indexing

### 2.1 Spill convention

Per-session subdirectory:

```
~/.insrc/tmp/<session_id>/
  <epoch_ms>-<skill_id>.json    -- skill outputs
  <epoch_ms>-synthesise.md      -- final report markdown (per analyzer run)
  <epoch_ms>-classify.json      -- classify-question raw outputs (debug aid)
```

JSON shape:

```json
{
  "session_id":  "<uuid>",
  "timestamp":   1778394707804,
  "intent":      "code-analysis",
  "skill_id":    "code.source.repo.describe",
  "skill_input": { "repoPath": "/repo/hadoop" },
  "value":       { "found": true, "fileCount": 12500, "topModules": [...] },
  "confidence":  "high",
  "notes":       []
}
```

`PATHS.tmp` already exists (`~/.insrc/tmp/`). Add `PATHS.sessionTmp(sessionId)` helper that returns `join(PATHS.tmp, sessionId)`.

### 2.2 Lance indexing

New table `artifact_vec` in `src/insrc/db/lance/artifact-vec.ts` (mirrors the shape of `session-vec.ts`):

```ts
interface ArtifactVecRow {
  id:         string;            // primary key: <session_id>:<timestamp>:<skill_id>
  session_id: string;
  intent:     string;
  skill_id:   string;
  timestamp:  bigint;            // epoch ms
  path:       string;            // disk file path
  preview:    string;            // first ~2 KB of the value blob (for inline cite)
  vector:     number[];          // embedding of the value blob (or its summary if too large)
}

export async function upsertArtifactVec(row: ArtifactVecRow): Promise<void>;
export async function queryArtifactVec(opts: {
  sessionId?:  string;
  intent?:     string;
  queryVector: number[];
  k:           number;
}): Promise<ReadonlyArray<ArtifactVecRow & { distance: number }>>;
export async function deleteArtifactsForSession(sessionId: string): Promise<number>;
```

### 2.3 Spill writer

`src/insrc/agent/artifacts/spill-writer.ts`. Subscribes to `session.skillAudit` events; on every `skill-end`:
- writes the JSON to `~/.insrc/tmp/<session_id>/...`
- embeds the value blob via `embedQuery(JSON.stringify(value))` (fallback: skill description + skill_id when blob is too large)
- upserts the artifact_vec row

Failure-tolerant: a disk write or embed failure is logged and dropped; the analyzer pipeline never blocks on spill.

### 2.4 Cleanup

On `session close`:
- `deleteArtifactsForSession(sessionId)` -- drops Lance rows
- `rm -rf ~/.insrc/tmp/<session_id>/`

A startup sweep removes orphan dirs (sessions whose entries aren't in the cross-session-retrieval index).

### 2.5 Test

`db/lance/__tests__/artifact-vec.test.ts`:
- upsert + query round-trip with known vectors
- intent-filtered query returns only the right intent's artifacts
- session-filtered query returns only the right session's artifacts
- delete cleans up

`agent/artifacts/__tests__/spill-writer.test.ts`:
- skill-end -> file appears + Lance row exists with matching id + preview
- write failure logged, skill-end ack still fires (audit chain unbroken)

---

## Phase 3 -- relevance retrieval + question-enhancer

### 3.1 Relevance scorer

`src/insrc/agent/intent/relevance.ts`:

```ts
export interface RelevanceWeights {
  intent:   number;   // default 0.3 -- match means current intent OR
                      //                a prior intent that produced
                      //                a same-domain artifact
  semantic: number;   // default 0.5 -- cosine similarity
  recency:  number;   // default 0.2 -- exp(-age_seconds / TAU)
}

export const DEFAULT_TAU_SECONDS = 60 * 30;      // 30 min half-life
export const DEFAULT_WEIGHTS: RelevanceWeights = { intent: 0.3, semantic: 0.5, recency: 0.2 };

export interface ScoredArtifact extends ArtifactVecRow {
  readonly distance: number;
  readonly intentMatch: number;     // 0 or 1
  readonly recency:     number;     // 0..1
  readonly score:       number;     // weighted sum
}

export function scoreArtifacts(
  hits: readonly (ArtifactVecRow & { distance: number })[],
  currentIntent: string,
  now: number,
  weights?: RelevanceWeights,
): ScoredArtifact[];
```

Returns artifacts sorted desc by score. Caller decides cut-off (top-K, score floor).

### 3.2 Retriever

`src/insrc/agent/intent/retriever.ts`:

```ts
export interface RetrieveOpts {
  readonly maxArtifacts: number;     // default 8
  readonly scoreFloor:   number;     // default 0.2
}

export async function retrievePriorContext(
  session: Session,
  enhancedQuery: string,
  resolvedIntent: ResolvedIntent,
  opts?: RetrieveOpts,
): Promise<PriorContext>;
```

Pipeline:
1. Embed `enhancedQuery` once.
2. `queryArtifactVec({ sessionId: session.id, queryVector: vec, k: maxArtifacts * 2 })` -- over-fetch so the score floor has room to filter.
3. `scoreArtifacts(hits, resolvedIntent.id, Date.now())`.
4. Filter `score >= scoreFloor`, slice to `maxArtifacts`.
5. Mine `PriorFacts` from the artifact previews (per-skill mining map: `code.source.repo.describe` -> modules; `code.entity.summary` -> entities; etc.).
6. Return `{ currentIntent, intentChanged, artifacts, facts }`.

### 3.3 Question-enhancer

`src/insrc/agent/intent/enhancer.ts`. One LLM call per turn (cloud-
small affinity), structured JSON output, schema-validated, with one
retry on validation failure (mirrors `classify-question`'s contract).

The enhancer always sees:

  1. **Prior facts** -- the mined structured data (modules,
     entities, tables, ORM models) from §3.2's facts-mining step.
     This is the primary surface for label -> identifier resolution
     and is small enough to inline in full.
  2. **Top-K artifact previews** (default `K = 3`) -- the first
     `previewMaxBytes` (default 2048) of each artifact's value blob,
     ordered by relevance score. Provides grounding text for
     references that the facts-mining step missed.
  3. **`spill_path` per artifact** -- absolute disk path to the
     full spill JSON. The LLM doesn't read it; it goes into the
     prompt for trace logging + the audit pane, AND the LLM can
     name an `artifact_id` in `requestArtifactIds` to ask for the
     full body to be inlined on a re-fetch round (see below).

The retriever fetches `maxArtifacts: 8` (§3.2) so the facts-mining
sees the broader pool; only the **top-3 by score** get inline
previews. Hard injection cap ~10 KB; on overflow we drop previews
from lowest-score first (facts always survive).

#### Output shape

```ts
export interface EnhancerInput {
  readonly originalMessage:        string;
  readonly priorContext:           PriorContext;
  /**
   * Set on the second pass when the first-pass output named
   * artifacts in `requestArtifactIds`. Each entry is the full
   * value blob loaded from disk (cap: ~16 KB per artifact).
   */
  readonly inlineFullArtifacts?:   readonly InlineFullArtifact[];
}

export interface InlineFullArtifact {
  readonly artifactId: string;
  readonly skillId:    string;
  readonly value:      unknown;       // the spill's raw value blob
}

export interface EnhancerOutput {
  readonly enhancedQuestion:   string;             // may equal original
  readonly citedArtifactIds:   readonly string[];  // sources used
  /**
   * IDs of artifacts whose 2 KB preview was insufficient. The
   * orchestrator re-fetches these (capped at 3) and re-prompts
   * with `inlineFullArtifacts` populated. A second populated
   * `requestArtifactIds` is IGNORED (one re-fetch round only --
   * hard cap to bound cost).
   */
  readonly requestArtifactIds: readonly string[];
  readonly notes:              readonly string[];
}

export async function enhanceQuestion(
  session: Session,
  input: EnhancerInput,
): Promise<EnhancerOutput>;
```

#### Prompt skeleton (literal shape)

```
SYSTEM:
You rewrite a brief follow-up into a self-contained question an
analyzer can answer cold.

Rules:
  1. If the raw message is already self-contained, return it
     unchanged. citedArtifactIds: [], requestArtifactIds: [].
  2. If the raw message references a noun that resolves UNIQUELY in
     `Prior facts`, replace the noun with the concrete identifier
     and cite the source artifact id.
  3. If a reference is ambiguous (matches multiple facts), surface
     the ambiguity in the rewritten question. The analyzer's
     select-scope step will gate on it.
  4. Never invent a noun that isn't in the raw message or in prior
     facts.
  5. If a preview is truncated and you genuinely need the full body
     to resolve a reference -- AND no fact resolves it -- list the
     `artifact_id` in `requestArtifactIds` and STOP. The
     orchestrator will refetch and prompt you again with the full
     body inlined under `## Full artifact bodies`. Use sparingly:
     bound is 3 ids; second-pass requests are ignored.

Output strict JSON:
  { enhancedQuestion, citedArtifactIds, requestArtifactIds, notes }

USER:
## Original message
{originalMessage}

## Current intent
{currentIntent}  (intentChanged: {true|false})

## Prior facts (mined; primary -- prefer these for label→identifier)
### Modules ({n})
- /repo/hadoop/.../hadoop-hdfs-project/  (label: "HDFS Core", 240 files)
- /repo/hadoop/.../hadoop-yarn-project/  (label: "YARN", 180 files)
### Entities ({n})
(none in this turn)
### Tables ({n})
- prod-db.users  (cols: id, email, created_at)
### ORM models ({n})
(none)

## Recent artifacts (top-3 by relevance)
[1] score=0.81  intent=code-analysis  age=2m  code.source.repo.describe
    artifact_id: 9a4c1f8e:1778394707:code.source.repo.describe
    spill_path:  ~/.insrc/tmp/9a4c1f8e/1778394707-code.source.repo.describe.json
    preview (2 KB of 47 KB):
    ```json
    {"fileCount":12500,"topModules":[...]}    (truncated)
    ```
[2] score=0.34  intent=code-analysis  age=5m  code.source.module.describe
    artifact_id: 9a4c1f8e:1778394920:code.source.module.describe
    spill_path:  ~/.insrc/tmp/9a4c1f8e/1778394920-code.source.module.describe.json
    preview (full -- 1.3 KB):
    ```json
    {"found":true,"modulePath":"/repo/hadoop/.../hadoop-yarn-project/"}
    ```

## Full artifact bodies        ← only populated on the second pass
[1] artifact_id: ...
    ```json
    { ...full value blob... }
    ```
```

#### Re-fetch round

```
runEnhancer(input):
    out  = callLLM(buildPrompt(input))
    parsed = parseAndValidate(out)
    if !parsed.ok:
        out = callLLM(buildPrompt(input, retryHint=parsed.failure))   // 1 validation retry
        parsed = parseAndValidate(out)
        if !parsed.ok: return passThrough(input.originalMessage, note=parsed.failure)

    if parsed.value.requestArtifactIds.length > 0:
        ids   = parsed.value.requestArtifactIds.slice(0, 3)         // hard cap
        full  = await Promise.all(ids.map(readArtifactById))
        out2  = callLLM(buildPrompt({...input, inlineFullArtifacts: full}))
        parsed2 = parseAndValidate(out2)
        // The second pass's requestArtifactIds is IGNORED (no chained refetch).
        if parsed2.ok: return { ...parsed2.value, requestArtifactIds: [] }
        else:          return parsed.value   // first-pass rewrite is the fallback

    return parsed.value
```

Worst-case cost per turn: 2 LLM calls + 3 disk reads. p50 expected:
1 LLM call, 0 disk reads.

#### Provider affinity

`cloud` (small tier -- same as `classify-question` / `select-scope`).

### 3.4 Test

`agent/intent/__tests__/enhancer.test.ts`:
- empty priorContext + raw "describe this repo" -> unchanged + no citations + no requestArtifactIds
- priorContext has `modules: [{ path: '/repo/hadoop/...hadoop-hdfs/...', label: 'HDFS Core' }]` + raw "describe HDFS Core" -> enhanced to `"describe the module at /repo/hadoop/.../hadoop-hdfs/..."` + 1 citation
- ambiguous label "describe Core" with two matching modules -> question surfaces both alternatives
- all-LLM-output retries on invalid JSON -> degrades to original message + low-confidence note
- **First-pass requests artifact bodies** -> orchestrator inlines the full bodies + re-prompts; second-pass output is honored
- **Re-fetch hard cap**: second-pass output ALSO names `requestArtifactIds` -> ignored; we keep the second-pass rewrite, no third LLM call
- **Re-fetch cap on count**: first-pass requests 7 ids -> only the first 3 are loaded
- **Spill path appears in prompt + trace**: a snapshot test on `buildPrompt()` output asserts the `spill_path:` line is present per artifact (so the audit pane has the pointer)

---

## Phase 4 -- chat-handler + orchestrator wiring

### 4.1 Chat-handler integration point

In `daemon/chat-handler.ts` (where the user message first lands), wrap the existing dispatch:

```ts
// Pseudo-code; locations + names will be confirmed by the wiring step.
const resolvedIntent = await resolveIntent(session, userMessage, INTENT_CLASSES);
const priorContext   = await retrievePriorContext(session, userMessage, resolvedIntent);
const enhanced       = await enhanceQuestion(session, { originalMessage: userMessage, priorContext });

// Dispatch to the existing analyzer / chat path with the enhanced question.
// The pipeline reads priorContext from session via getPriorContext() (set
// alongside the [intent:current] tag below).
session.contextManager.setTag('[priorContext:current]', JSON.stringify(priorContext));
session.contextManager.setTag('[intent:current]', resolvedIntent.id);
return dispatchToAnalyzer(resolvedIntent.id, enhanced.enhancedQuestion);
```

### 4.2 Skill input plumbing

`code.meta.classify-question` and `code.meta.select-scope` (and their data-analyzer mirrors) gain a `priorContext?: PriorContext` input field. The orchestrator's `runSkillsPipeline` reads the tag-set context and threads it through.

### 4.3 Skill-side use

`code.meta.select-scope` becomes the primary consumer of `priorContext.facts`. Its prompt grows:

```
... The active repo is ___. Prior turns in this session have produced
the following structured facts you can resolve references against:

Modules: [ { path, label, fileCount } ]
Entities: [ ... ]
Tables: [ ... ]
ORM models: [ ... ]

When the user references a friendly label ("HDFS Core") that matches
one of these facts, fill the skill's `args` with the concrete
identifier (modulePath / entityId / connectionId+target). When a
reference is ambiguous, surface it via the existing ambiguity arm.
```

### 4.4 Tests

- `agent/intent/__tests__/integration.test.ts`: simulates the HDFS-Core regression turn-pair end-to-end against a fake LLM. Asserts the second turn's `select-scope` receives `priorContext.facts.modules` containing the HDFS path.
- An orchestrator-level smoke that walks the full chat-handler -> resolver -> retriever -> enhancer -> meta-skills chain with stubbed providers.

---

## Phase 5 -- cross-intent correlation

### 5.1 The case

User runs `/code-analyze "describe this repo"` -> report mentions a `users` table the indexer surfaced as a foreign-citation. User then asks "what's the schema of users" (data-analysis intent).

The retriever's intent filter must NOT exclude code-analysis artifacts when the current intent is data-analysis. Solution: the relevance score's intent term is **graded**, not boolean.

```ts
function intentMatch(artifactIntent: string, currentIntent: string): number {
  if (artifactIntent === currentIntent) return 1.0;
  if (areCorrelated(artifactIntent, currentIntent)) return 0.5;
  return 0;
}

function areCorrelated(a: string, b: string): boolean {
  const pairs = [
    ['code-analysis', 'data-analysis'],   // schemas in code reference DB tables
    ['data-analysis', 'code-analysis'],
    ['code-analysis', 'debug'],
    // ...
  ];
  return pairs.some(([x, y]) => x === a && y === b);
}
```

### 5.2 The enhancer's job in cross-intent

When the resolver flags `intentChanged: true`, the enhancer's prompt includes a one-line "Note: intent shifted from X to Y" so the LLM understands prior facts may need translation (e.g. a code-side `users` reference becomes a data-side `connectionId+target=users` reference).

### 5.3 Test

- session has run `/code-analyze` -> mining stored a `users` table reference under `priorContext.facts.tables`. Then user asks "schema of users" -> resolver flags shift to data-analysis -> retriever still returns the `users` artifact (correlated intent) -> enhancer rewrites with the concrete `(connectionId, target=users)` -> data-analyzer's select-scope fills args.

---

## Phase 6 -- acceptance + the regression suite

### 6.1 The HDFS-Core case (the trigger)

End-to-end test under `daemon/controllers/__tests__/code-analyzer-multiturn.test.ts`:

1. Seed a fake repo with a `hadoop-hdfs` directory + a few Java entities.
2. Run `/code-analyze "describe this repo"` against it. Capture the report; assert `topModules` includes the HDFS path; assert the synthesise prompt produced the friendly label "HDFS Core" (or whatever the repo-describe synthesise renderer emits).
3. Same session, run `/code-analyze "describe HDFS Core"`.
4. Assert the meta-skills pipeline received `priorContext.facts.modules` with the HDFS entry.
5. Assert `code.source.module.describe` was called with the concrete HDFS path -- not "HDFS Core".
6. Assert the second turn's report covers the HDFS module (not the no-files-in-module refusal).

### 6.2 Sibling cases

- Code-analyzer entity drill-down: turn 1 lists callers of `compute()`; turn 2 asks "why does main call this" -> resolver maps "this" to `compute` from prior facts.
- Data-analyzer table drill-down: turn 1 describes the `orders` table; turn 2 asks "show me the latest 50 rows" -> select-scope receives `priorContext.facts.tables` with `orders`.
- Cross-intent: turn 1 code-analysis surfaces a Postgres connection reference; turn 2 data-analysis "what's its schema" resolves the connection from prior facts.

### 6.3 Negative-path tests

- Stale prior context: turn 1 from 2 hours ago -> recency weight pulls score below floor -> artifact excluded; enhancer treats turn 2 as cold.
- Ambiguous reference: prior facts have two `User` entries (one Java class, one TS interface) -> enhancer surfaces both, select-scope's ambiguity arm fires.
- Disk-spill failure: artifact-vec write throws -> spill-writer logs + drops; the analyzer pipeline still completes (no cascade failure).

---

## Sequencing recommendation

The phases are largely orthogonal but Phase 4 depends on 1+2+3 to have something to wire. Recommended order:

1. **Phase 1** (intent state) -- 1-2 days; lands the tag + resolver helper. Independently useful.
2. **Phase 2** (spill + index) -- 2-3 days; lands the disk + Lance plumbing. Independently testable; the artifacts are queryable from the workbench skill-trace pane immediately.
3. **Phase 3** (retriever + enhancer) -- 2-3 days; lands the relevance scorer + the LLM enhancer. Independently testable end-to-end with synthetic fixtures.
4. **Phase 4** (wiring) -- 1-2 days; rewires chat-handler + meta skills. The HDFS-Core regression begins to pass partway through.
5. **Phase 5** (cross-intent) -- 1 day; one helper + a prompt-line addition. Cheap once Phase 3 has shipped.
6. **Phase 6** (regression suite) -- 1-2 days; locks the lessons in.

Total estimate: ~10-13 days of focused work.

---

## Open questions

1. **Embedding budget**. Every skill-end currently produces one Lance write + one embed call. For a typical analyzer run (5-15 skills), that's 5-15 extra Ollama embed calls per turn. Acceptable for now; revisit if we see latency.
2. **Artifact retention**. Per-session deletion on close is clear; what about long-running sessions that accumulate hundreds of artifacts? Cap per session (LRU at 100? rolling 24-hour window?).
3. **Rendered-report access**. The synthesise output (`<ts>-synthesise.md`) is now indexed alongside skill-output spills and discoverable via `requestArtifactIds` (§3.3). That covers the "needs the prose to disambiguate" case without inlining the whole report by default. Open: should the rendered report be **boosted** in the score (e.g. always make it eligible for top-3 previews when same-intent + same-session)? Worth measuring after live use; defaulting to "no, treat it like any other artifact" for v1.
4. **Tag naming**. `[intent:current]` is precedent-following, but do we want `[priorContext:facts]` separately from the in-memory `PriorContext` object? This plan threads the object through `setTag(JSON.stringify(...))`; an alternative is a typed first-class slot on `ContextManager`. The first is faster to ship; the second is cleaner long-term.
5. **Workbench trace UI**. The skill-trace pane already shows the per-skill audit. Should it grow a "this turn used these prior artifacts" subsection, sourced from `EnhancerOutput.citedArtifactIds`? Worth a follow-up plan.
6. **Failure mode of the enhancer**. If the LLM is down / over-budget, do we fall back to (a) raw user message, (b) raw user message + raw `PriorContext` JSON appended, or (c) abort and tell the user? This plan picks (a) for simplicity; (b) might be worth measuring.

---

## Acceptance for the whole plan

- The HDFS-Core 2-turn regression test passes.
- All three sibling regression tests pass.
- The skill-trace pane shows the resolver decision + the retrieved artifacts + the enhanced question for every turn (existing pane; no UI work in this plan).
- The daemon `tsc --noEmit` + `scripts/build.sh daemon` stay clean.
- Per-turn p50 latency overhead from the resolver + retriever + enhancer combined is &le; 800 ms (one cloud-small LLM call + one embed call + one Lance ANN).
