/**
 * shared.fs.peek -- bounded read of a file's content (head or tail).
 *
 * Phase 1 of plans/shared-fs-skills-and-namespace-cleanup.md.
 *
 * The Code Knowledge Graph indexes *code* entities. Ad-hoc files --
 * JSON fixtures, config files, READMEs, sample CSV headers, log
 * snippets -- are not indexed, and the planner has no skill to
 * inspect them. Today's workaround chains 3-4 `data.source.file.*`
 * calls just to ground "what does this JSON file look like." Most of
 * those don't return content, they return shape or row samples.
 *
 * This skill gives a bounded peek. Two caps:
 *   - `lines` (default 50)
 *   - `bytes` (default 8192)
 * Whichever cap hits first wins. The pair prevents both
 *   (a) a 1 MB single-line minified JSON ballooning the LLM context, and
 *   (b) a 200-line log file pulled in 50 lines at a time.
 *
 * Binary files are detected and reported via `encoding: 'binary'` with
 * no decoded content -- the planner shouldn't be reading raw bytes.
 *
 * `head: true` (default) reads from the start; `head: false` reads the
 * tail. Useful for log files where the recent entries are at the end.
 */

import { open, stat } from 'node:fs/promises';
import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PeekInput {
	readonly path:    string;
	readonly head?:   boolean;
	readonly lines?:  number;
	readonly bytes?:  number;
}

interface PeekOutput {
	readonly content:     string;
	readonly truncated:   boolean;
	readonly totalBytes:  number;
	readonly totalLines?: number;
	readonly encoding:    'utf-8' | 'binary';
}

// ---------------------------------------------------------------------------
// Bounds + defaults
// ---------------------------------------------------------------------------

const DEFAULT_LINES = 50;
const MAX_LINES     = 500;
const DEFAULT_BYTES = 8192;
const MAX_BYTES     = 65_536;
const PROBE_BYTES   = 1024;   // bytes inspected for binary detection

// ---------------------------------------------------------------------------
// Skill definition
// ---------------------------------------------------------------------------

const sharedFsPeekSkill: Skill<PeekInput, PeekOutput> = {
	id: 'shared.fs.peek',
	name: 'Filesystem: bounded read of a file',
	description:
		'Read a bounded slice of a file -- first or last N lines, up to a byte cap. ' +
		'Defaults to head:true, lines:50, bytes:8192 (8 KB). Whichever cap hits ' +
		'first wins. Returns `content` (UTF-8 text), `truncated`, `totalBytes`, ' +
		'and `encoding` ("binary" for non-text files; content omitted). Use this ' +
		'to ground ad-hoc files the graph does NOT index: JSON fixtures, configs, ' +
		'READMEs, CSV headers, log snippets. NOT for code source -- the entity ' +
		'graph has typed views on top of source files.',
	family: 'source-introspection',
	owner: 'shared',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			path:  { type: 'string',  description: 'Absolute file path.' },
			head:  { type: 'boolean', description: 'Read from the start (true, default) or the end (false).' },
			lines: { type: 'number',  description: `Cap on lines returned. Default ${DEFAULT_LINES}, max ${MAX_LINES}.`, minimum: 1, maximum: MAX_LINES },
			bytes: { type: 'number',  description: `Hard cap on bytes read. Default ${DEFAULT_BYTES}, max ${MAX_BYTES}.`, minimum: 1, maximum: MAX_BYTES },
		},
		required: ['path'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			content:    { type: 'string'  },
			truncated:  { type: 'boolean' },
			totalBytes: { type: 'number'  },
			totalLines: { type: 'number'  },
			encoding:   { type: 'string', enum: ['utf-8', 'binary'] },
		},
		required: ['content', 'truncated', 'totalBytes', 'encoding'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: PeekInput, _deps: SkillDeps): Promise<SkillResult<PeekOutput>> {
		if (!input.path.startsWith('/')) {
			return rejectInvalid('path must be an absolute filesystem path');
		}

		let totalBytes: number;
		try {
			const s = await stat(input.path);
			if (!s.isFile()) {
				return rejectInvalid(`path is not a regular file: ${input.path}`);
			}
			totalBytes = s.size;
		} catch (err) {
			return rejectInvalid(`stat failed: ${(err as Error).message}`);
		}

		const lineCap  = clampLines(input.lines);
		const byteCap  = clampBytes(input.bytes);
		const head     = input.head !== false;   // default true

		// Open once; use the same handle for probe + content read.
		const handle = await open(input.path, 'r');
		try {
			// Binary probe: read up to PROBE_BYTES from the start and test for
			// NULs / high non-printable density.
			const probeLen = Math.min(PROBE_BYTES, totalBytes);
			const probe = Buffer.alloc(probeLen);
			await handle.read(probe, 0, probeLen, 0);
			if (looksBinary(probe)) {
				return {
					value: {
						content:    '',
						truncated:  true,
						totalBytes,
						encoding:   'binary',
					},
					confidence: 'medium',
					notes:      ['file looks binary; content omitted'],
					toolCalls:  [],
				};
			}

			// Text path: read up to byteCap from head or tail.
			const readLen  = Math.min(byteCap, totalBytes);
			const position = head ? 0 : Math.max(0, totalBytes - readLen);
			const buf      = Buffer.alloc(readLen);
			await handle.read(buf, 0, readLen, position);
			const raw = buf.toString('utf8');

			// Apply line cap.
			const allLines = raw.split('\n');
			let kept: string[];
			let lineCapHit: boolean;
			if (head) {
				kept = allLines.slice(0, lineCap);
				lineCapHit = allLines.length > lineCap;
			} else {
				kept = allLines.slice(Math.max(0, allLines.length - lineCap));
				lineCapHit = allLines.length > lineCap;
			}
			const content = kept.join('\n');

			// Truncated if EITHER cap hit, OR if we didn't read the full file.
			const byteCapHit = readLen < totalBytes;
			const truncated  = byteCapHit || lineCapHit;

			// totalLines only meaningful when we read the whole file -- otherwise
			// we'd be guessing from a partial window.
			const totalLines = byteCapHit ? undefined : allLines.length;

			const value: PeekOutput = totalLines !== undefined
				? { content, truncated, totalBytes, totalLines, encoding: 'utf-8' }
				: { content, truncated, totalBytes,             encoding: 'utf-8' };

			return {
				value,
				confidence: 'high',
				notes:      truncated ? [`truncated (line cap hit: ${lineCapHit}, byte cap hit: ${byteCapHit})`] : [],
				toolCalls:  [],
			};
		} finally {
			await handle.close();
		}
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLines(requested: number | undefined): number {
	if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
		return DEFAULT_LINES;
	}
	return Math.min(Math.floor(requested), MAX_LINES);
}

function clampBytes(requested: number | undefined): number {
	if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
		return DEFAULT_BYTES;
	}
	return Math.min(Math.floor(requested), MAX_BYTES);
}

/**
 * Detect binary files. Two signals:
 *
 *   1. Any NUL byte in the probe -- text files almost never contain NUL.
 *   2. >30% of bytes outside the printable ASCII + common control range
 *      (TAB / LF / CR). Catches files that decode as UTF-8 garbage but
 *      aren't actually text.
 *
 * Doesn't try to be precise; the planner has bigger problems if it asks
 * for content of a binary file.
 */
export function looksBinary(probe: Buffer): boolean {
	if (probe.length === 0) { return false; }
	let nonPrintable = 0;
	for (let i = 0; i < probe.length; i++) {
		const b = probe[i]!;
		if (b === 0) { return true; }
		const printable =
			(b >= 0x20 && b <= 0x7e) ||   // ASCII printable
			b === 0x09 || b === 0x0a || b === 0x0d ||   // TAB, LF, CR
			b >= 0x80;   // assume high bytes are utf-8 continuation; cheap heuristic
		if (!printable) { nonPrintable++; }
	}
	return nonPrintable / probe.length > 0.3;
}

function rejectInvalid(reason: string): SkillResult<PeekOutput> {
	return {
		value:      { content: '', truncated: false, totalBytes: 0, encoding: 'utf-8' },
		confidence: 'low',
		notes:      [reason],
		toolCalls:  [],
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSharedFsPeekSkill(): void {
	registerSkill(sharedFsPeekSkill as unknown as Skill);
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _clampLinesForTest = clampLines;
export const _clampBytesForTest = clampBytes;
export const _looksBinaryForTest = looksBinary;
