/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc handoff` -- run a handoff from the CLI.
 *
 * Phase 2a Day 5. Two usage modes:
 *
 *   1. Real claude-code spawn (production path):
 *        insrc handoff \
 *          --template DEBUG-SESSION \
 *          --intent "fix the flaky test in foo.test.ts" \
 *          --repo /path/to/repo \
 *          --agent claude-code \
 *          --mcp-server-path /abs/path/insrc-mcp-server.js
 *
 *   2. Scripted-agent dry-run (debugging / CI without claude):
 *        insrc handoff \
 *          --template DEBUG-SESSION \
 *          --intent "fix" \
 *          --repo /path/to/repo \
 *          --agent scripted-agent \
 *          --scripted-deliverable /path/to/fake-deliverable.md
 *
 * Exit codes:
 *   0  audit verdict = accept
 *   1  audit verdict = revise-edits
 *   2  audit verdict = revise-major
 *   3  CLI usage error (missing required flag / unknown template)
 *   4  spawn / orchestration error
 */

import type { Command } from 'commander';
import { readFileSync } from 'node:fs';

import { runHandoff, type AgentChoice, type ScriptedAgentFn } from '../../handoff/index.js';
import type { TemplateId, ScopePayload, MemoryRef } from '../../handoff/types.js';
import { findTemplate } from '../../handoff/templates/registry.js';

export interface HandoffCliOpts {
	readonly template:    string;
	readonly intent:      string;
	readonly repo:        string;
	readonly agent:       string;
	readonly mcpServerPath?:        string;
	readonly persistRoot?:          string;
	readonly sessionId?:             string;
	readonly scriptedDeliverable?:  string;
	readonly inScope?:              string;
	readonly outOfScope?:            string;
	readonly failingTest?:           string;
	readonly forceCleanup?:          boolean;
	readonly claudeBinPath?:         string;
}

export interface CliIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
}

/**
 * Public test seam: the command logic as an injectable function. Returns
 * the same exit code the Commander action emits.
 */
export async function runHandoffCli(opts: HandoffCliOpts, io: CliIo): Promise<number> {
	// 1. Validate the template id.
	if (findTemplate(opts.template as TemplateId) === undefined) {
		io.stderr(`error: unknown template '${opts.template}'.\n`);
		return 3;
	}

	// 2. Validate / build the agent choice.
	if (opts.agent !== 'claude-code' && opts.agent !== 'codex' && opts.agent !== 'scripted-agent') {
		io.stderr(`error: unknown agent '${opts.agent}'. Supported: claude-code, codex, scripted-agent.\n`);
		return 3;
	}

	let scriptedAgent: ScriptedAgentFn | undefined;
	if (opts.agent === 'scripted-agent') {
		if (opts.scriptedDeliverable === undefined) {
			io.stderr("error: --agent scripted-agent requires --scripted-deliverable <path>\n");
			return 3;
		}
		let body: string;
		try {
			body = readFileSync(opts.scriptedDeliverable, 'utf8');
		} catch (err) {
			io.stderr(`error: cannot read --scripted-deliverable '${opts.scriptedDeliverable}': ${(err as Error).message}\n`);
			return 3;
		}
		scriptedAgent = async () => ({ stdout: body, stderr: '', exitCode: 0, durationMs: 0 });
	}

	// 3. Build the scope payload from --repo (+ optional --in-scope / --out-of-scope).
	const scope: ScopePayload = {
		repoId:          opts.repo,
		repoPath:        opts.repo,
		inScopeGlobs:    splitList(opts.inScope ?? '**'),
		outOfScopePaths: splitList(opts.outOfScope ?? ''),
		riskHints:       'low',
	};
	const memoryRefs: readonly MemoryRef[] = [];

	const sessionId = opts.sessionId ?? `cli-${Date.now()}`;
	const templateExtras: Record<string, unknown> = {};
	if (opts.failingTest !== undefined) templateExtras['failingTest'] = opts.failingTest;

	// 4. Run.
	try {
		const result = await runHandoff({
			templateId:     opts.template as TemplateId,
			intent:         opts.intent,
			scope,
			memoryRefs,
			agent:          opts.agent as AgentChoice,
			templateExtras,
			...(opts.mcpServerPath !== undefined ? { mcpServerPath: opts.mcpServerPath } : {}),
			...(opts.persistRoot   !== undefined ? { persistRoot:   opts.persistRoot   } : {}),
			sessionId,
			...(opts.claudeBinPath !== undefined ? { claudeBinPath: opts.claudeBinPath } : {}),
			...(opts.forceCleanup  === true      ? { forceCleanup:  true            } : {}),
			...(scriptedAgent      !== undefined ? { scriptedAgent }                : {}),
		});

		// 5. Render summary + diff to stdout.
		io.stdout(`spec id:        ${result.spec.specId}\n`);
		io.stdout(`template:       ${result.spec.templateId}\n`);
		io.stdout(`worktree:       ${result.worktreePath}\n`);
		io.stdout(`spawn exit:     ${result.spawnResult.exitCode}\n`);
		io.stdout(`audit verdict:  ${result.audit.verdict}\n`);
		io.stdout(`reason:         ${result.audit.reason}\n`);
		if (result.audit.editHints.length > 0) {
			io.stdout('edit hints:\n');
			for (const h of result.audit.editHints) io.stdout(`  - ${h}\n`);
		}
		if (result.diff.length > 0) {
			io.stdout(`\ndiff:\n${result.diff}\n`);
		} else {
			io.stdout('\ndiff: (worktree unchanged)\n');
		}

		switch (result.audit.verdict) {
			case 'accept':       return 0;
			case 'revise-edits': return 1;
			case 'revise-major': return 2;
		}
	} catch (err) {
		io.stderr(`error: handoff failed: ${(err as Error).message}\n`);
		return 4;
	}
}

function splitList(s: string): string[] {
	if (s.length === 0) return [];
	return s.split(',').map(p => p.trim()).filter(p => p.length > 0);
}

export function registerHandoffCommands(program: Command): void {
	program
		.command('handoff')
		.description('Run a handoff: spec assembly + worktree + agent spawn + audit + diff')
		.requiredOption('--template <id>',                 'template id (e.g. DEBUG-SESSION)')
		.requiredOption('--intent <text>',                 'user intent in one sentence')
		.requiredOption('--repo <path>',                   'absolute path to the source repo')
		.requiredOption('--agent <name>',                  'one of: claude-code | codex | scripted-agent')
		.option('--mcp-server-path <path>',                'absolute path to insrc-mcp-server.js (default: /abs/path/...)')
		.option('--persist-root <dir>',                    'override the per-session persistence root (~/.insrc/handoffs)')
		.option('--session-id <id>',                       "session id; default 'cli-<ts>'")
		.option('--scripted-deliverable <path>',           "for --agent scripted-agent: path to a markdown file used as the agent's stdout")
		.option('--in-scope <globs>',                      "comma-separated globs the agent may read/edit (default '**')")
		.option('--out-of-scope <paths>',                  'comma-separated paths the agent MUST NOT modify')
		.option('--failing-test <name>',                   'optional DEBUG-SESSION extras: the failing test name')
		.option('--claude-bin-path <path>',                'test seam: override the claude binary path')
		.option('--force-cleanup',                         'remove the worktree on completion (default: keep)')
		.action(async (opts: HandoffCliOpts) => {
			const code = await runHandoffCli(opts, {
				stdout: s => process.stdout.write(s),
				stderr: s => process.stderr.write(s),
			});
			process.exit(code);
		});
}
