/**
 * GeneralBrainstormController -- default open-ended brainstorm.
 *
 * Produces a narrative summary document with themes, key ideas, and
 * action items. Skips per-theme spec generation (base.skipPerThemeSpec
 * returns true), so after convergence the pipeline goes straight to
 * assembly.
 */

import { BrainstormControllerBase } from './base.js';
import type { BrainstormCategory } from './types.js';

import {
  SEED_GENERAL_SYSTEM, DIVERGE_GENERAL_SYSTEM,
  REVIEW_IDEAS_GENERAL_SYSTEM,
  CONVERGE_CLUSTER_GENERAL_SYSTEM, CONVERGE_PROMOTE_GENERAL_SYSTEM,
  ASSEMBLE_SUMMARY_SYSTEM,
} from '../../../agent/tasks/brainstorm/prompts/general.js';
import { registerSpecTemplate } from '../../../agent/tasks/brainstorm/templates.js';

const GENERAL_SPEC_TEMPLATE = `# Brainstorm Summary -- {{doc_id}}

> **Topic:** <original prompt in one sentence>

## Executive Summary

<3-5 sentences: what was explored, what emerged, recommended direction>

---

## Themes

### <Theme Name>

> <theme description -- one sentence>

**Key Ideas:**
- <idea 1 -- one sentence>
- <idea 2 -- one sentence>

**Action Items:**
- [ ] <concrete next step>
- [ ] <concrete next step>

---

## Recommended Next Steps

1. <highest priority action>
2. <second priority action>
3. <third priority action>

## Open Questions

- <any question that emerged during brainstorming>

## Session Stats

- **Rounds:** {{rounds}}
- **Ideas generated:** {{idea_count}}
- **Themes identified:** {{theme_count}}
`;

registerSpecTemplate('general', GENERAL_SPEC_TEMPLATE);

export class GeneralBrainstormController extends BrainstormControllerBase {
  get category(): BrainstormCategory { return 'general'; }

  getSeedPrompt(): string              { return SEED_GENERAL_SYSTEM; }
  getDivergePrompt(): string           { return DIVERGE_GENERAL_SYSTEM; }
  getReviewIdeasPrompt(): string       { return REVIEW_IDEAS_GENERAL_SYSTEM; }
  getConvergeClusterPrompt(): string   { return CONVERGE_CLUSTER_GENERAL_SYSTEM; }
  getConvergePromotePrompt(): string   { return CONVERGE_PROMOTE_GENERAL_SYSTEM; }
  getThemeSpecPrompt(): string         { return ''; }  // skipped
  getReviewThemeSpecPrompt(): string   { return ''; }  // skipped
  getAssemblePrompt(): string          { return ASSEMBLE_SUMMARY_SYSTEM; }
  getDocPrefix(): string               { return 'BST-DOC'; }
  getThemePrefix(): string             { return 'BST-TH'; }
  getSaveDir(): string                 { return 'brainstorms'; }
  getConvergenceLabel(): string        { return 'theme'; }
  getIdeaGateTitle(): string           { return 'Idea Review'; }
  getConvergenceGateTitle(): string    { return 'Theme Review'; }

  /** Skip per-theme spec -- assembly produces a narrative summary directly. */
  protected override skipPerThemeSpec(): boolean { return true; }
}
