/**
 * ImplementationBrainstormController -- brainstorm for coding approaches.
 *
 * Produces an implementation plan (IMP-DOC) with task cards (T-001...),
 * dependency graph, timeline, and risk notes. Saves to plans/ so it
 * flows naturally into pair/delegate agents for execution.
 */

import { BrainstormControllerBase } from './base.js';
import type { BrainstormCategory } from './types.js';

import {
  SEED_IMPLEMENTATION_SYSTEM, DIVERGE_IMPLEMENTATION_SYSTEM,
  REVIEW_IDEAS_IMPLEMENTATION_SYSTEM,
  CONVERGE_CLUSTER_IMPLEMENTATION_SYSTEM, CONVERGE_PROMOTE_IMPLEMENTATION_SYSTEM,
  REVIEW_TASK_PLAN_SYSTEM,
  buildGenerateTaskPlanSystem, buildAssemblePlanSystem,
} from '../../../agent/tasks/brainstorm/prompts/implementation.js';
import {
  registerSpecTemplate, registerThemeSpecTemplate,
} from '../../../agent/tasks/brainstorm/templates.js';

const IMPLEMENTATION_SPEC_TEMPLATE = `# Implementation Plan -- {{doc_id}}

> **Goal:** <what is being implemented, one sentence>

## Executive Summary

<2-3 sentences: approach chosen, number of tasks, estimated total effort>

---

## T-001. <Task Name>

> <task description -- one sentence>

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

\`\`\`
T-001 -> T-002 -> T-004
  |       |
  v       v
T-003   T-005
\`\`\`

## Timeline

| Phase | Tasks | Estimated Effort |
|-------|-------|-----------------|
| Foundation | T-001, T-002 | medium |
| Enhancement | T-003, T-004 | large |
| Polish | T-005 | small |

## Risks

- <risk description with mitigation>
`;

const IMPLEMENTATION_THEME_TEMPLATE = `### Steps

1. <implementation step with code reference>
2. <implementation step>

### Files to Modify

- \`src/path/file.ts\` -- <what changes>

### Test Plan

- [ ] <testable criterion>

### Notes

- <dependency or sequencing note>
`;

registerSpecTemplate('implementation', IMPLEMENTATION_SPEC_TEMPLATE);
registerThemeSpecTemplate('implementation', IMPLEMENTATION_THEME_TEMPLATE);

export class ImplementationBrainstormController extends BrainstormControllerBase {
  get category(): BrainstormCategory { return 'implementation'; }

  getSeedPrompt(): string              { return SEED_IMPLEMENTATION_SYSTEM; }
  getDivergePrompt(): string           { return DIVERGE_IMPLEMENTATION_SYSTEM; }
  getReviewIdeasPrompt(): string       { return REVIEW_IDEAS_IMPLEMENTATION_SYSTEM; }
  getConvergeClusterPrompt(): string   { return CONVERGE_CLUSTER_IMPLEMENTATION_SYSTEM; }
  getConvergePromotePrompt(): string   { return CONVERGE_PROMOTE_IMPLEMENTATION_SYSTEM; }
  getThemeSpecPrompt(): string         { return buildGenerateTaskPlanSystem(); }
  getReviewThemeSpecPrompt(): string   { return REVIEW_TASK_PLAN_SYSTEM; }
  getAssemblePrompt(): string          { return buildAssemblePlanSystem(); }
  getDocPrefix(): string               { return 'IMP-DOC'; }
  getThemePrefix(): string             { return 'IMP-TH'; }
  getSaveDir(): string                 { return 'plans'; }
  getConvergenceLabel(): string        { return 'task'; }
  getIdeaGateTitle(): string           { return 'Approach Review'; }
  getConvergenceGateTitle(): string    { return 'Task Review'; }
}
