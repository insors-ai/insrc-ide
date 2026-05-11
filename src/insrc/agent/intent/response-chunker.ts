/**
 * Split an assistant response into semantic chunks for per-segment
 * retrieval (Phase 2 of plans/intent-classification-consolidation.md).
 *
 * Why chunk: the intent classifier's memory needs to retrieve the
 * specific paragraph in a prior assistant response that mentions the
 * entity the user is now asking about, NOT the entire reply (which
 * smears the embedding signal AND blows out the classifier prompt).
 * One row per chunk, embedded independently, lets ANN pinpoint the
 * relevant excerpt.
 *
 * Splitting strategy (highest-priority boundary wins):
 *   1. Markdown headings (`## ` / `### ` / `#### `) -- a heading
 *      starts a new chunk. The classifier's retrieval almost always
 *      follows the heading structure of structured analysis reports
 *      ("HDFS Core", "NameNode HA", etc.).
 *   2. Blank-line paragraph boundaries inside a heading section.
 *   3. Token-budget cap (`maxCharsPerChunk`) -- if a paragraph alone
 *      exceeds the cap, we still emit it as one chunk. We do NOT
 *      hard-split mid-paragraph because that produces semantically
 *      meaningless fragments. Oversized chunks just take a small
 *      hit on embedding precision; they remain a single ANN hit.
 *
 * Tail coalescing: chunks smaller than `minCharsPerChunk` get folded
 * into the PREVIOUS chunk so we don't pollute the table with
 * 30-char "Done." footers. The first chunk is exempt (nothing to
 * fold into).
 *
 * Stable indices: chunks are emitted in document order and assigned
 * `idx = 0, 1, 2, ...` based on that order. The same input always
 * produces the same `(idx, text)` pairs -- this is what lets the
 * indexing hook upsert by `${turnId}:${segmentIdx}` and overwrite
 * stale rows when a turn gets recompacted.
 */

export interface ResponseChunk {
	readonly idx:  number;
	readonly text: string;
}

export interface ChunkResponseOpts {
	readonly maxCharsPerChunk?: number;
	readonly minCharsPerChunk?: number;
}

const DEFAULT_MAX_CHARS = 1_500;
const DEFAULT_MIN_CHARS = 200;

const HEADING_LINE = /^(#{2,4})\s+\S/;

export function chunkResponseForRetrieval(
	text: string,
	opts?: ChunkResponseOpts,
): readonly ResponseChunk[] {
	const max = opts?.maxCharsPerChunk ?? DEFAULT_MAX_CHARS;
	const min = opts?.minCharsPerChunk ?? DEFAULT_MIN_CHARS;

	const trimmed = text.trim();
	if (trimmed.length === 0) return [];
	if (trimmed.length <= max) {
		// Whole response fits in one chunk -- no splitting work to do.
		return [{ idx: 0, text: trimmed }];
	}

	// Pass 1: split on heading boundaries.
	const headingSections = splitOnHeadings(trimmed);

	// Pass 2: within each heading section, collapse blank-line
	// paragraphs into chunks, capping at `max` chars.
	const rawChunks: string[] = [];
	for (const section of headingSections) {
		rawChunks.push(...packParagraphsIntoChunks(section, max));
	}

	// Pass 3: coalesce tail chunks that are too small to be useful.
	const coalesced = coalesceShortChunks(rawChunks, min);

	// Pass 4: assign stable indices.
	return coalesced.map((t, i) => ({ idx: i, text: t }));
}

// ---------------------------------------------------------------------------
// Pass 1: heading splits
// ---------------------------------------------------------------------------

function splitOnHeadings(text: string): readonly string[] {
	const lines = text.split(/\r?\n/);
	const sections: string[] = [];
	let buffer: string[] = [];

	for (const line of lines) {
		if (HEADING_LINE.test(line) && buffer.length > 0) {
			sections.push(buffer.join('\n').trim());
			buffer = [];
		}
		buffer.push(line);
	}
	if (buffer.length > 0) {
		const tail = buffer.join('\n').trim();
		if (tail.length > 0) sections.push(tail);
	}
	return sections.length > 0 ? sections : [text];
}

// ---------------------------------------------------------------------------
// Pass 2: paragraph packing inside one heading section
// ---------------------------------------------------------------------------

function packParagraphsIntoChunks(section: string, maxChars: number): readonly string[] {
	if (section.length <= maxChars) return [section];

	// Split on blank-line boundaries -- preserves the heading line
	// (always paragraph 0) so the first chunk always carries it.
	const paragraphs = section.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
	if (paragraphs.length === 1) {
		// No blank-line boundary inside an oversized section. We do
		// NOT mid-split a paragraph (see top-of-file rationale); emit
		// it as one oversized chunk.
		return [section];
	}

	const chunks: string[] = [];
	let current = '';
	for (const para of paragraphs) {
		if (current.length === 0) {
			current = para;
			continue;
		}
		// `+2` accounts for the blank-line separator we'll re-insert.
		if (current.length + para.length + 2 <= maxChars) {
			current = `${current}\n\n${para}`;
		} else {
			chunks.push(current);
			current = para;
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

// ---------------------------------------------------------------------------
// Pass 3: tail coalescing
// ---------------------------------------------------------------------------

function coalesceShortChunks(chunks: readonly string[], minChars: number): readonly string[] {
	if (chunks.length <= 1) return chunks;

	const out: string[] = [chunks[0]!];
	for (let i = 1; i < chunks.length; i++) {
		const c = chunks[i]!;
		if (c.length < minChars) {
			// Fold into the previous chunk.
			out[out.length - 1] = `${out[out.length - 1]!}\n\n${c}`;
		} else {
			out.push(c);
		}
	}
	return out;
}
