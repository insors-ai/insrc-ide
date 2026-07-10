/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Insrc MCP server.
 *
 * Exposes the analyze framework as an MCP tool surface so Claude
 * Code / Codex CLI (or any spec-conformant MCP client) can invoke
 * the deterministic exploration + synthesizer pipeline over the
 * `insrc_analyze` tool.
 *
 * The server runs IN PROCESS: it links the analyze module directly,
 * reads from the same LMDB the main daemon writes to, and threads
 * the calling client's `sampling/createMessage` capability through
 * to the shaper factory via a request-scoped
 * `runWithSamplerContext` scope. That means:
 *
 *   - No inner `claude --print` subprocess spawn (which would nest
 *     Claude inside Claude). The outer client's LLM session powers
 *     every inner analyze call.
 *   - No RPC bridge to the main daemon for LLM work; the analyze
 *     pipeline runs where the tool call arrives.
 *
 * The client's capability declaration at initialize decides which
 * path drives inner LLM calls:
 *
 *   - Client declares `sampling` -> use MCP sampling
 *   - Client doesn't declare sampling -> fall back to
 *     `AnalyzeConfig.shaperProvider` (subprocess CliProvider or
 *     Ollama). This lets the same binary work with clients that
 *     don't yet support sampling.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { buildRun } from '../daemon/analyze-rpc.js';
import { runWithSamplerContext } from '../analyze/context/shaper-provider.js';
import { getLogger } from '../shared/logger.js';

import { renderBundleAsMarkdown } from './bundle-md.js';
import { makeSamplerFromMcpServer } from './sampling-bridge.js';

const log = getLogger('mcp:server');

const SERVER_INFO = {
	name:    'insrc-analyze',
	version: '0.1.0',
} as const;

// ---------------------------------------------------------------------------
// Tool input schema (zod)
// ---------------------------------------------------------------------------

/**
 * Input schema for `insrc_analyze`. Kept small on purpose -- most
 * runs need only `focus` + an inferred repo. Extra knobs
 * (`target`, `scope`, `answerType`) exist so a caller who knows
 * they want a specific recipe can bypass the classifier's inference.
 */
const ANALYZE_INPUT = {
	repo: z.string()
		.describe(
			'Absolute path (or registered repo name) the analyze framework ' +
			'should operate on. Must match a repo previously registered via ' +
			'`insrc repo add`. If unset, the daemon\'s default repo (from ' +
			'`INSRC_REPO` env / config) is used; when neither is set, the ' +
			'call fails with a repo-not-found error listing every registered ' +
			'repo.',
		)
		.optional(),
	focus: z.string()
		.min(1)
		.describe(
			'One-line natural-language framing of what to analyze. E.g. ' +
			'"map the payable extraction module", "does the CLAUDE.md Haiku ' +
			'rule hold?", or "list every registered data source". The ' +
			'framework\'s classifier turns this into a structured intent + ' +
			'picks a deterministic recipe.',
		),
	target: z.enum(['code', 'docs', 'data', 'infra', 'generic'])
		.describe(
			'Optional target hint. Skip the classifier\'s target inference ' +
			'when the caller already knows.',
		)
		.optional(),
	scope: z.enum(['XS', 'S', 'M', 'L', 'XL'])
		.describe(
			'Optional scope bucket. XS = single symbol; XL = entire ' +
			'workspace. Larger scopes take longer and produce bigger ' +
			'bundles. Defaults are computed from the intent.',
		)
		.optional(),
};

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Build the MCP server + register every tool. The caller connects
 * whatever transport it wants (stdio by default; tests use
 * `InMemoryTransport`).
 */
export function buildInsrcMcpServer(): McpServer {
	const server = new McpServer(SERVER_INFO, {
		capabilities: {
			tools:     {},
			resources: {},
			// We do not declare `sampling` -- that's a CLIENT capability;
			// the server merely uses it when the client declares it.
		},
	});

	server.registerTool(
		'insrc_analyze',
		{
			title: 'insrc analyze',
			description:
				'ALWAYS call this tool FIRST when the user asks about a ' +
				'repository\'s code structure, conventions, adherence to ' +
				'rules, existing capabilities, or design decisions. Runs the ' +
				'insrc analyze framework which walks the indexed code graph + ' +
				'emits a verified, citation-grounded 7-layer bundle (system, ' +
				'focus, summary, structure, surface, artefacts, upstream). ' +
				'Deterministic and cited -- MORE accurate than manual ' +
				'grep + read for context questions.\n\n' +
				'Prefer this over Read/Grep/Glob for:\n' +
				'  - "map / explore <module>"\n' +
				'  - "does the codebase already do <X>?"\n' +
				'  - "how does <Y> work?"\n' +
				'  - "does the code follow <rule> from <doc>?"\n' +
				'  - "what conventions does <module> follow?"\n' +
				'  - "list every registered <data source | infra manifest>"\n' +
				'  - Any question where you\'d otherwise grep + read to answer.\n\n' +
				'Call again with a narrower `focus` to drill down. Fall back ' +
				'to Read/Grep/Glob only when this tool returns an empty or ' +
				'clearly off-topic bundle. When the client supports MCP ' +
				'sampling, inner LLM calls (decomposer, synthesizer, narrow-' +
				'LLM explorations) route back to the client\'s own model in ' +
				'the same session; otherwise the daemon\'s configured ' +
				'shaperProvider handles them.',
			annotations: {
				readOnlyHint:   true,
				idempotentHint: false,   // running twice can pick a new plan; not idempotent
				openWorldHint:  false,   // scope is the indexed repo, not the open web
			},
			inputSchema: ANALYZE_INPUT,
		},
		async (rawArgs, _extra) => {
			const args = rawArgs as {
				repo?:   string;
				focus:   string;
				target?: 'code' | 'docs' | 'data' | 'infra' | 'generic';
				scope?:  'XS' | 'S' | 'M' | 'L' | 'XL';
			};
			return handleAnalyze(server, args);
		},
	);

	return server;
}

/**
 * Wire the built server to stdio + block until the transport
 * closes. Used by `bin/insrc-mcp`.
 */
export async function runInsrcMcpStdio(): Promise<void> {
	const server = buildInsrcMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info({}, 'insrc-mcp: stdio server connected');
	// The transport will keep the process alive until stdin closes.
}

// ---------------------------------------------------------------------------
// insrc_analyze handler
// ---------------------------------------------------------------------------

async function handleAnalyze(
	server: McpServer,
	args:   {
		repo?:   string;
		focus:   string;
		target?: 'code' | 'docs' | 'data' | 'infra' | 'generic';
		scope?:  'XS' | 'S' | 'M' | 'L' | 'XL';
	},
): Promise<{
	content:  { type: 'text'; text: string }[];
	isError?: boolean;
}> {
	// Resolve the repo path. Explicit param > INSRC_REPO env > fail.
	const repoPath = resolveRepoPath(args.repo);
	if (repoPath === undefined) {
		return errorResult(
			'no repo -- pass the `repo` param or set INSRC_REPO in the ' +
			'MCP server\'s environment. The insrc daemon must have this repo ' +
			'registered (see `insrc repo add`).',
		);
	}

	// Assemble the intent. This mirrors the shape the daemon's
	// `analyze.context.buildRun` RPC accepts (see daemon/analyze-rpc.ts).
	const runId  = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const intent = {
		target:    args.target ?? 'code',
		scope:     args.scope ?? 'M',
		focused:   true,
		focus:     args.focus,
		scopeRef:  { kind: 'workspace', value: repoPath },
		reasoning: `MCP invocation: ${args.focus}`,
	};

	// Sampling handoff: if the client declared `sampling`, thread the
	// callback through the analyze pipeline via runWithSamplerContext.
	// If it didn't, the analyze factory falls back to the daemon's
	// shaperProvider config -- CliProvider subprocess or Ollama.
	const clientCaps = server.server.getClientCapabilities();
	const samplingSupported = clientCaps?.sampling !== undefined;

	log.info(
		{
			runId,
			repoPath,
			target: intent.target,
			scope:  intent.scope,
			focus:  intent.focus.slice(0, 80),
			samplingSupported,
		},
		'insrc_analyze: dispatching',
	);

	const rpcParams = { runId, intent };
	const rpc = samplingSupported
		? runWithSamplerContext(
			makeSamplerFromMcpServer(server.server),
			[],
			() => buildRun(rpcParams),
		)
		: buildRun(rpcParams);

	const result = await rpc;
	if (!result.ok) {
		return errorResult(
			`analyze.context.buildRun failed: ${result.error.code} -- ${result.error.message}`,
		);
	}

	const markdown = renderBundleAsMarkdown(result.bundle);
	return {
		content: [{ type: 'text', text: markdown }],
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveRepoPath(explicit: string | undefined): string | undefined {
	if (explicit !== undefined && explicit.length > 0) return explicit;
	const env = process.env['INSRC_REPO'];
	if (env !== undefined && env.length > 0) return env;
	return undefined;
}

function errorResult(message: string): {
	content: { type: 'text'; text: string }[];
	isError: true;
} {
	return {
		content: [{ type: 'text', text: message }],
		isError: true,
	};
}
