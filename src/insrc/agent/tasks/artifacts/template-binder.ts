/**
 * Template binder.
 *
 * Consumes a kind's raw render payload (Mermaid text or an already-
 * rendered SVG string) and the artifact's metadata, and returns two
 * bound HTML strings:
 *
 *   - embedded   -- `@@RENDERER_SCRIPT@@` is the empty string;
 *                    relies on the host surface to load Mermaid once
 *                    per session.
 *   - standalone -- `@@RENDERER_SCRIPT@@` is the trusted snippet
 *                    from `_renderer.html`, with the CDN script tag
 *                    bound from `mermaid-cdn.json` (SRI-pinned).
 *
 * Substitution is plain string-replace on `@@NAME@@` tokens; see
 * design/artifacts/index.html §7.1 for the slot contract. Every slot
 * value except `@@SOURCE@@` and `@@RENDERER_SCRIPT@@` passes through
 * `sanitiseSlotValue` first.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from '../../../shared/logger.js';
import type {
	ArtifactKind,
	MermaidCdnMeta,
	RenderedArtifactHtml,
} from '../../../shared/artifacts.js';
import { loadRendererSnippet, loadTemplate } from './template-loader.js';
import { escapeMermaidSource, sanitiseSlotValue } from './sanitise.js';

const log = getLogger('artifact-binder');

// ---------------------------------------------------------------------------
// CDN metadata (mermaid-cdn.json)
// ---------------------------------------------------------------------------

const MERMAID_CDN_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../assets/artifacts/mermaid-cdn.json',
);

let mermaidCdnCache: MermaidCdnMeta | undefined;

async function getMermaidCdnMeta(): Promise<MermaidCdnMeta> {
	if (mermaidCdnCache !== undefined) { return mermaidCdnCache; }
	const raw = await readFile(MERMAID_CDN_PATH, 'utf8');
	const parsed = JSON.parse(raw) as Partial<MermaidCdnMeta>;
	if (
		typeof parsed.version !== 'string' ||
		typeof parsed.scriptUrl !== 'string' ||
		typeof parsed.integrity !== 'string' ||
		parsed.crossorigin !== 'anonymous'
	) {
		throw new Error(`artifact-binder: malformed mermaid-cdn.json at ${MERMAID_CDN_PATH}`);
	}
	mermaidCdnCache = {
		version: parsed.version,
		scriptUrl: parsed.scriptUrl,
		integrity: parsed.integrity,
		crossorigin: 'anonymous',
	};
	return mermaidCdnCache;
}

// ---------------------------------------------------------------------------
// Binder input / output
// ---------------------------------------------------------------------------

export type BinderSourceKind = 'mermaid' | 'svg';

export interface BindRequest {
	readonly artifactKind: ArtifactKind;
	/** Stable artifact id, used for the `@@ID@@` slot and DOM attribution. */
	readonly id: string;
	/** The renderer payload. For `sourceKind: 'mermaid'`, this is Mermaid
	 *  text that lands verbatim inside `<pre class="mermaid">` (after
	 *  narrow-escape). For `sourceKind: 'svg'`, the string is already
	 *  valid SVG emitted by our own deterministic wireframe renderer. */
	readonly source: string;
	readonly sourceKind: BinderSourceKind;

	readonly title: string;
	/** One-line summary shown in the header; binder already sanitises. */
	readonly metaLine: string;
	/** Free-text provenance ("live DB: primary", "docker-compose.yml",
	 *  "free-text", etc.) for the footer. */
	readonly provenance: string;
	/** ISO-8601 timestamp rendered in the footer. */
	readonly generatedAt: string;
	/** Optional legend HTML fragment. Sanitised through
	 *  `sanitiseSlotValue` same as every other slot -- authors that want
	 *  richer legends should use the repo template override instead of
	 *  passing raw HTML here. */
	readonly legend?: string | undefined;
	/** Optional repo root for the per-repo template-override layer. */
	readonly repoRoot?: string | undefined;
}

// ---------------------------------------------------------------------------
// Slot substitution
// ---------------------------------------------------------------------------

const SLOT_NAMES = [
	'@@ID@@',
	'@@TITLE@@',
	'@@SOURCE@@',
	'@@META_LINE@@',
	'@@LEGEND@@',
	'@@GENERATED_AT@@',
	'@@PROVENANCE@@',
	'@@RENDERER_SCRIPT@@',
] as const;

type SlotName = typeof SLOT_NAMES[number];

type SlotMap = Readonly<Record<SlotName, string>>;

function substitute(template: string, slots: SlotMap): string {
	let out = template;
	for (const slot of SLOT_NAMES) {
		// Plain string replace-all. Slot tokens are chosen so they don't
		// collide with real template text; the binder doesn't do DSL
		// escaping.
		out = out.split(slot).join(slots[slot]);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Renderer-script binding (standalone mode only)
// ---------------------------------------------------------------------------

async function buildStandaloneRendererScript(
	sourceKind: BinderSourceKind,
): Promise<string> {
	// Wireframes are raw SVG -- the host (or any embedding surface)
	// needs no external script to display them. Return the empty string
	// in both modes.
	if (sourceKind === 'svg') { return ''; }

	const [snippet, cdn] = await Promise.all([
		loadRendererSnippet(),
		getMermaidCdnMeta(),
	]);
	const scriptTag =
		`<script src="${cdn.scriptUrl}" integrity="${cdn.integrity}" crossorigin="${cdn.crossorigin}"></script>`;
	return snippet.split('@@MERMAID_SCRIPT_TAG@@').join(scriptTag);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bind a kind's template twice -- once per output mode. Both strings
 * come back in the `RenderedArtifactHtml` bundle the caller attaches
 * to its `ArtifactResult`.
 */
export async function bindTemplate(req: BindRequest): Promise<RenderedArtifactHtml> {
	const tpl = await loadTemplate(req.artifactKind, req.repoRoot !== undefined ? { repoRoot: req.repoRoot } : {});

	// Slot values shared between both modes.
	const sharedSlots = {
		'@@ID@@': sanitiseSlotValue(req.id),
		'@@TITLE@@': sanitiseSlotValue(req.title),
		'@@SOURCE@@':
			req.sourceKind === 'mermaid'
				? escapeMermaidSource(req.source)
				: req.source, // trusted SVG from our own renderer
		'@@META_LINE@@': sanitiseSlotValue(req.metaLine),
		'@@LEGEND@@': req.legend === undefined ? '' : sanitiseSlotValue(req.legend),
		'@@GENERATED_AT@@': sanitiseSlotValue(req.generatedAt),
		'@@PROVENANCE@@': sanitiseSlotValue(req.provenance),
	} as const;

	const embeddedSlots: SlotMap = {
		...sharedSlots,
		'@@RENDERER_SCRIPT@@': '',
	};

	const standaloneRenderer = await buildStandaloneRendererScript(req.sourceKind);
	const standaloneSlots: SlotMap = {
		...sharedSlots,
		'@@RENDERER_SCRIPT@@': standaloneRenderer,
	};

	const embedded = substitute(tpl.text, embeddedSlots);
	const standalone = substitute(tpl.text, standaloneSlots);

	log.debug({
		kind: req.artifactKind,
		layer: tpl.layer,
		id: req.id,
		sourceKind: req.sourceKind,
		embeddedBytes: embedded.length,
		standaloneBytes: standalone.length,
	}, 'artifact bound');

	return { embedded, standalone };
}
