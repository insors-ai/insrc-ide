# Planner-discovery loop for the code-analyzer

## Motivation

Validation run on 2026-05-23 (against `insors/extraction`, tier-XL,
request: "review insors/extraction") shipped 9 sections but **5 of
the 9 titles were generic menu-axis copies** that the planner prompt
explicitly flags as "bad examples": *Configuration & Environment
Management*, *Public Entry Points & Service Interfaces*, *Testing
Framework & Coverage Strategy*, *External Dependencies & Third-Party
Integrations*, *Deployment & Build Artifacts*. The plan also missed
the actual subsystems entirely: financial, legal, payable, matching,
services, ocr — none made it into a single section.

Trace from the live planner call (llmCallId 3, Anthropic Haiku):

The cloud planner's entire view of the repo was this static block:

```
Top modules by file count (max 12):
  insors/extraction/db                            33 files, 808 entities
  schemas/common/scripts/deltas                   33 files, 33 entities    ← SQL migrations
  examples                                        26 files
  insors/core/model/common                        25 files, 314 entities
  test/integration/data/BB/GRN                    25 files, 25 entities    ← test data
  test/integration/data/BB/PO                     25 files, 25 entities    ← test data
  test/integration/data/BB/po-transformed         25 files, 25 entities    ← test data
  scripts                                         21 files
  insors/core/common                              20 files, 377 entities
  insors/core/tasks                               18 files, 188 entities
  insors/extraction/common                        18 files, 157 entities
  docker/k3s/scripts                              17 files, 19 entities    ← shell scripts
```

Three observations make a rules-based fix structurally inadequate:

1. **The "top modules by file count" heuristic is inverted relative
   to architectural weight.** A 3000-line consumer counts as one
   file; a directory of 25 PO test fixtures counts as 25.
2. **Non-code directories are invisible** even when they're load-
   bearing: 33 Dockerfiles in `docker/insors/`, full k8s manifests
   in `deployments/GCP/`, all entry-point services in
   `insors/extraction/services/` — none appear in the summary.
3. **Repo shapes vary too widely for a static template to cover.**
   A test-framework repo, a notebook-heavy research codebase, an
   Erlang umbrella, an infra-only repo — each demands a different
   "what's important here?" answer. Hand-tuned denylists and
   weighting heuristics will always be wrong for some class of repo.

The fix is to give the planner the same kind of agency the per-
section discovery flow already has: let it ask the orchestrator what
it needs to know, get answers from real skill calls (including
git-state queries), and commit to a plan when it has enough context.

## Architectural fit

This plan is the **fifth consumer** of the tool-loop substrate
described in `plans/tool-loop-substrate.md`. The loop mechanics,
termination protocol, telemetry, and failure-mode handling all live
in the substrate. This plan adds:

- A curated subset of the existing skill catalog exposed to the
  planner (no new `planner_*` namespace)
- 3 new catalog skills the planner needs that don't exist today
  (literal grep + 2 git-state skills) — added as regular skills,
  available to any future caller including the per-section flow
- One small enhancement to `code.source.module.describe`
  (file-read fallback parallel to the one shipped for
  `code.source.file.describe`)
- The `submit_plan` terminationTool definition (typed payload =
  today's `PlanActionsResult` schema)
- A uniform planner seed (request + repo path + tool catalog +
  subtype hint)
- The orchestrator wiring that swaps in `planActionsInteractive`
  behind a feature flag

## Tool surface (reuses the existing skill catalog)

The planner consumes a curated subset of the existing
`src/insrc/daemon/skills/built-ins/code.*` skill catalog. No new
planner-specific namespace; same skill ids and descriptions the
per-section flow uses. Three of the nine are new catalog skills
added by this plan; six are pre-existing.

| Skill id | Status | Purpose |
|---|---|---|
| `code.source.repo.describe` | existing | Top-level repo summary (entity kinds, languages, top modules) |
| `code.source.module.describe` | existing (small enhancement here) | Walk into a module/directory; list files + entities + languages. Enhancement: file-read fallback when the dir has zero indexed entities (mirrors the fallback we shipped for `file.describe`) |
| `code.source.file.describe` | existing | Read a specific file's entities + body (already has the `bodyExcerpt` file-read fallback shipped recently) |
| `code.entity.summary` | existing | Read an entity body. With the file-read fallback, this naturally returns README contents when called on a file entity for a README |
| `code.entity.locate-by-name` | existing | Find an entity by name (used when the planner suspects a specific class/file exists and wants to confirm) |
| `code.entity.search-by-vector` | existing | Semantic search (used when the planner suspects a feature/concept exists but can't name a directory or class) |
| `code.source.grep` | **NEW** | Literal pattern search bounded to a path + maxHits. Complements `entity.search-by-vector` for literal-pattern questions (`@app.route`, `import celery`) where semantic matching is wrong |
| `code.repo.git-status` | **NEW** | List files changed vs a ref (`ref?='HEAD'`). For "review changed files" requests |
| `code.repo.git-recent` | **NEW** | List files from recent commits (`count?=5`). For "review my recent work" requests |
| `submit_plan` | substrate pseudo-tool | Terminates the loop with the typed `PlanActionsResult` payload |

The planner picks which skills to use based on the request and the
canonical tool descriptions. "Review insors/extraction" →
`module.describe(insors/extraction)` + `file.describe(insors/extraction/README.md)`
+ per-subdir `module.describe`. "Review changed files" →
`code.repo.git-status` first, then `module.describe` on each
module touched. The orchestrator does NOT pre-resolve any of this.

The PR-files case (`"review PR #142"`) is left to v2 — `gh`
availability is platform-dependent and the v1 git skills cover the
working-tree-vs-ref case. Until a `code.repo.git-pr-files` skill
lands, PR-shaped requests degrade to `git-status` over a
user-relevant ref.

### Why reuse instead of a `planner_*` namespace

1. **One source of truth for skill descriptions.** The planner sees
   the same canonical tool descriptions the per-section local LLM
   sees. No risk of the two flows building different mental models
   of the same capability.
2. **Hallucination-pattern fixes apply uniformly.** The
   `tool-call-guard-layer` (Plan 1)'s per-skill arg-rename map fixes
   both flows from one place.
3. **Catalog grows once.** The 3 new skills (`code.source.grep`,
   `code.repo.git-status`, `code.repo.git-recent`) become available
   to the per-section flow too — useful for future "review files
   changed by commit X" investigations.
4. **Less code to maintain.** No parallel definition layer; the
   planner's tool list is a string array of skill ids.

## Subtype-driven planner-prompt hint

The scope classifier emits a `subtype` (see
`plans/scope-classifier-subtype-extension.md`) describing the work
shape: `review | summarize | audit | explain | compare | document
| diagnose`. The orchestrator appends a single bias line to the
planner's system prompt based on the subtype:

| `subtype` | One-line hint |
|---|---|
| `review` | "This is a review request — bias your sections toward surfacing gaps, risks, weak spots, and improvement opportunities." |
| `summarize` | "This is a summarize request — bias toward concise, broad-stroke sections. Prefer fewer sections; avoid exhaustive enumeration." |
| `audit` | "This is an audit request — bias toward exhaustive coverage with explicit verdicts on each axis. Don't skip relevant axes; surface problems clearly." |
| `explain` | "This is an explain request — bias toward pedagogical walkthrough. Sections should teach how/why things work, not just list what's there." |
| `compare` | "This is a compare request — bias each section toward two-sided framing (X vs Y, before vs after)." |
| `document` | "This is a document request — bias toward neutral, complete reference documentation. Sections should read like docs, not opinions." |
| `diagnose` | "This is a diagnose request — bias toward evidence-driven cause analysis. Sections should follow the investigation, not the codebase's structure." |

No other downstream effect. The seed shape, tool set, per-section
budgets, review criteria — all unchanged across subtypes.

## Seed (uniform)

```
## Request
<user request verbatim>

## Active repo
<repo path>

## Available skills
<canonical tool descriptions for the 9 skill ids listed above,
 generated from the skill registry — same descriptions the per-
 section flow's local LLM sees>
- submit_plan({...})  Submit the final plan when ready.

Use these skills to discover the structure of the repo and the
scope of the request before committing to a plan. Commit only
when you can name each section after a real subsystem you've
observed or a concrete file group the request points at.

<subtype hint from the classifier, appended here>
```

No pre-baked tool results. No conditional branching on request
shape. The planner reads the request, sees the catalog, picks the
right skills, and commits when ready.

## Substrate configuration

```ts
runToolLoop<PlanActionsResult>({
  provider:     cloudProvider,
  messages:     buildPlannerSeedMessages(request, repoPath, subtypeHint),
  tools:        PLANNER_DISCOVERY_TOOLS,
  dispatchTool: dispatchPlannerTool,
  policy: {
    maxTurns:                4,
    toolChoice:              'auto',
    terminationTool: {
      name:        'submit_plan',
      description: 'Submit the final plan when discovery is complete.',
      inputSchema: PLAN_ACTIONS_SCHEMA,
      validate:    validatePlanActionsResult,
    },
    onMixedTermination:    'reject',
    onSchemaViolation:     'retry-with-correction',
    stopOnDegenerateRepeat: true,
  },
  label: 'planner-discovery',
});
```

All loop mechanics — turn budgeting, transcript management,
corrective prompts, telemetry — come from the substrate.

## Failure / exhaustion handling

The substrate returns `{ kind: 'exhausted', reason, transcript }`
if the planner hits `maxTurns: 4` without a valid `submit_plan`.
For v1, **all exhaustion paths fall through to
`synthesiseFallbackAction(ca, accepted)`** — today's degraded
single-action fallback. Throw away the transcript; ship a generic
plan; log the event with reason, turn count, and any failed
submit_plan attempts for telemetry-driven follow-up.

Rationale: exhaustion in the static planner is ~0%; the interactive
planner with 4 turns should be at least as decisive. If live data
shows exhaustion >10%, upgrade to a recovery strategy (last-attempt
salvage, or forced-final-commit once the substrate exposes
`tool_choice: 'tool:<name>'`).

## Phase breakdown

| Phase | Scope | Ship gate |
|---|---|---|
| **0. Precondition: scope-classifier subtype extension** | See `plans/scope-classifier-subtype-extension.md` Phases 1-4. Must land first. | Classifier emits `subtype` reliably across a sample of requests |
| **1a. New catalog skills** | Add 3 new skills to `src/insrc/daemon/skills/built-ins/`: `code.source.grep`, `code.repo.git-status`, `code.repo.git-recent`. Standard skill shape (registry registration + schema + execute). Unit tests against fixture filesystems / fixture git repos. Failure modes (missing `git`, no-git repo) covered. | New skills work in isolation; available to ALL catalog consumers, not just the planner |
| **1b. Enhance `code.source.module.describe`** | Apply the file-read fallback we shipped for `code.source.file.describe` — when a module dir has zero indexed entities, return a file listing from disk. ~30 lines on top of existing skill. | Module.describe returns useful output for unindexed dirs (config / deployment / shell-script dirs) |
| **1c. Curated planner skill list** | Define `PLANNER_DISCOVERY_SKILL_IDS: readonly string[]` listing the 9 skill ids the planner consumes. Wire the substrate's `tools` parameter from these. | Constant module shipped; substrate's `dispatchTool` correctly routes to skills by id |
| **2. `planActionsInteractive` wired on the substrate** | New entry point in `agent/content-gen/plan-actions.ts` that calls `runToolLoop` with the planner config. The legacy one-shot `planActions` stays in tree for rollback. | Substrate-driven planner runs end-to-end against a fake cloud provider that scripts canned tool-call + submit_plan responses |
| **3. Prompt updates** | System prompt + tier-context files updated for the tool-use protocol. Subtype hints inlined. Existing prompt-snapshot tests regenerated. | Snapshot tests pass; manual prompt review |
| **4. Orchestrator wiring** | Feature-flag dispatch at `daemon/controllers/code-analyzer-orchestrator.ts:709`: `INSRC_ANALYZER_PLANNER_FLOW=interactive` (default) → new path; `=static` → legacy. Subtype hint appended to seed from `classification.subtype`. | Live `/code-analyze` run completes end-to-end with the interactive planner |
| **5. Live validation** | Re-run the `insors/extraction` "review" prompt. Compare against (a) Claude's independent reference at `/tmp/insors-extraction-claude-analysis.md` and (b) the prior static-planner output. Also run a "review changed files" prompt to confirm `code.repo.git-status` flows through the planner correctly. | Live runs show substantial improvement; git-shaped requests get sensible plans without orchestrator-side detection |

Phases 1-4 ship together (no value mid-stream). Phase 5 is the
validation gate.

## Validation criteria

For each repo / request validated:

| Criterion | Threshold |
|---|---|
| Section titles naming real subsystems / concrete file groups | ≥ 60% (vs ~30% baseline) |
| Generic menu-axis titles ("Testing Framework", "External Dependencies", etc.) | ≤ 1 per plan |
| Discovery turns before commit | 2-4 (turn budget respected) |
| `submit_plan` schema violations recovered | 100% (substrate retries) |
| Plan section count | Driven by request, not padded to ceiling |
| Git-shaped requests (`"review changed files"`) | Planner invokes `code.repo.git-status` and plans against the result |
| Subtype-driven emphasis (`summarize` vs `audit` for the same target) | Plans visibly differ in section count + depth |

## Out of scope

- **Tool-loop substrate mechanics.** See
  `plans/tool-loop-substrate.md`. This plan consumes the substrate;
  it does not define how the loop runs.
- **Pre-dispatch tool-call guard.** See
  `plans/tool-call-guard-layer.md`. The cloud planner does not
  exhibit the qwen-shaped hallucination pattern at scale, so the
  guard is OFF by default for this call site.
- **Scope-classifier subtype extension.** See
  `plans/scope-classifier-subtype-extension.md`. Precondition for
  this plan.
- **Per-subtype tool-set or prompt evolution beyond the one-line
  hint.** Subtype only emits a single bias line in the planner's
  system prompt; no other downstream effect. Per-subtype review
  criteria templates, budgets, or tool filters are future work.
- **Per-section discovery flow.** Unchanged. Once the planner
  emits the `PlannedAction[]`, the rest of the pipeline (verify,
  expand, execute, review, write) is unchanged.
- **Verify-step vector-fallback name-stem check.** A real follow-
  up (vector fallback currently rubber-stamps semantically-unrelated
  matches), but separate from the planner-discovery work.

## Open questions

1. **PR-shaped requests in v1.** v1 ships with `code.repo.git-status`
   and `code.repo.git-recent` — covers "review changed files" and
   "review recent commits" but not "review PR #N" directly. PR-shaped
   requests degrade to git-status over a user-relevant ref (planner
   handles this via standard tool-failure → corrective-prompt path).
   A dedicated `code.repo.git-pr-files` skill (wrapping `gh pr files`
   with graceful degradation when `gh` is unavailable) is a clean
   follow-up but not blocking ship.

## Rollback

`INSRC_ANALYZER_PLANNER_FLOW=static` falls back to the legacy
one-shot `planActions`. Legacy code path stays in tree at least
through one validation cycle.
