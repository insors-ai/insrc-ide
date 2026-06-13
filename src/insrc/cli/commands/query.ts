/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc query` -- CLI front-end to the MCP tool registry.
 *
 * Usage:
 *   insrc query --list
 *       Print the 14 tool descriptors as JSON to stdout.
 *
 *   insrc query --tool <name> --args '<json>'
 *       Invoke the tool with the given JSON args (Zod-validated against
 *       the tool's input schema). Result printed as JSON to stdout.
 *
 *   insrc query --tool <name> --args '<json>' --session-token <token>
 *       Same, but for session-scoped tools (artifact_*, spec_*).
 *
 * Exit codes (per plan §1.3):
 *   0  success
 *   2  unknown tool
 *   3  schema-validation failure
 *   4  tool error (handler returned isError or threw)
 */

import type { Command } from 'commander';
import { z, type ZodRawShape } from 'zod';
import { ALL_TOOLS, findToolByName, invokeTool } from '../../mcp/tool-registry.js';

export interface QueryOpts {
	readonly list?:         boolean;
	readonly tool?:         string;
	readonly args?:         string;
	readonly sessionToken?: string;
}

/** Public test seam: run the query command logic. */
export async function runQuery(opts: QueryOpts, writer: { stdout: (s: string) => void; stderr: (s: string) => void }): Promise<number> {
	if (opts.list) {
		const list = ALL_TOOLS.map(t => ({
			name:        t.name,
			description: t.description,
			scope:       t.scope,
			inputSchema: describeSchema(t.inputSchema),
		}));
		writer.stdout(JSON.stringify({ tools: list, count: list.length }, null, 2));
		return 0;
	}

	if (opts.tool === undefined || opts.tool.length === 0) {
		writer.stderr('error: must pass either --list or --tool <name>\n');
		return 2;
	}

	const tool = findToolByName(opts.tool);
	if (tool === undefined) {
		writer.stderr(`error: unknown tool '${opts.tool}'. Use 'insrc query --list' to see available tools.\n`);
		return 2;
	}

	let parsedArgs: unknown;
	if (opts.args === undefined || opts.args.length === 0) {
		parsedArgs = {};
	} else {
		try {
			parsedArgs = JSON.parse(opts.args);
		} catch (err) {
			writer.stderr(`error: --args is not valid JSON: ${(err as Error).message}\n`);
			return 3;
		}
	}

	const schemaResult = z.object(tool.inputSchema as ZodRawShape).safeParse(parsedArgs);
	if (!schemaResult.success) {
		writer.stderr(`error: --args does not match the input schema for tool '${tool.name}':\n${JSON.stringify(schemaResult.error.format(), null, 2)}\n`);
		return 3;
	}

	const callOpts: { sessionToken?: string } = {};
	if (opts.sessionToken !== undefined) callOpts.sessionToken = opts.sessionToken;
	const result = await invokeTool(tool, schemaResult.data, callOpts);
	writer.stdout(JSON.stringify(result, null, 2));
	return result.isError === true ? 4 : 0;
}

function describeSchema(shape: ZodRawShape): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(shape)) {
		const desc = (v as { description?: string }).description ?? '';
		// Best-effort tag: tell the user which keys are optional.
		const optional = (v as { isOptional?: () => boolean }).isOptional?.() === true;
		out[k] = `${optional ? '(optional) ' : ''}${desc}`;
	}
	return out;
}

export function registerQueryCommands(program: Command): void {
	program
		.command('query')
		.description('list or invoke an insrc MCP tool from the CLI')
		.option('--list',                 'print the available tools as JSON')
		.option('--tool <name>',          'tool name to invoke (e.g. insrc_entity_search)')
		.option('--args <json>',          "JSON-encoded args object (e.g. '{\"query\":\"X\",\"limit\":5}')")
		.option('--session-token <tok>',  'session token for session-scoped tools (artifact_*, spec_*)')
		.action(async (opts: QueryOpts) => {
			const exitCode = await runQuery(opts, {
				stdout: s => process.stdout.write(`${s}\n`),
				stderr: s => process.stderr.write(s),
			});
			process.exit(exitCode);
		});

}
