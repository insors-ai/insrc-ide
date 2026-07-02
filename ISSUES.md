# Open issues

Live list of design gaps + known behaviour smells that don't warrant
their own branch yet. Each entry: what, where, why it needs fixing,
proposed direction, priority tag.

Priority levels:
- **P0** — blocks a released feature; user-visible failure
- **P1** — known-wrong behaviour; users can work around it
- **P2** — polish; would improve UX / code quality

---

## I-001 · Slash commands skip scope inference (P1)

**Where:**
- `src/insrc/analyze/orchestrator/driver.ts` — `runAnalyze()` branch on `args.targetHint`
- `src/insrc/analyze/orchestrator/types.ts` — `RunAnalyzeArgs.targetHint` / `scopeHint`
- `src/vs/workbench/contrib/insrc/electron-sandbox/chatServiceImpl.ts` — `_parseSlashCommand`

**Symptom:**
When the user types `/code map the architecture`, the orchestrator
skips the classifier entirely to save the ~3-min LLM round-trip.
That's the load-bearing win. But the classifier is also what
normally picks `scope` (`XS`/`S`/`M`/`L`/`XL`) from prompt + workspace
signals. Skipping it means we lose the scope decision along with the
target decision. Current fallback: hardcoded `scope='M'` when the
user doesn't append `:xs|:s|:l|:xl` to the slash command.

**Why it's wrong:**
- On a tiny repo, `M` (10-40 tasks) is overkill → wasted LLM time.
- On a huge monorepo, `M` may be too small → shallow coverage.
- The user shouldn't have to know scope bands exist to get a
  sensible run.

**Proposed direction (any of):**
1. **Cheap scope-only classifier.** New prompt + small LLM call
   (~30 sec) that just picks a scope band. Runs when `targetHint`
   is set but `scopeHint` isn't. Preserves the 3-min-saving
   promise; costs 30 sec instead.
2. **Target-only bias.** Keep the full classifier, but force
   `target` to the hint after the LLM emits. Restores scope quality
   at the cost of the full 3-min hold; contradicts the slash-command
   design goal.
3. **Repo-size heuristic.** Backend counts registered files in
   scope + picks band deterministically (< 200 files → S, < 2000
   files → M, etc.). Zero LLM cost; can be wildly wrong.

Leaning toward (1). Defer decision until after a real end-to-end
`/code` run completes so we know the M default's failure modes.

**Filed:** 2026-07-02 during first successful `/code` run
(`analyze-mr30tzkc-b9b037`).

---

## I-002 · Plan-stage silence: substep coverage is coarse (P2)

**Where:**
- `src/insrc/analyze/orchestrator/driver.ts` — `runAnalyze()` plan-stage
- `src/insrc/analyze/orchestrator/types.ts` — `AnalyzeRunEvent.stage-substep`
- `src/vs/workbench/contrib/insrc/browser/chat/liveStepsWidget.ts` — substep rendering

**Symptom:**
The plan stage sits silent between `stage-started` and the first
`plan-attempt`/`plan-accepted` for 5–15 minutes because two heavy
sub-phases run back-to-back with no wire events between them: the
run-bundle shaper's tool loop, then the planner LLM's first call.
The chat panel just cycles "Plan: started" the whole time and
users think the run has hung.

**Fix landed (this commit):** Orchestrator now emits
`stage-substep` events at both boundaries (`substep: 'bundle-shaper'`
before `buildRunBundle`, `substep: 'planner'` before the planner
call). The daemon RPC layer forwards these on the wire; the chat
panel's progress strip + LiveStepsWidget render the `detail` line
so the user sees "Plan: building code/M run bundle" flip to
"Plan: composing task list".

**Still coarse:**
- The bundle-shaper tool loop itself is silent; a run can spend
  6+ minutes inside `buildRunBundle` and the UI still shows
  a single "building code/M run bundle" line. Ideally the shaper
  emits a per-tool-call trace event (`shaper-tool-call`,
  `shaper-tool-response`) so the widget can grow a nested row per
  tool interaction.
- The planner LLM's first attempt is also silent -- only
  `plan-attempt` fires on validation failure or accept. A
  streaming-token bridge (like `liveStep`) would make the row
  update as tokens arrive.

**Proposed direction:**
1. **Shaper tool-call trace.** Add `shaper-tool-call` +
   `shaper-tool-response` variants to `AnalyzeRunEvent`. Wire
   `buildRunBundle` to emit each. Widget renders as indented
   sub-rows under the bundle-shaper row.
2. **Planner token stream.** Piggyback on the existing `liveStep`
   frame the daemon already emits for LLM steps; make the chat
   panel show the streaming preview inline under the planner row.

Both are additive -- the current substep coverage handles the
common case (2 heavy sub-phases) and unblocks users; the deeper
trace is a follow-up for the pathological runs.

**Filed:** 2026-07-02 after users hit `Plan: started` cycling on
`analyze-mr30tzkc-b9b037`.

---

## I-003 · qwen3.6 fence-wraps structured output; retries loop until exhaustion (P0)

**Where:**
- `src/insrc/agent/providers/ollama.ts` — `completeStructured()` JSON.parse
- Failing run: `analyze-mr30tzkc-b9b037`

**Symptom:**
On the plan-stage code shaper's structured-output call, Ollama +
qwen3.6:35b-a3b sometimes ignores the schema-constrained decoding
contract (the `format: schema` option) and emits its JSON wrapped
in a markdown code fence:

```
```json
{ "system": "...", ... }
```
```

`JSON.parse(text)` rejects it immediately. The retry loop then
prompts the model with "your last response was not valid JSON,
please retry" — which qwen3.6 interprets as "be more explicit
about what you're producing" and it fence-wraps AGAIN, more
verbosely. Every attempt fails identically → the whole run gives
up with `shaper-schema-unrecoverable` after ~15 min.

Observed in `analyze-mr30tzkc-b9b037`:
- Attempt 1: truncated at char 9771 (unrelated; long shaper response)
- Attempt 2: fence-wrapped -> rejected
- Attempt 3: fence-wrapped -> rejected -> run terminates

**Fix landed (this commit):** `stripJsonFence()` helper runs
before `JSON.parse` in the Ollama provider. Matches
` ```json\n...\n``` ` and language-less ` ```\n...\n``` ` variants,
returns the fence body. Fence-free responses pass through
untouched. This defensive strip catches the qwen quirk without
touching the schema-constrained decoding contract — Ollama still
does its best-effort grammar enforcement; we just no longer die
when the model breaks it in this specific way.

**Follow-ups worth considering:**
- The retry loop's "please retry with valid JSON" message may
  make qwen3.6 MORE likely to fence-wrap on the next attempt.
  Consider rephrasing to "your last response could not be
  parsed; emit raw JSON without any wrapping" so it's aware of
  the failure mode explicitly.
- Long shaper responses that legitimately hit `num_predict`
  (attempt 1 of this run) still fail catastrophically. Streaming
  the shaper output + parsing on stream-close would let us
  detect truncation earlier + emit a specific error code the
  UI can surface differently.

**Filed:** 2026-07-02 during `analyze-mr30tzkc-b9b037` triage.

---
