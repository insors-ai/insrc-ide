/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * On-disk persistence for working-memory entries
 * (planner-section-task-separation P1.b).
 *
 * File layout under the per-report-run directory:
 *
 *   <runDir>/
 *     0000-<todoSlug>.md
 *     0001-<todoSlug>.md
 *     ...
 *
 * Each entry file is:
 *
 *   ```
 *   <one-line minified JSON metadata block>
 *   ---working-memory-entry-body---
 *
 *   <section markdown>
 *   ```
 *
 * Write atomicity is achieved via `writeFile(tmp) + rename(tmp, final)`.
 * On POSIX `rename(2)` is atomic when both paths live on the same
 * filesystem, which they always do here (same runDir). Q9: a crash mid-
 * write leaves no half-written entry visible.
 */

import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
	WorkingMemoryEntry,
	WorkingMemoryEntryMetadata,
} from './types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('working-memory-store');

const BODY_SENTINEL = '---working-memory-entry-body---';
const FILENAME_PATTERN = /^(\d{4})-([A-Za-z0-9._-]+)\.md$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ListedEntry {
	readonly index: number;
	readonly entry: WorkingMemoryEntry;
}

export class WorkingMemoryStore {
	/**
	 * @param runDir Absolute path to the per-report-run directory. Created
	 *               lazily on first write. Caller owns the directory's
	 *               lifecycle (see PATHS.workingMemoryRun).
	 */
	constructor(public readonly runDir: string) {}

	/**
	 * Atomically write the entry at the given zero-based TODO index.
	 * Overwrites any existing entry at that index (re-runs after a
	 * mid-TODO crash overwrite the partial in-flight entry).
	 */
	async write(index: number, entry: WorkingMemoryEntry): Promise<void> {
		await fsp.mkdir(this.runDir, { recursive: true });
		const finalPath = join(this.runDir, filenameFor(index, entry.todoId));
		const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
		const serialised = serialiseEntry(entry);
		await fsp.writeFile(tmpPath, serialised, { encoding: 'utf8', mode: 0o644 });
		await fsp.rename(tmpPath, finalPath);
		log.debug({ index, todoId: entry.todoId, path: finalPath }, 'working-memory entry written');
	}

	/**
	 * Read the entry at `index`. Returns `undefined` if no entry exists
	 * (or the directory itself doesn't exist yet). Throws if the entry
	 * file is present but malformed -- callers treat that as
	 * unrecoverable per Q9's failure classification.
	 */
	async read(index: number): Promise<WorkingMemoryEntry | undefined> {
		const filename = await this.findFilenameForIndex(index);
		if (filename === undefined) {
			return undefined;
		}
		const raw = await fsp.readFile(join(this.runDir, filename), 'utf8');
		return parseEntry(raw);
	}

	async hasEntry(index: number): Promise<boolean> {
		const filename = await this.findFilenameForIndex(index);
		return filename !== undefined;
	}

	/**
	 * Lists every entry in the run, ordered by index ascending. Used by
	 * the shape-the-memory step (P1.c) to concatenate the working-memory
	 * text. Skips files that don't match the entry filename pattern.
	 */
	async listEntries(): Promise<readonly ListedEntry[]> {
		let names: string[];
		try {
			names = await fsp.readdir(this.runDir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw err;
		}
		const ordered: Array<{ index: number; filename: string }> = [];
		for (const name of names) {
			const m = name.match(FILENAME_PATTERN);
			if (m === null) {
				continue;
			}
			ordered.push({ index: parseInt(m[1]!, 10), filename: name });
		}
		ordered.sort((a, b) => a.index - b.index);
		const out: ListedEntry[] = [];
		for (const { index, filename } of ordered) {
			const raw = await fsp.readFile(join(this.runDir, filename), 'utf8');
			out.push({ index, entry: parseEntry(raw) });
		}
		return out;
	}

	/**
	 * Returns the concatenated detail markdown across every entry in
	 * order, with a per-entry header. This is the input shape the
	 * memory-shape experiment (`scripts/test-memory-shape.ts`) consumes
	 * and the format P1.c's `shapeMemory` expects.
	 */
	async accumulatedMemoryText(): Promise<string> {
		const entries = await this.listEntries();
		if (entries.length === 0) {
			return '';
		}
		const parts: string[] = [];
		for (const { index, entry } of entries) {
			parts.push(`=== entry-${String(index).padStart(4, '0')} (${entry.todoId}) ===\n\n${entry.detail}\n`);
		}
		return parts.join('\n');
	}

	private async findFilenameForIndex(index: number): Promise<string | undefined> {
		let names: string[];
		try {
			names = await fsp.readdir(this.runDir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw err;
		}
		const padded = String(index).padStart(4, '0');
		for (const name of names) {
			const m = name.match(FILENAME_PATTERN);
			if (m !== null && m[1] === padded) {
				return name;
			}
		}
		return undefined;
	}
}

/**
 * Open (or create) a working-memory store at the given run directory.
 * Currently a thin wrapper around `new WorkingMemoryStore(runDir)`; kept
 * as the public entrypoint so future P1.d cache-attachment doesn't
 * break callers.
 */
export function openWorkingMemoryStore(runDir: string): WorkingMemoryStore {
	return new WorkingMemoryStore(runDir);
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function serialiseEntry(entry: WorkingMemoryEntry): string {
	const meta: WorkingMemoryEntryMetadata = {
		todoId:      entry.todoId,
		objective:   entry.objective,
		findings:    entry.findings,
		completedAt: entry.completedAt,
		origin:      entry.origin,
	};
	// JSON.stringify with no indentation -- single line, then sentinel,
	// then the markdown body verbatim. Body indentation / whitespace is
	// preserved (no trim).
	return `${JSON.stringify(meta)}\n${BODY_SENTINEL}\n\n${entry.detail}`;
}

export function parseEntry(raw: string): WorkingMemoryEntry {
	const sentinelIdx = raw.indexOf(`\n${BODY_SENTINEL}\n`);
	if (sentinelIdx < 0) {
		throw new Error('working-memory entry: missing body sentinel');
	}
	const metaLine = raw.slice(0, sentinelIdx).trim();
	const bodyStart = sentinelIdx + BODY_SENTINEL.length + 2;   // \n + sentinel + \n
	// Body always has a leading blank line after the sentinel block.
	const detail = raw.slice(bodyStart).replace(/^\n/, '');

	let meta: WorkingMemoryEntryMetadata;
	try {
		meta = JSON.parse(metaLine) as WorkingMemoryEntryMetadata;
	} catch (err) {
		throw new Error(`working-memory entry: metadata parse failed: ${(err as Error).message}`);
	}
	if (typeof meta.todoId !== 'string' || meta.todoId.length === 0) {
		throw new Error('working-memory entry: missing todoId');
	}
	if (typeof meta.objective !== 'string') {
		throw new Error('working-memory entry: missing objective');
	}
	if (typeof meta.completedAt !== 'number' || !Number.isFinite(meta.completedAt)) {
		throw new Error('working-memory entry: bad completedAt');
	}
	if (meta.origin !== 'initial' && meta.origin !== 'report-review-escalation') {
		throw new Error(`working-memory entry: bad origin "${meta.origin}"`);
	}
	if (meta.findings === undefined || meta.findings === null || !Array.isArray(meta.findings.perRoot)) {
		throw new Error('working-memory entry: bad findings shape');
	}
	return {
		todoId:      meta.todoId,
		objective:   meta.objective,
		detail,
		findings:    meta.findings,
		completedAt: meta.completedAt,
		origin:      meta.origin,
	};
}

// ---------------------------------------------------------------------------
// Filename slugging
// ---------------------------------------------------------------------------

function filenameFor(index: number, todoId: string): string {
	const padded = String(index).padStart(4, '0');
	return `${padded}-${slugifyTodoId(todoId)}.md`;
}

/**
 * Reduce a TODO id to filename-safe characters. The id is preserved
 * lossily as a human-readable hint -- the canonical id always lives in
 * the metadata block, never in the filename.
 */
export function slugifyTodoId(todoId: string): string {
	const safe = todoId
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const trimmed = safe.length > 60 ? safe.slice(0, 60) : safe;
	return trimmed.length > 0 ? trimmed : 'todo';
}

// ---------------------------------------------------------------------------
// Helper: ensure the parent directory of a path exists. Exported for
// callers that want to pre-create a run directory before write().
// ---------------------------------------------------------------------------

export async function ensureRunDir(runDir: string): Promise<void> {
	await fsp.mkdir(dirname(runDir), { recursive: true });
	await fsp.mkdir(runDir, { recursive: true });
}
