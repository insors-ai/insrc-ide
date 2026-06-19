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
  ProviderCapabilities,
  StructuredCompletionOpts,
  StructuredSchema,
  ToolCall,
  ToolDefinition,
} from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import { withCloudRetry } from './cloud-retry.js';
import {
  processSchemaForOpenAIStrict,
  validateAgainstSchema,
  withStructuredRetry,
} from './structured-output.js';

const log = getLogger('openai');

export interface OpenAIProviderConfig {
  model?: string | undefined;
  apiKey?: string | undefined;
}

export class OpenAIProvider implements LLMProvider {
  readonly supportsTools = true;
  // plans/structured-output.md Phase B.2. OpenAI's native structured
  // output uses `response_format: { type: 'json_schema', strict: true }`
  // after `processSchemaForOpenAIStrict` pre-flights the schema for
  // strict-mode compliance (additionalProperties:false, full required
  // arrays, oneOf -> anyOf rewrites).
  readonly capabilities: ProviderCapabilities = {
    structuredOutput: true,
    toolCalling:      true,
    vision:           true,
    webSearch:        true,
    streaming:        true,
    embeddings:       false,
  };
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
    const toolChoice = toOpenAIToolChoice(opts.toolChoice, tools);
    if (toolChoice !== undefined)        params['tool_choice'] = toolChoice;

    try {
      const response = await withCloudRetry(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => this.client.chat.completions.create(params as any),
        { label: 'openai.complete', log },
      );
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

  // plans/structured-output.md Phase B.2. OpenAI structured output.
  //
  // Strategy: `response_format: { type: 'json_schema', json_schema: {
  // name, schema, strict: true } }`. The schema is pre-flighted via
  // `processSchemaForOpenAIStrict` which mutates a deep copy of the
  // input to add `additionalProperties: false` on every object,
  // populate `required` arrays, and rewrite `oneOf` -> `anyOf`. ajv
  // re-validates as a defensive backstop; on validation failure the
  // retry helper appends the errors as a user message.
  //
  // Strict mode means the wire layer enforces the schema; ajv only
  // catches drift in cases the API somehow misses (rare). The shape
  // arriving at the caller is always the validated typed value.
  async completeStructured<T>(
    messages: LLMMessage[],
    schema:   StructuredSchema,
    opts?:    StructuredCompletionOpts,
  ): Promise<T> {
    const apiMessages = toOpenAIMessages(messages);
    // Deep-clone the schema before pre-flight so we don't mutate the
    // caller's source-of-truth schema constant.
    const strictSchema = processSchemaForOpenAIStrict(
      JSON.parse(JSON.stringify(schema)) as StructuredSchema,
    );
    const schemaName = (schema as { title?: string }).title ?? '_emit';

    const baseParams: Record<string, unknown> = {
      model:    this.model,
      messages: apiMessages,
      response_format: {
        type: 'json_schema' as const,
        json_schema: {
          name:   schemaName,
          schema: strictSchema,
          strict: true,
        },
      },
    };
    if (opts?.maxTokens   !== undefined) baseParams['max_completion_tokens'] = opts.maxTokens;
    if (opts?.temperature !== undefined) baseParams['temperature']           = opts.temperature;

    return withStructuredRetry<T>(
      async (extraSystemNote) => {
        const msgs = extraSystemNote !== undefined
          ? [...apiMessages, { role: 'user' as const, content: extraSystemNote }]
          : apiMessages;
        try {
          const response = await withCloudRetry(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            () => this.client.chat.completions.create({ ...baseParams, messages: msgs } as any),
            { label: 'openai.completeStructured', log },
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const text = ((response as any).choices?.[0]?.message?.content ?? '') as string;
          if (text.length === 0) {
            throw new Error('openai.completeStructured: empty response content');
          }
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error(`openai.completeStructured: response was not valid JSON: ${(err as Error).message}. Got: ${text.slice(0, 200)}`);
          }
        } catch (err) {
          log.error({ err: String(err), model: this.model }, 'openai completeStructured failed');
          throw err;
        }
      },
      (raw) => validateAgainstSchema<T>(schema, raw),
      opts?.maxAttempts ?? 3,
    );
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
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    // Multimodal / structured -- map blocks to OpenAI's content shape.
    // - text + image_url => content parts on user/assistant
    // - tool_use         => `tool_calls` array on assistant
    // - tool_result      => separate `role: 'tool'` messages
    // - document         => fallback warning (PDFs not supported by chat.completions)
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
    const toolResults: Array<{ id: string; content: string }> = [];
    for (const block of m.content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.mediaType};base64,${block.data}` },
        });
      } else if (block.type === 'document') {
        parts.push({ type: 'text', text: '[PDF attachment -- not supported by OpenAI chat.completions]' });
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({ id: block.tool_use_id, content: block.isError === true ? `[error] ${block.content}` : block.content });
      }
    }

    if (toolResults.length > 0) {
      // tool results travel as separate `role: 'tool'` messages.
      for (const tr of toolResults) {
        out.push({ role: 'tool', content: tr.content, tool_call_id: tr.id });
      }
      continue;
    }

    if (m.role === 'assistant' && toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: parts.length > 0 ? parts : '',
        tool_calls: toolCalls,
      });
      continue;
    }

    out.push({ role: m.role, content: parts.length > 0 ? parts : '' });
  }
  return out;
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

/**
 * Map our generic `CompletionOpts.toolChoice` to OpenAI's
 * `tool_choice` parameter shape. Returns `undefined` when no
 * constraint should be applied (caller didn't ask, or tools aren't
 * being provided -- OpenAI rejects `tool_choice` without `tools`).
 *
 *   - 'auto' / 'required' / 'none' -> bare string (OpenAI native)
 *   - { name }                     -> { type: 'function', function: { name } }
 */
function toOpenAIToolChoice(
  toolChoice: 'auto' | 'required' | 'none' | { readonly name: string } | undefined,
  tools: unknown[] | undefined,
): string | { type: 'function'; function: { name: string } } | undefined {
  if (toolChoice === undefined) {
    return undefined;
  }
  if (!tools || tools.length === 0) {
    return undefined;
  }
  if (typeof toolChoice === 'object') {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return toolChoice;
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
  // OpenAI automatically caches prompt prefixes >= 1024 tokens. There's
  // NO client-side marker required (unlike Anthropic) -- caching fires
  // server-side. The response carries the hit count under
  // `usage.prompt_tokens_details.cached_tokens` (or
  // `cache_read_input_tokens` on newer SDK shapes). Surface it so
  // operators can see whether caching is firing as expected. Subtract
  // cached from prompt_tokens to get the uncached input count, matching
  // anthropic's shape where inputTokens = full-rate billed input.
  const cachedTokens =
    (usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)
      ?.prompt_tokens_details?.cached_tokens
    ?? (usage as { cache_read_input_tokens?: number } | undefined)?.cache_read_input_tokens
    ?? 0;
  const promptTokens = usage?.prompt_tokens ?? 0;
  return {
    text,
    ...(toolCalls ? { toolCalls } : {}),
    stopReason,
    ...(usage ? {
      usage: {
        inputTokens:      Math.max(0, promptTokens - cachedTokens),
        outputTokens:     usage.completion_tokens ?? 0,
        cacheReadTokens:  cachedTokens,
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

// Test exports
export const _toOpenAIToolChoiceForTest = toOpenAIToolChoice;
