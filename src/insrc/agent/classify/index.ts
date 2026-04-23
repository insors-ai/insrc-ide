/**
 * Generic LLM classifier.
 *
 * Input: a list of classes + text. Output: the best-fit class id +
 * confidence + reasoning. The provider is supplied by the caller;
 * callers typically pass `session.resolver.resolve('classifier', step)`
 * so per-step config overrides apply and the default cascade (per-step
 * -> active cloud -> local) is honoured by the resolver.
 *
 * Single round-trip, JSON-only response. No keyword fallback. On parse
 * / provider error the result is `{ id: classes[0].id, confidence: 0,
 * reasoning: '<error>', fallback: true }` -- caller decides whether to
 * retry or surface the error.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import type { ClassifyInput, ClassifyResult, ScopeSize } from '../../shared/classify.js';
import { getLogger } from '../../shared/logger.js';

const VALID_SCOPES: readonly ScopeSize[] = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'];
const VALID_SCOPES_SET = new Set<string>(VALID_SCOPES);

const log = getLogger('classify');

export type { ClassChoice, ClassifyInput, ClassifyResult } from '../../shared/classify.js';

/**
 * Run a single classification. The caller owns provider resolution.
 * Throws only if `classes` is empty -- anything else (LLM error,
 * parse failure, unknown id) returns `fallback: true`.
 */
export async function classify(
  input: ClassifyInput,
  provider: LLMProvider,
): Promise<ClassifyResult> {
  if (input.classes.length === 0) {
    throw new Error('classify: `classes` must be non-empty');
  }

  const messages = buildMessages(input);
  let rawText: string;
  try {
    const response = await provider.complete(messages, {
      maxTokens: 200,
      temperature: 0,
    });
    rawText = response.text;
  } catch (err) {
    log.warn({ err, role: input.role }, 'classify: provider call failed');
    return fallbackResult(input, `provider error: ${(err as Error).message}`);
  }

  const parsed = parseResponse(rawText, input);
  if (!parsed) {
    log.warn({ role: input.role, rawText: rawText.slice(0, 200) }, 'classify: unparseable response');
    return fallbackResult(input, 'unparseable LLM response');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildMessages(input: ClassifyInput): LLMMessage[] {
  const role = input.role ?? 'classifier';
  const classList = input.classes
    .map(c => `- ${c.id}: ${c.description ?? c.label ?? c.id}`)
    .join('\n');

  const systemLines = [
    `You are a ${role}. Given the text below, pick EXACTLY ONE class that best describes it AND estimate the scope of the work being asked for.`,
    '',
    '## Classes',
    classList,
    '',
    '## Scope (size of the work)',
    '- `S`     -- one small, localized change (minutes of work)',
    '- `M`     -- a few related changes in one module (single session)',
    '- `L`     -- a feature or module-sized piece of work (multi-session)',
    '- `XL`    -- subsystem-scale change spanning several modules',
    '- `XXL`   -- multi-subsystem change (e.g. auth + storage + UI)',
    '- `XXXL`  -- cross-cutting architectural change',
    '- `XXXXL` -- major rewrite or new product direction',
    '',
    'Rules:',
    '- Pick the single best-fit class.',
    '- `id` MUST be one of the listed class ids verbatim.',
    '- `scope` MUST be one of S / M / L / XL / XXL / XXXL / XXXXL -- pick the smallest tier the work could plausibly fit into.',
    '- Confidence: 0.9+ for clear matches, 0.7-0.9 reasonable, below 0.7 a guess.',
    '- Return ONLY valid JSON (no markdown fences, no prose).',
    '',
    'Schema:',
    '{ "id": "<class id>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>", "scope": "<S|M|L|XL|XXL|XXXL|XXXXL>" }',
  ];

  const userLines: string[] = [];
  if (input.context && input.context.trim().length > 0) {
    userLines.push('## Context', input.context.trim(), '');
  }
  userLines.push('## Text', input.text);

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userLines.join('\n') },
  ];
}

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

function parseResponse(rawText: string, input: ClassifyInput): ClassifyResult | null {
  const cleaned = stripFences(rawText.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  const id = typeof obj['id'] === 'string' ? obj['id'] as string : '';
  const validIds = new Set(input.classes.map(c => c.id));
  if (!validIds.has(id)) {
    return null;
  }

  const confRaw = typeof obj['confidence'] === 'number' ? obj['confidence'] as number : 0.5;
  const confidence = Math.max(0, Math.min(1, confRaw));
  const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] as string : '';

  // Scope is mandatory per the schema but we tolerate omission / unknown
  // values by falling back to 'M' (a reasonable "normal" default).
  const scopeRaw = typeof obj['scope'] === 'string' ? (obj['scope'] as string).trim().toUpperCase() : '';
  const scope: ScopeSize = VALID_SCOPES_SET.has(scopeRaw) ? (scopeRaw as ScopeSize) : 'M';

  return { id, confidence, reasoning, scope, fallback: false };
}

function stripFences(text: string): string {
  let out = text;
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  return out.trim();
}

function fallbackResult(input: ClassifyInput, reason: string): ClassifyResult {
  return {
    id: input.classes[0]!.id,
    confidence: 0,
    reasoning: reason,
    scope: 'M',
    fallback: true,
  };
}
