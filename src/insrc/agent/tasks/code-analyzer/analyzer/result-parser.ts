/**
 * Strict-JSON parser + schema validator for AnalyzerResult.
 *
 * The local analyzer returns JSON shaped per the schema in the
 * analyzer system prompt (`prompts/analyzer-system.ts`). This module
 * accepts the raw text, strips any stray markdown fences the model
 * may have added, parses, validates the structure against
 * AnalyzerResult, and threads in the orchestrator-supplied itemId.
 *
 * Failure modes (matched to the design's section 15 failure table):
 *  - `unparseable`         JSON.parse threw. One strict-JSON retry,
 *                          then accept-as-prose-only with a warning.
 *  - `schema_violation`    JSON parsed but didn't match the shape.
 *                          Retried like `unparseable`.
 *  - `citations_missing`   Schema OK but a finding had no citations.
 *                          Caller hands off to the citations module
 *                          which retries once then downgrades.
 *
 * `validateCitations` lives in `citations.ts` because the citations
 * invariant is a load-bearing analyzer rule with its own retry policy
 * -- not a generic schema check.
 */

import type {
  AnalyzerResult,
  AnalysisKind,
  CodeAnalysisConcern,
  CodeCitation,
  Confidence,
  Finding,
  FindingSeverity,
  ToolCallSummary,
} from '../types.js';

const VALID_CONCERNS: ReadonlySet<CodeAnalysisConcern> = new Set<CodeAnalysisConcern>([
  'duplicates', 'consistency', 'interface-mismatch', 'impact', 'smells',
]);

const VALID_SEVERITIES: ReadonlySet<FindingSeverity> = new Set<FindingSeverity>([
  'info', 'warn', 'error',
]);

const VALID_CONFIDENCES: ReadonlySet<Confidence> = new Set<Confidence>([
  'high', 'medium', 'low',
]);

const VALID_KINDS: ReadonlySet<AnalysisKind> = new Set<AnalysisKind>([
  'locate', 'describe', 'trace', 'compare', 'free-form',
]);
void VALID_KINDS;

const SNIPPET_MAX_CHARS = 200;

export type ParseResult =
  | { readonly ok: true; readonly result: AnalyzerResult }
  | {
      readonly ok: false;
      readonly reason: 'unparseable' | 'schema_violation';
      readonly detail: string;
    };

/**
 * Parse the analyzer's raw response into an AnalyzerResult. Stamps
 * the orchestrator-supplied itemId.
 */
export function parseAnalyzerResult(rawText: string, itemId: string): ParseResult {
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

  // -- answer --
  const answer = isString(obj['answer']) ? obj['answer'] : '';
  if (answer.length === 0) {
    return { ok: false, reason: 'schema_violation', detail: 'missing or empty `answer`' };
  }

  // -- confidence --
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
  const citations: CodeCitation[] = [];
  for (let i = 0; i < citationsRaw.length; i++) {
    const c = parseCitation(citationsRaw[i]);
    if (c === undefined) {
      return {
        ok: false,
        reason: 'schema_violation',
        detail: `citations[${i}]: missing required \`path\``,
      };
    }
    citations.push(c);
  }

  // -- findings --
  const findingsRaw = Array.isArray(obj['findings']) ? obj['findings'] : [];
  const findings: Finding[] = [];
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

  const result: AnalyzerResult = {
    itemId,
    answer,
    findings,
    citations,
    confidence,
    toolCalls,
    ...(truncated !== undefined ? { truncated } : {}),
  };
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// Per-element parsers
// ---------------------------------------------------------------------------

function parseFinding(raw: unknown, idx: number): Finding | string {
  if (!isObject(raw)) return `findings[${idx}] is not an object`;

  const concernRaw = isString(raw['concern']) ? raw['concern'] : '';
  if (!VALID_CONCERNS.has(concernRaw as CodeAnalysisConcern)) {
    return `findings[${idx}].concern "${concernRaw}" is not a recognised CodeAnalysisConcern`;
  }
  const severityRaw = isString(raw['severity']) ? raw['severity'] : '';
  if (!VALID_SEVERITIES.has(severityRaw as FindingSeverity)) {
    return `findings[${idx}].severity "${severityRaw}" is not info|warn|error`;
  }
  const issue = isString(raw['issue']) ? raw['issue'] : '';
  if (issue.length === 0) {
    return `findings[${idx}].issue is missing or empty`;
  }
  const file = isString(raw['file']) ? raw['file'] : '';

  const findingCitationsRaw = Array.isArray(raw['citations']) ? raw['citations'] : [];
  const findingCitations: CodeCitation[] = [];
  for (let i = 0; i < findingCitationsRaw.length; i++) {
    const c = parseCitation(findingCitationsRaw[i]);
    if (c === undefined) {
      return `findings[${idx}].citations[${i}]: missing required \`path\``;
    }
    findingCitations.push(c);
  }

  const finding: Finding = {
    file,
    concern: concernRaw as CodeAnalysisConcern,
    severity: severityRaw as FindingSeverity,
    issue,
    citations: findingCitations,
    ...(isNumber(raw['line']) ? { line: raw['line'] as number } : {}),
    ...(isString(raw['suggestion']) ? { suggestion: raw['suggestion'] as string } : {}),
  };
  return finding;
}

function parseCitation(raw: unknown): CodeCitation | undefined {
  if (!isObject(raw)) return undefined;
  const path = isString(raw['path']) ? raw['path'] : '';
  if (path.length === 0) return undefined;
  const snippetRaw = isString(raw['snippet']) ? raw['snippet'] : undefined;
  const snippet = snippetRaw !== undefined && snippetRaw.length > SNIPPET_MAX_CHARS
    ? snippetRaw.slice(0, SNIPPET_MAX_CHARS)
    : snippetRaw;
  return {
    path,
    ...(isString(raw['entityId']) ? { entityId: raw['entityId'] as string } : {}),
    ...(isNumber(raw['lineStart']) ? { lineStart: raw['lineStart'] as number } : {}),
    ...(isNumber(raw['lineEnd']) ? { lineEnd: raw['lineEnd'] as number } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
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

function stripFences(text: string): string {
  let out = text;
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  return out.trim();
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
