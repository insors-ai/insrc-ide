/**
 * Phase W of plans/code-analyzer-gather-then-write.md.
 *
 * Single LLM call per section, given the structured evidence ledger
 * Phase G produced. No tool calls. No multi-turn loop. No paragraph
 * accumulation. The model writes the section in one shot.
 *
 * This is where prose lives. Phase G never emits prose for the
 * report; this module is the only one that does. As a result the
 * pathological duplication seen in run #9 (same anchor paragraph
 * emitted 20+ times because eviction kept resetting the model's
 * memory) cannot recur -- the model has one prompt with all the
 * evidence and produces one section.
 *
 * Output post-processing strips common opener artifacts (e.g.
 * "Here is the section:", fenced-markdown wrappers) the same way
 * `patchSectionItemwise` does on per-item patches.
 */

import type { LLMProvider, LLMMessage } from '../../../shared/types.js';
import type { PlannedAction } from '../../content-gen/plan-actions.js';
import type { RepoSizeSummary } from '../../../daemon/repo-summary.js';
import { formatRepoSizeSummary } from '../../../daemon/repo-summary.js';
import { getLogger } from '../../../shared/logger.js';
import { loadFlowPrompt } from './prompts/loader.js';
import type { EvidenceEntry } from './summarize-result.js';

const log = getLogger('code-analyzer:write');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WriteFromEvidenceInput {
	readonly provider:         LLMProvider;
	readonly action:           PlannedAction;
	readonly request:          string;
	readonly evidence:         readonly EvidenceEntry[];
	readonly repoSizeSummary?: RepoSizeSummary | undefined;
	/** Token cap for the write call. Defaults to action.maxBudgetTokens
	 *  + headroom (2x) for the prose, since the budget is informational
	 *  -- the model needs room to write a complete section. */
	readonly maxTokens?:       number | undefined;
	/** Active indexed-repo root. When supplied, absolute citation paths
	 *  under this root are emitted as repo-relative paths so the IDE's
	 *  `path:` opener (which joins against the workspace folder) doesn't
	 *  produce a doubled prefix like
	 *  `/workspace/Users/foo/repo/...`. Optional for back-compat with
	 *  callers (and tests) that don't carry a repo root. */
	readonly repoPath?:        string | undefined;
}

export interface WriteFromEvidenceOutput {
	/** The section markdown -- a single coherent block of prose,
	 *  unlike the interleaved writer's concatenated turns. */
	readonly markdown:         string;
	/** Citation strings the model actually used in the prose, parsed
	 *  out of the markdown. Lets the picker / reviewer score citation
	 *  diversity without re-parsing. */
	readonly citationsUsed:    readonly string[];
	/** True when the model emitted nothing or only a stub. Caller
	 *  decides what to do (the orchestrator's F.4 fallback triggers
	 *  on this). */
	readonly empty:            boolean;
	/** Token usage from the provider, when available. */
	readonly tokenUsage?:      { readonly inputTokens: number; readonly outputTokens: number } | undefined;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function writeSectionFromEvidence(input: WriteFromEvidenceInput): Promise<WriteFromEvidenceOutput> {
	// Phase 12 of plans/code-analyzer-hallucination-mitigation.md:
	// optional structured-writer path gated behind
	// INSRC_ANALYZER_WRITER_MODE=structured. The structured writer
	// emits `{paragraphs: [{narrative, evidenceRefs}]}` and a
	// renderer splices citations from real EvidenceEntry citations
	// -- by construction, no paragraph can exist without an evidence
	// anchor. Default path remains the legacy freeform writer.
	const { isStructuredWriterEnabled, writeSectionStructured } = await import('./write-from-evidence-structured.js');
	if (isStructuredWriterEnabled()) {
		return writeSectionStructured(input);
	}

	const t0 = Date.now();
	const maxTokens = input.maxTokens ?? Math.max(input.action.maxBudgetTokens * 2, 2400);

	const messages: LLMMessage[] = [
		{ role: 'system', content: buildSystemPrompt(input.repoSizeSummary) },
		{ role: 'user',   content: buildUserPrompt(input) },
	];

	log.info(
		{ actionId: input.action.id, evidenceCount: input.evidence.length, maxTokens },
		'writeSectionFromEvidence: starting',
	);

	const resp = await input.provider.complete(messages, { maxTokens });
	const cleaned = stripWriterArtifacts(resp.text ?? '');
	const citationsUsed = extractCitations(cleaned);

	log.info(
		{
			actionId:        input.action.id,
			textLen:         cleaned.length,
			citationCount:   citationsUsed.length,
			evidenceCount:   input.evidence.length,
			durationMs:      Date.now() - t0,
		},
		'writeSectionFromEvidence: complete',
	);

	const out: WriteFromEvidenceOutput = {
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

function buildSystemPrompt(repoSizeSummary: RepoSizeSummary | undefined): string {
	// Phase 3 of plans/code-analyzer-externalize-prompts.md.
	// Prose lives in prompts/flow/write/system.md + the sections it
	// composes. This function only assembles the repo-context variable.
	const repoContext = (repoSizeSummary !== undefined && !repoSizeSummary.empty)
		? '\n\n## Repository under analysis\n' + formatRepoSizeSummary(repoSizeSummary, 'detailed')
		: '';
	return loadFlowPrompt('write', { REPO_CONTEXT: repoContext });
}

function buildUserPrompt(input: WriteFromEvidenceInput): string {
	const parts: string[] = [];
	parts.push('## Original request');
	parts.push(input.request.trim());
	parts.push('');
	parts.push('## Section to write');
	parts.push(`title:     ${input.action.title}`);
	parts.push(`objective: ${input.action.objective}`);
	parts.push('');
	parts.push('## Review criteria (what the reviewer will score on)');
	for (const c of input.action.reviewCriteria) {
		parts.push(`- ${c}`);
	}
	// Repo summary moved to the system prompt (authoritative ambient
	// context); not repeated in the user prompt.
	parts.push('');
	parts.push('## Evidence ledger');
	parts.push('Each item below is a fact + a markdown-link citation. **Embed these links',
		'INLINE in your prose** when you write about each fact.');
	parts.push('');
	if (input.evidence.length === 0) {
		parts.push('_(no evidence captured -- write a brief best-effort overview, flag uncertainty explicitly)_');
	} else {
		for (let i = 0; i < input.evidence.length; i++) {
			const e = input.evidence[i]!;
			parts.push(`### Evidence ${i + 1}: \`${e.skillId}\` (${e.confidence})`);
			// Pair each fact with the corresponding citation as an inline
			// markdown link. The model is much more likely to carry an
			// inline link verbatim than to compose one from separate
			// fact+citation lists. When there are more facts than
			// citations, distribute the citations round-robin so every
			// fact carries at least one. When there are more citations
			// than facts, attach the extras to the last fact.
			//
			// Phase epsilon of plans/code-analyzer-discovery-plan-loop.md:
			// when the entry carries structured `citationObjs` (from the
			// discovery flow's adapter), render markdown links directly
			// from the Citation fields -- the writer sees the entityId,
			// label, and line range natively rather than parsing a string
			// like `path:foo.ts#L1-L20`. Falls back to the legacy
			// string-citation path when `citationObjs` is undefined or
			// empty (gather-evidence flow + back-compat).
			const links = (e.citationObjs !== undefined && e.citationObjs.length > 0)
				? e.citationObjs.map((c, idx) => renderStructuredCitationLink(c, i, idx, input.repoPath))
				: e.citations.map((c, idx) => {
					// Legacy string-citation path: peel off any `path:`
					// prefix, relativize against the active repo root,
					// then re-attach. Preserves URL fragments (#Lx-Ly).
					const raw = c.startsWith('path:') ? c.slice('path:'.length) : c;
					const fragIdx = raw.indexOf('#');
					const body    = fragIdx >= 0 ? raw.slice(0, fragIdx) : raw;
					const frag    = fragIdx >= 0 ? raw.slice(fragIdx)    : '';
					const rel     = relativizeCitationPath(body, input.repoPath);
					return `[ref ${i + 1}.${idx + 1}](path:${rel}${frag})`;
				});
			if (e.facts.length === 0) {
				if (links.length > 0) {
					parts.push(`  - (no facts; raw citations: ${links.join(', ')})`);
				}
			} else if (links.length === 0) {
				for (const f of e.facts) {
					parts.push(`  - ${f} _(no citation -- mark this claim as uncertain in your prose)_`);
				}
			} else {
				for (let fi = 0; fi < e.facts.length; fi++) {
					const f = e.facts[fi]!;
					// Round-robin assignment so every fact gets at least one
					// link when there's at least one citation overall.
					const link = links[fi % links.length]!;
					parts.push(`  - ${f} ${link}`);
				}
				// Surface any "extra" citations (more cites than facts) so
				// the model can still attach them to whichever paragraph
				// fits best.
				if (links.length > e.facts.length) {
					const extras = links.slice(e.facts.length).join(', ');
					parts.push(`  - _additional citations available for this evidence: ${extras}_`);
				}
			}
			parts.push('');
		}
	}
	parts.push('---');
	parts.push('Write the section body now. Markdown only, no heading.');
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Output post-processing
// ---------------------------------------------------------------------------

/**
 * Strip common writer-artifact openers / wrappers the model emits
 * despite the prompt rules. Cheap defense in depth; prompt does the
 * heavy lifting. Mirrors the approach in `patchSectionItemwise`'s
 * `stripParagraphArtifacts`.
 */
export function stripWriterArtifacts(text: string): string {
	let t = text.trim();
	if (t.length === 0) return t;

	// Strip surrounding triple-backtick fence (with or without info
	// string). The model occasionally wraps the whole section in
	// ```markdown ... ```.
	const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
	if (fence) { t = fence[1]!.trim(); }

	// Strip a "Here is..." / "Here's..." opener up to the first
	// period or colon (lazy match so the actual content isn't eaten).
	t = t.replace(/^(here'?s?\b[^.\n]*?[.:]\s*)/i, '').trim();

	// Strip a leading "## title" if the model included it despite
	// the rule (the orchestrator prepends the heading).
	t = t.replace(/^#{1,3}\s+\S.*\n+/, '').trim();

	// Strip "Based on the evidence" / "In summary" preambles at the
	// start (process narration that leaked past the prompt). The
	// body is `[^.:\n]*` (no period/colon/newline) so we stop at the
	// FIRST sentence terminator -- a greedier match would eat past
	// the boundary and consume the actual content.
	t = t.replace(/^(based on (the )?evidence|in summary|to summari[sz]e|let me\b)[^.:\n]*[.:]\s*/i, '').trim();

	return t;
}

/**
 * Pull out every `[text](path:foo.ts#L1-L20)`-style citation the
 * markdown actually contains. Lets the picker score citation
 * diversity without rescanning the body. Distinct URIs only -- a
 * single citation used in two places counts once.
 */
/**
 * Strip the active repo root prefix from an absolute citation path so
 * the IDE's `path:` opener (`pathUriOpener.ts`) -- which joins the URI
 * path against the workspace folder -- doesn't produce a doubled
 * prefix like `<workspace>/Users/foo/repo/file.java`. Returns the
 * input unchanged when `repoRoot` is absent or the path isn't a
 * descendant of it.
 *
 * Examples (with repoRoot=`/Users/foo/hadoop`):
 *   `/Users/foo/hadoop/src/Main.java` -> `src/Main.java`
 *   `/Users/foo/other/x.java`         -> `/Users/foo/other/x.java`  (unchanged)
 *   `src/Main.java`                    -> `src/Main.java`             (already relative)
 */
export function relativizeCitationPath(absOrRelPath: string, repoRoot: string | undefined): string {
	if (repoRoot === undefined || repoRoot.length === 0) return absOrRelPath;
	const root = repoRoot.replace(/\/+$/, '');
	if (absOrRelPath === root) return '.';
	const prefix = `${root}/`;
	if (absOrRelPath.startsWith(prefix)) return absOrRelPath.slice(prefix.length);
	return absOrRelPath;
}

/**
 * Render one structured Citation as an inline `[label](path:foo#L1-L20)`
 * markdown link. Phase epsilon of plans/code-analyzer-discovery-plan-loop.md:
 * the discovery flow's adapter populates `EvidenceEntry.citationObjs`
 * with these; the writer renders them natively rather than carrying
 * pre-rendered strings.
 *
 * Label preference:
 *   1. Citation.label (class/function/file label from the cloud or
 *      the executing skill)
 *   2. The file's basename (path's tail segment)
 *   3. The bare fact-pair "ref <evIdx+1>.<citIdx+1>" if both are
 *      missing (matches the legacy string path's label format).
 */
function renderStructuredCitationLink(c: import('../../content-gen/discovery-plan.js').Citation, evIdx: number, citIdx: number, repoPath?: string | undefined): string {
	const range = (c.startLine !== undefined && c.endLine !== undefined)
		? `#L${c.startLine}-L${c.endLine}`
		: (c.startLine !== undefined ? `#L${c.startLine}` : '');
	const fallbackLabel = c.path.split('/').pop() ?? '';
	const label = c.label ?? (fallbackLabel.length > 0 ? fallbackLabel : `ref ${evIdx + 1}.${citIdx + 1}`);
	const renderedPath = relativizeCitationPath(c.path, repoPath);
	return `[${label}](path:${renderedPath}${range})`;
}

export function extractCitations(markdown: string): readonly string[] {
	const re = /\[[^\]]+\]\(path:([^)]+)\)/g;
	const seen = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown)) !== null) {
		seen.add(`path:${m[1]!}`);
	}
	return [...seen];
}

// ---------------------------------------------------------------------------
// Phase 11.A of plans/code-analyzer-hallucination-mitigation.md:
// citation-per-paragraph validator.
// ---------------------------------------------------------------------------

/**
 * Paragraphs shorter than this character count are treated as
 * transitional and exempted from the citation requirement.
 * Empirical: legitimate transition sentences ("These components are
 * detailed below:", section openers naming the subject) tend to be
 * under 80 chars; padding paragraphs are usually longer.
 */
const PARAGRAPH_TRANSITION_THRESHOLD_CHARS = 80;

export interface CitationCoverageResult {
	readonly ok:                    boolean;
	/** Total non-trivial paragraphs (above the transition threshold). */
	readonly nonTrivialParagraphs:  number;
	/** Paragraphs above threshold that lack any `[label](path:...)` link. */
	readonly uncitedParagraphs:     readonly string[];
}

/**
 * Validate that every non-trivial paragraph contains at least one
 * inline `[label](path:...)` citation link. Returns the offending
 * paragraphs so callers can surface them to a redraft prompt.
 *
 * "Non-trivial" excludes:
 *   - Empty / whitespace-only blocks
 *   - Paragraphs ending with `:` (intro to a following list)
 *   - Paragraphs under `PARAGRAPH_TRANSITION_THRESHOLD_CHARS` --
 *     these are typically transitions ("The next sections detail..."),
 *     where requiring a citation hurts readability.
 *
 * The validator is intentionally permissive on short text and strict
 * on long blocks: an 800-char paragraph with no citations is almost
 * certainly hallucinated filler; a 60-char transition sentence is
 * almost certainly legitimate.
 */
export function validateCitationCoverage(markdown: string): CitationCoverageResult {
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
		// Skip "intro to list" paragraphs ending with a colon -- the
		// following list items typically carry the citations.
		if (p.endsWith(':')) continue;
		nonTrivial += 1;
		// Look for any `[label](path:...)` link
		if (!/\[[^\]]+\]\(path:[^)]+\)/.test(p)) {
			uncited.push(p);
		}
	}

	return {
		ok:                    uncited.length === 0,
		nonTrivialParagraphs:  nonTrivial,
		uncitedParagraphs:     uncited,
	};
}

/**
 * Render the citation-coverage failure as redraft notes. Truncates
 * each offending paragraph so the redraft prompt stays bounded.
 */
export function formatCitationCoverageNotes(result: CitationCoverageResult): string[] {
	if (result.ok) return [];
	const notes: string[] = [];
	notes.push(
		`Citation coverage failure: ${result.uncitedParagraphs.length} of ${result.nonTrivialParagraphs} non-trivial paragraph(s) lack an inline [label](path:...) citation. Every non-transition paragraph MUST contain at least one citation drawn from the evidence ledger. Rewrite the following without removing citations from other paragraphs:`,
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
// Test exports
// ---------------------------------------------------------------------------

export const _buildSystemPromptForTest             = buildSystemPrompt;
export const _buildUserPromptForTest               = buildUserPrompt;
export const _renderStructuredCitationLinkForTest  = renderStructuredCitationLink;
