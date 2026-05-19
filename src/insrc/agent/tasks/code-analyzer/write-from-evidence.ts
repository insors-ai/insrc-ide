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
	const parts: string[] = [
		'## Compliance directive (READ FIRST)',
		'',
		'You MUST follow EVERY instruction in this prompt carefully and without',
		'deviation. These rules are not suggestions -- they are the contract under',
		'which your output is judged. Partial compliance, "good enough" shortcuts,',
		'or skipping rules you think don\'t apply will cause the output to be',
		'rejected and the round to fail. If a rule conflicts with what feels',
		'natural, the rule wins.',
		'',
		'You are writing ONE section of a code-analysis report.',
		'',
		'You will receive (in the user message):',
		'  - The section title + objective + review criteria.',
		'  - The full EVIDENCE LEDGER another agent gathered for this section --',
		'    a list of skill invocations with extracted facts and INLINE citation links.',
		'',
		'Repository-level context (file counts, top modules, languages) is supplied',
		'at the END of this system prompt -- treat it as authoritative ambient context,',
		'not as user-supplied data.',
		'',
		'## Anti-hallucination contract (NON-NEGOTIABLE)',
		'',
		'You may have prior knowledge of well-known codebases (Hadoop, Linux, React,',
		'Django, etc.). For this report you must IGNORE that prior knowledge. The reader',
		'needs to verify every fact against THIS specific repository -- which may be a',
		'fork, a custom version, an outdated snapshot, or a completely different project',
		'with a similar name.',
		'',
		'Rules:',
		'  1. Every factual statement in your prose must trace to a fact line in the',
		'     evidence ledger. If a fact is not in the ledger, it is NOT IN YOUR REPORT.',
		'  2. You may NOT invent counts ("contains 135 files"), class names',
		'     ("`DistributedFileSystem`"), file paths, or method signatures unless',
		'     EXACTLY that detail appears in an evidence fact.',
		'  3. Every citation link `[label](path:...)` must be carried VERBATIM from the',
		'     evidence ledger. You may NOT compose a new path URL. You may NOT cite a',
		'     directory and pretend it points to a class. The citations in the ledger',
		'     are the ONLY URLs allowed in the prose.',
		'  4. If the evidence does not cover a topic the section asks about, SAY SO',
		'     EXPLICITLY in the prose: "The available evidence does not surface',
		'     <topic>; this is a gap." Do NOT fill the gap with general knowledge.',
		'  5. If the evidence ledger is empty or near-empty (0-2 entries), produce a',
		'     SHORT honest paragraph stating that the gather phase did not surface',
		'     enough information to write this section. DO NOT write a plausible-looking',
		'     section from memory.',
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
		'     link** -- AND that link must be one of the citations from the evidence',
		'     ledger, not a path you composed yourself.',
		'  2. **Every claim must be traceable to an evidence fact.** Specific counts,',
		'     class names, method names, file paths: all of these must appear in an',
		'     evidence fact verbatim, OR you may NOT include them.',
		'  3. **Carry citation links VERBATIM** -- same label, same URL. Do NOT shorten,',
		'     paraphrase, or invent.',
		'  4. **Honest gaps are better than plausible fabrications.** If you don\'t have',
		'     evidence for a topic, write "the available evidence does not cover X" --',
		'     do not pad with general knowledge.',
		'  5. **NO process narration.** Never "I will...", "Let me...", "Based on the',
		'     evidence above...", "In conclusion...".',
		'  6. **NO preamble or postscript.** No "Here is the section:". No "In summary".',
		'  7. **No section heading.** Do NOT emit `## title` -- the orchestrator prepends',
		'     it. Start with the body paragraph directly.',
		'  8. **Drive prose density off the evidence size.** Many evidence entries -> a',
		'     full 4-8 paragraph section. Few entries -> 1-3 honest paragraphs that say',
		'     what was found and what was not. Don\'t pad to hit a paragraph count.',
		'',
		'Before you finish: scan your output. For EACH claim, ask "is this fact in the',
		'evidence ledger?" If no, REMOVE or REWRITE it. For each paragraph: does it have',
		'an inline `[...](path:...)` link from the ledger? If no, REWRITE it.',
	];
	if (repoSizeSummary !== undefined && !repoSizeSummary.empty) {
		parts.push('');
		parts.push('## Repository under analysis');
		parts.push(formatRepoSizeSummary(repoSizeSummary, 'detailed'));
	}
	return parts.join('\n');
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
