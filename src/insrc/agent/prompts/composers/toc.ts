/**
 * Render the artifact-store Table of Contents (TOC) as a prompt
 * block. The TOC is the LLM's index into the persisted artifact
 * store -- each row carries an artifact id + its claim-shaped
 * goal-aware summary (see Phase 1 of
 * `plans/section-flow-architecture-redesign.md`).
 *
 * Phase 0 ships a minimal stub: just the data shape + a default
 * renderer. Phase 1 wires it to the actual artifact store and
 * adds the closure-marker rendering. Build-context (Phase 3) and
 * decide-next-step (Phase 4) become the primary consumers.
 *
 * Token budget: the TOC is bounded by truncating oldest-first when
 * the rendered size exceeds `maxTokens`. Truncated artifacts remain
 * on disk and reachable via `shared.memory.get-artifact({id})` even
 * when they don't appear in the TOC block.
 */

export interface TocEntry {
	readonly id:      string;       // "art-<8-char-hex>"
	readonly summary: string;       // 128 tokens, claim-shaped + closure markers
}

export interface Toc {
	readonly entries: readonly TocEntry[];
}

export interface RenderTocOpts {
	/** Soft budget in characters (rough chars-per-token ratio = 3). */
	readonly maxChars?: number | undefined;
}

const DEFAULT_MAX_CHARS = 18_000;   // ~6k tokens at the default chars-per-token=3
const HEADER = '## TABLE OF CONTENTS (artifacts available; call shared.memory.get-artifact({id}) to fetch)';

export function renderToc(toc: Toc, opts?: RenderTocOpts): string {
	if (toc.entries.length === 0) {
		return `${HEADER}\n(no artifacts persisted yet)`;
	}
	const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
	const lines: string[] = [HEADER, ''];

	// `toc.entries` is already newest-first (see
	// `agent/artifacts/toc-builder.ts` -- `listArtifactsForSession`
	// sorts by timestamp DESC). Iterate as-is: the model sees the
	// most-recent artifacts up top, and when the budget hits we stop
	// adding lines, dropping OLDEST entries (which sit at the end).
	let chars = lines.join('\n').length;
	let renderedCount = 0;
	for (const e of toc.entries) {
		const line = `${e.id}: ${e.summary}`;
		if (chars + line.length + 1 > maxChars) {
			break;
		}
		lines.push(line);
		chars += line.length + 1;
		renderedCount += 1;
	}
	const truncatedCount = toc.entries.length - renderedCount;
	if (truncatedCount > 0) {
		lines.push('');
		lines.push(`(${truncatedCount} older artifacts omitted from TOC; still fetchable by id via shared.memory.get-artifact)`);
	}
	return lines.join('\n');
}
