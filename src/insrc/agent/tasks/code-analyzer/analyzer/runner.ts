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
import { ANALYZER_RESULT_SCHEMA } from './schema.js';

/**
 * Single source of truth for the response-format constraint passed to
 * the LLM provider. Wrapping it in a getter makes the intent
 * (Ollama-native JSON-Schema constraint, mirrors instructor-js'
 * structured-outputs path) clearly visible at every call site.
 */
const RESPONSE_FORMAT_SCHEMA = {
  schema: ANALYZER_RESULT_SCHEMA as unknown as Record<string, unknown>,
} as const;

const log = getLogger('code-analyzer:runner');

// ---------------------------------------------------------------------------
// Caps -- design constants, not config-tunable.
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS = 8;
/**
 * Safety upper bound on per-task wall-clock. Generous on purpose --
 * local Ollama models routinely need 30-60 s per iteration; a tight
 * cap forces premature truncation into the strict-JSON retry path
 * (empirically tripled per-item cost on devstral). 10 minutes is
 * the "stuck Ollama" backstop, not a target SLA.
 */
const MAX_WALL_CLOCK_MS = 600_000;
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
      'Vector similarity search (DuckDB VSS HNSW) over indexed code entities, ' +
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
  // Cross-agent: Data Analyzer surface (Phase 4.2 of
  // plans/analyzers/data-analyzer.md). When a code-analysis task
  // surfaces a query against a table, the analyzer can call
  // `data_lineage` to enumerate readers / writers via the data-
  // analyzer's structured probe, or `data_schema-drift` to confirm
  // a Prisma vs live mismatch the code is paying for. Both fail
  // closed on `_crossAgentDepth >= 1` so the depth cap holds.
  {
    name: 'data_lineage',
    description:
      'Cross-agent: cross-link a data target (table / namespace / file) to the code that reads / writes it. ' +
      'Use to ground a code-side observation about a query in the actual call sites.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        target:       { type: 'string' },
        limit:        { type: 'number' },
      },
      required: ['connectionId', 'target'],
    },
  },
  {
    name: 'data_schema-drift',
    description:
      'Cross-agent: diff an RDBMS connection\'s expected schema (Prisma) against the live shape. ' +
      'Returns missing-column / extra-column / type-mismatch / nullable-mismatch / pk-changed / fk-changed.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        target:       { type: 'string' },
      },
      required: ['connectionId', 'target'],
    },
  },
  {
    // F8: control-flow tool. The model calls this when it's done
    // gathering evidence; the runner intercepts the call, treats the
    // structured args as the AnalyzerResult, and exits the loop. Tool
    // args travel through Ollama's structured `tool_calls` wire field
    // (not free-form text), so they're not affected by the
    // format-with-tools-drop quirk that forced the prose-then-retry
    // dance pre-F8. See plans/analyzers/code-analyzer.md F8.
    name: 'submit_analysis',
    description:
      'CALL THIS TO FINISH. Submit your AnalyzerResult as structured ' +
      'arguments. The orchestrator parses the args directly -- do NOT ' +
      'also write JSON in your reply text.',
    inputSchema: ANALYZER_RESULT_SCHEMA as unknown as Record<string, unknown>,
  },
];

/** The `submit_analysis` control-flow tool name -- referenced by the
 *  loop's intercept logic. */
const SUBMIT_TOOL = 'submit_analysis';

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
  /**
   * Optional token streaming callback. When set, fired with each
   * token chunk during free-text LLM emissions in the tool loop.
   * The orchestrator wires this into the chat panel's brainstorm-
   * style "live console" bubble so the user sees raw model output
   * stream in alongside the tool-call traces from `onProgress`.
   * Tokens carry no implicit newline -- the receiver appends inline.
   */
  onToken?: ((token: string) => void) | undefined;
  /** Cancellation signal forwarded to executeTool. */
  signal?: AbortSignal | undefined;
  /**
   * Per-task wall-clock budget. Phase 5.A: the orchestrator passes a
   * tier-driven value (S=30s, M=60s, L=60s, XL=60s, XXL+=90s).
   * Defaults to 60 s -- the pre-Phase-5 Phase-1 budget -- when the
   * caller doesn't supply one.
   */
  wallClockMs?: number | undefined;
  /**
   * Scope tier for this run. Phase 5.B: threaded into the analyzer
   * system prompt so the tier-conditional playbook section
   * (`tierAnalyzerGuidance`) shifts the analytical altitude
   * (per-line citations / signature-level / structural). Defaults
   * to 'M' for backwards compat.
   */
  tier?: import('../../../../shared/classify.js').ScopeSize | undefined;
  /**
   * Plumb-through fields for the universal access gate (Phase 4 of
   * plans/access-gate.md). The orchestrator pre-seeds Session.access
   * with the repo root prefix + any approvedDirs at task start; the
   * dispatcher inside `executeTool` consults that store on every fs-
   * class call and fires a gate UI here when an out-of-repo path
   * misses. These fields tell the dispatcher WHERE to send the gate
   * request -- without them it fails closed and denies the call.
   *
   * The orchestrator threads its own `deps.send`/`deps.channel`/
   * `deps.requestId` straight through; the runner doesn't construct
   * or interpret any of them.
   */
  send?: ToolExecContext['send'];
  channel?: ToolExecContext['channel'];
  requestId?: ToolExecContext['requestId'];
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
  /**
   * Set to true when the strict-JSON retry also failed and the runner
   * returned a synthesised prose-only AnalyzerResult. The orchestrator
   * uses this as a terminal signal (F4): a `retry-with-hint` reviewer
   * decision becomes accept-with-low-confidence because the local
   * model demonstrably can't produce JSON for this task; another
   * 60-s analyzer pass won't help.
   */
  readonly proseOnlyFallback?: boolean;
}

/**
 * Run one analyzer task end-to-end. Single entry point the orchestrator
 * calls per TodoItem.
 */
export async function runAnalyzer(
  task: AnalysisTask,
  opts: RunAnalyzerOpts,
): Promise<RunAnalyzerOutcome> {
  const messages = buildInitialMessages(task, opts.tier ?? 'M');
  const callTrace: ToolCallSummary[] = [];
  let cumulativeReadBytes = 0;
  const startedAt = Date.now();
  const wallClockMs = opts.wallClockMs ?? MAX_WALL_CLOCK_MS;

  // -- main tool-calling loop --
  let iter = 0;
  let lastText = '';
  while (iter < MAX_TOOL_CALLS) {
    if (Date.now() - startedAt > wallClockMs) {
      log.warn({ itemId: task.itemId, iter }, 'analyzer hit wall-clock cap');
      break;
    }

    // Pass the AnalyzerResult JSON Schema as the response-format
    // constraint on every call -- including tool-using ones. The
    // Ollama wrapper's per-family quirks downgrade this to no-format
    // when tools are present AND the model family can't handle
    // format+tools (qwen). For Mistral / Devstral / Codestral the
    // schema constrains the model's text output across the entire
    // tool-calling loop, eliminating the prose-on-final-turn pattern
    // observed in the Phase 1 validation runs.
    const llmResponse: LLMResponse = await opts.provider.complete(messages, {
      tools: ANALYZER_TOOLS as ToolDefinition[],
      maxTokens: COMPLETION_MAX_TOKENS,
      responseFormat: RESPONSE_FORMAT_SCHEMA,
      ...(opts.onToken !== undefined ? { onToken: opts.onToken } : {}),
    });
    lastText = llmResponse.text ?? '';

    if (llmResponse.stopReason !== 'tool_use' || !llmResponse.toolCalls?.length) {
      // Final turn -- model returned text (expected to be JSON).
      break;
    }

    // F8: intercept submit_analysis BEFORE entering the per-tool
    // execution loop. The model signals task completion by calling
    // this control-flow tool with the AnalyzerResult shape as args;
    // we stringify the args so the existing parse path downstream
    // handles validation + citations + retry uniformly. Multi-tool
    // turns where the model calls submit_analysis alongside other
    // tools resolve to "we're done" -- the other calls in this turn
    // are dropped (the model already produced the answer).
    const submitCall = llmResponse.toolCalls.find(c => c.name === SUBMIT_TOOL);
    if (submitCall) {
      lastText = JSON.stringify(submitCall.input);
      callTrace.push({
        name: SUBMIT_TOOL,
        argsHash: hashArgs(submitCall.input),
        durationMs: 0,
        resultRows: Object.keys(submitCall.input).length,
      });
      opts.onProgress?.(`[analyzer] ${SUBMIT_TOOL} called -- finishing task`);
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
      // Universal access gate dispatch happens INSIDE executeTool
      // (Phase 2 of plans/access-gate.md) -- the runner just plumbs
      // send/channel/requestId so the dispatcher can fire a gate UI
      // when a path misses Session.access. The orchestrator pre-seeds
      // the repo root + approvedDirs at task start, so in-repo reads
      // never gate.
      const t0 = Date.now();
      const execCtx: ToolExecContext = {
        session: opts.session,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.send !== undefined ? { send: opts.send } : {}),
        ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
        ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
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

  const truncated = iter >= MAX_TOOL_CALLS || Date.now() - startedAt > wallClockMs;

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
        'Your previous result did not validate as an AnalyzerResult ' +
        `(${parsed.reason}: ${parsed.detail}). The submit_analysis tool ` +
        'is not available on this retry -- write the corrected JSON in ' +
        'your reply text instead. Reply with ONLY a single JSON object ' +
        'matching the AnalyzerResult shape from the system prompt -- no ' +
        'prose, no fences, no <think> blocks, nothing before `{` or ' +
        'after `}`.',
    });
    const retryResp = await opts.provider.complete(messages, {
      tools: [],
      maxTokens: COMPLETION_MAX_TOKENS,
      responseFormat: RESPONSE_FORMAT_SCHEMA,
      ...(opts.onToken !== undefined ? { onToken: opts.onToken } : {}),
    });
    lastText = retryResp.text ?? '';
    parsed = parseAnalyzerResult(lastText, task.itemId);
  }

  if (!parsed.ok) {
    // Log `detail` alongside `reason` so the schema_violation path
    // names the specific parser rule that failed (e.g. "missing or
    // empty `answer`", "findings[2].concern \"complexity\" is not a
    // recognised CodeAnalysisConcern"). Without this, F10 in
    // plans/analyzers/code-analyzer.md was a black box -- we knew
    // the retry failed but not why.
    log.warn({ itemId: task.itemId, reason: parsed.reason, detail: parsed.detail }, 'analyzer JSON retry also failed; falling back to prose-only result');
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
      proseOnlyFallback: true,
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
      responseFormat: RESPONSE_FORMAT_SCHEMA,
      ...(opts.onToken !== undefined ? { onToken: opts.onToken } : {}),
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

function buildInitialMessages(
  task: AnalysisTask,
  tier: import('../../../../shared/classify.js').ScopeSize,
): LLMMessage[] {
  const userBody = [
    '# Task',
    JSON.stringify(
      {
        kind: task.kind,
        question: task.question,
        scope: task.scope,
        tier,
        retryCount: task.retryCount,
        hint: task.hint,
        origin: task.origin,
      },
      null,
      2,
    ),
    '',
    '# Output',
    'Run the per-kind playbook from the system prompt. When you have',
    'enough evidence to answer, call the `submit_analysis` tool with',
    'your AnalyzerResult as structured arguments. Do NOT write the',
    'result as JSON in your reply text -- use the tool.',
  ].join('\n');

  return [
    { role: 'system', content: buildAnalyzerSystemPrompt(tier) },
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

