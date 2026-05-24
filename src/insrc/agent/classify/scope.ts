/**
 * Scope + subtype LLM classifier.
 *
 * Emits BOTH the size signal (`scope: ScopeSize`) and the work-shape
 * signal (`subtype: AnalysisSubtype`) in a single LLM round-trip.
 *
 *   - `scope` answers "how big?" -- S / M / L / XL / XXL / XXXL / XXXXL
 *   - `subtype` answers "what kind of work product?" -- review /
 *     summarize / audit / explain / compare / document / diagnose
 *
 * `subtype` is consumed by the analyzer's planner-discovery loop
 * (`plans/code-analyzer-planner-discovery-loop.md`) as a single-line
 * bias in the planner's system prompt. It does not branch the seed
 * shape, the toolset, the per-section budgets, or any other knob --
 * the planner's tools handle scope resolution against repo reality.
 *
 * Backward compatibility: existing callers that read only `scope`
 * are unaffected; `subtype` is a new field, ignored if unused.
 *
 * Fallback: on parse / provider failure, returns
 * `{ scope: 'M', subtype: 'review', fallback: true }`. Default
 * subtype is `'review'` because most analyzer requests are review-
 * shaped; an honest "I'm not sure what kind" answer that doesn't
 * mislead downstream emphasis biasing.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import type { ScopeSize } from '../../shared/classify.js';
import { getLogger } from '../../shared/logger.js';
import { stripJsonFences } from '../../shared/json-fences.js';

const log = getLogger('classify:scope');

const VALID_SCOPES: readonly ScopeSize[] = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'];
const VALID_SCOPES_SET = new Set<string>(VALID_SCOPES);

/**
 * Work-shape (verb) of the analysis request. Each value biases the
 * planner's section emphasis via a single-line hint -- nothing else
 * downstream branches on this.
 */
export type AnalysisSubtype =
	| 'review'      // critical reading -- surface gaps, risks, improvement opportunities
	| 'summarize'   // concise overview, broad strokes
	| 'audit'       // exhaustive examination with explicit verdicts
	| 'explain'     // pedagogical walkthrough -- how / why
	| 'compare'     // X vs Y framing
	| 'document'    // reference documentation; neutral and complete
	| 'diagnose';   // find the cause of a problem; evidence-driven

const VALID_SUBTYPES: readonly AnalysisSubtype[] = [
	'review', 'summarize', 'audit', 'explain', 'compare', 'document', 'diagnose',
];
const VALID_SUBTYPES_SET = new Set<string>(VALID_SUBTYPES);

const DEFAULT_SUBTYPE: AnalysisSubtype = 'review';

export interface ScopeClassifyInput {
	/** Free-form text to size. */
	readonly text: string;
	/**
	 * Optional context appended to the prompt -- repo signals (size,
	 * primary languages, file count) help the model judge "the
	 * entire repo" vs "a single function" prompts.
	 */
	readonly context?: string;
	/** Optional role label for the prompt preamble. Defaults to "scope sizer". */
	readonly role?: string;
}

export interface ScopeClassifyResult {
	readonly scope:     ScopeSize;
	readonly subtype:   AnalysisSubtype;
	readonly reasoning: string;
	readonly fallback:  boolean;
}

/**
 * Run a single scope + subtype classification. Caller owns provider
 * resolution (typically `session.resolver.resolve('classifier', 'scope')`).
 */
export async function classifyScope(
	input: ScopeClassifyInput,
	provider: LLMProvider,
): Promise<ScopeClassifyResult> {
	const messages = buildMessages(input);
	let rawText: string;
	try {
		const response = await provider.complete(messages, {
			maxTokens: 120,
			temperature: 0,
		});
		rawText = response.text;
	} catch (err) {
		log.warn({ err, role: input.role }, 'classifyScope: provider call failed');
		return {
			scope:     'M',
			subtype:   DEFAULT_SUBTYPE,
			reasoning: `provider error: ${(err as Error).message}`,
			fallback:  true,
		};
	}

	const parsed = parseResponse(rawText);
	if (!parsed) {
		log.warn({ role: input.role, rawText: rawText.slice(0, 200) }, 'classifyScope: unparseable response');
		return {
			scope:     'M',
			subtype:   DEFAULT_SUBTYPE,
			reasoning: 'unparseable LLM response',
			fallback:  true,
		};
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildMessages(input: ScopeClassifyInput): LLMMessage[] {
	const role = input.role ?? 'scope sizer';

	const systemLines = [
		`You are a ${role}. Given the text below, classify the work the user is asking about on TWO axes: SIZE (\`scope\`) and WORK-SHAPE (\`subtype\`).`,
		'',
		'## Scope (size of the work)',
		'These tiers apply to ANY intent -- analysis depth, query breadth, refactor span, etc. Pick the tier that gives the answer the right BREADTH.',
		'- `S`     -- one focused unit (a function, a column, a paragraph; minutes)',
		'- `M`     -- one module / one report section / one focused query (single session)',
		'- `L`     -- a full module or 5-10 sections / a feature build (multi-session)',
		'- `XL`    -- a subsystem (HDFS / auth / storage layer; many modules)',
		'- `XXL`   -- multiple subsystems (auth + storage + UI; or repo-wide analysis)',
		'- `XXXL`  -- cross-cutting concern that touches every subsystem',
		'- `XXXXL` -- whole-product / multi-product / major rewrite',
		'',
		'## Subtype (kind of work product)',
		'Alongside the tier, identify what KIND of work product the request asks for:',
		'- `review`    -- critical reading; surface gaps, risks, weak spots, improvement opportunities',
		'- `summarize` -- concise overview at the requested scope; broad strokes only',
		'- `audit`     -- exhaustive examination with explicit verdicts ("this passes / this needs work")',
		'- `explain`   -- pedagogical walkthrough -- how/why something works to someone learning',
		'- `compare`   -- two-sided framing (X vs Y, before vs after)',
		'- `document`  -- produce reference documentation; bias toward neutral, durable phrasing',
		'- `diagnose`  -- find the cause of a problem; evidence-driven cause analysis',
		'',
		'When the request gives no strong subtype signal, default to `review`.',
		'',
		'## Examples (anchors -- match the SHAPE of the prompt, not its length)',
		'- "describe what this repo does"             (large repo) -> { scope: "L",  subtype: "summarize" }',
		'- "summarise this repo and its subsystems"   (large repo) -> { scope: "XL", subtype: "summarize" }',
		'- "review insors/extraction"                              -> { scope: "XL", subtype: "review" }',
		'- "audit the data-access layer for SQL injection"         -> { scope: "L",  subtype: "audit" }',
		'- "explain how the message consumer works"                -> { scope: "L",  subtype: "explain" }',
		'- "compare the Anthropic and Mistral OCR backends"        -> { scope: "L",  subtype: "compare" }',
		'- "document the public API of extraction.db"              -> { scope: "L",  subtype: "document" }',
		'- "diagnose why the matching consumer is slow"            -> { scope: "L",  subtype: "diagnose" }',
		'- "what does parseConfig do?"                             -> { scope: "S",  subtype: "explain" }',
		'',
		'Rules:',
		'- Pick the tier that DOES THE PROMPT JUSTICE -- the smallest tier the answer would COMPLETELY fit into.',
		'- Broad-overview / describe-the-repo / "what does this codebase do" prompts against a multi-module repo are multi-section by nature: L for moderate repos, XL+ for large/complex ones.',
		'- "single sitting" is NOT the test -- BREADTH is the test. A one-sentence question can ask for an XL answer.',
		'- When the context block lists a large repo size (1000+ files / 10+ top modules), bias UP for any overview-shaped question.',
		'- `scope` MUST be one of S / M / L / XL / XXL / XXXL / XXXXL.',
		'- `subtype` MUST be one of review / summarize / audit / explain / compare / document / diagnose. Default to `review` when ambiguous.',
		'- Return ONLY valid JSON (no markdown fences, no prose).',
		'',
		'Schema:',
		'{ "scope": "<S|M|L|XL|XXL|XXXL|XXXXL>", "subtype": "<review|summarize|audit|explain|compare|document|diagnose>", "reasoning": "<one sentence>" }',
	];

	const userLines: string[] = [];
	if (input.context && input.context.trim().length > 0) {
		userLines.push('## Context', input.context.trim(), '');
	}
	userLines.push('## Text', input.text);

	return [
		{ role: 'system', content: systemLines.join('\n') },
		{ role: 'user', content: userLines.join('\n') },
	];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseResponse(rawText: string): ScopeClassifyResult | null {
	const cleaned = stripJsonFences(rawText);
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') {
		return null;
	}

	const obj = parsed as Record<string, unknown>;

	// scope: hard requirement -- if invalid, the whole parse fails.
	const scopeRaw = typeof obj['scope'] === 'string' ? (obj['scope'] as string).trim().toUpperCase() : '';
	if (!VALID_SCOPES_SET.has(scopeRaw)) {
		return null;
	}

	// subtype: soft requirement -- if invalid or missing, default to
	// 'review'. We don't fail the whole parse on subtype trouble,
	// since the size axis is more load-bearing than the work-shape
	// hint downstream.
	const subtypeRaw = typeof obj['subtype'] === 'string'
		? (obj['subtype'] as string).trim().toLowerCase()
		: '';
	const subtype: AnalysisSubtype = VALID_SUBTYPES_SET.has(subtypeRaw)
		? subtypeRaw as AnalysisSubtype
		: DEFAULT_SUBTYPE;

	const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] as string : '';

	return {
		scope:    scopeRaw as ScopeSize,
		subtype,
		reasoning,
		fallback: false,
	};
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _parseResponseForTest = parseResponse;
export const _DEFAULT_SUBTYPE_FOR_TEST: AnalysisSubtype = DEFAULT_SUBTYPE;
