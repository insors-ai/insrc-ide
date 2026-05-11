/**
 * Scope-only LLM classifier.
 *
 * The generic `classify()` module emits both a class id and a scope
 * tier alongside it -- useful when the caller doesn't yet know the
 * intent. But callers that ALREADY know the intent (e.g. the
 * /code-analyze slash command) shouldn't pay for a class-pick they
 * don't need; a focused scope-only prompt is half the tokens, half
 * the latency, and all the signal.
 *
 * This module is a thin wrapper that runs ONE round-trip with a
 * scope-only prompt. Output: `{ scope, reasoning, fallback }`. On
 * any failure (provider error, unparseable text, unknown tier),
 * falls back to `'M'` and sets `fallback: true`.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import type { ScopeSize } from '../../shared/classify.js';
import { getLogger } from '../../shared/logger.js';
import { stripJsonFences } from '../../shared/json-fences.js';

const log = getLogger('classify:scope');

const VALID_SCOPES: readonly ScopeSize[] = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'];
const VALID_SCOPES_SET = new Set<string>(VALID_SCOPES);

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
	readonly scope: ScopeSize;
	readonly reasoning: string;
	readonly fallback: boolean;
}

/**
 * Run a single scope-only classification. Caller owns provider
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
			maxTokens: 100,
			temperature: 0,
		});
		rawText = response.text;
	} catch (err) {
		log.warn({ err, role: input.role }, 'classifyScope: provider call failed');
		return { scope: 'M', reasoning: `provider error: ${(err as Error).message}`, fallback: true };
	}

	const parsed = parseResponse(rawText);
	if (!parsed) {
		log.warn({ role: input.role, rawText: rawText.slice(0, 200) }, 'classifyScope: unparseable response');
		return { scope: 'M', reasoning: 'unparseable LLM response', fallback: true };
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildMessages(input: ScopeClassifyInput): LLMMessage[] {
	const role = input.role ?? 'scope sizer';

	const systemLines = [
		`You are a ${role}. Given the text below, estimate the SCOPE of the work the user is asking about.`,
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
		'## Examples (anchors -- match the SHAPE of the prompt, not its length)',
		'- "describe what this repo does"             (large repo, 1000s of files) -> L  (broad-overview is multi-section by nature)',
		'- "summarise this repo and its subsystems"   (large repo)                 -> XL (named multi-subsystem audit)',
		'- "deep dive on architecture + design + ops" (large repo)                 -> XL (depth + breadth)',
		'- "summarise the auth module"                (any size)                   -> M  (one module)',
		'- "what does parseConfig do?"                (any size)                   -> S  (one function)',
		'- "list everything in this codebase"         (large repo)                 -> XXL (repo-wide enumeration)',
		'',
		'Rules:',
		'- Pick the tier that DOES THE PROMPT JUSTICE -- the smallest tier the answer would COMPLETELY fit into.',
		'- Broad-overview / describe-the-repo / "what does this codebase do" prompts against a multi-module repo are multi-section by nature: L for moderate repos, XL+ for large/complex ones.',
		'- "single sitting" is NOT the test -- BREADTH is the test. A one-sentence question can ask for an XL answer.',
		'- When the context block lists a large repo size (1000+ files / 10+ top modules), bias UP for any overview-shaped question.',
		'- `scope` MUST be one of S / M / L / XL / XXL / XXXL / XXXXL.',
		'- Return ONLY valid JSON (no markdown fences, no prose).',
		'',
		'Schema:',
		'{ "scope": "<S|M|L|XL|XXL|XXXL|XXXXL>", "reasoning": "<one sentence>" }',
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
	const scopeRaw = typeof obj['scope'] === 'string' ? (obj['scope'] as string).trim().toUpperCase() : '';
	if (!VALID_SCOPES_SET.has(scopeRaw)) {
		return null;
	}
	const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] as string : '';

	return {
		scope: scopeRaw as ScopeSize,
		reasoning,
		fallback: false,
	};
}
