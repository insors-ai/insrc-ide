/**
 * Phase 12 of plans/code-analyzer-hallucination-mitigation.md.
 *
 * Structured-mode writer: the model emits a JSON object declaring
 * each paragraph + the EvidenceEntry id(s) it's grounded in. A
 * renderer then assembles the prose, splicing citations from the
 * referenced evidence entries' citation lists at render time. The
 * model never writes citation links itself.
 *
 * Hard constraints enforced by construction:
 *   - Every paragraph MUST declare at least one evidenceRef. The
 *     schema rejects empty refs[].
 *   - Every ref MUST resolve to a real evidence entry. The renderer
 *     drops paragraphs with unresolved refs (with a warning).
 *
 * Ships behind `INSRC_ANALYZER_WRITER_MODE=structured`. Default
 * remains the legacy freeform writer until live validation moves
 * the default.
 */

import type { LLMProvider, LLMMessage } from '../../../shared/types.js';
import type { PlannedAction } from '../../content-gen/plan-actions.js';
import type { RepoSizeSummary } from '../../../daemon/repo-summary.js';
import { formatRepoSizeSummary } from '../../../daemon/repo-summary.js';
import { getLogger } from '../../../shared/logger.js';
import { loadFlowPrompt } from './prompts/loader.js';
import type { EvidenceEntry } from './summarize-result.js';
import type { Citation } from '../../content-gen/discovery-plan.js';
import { extractCitations, relativizeCitationPath } from './write-from-evidence.js';
import type { WriteFromEvidenceInput, WriteFromEvidenceOutput } from './write-from-evidence.js';

const log = getLogger('code-analyzer:write-structured');

// ---------------------------------------------------------------------------
// Env-var gate
// ---------------------------------------------------------------------------

export const STRUCTURED_WRITER_ENV_VAR = 'INSRC_ANALYZER_WRITER_MODE';

export function isStructuredWriterEnabled(): boolean {
	return process.env[STRUCTURED_WRITER_ENV_VAR] === 'structured';
}

// ---------------------------------------------------------------------------
// Schema (sent to the cloud as responseFormat)
// ---------------------------------------------------------------------------

const STRUCTURED_WRITER_SCHEMA = {
	type: 'object',
	required: ['paragraphs'],
	additionalProperties: false,
	properties: {
		paragraphs: {
			type: 'array',
			minItems: 0,
			maxItems: 12,
			items: {
				type: 'object',
				required: ['narrative', 'evidenceRefs'],
				additionalProperties: false,
				properties: {
					narrative: { type: 'string', minLength: 1, maxLength: 2400 },
					evidenceRefs: {
						type: 'array',
						minItems: 1,
						maxItems: 6,
						items: { type: 'string', minLength: 1, maxLength: 32 },
						uniqueItems: true,
					},
				},
			},
		},
	},
} as const;

interface StructuredWriterResponse {
	readonly paragraphs: readonly {
		readonly narrative:    string;
		readonly evidenceRefs: readonly string[];
	}[];
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function writeSectionStructured(
	input: WriteFromEvidenceInput,
): Promise<WriteFromEvidenceOutput> {
	const t0 = Date.now();
	// Assign positional ids to evidence entries -- the prompt + model
	// + renderer all refer to entries by these ids. We never expose
	// the underlying graph ids (which the model might invent).
	const indexed = input.evidence.map((e, i) => ({ id: `e${i + 1}`, entry: e }));
	const entryById = new Map(indexed.map(x => [x.id, x.entry]));
	const maxTokens = input.maxTokens ?? Math.max(input.action.maxBudgetTokens * 2, 2400);

	const messages: LLMMessage[] = [
		{ role: 'system', content: buildStructuredSystemPrompt(input.repoSizeSummary) },
		{ role: 'user',   content: buildStructuredUserPrompt(input, indexed) },
	];

	log.info(
		{ actionId: input.action.id, evidenceCount: input.evidence.length, maxTokens },
		'writeSectionStructured: starting',
	);

	const resp = await input.provider.complete(messages, {
		maxTokens,
		temperature: 0,
		responseFormat: { schema: STRUCTURED_WRITER_SCHEMA as Record<string, unknown> },
	});

	const parsed = parseStructuredResponse(resp.text ?? '');
	if (parsed === null) {
		log.warn({ actionId: input.action.id }, 'writeSectionStructured: failed to parse structured response');
		return {
			markdown:      '',
			citationsUsed: [],
			empty:         true,
			...(resp.usage !== undefined ? { tokenUsage: resp.usage } : {}),
		};
	}

	const renderResult = renderParagraphs(parsed, entryById, input.repoPath);
	const citationsUsed = extractCitations(renderResult.markdown);

	log.info(
		{
			actionId:              input.action.id,
			textLen:               renderResult.markdown.length,
			citationCount:         citationsUsed.length,
			evidenceCount:         input.evidence.length,
			paragraphsRequested:   parsed.paragraphs.length,
			paragraphsRendered:    renderResult.kept,
			paragraphsDroppedNoRef: renderResult.droppedNoRef,
			paragraphsDroppedBadRef: renderResult.droppedBadRef,
			durationMs:            Date.now() - t0,
		},
		'writeSectionStructured: complete',
	);

	return {
		markdown:      renderResult.markdown,
		citationsUsed,
		empty:         renderResult.markdown.trim().length === 0,
		...(resp.usage !== undefined ? { tokenUsage: resp.usage } : {}),
	};
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildStructuredSystemPrompt(repoSizeSummary: RepoSizeSummary | undefined): string {
	const repoContext = (repoSizeSummary !== undefined && !repoSizeSummary.empty)
		? '\n\n## Repository under analysis\n' + formatRepoSizeSummary(repoSizeSummary, 'detailed')
		: '';
	// `write-structured` flow doesn't yet template REPO_CONTEXT --
	// inject it inline at the end (parity with the legacy writer's
	// composition pattern).
	return loadFlowPrompt('write-structured', {}) + repoContext;
}

function buildStructuredUserPrompt(
	input: WriteFromEvidenceInput,
	indexed: readonly { id: string; entry: EvidenceEntry }[],
): string {
	const parts: string[] = [];
	parts.push('## Original request');
	parts.push(input.request.trim());
	parts.push('');
	parts.push('## Section to write');
	parts.push(`title:     ${input.action.title}`);
	parts.push(`objective: ${input.action.objective}`);
	parts.push('');
	parts.push('## Review criteria');
	for (const c of input.action.reviewCriteria) {
		parts.push(`- ${c}`);
	}
	parts.push('');
	parts.push('## Evidence ledger (reference these entries by `id` in your evidenceRefs[])');
	if (indexed.length === 0) {
		parts.push('_(no evidence captured -- emit an empty paragraphs array)_');
	} else {
		for (const { id, entry } of indexed) {
			parts.push(`### ${id}: \`${entry.skillId}\` (${entry.confidence})`);
			if (entry.facts.length === 0) {
				parts.push('  - (no facts)');
			} else {
				for (const f of entry.facts) parts.push(`  - ${f}`);
			}
			parts.push('');
		}
	}
	parts.push('---');
	parts.push('Emit the structured paragraphs array now. STRICT JSON only. No markdown fences.');
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing + rendering
// ---------------------------------------------------------------------------

function parseStructuredResponse(raw: string): StructuredWriterResponse | null {
	let s = raw.trim();
	if (s.startsWith('```')) {
		s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
	}
	let parsed: unknown;
	try { parsed = JSON.parse(s); } catch { return null; }
	if (typeof parsed !== 'object' || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;
	if (!Array.isArray(obj['paragraphs'])) return null;
	const paragraphs: { narrative: string; evidenceRefs: string[] }[] = [];
	for (const p of obj['paragraphs']) {
		if (typeof p !== 'object' || p === null) continue;
		const pr = p as Record<string, unknown>;
		const narrative = typeof pr['narrative'] === 'string' ? (pr['narrative'] as string).trim() : '';
		if (narrative.length === 0) continue;
		if (!Array.isArray(pr['evidenceRefs'])) continue;
		const refs: string[] = [];
		for (const r of pr['evidenceRefs']) {
			if (typeof r === 'string' && r.length > 0) refs.push(r);
		}
		if (refs.length === 0) continue; // schema-enforced, but defensive
		paragraphs.push({ narrative, evidenceRefs: refs });
	}
	return { paragraphs };
}

interface RenderResult {
	readonly markdown:        string;
	readonly kept:            number;
	readonly droppedNoRef:    number;
	readonly droppedBadRef:   number;
}

/**
 * Render the structured response into prose. For each paragraph:
 *   1. Resolve evidenceRefs to entries; drop the paragraph if any
 *      ref doesn't resolve (model invented an id).
 *   2. Splice ONE citation from the FIRST referenced entry at the
 *      end of the paragraph's first sentence.
 *   3. Append additional citations (from other refs) at the end of
 *      the paragraph in parens.
 *
 * Splicing rules favour readability over comprehensive coverage --
 * a paragraph with 3 refs gets 1 primary citation + 2 supporting
 * citations appended; it doesn't try to anchor each sentence.
 */
function renderParagraphs(
	response: StructuredWriterResponse,
	entryById: ReadonlyMap<string, EvidenceEntry>,
	repoPath: string | undefined,
): RenderResult {
	const out: string[] = [];
	let droppedNoRef = 0;
	let droppedBadRef = 0;
	for (const p of response.paragraphs) {
		if (p.evidenceRefs.length === 0) { droppedNoRef++; continue; }
		const resolved = p.evidenceRefs
			.map(id => entryById.get(id))
			.filter((e): e is EvidenceEntry => e !== undefined);
		if (resolved.length === 0) { droppedBadRef++; continue; }
		const rendered = renderOneParagraph(p.narrative, resolved, repoPath);
		if (rendered.length > 0) out.push(rendered);
	}
	return {
		markdown:      out.join('\n\n'),
		kept:          out.length,
		droppedNoRef,
		droppedBadRef,
	};
}

function renderOneParagraph(narrative: string, refs: readonly EvidenceEntry[], repoPath: string | undefined): string {
	// Gather all candidate citations from the referenced entries.
	const allCitations: string[] = [];
	for (const e of refs) {
		// Structured citations first (preferred -- richer label data)
		if (e.citationObjs !== undefined && e.citationObjs.length > 0) {
			for (const c of e.citationObjs) {
				allCitations.push(renderCitationLink(c, repoPath));
			}
		}
		// Legacy string citations fall back -- peel off any `path:`
		// prefix, relativize against the active repo root, re-attach.
		// Preserves URL fragments (#Lx-Ly).
		for (const c of e.citations) {
			const raw = c.startsWith('path:') ? c.slice('path:'.length) : c;
			const fragIdx = raw.indexOf('#');
			const body    = fragIdx >= 0 ? raw.slice(0, fragIdx) : raw;
			const frag    = fragIdx >= 0 ? raw.slice(fragIdx)    : '';
			const rel     = relativizeCitationPath(body, repoPath);
			allCitations.push(`[ref](path:${rel}${frag})`);
		}
	}
	if (allCitations.length === 0) {
		// No citations on the referenced entries -- return narrative
		// without splicing. The citation-coverage validator (Phase
		// 11.A) will catch this paragraph as un-cited and trigger
		// redraft. We do not synthesize a placeholder citation.
		return narrative;
	}
	// Splice strategy: anchor at the end of the first sentence.
	const primary = allCitations[0]!;
	const secondary = allCitations.slice(1, 3); // cap at 2 extras to avoid clutter

	// First-sentence split: find first `. ` followed by an uppercase
	// letter, or fall back to the whole narrative.
	const firstSentenceMatch = narrative.match(/^([^.]+\.)\s+/);
	let body: string;
	if (firstSentenceMatch !== null) {
		const head = firstSentenceMatch[1]!;
		const rest = narrative.slice(firstSentenceMatch[0].length);
		body = `${head.slice(0, -1)} ${primary}.${rest.length > 0 ? ' ' + rest : ''}`;
	} else {
		// Whole paragraph is one sentence; append the citation before the
		// terminal punctuation.
		const terminal = narrative.match(/[.!?]\s*$/);
		if (terminal !== null) {
			body = `${narrative.slice(0, terminal.index)} ${primary}${terminal[0]}`;
		} else {
			body = `${narrative} ${primary}`;
		}
	}

	if (secondary.length > 0) {
		body += ` (see also ${secondary.join(', ')})`;
	}
	return body;
}

function renderCitationLink(c: Citation, repoPath: string | undefined): string {
	const range = (c.startLine !== undefined && c.endLine !== undefined)
		? `#L${c.startLine}-L${c.endLine}`
		: (c.startLine !== undefined ? `#L${c.startLine}` : '');
	const fallbackLabel = c.path.split('/').pop() ?? 'ref';
	const label = c.label ?? (fallbackLabel.length > 0 ? fallbackLabel : 'ref');
	const renderedPath = relativizeCitationPath(c.path, repoPath);
	return `[${label}](path:${renderedPath}${range})`;
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _parseStructuredResponseForTest = parseStructuredResponse;
export const _renderParagraphsForTest        = renderParagraphs;
export const _renderOneParagraphForTest      = renderOneParagraph;
