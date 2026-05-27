/**
 * writeFromDataEvidence -- evidence-anchored prose writer for the
 * data analyzer (Phase E of plans/analyzers/data-analyzer-parity.md).
 *
 * Mirrors agent/tasks/code-analyzer/write-from-evidence.ts but adapted
 * for DataEvidenceEntry input + DataCitation rendering. One LLM call
 * per task; no tool loop, no multi-turn.
 *
 * Citation URL scheme:
 *   - rdbms:       `data:rdbms/<connectionId>/<schema?>.<table>#col=<column?>`
 *   - kv:          `data:kv/<connectionId>/<keyPattern>#field=<fieldPath?>`
 *   - file-source: `data:file/<connectionId>/<path>#col=<column?>`
 *   - code-ref:    `path:<path>#L<start>-L<end>`     (reuses the code-side scheme)
 *
 * The `data:` URI scheme is intentionally distinct from the code
 * analyzer's `path:` scheme so the IDE renderer can dispatch each to
 * the right opener (workbench dbDrivers pane vs. file editor).
 *
 * Phase 5 of the parity plan bakes in five hardening rules learned
 * from the code-analyzer's live tests (BEFORE first run, not after):
 *
 *   - DA-A1: "not found" footnotes must cite a verbatim identifier
 *            from the evidence ledger. Writer system prompt enforces.
 *   - DA-B1: redraft must grow-or-stay-equal in (textLen ×
 *            citationCount). The orchestrator applies this guard at
 *            redraft time (see redraftRegressionGuard below).
 *   - DA-B2: citation identifiers MUST come verbatim from evidence.
 *            Writer system prompt + extractDataCitations cross-check.
 *   - DA-B3: no hybrid citation shapes (one of the four URI shapes
 *            above; no mixing class names into paths or rows into
 *            column slots).
 *   - DA-B4: per-paragraph dedup on (connection, schema, table,
 *            column) tuples. validateParagraphCitationDedup
 *            structural check.
 */

import type { LLMProvider, LLMMessage } from '../../../shared/types.js';
import { getLogger } from '../../../shared/logger.js';
import type {
	DataAnalysisTask,
	DataCitation,
	DataEvidenceEntry,
	RdbmsCitation,
	KvCitation,
	FileSourceCitation,
	CodeRefCitation,
} from './types.js';

const log = getLogger('data-analyzer:write');

const DEFAULT_MAX_TOKENS = 3000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WriteFromDataEvidenceInput {
	readonly provider: LLMProvider;
	readonly task:     DataAnalysisTask;
	readonly evidence: readonly DataEvidenceEntry[];
	readonly maxTokens?: number | undefined;
}

export interface WriteFromDataEvidenceOutput {
	readonly markdown:      string;
	readonly citationsUsed: readonly string[];
	readonly empty:         boolean;
	readonly tokenUsage?:   { readonly inputTokens: number; readonly outputTokens: number } | undefined;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function writeFromDataEvidence(input: WriteFromDataEvidenceInput): Promise<WriteFromDataEvidenceOutput> {
	const t0 = Date.now();
	const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

	const messages: LLMMessage[] = [
		{ role: 'system', content: buildSystemPrompt() },
		{ role: 'user',   content: buildUserPrompt(input) },
	];

	log.info(
		{ itemId: input.task.itemId, evidenceCount: input.evidence.length, maxTokens },
		'writeFromDataEvidence: starting',
	);

	const resp = await input.provider.complete(messages, { maxTokens });
	const cleaned = stripWriterArtifacts(resp.text ?? '');
	const citationsUsed = extractDataCitations(cleaned);

	log.info(
		{
			itemId:        input.task.itemId,
			textLen:       cleaned.length,
			citationCount: citationsUsed.length,
			evidenceCount: input.evidence.length,
			durationMs:    Date.now() - t0,
		},
		'writeFromDataEvidence: complete',
	);

	const out: WriteFromDataEvidenceOutput = {
		markdown:      cleaned,
		citationsUsed,
		empty:         cleaned.trim().length === 0,
		...(resp.usage !== undefined ? { tokenUsage: resp.usage } : {}),
	};
	return out;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
	return [
		'You are writing prose that answers a data-analysis question using ONLY',
		'the structured evidence supplied below. Output markdown with INLINE',
		'citation links -- one link per concrete claim.',
		'',
		'## Citation URI scheme (USE EXACTLY)',
		'  - rdbms:       data:rdbms/<connectionId>/<schema>.<table>#col=<column>',
		'                 (omit `.<schema>` if not present; omit `#col=...` if no column)',
		'  - kv:          data:kv/<connectionId>/<keyPattern>#field=<fieldPath>',
		'  - file-source: data:file/<connectionId>/<path>#col=<column>',
		'  - code-ref:    path:<path>#L<startLine>-L<endLine>',
		'',
		'## Hard rules (the report is REJECTED if any of these is violated)',
		'',
		'**DA-A1**: NEVER write "X was not found" / "no Y" / "missing Z" claims',
		'unless the missing identifier (X, Y, Z) appears VERBATIM in at least one',
		'evidence citation below. If the evidence does not contain a target you',
		'want to negate, the right answer is "evidence does not address this" --',
		'not a fabricated "not found" claim.',
		'',
		'**DA-B2**: Citation identifiers MUST come verbatim from the evidence',
		'below. Do NOT abbreviate `schema.table.column` to `table.column` or',
		'`column`. Do NOT invent connection ids, table names, or column names',
		'that are not in the evidence.',
		'',
		'**DA-B3**: One URI shape per citation. Do NOT mix shapes -- e.g.',
		'`data:rdbms/conn/schema.table#col=foo&class=Bar` is wrong (class names',
		'belong in the label, not the URI). The four allowed shapes are listed',
		'above; pick the one that matches the citation\'s `kind`.',
		'',
		'**DA-B4**: Within a single paragraph, cite each (connection, schema,',
		'table, column) tuple AT MOST ONCE. Repeating the same citation in three',
		'consecutive sentences adds nothing; either spread the discussion across',
		'paragraphs or pick a more specific citation for the second mention.',
		'',
		'## Writing rules',
		'  - Output ONLY the markdown body. No heading. No "Here is..." preamble.',
		'    No "Based on the evidence" intro. No fenced-markdown wrapper.',
		'  - Pair every concrete claim with an inline citation. Paragraphs over',
		'    80 chars MUST contain at least one inline citation.',
		'  - Use the evidence\'s `facts` verbatim or paraphrase tightly; never',
		'    invent quantities or relationships absent from the evidence.',
		'  - When `numericFacts` are present on an evidence entry, render them',
		'    inline in prose (e.g. "p99 amount is 5000"). They are first-class',
		'    citations to numeric measurements.',
	].join('\n');
}

function buildUserPrompt(input: WriteFromDataEvidenceInput): string {
	const parts: string[] = [];
	parts.push('## Task question');
	parts.push(input.task.question.trim());
	parts.push('');
	parts.push(`## Task kind: ${input.task.kind}`);
	if (input.task.hint !== undefined && input.task.hint.length > 0) {
		parts.push('');
		parts.push(`## Hint`);
		parts.push(input.task.hint);
	}
	parts.push('');
	parts.push('## Evidence ledger');
	parts.push('Each item below is a fact + a citation. **Embed the citation INLINE in your');
	parts.push('prose** when you write about each fact, using the URI scheme from the system prompt.');
	parts.push('');

	if (input.evidence.length === 0) {
		parts.push('_(no evidence captured -- write a brief honest "no evidence available" note);');
		parts.push(' DA-A1 forbids fabricated "not found" claims.)_');
	} else {
		for (let i = 0; i < input.evidence.length; i++) {
			const e = input.evidence[i]!;
			parts.push(`### Evidence ${i + 1}: \`${e.skillId}\` (${e.confidence})`);
			renderEvidenceFactsWithLinks(e, i, parts);
			parts.push('');
		}
	}
	parts.push('---');
	parts.push('Write the task answer now. Markdown only, no heading.');
	return parts.join('\n');
}

function renderEvidenceFactsWithLinks(
	e:     DataEvidenceEntry,
	evIdx: number,
	parts: string[],
): void {
	const links = e.citations.map((c, ci) => renderInlineCitation(c, evIdx, ci));
	if (e.facts.length === 0 && links.length > 0) {
		parts.push(`  - (no facts; raw citations: ${links.join(', ')})`);
		return;
	}
	if (e.facts.length === 0) {
		parts.push('  - (no facts, no citations -- evidence intentionally blank)');
		return;
	}
	if (links.length === 0) {
		for (const f of e.facts) {
			parts.push(`  - ${f} _(no citation -- mark this claim as uncertain in your prose)_`);
		}
	} else {
		for (let fi = 0; fi < e.facts.length; fi++) {
			const f = e.facts[fi]!;
			const link = links[fi % links.length]!;
			parts.push(`  - ${f} ${link}`);
		}
		if (links.length > e.facts.length) {
			const extras = links.slice(e.facts.length).join(', ');
			parts.push(`  - _additional citations available: ${extras}_`);
		}
	}
	// Render numeric facts if any -- writer prompt asks for inline
	// numerics, but we surface them in the ledger so the model sees
	// them as first-class data.
	if (e.numericFacts !== undefined && e.numericFacts.length > 0) {
		parts.push('  numeric facts:');
		for (const nf of e.numericFacts) {
			parts.push(`    - ${nf.name} = ${nf.value}${nf.unit ? ' ' + nf.unit : ''}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Citation rendering
// ---------------------------------------------------------------------------

export function renderInlineCitation(c: DataCitation, evIdx: number, citIdx: number): string {
	switch (c.kind) {
		case 'rdbms':       return renderRdbmsCitation(c, evIdx, citIdx);
		case 'kv':          return renderKvCitation(c, evIdx, citIdx);
		case 'file-source': return renderFileSourceCitation(c, evIdx, citIdx);
		case 'code-ref':    return renderCodeRefCitation(c, evIdx, citIdx);
	}
}

function renderRdbmsCitation(c: RdbmsCitation, evIdx: number, citIdx: number): string {
	const tablePath = c.schema !== undefined ? `${c.schema}.${c.table}` : c.table;
	const fragment  = c.column !== undefined ? `#col=${c.column}` : '';
	const label     = c.column !== undefined ? `${tablePath}.${c.column}` : tablePath;
	const uri       = `data:rdbms/${c.connectionId}/${tablePath}${fragment}`;
	return `[${label || `ref ${evIdx + 1}.${citIdx + 1}`}](${uri})`;
}

function renderKvCitation(c: KvCitation, evIdx: number, citIdx: number): string {
	const fragment = c.fieldPath !== undefined ? `#field=${c.fieldPath}` : '';
	const label    = c.fieldPath !== undefined ? `${c.keyPattern} ${c.fieldPath}` : c.keyPattern;
	const uri      = `data:kv/${c.connectionId}/${c.keyPattern}${fragment}`;
	return `[${label || `ref ${evIdx + 1}.${citIdx + 1}`}](${uri})`;
}

function renderFileSourceCitation(c: FileSourceCitation, evIdx: number, citIdx: number): string {
	const fragment = c.column !== undefined ? `#col=${c.column}` : '';
	const fallback = c.path.split('/').pop() ?? '';
	const label    = c.column !== undefined ? `${fallback}.${c.column}` : fallback;
	const uri      = `data:file/${c.connectionId}/${c.path}${fragment}`;
	return `[${label || `ref ${evIdx + 1}.${citIdx + 1}`}](${uri})`;
}

function renderCodeRefCitation(c: CodeRefCitation, evIdx: number, citIdx: number): string {
	const range = (c.lineStart !== undefined && c.lineEnd !== undefined)
		? `#L${c.lineStart}-L${c.lineEnd}`
		: (c.lineStart !== undefined ? `#L${c.lineStart}` : '');
	const fallback = c.path.split('/').pop() ?? '';
	const label    = fallback || `ref ${evIdx + 1}.${citIdx + 1}`;
	const uri      = `path:${c.path}${range}`;
	return `[${label}](${uri})`;
}

// ---------------------------------------------------------------------------
// Output post-processing
// ---------------------------------------------------------------------------

/**
 * Strip the same writer-artifact patterns the code-side strips, plus
 * a few data-specific ones. Cheap defense-in-depth; the prompt does
 * the heavy lifting.
 */
export function stripWriterArtifacts(text: string): string {
	let t = text.trim();
	if (t.length === 0) return t;

	// Strip surrounding triple-backtick fence (with or without info string).
	const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
	if (fence) { t = fence[1]!.trim(); }

	// Strip "Here is..." / "Here's..." opener up to the first period or colon.
	t = t.replace(/^(here'?s?\b[^.\n]*?[.:]\s*)/i, '').trim();

	// Strip a leading "## title" if the model included it.
	t = t.replace(/^#{1,3}\s+\S.*\n+/, '').trim();

	// Strip "Based on the evidence" / "In summary" preambles.
	t = t.replace(/^(based on (the )?evidence|in summary|to summari[sz]e|let me\b)[^.:\n]*[.:]\s*/i, '').trim();

	return t;
}

// ---------------------------------------------------------------------------
// Citation extraction
// ---------------------------------------------------------------------------

/**
 * Extract every `[label](data:...)` or `[label](path:...)` citation
 * from the markdown. Returns distinct URIs (a single citation used in
 * two places counts once). The writer's output gets cross-checked
 * against the evidence ledger via this list; the orchestrator can
 * also pass it to the picker for citation-diversity scoring.
 */
export function extractDataCitations(markdown: string): readonly string[] {
	const re = /\[[^\]]+\]\((data:[^)]+|path:[^)]+)\)/g;
	const seen = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown)) !== null) {
		seen.add(m[1]!);
	}
	return [...seen];
}

// ---------------------------------------------------------------------------
// Citation-coverage validator (mirrors the code-side validator)
// ---------------------------------------------------------------------------

const PARAGRAPH_TRANSITION_THRESHOLD_CHARS = 80;

export interface DataCitationCoverageResult {
	readonly ok:                   boolean;
	readonly nonTrivialParagraphs: number;
	readonly uncitedParagraphs:    readonly string[];
}

export function validateDataCitationCoverage(markdown: string): DataCitationCoverageResult {
	if (typeof markdown !== 'string' || markdown.trim().length === 0) {
		return { ok: true, nonTrivialParagraphs: 0, uncitedParagraphs: [] };
	}

	const paragraphs = markdown.split(/\n\s*\n+/);
	const uncited: string[] = [];
	let nonTrivial = 0;

	for (const raw of paragraphs) {
		const p = raw.trim();
		if (p.length === 0) continue;
		if (p.length < PARAGRAPH_TRANSITION_THRESHOLD_CHARS) continue;
		if (p.endsWith(':')) continue;
		nonTrivial += 1;
		if (!/\[[^\]]+\]\((data:[^)]+|path:[^)]+)\)/.test(p)) {
			uncited.push(p);
		}
	}

	return {
		ok:                    uncited.length === 0,
		nonTrivialParagraphs:  nonTrivial,
		uncitedParagraphs:     uncited,
	};
}

export function formatDataCitationCoverageNotes(result: DataCitationCoverageResult): string[] {
	if (result.ok) return [];
	const notes: string[] = [];
	notes.push(
		`Citation coverage failure: ${result.uncitedParagraphs.length} of ${result.nonTrivialParagraphs} non-trivial paragraph(s) lack an inline [label](data:...) citation.`,
	);
	for (let i = 0; i < Math.min(result.uncitedParagraphs.length, 3); i++) {
		const p = result.uncitedParagraphs[i]!;
		const snippet = p.length > 160 ? p.slice(0, 160) + '...' : p;
		notes.push(`  - paragraph ${i + 1}: "${snippet}"`);
	}
	if (result.uncitedParagraphs.length > 3) {
		notes.push(`  - ...and ${result.uncitedParagraphs.length - 3} more paragraph(s) without citations`);
	}
	return notes;
}

// ---------------------------------------------------------------------------
// DA-B4: per-paragraph citation dedup
// ---------------------------------------------------------------------------

export interface ParagraphDedupResult {
	readonly ok:               boolean;
	readonly offendingParagraphs: readonly {
		readonly paragraph: string;
		readonly duplicates: readonly string[];
	}[];
}

/**
 * DA-B4 structural check: within each paragraph, every distinct
 * citation URI should appear AT MOST ONCE. The writer system prompt
 * asks for this; this check enforces it after the fact and produces
 * targeted redraft notes when violated.
 *
 * Uses the FULL URI (including fragment) as the dedup key, not just
 * the table+column pair -- different fragments on the same table
 * legitimately differ.
 */
export function validateParagraphCitationDedup(markdown: string): ParagraphDedupResult {
	if (typeof markdown !== 'string' || markdown.trim().length === 0) {
		return { ok: true, offendingParagraphs: [] };
	}
	const paragraphs = markdown.split(/\n\s*\n+/);
	const offending: { paragraph: string; duplicates: string[] }[] = [];
	const re = /\[[^\]]+\]\((data:[^)]+|path:[^)]+)\)/g;
	for (const raw of paragraphs) {
		const p = raw.trim();
		if (p.length === 0) continue;
		const counts: Map<string, number> = new Map();
		let m: RegExpExecArray | null;
		while ((m = re.exec(p)) !== null) {
			const uri = m[1]!;
			counts.set(uri, (counts.get(uri) ?? 0) + 1);
		}
		re.lastIndex = 0;
		const dups: string[] = [];
		for (const [uri, n] of counts) {
			if (n > 1) dups.push(uri);
		}
		if (dups.length > 0) {
			offending.push({ paragraph: p, duplicates: dups });
		}
	}
	return {
		ok: offending.length === 0,
		offendingParagraphs: offending,
	};
}

export function formatParagraphDedupNotes(result: ParagraphDedupResult): string[] {
	if (result.ok) return [];
	const notes: string[] = [];
	notes.push(
		`Per-paragraph citation dedup failure (DA-B4): ${result.offendingParagraphs.length} paragraph(s) repeat the same citation within a single paragraph. Rewrite each so the duplicate citation appears at most once per paragraph; merge claims or pick a more specific citation for the second mention.`,
	);
	for (let i = 0; i < Math.min(result.offendingParagraphs.length, 3); i++) {
		const o = result.offendingParagraphs[i]!;
		const snippet = o.paragraph.length > 160 ? o.paragraph.slice(0, 160) + '...' : o.paragraph;
		notes.push(`  - paragraph ${i + 1}: duplicates [${o.duplicates.join(', ')}]: "${snippet}"`);
	}
	return notes;
}

// ---------------------------------------------------------------------------
// DA-B1: redraft-must-grow-or-stay-equal guard
// ---------------------------------------------------------------------------

export interface RedraftRegressionInput {
	readonly originalTextLen:      number;
	readonly originalCitationCount: number;
	readonly redraftTextLen:       number;
	readonly redraftCitationCount: number;
}

export interface RedraftRegressionResult {
	readonly regressed:           boolean;
	readonly originalScore:       number;
	readonly redraftScore:        number;
	readonly ratio:               number;
}

/**
 * DA-B1: a redraft pass should ADD grounding, not trim. Compute
 * `score = textLen × citationCount` for each draft and compare. The
 * redraft regresses if its score is < 90% of the original's.
 *
 * The orchestrator's policy after this check fires:
 *   - regressed: KEEP the original draft; log a warning.
 *   - not regressed: USE the redraft.
 *
 * Empty arrays edge case: when the original score is 0, any non-zero
 * redraft is non-regressed (improving from zero is always better).
 */
export function redraftRegressionGuard(input: RedraftRegressionInput): RedraftRegressionResult {
	const originalScore = input.originalTextLen * input.originalCitationCount;
	const redraftScore  = input.redraftTextLen  * input.redraftCitationCount;
	if (originalScore === 0) {
		return {
			regressed:     false,
			originalScore,
			redraftScore,
			ratio:         redraftScore > 0 ? Infinity : 1,
		};
	}
	const ratio = redraftScore / originalScore;
	return {
		regressed:     ratio < 0.9,
		originalScore,
		redraftScore,
		ratio,
	};
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _buildSystemPromptForTest = buildSystemPrompt;
export const _buildUserPromptForTest   = buildUserPrompt;
