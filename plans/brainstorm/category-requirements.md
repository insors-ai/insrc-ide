# Requirements Brainstorm Category — Refactor Plan

## Goal

Extract the current brainstorm behavior into `RequirementsBrainstormController`.
**Pure refactor** — no new prompts, no new templates, no behavior changes.

## Scope

This is Phase 2 of `core-restructure.md`. The entire implementation is:

```typescript
// src/daemon/controllers/brainstorm/requirements.ts

export class RequirementsBrainstormController extends BrainstormControllerBase {
  get category() { return 'requirements' as const; }

  getSeedPrompt()              { return SEED_SYSTEM; }
  getDivergePrompt()           { return DIVERGE_SYSTEM; }
  getReviewIdeasPrompt()       { return REVIEW_IDEAS_SYSTEM; }
  getConvergeClusterPrompt()   { return CONVERGE_CLUSTER_SYSTEM; }
  getConvergePromotePrompt()   { return CONVERGE_PROMOTE_SYSTEM; }
  getThemeSpecPrompt()         { return buildGenerateThemeSpecSystem(); }
  getReviewThemeSpecPrompt()   { return REVIEW_SPEC_SYSTEM; }
  getAssemblePrompt()          { return buildAssembleSpecSystem(); }
  getSpecTemplate()            { return loadSpecTemplate(); }
  getThemeSpecTemplate()       { return loadThemeSpecTemplate(); }
  getDocPrefix()               { return 'REQ-DOC'; }
  getThemePrefix()             { return 'REQ-TH'; }
  getSaveDir()                 { return 'brainstorms'; }
  getConvergenceLabel()        { return 'feature area'; }
  getIdeaGateTitle()           { return 'Idea Review'; }
  getConvergenceGateTitle()    { return 'Convergence Review'; }
}
```

All prompts, templates, and parsing functions already exist in:
- `src/agent/tasks/brainstorm/prompts.ts`
- `src/agent/tasks/brainstorm/templates.ts`

## What stays the same

Everything. The requirements category IS the current implementation.

- Ideation: seed ideas → Claude review → user gate with tick/cross
- Convergence: cluster by feature area → promote to requirements
- Spec gen: per-theme requirements table + acceptance criteria
- Review: Claude validates testability, completeness, conflicts
- Output: REQ-DOC-* with requirement tables, cross-references, traceability
- Save: brainstorms/ directory

## Future enhancements (not in this refactor)

- Requirements-specific convergence prompt that emphasizes user stories
- Priority weighting in spec assembly based on user-set priorities
- Traceability matrix auto-generation from idea→theme→requirement chain
- Integration with designer agent (output feeds directly as input)

## Verification

After refactor, run the same brainstorm test case. Output should be identical.
