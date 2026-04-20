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

/**
 * Lookup from entity name (as emitted by LLMs in "refs: entityA, entityB") to
 * a concrete file location. Built from daemon search results; used to resolve
 * LLM-hallucinated entity names into clickable references. Refs whose name is
 * not in this index are dropped rather than rendered as broken links.
 */
export type EntityIndex = Record<string, { path: string; line?: number }>;

/**
 * Template reason used when the user rejects an idea without typing any
 * feedback. Present in the idea's feedback[] array with templated=true so
 * the LLM (and future UI) can tell a default-template rejection from one
 * that carries a real reason.
 */
export const REJECT_FEEDBACK_TEMPLATE = 'Rejected without a stated reason.';

/** A single piece of user feedback left on an idea during review. */
export interface IdeaFeedback {
  /** Which user action produced this feedback. Only reject / diverge /
   *  discuss record feedback -- approve / park / skip never do. */
  action: 'reject' | 'diverge' | 'discuss';
  /** User-supplied reason, or the template string when user gave none. */
  reason: string;
  /** True when `reason` is the default template. Only ever set for the
   *  reject action with empty user input. */
  templated: boolean;
  /** Round this feedback was given in. */
  round: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
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
  /** Feedback entries captured this round. Reset at the start of each new
   *  ideation round; historical feedback remains in state.qna for audit.
   *  Optional for backwards-compat with older checkpoints that predate the
   *  field -- readers should treat a missing array as []. */
  feedback?: IdeaFeedback[] | undefined;
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
