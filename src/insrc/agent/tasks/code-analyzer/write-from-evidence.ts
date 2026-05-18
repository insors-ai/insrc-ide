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
		'    a list of skill invocations with extracted facts and citations.',
		'',
		'Your job: write the section markdown in one coherent pass. Cover the objective.',
		'Address every review criterion. Use the evidence to ground every claim.',
		'',
		'Hard rules:',
		'  1. CITE every fact via the `[label](path:foo.ts#L1-L20)` citation strings',
		'     provided in the evidence. Carry them VERBATIM into the prose. Do NOT',
		'     fabricate citations.',
		'  2. Write COMPLETE PARAGRAPHS with specific entity names, file paths, counts.',
		'     No filler ("this module is well-organised"); no speculation beyond evidence.',
		'  3. NO process narration. NEVER write "I will...", "Let me...", "Now I will...",',
		'     "Based on the evidence above, ...". Just state the facts.',
		'  4. NO preamble or postscript. No "Here is the section:". No "In summary, ...".',
		'  5. Output ONLY the section markdown body. Do NOT include the section heading',
		'     (`## title`) -- the orchestrator prepends it.',
		'  6. 4-8 paragraphs is the target. Don\'t pad; don\'t truncate.',
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
	if (input.evidence.length === 0) {
		parts.push('_(no evidence captured -- write a brief best-effort overview, flag uncertainty explicitly)_');
	} else {
		for (let i = 0; i < input.evidence.length; i++) {
			const e = input.evidence[i]!;
			parts.push(`### ${i + 1}. ${e.skillId} (confidence: ${e.confidence})`);
			parts.push(`args: \`${JSON.stringify(e.args)}\``);
			parts.push('facts:');
			for (const f of e.facts) {
				parts.push(`  - ${f}`);
			}
			if (e.citations.length > 0) {
				parts.push('citations:');
				for (const c of e.citations) {
					parts.push(`  - \`${c}\``);
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
