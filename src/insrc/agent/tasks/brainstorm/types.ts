/**
 * Types for the brainstorm agent — idea exploration with incremental
 * requirements spec building.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Input from the REPL to start a brainstorming session. */
export interface BrainstormInput {
  message: string;
  codeContext: string;
  existingSpec?: string | undefined;
  session: {
    repoPath: string;
    closureRepos: string[];
  };
  /** Classification result from intent classifier. */
  classification?: { intent: string; confidence: number; keywords?: string[] | undefined } | undefined;
}

// ---------------------------------------------------------------------------
// Ideas
// ---------------------------------------------------------------------------

export type IdeaStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'parked'
  | 'skipped'
  | 'refining'
  | 'promoted'
  | 'merged';

export type IdeaSource = 'seed' | 'diverge' | 'user' | 'refine';

/** A structured reference attached to an idea. */
export interface IdeaRef {
  type: 'code' | 'doc' | 'url';
  path: string;
  label: string;
  line?: number | undefined;
  snippet?: string | undefined;
}

/** A single idea in the brainstorming pool. */
export interface Idea {
  id: string;
  index: number;
  /** Short descriptive title (1 line). */
  title: string;
  /** Detailed description (markdown). */
  body: string;
  /** Structured code/doc references. */
  references: IdeaRef[];
  status: IdeaStatus;
  source: IdeaSource;
  round: number;
  parentId?: string | undefined;
  promotedTo?: string | undefined;
  mergedInto?: string | undefined;
  tags: string[];
  rationale?: string | undefined;
  // Claude review annotations (populated by review step)
  reviewTitle?: string | undefined;
  reviewDescription?: string | undefined;
  reviewVerdict?: 'strong' | 'moderate' | 'weak' | 'user' | undefined;
  reviewRationale?: string | undefined;
  /** User comment left during idea review gate. */
  userComment?: string | undefined;
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/** A theme grouping related ideas. */
export interface Theme {
  id: string;
  /** Unique theme ID: REQ-TH-<8-digit hash>. */
  themeId?: string | undefined;
  name: string;
  description: string;
  ideaIds: string[];
  requirementIds: string[];
  /** User comment left during convergence review. */
  userComment?: string | undefined;
  /** User-assigned priority. */
  priority?: 'low' | 'medium' | 'high' | undefined;
}

// ---------------------------------------------------------------------------
// Requirements spec
// ---------------------------------------------------------------------------

export type RequirementType = 'functional' | 'non-functional' | 'constraint';
export type RequirementPriority = 'must' | 'should' | 'could';

/** A requirement in the live spec. */
export interface SpecRequirement {
  id: string;
  index: number;
  statement: string;
  type: RequirementType;
  priority: RequirementPriority;
  themeId: string;
  acceptanceCriteria: string[];
  rationale: string;
  sourceIdeaIds: string[];
  codeRefs: string[];
  revision: number;
  addedInRound: number;
}

/** Revision log entry. */
export interface SpecRevision {
  round: number;
  requirementId: string;
  action: 'added' | 'modified' | 'removed' | 'merged';
  detail: string;
}

// ---------------------------------------------------------------------------
// Provider override (@-mention) — re-exported from shared framework
// ---------------------------------------------------------------------------

export type { ProviderOverride } from '../../framework/provider-mention.js';

// ---------------------------------------------------------------------------
// Promotion / merge proposals (used between converge and update-spec)
// ---------------------------------------------------------------------------

/** A proposal to promote an idea into a formal requirement. */
export interface PromotionProposal {
  ideaId: string;
  statement: string;
  type: RequirementType;
  priority: RequirementPriority;
  acceptanceCriteria: string[];
  rationale: string;
  themeId: string;
}

/** A proposal to merge an idea into an existing requirement. */
export interface MergeProposal {
  ideaId: string;
  targetRequirementId: string;
  additionalCriteria: string[];
  note: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Final output of the brainstorm agent. */
export interface BrainstormResult {
  kind: 'brainstorm-spec';
  output: string;
  requirements: SpecRequirement[];
  themes: Theme[];
  ideas: Idea[];
  revisions: SpecRevision[];
  summary: string;
  stats: {
    rounds: number;
    totalIdeas: number;
    promoted: number;
    merged: number;
    rejected: number;
    parked: number;
  };
}
