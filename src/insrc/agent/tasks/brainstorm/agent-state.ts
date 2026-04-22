/**
 * BrainstormState — serializable agent state for the brainstorm pipeline.
 *
 * Tracks ideas, themes, and a live requirements spec that builds
 * incrementally across diverge/converge rounds.
 */

import type { AgentState } from '../../framework/types.js';
import type {
  Idea, Theme, SpecRequirement, SpecRevision,
  ProviderOverride, PromotionProposal, MergeProposal,
  EntityIndex,
} from './types.js';

// ---------------------------------------------------------------------------
// QnA tracking
// ---------------------------------------------------------------------------

/** A semantic question-answer exchange in the brainstorm session. */
export interface BrainstormQnA {
  /** Which step produced this exchange. */
  step: string;
  /** Round number when this occurred. */
  round: number;
  /** Who initiated — 'user' if user asked/directed, 'system' if system presented for review. */
  source: 'user' | 'system';
  /** The question or content shown. */
  question: string;
  /** The response or action taken. */
  answer: string;
  /** ISO timestamp. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Brainstorm agent state
// ---------------------------------------------------------------------------

export interface BrainstormState extends AgentState {
  input: {
    message:       string;
    codeContext:    string;
    existingSpec?: string | undefined;
    repoPath:      string;
    closureRepos:  string[];
    /** Classification result from intent classifier. */
    classification?: { intent: string; confidence: number; keywords?: string[] | undefined } | undefined;
  };

  /** Unique document ID: REQ-DOC-<8-digit hash>. */
  docId:     string;
  /** Author name from git config or OS user. */
  author?:   string | undefined;

  // Session tracking
  /** Current diverge/converge cycle (1-based). */
  round:     number;
  /** Current thinking mode. */
  mode:      'diverge' | 'converge';
  /** Max rounds before forced finalization (default: 5). */
  maxRounds: number;

  // Idea pool
  ideas:          Idea[];
  nextIdeaIndex:  number;

  // Themes (populated after first converge)
  themes: Theme[];

  // Live requirements spec
  requirements:  SpecRequirement[];
  nextReqIndex:  number;
  revisions:     SpecRevision[];

  // Pending proposals from converge step (consumed by update-spec)
  pendingPromotions: PromotionProposal[];
  pendingMerges:     MergeProposal[];

  // Context management
  /** Daemon search results from seed phase. */
  codebaseFindings:  string;
  /**
   * Entity-name → file location lookup built from daemon search results. Used
   * by parseIdeaList to resolve LLM-emitted ref names into clickable file
   * references. Optional — legacy states may not have it, in which case refs
   * are dropped until the next seed/diverge populates it.
   */
  entityIndex?:      EntityIndex | undefined;
  /** Compressed summaries of prior rounds. */
  compressedHistory: string;
  /** Initial problem decomposition from seed phase. */
  seedAnalysis:      string;
  /** Config context loaded from conventions/feedback/templates (loaded once in seed). */
  configContext?:    string | undefined;
  /** Last user direction from gate feedback. */
  recentFeedback?:   string | undefined;

  // Provider override (@-mention)
  providerOverride?: ProviderOverride | undefined;

  // Edit tracking
  /** Edit round counters, keyed by stage tag (e.g. 'seed', 'diverge-2', 'spec-1'). */
  editRounds: Record<string, number>;

  // Flags
  /** Whether the user chose 'continue' at the last review-spec gate. */
  userRequestedContinue: boolean;

  // Flow tracking
  /** Current step name for controller flow decisions. */
  lastStep: string;
  /**
   * Sub-category of the session (design / requirements / implementation
   * / testing / general). Snapshotted here in `buildInitialTasks` so
   * Phase 2 resume can pick the right brainstorm subclass from the
   * checkpoint without having to reclassify the user's original message.
   */
  category?: string | undefined;
  /**
   * Phase 2 resume (Item 7). When the session was killed mid-LLM-step
   * and we emit the resume-confirm gate, `lastStep` becomes
   * 'resume-confirm' so dispatch routes replies to `afterResumeConfirm`.
   * We stash the original in-flight step here so `retry` can rebuild
   * the right task. Cleared when retry runs or abandon is picked.
   */
  resumingFromStep?: string | undefined;

  // QnA tracking
  /** Semantic QnA pairs — tracks all user interactions across the session. */
  qna: BrainstormQnA[];

  // Claude review results
  /** Summary from Claude's idea review (seed/diverge). */
  reviewSummary?:      string | undefined;
  /** Summary from Claude's spec review. */
  specReviewSummary?:  string | undefined;
  /** Polished spec markdown from Claude's spec review. */
  polishedSpec?:       string | undefined;

  // Per-theme spec generation (Phase 4)
  /** Queue of theme indices remaining to generate spec sections for. */
  specThemeQueue?: number[] | undefined;
  /** Accumulated spec sections, one per theme. */
  specSections?: Array<{ themeIndex: number; themeName: string; themeId?: string | undefined; content: string; reviewed: boolean }> | undefined;
  /** Index of the theme currently being processed for spec generation. */
  currentThemeIndex?: number | undefined;

  /** Fresh code context from per-theme vector search (set before each theme spec generation). */
  themeSearchContext?: string | undefined;

  /**
   * Claude's most recent theme-spec review output, preserved for the
   * local-LLM refine pass (Phase 4.5). Mirrors the ideation pattern
   * `local generate -> Claude review -> local refine`. Set by
   * `afterReviewThemeSpec`, consumed by `buildRefineThemeSpecTask`,
   * cleared by `afterRefineThemeSpec`.
   */
  lastThemeReview?: {
    polishedSection: string;
    issues: string[];
    suggestions: string[];
  } | undefined;

  // Sequential idea review (one-at-a-time card flow)
  /** Ordered list of idea IDs to review in current round. */
  reviewQueue: string[];
  /** Index into reviewQueue for current idea being reviewed. */
  currentReviewIndex: number;
  /** Idea IDs that were parked (review after all others). */
  parkedIds: string[];
  /** Whether we are in sequential review mode. */
  sequentialReview: boolean;

  // Per-idea discussion
  /** ID of the idea currently being discussed (null = showing idea list). */
  focusedIdeaId?: string | undefined;
  /** Code context retrieved for the focused idea. */
  focusedIdeaContext?: string | undefined;
  /** Messages exchanged in the current discussion. */
  discussionMessages?: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }> | undefined;

  // Output
  assembledOutput?: string | undefined;
  summary?:         string | undefined;
  /** Count of unique requirements (R-NNN) in assembled output. */
  requirementCount?: number | undefined;

  /**
   * Transient warning surfaced on the next gate (e.g. LLM returned 0
   * usable ideas on diverge). Consumed and cleared by the next
   * buildSingleIdeaGate / buildIdeaListGate.
   */
  pendingWarning?: string | undefined;

  /**
   * Filesystem path written by the presentation-save step. Stashed so
   * the post-save handoff-proposal gate (Item 53) can reference it in
   * the prompt it suggests for the downstream agent.
   */
  savedArtifactPath?: string | undefined;
}
