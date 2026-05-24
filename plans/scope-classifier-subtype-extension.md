# Scope-classifier subtype extension

## Motivation

The analyzer's scope classifier in
[`agent/classify/scope.ts`](../src/insrc/agent/classify/scope.ts)
emits one signal: `scope: ScopeSize` (S / M / L / XL / XXL / XXXL /
XXXXL). That answers "how big is the work?" but not "what KIND of
work product does the user want?" — a question that materially
affects how the planner-discovery loop
(`plans/code-analyzer-planner-discovery-loop.md`) should bias the
sections it plans.

A request to **review** a codebase wants sections that surface gaps,
risks, and improvement opportunities. A request to **summarize**
the same codebase wants concise overview sections. **Audit** wants
exhaustive coverage with verdicts. **Explain** wants pedagogical
walkthroughs. The planner produces materially different plans for
each — but today it has no signal about which is requested.

This plan extends the classifier output to carry the work-shape
alongside the size, and threads it into the planner's system
prompt as a one-line emphasis hint.

## What this plan does NOT do

An earlier draft of this plan (now superseded) attempted to make
the classifier emit a "kind" discriminator like `'path' |
'git-changes' | 'pr' | 'feature' | ...` that branched seed
construction in the orchestrator. That approach was rejected on
review for three reasons:

1. It conflated "where to look" (path/repo) with "how to scope"
   (git-changes/pr) with "what's it about" (feature) — three
   separate concerns under one taxonomy.
2. It pushed scope-resolution logic into the orchestrator's
   seed-construction code, which is precisely the kind of
   heuristic-over-request logic the planner-discovery design
   exists to eliminate.
3. It made the seed shape conditional on classifier output,
   creating N parallel code paths instead of one uniform seed +
   one decision-making planner.

The corrected architecture:

- The classifier emits work-shape (verb), not scope-shape.
- The planner-discovery seed is **uniform** — request + repo path
  + tool catalog + the subtype hint. No conditional pre-baking.
- The planner has git-aware tools alongside structural tools in
  its catalog. When the request says "review changed files," the
  planner sees its `planner_git_status` tool and uses it. The
  orchestrator does NOT pre-resolve git state.

This plan reflects that corrected architecture. The git tools are
described in
[`plans/code-analyzer-planner-discovery-loop.md`](code-analyzer-planner-discovery-loop.md);
this plan only covers the classifier change.

## Relationship to classification-rewrite

The [`classification-rewrite`](classification-rewrite.md) plan
consolidates pure classifications (pick-one-id-from-list) into a
generic `classify()` module and explicitly carves out structured
extraction (see [decompose.ts](../src/insrc/agent/classifier/decompose.ts))
as out of scope.

The subtype extension here is structured extraction (two outputs:
`tier` AND `subtype`, with shared reasoning), same shape as decompose.
It does NOT fit the generic `classify()` contract and should NOT be
folded into that module. The two plans are independent:

| Plan | Surface | Output |
|---|---|---|
| `classification-rewrite` | Generic `classify({classes, text})` | `{ id, confidence, reasoning, fallback }` |
| `scope-classifier-subtype-extension` | Specialized `classifyScope({text, ctx})` | `{ tier, subtype, reasoning, fallback }` |

No file in either plan's deletion list overlaps. The 2-class
single/batch scope classifier in classification-rewrite §4 is a
different classifier (coding pair-vs-delegate routing); unaffected.

## Enhanced output

```ts
// src/insrc/agent/classify/scope.ts (existing module, output enriched)

export type AnalysisSubtype =
  | 'review'      // critical reading — surface gaps, risks, improvement opportunities
  | 'summarize'   // concise overview — broad strokes, lowest token count
  | 'audit'       // exhaustive examination with verdicts; bias toward coverage
  | 'explain'     // pedagogical walkthrough — explain how/why something works
  | 'compare'     // X vs Y or before-vs-after framing
  | 'document'    // produce reference documentation; bias toward neutral, durable phrasing
  | 'diagnose';   // find the cause of a problem; bias toward evidence + likely-cause sections

export interface ScopeClassifyResult {
  readonly tier:      ScopeSize;
  readonly subtype:   AnalysisSubtype;
  readonly reasoning: string;
  readonly fallback:  boolean;
}
```

`tier` continues to mean size. `subtype` is work-shape. The two are
orthogonal — a `review` can be S (one function) or XXL (the whole
repo); a `summarize` can be S or XXL.

No kind-specific metadata, no per-subtype branching downstream. The
subtype is **purely a hint** consumed in one place: a single line in
the planner's system prompt.

## Subtype taxonomy

| `subtype` | Definition | Example requests |
|---|---|---|
| `review` | Critical reading; surface gaps, risks, weak spots, improvement opportunities | "review insors/extraction", "look at the auth module", "any issues with the retry logic?" |
| `summarize` | Concise overview at the requested scope; broad strokes only | "summarize this repo", "give me a quick overview of the OCR backends", "what does this codebase do?" |
| `audit` | Exhaustive examination with explicit verdicts ("this passes / this needs work") | "audit the security of the API", "check all the DB queries for SQL injection", "compliance audit of the data-access layer" |
| `explain` | Pedagogical walkthrough — explain how/why something works to someone learning | "explain how the message consumer works", "walk me through the OCR pipeline", "how does fallback assignment work?" |
| `compare` | Two-sided framing — X vs Y, before vs after, this repo vs that repo | "compare the Anthropic and Mistral OCR backends", "diff the legacy and new patch pipelines" |
| `document` | Produce reference documentation; bias toward neutral, complete, durable phrasing | "document the public API of `extraction.db`", "write developer docs for the matching engine" |
| `diagnose` | Find the cause of a problem; bias toward evidence + likely-cause sections | "why is the OCR returning empty pages?", "diagnose why the matching consumer is slow" |

Default subtype when the request gives no strong signal: `review`.
Most analyzer requests are review-shaped; the bias is safe.

## Subtype → planner-prompt hint

The classifier's `subtype` is read by the orchestrator and threaded
into the planner-discovery seed as a single bias line. Concrete
mapping:

| `subtype` | One-line hint appended to planner system prompt |
|---|---|
| `review` | "This is a review request — bias your sections toward surfacing gaps, risks, weak spots, and improvement opportunities." |
| `summarize` | "This is a summarize request — bias toward concise, broad-stroke sections. Prefer fewer sections; avoid exhaustive enumeration." |
| `audit` | "This is an audit request — bias toward exhaustive coverage with explicit verdicts on each axis. Don't skip relevant axes; surface problems clearly." |
| `explain` | "This is an explain request — bias toward pedagogical walkthrough. Sections should teach how/why things work, not just list what's there." |
| `compare` | "This is a compare request — bias each section toward two-sided framing (X vs Y, before vs after)." |
| `document` | "This is a document request — bias toward neutral, complete reference documentation. Sections should read like docs, not opinions." |
| `diagnose` | "This is a diagnose request — bias toward evidence-driven cause analysis. Sections should follow the investigation, not the codebase's structure." |

No other downstream effects. The seed shape, the planner toolset,
the per-section budget, the review criteria — all unchanged across
subtypes. Just one line of guidance in the system prompt.

## Prompt enhancement (classifier-side)

The current prompt in `scope.ts` teaches only tier discrimination.
The enhancement adds a parallel section teaching subtype
discrimination and updates the JSON schema.

System prompt additions:

```
## Subtype (kind of work product)
Alongside the tier, identify what KIND of work product the request
asks for:
- `review`:    critical reading — gaps, risks, improvements
- `summarize`: concise overview, broad strokes
- `audit`:     exhaustive examination with verdicts
- `explain`:   pedagogical walkthrough — how/why things work
- `compare`:   X vs Y or before-vs-after framing
- `document`:  reference documentation; neutral and complete
- `diagnose`:  find the cause of a problem; evidence-driven

When the request gives no strong signal, default to `review`.

## Examples (one line each)
- "review insors/extraction"          -> { tier: 'XL', subtype: 'review' }
- "summarise this repo"               -> { tier: 'XL', subtype: 'summarize' }
- "audit the data-access layer for SQL injection" -> { tier: 'L', subtype: 'audit' }
- "explain how the message consumer works" -> { tier: 'L', subtype: 'explain' }
- "compare the Anthropic and Mistral OCR backends" -> { tier: 'L', subtype: 'compare' }
- "document the public API of extraction.db" -> { tier: 'L', subtype: 'document' }
- "diagnose why the matching consumer is slow" -> { tier: 'L', subtype: 'diagnose' }
```

JSON schema (extended from the existing flat shape):

```json
{
  "type": "object",
  "required": ["tier", "subtype", "reasoning"],
  "properties": {
    "tier":      { "enum": ["S","M","L","XL","XXL","XXXL","XXXXL"] },
    "subtype":   { "enum": ["review","summarize","audit","explain","compare","document","diagnose"] },
    "reasoning": { "type": "string" }
  }
}
```

Validation on the response: `tier` and `subtype` must be valid
enum values. On parse / enum failure: fall back to `tier: 'M'`,
`subtype: 'review'`, `fallback: true` (mirrors the current parser's
defensive shape).

## Downstream consumer change (orchestrator)

Single integration point: when the orchestrator builds the planner
seed, it appends the subtype hint line to the planner's system
prompt:

```ts
// daemon/controllers/code-analyzer-orchestrator.ts (planner-discovery wiring)
const classification = await classifyScope({ text: request, context: ... }, classifierProvider);

// build the planner seed (uniform, NO branching on classification):
const seed = buildPlannerSeed({
  request,
  repoPath,
  toolCatalog: PLANNER_DISCOVERY_TOOLS,
  subtypeHint: SUBTYPE_HINTS[classification.subtype],   // the one-line bias
});
```

That's the entire downstream change. The seed itself doesn't branch
on subtype; the hint is just a string the planner reads.

## Phase breakdown

| Phase | Scope | Ship gate |
|---|---|---|
| **1. Schema + types** | Extend `ScopeClassifyResult` with `subtype: AnalysisSubtype`. Add the type alias + JSON schema entry. Backward-compatible — existing callers reading only `tier` continue to work. | Existing scope-classifier tests pass unchanged |
| **2. Prompt enhancement + parser** | Add the subtype section + examples to the system prompt. Update parser to extract `subtype` and validate against the enum. Snapshot test the new prompt. | Snapshot test passes; unit-test parser against synthetic LLM outputs covering each subtype |
| **3. Default + fallback** | Default to `'review'` when classifier output is ambiguous (parse OK but `subtype` not present). Hard fallback to `'review'` on full parse failure (alongside the existing `tier: 'M'` fallback). | Fallback test cases cover both partial and full failures |
| **4. Live validation against current call sites** | Classifier is called from [`chat-handler.ts:1218`](../src/insrc/daemon/chat-handler.ts#L1218) (data-analyzer) and [`chat-handler.ts:1470`](../src/insrc/daemon/chat-handler.ts#L1470) (code-analyzer). Confirm both continue to receive `tier` correctly; `subtype` returns sensibly across a sample of requests. | Manual sample run; no regressions in either intent's tier classification |
| **5. Orchestrator wiring (consumer side)** | When the planner-discovery loop ships, the orchestrator appends `SUBTYPE_HINTS[classification.subtype]` to the planner's system prompt. Single-line integration. | Lives in the planner-discovery plan's Phase 4 (orchestrator wiring) — not in this plan's scope |

Phases 1-3 ship together (no value without all three). Phase 4 is
validation. Phase 5 is described here for context but executes
inside the planner-discovery plan, not this plan.

## Test coverage

| File | Coverage |
|---|---|
| `scope.test.ts` (extend) | Each subtype parsed from a synthetic LLM response; default-to-review fallback on partial response; full-fallback on parse failure |

## Out of scope

- **The generic `classify()` consolidation.** See
  `classification-rewrite.md`. This plan does not touch the
  pure-classification call sites.
- **Scope-resolution mechanism** (git diff, PR file lists, path
  validation). Handled by planner tools, not by the classifier.
  See `code-analyzer-planner-discovery-loop.md`.
- **Per-subtype seed shape.** The seed is uniform; subtype only
  emits a one-line prompt hint.
- **Per-subtype budgets, review criteria, validation rules.** Out
  of scope. The subtype only biases the planner's emphasis when
  composing sections; it does not change any other knob.
- **New subtypes beyond the seven listed.** Future extensions —
  each follows the same pattern (one enum value + one hint line)
  and is separately decidable.

## Subtype edge cases (handled downstream)

The classifier does NOT have repo visibility — it sees only the
request text + light context. It cannot validate that the subjects
named in the request actually exist in the active repo. Two
specific edge cases are explicitly handled downstream rather than
in the classifier:

- **`compare` with an unresolvable second comparator.** Example:
  user asks `"compare the Anthropic and Mistral OCR backends"`
  but only Anthropic exists in the repo. The classifier emits
  `subtype: 'compare'` based on request text alone; the planner-
  discovery loop discovers via its tools that one subject is
  empty and adapts (typically by submitting a plan that's
  structurally a `review` of the one that exists, with a section
  noting the second subject wasn't located). This rides the
  planner's normal tool-failure handling — no special-case logic
  needed at the classifier or in the substrate.
- **Other subject-existence checks.** Same shape: classifier names
  what the request asks for, planner validates via tools, planner
  adapts via standard failure-recovery.

The classifier's job is to read the request faithfully; the
planner's job is to ground that read against repo reality.

## Future work

- **Subtype-driven prompt evolution.** The subtype hint is one
  line today. If live validation shows that hint isn't strong
  enough to actually bias the planner's output, the natural next
  step is per-subtype review-criteria templates or per-subtype
  tool-catalog filtering. Held for v2.

## Open questions

(none — all settled in plan body)

## Rollback

The classifier output remains backward-compatible — `subtype` is a
new field, existing callers ignore it. Reverting Phase 5
(orchestrator wiring) leaves the classifier's subtype unconsumed
but doesn't break anything.
