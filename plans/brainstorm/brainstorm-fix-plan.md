# Brainstorm Agent Fix Plan (v12)

Issues from testing on 2026-03-18/19 (rounds 3–10). All v5–v9 issues fixed and committed. Round 10 verified enhancements E3–E6 deployed but revealed merge/feedback bugs in the diverge cycle.

Status key: **DONE** = verified working, **OPEN** = not started, **REGRESSED** = fix didn't work

---

## Fixed Issues (v5) — committed `11972c0`

1. Intent badge shows `brainstorm/requirements` — DONE
2. Scrollbar in collapsed gate card — DONE
3. User-added ideas appear immediately — DONE
4. Gate card min-height 1/3 chat window — DONE
5. Theme IDs in final output — DONE (`aeb6e37`)
6. Requirements filename uses doc ID — DONE
7. Working indicator stuck — DONE

## Fixed Issues (v6) — committed with v5 batch

8. Per-idea feedback persistence — DONE (context-builder, base.ts, webview)
9. Quality variance between runs — DONE (multiple sub-fixes)
10. Changelog in template — DONE

## Fixed Issues (Round 6) — committed `79160f2`

11. Diverge temperature too high — DONE (`base.ts` — lowered to 0.5)
13. Rejected ideas leak into convergence — DONE (`applyGateSelections()`)
15. Claude review too permissive — DONE (`prompts.ts` — stricter relevance)
16. Artifact indexing/filtering — reverted (user preference)

## Fixed Issues (Round 7) — committed `79160f2`

12. "Approve All" disabled functionality — DONE (functionally disabled)
14. Double HTML wrapping — DONE (`htmlContent` + `passThrough` on presentation)
17. Diverge button on gate card — DONE
17b. Comment fields not cleared after incorporation — DONE

## Fixed Issues (Round 8) — committed `800a5c2`

18. Claude review results not processed by local LLM — DONE

New `refine-ideas` step: `generate-ideas → review-ideas (Claude) → refine-ideas (local LLM) → idea-gate`. Drops weak, rewrites moderate, keeps strong. New abstract hook `getRefineIdeasPrompt()`.

## Fixed Issues (Round 9) — committed `26b4f70`

- Vector store search before diverge rounds (`search-context` step via RPC)
- `startIdeationRound()` helper — all re-run paths go through it
- User idea `reviewVerdict: 'user'` support in prompts
- Gate button hover/active states, disabled styling improvements
- Requirement count in session summary (R-\d{3} regex)
- Changelog date injection (real date, not hallucinated)
- Orphan `<li>` wrapping in assembly output

## Implemented Enhancements (Round 10) — not yet committed

### Enhancement 3: Per-idea enhancement via vector search — DONE (code)

New flow: `generate-ideas → enhance-ideas-search (RPC) → enhance-ideas-llm (local) → review-ideas (Claude)`

Files: `base.ts` (3 new handlers + 2 task builders), `prompts.ts` (`ENHANCE_IDEAS_SYSTEM`), `requirements.ts` (hook)

### Enhancement 4: Delta-only processing for diverge rounds — DONE (code)

- `buildReviewIdeasTask()`: on round > 1, only sends current-round ideas to Claude. Approved items shown as read-only context.
- `buildRefineIdeasTask()`: on round > 1, only sends current-round ideas to local LLM.
- `afterReviewIdeas()`: "all weak" check only considers current-round ideas.

### Enhancement 5: Per-theme vector search — DONE (code)

New `search-theme-context` step before each `generate-theme-spec`. Builds query from theme name + description + idea texts. Fresh per-theme code context replaces stale global context.

Files: `base.ts` (new step handler + task builder), `agent-state.ts` (`themeSearchContext` field)

### Enhancement 6: Smarter diverge prompt — DONE (code)

Replaced technique-based diverge prompt with engineering-focused approach: gaps, combinations, edge cases, depth. Explicit "Do NOT use analogies from other domains" instruction.

---

## Verified DONE in Round 10 output (`req-doc-bc1db1aa.html`)

- Theme IDs (`REQ-TH-xxx`) in output — DONE
- Filename uses doc ID — DONE
- Changelog section with correct date (`2026-03-18`) and author (`Subho Ghosh`) — DONE
- No double HTML wrapping — DONE
- No orphan `<li>` tags — DONE
- Requirements count correct (18) — DONE
- Cross-references table present — DONE
- Traceability table present — DONE
- 6 themes, 18 requirements — quality significantly improved over prior rounds

---

## Open Bugs (Round 10 testing)

### Bug 30: Duplicate ideas in round 2 merge — OPEN

**Problem:** Round 1 ideas (1–8) appear duplicated as round 2 ideas (10–16) in the output. Ideas [1] and [10] are identical, [4] and [11], etc.

**Root cause:** `afterRefineIdeas()` merges `priorAccepted + refinedIdeas`, but the refinedIdeas on round 2 include paraphrased copies of round 1 ideas. The delta-only fix in `buildReviewIdeasTask` and `buildRefineIdeasTask` correctly filters to `round === currentRound`, but the **enhance step** (`buildEnhanceIdeasSearchTask` / `afterEnhanceIdeasLlm`) and the **generate step** (`buildGenerateIdeasTask`) are still processing the full set or feeding the full context to the LLM.

**Fix needed:**
1. `buildEnhanceIdeasSearchTask()` — already filters to current round. Verify.
2. `afterEnhanceIdeasLlm()` — matches enhanced ideas back to originals by index. But if the LLM outputs ideas with indices [1]–[8] (round 1 indices), they'll overwrite round 1 originals. **Fix:** match only against current-round ideas.
3. `buildGenerateIdeasTask()` (round > 1) — check if the existing approved ideas in the diverge context are being regenerated. The diverge prompt says "generate NEW ideas" but the LLM may paraphrase existing ones.
4. `afterGenerateIdeas()` (round > 1) — `parseIdeaList` starts numbering from `nextIdeaIndex`. If `nextIdeaIndex` is correct, the new ideas should have non-colliding indices. **Verify** `nextIdeaIndex` is properly maintained.

**Files:** `base.ts` (`afterEnhanceIdeasLlm`, `afterRefineIdeas`, `afterGenerateIdeas`)

### Bug 31: User feedback lost in diverge cycle — OPEN

**Problem:** User-added ideas and comments on ideas are not carried through to the diverge cycle. Only item deletions (rejections) took effect. The user's idea about intent detection (`/find`, `/explain`, `/analyze`) is absent from final output.

**Root cause:** When user clicks "Diverge" in `afterIdeaReview()`:
1. User-added ideas get `status: 'accepted'` and are stored in `state.ideas` ← this part works
2. But the diverge generate step only shows accepted ideas as READ-ONLY context. New ideas added by the user are marked `source: 'user'`, `status: 'accepted'` — they survive in state but are never sent through the enhance → review → refine pipeline.
3. The user's idea needs to flow through: enhance (get code refs) → review (Claude evaluates) → refine (local LLM processes) → appear in gate with verdict.

**Fix needed:**
1. In `afterIdeaReview()` diverge path: user-added ideas should be set to `status: 'proposed'` and `round: currentRound+1` (the new round) so they flow through the delta pipeline.
2. Commented ideas should also be updated: set `round: currentRound+1` so they're included in the delta set for re-processing.
3. The diverge generate step should include user ideas as "ideas to build upon" rather than just context.

**Files:** `base.ts` (`afterIdeaReview` diverge path)

### Bug 23 (4th report): "Approve All" disabled styling not visible — REGRESSED

**Problem:** Button looks active/highlighted even when disabled. Reported 4 times.

**Note:** Extension was confirmed installed (`code --install-extension --force`), diverge button visible, so the correct build IS deployed. The CSS fix genuinely isn't working.

**Action:** Debug in VS Code webview DevTools. Inspect the button element when disabled. Check:
1. Is the `disabled` attribute on the DOM element?
2. Does the CSS selector match?
3. Is another rule with higher specificity overriding?

**Files:** `vscode-insrc/src/webview/chat.html`

---

## Future Enhancements

### Enhancement 7: Refactor gate feedback to `IdeaFeedback` structure

**Problem:** Current gate feedback is a messy JSON bag with `selections`, `comments`, `addedIdeas` as separate dictionaries keyed by index strings. Fragile, easy to desync.

**Proposed structure:**
```typescript
interface IdeaFeedback {
  items: Array<{
    idea: Idea;       // or just idea.id
    selected: boolean; // true = keep, false = rejected
    comment?: string;
  }>;
  addedIdeas: string[];
}
```

One array, one pass to process. Fixes root cause of desynced selections/comments.

### Enhancement 8: Per-idea vector search (sequential per idea)

Current E3 implementation does a single batch search with all idea texts combined. A more thorough approach would search per-idea and ground each individually. Lower priority — batch approach works well enough.

### Enhancement 9: Incremental context enrichment

Build up code context across rounds rather than replacing it. Each round's search results augment the prior context (with dedup). Currently `afterSearchContext` appends but the enhance step replaces.

---

## Remaining Known Issues

### Daemon shutdown hangs (TODO in index.ts)

`daemon stop` times out after 5s; old process holds Kuzu DB lock. Root cause: `queueDone` never resolves if LLM jobs are in-flight. See TODO at `src/daemon/index.ts:611`.

---

## Files Modified (all rounds)

| File | Changes |
|------|---------|
| `src/daemon/controllers/brainstorm/base.ts` | All step handlers, task builders, enhancement steps (E3–E5), delta-only logic (E4), search-context, startIdeationRound |
| `src/daemon/controllers/brainstorm/requirements.ts` | All abstract hook implementations including `getEnhanceIdeasPrompt()` |
| `src/agent/tasks/brainstorm/prompts.ts` | All prompts: SEED, DIVERGE (E6), ENHANCE (E3), REFINE, REVIEW, cluster min-theme, user verdict |
| `src/agent/tasks/brainstorm/types.ts` | `reviewVerdict` widened to include `'user'` |
| `src/agent/tasks/brainstorm/assembly.ts` | Theme IDs, HTML guard, orphan li wrap, requirement count |
| `src/agent/tasks/brainstorm/templates.ts` | Changelog section |
| `src/agent/tasks/brainstorm/context-builder.ts` | Feedback persistence |
| `src/agent/tasks/brainstorm/agent-state.ts` | `requirementCount`, `themeSearchContext` fields |
| `src/daemon/task.ts` | Terminal gate actions, passThrough |
| `src/daemon/index.ts` | Shutdown TODO |
| `vscode-insrc/src/webview/chat.html` | Scrollbar, added ideas, min-height, disabled styling, diverge button, hover states, gate feedback refactor |
| `vscode-insrc/src/ui/chatPanel.ts` | Intent badge category |
