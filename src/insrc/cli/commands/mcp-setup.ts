/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc mcp-setup <agent>` -- writes the insrc MCP server registration
 * into the external agent's config file (Claude Code or Codex).
 *
 * After this runs, restarting the agent will surface the insrc tool
 * surface (insrc_entity_*, insrc_artifact_*, insrc_memory_*,
 * insrc_repo_*, insrc_spec_*) automatically. Tools whose handlers are
 * still stubbed (Phase 1.x) return structured errors; the agent can
 * still see them in tools/list and judge their usability.
 *
 * Usage:
 *   insrc mcp-setup claude-code [--dry-run] [--server-path <abs-path>]
 *   insrc mcp-setup codex       [--dry-run] [--server-path <abs-path>]
 *
 * `--dry-run` prints the config block that WOULD be written and
 * exits without touching the file. Useful for review before applying.
 *
 * `--server-path` overrides the auto-detected absolute path to the
 * compiled insrc-mcp-server entry. By default we infer it from
 * `__filename` (cli/commands/mcp-setup.js -> ../../mcp/server.js).
 */

import type { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `os.homedir()` on macOS does NOT honor the HOME env var (it goes
 * through getpwuid). Tests that point HOME at a tmp dir need the
 * env-first path. Production callers fall through to homedir().
 */
function userHome(): string {
	const env = process.env['HOME'];
	if (env !== undefined && env.length > 0) return env;
	return homedir();
}

export type ExternalAgent = 'claude-code' | 'codex';

export interface McpSetupOpts {
	readonly dryRun?:     boolean;
	readonly serverPath?: string;
}

export interface McpSetupResult {
	readonly agent:        ExternalAgent;
	readonly configPath:   string;
	readonly serverPath:   string;
	/** The contents that were (or would be) written to configPath. */
	readonly configBlock:  string;
	readonly action:       'created' | 'merged' | 'updated' | 'unchanged' | 'dry-run';
}

/**
 * Resolve the absolute path to the compiled MCP server entry. Order:
 *   1. caller-supplied `serverPathOverride`
 *   2. INSRC_MCP_SERVER_PATH env var (escape hatch for non-standard layouts)
 *   3. inferred from this file's __filename: ../../mcp/server.js
 *      (post-build cli/commands/mcp-setup.js -> mcp/server.js).
 */
export function resolveMcpServerPath(serverPathOverride?: string): string {
	if (serverPathOverride !== undefined && serverPathOverride.length > 0) {
		return resolve(serverPathOverride);
	}
	const fromEnv = process.env['INSRC_MCP_SERVER_PATH'];
	if (fromEnv !== undefined && fromEnv.length > 0) {
		return resolve(fromEnv);
	}
	const here = fileURLToPath(import.meta.url);
	// __dirname = .../cli/commands ; server.js = ../../mcp/server.js
	// During dev (tsx + .ts source) we'd point at the .ts file, which
	// `node` can't run; users running mcp-setup in dev should pass
	// --server-path explicitly. Post-build (tsc output) the inferred
	// path is correct.
	return resolve(dirname(here), '..', '..', 'mcp', 'server.js');
}

// ---------------------------------------------------------------------------
// Claude Code (JSON settings.json)
// ---------------------------------------------------------------------------

interface ClaudeMcpEntry {
	readonly command: string;
	readonly args:    string[];
}

interface ClaudeSettings {
	mcpServers?: Record<string, ClaudeMcpEntry>;
	[k: string]: unknown;
}

function claudeSettingsPath(): string {
	return join(userHome(), '.claude', 'settings.json');
}

function writeClaudeConfig(serverPath: string, dryRun: boolean): McpSetupResult {
	const targetPath = claudeSettingsPath();
	const insrcEntry: ClaudeMcpEntry = {
		command: 'node',
		args:    [serverPath],
	};

	if (dryRun) {
		const preview = JSON.stringify({ mcpServers: { insrc: insrcEntry } }, null, 2);
		return { agent: 'claude-code', configPath: targetPath, serverPath, configBlock: preview, action: 'dry-run' };
	}

	let settings: ClaudeSettings = {};
	let action: McpSetupResult['action'] = 'created';

	if (existsSync(targetPath)) {
		try {
			const existing = readFileSync(targetPath, 'utf8');
			settings = JSON.parse(existing) as ClaudeSettings;
			const prior = settings.mcpServers?.['insrc'];
			if (prior !== undefined
				&& prior.command === insrcEntry.command
				&& JSON.stringify(prior.args) === JSON.stringify(insrcEntry.args)) {
				return {
					agent: 'claude-code', configPath: targetPath, serverPath,
					configBlock: JSON.stringify(prior, null, 2), action: 'unchanged',
				};
			}
			action = prior === undefined ? 'merged' : 'updated';
		} catch (err) {
			throw new Error(`failed to read existing Claude Code settings at ${targetPath}: ${(err as Error).message}`);
		}
	}

	settings.mcpServers = { ...(settings.mcpServers ?? {}), insrc: insrcEntry };
	const dir = dirname(targetPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(targetPath, JSON.stringify(settings, null, 2));
	return {
		agent: 'claude-code', configPath: targetPath, serverPath,
		configBlock: JSON.stringify(settings.mcpServers['insrc'], null, 2),
		action,
	};
}

// ---------------------------------------------------------------------------
// Codex (TOML config.toml)
// ---------------------------------------------------------------------------

function codexConfigPath(): string {
	return join(userHome(), '.codex', 'config.toml');
}

/**
 * Inline TOML generation (no TOML library dependency, per design §2.5
 * decision). The block is small and stable; if Codex's config schema
 * ever grows, swap in `@iarna/toml` or similar.
 */
function buildCodexTomlBlock(serverPath: string): string {
	const escaped = serverPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return [
		'[mcp_servers.insrc]',
		`command = "node"`,
		`args = ["${escaped}"]`,
		`env_vars = ["INSRC_SESSION_TOKEN", "INSRC_DAEMON_SOCKET", "INSRC_SPEC_ID"]`,
		'',
	].join('\n');
}

function writeCodexConfig(serverPath: string, dryRun: boolean): McpSetupResult {
	const targetPath = codexConfigPath();
	const block      = buildCodexTomlBlock(serverPath);

	if (dryRun) {
		return { agent: 'codex', configPath: targetPath, serverPath, configBlock: block, action: 'dry-run' };
	}

	let action: McpSetupResult['action'] = 'created';
	let next: string;

	if (existsSync(targetPath)) {
		const existing = readFileSync(targetPath, 'utf8');
		// Strip an existing `[mcp_servers.insrc]` block (and its body
		// up to the next TOML section header) if present. Line-based
		// to keep the parser-free policy honest: JS regex lacks `\Z`,
		// and `$` under /m matches every line end, so anything fancier
		// here is fragile.
		const lines = existing.split('\n');
		const kept: string[] = [];
		let inInsrcBlock = false;
		let hadBlock     = false;
		for (const line of lines) {
			const trimmed = line.trimStart();
			if (trimmed.startsWith('[mcp_servers.insrc]')) {
				inInsrcBlock = true;
				hadBlock     = true;
				continue;
			}
			if (inInsrcBlock && trimmed.startsWith('[')) {
				inInsrcBlock = false;
			}
			if (!inInsrcBlock) kept.push(line);
		}
		const trimmedTail = kept.join('\n').replace(/\n*$/, '');
		next   = trimmedTail.length === 0 ? block : trimmedTail + '\n\n' + block;
		action = hadBlock ? (next === existing ? 'unchanged' : 'updated') : 'merged';
	} else {
		next = block;
	}

	const dir = dirname(targetPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(targetPath, next);
	return { agent: 'codex', configPath: targetPath, serverPath, configBlock: block, action };
}

// ---------------------------------------------------------------------------
// Entry point + Commander wiring
// ---------------------------------------------------------------------------

/**
 * Public test seam. Returns the result rather than process.exit-ing so
 * the unit tests can assert on action + configBlock.
 */
export function runMcpSetup(agent: ExternalAgent, opts: McpSetupOpts = {}): McpSetupResult {
	const serverPath = resolveMcpServerPath(opts.serverPath);
	const dryRun     = opts.dryRun === true;
	switch (agent) {
		case 'claude-code': return writeClaudeConfig(serverPath, dryRun);
		case 'codex':       return writeCodexConfig(serverPath, dryRun);
	}
}

export function registerMcpSetupCommands(program: Command): void {
	const mcp = program
		.command('mcp-setup <agent>')
		.description('register the insrc MCP server with an external coding agent (claude-code | codex)')
		.option('--dry-run',          'print the config block that would be written; do not touch the file')
		.option('--server-path <p>',  'override the inferred absolute path to insrc-mcp-server')
		.action((agentArg: string, opts: { dryRun?: boolean; serverPath?: string }) => {
			if (agentArg !== 'claude-code' && agentArg !== 'codex') {
				process.stderr.write(`error: unknown agent '${agentArg}'. Supported: claude-code, codex.\n`);
				process.exit(2);
			}
			const runOpts: McpSetupOpts = {
				...(opts.dryRun === true ? { dryRun: true } : {}),
				...(opts.serverPath !== undefined ? { serverPath: opts.serverPath } : {}),
			};
			const result = runMcpSetup(agentArg, runOpts);
			process.stdout.write(`agent:        ${result.agent}\n`);
			process.stdout.write(`config path:  ${result.configPath}\n`);
			process.stdout.write(`server path:  ${result.serverPath}\n`);
			process.stdout.write(`action:       ${result.action}\n`);
			process.stdout.write(`config block:\n${result.configBlock}\n`);
		});
	void mcp;
}
