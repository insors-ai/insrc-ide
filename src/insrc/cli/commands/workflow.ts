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
import { approveArtifactByJsonPath, jsonPathForMd, rejectArtifactByJsonPath } from '../../workflow/gates.js';
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
}
