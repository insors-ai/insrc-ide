/**
 * Citations invariant validator.
 *
 * Pure function. Per `design/analyzers/code-analyzer.html` section 7.5:
 *
 *   Every claim in `answer` or every Finding must resolve to at least
 *   one CodeCitation. The analyzer's output JSON is rejected and
 *   retried (once) if any finding has citations.length === 0. After
 *   the retry, a missing-citation result is accepted but auto-
 *   downgraded to confidence: 'low'.
 *
 * The retry / downgrade policy lives in the analyzer runner; this
 * module is the predicate the runner consults. Keeping it pure makes
 * it cheap to call twice (pre- and post-retry) and easy to test.
 */

import type { AnalyzerResult } from '../types.js';

export type CitationsValidation =
  | { readonly ok: true; readonly result: AnalyzerResult }
  | {
      readonly ok: false;
      readonly reason: 'no_citation_for_finding';
      /** 0-based index into result.findings of the first violator. */
      readonly findingIndex: number;
      readonly result: AnalyzerResult;
    };

/**
 * True iff every finding in the result carries at least one citation.
 *
 * The result is returned in both branches so the caller can salvage
 * the analyzer's prose answer + tool-call trace even when the
 * invariant fails.
 */
export function validateCitations(result: AnalyzerResult): CitationsValidation {
  for (let i = 0; i < result.findings.length; i++) {
    const finding = result.findings[i]!;
    if (finding.citations.length === 0) {
      return {
        ok: false,
        reason: 'no_citation_for_finding',
        findingIndex: i,
        result,
      };
    }
  }
  return { ok: true, result };
}

/**
 * Force a result's confidence band to 'low' and surface a warning on
 * the items's meta. Called by the runner after a citations-invariant
 * retry has also failed, per the design's "accepted but downgraded"
 * fallback.
 */
export function downgradeForMissingCitations(result: AnalyzerResult): AnalyzerResult {
  if (result.confidence === 'low') return result;
  return { ...result, confidence: 'low' };
}
