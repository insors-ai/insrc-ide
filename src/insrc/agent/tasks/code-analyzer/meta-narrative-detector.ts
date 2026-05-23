/**
 * Phase 10.A.1 of plans/code-analyzer-hallucination-mitigation.md.
 *
 * Regex tripwire that fires when the writer emits "gather phase did
 * not reach X" style meta-narration paragraphs. The writer prompts
 * (Phase 10.A) tell the model to omit such paragraphs entirely; this
 * is the safety net that catches when the model violates that rule.
 *
 * This is a DETECTOR, not a FENCE: a hit triggers redraft (so the
 * model can salvage real content), not silent stripping. The patterns
 * are an evolving list -- expected to grow as new boilerplate
 * templates emerge from model swaps. Add new patterns to
 * `META_NARRATIVE_PATTERNS` below as they're observed in live runs.
 */

const log_module = 'code-analyzer:meta-narrative-detector';

/**
 * Patterns observed in live runs as the writer's "gap apology" /
 * "process narration" boilerplate. Each pattern targets the
 * *shape* of meta-narration (talking about the analysis process
 * itself), not a single phrase. False-positive rate stays low because
 * legitimate code-analysis prose doesn't describe the analysis
 * tooling itself.
 *
 * Patterns must match a *paragraph shape*, not a bare keyword --
 * legitimate prose may mention "gather" or "evidence" as nouns; the
 * patterns require a verb context that indicates meta-narration.
 */
export const META_NARRATIVE_PATTERNS: readonly RegExp[] = [
	// "the gather phase opened/surveyed/scanned ... but/and did not reach/cover/surface ..."
	/the gather phase\s+(only\s+)?(opened|scanned|surveyed|examined|covered)[^.\n]*?(but|and|though)?\s*did not (reach|surface|enter|cover|examine|extend)/i,
	// "did not reach the ... layer/subsystem" -- the canonical "blame the index" pattern
	/did not (reach|surface|enter|cover) the [^.\n]{0,60}?(layer|subsystem|module|component|level)/i,
	// "the available evidence does not surface/cover ... [topic]"
	/the available evidence does not (surface|cover|include|extend to)/i,
	// Closing apology variants: "this is a gap in the section, not a claim about the codebase"
	/this is a gap in the section,?\s*not a claim about the codebase/i,
	// "no [X] (were|was) found/located/surfaced/identified in the index" -- meta-statement
	// about what the indexer/gather phase did not surface
	/\b(no|nothing|none)\b[^.\n]{0,60}?(were|was)?\s*(found|located|surfaced|identified) in the index/i,
	// "the gather phase only opened/reached/touched the top-level ..."
	/the gather phase only\s+(opened|reached|touched|surveyed|examined)/i,
	// Inverted form: "evidence did not extend to ..." / "evidence was not gathered ..."
	/evidence (was not|did not) (gather|surfac|captur|reach|extend|cover)/i,
];

export interface MetaNarrativeHit {
	readonly pattern: string;
	/** The matched substring + ~40 chars of trailing context, to surface to the redraft prompt. */
	readonly excerpt: string;
}

export interface MetaNarrativeResult {
	readonly hit:     boolean;
	readonly matches: readonly MetaNarrativeHit[];
}

/**
 * Scan prose for meta-narrative patterns. Returns the first ~3
 * matches with excerpts (enough to feed to the redraft prompt
 * without bloating notes[]).
 */
export function detectMetaNarrative(prose: string): MetaNarrativeResult {
	if (typeof prose !== 'string' || prose.length === 0) {
		return { hit: false, matches: [] };
	}
	const matches: MetaNarrativeHit[] = [];
	for (const re of META_NARRATIVE_PATTERNS) {
		const m = re.exec(prose);
		if (m !== null && m.index !== undefined) {
			const start = Math.max(0, m.index - 10);
			const end = Math.min(prose.length, m.index + m[0].length + 40);
			const excerpt = prose.slice(start, end).replace(/\s+/g, ' ').trim();
			matches.push({ pattern: re.source, excerpt });
			if (matches.length >= 3) break;
		}
	}
	return { hit: matches.length > 0, matches };
}

/**
 * Render the detector's hits as a list of `notes` lines for the
 * redraft prompt. Stable shape, easy to extend.
 */
export function formatMetaNarrativeNotes(result: MetaNarrativeResult): string[] {
	if (!result.hit) return [];
	const out: string[] = [];
	out.push(
		'Meta-narrative paragraphs detected in your prior draft. The rule is OMIT paragraphs you have no evidence for -- do NOT write apology paragraphs about what the gather phase did or didn\'t reach. Rewrite without these paragraphs:',
	);
	for (const m of result.matches) {
		out.push(`  - "${m.excerpt}..."`);
	}
	return out;
}

// Module-level export for downstream logging tag (kept here for parity with the
// rest of the code-analyzer modules' logger-tag convention).
export const META_NARRATIVE_LOG_MODULE = log_module;
