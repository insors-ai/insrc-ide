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
import type {
  ClassifyInput,
  ClassifyResult,
  ClassifyRelationship,
  ScopeSize,
} from '../../shared/classify.js';
import { getLogger } from '../../shared/logger.js';
import { stripJsonFences } from '../../shared/json-fences.js';

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
      maxTokens: 1024,
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

  const wantsRelationship = (input.relationshipEnum?.length ?? 0) > 0;

  const systemLines: string[] = [
    `You are a ${role}. Given the text below, pick EXACTLY ONE class that best describes it AND estimate the scope of the work being asked for.`,
    '',
    '## Classes',
    classList,
    '',
    '## Scope (size of the work)',
    'These tiers apply to ANY intent -- analysis depth, query breadth, refactor span, etc. Pick the smallest tier the work could plausibly fit into.',
    '- `S`     -- one focused unit (a function, a column, a paragraph; minutes)',
    '- `M`     -- one module / one report section / one focused query (single session)',
    '- `L`     -- a full module or 5-10 sections / a feature build (multi-session)',
    '- `XL`    -- a subsystem (HDFS / auth / storage layer; many modules)',
    '- `XXL`   -- multiple subsystems (auth + storage + UI; or repo-wide analysis)',
    '- `XXXL`  -- cross-cutting concern that touches every subsystem',
    '- `XXXXL` -- whole-product / multi-product / major rewrite',
  ];

  if (wantsRelationship) {
    systemLines.push(
      '',
      '## Relationship to prior conversation',
      'In addition to picking the intent class, classify how the input prompt relates to the recent context the user has shared (the `## Recent context` block, if any). Use one of:',
      ...input.relationshipEnum!.map(k => `- ${k}`),
      '',
      'Citation rules:',
      '- The `relationship.citations` array MUST list the keys you actually leaned on to decide.',
      '- Citations are BARE keys: emit `"t1"`, NOT `"[t1]"`. The brackets in the recent-context block are visual markers only.',
      '- Empty array when the relationship is the "fresh / new topic" kind, or when no recent-context items applied.',
      '- Cite only keys that appear in the `## Recent context` block; do NOT invent new keys.',
    );
  }

  systemLines.push(
    '',
    'Rules:',
    '- Pick the single best-fit class.',
    '- `id` MUST be one of the listed class ids verbatim.',
    '- `scope` MUST be one of S / M / L / XL / XXL / XXXL / XXXXL -- pick the smallest tier the work could plausibly fit into.',
    '- Confidence: 0.9+ for clear matches, 0.7-0.9 reasonable, below 0.7 a guess.',
    '- Return ONLY valid JSON (no markdown fences, no prose).',
    '',
    'Schema:',
  );

  if (wantsRelationship) {
    systemLines.push(
      '{',
      '  "id":         "<class id>",',
      '  "confidence": <0.0-1.0>,',
      '  "reasoning":  "<one sentence>",',
      '  "scope":      "<S|M|L|XL|XXL|XXXL|XXXXL>",',
      '  "relationship": {',
      `    "kind":       "<${input.relationshipEnum!.join('|')}>",`,
      '    "confidence": <0.0-1.0>,',
      '    "reasoning":  "<one sentence>",',
      '    "citations":  ["<key>", ...]',
      '  }',
      '}',
    );
  } else {
    systemLines.push(
      '{ "id": "<class id>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>", "scope": "<S|M|L|XL|XXL|XXXL|XXXXL>" }',
    );
  }

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
  const cleaned = stripJsonFences(rawText);
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

  const wantsRelationship = (input.relationshipEnum?.length ?? 0) > 0;
  if (wantsRelationship) {
    const relationship = parseRelationship(obj['relationship'], input.relationshipEnum!);
    return { id, confidence, reasoning, scope, fallback: false, relationship };
  }

  return { id, confidence, reasoning, scope, fallback: false };
}

/**
 * Coerce the LLM-emitted `relationship` block into a typed
 * ClassifyRelationship. Defensive on every field: any malformed /
 * missing piece falls back to the safe defaults so callers never
 * have to handle "missing relationship when relationshipEnum was
 * supplied". The `kind` always lands on a valid enum value (default:
 * the first enum entry, expected to be the "neutral / new topic"
 * kind).
 */
function parseRelationship(
  raw: unknown,
  enumKinds: readonly string[],
): ClassifyRelationship {
  const fallbackKind = enumKinds[0] ?? '';
  const fallback: ClassifyRelationship = {
    kind:       fallbackKind,
    confidence: 0.5,
    reasoning:  'no relationship data emitted',
    citations:  [],
  };
  if (!raw || typeof raw !== 'object') return fallback;

  const r = raw as Record<string, unknown>;
  const kindRaw = typeof r['kind'] === 'string' ? r['kind'] as string : '';
  const validKinds = new Set(enumKinds);
  const kind = validKinds.has(kindRaw) ? kindRaw : fallbackKind;

  const confRaw = typeof r['confidence'] === 'number' ? r['confidence'] as number : 0.5;
  const confidence = Math.max(0, Math.min(1, confRaw));

  const reasoning = typeof r['reasoning'] === 'string' ? r['reasoning'] as string : '';

  const citationsRaw = Array.isArray(r['citations']) ? r['citations'] as unknown[] : [];
  const citations = citationsRaw
    .filter((c): c is string => typeof c === 'string' && c.length > 0);

  return { kind, confidence, reasoning, citations };
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
