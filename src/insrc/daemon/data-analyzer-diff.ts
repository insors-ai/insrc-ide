/**
 * Diff-vs-previous-run helper for the Data Analyzer
 * (plans/analyzers/data-analyzer.md Phase 5.2).
 *
 * Mirror of `code-analyzer-diff.ts` but typed for the data-analyzer's
 * finding + citation shape. Pairs DataFindings across two completed
 * data-analysis lists by their PRIMARY citation; falls back to
 * concern + normalised issue text when no citation exists.
 *
 * Use cases the design called out:
 *   - "Did the schema change since last audit?" -- typically with a
 *     `data-analyze` re-run, then this diff highlights drift items
 *     that newly appeared / dropped between the two runs.
 *   - "Compare prod connection's drift before/after the migration" --
 *     two ad-hoc runs of the same /data-analyze prompt against
 *     different connection-version states.
 *
 * Buckets: added / removed / changed / unchanged (same shape as the
 * code-analyzer diff so the workbench renders both with one CSS).
 */

import { getDb } from '../db/client.js';
import { getList } from '../db/todos.js';
import { getLogger } from '../shared/logger.js';
import type {
	DataCitation,
	DataFinding,
} from '../agent/tasks/data-analyzer/types.js';
import type { TodoItem, TodoList } from '../shared/todos.js';

const log = getLogger('data-analyzer:diff');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DataFindingDiffEntry {
	readonly key: string;
	readonly current?: DataFinding | undefined;
	readonly prior?: DataFinding | undefined;
}

export interface DataDiffStats {
	readonly added: number;
	readonly removed: number;
	readonly changed: number;
	readonly unchanged: number;
}

export interface DataDiffResult {
	readonly priorListId: string;
	readonly currentListId: string;
	readonly priorTitle: string;
	readonly currentTitle: string;
	readonly samePrompt: boolean;
	readonly added: readonly DataFindingDiffEntry[];
	readonly removed: readonly DataFindingDiffEntry[];
	readonly changed: readonly DataFindingDiffEntry[];
	readonly unchanged: readonly DataFindingDiffEntry[];
	readonly stats: DataDiffStats;
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

export async function diffRunsRpc(params: DiffRunsParams): Promise<DataDiffResult> {
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
	if (prior.owner !== 'data-analyzer' || current.owner !== 'data-analyzer') {
		throw new Error('diffRuns only supports data-analyzer lists');
	}

	const priorFindings   = collectAcceptedFindings(prior);
	const currentFindings = collectAcceptedFindings(current);
	log.info(
		{ priorListId, currentListId, priorCount: priorFindings.length, currentCount: currentFindings.length },
		'diffRuns: collected accepted findings',
	);

	const buckets = bucketDiff(priorFindings, currentFindings);
	const samePrompt = (prior.description ?? '').trim() === (current.description ?? '').trim();
	const stats: DataDiffStats = {
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
	readonly finding: DataFinding;
}

/**
 * The data-analyzer's TodoItem.meta carries `findings` from the
 * accepted DataAnalyzerResult (see updateItemMeta call in
 * runNextAnalyzerTask). We extract them here via a structural check
 * since the meta shape isn't typed at the framework level.
 */
function collectAcceptedFindings(list: TodoList): KeyedFinding[] {
	const out: KeyedFinding[] = [];
	for (const item of list.items) {
		const meta = item.meta as { findings?: unknown; kind?: unknown } | undefined;
		if (meta === undefined) continue;
		if (item.status !== 'completed') continue;
		const findings = Array.isArray(meta.findings) ? meta.findings as DataFinding[] : undefined;
		if (findings === undefined) continue;
		for (const f of findings) {
			out.push({ key: findingKey(f, item), finding: f });
		}
	}
	return out;
}

/**
 * Stable matching key for a DataFinding. Primary citation when
 * present; otherwise concern + normalised issue + item kind.
 *
 * Citation key shapes (matching the four DataCitation variants):
 *   - rdbms:       `cite::rdbms::<conn>::<schema>.<table>[.<column>]`
 *   - kv:          `cite::kv::<conn>::<keyPattern>[::<fieldPath>]`
 *   - file-source: `cite::file::<conn>::<path>[::<column>]`
 *   - code-ref:    `cite::code::<path>[#<lineStart>]`
 */
function findingKey(finding: DataFinding, item: TodoItem): string {
	const c: DataCitation | undefined = finding.citations[0];
	if (c !== undefined) {
		if (c.kind === 'rdbms') {
			const tbl = c.schema !== undefined ? `${c.schema}.${c.table}` : c.table;
			return `cite::rdbms::${c.connectionId}::${tbl}${c.column !== undefined ? '.' + c.column : ''}`;
		}
		if (c.kind === 'kv') {
			return `cite::kv::${c.connectionId}::${c.keyPattern}${c.fieldPath !== undefined ? '::' + c.fieldPath : ''}`;
		}
		if (c.kind === 'file-source') {
			return `cite::file::${c.connectionId}::${c.path}${c.column !== undefined ? '::' + c.column : ''}`;
		}
		if (c.kind === 'code-ref') {
			return `cite::code::${c.path}${c.lineStart !== undefined ? '#' + c.lineStart : ''}`;
		}
	}
	const meta = item.meta as { kind?: unknown } | undefined;
	const kind = typeof meta?.kind === 'string' ? meta.kind : 'unknown';
	const issue = finding.issue.trim().toLowerCase().replace(/\s+/g, ' ');
	return `text::${kind}::${finding.concern}::${issue}`;
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

interface DiffBuckets {
	readonly added: DataFindingDiffEntry[];
	readonly removed: DataFindingDiffEntry[];
	readonly changed: DataFindingDiffEntry[];
	readonly unchanged: DataFindingDiffEntry[];
}

function bucketDiff(prior: readonly KeyedFinding[], current: readonly KeyedFinding[]): DiffBuckets {
	const priorByKey = new Map<string, DataFinding[]>();
	for (const k of prior) {
		const arr = priorByKey.get(k.key) ?? [];
		arr.push(k.finding);
		priorByKey.set(k.key, arr);
	}
	const currentByKey = new Map<string, DataFinding[]>();
	for (const k of current) {
		const arr = currentByKey.get(k.key) ?? [];
		arr.push(k.finding);
		currentByKey.set(k.key, arr);
	}

	const added: DataFindingDiffEntry[] = [];
	const removed: DataFindingDiffEntry[] = [];
	const changed: DataFindingDiffEntry[] = [];
	const unchanged: DataFindingDiffEntry[] = [];

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

function issueEquivalent(a: DataFinding, b: DataFinding): boolean {
	if (a.concern !== b.concern || a.severity !== b.severity) return false;
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
	stats: DataDiffStats;
	samePrompt: boolean;
}): string {
	const { prior, current, buckets, stats, samePrompt } = args;
	const lines: string[] = [];
	lines.push('# Data Analysis diff');
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

function renderFindingLine(lines: string[], prefix: string, finding: DataFinding): void {
	const cite = renderCitationInline(finding.citations[0]);
	lines.push(`${prefix} **[${finding.severity}/${finding.concern}]** ${escapeInline(finding.issue)}${cite}`);
}

function renderCitationInline(c: DataCitation | undefined): string {
	if (c === undefined) return '';
	if (c.kind === 'rdbms') {
		const tbl = c.schema !== undefined ? `${c.schema}.${c.table}` : c.table;
		return ` (\`${c.connectionId}:${tbl}${c.column !== undefined ? '.' + c.column : ''}\`)`;
	}
	if (c.kind === 'kv') {
		return ` (\`${c.connectionId}:${c.keyPattern}${c.fieldPath !== undefined ? '::' + c.fieldPath : ''}\`)`;
	}
	if (c.kind === 'file-source') {
		return ` (\`${c.connectionId}:${c.path}${c.column !== undefined ? '::' + c.column : ''}\`)`;
	}
	// code-ref: shows path:line for cross-citations into source code
	return ` (\`${c.path}${c.lineStart !== undefined ? ':' + c.lineStart : ''}\`)`;
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
