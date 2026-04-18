/**
 * Brainstorm sub-category detector.
 *
 * Keyword-based heuristic -- cheap, deterministic, runs at dispatch
 * time in the daemon without a separate LLM call. If confidence is
 * low (no strong match), returns 'general'.
 *
 * Each category has both a primary set (high weight) and a secondary
 * set (low weight). Ties fall back to the category declaration order
 * in BrainstormCategory, which mirrors the user-facing priority.
 */

import type { BrainstormCategory } from '../../daemon/controllers/brainstorm/types.js';

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
    strong: [rx('design architecture')],
    weak: [rx('component api schema contract interface boundary module tradeoff trade-off')],
  },
  {
    category: 'implementation',
    strong: [rx('implement implementation build code')],
    weak: [rx('approach effort estimate refactor migrate migration tasks breakdown subtask plan')],
  },
  {
    category: 'requirements',
    strong: [rx('requirement requirements spec specification')],
    weak: [rx('feature user-story acceptance criteria functional non-functional constraint')],
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
