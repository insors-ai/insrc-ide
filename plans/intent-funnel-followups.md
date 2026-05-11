# Intent funnel follow-ups -- post-consolidation fix plan

**Status:** ready
**Owner:** subhagho@gmail.com
**Surfaced:** 2026-05-11 during live test of `plans/intent-classification-consolidation.md` (`b15c506f700`).
**Trigger bug:** confirmed FIXED end-to-end. `/code-analyze X` → `drill down into HDFS` correctly classifies as `code-analysis` with relationship `DRILL_DOWN`. These follow-ups improve quality and close gaps the live test surfaced -- none of them block the consolidation.

---

## Phase A -- quick wins (concrete diffs, ~1 hour total)

### A.1 Citation hydrator drops bracketed `[tN]` / `[sN]` keys

**Location:** [src/insrc/agent/intent/resolver.ts:326](src/insrc/agent/intent/resolver.ts#L326) `hydrateCitationKey`.

**Symptom:** Live LLM (llmCallId=128 in agent.5.log) returned `"citations": ["[t1]", "[t2]"]` -- with brackets. The hydrator's `^([ts])(\d+)$` regex rejected both, so the resolver logged `citations: 0` even though the LLM tried to cite both turns. **100% citation-loss rate observed in the first live cold-classify follow-up.**

**Why the LLM brackets them:** the system prompt references citation keys as `[t1]` / `[s2]` in the rules section, and the rendered `## Recent context` block prefixes each item with the bracketed form. The LLM copied the format faithfully.

**Fix (both edits):**

1. **Loosen the hydrator** -- strip brackets before matching:
   ```ts
   function hydrateCitationKey(key: string, memory: ClassifierMemory): MemoryCitation | undefined {
       const bare = key.trim().replace(/^\[|\]$/g, '');
       const m = bare.match(/^([ts])(\d+)$/i);
       if (m === null) return undefined;
       ...
   }
   ```

2. **Tighten the prompt** in [src/insrc/agent/classify/index.ts:81](src/insrc/agent/classify/index.ts) (the citation rules block rendered when `relationshipEnum` is supplied) -- add an explicit format note:
   ```
   - Citations are BARE keys: emit `"t1"`, NOT `"[t1]"`. The brackets
     in the recent-context block are visual markers only.
   ```

**Tests:** add to [src/insrc/agent/classify/__tests__/relationship.test.ts](src/insrc/agent/classify/__tests__/relationship.test.ts) -- a parser case verifying both bracketed AND bare citations survive end-to-end via `resolveIntent.hydrateRelationshipCitations`. Add to [src/insrc/agent/intent/__tests__/resolver.test.ts](src/insrc/agent/intent/__tests__/resolver.test.ts) -- bracketed citations resolve correctly.

**Success criteria:** after fix, the previously-observed `citations: ["[t1]", "[t2]"]` payload yields `citations: 2` on the resolver, with both hydrated `MemoryCitation` objects pointing at the right turns.

**Effort:** 15 min.

---

### A.2 Continuation heuristic misses `drill down`

**Location:** [src/insrc/agent/intent/resolver.ts:384](src/insrc/agent/intent/resolver.ts#L384) `CONTINUATION_LEAD` regex.

**Symptom:** the regex currently includes `drill into` but not `drill down`. Live test: `drill down into HDFS` fell through to cold-classify, burning an Ollama embed + an Anthropic LLM call when the tag-reuse fast path would have produced the same answer for free.

**Fix:** extend the alternation:

```ts
// BEFORE
... |describe|drill into|elaborate(?:\s+on)? ...

// AFTER
... |describe|drill\s+(?:into|down(?:\s+into)?)|elaborate(?:\s+on)? ...
```

**Tests:** add to [src/insrc/agent/intent/__tests__/resolver.test.ts](src/insrc/agent/intent/__tests__/resolver.test.ts) -- `looksLikeContinuation` returns `true` for `drill down into X`, `drill down on Y`, `drill down`.

**Success criteria:** a 2-turn session where turn 1 is `/code-analyze ...` and turn 2 is `drill down into HDFS` resolves via `source: 'tag'`, NOT `source: 'classified-fresh'`. Verified by inspecting `intent resolved (...)` log line.

**Effort:** 5 min.

---

### A.3 `select-scope` skills choke on unmatched markdown fences

**Locations:**
- [src/insrc/daemon/skills/built-ins/code.meta.select-scope.ts:527](src/insrc/daemon/skills/built-ins/code.meta.select-scope.ts#L527) `stripFences`
- [src/insrc/daemon/skills/built-ins/data.meta.select-scope.ts:401](src/insrc/daemon/skills/built-ins/data.meta.select-scope.ts#L401) `stripFences`

**Symptom:** live warning at agent.5.log:1778489725246 --
```
JSON parse failed: Unexpected token '`', "```json\n{\n\"... is not valid JSON
select-scope retry rejected; surfacing low confidence
```

The skill DOES call `stripFences` before `JSON.parse`, but the current implementation uses a regex that requires MATCHED open/close fences:

```ts
function stripFences(text: string): string {
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
    return fenceMatch !== null ? fenceMatch[1]! : text;
}
```

When the LLM emits an opening ` ```json ` but no closing fence (truncation, model quirk, etc.), the regex doesn't match and returns the raw text -- which still leads with ` ``` ` and fails parsing.

**Fix:** replace with the lenient version that already works in [src/insrc/agent/classify/index.ts:231](src/insrc/agent/classify/index.ts#L231) -- strip leading and trailing fences independently:

```ts
function stripFences(text: string): string {
    let out = text.trim();
    if (out.startsWith('```')) {
        out = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    return out.trim();
}
```

Audit the other built-in skills under [src/insrc/daemon/skills/built-ins/](src/insrc/daemon/skills/built-ins/) for any other strict-fence parsers; replace them too. Consider extracting `stripFences` to `src/insrc/shared/json-fences.ts` (or similar) so the four current copies stay in sync.

**Tests:** add to [src/insrc/daemon/skills/__tests__/](src/insrc/daemon/skills/__tests__/) -- one case each for: matched fences, open-only fence, no fences, fenced + trailing whitespace.

**Success criteria:** the same LLM payload that triggered the live warning (`"```json\n{...\n```"` AND `"```json\n{...\n"`) both parse successfully.

**Effort:** 30 min including the shared-helper extraction + audit of sibling skills.

---

### A.4 Scope tier descriptions are coding-centric

**Locations:**
- [src/insrc/agent/classify/index.ts:84-91](src/insrc/agent/classify/index.ts#L84-L91) -- the scope-tier block rendered into the classifier system prompt
- [src/insrc/shared/classify.ts:42-69](src/insrc/shared/classify.ts#L42-L69) `SCOPE_META` -- the label + description pair surfaced in the UI / logs

**Symptom:** live test classified "drill down into HDFS" (one of the biggest subsystems in Apache Hadoop, ~50 modules) as `scope: 'M'` -- identical to a one-paragraph touch-up. Every tier description is framed as "a change":

```
- S     -- one small, localized change (minutes of work)
- M     -- a few related changes in one module (single session)
- L     -- a feature or module-sized piece of work (multi-session)
- XL    -- subsystem-scale change spanning several modules
- XXL   -- multi-subsystem change (e.g. auth + storage + UI)
- XXXL  -- cross-cutting architectural change
- XXXXL -- major rewrite or new product direction
```

For read-only intents (`code-analysis`, `data-analysis`, `research`, `review`, `document`, `brainstorm`) there's no concept of "a change" to size. The LLM defaults to M.

**Downstream impact:** scope drives planning budget, expand-step depth, and report length in the analyzer pipeline. Treating "describe whole repo" and "drill into one subsystem" identically under M skews all of those.

**Fix:** replace the tier descriptions in BOTH locations with work-volume-neutral wording that reads sensibly for any intent:

**`agent/classify/index.ts` (the LLM prompt):**
```
- `S`     -- one focused unit (a function, a column, a paragraph; minutes)
- `M`     -- one module / one report section / one focused query (single session)
- `L`     -- a full module or 5-10 sections / a feature build (multi-session)
- `XL`    -- a subsystem (HDFS / auth / storage layer; many modules)
- `XXL`   -- multiple subsystems (auth + storage + UI; or repo-wide analysis)
- `XXXL`  -- cross-cutting concern that touches every subsystem
- `XXXXL` -- whole-product / multi-product / major rewrite
```

**`shared/classify.ts SCOPE_META`** (each `description` field):
```ts
S:     'one focused unit (a function, a column, a paragraph); minutes',
M:     'one module / one report section / one focused query; single session',
L:     'a full module or 5-10 sections / a feature build; multi-session',
XL:    'a subsystem (HDFS / auth / storage layer); many modules',
XXL:   'multiple subsystems or repo-wide analysis',
XXXL:  'cross-cutting concern that touches every subsystem',
XXXXL: 'whole-product / multi-product / major rewrite',
```

(`label` stays unchanged -- "Small", "Medium", etc. The UI pill / chip text doesn't depend on intent.)

**Tests:** the existing scope-classifier tests pin specific intent classifications, not the tier wording -- they should keep passing. Spot-check live: run "describe HDFS Core" on Hadoop after the change and verify the LLM picks XL (not M).

**Success criteria:** the LLM's scope output differentiates subsystem-scale read-only work from single-module work. A "describe HDFS" prompt should land XL+; "summarise NameNode RPC" should land M-L.

**Effort:** 30 min including a live spot-check.

---

## Phase B -- memory pipeline gap (#2 + #3 bundled, ~2 hours)

The two are tightly coupled: if the assistant body never reaches `persistTurn`, both the turn embedding AND the segment indexing miss the assistant content.

### B.1 Audit `result.finalOutput` for the code-analyzer slash path

**Location:** [src/insrc/daemon/chat-handler.ts:1474](src/insrc/daemon/chat-handler.ts#L1474) calls `persistTurn(session, originalMessage, result.finalOutput, result.finalFormat)` inside `runCodeAnalyzerSlash`. `result` comes from `runControlledPipeline(controller, ..., deps)` where `controller = CodeAnalyzerOrchestratorController`.

**Investigation steps:**

1. Read [src/insrc/daemon/controllers/code-analyzer-orchestrator.ts](src/insrc/daemon/controllers/code-analyzer-orchestrator.ts) and trace how `finalOutput` is populated. The synthesis/expand/review pipeline streams sections to the IDE via `send({ stream: 'delta', ... })` -- verify whether the final aggregated markdown also lands in `finalOutput` on the controller result.
2. Reproduce: run `/code-analyze ...` against a live daemon and then immediately run:
   ```bash
   grep '"msg":"response segments indexed"' /tmp/.insrc/agent.*.log | tail -5
   grep '"msg":"response-segment indexing failed' /tmp/.insrc/agent.*.log | tail -5
   ```
   - **If "indexed" appears with `stored: 0`**: assistant body was empty (root cause confirmed at B.2).
   - **If "indexed" appears with `stored: N > 0`**: bug is elsewhere -- maybe the turn vector itself wasn't written (check `turn_vec` for the session id), or `searchTurnVecsBySession` is missing it.
   - **If "indexing failed" appears**: Ollama embed failure is the root cause -- separate fix.
   - **If NOTHING appears**: `persistTurn` not being called, or `indexResponseSegments` was passed an empty body and short-circuited at the `trim().length === 0` guard.

**Expected root cause:** the orchestrator streams sections to the IDE but doesn't accumulate them into the pipeline result -- `finalOutput` ends up empty or a one-line summary.

### B.2 Fix the orchestrator to populate `finalOutput` with the full report

**Sketch:** the controller's `Result` payload needs to carry the rendered, accumulated markdown. Three implementation paths:

1. **Tap the stream**: install a capture-send wrapper around the orchestrator's `send` (similar to the `captureSend` pattern at chat-handler.ts:2696) that records every `delta` chunk into a string; set `result.finalOutput` to that buffer at the end of the pipeline.
2. **Have the orchestrator emit `finalOutput` directly**: the synthesis step already builds section bodies in memory before streaming. Surface that buffer back as part of the controller's return shape.
3. **Re-render on persist**: after the pipeline completes, read the `code_analysis_list` row by id and reconstruct the markdown server-side.

Path (1) is the least invasive -- adds a wrapper at the chat-handler call site without touching the controller. Path (2) is cleaner but requires touching the controller's Result shape. Pick after the investigation pins the exact gap.

**Tests:** add a chat-handler integration test that runs `runCodeAnalyzerSlash` against a fake controller emitting deltas, asserts the LMDB turn row's `assistant` field after persistTurn is the concatenation of all deltas.

**Success criteria after B.1 + B.2:**
- `/code-analyze X` produces a turn row whose `assistant` field is the full markdown report.
- The next turn's `classifier-memory retrieved` log line shows `segments: ≥3` and `turns: ≥3` with at least one ASSISTANT-side excerpt in the rendered `## Recent context`.

**Effort:** 30 min investigation + 1 hr fix + 30 min test.

---

## Phase C -- clickable code references in analysis reports (~2 hours)

### C.1 Audit skill output schemas for `path` + `lineStart`

**Locations:** [src/insrc/daemon/skills/built-ins/](src/insrc/daemon/skills/built-ins/) -- the code.source.* and code.entity.* skills. Specifically:
- `code.source.repo.describe`
- `code.source.module.describe`
- `code.source.file.describe`
- `code.entity.search-by-vector`
- `code.entity.locate-by-name`

Each surfaces entity refs (class names, file paths, function names) consumed by the synthesize/expand prompt downstream. Audit each one's output schema -- some may carry only `name`, not `path` / `lineStart`. The entity graph already stores both per entity, so the missing fields are a serialisation gap, not a data gap.

**Standardise on:** every entity-emitting skill output includes `{ name, path, lineStart? }` for every reference.

### C.2 Update synthesize/expand prompt to render Markdown links

**Location:** the system prompt in [src/insrc/daemon/controllers/code-analyzer-orchestrator.ts](src/insrc/daemon/controllers/code-analyzer-orchestrator.ts) (synthesis step) and [src/insrc/agent/content-gen/review-action.ts](src/insrc/agent/content-gen/review-action.ts) (expand/review step).

**Prompt addition:** after the entity-reference instructions, insert:

```
When mentioning a class, file, module, or function the user can
navigate to, render it as a Markdown link using the `path` (and
optional `lineStart`) carried by the skill's output:

  Bare entity:   [HdfsServerConstants](hadoop-hdfs/src/main/java/.../HdfsServerConstants.java)
  Specific line: [startCommonServices](hadoop-hdfs/.../NameNode.java#L432)

NEVER mention an entity as plain text when its path is available.
```

**Note on the renderer:** per `CLAUDE.md`, the VSCode extension's
markdown renderer accepts `[label](relative/path)` and `[label](relative/path#L42)` links. No renderer-side changes needed.

### C.3 Test live

Run `/code-analyze describe what this repo does` on Hadoop, verify the report's section bodies contain Markdown links (Ctrl-click in the Report Pane navigates to the file).

**Success criteria:** every entity / file / function mention in a report renders as a clickable link. Bare plain-text references are the exception (and only when no path is available).

**Effort:** 30 min audit + 30 min prompt edit + 1 hr live verification across all section types.

---

## Sequencing

Phase A is fully parallelisable -- four small independent diffs. Phase B is gated on the orchestrator investigation. Phase C is independent of A and B.

Recommended order:
1. **Phase A** in a single PR (all four; ~1 hr) -- biggest impact-per-effort, no architectural risk.
2. **Phase B** next (~2 hrs) -- restores the full Phase 4 memory design.
3. **Phase C** last (~2 hrs) -- highest user-facing impact but doesn't gate any classifier behaviour.

Total: ~5 hours of focused work.

---

## Out of scope

- Re-running the consolidation plan's Phase 9 enforcement tests -- they already pass (`b15c506f700` keeps the funnel + tag-stamping asserts green).
- Privatising `classifyPrimaryIntent` to a non-exported function -- the Phase 7 banner + CI grep assert is enough; the export stays for the test surface.
- Backfilling response-segment vectors for historical sessions -- not needed once forward-going indexing lands; old sessions just get empty memory until they accrue new turns.
