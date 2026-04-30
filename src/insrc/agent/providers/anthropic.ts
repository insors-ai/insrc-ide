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
          ...(system ? { system } : {}),
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
            name:  fromClaudeToolName(b.name),
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
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
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
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
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
 * Supports text, image (base64), and document (base64 PDF) blocks.
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
    }
  });
}

/**
 * Anthropic's API restricts tool names to `^[a-zA-Z0-9_-]{1,128}$`.
 * Many of our tool ids use `:` as a namespace separator
 * (`db:sql:describe`, `code:locate`, `data:lineage`, etc.) which the
 * API rejects with HTTP 400.
 *
 * We translate `:` -> `__` when sending the tool list to Claude, and
 * the inverse on tool_use blocks coming back, so the rest of the
 * pipeline (executor + tool registry) sees the canonical colon form.
 *
 * `__` was picked because none of our shipped tool ids contain it;
 * the round-trip is lossless for every tool registered today.
 */
const CLAUDE_NAME_SEP = '__';

function toClaudeToolName(name: string): string {
  return name.replace(/:/g, CLAUDE_NAME_SEP);
}

export function fromClaudeToolName(name: string): string {
  return name.split(CLAUDE_NAME_SEP).join(':');
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map(t => ({
    name:         toClaudeToolName(t.name),
    description:  t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

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
