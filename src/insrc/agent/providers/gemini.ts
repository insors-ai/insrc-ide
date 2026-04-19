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
  ToolCall,
  ToolDefinition,
} from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('gemini');

export interface GeminiProviderConfig {
  model?: string | undefined;
  apiKey?: string | undefined;
}

export class GeminiProvider implements LLMProvider {
  readonly supportsTools = true;
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

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents,
        ...(Object.keys(genConfig).length > 0 ? { config: genConfig } : {}),
      });
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
    const parts = m.content.map(block => {
      if (block.type === 'text') return { text: block.text };
      if (block.type === 'image') {
        return { inlineData: { mimeType: block.mediaType, data: block.data } };
      }
      // document (PDF)
      return { inlineData: { mimeType: block.mediaType, data: block.data } };
    });
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
  return {
    text,
    ...(toolCalls ? { toolCalls } : {}),
    stopReason,
    ...(usage ? {
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
      },
    } : {}),
  };
}

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
