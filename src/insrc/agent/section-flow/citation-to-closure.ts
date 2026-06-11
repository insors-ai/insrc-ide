/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Transform `CitedStepSummary[]` (local-tier output) into
 * `ClosureClaim[]` (convergence accounting input).
 *
 * Replaces the legacy plaintext-regex `scanAllClosureMarkers(...)`
 * path. The cited summaries carry explicit `gapClosures` arrays with
 * structured `{ gapId, verdict }` -- no regex scan, no
 * gap-id-paraphrase tolerance issues, no closure markers fabricated in
 * narrative prose.
 *
 * Verdict mapping:
 *   - cited summary `verdict: 'closes'`     -> ClosureClaim `closes-fully`, gapId
 *   - cited summary `verdict: 'partially'`  -> ClosureClaim `partial`, gapId
 *   - cited summary `verdict: 'off-topic'`  -> ClosureClaim `off-topic`, gapId=null
 */

import type { ClosureClaim } from './convergence.js';
import type { CitedStepSummary } from './citation-types.js';

export function citedSummariesToClosureClaims(
	stepId:    string,
	summaries: readonly CitedStepSummary[],
): readonly ClosureClaim[] {
	const out: ClosureClaim[] = [];
	for (const s of summaries) {
		for (const closure of s.gapClosures) {
			if (closure.verdict === 'closes') {
				out.push({ stepId, callId: s.callId, gapId: closure.gapId, verdict: 'closes-fully' });
			} else if (closure.verdict === 'partially') {
				out.push({ stepId, callId: s.callId, gapId: closure.gapId, verdict: 'partial' });
			} else {
				// 'off-topic'
				out.push({ stepId, callId: s.callId, gapId: null,        verdict: 'off-topic' });
			}
		}
	}
	return out;
}
