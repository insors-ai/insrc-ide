/**
 * Wireframe artifact kind.
 *
 * Source priority (first match wins):
 *   1. Caller-supplied `spec` -- rendered verbatim.
 *   2. `component` -- name of an in-tree React component. The
 *      walker (§4.1) looks the function up in Kuzu, reads its
 *      source body, and runs a fresh tree-sitter pass to derive
 *      a low-fi `WireframeSpec` from the JSX. Recursive descent
 *      into in-tree imports up to `depth` (default 3). Falls
 *      through on lookup / parse failure.
 *   3. Free-text `description` + LLM stage-2 (local Ollama by
 *      default) -- LLM emits a WireframeSpec JSON that the
 *      deterministic SVG renderer then paints.
 *   4. Free-text `description` only (no provider, or LLM failed) --
 *      deterministic default layout scaffold.
 */

import { randomBytes } from 'node:crypto';
import { getLogger } from '../../../../shared/logger.js';
import type {
	ArtifactResult,
	WireframeCell,
	WireframeLayout,
	WireframeOptions,
	WireframeRow,
	WireframeSpec,
} from '../../../../shared/artifacts.js';
import type { LLMProvider } from '../../../../shared/types.js';
import { getDb } from '../../../../db/client.js';
import { bindTemplate } from '../template-binder.js';
import { renderWireframe } from '../wireframe/render.js';
import { introspectComponent } from './wireframe-introspect.js';

const log = getLogger('artifact-kind-wireframe');

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/**
 * Tool-level options for this kind. Extends the public
 * `WireframeOptions` with a raw `spec` field so callers that have
 * already produced a spec (e.g. an agent doing its own LLM pass) can
 * pass it in directly.
 */
export interface WireframeInput extends WireframeOptions {
	readonly spec?: WireframeSpec | undefined;
}

function isLayout(value: unknown): value is WireframeLayout {
	return value === 'desktop' || value === 'mobile' || value === 'tablet';
}

/**
 * Minimal deterministic fallback spec when the caller didn't pass a
 * structured one. Picks a sensible scaffold per layout and surfaces
 * the user's description as the `content` cell label so the diagram
 * reflects the request even before LLM stage-2 is wired in.
 */
function defaultSpec(layout: WireframeLayout, description: string): WireframeSpec {
	const contentLabel = description.trim() !== ''
		? description.trim()
		: 'Content';

	if (layout === 'mobile') {
		const rows: readonly WireframeRow[] = [
			{ height: 48,     cells: [{ kind: 'header', label: 'Header' }] },
			{ height: 'auto', cells: [{ kind: 'content', label: contentLabel }] },
			{ height: 48,     cells: [{ kind: 'footer', label: 'Footer' }] },
		];
		return { layout, rows };
	}

	// desktop / tablet share the sidebar-content layout.
	const mainCells: readonly WireframeCell[] = [
		{ kind: 'nav',     label: 'Nav',     widthRatio: 1 },
		{ kind: 'content', label: contentLabel, widthRatio: 4 },
		{ kind: 'sidebar', label: 'Sidebar', widthRatio: 1 },
	];
	const rows: readonly WireframeRow[] = [
		{ height: 56,     cells: [{ kind: 'header', label: 'Header' }] },
		{ height: 'auto', cells: mainCells },
		{ height: 48,     cells: [{ kind: 'footer', label: 'Footer' }] },
	];
	return { layout, rows };
}

// ---------------------------------------------------------------------------
// Spec -> source-string (JSON serialisation for revision storage)
// ---------------------------------------------------------------------------

/**
 * The artifact's editable `source` string is a pretty-printed JSON
 * dump of the spec. This is what phase-2 regenerate re-parses to
 * apply user edits, so it must be round-trippable. The rendered
 * output (what the binder substitutes into `@@SOURCE@@`) is the SVG,
 * not the JSON.
 */
function specToSource(spec: WireframeSpec): string {
	return JSON.stringify(spec, null, 2);
}

// ---------------------------------------------------------------------------
// LLM stage-2: free-text -> WireframeSpec
// ---------------------------------------------------------------------------

const CELL_KINDS: readonly string[] = [
	'header', 'nav', 'content', 'sidebar', 'footer', 'placeholder',
];

/**
 * Runtime shape guard on a WireframeSpec returned by the LLM. We
 * don't trust the model's output; validate every field and narrow
 * before passing to the SVG renderer (which is pure but would happily
 * produce a weird diagram from a weird spec).
 */
function validateSpec(candidate: unknown): WireframeSpec | null {
	if (candidate === null || typeof candidate !== 'object') { return null; }
	const c = candidate as Record<string, unknown>;
	const layout = c['layout'];
	if (layout !== 'desktop' && layout !== 'tablet' && layout !== 'mobile') { return null; }
	const rawRows = c['rows'];
	if (!Array.isArray(rawRows) || rawRows.length === 0) { return null; }

	const rows: WireframeRow[] = [];
	for (const rawRow of rawRows) {
		if (rawRow === null || typeof rawRow !== 'object') { return null; }
		const r = rawRow as Record<string, unknown>;
		const height = r['height'];
		const heightOk = height === 'auto' || (typeof height === 'number' && Number.isFinite(height) && height > 0);
		if (!heightOk) { return null; }
		const rawCells = r['cells'];
		if (!Array.isArray(rawCells) || rawCells.length === 0) { return null; }
		const cells = validateCells(rawCells);
		if (cells === null) { return null; }
		rows.push({ height: height as number | 'auto', cells });
	}
	return { layout, rows };
}

function validateCells(rawCells: readonly unknown[]): WireframeCell[] | null {
	const cells: WireframeCell[] = [];
	for (const rawCell of rawCells) {
		if (rawCell === null || typeof rawCell !== 'object') { return null; }
		const rc = rawCell as Record<string, unknown>;
		const kind = rc['kind'];
		if (typeof kind !== 'string' || !CELL_KINDS.includes(kind)) { return null; }
		const cell: WireframeCell = { kind: kind as WireframeCell['kind'] };
		const c: Record<string, unknown> = cell as unknown as Record<string, unknown>;
		if (typeof rc['label'] === 'string' && rc['label'].length > 0) {
			c['label'] = rc['label'];
		}
		if (typeof rc['widthRatio'] === 'number' && Number.isFinite(rc['widthRatio']) && (rc['widthRatio'] as number) > 0) {
			c['widthRatio'] = rc['widthRatio'];
		}
		if (Array.isArray(rc['children'])) {
			const childRows: WireframeRow[] = [];
			for (const cr of rc['children']) {
				if (cr === null || typeof cr !== 'object') { return null; }
				const crr = cr as Record<string, unknown>;
				const h = crr['height'];
				if (h !== 'auto' && !(typeof h === 'number' && Number.isFinite(h) && h > 0)) { return null; }
				if (!Array.isArray(crr['cells'])) { return null; }
				const nestedCells = validateCells(crr['cells']);
				if (nestedCells === null) { return null; }
				childRows.push({ height: h as number | 'auto', cells: nestedCells });
			}
			c['children'] = childRows;
		}
		cells.push(cell);
	}
	return cells;
}

function buildSpecPrompt(description: string, layout: WireframeLayout): string {
	// Strict-output JSON prompt. Keeping the instructions short and
	// imperative keeps small local models from wandering into prose.
	return [
		'You produce WireframeSpec JSON for low-fidelity UI wireframes.',
		'',
		'Output ONLY a JSON object matching this shape (no markdown, no prose):',
		'{',
		'  "layout": "desktop" | "tablet" | "mobile",',
		'  "rows": [',
		'    {',
		'      "height": number | "auto",',
		'      "cells": [',
		'        {',
		'          "kind": "header" | "nav" | "content" | "sidebar" | "footer" | "placeholder",',
		'          "label": string,',
		'          "widthRatio": number,        // optional; defaults to 1; governs horizontal split within a row',
		'          "children": [                // optional; nested rows inside a cell',
		'            { "height": number | "auto", "cells": [...] }',
		'          ]',
		'        }',
		'      ]',
		'    }',
		'  ]',
		'}',
		'',
		`Target layout: ${layout}.`,
		`Description: ${description}`,
		'',
		'Rules:',
		'- Use "auto" height for the main content row, numeric heights (48-72 px) for header/footer.',
		'- widthRatio is a relative number (1, 2, 3...). Omit when cells should share the row equally.',
		'- Prefer 3-6 rows total. Use placeholder only for regions without a clear label.',
	].join('\n');
}

function extractJsonObject(text: string): unknown {
	// LLMs sometimes wrap the JSON in ``` fences or prepend an
	// apology. Peel off fences, then grab the first balanced { ... }.
	const trimmed = text.trim();
	const unfenced = trimmed.startsWith('```')
		? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
		: trimmed;
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

async function synthesiseSpec(
	provider: LLMProvider,
	description: string,
	layout: WireframeLayout,
): Promise<WireframeSpec | null> {
	const prompt = buildSpecPrompt(description, layout);
	try {
		const response = await provider.complete(
			[
				{ role: 'system', content: prompt },
				{ role: 'user', content: description || 'wireframe' },
			],
			{ temperature: 0.2, maxTokens: 1200 },
		);
		const parsed = extractJsonObject(response.text);
		if (parsed === null) { return null; }
		return validateSpec(parsed);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'wireframe LLM synthesis threw');
		return null;
	}
}

// ---------------------------------------------------------------------------
// React-component introspection branch (§4.1)
// ---------------------------------------------------------------------------

/**
 * Try the on-demand React introspection branch. Returns null on
 * any failure (graph DB unavailable, entity not found, wrong
 * language, parse failure) so the caller falls through to the
 * LLM / scaffold paths. Records warnings on each fallthrough so
 * the user sees the reason.
 */
async function tryIntrospect(
	componentName: string,
	depth: number | undefined,
	repoRoot: string | undefined,
	warnings: string[],
): Promise<{
	spec: WireframeSpec;
	entity: { name: string; language: string };
	note?: string | undefined;
} | null> {
	const db = await getDb().catch(() => null);
	if (db === null) {
		warnings.push('React introspection skipped: graph DB unavailable. Falling through to LLM / scaffold.');
		return null;
	}
	try {
		const result = await introspectComponent({
			componentName,
			db,
			...(repoRoot !== undefined ? { repoPath: repoRoot } : {}),
			...(depth !== undefined ? { depth } : {}),
		});
		return {
			spec: result.spec,
			entity: { name: result.entity.name, language: result.entity.language },
			...(result.note !== undefined ? { note: result.note } : {}),
		};
	} catch (err) {
		warnings.push(`React introspection failed: ${(err as Error).message}. Falling through to LLM / scaffold.`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RunWireframeOpts {
	readonly sessionId: string;
	readonly repoRoot?: string | undefined;
	readonly input: WireframeInput;
	readonly provider?: LLMProvider | undefined;
}

/**
 * Generate a wireframe artifact. Returns the full `ArtifactResult`
 * (includes both embedded + standalone HTML). Persistence is the
 * caller's responsibility; this function is pure over its inputs.
 */
export async function runWireframe(opts: RunWireframeOpts): Promise<ArtifactResult> {
	const { input } = opts;
	const layout: WireframeLayout = isLayout(input.layout) ? input.layout : 'desktop';
	const warnings: string[] = [];

	let spec: WireframeSpec;
	let provenance: string;
	let confidence: 'high' | 'medium' | 'low';

	if (input.spec !== undefined) {
		spec = input.spec;
		provenance = 'caller-supplied spec';
		confidence = 'high';
	} else if (input.component !== undefined && input.component.trim() !== '') {
		const introspected = await tryIntrospect(input.component, input.depth, opts.repoRoot, warnings);
		if (introspected !== null) {
			spec = introspected.spec;
			provenance = `React introspection on '${introspected.entity.name}' (${introspected.entity.language})`;
			confidence = 'high';
			if (introspected.note !== undefined) { warnings.push(introspected.note); }
		} else {
			// Introspection failed -- fall through to LLM / scaffold.
			if (
				opts.provider !== undefined
				&& input.description !== undefined
				&& input.description.trim() !== ''
			) {
				const synthesised = await synthesiseSpec(opts.provider, input.description, layout);
				if (synthesised !== null) {
					spec = synthesised;
					provenance = 'LLM synthesis from description (introspection fallback)';
					confidence = 'medium';
				} else {
					spec = defaultSpec(layout, input.description);
					provenance = 'default layout (introspection + LLM both failed)';
					confidence = 'low';
				}
			} else {
				spec = defaultSpec(layout, input.description ?? input.component);
				provenance = 'default layout (introspection failed; no LLM provider)';
				confidence = 'low';
			}
		}
	} else if (
		opts.provider !== undefined
		&& input.description !== undefined
		&& input.description.trim() !== ''
	) {
		const synthesised = await synthesiseSpec(opts.provider, input.description, layout);
		if (synthesised !== null) {
			spec = synthesised;
			provenance = 'LLM synthesis from description';
			confidence = 'medium';
		} else {
			warnings.push(
				'LLM failed to produce a valid WireframeSpec; fell back to a default layout scaffold. ' +
				'Try regenerating or pass a structured spec.',
			);
			spec = defaultSpec(layout, input.description);
			provenance = 'default layout (LLM synthesis failed)';
			confidence = 'low';
		}
	} else {
		if (input.description === undefined || input.description.trim() === '') {
			warnings.push(
				'wireframe generated from default layout scaffold (no description or spec supplied). ' +
				'Supply a description to drive LLM synthesis, or pass a spec directly.',
			);
		} else {
			warnings.push(
				'wireframe generated from default layout scaffold (no LLM provider available). ' +
				'Structured synthesis requires a session-bound provider.',
			);
		}
		spec = defaultSpec(layout, input.description ?? '');
		provenance = 'default layout';
		confidence = 'low';
	}

	const svg = renderWireframe(spec);

	const id = randomBytes(16).toString('hex');
	const generatedAt = new Date().toISOString();
	const title = input.title?.trim() !== undefined && input.title.trim() !== ''
		? input.title.trim()
		: `Wireframe (${layout})`;

	const metaLine = `${layout} · ${spec.rows.length} row${spec.rows.length === 1 ? '' : 's'}`;

	const rendered = await bindTemplate({
		artifactKind: 'wireframe',
		id,
		source: svg,
		sourceKind: 'svg',
		title,
		metaLine,
		provenance,
		generatedAt,
		...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
	});

	const metadata: Record<string, string> = {
		generatedAt,
		provenance,
		layout,
	};

	const result: ArtifactResult = {
		id,
		kind: 'wireframe',
		source: specToSource(spec),
		renderedHtml: rendered,
		title,
		metadata,
		warnings,
		confidence,
	};

	log.info({
		sessionId: opts.sessionId,
		artifactId: id,
		layout,
		provenance,
		confidence,
	}, 'wireframe generated');

	return result;
}
