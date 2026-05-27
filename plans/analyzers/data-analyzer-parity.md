# Plan: Data Analyzer parity with Code Analyzer + post-rollout hardening

## Motivation

Two months of live code-analyzer testing produced a concrete recipe
for what works:

- **Multi-cycle discovery flow** beats single-pass tool loops --
  each cycle adds drill steps based on which prior steps yielded
  citations.
- **Per-result evidence summarization** (one `EvidenceEntry` per
  skill_invoke) keeps the writer's input shape stable regardless of
  how chatty the skill is.
- **Evidence-anchored writer** with structural redraft gate +
  per-claim grounding review catches the writer drifting away from
  evidence in real time.
- **Tool-call-guard** (rename map, schema validation, session-default
  injection, single-element-array coercion, JSON code-fence strip)
  cuts ~99% of LLM hallucination round-trips before they hit the
  skill runner.
- **Plan SCS** (per-section closure scoping) prevents cross-
  closure citation leaks (the hadoop-leak class).

The data analyzer skipped the first three of these, has no equivalent
of the fourth, and never needed the fifth. As a result, data-analyzer
output today is single-pass and shallow; it is also one slow Haiku-
hallucination-storm away from the same kind of report-quality
regressions we just spent a week of testing closing on the code side.

This plan brings the data analyzer to parity AND folds in the ten
TODOs that came out of the code-analyzer's
2026-05-26 / 2026-05-27 runs (see
[code-analyzer-output-quality-followup.md](../code-analyzer-output-quality-followup.md)
post-rollout-findings section).

## Goals

- Data analyzer's per-task loop becomes a **multi-cycle discovery
  flow**, mirroring [discovery-flow.ts](../../src/insrc/agent/tasks/code-analyzer/discovery-flow.ts).
- Each skill_invoke produces a structured **EvidenceEntry** via a
  data-side `summarizeResult` analog of
  [summarize-result.ts](../../src/insrc/agent/tasks/code-analyzer/summarize-result.ts).
- Final prose comes from an **evidence-anchored writer** with
  structural checks (citation count, claim grounding, redraft gate),
  mirroring
  [write-from-evidence.ts](../../src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts)
  and
  [claim-grounding-reviewer.ts](../../src/insrc/agent/tasks/code-analyzer/claim-grounding-reviewer.ts).
- Every data skill_invoke routes through a **data-flavored
  tool-call-guard** with the same five stages as
  [tool-call-guard.ts](../../src/insrc/agent/tool-call-guard.ts).
- Every learning from the code analyzer's post-rollout findings
  applies BEFORE first live run, not after.

## Non-goals

- Re-architecting the data skill registry. The 108 existing skills
  stay; only the *routing* and *result-handling* around them change.
- Replacing `generateMultiPass` for the synthesise step. The data
  analyzer keeps `generateMultiPass` as its outer scaffold; the
  evidence-anchored writer ships *underneath* it as the per-section
  prose generator.
- Cross-agent / drill-down / re-run wiring. Those are tracked in
  [data-analyzer.md](./data-analyzer.md) Phase 5; this plan focuses
  on the per-task loop + writer + guard.
- New skills. Composite skills + meta-skills are tracked in
  [data-analyzer-skills.md](./data-analyzer-skills.md).

## Phase ordering (strict DAG, no cycles)

Original draft had a cyclic dependency: a single "Phase 1 tool-call-
guard" wanted to ship Stage 4 (typed corrective prompt) which needs
a tool-loop to feed back to, but the tool-loop only lands in "Phase 3
discovery flow," which itself wanted the guard from day-1. Resolution:
**split the guard into early (Stages 1-3) + late (Stage 4) phases**.
Now everything ships as a strict DAG.

```
Phase A ──┐
          ├──> Phase C ──> Phase D
Phase B ──┘
              │
              └─────────> Phase E
```

| Phase | Depends on | Inline (was) |
|---|---|---|
| A -- per-result summarization | -- | old Phase 2 |
| B -- guard Stages 1-3 (rename + coerce + inject) | -- | old Phase 1 (silent stages) |
| C -- multi-cycle discovery flow + execute-step | A, B | old Phase 3 |
| D -- guard Stage 4 (typed corrective + reject) | C | old Phase 1 (corrective stage) |
| E -- evidence-anchored writer + claim grounding | A | old Phase 4 |

Phase 5 (post-rollout learnings) is distributed inline into the
phase whose surface area it touches -- no separate phase. Mapping:

- **DA-D1, DA-E1** (no-parallel-LLM-calls audit, cloud-by-default
  routing): cross-cutting; ship in Phase A's PR (the earliest phase).
- **DA-C3** (no half-implemented line-range args): Phase B (schema
  audit done WITH the guard rules).
- **DA-C1, DA-C2** (corrective surfaces arg / skill descriptions):
  Phase D (Stage 4 corrective lives here).
- **DA-A1, DA-B1, DA-B2, DA-B3, DA-B4** (writer-side checks):
  Phase E.

## Phases

### Phase A -- per-result summarization (foundation; no deps)

| New file | Mirrors | Purpose |
|---|---|---|
| `src/insrc/agent/tasks/data-analyzer/summarize-result.ts` | [summarize-result.ts](../../src/insrc/agent/tasks/code-analyzer/summarize-result.ts) | Extract `DataEvidenceEntry { facts[], citations[], confidence }` from one skill_invoke or db_* tool result |

`DataEvidenceEntry` shape: same as `EvidenceEntry` but with
`citations` typed as `DataCitation[]` (using the existing type from
[types.ts](../../src/insrc/agent/tasks/data-analyzer/types.ts)) +
optional `numericFacts: { name: string; value: number; unit?:
string }[]` for histogram bins / percentiles / cardinality counts
that are *numeric* in nature -- the writer needs structured access
to these, not just prose paraphrase.

Bounded prompt size (2-3k tokens of input). Same fence-strip
parser from
[summarize-result.ts:172](../../src/insrc/agent/tasks/code-analyzer/summarize-result.ts#L172)
applies verbatim.

**Bake in Phase 5 cross-cutting items here**:
- **DA-D1**: audit every `Promise.all` / parallel map under
  `src/insrc/agent/tasks/data-analyzer/` and
  `src/insrc/daemon/cross-agent/data-*.ts` that reaches an LLM
  provider. Replace with serial `for...of` + sequential await.
- **DA-E1**: add `INSRC_DATA_ANALYZER_USE_LOCAL=1` opt-out plumbing;
  default routing for `summarize-result.ts` is cloud LLM.

### Phase B -- guard Stages 1-3 (silent rename / coerce / inject; no deps)

Mirrors the code-analyzer guard but ships ONLY the silent stages
that need no feedback loop: tool-name resolution, arg-rename, type-
coerce, session-default inject. Stage 4 (typed corrective + reject)
is **deferred to Phase D** because today's data-analyzer dispatch
paths (`skills-pipeline.ts` + `analyzer/runner.ts` short loops) lack
the tool-loop that feeds typed correctives back to the LLM.

| New file | Mirrors | Purpose |
|---|---|---|
| `src/insrc/agent/tasks/data-analyzer/tool-call-guard.ts` | [tool-call-guard.ts](../../src/insrc/agent/tool-call-guard.ts) (subset) | Stages 1-3 only: fuzzy tool-name resolve, arg-rename, type-coerce, session-default inject. Schema-validate happens but returns `pass` or silent `coerced` -- not `rejected` (yet). |
| `src/insrc/agent/tasks/data-analyzer/tool-call-guard-rules.ts` | [tool-call-guard-rules.ts](../../src/insrc/agent/tool-call-guard-rules.ts) | Per-skill arg-rename map; **starts empty** (populated empirically from live runs). |

**Session defaults specific to data**: `connectionId`, `schema`,
`database`. Same shape as the code-side's `repoPath` injection but
keyed off the active connection in the data-analyzer session state.

**Wire points**:
- [skills-pipeline.ts:197](../../src/insrc/agent/tasks/data-analyzer/skills-pipeline.ts#L197) -- right before `runSkill(inv.skillId, inv.args, ...)`. Silent rename + inject + coerce on the `ScopedInvocation` before dispatch.
- [analyzer/runner.ts:421](../../src/insrc/agent/tasks/data-analyzer/analyzer/runner.ts#L421) -- right before `executeTool(call, execCtx)`. Same silent pre-filter on `db_*` tool calls. Need a small adapter to feed `db_*` tool schemas (not skill schemas) into the guard's `getSkillInputSchema` dep.

**Bake in Phase 5**:
- **DA-C3**: audit the 108-skill registry for any skill that takes
  `startLine` / `endLine` / line-range args but doesn't actually
  implement slicing. None should ship with the guard; either fix the
  skill (full slicing) or drop the args from its schema.

### Phase C -- multi-cycle discovery flow + execute-step (depends on A + B)

| New file | Mirrors | Purpose |
|---|---|---|
| `src/insrc/agent/tasks/data-analyzer/execute-step.ts` | [execute-step.ts](../../src/insrc/agent/tasks/code-analyzer/execute-step.ts) | Per-discovery-step tool-loop. Calls into runSkill / executeTool through the Phase B guard; collects results into `DataEvidenceEntry[]` via Phase A summarizer. |
| `src/insrc/agent/tasks/data-analyzer/discovery-flow.ts` | [discovery-flow.ts](../../src/insrc/agent/tasks/code-analyzer/discovery-flow.ts) | Multi-cycle expand-step / execute-step / review-cycle / retain-or-drop |

**Per-task cycle structure** (same as code side):
1. Cycle 1: planner emits N drill steps; each step runs through
   `execute-step.ts` → produces `DataEvidenceEntry[]`.
2. Cycle-reviewer keeps steps with `citations.length > 0`; drops
   the rest; asks for K new drill steps based on what was kept.
3. Cycle 2-3: repeat until either retain growth flatlines or
   `cyclesRun >= 3`.

**Plan SCS analog for data**: per-task scoping to a single
*connection + schema closure* (or single CSV/Parquet file).
A drill step asking about `connectionB.tableX` while we're
analyzing `connectionA` MUST be rejected the way cross-repo
queries get rejected in the code-analyzer's Plan SCS. Hook it
into the connection-approval gate.

### Phase D -- guard Stage 4 (typed corrective + reject path; depends on C)

Add the reject path to the guard. Wires INTO Phase C's tool-loop in
`execute-step.ts`: a `GuardOutcome.kind === 'rejected'` produces a
`ToolResult { isError: true, content: <corrective prompt> }` that
gets fed back to the LLM as the next turn's tool_result block,
exactly like the code-side. The LLM re-emits the call with the
guidance from the corrective.

**Bake in Phase 5**:
- **DA-C1**: when the corrective lists "missing required argument",
  surface the arg's `description` field from the skill schema, not
  just `(<type>)`. With 108 skills sharing arg names like `column`,
  `field`, `name`, descriptions are necessary disambiguation.
- **DA-C2**: when the corrective lists "unknown tool name", show
  TOP-N closest skill ids WITH their one-line descriptions, not
  just ids.

### Phase E -- evidence-anchored writer + claim grounding (depends on A; parallel with C/D)

| New file | Mirrors | Purpose |
|---|---|---|
| `src/insrc/agent/tasks/data-analyzer/write-from-evidence.ts` | [write-from-evidence.ts](../../src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts) | Render `DataEvidenceEntry[]` → markdown with inline citations |
| `src/insrc/agent/tasks/data-analyzer/claim-grounding-reviewer.ts` | [claim-grounding-reviewer.ts](../../src/insrc/agent/tasks/code-analyzer/claim-grounding-reviewer.ts) | Per-claim evidence check; emit redraft verdict |

**Bake in Phase 5**:
- **DA-A1**: "not found" footnotes must cite a verbatim evidence
  identifier; no writer paraphrase.
- **DA-B1**: redraft-must-grow-or-stay-equal guard (textLen ×
  citationCount).
- **DA-B2**: citation identifiers must come verbatim from evidence
  (no abbreviating `schema.table.column` to `column`).
- **DA-B3**: no hybrid citation shapes (one of `(connection, schema,
  table, column?, rowRange?)`).
- **DA-B4**: per-paragraph dedup on `(connection, schema, table,
  column)` tuples.

The writer lives *under* `generateMultiPass` -- per-task prose is
generated by the new evidence-anchored writer, then `generateMultiPass`
stitches per-task prose into the final report.

## Phase-5 (post-rollout) traceability

Every TODO from
[code-analyzer-output-quality-followup.md](../code-analyzer-output-quality-followup.md)
post-rollout section maps to the data-side phase that implements it.
Listed once, referenced inline above:

| Code-side TODO | Data-side label | Phase | Description |
|---|---|---|---|
| TODO-A1 | DA-A1 | E | "not found" footnotes must cite verbatim evidence identifiers |
| TODO-B1 | DA-B1 | E | redraft-must-grow-or-stay-equal guard |
| TODO-B2 | DA-B2 | E | citation identifiers must come verbatim from evidence (no abbreviation) |
| TODO-B3 | DA-B3 | E | no hybrid citation shapes |
| TODO-B4 | DA-B4 | E | per-paragraph dedup on `(connection, schema, table, column)` tuples |
| TODO-C1 | DA-C1 | D | corrective surfaces arg `description`, not just name + type |
| TODO-C2 | DA-C2 | D | corrective surfaces skill descriptions on unknown-tool, not just ids |
| TODO-C3 | DA-C3 | B | no skill ships with line-range args unless slicing is real |
| (memory rule) | DA-D1 | A | no-parallel-LLM-calls audit |
| (memory rule) | DA-E1 | A | cloud-LLM-by-default routing + `INSRC_DATA_ANALYZER_USE_LOCAL=1` opt-out |

## Sequencing

- **A** ships first (foundation; no deps). PR includes DA-D1 + DA-E1.
- **B** ships in parallel with A (no deps). PR includes DA-C3.
- **C** ships after both A + B land. Consumes evidence entries (A) and dispatches through the silent guard (B).
- **D** ships immediately after C lands (or in the same PR if C is small). Adds Stage 4 reject + corrective. PR includes DA-C1 + DA-C2.
- **E** ships in parallel with C (depends only on A). PR includes DA-A1, DA-B1, DA-B2, DA-B3, DA-B4.

PR map: 4 PRs total (A, B, C+D, E).
  4; DA-C1, C2 → Phase 1; DA-C3 → Phase 1 + skill audit; DA-D1, E1
  → cross-cutting, do in PR 1).

## Non-goals (recap)

- No new data skills.
- No replacement of `generateMultiPass`.
- No drill-down / re-run / cross-agent wiring (lives in
  [data-analyzer.md](./data-analyzer.md) Phase 5).
- No changes to the connection-approval gate or per-task cache --
  both stay as-is.

## Risk

- **Phase C multi-cycle latency**: the code side's discovery flow
  runs 3 cycles per section, 5-15 steps per cycle. For data, each
  step is potentially a real DB query -- latency could balloon.
  Mitigation: hard cap `stepsPerCycle ≤ 4` and `cyclesPerTask ≤ 3`,
  same as the code side. Add per-step timeout matching the data-
  driver's existing 60s envelope (see
  [data-analyze.ts](../../src/insrc/daemon/cross-agent/data-analyze.ts)).

- **Phase B guard over-rewrites**: the data side has many overlapping
  arg names (`column` on profile skills vs `field` on
  validation skills). A rename rule that's right for one skill could
  silently corrupt input to another. Mitigation: start with an
  EMPTY rename map; only add entries after a recurring pattern is
  observed in live logs (criterion from
  [tool-call-guard-rules.ts:21](../../src/insrc/agent/tool-call-guard-rules.ts#L21)).

- **Phase E writer regression**: replacing the existing
  `generateMultiPass`-only synthesis path with an evidence-anchored
  writer underneath it could regress the multi-pass outline quality.
  Mitigation: gate the new writer behind
  `INSRC_DATA_ANALYZER_EVIDENCE_WRITER=1` for the first two weeks
  while running both writers side-by-side on a synthetic test
  battery.

## Open questions

1. **Citation shape for data**: code-side citations are
   `path:foo.ts#Lstart-Lend`. Data-side existing citations are
   `DataCitation { connectionId, schema, table, column?,
   rowRange? }`. The new writer must render these as inline markdown
   links; what URL scheme should they use? Proposal: `data:<connectionId>/<schema>/<table>#col=<column>&rows=<start>-<end>`.
   Needs IDE renderer support; same kind of question as
   [code-analyzer-output-quality-followup.md TODO-6](../code-analyzer-output-quality-followup.md)
   (the `path:` scheme question on the code side).

2. **Numeric facts in `DataEvidenceEntry`**: phase 2 adds optional
   `numericFacts: { name, value, unit }[]`. Is that worth shipping
   day-1, or do we just paraphrase numbers into `facts: string[]`
   like the code side does today? Argues for: writer can render a
   table cell or histogram block from structured numerics. Argues
   against: extra prompt-engineering work and another schema
   property the LLM can get wrong. Default: ship optional, let writer
   prefer structured when present, fall back to prose facts when not.

3. **Cycle-reviewer parity**: code side uses the cloud LLM (Haiku)
   for cycle review. Data side already does. Do we need a
   per-task-shape-aware reviewer prompt (profile vs lineage vs drift
   vs quality), or is one generic reviewer enough? Code side runs
   one generic reviewer with section-objective in context;
   matches data's per-task-objective shape. Likely one reviewer is
   enough; revisit if live results show review verdicts insensitive
   to task shape.
