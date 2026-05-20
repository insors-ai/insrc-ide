import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  CompletionOpts,
  ToolDefinition,
  ToolCall,
  ContentBlock,
} from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('claude');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  model?: string | undefined;
  apiKey?: string | undefined;
}

// ---------------------------------------------------------------------------
// Web search result type
// ---------------------------------------------------------------------------

export interface WebSearchResult {
  query: string;
  results: Array<{
    url: string;
    title: string;
    snippet: string;
    content?: string | undefined;
  }>;
  provider: 'brave' | 'claude';
  summary: string;
  usage?: { inputTokens: number; outputTokens: number } | undefined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  readonly supportsTools = true;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: AnthropicProviderConfig = {}) {
    this.model = config.model ?? 'claude-sonnet-4-6';
    this.client = new Anthropic({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
  }

  async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
    const { system, apiMessages } = splitMessages(messages);
    const tools = opts.tools ? toAnthropicTools(opts.tools) : undefined;
    // Prompt caching: when the caller hasn't opted out (default = on),
    // mark the system prompt as a cacheable prefix with
    // `cache_control: { type: 'ephemeral' }`. Anthropic billing for
    // cache reads is ~10% of input rate, cache writes ~125%; for a
    // tool-loop with N iterations sharing the same system prompt the
    // net saving approaches `(N-1) * 0.9 * input_cost`. The marker is
    // a no-op when `system` is undefined.
    const cacheSystem = opts.cacheSystem !== false;
    const systemParam = buildSystemParam(system, cacheSystem);

    log.debug({
      model: this.model,
      maxTokens: opts.maxTokens ?? 8_192,
      temperature: opts.temperature,
      systemLen: system?.length ?? 0,
      system,
      messageCount: apiMessages.length,
      messages: apiMessages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      toolCount: tools?.length ?? 0,
      tools: tools?.map(t => t.name),
    }, 'claude request');

    try {
      // Item 32b: when the caller supplies an `onToken` callback, use
      // the streaming Messages API and emit each text_delta as it
      // arrives. Falls back to the non-streaming create() path when no
      // callback is set to avoid forcing SSE overhead on every caller.
      // `finalMessage()` still resolves a complete Anthropic.Message so
      // we get the same shape for toolCalls / usage / stop_reason.
      if (opts.onToken) {
        const stream = this.client.messages.stream({
          model:      this.model,
          max_tokens: opts.maxTokens ?? 8_192,
          ...(systemParam !== undefined ? { system: systemParam } : {}),
          ...(tools && tools.length > 0 ? { tools } : {}),
          messages:   apiMessages,
        });

        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            opts.onToken(event.delta.text);
          }
        }

        const response = await stream.finalMessage();

        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('');

        const toolCalls = response.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
          .map((b): ToolCall => ({
            id:    b.id,
            name:  b.name,
            input: b.input as Record<string, unknown>,
          }));

        return {
          text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          stopReason: response.stop_reason === 'tool_use'
            ? 'tool_use'
            : response.stop_reason === 'max_tokens'
              ? 'max_tokens'
              : 'end_turn',
          usage: extractUsage(response.usage),
        };
      }

      const response = await this.client.messages.create({
        model:      this.model,
        max_tokens: opts.maxTokens ?? 8_192,
        ...(system ? { system } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        messages:   apiMessages,
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');

      const toolCalls = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b): ToolCall => ({
          id:    b.id,
          name:  b.name,
          input: b.input as Record<string, unknown>,
        }));

      log.debug({
        model: this.model,
        stopReason: response.stop_reason,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        textLen: text.length,
        text,
        toolCallCount: toolCalls.length,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      }, 'claude response');

      return {
        text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        stopReason: response.stop_reason === 'tool_use'
          ? 'tool_use'
          : response.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : 'end_turn',
        usage: extractUsage(response.usage),
      };
    } catch (err) {
      throw wrapError(err);
    }
  }

  async embed(_text: string): Promise<number[]> {
    // Claude API does not provide embeddings -- use Ollama for embedding
    return [];
  }

  /**
   * Web search via Anthropic server-side tool.
   * Uses the cheapest model available for cost efficiency.
   */
  async webSearch(query: string, maxResults: number = 5): Promise<WebSearchResult> {
    log.info({ query, maxResults }, 'claude web search');

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 2048,
        tools: [{
          type: 'web_search_20250305' as unknown as 'custom',
          name: 'web_search',
        } as unknown as Anthropic.Tool],
        messages: [{
          role: 'user',
          content: `Search the web for: "${query}". Return the ${maxResults} most relevant results with URLs, titles, and brief summaries.`,
        }],
      });

      // Extract text and any search result blocks
      const results: WebSearchResult['results'] = [];
      let summary = '';

      for (const block of response.content) {
        if (block.type === 'text') {
          summary += block.text;
        }
        // Server-side tool results may appear as tool_use blocks with results
        if (block.type === 'tool_use' && block.name === 'web_search') {
          const input = block.input as Record<string, unknown>;
          if (input['results'] && Array.isArray(input['results'])) {
            for (const r of input['results'] as Array<Record<string, unknown>>) {
              results.push({
                url: String(r['url'] ?? ''),
                title: String(r['title'] ?? ''),
                snippet: String(r['snippet'] ?? r['description'] ?? ''),
              });
            }
          }
        }
      }

      // If no structured results, parse from the text response
      if (results.length === 0 && summary.length > 0) {
        results.push({
          url: '',
          title: 'Web search summary',
          snippet: summary.slice(0, 2000),
        });
      }

      log.info({ query, resultCount: results.length, summaryLen: summary.length }, 'claude web search complete');

      return {
        query,
        results,
        provider: 'claude',
        summary,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (err) {
      log.error({ query, error: (err as Error).message }, 'claude web search failed');
      throw wrapError(err);
    }
  }

  async *stream(messages: LLMMessage[], opts: CompletionOpts = {}): AsyncIterable<string> {
    const { system, apiMessages } = splitMessages(messages);

    try {
      const stream = this.client.messages.stream({
        model:      this.model,
        max_tokens: opts.maxTokens ?? 8_192,
        ...(system ? { system } : {}),
        messages:   apiMessages,
      });

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield event.delta.text;
        }
      }
    } catch (err) {
      throw wrapError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitMessages(messages: LLMMessage[]): {
  system: string | undefined;
  apiMessages: Anthropic.MessageParam[];
} {
  const systemParts = messages
    .filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('\n\n'));

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

  const apiMessages: Anthropic.MessageParam[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string'
        ? m.content
        : toAnthropicContent(m.content),
    }));

  return { system, apiMessages };
}

/**
 * Convert our ContentBlock[] to Anthropic SDK content blocks.
 * Supports text, image, document, tool_use, and tool_result blocks.
 */
function toAnthropicContent(blocks: ContentBlock[]): Anthropic.ContentBlockParam[] {
  return blocks.map((block): Anthropic.ContentBlockParam => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image':
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: block.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            data: block.data,
          },
        };
      case 'document':
        return {
          type: 'document',
          source: {
            type: 'base64',
            media_type: block.mediaType as 'application/pdf',
            data: block.data,
          },
        };
      case 'tool_use':
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.isError === true ? { is_error: true } : {}),
        };
    }
  });
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Build the Anthropic `system` parameter. When `cacheSystem` is true
 * and a system prompt is present, wraps it in a single content block
 * with `cache_control: { type: 'ephemeral' }` so the prefix is
 * cacheable. Anthropic charges ~125% of input rate for the first call
 * that writes the cache and ~10% for subsequent reads, so this is a
 * net win as soon as the same system prompt is sent twice within the
 * cache TTL (5 min for ephemeral). When `cacheSystem` is false or
 * `system` is undefined, falls back to the previous string / undef
 * shape.
 */
function buildSystemParam(
  system: string | undefined,
  cacheSystem: boolean,
): string | Anthropic.TextBlockParam[] | undefined {
  if (system === undefined || system.length === 0) return undefined;
  if (!cacheSystem) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/**
 * Project the Anthropic SDK's `Message.usage` onto our LLMResponse
 * shape, preserving cache hit / write tokens when present.
 */
function extractUsage(u: Anthropic.Usage): LLMResponse['usage'] {
  return {
    inputTokens:           u.input_tokens,
    outputTokens:          u.output_tokens,
    cacheReadTokens:       u.cache_read_input_tokens ?? 0,
    cacheCreationTokens:   u.cache_creation_input_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Test exports (caching helpers)
// ---------------------------------------------------------------------------

export const _buildSystemParamForTest = buildSystemParam;
export const _extractUsageForTest     = extractUsage;

function wrapError(err: unknown): never {
  if (err instanceof Anthropic.AuthenticationError) {
    throw new Error(
      'Claude API authentication failed. Set ANTHROPIC_API_KEY.',
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    throw new Error('Claude API rate limit reached. Retry after a moment.');
  }
  if (err instanceof Anthropic.APIError) {
    throw new Error(`Claude API error ${err.status}: ${err.message}`);
  }
  throw err;
}
