/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Approval / rejection gates for workflow chains.
 *
 * The gate helpers READ from artifact JSONs on disk and refuse
 * downstream work when the upstream artifact isn't approved. This
 * is the trust boundary between workflows — a downstream workflow
 * MUST call the corresponding gate before consuming an upstream
 * artifact.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getEffectiveHld } from './amendments/effective.js';
import { makeStaleAck } from './amendments/staleness.js';
import type { DefineArtifact } from './artifacts/define.js';
import type { HldArtifact }    from './artifacts/hld.js';
import { defineArtifactPaths, hldArtifactPaths, writeAtomic } from './storage.js';

// ---------------------------------------------------------------------------
// Read + require-approved helpers
// ---------------------------------------------------------------------------

export class ArtifactMissingError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = 'ArtifactMissingError';
	}
}

export class ArtifactNotApprovedError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = 'ArtifactNotApprovedError';
	}
}

/** Read the canonical Define JSON from disk. */
export function readDefineArtifact(repoPath: string, epicSlug: string): DefineArtifact {
	const paths = defineArtifactPaths(repoPath, epicSlug);
	if (!existsSync(paths.json)) {
		throw new ArtifactMissingError(
			`Define artifact not found at ${paths.json}. Run \`insrc_workflow_step\` ` +
			`workflow='define' focus='...' first.`,
		);
	}
	const raw = readFileSync(paths.json, 'utf8');
	return JSON.parse(raw) as DefineArtifact;
}

/** Same as `readDefineArtifact` but refuses when the artifact is
 *  not approved. Downstream runners (`design.epic` s1) call this. */
export function requireApprovedEpic(repoPath: string, epicSlug: string): DefineArtifact {
	const define = readDefineArtifact(repoPath, epicSlug);
	if (define.meta.approvedAt === undefined || define.meta.approvedAt.length === 0) {
		const path = defineArtifactPaths(repoPath, epicSlug).md;
		throw new ArtifactNotApprovedError(
			`Epic '${epicSlug}' is not approved. Run \`insrc workflow approve ${path}\` ` +
			`before starting design.epic.`,
		);
	}
	if (define.meta.rejectedAt !== undefined && define.meta.rejectedAt.length > 0) {
		throw new ArtifactNotApprovedError(
			`Epic '${epicSlug}' was rejected on ${define.meta.rejectedAt}. Re-run define with --reopen first.`,
		);
	}
	return define;
}

/** Read the canonical HLD JSON from disk. */
export function readHldArtifact(repoPath: string, epicSlug: string): HldArtifact {
	const paths = hldArtifactPaths(repoPath, epicSlug);
	if (!existsSync(paths.json)) {
		throw new ArtifactMissingError(
			`HLD not found at ${paths.json}. Run design.epic before design.story.`,
		);
	}
	const raw = readFileSync(paths.json, 'utf8');
	return JSON.parse(raw) as HldArtifact;
}

/** Same as `readHldArtifact` but refuses when the artifact is not
 *  approved AND returns the EFFECTIVE HLD (base + approved
 *  amendments). Downstream workflows must go through this — they
 *  never see the raw base directly.
 *
 *  Amendments are only applied when the base is approved; a
 *  pending or rejected base short-circuits with
 *  `ArtifactNotApprovedError` as before. */
export function requireApprovedHld(repoPath: string, epicSlug: string): HldArtifact {
	const hld = readHldArtifact(repoPath, epicSlug);
	if (hld.meta.approvedAt === undefined || hld.meta.approvedAt.length === 0) {
		const path = hldArtifactPaths(repoPath, epicSlug).md;
		throw new ArtifactNotApprovedError(
			`HLD for Epic '${epicSlug}' is not approved. Run \`insrc workflow approve ${path}\` before starting design.story.`,
		);
	}
	return getEffectiveHld(repoPath, epicSlug, hld);
}

/** Read the BASE HLD (no amendments applied). Used by amendment
 *  approval CLI + the effective-hash calculator + the staleness
 *  scanner. Downstream workflows should call `requireApprovedHld`
 *  instead. */
export function readBaseHld(repoPath: string, epicSlug: string): HldArtifact {
	return readHldArtifact(repoPath, epicSlug);
}

// ---------------------------------------------------------------------------
// Stale-ack helper
// ---------------------------------------------------------------------------

/** Record a stale-ack override on an LLD artifact meta. Reads
 *  `<lldJsonPath>`, adds `staleAckedAt` + `staleAckedReason`,
 *  writes atomically. */
export function ackStaleArtifact(jsonPath: string, reason: string): { readonly path: string; readonly ackedAt: string; readonly reason: string } {
	if (!existsSync(jsonPath)) {
		throw new ArtifactMissingError(`No artifact at ${jsonPath}`);
	}
	const raw = readFileSync(jsonPath, 'utf8');
	const artifact = JSON.parse(raw) as { meta?: Record<string, unknown> };
	if (typeof artifact.meta !== 'object' || artifact.meta === null) {
		throw new Error(`Artifact at ${jsonPath} has no meta`);
	}
	const ack = makeStaleAck(reason);
	const next = { ...artifact, meta: { ...artifact.meta, ...ack } };
	writeAtomic(jsonPath, JSON.stringify(next, null, 2) + '\n');
	return { path: jsonPath, ackedAt: ack.staleAckedAt, reason: ack.staleAckedReason };
}

// ---------------------------------------------------------------------------
// Approve / reject helpers (mutate artifact meta)
// ---------------------------------------------------------------------------

export interface ApprovalResult {
	readonly workflow:  string;
	readonly path:      string;
	readonly approvedAt: string;
}

/** Mark an artifact approved by writing `meta.approvedAt` into its
 *  JSON. Works generically for any workflow — the artifact's JSON
 *  path is passed in verbatim. */
export function approveArtifactByJsonPath(jsonPath: string): ApprovalResult {
	if (!existsSync(jsonPath)) {
		throw new ArtifactMissingError(`No artifact at ${jsonPath}`);
	}
	const raw = readFileSync(jsonPath, 'utf8');
	const artifact = JSON.parse(raw) as { meta?: { workflow?: string; approvedAt?: string; rejectedAt?: string; rejectReason?: string } };
	if (typeof artifact.meta !== 'object' || artifact.meta === null) {
		throw new Error(`Artifact at ${jsonPath} has no meta`);
	}
	const approvedAt = new Date().toISOString();
	const nextMeta = { ...artifact.meta, approvedAt };
	// Clear any prior rejection if we're re-approving.
	delete nextMeta.rejectedAt;
	delete nextMeta.rejectReason;
	const next = { ...artifact, meta: nextMeta };
	writeAtomic(jsonPath, JSON.stringify(next, null, 2) + '\n');
	return { workflow: nextMeta.workflow ?? 'unknown', path: jsonPath, approvedAt };
}

export interface RejectionResult {
	readonly workflow:    string;
	readonly path:        string;
	readonly rejectedAt:  string;
	readonly rejectReason: string;
}

/** Same as `approveArtifactByJsonPath` but records a rejection. */
export function rejectArtifactByJsonPath(jsonPath: string, reason: string): RejectionResult {
	if (!existsSync(jsonPath)) {
		throw new ArtifactMissingError(`No artifact at ${jsonPath}`);
	}
	if (typeof reason !== 'string' || reason.trim().length === 0) {
		throw new Error(`reject requires a non-empty --reason`);
	}
	const raw = readFileSync(jsonPath, 'utf8');
	const artifact = JSON.parse(raw) as { meta?: { workflow?: string; approvedAt?: string; rejectedAt?: string; rejectReason?: string } };
	if (typeof artifact.meta !== 'object' || artifact.meta === null) {
		throw new Error(`Artifact at ${jsonPath} has no meta`);
	}
	const rejectedAt = new Date().toISOString();
	const nextMeta = { ...artifact.meta, rejectedAt, rejectReason: reason };
	delete nextMeta.approvedAt;
	const next = { ...artifact, meta: nextMeta };
	writeAtomic(jsonPath, JSON.stringify(next, null, 2) + '\n');
	return { workflow: nextMeta.workflow ?? 'unknown', path: jsonPath, rejectedAt, rejectReason: reason };
}

/** Given an md path (which the CLI accepts), resolve the sibling
 *  .json. Users almost always have the md path handy. */
export function jsonPathForMd(mdPath: string): string {
	if (mdPath.endsWith('.json')) return mdPath;
	if (mdPath.endsWith('.md'))   return mdPath.slice(0, -3) + '.json';
	throw new Error(`Expected a .md or .json path, got '${mdPath}'`);
}

// Kept as a silence-fixup import so the module surface stays clean
// when nothing else in this file needs `writeFileSync`.
export { writeFileSync as _writeFileSync };
// Re-exports so callers can pull everything gate-related from one module.
export { join as _join };
