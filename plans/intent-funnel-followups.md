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
1. `runCodeAnalyzerSlash` in [daemon/chat-handler.ts](src/insrc/daemon/chat-handler.ts) calls `persistTurn(session, originalMessage, result.finalOutput, result.finalFormat)`. Is `result.finalOutput` the full report or a stub? Compare `chat-handler:1495` area.
2. The orchestrator may be flushing markdown to the IDE via a side channel and `result.finalOutput` ends up as an empty string / one-liner.

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

## Prioritisation

1. **#1 (drill down regex)** -- trivial, ship next time we touch the resolver.
2. **#2 (assistant-side missing)** -- highest functional impact; the Phase 4 memory design is degraded until this is fixed.
3. **#3 (segments empty)** -- likely solves itself when #2 is fixed. Verify after the #2 fix lands.
4. **#4 (select-scope fences)** -- robustness; sporadic. Bundle with the next skills-pipeline pass.
