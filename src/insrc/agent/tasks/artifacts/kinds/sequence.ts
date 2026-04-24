/**
 * Sequence diagram artifact kind.
 *
 * Source priority:
 *   1. Caller-supplied Mermaid `source` -- rendered verbatim.
 *   2. `entry` id/name -- walks the Kuzu CALLS relation up to `depth`
 *      hops and emits a `sequenceDiagram` with one participant per
 *      unique entity and one message per CALLS edge.
 *   3. Free-text `description` -- two-actor scaffold fallback.
 */

import { getLogger } from '../../../../shared/logger.js';
import type {
	ArtifactResult,
	SequenceOptions,
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

const log = getLogger('artifact-kind-sequence');

export interface SequenceInput extends MermaidCommonInput, SequenceOptions {}

/** Generate a minimal sequence diagram from a free-text description. */
function defaultSource(description: string): string {
	const intent = cleanOneLine(description, 'action');
	return [
		'sequenceDiagram',
		'  autonumber',
		'  participant User',
		'  participant System',
		`  User->>System: ${intent}`,
		'  System-->>User: response',
	].join('\n');
}

/** Mermaid participant aliases must match `[A-Za-z0-9_]+`. */
function participantAlias(entity: Entity, seen: Set<string>): string {
	let base = entity.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
	if (base === '' || /^\d/.test(base)) { base = `p_${base}`; }
	let alias = base;
	let suffix = 2;
	while (seen.has(alias)) {
		alias = `${base}_${suffix}`;
		suffix++;
	}
	seen.add(alias);
	return alias;
}

/**
 * Render a CallGraph as a Mermaid sequenceDiagram. Each entity becomes
 * a participant; each CALLS edge becomes a `->>` message labelled with
 * the target name.
 */
function sequenceFromCallGraph(graph: CallGraph): string {
	const lines: string[] = ['sequenceDiagram', '  autonumber'];
	const seen = new Set<string>();
	const aliasById = new Map<string, string>();

	for (const node of graph.nodes) {
		const alias = participantAlias(node, seen);
		aliasById.set(node.id, alias);
		// Use `as` clause so the visible label can differ from the alias.
		const displayName = node.name.replace(/"/g, '');
		lines.push(`  participant ${alias} as ${displayName}`);
	}

	for (const edge of graph.edges) {
		const fromAlias = aliasById.get(edge.from);
		const toAlias = aliasById.get(edge.to);
		const toNode = graph.nodes.find(n => n.id === edge.to);
		if (fromAlias === undefined || toAlias === undefined || toNode === undefined) { continue; }
		const label = toNode.name.replace(/:/g, '-').replace(/[[\]"]/g, '');
		lines.push(`  ${fromAlias}->>${toAlias}: ${label}`);
	}

	return lines.join('\n');
}

export interface RunSequenceOpts extends KindRunOpts {
	readonly input: SequenceInput;
}

export async function runSequence(opts: RunSequenceOpts): Promise<ArtifactResult> {
	const { input } = opts;
	const warnings: string[] = [];

	let mermaidSource: string;
	let provenance: string;
	let confidence: 'high' | 'medium' | 'low';
	let metaLineSuffix = '';

	if (input.source !== undefined && input.source.trim() !== '') {
		mermaidSource = input.source;
		provenance = 'caller-supplied Mermaid source';
		confidence = 'high';
	} else if (input.entry !== undefined && input.entry.trim() !== '') {
		const graph = await traverseCallGraph({
			entry: input.entry,
			...(input.depth !== undefined ? { depth: input.depth } : {}),
			...(opts.repoRoot !== undefined ? { repoPath: opts.repoRoot } : {}),
		}).catch(err => {
			warnings.push(
				`Kuzu CALLS traversal failed for '${input.entry}': ${(err as Error).message}. ` +
				'Returned a free-text scaffold instead.',
			);
			return null;
		});
		if (graph !== null && graph.nodes.length > 1) {
			mermaidSource = sequenceFromCallGraph(graph);
			provenance = `Kuzu CALLS from '${graph.entry.name}'`;
			confidence = 'high';
			metaLineSuffix = ` · ${graph.nodes.length} participants · ${graph.edges.length} calls`;
		} else {
			if (graph !== null && graph.nodes.length <= 1) {
				warnings.push(
					`Kuzu CALLS traversal from '${input.entry}' found no downstream calls. ` +
					'Returned a free-text scaffold instead.',
				);
			} else if (graph === null && warnings.length === 0) {
				warnings.push(
					`Kuzu could not resolve entry '${input.entry}'. ` +
					'Returned a free-text scaffold instead.',
				);
			}
			mermaidSource = defaultSource(input.description ?? '');
			provenance = 'free-text (default scaffold)';
			confidence = 'low';
		}
	} else {
		mermaidSource = defaultSource(input.description ?? '');
		provenance = 'free-text (default scaffold)';
		confidence = 'low';
	}

	const title = input.title?.trim() !== undefined && input.title.trim() !== ''
		? input.title.trim()
		: `Sequence: ${truncate(cleanOneLine(input.description, 'scaffold'), 48)}`;

	const metadata: Record<string, string> = {};
	if (input.entry !== undefined) { metadata['entry'] = input.entry; }
	if (input.depth !== undefined) { metadata['depth'] = String(input.depth); }

	log.info({
		sessionId: opts.sessionId,
		provenance,
		confidence,
		hasCallerSource: input.source !== undefined,
	}, 'sequence artifact generated');

	return runMermaidArtifact(
		{
			kind: 'sequence',
			title,
			mermaidSource,
			metaLine: provenance + metaLineSuffix,
			provenance,
			confidence,
			warnings,
			metadata,
		},
		opts,
	);
}
