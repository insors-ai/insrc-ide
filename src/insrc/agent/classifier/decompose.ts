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

import type { Intent, LLMProvider } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';

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

export interface DecomposeResult {
  /** Ordered array of actions to execute */
  actions: DecomposedAction[];
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
Given a user message, break it down into one or more structured actions.

Available intents: ${ALL_INTENTS.join(', ')}

File reference purposes:
- requirements-source: document to extract requirements from
- style-reference: file to use for output styling/template
- target-file: file to modify, refactor, debug, or review
- test-target: file to write tests for
- context: general background/reference material
- config: configuration file reference
- data: data file reference

Rules:
- Decompose into MULTIPLE actions when the request has sequential processing steps.
  Examples:
  - "check the pods and output as markdown" → action 1: infra (run kubectl), action 2: document (format as markdown, dependsOn: 0)
  - "get logs from pod X and find the error" → action 1: infra (get logs), action 2: research (analyze for errors, dependsOn: 0)
  - "list services and create a diagram" → action 1: infra (list services), action 2: document (create diagram, dependsOn: 0)
  - "design X and then implement it" → action 1: design, action 2: implement (dependsOn: 0)
- If the request is truly a single operation with no post-processing, use a single action.
- Detect file paths in the message and tag each with its purpose based on how
  the user describes it (e.g., "based on X" → requirements-source, "using Y for styling" → style-reference).
- If action B depends on action A's output, set dependsOn to A's index (0-based).
- For infra/deploy intents, provide a commandHint with your best guess at the
  shell command. This is a HINT — it will be refined at execution time using
  actual output from prior steps. Do NOT add output format flags (e.g., -o
  markdown, -o json). Formatting is a separate action.
- Informational questions ("what is X", "what services are available", "how does X work",
  "what endpoints exist", "where is X defined", "show me the Y") are "research" intent —
  they ask about existing state, not about building something new. Do NOT classify these
  as "requirements", "design", or "plan". Only use "requirements" when the user explicitly
  wants to define specs/stories for something to be built. Only use "design" when the user
  explicitly wants architectural reasoning or tradeoff analysis.
- Confidence: 0.9+ for clear actions, 0.7-0.9 for inferred, below 0.7 for guesses.
- For greetings (hi, hello, hey, thanks, etc.) or vague/conversational messages,
  use intent "research" with action "chat" and confidence 0.3. Do NOT force a
  specific intent on ambiguous messages.

Output ONLY valid JSON — no markdown fences, no explanation:
{
  "actions": [
    {
      "intent": "<intent>",
      "action": "<description>",
      "subject": "<what is being acted on>",
      "refs": [{ "path": "<file-path>", "purpose": "<purpose>" }],
      "outputFormat": "<html|md|json|null>",
      "dependsOn": <index|null>,
      "commandHint": "<best-guess-shell-command|null>",
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
      { maxTokens: 500, temperature: 0 },
    );

    const parsed = parseDecomposeResponse(response.text);
    if (parsed && parsed.length > 0) {
      log.info({ actions: parsed.length, intents: parsed.map(a => a.intent) }, 'decomposed');
      return { actions: parsed, message, usedLLM: true };
    }
  } catch (err) {
    log.debug({ err }, 'decompose LLM call failed');
  }

  // Fallback: return empty — caller should fall back to single-intent classifier
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
