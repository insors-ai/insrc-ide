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
import type { EvidenceEntry } from './gather-evidence.js';

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
	const t0 = Date.now();
	const maxTokens = input.maxTokens ?? Math.max(input.action.maxBudgetTokens * 2, 2400);

	const messages: LLMMessage[] = [
		{ role: 'system', content: buildSystemPrompt() },
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

function buildSystemPrompt(): string {
	return [
		'You are writing ONE section of a code-analysis report.',
		'',
		'You will receive:',
		'  - The section title + objective + review criteria.',
		'  - A REPO SUMMARY for orientation.',
		'  - The full EVIDENCE LEDGER another agent gathered for this section --',
		'    a list of skill invocations with extracted facts and INLINE citation links.',
		'',
		'Your job: write the section markdown in one coherent pass. Cover the objective.',
		'Address every review criterion. Use the evidence to ground every claim.',
		'',
		'## How citations work (READ THIS CAREFULLY)',
		'',
		'Each evidence fact in the ledger is presented like this:',
		'  - Module contains 30 files [`db/__init__.py:1-20`](path:insors/extraction/db/__init__.py#L1-L20)',
		'',
		'The `[label](path:...)` part is a MARKDOWN LINK. When you write your prose,',
		'you MUST embed these links INLINE in your sentences -- not as a separate',
		'reference list. Carry the link VERBATIM (same label, same URL).',
		'',
		'EXAMPLE prose:',
		'  > The `db` submodule contains 30 Python files implementing the persistence',
		'  > layer ([`db/__init__.py:1-20`](path:insors/extraction/db/__init__.py#L1-L20)).',
		'  > Two classes anchor the design: `ManagedCursor` and `ExtractionDbManager`',
		'  > ([`db/__init__.py:20-80`](path:insors/extraction/db/__init__.py#L20-L80)).',
		'',
		'Notice how the `[label](path:...)` markdown links are EMBEDDED INSIDE',
		'sentences, after the claim they support. THAT is what you must produce.',
		'',
		'## Hard rules',
		'',
		'  1. **Every paragraph must contain AT LEAST ONE inline `[label](path:...)`',
		'     link.** A paragraph with no links does not count -- you must cite.',
		'  2. **Carry the citation links VERBATIM** -- same label text, same URL. Do',
		'     NOT shorten them, do NOT paraphrase the label, do NOT invent new URLs.',
		'  3. **Use specific names, counts, file paths** from the evidence facts. No',
		'     filler ("this module is well-organised"); no speculation beyond evidence.',
		'  4. **NO process narration.** Never "I will...", "Let me...", "Based on the',
		'     evidence above...", "In conclusion...". Just state the facts.',
		'  5. **NO preamble or postscript.** No "Here is the section:". No "In summary".',
		'  6. **No section heading.** Do NOT emit `## title` -- the orchestrator',
		'     prepends it. Start with the body paragraph directly.',
		'  7. **4-8 paragraphs is the target.** Don\'t pad; don\'t truncate.',
		'',
		'Before you finish: scan your output. If any paragraph has zero `[...](path:...)`',
		'links, REWRITE that paragraph to include the relevant citation from the evidence.',
	].join('\n');
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
	if (input.repoSizeSummary !== undefined && !input.repoSizeSummary.empty) {
		parts.push('');
		parts.push('## Repo summary');
		parts.push(formatRepoSizeSummary(input.repoSizeSummary, 'detailed'));
	}
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
			const links = e.citations.map((c, idx) => `[ref ${i + 1}.${idx + 1}](${c.startsWith('path:') ? c : `path:${c}`})`);
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
// Test exports
// ---------------------------------------------------------------------------

export const _buildSystemPromptForTest = buildSystemPrompt;
export const _buildUserPromptForTest   = buildUserPrompt;
