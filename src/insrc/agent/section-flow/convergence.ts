/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Convergence signals for the dynamic decide-next-step loop --
 * Phase 5 of plans/section-flow-architecture-redesign.md (folded
 * into Phase 4 batch 4.2 because the new loop literally cannot
 * terminate without them).
 *
 * Three independent signals; whichever fires first ends the loop:
 *
 *   1. **Fact-gap closure** -- every gap fact in the active list has
 *      at least one `CLOSES <gap-id> fully` marker against it in the
 *      TOC. Pure structural scan, deterministic, no LLM call.
 *
 *   2. **N consecutive no-progress steps** -- a step "contributes
 *      evidence" when its goal-aware summary carries at least one
 *      closure marker (any `CLOSES` or `PARTIALLY supports`). N
 *      consecutive markerless steps means the loop is no longer
 *      making real progress; terminate `unrecoverable`.
 *
 *   3. **Safety ceiling** -- a hard cap (default 50 steps per TODO,
 *      env-configurable) that exists ONLY to prevent runaway loops
 *      if both signals above fail. When it fires, treat it as a bug
 *      and log loudly. Under correct conditions it should never fire.
 *
 * The marker scanner + `ClosureClaim` shape moved here from the
 * deleted `step-cycle-review.ts` during Phase 4 batch 4.2. The
 * vocabulary is the same one the cycle-review v2 writer taught and
 * the new decide-next-step v1 writer continues to teach:
 *
 *     CLOSES <gap-id> fully
 *     PARTIALLY supports <gap-id>
 *     OFF-TOPIC
 *
 * `<gap-id>` is the literal `id` of a gap fact (NOT the numeric
 * index). Multiple markers per summary are allowed (chained with
 * `;`). A marker whose `<gap-id>` isn't in the active gap-fact set
 * is dropped so fabricated coverage claims never reach the
 * convergence logic.
 */

import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:convergence');

// ---------------------------------------------------------------------------
// Default budgets (env-overridable)
// ---------------------------------------------------------------------------

/** Default cap on no-progress steps before the loop terminates as `unrecoverable`. */
export const DEFAULT_NO_PROGRESS_BUDGET = parseEnvInt('INSRC_NO_PROGRESS_BUDGET', 3);
/** Hard cap on steps per TODO (a runaway-loop backstop -- should never fire under correct conditions). */
export const DEFAULT_SAFETY_CEILING = parseEnvInt('INSRC_SECTION_FLOW_SAFETY_CEILING', 50);

function parseEnvInt(name: string, fallback: number): number {
	const v = process.env[name];
	if (v === undefined || v.trim().length === 0) { return fallback; }
	const n = parseInt(v, 10);
	if (!Number.isFinite(n) || n <= 0) { return fallback; }
	return n;
}

// ---------------------------------------------------------------------------
// Closure markers
// ---------------------------------------------------------------------------

export type ClosureVerdict = 'closes-fully' | 'partial' | 'off-topic';

/** One marker extracted from a goal-aware summary. */
export interface ClosureClaim {
	readonly stepId:  string;
	readonly callId:  string;
	/** Gap-fact id the marker referenced. `null` when verdict is `off-topic`. */
	readonly gapId:   string | null;
	readonly verdict: ClosureVerdict;
}

/**
 * Scan a goal-aware summary string for closure markers. The
 * vocabulary is fixed; multiple markers per summary chained with
 * `;` are allowed. Unknown gap-ids are dropped (logged) so
 * fabricated coverage claims never reach the convergence logic.
 *
 * Returns each match as a `ClosureClaim` with `gapId` non-null for
 * `closes-fully` / `partial` and null for `off-topic`.
 */
export function scanClosureMarkers(
	summary: string,
	stepId:  string,
	callId:  string,
	gapIds:  ReadonlySet<string>,
): readonly ClosureClaim[] {
	const out: ClosureClaim[] = [];
	const reCloses   = /CLOSES\s+([A-Za-z0-9_.-]+)\s+fully/gi;
	const rePartial  = /PARTIALLY\s+supports\s+([A-Za-z0-9_.-]+)/gi;
	const reOffTopic = /OFF[\s-]TOPIC/gi;
	let touched = false;
	for (let m: RegExpExecArray | null = reCloses.exec(summary); m !== null; m = reCloses.exec(summary)) {
		const gapId = normaliseGapId(m[1] ?? '');
		if (!gapIds.has(gapId)) {
			log.warn({ stepId, callId, gapId }, 'convergence: CLOSES marker references unknown gap-id; dropping');
			continue;
		}
		out.push({ stepId, callId, gapId, verdict: 'closes-fully' });
		touched = true;
	}
	for (let m: RegExpExecArray | null = rePartial.exec(summary); m !== null; m = rePartial.exec(summary)) {
		const gapId = normaliseGapId(m[1] ?? '');
		if (!gapIds.has(gapId)) {
			log.warn({ stepId, callId, gapId }, 'convergence: PARTIALLY marker references unknown gap-id; dropping');
			continue;
		}
		out.push({ stepId, callId, gapId, verdict: 'partial' });
		touched = true;
	}
	if (reOffTopic.test(summary)) {
		out.push({ stepId, callId, gapId: null, verdict: 'off-topic' });
		touched = true;
	}
	if (!touched) {
		log.warn({ stepId, callId, summary: summary.slice(0, 80) }, 'convergence: summary entry has no recognised closure marker');
	}
	return out;
}

/**
 * Strip trailing sentence-ending punctuation from a captured gap-id.
 * The regex `[A-Za-z0-9_.-]+` includes `.` because some gap-ids
 * legitimately contain dots (e.g. `foo.bar`), but greedy capture
 * swallows the sentence-ending period when the marker sits at the end
 * of a clause: `"PARTIALLY supports my-gap."` captures `my-gap.` and
 * the validator drops it as unknown.
 *
 * Live test caught this firing dozens of times across one run. The
 * fix is to trim trailing `.`, `,`, `;`, `:`, `!`, `?` after capture.
 */
function normaliseGapId(raw: string): string {
	return raw.replace(/[.,;:!?]+$/, '');
}

/**
 * Convenience: scan a `{ stepId: { callId: summary } }` shape and
 * return every closure claim found across all entries. Used by the
 * orchestrator when a fresh batch of decide-next-step summaries
 * lands.
 */
export function scanAllClosureMarkers(
	summaries: Readonly<Record<string, Readonly<Record<string, string>>>>,
	gapIds:    ReadonlySet<string>,
): readonly ClosureClaim[] {
	const all: ClosureClaim[] = [];
	for (const [stepId, callMap] of Object.entries(summaries)) {
		for (const [callId, summary] of Object.entries(callMap)) {
			for (const claim of scanClosureMarkers(summary, stepId, callId, gapIds)) {
				all.push(claim);
			}
		}
	}
	return all;
}

// ---------------------------------------------------------------------------
// Coverage check (signal 1)
// ---------------------------------------------------------------------------

export type CoverageStatus = 'covered' | 'partial' | 'open';

export interface GapCoverage {
	readonly gapId:  string;
	readonly status: CoverageStatus;
	/** Distinct (stepId, callId) pairs whose summary marked this gap. Closer-rank markers preferred. */
	readonly contributingCalls: readonly { readonly stepId: string; readonly callId: string }[];
}

export interface CoverageReport {
	readonly perGap:    readonly GapCoverage[];
	readonly allClosed: boolean;
}

/**
 * Compute per-gap coverage from a list of accepted closure claims.
 * A gap is `covered` if any claim carries verdict=`closes-fully`;
 * `partial` if only `partial` claims are present; `open` otherwise
 * (no claim or only `off-topic`).
 *
 * `allClosed` is true exactly when every gap-id in the active list
 * has at least one `closes-fully` claim.
 */
export function computeCoverage(
	gapIds: readonly string[],
	claims: readonly ClosureClaim[],
): CoverageReport {
	const byGap = new Map<string, ClosureClaim[]>();
	for (const id of gapIds) { byGap.set(id, []); }
	for (const c of claims) {
		if (c.gapId === null) { continue; }
		const bucket = byGap.get(c.gapId);
		if (bucket !== undefined) { bucket.push(c); }
	}
	const perGap: GapCoverage[] = [];
	let allClosed = true;
	for (const id of gapIds) {
		const bucket = byGap.get(id) ?? [];
		const closes = bucket.filter(c => c.verdict === 'closes-fully');
		const partials = bucket.filter(c => c.verdict === 'partial');
		let status: CoverageStatus;
		if (closes.length > 0) {
			status = 'covered';
		} else if (partials.length > 0) {
			status = 'partial';
		} else {
			status = 'open';
		}
		if (status !== 'covered') { allClosed = false; }
		const contributingCalls = (closes.length > 0 ? closes : partials).map(c => ({ stepId: c.stepId, callId: c.callId }));
		perGap.push({ gapId: id, status, contributingCalls });
	}
	return { perGap, allClosed };
}

// ---------------------------------------------------------------------------
// No-progress accounting (signal 2)
// ---------------------------------------------------------------------------

/**
 * A step "contributes evidence" iff at least one of its goal-aware
 * summaries carries a `CLOSES` or `PARTIALLY supports` marker.
 * `OFF-TOPIC` and no-marker summaries DON'T count -- they leave the
 * coverage map untouched.
 *
 * The orchestrator increments `noProgressCount` after every step that
 * doesn't contribute; resets it after every step that does. When the
 * count reaches `noProgressBudget` (default 3), the loop terminates
 * with `verdict: 'unrecoverable'`.
 */
export function stepContributedEvidence(claims: readonly ClosureClaim[]): boolean {
	return claims.some(c => c.verdict === 'closes-fully' || c.verdict === 'partial');
}
