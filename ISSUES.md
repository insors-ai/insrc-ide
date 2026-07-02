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
