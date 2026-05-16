/**
 * Patch-block parser + applier for the structured-review patch loop
 * (Phase F of plans/code-analyzer-structured-review.md).
 *
 * Wire format the writer emits:
 *
 *   ```patch:wi-3
 *   <new paragraph content>
 *   ```
 *
 *   ```patch:wi-4 after=paragraph-5
 *   <new paragraph content>
 *   ```
 *
 *   ```skip:wi-2
 *   <one-sentence reason>
 *   ```
 *
 * - `patch:<id>` -- replace / insert / delete a paragraph in the draft.
 *   The work item's `kind` drives the action:
 *     - `fix` / `enhance`: replace the paragraph the `where` field points at.
 *     - `add`:             insert AFTER the paragraph the `where` field points at.
 *                          The `after=<anchor>` block-tag attribute overrides `where`.
 *     - `trim`:            delete the paragraph the `where` field points at.
 *                          The patch body is ignored (and should be empty).
 *
 * - `skip:<id>` -- the writer could not address the item; body is the reason.
 *
 * The applier is intentionally permissive about the `where` field --
 * a real writer's "paragraph 3" might not exactly match the renumbered
 * draft. When resolution fails, the patch is applied at end-of-section
 * and the item is reported `status: 'partial', reason: 'where unresolved'`.
 *
 * Pure functions; no I/O. Easy to test in isolation.
 */

import type { ReviewWorkItem, WorkItemKind } from '../../content-gen/review-action.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PatchBlock {
	readonly kind:    'patch' | 'skip';
	readonly itemId:  string;
	/** Block-tag attributes parsed from the fence line, e.g. `after=paragraph-5`. */
	readonly attrs:   Readonly<Record<string, string>>;
	readonly body:    string;
}

export interface WorkItemStatus {
	readonly id:     string;
	readonly status: 'addressed' | 'partial' | 'skipped';
	readonly reason?: string;
}

export interface ApplyPatchesResult {
	readonly patchedMarkdown: string;
	readonly itemStatuses:    readonly WorkItemStatus[];
}

// ---------------------------------------------------------------------------
// parsePatches
// ---------------------------------------------------------------------------

/**
 * Walk a writer's combined turn text and extract every `patch:<id>` or
 * `skip:<id>` fenced block in order. Blocks are matched even when
 * interleaved with prose; the prose is discarded for the purposes of
 * the patch applier.
 *
 * Returns the ordered list of blocks. Deduplication (later block wins
 * for the same id) is the applier's responsibility.
 */
export function parsePatches(text: string): readonly PatchBlock[] {
	const blocks: PatchBlock[] = [];
	// Match opening fence: ```patch:wi-3 [attrs]\n ... \n```
	// We accept any non-whitespace id (the reviewer constrains to wi-N
	// but we don't want a tight regex to break on a stray suffix).
	const re = /^```(patch|skip):([^\s`]+)([^\n]*)\n([\s\S]*?)\n```/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const kind   = m[1] as 'patch' | 'skip';
		const itemId = m[2]!;
		const attrs  = parseAttrs(m[3] ?? '');
		const body   = (m[4] ?? '').trim();
		blocks.push({ kind, itemId, attrs, body });
	}
	return blocks;
}

function parseAttrs(s: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const tok of s.trim().split(/\s+/)) {
		if (tok.length === 0) continue;
		const eq = tok.indexOf('=');
		if (eq <= 0) continue;
		out[tok.slice(0, eq)] = tok.slice(eq + 1);
	}
	return out;
}

// ---------------------------------------------------------------------------
// applyPatches
// ---------------------------------------------------------------------------

/**
 * Apply a list of patch blocks to a draft markdown string, driven by
 * the reviewer's work-item list.
 *
 * Algorithm:
 *   1. Split the draft on blank lines into a paragraph array.
 *   2. Index the blocks by id (last write wins).
 *   3. For each work item in order, look up its block and apply
 *      according to the item's kind. Record the per-item status.
 *   4. Items that have no matching block are recorded as
 *      `status: 'skipped', reason: 'no patch emitted'`.
 *   5. Re-join the paragraph array with `\n\n`.
 */
export function applyPatches(
	draftMarkdown: string,
	workItems: readonly ReviewWorkItem[],
	blocks: readonly PatchBlock[],
): ApplyPatchesResult {
	const paragraphs = splitParagraphs(draftMarkdown);
	const blockById  = new Map<string, PatchBlock>();
	for (const b of blocks) blockById.set(b.itemId, b);   // last wins

	const statuses: WorkItemStatus[] = [];

	// Apply edits to a working copy so each item's `where` resolves
	// against the ORIGINAL paragraph numbering. We track inserts/
	// deletes via a list of edits and apply them at the end so we
	// don't have to renumber on the fly.
	type Edit =
		| { kind: 'replace'; idx: number; text: string }
		| { kind: 'insert';  afterIdx: number; text: string }
		| { kind: 'delete';  idx: number };
	const edits: Edit[] = [];

	for (const item of workItems) {
		const block = blockById.get(item.id);
		if (block === undefined) {
			statuses.push({
				id: item.id,
				status: 'skipped',
				reason: 'no patch emitted',
			});
			continue;
		}

		if (block.kind === 'skip') {
			statuses.push({
				id: item.id,
				status: 'skipped',
				reason: block.body.length > 0 ? block.body : 'writer reported skip',
			});
			continue;
		}

		// Phase L.4: defense-in-depth sanitization. If the patch body
		// ends with a transition phrase ("Next, I will...", "Let me
		// now examine...") the writer slipped its between-block
		// narration into the body. The terminal-artifact rule in the
		// L.2 prompt rewrite should prevent this, but we strip it
		// here as a backstop. The item status becomes `partial` with
		// the reason so the operator sees the prompt-level fix didn't
		// fully land.
		const sanitized = stripTrailingTransition(block.body);
		const sanitizedBlock: PatchBlock = sanitized.changed
			? { ...block, body: sanitized.body }
			: block;

		const status = applyOne(item, sanitizedBlock, paragraphs, edits);
		if (sanitized.changed && status.status === 'addressed') {
			statuses.push({
				id:     item.id,
				status: 'partial',
				reason: 'writer announced an action in the patch body; trailing sentence stripped',
			});
		} else {
			statuses.push(status);
		}
	}

	const patched = applyEdits(paragraphs, edits);
	return {
		patchedMarkdown: patched.join('\n\n').trim(),
		itemStatuses:    statuses,
	};
}

function applyOne(
	item:        ReviewWorkItem,
	block:       PatchBlock,
	paragraphs:  readonly string[],
	edits:       { kind: string; idx?: number; afterIdx?: number; text?: string }[],
): WorkItemStatus {
	const kind: WorkItemKind = item.kind;

	// Resolve the target paragraph index. `where` is the primary
	// signal; `after=<anchor>` on a patch:add block overrides it.
	const anchorOverride = block.attrs['after'];
	const whereSource    = anchorOverride !== undefined ? `after ${anchorOverride}` : item.where;
	const resolved       = resolveParagraphIdx(whereSource, paragraphs);

	if (kind === 'trim') {
		if (resolved === null) {
			return { id: item.id, status: 'partial', reason: 'where unresolved (trim no-op)' };
		}
		edits.push({ kind: 'delete', idx: resolved });
		return { id: item.id, status: 'addressed' };
	}

	if (kind === 'add') {
		if (resolved === null) {
			// Fall back to "append at end".
			edits.push({ kind: 'insert', afterIdx: paragraphs.length - 1, text: block.body });
			return { id: item.id, status: 'partial', reason: 'where unresolved; appended at end' };
		}
		edits.push({ kind: 'insert', afterIdx: resolved, text: block.body });
		return { id: item.id, status: 'addressed' };
	}

	// fix / enhance: replace the targeted paragraph.
	if (resolved === null) {
		edits.push({ kind: 'insert', afterIdx: paragraphs.length - 1, text: block.body });
		return { id: item.id, status: 'partial', reason: 'where unresolved; appended at end' };
	}
	edits.push({ kind: 'replace', idx: resolved, text: block.body });
	return { id: item.id, status: 'addressed' };
}

// ---------------------------------------------------------------------------
// where -> paragraph idx resolver
// ---------------------------------------------------------------------------

/**
 * Map a reviewer's `where` value to a paragraph index.
 *
 * Accepted shapes:
 *   - "paragraph N"             -> 1-indexed paragraph
 *   - "after paragraph N"       -> N (caller decides insert-vs-replace)
 *   - "paragraphs 2-4"          -> first of range (2)
 *   - "section opening"         -> 0
 *   - "section closing" / "end" -> last paragraph
 *
 * Returns null when no shape matches.
 */
function resolveParagraphIdx(where: string, paragraphs: readonly string[]): number | null {
	if (paragraphs.length === 0) return null;
	const w = where.trim().toLowerCase();

	if (/^(section\s+)?opening$/.test(w) || w === 'opening' || w === 'start') {
		return 0;
	}
	if (/^(section\s+)?(closing|ending|end)$/.test(w) || w === 'closing' || w === 'end') {
		return paragraphs.length - 1;
	}

	const single = w.match(/^(?:after\s+)?paragraphs?\s+(\d+)/);
	if (single !== null) {
		const n = Number.parseInt(single[1]!, 10);
		if (Number.isFinite(n) && n >= 1 && n <= paragraphs.length) {
			return n - 1;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function splitParagraphs(markdown: string): string[] {
	const trimmed = markdown.trim();
	if (trimmed.length === 0) return [];
	return trimmed.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
}

function applyEdits(
	paragraphs:  readonly string[],
	edits:       readonly { kind: string; idx?: number; afterIdx?: number; text?: string }[],
): string[] {
	// Apply replaces first, then deletes (descending), then inserts
	// (descending). This avoids index drift.
	const work = [...paragraphs];

	for (const e of edits) {
		if (e.kind === 'replace' && e.idx !== undefined && e.text !== undefined) {
			work[e.idx] = e.text;
		}
	}
	const deletes = edits
		.filter(e => e.kind === 'delete' && e.idx !== undefined)
		.map(e => e.idx as number)
		.sort((a, b) => b - a);
	for (const i of deletes) {
		work.splice(i, 1);
	}
	const inserts = edits
		.filter(e => e.kind === 'insert' && e.afterIdx !== undefined && e.text !== undefined)
		.map(e => ({ afterIdx: e.afterIdx as number, text: e.text as string }))
		.sort((a, b) => b.afterIdx - a.afterIdx);
	for (const ins of inserts) {
		// Inserting "after paragraph N" means at index N+1.
		const at = Math.max(0, Math.min(work.length, ins.afterIdx + 1));
		work.splice(at, 0, ins.text);
	}
	return work;
}

// ---------------------------------------------------------------------------
// Phase L.4: trailing-transition sanitizer
// ---------------------------------------------------------------------------

const TRANSITION_REGEX = /(?:^|(?<=[.!?]\s))(let me|i'll now|i'll start|i'll begin|i'll examine|i'll look|i'll check|i'll add|i will now|i will start|i will begin|i will examine|i will add|next, i|next i'll|going to|now i'll|now let me|to further (?:understand|explore|examine|investigate))\b[^.!?]*[.!?]?\s*$/i;

/**
 * Strip a trailing transition sentence from a patch body. Used as
 * defense in depth against the L.2 prompt-level fix. Returns the
 * sanitized body + a flag indicating whether any change was made.
 *
 * Matches phrases starting at the LAST sentence boundary (or the
 * start of the body) so we don't accidentally strip mid-paragraph
 * occurrences like "...the reader I will describe is...".
 */
function stripTrailingTransition(body: string): { body: string; changed: boolean } {
	const trimmed = body.trim();
	if (trimmed.length === 0) return { body: trimmed, changed: false };
	const stripped = trimmed.replace(TRANSITION_REGEX, '').trimEnd();
	if (stripped === trimmed) return { body: trimmed, changed: false };
	return { body: stripped, changed: true };
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _resolveParagraphIdxForTest = resolveParagraphIdx;
export const _splitParagraphsForTest     = splitParagraphs;
export const _stripTrailingTransitionForTest = stripTrailingTransition;
