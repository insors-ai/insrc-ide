/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc workflow chain <epic-slug>` support module.
 *
 * The chain command reports the current state of an Epic across
 * the whole workflow lifecycle (define → design.epic → design.story
 * per Story) and prints the exact next MCP tool invocation the
 * user should run.
 *
 * The command is a status + guide — it does NOT drive the LLM-
 * heavy workflows itself. Those run through the `insrc_workflow_step`
 * MCP tool inside a client like Claude Code / Codex CLI.
 *
 * Design principle: the framework tells the user (or their LLM)
 * exactly what to do next; the user runs it in-session.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { DefineArtifact } from './artifacts/define.js';
import type { HldArtifact } from './artifacts/hld.js';
import { defineArtifactPaths, hldArtifactPaths, lldArtifactPaths } from './storage.js';
import { listAmendments } from './amendments/store.js';
import { scanLldStaleness } from './amendments/staleness.js';

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface ChainReport {
	readonly epicSlug: string;
	readonly define: {
		readonly exists:      boolean;
		readonly approved:    boolean;
		readonly rejected:    boolean;
		readonly path?:       string;
	};
	readonly hld: {
		readonly exists:   boolean;
		readonly approved: boolean;
		readonly rejected: boolean;
		readonly path?:    string;
	};
	readonly stories: readonly {
		readonly id:       string;
		readonly title:    string;
		readonly hasLld:   boolean;
		readonly approved: boolean;
		readonly stale:    boolean;
		readonly staleReason?: string;
		readonly path?:    string;
	}[];
	readonly amendments: {
		readonly pending:  number;
		readonly approved: number;
		readonly rejected: number;
	};
	readonly tracker: {
		readonly pushed:      boolean;
		readonly epicRef?:    string;
		readonly lastSyncedAt?: string;
	};
	readonly nextAction: NextAction;
}

export type NextAction =
	| { readonly kind: 'run-define';       readonly command: string }
	| { readonly kind: 'approve-define';   readonly command: string }
	| { readonly kind: 'run-hld';          readonly command: string }
	| { readonly kind: 'approve-hld';      readonly command: string }
	| { readonly kind: 'run-lld';          readonly storyId: string; readonly command: string }
	| { readonly kind: 'approve-lld';      readonly storyId: string; readonly command: string }
	| { readonly kind: 'refresh-stale';    readonly storyId: string; readonly reason: string }
	| { readonly kind: 'review-amendment'; readonly amendmentId: string; readonly command: string }
	| { readonly kind: 'push-tracker';     readonly command: string }
	| { readonly kind: 'sync-tracker';     readonly command: string }
	| { readonly kind: 'chain-complete' };

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildChainReport(repoPath: string, epicSlug: string): ChainReport {
	const define = readDefineIfPresent(repoPath, epicSlug);
	const hld    = readHldIfPresent(repoPath, epicSlug);
	const stories = readStoryLldStatus(repoPath, epicSlug, define, hld);
	const amendments = countAmendments(repoPath, epicSlug);
	const tracker = readTrackerMeta(define.artifact);
	const nextAction = computeNextAction(repoPath, epicSlug, {
		define, hld, stories, amendments, tracker,
	});
	return {
		epicSlug,
		define: {
			exists:   define.exists,
			approved: define.approved,
			rejected: define.rejected,
			...(define.path !== undefined ? { path: define.path } : {}),
		},
		hld: {
			exists:   hld.exists,
			approved: hld.approved,
			rejected: hld.rejected,
			...(hld.path !== undefined ? { path: hld.path } : {}),
		},
		stories,
		amendments,
		tracker,
		nextAction,
	};
}

interface DefineState {
	readonly exists:   boolean;
	readonly approved: boolean;
	readonly rejected: boolean;
	readonly path?:    string;
	readonly artifact?: DefineArtifact;
}

interface HldState {
	readonly exists:   boolean;
	readonly approved: boolean;
	readonly rejected: boolean;
	readonly path?:    string;
	readonly artifact?: HldArtifact;
}

function readDefineIfPresent(repoPath: string, epicSlug: string): DefineState {
	const paths = defineArtifactPaths(repoPath, epicSlug);
	if (!existsSync(paths.json)) return { exists: false, approved: false, rejected: false };
	const raw = readFileSync(paths.json, 'utf8');
	const artifact = JSON.parse(raw) as DefineArtifact;
	const approved = typeof artifact.meta.approvedAt === 'string' && artifact.meta.approvedAt.length > 0;
	const rejected = typeof artifact.meta.rejectedAt === 'string' && artifact.meta.rejectedAt.length > 0;
	return { exists: true, approved, rejected, path: paths.md, artifact };
}

function readHldIfPresent(repoPath: string, epicSlug: string): HldState {
	const paths = hldArtifactPaths(repoPath, epicSlug);
	if (!existsSync(paths.json)) return { exists: false, approved: false, rejected: false };
	const raw = readFileSync(paths.json, 'utf8');
	const artifact = JSON.parse(raw) as HldArtifact;
	const approved = typeof artifact.meta.approvedAt === 'string' && artifact.meta.approvedAt.length > 0;
	const rejected = typeof artifact.meta.rejectedAt === 'string' && artifact.meta.rejectedAt.length > 0;
	return { exists: true, approved, rejected, path: paths.md, artifact };
}

function readStoryLldStatus(
	repoPath:  string,
	epicSlug:  string,
	define:    DefineState,
	hld:       HldState,
): ChainReport['stories'] {
	if (define.artifact === undefined) return [];
	const stories = define.artifact.body.stories;
	// Staleness scan needs the HLD to be present. Without it we
	// don't yet know effective hash, so just report existence.
	const staleness = hld.artifact === undefined ? new Map<string, { stale: boolean; staleReason?: string }>()
		: staleByStory(scanLldStaleness(repoPath, epicSlug, hld.artifact));
	return stories.map(s => {
		const paths = lldArtifactPaths(repoPath, epicSlug, s.id);
		const hasLld = existsSync(paths.json);
		let approved = false;
		if (hasLld) {
			try {
				const raw = readFileSync(paths.json, 'utf8');
				const lld = JSON.parse(raw) as { meta: { approvedAt?: string } };
				approved = typeof lld.meta.approvedAt === 'string' && lld.meta.approvedAt.length > 0;
			} catch { /* malformed — treat as unapproved */ }
		}
		const stale = staleness.get(s.id);
		return {
			id: s.id, title: s.title,
			hasLld, approved,
			stale: stale?.stale === true,
			...(stale?.staleReason !== undefined ? { staleReason: stale.staleReason } : {}),
			...(hasLld ? { path: paths.md } : {}),
		};
	});
}

function staleByStory(entries: ReturnType<typeof scanLldStaleness>): Map<string, { stale: boolean; staleReason?: string }> {
	const m = new Map<string, { stale: boolean; staleReason?: string }>();
	for (const e of entries) {
		m.set(e.storyId, { stale: e.stale, ...(e.staleReason !== undefined ? { staleReason: e.staleReason } : {}) });
	}
	return m;
}

function countAmendments(repoPath: string, epicSlug: string): ChainReport['amendments'] {
	const rows = listAmendments(repoPath, epicSlug);
	let pending = 0, approved = 0, rejected = 0;
	for (const r of rows) {
		if (r.status === 'pending')       pending++;
		else if (r.status === 'approved') approved++;
		else if (r.status === 'rejected') rejected++;
	}
	return { pending, approved, rejected };
}

function readTrackerMeta(define?: DefineArtifact): ChainReport['tracker'] {
	if (define === undefined) return { pushed: false };
	const meta = define.meta as { tracker?: { epicRef?: string; lastSyncedAt?: string } };
	if (meta.tracker === undefined || typeof meta.tracker.epicRef !== 'string') return { pushed: false };
	return {
		pushed:  true,
		epicRef: meta.tracker.epicRef,
		...(typeof meta.tracker.lastSyncedAt === 'string' ? { lastSyncedAt: meta.tracker.lastSyncedAt } : {}),
	};
}

// ---------------------------------------------------------------------------
// Next-action decision tree
// ---------------------------------------------------------------------------

interface NextActionInput {
	readonly define:    DefineState;
	readonly hld:       HldState;
	readonly stories:   ChainReport['stories'];
	readonly amendments: ChainReport['amendments'];
	readonly tracker:   ChainReport['tracker'];
}

function computeNextAction(repoPath: string, epicSlug: string, s: NextActionInput): NextAction {
	// 1. Define isn't done or approved.
	if (!s.define.exists) {
		return {
			kind: 'run-define',
			command: `insrc_workflow_step phase=start workflow=define focus="<your ask>"`,
		};
	}
	if (s.define.rejected) {
		return {
			kind: 'run-define',
			command: `insrc_workflow_step phase=start workflow=define focus="<re-framed ask; prior was rejected>"`,
		};
	}
	if (!s.define.approved) {
		return {
			kind: 'approve-define',
			command: `insrc workflow approve ${s.define.path}`,
		};
	}
	// 2. Pending amendments block downstream: surface them first.
	if (s.amendments.pending > 0) {
		return {
			kind: 'review-amendment',
			amendmentId: `<list via: insrc workflow amend ${epicSlug} --list>`,
			command: `insrc workflow amend ${epicSlug} --list`,
		};
	}
	// 3. HLD.
	if (!s.hld.exists) {
		return {
			kind: 'run-hld',
			command: `insrc_workflow_step phase=start workflow=design.epic focus="HLD for ${epicSlug}" params={"epicSlug":"${epicSlug}"}`,
		};
	}
	if (!s.hld.approved) {
		return {
			kind: 'approve-hld',
			command: `insrc workflow approve ${s.hld.path}`,
		};
	}
	// 4. LLDs: pick the first Story that's missing OR stale OR unapproved.
	for (const story of s.stories) {
		if (story.stale) {
			return {
				kind: 'refresh-stale',
				storyId: story.id,
				reason: story.staleReason ?? 'unknown',
			};
		}
		if (!story.hasLld) {
			return {
				kind: 'run-lld',
				storyId: story.id,
				command: `insrc_workflow_step phase=start workflow=design.story focus="LLD for ${story.id}" params={"epicSlug":"${epicSlug}","storyId":"${story.id}"}`,
			};
		}
		if (!story.approved) {
			return {
				kind: 'approve-lld',
				storyId: story.id,
				command: `insrc workflow approve ${story.path}`,
			};
		}
	}
	// 5. Tracker: suggest push once every LLD is approved.
	if (!s.tracker.pushed) {
		return {
			kind: 'push-tracker',
			command: `insrc_workflow_step phase=start workflow=tracker.push focus="push ${epicSlug} to GitHub" params={"epicSlug":"${epicSlug}"}`,
		};
	}
	// 6. Suggest a sync if it's been a while (heuristic: never
	// synced OR older than 24h).
	if (s.tracker.lastSyncedAt === undefined) {
		return {
			kind: 'sync-tracker',
			command: `insrc_workflow_step phase=start workflow=tracker.sync focus="sync ${epicSlug} from GitHub" params={"epicSlug":"${epicSlug}"}`,
		};
	}
	// Chain complete for this Epic (design + tracker up-to-date).
	return { kind: 'chain-complete' };
	// silence unused
	void repoPath; void readdirSync; void join;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/** Render a chain report to plain text for CLI stdout. */
export function formatChainReport(r: ChainReport): string {
	const lines: string[] = [];
	lines.push(`# Chain status: ${r.epicSlug}`);
	lines.push('');
	lines.push(`## Define`);
	lines.push(bullet('exists',   r.define.exists));
	lines.push(bullet('approved', r.define.approved));
	if (r.define.rejected) lines.push(`  - rejected: yes`);
	lines.push('');
	lines.push(`## HLD`);
	lines.push(bullet('exists',   r.hld.exists));
	lines.push(bullet('approved', r.hld.approved));
	if (r.hld.rejected) lines.push(`  - rejected: yes`);
	lines.push('');
	if (r.stories.length > 0) {
		lines.push(`## LLDs`);
		for (const s of r.stories) {
			const flags: string[] = [];
			if (!s.hasLld)           flags.push('missing');
			else if (!s.approved)    flags.push('unapproved');
			if (s.stale)             flags.push(`STALE (${s.staleReason ?? '?'})`);
			const status = flags.length > 0 ? flags.join(', ') : 'up-to-date';
			lines.push(`  - ${s.id}: ${s.title} — ${status}`);
		}
		lines.push('');
	}
	lines.push(`## Amendments`);
	lines.push(`  - pending: ${r.amendments.pending}   approved: ${r.amendments.approved}   rejected: ${r.amendments.rejected}`);
	lines.push('');
	lines.push(`## Tracker`);
	if (r.tracker.pushed) {
		lines.push(`  - pushed: ${r.tracker.epicRef}`);
		if (r.tracker.lastSyncedAt !== undefined) lines.push(`  - lastSyncedAt: ${r.tracker.lastSyncedAt}`);
	} else {
		lines.push('  - not yet pushed');
	}
	lines.push('');
	lines.push(`## Next action`);
	lines.push(formatNextAction(r.nextAction));
	return lines.join('\n') + '\n';
}

function bullet(label: string, value: boolean): string {
	return `  - ${label}: ${value ? 'yes' : 'no'}`;
}

function formatNextAction(a: NextAction): string {
	switch (a.kind) {
		case 'run-define':       return `Run define: \`${a.command}\``;
		case 'approve-define':   return `Approve Define: \`${a.command}\``;
		case 'run-hld':          return `Run HLD (design.epic): \`${a.command}\``;
		case 'approve-hld':      return `Approve HLD: \`${a.command}\``;
		case 'run-lld':          return `Run LLD for Story '${a.storyId}': \`${a.command}\``;
		case 'approve-lld':      return `Approve LLD for Story '${a.storyId}': \`${a.command}\``;
		case 'refresh-stale':    return `Story '${a.storyId}' LLD is stale (${a.reason}). Re-run design.story or ack-stale.`;
		case 'review-amendment': return `Pending amendment(s) block downstream progress. Review: \`${a.command}\``;
		case 'push-tracker':     return `All designs approved. Push to GitHub: \`${a.command}\``;
		case 'sync-tracker':     return `Sync tracker status: \`${a.command}\``;
		case 'chain-complete':   return `Chain complete — no next action.`;
		default:                 return 'unknown';
	}
}
