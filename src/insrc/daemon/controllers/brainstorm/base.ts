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
import type { Idea } from '../../../agent/tasks/brainstorm/types.js';

// Category types
import type { BrainstormCategory } from './types.js';

// Parsing & formatting
import { parseSeedOutput, parseIdeaList, selectTechniques } from '../../../agent/tasks/brainstorm/ideas.js';
import { parseClusterOutput, parsePromotionOutput, identifyGaps } from '../../../agent/tasks/brainstorm/convergence.js';
import { renderSpecMarkdown } from '../../../agent/tasks/brainstorm/spec-builder.js';
import { formatIdeasForContext, formatThemesForContext } from '../../../agent/tasks/brainstorm/context-builder.js';
import { assembleDocument } from '../../../agent/tasks/brainstorm/assembly.js';
import { defaultSavePath, saveArtifact } from '../../../agent/tasks/shared/artifact-save.js';

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
      repoPath: '',
      closureRepos: [],
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
  abstract getRefineIdeasPrompt(): string;
  abstract getEnhanceIdeasPrompt(): string;
  abstract getDiscussRespondPrompt(): string;
  abstract getDiscussRefinePrompt(): string;
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

  /** Override to skip per-theme spec generation (e.g., general category). */
  protected skipPerThemeSpec(): boolean { return false; }

  private state!: BrainstormState;
  private taskCounter = 0;

  buildInitialTasks(input: ControllerInput): Task[] {
    this.state = initState(input, this.getDocPrefix());
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
      case 'idea-discuss-search':
        return this.afterIdeaDiscussSearch(completed);
      case 'idea-discuss':
        return this.afterIdeaDiscuss(gateReply);
      case 'idea-discuss-respond':
        return this.afterIdeaDiscussRespond(completed);
      case 'idea-discuss-refine':
        return this.afterIdeaDiscussRefine(completed);

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
      case 'assemble-spec':
        return this.afterAssembleSpec(completed);

      // --- Finalize ---
      case 'finalize':
        return this.afterFinalize(completed);
      case 'presentation':
        return this.afterPresentation(gateReply);

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
      queryParts.push(idea.text.slice(0, 100));
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
      .map(i => i.text.slice(0, 80))
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
        const entities = JSON.parse(completed.output) as Array<{ kind: string; name: string; file: string; body?: string; signature?: string }>;
        if (entities.length > 0) {
          const parts: string[] = [];
          for (const e of entities) {
            const sig = e.signature ? ` — ${e.signature}` : '';
            const body = e.body ? `\n${e.body.slice(0, 300)}` : '';
            parts.push(`[${e.kind}] ${e.name}${sig} (${e.file})${body}`);
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
      description: 'Enhancing ideas with code context...',
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getEnhanceIdeasPrompt(),
      userMessage: `## Original Problem\n${this.state.input.message}\n\n## Ideas to Enhance\n${ideaList}\n\n## Relevant Code Entities\n${codeEntities}`,
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
    );

    // Match enhanced ideas back to originals by POSITION (not index — LLM renumbers from [1])
    const ideasToEnhance = this.state.round === 1
      ? this.state.ideas.filter(i => i.status === 'proposed')
      : this.state.ideas.filter(i => i.round === this.state.round);

    for (let pos = 0; pos < enhanced.length && pos < ideasToEnhance.length; pos++) {
      const enh = enhanced[pos]!;
      const original = ideasToEnhance[pos]!;
      original.text = enh.text;
      if (enh.codeRefs.length > 0) original.codeRefs = enh.codeRefs;
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
    );

    // Keep accepted ideas from prior rounds only
    const priorAccepted = this.state.ideas.filter(i => i.status === 'accepted' && i.round < this.state.round);

    // Build verdict map from pre-refine ideas (keyed by text prefix for fuzzy match)
    const verdictMap = new Map<string, { verdict: 'strong' | 'moderate' | 'weak' | 'user'; source: 'llm' | 'user' }>();
    for (const idea of this.state.ideas) {
      if (idea.reviewVerdict) {
        verdictMap.set(idea.text.slice(0, 50).toLowerCase(), {
          verdict: idea.reviewVerdict,
          source: idea.source,
        });
      }
    }

    // Renumber refined ideas and carry forward verdicts
    const startIndex = priorAccepted.length > 0 ? Math.max(...priorAccepted.map(i => i.index)) + 1 : 1;
    for (let i = 0; i < refinedIdeas.length; i++) {
      refinedIdeas[i]!.index = startIndex + i;
      const match = verdictMap.get(refinedIdeas[i]!.text.slice(0, 50).toLowerCase());
      if (match) {
        refinedIdeas[i]!.reviewVerdict = match.verdict;
        refinedIdeas[i]!.source = match.source;
      } else {
        // New or heavily rewritten idea — survived refine so at least strong
        refinedIdeas[i]!.reviewVerdict = 'strong';
      }
    }

    // Unified merge — no special-casing for user ideas
    this.state.ideas = [...priorAccepted, ...refinedIdeas];
    this.state.nextIdeaIndex = Math.max(...this.state.ideas.map(i => i.index), 0) + 1;

    this.state.lastStep = 'idea-list';
    return [this.buildIdeaListGate()];
  }

  // ---------------------------------------------------------------------------
  // Step handlers — Idea List + Per-Idea Discussion (Phase 3b)
  // ---------------------------------------------------------------------------

  /** Handle user action from the idea list gate. */
  private afterIdeaList(gateReply: GateReply | undefined): Task[] {
    if (!gateReply || gateReply.action === 'accept-remaining') {
      return this.handleIdeaApprove();
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
        description: `Searching codebase for "${idea.text.slice(0, 40)}..."`,
        kind: 'rpc',
        intent: 'brainstorm',
        rpcMethod: 'search.query',
        rpcParams: { text: idea.text.slice(0, 200), limit: 10, filter: 'code' },
        stateKey: 'discussSearchOutput',
      }];
    }

    if (gateReply.action === 'diverge') {
      // Remove rejected ideas, build feedback, start new round
      const rejected = this.state.ideas.filter(i => i.status === 'rejected');
      const feedbackParts: string[] = [];
      if (rejected.length > 0) {
        feedbackParts.push(`User rejected ${rejected.length} idea(s): ${rejected.map(i => `[${i.index}] ${i.text.slice(0, 60)}`).join('; ')}`);
      }
      if (gateReply.feedback && gateReply.feedback !== rejected[0]?.id) {
        feedbackParts.push(gateReply.feedback);
      }
      this.state.recentFeedback = feedbackParts.join('\n');
      this.state.ideas = this.state.ideas.filter(i => i.status !== 'rejected');
      this.state.nextIdeaIndex = Math.max(...this.state.ideas.map(i => i.index), 0) + 1;
      this.state.round += 1;
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
      return this.exitDiscussion();
    }

    if (gateReply.action === 'reject') {
      idea.status = 'rejected';
      return this.exitDiscussion();
    }

    if (gateReply.action === 'refine') {
      // User wants the idea refined based on discussion
      const userMsg = gateReply.feedback ?? 'Please refine this idea based on our discussion.';
      this.addDiscussionMessage('user', userMsg);

      this.state.lastStep = 'idea-discuss-refine';
      return [{
        index: this.taskCounter++,
        description: 'Refining idea based on discussion...',
        kind: 'llm',
        intent: 'brainstorm',
        systemPrompt: this.getDiscussRefinePrompt(),
        userMessage: this.buildDiscussionContext(idea, userMsg),
        stateKey: 'discussRefineOutput',
      }];
    }

    if (gateReply.action === 'respond') {
      // User sent a discussion message (via inject or direct input)
      const userMsg = gateReply.feedback ?? '';
      if (!userMsg) return [this.buildIdeaDiscussGate()];

      this.addDiscussionMessage('user', userMsg);

      this.state.lastStep = 'idea-discuss-respond';
      return [{
        index: this.taskCounter++,
        description: 'Thinking about this idea...',
        kind: 'llm',
        intent: 'brainstorm',
        systemPrompt: this.getDiscussRespondPrompt(),
        userMessage: this.buildDiscussionContext(idea, userMsg),
        stateKey: 'discussRespondOutput',
      }];
    }

    return this.exitDiscussion();
  }

  /** After LLM responds to discussion message, re-present discussion gate. */
  private afterIdeaDiscussRespond(completed: TaskResult): Task[] {
    this.addDiscussionMessage('assistant', completed.output);
    this.state.lastStep = 'idea-discuss';
    return [this.buildIdeaDiscussGate()];
  }

  /** After LLM refines idea, update idea text, re-present discussion gate. */
  private afterIdeaDiscussRefine(completed: TaskResult): Task[] {
    const idea = this.state.ideas.find(i => i.id === this.state.focusedIdeaId);
    if (idea) {
      // Parse refined idea output — extract text/tags/refs from the single line
      const refined = parseIdeaList(
        completed.output,
        this.state.round,
        idea.index,
        this.state.input.repoPath || 'unknown',
      );
      if (refined.length > 0) {
        idea.text = refined[0]!.text;
        if (refined[0]!.tags.length > 0) idea.tags = refined[0]!.tags;
        if (refined[0]!.codeRefs.length > 0) idea.codeRefs = refined[0]!.codeRefs;
      }
      this.addDiscussionMessage('assistant', `Refined: ${idea.text}`);
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
      `## Idea Being Discussed\n[${idea.index}] ${idea.text}`,
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

    this.state.round += 1;
    return this.startIdeationRound();
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
      ...themeIdeas.slice(0, 3).map(i => i.text.slice(0, 60)),
    ].join(' ').slice(0, 500);

    return {
      index: this.taskCounter++,
      description: `Searching codebase for ${theme.name}...`,
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
      // Claude may return a polished markdown version or JSON with polishedSection
      try {
        const review = JSON.parse(stripFences(completed.output));
        if (review.polishedSection) {
          lastSection.content = review.polishedSection;
        }
        // Otherwise keep the original markdown from the generate step
      } catch {
        // Non-JSON output — if it looks like markdown (contains |, #, or -), use it as replacement
        const trimmed = completed.output.trim();
        if (trimmed.includes('|') || trimmed.startsWith('#') || trimmed.startsWith('-')) {
          lastSection.content = trimmed;
        }
      }
      lastSection.reviewed = true;
    }
    this.state.specSections = sections;

    // Next theme or assemble
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
    if (!gateReply || gateReply.action === 'skip') {
      return null;
    }

    if (gateReply.action === 'save' && gateReply.feedback) {
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
        saveArtifact(config, format, path);
      } catch {
        // Invalid feedback JSON — skip save
      }
    }

    return null;
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
    for (const text of fb.addedIdeas) {
      this.state.ideas.push({
        id: randomBytes(16).toString('hex'),
        index: this.state.nextIdeaIndex++,
        text,
        tags: [],
        codeRefs: [],
        round: this.state.round,
        status: 'proposed',
        source: 'user',
        reviewVerdict: 'user',
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
          title: i.reviewTitle || `[${i.index}] ${i.text.slice(0, 80)}`,
          body: i.reviewDescription || i.text,
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
          const ideaNames = themeIdeas.map(i => `[${i.index}] ${(i.reviewTitle || i.text).slice(0, 120)}`).join('\n');
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
      // Include existing accepted ideas for diverge rounds
      const accepted = this.state.ideas.filter(i => i.status === 'accepted');
      if (accepted.length > 0) {
        userMessage += `\n\n## Existing Accepted Ideas\n${formatIdeasForContext(accepted)}`;
      }

      // Add techniques for diverge
      const techniques = selectTechniques(this.state);
      const techniqueBlock = techniques
        .map(t => `### ${t.name}\n${t.prompt}`)
        .join('\n\n');
      userMessage += `\n\n## Techniques to Apply\n${techniqueBlock}`;
    }

    if (this.state.recentFeedback) {
      userMessage += `\n\n## User Direction\n${this.state.recentFeedback}`;
    }

    const qnaCtx = buildQnAContext(this.state);
    if (qnaCtx) {
      userMessage += `\n\n${qnaCtx}`;
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
      description: 'Reviewing ideas with Claude...',
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getReviewIdeasPrompt(),
      userMessage: `## Original Problem\n${this.state.input.message}\n\n## Ideas to Review\n${ideaList}${approvedSection}`,
      providerHint: 'claude',
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
      description: 'Refining ideas based on review...',
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getRefineIdeasPrompt(),
      userMessage: `## Original Problem\n${this.state.input.message}\n\n## Ideas with Review Verdicts\n${ideaList}\n\n## Claude Review\n${reviewOutput}`,
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
      title: `[${idea.index}] ${idea.text.slice(0, 80)}${idea.text.length > 80 ? '...' : ''}`,
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

    return {
      index: this.taskCounter++,
      description: `${this.getIdeaGateTitle()} (round ${this.state.round})`,
      kind: 'transform',
      intent: 'brainstorm',
      userMessage: content,
      passThrough: true,
      requiresGate: true,
      gateTitle: `${this.getIdeaGateTitle()} (Round ${this.state.round})`,
      gateActions: [
        { name: 'accept-remaining', label: 'Accept remaining' },
        { name: 'diverge', label: 'Diverge', hint: '<optional direction>' },
        { name: 'converge', label: 'Converge now' },
      ],
      gateTabs: [{
        label: 'Ideas',
        items,
        selectable: true,
      }],
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
      `## Discussing: [${idea.index}] ${idea.text}`,
      '',
      ...(idea.reviewVerdict ? [`**Verdict:** ${idea.reviewVerdict}`] : []),
      ...(idea.reviewRationale ? [`**Rationale:** ${idea.reviewRationale}`] : []),
      ...(idea.tags.length > 0 ? [`**Tags:** ${idea.tags.join(', ')}`] : []),
      ...(idea.codeRefs.length > 0 ? [`**Refs:** ${idea.codeRefs.join(', ')}`] : []),
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
      gateTitle: `Discuss: [${idea.index}] ${idea.text.slice(0, 50)}`,
      gateActions: [
        { name: 'accept', label: 'Accept' },
        { name: 'reject', label: 'Reject' },
        { name: 'refine', label: 'Refine', hint: '<direction>', needsInput: true },
        { name: 'respond', label: 'Discuss', hint: '<your thoughts>', needsInput: true },
        { name: 'back', label: 'Back to list' },
      ],
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
      description: `Clustering ideas into themes (round ${this.state.round})...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getConvergeClusterPrompt(),
      userMessage,
      temperature: 0.3,
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
      description: 'Evaluating promotions...',
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getConvergePromotePrompt(),
      userMessage,
      temperature: 0.3,
      providerHint: 'claude',
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

    return {
      index: this.taskCounter++,
      description: `Convergence Review (round ${this.state.round})`,
      kind: 'transform',
      intent: 'brainstorm',
      userMessage: content,
      requiresGate: true,
      gateTitle: this.getConvergenceGateTitle(),
      gateActions: [
        { name: 'approve', label: 'Approve' },
        { name: 'edit', label: 'Edit', hint: '<feedback on promotions>', needsInput: true },
        { name: 'diverge', label: 'Back to diverge', hint: '<focus area>', needsInput: true },
      ],
      gateTabs: this.buildThemeTabs(),
      cyclic: { maxRounds: MAX_EDIT_ROUNDS, retryActions: ['edit'], skipActions: ['diverge'] },
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
      `[${i.index}] ${i.reviewTitle || i.text}\n${i.reviewDescription || ''}\nTags: ${i.tags.join(', ')}${i.codeRefs.length > 0 ? `\nRefs: ${i.codeRefs.join(', ')}` : ''}`,
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
      '',
      `## Ideas for This Theme`,
      ideaContext,
      ...((this.state.themeSearchContext || this.state.input.codeContext)
        ? ['', `## Relevant Code Context`, this.state.themeSearchContext || this.state.input.codeContext]
        : []),
    ].join('\n');

    return {
      index: this.taskCounter++,
      description: `Generating spec: ${theme.name}...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getThemeSpecPrompt(),
      userMessage,
      temperature: 0.3,
      stateKey: 'themeSpecOutput',
    };
  }

  private buildReviewThemeSpecTask(specSection: string, themeIdx: number): Task {
    const theme = this.state.themes[themeIdx];
    const themeName = theme?.name ?? `Theme ${themeIdx + 1}`;

    return {
      index: this.taskCounter++,
      description: `Claude reviewing: ${themeName}...`,
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getReviewThemeSpecPrompt(),
      userMessage: `## Original Problem\n${this.state.input.message}\n\n## Theme: ${themeName}\n\n## Generated Spec Section\n${specSection}`,
      temperature: 0.3,
      maxTokens: 8192,
      providerHint: 'claude',
      stateKey: 'themeSpecReviewOutput',
    };
  }

  private buildAssembleSpecTask(): Task {
    const sections = this.state.specSections ?? [];
    const sectionContent = sections
      .map(s => {
        const heading = s.themeId ? `${s.themeId} — ${s.themeName}` : s.themeName;
        return `## ${heading}\n\n${s.content}`;
      })
      .join('\n\n---\n\n');

    const today = new Date().toISOString().slice(0, 10);
    const userMessage = [
      `## Original Problem`,
      this.state.input.message,
      '',
      `## Metadata`,
      `- Document ID: ${this.state.docId}`,
      `- Date: ${today}`,
      `- Author: ${this.state.author ?? 'Unknown'}`,
      '',
      `## Per-Theme Spec Sections (${sections.length} themes)`,
      '',
      sectionContent,
    ].join('\n');

    return {
      index: this.taskCounter++,
      description: 'Assembling final spec...',
      kind: 'llm',
      intent: 'brainstorm',
      systemPrompt: this.getAssemblePrompt(),
      userMessage,
      temperature: 0.2,
      stateKey: 'assembleSpecOutput',
    };
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

    return {
      index: this.taskCounter++,
      description: 'Review final output',
      kind: 'transform',
      intent: 'brainstorm',
      passThrough: true,
      userMessage: this.state.assembledOutput || '',
      requiresGate: true,
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
      stateKey: 'presentationOutput',
    };
  }
}
