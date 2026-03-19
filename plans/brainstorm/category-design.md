# Design Brainstorm Category — Implementation Plan

## Goal

Create `DesignBrainstormController` — a sub-controller for brainstorming architecture, API shape, component boundaries, and design tradeoffs. Output is a design document similar to the designer agent's output but produced through iterative brainstorming.

## Flow

```
generate-ideas (local: architecture options, patterns, tradeoffs)
  → review-ideas (Claude: evaluate feasibility, complexity, alignment)
  → Idea Review Gate (tabbed: Summary + Ideas)
  → [loop or converge]
converge-cluster (local: group by component/layer/concern)
  → converge-promote (Claude: identify key design decisions per component)
  → Component Review Gate (tabbed: Summary + Components with priority)
  → [per-component design]:
      generate-component-design (local: interfaces, data flow, dependencies)
      → review-component-design (Claude: validate contracts, spot coupling)
  → assemble-design (local: combine, add cross-component references)
  → Presentation Gate (Preview + Save)
```

## Files to create

### Prompts — `src/agent/tasks/brainstorm/prompts/design.ts`

```typescript
export const SEED_DESIGN_SYSTEM = `You are a software architect brainstorming design options.

Decompose the problem into architectural concerns:
- Components/modules needed
- Interface boundaries
- Data flow patterns
- Integration points
- Key tradeoffs (performance vs. simplicity, coupling vs. cohesion)

Generate 5–10 design ideas. Each idea should:
- Propose a specific architectural approach or pattern
- Reference existing code entities where relevant
- Note tradeoffs explicitly
- Include 1–2 tags for later clustering

## Output Format

First output the analysis under a ## Analysis heading (problem decomposition, constraints, existing patterns in codebase).

Then output ideas as a numbered list:
[1] Idea text — tags: tag1, tag2 — refs: entity1, entity2
[2] Another idea — tags: tag3 — refs: entity3`;

export const DIVERGE_DESIGN_SYSTEM = `You are a creative software architect exploring design alternatives.

Generate new architectural ideas by applying specific techniques.
Each idea must be DISTINCT from existing accepted ideas.

Rules:
- Propose concrete architectural approaches, not vague principles
- Reference existing code patterns, modules, and interfaces
- Note tradeoffs for each approach (what you gain vs. what you lose)
- Consider existing codebase patterns — leverage, extend, or deliberately diverge
- Tag each idea for component/layer clustering

## Output Format

For each technique applied, output a heading then ideas:

### Technique: <name>
<one-sentence provocation>

[N] Idea text — tags: tag1, tag2 — refs: entity1, entity2`;

export const REVIEW_IDEAS_DESIGN_SYSTEM = `You are reviewing architectural design proposals.

Evaluate each idea for:
1. **Feasibility**: Can this be implemented with the existing codebase?
2. **Complexity**: How much effort and risk does this introduce?
3. **Alignment**: Does this fit the existing architecture patterns?
4. **Tradeoffs**: Are the tradeoffs acceptable for the stated goals?

Output ONLY valid JSON:
{
  "summary": "<2-3 sentence assessment of the idea set>",
  "ideas": [
    {
      "index": 1,
      "title": "<concise title>",
      "description": "<1-2 sentence refined description>",
      "verdict": "strong|moderate|weak",
      "rationale": "<why this verdict>",
      "tradeoffs": "<key tradeoff noted>"
    }
  ]
}`;

export const CONVERGE_CLUSTER_DESIGN_SYSTEM = `You are organizing design ideas into architectural components.

Group the accepted ideas into component/layer clusters:
- Each cluster = one architectural component, layer, or module
- Name each cluster after the component it represents
- A cluster should contain 2–5 ideas that form a cohesive design approach
- Ideas can appear in multiple clusters if they span components

## Output Format

### Theme: <Component Name>
<one-sentence description of this component's role>
Ideas: 1, 3, 7

### Merges
- Merge idea N into idea M: <reason>`;

export const CONVERGE_PROMOTE_DESIGN_SYSTEM = `You are promoting brainstorm ideas into formal design decisions.

For each component cluster, identify:
1. The key design decision (what approach to take)
2. The interface contract (TypeScript signatures if applicable)
3. Dependencies on other components
4. Migration notes (if modifying existing code)

Output ONLY valid JSON:
{
  "promotions": [
    {
      "ideaId": "<idea hash>",
      "statement": "<formal design decision statement>",
      "type": "interface|dataflow|pattern|integration",
      "priority": "must|should|could",
      "component": "<component name>"
    }
  ],
  "merges": [
    {
      "ideaId": "<source idea hash>",
      "targetRequirementId": "<target id>",
      "note": "<merge rationale>"
    }
  ]
}`;

export const GENERATE_COMPONENT_DESIGN_SYSTEM = `You are writing a design section for one component from a brainstorming session.

You are given:
- The original problem statement
- A component name and description
- The design ideas grouped under this component
- Relevant code context

Tasks:
1. Define the component's interface (TypeScript signatures)
2. Describe the data flow (input → processing → output)
3. List integration points with other components
4. Note migration requirements (if modifying existing code)
5. Flag risks and open questions

## Output Format

### Interface Contract
\`\`\`typescript
// TypeScript interface definitions
\`\`\`

### Data Flow
1. Step description
2. Step description

### Integration Points
- Component X: description of interaction
- Component Y: description of interaction

### Migration Notes
- What existing code needs to change

### Risks
- Risk description`;

export const REVIEW_COMPONENT_DESIGN_SYSTEM = `You are reviewing a design section for one component.

Check for:
1. API consistency — do interfaces match stated behavior?
2. Coupling — is this component too tightly coupled to others?
3. Missing error handling — what happens when things fail?
4. Scalability — will this approach work at larger scale?
5. Security — any input validation or auth concerns?

Output ONLY valid JSON:
{
  "polishedSection": "<the corrected/improved markdown section>",
  "issues": ["<issue 1>", "<issue 2>"],
  "suggestions": ["<suggestion 1>"]
}`;

export const ASSEMBLE_DESIGN_SYSTEM = `You are assembling a design document from individually reviewed component sections.

Combine all sections into a single coherent document:
1. Number components sequentially (C-001, C-002, ...)
2. Add cross-references between related components
3. Write an executive summary (2–3 sentences)
4. Add a dependency diagram (text-based)
5. Ensure consistent naming and formatting
6. Do NOT add, remove, or change designs — only format and cross-reference`;
```

### Template — `src/agent/tasks/brainstorm/templates/design-spec.md`

```markdown
# Design Document — {{doc_id}}

> **Problem:** <restate the original problem in one sentence>

## Executive Summary

<2–3 sentences: what is being designed, key architectural decisions>

---

## C-001. {{theme_id}} — <Component Name>

> <component role — one sentence>

### Interface Contract

```typescript
// interfaces
```

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

```
C-001 → C-002 → C-003
  ↓
C-004
```

## Cross-References

| Component | Related To | Relationship |
|-----------|-----------|--------------|
| C-001 | C-002 | <brief explanation> |

## Open Questions

- <any architectural decisions needing stakeholder input>
```

### Template — `src/agent/tasks/brainstorm/templates/design-theme.md`

```markdown
### Interface Contract

```typescript
// TypeScript interface definitions
```

### Data Flow

1. <step description>
2. <step description>

### Integration Points

- <Component X>: <interaction description>

### Migration Notes

- <what existing code needs to change>

### Risks

- <risk>
```

### Controller — `src/daemon/controllers/brainstorm/design.ts`

```typescript
export class DesignBrainstormController extends BrainstormControllerBase {
  get category() { return 'design' as const; }

  getSeedPrompt()              { return SEED_DESIGN_SYSTEM; }
  getDivergePrompt()           { return DIVERGE_DESIGN_SYSTEM; }
  getReviewIdeasPrompt()       { return REVIEW_IDEAS_DESIGN_SYSTEM; }
  getConvergeClusterPrompt()   { return CONVERGE_CLUSTER_DESIGN_SYSTEM; }
  getConvergePromotePrompt()   { return CONVERGE_PROMOTE_DESIGN_SYSTEM; }
  getThemeSpecPrompt()         { return GENERATE_COMPONENT_DESIGN_SYSTEM; }
  getReviewThemeSpecPrompt()   { return REVIEW_COMPONENT_DESIGN_SYSTEM; }
  getAssemblePrompt()          { return ASSEMBLE_DESIGN_SYSTEM; }
  getSpecTemplate()            { return loadSpecTemplate('design'); }
  getThemeSpecTemplate()       { return loadThemeSpecTemplate('design'); }
  getDocPrefix()               { return 'DES-DOC'; }
  getThemePrefix()             { return 'DES-TH'; }
  getSaveDir()                 { return 'design'; }
  getConvergenceLabel()        { return 'component'; }
  getIdeaGateTitle()           { return 'Design Review'; }
  getConvergenceGateTitle()    { return 'Component Review'; }
}
```

### Template loader — `src/agent/tasks/brainstorm/templates.ts`

Update `loadSpecTemplate()` and `loadThemeSpecTemplate()` to accept a category parameter:

```typescript
export function loadSpecTemplate(category: BrainstormCategory = 'requirements'): string {
  const filename = `brainstorm-${category}-spec.md`;
  try {
    return readFileSync(join(PATHS.templates, filename), 'utf-8');
  } catch {
    return BUILTIN_TEMPLATES[category]?.spec ?? BRAINSTORM_SPEC_TEMPLATE;
  }
}
```

## Key differences from Requirements

| Aspect | Requirements | Design |
|--------|-------------|--------|
| Seed prompt | User needs, stakeholders | Architecture options, patterns |
| Diverge prompt | Constraints, user stories | Tradeoffs, alternatives |
| Convergence | By feature area | By component/layer |
| Per-theme gen | Requirement table + acceptance criteria | Interface contract + data flow |
| Claude review | Testability, completeness | API consistency, coupling |
| ID prefix | REQ-DOC / REQ-TH | DES-DOC / DES-TH |
| Save dir | brainstorms/ | design/ |
| Gate titles | "Idea Review" / "Convergence Review" | "Design Review" / "Component Review" |
| Output structure | Requirement IDs (R-001) | Component IDs (C-001) |

## Verification

1. Type check passes
2. "brainstorm architecture for X" → classified as design category
3. Seed ideas focus on architectural approaches, not user requirements
4. Convergence clusters by component, not by feature area
5. Per-component design sections have interface contracts and data flow
6. Final output has component IDs (C-001), dependency diagram, cross-references
7. Saves to design/ directory
