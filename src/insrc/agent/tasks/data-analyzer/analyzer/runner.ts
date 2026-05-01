/**
 * Per-task analyzer runner for the Data Analyzer.
 *
 * Mirrors agent/tasks/code-analyzer/analyzer/runner.ts: bounded tool-
 * calling loop, JSON-schema response-format constraint, control-flow
 * `submit_analysis` tool, JSON parse + citations-invariant retry,
 * one-retry-then-downgrade fallback. Key differences:
 *
 *   - Tool inventory uses the SHIPPED data-driver builtins (db:*)
 *     instead of the code-analyzer's graph_* / Read / Grep / etc.
 *   - Per-call connection-approval gate fires BEFORE the first tool
 *     call against any connectionId not yet approved this session.
 *     Mirrors the code-analyzer's fs-access gate but keyed on
 *     connection ids instead of paths.
 *   - No cumulative-byte cap: db:* tools have per-call row caps and
 *     return structured driver output, not arbitrary file content,
 *     so the code-analyzer's MAX_CUMULATIVE_READ_BYTES tracking
 *     doesn't apply.
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
import type { ScopeSize } from '../../../../shared/classify.js';
import type {
  BlockedReason,
  DataAnalysisTask,
  DataAnalyzerResult,
  ToolCallSummary,
} from '../types.js';
import { buildAnalyzerSystemPrompt } from '../prompts/analyzer-system.js';
import { parseDataAnalyzerResult, type ParseResult } from './result-parser.js';
import {
  validateCitations,
  downgradeForMissingCitations,
} from './citations.js';
import { DATA_ANALYZER_RESULT_SCHEMA } from './schema.js';

const RESPONSE_FORMAT_SCHEMA = {
  schema: DATA_ANALYZER_RESULT_SCHEMA as unknown as Record<string, unknown>,
} as const;

const log = getLogger('data-analyzer:runner');

// ---------------------------------------------------------------------------
// Caps -- design constants, not config-tunable.
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS = 8;
/**
 * Safety upper bound on per-task wall-clock. Generous on purpose --
 * local Ollama models routinely need 30-60 s per iteration; a tight
 * cap forces premature truncation. 10 minutes is the "stuck Ollama"
 * backstop, not a target SLA. Per the no-walltime-caps lesson from
 * the code-analyzer rollout (commit ee036d9ad17 was an interim).
 */
const MAX_WALL_CLOCK_MS = 600_000;
const COMPLETION_MAX_TOKENS = 4000;

// ---------------------------------------------------------------------------
// Closed tool list -- the data-driver's shipped builtins.
// ---------------------------------------------------------------------------

const DB_LIST_CONNECTIONS = 'db_list_connections';
const DB_SQL_DESCRIBE     = 'db_sql_describe';
const DB_SQL_SAMPLE       = 'db_sql_sample';
const DB_SQL_EXPLAIN      = 'db_sql_explain';
const DB_KV_SCAN          = 'db_kv_scan';
const DB_KV_GET           = 'db_kv_get';
const DB_KV_SAMPLE_SHAPE  = 'db_kv_sample_shape';
const DB_FILE_DESCRIBE    = 'db_file_describe';
const DB_FILE_SAMPLE      = 'db_file_sample';
const DB_FILE_SAMPLE_SHAPE = 'db_file_sample_shape';
const DATA_LINEAGE        = 'data_lineage';
const DATA_SCHEMA_DRIFT   = 'data_schema-drift';
const CODE_LOCATE         = 'code_locate';
const CODE_TRACE          = 'code_trace';
const CODE_DESCRIBE       = 'code_describe';
const SUBMIT_TOOL         = 'submit_analysis';

const ANALYZER_TOOLS: readonly ToolDefinition[] = [
  {
    name: DB_LIST_CONNECTIONS,
    description: 'List every data-driver connection configured for the active repo. Use first to pick a connectionId.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: DB_SQL_DESCRIBE,
    description: 'Describe an RDBMS table/view (columns + types + nullability + PK/FK). Use before db:sql:sample.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        target:       { type: 'string', description: 'Table/view, e.g. "users" or "public.users".' },
      },
      required: ['connectionId', 'target'],
    },
  },
  {
    name: DB_SQL_SAMPLE,
    description: 'Sample rows from an RDBMS table. Structured `where` only (no raw SQL). Cap 50 rows.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        target:       { type: 'string' },
        where:        { type: 'object' },
        limit:        { type: 'number' },
      },
      required: ['connectionId', 'target'],
    },
  },
  {
    name: DB_SQL_EXPLAIN,
    description: 'Per-dialect EXPLAIN. Use sparingly for capacity-risk findings.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        target:       { type: 'string' },
        where:        { type: 'object' },
      },
      required: ['connectionId', 'target'],
    },
  },
  {
    name: DB_KV_SCAN,
    description: 'Scan keys in a KV connection (Redis, etcd, Memcached, ...). Cap 500 keys.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        namespace:    { type: 'string' },
        limit:        { type: 'number' },
      },
      required: ['connectionId'],
    },
  },
  {
    name: DB_KV_GET,
    description: 'Fetch one key from a KV connection.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        key:          { type: 'string' },
      },
      required: ['connectionId', 'key'],
    },
  },
  {
    name: DB_KV_SAMPLE_SHAPE,
    description: 'Merge value shapes via inferShape across many KV values. Cap 50 values.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        keyPattern:   { type: 'string' },
        limit:        { type: 'number' },
      },
      required: ['connectionId', 'keyPattern'],
    },
  },
  {
    name: DB_FILE_DESCRIBE,
    description: 'File-driver introspection (CSV header, parquet schema, jsonl first record).',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        path:         { type: 'string' },
      },
      required: ['connectionId'],
    },
  },
  {
    name: DB_FILE_SAMPLE,
    description: 'File-driver row sample.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        path:         { type: 'string' },
        limit:        { type: 'number' },
      },
      required: ['connectionId'],
    },
  },
  {
    name: DB_FILE_SAMPLE_SHAPE,
    description: 'File-driver merged shape via inferShape. Cap 50 records.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        path:         { type: 'string' },
        limit:        { type: 'number' },
      },
      required: ['connectionId'],
    },
  },
  {
    name: DATA_LINEAGE,
    description:
      'Cross-link a data target (table / namespace / file) to the code that reads or writes it. ' +
      'Returns reader / writer / ambiguous classification per code citation. Use for `lineage` tasks ' +
      'or whenever a finding needs to point readers at the call sites behind a schema observation.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        target:       { type: 'string', description: 'Table name (RDBMS), key pattern (KV), or file path (file driver).' },
        limit:        { type: 'number' },
      },
      required: ['connectionId', 'target'],
    },
  },
  {
    name: DATA_SCHEMA_DRIFT,
    description:
      'Diff an RDBMS connection\'s expected schema (Prisma) against the live shape. Reports ' +
      'missing-column / extra-column / type-mismatch / nullable-mismatch / pk-changed / fk-changed. ' +
      'When the connection has no Prisma schemaSource, returns confidence:"low" with a "no static ' +
      'schema source" note rather than fabricating findings.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        target:       { type: 'string', description: 'Table name (Prisma model OR @@map target).' },
      },
      required: ['connectionId', 'target'],
    },
  },
  // Cross-agent surface (Phase 4.2 of plans/analyzers/data-analyzer.md).
  // The data-analyzer's lineage / schema-drift findings often want to
  // ground in code citations; the Code Analyzer's lookup tools provide
  // those. The tools fail closed on `_crossAgentDepth >= 1` so the
  // depth cap holds when this analyzer was itself invoked
  // cross-agent. When the Code Analyzer isn't registered in this
  // daemon build the tool calls return TOOL_UNAVAILABLE and the
  // analyzer LLM downgrades the affected findings.
  {
    name: CODE_LOCATE,
    description:
      'Cross-agent: vector + entity lookup over the active session\'s code knowledge graph. ' +
      'Returns small entity stubs for "where is X defined?" follow-ups behind a lineage / drift finding.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: CODE_TRACE,
    description:
      'Cross-agent: CALLS-edge graph walk for "who calls X / what does X call?". Pair with code_locate ' +
      'to seed an entityId, then trace one or two hops to surface readers / writers behind a table.',
    inputSchema: {
      type: 'object',
      properties: {
        entityId:  { type: 'string' },
        direction: { type: 'string', enum: ['callers', 'callees', 'both'] },
        depth:     { type: 'number' },
      },
      required: ['entityId'],
    },
  },
  {
    name: CODE_DESCRIBE,
    description:
      'Cross-agent: full entity card (signature + body + 1-hop neighbours summary) for a given entityId.',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string' },
      },
      required: ['entityId'],
    },
  },
  {
    // Control-flow tool -- the model calls this when finished.
    name: SUBMIT_TOOL,
    description: 'CALL THIS TO FINISH. Submit your DataAnalyzerResult as structured arguments.',
    inputSchema: DATA_ANALYZER_RESULT_SCHEMA as unknown as Record<string, unknown>,
  },
];

const ALLOWED_NAMES: ReadonlySet<string> = new Set(ANALYZER_TOOLS.map(t => t.name));

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunDataAnalyzerOpts {
  readonly provider: LLMProvider;
  readonly session: Session;
  readonly onProgress?: ((message: string) => void) | undefined;
  readonly onToken?: ((token: string) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly wallClockMs?: number | undefined;
  readonly tier?: ScopeSize | undefined;
  /**
   * Plumb-through fields for the universal access gate (Phase 4 of
   * plans/access-gate.md). The orchestrator pre-seeds Session.access
   * with auto-approved connection ids (e.g. ephemeral file connections
   * the user typed in their prompt) at task start; the dispatcher
   * inside executeTool consults that store on every db_* call and
   * fires a UI gate here on miss. Without these the dispatcher fails
   * closed and denies the call.
   */
  readonly send?: ToolExecContext['send'];
  readonly channel?: ToolExecContext['channel'];
  readonly requestId?: ToolExecContext['requestId'];
}

export interface RunDataAnalyzerOutcome {
  readonly result: DataAnalyzerResult;
  readonly warning?: string;
  readonly truncated: boolean;
  readonly proseOnlyFallback?: boolean;
}

/**
 * Run one analyzer task end-to-end. Single entry point the orchestrator
 * calls per TodoItem.
 */
export async function runDataAnalyzer(
  task: DataAnalysisTask,
  opts: RunDataAnalyzerOpts,
): Promise<RunDataAnalyzerOutcome> {
  const messages = buildInitialMessages(task, opts.tier ?? 'M');
  const callTrace: ToolCallSummary[] = [];
  const startedAt = Date.now();
  const wallClockMs = opts.wallClockMs ?? MAX_WALL_CLOCK_MS;

  let iter = 0;
  let lastText = '';
  let blockedReason: BlockedReason | undefined;

  while (iter < MAX_TOOL_CALLS) {
    if (Date.now() - startedAt > wallClockMs) {
      log.warn({ itemId: task.itemId, iter }, 'analyzer hit wall-clock cap');
      break;
    }

    const llmResponse: LLMResponse = await opts.provider.complete(messages, {
      tools: ANALYZER_TOOLS as ToolDefinition[],
      maxTokens: COMPLETION_MAX_TOKENS,
      responseFormat: RESPONSE_FORMAT_SCHEMA,
      ...(opts.onToken !== undefined ? { onToken: opts.onToken } : {}),
    });
    lastText = llmResponse.text ?? '';

    if (llmResponse.stopReason !== 'tool_use' || !llmResponse.toolCalls?.length) {
      break;
    }

    // Intercept submit_analysis -- model signalled completion.
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
        if (blockedReason === undefined) {
          const decision = await fireToolErrorGate(call, msg, opts, task);
          if (decision === 'abort') {
            blockedReason = 'tool-error-abort';
            log.warn({ itemId: task.itemId, toolName: call.name }, 'user aborted task on unknown-tool error');
            break;
          }
        }
        continue;
      }

      // Universal access gate dispatch happens INSIDE executeTool
      // (Phase 2 of plans/access-gate.md). The runner just plumbs
      // send/channel/requestId so the dispatcher can fire a UI gate
      // when a connection misses Session.access. The orchestrator
      // pre-seeds ephemeral connections (auto-approved on registration)
      // at task start; gated connections raise a generic "Approve
      // connection use" prompt.
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

      // Detect access-gate denial so the result carries blockedReason
      // even if the model can't recover with another tool call. The
      // dispatcher prefixes its denial body with "ACCESS_DENIED:" --
      // string-match is robust enough since no other tool result uses
      // that token.
      const isAccessDenied = r.isError === true && r.content.includes('ACCESS_DENIED');
      if (isAccessDenied && blockedReason === undefined) {
        blockedReason = 'connection-denied';
      }

      const trace: ToolCallSummary = {
        name: call.name,
        argsHash: hashArgs(call.input),
        durationMs,
        resultRows: estimateRowCount(r.content),
        ...(r.isError ? { error: r.content.slice(0, 200) } : {}),
      };
      callTrace.push(trace);
      opts.onProgress?.(`[analyzer] ${call.name}(${summariseInput(call.input)}) -> ${trace.resultRows} rows in ${durationMs}ms`);

      resultsBlock.push(renderToolResultBlock(call.id, r.content, r.isError === true));

      // Tool-error gate: when a non-access tool call fails, ask the
      // user whether to continue (model gets the error in messages
      // and may self-correct) or abort (mark the task blocked so
      // synthesise surfaces the failure verbatim instead of letting
      // the analyzer fabricate around it). Skip on ACCESS_DENIED --
      // the access gate already prompted; double-prompting the user
      // for the same denial would be noise. Skip when blockedReason
      // is already set so we don't keep asking after the user already
      // committed to a route.
      if (r.isError && !isAccessDenied && blockedReason === undefined) {
        const decision = await fireToolErrorGate(call, r.content, opts, task);
        if (decision === 'abort') {
          blockedReason = 'tool-error-abort';
          log.warn({ itemId: task.itemId, toolName: call.name }, 'user aborted task on tool-error gate');
          break;
        }
      }
    }
    messages.push({ role: 'user', content: resultsBlock.join('\n\n') });
    if (blockedReason === 'tool-error-abort') { break; }
  }

  const truncated = iter >= MAX_TOOL_CALLS || Date.now() - startedAt > wallClockMs;

  // Parse the model's final text. One retry on parse failure -- but
  // skip the retry when the user aborted via the tool-error gate.
  // Aborting means "stop, this run is done"; burning another LLM call
  // to coerce a result the user already declined to wait for is just
  // wasted tokens.
  let parsed: ParseResult = parseDataAnalyzerResult(lastText, task.itemId);
  let parseRetried = false;
  if (!parsed.ok && blockedReason !== 'tool-error-abort') {
    log.warn({ itemId: task.itemId, reason: parsed.reason, detail: parsed.detail }, 'analyzer JSON parse failed; retrying once');
    parseRetried = true;
    messages.push({ role: 'assistant', content: lastText });
    messages.push({
      role: 'user',
      content:
        'Your previous result did not validate as a DataAnalyzerResult ' +
        `(${parsed.reason}: ${parsed.detail}). The submit_analysis tool ` +
        'is not available on this retry -- write the corrected JSON in ' +
        'your reply text instead. Reply with ONLY a single JSON object ' +
        'matching the DataAnalyzerResult shape from the system prompt -- no ' +
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
    parsed = parseDataAnalyzerResult(lastText, task.itemId);
  }

  if (!parsed.ok) {
    log.warn({ itemId: task.itemId, reason: parsed.reason, detail: parsed.detail }, 'analyzer JSON retry also failed; falling back to prose-only result');
    const fallback: DataAnalyzerResult = {
      itemId: task.itemId,
      answer: lastText.length > 0
        ? lastText
        : 'Analyzer returned no parseable response after one retry.',
      findings: [],
      citations: [],
      confidence: 'low',
      toolCalls: callTrace,
      ...(truncated ? { truncated: true } : {}),
      ...(blockedReason !== undefined ? { blockedReason } : {}),
    };
    return {
      result: fallback,
      warning: `analyzer JSON unparseable after retry (${parsed.reason}: ${parsed.detail})`,
      truncated,
      proseOnlyFallback: true,
    };
  }

  // Stamp authoritative trace + truncated flag + any gate denial.
  let result = withRunnerToolCalls(parsed.result, callTrace, truncated, blockedReason);

  // Citations invariant + one retry. Skip when blocked (no findings expected).
  if (result.blockedReason === undefined) {
    const validation = validateCitations(result);
    if (!validation.ok) {
      log.warn({ itemId: task.itemId, findingIndex: validation.findingIndex }, 'analyzer findings missing citations; retrying once');
      messages.push({ role: 'assistant', content: lastText });
      messages.push({
        role: 'user',
        content:
          `Finding [${validation.findingIndex}] has no citations. Every finding ` +
          'MUST include at least one DataCitation entry (with kind + the per-kind required fields). ' +
          'Reply with the corrected strict JSON; preserve everything else as-is.',
      });
      const retryResp = await opts.provider.complete(messages, {
        tools: [],
        maxTokens: COMPLETION_MAX_TOKENS,
        responseFormat: RESPONSE_FORMAT_SCHEMA,
        ...(opts.onToken !== undefined ? { onToken: opts.onToken } : {}),
      });
      const retryParsed = parseDataAnalyzerResult(retryResp.text ?? '', task.itemId);
      if (retryParsed.ok) {
        const retryResult = withRunnerToolCalls(retryParsed.result, callTrace, truncated, blockedReason);
        const retryValidation = validateCitations(retryResult);
        if (retryValidation.ok) {
          return { result: downgradeForToolErrors(retryResult, task.itemId), truncated };
        }
        return {
          result: downgradeForMissingCitations(retryResult),
          warning: 'one or more findings still missing citations after retry; confidence downgraded to low',
          truncated,
        };
      }
      return {
        result: downgradeForMissingCitations(result),
        warning: 'citations-invariant retry returned unparseable JSON; confidence downgraded to low',
        truncated,
      };
    }
  }

  result = downgradeForToolErrors(result, task.itemId);

  return parseRetried
    ? { result, warning: 'analyzer JSON required one strict-JSON retry', truncated }
    : { result, truncated };
}

/**
 * Auto-downgrade confidence when evidence-gathering tool calls had a
 * high error ratio. Rationale: a model that asked four questions of
 * the data tier and got three errors back can't credibly emit
 * confidence: "high" -- it's stitching together claims from one
 * surviving call. We clamp to "low" so the reviewer + synthesise pass
 * treat the result skeptically; the reviewer is also independently
 * trained (via prompt) to flag this combination for retry-with-hint.
 *
 * Excludes from the count:
 *   - submit_analysis (control-flow, not evidence)
 *   - db_list_connections (cheap discovery; failure here is unusual but
 *     by itself doesn't invalidate downstream describe / sample calls)
 *
 * Threshold: errors / non-excluded calls >= 0.5. Single-call edge case
 * (one evidence call, errored) also triggers -- a one-shot failure is
 * the strongest possible signal that the answer is unsupported.
 */
function downgradeForToolErrors(
  result: DataAnalyzerResult,
  itemId: string,
): DataAnalyzerResult {
  const evidence = result.toolCalls.filter(
    c => c.name !== SUBMIT_TOOL && c.name !== DB_LIST_CONNECTIONS,
  );
  if (evidence.length === 0) { return result; }
  const errorCount = evidence.filter(c => c.error !== undefined).length;
  if (errorCount * 2 < evidence.length) { return result; }
  if (result.confidence === 'low') { return result; }
  log.warn(
    { itemId, evidenceCalls: evidence.length, errorCount, prevConfidence: result.confidence },
    'analyzer tool-error ratio >= 0.5; clamping confidence to low',
  );
  return { ...result, confidence: 'low' };
}

// ---------------------------------------------------------------------------
// Tool-error gate
// ---------------------------------------------------------------------------

/**
 * Surface a failed tool call to the user and wait for them to decide
 * whether to keep going or stop the task. Mirrors the access-gate
 * pattern in agent/tools/executor.ts but without the
 * approve/approve-prefix/deny-tax: tool errors aren't a permission
 * decision, they're a "the model is now operating on bad evidence,
 * how do you want me to handle it?" decision.
 *
 * Actions:
 *   - continue: feed the error result back to the analyzer; it can
 *               self-correct (e.g. db_file_describe error -> retry
 *               with db_file_sample_shape) or accept low confidence.
 *   - abort:    set blockedReason='tool-error-abort' on the result;
 *               the orchestrator routes to the blocked bucket and the
 *               synthesise pass surfaces the failure verbatim instead
 *               of treating the partial finding as accepted.
 *
 * Fails open (returns 'continue') when send/channel/requestId are
 * missing -- the runner is also driven from tests and scripts that
 * have no IPC plumbing; auto-aborting on every error there would make
 * those harnesses unusable.
 */
async function fireToolErrorGate(
  call: ToolCall,
  errorContent: string,
  opts: RunDataAnalyzerOpts,
  task: DataAnalysisTask,
): Promise<'continue' | 'abort'> {
  const send = opts.send;
  const channel = opts.channel;
  const requestId = opts.requestId;
  if (send === undefined || channel === undefined || requestId === undefined) {
    log.warn({ tool: call.name, itemId: task.itemId }, 'tool-error gate: no plumbing; auto-continuing');
    return 'continue';
  }

  const gateId = `tool-error-${call.name}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const inputSummary = summariseInput(call.input);
  const truncatedErr = errorContent.length > 800
    ? errorContent.slice(0, 800) + '...'
    : errorContent;

  const contentLines = [
    `**Task:** ${task.question}`,
    '',
    `**Tool call:** \`${call.name}(${inputSummary})\``,
    '',
    '**Error:**',
    '```',
    truncatedErr,
    '```',
    '',
    'Continuing lets the analyzer feed the error back into the model so it can ' +
    'self-correct (try a sibling tool) or finish with low confidence. Aborting ' +
    'marks the task blocked so the report calls out the failure verbatim ' +
    'instead of papering over it with a fabricated answer.',
  ];

  send({
    id: requestId,
    stream: 'gate',
    data: {
      gateId,
      title: `Data Analyzer tool error: ${call.name}`,
      content: contentLines.join('\n'),
      format: 'markdown',
      actions: [
        { name: 'continue', label: 'Continue' },
        { name: 'abort',    label: 'Abort task' },
      ],
    },
  });

  try {
    return await new Promise<'continue' | 'abort'>((resolve, reject) => {
      channel.registerExternalGate(
        gateId,
        (reply) => resolve(reply.action === 'abort' ? 'abort' : 'continue'),
        reject,
      );
    });
  } catch {
    // Channel closed / gate cancelled before the user replied -- don't
    // wedge the run; treat as continue and let downstream confidence
    // downgrades + reviewer rules catch the bad evidence.
    return 'continue';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInitialMessages(
  task: DataAnalysisTask,
  tier: ScopeSize,
): LLMMessage[] {
  const userBody = [
    '# Task',
    JSON.stringify(
      {
        kind: task.kind,
        question: task.question,
        scope: task.scope,
        tier,
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
    'your DataAnalyzerResult as structured arguments. Do NOT write the',
    'result as JSON in your reply text -- use the tool.',
  ].join('\n');

  return [
    { role: 'system', content: buildAnalyzerSystemPrompt(tier) },
    { role: 'user', content: userBody },
  ];
}

function withRunnerToolCalls(
  result: DataAnalyzerResult,
  toolCalls: readonly ToolCallSummary[],
  truncated: boolean,
  blockedReason: BlockedReason | undefined,
): DataAnalyzerResult {
  return {
    ...result,
    toolCalls,
    ...(truncated ? { truncated: true } : {}),
    ...(blockedReason !== undefined ? { blockedReason } : {}),
  };
}

function renderToolResultBlock(toolCallId: string, content: string, isError: boolean): string {
  const prefix = isError ? '[error] ' : '';
  return `<tool_result tool_call_id="${toolCallId}">\n${prefix}${content}\n</tool_result>`;
}

function summariseInput(input: Record<string, unknown>): string {
  // Prefer connectionId+target where present (db:sql:* pattern); else first value.
  const c = input['connectionId'];
  const t = input['target'] ?? input['key'] ?? input['keyPattern'] ?? input['path'];
  if (typeof c === 'string' && c.length > 0) {
    if (typeof t === 'string' && t.length > 0) {
      return `${c}, ${t}`;
    }
    return c;
  }
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

