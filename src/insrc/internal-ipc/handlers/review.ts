/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `internal.review.*` -- audit-time review handlers backed by the
 * Phase 0 extracted libraries.
 *
 * - `internal.review.citation-verify` -> verifyCitedSummary
 * - `internal.review.section-review`  -> reviewSection
 *
 * Phase 6 (external-agent audit loop) reuses the same Phase 0 libs
 * to score deliverables returned by the external coding agent.
 * Until Phase 6 lands, these handlers are called only by section-flow
 * for local-LLM-generated content.
 */

import {
	verifyCitedSummary,
	type ArtifactRawTextLookup,
	type VerificationResult,
} from '../../agent/section-flow/audit/citation-verifier.js';
import {
	reviewSection,
	type SectionReviewInput,
	type SectionReviewResult,
} from '../../agent/section-flow/audit/section-review.js';
import type { CitedStepSummary } from '../../agent/section-flow/citation-types.js';
import type { InternalIpcHandler } from '../types.js';

export interface CitationVerifyInput {
	readonly summary: CitedStepSummary;
	readonly lookup:  ArtifactRawTextLookup;
}

export const reviewCitationVerify: InternalIpcHandler<CitationVerifyInput, VerificationResult> = {
	name: 'internal.review.citation-verify',
	async invoke(input) {
		return verifyCitedSummary(input.summary, input.lookup);
	},
};

export const reviewSectionReview: InternalIpcHandler<SectionReviewInput, SectionReviewResult> = {
	name: 'internal.review.section-review',
	async invoke(input) {
		return reviewSection(input);
	},
};
