/**
 * data_lineage -- cross-link a data target (table / collection / file)
 * to the code that reads or writes it.
 *
 * Phase 3.1 of plans/analyzers/data-analyzer.md. Implements a v1
 * lineage probe that:
 *
 *   1. Vector-searches the active session's repo closure for code
 *      entities semantically related to the target name. Vector
 *      search is broad on its own; we follow up with a body grep so
 *      we keep only entities that *actually* mention the target.
 *   2. Classifies each hit as reader / writer / ambiguous via a small
 *      keyword library (insert / select / etc.) applied to the body
 *      text near the literal match. This is intentionally cheap and
 *      heuristic -- the proper version uses ORM-typed identifiers
 *      and is left for a follow-up alongside Phase 3.2's drift
 *      detection (which has the same "expected shape" plumbing).
 *   3. Emits a markdown summary the data-analyzer's runner LLM can
 *      lift directly into a DataAnalyzerResult finding, plus a
 *      structured `data` payload (exact path / line / classification)
 *      for downstream callers.
 *
 * No `access` policy: the tool reads the daemon's own code knowledge
 * graph, not any user-facing external resource. Per Phase 4 of
 * plans/access-gate.md the dispatcher short-circuits ungated for
 * tools with no `access` field.
 */

import { getLogger } from '../../../../shared/logger.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../../types.js';
import { getDb } from '../../../../db/client.js';
import { embedQuery } from '../../../../indexer/embedder.js';
import { searchEntities } from '../../../../db/search.js';
import type { Entity } from '../../../../shared/types.js';

const log = getLogger('data:lineage');

// ---------------------------------------------------------------------------
// Heuristic keyword library
// ---------------------------------------------------------------------------

/**
 * Word-boundary regexes are expensive in a tight loop; use a single
 * compiled pattern per side and walk matches once.
 *
 * The choice of vocabulary is deliberately conservative -- we'd
 * rather classify uncertain hits as `ambiguous` than misattribute a
 * read site as a write. ORM-typed identifier matching (Prisma's
 * `prisma.user.create({...})` pattern) is a follow-up that lives
 * alongside Phase 3.2's expected-shape resolver.
 */
const WRITE_PATTERN = /\b(insert|update|delete|upsert|save|create|set|write|put|merge)\b/i;
const READ_PATTERN = /\b(select|find|get|query|where|fetch|read|scan|first|all|count)\b/i;

type Classification = 'reader' | 'writer' | 'ambiguous';

interface LineageHit {
	readonly entityId: string;
	readonly path: string;       // workspace-relative
	readonly startLine: number;
	readonly endLine: number;
	readonly entityName: string;
	readonly entityKind: string;
	readonly classification: Classification;
	readonly snippet: string;     // 80-char window around the match
}

interface LineageData {
	readonly target: string;
	readonly connectionId: string;
	readonly hits: readonly LineageHit[];
	readonly truncated: boolean;
	/** Aggregate counts by classification, computed once at render time. */
	readonly counts: { readers: number; writers: number; ambiguous: number };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/**
 * Vector hits to retrieve before body filtering. Larger than the
 * caller's `limit` because vector neighbours don't always contain
 * the literal target string -- we over-fetch then filter so the
 * post-filter result reaches `limit`.
 */
const VECTOR_OVERFETCH_FACTOR = 4;

export const dataLineageTool: Tool = {
	id: 'data_lineage',
	description:
		'Link a data target (RDBMS table, KV namespace, or file path) to the source code that reads or writes it. ' +
		'Returns code citations classified reader / writer / ambiguous. v1 uses literal-name matching + heuristic ' +
		'classification; ORM-typed matching lands with Phase 3.2.',
	inputSchema: {
		type: 'object',
		properties: {
			connectionId: {
				type: 'string',
				description: 'Connection the target belongs to. Stamped into the lineage finding so the analyzer ties the result to a specific source.',
			},
			target: {
				type: 'string',
				description: 'Table name (RDBMS), key pattern (KV), or file path (file driver).',
			},
			limit: {
				type: 'number',
				minimum: 1,
				maximum: MAX_LIMIT,
				description: `Max code citations to return. Default ${DEFAULT_LIMIT}.`,
			},
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	requiresApproval: false,

	async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
		const connectionId = typeof input['connectionId'] === 'string' ? input['connectionId'] : '';
		const target = typeof input['target'] === 'string' ? input['target'] : '';
		if (connectionId.length === 0 || target.length === 0) {
			return fail('connectionId and target are required');
		}
		const rawLimit = typeof input['limit'] === 'number' ? input['limit'] : DEFAULT_LIMIT;
		const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)));

		const closure = deps.session.closureRepos;
		if (closure.length === 0) {
			return fail('session has no closure repos initialised; cannot search the code knowledge graph');
		}

		// Vector search for semantic neighbourhood, then filter by body
		// substring. Pre-filtering by literal would be cheaper but
		// LanceDB doesn't index the body field for substring lookup,
		// and the embedded query gives the analyzer a useful broader
		// surface when the table name itself doesn't appear verbatim
		// (e.g. ORM model names).
		const db = await getDb();
		const queryVec = await embedQuery(target);
		if (queryVec.length === 0) {
			return fail('failed to embed target name (Ollama unavailable?)');
		}

		const overfetch = Math.min(MAX_LIMIT * VECTOR_OVERFETCH_FACTOR, limit * VECTOR_OVERFETCH_FACTOR);
		const candidates = await searchEntities(db, queryVec, [...closure], overfetch, 'code');

		const literal = target.toLowerCase();
		const hits: LineageHit[] = [];
		for (const entity of candidates) {
			const body = entity.body ?? '';
			if (body.length === 0) continue;
			const matchIdx = body.toLowerCase().indexOf(literal);
			if (matchIdx === -1) continue;     // vector neighbour without literal mention; drop
			hits.push(buildHit(entity, body, matchIdx, target));
			if (hits.length >= limit) break;
		}
		const truncated = candidates.length === overfetch && hits.length === limit;

		const counts = countByClassification(hits);
		const data: LineageData = {
			target, connectionId, hits, truncated, counts,
		};

		log.info(
			{ target, connectionId, hits: hits.length, ...counts, candidates: candidates.length },
			'data_lineage probe complete',
		);

		return {
			output: renderLineageReport(data),
			format: 'markdown',
			success: true,
			data,
		};
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(msg: string): ToolResult {
	return { output: `[data_lineage] ${msg}`, format: 'text', success: false, error: msg };
}

function buildHit(entity: Entity, body: string, matchIdx: number, target: string): LineageHit {
	// 80-char window centred on the match (40 each side, clamped).
	const winRadius = 40;
	const start = Math.max(0, matchIdx - winRadius);
	const end = Math.min(body.length, matchIdx + target.length + winRadius);
	const window = body.slice(start, end).replace(/\s+/g, ' ').trim();

	const writer = WRITE_PATTERN.test(window);
	const reader = READ_PATTERN.test(window);
	const classification: Classification =
		writer && !reader ? 'writer'
			: reader && !writer ? 'reader'
				: 'ambiguous';

	return {
		entityId: entity.id,
		// Convert absolute path to repo-relative for citation rendering.
		// Scan the closure list and pick the longest matching prefix
		// so nested workspaces (rare but possible) get the closest repo
		// rather than the alphabetically-first one.
		path: relativeForRepo(entity.file, entity.repo),
		startLine: entity.startLine,
		endLine: entity.endLine,
		entityName: entity.name,
		entityKind: entity.kind,
		classification,
		snippet: window,
	};
}

function relativeForRepo(absPath: string, repoPath: string): string {
	if (repoPath.length > 0 && absPath.startsWith(repoPath)) {
		const rel = absPath.slice(repoPath.length);
		return rel.startsWith('/') ? rel.slice(1) : rel;
	}
	return absPath;
}

function countByClassification(hits: readonly LineageHit[]): { readers: number; writers: number; ambiguous: number } {
	let readers = 0;
	let writers = 0;
	let ambiguous = 0;
	for (const h of hits) {
		if (h.classification === 'reader') readers++;
		else if (h.classification === 'writer') writers++;
		else ambiguous++;
	}
	return { readers, writers, ambiguous };
}

/**
 * Markdown rendered for the analyzer LLM. Uses `path:` URIs so the
 * existing PathUriOpener resolves clicks in the report pane and the
 * shared `rewriteCustomUrisForSave` helper rewrites them to absolute
 * file:// URIs at save time.
 *
 * Output structure mirrors the reader / writer / ambiguous tri-fold
 * the design calls out, so the analyzer's synthesise prompt can
 * preserve the labelling without re-classifying.
 */
function renderLineageReport(d: LineageData): string {
	const head = `# Lineage for \`${d.connectionId}\` -> \`${d.target}\`\n`;
	const summary = `${d.counts.readers} reader(s), ${d.counts.writers} writer(s), ${d.counts.ambiguous} ambiguous` +
		(d.truncated ? ` _(truncated to first ${d.hits.length})_` : '');

	if (d.hits.length === 0) {
		return `${head}\n${summary}\n\n_No code references found in the active repo closure. The target may be queried only via configuration / migration files, or the indexer hasn't yet seen the relevant code._`;
	}

	const sections: string[] = [head, summary, ''];
	for (const kind of ['writer', 'reader', 'ambiguous'] as const) {
		const slice = d.hits.filter(h => h.classification === kind);
		if (slice.length === 0) continue;
		sections.push(`## ${capitalize(kind)}s (${slice.length})\n`);
		for (const h of slice) {
			sections.push(renderHit(h));
		}
		sections.push('');
	}
	return sections.join('\n');
}

function renderHit(h: LineageHit): string {
	const uri = `path:${h.path}#L${h.startLine}-L${h.endLine}`;
	const label = `\`${h.path}:${h.startLine}\``;
	return `- [${label}](${uri}) -- \`${h.entityKind}:${h.entityName}\`\n  > \`${truncateSnippet(h.snippet)}\``;
}

function truncateSnippet(s: string, max = 140): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function capitalize(s: string): string {
	return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
