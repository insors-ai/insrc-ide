/**
 * Shared helper for Mermaid-based artifact kinds (er / sequence /
 * flow / deployment).
 *
 * Each kind resolves its own (title, mermaid source, provenance,
 * warnings, confidence) from the tool input + any data-source lookups,
 * then calls `runMermaidArtifact` to bind the template and build the
 * `ArtifactResult`. Keeps the four kind modules focused on their
 * per-kind concerns and the binder invocation in one place.
 *
 * The wireframe kind does NOT go through this helper because its
 * rendered source is SVG, not Mermaid text (see `binder.sourceKind`).
 */

import { randomBytes } from 'node:crypto';
import { getLogger } from '../../../../shared/logger.js';
import type {
	ArtifactConfidence,
	ArtifactKind,
	ArtifactResult,
} from '../../../../shared/artifacts.js';
import { bindTemplate } from '../template-binder.js';
import type { KindRunOpts } from '../registry.js';

const log = getLogger('artifact-kind-mermaid');

/** Mermaid-source kinds this helper supports. Excludes `wireframe`. */
export type MermaidArtifactKind = Exclude<ArtifactKind, 'wireframe'>;

export interface MermaidArtifactInvocation {
	readonly kind: MermaidArtifactKind;
	readonly title: string;
	/** Raw Mermaid text. The binder narrow-escapes (&, <, >) before
	 *  substitution; callers should not pre-escape. */
	readonly mermaidSource: string;
	/** Compact one-line summary rendered in the header. */
	readonly metaLine: string;
	/** Where the source came from: "caller-supplied source",
	 *  "docker-compose.yml", "free-text (default scaffold)", etc. */
	readonly provenance: string;
	readonly confidence: ArtifactConfidence;
	/** Degrade notices the caller wants surfaced to the user. */
	readonly warnings?: readonly string[] | undefined;
	/** Extra provenance metadata. Keys show up on the result's meta
	 *  bag alongside the binder-managed `generatedAt` / `provenance`. */
	readonly metadata?: Readonly<Record<string, string>> | undefined;
}

/**
 * Bind + package a Mermaid artifact. Returns the full
 * `ArtifactResult`; persistence is the caller's responsibility.
 */
export async function runMermaidArtifact(
	inv: MermaidArtifactInvocation,
	opts: KindRunOpts,
): Promise<ArtifactResult> {
	const id = randomBytes(16).toString('hex');
	const generatedAt = new Date().toISOString();

	const rendered = await bindTemplate({
		artifactKind: inv.kind,
		id,
		source: inv.mermaidSource,
		sourceKind: 'mermaid',
		title: inv.title,
		metaLine: inv.metaLine,
		provenance: inv.provenance,
		generatedAt,
		...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
	});

	const metadata: Record<string, string> = {
		...(inv.metadata ?? {}),
		generatedAt,
		provenance: inv.provenance,
	};

	const result: ArtifactResult = {
		id,
		kind: inv.kind,
		source: inv.mermaidSource,
		renderedHtml: rendered,
		title: inv.title,
		metadata,
		warnings: inv.warnings ?? [],
		confidence: inv.confidence,
	};

	log.info({
		sessionId: opts.sessionId,
		kind: inv.kind,
		artifactId: id,
		provenance: inv.provenance,
		confidence: inv.confidence,
	}, 'mermaid artifact rendered');

	return result;
}

// ---------------------------------------------------------------------------
// Input helpers shared by the Mermaid kinds
// ---------------------------------------------------------------------------

/**
 * Common fields every Mermaid kind's input accepts. Each kind extends
 * this with its own kind-specific options.
 */
export interface MermaidCommonInput {
	readonly title?: string | undefined;
	readonly description?: string | undefined;
	/** Pre-built Mermaid text. When present the kind skips its
	 *  default-source path and uses this verbatim. */
	readonly source?: string | undefined;
}

/**
 * Collapse multi-line or whitespace-noisy description text into a
 * single cleaned-up line. Used by the default-source generators to
 * embed the caller's intent as a diagram label without breaking
 * Mermaid's line grammar.
 */
export function cleanOneLine(text: string | undefined, fallback: string): string {
	if (text === undefined) { return fallback; }
	const trimmed = text.replace(/\s+/g, ' ').trim();
	return trimmed === '' ? fallback : trimmed;
}

/**
 * Truncate a string to a fixed byte length for use in header metaLine
 * summaries (the binder sanitises HTML, but readability still wants a
 * short snippet).
 */
export function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, Math.max(0, max - 3)) + '...' : text;
}
