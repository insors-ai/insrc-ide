/**
 * Diff-vs-previous-run helper for the Code Analyzer
 * (plans/analyzers/code-analyzer.md Phase 4.2).
 *
 * Takes two completed analysis lists -- typically a re-run and its
 * `parentListId` source -- and produces a structured diff over the
 * accepted findings PLUS a rendered markdown summary the workbench
 * can open in an editor.
 *
 * Matching: findings are paired across runs by their PRIMARY citation
 * (`<path>:<lineStart>` or `<path>` when no line is available). This
 * survives the "same finding, code drifted slightly" case better than
 * matching on the issue text -- LLM-authored prose varies between
 * runs even when the underlying code is identical. Findings without
 * any citation are matched on `concern + issue` text as a fallback.
 *
 * The diff buckets each pair into:
 *
 *   - `added`     -- in the CURRENT run, not in the PRIOR.
 *   - `removed`   -- in the PRIOR run, not in the CURRENT.
 *   - `unchanged` -- present on both sides with identical issue text.
 *   - `changed`   -- present on both sides with different issue text
 *                    (the citation matched but the analyzer landed on
 *                    a different observation).
 */

import { getDb } from '../db/client.js';
import { getList } from '../db/todos.js';
import { getLogger } from '../shared/logger.js';
import type {
	AnalysisItemMeta,
	CodeCitation,
	Finding,
} from '../agent/tasks/code-analyzer/types.js';
import type { TodoItem, TodoList } from '../shared/todos.js';

const log = getLogger('code-analyzer:diff');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FindingDiffEntry {
	readonly key: string;
	readonly current?: Finding | undefined;
	readonly prior?: Finding | undefined;
}

export interface DiffStats {
	readonly added: number;
	readonly removed: number;
	readonly changed: number;
	readonly unchanged: number;
}

export interface DiffResult {
	readonly priorListId: string;
	readonly currentListId: string;
	readonly priorTitle: string;
	readonly currentTitle: string;
	readonly samePrompt: boolean;
	readonly added: readonly FindingDiffEntry[];
	readonly removed: readonly FindingDiffEntry[];
	readonly changed: readonly FindingDiffEntry[];
	readonly unchanged: readonly FindingDiffEntry[];
	readonly stats: DiffStats;
	/** Pre-rendered markdown summary -- the workbench opens this directly. */
	readonly markdown: string;
}

export interface DiffRunsParams {
	readonly priorListId?: unknown;
	readonly currentListId?: unknown;
}

// ---------------------------------------------------------------------------
// RPC entry
// ---------------------------------------------------------------------------

/**
 * Compute the diff between two analysis lists. Throws on missing /
 * non-code-analyzer lists.
 */
export async function diffRunsRpc(params: DiffRunsParams): Promise<DiffResult> {
	const priorListId   = expectListId(params.priorListId, 'priorListId');
	const currentListId = expectListId(params.currentListId, 'currentListId');

	const db = await getDb();
	const [prior, current] = await Promise.all([
		getList(db, priorListId),
		getList(db, currentListId),
	]);
	if (prior === null) {
		throw new Error(`prior list ${priorListId} not found`);
	}
	if (current === null) {
		throw new Error(`current list ${currentListId} not found`);
	}
	if (prior.owner !== 'code-analyzer' || current.owner !== 'code-analyzer') {
		throw new Error('diffRuns only supports code-analyzer lists');
	}

	const priorFindings   = collectAcceptedFindings(prior);
	const currentFindings = collectAcceptedFindings(current);
	log.info(
		{ priorListId, currentListId, priorCount: priorFindings.length, currentCount: currentFindings.length },
		'diffRuns: collected accepted findings',
	);

	const buckets = bucketDiff(priorFindings, currentFindings);
	const samePrompt = (prior.description ?? '').trim() === (current.description ?? '').trim();
	const stats: DiffStats = {
		added:     buckets.added.length,
		removed:   buckets.removed.length,
		changed:   buckets.changed.length,
		unchanged: buckets.unchanged.length,
	};
	const markdown = renderDiffMarkdown({
		prior,
		current,
		buckets,
		stats,
		samePrompt,
	});

	return {
		priorListId,
		currentListId,
		priorTitle: prior.title,
		currentTitle: current.title,
		samePrompt,
		added:     buckets.added,
		removed:   buckets.removed,
		changed:   buckets.changed,
		unchanged: buckets.unchanged,
		stats,
		markdown,
	};
}

// ---------------------------------------------------------------------------
// Finding extraction
// ---------------------------------------------------------------------------

interface KeyedFinding {
	readonly key: string;
	readonly finding: Finding;
}

/**
 * Pull every accepted finding out of a code-analyzer list. Each
 * `TodoItem.meta` carries the analyzer's `findings` array as one of
 * its completion fields (AnalysisItemMeta wire shape).
 */
function collectAcceptedFindings(list: TodoList): KeyedFinding[] {
	const out: KeyedFinding[] = [];
	for (const item of list.items) {
		const meta = item.meta as AnalysisItemMeta | undefined;
		if (meta === undefined || meta.findings === undefined) {
			continue;
		}
		// Cancelled / blocked items don't get their findings included
		// in the diff -- only completed runs land in the accepted set.
		if (item.status !== 'completed') {
			continue;
		}
		for (const f of meta.findings) {
			out.push({ key: findingKey(f, item), finding: f });
		}
	}
	return out;
}

/**
 * Derive a stable matching key for a finding. Primary path: first
 * citation's `path` + (line start when present). Fallback: concern +
 * normalised issue text + item kind. The fallback is ~stable for
 * findings that lack citations entirely (rare -- the analyzer's
 * citation invariant rejects most such findings before they reach
 * accepted state).
 */
function findingKey(finding: Finding, item: TodoItem): string {
	const c: CodeCitation | undefined = finding.citations[0];
	if (c !== undefined && typeof c.path === 'string' && c.path.length > 0) {
		const line = c.lineStart ?? finding.line;
		return `cite::${c.path}::${line ?? ''}`;
	}
	const meta = item.meta as AnalysisItemMeta | undefined;
	const kind = meta?.kind ?? 'unknown';
	const issue = finding.issue.trim().toLowerCase().replace(/\s+/g, ' ');
	return `text::${kind}::${finding.concern}::${issue}`;
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

interface DiffBuckets {
	readonly added: FindingDiffEntry[];
	readonly removed: FindingDiffEntry[];
	readonly changed: FindingDiffEntry[];
	readonly unchanged: FindingDiffEntry[];
}

function bucketDiff(prior: readonly KeyedFinding[], current: readonly KeyedFinding[]): DiffBuckets {
	// Group by key on each side. Multiple findings can share a key
	// (same citation, different issue text); we treat the first as
	// the canonical entry and pair against the prior side.
	const priorByKey = new Map<string, Finding[]>();
	for (const k of prior) {
		const arr = priorByKey.get(k.key) ?? [];
		arr.push(k.finding);
		priorByKey.set(k.key, arr);
	}
	const currentByKey = new Map<string, Finding[]>();
	for (const k of current) {
		const arr = currentByKey.get(k.key) ?? [];
		arr.push(k.finding);
		currentByKey.set(k.key, arr);
	}

	const added: FindingDiffEntry[] = [];
	const removed: FindingDiffEntry[] = [];
	const changed: FindingDiffEntry[] = [];
	const unchanged: FindingDiffEntry[] = [];

	for (const [key, currentArr] of currentByKey) {
		const priorArr = priorByKey.get(key);
		const cur = currentArr[0]!;
		if (priorArr === undefined || priorArr.length === 0) {
			added.push({ key, current: cur });
			continue;
		}
		const pri = priorArr[0]!;
		if (issueEquivalent(pri, cur)) {
			unchanged.push({ key, current: cur, prior: pri });
		} else {
			changed.push({ key, current: cur, prior: pri });
		}
	}

	for (const [key, priorArr] of priorByKey) {
		if (!currentByKey.has(key)) {
			removed.push({ key, prior: priorArr[0]! });
		}
	}

	return { added, removed, changed, unchanged };
}

function issueEquivalent(a: Finding, b: Finding): boolean {
	if (a.concern !== b.concern || a.severity !== b.severity) {
		return false;
	}
	const ai = a.issue.trim().toLowerCase().replace(/\s+/g, ' ');
	const bi = b.issue.trim().toLowerCase().replace(/\s+/g, ' ');
	return ai === bi;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderDiffMarkdown(args: {
	prior: TodoList;
	current: TodoList;
	buckets: DiffBuckets;
	stats: DiffStats;
	samePrompt: boolean;
}): string {
	const { prior, current, buckets, stats, samePrompt } = args;
	const lines: string[] = [];
	lines.push(`# Code Analysis diff`);
	lines.push('');
	lines.push(`**Prior:**   ${escapeInline(prior.title)} (\`${prior.id.slice(0, 8)}\`, ${prior.updatedAt})`);
	lines.push(`**Current:** ${escapeInline(current.title)} (\`${current.id.slice(0, 8)}\`, ${current.updatedAt})`);
	if (!samePrompt) {
		lines.push('');
		lines.push('> _Prompts differ between runs -- treating findings as comparable but the result may include false positives in `added` / `removed`._');
	}
	lines.push('');
	lines.push(`**Stats:** +${stats.added} added · -${stats.removed} removed · ~${stats.changed} changed · ${stats.unchanged} unchanged`);
	lines.push('');

	if (buckets.added.length > 0) {
		lines.push(`## Added (${buckets.added.length})`);
		lines.push('');
		for (const entry of buckets.added) {
			renderFindingLine(lines, '+', entry.current!);
		}
		lines.push('');
	}
	if (buckets.removed.length > 0) {
		lines.push(`## Removed (${buckets.removed.length})`);
		lines.push('');
		for (const entry of buckets.removed) {
			renderFindingLine(lines, '-', entry.prior!);
		}
		lines.push('');
	}
	if (buckets.changed.length > 0) {
		lines.push(`## Changed (${buckets.changed.length})`);
		lines.push('');
		for (const entry of buckets.changed) {
			renderFindingLine(lines, '<', entry.prior!);
			renderFindingLine(lines, '>', entry.current!);
			lines.push('');
		}
	}
	if (buckets.added.length === 0 && buckets.removed.length === 0 && buckets.changed.length === 0) {
		lines.push('_No findings differ between the two runs._');
		lines.push('');
	}
	return lines.join('\n').replace(/\s+$/, '') + '\n';
}

function renderFindingLine(lines: string[], prefix: string, finding: Finding): void {
	const c = finding.citations[0];
	const cite = c !== undefined && typeof c.path === 'string'
		? ` (\`${c.path}${c.lineStart !== undefined ? ':' + c.lineStart : ''}\`)`
		: '';
	lines.push(`${prefix} **[${finding.severity}/${finding.concern}]** ${escapeInline(finding.issue)}${cite}`);
}

function escapeInline(s: string): string {
	return s.replace(/`/g, '\\`').replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

function expectListId(value: unknown, fieldName: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${fieldName} must be a non-empty string`);
	}
	return value;
}
