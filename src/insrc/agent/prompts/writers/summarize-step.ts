/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * summarize-step writer -- the LOCAL-tier turn that authors cited
 * summaries for each call of a freshly-executed DiscoveryStep.
 *
 * Replaces the cloud-side `lastStepArtifactSummary` from Phase 4. The
 * cloud-tier `decide-next-step` previously wrote summaries for its own
 * goal-aware purposes, which produced mis-labelled artifacts (live run
 * caught `data.source.file.sample-shape` output labelled as "INGRN
 * Pydantic Model Class Definition"). Moving summary authoring to the
 * local tier with citations:
 *
 *   - Local model has narrow context (just the call's raw output) so
 *     can't drift toward the TODO goal.
 *   - Every claim carries citations -- verbatim substrings the
 *     verifier substring-matches against the call's raw text.
 *   - Mislabelling self-detects: a summary calling extract-fields
 *     output a "class definition" still has to cite spans from THAT
 *     output, so the claim text is bound to the actual content.
 *
 * Citation namespace: the model emits citations keyed by **callId**
 * (e.g. `s1.a`) -- short ids, no chance of the artifact-vec triple
 * format-discipline failures we cataloged in the live run. The
 * caller (`step-summarize-step.ts`) substitutes callId -> artifactId
 * before storing the result. The model never sees the long form.
 *
 * Output schema (strict JSON):
 *
 *   {
 *     "summaries": [
 *       {
 *         "callId":   "s1.a",
 *         "summary":  "1-3 sentence narrative",
 *         "claims": [
 *           {
 *             "claim":     "<atomic assertion>",
 *             "evidence":  "cited" | "confirmed-null",
 *             "citations": [
 *               { "callId": "<call this span comes from>", "span": "<verbatim substring>" }
 *             ],
 *             "countAssertion": 27   // OPTIONAL -- only when claim names a number
 *           }
 *         ],
 *         "gapClosures": [
 *           {
 *             "gapId":     "<gap-fact id>",
 *             "verdict":   "closes" | "partially" | "off-topic",
 *             "claim":     "<assertion of the closure>",
 *             "evidence":  "cited" | "confirmed-null",
 *             "citations": [...]
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Validation runs at the caller-level (step-summarize-step). This
 * writer just builds the prompt.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { RequiredFact } from '../../section-flow/fact-gap-types.js';
import type { PromptWriter } from '../types.js';
import { renderFactGaps } from '../composers/fact-gaps.js';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export interface SummarizeStepCallInput {
	/** PlannedSkillCall.id (e.g. `s1.a`). */
	readonly callId:     string;
	/** Catalog skill id (e.g. `code.class.extract-fields`). */
	readonly skillId:    string;
	/** Literal args sentence from the planner. */
	readonly context:    string;
	/**
	 * Raw text output of the skill call. May be empty (the call
	 * returned nothing). Empty text is the canonical case for
	 * `evidence: 'confirmed-null'`.
	 */
	readonly rawText:    string;
}

export interface SummarizeStepWriterInput {
	readonly todoObjective: string;
	readonly stepIntent:    string;
	readonly stepStatus:    'ok' | 'partial' | 'failed';
	readonly calls:         readonly SummarizeStepCallInput[];
	readonly gapFacts:      readonly RequiredFact[];
	readonly isRetry:       boolean;
	/** When isRetry is true, the caller's list of failing claims + reasons. */
	readonly priorFailureReason: string | undefined;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const ROLE = [
	'You are the SUMMARIZE-STEP writer for one DiscoveryStep of a section-',
	'flow investigation. The step has just executed; for each of its skill',
	'calls you see the call\'s raw text output. Your job is to author a',
	'**cited summary** for each call: a short narrative + a list of atomic',
	'claims, each backed by verbatim citations into the raw output.',
	'',
	'A later verifier substring-matches every citation against the call\'s',
	'raw text. Claims whose citations don\'t match are REJECTED -- the',
	'caller retries you with a corrective hint, or escalates. You CANNOT',
	'sneak past the verifier: paraphrased / invented / hallucinated spans',
	'fail the substring check by definition.',
	'',
	'Citation rules:',
	'  - Citation `span` MUST be a VERBATIM substring of the cited call\'s',
	'    raw text. NO paraphrase. NO ellipses. NO summarisation. Copy',
	'    characters literally including whitespace.',
	'  - Citation `callId` MUST be one of the callIds listed under',
	'    "CALLS TO SUMMARISE" below. Use the SHORT id (e.g. `s1.a`),',
	'    NOT any other format. A claim from call s1.a may cite spans',
	'    in call s1.b\'s output -- use `s1.b` for that citation.',
	'  - Each citation `span` should be 40-300 chars and SPECIFIC enough',
	'    to be unambiguous. A common single word ("the", "field") would',
	'    pass the substring check vacuously and is a useless citation.',
	'',
	'Evidence type:',
	'  - `cited` -- the normal case. >=1 citation, each substring-matches.',
	'  - `confirmed-null` -- ONLY when the claim asserts ABSENCE. Use when',
	'    the call\'s raw text is empty (or all-whitespace) AND the claim',
	'    is "no matches", "directory empty", "no fields found", etc.',
	'    Exactly ONE citation, pointing to the empty artifact.',
	'',
	'Count claims (CRITICAL):',
	'  - When a claim names a number ("class has 27 fields", "directory',
	'    contains 12 files"), supply `countAssertion: N` AND include ONE',
	'    citation per element (27 citations for 27 fields, 12 for 12',
	'    files). The verifier asserts `citations.length === countAssertion`.',
	'  - Do NOT inflate counts. If you can only cite 8 fields with spans,',
	'    write the claim as "the artifact lists fields including X, Y, Z"',
	'    with 3-5 cited examples (no countAssertion), NOT "the class has',
	'    27 fields" without 27 citations.',
	'',
	'Gap closures (separate from regular claims):',
	'  - For EACH gap-fact this call materially supports or definitively',
	'    rules out (off-topic), emit one entry in `gapClosures`. Use the',
	'    gap-fact\'s EXACT `id` (verbatim, NO paraphrasing -- no trailing',
	'    punctuation, no pluralisation drift).',
	'  - `verdict: "closes"`     -- this call\'s output materially answers',
	'    the gap-fact in full.',
	'  - `verdict: "partially"`  -- this call addresses the gap-fact but',
	'    more evidence is needed.',
	'  - `verdict: "off-topic"`  -- this call definitively doesn\'t speak',
	'    to this gap-fact (the question is out of scope for this artifact).',
	'  - Each closure carries its own citations -- same rules.',
	'',
	'Narrative summary:',
	'  - 1-3 sentences. Human-readable header describing what the call',
	'    produced. Specific identifiers / numbers belong in `claims`',
	'    (with citations), NOT in this narrative.',
	'  - Avoid goal-aware labels (e.g. don\'t call sample-shape output',
	'    "the class definition" just because the TODO is about the class).',
	'    Describe what the skill actually returned.',
	'',
	'Output exactly ONE JSON object with key `summaries` -- an array of',
	'one entry per call. No prose outside the JSON. No markdown fences.',
	'',
	'Edge cases:',
	'  - Empty raw text -> emit a summary with `summary` describing the',
	'    null result, `claims: []` OR one `confirmed-null` claim, and',
	'    `gapClosures` listing any gap this null materially closes off.',
	'  - Single short string output (e.g. an entity id) -> one claim',
	'    citing that string verbatim. No gap closures unless the id',
	'    itself answers a gap.',
	'  - Long verbose output (e.g. a code dump) -> 3-8 claims pinning',
	'    the most material assertions with specific 40-300 char spans',
	'    each. Don\'t try to summarise everything -- pick what matters',
	'    for the gap-facts.',
].join('\n');

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

function buildUser(input: SummarizeStepWriterInput): string {
	const lines: string[] = [];

	lines.push('## TODO OBJECTIVE');
	lines.push(input.todoObjective);
	lines.push('');

	lines.push('## STEP THAT JUST EXECUTED');
	lines.push(`intent: ${input.stepIntent}`);
	lines.push(`step status: ${input.stepStatus}`);
	lines.push('');

	lines.push('## GAP FACTS (closure targets)');
	lines.push(renderFactGaps(input.gapFacts));
	lines.push('');

	lines.push('## CALLS TO SUMMARISE');
	lines.push('Use these EXACT callIds in your citations and in the `summaries[].callId` field:');
	lines.push('');
	for (const call of input.calls) {
		lines.push(`### callId: ${call.callId}`);
		lines.push(`skillId: ${call.skillId}`);
		lines.push(`context: ${call.context}`);
		lines.push('raw output:');
		const raw = call.rawText.trim();
		if (raw.length === 0) {
			lines.push('  (empty)');
		} else {
			for (const ln of raw.split('\n')) { lines.push(`  ${ln}`); }
		}
		lines.push('');
	}

	if (input.isRetry) {
		lines.push('## RETRY CORRECTION');
		lines.push(`Your previous response had bad citations: ${input.priorFailureReason ?? 'unknown'}`);
		lines.push('Re-emit a fixed JSON object. Every citation span MUST be a verbatim substring of the raw output for its callId above.');
		lines.push('');
	}

	lines.push('## OUTPUT SHAPE');
	lines.push('Emit ONE JSON object:');
	lines.push('');
	lines.push('{');
	lines.push('  "summaries": [');
	lines.push('    {');
	lines.push('      "callId":   "<one of the callIds above>",');
	lines.push('      "summary":  "<1-3 sentence narrative>",');
	lines.push('      "claims": [');
	lines.push('        {');
	lines.push('          "claim":     "<atomic assertion>",');
	lines.push('          "evidence":  "cited",');
	lines.push('          "citations": [');
	lines.push('            { "callId": "<one of the callIds above>", "span": "<verbatim substring 40-300 chars>" }');
	lines.push('          ]');
	lines.push('          // "countAssertion": 27  -- ONLY when the claim names a count');
	lines.push('        }');
	lines.push('      ],');
	lines.push('      "gapClosures": [');
	lines.push('        {');
	lines.push('          "gapId":     "<exact gap-fact id>",');
	lines.push('          "verdict":   "closes" | "partially" | "off-topic",');
	lines.push('          "claim":     "<assertion of the closure>",');
	lines.push('          "evidence":  "cited" | "confirmed-null",');
	lines.push('          "citations": [{ "callId": "...", "span": "..." }]');
	lines.push('        }');
	lines.push('      ]');
	lines.push('    }');
	lines.push('  ]');
	lines.push('}');
	lines.push('');
	lines.push('## TASK');
	lines.push('Emit the JSON object now. Begin with `{` and end with `}`.');
	return lines.join('\n');
}

export const summarizeStepWriterV1: PromptWriter<SummarizeStepWriterInput, readonly LLMMessage[]> = {
	id:      'summarize-step',
	version: 1,
	tier:    'local',
	summary: 'Local-tier turn: author cited summaries for each call of a freshly-executed DiscoveryStep.',

	build(input: SummarizeStepWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: ROLE },
			{ role: 'user',   content: buildUser(input) },
		];
	},
};

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _buildUserForTest = buildUser;
