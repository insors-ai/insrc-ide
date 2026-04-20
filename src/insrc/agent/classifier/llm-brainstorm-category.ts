/**
 * LLM-based brainstorm sub-category classifier.
 *
 * Primary path for routing a brainstorm task into one of the five
 * category-specific controllers. Mirrors llm-classify.ts in shape --
 * structured JSON output, null on failure so the caller can fall back
 * to the keyword matcher.
 */

import type { LLMProvider } from '../../shared/types.js';
import type { BrainstormCategory } from '../../daemon/controllers/brainstorm/types.js';

const ALL_CATEGORIES: BrainstormCategory[] = [
  'requirements',
  'design',
  'implementation',
  'testing',
  'general',
];

const CLASSIFY_SYSTEM = `You are a sub-classifier for brainstorm requests.
Given a user message, pick the sub-category that best matches what the user wants the brainstorm to produce.

Categories:
- requirements: user wants to brainstorm WHAT to build -- specs, user stories, acceptance criteria, scope decisions
- design: user wants to brainstorm architectural shape -- modules, interfaces, data flow, API contracts, tradeoffs
- implementation: user wants to brainstorm HOW to build it -- code approaches, libraries, refactor strategies, tasks/phases
- testing: user wants to brainstorm how to test something -- scenarios, test types, assertions, coverage gaps, flaky risks
- general: open-ended exploration that doesn't fit the four structured categories -- hackathon ideas, product direction, creative framing

Rules:
- Pick the single best-fit category.
- If the message only says "brainstorm X" without a clear angle, lean toward 'design' or 'general' -- NOT 'implementation' by default.
- Words like "agent", "feature", "workflow", "service", "tool" by themselves do NOT imply implementation -- look at what the user wants to END UP with.
- Confidence: 0.9+ for clear matches, 0.6-0.9 for reasonable inferences, below 0.6 for guesses.

Respond with ONLY valid JSON matching this schema:
{
  "category": "<requirements|design|implementation|testing|general>",
  "confidence": <0.0-1.0>,
  "reasoning": "<one sentence>"
}`;

export interface BrainstormCategoryClassification {
  category: BrainstormCategory;
  confidence: number;
  reasoning: string;
}

function isValidCategory(v: unknown): v is BrainstormCategory {
  return typeof v === 'string' && (ALL_CATEGORIES as string[]).includes(v);
}

function clampConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : 0.5;
  return Math.max(0, Math.min(1, n));
}

function parseResponse(text: string): BrainstormCategoryClassification | null {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    const parsed = JSON.parse(cleaned);
    if (!isValidCategory(parsed.category)) return null;
    return {
      category: parsed.category,
      confidence: clampConfidence(parsed.confidence),
      reasoning: String(parsed.reasoning ?? ''),
    };
  } catch {
    return null;
  }
}

/**
 * Classify a brainstorm message via the local LLM.
 * Returns null on provider failure or unparseable output so the caller
 * can fall back to keyword matching.
 */
export async function classifyBrainstormCategoryLLM(
  message: string,
  provider: LLMProvider,
): Promise<BrainstormCategoryClassification | null> {
  try {
    const response = await provider.complete(
      [
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user', content: message },
      ],
      { maxTokens: 150, temperature: 0 },
    );
    return parseResponse(response.text);
  } catch {
    return null;
  }
}
