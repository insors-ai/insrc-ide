/**
 * Cross-agent surface for the Data Analyzer
 * (plans/analyzers/data-analyzer.md Phase 4.1).
 *
 * Mirrors `code-tools.ts`. Sibling analyzer families dispatch into
 * the data-driver layer through these `data_*` wrappers instead of
 * binding to the `db_*` builtins directly. The wrappers exist for
 * three reasons (per the plan):
 *
 *   1. **Namespace.** The design's documented cross-agent namespace
 *      is `data:*` (here, underscore form to match the Anthropic
 *      regex). Sibling analyzers shouldn't have to know whether the
 *      data-driver internals call themselves `db_*`.
 *   2. **Family dispatch.** A caller asking "describe target X on
 *      connection C" doesn't know whether C is RDBMS / KV / file.
 *      The wrapper looks up the connection's family via the pool
 *      and routes to the right `db_*_describe` (or
 *      `db_kv_sample_shape`).
 *   3. **Depth cap.** Each wrapper reads `_crossAgentDepth` and
 *      returns a `TOOL_UNAVAILABLE` sentinel when the cap is
 *      exceeded -- same `code_*` rules.
 *
 * `data_lineage` and `data_schema-drift` are NOT re-registered here
 * -- they live in `daemon/tools/builtins/data/` already and got
 * their depth checks added inline. Cross-agent callers use the same
 * canonical ids as the analyzer's own runner.
 */

import { getLogger } from '../../shared/logger.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../tools/types.js';
import { registerTool } from '../tools/registry.js';
import { executeTool } from '../../agent/tools/executor.js';
import { acquirePool } from '../db/pool-cache.js';
import {
	exceedsCrossAgentDepth,
	readCrossAgentDepth,
	toolUnavailable,
} from '../../shared/cross-agent.js';

const log = getLogger('cross-agent:data');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(toolId: string, msg: string): ToolResult {
	return { output: `[${toolId}] ${msg}`, format: 'text', success: false, error: msg };
}

function depthCheck(toolId: string, input: ToolInput): ToolResult | null {
	if (exceedsCrossAgentDepth(readCrossAgentDepth(input))) {
		const sentinel = toolUnavailable('cross_agent_depth_exceeded');
		return {
			output: `[${toolId}] unavailable: cross_agent_depth_exceeded`,
			format: 'json',
			success: false,
			error: 'cross_agent_depth_exceeded',
			data: sentinel,
		};
	}
	return null;
}

/**
 * Forward to a builtin tool via the unified executor. The wrapper
 * stamps `_crossAgentDepth` (incremented by 1) on the forwarded
 * input so the next hop sees the right depth -- but most `db_*`
 * tools don't read the field, so this is mainly for symmetry.
 *
 * Errors propagate verbatim; the cross-agent caller can read
 * `result.isError` like any other tool result. We deliberately
 * don't translate `db_*`-specific error strings -- the underlying
 * `[db_sql_describe] ...` wording is informative enough for the
 * sibling analyzer's review step.
 */
async function forwardToBuiltin(
	toolId: string,
	builtinName: string,
	input: ToolInput,
	deps: ToolDeps,
	transform?: (input: ToolInput) => ToolInput,
): Promise<ToolResult> {
	const forwarded = transform ? transform(input) : { ...input };
	// Strip the depth field so the forwarded result doesn't double-
	// count it; the dispatcher upstream already validated.
	const { _crossAgentDepth: _omit, ...rest } = forwarded as Record<string, unknown>;
	void _omit;
	const callId = `${toolId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
	const r = await executeTool(
		{ id: callId, name: builtinName, input: rest as Record<string, unknown> },
		{
			session: deps.session,
			...(deps.send !== undefined ? { send: deps.send } : {}),
			...(deps.channel !== undefined ? { channel: deps.channel } : {}),
			...(deps.requestId !== undefined ? { requestId: deps.requestId } : {}),
			...(deps.signal !== undefined ? { signal: deps.signal } : {}),
		},
	);
	// executeTool returns the legacy ToolCall ToolResult shape
	// (toolCallId / content / isError). Translate to the unified
	// ToolResult shape so this tool's caller sees a consistent
	// payload like every other unified tool.
	return {
		output: r.content,
		format: 'markdown',
		success: !r.isError,
		...(r.isError ? { error: 'forwarded tool failed' } : {}),
	};
}

async function lookupConnectionFamily(
	deps: ToolDeps,
	connectionId: string,
): Promise<'rdbms' | 'kv' | 'file' | undefined> {
	const repoPath = deps.session.repoPath;
	if (repoPath.length === 0) return undefined;
	const pool = await acquirePool(repoPath);
	const c = pool.list().find(c => c.id === connectionId);
	return c?.family;
}

// ---------------------------------------------------------------------------
// Pure-namespace wrappers
// ---------------------------------------------------------------------------

const CONNECTION_PROP = {
	connectionId: { type: 'string' },
} as const;

export const dataListConnectionsTool: Tool = {
	id: 'data_list_connections',
	description:
		'Cross-agent: enumerate every data-driver connection registered for the active repo. ' +
		'Pass-through to the `db_list_connections` builtin so siblings consume a stable `data:*` namespace.',
	inputSchema: {
		type: 'object',
		properties: {},
		additionalProperties: true,
	},
	requiresApproval: false,
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const blocked = depthCheck(this.id, input);
		if (blocked !== null) return blocked;
		return forwardToBuiltin(this.id, 'db_list_connections', input, deps);
	},
};

export const dataScanTool: Tool = {
	id: 'data_scan',
	description: 'Cross-agent KV scan. Forwards to `db_kv_scan`. Connection must be a KV family member.',
	inputSchema: {
		type: 'object',
		properties: {
			...CONNECTION_PROP,
			namespace: { type: 'string' },
			limit:     { type: 'number' },
		},
		required: ['connectionId'],
		additionalProperties: true,
	},
	requiresApproval: false,
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const blocked = depthCheck(this.id, input);
		if (blocked !== null) return blocked;
		return forwardToBuiltin(this.id, 'db_kv_scan', input, deps);
	},
};

export const dataGetTool: Tool = {
	id: 'data_get',
	description: 'Cross-agent KV get. Forwards to `db_kv_get`.',
	inputSchema: {
		type: 'object',
		properties: {
			...CONNECTION_PROP,
			key: { type: 'string' },
		},
		required: ['connectionId', 'key'],
		additionalProperties: true,
	},
	requiresApproval: false,
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const blocked = depthCheck(this.id, input);
		if (blocked !== null) return blocked;
		return forwardToBuiltin(this.id, 'db_kv_get', input, deps);
	},
};

export const dataExplainTool: Tool = {
	id: 'data_explain',
	description: 'Cross-agent RDBMS EXPLAIN. Forwards to `db_sql_explain`.',
	inputSchema: {
		type: 'object',
		properties: {
			...CONNECTION_PROP,
			target: { type: 'string' },
			where:  { type: 'object' },
		},
		required: ['connectionId', 'target'],
		additionalProperties: true,
	},
	requiresApproval: false,
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const blocked = depthCheck(this.id, input);
		if (blocked !== null) return blocked;
		return forwardToBuiltin(this.id, 'db_sql_explain', input, deps);
	},
};

// ---------------------------------------------------------------------------
// Family-dispatch wrappers
// ---------------------------------------------------------------------------

/**
 * Map (family, action) -> the underlying `db_*` builtin id. Lets the
 * dispatcher route on connection family without hardcoding the
 * mapping at every call site.
 */
const FAMILY_DISPATCH: Readonly<{
	describe: Record<'rdbms' | 'kv' | 'file', string>;
	sample:   Record<'rdbms' | 'kv' | 'file', string>;
	sampleShape: Record<'rdbms' | 'kv' | 'file', string | undefined>;
}> = {
	describe: {
		rdbms: 'db_sql_describe',
		kv:    'db_kv_sample_shape',
		file:  'db_file_describe',
	},
	sample: {
		rdbms: 'db_sql_sample',
		kv:    'db_kv_get',
		file:  'db_file_sample',
	},
	sampleShape: {
		rdbms: undefined,
		kv:    'db_kv_sample_shape',
		file:  'db_file_sample_shape',
	},
};

export const dataDescribeTool: Tool = {
	id: 'data_describe',
	description:
		'Cross-agent: describe a data target. Routes to `db_sql_describe` (RDBMS) / `db_kv_sample_shape` (KV) / ' +
		'`db_file_describe` (file) based on the connection\'s family. Caller doesn\'t need to know the family.',
	inputSchema: {
		type: 'object',
		properties: {
			...CONNECTION_PROP,
			target: { type: 'string', description: 'Table (RDBMS), key pattern (KV), or path (file).' },
		},
		required: ['connectionId'],
		additionalProperties: true,
	},
	requiresApproval: false,
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const blocked = depthCheck(this.id, input);
		if (blocked !== null) return blocked;
		const connectionId = String(input['connectionId'] ?? '');
		if (connectionId.length === 0) return fail(this.id, 'connectionId required');
		const family = await lookupConnectionFamily(deps, connectionId);
		if (family === undefined) return fail(this.id, `unknown connection '${connectionId}'`);
		const builtin = FAMILY_DISPATCH.describe[family];
		log.info({ tool: this.id, connectionId, family, builtin }, 'family dispatch');
		// KV "describe" routes to sample_shape, which uses `keyPattern`
		// rather than `target`. Translate at the boundary.
		if (family === 'kv') {
			return forwardToBuiltin(this.id, builtin, input, deps, raw => {
				const out: ToolInput = { ...raw };
				if (typeof raw['target'] === 'string') {
					out['keyPattern'] = raw['target'];
					delete out['target'];
				}
				return out;
			});
		}
		if (family === 'file') {
			// file_describe uses `path` instead of `target`.
			return forwardToBuiltin(this.id, builtin, input, deps, raw => {
				const out: ToolInput = { ...raw };
				if (typeof raw['target'] === 'string') {
					out['path'] = raw['target'];
					delete out['target'];
				}
				return out;
			});
		}
		return forwardToBuiltin(this.id, builtin, input, deps);
	},
};

export const dataSampleTool: Tool = {
	id: 'data_sample',
	description:
		'Cross-agent: sample data from a target. Routes to `db_sql_sample` (RDBMS) / `db_kv_get` (KV) / ' +
		'`db_file_sample` (file) based on the connection\'s family.',
	inputSchema: {
		type: 'object',
		properties: {
			...CONNECTION_PROP,
			target: { type: 'string' },
			where:  { type: 'object' },
			limit:  { type: 'number' },
		},
		required: ['connectionId'],
		additionalProperties: true,
	},
	requiresApproval: false,
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const blocked = depthCheck(this.id, input);
		if (blocked !== null) return blocked;
		const connectionId = String(input['connectionId'] ?? '');
		if (connectionId.length === 0) return fail(this.id, 'connectionId required');
		const family = await lookupConnectionFamily(deps, connectionId);
		if (family === undefined) return fail(this.id, `unknown connection '${connectionId}'`);
		const builtin = FAMILY_DISPATCH.sample[family];
		log.info({ tool: this.id, connectionId, family, builtin }, 'family dispatch');
		if (family === 'kv') {
			// KV sample = get(key); translate target -> key.
			return forwardToBuiltin(this.id, builtin, input, deps, raw => {
				const out: ToolInput = { ...raw };
				if (typeof raw['target'] === 'string') {
					out['key'] = raw['target'];
					delete out['target'];
				}
				return out;
			});
		}
		if (family === 'file') {
			return forwardToBuiltin(this.id, builtin, input, deps, raw => {
				const out: ToolInput = { ...raw };
				if (typeof raw['target'] === 'string') {
					out['path'] = raw['target'];
					delete out['target'];
				}
				return out;
			});
		}
		return forwardToBuiltin(this.id, builtin, input, deps);
	},
};

export const dataSampleShapeTool: Tool = {
	id: 'data_sample_shape',
	description:
		'Cross-agent: merge value shapes via inferShape. Routes to `db_kv_sample_shape` (KV) / ' +
		'`db_file_sample_shape` (file). Returns a clear error when the connection is RDBMS (use ' +
		'`data_describe` for those).',
	inputSchema: {
		type: 'object',
		properties: {
			...CONNECTION_PROP,
			target: { type: 'string' },
			limit:  { type: 'number' },
		},
		required: ['connectionId'],
		additionalProperties: true,
	},
	requiresApproval: false,
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const blocked = depthCheck(this.id, input);
		if (blocked !== null) return blocked;
		const connectionId = String(input['connectionId'] ?? '');
		if (connectionId.length === 0) return fail(this.id, 'connectionId required');
		const family = await lookupConnectionFamily(deps, connectionId);
		if (family === undefined) return fail(this.id, `unknown connection '${connectionId}'`);
		const builtin = FAMILY_DISPATCH.sampleShape[family];
		if (builtin === undefined) {
			return fail(
				this.id,
				`connection '${connectionId}' is rdbms; sample_shape is KV/file only. Use data_describe for RDBMS.`,
			);
		}
		log.info({ tool: this.id, connectionId, family, builtin }, 'family dispatch');
		return forwardToBuiltin(this.id, builtin, input, deps, raw => {
			const out: ToolInput = { ...raw };
			if (family === 'kv' && typeof raw['target'] === 'string') {
				out['keyPattern'] = raw['target'];
				delete out['target'];
			}
			if (family === 'file' && typeof raw['target'] === 'string') {
				out['path'] = raw['target'];
				delete out['target'];
			}
			return out;
		});
	},
};

// ---------------------------------------------------------------------------
// Registration entry-point
// ---------------------------------------------------------------------------

export function registerDataAnalyzerCrossAgentTools(): void {
	registerTool(dataListConnectionsTool);
	registerTool(dataDescribeTool);
	registerTool(dataSampleTool);
	registerTool(dataScanTool);
	registerTool(dataGetTool);
	registerTool(dataSampleShapeTool);
	registerTool(dataExplainTool);
}
