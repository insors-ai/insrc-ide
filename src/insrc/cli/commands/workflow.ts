/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc workflow` CLI. Phase A ships:
 *
 *   - `insrc workflow list`   — enumerate registered workflows.
 *   - `insrc workflow runs`   — list workflow-runs log entries.
 *   - `insrc workflow derive-slug <focus>` — pure helper for tests.
 *
 * The actual workflow-start path lives behind the `insrc_workflow_step`
 * MCP tool (Claude Code / Codex drive it), not a CLI command. A CLI
 * `start` command that would try to drive the LLM turns here would
 * either re-implement the state loop or hard-code an LLM provider
 * — both bad. In Phase B+ the CLI grows `approve`, `reject`,
 * `push`, `sync`, `post` — those are deterministic and don't need
 * the outer LLM.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';
import { PATHS } from '../../shared/paths.js';
import {
	ackStaleArtifact,
	approveArtifactByJsonPath,
	jsonPathForMd,
	readBaseHld,
	rejectArtifactByJsonPath,
} from '../../workflow/gates.js';
import {
	approveAmendment,
	listAmendments,
	readAmendment,
	rejectAmendment,
} from '../../workflow/amendments/store.js';
import { scanLldStaleness } from '../../workflow/amendments/staleness.js';
import { deriveSlug } from '../../workflow/slug.js';
import { WORKFLOW_NAMES } from '../../workflow/types.js';

export function registerWorkflowCommands(program: Command): void {
	const wf = program
		.command('workflow')
		.description('workflow framework (define / design / plan / build / test)');

	wf.command('list')
		.description('list registered workflow names')
		.action(() => {
			for (const name of WORKFLOW_NAMES) {
				process.stdout.write(`${name}\n`);
			}
		});

	wf.command('runs')
		.description('list workflow-run log directories under ~/.insrc/workflow-runs/')
		.option('--slug <slug>', 'only show runs for one slug')
		.action((opts: { slug?: string }) => {
			const root = join(PATHS.insrc, 'workflow-runs');
			if (!existsSync(root)) {
				process.stdout.write('no workflow runs yet\n');
				return;
			}
			const slugs = opts.slug === undefined
				? readdirSync(root, { withFileTypes: true })
					.filter(d => d.isDirectory())
					.map(d => d.name)
				: [opts.slug];
			for (const slug of slugs) {
				const slugDir = join(root, slug);
				if (!existsSync(slugDir)) continue;
				const entries = readdirSync(slugDir, { withFileTypes: true })
					.filter(d => d.isFile() && d.name.endsWith('.jsonl'));
				process.stdout.write(`## ${slug}\n`);
				for (const e of entries) {
					process.stdout.write(`  ${e.name}\n`);
				}
			}
		});

	wf.command('derive-slug <focus...>')
		.description('derive the slug the framework would use for a focus (helper)')
		.action((parts: string[]) => {
			const focus = parts.join(' ');
			try {
				process.stdout.write(`${deriveSlug(focus)}\n`);
			} catch (err) {
				process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
				process.exit(1);
			}
		});

	wf.command('approve <artifact-path>')
		.description('mark a workflow artifact approved (sets meta.approvedAt)')
		.action((artifactPath: string) => {
			try {
				const jsonPath = jsonPathForMd(artifactPath);
				const r = approveArtifactByJsonPath(jsonPath);
				process.stdout.write(`approved ${r.workflow}: ${r.path} at ${r.approvedAt}\n`);
			} catch (err) {
				process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
				process.exit(1);
			}
		});

	wf.command('reject <artifact-path>')
		.description('mark a workflow artifact rejected (sets meta.rejectedAt + reason)')
		.requiredOption('--reason <text>', 'why the artifact is being rejected')
		.action((artifactPath: string, opts: { reason: string }) => {
			try {
				const jsonPath = jsonPathForMd(artifactPath);
				const r = rejectArtifactByJsonPath(jsonPath, opts.reason);
				process.stdout.write(`rejected ${r.workflow}: ${r.path} at ${r.rejectedAt}\n`);
			} catch (err) {
				process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
				process.exit(1);
			}
		});

	// ---------------------------------------------------------------
	// Amendments (Phase E)
	// ---------------------------------------------------------------

	wf.command('status <epic-slug>')
		.description('show pending amendments + stale LLDs for an Epic')
		.option('--repo <path>', 'repo path (defaults to cwd)', process.cwd())
		.action((epicSlug: string, opts: { repo: string }) => {
			try {
				const repoPath = opts.repo;
				const amendments = listAmendments(repoPath, epicSlug);
				const pending = amendments.filter(a => a.status === 'pending');
				const approved = amendments.filter(a => a.status === 'approved');
				const rejected = amendments.filter(a => a.status === 'rejected');
				process.stdout.write(`## Amendments for '${epicSlug}'\n`);
				process.stdout.write(`  pending: ${pending.length}   approved: ${approved.length}   rejected: ${rejected.length}\n`);
				for (const a of pending) {
					process.stdout.write(`  - ${a.id}  (${a.amendment.type})  proposedBy=${a.proposedBy.workflow}:${a.proposedBy.storyId ?? '?'}:${a.proposedBy.stepId}\n`);
				}
				process.stdout.write(`\n## LLDs staleness\n`);
				let base;
				try { base = readBaseHld(repoPath, epicSlug); }
				catch { process.stdout.write('  (no HLD yet)\n'); return; }
				const entries = scanLldStaleness(repoPath, epicSlug, base);
				if (entries.length === 0) { process.stdout.write('  (no LLDs)\n'); return; }
				for (const e of entries) {
					const acked = e.ackedStale !== undefined ? ' [ACKED]' : '';
					if (e.stale) {
						process.stdout.write(`  ${e.storyId}: STALE (${e.staleReason})${acked}\n`);
					} else {
						process.stdout.write(`  ${e.storyId}: up-to-date\n`);
					}
				}
			} catch (err) {
				process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
				process.exit(1);
			}
		});

	const amend = wf.command('amend <epic-slug>')
		.description('list / show / approve / reject HLD amendments for an Epic')
		.option('--repo <path>', 'repo path (defaults to cwd)', process.cwd())
		.option('--list', 'list every amendment for this Epic')
		.option('--show <amendmentId>', 'show one amendment in detail')
		.option('--approve <amendmentId>', 'approve a pending amendment')
		.option('--reject <amendmentId>', 'reject a pending amendment')
		.option('--notes <text>', 'reason (required with --reject)')
		.option('--approved-by <name>', 'approver id / name (defaults to $USER)', process.env['USER'] ?? 'unknown');
	amend.action((epicSlug: string, opts: {
		repo: string; list?: boolean; show?: string;
		approve?: string; reject?: string; notes?: string; approvedBy: string;
	}) => {
		try {
			const repoPath = opts.repo;
			if (opts.list === true) {
				const rows = listAmendments(repoPath, epicSlug);
				if (rows.length === 0) { process.stdout.write('(no amendments)\n'); return; }
				for (const a of rows) {
					const detail = a.status === 'approved' ? ` approvedAt=${a.approvedAt}` :
						a.status === 'rejected' ? ` rejectedReason='${a.rejectedReason ?? ''}'` : '';
					process.stdout.write(`${a.id}  ${a.status}  ${a.amendment.type}${detail}\n`);
				}
				return;
			}
			if (opts.show !== undefined) {
				const rec = readAmendment(repoPath, epicSlug, opts.show);
				process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
				return;
			}
			if (opts.approve !== undefined) {
				const rec = approveAmendment(repoPath, epicSlug, opts.approve, opts.approvedBy);
				process.stdout.write(`approved ${rec.id} at ${rec.approvedAt}\n`);
				return;
			}
			if (opts.reject !== undefined) {
				const reason = opts.notes;
				if (typeof reason !== 'string' || reason.length === 0) {
					throw new Error(`--reject requires --notes <reason>`);
				}
				const rec = rejectAmendment(repoPath, epicSlug, opts.reject, reason);
				process.stdout.write(`rejected ${rec.id} at ${rec.rejectedAt}\n`);
				return;
			}
			amend.help();
		} catch (err) {
			process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
			process.exit(1);
		}
	});

	wf.command('ack-stale <artifact-path>')
		.description('record a stale-ack override on an LLD (staleAckedAt + reason)')
		.requiredOption('--reason <text>', 'why the staleness is acknowledged')
		.action((artifactPath: string, opts: { reason: string }) => {
			try {
				const jsonPath = jsonPathForMd(artifactPath);
				const r = ackStaleArtifact(jsonPath, opts.reason);
				process.stdout.write(`acked ${r.path} at ${r.ackedAt} — ${r.reason}\n`);
			} catch (err) {
				process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
				process.exit(1);
			}
		});
}
