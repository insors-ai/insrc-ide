import { Ollama } from 'ollama';
import { Agent, fetch as undiciFetch } from 'undici';
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  CompletionOpts,
  ToolDefinition,
  ToolCall,
} from '../../shared/types.js';
import { loadConfig } from '../config.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('ollama');

// Lazy defaults -- calling `loadConfig()` at module load creates a circular
// init (config.ts imports factory.ts imports this file), so we defer until
// an OllamaProvider is actually constructed.
let _localDefaults: import('../../shared/types.js').LocalProviderConfig | undefined;
function localDefaults(): import('../../shared/types.js').LocalProviderConfig {
  if (!_localDefaults) {
    _localDefaults = loadConfig().models.providers.local;
  }
  return _localDefaults;
}

/**
 * Per-model-family quirks the wrapper has to apply. Most are
 * legacies of qwen-specific control tokens / output limitations; new
 * coder models (devstral, codestral, etc.) generally follow the
 * standard Ollama tool-calling + JSON-format contract without help.
 */
interface ModelQuirks {
  readonly family: 'qwen' | 'mistral' | 'codellama' | 'deepseek' | 'gemma' | 'unknown';
  /**
   * Prepend `/no_think` to the system prompt when tools are present.
   * qwen2.5/qwen3 use this control token to disable thinking mode so
   * tool_calls come back via the structured wire format instead of
   * inside <think> tags. Other families ignore the token; for
   * Mistral-family models it's just dead text in the prompt budget,
   * so we skip it.
   */
  readonly noThinkOnTools: boolean;
  /**
   * Pass `format: 'json'` (or a JSON Schema object) to Ollama in the
   * same call as `tools`. qwen breaks on this combo (returns blank
   * tool_calls); Mistral / Devstral / Codestral handle it cleanly,
   * which lets us constrain the model's text output across the
   * whole tool-calling loop instead of only retrying after a
   * parse failure.
   */
  readonly formatWithTools: boolean;
}

function detectModelFamily(model: string): ModelQuirks['family'] {
  const lower = model.toLowerCase();
  if (lower.startsWith('qwen')) { return 'qwen'; }
  if (lower.startsWith('devstral') || lower.startsWith('mistral') || lower.startsWith('mixtral') || lower.startsWith('codestral')) { return 'mistral'; }
  if (lower.startsWith('codellama') || lower.startsWith('llama')) { return 'codellama'; }
  if (lower.startsWith('deepseek')) { return 'deepseek'; }
  if (lower.startsWith('gemma')) { return 'gemma'; }
  return 'unknown';
}

function modelQuirks(model: string): ModelQuirks {
  const family = detectModelFamily(model);
  switch (family) {
    case 'qwen':      return { family, noThinkOnTools: true,  formatWithTools: false };
    case 'mistral':   return { family, noThinkOnTools: false, formatWithTools: true  };
    case 'codellama': return { family, noThinkOnTools: false, formatWithTools: true  };
    case 'deepseek':  return { family, noThinkOnTools: false, formatWithTools: true  };
    case 'gemma':     return { family, noThinkOnTools: false, formatWithTools: true  };
    case 'unknown':   return { family, noThinkOnTools: false, formatWithTools: true  };
  }
}

export class OllamaProvider implements LLMProvider {
  readonly supportsTools = true;
  private readonly client: Ollama;
  private readonly model: string;
  private readonly numCtx: number;
  private readonly embeddingModel: string;
  private readonly quirks: ModelQuirks;

  constructor(
    model?: string,
    host?: string,
    numCtx?: number,
  ) {
    const d = localDefaults();
    this.model = model ?? d.coreModel;
    host = host ?? d.host;
    this.numCtx = numCtx ?? d.params[d.coreModel]?.maxInputTokens ?? 16_384;
    this.embeddingModel = d.embeddingModel;
    this.quirks = modelQuirks(this.model);
    log.info({ model: this.model, family: this.quirks.family, noThinkOnTools: this.quirks.noThinkOnTools, formatWithTools: this.quirks.formatWithTools }, 'ollama provider configured');
    // Override undici's default headers timeout (300s) which is too short for
    // CPU-bound large-context inference that can take 5-10 minutes.
    const agent = new Agent({
      headersTimeout: 0,   // disable -- streaming returns headers with first token
      bodyTimeout: 0,      // disable -- streaming body arrives incrementally
      connectTimeout: 30_000,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const longTimeoutFetch = ((input: any, init?: any) =>
      undiciFetch(input, { ...init, dispatcher: agent })) as unknown as typeof globalThis.fetch;
    this.client = new Ollama({ host, fetch: longTimeoutFetch });
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.list();
      return true;
    } catch {
      return false;
    }
  }

  async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
    const ollamaMessages = toOllamaMessages(messages);
    const tools = opts.tools ? toOllamaTools(opts.tools) : undefined;

    // Per-family pre-prompt directives. /no_think is a qwen-specific
    // control token that turns off thinking-mode so tool_calls come
    // back via the structured wire format. Other families ignore it
    // (or, for Mistral-family, would just see literal /no_think as
    // dead text -- skip it).
    if (this.quirks.noThinkOnTools && tools && tools.length > 0 && ollamaMessages.length > 0 && ollamaMessages[0]!.role === 'system') {
      const sys = ollamaMessages[0]!;
      if (!sys.content.startsWith('/no_think')) {
        sys.content = `/no_think\n${sys.content}`;
      }
    }

    log.debug({
      model: this.model,
      numCtx: this.numCtx,
      maxTokens: opts.maxTokens ?? 8_192,
      temperature: opts.temperature,
      messageCount: ollamaMessages.length,
      messages: ollamaMessages.map(m => ({
        role: m.role,
        contentLen: m.content.length,
        content: m.content,
      })),
      toolCount: tools?.length ?? 0,
      tools: tools?.map(t => t.function.name),
    }, 'ollama request');

    try {
      // Always use streaming internally to avoid headers-timeout on slow
      // CPU inference. The non-streaming Ollama API waits for the entire
      // response before sending HTTP headers, which can exceed the timeout
      // for large-context calls on CPU-only machines.
      return await this.completeStreaming(ollamaMessages, tools, opts);
    } catch (err) {
      throw wrapOllamaError(err);
    }
  }

  private async completeStreaming(
    ollamaMessages: OllamaMessage[],
    tools: OllamaTool[] | undefined,
    opts: CompletionOpts,
  ): Promise<LLMResponse> {
    // Resolve `format` from CompletionOpts.responseFormat. Three input
    // forms (see shared/types.ts):
    //   - 'json'               -> Ollama format: 'json' (parseable-JSON)
    //   - { schema: <object> } -> Ollama format: <schema> (shape-bound)
    //   - undefined            -> no format constraint
    //
    // The format/tools combo is gated on a per-family quirk: qwen
    // breaks on it (returns blank tool_calls); Mistral / Devstral /
    // Codestral handle it cleanly. Off-with-tools for qwen preserves
    // the Phase-1 behaviour; on-with-tools for everything else lets
    // the model produce shape-constrained answers across the whole
    // tool-calling loop.
    const ollamaFormat = this._resolveOllamaFormat(opts.responseFormat, tools);
    // qwen3.6 (and other thinking-capable qwen models) treats `think: false`
    // as a structured request to skip the <think>...</think> reasoning block.
    // qwen3-coder already gets the legacy `/no_think` prompt-prefix path
    // above; sending the field is harmless for non-thinking models. Tool-loop
    // calls (the model is just picking the next tool) don't benefit from
    // thinking and the latency hit per turn is material.
    const disableThinking = this.quirks.noThinkOnTools && tools !== undefined && tools.length > 0;
    // Prompt caching: Ollama caches KV state when consecutive calls
    // share a prompt prefix AND the model is still loaded. `keep_alive`
    // controls how long the daemon keeps the model in memory after a
    // call returns; default 5min. For the analyzer's tool-loop (often
    // hours of work on the same model + same system prompt) we set this
    // to 24h so the model + KV cache survive between calls and prefix
    // reuse kicks in. `cacheSystem === false` reverts to the default
    // (5m) for one-off calls.
    const keepAlive = opts.cacheSystem === false ? undefined : '24h';
    const response = await this.client.chat({
      model: this.model,
      messages: ollamaMessages,
      ...(tools ? { tools } : {}),
      ...(ollamaFormat !== undefined ? { format: ollamaFormat } : {}),
      ...(disableThinking ? { think: false } : {}),
      ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
      stream: true,
      options: {
        num_ctx: this.numCtx,
        num_predict: opts.maxTokens ?? 8_192,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      },
    });

    let text = '';
    let allToolCalls: OllamaToolCall[] = [];
    // Ollama's final stream chunk carries token counts:
    //   prompt_eval_count        -- input tokens
    //   prompt_eval_duration     -- ns spent on prompt processing
    //   eval_count               -- output tokens generated
    // When the model's KV cache is warm and the prompt prefix matched
    // a prior call, `prompt_eval_count` reflects only the NEW (non-
    // cached) prefix portion. The `done_reason === 'load'` chunk
    // (model warm-up) doesn't carry these fields.
    let promptEvalCount: number | undefined;
    let evalCount: number | undefined;
    for await (const chunk of response) {
      if (chunk.message.content) {
        text += chunk.message.content;
        opts.onToken?.(chunk.message.content);
      }
      if (chunk.message.tool_calls) {
        allToolCalls = allToolCalls.concat(chunk.message.tool_calls as OllamaToolCall[]);
      }
      // `done: true` chunks carry the usage counts.
      if (chunk.done === true) {
        if (typeof chunk.prompt_eval_count === 'number') promptEvalCount = chunk.prompt_eval_count;
        if (typeof chunk.eval_count === 'number')        evalCount = chunk.eval_count;
      }
    }

    const toolCalls = parseToolCalls(allToolCalls.length > 0 ? allToolCalls : undefined);

    log.debug({
      model: this.model,
      textLen: text.length,
      text,
      toolCallCount: toolCalls.length,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      promptEvalCount,
      evalCount,
    }, 'ollama response');

    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      ...(promptEvalCount !== undefined && evalCount !== undefined ? {
        usage: { inputTokens: promptEvalCount, outputTokens: evalCount },
      } : {}),
    };
  }

  /**
   * Resolve the `format` field passed to ollama.chat from
   * CompletionOpts.responseFormat. Returns `undefined` when no
   * constraint should be applied (caller didn't ask, or family-quirk
   * gates it off when tools are present).
   */
  private _resolveOllamaFormat(
    responseFormat: CompletionOpts['responseFormat'],
    tools: OllamaTool[] | undefined,
  ): string | object | undefined {
    if (responseFormat === undefined) {
      return undefined;
    }
    const hasTools = tools !== undefined && tools.length > 0;
    if (hasTools && !this.quirks.formatWithTools) {
      // qwen quirk: format + tools breaks tool_calls. Drop the
      // constraint here; the analyzer's strict-JSON retry path picks
      // it up on a no-tools call.
      return undefined;
    }
    return responseFormat === 'json' ? 'json' : responseFormat.schema;
  }

  async embed(text: string): Promise<number[]> {
    try {
      const result = await this.client.embed({ model: this.embeddingModel, input: text });
      return result.embeddings[0] ?? [];
    } catch {
      return [];
    }
  }

  async *stream(messages: LLMMessage[], opts: CompletionOpts = {}): AsyncIterable<string> {
    const ollamaMessages = toOllamaMessages(messages);

    try {
      const response = await this.client.chat({
        model: this.model,
        messages: ollamaMessages,
        stream: true,
        options: {
          num_ctx: this.numCtx,
          num_predict: opts.maxTokens ?? 8_192,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        },
      });

      for await (const chunk of response) {
        if (chunk.message.content) {
          yield chunk.message.content;
        }
      }
    } catch (err) {
      throw wrapOllamaError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Native tool calls on an assistant turn (Ollama SDK passes these
   *  through to the chat template; for qwen3-coder they render as
   *  `<tool_call>` chat-template tokens the model recognises). */
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

/**
 * Translate `LLMMessage[]` into Ollama's native shape. Structured
 * content blocks (`tool_use` on assistant turns, `tool_result` on
 * user turns) are converted to the SDK's `tool_calls` field and
 * `role: 'tool'` messages respectively, so the chat template carries
 * the structured signal instead of a mimicable text marker.
 */
function toOllamaMessages(messages: LLMMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    // Multi-block content. Separate by type.
    const texts: string[] = [];
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    const toolResults: Array<{ id: string; content: string; isError: boolean }> = [];
    for (const b of m.content) {
      if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'tool_use') toolUses.push({ id: b.id, name: b.name, input: b.input as Record<string, unknown> });
      else if (b.type === 'tool_result') toolResults.push({ id: b.tool_use_id, content: b.content, isError: b.isError === true });
      // image / document blocks are skipped here -- this provider doesn't surface them.
    }

    if (toolResults.length > 0) {
      // Each tool_result becomes a separate `role: 'tool'` message
      // so the model sees them as the conversation's tool-side
      // returns rather than mixed user content.
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          content: tr.isError ? `[error] ${tr.content}` : tr.content,
        });
      }
      continue;
    }

    if (m.role === 'assistant' && toolUses.length > 0) {
      out.push({
        role: 'assistant',
        content: texts.join('\n'),
        tool_calls: toolUses.map(tu => ({
          function: { name: tu.name, arguments: tu.input },
        })),
      });
      continue;
    }

    out.push({ role: m.role, content: texts.join('\n') });
  }
  return out;
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function toOllamaTools(tools: ToolDefinition[]): OllamaTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

let _toolCallId = 0;

function parseToolCalls(raw?: OllamaToolCall[]): ToolCall[] {
  if (!raw || raw.length === 0) return [];
  return raw.map(tc => ({
    id: `tc_${++_toolCallId}`,
    name: tc.function.name,
    input: tc.function.arguments,
  }));
}

function wrapOllamaError(err: unknown): Error {
  if (err instanceof Error) {
    if (err.message.includes('ECONNREFUSED')) {
      return new Error(
        'Ollama is not running. Start it with: ollama serve',
      );
    }
    if (err.message.includes('not found') || err.message.includes('404')) {
      return new Error(
        `Model not found in Ollama. Pull it with: ollama pull <model>`,
      );
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}
