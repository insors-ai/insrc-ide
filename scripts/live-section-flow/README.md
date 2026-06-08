# Live Ollama tests for section-flow LLM call sites

One script per LLM-touching step in the section-flow / working-memory /
content-gen pipelines. Each script exercises ONE call site against a
real local Ollama model and asserts schema + content sanity. Bar is
"local-model responses are not completely off the picture" — schema must
hold, content must reference the seed terms, no refusal patterns.

## Run

```bash
source ~/.insors
npx tsx scripts/live-section-flow/<N>-<name>.ts            # one trial
npx tsx scripts/live-section-flow/<N>-<name>.ts --trials=3 # stability check
npx tsx scripts/live-section-flow/<N>-<name>.ts --verbose  # dump LLM output
npx tsx scripts/live-section-flow/<N>-<name>.ts --model=qwen3-coder:latest
```

Default model: `qwen3.6:35b-a3b` (override with `--model=...`). All
scripts pass `disableThinking: true` so the qwen3.6 `think: false`
control field is sent.

## Scripts

| File | LLM step under test | What it validates |
|---|---|---|
| `01-investigation-plan.ts` | `step-investigation-plan` | TODO list 1-12, kebab ids, no near-dupes, retry path |
| `02-section-planner.ts` | `step-section-planner` | PlannedTree shape, ≥2 roots, **catalog-membership (GAP A fix)** |
| `03-root-execution-review.ts` | `step-root-execution` per-root review | 3-verdict JSON, suggested_leaves coercion |
| `04-section-review.ts` | `step-section-review` review + revise | 3-verdict + non-empty revise markdown |
| `05-report-assemble.ts` | `step-report-assemble` | Non-empty markdown, sections preserved, no inventions |
| `06-report-review.ts` | `step-report-review` review + revise | 3-verdict + structural payload (scope-gap) |
| `07-wm-shaper.ts` | `working-memory/shaper.shapeMemory` | 5-key bundle, token budgets enforced |
| `08-wm-updater.ts` | `working-memory/updater.incrementalUpdate` | Per-layer single-key × 3 layers, semantic relevance |
| `09-wm-bullet-extractor.ts` | `working-memory/bullet-extractor.extractBullets` | 5-10 prompt-agnostic bullets, no Qs/recs |

## Outcomes

Each trial reports one of:

- `pass` — schema + sanity OK
- `pass-degraded` — schema OK, sanity issue(s); does not exit non-zero
- `fail` — schema violation or throw; exit code 1

Use `pass-degraded` to track model drift across upgrades without breaking
CI signals.

## Baseline results (2026-06-08, model `qwen3.6:35b-a3b`)

All 9 scripts ran clean against the local model:

| Script | Outcome | Notes |
|---|---|---|
| 01 investigation-plan | pass | 7 TODOs, first attempt valid |
| 02 section-planner | pass (after retry) | first attempt catches hallucinated catalog ids; retry produces valid tree |
| 03 root-execution-review | pass | 3 followup cycles → force-accept with revise-major (cap contract) |
| 04 section-review | pass | review verdict + revise-edits cycle both fired |
| 05 report-assemble | pass | 1830-char report, distinctive content preserved |
| 06 report-review | pass | scope-gap correctly flagged on deliberate-gap question |
| 07 wm-shaper | pass | all 5 layers populated within budget |
| 08 wm-updater | pass | 3 layer calls; semantic layer surfaces next-objective content |
| 09 wm-bullet-extractor | pass | 8 prompt-agnostic bullets, no Qs/recs |

The section-planner reliably triggers the retry path because the worked
example uses placeholder skill ids (intentional — the catalog rule pushes
the model to consult the SKILL CATALOG section); after the corrective
hint, retry validates cleanly and the model picks real registry ids.
