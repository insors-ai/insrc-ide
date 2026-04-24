/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TodoItem, TodoList } from './todosService.js';

/**
 * Browser-side artifact types + shape guards.
 *
 * Artifacts ride the existing `todos` stream -- each artifact is a
 * completed TodoItem on a per-session `Artifacts` list (see
 * plans/artifact-tasks.md section 1.5). The chat widget inspects `item.meta`
 * to tell regular todo items apart from artifact items; this module
 * holds the shared detection helpers + the narrow subset of meta
 * fields the browser cares about.
 *
 * The canonical shape lives in the daemon at
 * `src/insrc/shared/artifacts.ts` (`ArtifactItemMeta`). Types here
 * mirror that subset -- same duplication pattern
 * `todosService.ts` uses for TodoItem / TodoList. The wire format is
 * the contract; no cross-boundary imports.
 */

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export type ArtifactKind =
	| 'er'
	| 'sequence'
	| 'flow'
	| 'deployment'
	| 'wireframe';

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
	'er',
	'sequence',
	'flow',
	'deployment',
	'wireframe',
];

const ARTIFACT_KIND_SET: ReadonlySet<string> = new Set(ARTIFACT_KINDS);

export type ArtifactConfidence = 'high' | 'medium' | 'low';

// ---------------------------------------------------------------------------
// Persisted meta shape (subset of ArtifactItemMeta the browser uses)
// ---------------------------------------------------------------------------

export interface ArtifactRenderedHtml {
	readonly embedded: string;
	readonly standalone: string;
}

/**
 * One entry in an artifact's revision history. Mirrors the daemon's
 * `ArtifactRevisionRecord` shape -- we only read these on the
 * browser side (the Artifacts pane surfaces count + tooltip from
 * them).
 */
export interface ArtifactRevisionRecord {
	readonly at: string;
	readonly edits: string;
	readonly source: string;
}

export interface ArtifactItemMeta {
	readonly kind: ArtifactKind;
	readonly source: string;
	readonly renderedHtml: ArtifactRenderedHtml;
	readonly title?: string | undefined;
	readonly metadata: Readonly<Record<string, string>>;
	readonly warnings: readonly string[];
	readonly confidence: ArtifactConfidence;
	/** Last-N prior sources kept on regenerate
	 *  (plans/artifact-tasks.md section 2.1). May be absent on items
	 *  generated before revision tracking landed. */
	readonly revisions?: readonly ArtifactRevisionRecord[] | undefined;
}

// ---------------------------------------------------------------------------
// Shape guards
// ---------------------------------------------------------------------------

/**
 * Type-guards an unknown value into an `ArtifactItemMeta`. Only checks
 * the fields the chat widget actually reads (kind + renderedHtml);
 * richer validation would add weight without value here.
 */
export function isArtifactItemMeta(value: unknown): value is ArtifactItemMeta {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const meta = value as Record<string, unknown>;
	const kind = meta['kind'];
	if (typeof kind !== 'string' || !ARTIFACT_KIND_SET.has(kind)) {
		return false;
	}
	const rendered = meta['renderedHtml'];
	if (rendered === null || typeof rendered !== 'object') {
		return false;
	}
	const r = rendered as Record<string, unknown>;
	if (typeof r['embedded'] !== 'string' || typeof r['standalone'] !== 'string') {
		return false;
	}
	return true;
}

/** Convenience wrapper: a TodoItem is an artifact item iff its meta
 *  satisfies `ArtifactItemMeta`. */
export function isArtifactItem(item: TodoItem): boolean {
	return isArtifactItemMeta(item.meta);
}

/**
 * A list is treated as an "artifacts list" when its title is the
 * conventional `'Artifacts'` the daemon persistence layer uses. Kept
 * as a fast path; the chat widget uses the item-level guard for
 * rendering decisions and this list-level guard only to decide
 * whether to forward a list to the regular todos widget or the
 * artifact widget.
 */
export const ARTIFACTS_LIST_TITLE = 'Artifacts';

export function isArtifactList(list: TodoList): boolean {
	return list.title === ARTIFACTS_LIST_TITLE;
}
