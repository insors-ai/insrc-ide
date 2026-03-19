# General Brainstorm Category — Implementation Plan

## Goal

Create `GeneralBrainstormController` — the default sub-controller for open-ended brainstorming when no specific category is detected. Produces a summary document with themes, key ideas, action items, and next steps.

## Flow

```
generate-ideas (local: broad exploration, no constraints)
  → review-ideas (Claude: assess novelty, feasibility, alignment)
  → Idea Review Gate (tabbed: Summary + Ideas)
  → [loop or converge]
converge-cluster (local: affinity grouping)
  → converge-promote (Claude: identify actionable items)
  → Theme Review Gate (tabbed: Summary + Themes)
  → assemble-summary (local: narrative summary + action items)
  → Presentation Gate (Preview + Save)
```

**Note:** General category has a **simpler flow** — no per-theme spec generation step. After convergence review, it goes straight to assembly. The assembly produces a narrative summary rather than a structured specification.

## Prompts — `src/agent/tasks/brainstorm/prompts/general.ts`

| Prompt | Focus |
|--------|-------|
| `SEED_GENERAL_SYSTEM` | Open exploration, "what if" scenarios, lateral thinking |
| `DIVERGE_GENERAL_SYSTEM` | Creative techniques, analogy transfer, constraint removal |
| `REVIEW_IDEAS_GENERAL_SYSTEM` | Novelty assessment, feasibility check, alignment with goals |
| `CONVERGE_CLUSTER_GENERAL_SYSTEM` | Affinity grouping — ideas that share a common thread |
| `CONVERGE_PROMOTE_GENERAL_SYSTEM` | Identify top actionable items per theme |
| `ASSEMBLE_SUMMARY_SYSTEM` | Narrative summary, action items, recommended next steps |

### Seed prompt key differences

```
- No structural constraints — encourage creative thinking
- "What if" scenarios welcome
- Don't require code references (but include when relevant)
- Broader tag vocabulary (not limited to code concerns)
- Encourage cross-domain thinking
```

### Claude review key differences

```
- Focus on novelty: is this idea genuinely new or restating the obvious?
- Feasibility: could this actually work, given constraints?
- Alignment: does this serve the stated goal, or is it tangential?
- DO NOT filter for testability or technical correctness
- Encourage ambitious ideas — weak verdicts should be rare
```

## Templates

### `general-spec.md`

```markdown
# Brainstorm Summary — {{doc_id}}

> **Topic:** <original prompt, one sentence>

## Executive Summary

<3–5 sentence narrative: what was explored, key insights, recommended direction>

---

## Themes

### {{theme_id}} — <Theme Name>

> <theme description>

**Key Ideas:**
- <idea 1 — one sentence>
- <idea 2 — one sentence>

**Action Items:**
- [ ] <concrete next step>
- [ ] <concrete next step>

---

## Recommended Next Steps

1. <highest priority action>
2. <second priority action>
3. <third priority action>

## Open Questions

- <question that emerged during brainstorming>

## Session Stats

- **Rounds:** <N>
- **Ideas generated:** <N>
- **Themes identified:** <N>
- **Action items:** <N>
```

### `general-theme.md`

Not used — general category skips per-theme spec generation. Assembly works directly from themes + ideas.

## Controller — `src/daemon/controllers/brainstorm/general.ts`

```typescript
export class GeneralBrainstormController extends BrainstormControllerBase {
  get category() { return 'general' as const; }

  getSeedPrompt()              { return SEED_GENERAL_SYSTEM; }
  getDivergePrompt()           { return DIVERGE_GENERAL_SYSTEM; }
  getReviewIdeasPrompt()       { return REVIEW_IDEAS_GENERAL_SYSTEM; }
  getConvergeClusterPrompt()   { return CONVERGE_CLUSTER_GENERAL_SYSTEM; }
  getConvergePromotePrompt()   { return CONVERGE_PROMOTE_GENERAL_SYSTEM; }
  getThemeSpecPrompt()         { return ''; }  // Not used — general skips per-theme spec
  getReviewThemeSpecPrompt()   { return ''; }  // Not used
  getAssemblePrompt()          { return ASSEMBLE_SUMMARY_SYSTEM; }
  getSpecTemplate()            { return loadSpecTemplate('general'); }
  getThemeSpecTemplate()       { return ''; }  // Not used
  getDocPrefix()               { return 'BST-DOC'; }
  getThemePrefix()             { return 'BST-TH'; }
  getSaveDir()                 { return 'brainstorms'; }
  getConvergenceLabel()        { return 'theme'; }
  getIdeaGateTitle()           { return 'Idea Review'; }
  getConvergenceGateTitle()    { return 'Theme Review'; }

  // Override: skip per-theme spec generation, go straight to assembly
  protected skipPerThemeSpec(): boolean { return true; }
}
```

### Base class hook for skipping per-theme spec

Add to `BrainstormControllerBase`:

```typescript
/** Override to skip per-theme spec generation (general category). */
protected skipPerThemeSpec(): boolean { return false; }
```

In `afterValidateConvergence()`, when approved:

```typescript
if (this.skipPerThemeSpec()) {
  // Go straight to assembly
  this.state.lastStep = 'assemble-spec';
  return [this.buildAssembleSpecTask()];
}
// Normal: start per-theme spec generation
this.state.specThemeQueue = this.state.themes.map((_, idx) => idx);
return this.nextThemeSpec();
```

## Key differences

| Aspect | Requirements | General |
|--------|-------------|---------|
| Seed focus | User needs, constraints | Open exploration, "what if" |
| Convergence | Feature area | Affinity grouping |
| Per-theme spec | Yes (requirement tables) | **No** (skipped) |
| Assembly | Formal spec with IDs | Narrative summary + action items |
| Claude review | Testability | Novelty, feasibility |
| IDs | REQ-DOC / REQ-TH | BST-DOC / BST-TH |
| Save dir | brainstorms/ | brainstorms/ |
| Output tone | Formal, structured | Conversational, actionable |
| Downstream | Designer agent | Any agent (or none) |

## Verification

1. "brainstorm ideas for improving X" → classified as general (default)
2. Ideas are open-ended, not constrained to requirements format
3. Convergence groups by affinity, not feature
4. Per-theme spec is skipped — goes straight to assembly
5. Final output is narrative with action items, not formal spec
6. Saves to brainstorms/ directory
