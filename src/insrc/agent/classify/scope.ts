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
		'- `S`     -- one small, localized question (single function, handful of lines).',
		'- `M`     -- a small group of related entities (single file, tight cluster).',
		'- `L`     -- a feature / module / sub-tree (~10-50 entities; multi-file).',
		'- `XL`    -- multiple modules; cross-cutting comparison or trace.',
		'- `XXL`   -- sub-system audit (multiple modules + their interactions).',
		'- `XXXL`  -- repo-wide architectural concern.',
		'- `XXXXL` -- multi-repo / new product direction.',
		'',
		'Rules:',
		'- Pick the SMALLEST tier the work could plausibly fit into.',
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
	const cleaned = stripFences(rawText.trim());
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

function stripFences(text: string): string {
	let out = text;
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
	}
	return out.trim();
}
