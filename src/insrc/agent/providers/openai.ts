/**
 * OpenAI provider -- implements `LLMProvider` against the official
 * `openai` SDK (chat.completions API).
 *
 * Embeddings are deliberately unsupported (cloud providers do not
 * participate in embedding selection; that stays local per plan).
 */

import OpenAI from 'openai';
import type {
  CompletionOpts,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  ToolCall,
  ToolDefinition,
} from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('openai');

export interface OpenAIProviderConfig {
  model?: string | undefined;
  apiKey?: string | undefined;
}

export class OpenAIProvider implements LLMProvider {
  readonly supportsTools = true;
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: OpenAIProviderConfig = {}) {
    this.model = config.model ?? 'gpt-4o';
    this.client = new OpenAI({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
  }

  async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
    const apiMessages = toOpenAIMessages(messages);
    const tools = opts.tools ? toOpenAITools(opts.tools) : undefined;

    const params: Record<string, unknown> = {
      model: this.model,
      messages: apiMessages,
    };
    if (opts.maxTokens !== undefined)    params['max_completion_tokens'] = opts.maxTokens;
    if (opts.temperature !== undefined)  params['temperature'] = opts.temperature;
    if (tools && tools.length > 0)       params['tools'] = tools;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await this.client.chat.completions.create(params as any);
      return fromOpenAIResponse(response);
    } catch (err) {
      log.error({ err: String(err), model: this.model }, 'openai complete failed');
      throw err;
    }
  }

  async *stream(messages: LLMMessage[], opts: CompletionOpts = {}): AsyncIterable<string> {
    const apiMessages = toOpenAIMessages(messages);

    const params: Record<string, unknown> = {
      model: this.model,
      messages: apiMessages,
      stream: true,
    };
    if (opts.maxTokens !== undefined)   params['max_completion_tokens'] = opts.maxTokens;
    if (opts.temperature !== undefined) params['temperature'] = opts.temperature;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamResp = await this.client.chat.completions.create(params as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const chunk of streamResp as any) {
      const delta = chunk?.choices?.[0]?.delta?.content;
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
// Message / tool translation
// ---------------------------------------------------------------------------

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};

function toOpenAIMessages(messages: LLMMessage[]): ChatMessage[] {
  return messages.map(m => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content };
    }
    // Multimodal -- map text blocks and images to OpenAI's content parts.
    // PDFs are not natively supported in chat.completions; fall back to text warning.
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
    for (const block of m.content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.mediaType};base64,${block.data}` },
        });
      } else if (block.type === 'document') {
        parts.push({ type: 'text', text: '[PDF attachment -- not supported by OpenAI chat.completions; use a vision-capable model or switch providers]' });
      }
    }
    return { role: m.role, content: parts };
  });
}

function toOpenAITools(tools: ToolDefinition[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
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
function fromOpenAIResponse(response: any): LLMResponse {
  const choice = response?.choices?.[0];
  const message = choice?.message;
  const text = typeof message?.content === 'string' ? message.content : '';
  let toolCalls: ToolCall[] | undefined;
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolCalls = message.tool_calls.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name ?? '',
      input: safeParseJson(tc.function?.arguments),
    }));
  }
  const finishReason = choice?.finish_reason;
  const stopReason: LLMResponse['stopReason'] =
    finishReason === 'tool_calls' ? 'tool_use'
    : finishReason === 'length'   ? 'max_tokens'
    :                               'end_turn';
  const usage = response?.usage;
  return {
    text,
    ...(toolCalls ? { toolCalls } : {}),
    stopReason,
    ...(usage ? {
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      },
    } : {}),
  };
}

function safeParseJson(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return {};
  try {
    const parsed = JSON.parse(s);
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
