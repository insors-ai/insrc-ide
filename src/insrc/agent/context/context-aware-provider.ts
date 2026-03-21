/**
 * ContextAwareProvider — wraps any LLMProvider to automatically inject
 * L1-L5 context from the shared ContextManager before each call.
 *
 * All callers just call `provider.complete(messages)` — context assembly,
 * turn recording, and budget enforcement are handled transparently.
 *
 * Usage:
 *   const provider = new ContextAwareProvider(ollamaProvider, contextManager, 16384);
 *   const response = await provider.complete([{ role: 'user', content: 'Hi' }]);
 *   // ^ automatically gets L1-L5 context injected, turn recorded
 */

import type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  CompletionOpts,
} from '../../shared/types.js';
import type { ContextManager } from './index.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('context-provider');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ContextAwareOptions {
  /** If true, auto-record turns after response (default true) */
  autoRecord?: boolean | undefined;
  /** If true, include L4 code context (default true) */
  includeCodeContext?: boolean | undefined;
  /** Label for logging ("local" or "claude") */
  label?: string | undefined;
}

/** Per-call overrides passed via CompletionOpts */
export interface ContextCallOpts {
  /** Skip recording this call as a turn */
  __skipRecord?: boolean | undefined;
  /** Skip context injection (use raw provider) */
  __skipContext?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Cached context for reuse within a single turn (e.g. tool loop iterations)
// ---------------------------------------------------------------------------

interface CachedAssembly {
  messages: LLMMessage[];
  embedding: number[];
  turnKey: string; // hash of user message to detect new turns
}

// ---------------------------------------------------------------------------
// ContextAwareProvider
// ---------------------------------------------------------------------------

export class ContextAwareProvider implements LLMProvider {
  private _cachedAssembly: CachedAssembly | null = null;

  constructor(
    private readonly base: LLMProvider,
    private readonly ctx: ContextManager,
    private readonly budgetTokens: number,
    private readonly _opts: ContextAwareOptions = {},
  ) {}

  /** The underlying raw provider (for internal calls that skip context) */
  get raw(): LLMProvider {
    return this.base;
  }

  get supportsTools(): boolean {
    return this.base.supportsTools;
  }

  async complete(
    callerMessages: LLMMessage[],
    opts?: CompletionOpts,
  ): Promise<LLMResponse> {
    const callOpts = opts as (Record<string, unknown> & ContextCallOpts) | undefined;

    // Skip context if requested
    if (callOpts?.__skipContext) {
      return this.base.complete(callerMessages, opts);
    }

    // Extract user message for context assembly
    const userMessage = extractLastUserMessage(callerMessages);

    // Assemble context (cached per turn to avoid re-computing in tool loops)
    const turnKey = userMessage.substring(0, 200);
    let contextMessages: LLMMessage[];
    let embedding: number[];

    if (this._cachedAssembly && this._cachedAssembly.turnKey === turnKey) {
      // Reuse cached context for this turn
      contextMessages = this._cachedAssembly.messages;
      embedding = this._cachedAssembly.embedding;
    } else {
      // Fresh context assembly
      embedding = await this.ctx.embedQuery(userMessage);
      const assembled = await this.ctx.assemble(userMessage, embedding);
      contextMessages = this.ctx.buildMessages(assembled, '');

      // Cache for reuse (tool loop iterations)
      this._cachedAssembly = { messages: contextMessages, embedding, turnKey };

      const label = this._opts.label ?? 'provider';
      log.debug({
        label,
        contextTokens: assembled.totalTokens,
        budget: this.budgetTokens,
        dropped: assembled.dropped.length,
      }, 'context assembled for provider');
    }

    // Merge context messages with caller's messages
    const enriched = mergeMessages(contextMessages, callerMessages);

    // Call base provider
    const response = await this.base.complete(enriched, opts);

    // Auto-record turn (unless disabled)
    const shouldRecord = (this._opts.autoRecord !== false) && !(callOpts?.__skipRecord);
    if (shouldRecord && userMessage && response.text) {
      const turn = {
        userMessage,
        assistantResponse: response.text,
        entityIds: this.ctx.getLastEntityIds(),
      };
      await this.ctx.recordTurn(turn, embedding);
      log.debug({ label: this._opts.label }, 'turn auto-recorded');
    }

    return response;
  }

  /** Delegate stream to base provider (context injected for initial messages) */
  async *stream(callerMessages: LLMMessage[], opts?: CompletionOpts): AsyncIterable<string> {
    // For streaming, inject context but don't auto-record (streaming responses are partial)
    const userMessage = extractLastUserMessage(callerMessages);
    const embedding = await this.ctx.embedQuery(userMessage);
    const assembled = await this.ctx.assemble(userMessage, embedding);
    const contextMessages = this.ctx.buildMessages(assembled, '');
    const enriched = mergeMessages(contextMessages, callerMessages);

    yield* this.base.stream(enriched, opts);
  }

  /** Delegate embed to base provider */
  async embed(text: string): Promise<number[]> {
    return this.base.embed(text);
  }

  /** Invalidate cached assembly (call when context changes externally) */
  invalidateCache(): void {
    this._cachedAssembly = null;
  }

  /** Create a copy with different options (e.g. skipRecord for classification) */
  withOptions(overrides: Partial<ContextAwareOptions>): ContextAwareProvider {
    return new ContextAwareProvider(this.base, this.ctx, this.budgetTokens, {
      ...this._opts,
      ...overrides,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the last user message from a message array.
 * Falls back to empty string if no user message found.
 */
function extractLastUserMessage(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      const content = messages[i]!.content;
      if (typeof content === 'string') return content;
      // ContentBlock[] — extract text blocks
      if (Array.isArray(content)) {
        return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      }
      return '';
    }
  }
  return '';
}

/**
 * Merge context messages (from context manager) with caller's messages.
 *
 * Strategy:
 * - Context system prompt is merged with caller's system prompt (if any)
 * - Context history (L3a recent turns) is prepended before caller's messages
 * - Caller's messages come last (most recent)
 */
function mergeMessages(contextMessages: LLMMessage[], callerMessages: LLMMessage[]): LLMMessage[] {
  // Separate system messages from conversation messages
  const contextSystem = contextMessages.filter(m => m.role === 'system');
  const contextConversation = contextMessages.filter(m => m.role !== 'system');

  const callerSystem = callerMessages.filter(m => m.role === 'system');
  const callerConversation = callerMessages.filter(m => m.role !== 'system');

  // Merge system prompts
  const mergedSystem: LLMMessage[] = [];
  if (contextSystem.length > 0 || callerSystem.length > 0) {
    const systemParts: string[] = [];
    for (const msg of contextSystem) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) systemParts.push(text);
    }
    for (const msg of callerSystem) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text && !systemParts.includes(text)) {
        systemParts.push(text);
      }
    }
    mergedSystem.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  // Combine: merged system + context conversation + caller conversation
  return [
    ...mergedSystem,
    ...contextConversation,
    ...callerConversation,
  ];
}
