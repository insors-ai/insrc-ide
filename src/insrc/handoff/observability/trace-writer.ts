/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-handoff trace writer (plans/external-agent-integration.md §5.2).
 *
 * Lifecycle:
 *   1. `runHandoff` creates a writer at the start of the pipeline via
 *      {@link openTraceWriter}, pointed at
 *      `<persistRoot>/<sessionId>/<specId>.trace.jsonl`.
 *   2. Every HandoffEvent emitted by the orchestrator passes through
 *      {@link TraceWriter.record}, which appends one JSONL line with
 *      a wall-clock timestamp + the verbatim event payload.
 *   3. On pipeline exit (success / error / abort), the orchestrator
 *      calls {@link TraceWriter.close} to flush and release the FD.
 *
 * Crash safety:
 *   - We open the file with O_APPEND and write one line at a time.
 *     A crash mid-write leaves at worst a partial JSON line at the
 *     tail; downstream readers tolerate this with a try/catch
 *     around `JSON.parse` per line.
 *   - We fsync on close so a crash AFTER close() still has all
 *     prior records on disk.
 *
 * Side-channel:
 *   - The trace writer is additive observability. Failures opening
 *     or writing don't affect the pipeline; we log a warning and
 *     keep going. Spec-deliverable + audit JSON stay the source of
 *     truth for "did the handoff succeed".
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { HandoffEvent } from '../types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('handoff:trace');

/**
 * One line in the trace.jsonl file. Wall-clock ts in ms (set by the
 * writer at record time, not by the event source -- the orchestrator's
 * HandoffEvent variants don't carry ts and we don't want to introduce
 * a cross-cutting field on every variant).
 */
export interface TraceRecord {
	readonly ts:    number;
	readonly event: HandoffEvent;
}

export interface TraceWriter {
	/**
	 * Append one event. Synchronous + non-throwing: write failures
	 * are logged and swallowed so the pipeline can't get wedged by
	 * disk-full / FS issues.
	 */
	record(event: HandoffEvent): void;
	/** Flush + close. Idempotent; further `record` calls are no-ops. */
	close(): void;
}

export interface OpenTraceWriterOpts {
	readonly persistRoot: string;
	readonly sessionId:   string;
	readonly specId:      string;
	/** Test seam: override the clock for deterministic timestamps. */
	readonly nowMs?:      (() => number) | undefined;
	/** Test seam: skip the fsync on close (lets tests run faster). */
	readonly skipFsync?:  boolean | undefined;
}

/**
 * Open the trace writer for a single handoff. Creates parent
 * directories if needed; returns a no-op writer on any open failure
 * (logged) so callers can wire it unconditionally.
 */
export function openTraceWriter(opts: OpenTraceWriterOpts): TraceWriter {
	const path = join(opts.persistRoot, opts.sessionId, `${opts.specId}.trace.jsonl`);
	const now  = opts.nowMs ?? (() => Date.now());

	let fd: number | undefined;
	try {
		mkdirSync(dirname(path), { recursive: true });
		fd = openSync(path, 'a');
	} catch (err) {
		log.warn({ path, err: (err as Error).message }, 'trace: failed to open; running with no-op writer');
		return noopWriter();
	}

	let closed = false;
	return {
		record(event: HandoffEvent): void {
			if (closed) return;
			const record: TraceRecord = { ts: now(), event };
			let line: string;
			try {
				line = JSON.stringify(record) + '\n';
			} catch (err) {
				// Circular ref or BigInt in payload -- safe-stringify
				// fallback so the trace never breaks the run.
				log.warn({ kind: event.kind, err: (err as Error).message }, 'trace: stringify failed; recording shape-only');
				line = JSON.stringify({ ts: now(), event: { kind: event.kind, _stringifyError: true } }) + '\n';
			}
			try {
				if (fd === undefined) return;
				writeSync(fd, line);
			} catch (err) {
				log.warn({ path, err: (err as Error).message }, 'trace: write failed; closing writer');
				try { closeSync(fd!); } catch { /* swallow */ }
				fd = undefined;
				closed = true;
			}
		},
		close(): void {
			if (closed || fd === undefined) return;
			closed = true;
			try {
				if (opts.skipFsync !== true) fsyncSync(fd);
			} catch { /* swallow */ }
			try { closeSync(fd); } catch { /* swallow */ }
			fd = undefined;
		},
	};
}

/**
 * Read a trace.jsonl file back as an array of TraceRecord. Tolerates
 * a partial JSON line at the tail (returns the valid prefix); used by
 * tests + the observability viewer (future).
 */
export function readTraceJsonl(path: string): TraceRecord[] {
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch {
		return [];
	}
	const records: TraceRecord[] = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			records.push(JSON.parse(trimmed) as TraceRecord);
		} catch {
			// Partial line at the tail of a crash; drop the rest.
			break;
		}
	}
	return records;
}

/** Empty writer used when open fails -- keeps the pipeline going. */
function noopWriter(): TraceWriter {
	return {
		record(): void { /* no-op */ },
		close():  void { /* no-op */ },
	};
}

/**
 * Convenience: write a one-shot trace summary file alongside the
 * jsonl. Currently unused but exposed for future tooling that wants
 * to dump a fresh snapshot without re-reading the full stream.
 */
export function writeTraceSummary(path: string, body: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body);
	} catch (err) {
		log.warn({ path, err: (err as Error).message }, 'trace: summary write failed');
	}
}
