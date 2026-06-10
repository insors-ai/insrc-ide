/**
 * Per-TODO Table-of-Contents builder over `artifact_vec`
 * (Phase 1 of `plans/section-flow-architecture-redesign.md`).
 *
 * Reads spilled artifacts for the current session (optionally
 * bounded by a "since" timestamp) and returns `TocEntry[]` ready
 * for the existing renderer at
 * `agent/prompts/composers/toc.ts`.
 *
 * Two important details:
 *
 *   1. Newest-first. The most-recently-spilled artifact shows up
 *      first so the LLM's recency-weighted attention catches it.
 *
 *   2. Empty summaries become a structural fallback. A row whose
 *      reviewer-emitted summary hasn't landed yet (or was never
 *      emitted at all -- e.g. the spill happened mid-cycle and the
 *      review hasn't run) gets a deterministic
 *      "<skillId> output: <first 80 chars of preview>" so the TOC
 *      still has a usable entry.
 *
 * The composer (toc.ts) handles its own byte-budget trimming; this
 * builder doesn't enforce a cap.
 */

import { listArtifactsForSession } from '../../db/lance/artifact-vec.js';
import type { Toc, TocEntry } from '../prompts/composers/toc.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildTocInput {
	readonly sessionId:        string;
	/** Optional skill-id prefix filter. */
	readonly skillIdPrefix?:   string | undefined;
	/** Only include artifacts spilled AFTER this timestamp (ms). */
	readonly afterTimestamp?:  bigint | undefined;
	/** Cap on artifacts pulled from the store. The composer further trims
	 *  for budget; this is a defense against pathologically long TODO runs. */
	readonly maxArtifacts?:    number | undefined;
}

const DEFAULT_MAX_ARTIFACTS = 200;
const STRUCTURAL_PREVIEW_CHARS = 80;

export async function buildToc(input: BuildTocInput): Promise<Toc> {
	const rows = await listArtifactsForSession({
		sessionId:      input.sessionId,
		skillIdPrefix:  input.skillIdPrefix,
		afterTimestamp: input.afterTimestamp,
		limit:          input.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS,
	});
	const entries: TocEntry[] = rows.map(r => ({
		id:      r.id,
		summary: r.summary.length > 0 ? r.summary : structuralSummary(r.skill_id, r.preview),
	}));
	return { entries };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic fallback summary used when the reviewer hasn't yet
 * emitted a goal-aware summary for an artifact. Matches the shape
 * the plan calls for (`"<skillId> output: <first 80 chars>"`).
 */
export function structuralSummary(skillId: string, preview: string): string {
	const clean = preview.trim().replace(/\s+/g, ' ');
	const head  = clean.slice(0, STRUCTURAL_PREVIEW_CHARS);
	const tail  = clean.length > STRUCTURAL_PREVIEW_CHARS ? '...' : '';
	return `${skillId} output: ${head}${tail}`;
}
