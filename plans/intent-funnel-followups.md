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

### C.4 Final report needs a chat-panel link back to the persisted document

**Symptom:** when `/code-analyze` completes, the report opens in a tab. The chat panel shows the streamed deltas + a `done` summary, but **nothing in the chat history points back at the rendered report file**. If the user closes the tab they cannot reopen the report -- their only option is to re-run the analysis from scratch (slow, expensive, may produce a different report).

**Expected:** after the report is materialised, the chat panel turn ends with a Markdown line like:

```
📄 [View report: HDFS Core analysis](file:///Users/subhagho/.insrc/tmp/<sessionId>/reports/<turnId>.md)
```

The VSCode renderer (per CLAUDE.md's clickable-link conventions) opens the file when clicked -- the user gets the same view as the original tab without re-running anything. Persists across daemon restarts because the file lives in `~/.insrc/tmp/<sessionId>/` which survives session close (Phase 2 of the consolidation plan keeps the spill dir alive; only `repo.remove` purges it).

**Where to fix (two-part):**

1. **Persist the report on the daemon side.** Current pipeline streams deltas to the IDE but doesn't write the final markdown anywhere on disk (this is the SAME hole as B.1/B.2 -- if `result.finalOutput` becomes truthful, the spill writer already has a per-session tmp dir, just needs a `reports/` subdir + `writeFile(${turnId}.md, finalOutput)`).
2. **Emit the link in the chat panel.** After persist, emit a final `delta` containing the Markdown link OR add a `reportPath` field to the `done` IPC payload that the chat-panel renderer turns into a link. Decide based on the existing IPC contract -- if `done.summary` already supports markdown, use it; otherwise extend the contract with `reportFile`.

**Cross-link to B.2:** completing B.2 (orchestrator populates `finalOutput` truthfully) is a prerequisite for this -- you can't persist what you don't have. Implement B before C.4.

**Tests:**
- daemon-side: integration test that after `runCodeAnalyzerSlash` finishes, `~/.insrc/tmp/<sessionId>/reports/<turnId>.md` exists and matches `result.finalOutput`.
- IDE-side: manual verification that the chat panel renders the link and clicking it opens the file.

**Success criteria:**
- Every `/code-analyze` turn produces a file at `~/.insrc/tmp/<sessionId>/reports/<turnId>.md` containing the full rendered markdown.
- The chat panel's final message includes a clickable link to that file.
- Closing the tab, then clicking the chat-panel link, re-opens the same content.
- Files survive across daemon restarts; cleanup happens only on `repo.remove` (same lifecycle as the spill artefacts).

**Effort:** ~1 hr after B.2 lands.

---

## D. Report Pane interactions -- annotations + forward-to-chat

Live-test feedback (2026-05-11) after Phase C.4 shipped: the
Code Analysis Report Pane should support two interactive
affordances on top of the rendered markdown.

### D.1 Annotations

**Surface:** [src/vs/workbench/contrib/insrc/browser/code-analyzer/analysisReportPane.ts](src/vs/workbench/contrib/insrc/browser/code-analyzer/analysisReportPane.ts) -- the same pane that already renders the synthesised report via `MarkdownRenderer`.

**Feature:** the user selects a span of text in the report (a sentence, a bullet, a table row, a citation) and attaches a note / highlight / tag to it. Re-rendering the report (e.g. on resume, on idle-reaper restoring the list) preserves the annotation.

**Open design questions before implementation:**
1. **Annotation kinds** -- just free-text notes? Or also color-coded highlights, todo-style markers ("✓ verified", "❓ check"), star-bookmarks?
2. **Anchoring** -- selections are fragile across LLM re-runs. Options:
   - Range-by-text (store the selected substring + a fuzzy match on re-render). Survives minor edits.
   - Range-by-position (char offset into list.body). Breaks if the body shifts by even one character.
   - Anchor to a stable identifier (heading id, citation key). Most robust but limits granularity.
3. **Persistence** -- annotations should travel with the TodoList (the analyzer's durable per-run state). Add a `list.annotations?: Annotation[]` field on the TodoList row in LMDB and a workbench-side store keyed on listId.
4. **Visual treatment** -- gutter pins? Underline + tooltip on hover? Sidebar panel listing all annotations for the current list?
5. **Scope** -- per-report only, or also exposable via the Todos pane / RPC so the workbench can surface annotation counts on the run list?

**Effort estimate:** unknown until 1-4 are answered. Lower bound is ~4 hrs (text-only notes, range-by-text anchoring, in-memory only, gutter pin). Upper bound is ~2 days (multi-kind, durable, surfaceable across the workbench).

### D.2 Forward to chat

**Feature:** the user selects a span of report text → clicks "Forward to chat" → the chat panel input prefills with the selection quoted as a Markdown blockquote, ready for the user to type a follow-up question against it.

**Surface:**
- Selection listener on the Report Pane body container (existing `analysisReportPane._body`).
- A floating action button or context-menu entry (the workbench's standard right-click menu pattern) gated on `window.getSelection().toString().length > 0`.
- An action that calls the chat service's "prefill input" command -- requires the chat service to expose `setInputValue(text)` if it doesn't already; if not, route through a new command id (e.g. `insrc.chat.prefillInput`).

**Open design questions:**
1. **Quote format** -- blockquote (`> selected text`) or a fenced code block? Blockquote reads more like normal prose; the user usually adds a question after it ("> selected paragraph\n\nWhy does this contradict the architecture section?").
2. **Citations preservation** -- if the selection includes `path:` Markdown links, do we keep them in the quoted blockquote? Probably yes -- they'd remain clickable in the chat panel after our `path:` allow-list fix (`bb1d531e843`).
3. **Cursor placement** -- after prefilling, focus the input + place the cursor at the end (most natural for adding the question).

**Effort estimate:** ~2 hrs. The plumbing (selection listener + chat-service command) is straightforward; the questions are about polish.

### Sequencing D within the broader followups

D.2 (forward-to-chat) is independent of every prior item -- can ship in isolation any time. D.1 (annotations) is bigger and has open design questions; bundle once those are answered.

Recommended order:
1. D.2 first (~2 hrs; small surface, immediate value).
2. D.1 second (effort dependent on design choices).

---

## Sequencing

Phase A is fully parallelisable -- four small independent diffs. Phase B is gated on the orchestrator investigation. Phase C.1-C.3 are independent of A and B. **C.4 depends on B.2** -- can't persist the report file without a truthful `finalOutput`.

Recommended order:
1. **Phase A** in a single PR (all four; ~1 hr) -- biggest impact-per-effort, no architectural risk.
2. **Phase B** next (~2 hrs) -- restores the full Phase 4 memory design AND unblocks C.4.
3. **Phase C.1-C.3** (clickable refs in report content; ~2 hrs) -- parallelisable with A and B.
4. **Phase C.4** (chat-panel link to persisted report; ~1 hr) -- AFTER B.2.

Total: ~6 hours of focused work.

---

## Out of scope

- Re-running the consolidation plan's Phase 9 enforcement tests -- they already pass (`b15c506f700` keeps the funnel + tag-stamping asserts green).
- Privatising `classifyPrimaryIntent` to a non-exported function -- the Phase 7 banner + CI grep assert is enough; the export stays for the test surface.
- Backfilling response-segment vectors for historical sessions -- not needed once forward-going indexing lands; old sessions just get empty memory until they accrue new turns.
