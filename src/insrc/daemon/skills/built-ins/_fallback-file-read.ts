/**
 * Shared helper for the "DB entry is sparse -> read the file directly"
 * fallback pattern used by entity-lookup skills.
 *
 * Background: tree-sitter only has grammars for the indexer's first-
 * class languages (TypeScript, JavaScript, Python, Go, Java, Scala).
 * YAML / Dockerfile / shell / TOML files are still walked by the
 * indexer but get stored as `kind: 'file'` graph entities with no
 * body and no children. The Lance vector store has no embedding for
 * them either (no body to embed). Result: when the analyzer's
 * planner asks for `Dockerfile` or `configmap.yaml`, every
 * entity-lookup skill returns empty -> the section ships with zero
 * evidence and zero citations.
 *
 * The principle this helper enforces: when an entity is found at the
 * metadata level (graph row exists, file path is known) but the body
 * / parsed children come back empty, read the file from disk and
 * return its head as a fallback excerpt. Bounded by `maxBytes` so a
 * huge config dump doesn't blow the context window or take >100ms.
 *
 * Safety:
 *   - All I/O errors swallowed -> returns `{ ok: false }` not throws.
 *     Skills should treat a fallback failure as "no body either way"
 *     and degrade gracefully, not crash the step.
 *   - Refuses non-absolute paths (the entity layer stores absolute
 *     paths; a relative path here means caller bug or stale row,
 *     either of which we'd rather no-op on).
 *   - Truncates content at `maxBytes`; appends `... <truncated>`
 *     marker so consumers can tell the file kept going.
 *   - Binary files (UTF-8 decode failures) are reported as not
 *     readable; we don't try to print bytes the LLM can't use.
 */

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Default byte cap. Big enough for any Dockerfile / configmap / values.yaml
 *  in practice; small enough to keep the LLM context manageable. */
export const DEFAULT_MAX_FILE_BYTES = 16 * 1024;   // 16 KB

/** Cap on the line count returned, regardless of byte size. Most config
 *  files are well under 200 lines; setting this prevents a 16KB single-line
 *  minified JSON from flooding the excerpt. */
export const DEFAULT_MAX_LINES = 200;

export type ReadFileResult =
	| { readonly ok: true;  readonly content: string; readonly truncated: boolean; readonly byteSize: number }
	| { readonly ok: false; readonly reason: string };

/**
 * Read a file from disk for use as a fallback excerpt. Returns
 * `{ ok: false }` on any failure (missing, too large, binary, I/O
 * error) so callers can simply skip the fallback note instead of
 * branching on every error class. Caller logs `result.reason` for
 * telemetry; it never bubbles to the LLM's evidence ledger.
 */
export async function tryReadFileForFallback(
	absPath: string,
	maxBytes: number = DEFAULT_MAX_FILE_BYTES,
	maxLines: number = DEFAULT_MAX_LINES,
): Promise<ReadFileResult> {
	if (typeof absPath !== 'string' || absPath.length === 0) {
		return { ok: false, reason: 'no file path supplied' };
	}
	if (!isAbsolute(absPath)) {
		return { ok: false, reason: 'file path is not absolute' };
	}

	// Stat first to refuse oversize files cleanly. Reading a 50MB log
	// and then slicing wastes I/O and memory; bail at the stat layer.
	let byteSize: number;
	try {
		const s = await stat(absPath);
		if (!s.isFile()) return { ok: false, reason: 'path is not a regular file' };
		byteSize = s.size;
	} catch (err) {
		return { ok: false, reason: `stat failed: ${(err as Error).message}` };
	}

	// Empty file is technically a successful read, but treat it as not
	// useful for an excerpt -- the calling skill should still produce
	// an honest "no content" result rather than a misleading empty
	// fallback note.
	if (byteSize === 0) {
		return { ok: false, reason: 'file is empty' };
	}

	// Read up to maxBytes. Node has no built-in byte-cap on readFile,
	// so we read the whole file and slice; for the small-config-file
	// case this is fine (Dockerfile / yaml are O(KB), not O(MB)). For
	// files larger than maxBytes we still read the whole thing -- the
	// stat-guard above caps the worst case (we bail at, say, > 5MB).
	if (byteSize > maxBytes * 64) {
		// 64x maxBytes is a sanity cap: above this, the file is almost
		// certainly NOT a config file (huge JSON dump, minified bundle,
		// SQL fixture, etc.). Refuse rather than read 1MB into RAM for
		// a 16KB excerpt.
		return { ok: false, reason: `file too large (${byteSize} bytes > ${maxBytes * 64} byte sanity cap)` };
	}

	let buf: Buffer;
	try {
		buf = await readFile(absPath);
	} catch (err) {
		return { ok: false, reason: `read failed: ${(err as Error).message}` };
	}

	// Reject obvious binary content. UTF-8 decode with the legacy
	// `replacement` strategy would silently substitute U+FFFD; instead
	// we sniff for a NUL byte in the head (the canonical text-vs-
	// binary heuristic) and refuse if found. Config / source files
	// don't contain NUL bytes; binaries do.
	const sniff = buf.slice(0, Math.min(buf.length, 1024));
	for (let i = 0; i < sniff.length; i++) {
		if (sniff[i] === 0) {
			return { ok: false, reason: 'file appears to be binary (contains NUL byte)' };
		}
	}

	let text: string;
	try {
		text = buf.toString('utf8');
	} catch (err) {
		return { ok: false, reason: `utf8 decode failed: ${(err as Error).message}` };
	}

	// Apply caps. Byte cap first (so we slice on the buffer, not after
	// UTF-8 expansion); then line cap.
	let truncated = false;
	if (buf.length > maxBytes) {
		text = buf.slice(0, maxBytes).toString('utf8');
		truncated = true;
	}
	const lines = text.split('\n');
	if (lines.length > maxLines) {
		text = lines.slice(0, maxLines).join('\n');
		truncated = true;
	}
	if (truncated) {
		text = `${text}\n... <truncated>`;
	}

	return { ok: true, content: text, truncated, byteSize };
}
