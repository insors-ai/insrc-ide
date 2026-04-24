/**
 * Flow diagram artifact kind.
 *
 * Covers two sub-kinds (design §4.3):
 *   - 'code':    control-flow / call-flow within a function / entity.
 *                Phase 1 uses CALLS traversal as a CFG approximation
 *                (true CFG requires parser `BRANCHES` edges -- phase
 *                4 upgrade).
 *   - 'process': business / process flow. Free-text only by design.
 *
 * Source priority for code sub-kind:
 *   1. Caller-supplied Mermaid `source`.
 *   2. `entity` id/name -- CALLS traversal -> flowchart.
 *   3. Default `enter -> body -> return` scaffold.
 *
 * Sub-kind is resolved from `input.kind` or inferred via the presence
 * of `entity`.
 */

import { getLogger } from '../../../../shared/logger.js';
import type {
	ArtifactResult,
	FlowOptions,
	FlowSubKind,
} from '../../../../shared/artifacts.js';
import type { Entity } from '../../../../shared/types.js';
import type { KindRunOpts } from '../registry.js';
import {
	cleanOneLine,
	runMermaidArtifact,
	truncate,
	type MermaidCommonInput,
} from './shared-mermaid.js';
import { traverseCallGraph, type CallGraph } from './call-graph.js';

const log = getLogger('artifact-kind-flow');

export interface FlowInput extends MermaidCommonInput, FlowOptions {}

function resolveSubKind(input: FlowInput): FlowSubKind {
	if (input.kind === 'code' || input.kind === 'process') { return input.kind; }
	return input.entity !== undefined && input.entity.trim() !== '' ? 'code' : 'process';
}

/**
 * Escape a label for use inside a Mermaid flowchart node. Mermaid
 * treats `"` as a string delimiter and `[` / `]` as node shape
 * markers, so we drop those characters rather than HTML-escape them
 * (the binder's Mermaid-source escape runs later).
 */
function mermaidNodeLabel(raw: string, fallback: string): string {
	const cleaned = cleanOneLine(raw, fallback)
		.replace(/[[\]"]/g, '')
		.replace(/\|/g, '/');
	return cleaned === '' ? fallback : cleaned;
}

function defaultProcessSource(description: string): string {
	const step = mermaidNodeLabel(description, 'process step');
	return [
		'flowchart TD',
		'  Start((Start))',
		`  Step["${step}"]`,
		'  End((End))',
		'  Start --> Step --> End',
	].join('\n');
}

function defaultCodeSource(description: string, entity: string | undefined): string {
	const body = mermaidNodeLabel(description, entity ?? 'function body');
	const enter = mermaidNodeLabel(entity ?? 'enter', 'enter');
	return [
		'flowchart LR',
		`  Enter(["${enter}"])`,
		`  Body["${body}"]`,
		'  Return(["return"])',
		'  Enter --> Body --> Return',
	].join('\n');
}

/** Mermaid flowchart node ids must match `[A-Za-z_][A-Za-z0-9_]*`. */
function flowNodeId(entity: Entity, seen: Set<string>): string {
	let base = entity.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
	if (base === '' || /^\d/.test(base)) { base = `n_${base}`; }
	let id = base;
	let suffix = 2;
	while (seen.has(id)) {
		id = `${base}_${suffix}`;
		suffix++;
	}
	seen.add(id);
	return id;
}

/**
 * Render a CallGraph as a Mermaid `flowchart LR`. The entry entity
 * becomes a rounded "enter" node; every reachable entity becomes a
 * rectangle. CALLS edges render as `-->`.
 */
function codeFlowFromCallGraph(graph: CallGraph): string {
	const lines: string[] = ['flowchart LR'];
	const seen = new Set<string>();
	const idByEntityId = new Map<string, string>();

	for (const node of graph.nodes) {
		const id = flowNodeId(node, seen);
		idByEntityId.set(node.id, id);
		const label = mermaidNodeLabel(node.name, node.kind);
		const shape = node.id === graph.entry.id
			? `(["${label}"])`
			: `["${label}"]`;
		lines.push(`  ${id}${shape}`);
	}

	for (const edge of graph.edges) {
		const from = idByEntityId.get(edge.from);
		const to = idByEntityId.get(edge.to);
		if (from === undefined || to === undefined) { continue; }
		lines.push(`  ${from} --> ${to}`);
	}

	return lines.join('\n');
}

export interface RunFlowOpts extends KindRunOpts {
	readonly input: FlowInput;
}

export async function runFlow(opts: RunFlowOpts): Promise<ArtifactResult> {
	const { input } = opts;
	const subKind = resolveSubKind(input);
	const warnings: string[] = [];

	let mermaidSource: string;
	let provenance: string;
	let confidence: 'high' | 'medium' | 'low';
	let metaExtra = '';

	if (input.source !== undefined && input.source.trim() !== '') {
		mermaidSource = input.source;
		provenance = 'caller-supplied Mermaid source';
		confidence = 'high';
	} else if (subKind === 'code' && input.entity !== undefined && input.entity.trim() !== '') {
		const graph = await traverseCallGraph({
			entry: input.entity,
			...(opts.repoRoot !== undefined ? { repoPath: opts.repoRoot } : {}),
		}).catch(err => {
			warnings.push(
				`Kuzu CALLS traversal failed for '${input.entity}': ${(err as Error).message}. ` +
				'Returned a free-text scaffold instead.',
			);
			return null;
		});
		if (graph !== null && graph.nodes.length > 1) {
			mermaidSource = codeFlowFromCallGraph(graph);
			provenance = `Kuzu CALLS from '${graph.entry.name}' (CFG approximation)`;
			confidence = 'medium';
			metaExtra = ` · ${graph.nodes.length} nodes · ${graph.edges.length} edges`;
		} else {
			if (graph !== null && graph.nodes.length <= 1) {
				warnings.push(
					`Kuzu CALLS traversal from '${input.entity}' found no downstream calls. ` +
					'Returned a free-text scaffold instead.',
				);
			} else if (graph === null && warnings.length === 0) {
				warnings.push(
					`Kuzu could not resolve entity '${input.entity}'. ` +
					'Returned a free-text scaffold instead.',
				);
			}
			mermaidSource = defaultCodeSource(input.description ?? '', input.entity);
			provenance = 'free-text (default code-flow scaffold)';
			confidence = 'low';
		}
	} else if (subKind === 'code') {
		mermaidSource = defaultCodeSource(input.description ?? '', input.entity);
		provenance = 'free-text (default code-flow scaffold)';
		confidence = 'low';
	} else {
		mermaidSource = defaultProcessSource(input.description ?? '');
		provenance = 'free-text (default process-flow scaffold)';
		confidence = 'low';
	}

	const descLabel = truncate(cleanOneLine(input.description, subKind), 48);
	const title = input.title?.trim() !== undefined && input.title.trim() !== ''
		? input.title.trim()
		: `Flow (${subKind}): ${descLabel}`;

	const metadata: Record<string, string> = { subKind };
	if (input.entity !== undefined) { metadata['entity'] = input.entity; }

	log.info({
		sessionId: opts.sessionId,
		subKind,
		provenance,
		confidence,
		hasCallerSource: input.source !== undefined,
	}, 'flow artifact generated');

	return runMermaidArtifact(
		{
			kind: 'flow',
			title,
			mermaidSource,
			metaLine: `${subKind} · ${provenance}${metaExtra}`,
			provenance,
			confidence,
			warnings,
			metadata,
		},
		opts,
	);
}
