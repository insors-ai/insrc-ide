/**
 * summarizeResult -- Phase 1 of
 * [plans/code-analyzer-execute-step-per-result-summarization.md].
 *
 * Extracts a structured `EvidenceEntry { facts, citations, confidence }`
 * from one skill_invoke tool_result. The summarizer call is bounded
 * (~2-3k tokens of input total) so it sits well under the deep-
 * multi-turn regime where local models like Devstral-Small-2 start
 * dropping their generated tokens to empty content.
 *
 * Two callers:
 *   - gather-evidence (legacy path) -- one summarize per skill in its
 *     tool loop.
 *   - executeStep (Phase 2 of the same plan) -- same pattern, per
 *     PlannedSkillCall result.
 */

import type { LLMProvider } from '../../../shared/types.js';
import type { Citation } from '../../content-gen/discovery-plan.js';

/**
 * Structured summary of one skill_invoke result. Produced by
 * `summarizeResult`; consumed by the writer (write-from-evidence.ts)
 * and by the discovery flow's StepOutput aggregator.
 *
 * Lived in gather-evidence.ts until Phase 1 of
 * [plans/code-analyzer-execute-step-per-result-summarization.md]
 * pulled it out. The legacy gather-evidence flow stays callable by
 * re-exporting this name from there for back-compat; discovery-flow
 * and write-from-evidence import directly from this module.
 */
export interface EvidenceEntry {
	readonly skillId:    string;
	readonly args:       Record<string, unknown>;
	/** 1-3 short key facts extracted from the skill result. */
	readonly facts:      readonly string[];
	/** `path:foo.ts#L1-L20`-style citation strings. Legacy shape kept
	 *  for the gather-evidence emitter. The writer consumes this when
	 *  `citationObjs` is undefined.
	 *
	 *  Phase epsilon of plans/code-analyzer-discovery-plan-loop.md:
	 *  new callers (discovery-flow) populate `citationObjs` with the
	 *  structured Citation shape and leave `citations` empty. The
	 *  writer prefers `citationObjs` when present, falls back to
	 *  this string form when not. */
	readonly citations:  readonly string[];
	/** Phase epsilon: structured citations from the discovery-flow
	 *  ledger. When set + non-empty, the writer renders inline
	 *  markdown links from these (path / startLine / endLine / label)
	 *  rather than from `citations`. Optional + undefined-tolerant
	 *  so the existing gather-evidence path stays unchanged. */
	readonly citationObjs?: readonly Citation[] | undefined;
	readonly confidence: 'high' | 'medium' | 'low';
}

export const SUMMARY_MAX_TOKENS = 400;

export const EVIDENCE_SUMMARY_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		facts: {
			type: 'array',
			items: { type: 'string', maxLength: 200 },
			minItems: 1,
			maxItems: 4,
		},
		citations: {
			type: 'array',
			items: { type: 'string' },
		},
		confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
	},
	required: ['facts', 'citations', 'confidence'],
	additionalProperties: false,
};

export interface SummarizeInput {
	readonly skillId:    string;
	readonly args:       Record<string, unknown>;
	readonly resultText: string;
	readonly objective:  string;
	readonly criteria:   readonly string[];
}

export async function summarizeResult(provider: LLMProvider, input: SummarizeInput): Promise<EvidenceEntry> {
	const system = [
		'You are extracting structured evidence from one skill-invocation result.',
		'',
		'Output a JSON object matching this shape exactly:',
		'  { "facts": [string, ...], "citations": [string, ...], "confidence": "high"|"medium"|"low" }',
		'',
		'Rules:',
		'  - `facts`: 1-3 SHORT statements naming SPECIFIC entities, counts, or file paths',
		'    surfaced by this skill call. Each fact <= 200 chars. NO speculation -- only what',
		'    the result text shows.',
		'  - `citations`: file references the result text contains (path:foo.ts#L1-L20 shape).',
		'    Carry them verbatim. Empty array is fine if none are present.',
		'  - `confidence`: high if the result was rich + clear; medium if partial; low if errored,',
		'    empty, or off-topic for the objective.',
		'',
		'Output ONLY the JSON. No prose, no preamble.',
	].join('\n');

	const user = [
		'## Section objective',
		input.objective,
		'',
		'## Review criteria',
		input.criteria.map(c => `- ${c}`).join('\n'),
		'',
		`## Skill invoked: ${input.skillId}`,
		'args:',
		'```json',
		JSON.stringify(input.args, null, 2),
		'```',
		'',
		'## Result',
		input.resultText,
	].join('\n');

	const resp = await provider.complete(
		[
			{ role: 'system', content: system },
			{ role: 'user',   content: user },
		],
		{
			maxTokens:      SUMMARY_MAX_TOKENS,
			responseFormat: { schema: EVIDENCE_SUMMARY_SCHEMA },
		},
	);

	let parsed: { facts?: unknown; citations?: unknown; confidence?: unknown } | undefined;
	try {
		parsed = JSON.parse(stripJsonCodeFence(resp.text));
	} catch {
		// Fall through; we'll synthesize a low-confidence entry below.
	}

	const facts: string[] = Array.isArray(parsed?.facts)
		? parsed!.facts.filter((f: unknown): f is string => typeof f === 'string' && f.length > 0).slice(0, 4)
		: [];
	const citations: string[] = Array.isArray(parsed?.citations)
		? parsed!.citations.filter((c: unknown): c is string => typeof c === 'string' && c.length > 0)
		: [];
	const confidence: 'high' | 'medium' | 'low' =
		parsed?.confidence === 'high' || parsed?.confidence === 'medium' || parsed?.confidence === 'low'
			? parsed.confidence
			: 'low';

	return {
		skillId:    input.skillId,
		args:       input.args,
		facts:      facts.length > 0 ? facts : [`(no facts extracted from ${input.skillId})`],
		citations,
		confidence,
	};
}

/**
 * Strip a leading ```json (or bare ```) fence and the trailing ```
 * fence off a model's structured-output response. Anthropic Haiku
 * (live repro 2026-05-26) wraps JSON-formatted output in markdown
 * fences even when the request supplies a `responseFormat.schema`,
 * which used to break the bare `JSON.parse(resp.text.trim())` and
 * silently zero out every step's facts + citations. Returns the
 * input unchanged when no fence is present so qwen / other providers
 * that already emit raw JSON keep working.
 *
 * Tolerant of optional language tag (`json`, `JSON`, `Json`) and
 * surrounding whitespace.
 */
function stripJsonCodeFence(raw: string): string {
	const trimmed = raw.trim();
	const fenceOpen = /^```(?:json)?\s*\n?/i;
	const fenceClose = /\n?```\s*$/;
	if (!fenceOpen.test(trimmed)) return trimmed;
	return trimmed.replace(fenceOpen, '').replace(fenceClose, '').trim();
}

// Test export.
export const _stripJsonCodeFenceForTest = stripJsonCodeFence;
