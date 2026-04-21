/**
 * Prompt decomposition — splits a user message into structured actions.
 *
 * Replaces the single-intent classifier with a multi-action decomposer.
 * Returns an ordered array of actions with file references, purposes,
 * dependencies, and output directives.
 *
 * Examples:
 * - "design a caching layer" → [{ intent: 'design', subject: '...' }]
 * - "design X based on Y and use Z for styling" → [
 *     { intent: 'design', subject: 'X', refs: [{ path: 'Y', purpose: 'requirements-source' }] },
 *     { intent: 'style', refs: [{ path: 'Z', purpose: 'style-reference' }], dependsOn: 0 },
 *   ]
 * - "check pods and show indexer status" → [
 *     { intent: 'infra', action: 'check pods' },
 *     { intent: 'infra', action: 'show indexer status' },
 *   ]
 */

import type { Intent, LLMProvider } from '../shared/types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('decompose');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefPurpose =
  | 'requirements-source'  // extract requirements from this document
  | 'style-reference'      // use for output styling/template
  | 'target-file'          // file to modify/refactor/debug
  | 'test-target'          // file to test
  | 'context'              // general context/background
  | 'config'               // configuration reference
  | 'data';                // data file reference

export interface FileRef {
  path: string;
  purpose: RefPurpose;
}

export interface DecomposedAction {
  /** Primary intent for this action */
  intent: Intent;
  /** Human-readable action description */
  action: string;
  /** Subject/target of the action */
  subject?: string | undefined;
  /** File references with purpose tags */
  refs?: FileRef[] | undefined;
  /** Desired output format */
  outputFormat?: string | undefined;
  /** Index of action this depends on (for sequential execution) */
  dependsOn?: number | undefined;
  /** Suggested command for infra/deploy intents (hint — resolved at execution time) */
  commandHint?: string | undefined;
  /** Confidence score */
  confidence: number;
}

export type AttachedRelation = 'augment' | 'append' | 'format' | 'depends' | 'parallel';

export interface AttachedAction extends DecomposedAction {
  relation: AttachedRelation;
  reason: string;
}

export interface DecomposedPrompt {
  primary: DecomposedAction;
  attached: AttachedAction[];
}

export interface DecomposeResult {
  /** Ordered array of actions to execute (legacy format) */
  actions: DecomposedAction[];
  /** Primary/attached structured decomposition (new format) */
  prompt?: DecomposedPrompt | undefined;
  /** Original message with prefixes stripped */
  message: string;
  /** Whether the LLM decomposer was used (false = single-intent fallback) */
  usedLLM: boolean;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const ALL_INTENTS = [
  'implement', 'refactor', 'test', 'debug', 'review',
  'document', 'research', 'code-analysis', 'plan', 'requirements', 'design',
  'brainstorm', 'deploy', 'release', 'infra',
];

const DECOMPOSE_SYSTEM = `You are a prompt decomposer for a coding assistant.
Given a user message, identify the PRIMARY intent and any ATTACHED sub-requests.

Available intents: ${ALL_INTENTS.join(', ')}

Attached relation types:
- augment: enhances primary with additional context/angle (merged into one agent run)
- append: independent result added after primary output
- format: transforms primary output (e.g. "as markdown table", "summarize")
- depends: sequential -- needs primary's output first (e.g. "design X then implement it")
- parallel: independent work that can run alongside primary

File reference purposes:
- requirements-source: document to extract requirements from
- style-reference: file to use for output styling/template
- target-file: file to modify, refactor, debug, or review
- test-target: file to write tests for
- context: general background/reference material
- config: configuration file reference
- data: data file reference

Rules:
- Every prompt has exactly ONE primary intent
- Additional sub-requests are "attached" with a relation type
- "augment" (DEFAULT for same-intent sub-requests): information that enhances the primary goal.
  "find X and also check Y for comparison" -- Y augments X, single agent run with richer context.
  "implement X based on Y" -- Y augments X as reference material.
- "format": output formatting requests ("as markdown", "as table", "give me a comparison", "summarize")
- "depends": step 2 needs step 1's output. DIFFERENT intents only ("design X then implement it")
- "append": truly independent questions in the same message. Rare -- prefer augment.
- "parallel": independent work, different intents ("check security AND check performance")
- When in doubt between "augment" and "append", ALWAYS choose "augment"
- Informational questions ("what is X", "how does X work") are "research" intent
- For infra/deploy intents, provide commandHint (best-guess shell command, no output flags)
- Confidence: 0.9+ clear, 0.7-0.9 inferred, below 0.7 guesses
- Greetings/conversational: primary "research" with action "chat", confidence 0.3

Examples:
- "find NodeJS libs for OCR and also check the Python module for reference"
  primary: research "find NodeJS OCR libs"
  attached: [{ relation: "augment", action: "check Python module as reference" }]

- "check pods and output as markdown"
  primary: infra "check pods"
  attached: [{ relation: "format", action: "format as markdown" }]

- "design the API then implement it"
  primary: design "design the API"
  attached: [{ relation: "depends", intent: "implement", action: "implement the API" }]

- "analyze security issues and also review performance"
  primary: research "analyze security issues"
  attached: [{ relation: "parallel", intent: "research", action: "review performance" }]

Output ONLY valid JSON -- no markdown fences, no explanation:
{
  "primary": {
    "intent": "<intent>",
    "action": "<description>",
    "subject": "<what>",
    "refs": [{ "path": "<file-path>", "purpose": "<purpose>" }],
    "outputFormat": "<html|md|json|null>",
    "commandHint": "<shell-command|null>",
    "confidence": <0.0-1.0>
  },
  "attached": [
    {
      "intent": "<intent>",
      "action": "<description>",
      "subject": "<what>",
      "relation": "<augment|append|format|depends|parallel>",
      "reason": "<why this is attached>",
      "refs": [{ "path": "<file-path>", "purpose": "<purpose>" }],
      "confidence": <0.0-1.0>
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Decomposer
// ---------------------------------------------------------------------------

export async function decompose(
  message: string,
  provider: LLMProvider,
  conversationHistory?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<DecomposeResult> {
  try {
    // Build messages: decomposer system prompt + conversation history + user message
    // If history is provided (from context manager), include it so the LLM can resolve
    // references to prior turns (e.g., "format that as markdown", "use gke..." from previous output)
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: DECOMPOSE_SYSTEM },
    ];
    if (conversationHistory && conversationHistory.length > 0) {
      // Include recent history (skip system messages, keep user/assistant pairs)
      // Limit to last 4 turns to stay within context budget
      const historyTurns = conversationHistory
        .filter(m => m.role !== 'system')
        .slice(-8); // last 4 user/assistant pairs
      messages.push(...historyTurns);
    }
    messages.push({ role: 'user', content: message });

    const response = await provider.complete(
      messages,
      { maxTokens: 800, temperature: 0 },
    );

    // Try new primary/attached format first
    const prompt = parsePrimaryAttached(response.text);
    if (prompt) {
      // Convert to legacy actions[] for backward compat
      const actions: DecomposedAction[] = [prompt.primary];
      for (const a of prompt.attached) {
        actions.push(a);
      }
      const attachedSummary = prompt.attached.map(a => `${a.relation}:${a.intent}`).join(', ');
      log.info({
        primary: prompt.primary.intent,
        attached: prompt.attached.length,
        relations: attachedSummary,
      }, 'decomposed (primary/attached)');
      return { actions, prompt, message, usedLLM: true };
    }

    // Fallback: try old actions[] format
    const parsed = parseDecomposeResponse(response.text);
    if (parsed && parsed.length > 0) {
      // Auto-convert old format to primary/attached
      const autoPrompt = convertLegacyToPrompt(parsed);
      log.info({ actions: parsed.length, intents: parsed.map(a => a.intent) }, 'decomposed (legacy)');
      return { actions: parsed, prompt: autoPrompt, message, usedLLM: true };
    }
  } catch (err) {
    log.debug({ err }, 'decompose LLM call failed');
  }

  // Fallback: return empty -- caller should fall back to single-intent classifier
  return { actions: [], message, usedLLM: false };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseDecomposeResponse(text: string): DecomposedAction[] | null {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    // Extract JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as { actions?: unknown[] };
    if (!Array.isArray(parsed.actions)) return null;

    const actions: DecomposedAction[] = [];
    for (const raw of parsed.actions) {
      const a = raw as Record<string, unknown>;
      const intent = String(a['intent'] ?? '');
      if (!ALL_INTENTS.includes(intent)) continue;

      const refs = Array.isArray(a['refs'])
        ? (a['refs'] as Array<Record<string, unknown>>)
            .filter(r => typeof r['path'] === 'string' && typeof r['purpose'] === 'string')
            .map(r => ({ path: String(r['path']), purpose: String(r['purpose']) as RefPurpose }))
        : undefined;

      actions.push({
        intent: intent as Intent,
        action: String(a['action'] ?? ''),
        subject: a['subject'] ? String(a['subject']) : undefined,
        refs: refs && refs.length > 0 ? refs : undefined,
        outputFormat: a['outputFormat'] ? String(a['outputFormat']) : undefined,
        dependsOn: typeof a['dependsOn'] === 'number' ? a['dependsOn'] : undefined,
        commandHint: (a['commandHint'] ?? a['command']) ? String(a['commandHint'] ?? a['command']) : undefined,
        confidence: typeof a['confidence'] === 'number' ? Math.max(0, Math.min(1, a['confidence'])) : 0.8,
      });
    }

    return actions.length > 0 ? actions : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// New format parser (primary/attached)
// ---------------------------------------------------------------------------

const VALID_RELATIONS = new Set(['augment', 'append', 'format', 'depends', 'parallel']);

function parseAction(a: Record<string, unknown>): DecomposedAction | null {
  const intent = String(a['intent'] ?? '');
  if (!ALL_INTENTS.includes(intent)) return null;

  const refs = Array.isArray(a['refs'])
    ? (a['refs'] as Array<Record<string, unknown>>)
        .filter(r => typeof r['path'] === 'string' && typeof r['purpose'] === 'string')
        .map(r => ({ path: String(r['path']), purpose: String(r['purpose']) as RefPurpose }))
    : undefined;

  return {
    intent: intent as Intent,
    action: String(a['action'] ?? ''),
    subject: a['subject'] ? String(a['subject']) : undefined,
    refs: refs && refs.length > 0 ? refs : undefined,
    outputFormat: a['outputFormat'] ? String(a['outputFormat']) : undefined,
    commandHint: (a['commandHint'] ?? a['command']) ? String(a['commandHint'] ?? a['command']) : undefined,
    confidence: typeof a['confidence'] === 'number' ? Math.max(0, Math.min(1, a['confidence'])) : 0.8,
  };
}

function parsePrimaryAttached(text: string): DecomposedPrompt | null {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Must have 'primary' field
    if (!parsed['primary'] || typeof parsed['primary'] !== 'object') return null;

    const primary = parseAction(parsed['primary'] as Record<string, unknown>);
    if (!primary) return null;

    const attached: AttachedAction[] = [];
    if (Array.isArray(parsed['attached'])) {
      for (const raw of parsed['attached'] as Array<Record<string, unknown>>) {
        const base = parseAction(raw);
        if (!base) continue;

        const relation = String(raw['relation'] ?? 'augment');
        if (!VALID_RELATIONS.has(relation)) continue;

        attached.push({
          ...base,
          relation: relation as AttachedRelation,
          reason: String(raw['reason'] ?? ''),
        });
      }
    }

    return { primary, attached };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Legacy format converter
// ---------------------------------------------------------------------------

function convertLegacyToPrompt(actions: DecomposedAction[]): DecomposedPrompt {
  if (actions.length === 0) {
    return {
      primary: { intent: 'research', action: '', confidence: 0.3 },
      attached: [],
    };
  }

  const primary = actions[0]!;
  const attached: AttachedAction[] = [];

  for (let i = 1; i < actions.length; i++) {
    const action = actions[i]!;
    let relation: AttachedRelation;

    if (action.intent === 'document' && action.dependsOn !== undefined) {
      relation = 'format';
    } else if (action.dependsOn !== undefined) {
      relation = 'depends';
    } else if (action.intent === primary.intent) {
      relation = 'augment';
    } else {
      relation = 'append';
    }

    attached.push({
      ...action,
      relation,
      reason: action.dependsOn !== undefined ? 'depends on prior step' : 'additional request',
    });
  }

  return { primary, attached };
}
