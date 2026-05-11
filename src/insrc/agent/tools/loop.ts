import type {
  ContentBlock,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  ToolCall,
  ToolResult,
  ToolDefinition,
} from '../../shared/types.js';
import type { Session } from '../session.js';
import { executeTool, type ToolExecContext } from './executor.js';
import { validateToolCall, type ValidationResult } from './validator.js';
import { getToolSettings } from '../../daemon/tools/config.js';

// ---------------------------------------------------------------------------
// Tool Loop Runner
//
// Implements the agentic tool-use loop:
//   1. Send messages + tool definitions to LLM
//   2. If LLM returns tool_use → validate → execute → append results → re-prompt
//   3. Repeat until LLM returns end_turn or max iterations
//
// Iteration / nudge / spill thresholds live in the tool settings
// snapshot so the IDE can tune them without a daemon rebuild.
// ---------------------------------------------------------------------------

export interface ToolLoopOpts {
  /** The LLM provider to use for completions */
  provider: LLMProvider;
  /** Tool definitions to inject */
  tools: ToolDefinition[];
  /** User's intent string for validation context */
  intent: string;
  /** Permission mode */
  permissionMode: 'validate' | 'auto-accept';
  /** Validator LLM provider (Claude/Haiku) — only needed in validate mode */
  validator?: LLMProvider | undefined;
  /** Callback for streaming text deltas to the user */
  onTextDelta?: (delta: string) => void;
  /** Callback when a tool call is about to be executed */
  onToolCall?: (call: ToolCall, validation: ValidationResult) => void;
  /** Callback when a tool call returns */
  onToolResult?: (call: ToolCall, result: ToolResult) => void;
  /**
   * Caller-provided protocol hook. Runs AFTER validation but BEFORE
   * `executeTool`. Returning a `ToolResult` short-circuits the call --
   * the actual tool body is NOT invoked and the returned result is
   * fed back to the LLM. Returning `null`/`undefined` lets the call
   * proceed normally.
   *
   * The code-analyzer section writer uses this to enforce the
   * "always describe before invoke" protocol: a `skill_invoke` whose
   * `skillId` hasn't been described yet in this loop is rejected
   * with a protocol-error tool_result so the LLM learns to call
   * `skill_describe` first.
   */
  interceptToolCall?: (call: ToolCall) => ToolResult | null | undefined;
  /** Max tokens for LLM completions */
  maxTokens?: number | undefined;
  /** Override `getToolSettings().loop.maxIterations` for this loop.
   *  Callers like the code-analyzer's section writer pass their own
   *  per-section cap (default 10) so a global config change doesn't
   *  silently widen a per-call budget the orchestrator was relying on. */
  maxIterations?: number | undefined;
  /** Callback when an LLM response includes usage info (for cost tracking) */
  onUsage?: ((usage: { inputTokens: number; outputTokens: number }) => void) | undefined;
  /** User's original prompt (passed to SmartRead for intelligent extraction) */
  userPrompt?: string | undefined;
  /** Progress callback for tool execution updates */
  onProgress?: ((message: string) => void) | undefined;
  /** Session used by tools that scope to the active repo (graph queries, etc.) */
  session?: Session | undefined;
}

export interface ToolLoopResult {
  /** Final assistant text response */
  response: string;
  /** All messages produced during the loop (for history tracking) */
  messages: LLMMessage[];
  /** Number of tool-use iterations executed */
  iterations: number;
  /** Whether the loop hit the max iteration limit */
  hitLimit: boolean;
}

/**
 * Run the agentic tool loop.
 *
 * Takes initial messages (system + history + user), sends to the LLM with
 * tool definitions, and loops on tool_use responses until the LLM produces
 * a final text response (end_turn).
 */
export async function runToolLoop(
  messages: LLMMessage[],
  opts: ToolLoopOpts,
): Promise<ToolLoopResult> {
  const { provider, tools, intent, permissionMode, validator, onTextDelta, onToolCall, onToolResult } = opts;

  // Working copy of messages — we append tool results as we go
  const workingMessages = [...messages];
  const producedMessages: LLMMessage[] = [];
  let finalResponse = '';
  let iterations = 0;
  let nudgeCount = 0;

  const { maxIterations: globalMaxIterations, maxNudges } = getToolSettings().loop;
  const maxIterations = opts.maxIterations ?? globalMaxIterations;
  while (iterations < maxIterations) {
    // Call LLM with tool definitions — stream text via onToken if callback provided
    const completionOpts: { tools: ToolDefinition[]; maxTokens?: number; onToken?: (t: string) => void } = { tools };
    if (opts.maxTokens !== undefined) completionOpts.maxTokens = opts.maxTokens;
    if (onTextDelta) {
      completionOpts.onToken = (token: string) => {
        finalResponse += token;
        onTextDelta(token);
      };
    }
    const llmResponse: LLMResponse = await provider.complete(workingMessages, completionOpts);

    // Report usage for cost tracking
    if (llmResponse.usage && opts.onUsage) {
      opts.onUsage(llmResponse.usage);
    }

    // If no streaming callback, pick up text from the full response
    if (!onTextDelta && llmResponse.text) {
      finalResponse += llmResponse.text;
    }

    // If no tool calls, check if LLM described using a tool without calling it
    if (llmResponse.stopReason !== 'tool_use' || !llmResponse.toolCalls?.length) {
      // Heuristic nudge: detect responses where the model talks about
      // doing X but doesn't actually call a tool to do it. Two regex
      // gates (tool name reference + future-tense intent phrase)
      // gate the nudge so plain conversational replies aren't re-
      // prompted.
      //
      // NOTE: this backstops loops where the loop has no stronger
      // protocol enforcement (Pair's `fs_read`, Delegate's
      // `graph_query`, Brainstorm). The code-analyzer's section
      // writer has its own `interceptToolCall` enforcement
      // (writeSectionWithTools's describe-before-invoke protocol)
      // which fires earlier and more precisely, so nudges rarely
      // trigger there. If a future analyzer adopts a similar
      // protocol the nudge can be skipped for that loop entirely.
      const toolNames = tools.map(t => t.name.toLowerCase());
      const lastSentence = finalResponse.trim().split(/[.!?\n]/).filter(s => s.trim()).pop()?.trim().toLowerCase() ?? '';
      const referencesTool = toolNames.some(name =>
        lastSentence.includes(name.toLowerCase())
      ) || /\b(check|read|look at|examine|list|search|find|grep|scan)\b.*\b(file|directory|folder|log|path|content)\b/i.test(lastSentence);
      const isFutureTense = /\b(let me|i'll|i will|i need to|i should|i can|going to)\b/i.test(lastSentence);

      if (referencesTool && isFutureTense && nudgeCount < maxNudges) {
        // LLM's final sentence describes a tool action it didn't take
        workingMessages.push({ role: 'assistant', content: finalResponse });
        workingMessages.push({ role: 'user', content: 'You described an action but did not call a tool. Use the available tools to perform it now.' });
        finalResponse = '';
        nudgeCount++;
        continue;
      }
      // Record assistant message
      producedMessages.push({ role: 'assistant', content: finalResponse });
      break;
    }

    // Process tool calls
    iterations++;
    const toolResults: ToolResult[] = [];

    for (const call of llmResponse.toolCalls) {
      // Validate
      const validation = await validateToolCall(call, {
        intent,
        mode: permissionMode,
        validator,
      });

      onToolCall?.(call, validation);

      if (validation.action === 'rejected') {
        toolResults.push({
          toolCallId: call.id,
          content: `[rejected] ${validation.reason}`,
          isError: true,
        });
        continue;
      }

      // Caller-supplied protocol hook. Used by the code-analyzer
      // section writer to enforce describe-before-invoke. If the
      // hook returns a ToolResult, skip the actual dispatch.
      const intercepted = opts.interceptToolCall?.(call);
      if (intercepted) {
        onToolResult?.(call, intercepted);
        toolResults.push(intercepted);
        continue;
      }

      // Execute (auto-execute or approved)
      const execCtx: ToolExecContext = {
        userPrompt: opts.userPrompt,
        onProgress: opts.onProgress,
        ...(opts.session ? { session: opts.session } : {}),
      };
      let result = await executeTool(call, execCtx);

      onToolResult?.(call, result);
      toolResults.push(result);
    }

    // Build the assistant turn as STRUCTURED content blocks: an
    // optional text block (the model's pre-tool-call narration)
    // followed by one `tool_use` block per call. Providers translate
    // these into their native tool_use API shapes so history carries
    // the structured signal the model expects, not a mimicable text
    // marker. (We previously used `<!--insrc:tool-use-->` as a
    // stand-in; the local LLM kept mimicking it as final-turn text.)
    const assistantBlocks: ContentBlock[] = [];
    if (llmResponse.text.length > 0) {
      assistantBlocks.push({ type: 'text', text: llmResponse.text });
    }
    for (const c of llmResponse.toolCalls) {
      assistantBlocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    }
    const assistantMsg: LLMMessage = { role: 'assistant', content: assistantBlocks };
    workingMessages.push(assistantMsg);
    producedMessages.push(assistantMsg);

    // Build the user turn carrying tool_result blocks. Large outputs
    // spill to temp file + SmartRead-chunked first.
    const inlineMaxChars = getToolSettings().output.inlineMaxChars;
    const resultBlocks: ContentBlock[] = await Promise.all(toolResults.map(async r => {
      let content = r.content;
      if (content.length > inlineMaxChars) {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const tempDir = join(tmpdir(), '.insrc', 'tool-output');
        mkdirSync(tempDir, { recursive: true });
        const tempPath = join(tempDir, `${r.toolCallId}-${Date.now()}.txt`);
        writeFileSync(tempPath, content, 'utf-8');

        const lineCount = content.split('\n').length;
        const sizeKB = (content.length / 1024).toFixed(1);
        opts.onProgress?.(`Tool output large (${lineCount} lines, ${sizeKB}KB) — chunking via SmartRead`);

        try {
          const { smartRead } = await import('./smart-read.js');
          const sr = await smartRead(tempPath, opts.userPrompt ?? '', 4000, undefined, opts.onProgress);
          content = sr.content;
        } catch {
          const lines = content.split('\n');
          content = [
            `[Large output: ${lineCount} lines, ${sizeKB}KB — saved to ${tempPath}]`,
            '',
            ...lines.slice(0, 50),
            '',
            `... [${lineCount - 70} lines in temp file] ...`,
            '',
            ...lines.slice(-20),
          ].join('\n');
        }
      }
      const block: ContentBlock = {
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content,
        ...(r.isError === true ? { isError: true } : {}),
      };
      return block;
    }));

    const userMsg: LLMMessage = { role: 'user', content: resultBlocks };
    workingMessages.push(userMsg);
    producedMessages.push(userMsg);

    // Reset accumulated text for next iteration
    finalResponse = '';
  }

  const hitLimit = iterations >= maxIterations;
  if (hitLimit && !finalResponse) {
    finalResponse = '[max tool iterations reached]';
    producedMessages.push({ role: 'assistant', content: finalResponse });
  }

  return {
    response: finalResponse.trim(),
    messages: producedMessages,
    iterations,
    hitLimit,
  };
}
