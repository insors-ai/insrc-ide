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
import {
	listSessionArtifacts,
	persistArtifact,
} from '../../../../agent/tasks/artifacts/persistence.js';
import { regenerateArtifact } from '../../../../agent/tasks/artifacts/regenerate.js';
import { listTemplates } from '../../../../agent/tasks/artifacts/template-loader.js';

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
			description: 'Pre-built WireframeSpec JSON. When supplied, the tool renders it directly.',
		},
		component: {
			type: 'string',
			description: 'Function / component entity name to introspect (§4.1). When set, the tool looks up the function in the code graph, reads its body, and walks the JSX subtree to derive a layout-sketch WireframeSpec. Falls through to LLM / scaffold on any failure.',
		},
		depth: {
			type: 'number',
			description: 'Recursive descent depth for in-tree custom components encountered while walking. Default 3, max 6.',
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

const CALLFLOW_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		...COMMON_PROPS,
		...SOURCE_PROP,
		tracePath: {
			type: 'string',
			description: 'Absolute or repo-relative path to a JSON trace export. v1 supports OpenTelemetry / OTLP JSON (Jaeger + Zipkin land in a follow-up).',
		},
		traceJson: {
			type: 'string',
			description: 'Inline trace JSON. Same format as `tracePath` content; useful when the caller already has the trace string in memory.',
		},
		traceId: {
			type: 'string',
			description: 'When the input carries multiple traces, pick one by id. Defaults to the first trace when omitted.',
		},
		serviceFilter: {
			type: 'array',
			items: { type: 'string' },
			description: 'Render only spans whose `service.name` is in this list. When omitted, every service is included up to the 20-service cap.',
		},
		showInternal: {
			type: 'boolean',
			description: 'Include INTERNAL / UNKNOWN-kind spans. Default false -- only cross-service / client / server / producer / consumer spans render, since INTERNAL spans typically swamp the diagram.',
		},
		layout: {
			type: 'string',
			enum: ['sequence', 'flowchart'],
			description: 'Default `sequence`. The `flowchart` layout is recognised but not yet implemented in v1; falls back to `sequence` with a warning.',
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

const callflowTool: Tool = {
	id: 'artifact:callflow',
	description:
		'Generate a cross-service callflow diagram from a distributed trace ' +
		'(OpenTelemetry / OTLP JSON in v1; Jaeger + Zipkin in a follow-up). ' +
		'Renders services as participants and spans as duration-labelled messages in a Mermaid sequenceDiagram. ' +
		'Accepts an OTLP JSON file via `tracePath`, an inline JSON string via `traceJson`, or falls back to a free-text scaffold. ' +
		'Caps: 20 services, 50 spans, 5s parse.',
	inputSchema: CALLFLOW_SCHEMA,
	execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		return runKind('callflow', input, deps, this.id);
	},
};

// ---------------------------------------------------------------------------
// artifact:regenerate -- iterative LLM-driven edit of an existing artifact
// ---------------------------------------------------------------------------

const REGENERATE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['artifactId', 'edits'],
	properties: {
		artifactId: {
			type: 'string',
			description: 'The id of a prior artifact produced on this session (the `id` field on the ArtifactResult returned by any artifact:<kind> call).',
		},
		edits: {
			type: 'string',
			description: 'Natural-language edit request. Examples: "make it vertical instead of horizontal", "drop the Redis node", "add a retry loop between Service and Datastore".',
		},
	},
} as const;

const regenerateTool: Tool = {
	id: 'artifact:regenerate',
	description:
		'Iteratively edit an existing artifact. Re-runs the LLM against the prior source + the user\'s edit request, ' +
		'pushes the prior source onto the item\'s revision history (keep last 5), and emits the new rendered snippet. ' +
		'Same kind as the original -- use this when the user wants to refine the previous diagram rather than generate a new one from the data source.',
	inputSchema: REGENERATE_SCHEMA,
	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const toolId = this.id;
		const artifactId = typeof input['artifactId'] === 'string' ? input['artifactId'] : '';
		const edits = typeof input['edits'] === 'string' ? input['edits'] : '';
		if (artifactId === '' || edits === '') {
			return fail(toolId, `artifact:regenerate requires non-empty 'artifactId' + 'edits'`);
		}
		if (deps.todos === undefined) {
			return fail(
				toolId,
				'TodosApi missing from ToolDeps; cannot regenerate -- daemon wiring bug.',
			);
		}
		try {
			const result = await regenerateArtifact({
				sessionId: deps.session.id,
				artifactId,
				edits,
				api: deps.todos,
				provider: deps.session.ollamaProvider,
				repoRoot: deps.session.repoPath,
			});
			log.info({
				artifactId,
				newArtifactId: result.artifact.id,
				kind: result.artifact.kind,
				revisions: result.revisionCount,
				sessionId: deps.session.id,
			}, 'artifact regenerated');
			return {
				output:
					`artifact '${result.artifact.kind}' regenerated: ` +
					`id=${result.artifact.id}, revisions=${result.revisionCount}, edits="${edits.slice(0, 80)}"`,
				format: 'markdown',
				success: true,
				data: result.artifact,
			};
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn({ artifactId, err: msg }, 'artifact:regenerate failed');
			return fail(toolId, msg);
		}
	},
};

// ---------------------------------------------------------------------------
// artifact:list_templates -- thin wrapper around the template loader
// ---------------------------------------------------------------------------

const LIST_TEMPLATES_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {},
} as const;

const listTemplatesTool: Tool = {
	id: 'artifact:list_templates',
	description:
		'List the template resolution status for every artifact kind ' +
		'(repo override / user override / bundled). Useful for agents that want to report ' +
		'which templates a user has customised, or for a disambiguation prompt.',
	inputSchema: LIST_TEMPLATES_SCHEMA,
	async execute(_input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const opts = deps.session.repoPath !== undefined && deps.session.repoPath !== ''
			? { repoRoot: deps.session.repoPath }
			: {};
		const infos = await listTemplates(opts);
		const lines: string[] = ['| kind | layer | path |', '|---|---|---|'];
		for (const info of infos) {
			lines.push(`| ${info.kind} | ${info.layer} | ${info.path} |`);
		}
		return {
			output: lines.join('\n'),
			format: 'markdown',
			success: true,
			data: infos,
		};
	},
};

// ---------------------------------------------------------------------------
// artifact:list -- enumerate session artifacts for the NL regenerate UX
// ---------------------------------------------------------------------------

const LIST_ARTIFACTS_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {},
} as const;

const listArtifactsTool: Tool = {
	id: 'artifact:list',
	description:
		'List the artifacts produced on the current session, newest first (cap 50). ' +
		'Each entry carries `artifactId`, `kind`, `title`, `createdAt`, `updatedAt`, and ' +
		'`revisionsCount` -- useful for an LLM turn that needs to resolve a user reference ' +
		'like "regenerate the user/orders ER" to a concrete `artifactId` before calling ' +
		'`artifact:regenerate`.',
	inputSchema: LIST_ARTIFACTS_SCHEMA,
	async execute(_input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		if (deps.todos === undefined) {
			return fail(
				'artifact:list',
				'TodosApi missing from ToolDeps; cannot enumerate artifacts. This is a daemon wiring bug -- ' +
				'the tool executor (daemon/task.ts or agent/tools/executor.ts) should supply `deps.todos`.',
			);
		}
		const summaries = await listSessionArtifacts(deps.todos, deps.session.id);
		if (summaries.length === 0) {
			return {
				output: 'No artifacts on this session yet.',
				format: 'markdown',
				success: true,
				data: summaries,
			};
		}
		const lines: string[] = [
			'| artifactId | kind | title | createdAt | revisions |',
			'|---|---|---|---|---|',
		];
		for (const a of summaries) {
			lines.push(
				`| ${a.artifactId} | ${a.kind} | ${a.title} | ${a.createdAt} | ${a.revisionsCount} |`,
			);
		}
		return {
			output: lines.join('\n'),
			format: 'markdown',
			success: true,
			data: summaries,
		};
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
	registerTool(callflowTool);
	registerTool(regenerateTool);
	registerTool(listTemplatesTool);
	registerTool(listArtifactsTool);
}
