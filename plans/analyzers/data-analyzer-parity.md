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

## Phases (smallest-blast-radius first)

### Phase 1 -- data-side tool-call-guard (TODO-D1)

Mirror the code-analyzer guard structure exactly:

| New file | Mirrors | Purpose |
|---|---|---|
| `src/insrc/agent/tasks/data-analyzer/tool-call-guard.ts` | [tool-call-guard.ts](../../src/insrc/agent/tool-call-guard.ts) | Same five stages: tool-name fuzzy resolve, arg-rename, type-coerce, session-default inject, schema validate |
| `src/insrc/agent/tasks/data-analyzer/tool-call-guard-rules.ts` | [tool-call-guard-rules.ts](../../src/insrc/agent/tool-call-guard-rules.ts) | Per-skill arg-rename map; populated empirically (start empty; add patterns as live runs surface them) |

**Session defaults specific to data**: `connectionId`, `schema`,
`database`. Same shape as the code-side's `repoPath` injection but
keyed off the active connection in the data-analyzer session state.

Wire the guard into [analyzer/runner.ts](../../src/insrc/agent/tasks/data-analyzer/analyzer/runner.ts)
ahead of the existing per-skill validation. Both layers stay; the
guard is the cheap pre-filter, runner validation is the
authoritative check.

**Open question**: are there 108-skill-specific arg patterns worth
populating *before* the first live run? Likely no -- start empty
and let live failures drive entries (same approach as the code
side).

### Phase 2 -- per-result summarization (mirrors code Phase 1 of execute-step plan)

| New file | Mirrors | Purpose |
|---|---|---|
| `src/insrc/agent/tasks/data-analyzer/summarize-result.ts` | [summarize-result.ts](../../src/insrc/agent/tasks/code-analyzer/summarize-result.ts) | Extract `DataEvidenceEntry { facts[], citations[], confidence }` from one skill_invoke |

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

### Phase 3 -- multi-cycle discovery flow (mirrors code's discovery-flow.ts)

| New file | Mirrors | Purpose |
|---|---|---|
| `src/insrc/agent/tasks/data-analyzer/discovery-flow.ts` | [discovery-flow.ts](../../src/insrc/agent/tasks/code-analyzer/discovery-flow.ts) | Multi-cycle expand-step / execute-step / review-cycle / retain-or-drop |

**Per-task cycle structure** (same as code side):
1. Cycle 1: planner emits N drill steps; each step runs through
   `runDataAnalyzer` → produces `DataEvidenceEntry[]`.
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

### Phase 4 -- evidence-anchored writer

| New file | Mirrors | Purpose |
|---|---|---|
| `src/insrc/agent/tasks/data-analyzer/write-from-evidence.ts` | [write-from-evidence.ts](../../src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts) | Render `DataEvidenceEntry[]` → markdown with inline citations |
| `src/insrc/agent/tasks/data-analyzer/claim-grounding-reviewer.ts` | [claim-grounding-reviewer.ts](../../src/insrc/agent/tasks/code-analyzer/claim-grounding-reviewer.ts) | Per-claim evidence check; emit redraft verdict |

The writer lives *under* `generateMultiPass` -- per-task prose is
generated by the new evidence-anchored writer, then `generateMultiPass`
stitches per-task prose into the final report.

### Phase 5 -- post-rollout learnings baked in BEFORE first run

These TODOs were live-discovered on the code side. They get
implemented up front on the data side, not later.

- [ ] **DA-A1 (from TODO-A1)**: "not found" footnotes MUST cite a
      verbatim evidence path. If the writer claims `connectionA.schema.tableX
      has no PK`, the path `connectionA.schema.tableX` MUST appear in
      a `DataCitation` on at least one evidence entry, or the claim is
      rejected. No writer-paraphrased identifiers in "not found"
      footnotes.

- [ ] **DA-B1 (from TODO-B1)**: redraft-must-grow-or-stay-equal
      guard. If `redraft.textLen × redraft.citationCount` is < 90% of
      `original.textLen × original.citationCount`, KEEP the original
      and emit a structured-check warning. The redraft pass is for
      *adding grounding*, never for trimming.

- [ ] **DA-B2 (from TODO-B2)**: citation paths MUST come verbatim
      from evidence entries -- no abbreviating
      `schema.table.column` to `table.column` or `column`. Same
      structural check: reject citations whose identifier doesn't
      appear verbatim in any evidence entry. The data side's
      equivalent of "bare filename" is "bare column name" or "bare
      table name without schema qualifier".

- [ ] **DA-B3 (from TODO-B3)**: no hybrid citation shapes. The
      writer must emit ONE of:
      `(connection, schema, table, column?, rowRange?)` -- not mix
      identifiers and labels into the path slot. Example anti-pattern
      from the code side that maps here: `path:extraction_output.py:Word#L262-L325`
      would map to a malformed `connection:schema:table:row-range#column-name`
      shape; reject in the writer system prompt + structural check.

- [ ] **DA-B4 (from TODO-B4)**: within a paragraph, each
      `(connection, schema, table, column)` tuple appears at most once.
      Same per-paragraph duplicate-citation reject as the code side.

- [ ] **DA-C1 (from TODO-C1)**: when the guard rejects a call with
      "unexpected property X" or "missing required Y", surface the
      arg's `description` in the corrective, not just its name + type.
      Particularly important for the 108-skill data registry where
      arg names like `column`, `field`, `name` recur across skills
      with different semantics.

- [ ] **DA-C2 (from TODO-C2)**: corrective for unknown-tool
      rejections lists TOP-N closest skills WITH their one-line
      descriptions, not just ids. The data registry has 108 skills
      across 17 families; ids alone aren't enough for Haiku to pick.

- [ ] **DA-C3 (from TODO-C3)**: do not ship the data analyzer with
      any skill that takes a `startLine/endLine` arg unless it
      genuinely implements line-range slicing on the underlying
      source. Haiku will absolutely try to pass line ranges to skills
      that don't take them; the schema is the contract, no half-
      implementations.

- [ ] **DA-D1 (from no-parallel-LLM-calls memory rule)**: audit
      every code path in `src/insrc/agent/tasks/data-analyzer/`
      and `src/insrc/daemon/cross-agent/data-*.ts` for `Promise.all`
      / `Promise.allSettled` / parallel map that reaches an LLM
      provider (cloud OR local Ollama embed/complete). Replace with
      serial `for...of` + sequential `await`. The code side has been
      bitten by this rule three times; head it off here.

- [ ] **DA-E1**: every per-task LLM call (skill_invoke decoder,
      result summarizer, cycle reviewer, writer, claim-grounding
      reviewer) routes through the cloud LLM by default. Opt-out via
      `INSRC_DATA_ANALYZER_USE_LOCAL=1`, mirroring the code
      analyzer's
      [code-analyzer-orchestrator.ts cloud-as-default](../../src/insrc/daemon/controllers/code-analyzer-orchestrator.ts).
      Local Ollama is single-call-only material; multi-turn skill
      loops drop tokens silently on the qwen/devstral family.

## Sequencing

- Phases 1-2 are independent and ship in one PR each.
- Phase 3 depends on Phase 2 (cycle reviewer needs `DataEvidenceEntry`).
- Phase 4 depends on Phase 2 (writer reads evidence entries).
- Phase 5 items are scoped to specific phases (DA-A1, B1-B4 → Phase
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

- **Phase 3 multi-cycle latency**: the code side's discovery flow
  runs 3 cycles per section, 5-15 steps per cycle. For data, each
  step is potentially a real DB query -- latency could balloon.
  Mitigation: hard cap `stepsPerCycle ≤ 4` and `cyclesPerTask ≤ 3`,
  same as the code side. Add per-step timeout matching the data-
  driver's existing 60s envelope (see
  [data-analyze.ts](../../src/insrc/daemon/cross-agent/data-analyze.ts)).

- **Phase 1 guard over-rewrites**: the data side has many overlapping
  arg names (`column` on profile skills vs `field` on
  validation skills). A rename rule that's right for one skill could
  silently corrupt input to another. Mitigation: start with an
  EMPTY rename map; only add entries after a recurring pattern is
  observed in live logs (criterion from
  [tool-call-guard-rules.ts:21](../../src/insrc/agent/tool-call-guard-rules.ts#L21)).

- **Phase 4 writer regression**: replacing the existing
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
