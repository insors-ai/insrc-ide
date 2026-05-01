/**
 * Strict-JSON parser + schema validator for DataAnalyzerResult.
 *
 * Mirrors agent/tasks/code-analyzer/analyzer/result-parser.ts with
 * data-specific concern / citation-kind / blockedReason enums.
 * Reuses the shared `stripFences` helper (extracts the {...} span,
 * tolerant of prose preamble).
 *
 * Failure modes (matched to the design's section 15 failure table):
 *  - `unparseable`         JSON.parse threw. One strict-JSON retry,
 *                          then accept-as-prose-only with a warning.
 *  - `schema_violation`    JSON parsed but didn't match the shape.
 *                          Retried like `unparseable`.
 *  - `citations_missing`   Schema OK but a finding had no citations.
 *                          Caller hands off to citations.ts which
 *                          retries once then downgrades to 'low'.
 */

import type {
  BlockedReason,
  Confidence,
  DataAnalyzerResult,
  DataAnalysisConcern,
  DataCitation,
  DataFinding,
  FindingSeverity,
  ToolCallSummary,
} from '../types.js';
import { DATA_ANALYSIS_CONCERNS } from '../types.js';
import { stripFences } from '../../_shared/json-extract.js';

const VALID_CONCERNS: ReadonlySet<DataAnalysisConcern> =
  new Set<DataAnalysisConcern>(DATA_ANALYSIS_CONCERNS);

const VALID_SEVERITIES: ReadonlySet<FindingSeverity> = new Set<FindingSeverity>([
  'info', 'warn', 'error',
]);

const VALID_CONFIDENCES: ReadonlySet<Confidence> = new Set<Confidence>([
  'high', 'medium', 'low',
]);

const VALID_BLOCKED_REASONS: ReadonlySet<BlockedReason> = new Set<BlockedReason>([
  'connection-denied', 'pii-gate-denied', 'no-connections', 'tool-error-abort',
]);

const SAMPLE_VALUE_MAX_CHARS = 1024;
const SNIPPET_MAX_CHARS = 200;

export type ParseResult =
  | { readonly ok: true; readonly result: DataAnalyzerResult }
  | {
      readonly ok: false;
      readonly reason: 'unparseable' | 'schema_violation';
      readonly detail: string;
    };

/**
 * Parse the analyzer's raw response into a DataAnalyzerResult. Stamps
 * the orchestrator-supplied itemId.
 */
export function parseDataAnalyzerResult(rawText: string, itemId: string): ParseResult {
  const cleaned = stripFences(rawText.trim());

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      reason: 'unparseable',
      detail: `JSON.parse failed: ${(err as Error).message}`,
    };
  }

  if (!isObject(parsed)) {
    return { ok: false, reason: 'schema_violation', detail: 'top-level value is not an object' };
  }
  const obj = parsed;

  // -- answer (required) --
  const answer = isString(obj['answer']) ? obj['answer'] : '';
  if (answer.length === 0) {
    return { ok: false, reason: 'schema_violation', detail: 'missing or empty `answer`' };
  }

  // -- confidence (required) --
  const rawConfidence = isString(obj['confidence']) ? obj['confidence'] : '';
  if (!VALID_CONFIDENCES.has(rawConfidence as Confidence)) {
    return {
      ok: false,
      reason: 'schema_violation',
      detail: `invalid confidence "${rawConfidence}"; expected high|medium|low`,
    };
  }
  const confidence = rawConfidence as Confidence;

  // -- citations (top-level dedupe pool) --
  const citationsRaw = Array.isArray(obj['citations']) ? obj['citations'] : [];
  const citations: DataCitation[] = [];
  for (let i = 0; i < citationsRaw.length; i++) {
    const c = parseCitation(citationsRaw[i]);
    if (typeof c === 'string') {
      return { ok: false, reason: 'schema_violation', detail: `citations[${i}]: ${c}` };
    }
    citations.push(c);
  }

  // -- findings --
  const findingsRaw = Array.isArray(obj['findings']) ? obj['findings'] : [];
  const findings: DataFinding[] = [];
  for (let i = 0; i < findingsRaw.length; i++) {
    const parsedFinding = parseFinding(findingsRaw[i], i);
    if (typeof parsedFinding === 'string') {
      return { ok: false, reason: 'schema_violation', detail: parsedFinding };
    }
    findings.push(parsedFinding);
  }

  // -- toolCalls (debug trace; missing -> empty) --
  const toolCallsRaw = Array.isArray(obj['toolCalls']) ? obj['toolCalls'] : [];
  const toolCalls: ToolCallSummary[] = [];
  for (let i = 0; i < toolCallsRaw.length; i++) {
    const t = parseToolCall(toolCallsRaw[i]);
    if (t !== undefined) toolCalls.push(t);
  }

  const truncated = obj['truncated'] === true ? true : undefined;

  // blockedReason is set BY THE ORCHESTRATOR after a gate denial,
  // not by the model. Tolerant parse here for round-trip fidelity
  // (state-store readback) but the runner-side parse path strips it.
  const rawBlockedReason = isString(obj['blockedReason']) ? obj['blockedReason'] : '';
  const blockedReason = VALID_BLOCKED_REASONS.has(rawBlockedReason as BlockedReason)
    ? (rawBlockedReason as BlockedReason)
    : undefined;

  const result: DataAnalyzerResult = {
    itemId,
    answer,
    findings,
    citations,
    confidence,
    toolCalls,
    ...(truncated !== undefined ? { truncated } : {}),
    ...(blockedReason !== undefined ? { blockedReason } : {}),
  };
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// Per-element parsers
// ---------------------------------------------------------------------------

function parseFinding(raw: unknown, idx: number): DataFinding | string {
  if (!isObject(raw)) return `findings[${idx}] is not an object`;

  const concernRaw = isString(raw['concern']) ? raw['concern'] : '';
  if (!VALID_CONCERNS.has(concernRaw as DataAnalysisConcern)) {
    return `findings[${idx}].concern "${concernRaw}" is not a recognised DataAnalysisConcern`;
  }
  const severityRaw = isString(raw['severity']) ? raw['severity'] : '';
  if (!VALID_SEVERITIES.has(severityRaw as FindingSeverity)) {
    return `findings[${idx}].severity "${severityRaw}" is not info|warn|error`;
  }
  const issue = isString(raw['issue']) ? raw['issue'] : '';
  if (issue.length === 0) {
    return `findings[${idx}].issue is missing or empty`;
  }

  const findingCitationsRaw = Array.isArray(raw['citations']) ? raw['citations'] : [];
  const findingCitations: DataCitation[] = [];
  for (let i = 0; i < findingCitationsRaw.length; i++) {
    const c = parseCitation(findingCitationsRaw[i]);
    if (typeof c === 'string') {
      return `findings[${idx}].citations[${i}]: ${c}`;
    }
    findingCitations.push(c);
  }

  const finding: DataFinding = {
    concern: concernRaw as DataAnalysisConcern,
    severity: severityRaw as FindingSeverity,
    issue,
    citations: findingCitations,
  };
  return finding;
}

/**
 * Parse one DataCitation. Branches on `kind`. Returns either the parsed
 * citation OR an error-message string the caller embeds in the schema
 * violation reason.
 */
function parseCitation(raw: unknown): DataCitation | string {
  if (!isObject(raw)) return 'citation is not an object';

  const kind = isString(raw['kind']) ? raw['kind'] : '';
  switch (kind) {
    case 'rdbms': return parseRdbmsCitation(raw);
    case 'kv': return parseKvCitation(raw);
    case 'file-source': return parseFileCitation(raw);
    case 'code-ref': return parseCodeRefCitation(raw);
    default: return `unknown citation kind "${kind}" (expected rdbms|kv|file-source|code-ref)`;
  }
}

function parseRdbmsCitation(raw: Record<string, unknown>): DataCitation | string {
  const connectionId = isString(raw['connectionId']) ? raw['connectionId'] : '';
  if (connectionId.length === 0) return 'rdbms citation: missing required `connectionId`';
  const table = isString(raw['table']) ? raw['table'] : '';
  if (table.length === 0) return 'rdbms citation: missing required `table`';
  const sampleValue = clampSampleValue(raw['sampleValue']);
  return {
    kind: 'rdbms',
    connectionId,
    table,
    ...(isString(raw['schema']) ? { schema: raw['schema'] as string } : {}),
    ...(isString(raw['column']) ? { column: raw['column'] as string } : {}),
    ...(sampleValue !== undefined ? { sampleValue } : {}),
    ...(isString(raw['introspectionVersion']) ? { introspectionVersion: raw['introspectionVersion'] as string } : {}),
  };
}

function parseKvCitation(raw: Record<string, unknown>): DataCitation | string {
  const connectionId = isString(raw['connectionId']) ? raw['connectionId'] : '';
  if (connectionId.length === 0) return 'kv citation: missing required `connectionId`';
  const keyPattern = isString(raw['keyPattern']) ? raw['keyPattern'] : '';
  if (keyPattern.length === 0) return 'kv citation: missing required `keyPattern`';
  const sampleValue = clampSampleValue(raw['sampleValue']);
  return {
    kind: 'kv',
    connectionId,
    keyPattern,
    ...(isString(raw['fieldPath']) ? { fieldPath: raw['fieldPath'] as string } : {}),
    ...(sampleValue !== undefined ? { sampleValue } : {}),
  };
}

function parseFileCitation(raw: Record<string, unknown>): DataCitation | string {
  const connectionId = isString(raw['connectionId']) ? raw['connectionId'] : '';
  if (connectionId.length === 0) return 'file-source citation: missing required `connectionId`';
  const path = isString(raw['path']) ? raw['path'] : '';
  if (path.length === 0) return 'file-source citation: missing required `path`';
  const sampleValue = clampSampleValue(raw['sampleValue']);
  return {
    kind: 'file-source',
    connectionId,
    path,
    ...(isString(raw['column']) ? { column: raw['column'] as string } : {}),
    ...(sampleValue !== undefined ? { sampleValue } : {}),
  };
}

function parseCodeRefCitation(raw: Record<string, unknown>): DataCitation | string {
  const path = isString(raw['path']) ? raw['path'] : '';
  if (path.length === 0) return 'code-ref citation: missing required `path`';
  const snippetRaw = isString(raw['snippet']) ? raw['snippet'] : undefined;
  const snippet = snippetRaw !== undefined && snippetRaw.length > SNIPPET_MAX_CHARS
    ? snippetRaw.slice(0, SNIPPET_MAX_CHARS)
    : snippetRaw;
  return {
    kind: 'code-ref',
    path,
    ...(isNumber(raw['lineStart']) ? { lineStart: raw['lineStart'] as number } : {}),
    ...(isNumber(raw['lineEnd']) ? { lineEnd: raw['lineEnd'] as number } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(isString(raw['entityId']) ? { entityId: raw['entityId'] as string } : {}),
  };
}

function parseToolCall(raw: unknown): ToolCallSummary | undefined {
  if (!isObject(raw)) return undefined;
  const name = isString(raw['name']) ? raw['name'] : '';
  if (name.length === 0) return undefined;
  const argsHash = isString(raw['argsHash']) ? raw['argsHash'] : '';
  const durationMs = isNumber(raw['durationMs']) ? raw['durationMs'] as number : 0;
  const resultRows = isNumber(raw['resultRows']) ? raw['resultRows'] as number : 0;
  return {
    name,
    argsHash,
    durationMs,
    resultRows,
    ...(isString(raw['error']) ? { error: raw['error'] as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampSampleValue(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > SAMPLE_VALUE_MAX_CHARS ? v.slice(0, SAMPLE_VALUE_MAX_CHARS) : v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
