/**
 * summarizeResult -- Phase A of
 * [plans/analyzers/data-analyzer-parity.md].
 *
 * Extracts a structured `DataEvidenceEntry { facts, citations,
 * confidence, numericFacts? }` from one runSkill or db_* tool result.
 *
 * Mirrors agent/tasks/code-analyzer/summarize-result.ts but emits
 * DataCitations (rdbms / kv / file-source / code-ref) instead of
 * code-side string paths, and exposes an optional structured
 * `numericFacts` slot so profile / quality / distribution skills
 * can surface histogram bins, percentiles, and cardinality counts
 * to the writer without round-tripping through prose paraphrase.
 *
 * The summarizer call is bounded (~2-3k tokens of input total) so
 * it sits well under the deep-multi-turn regime where local models
 * like Devstral-Small-2 start dropping their generated tokens to
 * empty content.
 *
 * Routes through the cloud LLM by default (DA-E1 of the parity
 * plan). Opt-out via INSRC_DATA_ANALYZER_USE_LOCAL=1, matching the
 * code-analyzer's cloud-as-default routing pattern.
 *
 * Callers:
 *   - Phase B's silent guard wraps runSkill dispatch; after each
 *     runSkill returns its `SkillResult`, the surrounding caller
 *     hands the result text to summarizeResult.
 *   - Phase C's execute-step.ts (when it lands) summarises each
 *     skill invocation in its per-step tool loop.
 *   - The legacy analyzer/runner.ts can opt in by summarising the
 *     final tool result before pushing into its `DataFinding`
 *     aggregator.
 */

import type { LLMProvider } from '../../../shared/types.js';
import type { Confidence, DataCitation, DataEvidenceEntry } from './types.js';

/**
 * Max tokens reserved for the summariser's structured-output JSON.
 * Keep tight; the schema is small (1-3 facts, a citations array,
 * one confidence enum, optional numericFacts).
 */
export const SUMMARY_MAX_TOKENS = 500;

/**
 * JSON Schema for the structured-output response. Mirrors the code-
 * side EVIDENCE_SUMMARY_SCHEMA shape but adds the citations sub-
 * schemas (one per DataCitation kind) and the optional numericFacts
 * array.
 *
 * The summariser LLM emits ONE of the citation shapes per entry; the
 * `kind` discriminator tells the parser which to validate against.
 */
export const DATA_EVIDENCE_SUMMARY_SCHEMA: Record<string, unknown> = {
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
			items: {
				oneOf: [
					{
						type: 'object',
						properties: {
							kind:         { const: 'rdbms' },
							connectionId: { type: 'string' },
							schema:       { type: 'string' },
							table:        { type: 'string' },
							column:       { type: 'string' },
							sampleValue:  { type: 'string', maxLength: 1024 },
						},
						required: ['kind', 'connectionId', 'table'],
					},
					{
						type: 'object',
						properties: {
							kind:         { const: 'kv' },
							connectionId: { type: 'string' },
							keyPattern:   { type: 'string' },
							fieldPath:    { type: 'string' },
							sampleValue:  { type: 'string', maxLength: 1024 },
						},
						required: ['kind', 'connectionId', 'keyPattern'],
					},
					{
						type: 'object',
						properties: {
							kind:         { const: 'file-source' },
							connectionId: { type: 'string' },
							path:         { type: 'string' },
							column:       { type: 'string' },
							sampleValue:  { type: 'string', maxLength: 1024 },
						},
						required: ['kind', 'connectionId', 'path'],
					},
					{
						type: 'object',
						properties: {
							kind:      { const: 'code-ref' },
							path:      { type: 'string' },
							lineStart: { type: 'number' },
							lineEnd:   { type: 'number' },
							snippet:   { type: 'string', maxLength: 1024 },
						},
						required: ['kind', 'path'],
					},
				],
			},
		},
		numericFacts: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name:  { type: 'string', maxLength: 80 },
					value: { type: 'number' },
					unit:  { type: 'string', maxLength: 20 },
				},
				required: ['name', 'value'],
			},
		},
		confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
	},
	required: ['facts', 'citations', 'confidence'],
	additionalProperties: false,
};

export interface SummarizeInput {
	readonly skillId:    string;
	readonly args:       Record<string, unknown>;
	/**
	 * The skill result rendered as text for the summariser to read.
	 * Caller is responsible for stringifying SkillResult.value
	 * appropriately; we don't introspect it here.
	 */
	readonly resultText: string;
	/** The task's per-task objective (what the LLM is trying to answer). */
	readonly objective:  string;
	/** Review criteria for the task (helps the summariser pick relevant facts). */
	readonly criteria:   readonly string[];
}

/**
 * Run the summariser. Returns a `DataEvidenceEntry`. Errors during
 * structured-output parsing degrade to a low-confidence entry with a
 * synthetic "no facts extracted" prose fact -- matching the code-
 * side's defensive fallback.
 */
export async function summarizeResult(
	provider: LLMProvider,
	input:    SummarizeInput,
): Promise<DataEvidenceEntry> {
	const system = [
		'You are extracting structured evidence from one data-analysis skill invocation result.',
		'',
		'Output a JSON object matching this shape exactly:',
		'  {',
		'    "facts":        [string, ...],',
		'    "citations":    [DataCitation, ...],',
		'    "numericFacts": [{name, value, unit?}, ...]   (OPTIONAL)',
		'    "confidence":   "high"|"medium"|"low"',
		'  }',
		'',
		'Citation shapes (pick the matching `kind` for each):',
		'  - rdbms:       {kind:"rdbms",       connectionId, schema?, table,      column?, sampleValue?}',
		'  - kv:          {kind:"kv",          connectionId, keyPattern,          fieldPath?, sampleValue?}',
		'  - file-source: {kind:"file-source", connectionId, path,                column?, sampleValue?}',
		'  - code-ref:    {kind:"code-ref",    path, lineStart?, lineEnd?, snippet?}',
		'',
		'Rules:',
		'  - `facts`: 1-3 SHORT statements naming SPECIFIC entities, counts, columns, or values',
		'    surfaced by this skill call. Each fact <= 200 chars. NO speculation -- only what',
		'    the result text shows.',
		'  - `citations`: extract every concrete (connectionId + table/key/path) tuple the',
		'    result names. Carry sample values verbatim (truncated to 1 KB). Empty array',
		'    is fine if the result is pure metadata with no concrete targets.',
		'  - `numericFacts`: ONLY for skills that surface numeric values (histograms,',
		'    percentiles, cardinality counts, null ratios, distinct counts). Each entry',
		'    pairs a label with a number + optional unit. Omit entirely when the result',
		'    is qualitative.',
		'  - `confidence`: high if the result was rich + clear; medium if partial; low if',
		'    errored, empty, or off-topic for the objective.',
		'',
		'Output ONLY the JSON. No prose, no preamble.',
	].join('\n');

	const user = [
		'## Task objective',
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
			responseFormat: { schema: DATA_EVIDENCE_SUMMARY_SCHEMA },
		},
	);

	let parsed: {
		facts?:        unknown;
		citations?:    unknown;
		numericFacts?: unknown;
		confidence?:   unknown;
	} | undefined;
	try {
		parsed = JSON.parse(stripJsonCodeFence(resp.text));
	} catch {
		// Fall through; we'll synthesize a low-confidence entry below.
	}

	const facts: string[] = Array.isArray(parsed?.facts)
		? parsed!.facts.filter((f: unknown): f is string => typeof f === 'string' && f.length > 0).slice(0, 4)
		: [];

	const citations: DataCitation[] = Array.isArray(parsed?.citations)
		? parsed!.citations.flatMap((c: unknown): DataCitation[] => {
			const cit = parseCitation(c);
			return cit ? [cit] : [];
		})
		: [];

	const numericFacts: { name: string; value: number; unit?: string }[] | undefined =
		Array.isArray(parsed?.numericFacts)
			? parsed!.numericFacts.flatMap((nf: unknown): { name: string; value: number; unit?: string }[] => {
				if (typeof nf !== 'object' || nf === null) return [];
				const n = (nf as Record<string, unknown>)['name'];
				const v = (nf as Record<string, unknown>)['value'];
				const u = (nf as Record<string, unknown>)['unit'];
				if (typeof n !== 'string' || n.length === 0) return [];
				if (typeof v !== 'number' || !Number.isFinite(v)) return [];
				return [{
					name:  n,
					value: v,
					...(typeof u === 'string' && u.length > 0 ? { unit: u } : {}),
				}];
			})
			: undefined;

	const confidence: Confidence =
		parsed?.confidence === 'high' || parsed?.confidence === 'medium' || parsed?.confidence === 'low'
			? parsed.confidence
			: 'low';

	return {
		skillId: input.skillId,
		args:    input.args,
		facts:   facts.length > 0 ? facts : [`(no facts extracted from ${input.skillId})`],
		citations,
		...(numericFacts !== undefined && numericFacts.length > 0 ? { numericFacts } : {}),
		confidence,
	};
}

/**
 * Validate + narrow one raw citation object into a `DataCitation`.
 * Returns undefined on shape mismatch so the caller can flatMap-drop
 * malformed entries silently.
 */
function parseCitation(raw: unknown): DataCitation | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const o = raw as Record<string, unknown>;
	const kind = o['kind'];

	if (kind === 'rdbms') {
		const connectionId = o['connectionId'];
		const table        = o['table'];
		if (typeof connectionId !== 'string' || connectionId.length === 0) return undefined;
		if (typeof table        !== 'string' || table.length === 0)        return undefined;
		return {
			kind: 'rdbms',
			connectionId,
			table,
			...(typeof o['schema']      === 'string' && (o['schema']      as string).length > 0 ? { schema:      o['schema']      as string } : {}),
			...(typeof o['column']      === 'string' && (o['column']      as string).length > 0 ? { column:      o['column']      as string } : {}),
			...(typeof o['sampleValue'] === 'string' && (o['sampleValue'] as string).length > 0 ? { sampleValue: (o['sampleValue'] as string).slice(0, 1024) } : {}),
		};
	}

	if (kind === 'kv') {
		const connectionId = o['connectionId'];
		const keyPattern   = o['keyPattern'];
		if (typeof connectionId !== 'string' || connectionId.length === 0) return undefined;
		if (typeof keyPattern   !== 'string' || keyPattern.length === 0)   return undefined;
		return {
			kind: 'kv',
			connectionId,
			keyPattern,
			...(typeof o['fieldPath']   === 'string' && (o['fieldPath']   as string).length > 0 ? { fieldPath:   o['fieldPath']   as string } : {}),
			...(typeof o['sampleValue'] === 'string' && (o['sampleValue'] as string).length > 0 ? { sampleValue: (o['sampleValue'] as string).slice(0, 1024) } : {}),
		};
	}

	if (kind === 'file-source') {
		const connectionId = o['connectionId'];
		const path         = o['path'];
		if (typeof connectionId !== 'string' || connectionId.length === 0) return undefined;
		if (typeof path         !== 'string' || path.length === 0)         return undefined;
		return {
			kind: 'file-source',
			connectionId,
			path,
			...(typeof o['column']      === 'string' && (o['column']      as string).length > 0 ? { column:      o['column']      as string } : {}),
			...(typeof o['sampleValue'] === 'string' && (o['sampleValue'] as string).length > 0 ? { sampleValue: (o['sampleValue'] as string).slice(0, 1024) } : {}),
		};
	}

	if (kind === 'code-ref') {
		const path = o['path'];
		if (typeof path !== 'string' || path.length === 0) return undefined;
		return {
			kind: 'code-ref',
			path,
			...(typeof o['lineStart'] === 'number' && Number.isFinite(o['lineStart'] as number) ? { lineStart: o['lineStart'] as number } : {}),
			...(typeof o['lineEnd']   === 'number' && Number.isFinite(o['lineEnd']   as number) ? { lineEnd:   o['lineEnd']   as number } : {}),
			...(typeof o['snippet']   === 'string' && (o['snippet'] as string).length > 0       ? { snippet:   (o['snippet'] as string).slice(0, 1024) } : {}),
		};
	}

	return undefined;
}

/**
 * Strip a leading ```json (or bare ```) fence and the trailing ```
 * fence off a model's structured-output response. Anthropic Haiku
 * (live repro 2026-05-26 on code-analyzer) wraps JSON-formatted
 * output in markdown fences even when the request supplies a
 * `responseFormat.schema`, which used to break the bare
 * `JSON.parse(resp.text.trim())` call and silently zero out every
 * step's facts + citations. Returns the input unchanged when no
 * fence is present so qwen / other providers that already emit raw
 * JSON keep working.
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

// Test exports.
export const _parseCitationForTest          = parseCitation;
export const _stripJsonCodeFenceForTest     = stripJsonCodeFence;
