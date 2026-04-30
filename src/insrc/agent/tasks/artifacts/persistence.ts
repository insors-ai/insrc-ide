/**
 * TodoItem-backed persistence for artifact tasks.
 *
 * Every `ArtifactResult` is persisted as a completed `TodoItem` on a
 * session-scoped Artifacts list. Reusing the TODO framework
 * (plans/todo-framework.md) gives us durable storage, live-update
 * events, and the existing browser surfaces for free. The list itself
 * is auto-created on first artifact per session, owned by the family
 * baked into the caller-supplied `TodosApi`.
 *
 * Callers pass a `TodosApi` instance -- the tool executor populates
 * `ToolDeps.todos` with an instance scoped to the right family
 * (controller task path: the controller's family; LLM tool-loop:
 * `'chat'`). This module no longer constructs its own TodosApi, so
 * the agent/daemon module boundary stays clean.
 *
 * See plans/artifact-tasks.md §1.5.
 */

import { getLogger } from '../../../shared/logger.js';
import type { TodoItem, TodoList, TodosApi } from '../../../shared/todos.js';
import type {
	ArtifactItemMeta,
	ArtifactKind,
	ArtifactResult,
} from '../../../shared/artifacts.js';

const log = getLogger('artifact-persistence');

/** List title used to find / create the Artifacts list per session. */
const ARTIFACTS_LIST_TITLE = 'Artifacts';

/**
 * Marker flag on the list's meta (written into the list description
 * since `TodoList` has no dedicated meta field). The todos pane list
 * widget checks this to suppress the `+ Add comment` affordance
 * (code-analyzer design §5.3 pattern, reused here).
 *
 * Stored inside the description as a line-prefix sentinel so lists
 * authored before the list-widget change still work.
 */
const SUPPRESS_COMMENTS_MARKER = '[insrc:suppress-comments]';

/** Default description text for the list. Includes the sentinel. */
const DEFAULT_LIST_DESCRIPTION =
	`${SUPPRESS_COMMENTS_MARKER} Session-scoped artifacts ` +
	'(diagrams, wireframes) emitted by artifact.* tools. Read-only; ' +
	'regenerate via artifact.regenerate.';

// ---------------------------------------------------------------------------
// Find-or-create the session's Artifacts list
// ---------------------------------------------------------------------------

async function findArtifactsList(
	api: TodosApi,
	sessionId: string,
): Promise<TodoList | null> {
	const lists = await api.listForSession(sessionId);
	// Match by (owner, title). Multiple Artifacts lists on the same
	// session shouldn't happen, but if they do we take the first. The
	// framework stream events already carry list ids for disambiguation.
	for (const list of lists) {
		if (list.title === ARTIFACTS_LIST_TITLE && list.owner === api.caller) {
			return list;
		}
	}
	return null;
}

/**
 * Return the caller's Artifacts list for the session, creating it on
 * demand. Idempotent -- repeated calls within a session return the
 * same list id.
 */
export async function findOrCreateArtifactsList(
	api: TodosApi,
	sessionId: string,
): Promise<TodoList> {
	const existing = await findArtifactsList(api, sessionId);
	if (existing !== null) { return existing; }

	log.info({ sessionId, caller: api.caller }, 'creating Artifacts list for session');
	return api.createList({
		sessionId,
		title: ARTIFACTS_LIST_TITLE,
		description: DEFAULT_LIST_DESCRIPTION,
	});
}

/**
 * Expose the suppress-comments sentinel so downstream surfaces (list
 * widget, todos pane) can detect it without parsing magic strings.
 */
export function listSuppressesComments(list: TodoList): boolean {
	return typeof list.description === 'string'
		&& list.description.startsWith(SUPPRESS_COMMENTS_MARKER);
}

// ---------------------------------------------------------------------------
// Persist an artifact result
// ---------------------------------------------------------------------------

/**
 * Build the `TodoItem.meta` payload from an ArtifactResult.
 * Revisions start empty; phase-2 regenerate appends to them.
 */
function metaFromResult(result: ArtifactResult): ArtifactItemMeta {
	return {
		kind: result.kind,
		source: result.source,
		renderedHtml: result.renderedHtml,
		...(result.title !== undefined ? { title: result.title } : {}),
		metadata: result.metadata,
		warnings: result.warnings,
		confidence: result.confidence,
		revisions: [],
	};
}

/**
 * Derive a short, human-readable title for the TodoItem from the
 * artifact result. Falls back to `<kind>: <first line of source>` when
 * the caller didn't supply a title.
 */
function itemTitleFor(result: ArtifactResult): string {
	if (result.title !== undefined && result.title.trim() !== '') {
		return result.title.trim();
	}
	const firstSourceLine = result.source.split('\n', 1)[0]?.trim() ?? '';
	const truncated = firstSourceLine.length > 60
		? firstSourceLine.slice(0, 57) + '...'
		: firstSourceLine;
	return truncated !== '' ? `${result.kind}: ${truncated}` : result.kind;
}

export interface PersistedArtifact {
	readonly list: TodoList;
	readonly item: TodoItem;
}

/**
 * Save an artifact as a completed TodoItem on the session's Artifacts
 * list, creating the list on first call. Returns the list + item the
 * caller can surface to its own UI layer.
 */
export async function persistArtifact(
	api: TodosApi,
	sessionId: string,
	result: ArtifactResult,
): Promise<PersistedArtifact> {
	const list = await findOrCreateArtifactsList(api, sessionId);

	const item = await api.addItem(list.id, {
		title: itemTitleFor(result),
		// Use the artifact's own provenance sentence as the item's
		// description so it shows up in the todos pane row expansion.
		description: `[artifact:${result.id}] ${result.metadata['provenance'] ?? ''}`.trim(),
		meta: metaFromResult(result) as unknown as Readonly<Record<string, unknown>>,
	});

	// The framework creates items in `pending` status; artifacts aren't
	// tasks, so flip straight to `completed`.
	const completed = await api.markComplete(item.id);

	log.info({
		sessionId,
		caller: api.caller,
		artifactId: result.id,
		itemId: completed.id,
	}, 'artifact persisted');
	return { list, item: completed };
}

// ---------------------------------------------------------------------------
// Listing -- used by artifact:list (phase 2) for the NL regenerate UX
// ---------------------------------------------------------------------------

const ARTIFACT_ID_RE = /^\[artifact:([^\]]+)\]/;

/** Default + max number of artifacts returned by `listSessionArtifacts`. */
export const MAX_LIST_ARTIFACTS = 50;

export interface ArtifactSummary {
	readonly artifactId: string;
	readonly itemId: string;
	readonly kind: ArtifactKind;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly revisionsCount: number;
}

function clampListLimit(n: number | undefined): number {
	if (n === undefined) { return MAX_LIST_ARTIFACTS; }
	if (!Number.isFinite(n) || n < 1) { return 1; }
	return Math.min(Math.floor(n), MAX_LIST_ARTIFACTS);
}

/**
 * Enumerate the session's artifacts, newest first. Returns at most
 * `opts.limit` (default + cap: `MAX_LIST_ARTIFACTS`). Empty array
 * when the Artifacts list doesn't exist yet (no artifacts produced
 * this session).
 *
 * Used by the `artifact_list` tool so an LLM turn can resolve
 * artifact ids by name/kind/recency before calling
 * `artifact:regenerate({ artifactId, edits })` -- phase 2's NL
 * regenerate UX needs an artifact-discovery surface
 * (`artifact_list_templates` lists templates, not artifacts).
 */
export async function listSessionArtifacts(
	api: TodosApi,
	sessionId: string,
	opts: { readonly limit?: number } = {},
): Promise<ArtifactSummary[]> {
	const list = await findArtifactsList(api, sessionId);
	if (list === null) { return []; }

	const limit = clampListLimit(opts.limit);
	const out: ArtifactSummary[] = [];

	for (const item of list.items) {
		const meta = item.meta as unknown as ArtifactItemMeta | undefined;
		if (
			meta === undefined
			|| typeof meta !== 'object'
			|| typeof meta.kind !== 'string'
		) {
			continue;
		}
		if (typeof item.description !== 'string') { continue; }
		const match = ARTIFACT_ID_RE.exec(item.description);
		if (match === null) { continue; }
		const artifactId = match[1];
		if (artifactId === undefined || artifactId === '') { continue; }

		out.push({
			artifactId,
			itemId: item.id,
			kind: meta.kind,
			title: item.title,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
			revisionsCount: meta.revisions?.length ?? 0,
		});
	}

	// Newest-first by createdAt. Tie-break by itemId for determinism
	// (item ids are random, but deterministic given the test input).
	out.sort((a, b) => {
		const cmp = b.createdAt.localeCompare(a.createdAt);
		return cmp !== 0 ? cmp : b.itemId.localeCompare(a.itemId);
	});

	return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Lookup -- used by artifact.regenerate (phase 2) and tests
// ---------------------------------------------------------------------------

/**
 * Find the persisted item for an artifact id across a session's
 * Artifacts list. Linear scan over the list's items; acceptable for
 * phase 1 where lists stay small. Returns null when not found.
 */
export async function findByArtifactId(
	api: TodosApi,
	sessionId: string,
	artifactId: string,
): Promise<PersistedArtifact | null> {
	const list = await findArtifactsList(api, sessionId);
	if (list === null) { return null; }
	for (const item of list.items) {
		const meta = item.meta;
		if (meta && typeof meta === 'object' && 'kind' in meta) {
			const metaDescIncludesId = typeof item.description === 'string'
				&& item.description.includes(`[artifact:${artifactId}]`);
			if (metaDescIncludesId) { return { list, item }; }
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Regenerate -- append revision + swap in new render
// ---------------------------------------------------------------------------

/**
 * Last-N revisions kept on an artifact item. Older entries are
 * evicted as new regenerations happen. See plans/artifact-tasks.md
 * §2.1 -- 5 is the ceiling.
 */
export const MAX_REVISIONS = 5;

/**
 * Apply a regenerated ArtifactResult to an existing TodoItem: push
 * the prior source onto `meta.revisions` (with the user's edit text
 * + timestamp), install the new source + rendered HTML, and
 * `updateItemMeta` via the framework so the todos stream emits an
 * `itemUpdated` event that both the chat widget and the (phase-2)
 * Artifacts Pane consume in place.
 *
 * Returns the refreshed TodoItem. Throws when the item's meta
 * doesn't satisfy the artifact shape.
 */
export async function appendRevision(
	api: TodosApi,
	itemId: string,
	opts: {
		readonly edits: string;
		readonly newResult: ArtifactResult;
	},
): Promise<TodoItem> {
	const priorItem = await api.getItem(itemId);
	if (priorItem === null) {
		throw new Error(`appendRevision: item '${itemId}' not found`);
	}
	const priorMeta = priorItem.meta as unknown as ArtifactItemMeta | undefined;
	if (
		priorMeta === undefined
		|| typeof priorMeta !== 'object'
		|| typeof priorMeta.source !== 'string'
	) {
		throw new Error(`appendRevision: item '${itemId}' has no artifact meta`);
	}

	const newRevision = {
		at: new Date().toISOString(),
		edits: opts.edits,
		source: priorMeta.source,
	};
	const revisions = [...(priorMeta.revisions ?? []), newRevision]
		.slice(-MAX_REVISIONS);

	const nextMeta: ArtifactItemMeta = {
		kind: opts.newResult.kind,
		source: opts.newResult.source,
		renderedHtml: opts.newResult.renderedHtml,
		...(opts.newResult.title !== undefined ? { title: opts.newResult.title } : {}),
		metadata: opts.newResult.metadata,
		warnings: opts.newResult.warnings,
		confidence: opts.newResult.confidence,
		revisions,
	};

	log.info({
		itemId,
		kind: opts.newResult.kind,
		revisionCount: revisions.length,
		edits: opts.edits.slice(0, 80),
	}, 'artifact regenerated');

	return api.updateItemMeta(itemId, nextMeta as unknown as Readonly<Record<string, unknown>>);
}
