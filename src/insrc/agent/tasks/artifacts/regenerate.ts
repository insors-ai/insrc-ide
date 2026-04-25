/**
 * artifact:regenerate -- iterative editing of an existing artifact.
 *
 * Takes an artifact id + natural-language edit request. Unlike the
 * per-kind runners (which re-fetch the structured source when
 * available), regenerate operates on the last-known source stored
 * on the TodoItem's meta. The LLM reads that source + the edit text
 * and returns a revised source in the same grammar; we bind through
 * the template binder and push the prior source onto
 * `meta.revisions` (keep last 5).
 *
 * This lets a user iterate on "same diagram, new orientation",
 * "add a lane", "drop this cell" without re-invoking the kind tool
 * (which would re-pull from the data source and discard inline
 * caller edits).
 *
 * See plans/artifact-tasks.md §2.1.
 */

import { randomBytes } from 'node:crypto';
import { getLogger } from '../../../shared/logger.js';
import type {
	ArtifactItemMeta,
	ArtifactKind,
	ArtifactResult,
	WireframeSpec,
} from '../../../shared/artifacts.js';
import type {
	LLMMessage, LLMProvider, LLMResponse,
} from '../../../shared/types.js';
import type { TodoItem, TodosApi } from '../../../shared/todos.js';
import { bindTemplate } from './template-binder.js';
import { appendRevision, findByArtifactId } from './persistence.js';
import { renderWireframe } from './wireframe/render.js';

const log = getLogger('artifact-regenerate');

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const MERMAID_GRAMMAR: Readonly<Record<Exclude<ArtifactKind, 'wireframe'>, string>> = {
	er: 'erDiagram',
	sequence: 'sequenceDiagram',
	flow: 'flowchart (TD / LR / TB variant)',
	deployment: 'flowchart (deployment-styled; LR variant typical)',
	callflow: 'sequenceDiagram (services as participants, spans as duration-labelled messages)',
};

function buildMermaidEditPrompt(
	kind: Exclude<ArtifactKind, 'wireframe'>,
	priorSource: string,
	edits: string,
): LLMMessage[] {
	const system = [
		`You edit Mermaid source for ${kind} artifacts.`,
		'',
		`Return ONLY the updated Mermaid source (same ${MERMAID_GRAMMAR[kind]} grammar).`,
		'No prose, no markdown code fences, no commentary.',
		'',
		'Rules:',
		'- Preserve every node / edge / participant the user did NOT explicitly ask to remove.',
		'- Match Mermaid grammar precisely; the output is rendered verbatim.',
		'- When the user asks for layout direction changes, update only the header directive',
		'  (e.g. `flowchart TD` -> `flowchart LR`).',
	].join('\n');
	const user = [
		'## Current source',
		priorSource,
		'',
		'## Edit request',
		edits,
		'',
		'## Updated source',
	].join('\n');
	return [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	];
}

function buildWireframeEditPrompt(
	priorSpecJson: string,
	edits: string,
): LLMMessage[] {
	const system = [
		'You edit WireframeSpec JSON for wireframe artifacts.',
		'',
		'Return ONLY a JSON object matching this shape (no markdown, no prose):',
		'{',
		'  "layout": "desktop" | "tablet" | "mobile",',
		'  "rows": [',
		'    {',
		'      "height": number | "auto",',
		'      "cells": [',
		'        {',
		'          "kind": "header" | "nav" | "content" | "sidebar" | "footer" | "placeholder",',
		'          "label": string,',
		'          "widthRatio": number,',
		'          "children": [...]',
		'        }',
		'      ]',
		'    }',
		'  ]',
		'}',
		'',
		'Preserve every row / cell the user did NOT explicitly ask to remove.',
	].join('\n');
	const user = [
		'## Current spec',
		priorSpecJson,
		'',
		'## Edit request',
		edits,
		'',
		'## Updated spec',
	].join('\n');
	return [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	];
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Strip markdown fences + surrounding whitespace from an LLM reply. */
function stripFences(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith('```')) { return trimmed; }
	return trimmed
		.replace(/^```(?:[a-z]+)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
}

/** Pull the first balanced `{...}` object out of a JSON-bearing reply. */
function extractFirstJsonObject(text: string): unknown | null {
	const unfenced = stripFences(text);
	const start = unfenced.indexOf('{');
	if (start < 0) { return null; }
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < unfenced.length; i++) {
		const ch = unfenced[i];
		if (escape) { escape = false; continue; }
		if (ch === '\\') { escape = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) { continue; }
		if (ch === '{') { depth++; }
		else if (ch === '}') {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(unfenced.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Wireframe-spec shape guard (mirrors wireframe.ts; kept local here so
// the regenerate module doesn't grow a cross-dep.)
// ---------------------------------------------------------------------------

const CELL_KINDS: readonly string[] = [
	'header', 'nav', 'content', 'sidebar', 'footer', 'placeholder',
];

function validateWireframeSpec(candidate: unknown): WireframeSpec | null {
	if (candidate === null || typeof candidate !== 'object') { return null; }
	const c = candidate as Record<string, unknown>;
	const layout = c['layout'];
	if (layout !== 'desktop' && layout !== 'tablet' && layout !== 'mobile') { return null; }
	const rawRows = c['rows'];
	if (!Array.isArray(rawRows) || rawRows.length === 0) { return null; }
	const rows: { height: number | 'auto'; cells: unknown[] }[] = [];
	for (const rawRow of rawRows) {
		if (rawRow === null || typeof rawRow !== 'object') { return null; }
		const r = rawRow as Record<string, unknown>;
		const h = r['height'];
		if (h !== 'auto' && !(typeof h === 'number' && Number.isFinite(h) && h > 0)) { return null; }
		const rawCells = r['cells'];
		if (!Array.isArray(rawCells) || rawCells.length === 0) { return null; }
		for (const rc of rawCells) {
			if (rc === null || typeof rc !== 'object') { return null; }
			const kind = (rc as Record<string, unknown>)['kind'];
			if (typeof kind !== 'string' || !CELL_KINDS.includes(kind)) { return null; }
		}
		rows.push({ height: h as number | 'auto', cells: rawCells });
	}
	// `candidate` has already been narrowed by every path above; cast
	// through unknown to avoid duplicating the full nested shape here.
	return candidate as unknown as WireframeSpec;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RegenerateOpts {
	readonly sessionId: string;
	readonly artifactId: string;
	readonly edits: string;
	readonly api: TodosApi;
	readonly provider: LLMProvider;
	readonly repoRoot?: string | undefined;
}

export interface RegenerateResult {
	readonly artifact: ArtifactResult;
	readonly item: TodoItem;
	readonly revisionCount: number;
}

/**
 * Iteratively edit an existing artifact via an LLM source-rewrite.
 * Same-kind replacement: if the source was an ER diagram it stays
 * an ER diagram. Revision history is pushed via
 * `persistence.appendRevision`.
 */
export async function regenerateArtifact(
	opts: RegenerateOpts,
): Promise<RegenerateResult> {
	const persisted = await findByArtifactId(opts.api, opts.sessionId, opts.artifactId);
	if (persisted === null) {
		throw new Error(
			`artifact:regenerate: no artifact with id '${opts.artifactId}' on session '${opts.sessionId}'`,
		);
	}
	const priorMeta = persisted.item.meta as unknown as ArtifactItemMeta | undefined;
	if (
		priorMeta === undefined
		|| typeof priorMeta !== 'object'
		|| typeof priorMeta.source !== 'string'
		|| typeof priorMeta.kind !== 'string'
	) {
		throw new Error(
			`artifact:regenerate: item '${persisted.item.id}' has no artifact meta`,
		);
	}

	const newSourcePayload = await rewriteSource(
		priorMeta.kind,
		priorMeta.source,
		opts.edits,
		opts.provider,
	);
	if (newSourcePayload === null) {
		throw new Error(
			`artifact:regenerate: LLM produced an unparseable ${priorMeta.kind} source`,
		);
	}

	// Fresh id so the consumer's DOM element refreshes cleanly; the
	// TodoItem.id stays the same so widgets tracking by itemId
	// continue to update in place.
	const newArtifactId = randomBytes(16).toString('hex');
	const generatedAt = new Date().toISOString();
	const provenance = 'LLM regenerate from prior source';

	const rendered = await bindTemplate({
		artifactKind: priorMeta.kind,
		id: newArtifactId,
		source: newSourcePayload.renderSource,
		sourceKind: priorMeta.kind === 'wireframe' ? 'svg' : 'mermaid',
		title: priorMeta.title ?? `${priorMeta.kind} artifact`,
		metaLine: provenance,
		provenance,
		generatedAt,
		...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
	});

	const newResult: ArtifactResult = {
		id: newArtifactId,
		kind: priorMeta.kind,
		source: newSourcePayload.storedSource,
		renderedHtml: rendered,
		...(priorMeta.title !== undefined ? { title: priorMeta.title } : {}),
		metadata: {
			...priorMeta.metadata,
			generatedAt,
			provenance,
			regeneratedFrom: opts.artifactId,
		},
		warnings: [],
		confidence: 'medium',
	};

	const updatedItem = await appendRevision(opts.api, persisted.item.id, {
		edits: opts.edits,
		newResult,
	});

	const updatedMeta = updatedItem.meta as unknown as ArtifactItemMeta;
	log.info({
		sessionId: opts.sessionId,
		itemId: persisted.item.id,
		priorArtifactId: opts.artifactId,
		newArtifactId,
		kind: priorMeta.kind,
		edits: opts.edits.slice(0, 80),
		revisions: updatedMeta.revisions.length,
	}, 'artifact regenerated');

	return {
		artifact: newResult,
		item: updatedItem,
		revisionCount: updatedMeta.revisions.length,
	};
}

// ---------------------------------------------------------------------------
// Internals -- LLM source rewrite per kind
// ---------------------------------------------------------------------------

interface RewriteOutput {
	/** What the binder's `@@SOURCE@@` slot sees (Mermaid text or SVG string). */
	readonly renderSource: string;
	/** What's stored on `meta.source` for future regenerate calls. */
	readonly storedSource: string;
}

async function rewriteSource(
	kind: ArtifactKind,
	priorSource: string,
	edits: string,
	provider: LLMProvider,
): Promise<RewriteOutput | null> {
	if (kind === 'wireframe') {
		return rewriteWireframe(priorSource, edits, provider);
	}
	return rewriteMermaid(kind, priorSource, edits, provider);
}

async function rewriteMermaid(
	kind: Exclude<ArtifactKind, 'wireframe'>,
	priorSource: string,
	edits: string,
	provider: LLMProvider,
): Promise<RewriteOutput | null> {
	try {
		const response: LLMResponse = await provider.complete(
			buildMermaidEditPrompt(kind, priorSource, edits),
			{ temperature: 0.2, maxTokens: 1500 },
		);
		const cleaned = stripFences(response.text).trim();
		if (cleaned === '') { return null; }
		// For Mermaid kinds, both `renderSource` and `storedSource` are
		// the same Mermaid text -- the binder handles its own narrow
		// escape before slot substitution.
		return { renderSource: cleaned, storedSource: cleaned };
	} catch (err) {
		log.warn({ kind, err: (err as Error).message }, 'mermaid regenerate failed');
		return null;
	}
}

async function rewriteWireframe(
	priorSpecJson: string,
	edits: string,
	provider: LLMProvider,
): Promise<RewriteOutput | null> {
	try {
		const response: LLMResponse = await provider.complete(
			buildWireframeEditPrompt(priorSpecJson, edits),
			{ temperature: 0.2, maxTokens: 1500 },
		);
		const parsed = extractFirstJsonObject(response.text);
		if (parsed === null) { return null; }
		const spec = validateWireframeSpec(parsed);
		if (spec === null) { return null; }
		return {
			renderSource: renderWireframe(spec),
			storedSource: JSON.stringify(spec, null, 2),
		};
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'wireframe regenerate failed');
		return null;
	}
}
