# Open issues

Live list of design gaps + known behaviour smells that don't warrant
their own branch yet. Each entry: what, where, why it needs fixing,
proposed direction, priority tag.

Priority levels:
- **P0** — blocks a released feature; user-visible failure
- **P1** — known-wrong behaviour; users can work around it
- **P2** — polish; would improve UX / code quality

Status labels:
- **OPEN** — no code fix in tree yet
- **PARTIAL** — primary symptom addressed; follow-ups still open
- **FIXED** — no work remaining; entry stays here until the next
  cleanup pass so recent fixes are visible in one place

---

## I-001 · Slash commands skip scope inference (P1) · FIXED

**Where:**
- `src/insrc/analyze/classifier/scope-picker.ts` (new)
- `src/insrc/prompts/analyze/scope-picker.system.md` (new)
- `src/insrc/analyze/orchestrator/driver.ts` — `runAnalyze()` branch on `args.targetHint`
- `src/insrc/analyze/context/boot-validator.ts` — registers scope-picker prompt

**Was:**
When the user typed `/code map the architecture`, the orchestrator
skipped the classifier entirely to save the ~3-min LLM round-trip.
That preserved the "target from slash command" win but also lost
the scope decision, and the fallback hardcoded `scope='M'` for
every unqualified slash command. On a tiny repo M was overkill;
on a huge monorepo M was too small.

**Fix landed:**
- New scope-only prompt at `prompts/analyze/scope-picker.system.md`
  that takes the target (already decided), a compact workspace-
  signals block (registered repo count, total indexed entities,
  scope-ref repo's entity count) and the user's raw request, and
  returns a `{ scope, reasoning }` JSON.
- New driver at `analyze/classifier/scope-picker.ts` with its own
  typed errors, `pickScope()` entry point, and boot-validator hook.
  Uses the same `qwen3.6:35b-a3b` model but a tiny prompt (< 500
  tokens) + a 512-token cap, so a picker call runs in ~30-45 s.
- Wired into `runAnalyze()`: when `targetHint` is set but
  `scopeHint` isn't, the picker fires and emits a stage-substep
  event ("Classify: picking scope band") so the UI has something
  to show during the picker window. On picker failure the run
  falls back to `M` with a note in `intent.reasoning` -- the
  slash-command promise ("cheap, don't block on infra hiccups")
  stays intact.

**Filed:** 2026-07-02 during first successful `/code` run
(`analyze-mr30tzkc-b9b037`).
**Closed:** 2026-07-02, same session.

---

## I-002 · Plan-stage silence: substep coverage is coarse (P2) · FIXED

**Where:**
- `src/insrc/analyze/orchestrator/driver.ts` — `runAnalyze()` plan-stage + `forwardShaperTrace`
- `src/insrc/analyze/orchestrator/types.ts` — new event variants
- `src/insrc/analyze/context/types.ts` — new `ShaperTraceEvent` + `ShapeOpts.onTrace`
- `src/insrc/analyze/context/driver.ts` — emits from tool loop + streaming final emit
- `src/insrc/analyze/planner/types.ts` — new `PlanBuilderOpts.onLlmToken`
- `src/insrc/analyze/planner/driver.ts` — passes onToken through
- `src/insrc/daemon/analyze-rpc.ts` — translates trace variants to progress frames
- `src/vs/workbench/contrib/insrc/browser/chat/liveStepsWidget.ts` — renders tool sub-rows + streaming preview

**Was:**
The plan stage sat silent between `stage-started` and the first
`plan-attempt`/`plan-accepted` for 5-15 minutes because two heavy
sub-phases run back-to-back with no wire events between them: the
run-bundle shaper's tool loop, then the planner LLM's first call.
Even after the first fix landed (stage-substep events at the
sub-phase boundaries), a run could still spend 6+ minutes inside a
single "building code/M run bundle" line while the shaper hit tool
after tool, and the planner LLM's first attempt was still silent
until validation succeeded or failed.

**Fix landed:**
- New event variants `shaper-tool-call` + `shaper-tool-response`
  on `AnalyzeRunEvent`. The shaper's tool loop fires paired
  trace events for every tool interaction (via a new
  `ShapeOpts.onTrace` callback the orchestrator wires up-stack).
  The LiveStepsWidget renders each as an indented sub-row under
  the parent stage row, with the tool name + short args/output
  preview.
- New `llm-token` variant carrying a throttled streaming preview
  (>=250 ms or >=400 chars between emits, cap 240 chars). The
  Ollama provider's `completeStructured` now streams instead of
  collect-and-parse, calls `opts.onToken` per chunk. The shaper
  and planner both attach onToken bridges; the widget renders the
  tail as an italic live-typing line under the parent row.
- CSS added for `.insrc-chat-live-step-preview` (dimmed italic
  line that flex-wraps to a new line via `flex-basis: 100%`).

**Filed:** 2026-07-02 after users hit `Plan: started` cycling on
`analyze-mr30tzkc-b9b037`.
**Closed:** 2026-07-02, same session.

---

## I-003 · qwen3.6 fence-wraps structured output; retries loop until exhaustion (P0) · FIXED

**Where:**
- `src/insrc/agent/providers/ollama.ts` — `completeStructured()`
- `src/insrc/agent/providers/structured-output.ts` — retry-note builder
- `src/insrc/shared/types.ts` — `StructuredCompletionOpts.onToken`
- Failing run: `analyze-mr30tzkc-b9b037`

**Was:**
On the plan-stage code shaper's structured-output call, Ollama +
qwen3.6:35b-a3b sometimes ignored the schema-constrained decoding
contract and emitted its JSON wrapped in a markdown code fence.
`JSON.parse(text)` rejected it immediately. The retry loop then
prompted the model with "your last response was not valid JSON,
please retry" -- which qwen3.6 interpreted as "be more explicit
about what you're producing" and it fence-wrapped AGAIN, more
verbosely. Every attempt failed identically -> the whole run gave
up with `shaper-schema-unrecoverable` after ~15 min. A separate
failure mode -- num_predict truncation mid-JSON -- looked
indistinguishable in logs (both surfaced as "not valid JSON").

**Fix landed:**
- `stripJsonFence()` runs before `JSON.parse` in the Ollama
  provider (handled the ` ```json ... ``` ` and language-less
  variants; fence-free responses pass through untouched).
- `completeStructured` now STREAMS via `stream: true` +
  `for-await-of` chunks. Two payoffs:
    - `opts.onToken` fires per chunk, feeding the I-002 live-
      typing preview.
    - The terminal chunk's `done_reason` is inspected: when it's
      `length` (num_predict cap hit) the provider throws a
      distinct `response-truncated: num_predict cap (N tokens)
      hit before the model closed the JSON` error the retry
      loop's feedback note names explicitly. The model then
      knows to be more concise on the next attempt rather than
      emit the same too-long output.
- Rewrote the structured-retry feedback note in
  `structured-output.ts` -- explicitly bans markdown fences,
  ` ```json ` prefixes, prose intros, placeholder `...`, and
  unterminated strings. Named after the two failure modes we've
  actually seen instead of the generic "return valid JSON".

**Filed:** 2026-07-02 during `analyze-mr30tzkc-b9b037` triage.
**Closed:** 2026-07-02, same session.

---
