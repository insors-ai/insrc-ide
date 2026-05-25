# Close honest-gaps + weak-spots in code-analyzer output

## Motivation

Live run on 2026-05-25 against `insors-extraction` produced a clean
36.5 KB / 10-section report with no cross-repo leaks (Plan SCS
validated). The report's *content* is high-quality, but a careful
read surfaces seven distinct gaps that aren't bugs in the writer --
they're the writer correctly flagging where evidence is thin, or
small representational glitches in the surrounding pipeline.

Four honest-gap statements (the writer was right to flag these; the
gap is upstream):

1. *"No specific tolerance constants like `QUANTITY_TOLERANCE` were
   found"* (section 5) -- constants exist in code but are not surfaced
   by the entity index, so the planner's lookup skills can't find
   them.
2. *"`mapping_generation_agent.py` is not indexed"* (section 2) --
   the file is on disk but absent from the LMDB entity rows; either
   the parser skipped it or the indexer never queued it.
3. *"no audit logging was found for credential modification
   operations"* (section 8) -- a cross-cutting query that the current
   skill catalog can't satisfy in one pass (needs grep + reference
   walk together).
4. *"no K3s manifests were found... due to validation errors"*
   (section 10) -- the indexer's YAML validator rejected one or more
   manifests; details lost.

Three small weak spots:

5. **Self-contradiction (section 7)**: claims *"`FixedSizeChunker`
   ... default chunk_size of 1000"* but the citation is
   `chunking.py:L69-L238` (the whole implementation range), not the
   specific declaration line. The writer paraphrased the *value*
   from an implementation range it didn't actually point at.
6. **Drill-down section is a placeholder**: every report ends with
   `_The planner did not propose drill-down bullets for this run._`.
   The schema has no slot for them today.
7. **`path:` URL scheme**: every citation uses `[label](path:foo/bar)`,
   which the IDE workbench mis-resolves by prepending the workspace
   path (user-reported earlier in the session). Should be a relative
   path the IDE can open directly.

Each gap traces to a different layer:

- 1, 2, 4 -> indexer
- 3       -> skill catalog
- 5       -> writer prompt
- 6       -> planner submit_plan schema + reviewer prompt
- 7       -> citation renderer / template

This plan walks each in dependency order, smallest blast radius
first.

## Goals

- Eliminate the recurring *"not indexed"* footnotes for files that
  actually exist on disk.
- Eliminate the *"not found"* footnotes for things that DO exist in
  code but aren't surfaceable via the current skill set.
- Tighten the writer's citation discipline so paraphrased values
  always cite the specific declaration line.
- Make every report ship 2-3 drill-down bullets per section.
- Make every citation in the rendered report clickable from the
  workbench without manual path massaging.

## Non-goals

- Re-architect the indexer. Phase 1 is diagnostic + targeted fixes;
  invasive changes to the parser graph live in their own follow-up.
- Add new entity *kinds* to the graph (e.g., `kind: 'constant'`).
  Phase 3 explores whether enriching `code.source.grep` or adding a
  bounded `code.const.locate` skill closes the constants gap without
  a schema migration.
- Surface drill-down bullets in the IDE chat panel UI -- this plan
  ships the data; UI follow-up is separate.

## Design

### Indexer blind-spot diagnostic (Phase 1)

One-shot diagnostic script: walk every source file under each
registered repo (filtered to languages the parsers handle:
`typescript`, `javascript`, `python`, `go`, `java`, `scala`, plus the
artifact kinds `markdown`, `yaml`, `dockerfile`, `sql`), compare with
the `kind: 'file'` entity rows in LMDB for that repo, output:

- the union "indexed-but-empty" (file row exists, body length 0)
- the union "on-disk-but-no-row" (file exists, no entity for it)
- group "on-disk-but-no-row" by extension + count

Acceptance: we know exactly which file families the indexer is
losing and why. For each family, file a follow-up bug or land the
parser fix in Phase 2.

### Skill catalog gap (Phase 3)

Two scoped additions, both bounded so the LLM can't blow context:

- **`code.const.locate-by-name`** -- locates a named constant /
  threshold / config value across **all source surfaces where design
  intent typically lives**, not just code:
    - Python / TS top-level module bodies: `IDENTIFIER = literal`
    - JSON / YAML / TOML config files: keys matching the requested
      name (top-level + 1 nesting level)
    - Markdown design docs: heading text or `code-spans` containing
      the identifier
  Returns `{ name, value?, file, line, source: 'code' | 'config' |
  'doc' }` for each hit. Closure-scoped via Plan SCS. The `source`
  tag lets the writer cite design-doc evidence distinctly from code
  evidence. Future iterations extend to `.rst`, `.adoc`, `.html` doc
  formats behind the same skill -- the surface kinds are pluggable.
- **`code.security.audit-coverage`** -- composite skill: takes a
  `subject` (e.g., "credential modification") + a list of writer
  hints (function-name patterns), runs grep + `code.entity.callers`
  to verify every write site has a paired `audit.log(...)` or
  equivalent call within N hops. Returns `{ covered: [], missing: [] }`.

Both surface as optional members of `PLANNER_DISCOVERY_SKILL_IDS`
behind a feature flag so we can A/B their impact on report quality.

### Writer prompt: citation specificity (Phase 4)

Add a line to the discovery-flow writer prompt:

> When you cite a default value, threshold, or any specific
> numeric/string literal, the cited line range MUST contain the
> assignment / declaration of that literal. If the only evidence
> you have is a broad implementation range, either soften the claim
> to "the implementation defines a default chunk size (see
> `chunking.py:L69-L238`)" or omit the specific value. Never invent
> a value from a range that doesn't show it.

Tripwire pattern: when the writer says *"default X of N"* (or
similar), assert the cited line range is ≤ 5 lines wide. Wider =
forced redraft with the corrective.

### Drill-down bullets (Phase 5)

Drill-downs are **drafted after all discovery + per-section drafting
is complete**, not as part of the planner's submit_plan turn. By
that point the orchestrator already has:

- the full evidence ledger per section (retained-step IDs +
  per-step facts + per-step citations),
- the prose body each section shipped (with reviewer-accepted
  citation density),
- the prose-review verdict + any forced-redraft signals (e.g.
  tripwire excerpts, low-grounded claims) which point at exactly
  what a curious reader will want to dig into next.

That post-hoc context is strictly richer than what the planner had
when it submitted the section list. A dedicated single-cycle cloud
LLM pass after stitching produces drill-downs of much higher signal
than asking the planner to invent them on top of partial discovery.

#### Shape

Extend `PLAN_ACTIONS_SCHEMA` with an optional, **orchestrator-
populated** field per action:

```ts
drillDownPrompts?: readonly string[]   // 2-3 follow-up questions,
                                       // each ≤ 100 chars
```

The planner does NOT populate this -- its submit_plan output leaves
it absent. The orchestrator fills it in during the final stitch.

#### Flow

After per-section drafting completes, before `finalizeSynthesisedReport`:

1. Build a compact post-discovery context per section: title,
   objective, the final shipped markdown, the structural-check
   signals (tripwire excerpts, uncited paragraphs, low-grounded
   claim count), and the writer's notes.
2. Single cloud LLM call (cheap; one round-trip total, NOT per
   section) with a structured-output schema asking for 2-3
   drill-down prompts per section.
3. Merge the LLM response into the `actions[]` list as the new
   `drillDownPrompts` field per section.
4. Stitcher renders them as bullets in the `## Drill down` block,
   grouped by section title. The placeholder text goes away when
   `actions.every(a => a.drillDownPrompts?.length > 0)`.

This keeps the planner-discovery loop tight (no extra turn cost)
and amortises the drill-down LLM call across all 10 sections.

### Citation URL scheme (Phase 6)

**The `path:` prefix has no consumer.** A workbench-wide grep for
`scheme === 'path'` / `'path:'` / `"path:"` turns up zero hits in
`src/vs/workbench` or `src/vs/editor`. The Report Pane
([analysisReportPane.ts:132](src/vs/workbench/contrib/insrc/browser/code-analyzer/analysisReportPane.ts#L132))
hands the raw markdown to VS Code's standard `MarkdownRenderer`,
which sees `path:foo/bar.ts` as an unknown URL scheme and falls
through to the OS link handler -- that's how the doubled
`/Users/.../hadoop/Users/...` prefix surfaces. Nothing depends on
the prefix, so we strip it without compatibility risk.

**Producers** (all 4 sites are owned by code-analyzer; no
cross-contribution consumers):

- [discovery-flow.ts:428](src/insrc/agent/tasks/code-analyzer/discovery-flow.ts#L428)
- [write-from-evidence-structured.ts:341](src/insrc/agent/tasks/code-analyzer/write-from-evidence-structured.ts#L341)
- [write-from-evidence.ts:311](src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts#L311)
- [write-section.ts](src/insrc/agent/tasks/code-analyzer/write-section.ts) -- prompt examples taught to the writer LLM (must update so the LLM doesn't reintroduce the prefix)

**Change** (mechanical):

```diff
- [ManagedCursor.__init__](path:insors/extraction/db/__init__.py#L60-L116)
+ [ManagedCursor.__init__](insors/extraction/db/__init__.py#L60-L116)
```

Centralise the formatter (currently duplicated across the 3 emitter
files; pull into a single `renderCitationLink(label, file, range)`
helper while at it). Tripwire pattern check: after emitting, regex
the assembled markdown for `\(path:` -- assert zero occurrences.

## Phase breakdown

| Phase | Scope | Ship gate |
|---|---|---|
| **1. Indexer audit** | `scripts/audit-indexer-coverage.ts`: lists on-disk-but-no-row + indexed-but-empty per repo. Read-only diagnostic. | Output file lists for `insors-extraction` and `hadoop`; identify the file family causing the K3s "validation errors" message and the Python file family containing `mapping_generation_agent.py` |
| **2. Targeted indexer fixes** | Based on Phase 1, fix each rejected-file class. Likely candidates: tree-sitter Python files with rare syntax (decorators, walrus operator), YAML files with multi-doc separators (`---`), Dockerfiles with HEREDOC. Add `WARN`-level log + per-reason counter when the indexer skips a file. | `mapping_generation_agent.py` indexed on rerun; K3s manifests indexed (or documented permanent skip with a registry entry); telemetry dashboard shows skipped-file reasons by name |
| **3. Skill catalog additions** | New skills: `code.const.locate-by-name` (Python + TS literal-assignment scanner) and `code.security.audit-coverage` (composite grep + callers). Both closure-scoped per Plan SCS. Behind `INSRC_PLANNER_SKILLS_V2` flag for A/B. | Unit tests pass; planner-discovery catalog includes both behind the flag; opt-in flag toggles them on for the next live run |
| **4. Writer prompt tighten** | Inline the "cite the declaration line, not the implementation range" rule into the discovery-flow writer prompt. Add a tripwire-style structural check: regex for "default X of N" + assert citation line range ≤ 5 lines wide; redraft on violation. | Synthetic test where writer is fed broad-range evidence + asked to claim a specific value -> forces redraft to softer language |
| **5. Drill-down bullets** | Extend `PLAN_ACTIONS_SCHEMA` with optional `drillDownPrompts: string[]` per action (2-3 items, ≤100 chars each). Update planner system prompt to require them on submit. Orchestrator renders them in the final report's `## Drill down` section, grouped by section. | Live run report ends with populated `## Drill down` bullets instead of the empty-state placeholder |
| **6. Citation URL scheme** | Replace `path:foo/bar` with bare `foo/bar` in the citation formatter inside `writeSectionFromEvidence` (or wherever the citation template is centralized). Verify workbench markdown renderer opens the resulting paths on click. | Manual: click any citation in the rendered report; verify it opens the file without IDE prepending the workspace root twice |
| **7. Calibration** | Re-run the same `insors-extraction` analysis end-to-end. Assert: no `path:` prefixes in the output; drill-downs populated; no "not indexed" footnote for any file class fixed in Phase 2; writer self-contradictions reduced (manual diff vs the morning's report). | Final report ships with all six fixes visible; release notes |

Phases 1-2 ship in one PR (audit + fix tightly coupled). Phases 3-6
are independent and can ship in parallel. Phase 7 is the rollout
gate.

## Open questions

1. **Audit-coverage skill (Phase 3)**: detecting whether *every* call
   site of a sensitive write has an audit-log call is a non-trivial
   static analysis. Initial v1 should restrict to "the function that
   writes is in the same module as a function whose name matches
   `/log|audit/i`" -- coarse but cheap. Tighten later if false-
   negatives are high.

2. **`path:` scheme history (Phase 6)**: where exactly is this URL
   scheme produced and consumed? Need to grep the workbench /
   contributions / markdown-render path before changing it -- if
   anything cross-repo-aware depends on the prefix (e.g. a custom
   command that resolves `path:foo` against a registered repo set
   rather than the active workspace root), removing it would
   regress that. Walk it before editing the formatter.

## Out of scope

- **Cross-repo follow-up**: Plan SCS Phase 8 still pending --
  re-validate against a second indexed repo (besides
  `insors-extraction`) once the indexer fixes from Phase 2 land.
- **Multi-cycle drill-down execution**: clicking a drill-down bullet
  in the IDE should launch a focused follow-up analysis. UI + IPC
  wiring lives in a separate plan.
- **Indexer schema migration** (new entity kinds like
  `kind: 'constant'`): out-of-scope for this plan; if Phase 3's
  composite skills perform poorly, we revisit in a dedicated graph-
  schema plan.
- **Reviewer prompt rewrite**: the current reviewer is fine; only the
  writer prompt + structural check change in Phase 4.

## Risk

- **Phase 2 indexer fixes** could break parsing on previously-working
  files. Mitigation: run the audit script (Phase 1) BEFORE and AFTER
  to confirm the diff is purely additive.
- **Phase 4 tripwire** could over-trigger on perfectly-valid prose if
  the regex is too greedy. Mitigation: start with the strictest
  pattern (literal `"default X of N"` + assert line range ≤ 5) and
  expand only if real cases slip through.
- **Phase 5 turn-budget impact**: open question (3) above; lean on
  the deferred-pass option to keep planner-discovery latency stable.
