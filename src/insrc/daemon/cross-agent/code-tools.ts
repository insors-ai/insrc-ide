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

import { registerTool } from '../tools/registry.js';
import { runSkill, type SkillRunnerDeps } from '../skills/invoke.js';
import {
	CROSS_AGENT_DEPTH_FIELD,
	exceedsCrossAgentDepth,
	readCrossAgentDepth,
	toolUnavailable,
} from '../../shared/cross-agent.js';
import type { LLMProvider } from '../../shared/types.js';
import type { ProviderAffinity } from '../skills/types.js';
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

interface CodeLocateResult {
	readonly entityId: string;
	readonly name:     string;
	readonly kind:     string;
	readonly path:     string;
	readonly lineRange: { readonly start: number; readonly end: number };
	readonly repo:     string;
	readonly signature?: string | undefined;
}

// ---------------------------------------------------------------------------
// Phase 9.2 -- skill-shim plumbing
// ---------------------------------------------------------------------------

/**
 * Build a `SkillRunnerDeps` from the cross-agent tool's `ToolDeps`.
 * Mirrors the resolver pattern in `tools/builtins/skills/invoke-skill.ts`
 * so cross-agent tools route through the skill runner with the same
 * provider-affinity contract.
 */
function buildSkillRunnerDeps(deps: ToolDeps): SkillRunnerDeps {
	const session = deps.session;
	const resolveProvider = (affinity: ProviderAffinity): LLMProvider => {
		switch (affinity) {
			case 'local': return session.ollamaProvider;
			case 'cloud': return session.claudeProvider ?? session.ollamaProvider;
			case 'auto':  return session.resolver.resolve('skill', 'default');
		}
	};
	return {
		session,
		resolveProvider,
		toolExecCtx: {
			...(deps.send !== undefined ? { send: deps.send } : {}),
			...(deps.channel !== undefined ? { channel: deps.channel } : {}),
			...(deps.requestId !== undefined ? { requestId: deps.requestId } : {}),
		},
		...(deps.signal !== undefined ? { signal: deps.signal } : {}),
	};
}

// ---------------------------------------------------------------------------
// code:locate -- vector + entity lookup
// ---------------------------------------------------------------------------

interface CodeLocateData {
	readonly query: string;
	readonly results: readonly CodeLocateResult[];
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

		// Phase 9.2 shim (extended): forward to
		// `code.entity.search-by-vector` instead of running the embed +
		// ANN inline. Same data shape preserved: `{ query, results: [...] }`
		// with `_shim: true` for telemetry parity with code_trace +
		// code_describe.
		const runnerDeps = buildSkillRunnerDeps(deps);
		type SearchHit = {
			readonly id:        string;
			readonly name:      string;
			readonly kind:      string;
			readonly file:      string;
			readonly startLine: number;
			readonly endLine:   number;
			readonly signature?: string;
			readonly repo:      string;
		};
		type SearchOutput = {
			readonly query: string;
			readonly hits:  readonly SearchHit[];
		};
		const r = await runSkill<{ query: string; closureRepos: readonly string[]; limit: number }, SearchOutput>(
			'code.entity.search-by-vector',
			{ query, closureRepos: closure, limit: k },
			runnerDeps,
		);
		const results = r.value.hits.map(h => ({
			entityId:  h.id,
			name:      h.name,
			kind:      h.kind,
			path:      h.file,
			lineRange: { start: h.startLine, end: h.endLine },
			repo:      h.repo,
			signature: h.signature,
		}));
		const data: CodeLocateData & { _shim: true } = { query, results, _shim: true };
		const rendered = results.length === 0
			? '_no matches_'
			: results.map((e, i) => `${i + 1}. **${e.kind}** \`${e.name}\` (${e.path}:${e.lineRange.start}${e.lineRange.end > e.lineRange.start ? '-' + e.lineRange.end : ''})`).join('\n');
		return {
			output: `**code:locate** -- ${results.length} hit(s) for \`${query}\`.\n\n${rendered}`,
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

	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
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

		// Phase 9.2 shim: forward to code.entity.callers / code.entity.callees
		// instead of hitting the DB directly. Same data shape preserved
		// (lineRange.end depends on the skill output's `endLine` field
		// added in step 9.2 alongside the shim).
		const runnerDeps = buildSkillRunnerDeps(deps);
		const neighbours: CodeTraceNeighbour[] = [];
		if (direction === 'callers' || direction === 'both') {
			const r = await runSkill<{ entityId: string }, NeighborSkillOutput>(
				'code.entity.callers',
				{ entityId },
				runnerDeps,
			);
			for (const n of r.value.neighbors) {
				neighbours.push(neighbourFromSkill(n, 'callers'));
			}
		}
		if (direction === 'callees' || direction === 'both') {
			const r = await runSkill<{ entityId: string }, NeighborSkillOutput>(
				'code.entity.callees',
				{ entityId },
				runnerDeps,
			);
			for (const n of r.value.neighbors) {
				neighbours.push(neighbourFromSkill(n, 'callees'));
			}
		}

		const data: CodeTraceData & { _shim?: true } = {
			entityId,
			direction: direction as 'callers' | 'callees' | 'both',
			neighbours,
			_shim: true,    // Phase 9.2 telemetry marker; gates eventual deletion
		};
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

interface NeighborSkillOutput {
	readonly entityId:   string;
	readonly neighbors:  readonly {
		readonly id:        string;
		readonly name:      string;
		readonly kind:      string;
		readonly file:      string;
		readonly startLine: number;
		readonly endLine:   number;
	}[];
	readonly truncated:  boolean;
	readonly direction:  'callers' | 'callees';
}

function neighbourFromSkill(
	n: NeighborSkillOutput['neighbors'][number],
	edge: 'callers' | 'callees',
): CodeTraceNeighbour {
	return {
		entityId:  n.id,
		name:      n.name,
		kind:      n.kind,
		path:      n.file,
		lineRange: { start: n.startLine, end: n.endLine },
		edge,
		hop:       1,
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

	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const depth = readCrossAgentDepth(input);
		if (exceedsCrossAgentDepth(depth)) {
			return unavailableResult('code_describe', 'cross_agent_depth_exceeded');
		}
		const entityId = str(input, 'entityId');
		if (!entityId) {
			return fail('code_describe', 'entityId required');
		}

		// Phase 9.2 shim: forward to code.entity.summary +
		// code.entity.callers + code.entity.callees. Body cap stays at
		// the legacy 4000 via the new `excerptMaxChars` input on
		// code.entity.summary.
		const runnerDeps = buildSkillRunnerDeps(deps);

		type SummaryFound = {
			readonly found: true;
			readonly name: string;
			readonly kind: string;
			readonly file: string;
			readonly startLine: number;
			readonly endLine: number;
			readonly signature?: string;
			readonly excerpt: string;
		};
		type SummaryMiss = { readonly found: false; readonly reason: string };
		type SummaryOutput = SummaryFound | SummaryMiss;

		const summaryResult = await runSkill<{ entityId: string; excerptMaxChars: number }, SummaryOutput>(
			'code.entity.summary',
			{ entityId, excerptMaxChars: 4000 },
			runnerDeps,
		);
		if (!summaryResult.value.found) {
			return fail('code_describe', `no entity with id ${entityId}`);
		}
		const summary = summaryResult.value;

		const [callersResult, calleesResult] = await Promise.all([
			runSkill<{ entityId: string }, NeighborSkillOutput>('code.entity.callers', { entityId }, runnerDeps),
			runSkill<{ entityId: string }, NeighborSkillOutput>('code.entity.callees', { entityId }, runnerDeps),
		]);
		const callers = callersResult.value.neighbors;
		const callees = calleesResult.value.neighbors;

		const data: CodeDescribeData & { _shim?: true } = {
			entityId,
			...(summary.signature !== undefined ? { signature: summary.signature } : {}),
			...(summary.excerpt.length > 0 ? { body: summary.excerpt } : {}),
			path: summary.file,
			lineRange: { start: summary.startLine, end: summary.endLine },
			neighbours: {
				callers: callers.map(c => ({ entityId: c.id, name: c.name })),
				callees: callees.map(c => ({ entityId: c.id, name: c.name })),
			},
			_shim: true,    // Phase 9.2 telemetry marker
		};
		const lineLocStr = `${summary.file}:${summary.startLine}${summary.endLine > summary.startLine ? '-' + summary.endLine : ''}`;
		const rendered = [
			`**${summary.kind}** \`${summary.name}\` (${lineLocStr})`,
			summary.signature ? `\`${summary.signature}\`` : '',
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
