/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Citation verifier -- deterministic substring + count checks against
 * the artifacts named by each `CitedClaim.citations[]`.
 *
 * Originally section-flow internal; now part of `audit/` so it can also
 * be invoked on external-agent deliverables -- see
 * `plans/external-agent-integration.md` Phase 0 and Phase 6.
 *
 * No LLM judgment. Every check is a string operation:
 *   - `evidence: 'cited'`    -> every citation's `span` must be a
 *                                substring of its `artifactId`'s raw
 *                                text. `citations.length >= 1`.
 *   - `evidence: 'confirmed-null'` -> exactly one citation; the
 *                                referenced artifact's raw text must be
 *                                blank (length 0 after trim).
 *   - `countAssertion: N`    -> `citations.length === N`.
 *
 * The verifier returns a structured `VerificationResult` listing every
 * bad claim with a precise reason. The caller decides what to do
 * (retry summarise step, force synth revise-major, etc.).
 *
 * Why deterministic: live runs showed the cloud-tier reviewer
 * over-approving sections whose synth markdown contradicted the
 * underlying ledger. The cloud's "did we over-claim?" judgment is
 * unreliable because it shares the same goal-bias as the synth. A
 * deterministic substring check has zero goal-bias.
 */

import { readFile } from 'node:fs/promises';

import type {
	CitedClaim,
	CitedStepSummary,
	GapClosureClaim,
} from '../citation-types.js';
import { getArtifactById } from '../../../db/lance/artifact-vec.js';
import { getLogger } from '../../../shared/logger.js';

const log = getLogger('section-flow:citation-verifier');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BadClaim {
	/** Text of the failing claim, for the corrective hint. */
	readonly claimText: string;
	/** Specific reason -- which citation failed and why. */
	readonly reason:    string;
	/** When this is a gap closure, the gap id. */
	readonly gapId?:    string | undefined;
}

export interface VerificationResult {
	readonly ok:        boolean;
	readonly badClaims: readonly BadClaim[];
}

/**
 * Look up an artifact's raw text. Production wires this to the
 * artifact_vec table + spill file; tests can inject an in-memory map.
 */
export type ArtifactRawTextLookup = (artifactId: string) => Promise<string | undefined>;

/**
 * Default lookup that reads `artifact_vec` for the spill `path` then
 * reads the spill file from disk. Production callers use this directly.
 */
export const defaultArtifactRawTextLookup: ArtifactRawTextLookup = async (artifactId) => {
	const hit = await getArtifactById(artifactId);
	if (hit === null) { return undefined; }
	try {
		const buf = await readFile(hit.path, 'utf8');
		return buf;
	} catch (err) {
		log.warn({ artifactId, path: hit.path, err: (err as Error).message },
			'citation-verifier: spill file unreadable; treating raw text as missing');
		return undefined;
	}
};

// ---------------------------------------------------------------------------
// verifyCitedSummary -- main entry
// ---------------------------------------------------------------------------

export async function verifyCitedSummary(
	summary:            CitedStepSummary,
	getArtifactRawText: ArtifactRawTextLookup,
): Promise<VerificationResult> {
	const bad: BadClaim[] = [];

	for (const claim of summary.claims) {
		const r = await verifyOne(claim, getArtifactRawText);
		if (r.ok === false) {
			bad.push({ claimText: claim.claim, reason: r.reason });
		}
	}

	for (const closure of summary.gapClosures) {
		const r = await verifyClosure(closure, getArtifactRawText);
		if (r.ok === false) {
			bad.push({ claimText: closure.claim, reason: r.reason, gapId: closure.gapId });
		}
	}

	return { ok: bad.length === 0, badClaims: bad };
}

// ---------------------------------------------------------------------------
// verifyOne -- one claim of any shape
// ---------------------------------------------------------------------------

type OneResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

async function verifyOne(claim: CitedClaim, lookup: ArtifactRawTextLookup): Promise<OneResult> {
	if (claim.evidence === 'confirmed-null') {
		if (claim.citations.length !== 1) {
			return { ok: false, reason: `confirmed-null claim must have exactly 1 citation; got ${claim.citations.length}` };
		}
		const cit = claim.citations[0]!;
		const raw = await lookup(cit.artifactId);
		if (raw === undefined) {
			return { ok: false, reason: `artifact ${cit.artifactId} not found / unreadable` };
		}
		if (raw.trim().length > 0) {
			return { ok: false, reason: `confirmed-null claim cites a non-empty artifact (${raw.length} chars)` };
		}
		return { ok: true };
	}

	// evidence === 'cited'
	if (claim.citations.length === 0) {
		return { ok: false, reason: 'cited claim must have at least one citation' };
	}
	if (claim.countAssertion !== undefined && claim.citations.length !== claim.countAssertion) {
		return { ok: false, reason: `count claim asserts ${claim.countAssertion} but citations list has ${claim.citations.length}` };
	}
	for (let i = 0; i < claim.citations.length; i++) {
		const cit = claim.citations[i]!;
		const raw = await lookup(cit.artifactId);
		if (raw === undefined) {
			return { ok: false, reason: `citation[${i}]: artifact ${cit.artifactId} not found / unreadable` };
		}
		if (cit.span.length === 0) {
			return { ok: false, reason: `citation[${i}]: span is empty` };
		}
		if (!raw.includes(cit.span)) {
			const preview = cit.span.length > 80 ? `${cit.span.slice(0, 77)}...` : cit.span;
			return { ok: false, reason: `citation[${i}]: span not found in artifact ${cit.artifactId}: "${preview}"` };
		}
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// verifyClosure -- gap-closure claim: same as verifyOne plus verdict shape
// ---------------------------------------------------------------------------

async function verifyClosure(closure: GapClosureClaim, lookup: ArtifactRawTextLookup): Promise<OneResult> {
	if (closure.gapId.trim().length === 0) {
		return { ok: false, reason: 'gap-closure claim has empty gapId' };
	}
	if (closure.verdict !== 'closes' && closure.verdict !== 'partially' && closure.verdict !== 'off-topic') {
		return { ok: false, reason: `gap-closure has invalid verdict "${closure.verdict as string}"` };
	}
	return verifyOne(closure, lookup);
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _verifyOneForTest     = verifyOne;
export const _verifyClosureForTest = verifyClosure;
