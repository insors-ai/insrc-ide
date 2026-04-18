/**
 * RequirementsBrainstormController — brainstorm sub-controller for requirements.
 *
 * This is the current default brainstorm behavior, extracted from the
 * monolithic BrainstormController. Produces a requirements specification
 * (REQ-DOC) with numbered requirements, acceptance criteria, and
 * traceability to source ideas.
 */

import { BrainstormControllerBase } from './base.js';
import type { BrainstormCategory } from './types.js';

import {
  SEED_SYSTEM, DIVERGE_SYSTEM,
  CONVERGE_CLUSTER_SYSTEM, CONVERGE_PROMOTE_SYSTEM,
  buildGenerateThemeSpecSystem, buildAssembleSpecSystem,
  REVIEW_IDEAS_SYSTEM, REVIEW_SPEC_SYSTEM,
} from '../../../agent/tasks/brainstorm/prompts.js';

export class RequirementsBrainstormController extends BrainstormControllerBase {
  get category(): BrainstormCategory { return 'requirements'; }

  getSeedPrompt(): string              { return SEED_SYSTEM; }
  getDivergePrompt(): string           { return DIVERGE_SYSTEM; }
  getReviewIdeasPrompt(): string       { return REVIEW_IDEAS_SYSTEM; }
  getConvergeClusterPrompt(): string   { return CONVERGE_CLUSTER_SYSTEM; }
  getConvergePromotePrompt(): string   { return CONVERGE_PROMOTE_SYSTEM; }
  getThemeSpecPrompt(): string         { return buildGenerateThemeSpecSystem('requirements'); }
  getReviewThemeSpecPrompt(): string   { return REVIEW_SPEC_SYSTEM; }
  getAssemblePrompt(): string          { return buildAssembleSpecSystem('requirements'); }
  getDocPrefix(): string               { return 'REQ-DOC'; }
  getThemePrefix(): string             { return 'REQ-TH'; }
  getSaveDir(): string                 { return 'brainstorms'; }
  getConvergenceLabel(): string        { return 'feature area'; }
  getIdeaGateTitle(): string           { return 'Idea Review'; }
  getConvergenceGateTitle(): string    { return 'Convergence Review'; }
}
