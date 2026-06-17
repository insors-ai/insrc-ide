/**
 * Context Assembler — orchestrates the layered memory model.
 *
 * Manages the full lifecycle of context assembly per turn:
 *   L1: System context (static, built once)
 *   L2: Rolling summary (updated on eviction)
 *   L3a: Recent turns (recency-weighted)
 *   L3b: Semantic history (embedding similarity)
 *   L4: Task context (code entities from graph)
 *
 * Public API:
 *   ContextManager — stateful manager instantiated per session
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import type { AssembledContext } from './budget.js';
import { createBudget, type TokenBudget } from './budget.js';
import { buildSystemContext, type SystemContextOpts } from './system.js';
import { evictToSummary, type ConversationTurn } from './summary.js';
import { weightedRecent, weightedRecentTurns, getEvictable, MAX_RECENT_TURNS } from './recent.js';
import { SemanticHistory, embedText } from './semantic.js';
import { fetchTaskContext, resetSeenCounts, type DisclosureContext } from './task.js';
import { fitToBudget, type RawLayers } from './overflow.js';
import { buildOwnerPreferencesSection, type PreferenceCandidate } from './preferences.js';

export { type AssembledContext } from './budget.js';
export { type ConversationTurn } from './summary.js';
export { initSession } from './task.js';

const log = getLogger('agent:context');

export class ContextManager {
  private systemText: string;
  /**
   * G9 of design/memory-context.html: active-owner preferences merged into the
   * L1 system segment. Built lazily on the first assemble after construction
   * OR after a substrate FeedbackBus mutation. Cached across turns until
   * invalidated.
   */
  private preferencesText = '';
  private preferencesStale = true;
  private feedbackUnsubscribe: (() => void) | undefined;
  private summary = '';
  private readonly recentTurns: ConversationTurn[] = [];
  private readonly semanticHistory = new SemanticHistory();
  private readonly closureRepos: string[];
  private readonly repoPath: string;
  private readonly provider: LLMProvider;
  private readonly budget: TokenBudget;
  /** Entity IDs from the most recent L4 fetch — stored in turn on recordTurn(). */
  private lastEntityIds: string[] = [];
  /** Tagged outputs from pipelines — stored in L2 for cross-pipeline reference. */
  private readonly tags = new Map<string, string>();
  /** Active plan step body injected into L4 context each turn. */
  private activePlanStepContext = '';
  /** Text content from attachments, injected into L4 context for the current turn. */
  private attachmentContext = '';

  constructor(opts: SystemContextOpts & { closureRepos: string[]; provider: LLMProvider; contextWindowSize?: number | undefined }) {
    this.systemText = buildSystemContext(opts);
    this.closureRepos = opts.closureRepos;
    this.repoPath = opts.repoPath;
    this.provider = opts.provider;
    this.budget = createBudget(opts.contextWindowSize ?? 32_768);

    // G9: subscribe to the substrate's FeedbackBus for the active owner so
    // captured preferences invalidate the L1 cache. Skipped when the substrate
    // runtime isn't available (test paths without `initSubstrateRuntime`).
    void this.maybeSubscribeToFeedbackBus();
  }

  /** Tear down the FeedbackBus subscription. Idempotent. */
  dispose(): void {
    if (this.feedbackUnsubscribe !== undefined) {
      try { this.feedbackUnsubscribe(); } catch { /* swallow */ }
      this.feedbackUnsubscribe = undefined;
    }
  }

  private async maybeSubscribeToFeedbackBus(): Promise<void> {
    try {
      const mod = await import('../../daemon/substrate/singleton.js');
      if (!mod.hasSubstrateRuntime()) {
        log.debug('substrate runtime not initialised; preferences slice disabled');
        return;
      }
      const runtime = mod.getSubstrateRuntime();
      const sub = runtime.feedbackBus.subscribe(mod.AGENT_CHAT_OWNER, async () => {
        // Any mutation on agent:chat -> invalidate the preferences cache so the
        // next assemble rebuilds. Per-event filtering is unnecessary: every
        // event for this owner means the preferences set may have changed.
        this.preferencesStale = true;
      });
      this.feedbackUnsubscribe = sub.unsubscribe.bind(sub);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'failed to subscribe to substrate FeedbackBus; preferences cache will not auto-invalidate');
    }
  }

  /**
   * Rebuild the preferences slice from the substrate. Called on first assemble
   * after invalidation. Quietly returns '' when the substrate isn't available.
   */
  private async refreshPreferences(userMessage: string): Promise<void> {
    try {
      const mod = await import('../../daemon/substrate/singleton.js');
      if (!mod.hasSubstrateRuntime()) {
        this.preferencesText = '';
        this.preferencesStale = false;
        return;
      }
      const runtime = mod.getSubstrateRuntime();
      const ns = runtime.memory.scope(mod.AGENT_CHAT_OWNER, 'user-assertions');
      const candidates: PreferenceCandidate[] = [];
      // Use noise threshold per G7 -- entries with confidence below this are
      // suppressed at retrieval. Default 0.30 matches the setting default.
      const noiseThreshold = 0.30;
      for await (const entry of ns.scan<Record<string, unknown>>('')) {
        if (entry.kind !== 'constraint') { continue; }
        if (entry.confidence < noiseThreshold) { continue; }
        const v = entry.value as Record<string, unknown>;
        const subject = (typeof v.preferenceSubject === 'string' ? v.preferenceSubject : undefined)
          ?? (typeof v.subject === 'string' ? v.subject : undefined);
        const canonicalText = (typeof v.canonicalText === 'string' ? v.canonicalText : undefined)
          ?? (typeof v.text === 'string' ? v.text : undefined);
        if (subject === undefined || canonicalText === undefined) { continue; }
        candidates.push({
          subject,
          canonicalText,
          confidence: entry.confidence,
          ...(Array.isArray(v.categories) ? { categories: v.categories as string[] } : {}),
          ...(Array.isArray(v.repoPaths)  ? { repoPaths:  v.repoPaths  as string[] } : {}),
        });
      }
      if (candidates.length === 0) {
        this.preferencesText = '';
        this.preferencesStale = false;
        return;
      }
      const topic = this.buildSessionTopic(userMessage);
      this.preferencesText = await buildOwnerPreferencesSection({
        candidates,
        repoPath:      this.repoPath,
        sessionTopic:  topic,
        localProvider: this.provider,
      });
      this.preferencesStale = false;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'refreshPreferences failed; L1 will omit preferences');
      this.preferencesText = '';
      this.preferencesStale = false;
    }
  }

  /**
   * Build a short "session rolling topic" string for the G5-style relevance
   * curator. Pulls the current user message + the rolling summary + the
   * single most-recent turn to give the curator enough signal without
   * dumping the whole conversation.
   */
  private buildSessionTopic(userMessage: string): string {
    const parts: string[] = [];
    if (userMessage.trim().length > 0) {
      parts.push(`Current user message: ${userMessage.trim().slice(0, 500)}`);
    }
    if (this.summary.length > 0) {
      parts.push(`Recent summary: ${this.summary.slice(0, 500)}`);
    }
    const last = this.recentTurns[0];
    if (last !== undefined) {
      parts.push(`Last turn user: ${last.userMessage.slice(0, 200)}`);
    }
    return parts.join('\n');
  }

  /**
   * Record a completed turn. Handles eviction to L2 summary automatically.
   * Merges entity IDs from the last L4 fetch into the turn.
   */
  async recordTurn(turn: ConversationTurn, embedding: number[]): Promise<void> {
    // Merge entity IDs from the most recent L4 context fetch
    if (this.lastEntityIds.length > 0 && turn.entityIds.length === 0) {
      turn.entityIds = this.lastEntityIds;
    }
    this.lastEntityIds = [];

    // Add to recent turns (newest first)
    this.recentTurns.unshift(turn);

    // Store in semantic history with embedding
    this.semanticHistory.add(turn, embedding);

    // Evict overflow turns to summary
    const evictable = getEvictable(this.recentTurns);
    for (const evicted of evictable) {
      this.summary = await evictToSummary(this.summary, evicted, this.provider);
    }
    // Remove evicted turns from recent
    if (evictable.length > 0) {
      this.recentTurns.splice(MAX_RECENT_TURNS);
    }
  }

  /**
   * Assemble full context for one LLM turn.
   *
   * The queryEmbedding is the embedding of the current user message,
   * computed once and shared between L3b retrieval and L4 code search.
   */
  async assemble(userMessage: string, queryEmbedding: number[]): Promise<AssembledContext> {
    // G9: refresh the preferences slice if it's stale. The static system text
    // is built once in the constructor; preferences are layered on top with
    // event-driven invalidation. Refresh is synchronous (per accuracy-first)
    // so the next turn sees the latest preferences.
    if (this.preferencesStale) {
      await this.refreshPreferences(userMessage);
    }

    // L3a: Recent turns (recency-weighted)
    const recentBlocks = weightedRecent(this.recentTurns);

    // L3b: Semantic history (similarity-based)
    const semanticBlocks = this.semanticHistory.retrieve(queryEmbedding);

    // Build disclosure context for progressive entity disclosure
    const disclosure = this.buildDisclosureContext(queryEmbedding);

    // L4: Task context (code entities from graph search)
    const taskResult = await fetchTaskContext(userMessage, this.closureRepos, disclosure);
    this.lastEntityIds = taskResult.entityIds;

    // Extract entity names mentioned in the user message for overflow preservation
    const preservedNames = extractEntityNames(userMessage);

    // Prepend attachment text to code blocks (counts against L4 budget)
    const codeBlocks = this.attachmentContext
      ? [`## Attached Files\n${this.attachmentContext}`, ...taskResult.blocks]
      : taskResult.blocks;

    // Clear attachment context after use (single-turn only)
    this.attachmentContext = '';

    // G9: L1 system block = static instructions + active-owner preferences.
    const composedSystem = this.preferencesText.length > 0
      ? `${this.systemText}\n\n${this.preferencesText}`
      : this.systemText;

    const raw: RawLayers = {
      system: composedSystem,
      summary: this.summary,
      recent: recentBlocks,
      semantic: semanticBlocks,
      code: codeBlocks,
      preservedNames: preservedNames.size > 0 ? preservedNames : undefined,
    };

    return fitToBudget(raw, this.budget);
  }

  /** Build disclosure context from L3a and L3b entity IDs. */
  private buildDisclosureContext(queryEmbedding: number[]): DisclosureContext {
    // Collect entity IDs from recent turns (L3a)
    const recentEntityIds = new Set<string>();
    for (const turn of this.recentTurns) {
      for (const id of turn.entityIds) {
        recentEntityIds.add(id);
      }
    }

    // Collect entity IDs from semantic history turns (L3b)
    const semanticEntityIds = new Set<string>();
    const semanticTurns = this.semanticHistory.retrieveTurns(queryEmbedding);
    for (const turn of semanticTurns) {
      for (const id of turn.entityIds) {
        semanticEntityIds.add(id);
      }
    }

    return { recentEntityIds, semanticEntityIds };
  }

  /**
   * Build LLM messages from assembled context.
   * Returns [system, ...history context as user message, current user message].
   */
  buildMessages(assembled: AssembledContext, userMessage: string): LLMMessage[] {
    const messages: LLMMessage[] = [];

    // L1: System
    messages.push({ role: 'system', content: assembled.system.text });

    // L2 + L3b + L4: Summary, semantic history, and code as context preamble.
    // Each session-coupled block is explicitly framed as BACKGROUND so the
    // model doesn't latch onto the most concrete signal in the preamble
    // (e.g. an OCR-heavy prior session) when the current request itself is
    // generic. Live testing 2026-04-29: a fresh `/code-analyze` pulled
    // OCR-flavoured plans into a totally unrelated repo because the recent
    // turns described an OCR feature -- the planner LLM treated those as
    // signal rather than context.
    const contextParts: string[] = [];
    if (assembled.summary.text) {
      contextParts.push(
        `## Session Summary (BACKGROUND ONLY)\n` +
        `Prior topics in this session, for continuity reference. NOT the current request. ` +
        `Do not carry the subject matter into the response unless the user's request below explicitly invokes it.\n\n` +
        assembled.summary.text
      );
    }
    if (assembled.semantic.text) {
      contextParts.push(
        `## Related Past Exchanges (BACKGROUND ONLY)\n` +
        `Past turns retrieved by similarity to the current message -- shown only because the embedding matched, ` +
        `not because the user is asking about them. NOT the current request. ` +
        `Do not let their topic, scope, or focus bias what you do here.\n\n` +
        assembled.semantic.text
      );
    }
    if (assembled.code.text) {
      contextParts.push(`## Relevant Code\n${assembled.code.text}`);
    }
    if (this.activePlanStepContext) {
      contextParts.push(`## Active Plan Step\n${this.activePlanStepContext}`);
    }

    // L3a: Recent conversation turns (for continuity)
    const structuredTurns = weightedRecentTurns(this.recentTurns);
    if (structuredTurns.length > 0) {
      // Condense recent turns into a single context block, not separate messages
      const turnSummaries: string[] = [];
      for (let i = structuredTurns.length - 1; i >= 0; i--) {
        const turn = structuredTurns[i]!;
        const assistantSnippet = turn.assistantResponse
          ? turn.assistantResponse.replace(/<[^>]+>/g, '').slice(0, 200)
          : '(no response)';
        turnSummaries.push(`User: ${turn.userMessage.slice(0, 150)}\nAssistant: ${assistantSnippet}`);
      }
      contextParts.push(
        `## Recent Conversation (BACKGROUND ONLY)\n` +
        `Recent turns from this session, shown for tonal continuity only. NOT the current request and ` +
        `MUST NOT influence the topic, scope, entities, or focus of your response. ` +
        `Treat the current request below on its own merits, even if it is brief or generic.\n\n` +
        turnSummaries.join('\n\n')
      );
    }

    if (contextParts.length > 0) {
      messages.push({ role: 'user', content: contextParts.join('\n\n') });
      messages.push({
        role: 'assistant',
        content:
          `Understood. The blocks above are BACKGROUND context only. ` +
          `I will respond to the upcoming user request on its own merits, ` +
          `without carrying over topics, entities, or focus from prior turns ` +
          `unless the user's request explicitly invokes them.`,
      });
    }

    // Current user message -- this is the ONLY thing to act on. Prefixed so
    // the model has a clear delimiter between background and the live ask.
    messages.push({
      role: 'user',
      content: contextParts.length > 0
        ? `## Current Request (act on this only)\n${userMessage}`
        : userMessage,
    });

    return messages;
  }

  /**
   * Embed user message text. Single call shared between L3b and L4.
   */
  async embedQuery(text: string): Promise<number[]> {
    return embedText(this.provider, text);
  }

  /**
   * Seed L2 summary from prior session summaries.
   * Called once at session start after cross-session retrieval.
   */
  seedSummary(text: string): void {
    if (text) this.summary = text;
  }

  /**
   * Hydrate L3b semantic history from persisted turns.
   * Called once at session start to populate semantic history from prior sessions.
   */
  hydrateFromHistory(turns: Array<{ user: string; assistant: string; entities: string[]; vector: number[] }>): void {
    for (const t of turns) {
      const turn: ConversationTurn = {
        userMessage: t.user,
        assistantResponse: t.assistant,
        entityIds: t.entities,
      };
      this.semanticHistory.add(turn, t.vector);
    }
  }

  /**
   * Restore L3a recent turns from persisted data.
   * Called during session restore to populate the recent turns window.
   * Turns should be in chronological order (oldest first); they are
   * stored newest-first internally (last element = oldest).
   */
  restoreRecentTurns(turns: Array<{ user: string; assistant: string; entities: string[] }>): void {
    this.recentTurns.length = 0;
    // Take the last MAX_RECENT_TURNS turns, store newest-first
    const recent = turns.slice(-MAX_RECENT_TURNS);
    for (let i = recent.length - 1; i >= 0; i--) {
      const t = recent[i]!;
      this.recentTurns.push({
        userMessage: t.user,
        assistantResponse: t.assistant,
        entityIds: t.entities,
      });
    }
  }

  /** Get the entity IDs from the most recent L4 fetch. */
  getLastEntityIds(): string[] {
    return this.lastEntityIds;
  }

  /** Get current summary (for debugging/display). */
  getSummary(): string {
    return this.summary;
  }

  /** Get recent turn count. */
  getRecentCount(): number {
    return this.recentTurns.length;
  }

  /** Get semantic history size. */
  getSemanticSize(): number {
    return this.semanticHistory.size;
  }

  /** Store a tagged output in L2 (e.g. [requirements], [design], [plan:id]). */
  setTag(tag: string, content: string): void {
    this.tags.set(tag, content);
    // Also append tag reference to summary so it persists across evictions
    if (content) {
      this.summary = this.summary
        ? `${this.summary}\n${tag}: (stored)`
        : `${tag}: (stored)`;
    }
  }

  /** Retrieve a tagged output from L2. */
  getTag(tag: string): string {
    return this.tags.get(tag) ?? '';
  }

  /** Check if a tag exists in L2. */
  hasTag(tag: string): boolean {
    return this.tags.has(tag) && !!this.tags.get(tag);
  }

  /** Set the active plan step context for L4 injection. */
  setActivePlanStep(context: string): void {
    this.activePlanStepContext = context;
  }

  /** Get the active plan step context. */
  getActivePlanStep(): string {
    return this.activePlanStepContext;
  }

  /** Set text attachment content for L4 injection. Cleared after each assemble(). */
  setAttachmentContext(text: string): void {
    this.attachmentContext = text;
  }

  /** Get the current attachment context. */
  getAttachmentContext(): string {
    return this.attachmentContext;
  }

  /** Reset all state (for session restart). */
  reset(): void {
    this.summary = '';
    this.recentTurns.length = 0;
    this.lastEntityIds = [];
    this.tags.clear();
    this.activePlanStepContext = '';
    resetSeenCounts();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract likely entity names from user message for overflow preservation.
 *
 * Heuristic: camelCase, PascalCase, snake_case identifiers, and backtick-quoted names.
 * These are entity names the user explicitly mentioned — they should survive overflow.
 */
function extractEntityNames(message: string): Set<string> {
  const names = new Set<string>();

  // Backtick-quoted identifiers: `functionName`
  const backtickPattern = /`([a-zA-Z_]\w+)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickPattern.exec(message)) !== null) {
    names.add(m[1]!);
  }

  // camelCase or PascalCase identifiers (at least 2 parts)
  const camelPattern = /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g;
  while ((m = camelPattern.exec(message)) !== null) {
    names.add(m[1]!);
  }

  // PascalCase (starts with uppercase, has another uppercase)
  const pascalPattern = /\b([A-Z][a-z]+(?:[A-Z][a-z0-9]*)+)\b/g;
  while ((m = pascalPattern.exec(message)) !== null) {
    names.add(m[1]!);
  }

  // snake_case identifiers
  const snakePattern = /\b([a-z]\w*_\w+)\b/g;
  while ((m = snakePattern.exec(message)) !== null) {
    names.add(m[1]!);
  }

  return names;
}
