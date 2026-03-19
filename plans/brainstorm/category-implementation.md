# Implementation Brainstorm Category — Implementation Plan

## Goal

Create `ImplementationBrainstormController` — a sub-controller for brainstorming coding approaches, task breakdowns, library choices, and refactor strategies. Output is an implementation plan with task cards, code references, dependency ordering, and estimated effort.

## Flow

```
generate-ideas (local: implementation approaches, libraries, patterns)
  → review-ideas (Claude: evaluate complexity, risk, existing code reuse)
  → Approach Review Gate (tabbed: Summary + Approaches)
  → [loop or converge]
converge-cluster (local: group by task/phase/module)
  → converge-promote (Claude: identify critical path, dependencies)
  → Task Review Gate (tabbed: Summary + Tasks with priority)
  → [per-task planning]:
      generate-task-plan (local: steps, code refs, estimated effort)
      → review-task-plan (Claude: validate dependencies, spot risks)
  → assemble-plan (local: combine, add dependency graph, timeline)
  → Presentation Gate (Preview + Save)
```

## Prompts — `src/agent/tasks/brainstorm/prompts/implementation.ts`

| Prompt | Focus |
|--------|-------|
| `SEED_IMPLEMENTATION_SYSTEM` | Code approaches, library options, existing code reuse opportunities |
| `DIVERGE_IMPLEMENTATION_SYSTEM` | Alternative implementations, refactor approaches, performance strategies |
| `REVIEW_IDEAS_IMPLEMENTATION_SYSTEM` | Complexity assessment, risk evaluation, code reuse potential |
| `CONVERGE_CLUSTER_IMPLEMENTATION_SYSTEM` | Group by task/phase/module, identify dependencies |
| `CONVERGE_PROMOTE_IMPLEMENTATION_SYSTEM` | Critical path, effort estimates, dependency ordering |
| `GENERATE_TASK_PLAN_SYSTEM` | Implementation steps, code references, test plan per task |
| `REVIEW_TASK_PLAN_SYSTEM` | Dependency correctness, missing steps, scope creep risk |
| `ASSEMBLE_PLAN_SYSTEM` | Combine tasks, add dependency graph, timeline estimate |

### Seed prompt key differences

```
- Focus on HOW to implement, not WHAT to build
- Reference specific files, functions, modules that need modification
- Estimate relative complexity (small/medium/large) per approach
- Consider backward compatibility and migration paths
- Note which approaches can be done incrementally vs. big-bang
```

### Claude review key differences

```
- Check: Can this approach be tested incrementally?
- Check: Does this break existing API contracts?
- Check: Is the dependency order correct?
- Check: Is the effort estimate realistic?
- Check: Are there simpler alternatives that achieve the same goal?
```

## Templates

### `implementation-spec.md`

```markdown
# Implementation Plan — {{doc_id}}

> **Goal:** <what is being implemented, one sentence>

## Executive Summary

<2–3 sentences: approach chosen, number of tasks, estimated total effort>

---

## T-001. {{theme_id}} — <Task Name>

> <task description — one sentence>

| Aspect | Detail |
|--------|--------|
| **Effort** | small / medium / large |
| **Risk** | low / medium / high |
| **Dependencies** | T-002, T-003 |
| **Files** | src/foo.ts, src/bar.ts |

### Steps

1. <step with code reference>
2. <step with code reference>

### Test Plan

- [ ] <what to test after this task>

---

## Dependency Graph

```
T-001 → T-002 → T-004
  ↓       ↓
T-003   T-005
```

## Timeline

| Phase | Tasks | Estimated Effort |
|-------|-------|-----------------|
| Foundation | T-001, T-002 | medium |
| Enhancement | T-003, T-004 | large |
| Polish | T-005 | small |

## Risks

- <risk description with mitigation>
```

### `implementation-theme.md`

```markdown
### Steps

1. <implementation step with code reference>
2. <implementation step>

### Files to Modify

- `src/path/file.ts` — <what changes>

### Test Plan

- [ ] <testable criterion>

### Notes

- <dependency or sequencing note>
```

## Controller — `src/daemon/controllers/brainstorm/implementation.ts`

```typescript
export class ImplementationBrainstormController extends BrainstormControllerBase {
  get category() { return 'implementation' as const; }

  getSeedPrompt()              { return SEED_IMPLEMENTATION_SYSTEM; }
  getDivergePrompt()           { return DIVERGE_IMPLEMENTATION_SYSTEM; }
  getReviewIdeasPrompt()       { return REVIEW_IDEAS_IMPLEMENTATION_SYSTEM; }
  getConvergeClusterPrompt()   { return CONVERGE_CLUSTER_IMPLEMENTATION_SYSTEM; }
  getConvergePromotePrompt()   { return CONVERGE_PROMOTE_IMPLEMENTATION_SYSTEM; }
  getThemeSpecPrompt()         { return GENERATE_TASK_PLAN_SYSTEM; }
  getReviewThemeSpecPrompt()   { return REVIEW_TASK_PLAN_SYSTEM; }
  getAssemblePrompt()          { return ASSEMBLE_PLAN_SYSTEM; }
  getSpecTemplate()            { return loadSpecTemplate('implementation'); }
  getThemeSpecTemplate()       { return loadThemeSpecTemplate('implementation'); }
  getDocPrefix()               { return 'IMP-DOC'; }
  getThemePrefix()             { return 'IMP-TH'; }
  getSaveDir()                 { return 'plans'; }
  getConvergenceLabel()        { return 'task'; }
  getIdeaGateTitle()           { return 'Approach Review'; }
  getConvergenceGateTitle()    { return 'Task Review'; }
}
```

## Key differences from Requirements

| Aspect | Requirements | Implementation |
|--------|-------------|----------------|
| Seed focus | User needs | Code approaches |
| Convergence | Feature area | Task/phase |
| Per-theme gen | Requirement + criteria | Steps + code refs + effort |
| Claude review | Testability | Dependencies, scope |
| IDs | REQ-DOC / REQ-TH | IMP-DOC / IMP-TH |
| Save dir | brainstorms/ | plans/ |
| Gate titles | Idea Review | Approach Review |
| Output items | R-001 requirements | T-001 tasks |
| Downstream | Designer agent | Pair/Delegate agent |

## Verification

1. "brainstorm implementation approach for X" → classified as implementation
2. Ideas focus on code strategies, not user requirements
3. Convergence groups by task, not feature
4. Per-task plans have steps, code refs, effort estimates
5. Final output has task IDs (T-001), dependency graph, timeline
6. Saves to plans/ directory
