/**
 * BrainstormControllerBase — Abstract base for brainstorm agent sub-controllers.
 *
 * Uses typed BrainstormState internally for rich state management.
 * Each step emits Task objects with proper userMessage/systemPrompt;
 * the task pipeline executor + ContextManager handle LLM calls and
 * memory (L1-L5 context assembly).
 *
 * Flow:
 *   generate-ideas (llm: seed on round 1, diverge on round 2+)
 *   → review-ideas (llm: Claude)
 *   → idea-review (gate: approve/reframe/focus/converge)
 *   → [loop back to generate-ideas OR converge]:
 *       converge-cluster (llm: local)
 *       → converge-promote (llm: claude)
 *       → validate-convergence (gate: approve/edit/diverge)
 *       → [per-theme spec generation]:
 *           generate-theme-spec (llm: local, one theme at a time)
 *           → review-theme-spec (llm: claude)
 *           → [loop for remaining themes]
 *       → assemble-spec (llm: local, combine all sections)
 *       → finalize (transform: render HTML)
 *       → presentation (gate: save/dismiss)
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

import type {
  TaskController, ControllerInput, GateReply, FinalizeResult,
  Task, TaskResult, TaskStateStore, TaskFormat, GateTab, GateTabItem,
} from '../../task.js';
import type { BrainstormState } from '../../../agent/tasks/brainstorm/agent-state.js';
import type { EntityIndex, Idea, IdeaFeedback, IdeaSource } from '../../../agent/tasks/brainstorm/types.js';
import { REJECT_FEEDBACK_TEMPLATE } from '../../../agent/tasks/brainstorm/types.js';

// Category types
import type { BrainstormCategory } from './types.js';

// Parsing & formatting
import { parseSeedOutput, parseIdeaList, selectTechniques } from '../../../agent/tasks/brainstorm/ideas.js';
import { parseClusterOutput, parsePromotionOutput, identifyGaps } from '../../../agent/tasks/brainstorm/convergence.js';
import { renderSpecMarkdown } from '../../../agent/tasks/brainstorm/spec-builder.js';
import { formatIdeasForContext, formatThemesForContext } from '../../../agent/tasks/brainstorm/context-builder.js';
import { assembleDocument } from '../../../agent/tasks/brainstorm/assembly.js';
import { defaultSavePath, saveArtifact } from '../../../agent/tasks/shared/artifact-save.js';
import {
  REFINE_IDEAS_SYSTEM, ENHANCE_IDEAS_SYSTEM,
  DISCUSS_RESPOND_SYSTEM, DISCUSS_REFINE_SYSTEM,
} from '../../../agent/tasks/brainstorm/prompts.js';
import { getLogger } from '../../../shared/logger.js';

const log = getLogger('brainstorm-controller');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EDIT_ROUNDS = 3;
const MAX_ROUNDS = 5;
const AUTO_CONVERGE_THRESHOLD = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recordQnA(
  state: BrainstormState,
  step: string,
  source: 'user' | 'system',
  question: string,
  answer: string,
): void {
  state.qna.push({
    step,
    round: state.round,
    source,
    question: question.slice(0, 500),
    answer: answer.slice(0, 500),
    timestamp: new Date().toISOString(),
  });
}

/** Build a QnA context section from recent exchanges for inclusion in userMessage. */
function buildQnAContext(state: BrainstormState, maxEntries = 5): string {
  if (state.qna.length === 0) return '';

  const recent = state.qna.slice(-maxEntries);
  const lines = recent.map(q =>
    `[${q.step} r${q.round}] ${q.source === 'user' ? 'User' : 'System'}: ${q.question}\n→ ${q.answer}`,
  );
  return `## Session History\n${lines.join('\n\n')}`;
}

/** Resolve author name from git config, falling back to OS username. */
function getAuthor(): string {
  try {
    const gitUser = execSync('git config user.name', { encoding: 'utf-8', timeout: 2000 }).trim();
    if (gitUser) return gitUser;
  } catch { /* no git config */ }
  return os.userInfo().username || 'unknown';
}

/** Strip markdown code fences (```json ... ```) that LLMs often wrap around JSON. */
function stripFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned;
}

/** Safely extract a string summary from possibly-JSON content. */
function safeStringifySummary(raw: string): string {
  try {
    const parsed = JSON.parse(stripFences(raw));
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed.summary ?? JSON.stringify(parsed, null, 2);
    }
    return String(parsed);
  } catch {
    return raw;
  }
}

/** Initialize BrainstormState from ControllerInput. */
function initState(input: ControllerInput, docPrefix: string): BrainstormState {
  return {
    input: {
      message: input.message,
      codeContext: input.codeContext,
      // Pull from the live session when available -- matters for Phase 2
      // resume (Item 7), which keys the fallback DB-miss path on this
      // field. The previous hardcoded empty string meant every
      // checkpointed brainstorm session was unrecoverable after a cold
      // daemon restart.
      repoPath: input.session?.repoPath ?? '',
      closureRepos: input.session?.closureRepos ?? [],
      classification: input.classification,
    },
    docId: `${docPrefix}-${randomBytes(4).toString('hex')}`,
    author: getAuthor(),
    round: 1,
    mode: 'diverge',
    maxRounds: MAX_ROUNDS,
    ideas: [],
    nextIdeaIndex: 1,
    themes: [],
    requirements: [],
    nextReqIndex: 1,
    revisions: [],
    pendingPromotions: [],
    pendingMerges: [],
    codebaseFindings: '',
    compressedHistory: '',
    seedAnalysis: '',
    editRounds: {},
    userRequestedContinue: false,
    lastStep: 'generate-ideas',
    qna: [],
    reviewQueue: [],
    currentReviewIndex: 0,
    parkedIds: [],
    sequentialReview: true,
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export abstract class BrainstormControllerBase implements TaskController {
  readonly id = 'brainstorm';

  // ── Category-specific hooks (overridden by sub-controllers) ──────

  abstract get category(): BrainstormCategory;
  abstract getSeedPrompt(): string;
  abstract getDivergePrompt(): string;
  abstract getReviewIdeasPrompt(): string;
  abstract getConvergeClusterPrompt(): string;
  abstract getConvergePromotePrompt(): string;
  abstract getThemeSpecPrompt(): string;
  abstract getReviewThemeSpecPrompt(): string;
  abstract getAssemblePrompt(): string;
  abstract getDocPrefix(): string;
  abstract getThemePrefix(): string;
  abstract getSaveDir(): string;
  abstract getConvergenceLabel(): string;
  abstract getIdeaGateTitle(): string;
  abstract getConvergenceGateTitle(): string;

  // ── Shared prompt defaults (override per-category only if the category
  //    needs a different tone; the shared prompts are intentionally generic) ──

  getRefineIdeasPrompt(): string    { return REFINE_IDEAS_SYSTEM; }
  getEnhanceIdeasPrompt(): string   { return ENHANCE_IDEAS_SYSTEM; }
  getDiscussRespondPrompt(): string { return DISCUSS_RESPOND_SYSTEM; }
  getDiscussRefinePrompt(): string  { return DISCUSS_REFINE_SYSTEM; }

  /** Override to skip per-theme spec generation (e.g., general category). */
  protected skipPerThemeSpec(): boolean { return false; }

  private state!: BrainstormState;
  private taskCounter = 0;
  /**
   * The TaskStateStore from the current `next()` invocation. Stashed so
   * step handlers (which don't receive the store directly) can call
   * `this.store?.markSessionComplete()` to tell the pipeline to clean
   * up the checkpoint file on exit. Set at the top of every `next()`;
   * do not rely on it outside the dispatch call tree.
   */
  private store?: TaskStateStore;
  /**
   * Name → file location lookup built from codebase searches. Used to resolve
   * LLM-emitted "refs: foo, bar" entries into clickable references. Rebuilt on
   * every enhance-search; persists across a turn but not across resumes (the
   * next enhance-search recomputes it).
   */
  private _entityIndex: EntityIndex = {};

  /**
   * Record a feedback entry on an idea. Only reject / diverge / discuss
   * actions record feedback. Empty feedback on non-reject actions is a
   * no-op; empty feedback on reject is substituted with
   * REJECT_FEEDBACK_TEMPLATE and marked templated so the LLM can
   * distinguish "no reason given" from a real rejection reason.
   */
  private pushFeedback(
    idea: Idea,
    action: IdeaFeedback['action'],
    rawReason: string | undefined,
  ): void {
    let reason = (rawReason ?? '').trim();
    let templated = false;
    if (!reason) {
      if (action !== 'reject') {
        return;
      }
      reason = REJECT_FEEDBACK_TEMPLATE;
      templated = true;
    }
    if (!idea.feedback) { idea.feedback = []; }
    idea.feedback.push({
      action,
      reason,
      templated,
      round: this.state.round,
      timestamp: new Date().toISOString(),
    });
  }

  buildInitialTasks(input: ControllerInput): Task[] {
    this.state = initState(input, this.getDocPrefix());
    // Stamp the category on state so the resume handler can pick the
    // right subclass when rehydrating from a checkpoint. Each subclass
    // overrides `get category()`; we snapshot the value here so it
    // travels with the checkpoint even after the controller instance
    // is gone.
    this.state.category = this.category;
    this.taskCounter = 1;
    return [this.buildGenerateIdeasTask()];
  }

  next(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    store: TaskStateStore,
  ): Task[] | null {
    // Restore state from store on resume (crash recovery)
    const stored = store.get<BrainstormState>('brainstormState');
    if (stored && !this.state) {
      this.state = stored;
    }

    const step = this.state.lastStep;

    // Consume injected user messages (from chat.inject RPC)
    const injected = store.get<string[]>('injectedMessages') ?? [];
    if (injected.length > 0) {
      for (const msg of injected) {
        recordQnA(this.state, step, 'user', msg, '(pending — will influence next step)');
      }
      // Append to recentFeedback so next LLM task picks up user direction
      const combined = injected.join('\n');
      this.state.recentFeedback = this.state.recentFeedback
        ? `${this.state.recentFeedback}\n${combined}`
        : combined;
      store.set('injectedMessages', []);
    }

    // Consume user-contributed ideas (from brainstorm.addIdea RPC -- Item 14).
    // Item 20: user-authored ideas are auto-accepted -- the user explicitly
    // added them, asking them to Approve their own idea is nuisance. They go
    // straight into the accepted pool and participate in downstream
    // clustering / convergence without a review card.
    const injectedIdeas = store.get<Array<{ title: string; body: string }>>('injectedIdeas') ?? [];
    if (injectedIdeas.length > 0) {
      for (const raw of injectedIdeas) {
        const body = (raw.body ?? '').trim();
        const title = (raw.title ?? '').slice(0, 80).trim() || 'User idea';
        const idea: Idea = {
          id: randomBytes(16).toString('hex'),
          index: this.state.nextIdeaIndex++,
          title,
          body: body || title,
          ...(body ? { summary: body } : {}),
          references: [],
          tags: [],
          round: this.state.round,
          status: 'accepted',
          source: 'user',
          reviewVerdict: 'user',
          feedback: [],
        };
        this.state.ideas.push(idea);
        recordQnA(this.state, step, 'user', `Added idea: ${idea.title}`, '(auto-accepted as user-contributed)');
      }
      // Do NOT splice into reviewQueue -- status=accepted means this idea is
      // already in the pool. The user will see it in the next idea-list /
      // convergence-review pane with a user-contributed badge (Item 20b, UI).
      store.set('injectedIdeas', []);
    }

    // Record QnA for gate replies (user input)
    if (gateReply) {
      const feedbackText = gateReply.feedback
        ? `${gateReply.action}: ${gateReply.feedback}`
        : gateReply.action;
      recordQnA(this.state, step, 'user', feedbackText, completed.output.slice(0, 300));
    }

    // Record QnA for LLM results (system output)
    if (!gateReply && completed.success) {
      recordQnA(this.state, step, 'system', step, completed.output.slice(0, 300));
    }

    // Stash the store so dispatch handlers (afterPresentation, future
    // afterResumeConfirm) can signal session completion without having
    // the store threaded through every handler signature.
    this.store = store;
    const result = this.dispatch(step, completed, gateReply);

    // Sync state to store for checkpointing + QnA card updates
    store.set('brainstormState', this.state);
    store.set('brainstormQnA', this.state.qna);

    return result;
  }

  finalize(_store: TaskStateStore): FinalizeResult {
    // Return empty output — the presentation gate already displayed the content.
    // No artifacts here: saving happens only when user clicks Save in the gate.
    return {
      output: '',
      format: 'text',
    };
  }

  // ---------------------------------------------------------------------------
  // Flow dispatch
  // ---------------------------------------------------------------------------

  private dispatch(
    step: string,
    completed: TaskResult,
    gateReply: GateReply | undefined,
  ): Task[] | null {
    switch (step) {
      // --- Context enrichment ---
      case 'search-context':
        return this.afterSearchContext(completed);

      // --- Idea enhancement (vector search + LLM grounding) ---
      case 'enhance-ideas-search':
        return this.afterEnhanceIdeasSearch(completed);
      case 'enhance-ideas-llm':
        return this.afterEnhanceIdeasLlm(completed);

      // --- Ideation loop (Phase 3: unified) ---
      case 'generate-ideas':
        return this.afterGenerateIdeas(completed);
      case 'review-ideas':
        return this.afterReviewIdeas(completed);
      case 'refine-ideas':
        return this.afterRefineIdeas(completed);

      // --- Idea list + per-idea discussion (Phase 3b) ---
      case 'idea-list':
        return this.afterIdeaList(gateReply);
      case 'idea-review':
        return this.afterSingleIdeaReview(gateReply);
      case 'idea-diverge-single':
        return this.afterDivergeSingle(completed);
      case 'idea-discuss-search':
        return this.afterIdeaDiscussSearch(completed);
      case 'idea-discuss':
        return this.afterIdeaDiscuss(gateReply);
      case 'idea-discuss-respond':
        return this.afterIdeaDiscussRespond(completed);
      // idea-discuss-refine merged into idea-discuss-respond (unified flow)

      // --- Convergence ---
      case 'converge-cluster':
        return this.afterConvergeCluster(completed);
      case 'converge-promote':
        return this.afterConvergePromote(completed);
      case 'validate-convergence':
        return this.afterValidateConvergence(gateReply);

      // --- Per-theme spec generation (Phase 4) ---
      case 'search-theme-context':
        return this.afterSearchThemeContext(completed);
      case 'generate-theme-spec':
        return this.afterGenerateThemeSpec(completed);
      case 'review-theme-spec':
        return this.afterReviewThemeSpec(completed);
      case 'theme-spec-review':
        return this.afterThemeSpecReview(gateReply);
      case 'assemble-spec':
        return this.afterAssembleSpec(completed);

      // --- Finalize ---
      case 'finalize':
        return this.afterFinalize(completed);
      case 'presentation':
        return this.afterPresentation(gateReply);
      case 'handoff-proposal':
        return this.afterHandoffProposal(gateReply);

      // --- Resume (Phase 2 / Item 7) ---
      case 'resume-confirm':
        return this.afterResumeConfirm(gateReply);

      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Step handlers — Context enrichment via vector store search
  // ---------------------------------------------------------------------------

  /** Build a search query from current ideas/feedback to enrich code context. */
  private buildSearchContextTask(): Task {
    // Build search query from: user feedback, new idea texts, recent direction
    const queryParts: string[] = [];
    if (this.state.recentFeedback) {
      queryParts.push(this.state.recentFeedback.slice(0, 200));
    }
    // Include user-added ideas (most likely to introduce new concepts)
    const userIdeas = this.state.ideas.filter(i => i.reviewVerdict === 'user');
    for (const idea of userIdeas) {
      queryParts.push(idea.title);
    }
    // Fallback to the original problem if nothing else
    if (queryParts.length === 0) {
      queryParts.push(this.state.input.message.slice(0, 200));
    }
    const searchText = queryParts.join(' ');

    return {
      index: this.taskCounter++,
      description: 'Searching codebase for relevant context...',
      kind: 'rpc',
      intent: 'brainstorm',
      rpcMethod: 'search.query',
      rpcParams: { text: searchText, limit: 10, filter: 'code' },
      stateKey: 'searchContextOutput',
    };
  }

  /**
   * Start the next ideation round. On round > 1, searches the vector store
   * first to enrich code context with terms from user feedback/ideas.
   *
   * NOTE: do NOT reset `idea.feedback[]` here. The round-2 generation
   * prompt reads that feedback into its Rejected + Directions sections;
   * if we cleared it here, those sections would always be empty.
   * `buildGenerateIdeasTask` clears the arrays at the bottom, after the
   * prompt has been assembled.
   */
  private startIdeationRound(): Task[] {
    if (this.state.round > 1) {
      this.state.lastStep = 'search-context';
      return [this.buildSearchContextTask()];
    }
    this.state.lastStep = 'generate-ideas';
    return [this.buildGenerateIdeasTask()];
  }

  /** Parse search results and append to code context, then proceed to generate-ideas. */
  private afterSearchContext(completed: TaskResult): Task[] {
    if (completed.success && completed.output) {
      try {
        const entities = JSON.parse(completed.output) as Array<{ kind: string; name: string; file: string; body?: string; signature?: string }>;
        if (entities.length > 0) {
          const contextParts: string[] = [];
          for (const e of entities) {
            const sig = e.signature ? ` — ${e.signature}` : '';
            const body = e.body ? `\n${e.body.slice(0, 500)}` : '';
            contextParts.push(`[${e.kind}] ${e.name}${sig} (${e.file})${body}`);
          }
          const newContext = contextParts.join('\n\n');
          // Append to existing code context (deduplicate by not adding if already present)
          if (!this.state.input.codeContext.includes(newContext.slice(0, 100))) {
            this.state.input.codeContext = this.state.input.codeContext
              ? `${this.state.input.codeContext}\n\n--- Updated Context ---\n${newContext}`
              : newContext;
          }
        }
      } catch {
        // Parse failure — continue without enrichment
      }
    }

    this.state.lastStep = 'generate-ideas';
    return [this.buildGenerateIdeasTask()];
  }

  // ---------------------------------------------------------------------------
  // Step handlers — Idea enhancement (vector search + LLM grounding)
  // ---------------------------------------------------------------------------

  /** Build RPC search task using current-round idea texts as query. */
  private buildEnhanceIdeasSearchTask(): Task {
    // On round > 1, only enhance new/current-round ideas
    const ideasToEnhance = this.state.round === 1
      ? this.state.ideas
      : this.state.ideas.filter(i => i.round === this.state.round);

    // Combine idea texts into a single search query (top concepts)
    const searchText = ideasToEnhance
      .map(i => i.title)
      .join(' ')
      .slice(0, 500);

    return {
      index: this.taskCounter++,
      description: 'Searching codebase to ground ideas...',
      kind: 'rpc',
      intent: 'brainstorm',
      rpcMethod: 'search.query',
      rpcParams: { text: searchText, limit: 15, filter: 'code' },
      stateKey: 'enhanceSearchOutput',
    };
  }

  /** Parse search results, then send ideas + code entities to local LLM for grounding. */
  private afterEnhanceIdeasSearch(completed: TaskResult): Task[] {
    let codeEntities = '';
    if (completed.success && completed.output) {
      try {
        const entities = JSON.parse(completed.output) as Array<{ kind: string; name: string; file: string; startLine?: number; body?: string; signature?: string }>;
        if (entities.length > 0) {
          const parts: string[] = [];
          for (const e of entities) {
            const sig = e.signature ? ` — ${e.signature}` : '';
            const body = e.body ? `\n${e.body.slice(0, 300)}` : '';
            parts.push(`[${e.kind}] ${e.name}${sig} (${e.file})${body}`);
            // Index by bare name so LLM-emitted refs (which only carry the
            // entity name, not the path) can be resolved at parse time.
            if (e.name && e.file) {
              this._entityIndex[e.name] = e.startLine !== undefined
                ? { path: e.file, line: e.startLine }
                : { path: e.file };
            }
          }
          codeEntities = parts.join('\n\n');
        }
      } catch { /* continue without */ }
    }

    // If no code entities found, skip LLM enhancement and go straight to review
    if (!codeEntities) {
      this.state.lastStep = 'review-ideas';
      return [this.buildReviewIdeasTask('')];
    }

    // Send ideas + entities to local LLM for grounding
    const ideasToEnhance = this.state.round === 1
      ? this.state.ideas
      : this.state.ideas.filter(i => i.round === this.state.round);
    const ideaList = formatIdeasForContext(ideasToEnhance);

    this.state.lastStep = 'enhance-ideas-llm';
    return [{
      index: this.taskCounter++,
      // Item 32a: count-in-description gives presence during the bulk
      // enhance call (single local-LLM pass over the whole list, can
      // take 1-5min depending on size).
      description: `Enhancing ${ideasToEnhance.length} idea${ideasToEnhance.length === 1 ? '' : 's'} with code context (local LLM)...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getEnhanceIdeasPrompt(),
      userMessage: `## Original Problem\n${this.state.input.message}\n\n## Ideas to Enhance\n${ideaList}\n\n## Relevant Code Entities\n${codeEntities}`,
      resolverAgent: 'brainstorm',
      resolverStep: 'enhance',
      stateKey: 'enhanceLlmOutput',
    }];
  }

  /** Parse enhanced ideas from LLM, update state, proceed to Claude review. */
  private afterEnhanceIdeasLlm(completed: TaskResult): Task[] {
    // Parse enhanced ideas — same format as original ideas
    const enhanced = parseIdeaList(
      completed.output,
      this.state.round,
      1,
      this.state.input.repoPath || 'unknown',
      this._entityIndex,
    );

    // Match enhanced ideas back to originals by POSITION (not index — LLM renumbers from [1])
    const ideasToEnhance = this.state.round === 1
      ? this.state.ideas.filter(i => i.status === 'proposed')
      : this.state.ideas.filter(i => i.round === this.state.round);

    for (let pos = 0; pos < enhanced.length && pos < ideasToEnhance.length; pos++) {
      const enh = enhanced[pos]!;
      const original = ideasToEnhance[pos]!;
      original.title = enh.title;
      original.body = enh.body;
      original.references = enh.references;
      if (enh.tags.length > 0) original.tags = enh.tags;
    }

    // Proceed to Claude review
    this.state.lastStep = 'review-ideas';
    return [this.buildReviewIdeasTask(completed.output)];
  }

  // ---------------------------------------------------------------------------
  // Step handlers — Ideation (Phase 3: unified generate/review/gate)
  // ---------------------------------------------------------------------------

  private afterGenerateIdeas(completed: TaskResult): Task[] {
    if (this.state.round === 1) {
      // Parse seed output into analysis + ideas
      const { analysis, ideas } = parseSeedOutput(
        completed.output,
        this.state.input.repoPath || 'unknown',
      );
      this.state.seedAnalysis = analysis;
      this.state.ideas = [...this.state.ideas, ...ideas];
      this.state.nextIdeaIndex = this.state.ideas.length + 1;
    } else {
      // Parse diverge output — new ideas only
      const newIdeas = parseIdeaList(
        completed.output,
        this.state.round,
        this.state.nextIdeaIndex,
        this.state.input.repoPath || 'unknown',
      );
      this.state.ideas = [...this.state.ideas, ...newIdeas];
      this.state.nextIdeaIndex += newIdeas.length;
    }

    // Route through enhancement (vector search → LLM grounding) before Claude review
    this.state.lastStep = 'enhance-ideas-search';
    return [this.buildEnhanceIdeasSearchTask()];
  }

  private afterReviewIdeas(completed: TaskResult): Task[] {
    this.applyIdeaReview(completed.output);

    // If all current-round ideas are weak, skip refine and re-run ideation
    const currentRound = this.state.ideas.filter(i => i.round === this.state.round);
    const nonWeak = currentRound.filter(i => i.reviewVerdict !== 'weak');
    if (nonWeak.length === 0 && currentRound.length > 0) {
      this.state.recentFeedback = 'Claude review rejected all ideas as weak. Generating fresh ideas.';
      this.state.round += 1;
      return this.startIdeationRound();
    }

    // Route through local LLM to refine: drop weak, rewrite moderate, keep strong
    this.state.lastStep = 'refine-ideas';
    return [this.buildRefineIdeasTask(completed.output)];
  }

  private afterRefineIdeas(completed: TaskResult): Task[] {
    // Parse refined output — local LLM returns renumbered idea list without weak items
    const refinedIdeas = parseIdeaList(
      completed.output,
      this.state.round,
      1, // renumbered from 1
      this.state.input.repoPath || 'unknown',
      this._entityIndex,
    );

    // Keep non-rejected ideas from prior rounds for carry-forward into
    // the new pool. Rejected ideas are tracked separately so they
    // (a) persist in state.ideas as a rejection-audit trail and
    // (b) reserve their indices so refined ideas don't collide, and
    // (c) can be deduped against so the LLM can't accidentally
    //     regenerate a rejected title.
    const priorSurvivors = this.state.ideas.filter(
      i => i.round < this.state.round && i.status !== 'rejected',
    );
    const priorRejected = this.state.ideas.filter(
      i => i.round < this.state.round && i.status === 'rejected',
    );

    // Build verdict map from pre-refine ideas (keyed by text prefix for fuzzy match)
    const verdictMap = new Map<string, { verdict: 'strong' | 'moderate' | 'weak' | 'user'; source: IdeaSource }>();
    for (const idea of this.state.ideas) {
      if (idea.reviewVerdict) {
        verdictMap.set(idea.title.slice(0, 50).toLowerCase(), {
          verdict: idea.reviewVerdict,
          source: idea.source,
        });
      }
    }

    // Dedupe refinedIdeas against BOTH survivors and rejected prior ideas.
    // - Survivors: prevents paraphrased duplicates of accepted/proposed
    //   items being re-emitted by the local LLM as "new" ideas.
    // - Rejected: prevents the regeneration of ideas the user explicitly
    //   rejected (the bug that Phase 1 was supposed to fix).
    const dedupKeys = new Set([
      ...priorSurvivors.map(i => i.title.slice(0, 60).toLowerCase().trim()),
      ...priorRejected.map(i => i.title.slice(0, 60).toLowerCase().trim()),
    ]);
    const uniqueRefined = refinedIdeas.filter(i => {
      const key = i.title.slice(0, 60).toLowerCase().trim();
      return !dedupKeys.has(key);
    });

    // Renumber refined ideas. startIndex is based on the FULL pool
    // (survivors + rejected) so rejected indices stay reserved and
    // refined ideas never collide with a retained-but-rejected slot.
    const maxPriorIdx = Math.max(
      0,
      ...priorSurvivors.map(i => i.index),
      ...priorRejected.map(i => i.index),
    );
    const startIndex = maxPriorIdx + 1;
    for (let i = 0; i < uniqueRefined.length; i++) {
      uniqueRefined[i]!.index = startIndex + i;
      const match = verdictMap.get(uniqueRefined[i]!.title.slice(0, 50).toLowerCase());
      if (match) {
        uniqueRefined[i]!.reviewVerdict = match.verdict;
        uniqueRefined[i]!.source = match.source;
      } else {
        // New or heavily rewritten idea -- survived refine so at least strong
        uniqueRefined[i]!.reviewVerdict = 'strong';
      }
    }

    // Rebuild the pool: rejected (retained for dedup + audit) + survivors + new.
    this.state.ideas = [...priorRejected, ...priorSurvivors, ...uniqueRefined];
    this.state.nextIdeaIndex = Math.max(...this.state.ideas.map(i => i.index), 0) + 1;

    if (this.state.sequentialReview) {
      return this.enterSequentialReview();
    }
    this.state.lastStep = 'idea-list';
    return [this.buildIdeaListGate()];
  }

  // ---------------------------------------------------------------------------
  // Step handlers — Idea List + Per-Idea Discussion (Phase 3b)
  // ---------------------------------------------------------------------------

  /** Handle user action from the idea list gate. */
  private afterIdeaList(gateReply: GateReply | undefined): Task[] {
    if (!gateReply || gateReply.action === 'accept-remaining') {
      // User explicitly approved everything. Mark the remaining
      // proposed ideas accepted, then either converge (threshold met
      // or this was round 2+) or bump the round to generate more.
      this.state.ideas = this.state.ideas.map(i =>
        i.status === 'proposed' ? { ...i, status: 'accepted' as const } : i,
      );
      const acceptedCount = this.state.ideas.filter(i => i.status === 'accepted').length;
      if (acceptedCount >= AUTO_CONVERGE_THRESHOLD || this.state.round >= 2) {
        this.state.mode = 'converge';
        this.state.lastStep = 'converge-cluster';
        return [this.buildConvergeClusterTask()];
      }
      this.state.round += 1;
      return this.startIdeationRound();
    }

    if (gateReply.action === 'discuss') {
      // User clicked on an idea — enter discussion sub-flow
      const ideaId = gateReply.feedback;
      const idea = this.state.ideas.find(i => i.id === ideaId);
      if (!idea) return [this.buildIdeaListGate()]; // fallback

      this.state.focusedIdeaId = ideaId;
      this.state.discussionMessages = [];

      // Search for code context specific to this idea
      this.state.lastStep = 'idea-discuss-search';
      return [{
        index: this.taskCounter++,
        description: `Searching codebase for "${idea.title.slice(0, 40)}..."`,
        kind: 'rpc',
        intent: 'brainstorm',
        rpcMethod: 'search.query',
        rpcParams: { text: (idea.title + '. ' + idea.body).slice(0, 200), limit: 10, filter: 'code' },
        stateKey: 'discussSearchOutput',
      }];
    }

    if (gateReply.action === 'diverge') {
      // Remove rejected ideas, build feedback, start new round
      const rejected = this.state.ideas.filter(i => i.status === 'rejected');
      // Per decision B: each rejected idea in the bulk-diverge flow
      // gets a templated reject feedback entry so the next-round LLM
      // still sees "user rejected this" signal without a concrete reason.
      for (const r of rejected) {
        if (!(r.feedback ?? []).some(f => f.action === 'reject')) {
          this.pushFeedback(r, 'reject', undefined);
        }
      }
      const feedbackParts: string[] = [];
      if (rejected.length > 0) {
        feedbackParts.push(`User rejected ${rejected.length} idea(s): ${rejected.map(i => `[${i.index}] ${i.title.slice(0, 60)}`).join('; ')}`);
      }
      if (gateReply.feedback && gateReply.feedback !== rejected[0]?.id) {
        feedbackParts.push(gateReply.feedback);
      }
      this.state.recentFeedback = feedbackParts.join('\n');

      // Bug 31: bump user-added and commented ideas into the new round with
      // status='proposed' so they flow through the delta pipeline
      // (enhance -> review -> refine) instead of being stranded on the prior
      // round's already-reviewed shelf. Other surviving ideas keep their
      // round + status untouched.
      const nextRound = this.state.round + 1;
      this.state.ideas = this.state.ideas
        .filter(i => i.status !== 'rejected')
        .map(i => {
          const shouldReprocess = i.source === 'user' || !!i.userComment;
          if (shouldReprocess) {
            return { ...i, round: nextRound, status: 'proposed' as const };
          }
          return i;
        });

      this.state.nextIdeaIndex = Math.max(...this.state.ideas.map(i => i.index), 0) + 1;
      this.state.round = nextRound;
      return this.startIdeationRound();
    }

    if (gateReply.action === 'converge') {
      // Accept all pending ideas before converging
      this.state.ideas = this.state.ideas.map(i =>
        i.status === 'proposed' ? { ...i, status: 'accepted' as const } : i,
      );
      this.state.mode = 'converge';
      this.state.lastStep = 'converge-cluster';
      return [this.buildConvergeClusterTask()];
    }

    return this.handleIdeaApprove();
  }

  // ---------------------------------------------------------------------------
  // Sequential Idea Review (one-at-a-time card flow)
  // ---------------------------------------------------------------------------

  /** Enter sequential review mode — build queue from pending ideas. */
  private enterSequentialReview(): Task[] {
    const pending = this.state.ideas.filter(i => i.status === 'proposed');
    this.state.reviewQueue = pending.map(i => i.id);
    this.state.currentReviewIndex = 0;
    this.state.parkedIds = [];
    this.state.lastStep = 'idea-review';
    return [this.buildSingleIdeaGate()];
  }

  /** Build a gate for a single idea card. */
  /**
   * Pop the pendingWarning off state so it appears on exactly one gate.
   * Returns the string, or undefined if no warning was pending.
   */
  private consumePendingWarning(): string | undefined {
    const w = this.state.pendingWarning;
    if (w !== undefined) this.state.pendingWarning = undefined;
    return w;
  }

  private buildSingleIdeaGate(): Task {
    const ideaId = this.state.reviewQueue[this.state.currentReviewIndex];
    const idea = ideaId ? this.state.ideas.find(i => i.id === ideaId) : undefined;

    if (!idea) {
      // Queue exhausted — check parked
      return this.resolveReviewQueue();
    }

    const accepted = this.state.ideas.filter(i => i.status === 'accepted').length;
    const rejected = this.state.ideas.filter(i => i.status === 'rejected').length;
    const parked = this.state.parkedIds.length;
    const total = this.state.reviewQueue.length;
    const current = this.state.currentReviewIndex + 1;

    const refsSection = idea.references.length > 0
      ? `\n\n**References:**\n${idea.references.map(r => `- ${r.label}`).join('\n')}`
      : '';

    const content = [
      `## Idea ${current} of ${total} — Round ${this.state.round}`,
      '',
      `### ${idea.title}`,
      '',
      idea.body,
      refsSection,
      '',
      `---`,
      `Approved: ${accepted} | Rejected: ${rejected} | Parked: ${parked}`,
    ].join('\n');

    const warning = this.consumePendingWarning();
    const structured: Record<string, unknown> = {
      phase: 'ideation',
      itemType: 'idea',
      itemId: idea.id,
      item: idea,
      progress: {
        total,
        current,
        approved: accepted,
        rejected,
        parked,
        skipped: this.state.ideas.filter(i => i.status === 'skipped').length,
        pending: total - current,
      },
    };
    if (warning) structured.warning = warning;

    return {
      index: this.taskCounter++,
      description: `Review: ${idea.title.slice(0, 50)}`,
      kind: 'transform',
      intent: 'brainstorm',
      userMessage: content,
      passThrough: true,
      requiresGate: true,
      // Phase 2 / Item 7: persist after every gate task so user
      // actions (approve/reject/diverge/discuss/park) and the LLM work
      // that produced the idea are both survivable across daemon
      // restart. Without this flag the pipeline only checkpoints at
      // finalize, which is too late for any mid-flow interruption.
      persisted: true,
      gateTitle: `Idea ${current}/${total}: ${idea.title}`,
      gateActions: [
        { name: 'approve', label: 'Approve' },
        { name: 'reject', label: 'Reject' },
        { name: 'diverge', label: 'Diverge', hint: 'Generate variations', needsInput: true },
        { name: 'skip', label: 'Skip' },
        { name: 'park', label: 'Park' },
        { name: 'discuss', label: 'Discuss', needsInput: true },
      ],
      structured,
      stateKey: 'ideaReviewOutput',
    };
  }

  /** Handle action from single idea gate. */
  private afterSingleIdeaReview(gateReply: GateReply | undefined): Task[] {
    const ideaId = this.state.reviewQueue[this.state.currentReviewIndex];
    const idea = ideaId ? this.state.ideas.find(i => i.id === ideaId) : undefined;

    if (!idea || !gateReply) {
      return [this.resolveReviewQueue()];
    }

    const ideaLabel = `[${idea.index}] ${idea.title}`;

    switch (gateReply.action) {
      case 'approve':
        idea.status = 'accepted';
        recordQnA(this.state, 'idea-review', 'user',
          `Review idea ${ideaLabel}`,
          `Approved${gateReply.feedback ? ': ' + gateReply.feedback : ''}`);
        break;

      case 'reject':
        idea.status = 'rejected';
        this.pushFeedback(idea, 'reject', gateReply.feedback);
        recordQnA(this.state, 'idea-review', 'user',
          `Review idea ${ideaLabel}`,
          `Rejected: ${gateReply.feedback || 'No reason given'}`);
        break;

      case 'skip':
        idea.status = 'skipped';
        recordQnA(this.state, 'idea-review', 'user',
          `Review idea ${ideaLabel}`,
          'Skipped for later');
        break;

      case 'park':
        idea.status = 'parked';
        this.state.parkedIds.push(idea.id);
        recordQnA(this.state, 'idea-review', 'user',
          `Review idea ${ideaLabel}`,
          `Parked${gateReply.feedback ? ': ' + gateReply.feedback : ''}`);
        break;

      case 'diverge': {
        // Generate variations of this idea — add to end of queue
        this.state.recentFeedback = gateReply.feedback || `Diverge on: ${idea.title}`;
        idea.status = 'accepted'; // Keep the original
        this.pushFeedback(idea, 'diverge', gateReply.feedback);
        recordQnA(this.state, 'idea-review', 'user',
          `Review idea ${ideaLabel}`,
          `Diverge: generate variations. ${gateReply.feedback || ''}`.trim());
        // New ideas will be generated and added in a mini-round
        this.state.lastStep = 'idea-diverge-single';
        return [{
          index: this.taskCounter++,
          description: `Generating variations of "${idea.title.slice(0, 40)}"`,
          kind: 'llm',
          intent: 'brainstorm',
          systemPrompt: this.getDivergePrompt(),
          userMessage: [
            `## Original Idea`,
            `[${idea.index}] ${idea.title}: ${idea.body}`,
            '',
            `## Direction`,
            gateReply.feedback || 'Generate 3-5 variations or alternatives.',
            '',
            `Generate variations as a numbered list: [N] Title. Description`,
          ].join('\n'),
          providerHint: 'local',
          resolverAgent: 'brainstorm',
          resolverStep: 'diverge',
          stateKey: 'divergeSingleOutput',
        }];
      }

      case 'discuss': {
        // Enter per-idea discussion
        this.state.focusedIdeaId = idea.id;
        this.state.discussionMessages = [];
        if (gateReply.feedback) {
          this.pushFeedback(idea, 'discuss', gateReply.feedback);
          this.state.discussionMessages.push({
            role: 'user',
            content: gateReply.feedback,
            timestamp: new Date().toISOString(),
          });
          recordQnA(this.state, 'idea-review', 'user',
            `Discuss idea ${ideaLabel}`,
            gateReply.feedback);
        }
        this.state.lastStep = 'idea-discuss-search';
        return [{
          index: this.taskCounter++,
          description: `Searching codebase for "${idea.title.slice(0, 40)}"`,
          kind: 'rpc',
          intent: 'brainstorm',
          rpcMethod: 'search.query',
          rpcParams: { text: (idea.title + '. ' + idea.body).slice(0, 200), limit: 10, filter: 'code' },
          stateKey: 'discussSearchOutput',
        }];
      }

      default:
        idea.status = 'accepted';
        break;
    }

    // Advance to next idea in queue
    this.state.currentReviewIndex++;
    this.state.lastStep = 'idea-review';
    return [this.buildSingleIdeaGate()];
  }

  /** Handle diverge-single output — parse new ideas, add to queue. */
  private afterDivergeSingle(completed: TaskResult): Task[] {
    let newIdeaCount = 0;
    if (completed.success && completed.output) {
      const newIdeas = parseIdeaList(
        completed.output,
        this.state.round,
        this.state.nextIdeaIndex,
        this.state.input.repoPath || 'unknown',
        this._entityIndex,
      );
      newIdeaCount = newIdeas.length;
      for (const idea of newIdeas) {
        this.state.ideas.push(idea);
      }
      this.state.nextIdeaIndex += newIdeas.length;

      // Splice variation IDs into reviewQueue right after the current
      // index so the next card the user sees IS a variation of the idea
      // they just diverged on, not an unrelated later queue entry.
      const insertAt = this.state.currentReviewIndex + 1;
      this.state.reviewQueue.splice(insertAt, 0, ...newIdeas.map(i => i.id));
    }

    if (newIdeaCount === 0) {
      this.state.pendingWarning = 'The local LLM returned no usable variations. Try again or adjust your diverge direction.';
    }

    // Advance past the diverged idea.
    this.state.currentReviewIndex++;
    this.state.lastStep = 'idea-review';
    return [this.buildSingleIdeaGate()];
  }

  /** Resolve the review queue — handle parked ideas or proceed. */
  private resolveReviewQueue(): Task {
    // Check for parked ideas that need re-review
    const unresolvedParked = this.state.parkedIds.filter(id => {
      const idea = this.state.ideas.find(i => i.id === id);
      return idea && idea.status === 'parked';
    });

    if (unresolvedParked.length > 0) {
      // Re-enter queue with parked ideas
      this.state.reviewQueue = unresolvedParked;
      this.state.currentReviewIndex = 0;
      this.state.parkedIds = [];
      return this.buildSingleIdeaGate();
    }

    // All ideas resolved — decide next phase
    // Accept any remaining skipped as proposed (will be auto-accepted)
    for (const idea of this.state.ideas) {
      if (idea.status === 'skipped') {
        idea.status = 'proposed';
      }
    }

    // Delegate to handleIdeaApprove which checks converge threshold
    const tasks = this.handleIdeaApprove();
    return tasks[0]!;
  }

  /** Parse discussion search results, store context, present discussion gate. */
  private afterIdeaDiscussSearch(completed: TaskResult): Task[] {
    let codeContext = '';
    if (completed.success && completed.output) {
      try {
        const entities = JSON.parse(completed.output) as Array<{ kind: string; name: string; file: string; body?: string; signature?: string }>;
        if (entities.length > 0) {
          const parts: string[] = [];
          for (const e of entities) {
            const sig = e.signature ? ` — ${e.signature}` : '';
            const body = e.body ? `\n${e.body.slice(0, 300)}` : '';
            parts.push(`[${e.kind}] ${e.name}${sig} (${e.file})${body}`);
          }
          codeContext = parts.join('\n\n');
        }
      } catch { /* continue without */ }
    }

    this.state.focusedIdeaContext = codeContext || undefined;

    // If the user already sent an opening message when they clicked Discuss,
    // the last entry in discussionMessages is from them and no assistant
    // reply exists yet. Chain into the LLM response task before emitting
    // the discussion gate — otherwise the gate shows only the user's own
    // prompt and the user has to click again just to get a reply.
    const msgs = this.state.discussionMessages ?? [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
    if (lastMsg && lastMsg.role === 'user') {
      const idea = this.state.ideas.find(i => i.id === this.state.focusedIdeaId);
      if (idea) {
        this.state.lastStep = 'idea-discuss-respond';
        return [{
          index: this.taskCounter++,
          description: 'Responding to your question...',
          kind: 'llm',
          intent: 'brainstorm',
          systemPrompt: this.getDiscussRespondPrompt(),
          userMessage: this.buildDiscussionContext(idea, lastMsg.content),
          resolverAgent: 'brainstorm',
          resolverStep: 'discuss',
          stateKey: 'discussRespondOutput',
        }];
      }
    }

    this.state.lastStep = 'idea-discuss';
    return [this.buildIdeaDiscussGate()];
  }

  /** Handle user action from the discussion gate. */
  private afterIdeaDiscuss(gateReply: GateReply | undefined): Task[] {
    const idea = this.state.ideas.find(i => i.id === this.state.focusedIdeaId);
    if (!idea) return this.exitDiscussion();

    if (!gateReply || gateReply.action === 'back') {
      return this.exitDiscussion();
    }

    if (gateReply.action === 'accept') {
      idea.status = 'accepted';
      recordQnA(this.state, 'idea-discuss', 'user',
        `Discussion on [${idea.index}] ${idea.title}`,
        'Accepted after discussion');
      return this.exitDiscussion();
    }

    if (gateReply.action === 'reject') {
      idea.status = 'rejected';
      this.pushFeedback(idea, 'reject', gateReply.feedback);
      recordQnA(this.state, 'idea-discuss', 'user',
        `Discussion on [${idea.index}] ${idea.title}`,
        `Rejected: ${gateReply.feedback || 'after discussion'}`);
      return this.exitDiscussion();
    }

    // Unified discuss flow: user input (question or feedback) → LLM decides
    // whether to just respond or also update the idea
    if (gateReply.action === 'respond' || gateReply.action === 'refine') {
      const userMsg = gateReply.feedback ?? '';
      if (!userMsg) return [this.buildIdeaDiscussGate()];
      // Per decision D1: every user utterance during discussion becomes
      // its own feedback entry.
      this.pushFeedback(idea, 'discuss', userMsg);

      this.addDiscussionMessage('user', userMsg);
      recordQnA(this.state, 'idea-discuss', 'user',
        `Discussion on [${idea.index}] ${idea.title}`,
        userMsg);

      // Single unified LLM call — responds AND optionally updates idea
      this.state.lastStep = 'idea-discuss-respond';
      return [{
        index: this.taskCounter++,
        description: 'Processing your feedback...',
        kind: 'llm',
        intent: 'brainstorm',
        systemPrompt: this.getDiscussRespondPrompt(),
        userMessage: this.buildDiscussionContext(idea, userMsg),
        resolverAgent: 'brainstorm',
        resolverStep: 'discuss',
        stateKey: 'discussRespondOutput',
      }];
    }

    return this.exitDiscussion();
  }

  /**
   * After unified discuss LLM call — parse response and optionally update idea.
   *
   * LLM returns JSON: { response: string, updatedIdea?: { title, body } }
   * Or plain text (backward compat) — treated as response-only.
   */
  private afterIdeaDiscussRespond(completed: TaskResult): Task[] {
    const idea = this.state.ideas.find(i => i.id === this.state.focusedIdeaId);

    // Surface LLM-task failure inline in the discussion history so the
    // user sees something actionable instead of a silent no-op.
    if (!completed.success || !completed.output || completed.output.trim().length === 0) {
      const reason = completed.error ?? 'no output from the agent';
      this.addDiscussionMessage('assistant', `[Error: the agent could not respond. ${reason}]`);
      this.state.lastStep = 'idea-discuss';
      return [this.buildIdeaDiscussGate()];
    }

    let responseText = completed.output;
    let ideaUpdated = false;

    // Try to parse structured response
    try {
      const parsed = JSON.parse(completed.output.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      if (parsed && typeof parsed.response === 'string') {
        responseText = parsed.response;

        // If LLM included an updated idea, apply it
        if (parsed.updatedIdea && idea) {
          const oldTitle = idea.title;
          if (parsed.updatedIdea.title) idea.title = parsed.updatedIdea.title;
          if (parsed.updatedIdea.body) idea.body = parsed.updatedIdea.body;
          ideaUpdated = true;
          recordQnA(this.state, 'idea-discuss-update', 'system',
            `Idea [${idea.index}] updated from "${oldTitle}"`,
            `Updated to: ${idea.title}`);
        }
      }
    } catch {
      // Plain text response — no idea update
    }

    this.addDiscussionMessage('assistant', responseText);
    if (ideaUpdated && idea) {
      this.addDiscussionMessage('assistant', `[Idea updated: ${idea.title}]`);
    }

    if (idea) {
      recordQnA(this.state, 'idea-discuss', 'system',
        `Discussion on [${idea.index}] ${idea.title}`,
        responseText.slice(0, 300));
    }

    this.state.lastStep = 'idea-discuss';
    return [this.buildIdeaDiscussGate()];
  }

  // ---------------------------------------------------------------------------
  // Discussion helpers
  // ---------------------------------------------------------------------------

  /** Build the full discussion context for LLM calls. */
  private buildDiscussionContext(idea: Idea, currentMessage: string): string {
    const parts: string[] = [
      `## Original Problem\n${this.state.input.message}`,
      `## Idea Being Discussed\n[${idea.index}] ${idea.title}: ${idea.body}`,
    ];
    if (idea.reviewVerdict) parts.push(`Verdict: ${idea.reviewVerdict}`);
    if (idea.reviewRationale) parts.push(`Rationale: ${idea.reviewRationale}`);
    if (this.state.focusedIdeaContext) {
      parts.push(`\n## Relevant Code\n${this.state.focusedIdeaContext}`);
    }
    if (this.state.discussionMessages && this.state.discussionMessages.length > 0) {
      const history = this.state.discussionMessages
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      parts.push(`\n## Discussion History\n${history}`);
    }
    parts.push(`\n## Current Message\n${currentMessage}`);
    return parts.join('\n');
  }

  /** Add a message to the discussion history. */
  private addDiscussionMessage(role: 'user' | 'assistant', content: string): void {
    if (!this.state.discussionMessages) this.state.discussionMessages = [];
    this.state.discussionMessages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
    });
  }

  /** Exit discussion, clear focused state, return to idea list. */
  private exitDiscussion(): Task[] {
    this.state.focusedIdeaId = undefined;
    this.state.focusedIdeaContext = undefined;
    this.state.discussionMessages = undefined;
    if (this.state.sequentialReview) {
      // Return to sequential review at current position
      this.state.lastStep = 'idea-review';
      return [this.buildSingleIdeaGate()];
    }
    this.state.lastStep = 'idea-list';
    return [this.buildIdeaListGate()];
  }

  private handleIdeaApprove(): Task[] {
    // Accept remaining proposed ideas (rejected already filtered by finalizeSelections)
    this.state.ideas = this.state.ideas.map(i =>
      i.status === 'proposed' ? { ...i, status: 'accepted' as const } : i,
    );

    const acceptedCount = this.state.ideas.filter(i => i.status === 'accepted').length;
    if (acceptedCount >= AUTO_CONVERGE_THRESHOLD || this.state.round >= 2) {
      this.state.mode = 'converge';
      this.state.lastStep = 'converge-cluster';
      return [this.buildConvergeClusterTask()];
    }

    // Round 1 and below the auto-converge threshold: ask the user what
    // they want instead of silently bumping the round. The idea-list
    // gate's actions (accept-remaining / diverge / converge) each drive
    // the next step explicitly.
    this.state.lastStep = 'idea-list';
    return [this.buildIdeaListGate()];
  }

  // ---------------------------------------------------------------------------
  // Step handlers — Convergence
  // ---------------------------------------------------------------------------

  private afterConvergeCluster(completed: TaskResult): Task[] {
    const { themes } = parseClusterOutput(completed.output, this.state);
    // Assign unique IDs to each theme
    for (const theme of themes) {
      theme.themeId = `${this.getThemePrefix()}-${randomBytes(4).toString('hex')}`;
    }
    this.state.themes = themes;

    this.state.revisions.push({
      round: this.state.round,
      requirementId: '',
      action: 'added',
      detail: `${themes.length} themes identified: ${themes.map(t => t.name).join(', ')}`,
    });

    this.state.lastStep = 'converge-promote';
    return [this.buildConvergePromoteTask()];
  }

  private afterConvergePromote(completed: TaskResult): Task[] {
    const { promotions, merges } = parsePromotionOutput(
      completed.output,
      this.state.themes,
      this.state,
    );
    this.state.pendingPromotions = promotions;
    this.state.pendingMerges = merges;

    // Build convergence summary for the gate Summary tab
    const accepted = this.state.ideas.filter(i => i.status === 'accepted').length;
    const themeNames = this.state.themes.map(t => t.name).join(', ');
    this.state.specReviewSummary = [
      `**${this.state.themes.length} themes** identified from ${accepted} accepted ideas: ${themeNames}.`,
      `**${promotions.length} promotions** proposed${merges.length > 0 ? ` and ${merges.length} merges suggested` : ''}.`,
      promotions.slice(0, 3).map(p => `- ${p.statement.slice(0, 100)}`).join('\n'),
    ].join('\n\n');

    this.state.lastStep = 'validate-convergence';
    return [this.buildValidateConvergenceTask()];
  }

  private afterValidateConvergence(gateReply: GateReply | undefined): Task[] {
    // Parse structured feedback (comments on themes)
    if (gateReply?.feedback) {
      try {
        const fb = typeof gateReply.feedback === 'string' && gateReply.feedback.startsWith('{')
          ? JSON.parse(gateReply.feedback) as Record<string, unknown>
          : null;
        if (fb?.comments) {
          const comments = fb.comments as Record<string, string>;
          for (const [idStr, text] of Object.entries(comments)) {
            const idx = Number(idStr) - 1;
            if (this.state.themes[idx] && text.trim()) {
              this.state.themes[idx]!.userComment = text.trim();
            }
          }
        }
        if (fb?.priorities) {
          const priorities = fb.priorities as Record<string, string>;
          for (const [idStr, val] of Object.entries(priorities)) {
            const idx = Number(idStr) - 1;
            if (this.state.themes[idx]) {
              this.state.themes[idx]!.priority = val as 'low' | 'medium' | 'high';
            }
          }
        }
      } catch { /* non-JSON feedback — ignore */ }
    }

    if (!gateReply || gateReply.action === 'approve') {
      // Mark promoted/merged ideas
      const promotedIds = new Set(this.state.pendingPromotions.map(p => p.ideaId));
      const mergedIds = new Set(this.state.pendingMerges.map(m => m.ideaId));
      this.state.ideas = this.state.ideas.map(i => {
        if (promotedIds.has(i.id)) return { ...i, status: 'promoted' as const };
        if (mergedIds.has(i.id)) return { ...i, status: 'merged' as const };
        return i;
      });

      // Start per-theme spec generation (or skip for general category)
      if (this.skipPerThemeSpec()) {
        this.state.lastStep = 'assemble-spec';
        return [this.buildAssembleSpecTask()];
      }
      this.state.specThemeQueue = this.state.themes.map((_, idx) => idx);
      this.state.specSections = [];
      return this.nextThemeSpec();
    }

    if (gateReply.action === 'diverge') {
      // Back to ideation with feedback
      this.state.pendingPromotions = [];
      this.state.pendingMerges = [];
      this.state.recentFeedback = gateReply.feedback;
      this.state.mode = 'diverge';
      this.state.round += 1;
      return this.startIdeationRound();
    }

    // Edit — re-converge with feedback
    const key = `convergence-${this.state.round}`;
    const rounds = (this.state.editRounds[key] ?? 0) + 1;
    if (rounds > MAX_EDIT_ROUNDS) {
      // Force proceed to spec generation
      this.state.specThemeQueue = this.state.themes.map((_, idx) => idx);
      this.state.specSections = [];
      return this.nextThemeSpec();
    }

    this.state.editRounds = { ...this.state.editRounds, [key]: rounds };
    this.state.recentFeedback = gateReply.feedback;
    this.state.pendingPromotions = [];
    this.state.pendingMerges = [];
    this.state.lastStep = 'converge-cluster';
    return [this.buildConvergeClusterTask()];
  }

  // ---------------------------------------------------------------------------
  // Step handlers — Per-theme spec generation (Phase 4)
  // ---------------------------------------------------------------------------

  /** Advance to the next theme in the queue, or proceed to assembly. */
  private nextThemeSpec(): Task[] {
    const queue = this.state.specThemeQueue ?? [];
    if (queue.length === 0) {
      // All themes processed — assemble
      this.state.lastStep = 'assemble-spec';
      return [this.buildAssembleSpecTask()];
    }

    const themeIdx = queue[0]!;
    this.state.currentThemeIndex = themeIdx;
    this.state.specThemeQueue = queue.slice(1);

    // Search for theme-specific code context before generating spec
    const theme = this.state.themes[themeIdx];
    if (theme) {
      this.state.lastStep = 'search-theme-context';
      return [this.buildSearchThemeContextTask(themeIdx)];
    }

    this.state.lastStep = 'generate-theme-spec';
    return [this.buildGenerateThemeSpecTask(themeIdx)];
  }

  /** Build a search task using theme name + description + idea texts. */
  private buildSearchThemeContextTask(themeIdx: number): Task {
    const theme = this.state.themes[themeIdx]!;
    const themeIdeas = theme.ideaIds
      .map(id => this.state.ideas.find(i => i.id === id))
      .filter((i): i is NonNullable<typeof i> => i != null);

    const searchText = [
      theme.name,
      theme.description,
      ...themeIdeas.slice(0, 3).map(i => i.title),
    ].join(' ').slice(0, 500);

    // Item 32a: match the generate-spec description's N/M position hint
    // so the theme search + generate pair reads as one block.
    const totalThemes = this.state.themes.length;
    const position = `${themeIdx + 1}/${totalThemes}`;
    return {
      index: this.taskCounter++,
      description: `Searching codebase (${position}) for ${theme.name}...`,
      kind: 'rpc',
      intent: 'brainstorm',
      rpcMethod: 'search.query',
      rpcParams: { text: searchText, limit: 10, filter: 'code' },
      stateKey: 'themeSearchOutput',
    };
  }

  /** Parse theme search results, store as per-theme context, proceed to generate spec. */
  private afterSearchThemeContext(completed: TaskResult): Task[] {
    const themeIdx = this.state.currentThemeIndex ?? 0;
    let themeContext = '';

    if (completed.success && completed.output) {
      try {
        const entities = JSON.parse(completed.output) as Array<{ kind: string; name: string; file: string; body?: string; signature?: string }>;
        if (entities.length > 0) {
          const parts: string[] = [];
          for (const e of entities) {
            const sig = e.signature ? ` — ${e.signature}` : '';
            const body = e.body ? `\n${e.body.slice(0, 400)}` : '';
            parts.push(`[${e.kind}] ${e.name}${sig} (${e.file})${body}`);
          }
          themeContext = parts.join('\n\n');
        }
      } catch { /* continue without */ }
    }

    // Store fresh theme-specific context (used by buildGenerateThemeSpecTask)
    this.state.themeSearchContext = themeContext || undefined;

    this.state.lastStep = 'generate-theme-spec';
    return [this.buildGenerateThemeSpecTask(themeIdx)];
  }

  private afterGenerateThemeSpec(completed: TaskResult): Task[] {
    // Store the generated markdown section (will be reviewed by Claude next)
    const themeIdx = this.state.currentThemeIndex ?? 0;
    const theme = this.state.themes[themeIdx];
    const sections = this.state.specSections ?? [];
    sections.push({
      themeIndex: themeIdx,
      themeName: theme?.name ?? `Theme ${themeIdx + 1}`,
      themeId: theme?.themeId,
      content: completed.output,
      reviewed: false,
    });
    this.state.specSections = sections;

    // Send to Claude for review
    this.state.lastStep = 'review-theme-spec';
    return [this.buildReviewThemeSpecTask(completed.output, themeIdx)];
  }

  private afterReviewThemeSpec(completed: TaskResult): Task[] {
    // Update the last section with Claude's reviewed version
    const sections = this.state.specSections ?? [];
    const lastSection = sections[sections.length - 1];
    if (lastSection) {
      log.info({
        themeIndex: lastSection.themeIndex,
        themeName: lastSection.themeName,
        rawLen: completed.output.length,
        rawHead: completed.output.slice(0, 200),
        rawTail: completed.output.slice(-200),
      }, 'afterReviewThemeSpec: Claude review output arrived');
      // Claude's review prompt asks for a JSON `{ polishedSection: "..." }`
      // envelope, but in practice the output can arrive in several shapes:
      //
      //  1. Strict JSON: {"polishedSection": "## Header\n..."}
      //  2. JSON fenced in ```json ... ``` (common with Claude)
      //  3. Relaxed "JS-object" syntax with unquoted keys or trailing
      //     commas (Claude occasionally slips into this)
      //  4. Plain markdown prose (no envelope at all)
      //
      // We try (1)/(2) via `stripFences + JSON.parse`. On failure, try
      // to regex-extract the `polishedSection` string from (3). If both
      // fail and the output looks like markdown (4), use it raw. If
      // NONE of those work, keep the generate-step content rather than
      // letting the user see a JSON-wrapped blob (Item 49).
      const raw = completed.output;
      const stripped = stripFences(raw);
      let polished: string | undefined;

      try {
        const review = JSON.parse(stripped);
        if (review && typeof review === 'object' && typeof review.polishedSection === 'string') {
          polished = review.polishedSection;
        }
      } catch {
        // Fall through to regex extraction below.
      }

      // Strategy 1b: Claude often wraps the JSON in prose commentary
      // ("Here is the reviewed section: { ... }. Hope this helps!").
      // Find the first balanced `{...}` substring and try JSON.parse
      // on it.
      if (!polished) {
        const braceStart = stripped.indexOf('{');
        if (braceStart >= 0) {
          let depth = 0;
          let inStr = false;
          let escape = false;
          for (let i = braceStart; i < stripped.length; i++) {
            const ch = stripped[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) { continue; }
            if (ch === '{') { depth++; }
            else if (ch === '}') {
              depth--;
              if (depth === 0) {
                const slice = stripped.slice(braceStart, i + 1);
                try {
                  const review = JSON.parse(slice);
                  if (review && typeof review === 'object' && typeof review.polishedSection === 'string') {
                    polished = review.polishedSection;
                  }
                } catch {
                  // still malformed (e.g. trailing commas, unquoted keys)
                }
                break;
              }
            }
          }
        }
      }

      if (!polished) {
        // Regex fallback for JS-object-style output: match a
        // `polishedSection` key followed by a quoted string, handling
        // both escape-preserved and literal-newline body variants.
        const match = stripped.match(/polishedSection\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/s);
        if (match) {
          const rawPolished = match[1] ?? match[2] ?? '';
          // Unescape common JSON escapes that regex doesn't resolve.
          polished = rawPolished
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\'/g, "'")
            .replace(/\\\\/g, '\\');
        }
      }

      if (!polished) {
        // No envelope found -- check if the raw output itself is
        // clean markdown (no JSON-fence, no braces, starts with a
        // markdown sigil). If so, use it; otherwise keep whatever
        // afterGenerateThemeSpec wrote so the user at least sees the
        // unpolished-but-real spec.
        const trimmed = raw.trim();
        const looksLikeJsonWrapper = trimmed.startsWith('```json')
          || trimmed.startsWith('```typescript')
          || (trimmed.startsWith('{') && trimmed.includes('polishedSection'));
        const looksLikeMarkdown = !looksLikeJsonWrapper && (
          trimmed.startsWith('#')
          || trimmed.startsWith('-')
          || trimmed.startsWith('|')
          || trimmed.startsWith('```')
        );
        if (looksLikeMarkdown) {
          polished = trimmed;
        }
      }

      if (polished) {
        log.info({
          themeName: lastSection.themeName,
          polishedLen: polished.length,
          polishedHead: polished.slice(0, 160),
          delta: polished.length - lastSection.content.length,
        }, 'afterReviewThemeSpec: polishedSection extracted, updating section content');
        lastSection.content = polished;
      } else {
        log.warn({
          themeName: lastSection.themeName,
          rawLen: completed.output.length,
          rawHead: completed.output.slice(0, 400),
        }, 'afterReviewThemeSpec: could NOT extract polishedSection -- pane will show unreviewed generate output');
      }
      // else: leave lastSection.content as the generate-step output
      // (unpolished but at least readable).
      lastSection.reviewed = true;
    }
    this.state.specSections = sections;

    // Hand the polished section to the user for review before assembly. They
    // can approve and move to the next theme, or send edit feedback that
    // re-runs the per-theme generation with their notes appended.
    this.state.lastStep = 'theme-spec-review';
    return [this.buildThemeSpecReviewTask()];
  }

  /**
   * Gate: user reviews the Claude-polished spec section for the current theme
   * before the controller advances to the next theme (or final assembly).
   */
  private buildThemeSpecReviewTask(): Task {
    const sections = this.state.specSections ?? [];
    const section = sections[sections.length - 1];
    const themeIdx = this.state.currentThemeIndex ?? 0;
    const theme = this.state.themes[themeIdx];
    const themeName = section?.themeName ?? theme?.name ?? `Theme ${themeIdx + 1}`;
    const content = section?.content ?? '';

    const remaining = (this.state.specThemeQueue ?? []).length;
    const totalThemes = this.state.themes.length;
    const current = totalThemes - remaining;

    return {
      index: this.taskCounter++,
      // Item 32a: keep the position hint on the task description so it
      // matches the gateTitle formatting below ("Spec 3/7: Foo").
      description: `Review spec (${current}/${totalThemes}): ${themeName}`,
      kind: 'transform',
      intent: 'brainstorm',
      userMessage: content,
      passThrough: true,
      requiresGate: true,
      // Phase 2 / Item 7: persist so per-theme spec sections survive
      // across daemon restart -- re-running theme-spec generation is
      // expensive (Claude cluster + code search per theme).
      persisted: true,
      gateTitle: `Spec ${current}/${totalThemes}: ${themeName}`,
      gateActions: [
        { name: 'approve', label: 'Approve' },
        { name: 'edit', label: 'Request edits', hint: '<what to change>', needsInput: true },
      ],
      structured: {
        phase: 'specify',
        itemType: 'theme-spec',
        itemId: section?.themeId ?? String(themeIdx),
        item: {
          themeIndex: themeIdx,
          themeName,
          themeId: section?.themeId,
          content,
        },
        progress: {
          total: totalThemes,
          current,
          remaining,
        },
      },
      cyclic: { maxRounds: MAX_EDIT_ROUNDS, retryActions: ['edit'], skipActions: [] },
      stateKey: 'themeSpecReviewGateOutput',
    };
  }

  private afterThemeSpecReview(gateReply: GateReply | undefined): Task[] {
    const sections = this.state.specSections ?? [];
    const section = sections[sections.length - 1];

    // Default path (missing reply or approve) → advance.
    if (!gateReply || gateReply.action === 'approve') {
      return this.nextThemeSpec();
    }

    if (gateReply.action === 'edit') {
      const themeIdx = section?.themeIndex ?? this.state.currentThemeIndex ?? 0;
      const key = `theme-spec-${section?.themeId ?? themeIdx}`;
      const rounds = this.state.editRounds[key] ?? 0;
      if (rounds >= MAX_EDIT_ROUNDS) {
        // Safety rail matches the convergence gate: stop looping after N edits
        // and move on with whatever we have.
        return this.nextThemeSpec();
      }
      this.state.editRounds[key] = rounds + 1;

      // Capture feedback so the next generate call sees it. We drop the last
      // section (the one being edited) so afterGenerateThemeSpec will push a
      // fresh one in its place.
      if (section) {
        this.state.specSections = sections.slice(0, -1);
      }
      this.state.recentFeedback = gateReply.feedback
        ? `Edit request for ${section?.themeName ?? 'this theme'}:\n${gateReply.feedback}`
        : this.state.recentFeedback;

      this.state.lastStep = 'generate-theme-spec';
      return [this.buildGenerateThemeSpecTask(themeIdx)];
    }

    return this.nextThemeSpec();
  }

  private afterAssembleSpec(completed: TaskResult): Task[] {
    // The assembled spec markdown — store it for finalize
    this.state.polishedSpec = completed.output;

    // Count requirements from assembled output (R-001, R-002, etc.)
    const reqMatches = completed.output.match(/R-\d{3}/g);
    const uniqueReqs = reqMatches ? new Set(reqMatches).size : 0;
    this.state.requirementCount = uniqueReqs;

    this.state.revisions.push({
      round: this.state.round,
      requirementId: '',
      action: 'added',
      detail: `Final spec assembled from ${(this.state.specSections ?? []).length} theme sections`,
    });

    this.state.lastStep = 'finalize';
    return [this.buildFinalizeTask()];
  }

  // ---------------------------------------------------------------------------
  // Step handlers — Finalize
  // ---------------------------------------------------------------------------

  private afterFinalize(_completed: TaskResult): Task[] {
    this.state.lastStep = 'presentation';
    return [this.buildPresentationTask()];
  }

  private afterPresentation(gateReply: GateReply | undefined): Task[] | null {
    // Skip = user abandoned the spec. Decision F1 / P2.7: mark the
    // session complete so the pipeline unlinks the checkpoint file;
    // nothing left to resume.
    if (!gateReply || gateReply.action === 'skip') {
      this.store?.markSessionComplete();
      return null;
    }

    if (gateReply.action === 'save' && gateReply.feedback) {
      log.info({ feedbackLen: gateReply.feedback.length }, 'afterPresentation: save action received');
      try {
        const opts = JSON.parse(gateReply.feedback);
        const format = opts.format || 'markdown';
        const path = opts.path;
        const repoPath = this.state.input.repoPath || '.';
        const docTitle = this.state.docId || 'brainstorm-spec';
        const mdContent = this.state.polishedSpec || this.state.assembledOutput || '';
        const config = {
          agent: 'brainstorm' as const,
          title: docTitle,
          repoPath,
          markdownContent: mdContent,
          // assembledOutput is already full HTML — pass as htmlContent to avoid double wrapping
          htmlContent: format === 'html' ? (this.state.assembledOutput || undefined) : undefined,
        };
        log.info({ format, path, repoPath, mdContentLen: mdContent.length }, 'afterPresentation: calling saveArtifact');
        const written = saveArtifact(config, format, path);
        log.info({ writtenPath: written.path, size: written.size }, 'afterPresentation: saveArtifact returned');
        // Item 53: stash the resolved save path so the handoff gate can
        // quote it back to the user in the suggested downstream prompt.
        this.state.savedArtifactPath = written.path || path || undefined;
        // Decision H1 -- only mark complete when the save actually
        // resolved. Historically this called markSessionComplete() here
        // and returned null, but Item 53 now routes through a handoff
        // proposal gate first; markSessionComplete() is deferred to the
        // afterHandoffProposal handler so the checkpoint survives in
        // case the user wants to retry the handoff.
        this.state.lastStep = 'handoff-proposal';
        log.info({ category: this.state.category }, 'afterPresentation: emitting handoff-proposal gate');
        return [this.buildHandoffProposalTask()];
      } catch (err) {
        // Decision H1: keep the checkpoint so the user can retry.
        // Stash the error on pendingWarning so the re-emitted gate
        // surfaces it to the user via the shared warning strip.
        // Item 54: recentFeedback is consumed by LLM prompts, not
        // gate rendering -- pendingWarning is the right channel.
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        log.error({ err: msg, stack, feedback: gateReply.feedback }, 'afterPresentation: save failed, re-emitting presentation gate with warning');
        this.state.pendingWarning = `Save failed: ${msg}. Try a different path or format.`;
        return [this.buildPresentationTask()];
      }
    }

    return null;
  }

  /**
   * Item 53: post-save handoff proposal. After the user saves the spec,
   * suggest the downstream agent appropriate for the brainstorm sub-category
   * (requirements / design -> Designer, implementation -> Pair/Delegate,
   * testing -> Tester). The user can Accept (we close the brainstorm
   * session; the UI pre-fills the composer with `/<intent> ...`) or
   * Finish (close with no handoff). `general` category skips the
   * proposal and closes directly -- we have nothing meaningful to hand
   * off to.
   */
  private afterHandoffProposal(gateReply: GateReply | undefined): Task[] | null {
    // Either action closes the session -- the proposal is advisory, and
    // picking the downstream intent happens in the chat panel (the UI
    // reads the accepted action name and pre-fills the composer).
    this.store?.markSessionComplete();
    // Silence the linter -- we examine gateReply for logging only; both
    // branches end the pipeline.
    void gateReply;
    return null;
  }

  /**
   * Return the recommended downstream intent for the current brainstorm
   * category, or `undefined` when no meaningful handoff exists. `design`
   * and `requirements` both go to the Designer agent; `implementation`
   * goes to the coding agents (Pair/Delegate); `testing` goes to the
   * Tester (still in design). `general` has no structured next step.
   */
  private getHandoffIntent(): { intent: string; label: string } | undefined {
    switch (this.state.category) {
      case 'design':
      case 'requirements':
        return { intent: 'design', label: 'Continue with Designer' };
      case 'implementation':
        return { intent: 'implement', label: 'Continue with coding agent' };
      case 'testing':
        return { intent: 'test', label: 'Continue with Tester' };
      case 'general':
      default:
        return undefined;
    }
  }

  private buildHandoffProposalTask(): Task {
    const savedPath = this.state.savedArtifactPath;
    const handoff = this.getHandoffIntent();

    // Compose a short markdown blurb -- the UI renders this via
    // `gate.content` (which goes through renderMarkdown on the daemon
    // side when the task hits gateTaskResult).
    const lines: string[] = [];
    lines.push(`**Spec saved**${savedPath ? ` to \`${savedPath}\`` : ''}.`);
    if (handoff) {
      lines.push('');
      lines.push(`Continue with the **${handoff.label.replace(/^Continue with /, '')}** to turn this into actionable work, or finish here?`);
    } else {
      lines.push('');
      lines.push('Brainstorm is complete. Finish the session or continue in chat.');
    }

    const gateActions = handoff
      ? [
          { name: `continue-${handoff.intent}`, label: handoff.label },
          { name: 'finish', label: 'Finish' },
        ]
      : [{ name: 'finish', label: 'Finish' }];

    return {
      index: this.taskCounter++,
      description: 'Propose downstream agent handoff',
      kind: 'transform',
      intent: 'brainstorm',
      passThrough: true,
      userMessage: lines.join('\n'),
      requiresGate: true,
      // Phase 2 / Item 7: persist so the user can come back and pick
      // the handoff later if the daemon crashes between save and reply.
      persisted: true,
      gateTitle: 'Next step',
      gateActions,
      structured: {
        phase: 'finalize',
        itemType: 'handoff-proposal',
        item: {
          category: this.state.category ?? 'general',
          suggestedIntent: handoff?.intent,
          suggestedLabel: handoff?.label,
          savedPath: savedPath ?? '',
        },
      },
      stateKey: 'handoffProposalOutput',
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 2 resume (Item 7)
  //
  // The daemon's chat.resumeFromCheckpoint handler pre-seeds `this.state`
  // from the checkpoint, then calls `buildResumeTask()` to get the first
  // task to re-emit. For gate-emitting lastSteps we rebuild the exact
  // same gate the user was looking at (via the existing build*Task
  // methods -- they read from state, which has been restored). For
  // in-flight lastSteps (the daemon was mid-LLM-call when it died) we
  // emit a resume-confirm gate (decision G2) so the user picks between
  // retry (re-run the step) and abandon (discard checkpoint, end
  // session). Silently re-running would re-bill cloud tokens and may
  // also re-append duplicate entries to discussion history etc.
  // ---------------------------------------------------------------------------

  /** Steps whose name indicates a gate is open awaiting user reply. */
  private static readonly GATE_EMITTING_STEPS: ReadonlySet<string> = new Set([
    'idea-review',
    'idea-list',
    'idea-discuss',
    'validate-convergence',
    'theme-spec-review',
    'presentation',
    'handoff-proposal',
  ]);

  /** True if `step` is a gate-emitting step (see GATE_EMITTING_STEPS). */
  static isGateEmittingStep(step: string): boolean {
    return BrainstormControllerBase.GATE_EMITTING_STEPS.has(step);
  }

  /**
   * Hydrate `this.state` from a pre-seeded store. Called by the resume
   * path before `buildResumeTask()` so the gate / resume-confirm
   * builders read the same state the user was looking at before the
   * session stopped. The regular (non-resume) path does this lazily in
   * `next()`; we need it eager here because we're emitting a task
   * before the pipeline calls `next()`.
   */
  restoreState(store: TaskStateStore): void {
    const stored = store.get<BrainstormState>('brainstormState');
    if (stored) {
      this.state = stored;
      this.store = store;
    }
  }

  /**
   * Build the first task to run when resuming from a checkpoint.
   *
   * - Gate-emitting lastStep: rebuild the matching gate task. User
   *   lands back on the same pane + card they were looking at.
   * - In-flight lastStep (everything else): emit a resume-confirm gate
   *   so the user explicitly picks retry vs abandon (decision G2).
   *
   * Called from chat-handler after the checkpoint state has been
   * restored into `this.state`. Does NOT mutate state.
   */
  buildResumeTask(): Task {
    const step = this.state.lastStep;
    switch (step) {
      case 'idea-review':
        return this.buildSingleIdeaGate();
      case 'idea-list':
        return this.buildIdeaListGate();
      case 'idea-discuss':
        return this.buildIdeaDiscussGate();
      case 'validate-convergence':
        return this.buildValidateConvergenceTask();
      case 'theme-spec-review':
        return this.buildThemeSpecReviewTask();
      case 'presentation':
        return this.buildPresentationTask();
      case 'handoff-proposal':
        return this.buildHandoffProposalTask();
      default:
        // In-flight or unknown step -- surface the choice to the user.
        return this.buildResumeConfirmTask();
    }
  }

  /**
   * Build the resume-confirm gate task shown when the session was
   * killed mid-LLM-call. The user sees what step was in flight and
   * picks retry (re-run it) or abandon (close the session, delete the
   * checkpoint). See decision G2.
   */
  private buildResumeConfirmTask(): Task {
    // Remember the in-flight step so `afterResumeConfirm` can rebuild
    // the right retry task. We stash it on state under a dedicated key
    // (not lastStep) because state.lastStep is about to be overwritten
    // to 'resume-confirm' so dispatch() routes replies correctly.
    //
    // If state.lastStep is ALREADY 'resume-confirm' (user aborted while
    // the resume-confirm gate was open, then resumed again), prefer the
    // previously-stashed `resumingFromStep` so we don't lose the ORIGINAL
    // in-flight step label across repeated resumes.
    const rawLast = this.state.lastStep ?? 'unknown';
    const inFlightStep = rawLast === 'resume-confirm'
      ? (this.state.resumingFromStep ?? 'unknown')
      : rawLast;
    log.info({
      rawLastStep: rawLast,
      priorResumingFromStep: this.state.resumingFromStep ?? null,
      resolvedInFlightStep: inFlightStep,
    }, 'buildResumeConfirmTask: resolving in-flight step for retry');
    this.state.resumingFromStep = inFlightStep;
    this.state.lastStep = 'resume-confirm';

    const round = this.state.round ?? 1;
    const accepted = this.state.ideas.filter(i => i.status === 'accepted').length;
    const rejected = this.state.ideas.filter(i => i.status === 'rejected').length;
    const parked = this.state.parkedIds.length;
    const themes = this.state.themes?.length ?? 0;

    // Human-readable label for the step the user was mid-execution on.
    const stepLabel = this.resumeStepDescription(inFlightStep);

    const content = [
      `## Resume brainstorm session`,
      '',
      `The session was paused while **${stepLabel}**. Pick up where you left off, or end the session.`,
      '',
      `### Progress so far`,
      `- Round: ${round}`,
      `- Accepted: ${accepted}`,
      `- Rejected: ${rejected}`,
      `- Parked: ${parked}`,
      ...(themes > 0 ? [`- Themes: ${themes}`] : []),
    ].join('\n');

    return {
      index: this.taskCounter++,
      description: `Resume brainstorm session`,
      kind: 'transform',
      intent: 'brainstorm',
      userMessage: content,
      passThrough: true,
      requiresGate: true,
      gateTitle: 'Resume brainstorm',
      gateActions: [
        { name: 'retry', label: 'Retry' },
        { name: 'abandon', label: 'Abandon' },
      ],
      structured: {
        phase: 'resume',
        itemType: 'resume-confirm',
        item: { lastStep: inFlightStep, stepLabel, round, accepted, rejected, parked, themes },
      },
    };
  }

  /**
   * Human-readable label for a brainstorm `lastStep` value, used in the
   * resume-confirm gate body so the user understands what was running.
   */
  private resumeStepDescription(step: string): string {
    switch (step) {
      case 'search-context': return 'searching the codebase for context';
      case 'generate-ideas': return 'generating ideas';
      case 'enhance-ideas-search': return 'searching to ground ideas';
      case 'enhance-ideas-llm': return 'enhancing ideas with code context';
      case 'review-ideas': return 'reviewing ideas';
      case 'refine-ideas': return 'refining ideas based on review';
      case 'converge-cluster': return 'clustering ideas into themes';
      case 'converge-promote': return 'evaluating theme promotions';
      case 'idea-diverge-single': return 'generating a variation of an idea';
      case 'idea-discuss-search': return 'searching to support a discussion';
      case 'idea-discuss-respond': return 'responding in idea discussion';
      case 'search-theme-context': return 'searching theme context';
      case 'generate-theme-spec': return 'writing a per-theme spec section';
      case 'review-theme-spec': return 'reviewing a theme spec section';
      case 'assemble-spec': return 'assembling the final spec';
      case 'finalize': return 'finalizing output';
      default: return `running the '${step}' step`;
    }
  }

  /**
   * Handle the reply to the resume-confirm gate.
   *
   * - `retry`: re-queue the in-flight step that was running. Returns
   *   the next task(s) for the pipeline to execute.
   * - `abandon`: mark the session complete (pipeline deletes the
   *   checkpoint on exit) and return null to stop the pipeline. The
   *   browser's teardown path fires via `agent.discard` separately;
   *   this branch only needs the pipeline-side cleanup.
   */
  private afterResumeConfirm(gateReply: GateReply | undefined): Task[] | null {
    if (!gateReply || gateReply.action === 'abandon') {
      this.store?.markSessionComplete();
      return null;
    }
    if (gateReply.action === 'retry') {
      const inFlightStep = this.state.resumingFromStep;
      // Restore lastStep so the retried task's completion routes
      // through the correct `afterXxx` handler on the next dispatch.
      if (inFlightStep) {
        this.state.lastStep = inFlightStep;
        this.state.resumingFromStep = undefined;
      }
      const retry = this.rebuildInFlightTask(inFlightStep);
      log.info({
        inFlightStep: inFlightStep ?? null,
        retryRebuilt: retry !== null,
      }, 'afterResumeConfirm: retry path');
      if (retry) {
        // Item 45: before the retry task runs, hint the browser to
        // reopen the pane the user was on. The retry task itself is
        // an LLM call that may take minutes and emits no gate until
        // it completes; without this hint the user stares at the
        // chat panel's resolved resume-confirm card the whole time.
        // We prepend a no-op passThrough task whose description is
        // parsed by the browser's progress handler (see
        // brainstormSessionServiceImpl + brainstormFlowContribution).
        const paneKind = this.paneForStep(inFlightStep);
        if (paneKind) {
          const hintTask: Task = {
            index: this.taskCounter++,
            description: `OpenPane:${paneKind}`,
            kind: 'transform',
            intent: 'brainstorm',
            passThrough: true,
            userMessage: '',
          };
          return [hintTask, retry];
        }
        return [retry];
      }
      // Retry not supported for this step -- mark complete so the
      // pipeline exits cleanly rather than spinning on resume-confirm.
      this.store?.markSessionComplete();
      return null;
    }
    // Unknown action -- treat as abandon to avoid silent loops.
    this.store?.markSessionComplete();
    return null;
  }

  /**
   * Item 45: map an in-flight step to the brainstorm pane the user
   * was on when the session paused. Returned string matches the
   * browser's `BrainstormGateKind` vocabulary so the flow
   * contribution can open the matching editor pane preemptively on
   * Retry. Returns undefined for steps with no natural pane (e.g.
   * assemble-spec is a silent long-running task with no prior pane).
   */
  private paneForStep(step: string | undefined): string | undefined {
    switch (step) {
      // Ideation-round LLM steps -- the user was browsing idea cards.
      case 'search-context':
      case 'generate-ideas':
      case 'enhance-ideas-search':
      case 'enhance-ideas-llm':
      case 'review-ideas':
      case 'refine-ideas':
      case 'idea-diverge-single':
        return 'idea';
      // Idea discussion LLM steps -- user was in the discussion pane.
      case 'idea-discuss-search':
      case 'idea-discuss-respond':
        return 'idea-discussion';
      // Convergence LLM steps -- user had just clicked Converge on
      // the idea-list, so the idea-list pane was the last one open.
      case 'converge-cluster':
      case 'converge-promote':
        return 'idea-list';
      // Per-theme spec generation -- user was on the themes pane
      // (just approved the convergence-review gate) or transitioned
      // into the theme-details pane for an earlier theme.
      case 'search-theme-context':
      case 'generate-theme-spec':
      case 'review-theme-spec':
        return 'theme-spec';
      // Final assembly + finalize have no prior pane content worth
      // showing; the presentation pane will open when its gate fires.
      case 'assemble-spec':
      case 'finalize':
      default:
        return undefined;
    }
  }

  /**
   * Rebuild the task for an in-flight `lastStep` so the pipeline can
   * re-run it from scratch. Parametric builders (generate-theme-spec,
   * review-theme-spec) read the current theme index / spec section
   * from state; if state is insufficient we return null and the
   * pipeline ends cleanly (user can retry by restarting the session).
   */
  private rebuildInFlightTask(step: string | undefined): Task | null {
    switch (step) {
      case 'search-context':
        return this.buildSearchContextTask();
      case 'generate-ideas':
        return this.buildGenerateIdeasTask();
      case 'enhance-ideas-search':
        return this.buildEnhanceIdeasSearchTask();
      case 'review-ideas':
        return this.buildReviewIdeasTask();
      case 'converge-cluster':
        return this.buildConvergeClusterTask();
      case 'converge-promote':
        return this.buildConvergePromoteTask();
      case 'assemble-spec':
        return this.buildAssembleSpecTask();
      case 'finalize':
        return this.buildFinalizeTask();

      // Per-theme steps: themeIndex + specSections are persisted on state,
      // so we can rebuild each one without the prior task's output.
      case 'search-theme-context': {
        const themeIdx = this.state.currentThemeIndex ?? 0;
        return this.buildSearchThemeContextTask(themeIdx);
      }
      case 'generate-theme-spec': {
        const themeIdx = this.state.currentThemeIndex ?? 0;
        return this.buildGenerateThemeSpecTask(themeIdx);
      }
      case 'review-theme-spec': {
        // review-theme-spec wants the generate-step content to re-send
        // to Claude. afterGenerateThemeSpec pushed it onto specSections,
        // so pull the last section back out.
        const themeIdx = this.state.currentThemeIndex ?? 0;
        const sections = this.state.specSections ?? [];
        const lastSection = sections[sections.length - 1];
        if (!lastSection) {
          return null;
        }
        return this.buildReviewThemeSpecTask(lastSection.content, themeIdx);
      }

      // Still-parametric steps (Item 7f / 16b): the immediate prior task's
      // output isn't persisted on state so retry can't fully reconstruct.
      // Abandon is the only safe action here.
      case 'enhance-ideas-llm':
      case 'refine-ideas':
      case 'idea-diverge-single':
      case 'idea-discuss-search':
      case 'idea-discuss-respond':
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /** Extract per-idea comments from structured gate feedback and store on ideas. */
  /**
   * Parse the unified IdeaFeedback structure from the gate reply.
   * Returns { items, addedIdeas, hasComments, hasRejections } or null if no structured feedback.
   */
  private parseGateFeedback(gateReply: GateReply | undefined): {
    items: Array<{ id: string; selected: boolean; comment?: string | undefined }>;
    addedIdeas: string[];
    hasComments: boolean;
    hasRejections: boolean;
  } | null {
    if (!gateReply?.feedback) return null;
    try {
      const data = JSON.parse(gateReply.feedback) as Record<string, unknown>;
      const items = Array.isArray(data.items) ? data.items as Array<{ id: string; selected: boolean; comment?: string }> : [];
      const addedIdeas = Array.isArray(data.addedIdeas) ? data.addedIdeas as string[] : [];
      const hasComments = items.some(it => it.comment && it.comment.trim());
      const hasRejections = items.some(it => !it.selected);
      return { items, addedIdeas, hasComments, hasRejections };
    } catch {
      return null;
    }
  }

  /**
   * Apply the unified feedback to state.ideas in one pass.
   * Sets status and userComment per item. Appends addedIdeas.
   */
  // @ts-ignore — will be wired in next iteration
  private _applyGateFeedback(gateReply: GateReply | undefined): {
    addedIdeas: string[];
    hasComments: boolean;
    hasRejections: boolean;
    commentTexts: string[];
  } {
    const fb = this.parseGateFeedback(gateReply);
    if (!fb) return { addedIdeas: [], hasComments: false, hasRejections: false, commentTexts: [] };

    const commentTexts: string[] = [];

    // Apply per-item state
    for (const item of fb.items) {
      // Match by string id (gate sends idea.id)
      const idea = this.state.ideas.find(i => i.id === item.id);
      if (!idea) continue;
      idea.status = item.selected ? 'accepted' : 'rejected';
      if (item.comment && item.comment.trim()) {
        idea.userComment = item.comment.trim();
        commentTexts.push(`[${idea.index}] "${item.comment.trim()}"`);
      } else {
        idea.userComment = undefined;
      }
    }

    // Append user-added ideas — tagged 'user' so LLMs preserve them
    for (const userText of fb.addedIdeas) {
      const periodIdx = userText.indexOf('.');
      const userTitle = periodIdx > 0 && periodIdx <= 80
        ? userText.slice(0, periodIdx + 1).trim()
        : userText.slice(0, 80).trim();
      this.state.ideas.push({
        id: randomBytes(16).toString('hex'),
        index: this.state.nextIdeaIndex++,
        title: userTitle,
        body: userText,
        references: [],
        tags: [],
        round: this.state.round,
        status: 'proposed',
        source: 'user',
        reviewVerdict: 'user',
        feedback: [],
      });
    }

    return {
      addedIdeas: fb.addedIdeas,
      hasComments: fb.hasComments,
      hasRejections: fb.hasRejections,
      commentTexts,
    };
  }

  /** Finalize idea selections: keep accepted, filter out rejected. */
  // @ts-ignore — will be wired in next iteration
  private _finalizeSelections(): void {
    this.state.ideas = this.state.ideas.filter(i => i.status !== 'rejected');
  }

  /** Clear userComment on all ideas after feedback has been incorporated. */
  // @ts-ignore — will be wired in next iteration
  private _clearIncorporatedComments(): void {
    for (const idea of this.state.ideas) {
      if (idea.userComment) idea.userComment = undefined;
    }
  }

  /** Apply Claude's structured idea review to state. */
  private applyIdeaReview(reviewOutput: string): void {
    try {
      const review = JSON.parse(stripFences(reviewOutput));
      if (review.summary) {
        this.state.reviewSummary = review.summary;
      }
      if (Array.isArray(review.ideas)) {
        for (const ri of review.ideas) {
          const idea = this.state.ideas.find(i => i.index === ri.index);
          if (idea) {
            idea.reviewTitle = ri.title;
            idea.reviewDescription = ri.description;
            idea.reviewVerdict = ri.verdict;
            idea.reviewRationale = ri.rationale;
          }
        }
      }
    } catch {
      // If review output isn't valid JSON, store as-is for display
      this.state.reviewSummary = reviewOutput.slice(0, 500);
    }
  }

  // ---------------------------------------------------------------------------
  // Tab builders
  // ---------------------------------------------------------------------------

  /** Build idea tabs for tabbed gate card. */
  // @ts-ignore — will be wired in next iteration
  private _buildIdeaTabs(): GateTab[] {
    const rawSummary = this.state.reviewSummary || this.state.seedAnalysis || '';
    const summary = safeStringifySummary(rawSummary);
    const ideas = this.state.ideas.filter(i => i.status === 'proposed' || i.status === 'accepted');

    return [
      { label: 'Summary', content: summary },
      {
        label: 'Ideas',
        items: ideas.map(i => ({
          id: i.id,
          title: i.reviewTitle || `[${i.index}] ${i.title}`,
          body: i.reviewDescription || i.body,
          verdict: i.reviewVerdict,
          tags: i.tags,
          status: 'pending' as const,
          commentable: true,
          comment: i.userComment || undefined,
        })),
      },
    ];
  }

  /** Build theme tabs for tabbed gate card (convergence review). */
  private buildThemeTabs(): GateTab[] {
    const rawSummary = this.state.specReviewSummary || '';
    const summary = safeStringifySummary(rawSummary);
    return [
      { label: 'Summary', content: summary },
      {
        label: 'Themes',
        items: this.state.themes.map((t, idx) => {
          // Use ideaIds from clustering output — not tag-name matching
          const themeIdeas = t.ideaIds
            .map(id => this.state.ideas.find(i => i.id === id))
            .filter((i): i is NonNullable<typeof i> => i != null);
          const ideaNames = themeIdeas.map(i => `[${i.index}] ${(i.reviewTitle || i.title).slice(0, 120)}`).join('\n');
          return {
            id: idx + 1,
            title: `${t.themeId ? `${t.themeId} — ` : ''}${t.name}`,
            body: `${t.description}\n\n**Ideas:**\n${ideaNames}`,
            status: 'pending' as const,
            commentable: true,
            prioritySelector: true,
          };
        }),
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Task builders — Ideation
  // ---------------------------------------------------------------------------

  /** Build idea generation task. Round 1 = seed, round 2+ = diverge. */
  private buildGenerateIdeasTask(): Task {
    const isFirstRound = this.state.round === 1 && this.state.ideas.length === 0;

    let userMessage = this.state.input.message;

    if (!isFirstRound) {
      // Include existing accepted ideas so the LLM knows what's already
      // in the pool (and doesn't regenerate them).
      const accepted = this.state.ideas.filter(i => i.status === 'accepted');
      if (accepted.length > 0) {
        userMessage += `\n\n## Existing Accepted Ideas (keep in pool, don't restate)\n${formatIdeasForContext(accepted)}`;
      }

      // Rejected ideas: explicit do-not-regenerate signal. Each entry
      // carries the user's reason (or the template string if none was
      // given). The reject action records a feedback entry in
      // idea.feedback[] -- we pull from there so templated rejections
      // are distinguishable from reasoned ones.
      const rejected = this.state.ideas.filter(i =>
        i.status === 'rejected' && (i.feedback ?? []).some(f => f.action === 'reject'),
      );
      if (rejected.length > 0) {
        const lines = rejected.map(i => {
          const rej = (i.feedback ?? []).find(f => f.action === 'reject');
          const suffix = rej?.templated
            ? '-- user gave no reason; assume the concept itself was unwelcome'
            : `-- reason: ${rej?.reason ?? 'unspecified'}`;
          return `- [${i.index}] "${i.title}" ${suffix}`;
        }).join('\n');
        userMessage += `\n\n## Rejected Ideas (do NOT propose similar concepts)\n${lines}`;
      }

      // Directions the user wants explored: each diverge action on an
      // idea carries a per-idea direction. For each, ask the LLM to
      // produce variations of THAT specific idea that incorporate the
      // direction.
      const divergeEntries = this.state.ideas.flatMap(i =>
        (i.feedback ?? [])
          .filter(f => f.action === 'diverge')
          .map(f => ({ idea: i, feedback: f })),
      );
      if (divergeEntries.length > 0) {
        const lines = divergeEntries.map(({ idea, feedback }) =>
          `- from [${idea.index}] "${idea.title}": direction: ${feedback.reason}${feedback.templated ? ' (no direction given -- explore broadly)' : ''}`,
        ).join('\n');
        userMessage += `\n\n## Directions to Explore (produce 2-3 variations of each, incorporating the direction)\n${lines}`;
      }

      // Techniques block is now a fallback -- only used when the
      // directions don't cover a gap. The system prompt tells the
      // LLM to prefer variations over net-new ideas.
      const techniques = selectTechniques(this.state);
      const techniqueBlock = techniques
        .map(t => `### ${t.name}\n${t.prompt}`)
        .join('\n\n');
      userMessage += `\n\n## Additional Techniques (use ONLY if a gap remains after the directions above)\n${techniqueBlock}`;
    }

    // Bulk-diverge path on the idea-list gate stores a single rollup
    // critique in state.recentFeedback. Keep this for round transitions
    // driven by that path; per-idea diverge entries above are the
    // primary mechanism for non-bulk rounds.
    if (this.state.recentFeedback) {
      userMessage += `\n\n## Overall Direction (from bulk diverge)\n${this.state.recentFeedback}`;
    }

    const qnaCtx = buildQnAContext(this.state);
    if (qnaCtx) {
      userMessage += `\n\n${qnaCtx}`;
    }

    // Now that the prompt has captured every feedback entry, clear the
    // per-idea arrays so the next round starts fresh. Historical
    // feedback remains in state.qna for audit. This is the delayed
    // reset; doing it earlier (e.g. in startIdeationRound) would wipe
    // the arrays before we read them.
    for (const i of this.state.ideas) {
      i.feedback = [];
    }

    return {
      index: this.taskCounter++,
      description: isFirstRound
        ? 'Generating ideas...'
        : `Generating more ideas (round ${this.state.round})...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: isFirstRound ? this.getSeedPrompt() : this.getDivergePrompt(),
      userMessage,
      temperature: isFirstRound ? 0.7 : 0.5,
      // On re-run cycles, focus the L3b search on user's new input, not the full composite
      searchHint: (!isFirstRound && this.state.recentFeedback) ? this.state.recentFeedback : undefined,
      resolverAgent: 'brainstorm',
      resolverStep: isFirstRound ? 'seed' : 'diverge',
      stateKey: 'generateIdeasOutput',
    };
  }

  /** Build a Claude review task for ideas. Delta-only on round > 1. */
  private buildReviewIdeasTask(_rawOutput?: string): Task {
    const isFirstRound = this.state.round === 1;

    // On round > 1, only review current-round ideas (delta)
    const ideasToReview = isFirstRound
      ? this.state.ideas
      : this.state.ideas.filter(i => i.round === this.state.round);

    const ideaList = formatIdeasForContext(ideasToReview);

    // On round > 1, include approved ideas as read-only context (not for review)
    const approvedContext = !isFirstRound
      ? this.state.ideas.filter(i => i.status === 'accepted' && i.round < this.state.round)
      : [];
    const approvedSection = approvedContext.length > 0
      ? `\n\n## Already Approved (do NOT re-review)\n${formatIdeasForContext(approvedContext)}`
      : '';

    return {
      index: this.taskCounter++,
      // Item 32a: Claude review is the single longest step in round 1
      // (4-5min on bigger idea sets). Count hints at "how big" so the
      // wait feels bounded.
      description: `Reviewing ${ideasToReview.length} idea${ideasToReview.length === 1 ? '' : 's'} with Claude...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getReviewIdeasPrompt(),
      userMessage: `## Original Problem\n${this.state.input.message}\n\n## Ideas to Review\n${ideaList}${approvedSection}`,
      providerHint: 'claude',
      resolverAgent: 'brainstorm',
      resolverStep: 'review',
      stateKey: 'reviewIdeasOutput',
    };
  }

  /** Build local LLM task to refine ideas based on Claude review verdicts. Delta-only on round > 1. */
  private buildRefineIdeasTask(reviewOutput: string): Task {
    // On round > 1, only refine current-round ideas (delta)
    const ideasToRefine = this.state.round === 1
      ? this.state.ideas
      : this.state.ideas.filter(i => i.round === this.state.round);

    const ideaList = formatIdeasForContext(ideasToRefine);
    return {
      index: this.taskCounter++,
      // Item 32a: idea count gives the user a sense of step size --
      // "Refining 8 ideas" reads as bounded, whereas "Refining ideas"
      // could be anything from 1 to 50.
      description: `Refining ${ideasToRefine.length} idea${ideasToRefine.length === 1 ? '' : 's'} based on review...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getRefineIdeasPrompt(),
      userMessage: `## Original Problem\n${this.state.input.message}\n\n## Ideas with Review Verdicts\n${ideaList}\n\n## Claude Review\n${reviewOutput}`,
      resolverAgent: 'brainstorm',
      resolverStep: 'refine',
      stateKey: 'refineIdeasOutput',
    };
  }

  /** Build the unified idea review gate. */
  /** Build the selectable idea list gate (Phase 3b). */
  private buildIdeaListGate(): Task {
    const allIdeas = this.state.ideas.filter(i => i.status !== 'rejected');
    const accepted = allIdeas.filter(i => i.status === 'accepted');
    const pending = allIdeas.filter(i => i.status === 'proposed');

    const shouldAutoConverge = accepted.length >= AUTO_CONVERGE_THRESHOLD
      || this.state.round >= 2;

    // Build idea items for a selectable list (each row is clickable)
    const items: GateTabItem[] = allIdeas.map(idea => ({
      id: idea.id,
      title: `[${idea.index}] ${idea.title}`,
      status: idea.status === 'accepted' ? 'discussed' as const : 'pending' as const,
      verdict: idea.reviewVerdict ?? undefined,
      tags: idea.tags.length > 0 ? idea.tags : undefined,
    }));

    const content = [
      `## ${this.getIdeaGateTitle()} — Round ${this.state.round}`,
      `${pending.length} pending · ${accepted.length} accepted`,
      '',
      'Click on an idea to discuss it. Use the buttons below to proceed.',
      ...(shouldAutoConverge ? ['', '*Enough ideas gathered — consider converging.*'] : []),
    ].join('\n');

    const warning = this.consumePendingWarning();
    const structured: Record<string, unknown> = {
      phase: 'ideation',
      itemType: 'idea-list',
      // Item 38: include the full idea payloads so the browser's
      // session service can upsert ideas that never fire a per-idea
      // gate (user-added ideas are auto-accepted and skip the review
      // queue -- without this, the pane renders only ideas that
      // arrived via `idea` / `idea-discussion` gates and silently
      // drops user-contributed ones). Send non-rejected ideas;
      // rejected ones are already filtered out of the visible list.
      item: {
        ideas: allIdeas.map(idea => ({
          id: idea.id,
          index: idea.index,
          title: idea.title,
          body: idea.body,
          ...(idea.summary ? { summary: idea.summary } : {}),
          ...(idea.rationale ? { rationale: idea.rationale } : {}),
          references: idea.references,
          tags: idea.tags,
          status: idea.status,
          source: idea.source,
          round: idea.round,
          ...(idea.reviewVerdict ? { reviewVerdict: idea.reviewVerdict } : {}),
          ...(idea.reviewDescription ? { reviewDescription: idea.reviewDescription } : {}),
          ...(idea.reviewRationale ? { reviewRationale: idea.reviewRationale } : {}),
          ...(idea.userComment ? { userComment: idea.userComment } : {}),
        })),
      },
    };
    if (warning) structured.warning = warning;

    return {
      index: this.taskCounter++,
      description: `${this.getIdeaGateTitle()} (round ${this.state.round})`,
      kind: 'transform',
      intent: 'brainstorm',
      userMessage: content,
      passThrough: true,
      requiresGate: true,
      // Phase 2 / Item 7: persist so a mid-round daemon restart doesn't
      // lose the user's per-idea approve/reject decisions captured in
      // state.ideas[].status + state.ideas[].feedback.
      persisted: true,
      gateTitle: `${this.getIdeaGateTitle()} (Round ${this.state.round})`,
      // Item 40: only expose 'accept-remaining' when there's actually
      // something pending. When the reviewQueue is exhausted (user
      // went through every card) the button would be a no-op, which
      // confuses users who expect each visible action to do something.
      gateActions: [
        ...(pending.length > 0 ? [{ name: 'accept-remaining', label: 'Accept remaining' }] : []),
        { name: 'diverge', label: 'Diverge', hint: '<optional direction>' },
        { name: 'converge', label: 'Converge now' },
      ],
      gateTabs: [{
        label: 'Ideas',
        items,
        selectable: true,
      }],
      structured,
      stateKey: 'ideaListOutput',
    };
  }

  /** Build the per-idea discussion gate. */
  private buildIdeaDiscussGate(): Task {
    const idea = this.state.ideas.find(i => i.id === this.state.focusedIdeaId);
    if (!idea) return this.buildIdeaListGate(); // fallback

    // Build discussion history for display
    const historyLines = (this.state.discussionMessages ?? []).map(m =>
      `**${m.role === 'user' ? 'You' : 'Agent'}:** ${m.content}`,
    );

    const content = [
      `## Discussing: [${idea.index}] ${idea.title}: ${idea.body}`,
      '',
      ...(idea.reviewVerdict ? [`**Verdict:** ${idea.reviewVerdict}`] : []),
      ...(idea.reviewRationale ? [`**Rationale:** ${idea.reviewRationale}`] : []),
      ...(idea.tags.length > 0 ? [`**Tags:** ${idea.tags.join(', ')}`] : []),
      ...(idea.references.length > 0 ? [`**Refs:** ${idea.references.map(r => r.label).join(', ')}`] : []),
      '',
      ...(this.state.focusedIdeaContext
        ? ['### Code Context', this.state.focusedIdeaContext, '']
        : []),
      ...(historyLines.length > 0
        ? ['### Discussion', ...historyLines, '']
        : []),
    ].join('\n');

    return {
      index: this.taskCounter++,
      description: `Discussing idea [${idea.index}]`,
      kind: 'transform',
      intent: 'brainstorm',
      userMessage: content,
      passThrough: true,
      requiresGate: true,
      // Phase 2 / Item 7: persist so the discussion history in
      // state.discussionMessages survives across resume.
      persisted: true,
      gateTitle: `Discuss: [${idea.index}] ${idea.title.slice(0, 50)}`,
      gateActions: [
        { name: 'accept', label: 'Accept' },
        { name: 'reject', label: 'Reject' },
        { name: 'refine', label: 'Refine', hint: '<direction>', needsInput: true },
        { name: 'respond', label: 'Discuss', hint: '<your thoughts>', needsInput: true },
        { name: 'back', label: 'Back to list' },
      ],
      // Structured payload mirrors the other brainstorm gates. Without it the
      // chat panel can't classify this as an ideation gate and renders it as a
      // generic gate widget -- leaking brainstorm interactions into chat.
      structured: {
        phase: 'ideation',
        itemType: 'idea-discussion',
        itemId: idea.id,
        item: idea,
        messages: this.state.discussionMessages ?? [],
      },
      stateKey: 'discussGateOutput',
    };
  }

  // ---------------------------------------------------------------------------
  // Task builders — Convergence
  // ---------------------------------------------------------------------------

  private buildConvergeClusterTask(): Task {
    const accepted = this.state.ideas.filter(i => i.status === 'accepted');
    let userMessage = `## Original Problem\n${this.state.input.message}\n\n## Accepted Ideas\n${formatIdeasForContext(accepted)}`;

    if (this.state.themes.length > 0) {
      userMessage += `\n\n## Existing Themes\n${formatThemesForContext(this.state.themes)}`;
    }

    if (this.state.recentFeedback) {
      userMessage += `\n\n## User Feedback\n${this.state.recentFeedback}`;
    }

    return {
      index: this.taskCounter++,
      // Item 32a: show how many ideas are being clustered. Round label
      // stays so Convergence runs in later rounds (refinement) don't
      // look identical to the round-1 cluster.
      description: `Clustering ${accepted.length} idea${accepted.length === 1 ? '' : 's'} into themes (round ${this.state.round})...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getConvergeClusterPrompt(),
      userMessage,
      temperature: 0.3,
      resolverAgent: 'brainstorm',
      resolverStep: 'cluster',
      stateKey: 'clusterOutput',
    };
  }

  private buildConvergePromoteTask(): Task {
    const accepted = this.state.ideas.filter(i => i.status === 'accepted');
    let userMessage = `## Original Problem\n${this.state.input.message}\n\n## Accepted Ideas\n${formatIdeasForContext(accepted)}`;
    userMessage += `\n\n## Themes\n${formatThemesForContext(this.state.themes)}`;

    if (this.state.requirements.length > 0) {
      userMessage += `\n\n## Existing Requirements\n${renderSpecMarkdown(this.state)}`;
    }

    return {
      index: this.taskCounter++,
      description: `Evaluating promotions across ${this.state.themes.length} theme${this.state.themes.length === 1 ? '' : 's'}...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getConvergePromotePrompt(),
      userMessage,
      temperature: 0.3,
      providerHint: 'claude',
      resolverAgent: 'brainstorm',
      resolverStep: 'promote',
      stateKey: 'promoteOutput',
    };
  }

  private buildValidateConvergenceTask(): Task {
    const gaps = identifyGaps(this.state.themes, this.state.ideas);

    const content = [
      '## Themes',
      formatThemesForContext(this.state.themes),
      '',
      '## Promotion Proposals',
      ...this.state.pendingPromotions.map((p, i) =>
        `${i + 1}. **${p.statement.slice(0, 80)}** [${p.type}, ${p.priority}]`,
      ),
      '',
      '## Merge Proposals',
      ...this.state.pendingMerges.map((m, i) =>
        `${i + 1}. Idea → Req ${m.targetRequirementId.slice(0, 8)}: ${m.note || '(no note)'}`,
      ),
      '',
      '## Gaps',
      gaps.length > 0 ? gaps.join('\n') : 'No gaps identified.',
    ].join('\n');

    // Item 13: emit a structured payload so the browser's
    // brainstormSessionService can classify this gate as
    // `kind=convergence-review phase=convergence` instead of the
    // default `kind=unknown phase=waiting`. Without this, the flow
    // contribution drops the gate silently and the user is stranded
    // on the ideas pane after auto-converge.
    return {
      index: this.taskCounter++,
      description: `Convergence Review (round ${this.state.round})`,
      kind: 'transform',
      intent: 'brainstorm',
      userMessage: content,
      requiresGate: true,
      // Phase 2 / Item 7: persist so state.themes + state.pendingPromotions
      // are survivable once the convergence LLM work has run.
      persisted: true,
      gateTitle: this.getConvergenceGateTitle(),
      gateActions: [
        { name: 'approve', label: 'Approve' },
        { name: 'edit', label: 'Edit', hint: '<feedback on promotions>', needsInput: true },
        { name: 'diverge', label: 'Back to diverge', hint: '<focus area>', needsInput: true },
      ],
      gateTabs: this.buildThemeTabs(),
      cyclic: { maxRounds: MAX_EDIT_ROUNDS, retryActions: ['edit'], skipActions: ['diverge'] },
      structured: {
        phase: 'convergence',
        itemType: 'convergence-review',
        item: {
          themes: this.state.themes.map(t => ({
            id: t.id,
            ...(t.themeId !== undefined ? { themeId: t.themeId } : {}),
            name: t.name,
            description: t.description,
            ideaIds: [...t.ideaIds],
            status: 'proposed',
            ...(t.priority !== undefined ? { priority: t.priority } : {}),
            ...(t.userComment !== undefined ? { userComment: t.userComment } : {}),
          })),
          promotions: this.state.pendingPromotions.length,
          merges: this.state.pendingMerges.length,
          gaps,
        },
      },
      stateKey: 'convergenceGateOutput',
    };
  }

  // ---------------------------------------------------------------------------
  // Task builders — Per-theme spec generation (Phase 4)
  // ---------------------------------------------------------------------------

  private buildGenerateThemeSpecTask(themeIdx: number): Task {
    const theme = this.state.themes[themeIdx];
    if (!theme) {
      return {
        index: this.taskCounter++,
        description: 'Skipping missing theme...',
        kind: 'transform',
        intent: 'brainstorm',
        userMessage: 'No theme found.',
        stateKey: 'themeSpecOutput',
      };
    }

    // Gather ideas for this theme
    const themeIdeas = theme.ideaIds
      .map(id => this.state.ideas.find(i => i.id === id))
      .filter((i): i is NonNullable<typeof i> => i != null);

    const ideaContext = themeIdeas.map(i =>
      `[${i.index}] ${i.reviewTitle || i.title}\n${i.reviewDescription || i.body}\nTags: ${i.tags.join(', ')}${i.references.length > 0 ? `\nRefs: ${i.references.map(r => r.label).join(', ')}` : ''}`,
    ).join('\n\n');

    const userMessage = [
      `## Document: ${this.state.docId}`,
      '',
      `## Original Problem`,
      this.state.input.message,
      '',
      `## Theme: ${theme.themeId ?? ''} — ${theme.name}`,
      theme.description,
      ...(theme.userComment ? [`\n**User Comment:** ${theme.userComment}`] : []),
      ...(theme.priority ? [`**Priority:** ${theme.priority}`] : []),
      // `afterThemeSpecReview` stashes user edit feedback in
      // `state.recentFeedback` before re-running generate. Surface it
      // to the prompt so the LLM actually addresses the user's ask
      // instead of regenerating blind.
      ...(this.state.recentFeedback
        ? ['', '## User Edit Feedback', this.state.recentFeedback]
        : []),
      '',
      `## Ideas for This Theme`,
      ideaContext,
      ...((this.state.themeSearchContext || this.state.input.codeContext)
        ? ['', `## Relevant Code Context`, this.state.themeSearchContext || this.state.input.codeContext]
        : []),
    ].join('\n');

    // Item 32a: expose theme position as N/M so multi-theme runs
    // (often 5-8 themes, ~100s each) don't feel like an open-ended
    // wait. Matches how the theme-spec-review gate prefixes its
    // gateTitle.
    const totalThemes = this.state.themes.length;
    const position = `${themeIdx + 1}/${totalThemes}`;

    return {
      index: this.taskCounter++,
      description: `Generating spec (${position}): ${theme.name}...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getThemeSpecPrompt(),
      userMessage,
      temperature: 0.3,
      resolverAgent: 'brainstorm',
      resolverStep: 'theme-spec',
      stateKey: 'themeSpecOutput',
    };
  }

  private buildReviewThemeSpecTask(specSection: string, themeIdx: number): Task {
    const theme = this.state.themes[themeIdx];
    const themeName = theme?.name ?? `Theme ${themeIdx + 1}`;
    // Item 32a: same N/M prefix as the generate task so the pair reads
    // as one per-theme block.
    const totalThemes = this.state.themes.length;
    const position = `${themeIdx + 1}/${totalThemes}`;

    return {
      index: this.taskCounter++,
      description: `Claude reviewing (${position}): ${themeName}...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getReviewThemeSpecPrompt(),
      userMessage: `## Original Problem\n${this.state.input.message}\n\n## Theme: ${themeName}\n\n## Generated Spec Section\n${specSection}`,
      temperature: 0.3,
      maxTokens: 8192,
      providerHint: 'claude',
      resolverAgent: 'brainstorm',
      resolverStep: 'theme-spec-review',
      stateKey: 'themeSpecReviewOutput',
    };
  }

  private buildAssembleSpecTask(): Task {
    const today = new Date().toISOString().slice(0, 10);
    const header = [
      `## Original Problem`,
      this.state.input.message,
      '',
      `## Metadata`,
      `- Document ID: ${this.state.docId}`,
      `- Date: ${today}`,
      `- Author: ${this.state.author ?? 'Unknown'}`,
      '',
    ];

    let body: string[];
    if (this.skipPerThemeSpec()) {
      // Direct assembly: themes + their member ideas, no per-theme spec sections.
      body = this.buildDirectAssemblyContext();
    } else {
      const sections = this.state.specSections ?? [];
      const sectionContent = sections
        .map(s => {
          const heading = s.themeId ? `${s.themeId} -- ${s.themeName}` : s.themeName;
          return `## ${heading}\n\n${s.content}`;
        })
        .join('\n\n---\n\n');
      body = [
        `## Per-Theme Spec Sections (${sections.length} themes)`,
        '',
        sectionContent,
      ];
    }

    // Item 32a: assemble is the single longest step at the end
    // (~10min on big specs) with zero visible movement. Surfacing
    // "stitching N sections into a unified spec" at least tells the
    // user the step size.
    const sectionCount = this.skipPerThemeSpec()
      ? (this.state.themes?.length ?? 0)
      : (this.state.specSections?.length ?? 0);
    const sectionNoun = this.skipPerThemeSpec() ? 'theme' : 'spec section';
    return {
      index: this.taskCounter++,
      description: `Assembling final spec from ${sectionCount} ${sectionNoun}${sectionCount === 1 ? '' : 's'}...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getAssemblePrompt(),
      userMessage: [...header, ...body].join('\n'),
      temperature: 0.2,
      resolverAgent: 'brainstorm',
      resolverStep: 'assemble',
      stateKey: 'assembleSpecOutput',
    };
  }

  /**
   * User message body for direct assembly (when per-theme spec is skipped).
   * Includes each theme with its promoted/accepted ideas inline so the
   * assembly prompt can write a narrative summary without a prior spec pass.
   */
  private buildDirectAssemblyContext(): string[] {
    const themes = this.state.themes ?? [];
    const ideaById = new Map(this.state.ideas.map(i => [i.id, i]));
    const parts: string[] = [`## Themes (${themes.length})`, ''];
    for (const theme of themes) {
      parts.push(`### ${theme.name}`);
      parts.push(theme.description);
      parts.push('');
      parts.push('**Member ideas:**');
      for (const id of theme.ideaIds) {
        const idea = ideaById.get(id);
        if (!idea) { continue; }
        const status = idea.status !== 'proposed' ? ` [${idea.status}]` : '';
        parts.push(`- **${idea.title}**${status}: ${idea.body}`);
      }
      parts.push('');
    }
    return parts;
  }

  // ---------------------------------------------------------------------------
  // Task builders — Finalize
  // ---------------------------------------------------------------------------

  private buildFinalizeTask(): Task {
    const result = assembleDocument(this.state);
    this.state.assembledOutput = result.output;
    this.state.summary = result.summary;

    return {
      index: this.taskCounter++,
      description: 'Assembling final brainstorm document...',
      kind: 'transform',
      intent: 'brainstorm',
      userMessage: result.output,
      stateKey: 'assembledOutput',
      outputFormat: 'html' as TaskFormat,
      persisted: true,
      passThrough: true,
    };
  }

  private buildPresentationTask(): Task {
    const repoPath = this.state.input.repoPath || '.';
    const docTitle = this.state.docId || 'brainstorm-spec';
    const config = {
      agent: 'brainstorm' as const,
      title: docTitle,
      repoPath,
      markdownContent: this.state.assembledOutput || '',
      saveDir: this.getSaveDir(),
    };
    const savePath = defaultSavePath(config, 'markdown');

    // Item 54: surface any pending warning (e.g. previous Save failed)
    // so the pane's shared warning strip renders the reason above the
    // Save form instead of the user seeing a silent re-render.
    const warning = this.consumePendingWarning();
    const structured: Record<string, unknown> = {
      phase: 'finalize',
      itemType: 'presentation',
      item: {
        assembledOutput: this.state.assembledOutput ?? '',
        defaultSavePath: savePath,
      },
    };
    if (warning) structured.warning = warning;

    return {
      index: this.taskCounter++,
      description: 'Review final output',
      kind: 'transform',
      intent: 'brainstorm',
      passThrough: true,
      userMessage: this.state.assembledOutput || '',
      requiresGate: true,
      // Phase 2 / Item 7 + decision H1: keep the checkpoint around
      // through the presentation gate so save-failure retries don't
      // lose the assembled spec. The afterPresentation handler is
      // responsible for calling store.markSessionComplete() on
      // save-success + skip; the pipeline deletes the file on exit.
      persisted: true,
      gateTitle: 'Brainstorm Complete',
      gateActions: [
        { name: 'save', label: 'Save', needsInput: true, hint: 'Review Save Options tab, then submit' },
        { name: 'skip', label: 'Dismiss' },
      ],
      gateTabs: [
        { label: 'Preview', content: this.state.assembledOutput || '', format: 'html' },
        {
          label: 'Save Options',
          saveOptions: {
            formats: ['markdown', 'html'],
            defaultFormat: 'markdown',
            defaultPath: savePath,
          },
        },
      ],
      structured,
      stateKey: 'presentationOutput',
    };
  }
}
