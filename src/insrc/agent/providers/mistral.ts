/**
 * Mistral provider -- implements `LLMProvider` against `@mistralai/mistralai`.
 *
 * Embeddings are intentionally unsupported here; stay local.
 */

import { Mistral } from '@mistralai/mistralai';
import type {
  CompletionOpts,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  ToolCall,
  ToolDefinition,
} from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('mistral');

export interface MistralProviderConfig {
  model?: string | undefined;
  apiKey?: string | undefined;
}

export class MistralProvider implements LLMProvider {
  readonly supportsTools = true;
  private readonly client: Mistral;
  private readonly model: string;

  constructor(config: MistralProviderConfig = {}) {
    this.model = config.model ?? 'mistral-small-latest';
    this.client = new Mistral({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
  }

  async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
    const apiMessages = toMistralMessages(messages);
    const tools = opts.tools ? toMistralTools(opts.tools) : undefined;

    const request: Record<string, unknown> = {
      model: this.model,
      messages: apiMessages,
    };
    if (opts.maxTokens !== undefined)   request['maxTokens'] = opts.maxTokens;
    if (opts.temperature !== undefined) request['temperature'] = opts.temperature;
    if (tools && tools.length > 0)      request['tools'] = tools;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await this.client.chat.complete(request as any);
      return fromMistralResponse(response);
    } catch (err) {
      log.error({ err: String(err), model: this.model }, 'mistral complete failed');
      throw err;
    }
  }

  async *stream(messages: LLMMessage[], opts: CompletionOpts = {}): AsyncIterable<string> {
    const apiMessages = toMistralMessages(messages);

    const request: Record<string, unknown> = {
      model: this.model,
      messages: apiMessages,
    };
    if (opts.maxTokens !== undefined)   request['maxTokens'] = opts.maxTokens;
    if (opts.temperature !== undefined) request['temperature'] = opts.temperature;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eventStream = await this.client.chat.stream(request as any);
    for await (const event of eventStream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delta = (event as any)?.data?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        opts.onToken?.(delta);
        yield delta;
      }
    }
  }

  async embed(_text: string): Promise<number[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMistralMessages(messages: LLMMessage[]): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    // Mistral chat API: text content + optional tool_calls / tool role.
    const textParts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolCalls: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResults: any[] = [];
    let hadBinary = false;
    for (const block of m.content) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          content: block.isError === true ? `[error] ${block.content}` : block.content,
          tool_call_id: block.tool_use_id,
        });
      } else hadBinary = true;
    }
    if (toolResults.length > 0) {
      for (const tr of toolResults) out.push(tr);
      continue;
    }
    const content = textParts.join('\n') + (hadBinary
      ? '\n\n[Binary attachment -- not forwarded to Mistral; use a vision-capable provider or switch active provider]'
      : '');
    if (m.role === 'assistant' && toolCalls.length > 0) {
      out.push({ role: 'assistant', content, toolCalls });
    } else {
      out.push({ role: m.role, content });
    }
  }
  return out;
}

function toMistralTools(tools: ToolDefinition[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromMistralResponse(response: any): LLMResponse {
  const choice = response?.choices?.[0];
  const message = choice?.message;
  const text = typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (message.content as any[]).filter(b => b?.type === 'text').map(b => b.text).join('')
      : '';
  let toolCalls: ToolCall[] | undefined;
  if (Array.isArray(message?.toolCalls) && message.toolCalls.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolCalls = message.toolCalls.map((tc: any, idx: number) => ({
      id: tc.id ?? `mistral-${Date.now()}-${idx}`,
      name: tc.function?.name ?? '',
      input: safeParseJson(tc.function?.arguments),
    }));
  }
  const finishReason = choice?.finishReason;
  const stopReason: LLMResponse['stopReason'] =
    finishReason === 'tool_calls' ? 'tool_use'
    : finishReason === 'length'   ? 'max_tokens'
    :                               'end_turn';
  const usage = response?.usage;
  // Mistral's modern models (mistral-large-2411, codestral-25.01, etc.)
  // auto-cache stable prefixes server-side; no client marker is required.
  // The response carries the hit count under either
  // `usage.cachedTokens` (SDK >=1.3) or
  // `usage.prompt_tokens_details.cached_tokens` (snake_case payload).
  // Surface whichever is present, default to 0. Older models without
  // caching support simply return 0 -- still safe.
  const cachedTokens =
    (usage as { cachedTokens?: number } | undefined)?.cachedTokens
    ?? (usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)
       ?.prompt_tokens_details?.cached_tokens
    ?? 0;
  const promptTokens = usage?.promptTokens ?? 0;
  return {
    text,
    ...(toolCalls ? { toolCalls } : {}),
    stopReason,
    ...(usage ? {
      usage: {
        inputTokens:      Math.max(0, promptTokens - cachedTokens),
        outputTokens:     usage.completionTokens ?? 0,
        cacheReadTokens:  cachedTokens,
      },
    } : {}),
  };
}

// ---------------------------------------------------------------------------
// Test exports (caching observability)
// ---------------------------------------------------------------------------

export const _fromMistralResponseForTest = fromMistralResponse;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeParseJson(s: any): Record<string, unknown> {
  if (typeof s !== 'string') {
    return (s && typeof s === 'object') ? s as Record<string, unknown> : {};
  }
  try {
    const parsed = JSON.parse(s);
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
