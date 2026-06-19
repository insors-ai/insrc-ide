/**
 * Gemini provider -- implements `LLMProvider` against `@google/genai`
 * (Google's unified GenAI SDK).
 *
 * Embeddings are intentionally unsupported here; stay local.
 */

import { GoogleGenAI, type Content } from '@google/genai';
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
import { jsonSchemaToGeminiSchema } from './gemini-schema-adapter.js';

const log = getLogger('gemini');

export interface GeminiProviderConfig {
  model?: string | undefined;
  apiKey?: string | undefined;
}

export class GeminiProvider implements LLMProvider {
  readonly supportsTools = true;
  // plans/structured-output.md Phase B.3. Gemini's native structured
  // output uses `responseMimeType: 'application/json'` +
  // `responseSchema` (OpenAPI 3.0 dialect, which differs from JSON
  // Schema draft 2020-12). The `jsonSchemaToGeminiSchema` adapter
  // translates lower-case type names to UPPER-case, drops unsupported
  // keywords, and rewrites const -> enum-of-one + oneOf -> anyOf.
  readonly capabilities: ProviderCapabilities = {
    structuredOutput: true,
    toolCalling:      true,
    vision:           true,
    webSearch:        true,
    streaming:        true,
    embeddings:       false,
  };
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(config: GeminiProviderConfig = {}) {
    this.model = config.model ?? 'gemini-2.0-flash';
    this.client = new GoogleGenAI({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
  }

  async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
    const { system, contents } = toGeminiContents(messages);
    const tools = opts.tools ? toGeminiTools(opts.tools) : undefined;

    const genConfig: Record<string, unknown> = {};
    if (opts.maxTokens !== undefined)   genConfig['maxOutputTokens'] = opts.maxTokens;
    if (opts.temperature !== undefined) genConfig['temperature'] = opts.temperature;
    if (system)                          genConfig['systemInstruction'] = system;
    if (tools)                           genConfig['tools'] = tools;
    const toolConfig = toGeminiToolConfig(opts.toolChoice, tools);
    if (toolConfig !== undefined)        genConfig['toolConfig'] = toolConfig;

    try {
      const response = await withCloudRetry(
        () => this.client.models.generateContent({
          model: this.model,
          contents,
          ...(Object.keys(genConfig).length > 0 ? { config: genConfig } : {}),
        }),
        { label: 'gemini.complete', log },
      );
      return fromGeminiResponse(response);
    } catch (err) {
      log.error({ err: String(err), model: this.model }, 'gemini complete failed');
      throw err;
    }
  }

  async *stream(messages: LLMMessage[], opts: CompletionOpts = {}): AsyncIterable<string> {
    const { system, contents } = toGeminiContents(messages);

    const genConfig: Record<string, unknown> = {};
    if (opts.maxTokens !== undefined)   genConfig['maxOutputTokens'] = opts.maxTokens;
    if (opts.temperature !== undefined) genConfig['temperature'] = opts.temperature;
    if (system)                          genConfig['systemInstruction'] = system;

    const streamResp = await this.client.models.generateContentStream({
      model: this.model,
      contents,
      ...(Object.keys(genConfig).length > 0 ? { config: genConfig } : {}),
    });
    for await (const chunk of streamResp) {
      const delta = extractText(chunk);
      if (delta) {
        opts.onToken?.(delta);
        yield delta;
      }
    }
  }

  async embed(_text: string): Promise<number[]> {
    return [];
  }

  // plans/structured-output.md Phase B.3. Gemini structured output.
  //
  // Strategy: configure generateContent with
  // `responseMimeType: 'application/json'` + `responseSchema` (the
  // adapted, OpenAPI 3.0-flavour schema). Gemini's wire layer enforces
  // the schema; ajv re-validates the original JSON Schema as a
  // defensive backstop; retries with feedback on validation failure.
  async completeStructured<T>(
    messages: LLMMessage[],
    schema:   StructuredSchema,
    opts?:    StructuredCompletionOpts,
  ): Promise<T> {
    const { system, contents } = toGeminiContents(messages);
    const geminiSchema = jsonSchemaToGeminiSchema(schema);

    const baseGenConfig: Record<string, unknown> = {
      responseMimeType: 'application/json',
      responseSchema:   geminiSchema,
    };
    if (opts?.maxTokens   !== undefined) baseGenConfig['maxOutputTokens']     = opts.maxTokens;
    if (opts?.temperature !== undefined) baseGenConfig['temperature']         = opts.temperature;
    if (system !== undefined)            baseGenConfig['systemInstruction']   = system;

    return withStructuredRetry<T>(
      async (extraSystemNote) => {
        const contentsWithNote = extraSystemNote !== undefined
          ? [...contents, { role: 'user' as const, parts: [{ text: extraSystemNote }] }]
          : contents;
        try {
          const response = await withCloudRetry(
            () => this.client.models.generateContent({
              model: this.model,
              contents: contentsWithNote,
              config: baseGenConfig,
            }),
            { label: 'gemini.completeStructured', log },
          );
          const text = extractText(response) ?? '';
          if (text.length === 0) {
            throw new Error('gemini.completeStructured: empty response text');
          }
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error(`gemini.completeStructured: response was not valid JSON: ${(err as Error).message}. Got: ${text.slice(0, 200)}`);
          }
        } catch (err) {
          log.error({ err: String(err), model: this.model }, 'gemini completeStructured failed');
          throw err;
        }
      },
      (raw) => validateAgainstSchema<T>(schema, raw),
      opts?.maxAttempts ?? 3,
    );
  }
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function toGeminiContents(messages: LLMMessage[]): { system?: string; contents: Content[] } {
  let system: string | undefined;
  const contents: Content[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : textOf(m.content);
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') {
      contents.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [];
    for (const block of m.content) {
      if (block.type === 'text') parts.push({ text: block.text });
      else if (block.type === 'image') parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } });
      else if (block.type === 'document') parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } });
      else if (block.type === 'tool_use') {
        parts.push({ functionCall: { name: block.name, args: block.input } });
      } else if (block.type === 'tool_result') {
        // Gemini doesn't separate by `tool_use_id`; emit as functionResponse
        // tied to the call's name. The loop currently emits one tool_result
        // per tool_use, so positional correspondence works.
        parts.push({
          functionResponse: {
            name: block.tool_use_id, // best-effort -- gemini correlates by name in practice
            response: { content: block.isError === true ? `[error] ${block.content}` : block.content },
          },
        });
      }
    }
    contents.push({ role, parts });
  }
  return { ...(system !== undefined ? { system } : {}), contents };
}

function textOf(blocks: LLMMessage['content']): string {
  if (typeof blocks === 'string') return blocks;
  return blocks.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('\n');
}

function toGeminiTools(tools: ToolDefinition[]): Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }> {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    })),
  }];
}

/**
 * Map our generic `CompletionOpts.toolChoice` to Gemini's
 * `toolConfig.functionCallingConfig.mode` shape.
 *
 *   - 'auto'      -> { mode: 'AUTO' }
 *   - 'required'  -> { mode: 'ANY' }    (Gemini's name for "must use a tool")
 *   - 'none'      -> { mode: 'NONE' }
 *   - { name }    -> { mode: 'ANY', allowedFunctionNames: [name] }
 *
 * Returns `undefined` when no constraint should be applied
 * (Gemini, like the other providers, rejects toolConfig without tools).
 */
function toGeminiToolConfig(
  toolChoice: 'auto' | 'required' | 'none' | { readonly name: string } | undefined,
  tools: unknown[] | undefined,
): { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } } | undefined {
  if (toolChoice === undefined) {
    return undefined;
  }
  if (!tools || tools.length === 0) {
    return undefined;
  }
  if (typeof toolChoice === 'object') {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.name],
      },
    };
  }
  switch (toolChoice) {
    case 'auto':     return { functionCallingConfig: { mode: 'AUTO' } };
    case 'required': return { functionCallingConfig: { mode: 'ANY'  } };
    case 'none':     return { functionCallingConfig: { mode: 'NONE' } };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromGeminiResponse(response: any): LLMResponse {
  const text = extractText(response) ?? '';
  const toolCalls = extractToolCalls(response);
  const usage = response?.usageMetadata;
  const finishReason = response?.candidates?.[0]?.finishReason;
  const stopReason: LLMResponse['stopReason'] =
    toolCalls && toolCalls.length > 0 ? 'tool_use'
    : finishReason === 'MAX_TOKENS'   ? 'max_tokens'
    :                                   'end_turn';
  // Gemini supports two caching modes:
  //
  //   - Implicit caching (Gemini 2.0 Flash / 2.5 / etc.): automatic
  //     server-side prefix cache that fires for contexts >= ~32K
  //     tokens. No client marker required. Hit count surfaces under
  //     `usageMetadata.cachedContentTokenCount`.
  //
  //   - Explicit cached content: create a `cachedContents` resource
  //     via `client.caches.create({...})`, then reference by name in
  //     subsequent calls (`cachedContent: <name>` config field). This
  //     is session-level state, not handled by a single complete()
  //     call -- a future enhancement when the analyzer's per-section
  //     workflow can manage cache resources explicitly.
  //
  // For now: surface implicit-cache hit counts from the response. The
  // request side stays unchanged. Most analyzer prompts (2-3K tokens)
  // sit below the implicit threshold and will return 0; longer
  // synthesis prompts above 32K will benefit automatically.
  const cachedTokens = (usage as { cachedContentTokenCount?: number } | undefined)
    ?.cachedContentTokenCount ?? 0;
  const promptTokens = usage?.promptTokenCount ?? 0;
  return {
    text,
    ...(toolCalls ? { toolCalls } : {}),
    stopReason,
    ...(usage ? {
      usage: {
        inputTokens:      Math.max(0, promptTokens - cachedTokens),
        outputTokens:     usage.candidatesTokenCount ?? 0,
        cacheReadTokens:  cachedTokens,
      },
    } : {}),
  };
}

// ---------------------------------------------------------------------------
// Test exports (caching observability)
// ---------------------------------------------------------------------------

export const _fromGeminiResponseForTest = fromGeminiResponse;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(response: any): string | undefined {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const pieces: string[] = [];
  for (const p of parts) {
    if (typeof p?.text === 'string') pieces.push(p.text);
  }
  return pieces.length > 0 ? pieces.join('') : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractToolCalls(response: any): ToolCall[] | undefined {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const calls: ToolCall[] = [];
  for (const p of parts) {
    if (p?.functionCall?.name) {
      calls.push({
        id: p.functionCall.id ?? `gemini-${Date.now()}-${calls.length}`,
        name: p.functionCall.name,
        input: (p.functionCall.args ?? {}) as Record<string, unknown>,
      });
    }
  }
  return calls.length > 0 ? calls : undefined;
}

// Test exports
export const _toGeminiToolConfigForTest = toGeminiToolConfig;
