# Code Analyzer -- interleaved investigation + tool-loop memory model

**Status:** ready
**Owner:** subhagho@gmail.com
**Surfaced:** 2026-05-11, during the second live retest after `370ef18df39` shipped the 14 fixes from `/tmp/flow-review.md` §11.
**Predecessor:** the §11 fix plan in `/tmp/flow-review.md` (committed as `370ef18df39`). All 14 of those fixes remain valid; this plan is the next layer on top.

---

## Context

Phase F (2026-05-11) replaced the legacy classify-question / select-scope / pre-fetch pipeline with a tool-loop section writer (`writeSectionWithTools`). The §11 fix batch landed:

- 11.1 mandatory `skill_describe` before `skill_invoke`
- 11.2 catalog shrink (60-char summaries)
- 11.3 structured `tool_use` / `tool_result` content blocks (replaced text marker)
- 11.4 round-2 inherits round-1 `describedSkills`
- 11.5 degraded marker on double-refine
- 11.6 verdict-based item confidence
- 11.7 typed `SkillResult.rejectionReason`
- 11.8 split successful vs failed evidence for reviewer
- 11.9 empty-section placeholder
- 11.10 skip aborted-fallback file persist
- 11.11 wire `maxToolCalls` through `runToolLoop`
- 11.12 remove dead `_repoSizeSummary` cast
- 11.13 `expandThenReview` deprecated
- 11.14 cache `getRepoSizeSummary` by `(repoPath, gitHeadRef)`
- 11.15 nudge heuristics documented as backstop

The retest confirmed every fix works as intended. **But** it surfaced a new failure that the marker had been incidentally masking:

> Every assistant turn in the loop is a *pure* `tool_use` (no text). When the model is asked for the final section body, it emits `stopReason: 'end_turn'`, `textLength: 0` -- nothing.

Diagnosed across this conversation. The marker (originally `[tool calls executed]`, then `<!--insrc:tool-use-->`) was unintentionally serving a second job: it was an *in-context exemplar* of "the assistant produces text in its turns." With the marker gone, the model's recent context contains *only* `tool_use ↔ tool_result` pairs. It has no behavioural anchor for "switch to prose now." The system-prompt instruction to "emit the section markdown as your final text response" lives at turn 0 and is buried under 5-10 rounds of tool calls by the time it matters.

The deeper issue: **the original prompt encouraged sequential phases (call tools → stop → write).** That's not how intelligent investigation works. A real investigator calls a tool, reasons about the result, writes a paragraph, decides on next steps -- inference *as outputs come in*, not all-at-end.

### Supported local models

This plan's local-LLM surface is fixed at two models for now:

| Model tag | Family | `noThinkOnTools` | `formatWithTools` | Notes |
|---|---|---|---|---|
| `devstral-small-2:latest` | mistral | `false` | `true` | Default in current `~/.insrc/config.json`. Thinking-mode available throughout (no `/no_think`). Native `tool_calls` field handled cleanly by the chat template. **Primary target for testing this plan.** |
| `qwen3-coder:latest` | qwen | `true` | `false` | `/no_think` is auto-prepended to the system prompt so structured tool calls don't get interleaved with `<think>` blocks. Thinking is suppressed for ALL turns including the prose ones -- a known constraint to test against in Phase D's A/B run. |

Both families are already wired through `toOllamaMessages` in [providers/ollama.ts](src/insrc/agent/providers/ollama.ts) -- structured `tool_use` / `tool_result` blocks translate to Ollama's native `tool_calls` field on assistant turns and `role: 'tool'` messages for results. No further provider work is needed for either model.

Cloud models (Anthropic Haiku, OpenAI, Gemini, Mistral cloud) handle structured tool_use natively via their SDKs; those are used as the reviewer and could substitute as section-writer if the local LLMs underperform.

---

## Guiding principle: accuracy over speed

The primary purpose of the code-analyzer is to produce **accurate** analyses. Speed and per-call cost are second-order concerns. Concretely:

- **Skills NEVER truncate their structured output.** Whatever the graph / data layer returns is what the skill returns. No `limit: 200`, no `.slice(0, K)`, no "top-K" defaults that drop the long tail.
- **The full structured payload of every skill call is spilled to disk.** Always. No 256 KB cap, no in-memory-only fast path.
- **The LLM is responsible for processing the entire payload** -- in chunks if it's large -- not for processing whatever fraction we decided to show it. The tool loop iterates as many times as the data requires.
- **The renderer layer is the only place that decides how much of the spill to surface in a single tool_result.** Truncation is presentational, not architectural; the underlying data is always whole.

This is the inverse of the old §11 §11.2 "shrink the catalog / cap the output" framing. That framing optimised for context-budget pressure on a single LLM call. The new direction recognises that context pressure is solved by chunked iteration (Phase A's interleaved investigation + Phase B.4's pagination meta-tool), not by lossy upstream truncation.

The trade-off: a section analysing 4,821 dead-code entries will burn 20+ LLM rounds instead of 5. That's the right trade-off when accuracy is the goal -- the alternative is shipping a report that confidently asserts "the main dead code is X, Y, Z" while having seen 200 of 4,821 entries.

---

## Plan

Four phases, ordered by dependency. Each phase is independently shippable.

### Phase A -- interleaved investigation (the immediate fix)

**Goal:** the model writes prose *during* the tool loop, not at the end. The section markdown is the concatenation of the model's text turns across the loop -- one paragraph per evidence increment.

#### A.1 Rewrite the section-writer system prompt

**Location:** [src/insrc/agent/tasks/code-analyzer/write-section.ts:95-150](src/insrc/agent/tasks/code-analyzer/write-section.ts#L95-L150) (`SYSTEM_PROMPT_INTRO`).

The current `## How to work` block is a list of imperative actions (call describe → call invoke → iterate → stop → write). The model follows it literally -- bare tool calls then bare text -- and trips on the mode switch at the end.

Replace with an interleaved-investigation prompt:

```
You are investigating ONE section of a code-analysis report. Your job is to use
tools to gather evidence AND to think out loud as you do. Each tool result you
receive must be interpreted -- the section is grown paragraph by paragraph as
the investigation unfolds, not synthesised at the end.

## How to work (each turn)
  - BEGIN your turn with a SHORT PARAGRAPH:
    - First turn: what you're investigating now and why.
    - Subsequent turns: what the previous tool result told you about the
      section's review criteria, with inline citations for entities/files
      you reference.
  - THEN (optionally) call a tool to advance the investigation:
    - skill_describe first to learn the schema (mandatory by protocol)
    - skill_invoke once you have the schema + clear question
  - END the loop when you have enough to satisfy every review criterion --
    your final turn has NO tool call, just a closing paragraph that ties
    the investigation together.

The orchestrator collects the text from every one of your turns and stitches
them into the section body. Treat each paragraph as load-bearing: cite
everything you reference, no "above"/"below" cross-references, each
paragraph self-contained.

## Citations
Inline as you reference each entity:
  [`NameNode`](path:hadoop-hdfs-project/.../NameNode.java#L120-L350)
Bare backticks only when no file is known.

## Output rules
  1. The section body has no `## <title>` heading -- the orchestrator adds it.
  2. Use ONLY evidence from your skill calls + the repo summary block. No
     fabrication.
  3. Prefer production-source citations over test-source citations.
  4. Use the repo's own vocabulary -- name modules and classes as they are.
```

The key shift: *every assistant turn produces text*, and the section is the concatenation of those texts. The "final synthesis" step that was breaking the model is gone -- there's no synthesis pass, just an extended investigation that ends with a closing paragraph.

**Acceptance:** test trace shows non-zero `textLength` on every assistant turn. Concatenated `response` is multi-paragraph prose with inline citations.

#### A.2 Accumulate text across all assistant turns

**Location:** [src/insrc/agent/tools/loop.ts](src/insrc/agent/tools/loop.ts) -- the `runToolLoop` body.

Today the loop accumulates `finalResponse` per iteration and **resets to `''`** at the bottom of each iteration. The returned `response` is only the LAST turn's text. With interleaved investigation, every turn's text is part of the section -- we need to accumulate across all turns.

Change:

```ts
// At loop top (replace `let finalResponse = '';`):
const sectionParagraphs: string[] = [];
let currentTurnText = '';

// At completion-opts construction (in onToken handler):
completionOpts.onToken = (token: string) => {
  currentTurnText += token;
  onTextDelta(token);
};

// After provider.complete:
if (!onTextDelta && llmResponse.text) {
  currentTurnText += llmResponse.text;
}

// When pushing the assistant turn (whether tool_use or end_turn):
if (currentTurnText.trim().length > 0) {
  sectionParagraphs.push(currentTurnText.trim());
}
currentTurnText = '';

// Final return:
return {
  response: sectionParagraphs.join('\n\n').trim(),
  ...
};
```

**Acceptance:** test trace shows `response` = sum of all per-turn texts joined by blank lines. No data lost between iterations.

#### A.3 Strip narration from the per-turn text before stitching

The model's per-turn text may include both prose (the section content) and meta-narration ("Now I'll look at..."). For the concatenated result to read as a clean section body, we either:

a. **Trust the prompt** -- the system prompt forbids meta-narration; if the model misbehaves, that's a quality issue not a structural one.

b. **Sanitize at the loop boundary** -- strip sentences matching `^(Now|Next|Let me|I'll|I need to)` heuristically.

Option (a) is cleaner and matches the §11 §11.15 stance on nudge heuristics (don't fight model behaviour with regex). Start there. If quality suffers, layer in (b) later.

**Acceptance:** sample sections read like authored prose, not running commentary.

#### A.4 Remove the "final text response" framing from the prompt

**Location:** same prompt edit as A.1 -- ensure no surviving wording suggests a single final synthesis turn (e.g. "your final text response", "STOP calling tools and emit the section markdown"). The new framing is *every turn contributes*.

**Acceptance:** prompt audit by grep for the prior wording -- no hits.

---

### Phase B -- full-fidelity skill outputs + chunked LLM iteration

**Goal:** every skill emits its complete result; the spill carries the entire payload, never truncated; the LLM iterates through whatever is too large for one round via a paging meta-tool. No artificial `limit: 200`, no `default K=50`, no `slice(0, K)` in skill code. Truncation happens only in the rendering layer that produces one chunk per tool_result for the LLM -- and the LLM can always ask for the next chunk.

#### B.1 Remove all artificial caps from skill code

Audit `src/insrc/daemon/skills/built-ins/` for every numeric cap, default `limit`, `slice`, "top-K" behaviour, and remove them. Skills should compute the FULL result and return the FULL structured value.

Concrete patterns to remove (search for each):

```ts
// REMOVE this pattern -- whatever it is, the limit goes:
const limit = input.limit ?? DEFAULT_LIMIT;
const truncated = scoped.length > limit;
const result = scoped.slice(0, limit).map(...);

// REPLACE with:
const result = scoped.map(...);   // full result; no count, no truncated flag
```

Skill input schemas should drop `limit` / `maxK` / `topK` parameters entirely unless the parameter has a semantic purpose (e.g. `maxDepth` for BFS depth is legitimate; `limit` for "give me only the first N rows" is not). A skill should not have an opinion about how much the caller wants -- it returns the complete answer; the caller decides what to do with it.

Where today's cap exists for an EXTERNAL reason -- e.g. an underlying graph primitive hard-caps at 200 -- raise that cap or remove it. Reachability / closure / ANN primitives in `db/search.ts` and `db/graph/traversal.ts` need the same audit.

**Acceptance:** grep `limit\s*=\|maxK\|topK\|slice\s*\(\s*0` across `src/insrc/daemon/skills/built-ins/` and `src/insrc/db/` returns only legitimate non-truncation uses (string-slicing for previews, etc.). No skill input schema has a numeric "give me only N" parameter.

#### B.2 Per-skill audit -- before / after

Every built-in skill needs a pass. Current cap status (verified against source as of `370ef18df39`):

| Skill | Today's cap | Action |
|---|---|---|
| `code.source.repo.describe` | top-K modules (12), top-K entities | remove K; return full module + entity lists |
| `code.source.module.describe` | none in skill body (`db/entities.listEntitiesForRepo` is unbounded) | confirm; ensure entities array isn't truncated downstream |
| `code.source.file.describe` | none observed | confirm |
| `code.entity.summary` | body excerpt is capped (legitimate -- the body is text, not a list) | confirm cap is on text-preview only, not on returned fields |
| `code.entity.locate-by-name` | check K cap | remove K; return all matches |
| `code.entity.callers` / `callees` | hard-capped at 200 ("Caps at 200; truncated:true on overflow" per description) | remove cap; return all callers/callees |
| `code.entity.search-by-vector` | top-K ANN hits | this one is *legitimate* -- ANN inherently returns top-K by similarity score. Document that `topK` is a semantic parameter, not a truncation cap; default it generously (say 100) but allow override |
| `code.class.extract-fields` | typed fields list | confirm no cap |
| `code.class.locate-references` | check K cap | remove K |
| `data.code.dead-code` | `limit: 200` default in skill body (verified) | remove `limit` param + the `.slice(0, limit)` + the `truncated` flag entirely |
| `code.quality.complexity` | per-function results | confirm no aggregate cap |
| `code.quality.cyclic-deps` | SCC list | confirm no cap |
| `code.quality.duplication` | similar-pair list | confirm no cap (each pair is itself bounded) |
| `code.quality.unused-exports` | unused-export list | confirm no cap |
| `code.compare.entity-versions` | one entity diff | naturally bounded |
| `code.compare.impl-vs-doc` | field diff | naturally bounded |
| `code.compare.signature` | one diff | naturally bounded |

Acceptance per skill: a unit test invokes it on a known-large repo and asserts `result.value` contains the complete data (count matches the underlying query's count).

#### B.3 Spill writes the entire payload, always

Verify [src/insrc/agent/artifacts/spill-writer.ts](src/insrc/agent/artifacts/spill-writer.ts):

```ts
const FULL_BLOB_MAX_BYTES = 256 * 1024;
const onDisk = truncated
  ? fullBlob.slice(0, FULL_BLOB_MAX_BYTES) + '\n... <truncated>'
  : fullBlob;
```

This 256 KB cap **must go**. Large skill outputs (Hadoop-scale reachability could be tens of MB) need to spill in their entirety. Remove the cap; the on-disk JSON is whatever the skill returned, byte-for-byte.

Concrete change in `spill-writer.ts`:

```ts
// DELETE:
//   const FULL_BLOB_MAX_BYTES = 256 * 1024;
//   const truncated = fullBlob.length > FULL_BLOB_MAX_BYTES;
//   const onDisk = truncated ? fullBlob.slice(...) + '\n... <truncated>' : fullBlob;

// REPLACE WITH:
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(file, fullBlob, 'utf8');
log.info({ skillId, bytes: fullBlob.length, file }, 'spill: full payload written');
```

For multi-MB payloads, JSON.stringify is still in-process memory. If we ever hit a payload too large for that (10s of MB?), use a streaming JSON writer. Not blocking now.

**Acceptance:** spill files match `result.value` byte-for-byte. A unit test runs `data.code.dead-code` on Hadoop, reads the spill file, asserts `JSON.parse(spillFile).value.dead.length === N` where N is the full unreachable count from the graph primitive.

#### B.4 New meta-tool: `skill_load_page` for chunked iteration

A new daemon tool registered alongside `skill_invoke` / `skill_describe`:

```ts
const skillLoadPageTool: Tool = {
  id: 'skill_load_page',
  description:
    'Load the next page of a prior skill_invoke result from the on-disk spill. ' +
    'Use this when a skill returned aggregate stats + a `pageCursor` indicating more data is available. ' +
    'Returns the page contents plus the next cursor (or null when exhausted).',
  inputSchema: {
    type: 'object',
    properties: {
      spillId: {
        type: 'string',
        description: 'The spill id returned by the prior skill_invoke (format: `<sessionId>:<ts>:<skillId>`).',
      },
      fieldPath: {
        type: 'string',
        description: 'JSON path to the array field being paged through (e.g. `value.dead` for data.code.dead-code).',
      },
      pageIndex: { type: 'number', minimum: 0 },
      pageSize:  { type: 'number', minimum: 1, maximum: 500, default: 100 },
    },
    required: ['spillId', 'fieldPath', 'pageIndex'],
  },
  requiresApproval: false,
  async execute(input, _deps) {
    // 1. Resolve spillId -> on-disk path via session.skillAudit OR a side-index keyed by spillId
    // 2. Read the JSON file
    // 3. Navigate fieldPath (a simple dot-path resolver)
    // 4. Slice array[pageIndex * pageSize : (pageIndex+1) * pageSize]
    // 5. Return { items, totalCount, nextPageIndex | null }
  },
};
```

The model's investigation pattern becomes:

```
Turn 1: skill_describe(data.code.dead-code)
Turn 2: skill_invoke(data.code.dead-code, {repo: '...'})
        ← tool_result: { rootCount: 15234, deadCount: 4821,
                         firstPage: [...first 100 entries...],
                         spillId: "<sid>:<ts>:data.code.dead-code",
                         pageCursor: 1 }
Turn 3: <model writes a paragraph about the first 100>
        skill_load_page({spillId, fieldPath: 'value.dead', pageIndex: 1})
        ← tool_result: { items: [...next 100...], nextPageIndex: 2 }
Turn 4: <paragraph about the second page; pattern recognition starts to emerge>
        skill_load_page(..., pageIndex: 2)
...
Turn N: <model decides it has seen enough representative samples; closing paragraph>
```

The model controls the iteration. It can stop early if it sees the pattern is clear, or page through everything if every entry matters (e.g. "list every dead method in the storage module").

Implementation details:
- The `spillId` returned by `skill_invoke` is the same id the spill-writer already generates (`<sessionId>:<ts>:<skillId>`).
- A small lookup table or a deterministic path construction lets `skill_load_page` find the spill file from the id alone.
- `fieldPath` uses a dot-path resolver (`value.dead` → `obj.value.dead`). Restrict to simple chains for safety.

#### B.5 Rendering layer: skill_invoke result shape

The `renderSkillResultAsToolResult` function in [src/insrc/daemon/tools/builtins/skills/invoke-skill.ts](src/insrc/daemon/tools/builtins/skills/invoke-skill.ts) now does the projection that *used* to live in the skill body. For list-shaped fields:

```markdown
**skill:data.code.dead-code** (code-binding / code-analyzer) -- confidence: `high`

**Aggregate:**
  - repo: /Users/.../hadoop
  - rootCount: 15234
  - deadCount: 4821

**Page 0 of 49 (100 entries per page; full payload spilled to `<sid>:<ts>:data.code.dead-code`):**
```json
[ ...first 100 entries... ]
```

To page further, call:
`skill_load_page({ spillId: "<sid>:<ts>:data.code.dead-code", fieldPath: "value.dead", pageIndex: 1 })`
```

Render-time policy:
- Top-level scalars / small objects (≤ 1 KB): inline fully.
- Arrays: page-render. First page (default 100 items) inline; the rest pageable via the new tool.
- Nested arrays / large objects: surface a navigation hint with the field path; let the model decide.

The renderer NEVER drops data; it only chooses what to surface *now*. The full data is one `skill_load_page` call away.

**Acceptance:**
- For `data.code.dead-code` on Hadoop: tool_result contains aggregate + first 100 entries + clear pagination hint.
- `skill_load_page` on subsequent pages returns the correct slice, exhausts at the right index, returns `nextPageIndex: null` when done.
- A live test analyzing Hadoop produces a section that references entries from at least pages 0, 5, 10, 20 (sampling proves the model is paging, not just summarising the first page).

#### B.6 Naturally-bounded outputs need no paging

Skills that return small, naturally-bounded data (`code.entity.summary` for one entity, `code.compare.signature` for two entities) don't need the paging machinery -- the renderer just inlines the full result. The pagination path activates only when the rendered size would exceed the per-page budget. A simple size check at render time picks one mode or the other.

---

### Phase C -- working-memory eviction in the tool loop

**Goal:** the loop manages its context-budget actively. Once the model has analysed a tool result, the raw evidence is reclaimable scratch.

#### C.1 Token-awareness primitive

Add to `src/insrc/agent/tools/loop.ts`:

```ts
function estimateTokens(messages: LLMMessage[], charsPerToken = 3): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else {
      for (const block of m.content) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length + block.name.length + 16;
        else if (block.type === 'tool_result') chars += block.content.length;
      }
    }
  }
  return Math.ceil(chars / charsPerToken);
}
```

Cheap heuristic estimator; we don't need precise tokenisation, just an order-of-magnitude signal that triggers eviction.

#### C.2 Content-block-type-aware eviction policy

Add to `runToolLoop` before each provider call:

```ts
function maybeEvict(workingMessages: LLMMessage[], budgetTokens: number): void {
  if (estimateTokens(workingMessages) <= budgetTokens) return;

  // Walk oldest → newest. For each tool_result block whose tool_use is
  // followed by an assistant-text turn, the model has captured the
  // salient point in prose -- we can replace the raw with a stub.
  for (let i = 2; i < workingMessages.length - 1; i++) {   // preserve [0]=system, [1]=initial user
    const msg = workingMessages[i];
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    const blocks = msg.content as ContentBlock[];
    let mutated = false;
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b]!;
      if (block.type !== 'tool_result') continue;
      // already evicted?
      if (block.content.startsWith('[evicted')) continue;
      // has a subsequent assistant-text been written?
      if (hasSubsequentTextAnalysis(workingMessages, i)) {
        blocks[b] = {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: `[evicted -- the analysis paragraph below captures the salient findings]`,
          ...(block.isError === true ? { isError: true as const } : {}),
        };
        mutated = true;
        if (estimateTokens(workingMessages) <= budgetTokens) return;
      }
    }
    // (no msg array mutation needed -- block-array is mutated in place)
    void mutated;
  }
  // If still over budget: log a warning. Tighter measures (truncating
  // oldest paragraphs, aborting) can be added when we see real cases.
}

function hasSubsequentTextAnalysis(workingMessages: LLMMessage[], startIdx: number): boolean {
  for (let i = startIdx + 1; i < workingMessages.length; i++) {
    const m = workingMessages[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'text' && b.text.trim().length > 50) return true;
    }
  }
  return false;
}
```

Call site:

```ts
while (iterations < maxIterations) {
  // ... existing setup ...
  const inputBudget = (opts.maxInputTokens ?? 16384) * 0.7;
  maybeEvict(workingMessages, inputBudget);
  const llmResponse = await provider.complete(workingMessages, completionOpts);
  // ... rest of loop ...
}
```

`opts.maxInputTokens` is a new optional opt; per-provider defaults can be plumbed from the config (the local provider's `maxInputTokens` field).

**Acceptance:**
- Synthetic test: a loop with 8 large tool results, working memory crosses budget at iteration 4, eviction fires, working memory drops below budget, the loop continues.
- The model's narrative paragraphs survive (only tool_result content is stubbed).
- Final `response` quality is unaffected by eviction (paragraphs already captured the facts).

#### C.3 Make the model aware its evidence is ephemeral but recoverable

The system prompt from Phase A.1 needs a small addition so the model writes paragraphs that don't *rely* on the tool_result staying in history -- AND so the model knows that evicted pages can be re-fetched from the spill via `skill_load_page`:

```
## Memory model
The tool_result blocks you see are EPHEMERAL -- they may be evicted from
your context after you've written your analysis paragraph. Two implications:

  1. The paragraph you write IS the persistent record of what you learned.
     Cite specific entities, file paths, and line ranges INLINE. State
     numeric facts (file counts, entity counts) inline. Do not say
     "as shown in the previous tool result" -- the previous tool_result
     may no longer be in your context.

  2. The full skill output is ALWAYS spilled to disk and remains
     accessible via skill_load_page (using the spillId from the
     original skill_invoke). If you need to re-examine a page you
     already analysed -- e.g. to compare it against a later finding --
     call skill_load_page with the matching pageIndex.

Treat each paragraph as the canonical extract of one page. Your prose
is the answer; the raw tool_results are scratch space that recycles.
```

**Acceptance:** sample sections after Phase C land show explicit cited facts in paragraphs (not "see above" or "as the tool returned"). When the model needs to revisit earlier evidence, it issues a `skill_load_page` call rather than referencing a tool_result that's been evicted.

#### C.4 Eviction interacts with paging, not with skill outputs

Crucial distinction once Phase B is in:

| Layer | What's stored | When evicted |
|---|---|---|
| Disk spill (`~/.insrc/tmp/<sid>/.../*.json`) | FULL skill payload | Only on `repo.remove` cascade |
| `skill_load_page` returns | A page slice of the disk spill | Never -- the disk is the source of truth |
| Tool-loop working memory | The tool_result blocks from prior `skill_invoke` and `skill_load_page` calls | Phase C.2 eviction policy stubs these once the model has analysed them |

Eviction is a memory-management technique for the tool loop's working set; it does NOT delete evidence. Once a page has been analysed into a paragraph, the page's tool_result can be evicted from the working messages. If the model later needs that page again, it pages it back via `skill_load_page` -- the spill is untouched.

This is why the disk spill MUST be the full payload (Phase B.3): it's the durable source of truth, the place the model rewinds to when its working memory is compressed.

---

### Phase D -- observability + measurement

**Goal:** make the changes verifiable. We need to see whether sections actually improve.

#### D.1 Per-section instrumentation

Already partially in place: `writeSectionWithTools` logs `actionId`, `toolCallCount`, `hitLimit`, `skillsCalled`, `textLength`. Add:

- `paragraphCount`: number of non-empty text turns
- `avgTextLengthPerTurn`: mean text length across assistant turns
- `evictionsApplied`: how many tool_result blocks were stubbed during this section's loop
- `inputTokensFinal`: estimated tokens at loop end
- `verdict`: which reviewer verdict it received

These let us compare runs and detect regressions.

#### D.2 A/B test the prompt change

The Phase A prompt change is the riskiest -- it shifts how the model produces output. Before claiming the fix works:

1. Run the analyzer on Hadoop (large repo, scope=XL) -- 12 sections.
2. Compare sections written under the OLD prompt (current `370ef18df39`) vs the NEW prompt.
3. Metric: total section length, paragraph count per section, citation count per section, reviewer verdict distribution (accept vs refine).
4. If NEW < OLD on any metric, debug before merging.

A small harness script in `scripts/test-analyzer-prompt-ab.ts` could automate this.

**Acceptance:** A/B shows the new prompt at least matches the old on observable quality metrics, ideally improves them.

---

## Out of scope (deferred)

- **Per-section tool subsetting (§11.16 from `/tmp/flow-review.md`).** Required when the skill registry grows past ~50 skills. Not blocking today.
- **Data-analyzer's separate tool-loop runner.** `src/insrc/agent/tasks/data-analyzer/analyzer/runner.ts` has its own loop with the legacy text-marker pattern. Same bug shape; same fix shape; tackle in a sibling plan.
- **Cloud-LLM section writing.** Some users may want Claude Haiku writing the prose (local LLM only for evidence-gathering). That's a routing change, not a memory-model change -- can be a future provider-binding feature. If the local LLM doesn't handle interleaved investigation well after Phase A, this becomes blocking.
- **Local models beyond qwen-coder and devstral.** The supported local-model set is fixed at qwen-coder (qwen family) and devstral-small-2 (mistral family) for the lifetime of this plan. Both families are already wired through `toOllamaMessages` to translate our structured tool_use / tool_result blocks into Ollama's native `tool_calls` field + `role: 'tool'` returns. Adding a new family is a sibling concern, not in scope here.
- **GC for old session spills.** With the 256 KB cap gone, disk usage will grow. A "spills older than X days" sweeper is a future ops concern -- not blocking the accuracy-first work.
- **Streaming JSON for multi-MB payloads.** If a single skill returns a payload too large to fit in memory at `JSON.stringify` time, we'd need a streaming writer. None of today's skills approach that limit; revisit when one does.

---

## Why this order

Phase A unblocks the immediate bug -- without it, sections are empty regardless of how much data the skills carry. Phase B is the heaviest change (removes truncation everywhere, adds the paging meta-tool) and is the one that delivers ACCURACY -- the model finally sees every entity, not just the first 200. Phase C lets the tool loop keep running long enough to actually iterate through everything Phase B exposes. Phase D verifies that the model is in fact paging, not just summarising the first page.

Dependency: Phase A is independently shippable. Phase B depends on the spill mechanism being trusted (which means B.3 lands first), then B.4 (the meta-tool), then B.1/B.2 (skill audit). Phase C depends on Phase B.4 -- safe to evict only because paging makes the spill recoverable.

---

## Acceptance for the plan as a whole

A Hadoop-scale `/code-analyze describe what this repo does` produces a multi-paragraph 8-section report where:

1. Every section has at least 200 chars of prose (no degraded markers from §11.9 firing).
2. At least 80% of sections include 2+ inline `[Entity](path:...)` citations.
3. The dead-code section explicitly references entries from beyond the first page (e.g. the report mentions entry #2,400 of 4,821, demonstrating that the model paged through, not just summarised). Same shape for any other skill output where the spill has >1 page.
4. **No truncation flags surface in the user's report.** Phrases like "(top 200 shown)" / "the first N entries" / "more results available" appear in NEITHER the section prose NOR the underlying tool_result. The model knows the data is paged but the user sees a coherent analysis.
5. Reviewer's verdict is `accept` on at least 50% of sections (round 1), `refine-then-accept` on most of the rest, `refine-then-refine` on < 10%.
6. Disk spill for `data.code.dead-code` on Hadoop contains every unreachable entity (a checked count equal to the graph primitive's count), not a truncated subset.

Latency is intentionally NOT an acceptance criterion. A Hadoop-scale analysis may take 5+ minutes if the data warrants it. That is the right trade-off.

Each phase has its own acceptance criteria above; the plan-level criteria above are the end-state goal.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| New prompt produces repetitive prose across turns (model says the same thing each paragraph) | medium | Phase D A/B test catches this; if it happens, add an "each paragraph adds NEW information" rule to the prompt |
| Eviction stubs confuse the model | low | The stub text explicitly says where to find the analysis; model has been trained on similar patterns ("[truncated]") |
| Skill audit reveals widespread non-compliance (caps everywhere) | high | This is the *expected* outcome -- B.1's job is to remove every cap. Plan PR-by-PR per skill if needed |
| The paging meta-tool is mis-used by the model (e.g. pages without analysing) | medium | Strong system-prompt instruction: "Each `skill_load_page` MUST be followed by an analysis paragraph before the next page." Same protocol-style enforcement as §11.1's describe-before-invoke is an option if soft instruction fails |
| Devstral-small-2 doesn't follow the interleaved-investigation prompt well | medium | Phase D A/B compares it against the §11 baseline; if it underperforms, switch the local-default to qwen3-coder, accepting the `/no_think` constraint on prose reflection. If both underperform, route section-writing to Claude Haiku (cloud) -- this plan's orchestrator structure supports it without code changes (just a provider-resolver binding). |
| Qwen3-coder's `/no_think` mode hurts paragraph quality between tool calls | medium | Detectable in Phase D's per-section instrumentation (`avgTextLengthPerTurn` and citation density will drop). If real, prefer devstral; if devstral also fails, cloud fallback per above. |
| Hadoop-scale spills cause disk pressure on user machines | low | Phase B.3 keeps the existing `purgeSession` on `repo.remove`; a future GC for old sessions is a separate ops concern; not blocking |
| LLM rounds-per-section blow up (20+ rounds for big skills) | medium | Acceptable per the guiding principle. If a section truly needs 30 rounds, that's the trade-off for accuracy. Per-section caps via `maxToolCalls` (§11.11) are still a safety net for runaway loops, just set generously |

---

## Worked example: `/code-analyze describe what this repo does` on Hadoop

Concrete walkthrough of what the analyzer does end-to-end after all four phases land. Hadoop figures match the live retest (`agent.5.log`, pid 48931, 2026-05-11): 12,848 files, 221,790 entities, scope=XL.

### High-level flow

```
User: /code-analyze describe what this repo does
                                                                 chat panel
chat-handler.runCodeAnalyzerSlash                                ──┬──
  │                                                                 │
  ├─ resolveIntent({slashForced: 'code-analysis'})                   ├─ "Intent: code-analyzer"
  ├─ retrievePriorContext + enhanceQuestion                          │
  ├─ getRepoSizeSummary(repoPath)  [cached by gitHeadRef per §11.14] │
  ├─ classifyScope(...)            -> tier 'XL'                      ├─ "tier XL"
  │
  └─ runControlledPipeline(CodeAnalyzerOrchestratorController, ...)
       │
       │ buildInitialTasks -> SYNTHESIS_BOOTSTRAP_MARKER
       │ next() -> queueSynthesise -> runPlanExpandReviewSynthesise
       │
       ├── Stage 1: planActions(cloud, repoSummary, tier=XL)         ├─ "planning report sections..."
       │   └── 12 PlannedActions returned                            ├─ "planned 12 sections"
       │       e.g. "HDFS: Distributed Storage & NameNode..."
       │
       ├── Stage 1b: TodoList.create + addItem x12                   ├─ todos pane lights up
       │
       ├── Stage 2/3: per-action loop (12 iterations)
       │   ┌─ for each PlannedAction:
       │   │
       │   │   writeSectionWithTools (local LLM, devstral-small-2)   ├─ "[N/12] drafting via tool loop..."
       │   │     interleaved investigation tool loop (Phase A)
       │   │     ├─ system prompt: think-and-act each turn
       │   │     ├─ describe-before-invoke protocol (§11.1)
       │   │     ├─ skill_invoke           (full-fidelity, Phase B)
       │   │     ├─ skill_load_page x N    (paging, Phase B.4)
       │   │     ├─ eviction kicks in      (Phase C, on-demand)
       │   │     └─ paragraphs accumulate across turns (Phase A.2)
       │   │
       │   │   reviewAction (cloud, Haiku)
       │   │     └─ verdict accept | refine
       │   │
       │   │   if refine: writeSectionWithTools(refinePass=true)     ├─ "[N/12] refine (redrafting)"
       │   │              reviewAction
       │   │
       │   │   final = if rounds==2 && refine: degraded marker       ├─ "[N/12] <verdict>"
       │   │           else: review.accepted?.markdown ?? draft
       │   │
       │   │   TodoList.updateItemMeta + markComplete
       │   └─────────────────────────────────────────────────────
       │
       ├── Stage 4: stitchPlanSections(intentBrief, actions, sections)
       │
       └── finalize -> markdown report
            │
chat-handler:
  ├─ persistReportFile  -> ~/.insrc/tmp/<sid>/reports/turn-N.md     ├─ "📄 [view report](file://...)"
  └─ persistTurn        -> LMDB conversations
```

### Stage 1 — planner output (cloud, ~10s)

The planner sees `## Repo summary` showing top modules (`hadoop-hdfs-project/.../namenode`, `hadoop-common-project/.../fs`, `hadoop-yarn-project/...`) and emits 12 specific section titles. Picking three to illustrate:

| Action | Title | reviewCriteria |
|---|---|---|
| `hadoop-core-purpose` | Core Purpose & Project Mission | identifies framework, value props, Apache context |
| `hdfs-architecture` | HDFS: Distributed Storage & NameNode Coordination | block storage, NameNode/DataNode roles, fault tolerance |
| `dead-code-survey` | Long-Tail Dead Code Across Modules | uses dead-code analysis, names top concentrations |

### Section walkthrough — `hdfs-architecture`

What the new flow looks like for one section. Local LLM (devstral-small-2), interleaved investigation prompt (Phase A), full-fidelity skills (Phase B).

**Working messages at turn 1:**
```
system:  <interleaved-investigation prompt + 18-skill catalog (60-char summaries)>
user:    <section card: title, objective, criteria, repo summary, "Begin by analysing...">
```

**Turn 1 — orient + describe**

LLM emits:
```
text: "HDFS is Hadoop's distributed file system layer. The repo summary shows
       hadoop-hdfs-project takes 142 files in the main src/main and 205 in tests,
       which is the largest single subsystem. I'll start by describing the main
       module to see the NameNode/DataNode boundary."

tool_use[skill_describe]: { id: "code.source.module.describe" }
```

Loop pushes both blocks as the assistant turn; runs the tool; appends tool_result. **Note the text is non-empty** — that's Phase A's prompt rewrite at work.

**Turn 2 — invoke + analyse**

LLM emits:
```
text: "Schema requires modulePath + repoPath. Looking at hadoop-hdfs/src/main first."
tool_use[skill_invoke]: {
  skillId: "code.source.module.describe",
  args: {
    modulePath: "/Users/.../hadoop/hadoop-hdfs-project/hadoop-hdfs/src/main/java/org/apache/hadoop/hdfs",
    repoPath:   "/Users/.../hadoop"
  }
}
```

Now Phase B kicks in. `code.source.module.describe` returns the **full** structured value: 142 files, 5,617 entities, the complete `entities[]` and `files[]` arrays. The on-disk spill at `~/.insrc/tmp/<sid>/<ts>-code.source.module.describe.json` is **multi-MB**, byte-for-byte the full payload.

The renderer (B.5) sees the array sizes, picks the per-page budget (~600 tokens), produces the tool_result block:

```markdown
**skill:code.source.module.describe** (source-introspection / code-analyzer) -- confidence: `high`

**Aggregate:**
  - found: true
  - fileCount: 142
  - entityCount: 5617
  - publicCount: 893
  - languages: [{lang: "java", count: 142}]

**Page 0 of 57 (100 entries per page; full payload at spillId `<sid>:<ts>:code.source.module.describe`):**
```json
{
  "files": [...100 file entries...],
  "entities_page_0": [...100 entities...]
}
```

To page further, call:
`skill_load_page({ spillId: "<sid>:<ts>:code.source.module.describe", fieldPath: "value.entities", pageIndex: 1 })`
```

**Turn 3 — first-page analysis**

LLM emits (just text, no tool_use — finishing analysis of page 0):
```
text: "The HDFS main module has 5,617 entities across 142 Java files. Page 0
       includes the NameNode coordinator -- [NameNode](path:hadoop-hdfs-project/hadoop-hdfs/src/main/java/org/apache/hadoop/hdfs/server/namenode/NameNode.java#L120-L1100)
       sits at the core, with FSNamesystem and BlockManager as its main
       collaborators. The DataNode side appears in page 0 too:
       [DataNode](path:hadoop-hdfs-project/hadoop-hdfs/src/main/java/org/apache/hadoop/hdfs/server/datanode/DataNode.java#L180-L900)
       implementing block storage on the worker tier. Let me page through
       further to confirm the failure-recovery story (review criterion 3) is
       visible in the codebase."
```

Note: no tool_use this turn. The model is mid-analysis, planning its next call. But it *also* doesn't end the loop — there's no `stopReason: end_turn` because we want to see another tool call. Actually, the model COULD pause here and the loop would exit. The prompt should disambiguate; one option is to treat a no-tool-call turn as "section closed" only if the criteria are met. That's a Phase A.4 polish.

For this example assume the model continues. **Turn 4:**

```
tool_use[skill_load_page]: {
  spillId: "<sid>:<ts>:code.source.module.describe",
  fieldPath: "value.entities",
  pageIndex: 1
}
```

Loop reads the spill, projects entities `[100..200]`, returns the tool_result.

**Turn 5 — page-1 analysis**

```
text: "Page 1 surfaces the lease + replication subsystem:
       [LeaseManager](path:hadoop-hdfs-project/.../LeaseManager.java#L70-L850)
       handles write-coordination, while
       [BlockPlacementPolicyDefault](path:hadoop-hdfs-project/.../BlockPlacementPolicyDefault.java#L75-L800)
       enforces the rack-aware placement strategy that gives HDFS its fault
       tolerance. This addresses criterion 3: failure recovery is driven by
       block replication + rack-awareness in BlockPlacement, and lease recovery
       in LeaseManager."
```

By turn 7-8 the model has paged through enough to address all criteria. Some pages get one-line acknowledgements ("page 5 is mostly RPC protocol classes; no new architectural information"); some pages get full paragraphs.

**Turn ~10 — closing paragraph (no tool_use):**

```
text: "In aggregate, HDFS partitions cleanly into the NameNode (metadata
       coordinator), DataNodes (block-storage workers), and a coordination
       layer (LeaseManager, BlockPlacementPolicy). The codebase reflects the
       canonical paper architecture but with ~5,600 entities of accumulated
       implementation detail in src/main alone. Block-storage, replication,
       and rack-aware placement together deliver the fault tolerance criterion;
       the NameNode/DataNode split delivers the storage/metadata separation."
```

`stopReason: end_turn`. Loop exits.

**Result returned from writeSectionWithTools:**

`response` is the **concatenation** of every text block from every turn (Phase A.2):

```
HDFS is Hadoop's distributed file system layer. ... (turn 1 text)

Schema requires modulePath + repoPath. Looking at hadoop-hdfs/src/main first.
(turn 2 text)

The HDFS main module has 5,617 entities ... (turn 3 text)

Page 1 surfaces the lease + replication subsystem: ... (turn 5 text)

[...more paragraphs from intermediate turns...]

In aggregate, HDFS partitions cleanly into ... (final paragraph, turn 10)
```

`describedSkills` = `{ code.source.module.describe }`. `skillCalls[]` = 1 invoke + 7 paging calls. `iterations` = 10. `hitLimit` = false.

**Reviewer (cloud, ~3s):**

Cloud LLM reads the section card + the successful evidence (sees 1 successful skill_invoke + 7 skill_load_page returns split between `evidence` and a separate "successful pages" block per §11.8). Verdict: `accept` (criteria 1-3 all addressed with citations).

`final = review.accepted?.markdown ?? draft.markdown` -> the local LLM's concatenated prose. Stamped on the TodoList item with `confidence: 'high'` (round 1 + accept = high per §11.6).

### What's different from today

Side-by-side for this one section:

| Today (`370ef18df39`) | After this plan |
|---|---|
| `code.source.module.describe` truncates `entities` to ~50 entries; rest is lost | Full 5,617 entities on disk; model pages through all 57 pages if needed |
| Model sees one big tool_result, writes a single (often empty) final-turn synthesis | Model writes a paragraph per page; final text is the concatenation |
| Section body = LAST turn's text (was 0 in the live test → empty section) | Section body = SUM of all turns' text (10+ paragraphs grounded in evidence) |
| If working memory fills up, the loop just fails | Eviction stubs analysed pages; pages are re-fetchable via `skill_load_page` |
| Section quality depends on the model picking the "right" 50 entries to look at | Section quality depends on how thoroughly the model paged + analysed |
| ~5 tool calls per section | ~10-20 tool calls per section (acceptable per the philosophy) |
| Total run time: ~3-5 minutes for 12 sections | ~10-15 minutes for 12 sections |
| Output: 2.8 KB of preamble (last live test) | ~20-40 KB of grounded prose |

### Section walkthrough — `dead-code-survey` (a paging-heavy case)

The skill returns 4,821 unreachable entities. With Phase B.1 the skill no longer truncates; the spill has all 4,821 entries.

```
Turn 1: text: "Dead-code survey: identify unreachable code from exported entry points."
        tool_use[skill_describe]: { id: "data.code.dead-code" }
Turn 2: text: "Calling with default roots = all exported entities."
        tool_use[skill_invoke]: { skillId: "data.code.dead-code", args: {repo: "..."} }
        → result: aggregate { rootCount: 15234, deadCount: 4821 } + page 0 (first 100)
                  spillId: "<sid>:<ts>:data.code.dead-code"
Turn 3: text: "Of the first 100 unreachable: heavy concentration in legacy RPC
         (OldRpcEngine + 12 methods), test helpers misclassified as production
         code, and deprecated FileSystem APIs. Let me sample further pages to
         confirm the pattern."
Turn 4: tool_use[skill_load_page]: { spillId, fieldPath: "value.dead", pageIndex: 5 }
        → page 5 (entries 500-600)
Turn 5: text: "Page 5 mostly Streaming MapReduce code paths -- confirms my
         hypothesis: a significant fraction of 'dead' entities are legacy
         compatibility shims for since-replaced subsystems."
Turn 6: tool_use[skill_load_page]: { ..., pageIndex: 20 }
        → page 20 (entries 2000-2100)
Turn 7: text: "Page 20 is largely YARN admin protocol scaffolding -- generated-
         code style, all unreachable, all in src/main/.../api/protocolrecords."
... 
Turn 12: tool_use[skill_load_page]: { ..., pageIndex: 47 }
         → page 47 (entries 4700-4800)
Turn 13: text: "Tail pages confirm the same three buckets dominate: legacy
          RPC, Streaming compat, and generated protocol records. The
          remaining ~50 entries are scattered orphans across modules."
Turn 14: text: "**Distribution of 4,821 unreachable entities across Hadoop:**
          [...closing summary paragraph naming each bucket with concrete file
          citations and approximate counts...]"
         (no tool_use -- loop exits)
```

Section is grounded in samples from pages 0, 5, 20, ..., 47 -- the model paged through 8+ representative pages out of 49 total and wrote a paragraph per page plus a closing synthesis. **This is the accuracy gain.** Today's analyzer would have seen the first 200 entries and confidently called them "the dead code," missing the structural pattern that only emerges once you see the long tail.

### Memory at the end of this section

Disk (persistent until repo removed):
```
~/.insrc/tmp/<sid>/
  skills/
    <ts1>-data.code.dead-code.json              ← full 4,821 entries
    <ts2>-code.source.module.describe.json      ← full 5,617 entities for one module
    <ts3>-code.source.module.describe.json      ← another module's full payload
    ... one file per skill invocation across the whole 12-section run
  reports/
    turn-1.md                                    ← stitched final report
```

Lance `artifact_vec` table:
```
  one row per spill file, embedded preview indexed for ANN retrieval
```

Working memory (gone when daemon exits):
```
  tool-loop's workingMessages -- with eviction the size stayed bounded
  session.skillAudit -- bounded ring of skill events
```

A follow-up turn ("expand on the YARN dead-code finding") can issue a fresh prompt and pull the prior spill via the existing prior-context retriever — the data is right there on disk, not lost to truncation.

---
