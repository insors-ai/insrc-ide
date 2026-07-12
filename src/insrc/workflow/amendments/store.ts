/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * On-disk store for HLD amendments.
 *
 * Layout:
 *   docs/designs/<epic-slug>/_hld-amendments/<amendment-id>.json
 *
 * Each record is written once when proposed. The immutability
 * contract:
 *   - `amendment` + `rationale` + `citations` + `proposedBy` +
 *     `proposedAt` NEVER change after the initial write.
 *   - `status` transitions pending → approved | rejected exactly once.
 *   - approve fills `approvedAt`, reject fills `rejectedAt` +
 *     `rejectedReason`. No un-reject; a rejected id is dead.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { writeAtomic } from '../storage.js';
import { isAmendmentRecord } from './types.js';
import type { AmendmentRecord, AmendmentStatus } from './types.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function amendmentsDir(repoPath: string, epicSlug: string): string {
	return join(repoPath, 'docs/designs', epicSlug, '_hld-amendments');
}

export function amendmentPath(repoPath: string, epicSlug: string, amendmentId: string): string {
	return join(amendmentsDir(repoPath, epicSlug), `${amendmentId}.json`);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AmendmentNotFoundError extends Error {
	constructor(msg: string) { super(msg); this.name = 'AmendmentNotFoundError'; }
}

export class AmendmentImmutabilityError extends Error {
	constructor(msg: string) { super(msg); this.name = 'AmendmentImmutabilityError'; }
}

export class AmendmentIdConflictError extends Error {
	constructor(msg: string) { super(msg); this.name = 'AmendmentIdConflictError'; }
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Mint the next amendment id for an Epic. Scans the existing
 *  records to find the highest `amend-<slug>-<n>` counter. */
export function nextAmendmentId(repoPath: string, epicSlug: string): string {
	const dir = amendmentsDir(repoPath, epicSlug);
	if (!existsSync(dir)) return `amend-${epicSlug}-1`;
	let max = 0;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith('.json')) continue;
		const m = new RegExp(`^amend-${escapeRegex(epicSlug)}-(\\d+)\\.json$`).exec(name);
		if (m !== null) {
			const n = Number(m[1]);
			if (Number.isInteger(n) && n > max) max = n;
		}
	}
	return `amend-${epicSlug}-${max + 1}`;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Propose an amendment. Fails if an amendment with the same id
 *  already exists on disk. */
export function proposeAmendment(repoPath: string, record: AmendmentRecord): void {
	const path = amendmentPath(repoPath, record.epicSlug, record.id);
	if (existsSync(path)) {
		throw new AmendmentIdConflictError(
			`amendment '${record.id}' already exists at ${path}; ids are single-use`,
		);
	}
	if (record.status !== 'pending') {
		throw new AmendmentImmutabilityError(
			`proposeAmendment: status must be 'pending' at write time (got '${record.status}')`,
		);
	}
	writeAtomic(path, JSON.stringify(record, null, 2) + '\n');
}

/** Mark an amendment approved. Refuses if it's already resolved. */
export function approveAmendment(
	repoPath:   string,
	epicSlug:   string,
	amendmentId: string,
	approvedBy: string,
): AmendmentRecord {
	return transition(repoPath, epicSlug, amendmentId, prev => {
		if (prev.status !== 'pending') {
			throw new AmendmentImmutabilityError(
				`amendment '${amendmentId}' is ${prev.status}; cannot transition to approved`,
			);
		}
		return {
			...prev,
			status:     'approved' as AmendmentStatus,
			approvedAt: new Date().toISOString(),
			approvedBy,
		};
	});
}

/** Mark an amendment rejected. Refuses if it's already resolved. */
export function rejectAmendment(
	repoPath:   string,
	epicSlug:   string,
	amendmentId: string,
	reason:     string,
): AmendmentRecord {
	if (typeof reason !== 'string' || reason.trim().length === 0) {
		throw new Error(`rejectAmendment: reason is required`);
	}
	return transition(repoPath, epicSlug, amendmentId, prev => {
		if (prev.status !== 'pending') {
			throw new AmendmentImmutabilityError(
				`amendment '${amendmentId}' is ${prev.status}; cannot transition to rejected`,
			);
		}
		return {
			...prev,
			status:         'rejected' as AmendmentStatus,
			rejectedAt:     new Date().toISOString(),
			rejectedReason: reason,
		};
	});
}

function transition(
	repoPath:    string,
	epicSlug:    string,
	amendmentId: string,
	mutate:      (prev: AmendmentRecord) => AmendmentRecord,
): AmendmentRecord {
	const path = amendmentPath(repoPath, epicSlug, amendmentId);
	if (!existsSync(path)) {
		throw new AmendmentNotFoundError(`amendment '${amendmentId}' not found at ${path}`);
	}
	const raw = readFileSync(path, 'utf8');
	const prev = JSON.parse(raw) as unknown;
	if (!isAmendmentRecord(prev)) {
		throw new AmendmentImmutabilityError(`file at ${path} is not a valid AmendmentRecord`);
	}
	// Immutability check on the frozen fields:
	const next = mutate(prev);
	assertFrozen(prev, next);
	writeAtomic(path, JSON.stringify(next, null, 2) + '\n');
	return next;
}

function assertFrozen(prev: AmendmentRecord, next: AmendmentRecord): void {
	const frozen: (keyof AmendmentRecord)[] = ['id', 'epicSlug', 'hldBaseRunId', 'amendment', 'rationale', 'citations', 'proposedBy', 'proposedAt', 'sideEffects'];
	for (const k of frozen) {
		if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
			throw new AmendmentImmutabilityError(`amendment field '${String(k)}' cannot change`);
		}
	}
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function readAmendment(
	repoPath:    string,
	epicSlug:    string,
	amendmentId: string,
): AmendmentRecord {
	const path = amendmentPath(repoPath, epicSlug, amendmentId);
	if (!existsSync(path)) {
		throw new AmendmentNotFoundError(`amendment '${amendmentId}' not found at ${path}`);
	}
	const raw = readFileSync(path, 'utf8');
	const rec = JSON.parse(raw) as unknown;
	if (!isAmendmentRecord(rec)) {
		throw new Error(`file at ${path} is not a valid AmendmentRecord`);
	}
	return rec;
}

export function listAmendments(
	repoPath: string,
	epicSlug: string,
): readonly AmendmentRecord[] {
	const dir = amendmentsDir(repoPath, epicSlug);
	if (!existsSync(dir)) return [];
	const out: AmendmentRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith('.json')) continue;
		const raw = readFileSync(join(dir, name), 'utf8');
		const rec = JSON.parse(raw) as unknown;
		if (isAmendmentRecord(rec)) out.push(rec);
	}
	// Deterministic order: `amend-<slug>-<n>` sorted by n ascending.
	return out.sort((a, b) => amendmentSuffixNum(a.id) - amendmentSuffixNum(b.id));
}

/** Filter to only-approved amendments, sorted by approvedAt (rising).
 *  Same order the applier consumes them in. */
export function listApprovedAmendments(
	repoPath: string,
	epicSlug: string,
): readonly AmendmentRecord[] {
	return listAmendments(repoPath, epicSlug)
		.filter(a => a.status === 'approved' && typeof a.approvedAt === 'string')
		.sort((a, b) => (a.approvedAt ?? '').localeCompare(b.approvedAt ?? ''));
}

function amendmentSuffixNum(id: string): number {
	const m = /-(\d+)$/.exec(id);
	if (m === null) return 0;
	return Number(m[1]) || 0;
}
