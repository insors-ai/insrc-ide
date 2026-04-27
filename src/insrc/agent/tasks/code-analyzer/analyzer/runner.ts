/**
 * Per-task analyzer runner.
 *
 * Implements the bounded tool-calling loop described in
 * `design/analyzers/code-analyzer.html` section 7.4 and
 * `plans/analyzers/code-analyzer.md` section 1.4. Wraps the daemon's
 * existing tool registry / executor with a closed tool list and the
 * analyzer-specific budget enforcement: 8 tool calls per task, 60 s
 * wall clock, ~2 MB cumulative `Read` output.
 *
 * Deliberately does NOT reuse `agent/tools/loop.ts` directly:
 *  - The analyzer must produce strict JSON; the loop's
 *    "you-described-a-tool-but-didn't-call-it" nudge is wrong here.
 *  - Output volumes are bounded by per-tool caps; the loop's
 *    spill-large-output-to-tempfile + SmartRead path is unnecessary.
 *  - The 8-call / 60-s caps are not configurable from
 *    daemon/tools/config.ts; they're analyzer-design constants.
 *
 * On parse / citations failure the runner does one targeted retry per
 * failure mode (one for malformed JSON, one for missing citations)
 * before falling back to confidence 'low' per the design's section 15
 * failure table.
 */

import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  ToolCall,
  ToolDefinition,
} from '../../../../shared/types.js';
import type { Session } from '../../../session.js';
import { executeTool, type ToolExecContext } from '../../../tools/executor.js';
import { getLogger } from '../../../../shared/logger.js';
import type {
  AnalysisTask,
  AnalyzerResult,
  ToolCallSummary,
} from '../types.js';
import {
  buildAnalyzerSystemPrompt,
} from '../prompts/analyzer-system.js';
import {
  parseAnalyzerResult,
  type ParseResult,
} from './result-parser.js';
import {
  validateCitations,
  downgradeForMissingCitations,
} from './citations.js';

const log = getLogger('code-analyzer:runner');

// ---------------------------------------------------------------------------
// Caps -- design constants, not config-tunable.
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS = 8;
const MAX_WALL_CLOCK_MS = 60_000;
/** Approximate per-task ceiling on cumulative `Read` rendered output. */
const MAX_CUMULATIVE_READ_BYTES = 2 * 1024 * 1024;
/** Bytes refused per single `Read` call -- corresponds to file:read 512 KB cap. */
const MAX_PER_READ_BYTES = 512 * 1024;
/** Token ceiling for any single provider.complete() in the loop. */
const COMPLETION_MAX_TOKENS = 4000;

// ---------------------------------------------------------------------------
// Closed tool list -- legacy aliases the LLM was trained on.
// Mirrors agent/tasks/shared/investigate.ts but trimmed to the
// analyzer's read-only graph + file + grep set (no Bash, no Glob).
// ---------------------------------------------------------------------------

const ANALYZER_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'Read',
    description:
      'Read a file (or a line range). THIS IS THE CITATION-PRODUCING CALL. ' +
      'Per-call cap ~512 KB; cumulative ~2 MB per task.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or cwd-relative path.' },
        offset: { type: 'number', description: '1-based start line (optional).' },
        limit: { type: 'number', description: 'Lines to return (optional).' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Grep',
    description:
      'ripgrep over file contents. Result cap ~200 lines. Use when neither ' +
      'graph_search nor graph_entity surfaced the symbol -- obscure helpers, ' +
      'recent additions not yet indexed, string literals.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Root directory (optional).' },
        glob: { type: 'string', description: 'File-glob filter, e.g. "*.ts" (optional).' },
        include_context: { type: 'number', description: 'Lines of context (optional).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'ListDirectory',
    description: 'List directory contents. Use sparingly; prefer graph_search for code discovery.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
      },
      required: ['path'],
    },
  },
  {
    name: 'graph_search',
    description:
      'Vector similarity search (LanceDB ANN) over indexed code entities, ' +
      'scoped to the active repo dependency closure. Returns short entity ' +
      'stubs with relevance scores. Always the FIRST step on locate / ' +
      'free-form tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: 'Max hits (default 10).' },
        kind: { type: 'string', description: 'Restrict to entity kind (optional).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'graph_entity',
    description:
      'Canonical entity summary (signature + body + neighbours-summary). ' +
      'Counts as a code-read for citation purposes; prefer over raw Read ' +
      'when you have an entity id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entity id (sha256 hex).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'graph_callers',
    description: 'Entities that call the given entity, up to N hops (default 1).',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name or id.' },
        hops: { type: 'number', description: 'Max hop depth (default 1).' },
        full_body: { type: 'boolean', description: 'Include full body text (default false).' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'graph_callees',
    description: 'Entities the given entity calls, up to N hops (default 1).',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name or id.' },
        hops: { type: 'number', description: 'Max hop depth (default 1).' },
        full_body: { type: 'boolean', description: 'Include full body text (default false).' },
      },
      required: ['entity'],
    },
  },
];

/** Names accepted by the analyzer. The runner refuses anything else. */
const ALLOWED_NAMES: ReadonlySet<string> = new Set(ANALYZER_TOOLS.map(t => t.name));

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunAnalyzerOpts {
  /** Local LLM provider (Ollama by default; @mention upgrade-able). */
  provider: LLMProvider;
  /** Session that scopes graph_* tools to the active repo closure. */
  session: Session;
  /** Optional progress callback for tool-call traces. */
  onProgress?: ((message: string) => void) | undefined;
  /** Cancellation signal forwarded to executeTool. */
  signal?: AbortSignal | undefined;
  /**
   * Per-call path approval check (Phase 1.6 fs-access gate). Called
   * with the absolute path the analyzer wants to read before
   * executeTool runs for fs-class tools (Read / Grep / ListDirectory).
   * The orchestrator implements this against its session-scoped
   * approvedDirs registry and fires a user gate for unapproved
   * out-of-repo paths.
   *
   * When unset, all paths are allowed (Phase 1.4 default behaviour).
   */
  checkPathAccess?: ((path: string) => Promise<{ allowed: boolean; reason?: string }>) | undefined;
}

export interface RunAnalyzerOutcome {
  /** Final, validated AnalyzerResult (always present, even on retry exhaustion). */
  readonly result: AnalyzerResult;
  /**
   * Set when one or both retry paths fired. Surfaced on
   * AnalysisItemMeta.warning so the todos pane row tooltip can show it.
   */
  readonly warning?: string;
  /** True when the loop hit MAX_TOOL_CALLS or MAX_WALL_CLOCK_MS. */
  readonly truncated: boolean;
}

/**
 * Run one analyzer task end-to-end. Single entry point the orchestrator
 * calls per TodoItem.
 */
export async function runAnalyzer(
  task: AnalysisTask,
  opts: RunAnalyzerOpts,
): Promise<RunAnalyzerOutcome> {
  const messages = buildInitialMessages(task);
  const callTrace: ToolCallSummary[] = [];
  let cumulativeReadBytes = 0;
  const startedAt = Date.now();

  // -- main tool-calling loop --
  let iter = 0;
  let lastText = '';
  while (iter < MAX_TOOL_CALLS) {
    if (Date.now() - startedAt > MAX_WALL_CLOCK_MS) {
      log.warn({ itemId: task.itemId, iter }, 'analyzer hit wall-clock cap');
      break;
    }

    const llmResponse: LLMResponse = await opts.provider.complete(messages, {
      tools: ANALYZER_TOOLS as ToolDefinition[],
      maxTokens: COMPLETION_MAX_TOKENS,
    });
    lastText = llmResponse.text ?? '';

    if (llmResponse.stopReason !== 'tool_use' || !llmResponse.toolCalls?.length) {
      // Final turn -- model returned text (expected to be JSON).
      break;
    }

    iter++;
    messages.push({
      role: 'assistant',
      content: lastText.length > 0 ? `${lastText}\n[tool calls executed]` : '[tool calls executed]',
    });

    const resultsBlock: string[] = [];
    for (const call of llmResponse.toolCalls) {
      if (!ALLOWED_NAMES.has(call.name)) {
        const msg = `[error] tool "${call.name}" is not in the analyzer's closed list`;
        callTrace.push({ name: call.name, argsHash: '', durationMs: 0, resultRows: 0, error: msg });
        resultsBlock.push(renderToolResultBlock(call.id, msg, true));
        continue;
      }
      // Pre-budget gate for Read (the only call class with a cumulative cap).
      if (call.name === 'Read' && cumulativeReadBytes >= MAX_CUMULATIVE_READ_BYTES) {
        const msg = `[error] Read cumulative cap (${MAX_CUMULATIVE_READ_BYTES} bytes) reached`;
        callTrace.push({ name: call.name, argsHash: hashArgs(call.input), durationMs: 0, resultRows: 0, error: msg });
        resultsBlock.push(renderToolResultBlock(call.id, msg, true));
        continue;
      }
      // fs-access gate (Phase 1.6) -- consult the orchestrator-supplied
      // checkPathAccess callback for fs-class tools. The callback may
      // suspend on a user gate; we await its decision before deciding
      // whether to execute the tool.
      if (opts.checkPathAccess !== undefined) {
        const requestedPath = extractPathArg(call);
        if (requestedPath !== undefined) {
          const decision = await opts.checkPathAccess(requestedPath);
          if (!decision.allowed) {
            const msg = `[error] PermissionDenied: ${decision.reason ?? `access to ${requestedPath} not approved`}`;
            callTrace.push({
              name: call.name,
              argsHash: hashArgs(call.input),
              durationMs: 0,
              resultRows: 0,
              error: msg,
            });
            resultsBlock.push(renderToolResultBlock(call.id, msg, true));
            continue;
          }
        }
      }

      const t0 = Date.now();
      const execCtx: ToolExecContext = {
        session: opts.session,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      };
      const r = await executeTool(call, execCtx);
      const durationMs = Date.now() - t0;

      // Per-call Read cap: refuse oversize content but still surface what
      // the call returned so the analyzer can keep going.
      let content = r.content;
      let perCallTrimmed = false;
      if (call.name === 'Read' && content.length > MAX_PER_READ_BYTES) {
        content = content.slice(0, MAX_PER_READ_BYTES) + '\n[truncated -- per-Read cap reached]';
        perCallTrimmed = true;
      }
      if (call.name === 'Read' && !r.isError) {
        cumulativeReadBytes += content.length;
      }

      const trace: ToolCallSummary = {
        name: call.name,
        argsHash: hashArgs(call.input),
        durationMs,
        resultRows: estimateRowCount(content),
        ...(r.isError ? { error: content.slice(0, 200) } : {}),
      };
      callTrace.push(trace);
      opts.onProgress?.(`[analyzer] ${call.name}(${summariseInput(call.input)}) -> ${trace.resultRows} rows in ${durationMs}ms`);

      resultsBlock.push(
        renderToolResultBlock(
          call.id,
          perCallTrimmed
            ? `${content}\n[note: original output exceeded ${MAX_PER_READ_BYTES} bytes; analyzer received truncated content]`
            : content,
          r.isError === true,
        ),
      );
    }
    messages.push({ role: 'user', content: resultsBlock.join('\n\n') });
  }

  const truncated = iter >= MAX_TOOL_CALLS || Date.now() - startedAt > MAX_WALL_CLOCK_MS;

  // -- parse + retry on bad JSON --
  let parsed = parseAnalyzerResult(lastText, task.itemId);
  let parseRetried = false;
  if (!parsed.ok) {
    log.warn({ itemId: task.itemId, reason: parsed.reason, detail: parsed.detail }, 'analyzer JSON parse failed; retrying once');
    parseRetried = true;
    messages.push({ role: 'assistant', content: lastText });
    messages.push({
      role: 'user',
      content:
        'Your previous response was not valid AnalyzerResult JSON ' +
        `(${parsed.reason}: ${parsed.detail}). Reply with ONLY a single JSON ` +
        'object matching the schema in the system prompt -- no prose, no ' +
        'fences, no <think> blocks, nothing before `{` or after `}`.',
    });
    const retryResp = await opts.provider.complete(messages, {
      tools: [],
      maxTokens: COMPLETION_MAX_TOKENS,
      responseFormat: 'json',
    });
    lastText = retryResp.text ?? '';
    parsed = parseAnalyzerResult(lastText, task.itemId);
  }

  if (!parsed.ok) {
    log.warn({ itemId: task.itemId, reason: parsed.reason }, 'analyzer JSON retry also failed; falling back to prose-only result');
    const fallback: AnalyzerResult = {
      itemId: task.itemId,
      answer: lastText.length > 0
        ? lastText
        : 'Analyzer returned no parseable response after one retry.',
      findings: [],
      citations: [],
      confidence: 'low',
      toolCalls: callTrace,
      ...(truncated ? { truncated: true } : {}),
    };
    return {
      result: fallback,
      warning: `analyzer JSON unparseable after retry (${parsed.reason}: ${parsed.detail})`,
      truncated,
    };
  }

  // -- citations invariant + one retry --
  let result = withRunnerToolCalls(parsed.result, callTrace, truncated);
  const validation = validateCitations(result);
  if (!validation.ok) {
    log.warn(
      { itemId: task.itemId, findingIndex: validation.findingIndex },
      'analyzer findings missing citations; retrying once',
    );
    messages.push({ role: 'assistant', content: lastText });
    messages.push({
      role: 'user',
      content:
        `Finding [${validation.findingIndex}] has no citations. Every finding ` +
        'MUST include at least one entry in its `citations` array (path + lineRange). ' +
        'Reply with the corrected strict JSON; preserve everything else as-is.',
    });
    const retryResp = await opts.provider.complete(messages, {
      tools: [],
      maxTokens: COMPLETION_MAX_TOKENS,
      responseFormat: 'json',
    });
    const retryParsed: ParseResult = parseAnalyzerResult(retryResp.text ?? '', task.itemId);
    if (retryParsed.ok) {
      const retryResult = withRunnerToolCalls(retryParsed.result, callTrace, truncated);
      const retryValidation = validateCitations(retryResult);
      if (retryValidation.ok) {
        return { result: retryResult, truncated };
      }
      // Retry produced citations on most findings but missed others; downgrade.
      return {
        result: downgradeForMissingCitations(retryResult),
        warning: 'one or more findings still missing citations after retry; confidence downgraded to low',
        truncated,
      };
    }
    // Retry produced unparseable JSON; downgrade the original.
    return {
      result: downgradeForMissingCitations(result),
      warning: 'citations-invariant retry returned unparseable JSON; confidence downgraded to low',
      truncated,
    };
  }

  return parseRetried
    ? { result, warning: 'analyzer JSON required one strict-JSON retry', truncated }
    : { result, truncated };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInitialMessages(task: AnalysisTask): LLMMessage[] {
  const userBody = [
    '# Task',
    JSON.stringify(
      {
        kind: task.kind,
        question: task.question,
        scope: task.scope,
        retryCount: task.retryCount,
        hint: task.hint,
        origin: task.origin,
      },
      null,
      2,
    ),
    '',
    '# Output',
    'Run the per-kind playbook from the system prompt; reply with the strict-JSON',
    'AnalyzerResult shape only on the final turn (no prose, no fences).',
  ].join('\n');

  return [
    { role: 'system', content: buildAnalyzerSystemPrompt() },
    { role: 'user', content: userBody },
  ];
}

/**
 * Stamp the runner-tracked toolCalls + truncated flag onto the parsed
 * result. The parser already populated these from the model's claimed
 * trace, but the runner's own trace is authoritative.
 */
function withRunnerToolCalls(
  result: AnalyzerResult,
  toolCalls: readonly ToolCallSummary[],
  truncated: boolean,
): AnalyzerResult {
  return {
    ...result,
    toolCalls,
    ...(truncated ? { truncated: true } : {}),
  };
}

function renderToolResultBlock(toolCallId: string, content: string, isError: boolean): string {
  const prefix = isError ? '[error] ' : '';
  return `<tool_result tool_call_id="${toolCallId}">\n${prefix}${content}\n</tool_result>`;
}

function summariseInput(input: Record<string, unknown>): string {
  const first = Object.values(input)[0];
  if (typeof first === 'string') {
    return first.length > 60 ? first.slice(0, 57) + '...' : first;
  }
  return JSON.stringify(input).slice(0, 60);
}

function estimateRowCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

/**
 * Quick stable hash over canonicalised tool-call args so the trace
 * doesn't leak path strings while still letting us deduplicate
 * "the same call twice in a row".
 */
function hashArgs(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortKeys(input));
  let h = 0;
  for (let i = 0; i < canonical.length; i++) {
    h = ((h << 5) - h + canonical.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * Extract the filesystem path argument the analyzer wants to read for
 * fs-class tool calls. Returns undefined for tools that don't read
 * paths or for calls that omit the path arg (Grep without `path`
 * defaults to cwd, which is in-repo).
 */
function extractPathArg(call: ToolCall): string | undefined {
  if (call.name === 'Read') {
    const v = call.input['file_path'];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }
  if (call.name === 'Grep' || call.name === 'ListDirectory') {
    const v = call.input['path'];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }
  return undefined;
}
