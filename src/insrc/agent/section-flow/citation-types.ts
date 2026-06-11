/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Citation contract -- universal grounding for every fact emitted by a
 * local-tier LLM turn in the section-flow pipeline.
 *
 * Problem this replaces: the cloud-tier `decide-next-step` previously
 * authored `lastStepArtifactSummary` strings keyed by callId. Live runs
 * showed the cloud labelling `data.source.file.sample-shape` output as
 * "INGRN Pydantic Model Class Definition" -- pulling the goal into the
 * artifact summary at the cost of accuracy. The synth then incorporated
 * the mis-labelled summary verbatim, producing reports with two
 * contradictory class definitions side-by-side.
 *
 * Fix: move summary authoring from cloud (motivated-reasoning prone) to
 * local (text-against-text grounding), and require EVERY claim carry a
 * citation that points to a verifiable substring inside a named
 * artifact. The verifier runs deterministic substring + count checks --
 * no LLM judgment for "did we over-claim?". When the verifier rejects a
 * claim, the orchestrator can retry the summarise step OR force a
 * synth revise-major depending on which layer authored the bad claim.
 *
 * Count claims (e.g. "JSON fixture has 12 keys") decompose into N
 * citations -- one per element of the count. The verifier asserts
 * `citations.length === N` when the claim's `countAssertion` field is
 * populated. Optional escape hatch for narrative claims where exact
 * count cannot be machine-extracted.
 *
 * Confirmed-null answers (e.g. "directory contains no JSON files") are
 * a first-class evidence type. The single citation points to an
 * artifact whose raw text is empty / blank; the verifier asserts the
 * referenced artifact is in fact empty. Without this carve-out, honest
 * null exits would fail verification.
 */

// ---------------------------------------------------------------------------
// Citation -- a verbatim span from a known artifact
// ---------------------------------------------------------------------------

export interface Citation {
	/**
	 * Artifact-vec id (`<sessionId>:<timestamp>:<skillId>`) the span is
	 * drawn from. MUST match an artifact the verifier can look up.
	 */
	readonly artifactId: string;

	/**
	 * Verbatim substring from the artifact's raw output. NO paraphrase,
	 * NO ellipses, NO summarisation. The verifier asserts
	 * `artifact.rawText.includes(span)`.
	 *
	 * Multi-line spans are allowed; the substring check is on the raw
	 * string. Spans should be specific enough to be unambiguous
	 * (typically 40-200 chars) -- a single common word like "the" would
	 * pass the substring check vacuously.
	 */
	readonly span: string;
}

// ---------------------------------------------------------------------------
// CitedClaim -- one atomic assertion + its evidence
// ---------------------------------------------------------------------------

export type CitedClaimEvidence = 'cited' | 'confirmed-null';

export interface CitedClaim {
	/**
	 * One atomic assertion in natural language. Should be specific
	 * enough that a verifier can match its citations against it. Avoid
	 * narrative connectives ("therefore", "however") that have no
	 * grounding requirement -- those go in the summary text, not in a
	 * claim.
	 */
	readonly claim: string;

	/**
	 * Evidence type:
	 *   - `cited` -- normal case. `citations` MUST have >=1 entry.
	 *     Every citation's `span` must substring-match its
	 *     `artifactId`'s raw text.
	 *   - `confirmed-null` -- claim asserts ABSENCE (empty directory,
	 *     no matches found, file is empty). `citations` MUST have
	 *     exactly 1 entry. The referenced artifact's raw text must be
	 *     blank / 0 bytes.
	 */
	readonly evidence: CitedClaimEvidence;

	/**
	 * Citations backing the claim. Empty array is INVALID for
	 * `evidence: 'cited'`. Exactly-one-entry required for
	 * `evidence: 'confirmed-null'`.
	 *
	 * For count claims (e.g. "the class has 27 fields"), the citation
	 * list MUST have one entry per element being counted (27 citations,
	 * each spanning one field). Optional `countAssertion` lets the
	 * verifier enforce `citations.length === countAssertion`.
	 */
	readonly citations: readonly Citation[];

	/**
	 * When the claim names a count ("has N items"), set this to N.
	 * Verifier asserts `citations.length === countAssertion`. Omit
	 * (undefined) for non-count claims; verifier skips the count check.
	 */
	readonly countAssertion?: number | undefined;
}

// ---------------------------------------------------------------------------
// GapClosureClaim -- closure verdict for one gap-fact, also cited
// ---------------------------------------------------------------------------

export type GapClosureVerdict = 'closes' | 'partially' | 'off-topic';

export interface GapClosureClaim extends CitedClaim {
	/**
	 * The gap-fact `id` this claim addresses. MUST match an entry in
	 * the TODO's gap-fact set verbatim -- the closure-scanner in
	 * `convergence.ts` matches gap-id exactly.
	 */
	readonly gapId: string;

	/**
	 * Closure verdict:
	 *   - `closes`     -- this artifact materially answers the gap-fact.
	 *   - `partially`  -- artifact partially addresses; more evidence needed.
	 *   - `off-topic`  -- artifact doesn't speak to this gap.
	 *                     For `off-topic`, `evidence` is typically
	 *                     `confirmed-null` (artifact says nothing about
	 *                     this gap) OR `cited` with a span quoting the
	 *                     scope-mismatch.
	 */
	readonly verdict: GapClosureVerdict;
}

// ---------------------------------------------------------------------------
// CitedStepSummary -- one local-tier output describing ONE skill call
// ---------------------------------------------------------------------------

export interface CitedStepSummary {
	/** The PlannedSkillCall.id (e.g. `s1.a`). Short-form callId. */
	readonly callId: string;

	/** Catalog skill id (e.g. `code.class.extract-fields`). */
	readonly skillId: string;

	/** The spilled artifact id this summary applies to. */
	readonly artifactId: string;

	/**
	 * 1-3 sentence narrative summarising what the skill produced. The
	 * narrative itself is NOT verified -- it's a human-readable header
	 * for the cited claims below. Specific assertions belong in
	 * `claims`, not here.
	 */
	readonly summary: string;

	/**
	 * Atomic claims with citations. Every concrete identifier / number
	 * / field-name / type / class-name asserted in `summary` must
	 * appear here with citations. Verifier walks this list.
	 */
	readonly claims: readonly CitedClaim[];

	/**
	 * Gap-fact closure determinations. One per gap-fact this call
	 * materially supports OR explicitly marks off-topic. Gaps the call
	 * doesn't address are simply omitted (no entry == implicit "not
	 * addressed by this call").
	 */
	readonly gapClosures: readonly GapClosureClaim[];
}

// ---------------------------------------------------------------------------
// Per-step output (groups call summaries for one DiscoveryStep)
// ---------------------------------------------------------------------------

export interface CitedStepGroup {
	readonly stepId:    string;
	/** One summary per call in the step (matches step.skills[]). */
	readonly summaries: readonly CitedStepSummary[];
}
