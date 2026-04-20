/**
 * Brainstorm sub-category detector.
 *
 * Hybrid: LLM-first via `classifyBrainstormCategoryHybrid`, keyword
 * fallback via `detectBrainstormCategory` (used when the local LLM
 * provider is unavailable or its output is unparseable).
 *
 * The keyword matcher scores each candidate category; a score below
 * MIN_SCORE falls back to 'general'. Each category has a primary set
 * (high weight) and a secondary set (low weight). Ties fall back to
 * the declaration order in BrainstormCategory.
 */

import type { LLMProvider } from '../../shared/types.js';
import type { BrainstormCategory } from '../../daemon/controllers/brainstorm/types.js';
import {
  classifyBrainstormCategoryLLM,
  type BrainstormCategoryClassification,
} from './llm-brainstorm-category.js';

interface KeywordMatcher {
  category: BrainstormCategory;
  strong: RegExp[];
  weak: RegExp[];
}

/** Word-boundary regex helper. `words` is a space-separated list. */
function rx(words: string): RegExp {
  return new RegExp('\\b(?:' + words.split(/\s+/).join('|') + ')\\b', 'i');
}

const MATCHERS: KeywordMatcher[] = [
  {
    category: 'testing',
    strong: [rx('test tests testing testcase test-case')],
    weak: [rx('coverage assertion fixture mock stub flaky unit integration e2e regression')],
  },
  {
    category: 'design',
    strong: [rx('design architecture architect architecting')],
    weak: [rx('component api schema contract interface boundary module tradeoff trade-off endpoint service pipeline')],
  },
  {
    category: 'implementation',
    strong: [rx('implement implementation build code coding')],
    weak: [rx('approach effort estimate refactor migrate migration tasks breakdown subtask plan mvp prototype function workflow')],
  },
  {
    category: 'requirements',
    strong: [rx('requirement requirements spec specification specify')],
    weak: [rx('feature user-story acceptance criteria functional non-functional constraint story backlog')],
  },
];

const STRONG_WEIGHT = 3;
const WEAK_WEIGHT = 1;
const MIN_SCORE = 2;

/**
 * Detect the brainstorm sub-category for a user message.
 *
 * Returns 'general' when no category scores at least MIN_SCORE --
 * this is the structural fallback (no per-theme spec generation).
 */
export function detectBrainstormCategory(message: string): BrainstormCategory {
  const scores = new Map<BrainstormCategory, number>();

  for (const m of MATCHERS) {
    let score = 0;
    for (const re of m.strong) { if (re.test(message)) { score += STRONG_WEIGHT; } }
    for (const re of m.weak)   { if (re.test(message)) { score += WEAK_WEIGHT; } }
    if (score > 0) { scores.set(m.category, score); }
  }

  let best: BrainstormCategory = 'general';
  let bestScore = 0;
  for (const [cat, score] of scores) {
    if (score > bestScore) {
      best = cat;
      bestScore = score;
    }
  }

  return bestScore >= MIN_SCORE ? best : 'general';
}

// ---------------------------------------------------------------------------
// Hybrid entrypoint: LLM first, keyword fallback.
// ---------------------------------------------------------------------------

const LLM_MIN_CONFIDENCE = 0.6;

/**
 * Classify the brainstorm sub-category using the local LLM, falling
 * back to keyword matching when the LLM is unavailable, returns
 * unparseable output, or reports confidence below LLM_MIN_CONFIDENCE.
 *
 * When `provider` is undefined, the LLM step is skipped entirely and
 * the keyword matcher runs directly (used during early bootstrap
 * before a classifier provider is resolvable).
 */
export async function classifyBrainstormCategoryHybrid(
  message: string,
  provider: LLMProvider | undefined,
): Promise<BrainstormCategoryClassification> {
  if (provider) {
    const llm = await classifyBrainstormCategoryLLM(message, provider);
    if (llm && llm.confidence >= LLM_MIN_CONFIDENCE) {
      return llm;
    }
  }
  const category = detectBrainstormCategory(message);
  return {
    category,
    confidence: 0.3,
    reasoning: 'keyword fallback',
  };
}
