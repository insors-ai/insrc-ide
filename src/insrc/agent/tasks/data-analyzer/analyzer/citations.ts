/**
 * Citations invariant validator for the Data Analyzer.
 *
 * Mirrors agent/tasks/code-analyzer/analyzer/citations.ts. Per the
 * design's section 7.5: every Finding must resolve to at least one
 * DataCitation. The runner enforces a one-shot retry on violation,
 * then downgrades confidence to 'low' if the retry also misses.
 *
 * Gate-blocked tasks (blockedReason set) are exempt -- they have no
 * findings to validate; the orchestrator surfaces them in a separate
 * "blocked" bucket.
 */

import type { DataAnalyzerResult } from '../types.js';

export type CitationsValidation =
  | { readonly ok: true; readonly result: DataAnalyzerResult }
  | {
      readonly ok: false;
      readonly reason: 'no_citation_for_finding';
      /** 0-based index into result.findings of the first violator. */
      readonly findingIndex: number;
      readonly result: DataAnalyzerResult;
    };

/**
 * True iff every finding in the result carries at least one citation.
 *
 * Gate-blocked results (blockedReason set) automatically pass --
 * the orchestrator routes them through a separate "blocked" path
 * that doesn't expect findings.
 *
 * The result is returned in both branches so the caller can salvage
 * the analyzer's prose answer + tool-call trace even when the
 * invariant fails.
 */
export function validateCitations(result: DataAnalyzerResult): CitationsValidation {
  if (result.blockedReason !== undefined) {
    return { ok: true, result };
  }
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
 * Force a result's confidence band to 'low'. Called by the runner
 * after a citations-invariant retry has also failed.
 */
export function downgradeForMissingCitations(result: DataAnalyzerResult): DataAnalyzerResult {
  if (result.confidence === 'low') {
    return result;
  }
  return { ...result, confidence: 'low' };
}
