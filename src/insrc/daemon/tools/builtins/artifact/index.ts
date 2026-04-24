/**
 * Artifact tools -- pre-defined tasks that emit embeddable HTML
 * snippets (ER / sequence / flow / deployment / wireframe).
 *
 * Phase 1 MVP registers all five tool ids so the surface is
 * discoverable, but only `artifact:wireframe` has a runnable
 * implementation (via the kind registry). The other four return a
 * clean "not yet implemented" error from the dispatcher -- good for
 * exercising the full tool loop + chat widget plumbing before the
 * remaining kinds land.
 *
 * Persistence: each successful run stores the artifact as a completed
 * TodoItem on the session's Artifacts list, which the browser picks
 * up via the existing `todos` stream so the chat widget lights up
 * without a dedicated event channel.
 *
 * See design/artifacts/index.html and plans/artifact-tasks.md §1.1.
 */

import { getLogger } from '../../../../shared/logger.js';
import { registerTool } from '../../registry.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../../types.js';
import type {
	ArtifactKind,
	ArtifactResult,
} from '../../../../shared/artifacts.js';
import { dispatch, type KindRunOpts } from '../../../../agent/tasks/artifacts/registry.js';
import { persistArtifact } from '../../../../agent/tasks/artifacts/persistence.js';

const log = getLogger('tools-artifact');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fail(id: string, msg: string): ToolResult {
	return { output: `[${id}] ${msg}`, format: 'text', success: false, error: msg };
}

function commonOptsFromDeps(deps: ToolDeps): KindRunOpts {
	// Kinds that run an LLM stage-2 (currently: wireframe spec
	// synthesis from free-text) use the local Ollama provider by
	// default so a slash-free NL request doesn't silently escalate
	// to cloud tokens. Agent integrations that want the cloud model
	// can override via `@mention` before the call reaches this tool.
	return {
		sessionId: deps.session.id,
		repoRoot: deps.session.repoPath,
		provider: deps.session.ollamaProvider,
	};
}

/**
 * Summary line returned in `ToolResult.output` for LLM consumption.
 * The structured artifact payload is on `.data` -- callers that want
 * to render the snippet pull that. Keeping `output` concise saves
 * tokens on the LLM turn that sees the tool result.
 */
function summaryLine(result: ArtifactResult): string {
	const bytes = result.renderedHtml.embedded.length;
	const title = result.title ?? result.kind;
	return `artifact '${result.kind}' generated: id=${result.id}, title="${title}", rendered=${bytes}B`;
}

/**
 * Run a kind end-to-end: dispatch -> persist -> return ToolResult.
 */
async function runKind(
	kind: ArtifactKind,
	input: ToolInput,
	deps: ToolDeps,
	toolId: string,
): Promise<ToolResult> {
	try {
		const opts = commonOptsFromDeps(deps);
		const result = await dispatch(kind, opts, input);
		if (deps.todos === undefined) {
			return fail(
				toolId,
				'TodosApi missing from ToolDeps; cannot persist the artifact. This is a daemon wiring bug -- ' +
				'the tool executor (daemon/task.ts or agent/tools/executor.ts) should supply `deps.todos`.',
			);
		}
		const persisted = await persistArtifact(deps.todos, opts.sessionId, result);
		log.info({
			kind,
			artifactId: result.id,
			listId: persisted.list.id,
			itemId: persisted.item.id,
			caller: deps.todos.caller,
			sessionId: opts.sessionId,
		}, 'artifact persisted');
		return {
			output: summaryLine(result),
			format: 'markdown',
			success: true,
			data: result,
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.warn({ kind, err: msg }, 'artifact tool failed');
		return fail(toolId, msg);
	}
}

// ---------------------------------------------------------------------------
// Per-kind input schemas. Structured enough for the LLM to produce
// sensible calls; validation is further enforced inside each kind.
// ---------------------------------------------------------------------------

/** Shared options every kind supports. */
const COMMON_PROPS = {
	title: { type: 'string', description: 'Optional title rendered in the snippet header.' },
	description: {
		type: 'string',
		description: 'Free-text description. Acts as the primary input for kinds without a structured data source (e.g. wireframe, process-flow) and as steering context for kinds that do have one.',
	},
} as const;

const WIREFRAME_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		...COMMON_PROPS,
		layout: {
			type: 'string',
			enum: ['desktop', 'tablet', 'mobile'],
			description: 'Target layout class. Defaults to "desktop".',
		},
		spec: {
			type: 'object',
			description: 'Pre-built WireframeSpec JSON. When supplied, the tool renders it directly; otherwise a default scaffold is generated from the description (phase-1 MVP -- LLM-driven spec synthesis lands later).',
		},
	},
} as const;

const SOURCE_PROP = {
	source: {
		type: 'string',
		description: 'Pre-built Mermaid source. When present, the kind renders it verbatim (skipping its default-scaffold path).',
	},
} as const;

const ER_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		...COMMON_PROPS,
		...SOURCE_PROP,
		connection: {
			type: 'string',
			description: 'Connection id from db-connections.json. Recognised but not yet wired (live-DB introspection is phase 3); phase 1 falls through to the default scaffold with a warning.',
		},
		tables: {
			type: 'array',
			items: { type: 'string' },
			description: 'Subset of tables to include in the default scaffold.',
		},
		entityIds: {
			type: 'array',
			items: { type: 'string' },
			description: 'Kuzu graph entity ids (recognised but Kuzu traversal is a follow-up; falls through to the default scaffold with a warning).',
		},
	},
} as const;

const SEQUENCE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		...COMMON_PROPS,
		...SOURCE_PROP,
		entry: {
			type: 'string',
			description: 'Entry-point entity id for Kuzu CALLS traversal. Recognised but not yet wired; phase 1 falls through to the default scaffold with a warning.',
		},
		depth: {
			type: 'number',
			description: 'Traversal depth. Default 3.',
		},
	},
} as const;

const FLOW_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		...COMMON_PROPS,
		...SOURCE_PROP,
		kind: {
			type: 'string',
			enum: ['code', 'process'],
			description: 'Sub-kind. When omitted, inferred from `entity` presence.',
		},
		entity: {
			type: 'string',
			description: 'Function / entity id for the code sub-kind. CFG traversal is a follow-up; phase 1 falls through to the default scaffold with a warning.',
		},
	},
} as const;

const DEPLOYMENT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		...COMMON_PROPS,
		...SOURCE_PROP,
		fromFile: {
			type: 'string',
			description: 'Absolute or repo-relative path to a docker-compose.yml, k8s manifest, or Terraform plan JSON. Compose / k8s parsers land as follow-ups; Terraform is phase 3. Phase 1 recognises the field and falls through to the default scaffold with a warning.',
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const wireframeTool: Tool = {
	id: 'artifact:wireframe',
	description: 'Generate a low-fi UI wireframe as an embeddable HTML snippet (SVG). Accepts a structured WireframeSpec or a free-text description + layout.',
	inputSchema: WIREFRAME_SCHEMA,
	execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		return runKind('wireframe', input, deps, this.id);
	},
};

const erTool: Tool = {
	id: 'artifact:er',
	description: 'Generate an ER diagram as an embeddable HTML snippet (Mermaid erDiagram). Accepts a pre-built Mermaid source, a list of tables, or a free-text description; falls back to a default scaffold.',
	inputSchema: ER_SCHEMA,
	execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		return runKind('er', input, deps, this.id);
	},
};

const sequenceTool: Tool = {
	id: 'artifact:sequence',
	description: 'Generate a sequence diagram as an embeddable HTML snippet (Mermaid sequenceDiagram). Accepts a pre-built Mermaid source or a free-text description; falls back to a two-actor scaffold.',
	inputSchema: SEQUENCE_SCHEMA,
	execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		return runKind('sequence', input, deps, this.id);
	},
};

const flowTool: Tool = {
	id: 'artifact:flow',
	description: 'Generate a flow diagram as an embeddable HTML snippet (Mermaid flowchart). Supports code-flow and process-flow sub-kinds; accepts a pre-built source or generates a scaffold from the description.',
	inputSchema: FLOW_SCHEMA,
	execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		return runKind('flow', input, deps, this.id);
	},
};

const deploymentTool: Tool = {
	id: 'artifact:deployment',
	description: 'Generate a deployment diagram as an embeddable HTML snippet (Mermaid flowchart). Accepts a pre-built source or a free-text description; falls back to a client-service-datastore scaffold.',
	inputSchema: DEPLOYMENT_SCHEMA,
	execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		return runKind('deployment', input, deps, this.id);
	},
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerArtifactTools(): void {
	registerTool(wireframeTool);
	registerTool(erTool);
	registerTool(sequenceTool);
	registerTool(flowTool);
	registerTool(deploymentTool);
}
