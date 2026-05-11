# Intent funnel follow-ups -- gaps surfaced during real-world testing

**Status:** open
**Surfaced:** 2026-05-11 during live test of `plans/intent-classification-consolidation.md` after Phase 7 + 9 landed (`b15c506f700`).
**Test scenario:** `/code-analyze describe what this repo does` followed by `drill down into HDFS`. Both prompts classified correctly (`code-analysis`, relationship `DRILL_DOWN`), but the classifier context was thinner than the Phase 4 design intended.

These are bugs and gaps that DON'T block the consolidation -- the funnel is working. They block the classifier from being as informed as it should be on follow-ups.

---

## 1. Continuation heuristic misses `drill down`

**Where:** [agent/intent/resolver.ts:161 CONTINUATION_LEAD regex](src/insrc/agent/intent/resolver.ts#L161)

**Bug:** The regex includes `drill into` but not `drill down`. A user typing "drill down into HDFS" falls through to the cold-classify path instead of the cheap tag-reuse fast path. Same answer either way (the cold path still picked `code-analysis`), but burns an LLM call and a memory retrieval per turn for a textually obvious continuation.

**Fix:** Extend the regex alternation:
```ts
drill\s+(?:into|down(?:\s+into)?)
```

**Why:** Saves ~3-5s and one Ollama embed + one Anthropic LLM call per drill-down turn. Multiply by every "drill down" the user types in a session.

**Effort:** 5 min + new test cases in `resolver.test.ts:looksLikeContinuation`.

---

## 2. Assistant-side turn excerpts MISSING from classifier memory

**Where:** `## Recent context` rendered by [agent/classify/intent.ts:renderMemoryContextBlock](src/insrc/agent/classify/intent.ts) gets fed turn hits from [agent/intent/classifier-memory.ts:hydrateTurnHits](src/insrc/agent/intent/classifier-memory.ts).

**Symptom:** Both turn excerpts in the rendered context were USER-side. The prior `/code-analyze` had just produced a 12-section report 3 min before -- none of it surfaced. The LLM had no idea which section had HDFS content; the relationship classification was correct only because the user message itself ("drill down into HDFS") + the prior user message ("describe what this repo does") were enough to infer DRILL_DOWN without seeing the assistant output.

```
[t1] (3 min ago, USER, relevance 0.43, id=...:1)
      > /code-analyze describe what this repo does
[t2] (14 hr ago, USER, relevance 0.43, id=...:0)
      > /code-analyze describe what this repo does
```

**Root cause (suspected):** The hydrator emits one TurnMemoryHit per non-empty side of each turn (user + assistant). Two turns × two sides = 4 candidates. Top-3 by recency would normally include at least one assistant excerpt. Only seeing 2 user-side excerpts means **both turns' `assistant` field in LMDB is empty**.

**Why empty?** Two paths to investigate:
1. `runCodeAnalyzerSlash` in [daemon/chat-handler.ts](src/insrc/daemon/chat-handler.ts) calls `await persistTurn(session, originalMessage, result.finalOutput, result.finalFormat)`. Is `result.finalOutput` the full report or a stub? The orchestrator owns `result` -- audit `CodeAnalyzerOrchestratorController` for what it populates `finalOutput` with.
2. The orchestrator may be flushing markdown to the IDE via a side channel (`send({ stream: 'delta', ... })`) and `result.finalOutput` ends up as an empty string / one-liner because the streaming bypassed accumulation.

**Fix sketch:** Verify `persistTurn` receives the full assistant body. If not, the orchestrator's result-builder needs to populate `result.finalOutput` with the rendered report.

**Effort:** ~30 min investigation + small fix.

---

## 3. `response_segment_vec` empty for an active session

**Where:** Phase 2 indexing hook in [daemon/chat-handler.ts:indexResponseSegments](src/insrc/daemon/chat-handler.ts) (the `void indexResponseSegments({...})` fan-out after `persistTurn`).

**Symptom:** `classifier-memory retrieved` log line showed `segments: 0` for a session with a recent 12-section assistant report. The Phase 2 chunker should have produced ~12 segments (one per `##` heading) and the indexer should have embedded + upserted each into `response_segment_vec`.

**Possible causes (in order of likelihood):**
1. **`persistTurn` not called with the full report.** Same root cause as #2 -- if the assistant field is empty, the chunker returns 0 chunks and nothing gets indexed. Fixing #2 likely fixes this.
2. **`embedText` returning empty** -- Ollama embeddings unavailable / slow. The indexing fan-out drops rows whose embedding came back empty. Check daemon log for `embedText` Ollama errors.
3. **Chunker filtering everything** -- unlikely; the chunker has lenient defaults (200-char min, 1500-char max). A 12-section markdown report should easily clear minimum.
4. **`response segments indexed` debug line never emitted** -- means the indexer didn't even run. Grep daemon log for that string after a `/code-analyze` turn to confirm.

**Investigation steps:**
```bash
grep "response segments indexed" /tmp/.insrc/agent.*.log
grep "response-segment indexing" /tmp/.insrc/agent.*.log
```

**Effort:** ~30 min depending on root cause.

---

## 4. `code.meta.select-scope` skill chokes on markdown-fenced JSON

**Where:** `skill.code.meta.select-scope` (file location unknown -- skill package). The warning came at [agent.5.log:1778489725246](#).

**Symptom:**
```
JSON parse failed: Unexpected token '`', "```json\n{\n\"... is not valid JSON
"select-scope retry rejected; surfacing low confidence"
```

The LLM (likely Anthropic given the planner config) returned the scope JSON wrapped in ` ```json ... ``` ` fences. The skill's parser does a strict `JSON.parse` and rejects. The skill's retry policy gives up and marks the result low-confidence.

**Pre-existing issue.** Not related to the consolidation work. But it's a recurring pattern across skills.

**Fix:** Add a `stripFences` pre-step before `JSON.parse` in select-scope (and audit other meta-skills that may have the same gap). The classifier module already has the helper at [agent/classify/index.ts:stripFences](src/insrc/agent/classify/index.ts) -- consider moving it to `shared/` and reusing across skills.

**Effort:** ~30 min for select-scope + audit of other skills.

---

## 5. Citation hydration silently drops `[tN]` / `[sN]` keys

**Where:** [agent/intent/resolver.ts:hydrateCitationKey](src/insrc/agent/intent/resolver.ts) -- the regex `^([ts])(\d+)$` matches bare keys (`t1`, `s2`) but NOT bracketed keys (`[t1]`, `[s2]`).

**Symptom:** Live LLM call (llmCallId=128 in agent.5.log) returned
`"citations": ["[t1]", "[t2]"]` -- with brackets. The hydrator regex
rejected both, so the resolver logged `citations: 0` even though the
LLM tried to cite both turns. 100% citation-loss rate observed in
the first live cold-classify follow-up.

**Why the LLM brackets them:** The classifier system prompt
references citation keys as `[t1]` / `[s2]` notation in the rules
section, AND the rendered `## Recent context` block prefixes each
item with the bracketed form (`[t1] (3 min ago, USER, ...)`). The
LLM copied the format faithfully.

**Two fixes (do both):**

1. **Loosen the hydrator** -- strip brackets before matching. Defensive
   against either format the LLM might emit:
   ```ts
   const m = key.trim().replace(/^\[|\]$/g, '').match(/^([ts])(\d+)$/i);
   ```

2. **Tighten the prompt** -- in [agent/classify/index.ts](src/insrc/agent/classify/index.ts) where the citation rules are rendered, add an explicit example: "Citations are BARE keys -- emit `t1`, not `[t1]`."

**Test:** Add a citation-format case to `relationship.test.ts` covering bracketed inputs.

**Effort:** 15 min for the regex fix + prompt tweak + test.

---

## 6. Scope tier descriptions are coding-centric; read-only intents always default to `M`

**Where:** [agent/classify/index.ts buildMessages](src/insrc/agent/classify/index.ts) rendered scope-tier block + [shared/classify.ts SCOPE_META](src/insrc/shared/classify.ts) descriptions.

**Symptom:** Live test classified "drill down into HDFS" (one of the
biggest subsystems in Apache Hadoop, ~50 modules) as `scope: 'M'`,
the same tier the classifier picks for a 1-paragraph touch-up. The
LLM has no scope vocabulary that fits read-only / analysis work.

**Root cause:** Every tier description is framed as "a change":

```
- S     -- one small, localized change (minutes of work)
- M     -- a few related changes in one module (single session)
- L     -- a feature or module-sized piece of work (multi-session)
- XL    -- subsystem-scale change spanning several modules
- XXL   -- multi-subsystem change (e.g. auth + storage + UI)
- XXXL  -- cross-cutting architectural change
- XXXXL -- major rewrite or new product direction
```

For read-only intents (`code-analysis`, `data-analysis`, `research`,
`review`, `document`, `brainstorm`) there's no concept of "a change"
to size. The LLM falls back to M.

**Downstream impact:** Scope drives planning budget, expand-step
depth, and report length in the analyzer pipeline. Treating
"describe whole repo" and "drill into one subsystem" identically
under M skews all of those.

**Proposed reframe -- work-volume neutral, reads for any intent:**

```
- S     -- one focused unit (a function, a column, a paragraph; minutes)
- M     -- one module / one report section / one focused query (single session)
- L     -- a full module or 5-10 sections / a feature build (multi-session)
- XL    -- a subsystem (HDFS / auth / storage layer; many modules)
- XXL   -- multiple subsystems (auth + storage + UI; or repo-wide analysis)
- XXXL  -- cross-cutting concern that touches every subsystem
- XXXXL -- whole-product / multi-product / major rewrite
```

These read sensibly for `code-analysis` ("a subsystem-scale report"
is XL just like "implement spanning several modules" is XL),
`data-analysis` ("an analysis across multiple tables" is L), and
`research` (still inherently bounded). The downstream consumers in
`SCOPE_META` (label + tooltip-style description) are already
intent-neutral so the reframe doesn't ripple beyond the prompt.

**Test:** Update the snapshot-style scope-tier assertions if any
exist; otherwise just verify the LLM picks XL for "describe HDFS
Core" on a large repo. Live testing is the real validation.

**Effort:** ~30 min including snapshot tests.

---

## 7. Code references in the analysis report should be clickable

**Where:** Code-analyzer Markdown output -- the per-section reports
emitted by the synthesize/expand/review pipeline and rendered in
the IDE's Report Pane.

**Symptom:** When the report mentions a class, file, function, or
module (`HdfsServerConstants`, `hadoop-hdfs-project/hadoop-hdfs/...`,
`NameNode#startCommonServices`, etc.) it appears as plain text. User
has to copy-paste into the file picker to navigate. The graph
already knows the file path for every entity surfaced by the
analysis -- the daemon's response just isn't formatting them as
links.

**Expected:** Each reference renders as a Markdown link the user
can click to jump straight to the file (or to the line if the
entity has line metadata). The VSCode extension's renderer (per
CLAUDE.md's notes about `[filename.ts](src/filename.ts)` /
`[filename.ts:42](src/filename.ts#L42)` syntax) already supports
clickable file links inside Markdown.

**Where to fix:** Two candidate layers --

1. **At the skill output layer** -- the skills that surface entity
   refs (`code.source.repo.describe`, `code.source.module.describe`,
   `code.entity.search-by-vector`, `code.entity.locate-by-name`,
   etc.) format their results into a structured shape the
   review-action LLM consumes. If those shapes carry `path` and
   `lineStart` alongside `name`, the LLM has everything it needs to
   emit Markdown links.
2. **At the review/render layer** -- alternatively, post-process the
   LLM's markdown to upgrade bare entity names into links by looking
   them up in the entity index. Riskier (false positives on common
   words that happen to match an entity name) but doesn't require
   teaching the LLM about Markdown link syntax.

**Recommendation:** Layer 1 is cleaner. Update the system prompt
for the synthesize/expand step to instruct: "When mentioning an
entity, file, or module, render it as a Markdown link using the
`path` / `lineStart` fields surfaced by the skills." Pre-condition:
make sure the skills' output JSON consistently carries those
fields (audit them; some may only emit `name`).

**Effort:** ~1 hr for the prompt change + skill-output audit + live
verification. Larger if more skills need their output shape
extended to include paths.

---

## Prioritisation

1. **#5 (citation regex)** -- highest impact relative to effort; 100% of LLM-emitted citations are currently dropped. 15 min.
2. **#1 (drill down regex)** -- trivial follow-on while in the resolver. 5 min.
3. **#2 (assistant-side missing)** -- biggest functional impact; the Phase 4 memory design is degraded until this is fixed.
4. **#3 (segments empty)** -- likely solves itself when #2 is fixed. Verify after the #2 fix lands.
5. **#7 (clickable code refs)** -- highest user-facing impact; reports are useless if the user can't navigate from a mention to the source. Bundle with the next code-analyzer prompt pass.
6. **#6 (scope tiers)** -- bigger semantic change; ship after observing more live runs to confirm the new descriptions land sensibly across all intents.
7. **#4 (select-scope fences)** -- robustness; sporadic. Bundle with the next skills-pipeline pass.
