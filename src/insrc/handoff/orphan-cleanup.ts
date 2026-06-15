/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Orphan worktree detection (plans/external-agent-integration.md §5.1).
 *
 * The daemon's in-flight-handoff state is purely in-memory: it owns
 * no persistent registry of running handoffs. When the daemon
 * crashes (or the host loses power) mid-handoff, the worktree it
 * created in `<persistRoot>/<sessionId>/worktree` stays on disk
 * with no way to know whether the agent had finished its work,
 * the audit had run, or the user had decided to accept / reject
 * the diff. This module reads enough on-disk state to classify
 * each worktree:
 *
 *   - `completed`: the trace.jsonl ends in `handoff-final` or
 *     `handoff-error`. The pipeline finished; the worktree is
 *     waiting on user accept / reject. Safe to keep around.
 *
 *   - `interrupted`: the trace.jsonl exists but doesn't end in a
 *     terminal event. The daemon was killed mid-pipeline. The
 *     worktree is recoverable (the user can either retry with the
 *     same spec or discard the worktree).
 *
 *   - `pending`: the worktree exists but no trace.jsonl is on
 *     disk yet (daemon crashed BEFORE the trace was opened, i.e.
 *     during spec assembly or worktree creation). Discard
 *     candidate.
 *
 * Classification reads at most a few hundred bytes from the tail
 * of each trace file -- safe to run synchronously at daemon
 * startup over hundreds of worktrees.
 *
 * The daemon's startup hook (Phase 5 wiring) calls
 * {@link detectOrphans} and logs the result. The
 * `handoff.list-orphans` and `handoff.discard-orphan` IPCs
 * surface the same data to the IDE so users can clean up.
 *
 * Test seam: a `nowMs` injectable clock is plumbed for future
 * staleness-based heuristics; today the classifier doesn't use it.
 */

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { readTraceJsonl, type TraceRecord } from './observability/trace-writer.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('handoff:orphan');

export type OrphanStatus = 'completed' | 'interrupted' | 'pending';

export interface OrphanWorktree {
	readonly sessionId:    string;
	readonly worktreePath: string;
	readonly status:       OrphanStatus;
	readonly lastEventKind?: string | undefined;
	readonly lastEventTs?:   number  | undefined;
	readonly traceFile?:     string  | undefined;
	readonly specId?:        string  | undefined;
}

export interface DetectOrphansOpts {
	readonly persistRoot: string;
}

/**
 * Walk `<persistRoot>/<sessionId>/` and classify every worktree
 * directory we find. Resilient to a malformed persistRoot (missing
 * directory, non-directory entries, unreadable trace files) -- those
 * just don't show up in the result.
 */
export function detectOrphans(opts: DetectOrphansOpts): OrphanWorktree[] {
	if (!existsSync(opts.persistRoot)) {
		return [];
	}
	let sessionDirs: string[];
	try {
		sessionDirs = readdirSync(opts.persistRoot);
	} catch (err) {
		log.warn({ persistRoot: opts.persistRoot, err: (err as Error).message },
			'orphan: failed to enumerate persistRoot; returning empty');
		return [];
	}

	const out: OrphanWorktree[] = [];
	for (const sessionId of sessionDirs) {
		const sessionPath  = join(opts.persistRoot, sessionId);
		const worktreePath = join(sessionPath, 'worktree');

		// Skip non-directories (junk files, lock files, etc.).
		let isDir = false;
		try { isDir = statSync(sessionPath).isDirectory(); } catch { /* swallow */ }
		if (!isDir) continue;

		if (!existsSync(worktreePath)) {
			// Session dir without a worktree: probably a completed
			// handoff whose worktree was already cleaned up. Skip.
			continue;
		}

		const classification = classifySession(sessionPath, sessionId);
		out.push({
			sessionId,
			worktreePath,
			status:        classification.status,
			...(classification.lastEventKind !== undefined ? { lastEventKind: classification.lastEventKind } : {}),
			...(classification.lastEventTs   !== undefined ? { lastEventTs:   classification.lastEventTs   } : {}),
			...(classification.traceFile     !== undefined ? { traceFile:     classification.traceFile     } : {}),
			...(classification.specId        !== undefined ? { specId:        classification.specId        } : {}),
		});
	}
	return out;
}

interface SessionClassification {
	readonly status:         OrphanStatus;
	readonly lastEventKind?: string;
	readonly lastEventTs?:   number;
	readonly traceFile?:     string;
	readonly specId?:        string;
}

function classifySession(sessionPath: string, _sessionId: string): SessionClassification {
	// A session can host multiple handoffs over its lifetime; we pick
	// the most recently-touched trace.jsonl in the dir as the signal.
	let traceFiles: string[] = [];
	try {
		traceFiles = readdirSync(sessionPath).filter(name => name.endsWith('.trace.jsonl'));
	} catch { /* swallow */ }

	if (traceFiles.length === 0) {
		// No trace: the daemon crashed before spec assembly, or this
		// is a stale dir from a pre-Phase-5 build that didn't write
		// traces. Either way, treat as pending.
		return { status: 'pending' };
	}

	// Pick the most-recently-modified trace file.
	let chosenFile: string | undefined;
	let chosenMtime = -Infinity;
	for (const file of traceFiles) {
		const full = join(sessionPath, file);
		try {
			const mt = statSync(full).mtimeMs;
			if (mt > chosenMtime) {
				chosenMtime = mt;
				chosenFile = file;
			}
		} catch { /* swallow */ }
	}
	if (chosenFile === undefined) {
		return { status: 'pending' };
	}

	const tracePath = join(sessionPath, chosenFile);
	const records = readTraceJsonl(tracePath);
	if (records.length === 0) {
		return { status: 'pending', traceFile: tracePath };
	}

	const last = records[records.length - 1] as TraceRecord;
	const lastKind = last.event.kind;
	const isTerminal = lastKind === 'handoff-final' || lastKind === 'handoff-error';
	// Spec id lives in any of the per-spec events; pull from the
	// last record if it has one, otherwise scan for the first
	// `spec-ready` we know carries it.
	const specId = extractSpecId(records);

	return {
		status:        isTerminal ? 'completed' : 'interrupted',
		lastEventKind: lastKind,
		lastEventTs:   last.ts,
		traceFile:     tracePath,
		...(specId !== undefined ? { specId } : {}),
	};
}

function extractSpecId(records: readonly TraceRecord[]): string | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		const ev = records[i]!.event as { specId?: string };
		if (typeof ev.specId === 'string' && ev.specId.length > 0) {
			return ev.specId;
		}
	}
	return undefined;
}

/**
 * Forcefully remove an orphan worktree directory. Caller is
 * responsible for confirming with the user (via the IDE) before
 * calling -- this is a destructive operation.
 *
 * Returns `true` if the path was removed; `false` if it doesn't
 * exist (idempotent) or removal failed (logged).
 */
export function discardOrphan(worktreePath: string): boolean {
	if (!existsSync(worktreePath)) return false;
	try {
		rmSync(worktreePath, { recursive: true, force: true });
		log.info({ worktreePath }, 'orphan: discarded worktree');
		return true;
	} catch (err) {
		log.warn({ worktreePath, err: (err as Error).message }, 'orphan: discard failed');
		return false;
	}
}
