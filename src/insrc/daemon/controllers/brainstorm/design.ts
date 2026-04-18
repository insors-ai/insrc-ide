/**
 * DesignBrainstormController -- brainstorm for architecture & API design.
 *
 * Produces a design document (DES-DOC) with component-level interface
 * contracts, data flow, integration points, migration notes, and risks.
 * Convergence groups ideas by component/layer rather than feature area.
 */

import { BrainstormControllerBase } from './base.js';
import type { BrainstormCategory } from './types.js';

import {
  SEED_DESIGN_SYSTEM, DIVERGE_DESIGN_SYSTEM,
  REVIEW_IDEAS_DESIGN_SYSTEM,
  CONVERGE_CLUSTER_DESIGN_SYSTEM, CONVERGE_PROMOTE_DESIGN_SYSTEM,
  REVIEW_COMPONENT_DESIGN_SYSTEM,
  buildGenerateComponentDesignSystem, buildAssembleDesignSystem,
} from '../../../agent/tasks/brainstorm/prompts/design.js';
import {
  registerSpecTemplate, registerThemeSpecTemplate,
} from '../../../agent/tasks/brainstorm/templates.js';

const DESIGN_SPEC_TEMPLATE = `# Design Document -- {{doc_id}}

> **Problem:** <restate the original problem in one sentence>

## Executive Summary

<2-3 sentences: what is being designed, key architectural decisions>

---

## C-001. <Component Name>

> <component role -- one sentence>

### Interface Contract

\`\`\`typescript
// interfaces
\`\`\`

### Data Flow

1. <step>
2. <step>

### Integration Points

| Depends On | Interaction | Protocol |
|-----------|-------------|----------|
| C-002 | <description> | <sync/async/event> |

### Migration Notes

- <what changes in existing code>

### Risks

- <risk description>

---

## Dependency Diagram

\`\`\`
C-001 -> C-002 -> C-003
  |
  v
C-004
\`\`\`

## Cross-References

| Component | Related To | Relationship |
|-----------|-----------|--------------|
| C-001 | C-002 | <brief explanation> |

## Open Questions

- <any architectural decisions needing stakeholder input>
`;

const DESIGN_THEME_TEMPLATE = `### Interface Contract

\`\`\`typescript
// TypeScript interface definitions
\`\`\`

### Data Flow

1. <step description>
2. <step description>

### Integration Points

- <Component X>: <interaction description>

### Migration Notes

- <what existing code needs to change>

### Risks

- <risk>
`;

registerSpecTemplate('design', DESIGN_SPEC_TEMPLATE);
registerThemeSpecTemplate('design', DESIGN_THEME_TEMPLATE);

export class DesignBrainstormController extends BrainstormControllerBase {
  get category(): BrainstormCategory { return 'design'; }

  getSeedPrompt(): string              { return SEED_DESIGN_SYSTEM; }
  getDivergePrompt(): string           { return DIVERGE_DESIGN_SYSTEM; }
  getReviewIdeasPrompt(): string       { return REVIEW_IDEAS_DESIGN_SYSTEM; }
  getConvergeClusterPrompt(): string   { return CONVERGE_CLUSTER_DESIGN_SYSTEM; }
  getConvergePromotePrompt(): string   { return CONVERGE_PROMOTE_DESIGN_SYSTEM; }
  getThemeSpecPrompt(): string         { return buildGenerateComponentDesignSystem(); }
  getReviewThemeSpecPrompt(): string   { return REVIEW_COMPONENT_DESIGN_SYSTEM; }
  getAssemblePrompt(): string          { return buildAssembleDesignSystem(); }
  getDocPrefix(): string               { return 'DES-DOC'; }
  getThemePrefix(): string             { return 'DES-TH'; }
  getSaveDir(): string                 { return 'design'; }
  getConvergenceLabel(): string        { return 'component'; }
  getIdeaGateTitle(): string           { return 'Design Review'; }
  getConvergenceGateTitle(): string    { return 'Component Review'; }
}
