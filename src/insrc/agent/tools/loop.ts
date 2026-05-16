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
  /**
   * Token budget for the LLM's INPUT context (Phase C of the
   * interleaved-investigation plan). When the estimated input tokens
   * exceed `maxInputTokens * 0.7`, the loop runs an eviction pass
   * that stubs `tool_result` blocks whose analysis paragraph is
   * already in history. Set to a generous fraction of the active
   * model's max-input window; default 16000 (suits both qwen3-coder
   * and devstral-small-2).
   */
  maxInputTokens?: number | undefined;
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
  /** Number of tool_result blocks the eviction policy stubbed (Phase C). */
  evictionsApplied: number;
  /** Estimated tokens in the final working-message set (Phase D telemetry). */
  inputTokensFinal: number;
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

  // Interleaved-investigation memory model: every assistant turn's text is
  // a paragraph of the section. `sectionParagraphs` collects them in order;
  // `currentTurnText` is the per-iteration scratchpad that flushes into the
  // section list at the end of each iteration.
  //
  // The returned `response` is `sectionParagraphs.join('\n\n')`, not just
  // the final turn's text -- so callers that drive interleaved-investigation
  // (the code-analyzer section writer) get the full paragraph stream.
  // Callers whose model emits text only on the final turn (Pair / Delegate
  // / Brainstorm in the common case) see the same string they did before.
  const sectionParagraphs: string[] = [];
  let currentTurnText = '';
  let iterations = 0;
  let nudgeCount = 0;
  let evictionsApplied = 0;

  const { maxIterations: globalMaxIterations, maxNudges } = getToolSettings().loop;
  const maxIterations    = opts.maxIterations  ?? globalMaxIterations;
  const maxInputTokens   = opts.maxInputTokens ?? 16000;
  const evictionThreshold = Math.floor(maxInputTokens * 0.7);

  while (iterations < maxIterations) {
    // Phase C.2: before each provider call, run an eviction pass if
    // working memory is approaching the input-token budget. Eviction
    // stubs tool_result blocks whose analysis paragraph is already in
    // history; the disk spill remains the source of truth for any
    // future skill_load_page reads.
    evictionsApplied += maybeEvict(workingMessages, evictionThreshold);

    // Call LLM with tool definitions — stream text via onToken if callback provided
    const completionOpts: { tools: ToolDefinition[]; maxTokens?: number; onToken?: (t: string) => void } = { tools };
    if (opts.maxTokens !== undefined) completionOpts.maxTokens = opts.maxTokens;
    if (onTextDelta) {
      completionOpts.onToken = (token: string) => {
        currentTurnText += token;
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
      currentTurnText += llmResponse.text;
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
      const lastSentence = currentTurnText.trim().split(/[.!?\n]/).filter(s => s.trim()).pop()?.trim().toLowerCase() ?? '';
      const referencesTool = toolNames.some(name =>
        lastSentence.includes(name.toLowerCase())
      ) || /\b(check|read|look at|examine|list|search|find|grep|scan)\b.*\b(file|directory|folder|log|path|content)\b/i.test(lastSentence);
      const isFutureTense = /\b(let me|i'll|i will|i need to|i should|i can|going to)\b/i.test(lastSentence);

      if (referencesTool && isFutureTense && nudgeCount < maxNudges) {
        // LLM's final sentence describes a tool action it didn't take.
        // Push the partial text into the paragraph stream (still useful as
        // analysis prose) and re-prompt with a corrective user turn.
        if (currentTurnText.trim().length > 0) {
          sectionParagraphs.push(currentTurnText.trim());
        }
        workingMessages.push({ role: 'assistant', content: currentTurnText });
        workingMessages.push({ role: 'user', content: 'You described an action but did not call a tool. Use the available tools to perform it now.' });
        currentTurnText = '';
        nudgeCount++;
        continue;
      }
      // No-tool-call turn = the closing turn. Flush its text into the
      // section stream and exit the loop.
      if (currentTurnText.trim().length > 0) {
        sectionParagraphs.push(currentTurnText.trim());
      }
      producedMessages.push({ role: 'assistant', content: currentTurnText });
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

    // Flush this iteration's text into the paragraph stream + reset for
    // the next iteration. Each tool-use turn that included accompanying
    // text contributes a paragraph to the final section.
    if (currentTurnText.trim().length > 0) {
      sectionParagraphs.push(currentTurnText.trim());
    }
    currentTurnText = '';
  }

  const hitLimit = iterations >= maxIterations;
  if (hitLimit) {
    // If we ran out of iterations, the current turn's partial text (if
    // any) was never flushed by the per-iteration tail. Capture it now
    // so it doesn't disappear.
    if (currentTurnText.trim().length > 0) {
      sectionParagraphs.push(currentTurnText.trim());
    }
    if (sectionParagraphs.length === 0) {
      sectionParagraphs.push('[max tool iterations reached]');
      producedMessages.push({ role: 'assistant', content: '[max tool iterations reached]' });
    }
  }

  return {
    response: sectionParagraphs.join('\n\n').trim(),
    messages: producedMessages,
    iterations,
    hitLimit,
    evictionsApplied,
    inputTokensFinal: estimateTokens(workingMessages),
  };
}

// ---------------------------------------------------------------------------
// Phase C helpers: estimateTokens + maybeEvict
// ---------------------------------------------------------------------------

/**
 * Cheap heuristic token estimator over an `LLMMessage[]`. Uses a
 * chars-per-token ratio of 3 (the same ratio the rest of the project
 * uses, from `agent/context/budget.ts`). Not precise, but precise
 * enough to drive an eviction trigger.
 */
function estimateTokens(messages: readonly LLMMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else {
      for (const block of m.content) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'tool_use') chars += block.name.length + JSON.stringify(block.input).length + 16;
        else if (block.type === 'tool_result') chars += block.content.length;
        else if (block.type === 'image') chars += 256;     // rough placeholder for image attachments
        else if (block.type === 'document') chars += 512;  // rough placeholder for PDFs
      }
    }
  }
  return Math.ceil(chars / 3);
}

/**
 * Walk the working-message array oldest-to-newest; for each `tool_result`
 * block whose subsequent assistant turn contains a substantive text block,
 * replace the result content with a stub. Stops as soon as the estimate
 * drops below the budget. Returns the number of tool_result blocks
 * stubbed.
 *
 * Eviction never affects:
 *   - the system message (workingMessages[0])
 *   - the initial user message (workingMessages[1])
 *   - the most-recent user message (so the model can still read its
 *     latest evidence)
 *   - any assistant text or tool_use blocks (they're the load-bearing
 *     narrative + action history)
 *
 * "Substantive" = text block length >= 50 chars.
 */
function maybeEvict(workingMessages: LLMMessage[], budget: number): number {
  if (estimateTokens(workingMessages) <= budget) return 0;

  const lastIdx = workingMessages.length - 1;
  let evicted = 0;

  for (let i = 2; i < lastIdx; i++) {
    const msg = workingMessages[i]!;
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    const blocks = msg.content as ContentBlock[];

    // Has a subsequent assistant text block of >= 50 chars been written?
    if (!hasSubsequentTextAnalysis(workingMessages, i)) continue;

    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b]!;
      if (block.type !== 'tool_result') continue;
      if (block.content.startsWith('[evicted')) continue;   // already stubbed

      // Preserve the spillId (if any) so the model can still page into
      // the on-disk spill after eviction. The renderer formats it as
      // "_Full payload spilled to `<spillId>` ..._"; we extract the
      // backtick-quoted id.
      const spillIdMatch = block.content.match(/spilled to `([^`]+)`/);
      const spillIdHint  = spillIdMatch ? ` spillId: ${spillIdMatch[1]}` : '';
      const stub = `[evicted${spillIdHint}]`;

      // Only evict if the stub is materially smaller than the original.
      // For tiny tool_results (e.g. errors), the stub can be LARGER --
      // skip those to avoid net-negative evictions.
      if (stub.length >= block.content.length) continue;

      blocks[b] = {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: stub,
        ...(block.isError === true ? { isError: true as const } : {}),
      };
      evicted++;
      if (estimateTokens(workingMessages) <= budget) return evicted;
    }
  }
  return evicted;
}

function hasSubsequentTextAnalysis(workingMessages: readonly LLMMessage[], afterIdx: number): boolean {
  for (let i = afterIdx + 1; i < workingMessages.length; i++) {
    const m = workingMessages[i]!;
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') {
      if (m.content.trim().length >= 50) return true;
      continue;
    }
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'text' && b.text.trim().length >= 50) return true;
    }
  }
  return false;
}
