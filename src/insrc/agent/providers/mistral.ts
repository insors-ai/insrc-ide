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
  ProviderCapabilities,
  StructuredCompletionOpts,
  StructuredSchema,
  ToolCall,
  ToolDefinition,
} from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import { withCloudRetry } from './cloud-retry.js';
import { validateAgainstSchema, withStructuredRetry } from './structured-output.js';

const log = getLogger('mistral');

export interface MistralProviderConfig {
  model?: string | undefined;
  apiKey?: string | undefined;
}

export class MistralProvider implements LLMProvider {
  readonly supportsTools = true;
  // plans/structured-output.md Phase B.4. Mistral structured output
  // uses `response_format: { type: 'json_schema', json_schema }` on
  // newer models (`mistral-large-2407+`, `mistral-small-2503+`,
  // `mistral-large-latest`, `pixtral-large`). For older models we
  // fall back to `response_format: { type: 'json_object' }` which
  // guarantees parseable JSON but not schema conformance -- the ajv
  // backstop catches drift and retries with the validation errors
  // appended.
  readonly capabilities: ProviderCapabilities = {
    structuredOutput: true,
    toolCalling:      true,
    vision:           false,
    webSearch:        false,
    streaming:        true,
    embeddings:       false,
  };
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
    const toolChoice = toMistralToolChoice(opts.toolChoice, tools);
    if (toolChoice !== undefined)       request['toolChoice'] = toolChoice;

    try {
      const response = await withCloudRetry(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => this.client.chat.complete(request as any),
        { label: 'mistral.complete', log },
      );
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

  // plans/structured-output.md Phase B.4. Mistral structured output.
  //
  // Strategy: pick the response_format based on whether the model is
  // known to support the strict `json_schema` flavour. Newer models
  // get { type: 'json_schema', json_schema: { name, schema, strict } }
  // (wire-layer enforcement); older models get
  // { type: 'json_object' } (parseable JSON only). Either way, ajv
  // re-validates against the original schema; on validation failure
  // the retry helper appends the errors as a user message.
  async completeStructured<T>(
    messages: LLMMessage[],
    schema:   StructuredSchema,
    opts?:    StructuredCompletionOpts,
  ): Promise<T> {
    const apiMessages = toMistralMessages(messages);
    const schemaName = (schema as { title?: string }).title ?? '_emit';
    const responseFormat = supportsJsonSchema(this.model)
      ? {
        type: 'json_schema' as const,
        jsonSchema: {
          name:   schemaName,
          schemaDefinition: schema,
          strict: true,
        },
      }
      : { type: 'json_object' as const };

    const baseRequest: Record<string, unknown> = {
      model:    this.model,
      messages: apiMessages,
      responseFormat,
    };
    if (opts?.maxTokens   !== undefined) baseRequest['maxTokens']   = opts.maxTokens;
    if (opts?.temperature !== undefined) baseRequest['temperature'] = opts.temperature;

    return withStructuredRetry<T>(
      async (extraSystemNote) => {
        const msgs = extraSystemNote !== undefined
          ? [...apiMessages, { role: 'user' as const, content: extraSystemNote }]
          : apiMessages;
        try {
          const response = await withCloudRetry(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            () => this.client.chat.complete({ ...baseRequest, messages: msgs } as any),
            { label: 'mistral.completeStructured', log },
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const text = ((response as any).choices?.[0]?.message?.content ?? '') as string;
          if (text.length === 0) {
            throw new Error('mistral.completeStructured: empty response content');
          }
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error(`mistral.completeStructured: response was not valid JSON: ${(err as Error).message}. Got: ${text.slice(0, 200)}`);
          }
        } catch (err) {
          log.error({ err: String(err), model: this.model }, 'mistral completeStructured failed');
          throw err;
        }
      },
      (raw) => validateAgainstSchema<T>(schema, raw),
      opts?.maxAttempts ?? 3,
    );
  }
}

/**
 * Allow-list of Mistral models that support `response_format: { type: 'json_schema' }`.
 * Per Mistral's structured-outputs docs (mistral.ai/news/jsonmode-update). Older models
 * and unknown ids fall back to `{ type: 'json_object' }` which still produces parseable
 * JSON but doesn't enforce the schema at the wire layer; the ajv backstop covers drift.
 */
function supportsJsonSchema(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes('mistral-large')
    || m.startsWith('mistral-medium')
    || m.includes('mistral-small-2503')
    || m.includes('mistral-small-latest')
    || m.includes('pixtral-large')
    || m.includes('codestral');
}

/** Exported for unit tests. */
export const _supportsJsonSchemaForTest = supportsJsonSchema;

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

/**
 * Map our generic `CompletionOpts.toolChoice` to Mistral's
 * `toolChoice` parameter shape. Same wire format as OpenAI.
 * Returns `undefined` when no constraint should be applied.
 */
function toMistralToolChoice(
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

// Test exports
export const _toMistralToolChoiceForTest = toMistralToolChoice;
