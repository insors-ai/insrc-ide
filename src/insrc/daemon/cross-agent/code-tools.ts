/**
 * Cross-agent surface for the Code Analyzer
 * (plans/analyzers/code-analyzer.md Phase 3.1).
 *
 * Sibling analyzer families dispatch into the Code Analyzer through
 * these tools instead of invoking the chat path. Per design §13:
 *
 *   - `code_locate`   ~5 s envelope; vector + structural lookup
 *                     for "where is this defined?" questions.
 *   - `code_trace`    ~5 s envelope; CALLS predecessor / successor
 *                     graph walk for "who calls X / what does X
 *                     call?".
 *   - `code_describe` ~5 s envelope; full entity card (signature +
 *                     body + 1-hop neighbours summary).
 *
 * `code_analyze` (Flow-2 entry, 60 s envelope) ships in slice 2 of
 * Phase 3 -- it's the dispatch point that runs a caller-supplied
 * `AnalysisTask[]` through the orchestrator without a plan step or
 * gate.
 *
 * Every handler enforces `crossAgentDepth >= 1` -> `TOOL_UNAVAILABLE`
 * (reason `cross_agent_depth_exceeded`) per design §13.2. The depth
 * counter rides on the input bag via the conventional
 * `_crossAgentDepth` field.
 */

import { getDb } from '../../db/client.js';
import { searchEntities, findCallers, findCallees } from '../../db/search.js';
import { getEntity } from '../../db/entities.js';
import { embedQuery } from '../../indexer/embedder.js';
import { registerTool } from '../tools/registry.js';
import {
	CROSS_AGENT_DEPTH_FIELD,
	exceedsCrossAgentDepth,
	readCrossAgentDepth,
	toolUnavailable,
} from '../../shared/cross-agent.js';
import type { Entity } from '../../shared/types.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(input: ToolInput, key: string): string | undefined {
	const v = input[key];
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(input: ToolInput, key: string): number | undefined {
	const v = input[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function fail(id: string, msg: string): ToolResult {
	return { output: `[${id}] ${msg}`, format: 'text', success: false, error: msg };
}

/**
 * Render a TOOL_UNAVAILABLE sentinel as a ToolResult. Callers
 * downstream (the analyzer's review step) inspect `data` for the
 * sentinel shape rather than parsing the rendered text.
 */
function unavailableResult(id: string, reason: 'cross_agent_depth_exceeded', note?: string): ToolResult {
	const sentinel = toolUnavailable(reason, note);
	return {
		output: `[${id}] unavailable: ${reason}${note ? ` (${note})` : ''}`,
		format: 'json',
		success: false,
		error: reason,
		data: sentinel,
	};
}

function shortEntity(e: Entity): Record<string, unknown> {
	return {
		entityId: e.id,
		name:     e.name,
		kind:     e.kind,
		path:     e.file,
		lineRange: { start: e.startLine, end: e.endLine },
		repo:     e.repo,
		signature: e.signature,
	};
}

function lineLoc(e: Entity): string {
	return `${e.file}:${e.startLine}${e.endLine > e.startLine ? '-' + e.endLine : ''}`;
}

// ---------------------------------------------------------------------------
// code:locate -- vector + entity lookup
// ---------------------------------------------------------------------------

interface CodeLocateData {
	readonly query: string;
	readonly results: ReturnType<typeof shortEntity>[];
}

export const codeLocateTool: Tool = {
	id: 'code_locate',
	description:
		'Cross-agent lookup: find entities by name / description in the active session\'s code knowledge graph. Returns a small list of entity stubs (no bodies). Used by sibling analyzers asking "where is X defined?".',
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Free-form name / description / phrase.' },
			scope: {
				type: 'object',
				description: 'Optional narrowing -- repo / package / kind. Reserved; current implementation searches the whole closure.',
			},
			k: { type: 'number', description: 'Max hits. Default 5; capped at 20.', minimum: 1, maximum: 20 },
			[CROSS_AGENT_DEPTH_FIELD]: { type: 'number', description: 'Cross-agent recursion depth (set by caller).' },
		},
		required: ['query'],
		additionalProperties: false,
	},
	requiresApproval: false,

	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const depth = readCrossAgentDepth(input);
		if (exceedsCrossAgentDepth(depth)) {
			return unavailableResult('code_locate', 'cross_agent_depth_exceeded');
		}
		const query = str(input, 'query');
		if (!query) {
			return fail('code_locate', 'query required');
		}
		const k = Math.min(20, Math.max(1, num(input, 'k') ?? 5));
		const closure = deps.session.closureRepos;
		if (closure.length === 0) {
			return fail('code_locate', 'session has no closure repos initialized');
		}
		const db = await getDb();
		const vec = await embedQuery(query);
		if (vec.length === 0) {
			return fail('code_locate', 'failed to embed query (Ollama unavailable?)');
		}
		const hits = await searchEntities(db, vec, closure, k);
		const data: CodeLocateData = { query, results: hits.map(shortEntity) };
		const rendered = hits.length === 0
			? '_no matches_'
			: hits.map((e, i) => `${i + 1}. **${e.kind}** \`${e.name}\` (${lineLoc(e)})`).join('\n');
		return {
			output: `**code:locate** -- ${hits.length} hit(s) for \`${query}\`.\n\n${rendered}`,
			format: 'markdown',
			success: true,
			data,
		};
	},
};

// ---------------------------------------------------------------------------
// code:trace -- 1-hop CALLS predecessors / successors
// ---------------------------------------------------------------------------

interface CodeTraceNeighbour {
	readonly entityId: string;
	readonly name: string;
	readonly kind: string;
	readonly path: string;
	readonly lineRange: { readonly start: number; readonly end: number };
	readonly edge: 'callers' | 'callees';
	readonly hop: number;
}

interface CodeTraceData {
	readonly entityId: string;
	readonly direction: 'callers' | 'callees' | 'both';
	readonly neighbours: readonly CodeTraceNeighbour[];
}

export const codeTraceTool: Tool = {
	id: 'code_trace',
	description:
		'Cross-agent lookup: walk CALLS edges from a given entity. `direction: callers | callees | both`. Default depth 1 hop. Used by sibling analyzers asking "what calls X / what does X call?".',
	inputSchema: {
		type: 'object',
		properties: {
			entityId: { type: 'string', description: 'Entity id (sha256 hex).' },
			direction: { type: 'string', enum: ['callers', 'callees', 'both'], description: 'Which CALLS edge to follow.' },
			depth: { type: 'number', description: '1-hop only is currently supported. Reserved for future expansion.', minimum: 1, maximum: 1 },
			[CROSS_AGENT_DEPTH_FIELD]: { type: 'number', description: 'Cross-agent recursion depth (set by caller).' },
		},
		required: ['entityId', 'direction'],
		additionalProperties: false,
	},
	requiresApproval: false,

	async execute(input: ToolInput): Promise<ToolResult> {
		const depth = readCrossAgentDepth(input);
		if (exceedsCrossAgentDepth(depth)) {
			return unavailableResult('code_trace', 'cross_agent_depth_exceeded');
		}
		const entityId = str(input, 'entityId');
		if (!entityId) {
			return fail('code_trace', 'entityId required');
		}
		const direction = str(input, 'direction');
		if (direction !== 'callers' && direction !== 'callees' && direction !== 'both') {
			return fail('code_trace', 'direction must be one of callers | callees | both');
		}
		const db = await getDb();
		const neighbours: CodeTraceNeighbour[] = [];
		if (direction === 'callers' || direction === 'both') {
			const callers = await findCallers(db, entityId);
			for (const e of callers) {
				neighbours.push({ ...toNeighbour(e), edge: 'callers', hop: 1 });
			}
		}
		if (direction === 'callees' || direction === 'both') {
			const callees = await findCallees(db, entityId);
			for (const e of callees) {
				neighbours.push({ ...toNeighbour(e), edge: 'callees', hop: 1 });
			}
		}
		const data: CodeTraceData = { entityId, direction: direction as 'callers' | 'callees' | 'both', neighbours };
		const rendered = neighbours.length === 0
			? '_no neighbours_'
			: neighbours.map(n => `- ${n.edge === 'callers' ? '<-' : '->'} **${n.kind}** \`${n.name}\` (${n.path}:${n.lineRange.start})`).join('\n');
		return {
			output: `**code:trace** \`${entityId.slice(0, 12)}\` (${direction}) -- ${neighbours.length} neighbour(s).\n\n${rendered}`,
			format: 'markdown',
			success: true,
			data,
		};
	},
};

function toNeighbour(e: Entity): Omit<CodeTraceNeighbour, 'edge' | 'hop'> {
	return {
		entityId: e.id,
		name:     e.name,
		kind:     e.kind,
		path:     e.file,
		lineRange: { start: e.startLine, end: e.endLine },
	};
}

// ---------------------------------------------------------------------------
// code:describe -- canonical entity card
// ---------------------------------------------------------------------------

interface CodeDescribeData {
	readonly entityId: string;
	readonly summary?: string;
	readonly signature?: string;
	readonly body?: string;
	readonly path: string;
	readonly lineRange: { readonly start: number; readonly end: number };
	readonly neighbours: {
		readonly callers: readonly { readonly entityId: string; readonly name: string }[];
		readonly callees: readonly { readonly entityId: string; readonly name: string }[];
	};
}

export const codeDescribeTool: Tool = {
	id: 'code_describe',
	description:
		'Cross-agent lookup: full entity card -- signature, body, 1-hop callers + callees summary. Used by sibling analyzers needing context on a specific entity.',
	inputSchema: {
		type: 'object',
		properties: {
			entityId: { type: 'string', description: 'Entity id (sha256 hex).' },
			[CROSS_AGENT_DEPTH_FIELD]: { type: 'number', description: 'Cross-agent recursion depth (set by caller).' },
		},
		required: ['entityId'],
		additionalProperties: false,
	},
	requiresApproval: false,

	async execute(input: ToolInput): Promise<ToolResult> {
		const depth = readCrossAgentDepth(input);
		if (exceedsCrossAgentDepth(depth)) {
			return unavailableResult('code_describe', 'cross_agent_depth_exceeded');
		}
		const entityId = str(input, 'entityId');
		if (!entityId) {
			return fail('code_describe', 'entityId required');
		}
		const db = await getDb();
		const entity = await getEntity(db, entityId);
		if (!entity) {
			return fail('code_describe', `no entity with id ${entityId}`);
		}
		const [callers, callees] = await Promise.all([
			findCallers(db, entityId),
			findCallees(db, entityId),
		]);
		const data: CodeDescribeData = {
			entityId,
			...(entity.signature !== undefined ? { signature: entity.signature } : {}),
			...(entity.body !== undefined ? { body: entity.body.slice(0, 4000) } : {}),
			path: entity.file,
			lineRange: { start: entity.startLine, end: entity.endLine },
			neighbours: {
				callers: callers.map(e => ({ entityId: e.id, name: e.name })),
				callees: callees.map(e => ({ entityId: e.id, name: e.name })),
			},
		};
		const rendered = [
			`**${entity.kind}** \`${entity.name}\` (${lineLoc(entity)})`,
			entity.signature ? `\`${entity.signature}\`` : '',
			'',
			callers.length > 0 ? `**Callers (${callers.length}):** ${callers.map(c => `\`${c.name}\``).join(', ')}` : '',
			callees.length > 0 ? `**Callees (${callees.length}):** ${callees.map(c => `\`${c.name}\``).join(', ')}` : '',
		].filter(Boolean).join('\n');
		return {
			output: `**code:describe**\n\n${rendered}`,
			format: 'markdown',
			success: true,
			data,
		};
	},
};

// ---------------------------------------------------------------------------
// Registration entry-point
// ---------------------------------------------------------------------------

/**
 * Register the cross-agent surface (code:locate / code:trace /
 * code:describe). Called from the daemon bootstrap after the
 * built-in tools register, so the registry contains every
 * non-cross-agent tool first. `code_analyze` ships in Phase 3 slice
 * 2 alongside the orchestrator-side Flow-2 entry.
 */
export function registerCodeAnalyzerCrossAgentTools(): void {
	registerTool(codeLocateTool);
	registerTool(codeTraceTool);
	registerTool(codeDescribeTool);
}
