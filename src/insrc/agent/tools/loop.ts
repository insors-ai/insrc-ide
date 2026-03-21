import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  ToolCall,
  ToolResult,
  ToolDefinition,
} from '../../shared/types.js';
import { executeTool, type ToolExecContext } from './executor.js';
import { validateToolCall, type ValidationResult } from './validator.js';

// ---------------------------------------------------------------------------
// Tool Loop Runner
//
// Implements the agentic tool-use loop:
//   1. Send messages + tool definitions to LLM
//   2. If LLM returns tool_use → validate → execute → append results → re-prompt
//   3. Repeat until LLM returns end_turn or max iterations
//
// From design/agent.html:
//   - Read-only tools auto-execute (no validation cost)
//   - Mutating tools require Claude/Haiku validation before execution
//   - Max 25 iterations per turn to prevent runaway loops
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 25;
const MAX_NUDGES = 3;

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
  /** Max tokens for LLM completions */
  maxTokens?: number | undefined;
  /** Callback when an LLM response includes usage info (for cost tracking) */
  onUsage?: ((usage: { inputTokens: number; outputTokens: number }) => void) | undefined;
  /** User's original prompt (passed to SmartRead for intelligent extraction) */
  userPrompt?: string | undefined;
  /** Progress callback for tool execution updates */
  onProgress?: ((message: string) => void) | undefined;
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

  while (iterations < MAX_ITERATIONS) {
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
      // Detect: response references an available tool action but didn't invoke it
      // Only nudge if the response ends with unexpecuted intent (last sentence is future-tense)
      const toolNames = tools.map(t => t.name.toLowerCase());
      const lastSentence = finalResponse.trim().split(/[.!?\n]/).filter(s => s.trim()).pop()?.trim().toLowerCase() ?? '';
      const referencesTool = toolNames.some(name =>
        lastSentence.includes(name.toLowerCase())
      ) || /\b(check|read|look at|examine|list|search|find|grep|scan)\b.*\b(file|directory|folder|log|path|content)\b/i.test(lastSentence);
      const isFutureTense = /\b(let me|i'll|i will|i need to|i should|i can|going to)\b/i.test(lastSentence);

      if (referencesTool && isFutureTense && nudgeCount < MAX_NUDGES) {
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

      // Execute (auto-execute or approved)
      const execCtx: ToolExecContext = {
        userPrompt: opts.userPrompt,
        onProgress: opts.onProgress,
      };
      let result = await executeTool(call, execCtx);

      onToolResult?.(call, result);
      toolResults.push(result);
    }

    // Build the assistant message with tool calls (text so far + indication of tool use)
    const assistantContent = llmResponse.text
      ? `${llmResponse.text}\n[tool calls executed]`
      : '[tool calls executed]';

    workingMessages.push({ role: 'assistant', content: assistantContent });
    producedMessages.push({ role: 'assistant', content: assistantContent });

    // Append tool results — large outputs spill to temp file and get SmartRead-chunked
    const MAX_INLINE_CHARS = 12_000; // ~4K tokens inline, larger goes to temp file
    const resultContent = (await Promise.all(toolResults
      .map(async r => {
        const prefix = r.isError ? '[error] ' : '';
        let content = r.content;
        if (content.length > MAX_INLINE_CHARS) {
          // Spill to temp file, then SmartRead it
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

          // Use SmartRead to extract relevant parts
          try {
            const { smartRead } = await import('./smart-read.js');
            const result = await smartRead(tempPath, opts.userPrompt ?? '', 4000, undefined, opts.onProgress);
            content = result.content;
          } catch {
            // Fallback: head + tail
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
        return `<tool_result tool_call_id="${r.toolCallId}">\n${prefix}${content}\n</tool_result>`;
      })
    ))
      .join('\n\n');

    workingMessages.push({ role: 'user', content: resultContent });
    producedMessages.push({ role: 'user', content: resultContent });

    // Reset accumulated text for next iteration
    finalResponse = '';
  }

  const hitLimit = iterations >= MAX_ITERATIONS;
  if (hitLimit && !finalResponse) {
    finalResponse = '[max tool iterations reached]';
    producedMessages.push({ role: 'assistant', content: finalResponse });
  }

  return {
    response: finalResponse,
    messages: producedMessages,
    iterations,
    hitLimit,
  };
}
