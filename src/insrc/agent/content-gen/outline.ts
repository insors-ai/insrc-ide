/**
 * Pass 1 of the multi-pass content generator
 * (plans/content-generator.md commit 1).
 *
 * Single LLM call constrained to the OUTLINE_SCHEMA shape. On
 * provider error or schema violation: retry once with the validation
 * error fed back; on second failure, return a single-section
 * fallback outline so the caller still gets *something* to drive
 * pass 2 with.
 *
 * The module is content-agnostic. Caller supplies the system prompt
 * (the doc's purpose / audience / structural guidance) and the user
 * prompt (the actual brief). We wrap them with a strict output-rules
 * block locking the response to the JSON schema.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import { OUTLINE_SCHEMA } from './schema.js';
import type { OutlineResult, SectionPlan } from './types.js';

const log = getLogger('content-gen:outline');

const DEFAULT_MAX_SECTIONS = 12;
const DEFAULT_MAX_TOKENS   = 1500;

export interface GenerateOutlineInput {
	/** Caller's system prompt -- typically describes the doc's
	 *  purpose, audience, and any structural constraints. */
	readonly system: string;
	/** Caller's user prompt -- the actual content brief. */
	readonly user: string;
	/**
	 * Cap on the number of sections the outline may produce.
	 * Defaults to 12 -- matches the `OUTLINE_SCHEMA.sections.maxItems`
	 * cap. Lowering this is a soft hint to the model; the schema's
	 * hard cap still wins on Ollama.
	 */
	readonly maxSections?: number;
	/** Cap on outline-pass output tokens. Default 1500. */
	readonly maxTokens?: number;
}

export interface GenerateOutlineResult {
	readonly outline: OutlineResult;
	/**
	 * True when the outline came from a fallback path (provider
	 * error / unparseable response / schema violation persisting
	 * through the single retry). The caller can warn the user or
	 * treat it as a hard failure depending on their tolerance.
	 */
	readonly degraded: boolean;
	/** Free-form reason when `degraded` is true. */
	readonly note?: string | undefined;
}

/**
 * Run the outline pass. Throws only if `input.user` is empty; every
 * other error path returns a fallback outline with `degraded: true`.
 */
export async function generateOutline(
	input: GenerateOutlineInput,
	provider: LLMProvider,
): Promise<GenerateOutlineResult> {
	if (input.user.trim().length === 0) {
		throw new Error('generateOutline: `user` prompt must be non-empty');
	}

	const maxSections = input.maxSections ?? DEFAULT_MAX_SECTIONS;
	const maxTokens   = input.maxTokens   ?? DEFAULT_MAX_TOKENS;
	const messages    = buildOutlineMessages(input, maxSections);

	// First attempt. Pass the JSON Schema as `responseFormat: { schema }`
	// so Ollama's constrained decoder emits only matching output.
	// Cloud providers ignore the hint; we rely on parse + retry.
	const first = await tryOutline(messages, provider, maxTokens);
	if (first.kind === 'ok') {
		return { outline: first.outline, degraded: false };
	}

	// Retry once, feeding the validation error back as a corrective
	// user message (Instructor pattern).
	log.warn({ reason: first.reason }, 'outline: first attempt failed; retrying with correction');
	const retryMessages: LLMMessage[] = [
		...messages,
		{
			role: 'user',
			content: `Your previous response was rejected: ${first.reason}.\n\nReturn ONLY the JSON object that matches the OutlineResult schema. No fences, no prose, no preamble.`,
		},
	];
	const second = await tryOutline(retryMessages, provider, maxTokens);
	if (second.kind === 'ok') {
		return { outline: second.outline, degraded: false };
	}

	// Both attempts failed -- fall back to a single-section outline so
	// the caller still has something to feed pass 2.
	log.warn({ first: first.reason, second: second.reason }, 'outline: both attempts failed; falling back to single-section outline');
	return {
		outline: fallbackOutline(input.user),
		degraded: true,
		note: `outline pass failed: ${second.reason}`,
	};
}

// ---------------------------------------------------------------------------
// One outline attempt: provider call + parse + validate.
// ---------------------------------------------------------------------------

type OutlineAttempt =
	| { kind: 'ok'; outline: OutlineResult }
	| { kind: 'error'; reason: string };

async function tryOutline(
	messages: LLMMessage[],
	provider: LLMProvider,
	maxTokens: number,
): Promise<OutlineAttempt> {
	let rawText: string;
	try {
		const response = await provider.complete(messages, {
			maxTokens,
			temperature: 0,
			responseFormat: { schema: OUTLINE_SCHEMA as unknown as Record<string, unknown> },
		});
		rawText = response.text;
	} catch (err) {
		return { kind: 'error', reason: `provider error: ${(err as Error).message}` };
	}

	const cleaned = stripFences(rawText.trim());
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch (err) {
		return {
			kind: 'error',
			reason: `unparseable JSON (${(err as Error).message}); raw=${rawText.slice(0, 120)}`,
		};
	}

	const outline = validateOutline(parsed);
	if (typeof outline === 'string') {
		return { kind: 'error', reason: `schema violation: ${outline}` };
	}
	return { kind: 'ok', outline };
}

// ---------------------------------------------------------------------------
// Validation -- runs even on Ollama (defensive against schema-aware
// providers that drift) and is the only check on cloud providers.
// ---------------------------------------------------------------------------

/**
 * Returns the validated `OutlineResult` on success, or a string
 * error message on failure (used as the retry feedback).
 */
function validateOutline(parsed: unknown): OutlineResult | string {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return 'response is not a JSON object';
	}
	const obj = parsed as Record<string, unknown>;

	const title = typeof obj['title'] === 'string' ? obj['title'] : '';
	if (!Array.isArray(obj['sections'])) {
		return '`sections` must be an array';
	}
	const sectionsRaw = obj['sections'] as unknown[];
	if (sectionsRaw.length === 0) {
		return '`sections` must have at least one entry';
	}

	const seenIds = new Set<string>();
	const sections: SectionPlan[] = [];
	for (let i = 0; i < sectionsRaw.length; i++) {
		const sRaw = sectionsRaw[i];
		if (sRaw === null || typeof sRaw !== 'object' || Array.isArray(sRaw)) {
			return `section[${i}] is not an object`;
		}
		const s = sRaw as Record<string, unknown>;

		const id = typeof s['id'] === 'string' ? s['id'].trim() : '';
		if (id.length === 0) {
			return `section[${i}].id missing or empty`;
		}
		if (seenIds.has(id)) {
			return `section[${i}].id "${id}" duplicates an earlier section`;
		}
		seenIds.add(id);

		const sTitle = typeof s['title'] === 'string' ? s['title'].trim() : '';
		if (sTitle.length === 0) {
			return `section[${i}].title missing or empty`;
		}
		const intent = typeof s['intent'] === 'string' ? s['intent'].trim() : '';
		if (intent.length === 0) {
			return `section[${i}].intent missing or empty`;
		}

		const plan: { -readonly [K in keyof SectionPlan]: SectionPlan[K] } = {
			id,
			title: sTitle,
			intent,
		};
		if (typeof s['budgetTokens'] === 'number' && Number.isFinite(s['budgetTokens'])) {
			plan.budgetTokens = s['budgetTokens'] as number;
		}
		if (Array.isArray(s['dependsOn'])) {
			const deps = (s['dependsOn'] as unknown[]).filter((d): d is string => typeof d === 'string' && d.trim().length > 0);
			if (deps.length > 0) {
				plan.dependsOn = deps;
			}
		}
		sections.push(plan);
	}

	// Validate dependsOn references resolve to other section ids.
	for (let i = 0; i < sections.length; i++) {
		const s = sections[i]!;
		if (s.dependsOn === undefined) {
			continue;
		}
		for (const dep of s.dependsOn) {
			if (!seenIds.has(dep)) {
				return `section[${i}] "${s.id}" depends on unknown id "${dep}"`;
			}
			if (dep === s.id) {
				return `section[${i}] "${s.id}" depends on itself`;
			}
		}
	}

	return { title, sections };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildOutlineMessages(input: GenerateOutlineInput, maxSections: number): LLMMessage[] {
	const rules = [
		'',
		'# Output rules',
		'',
		`Reply with ONE JSON object matching the OutlineResult schema:`,
		'{',
		'  "title": "<doc title; may be empty>",',
		'  "sections": [',
		'    {',
		'      "id":           "<stable slug -- letters, digits, hyphen>",',
		'      "title":        "<section heading text>",',
		'      "intent":       "<1-2 sentence brief telling the section writer what to produce>",',
		'      "budgetTokens": <optional number>,',
		'      "dependsOn":    [<optional ids that must be drafted first>]',
		'    }',
		'  ]',
		'}',
		'',
		`- 1-${maxSections} sections.`,
		'- `id` is a stable slug used for caching; do not reuse ids.',
		'- `intent` is a SHORT brief, NOT the section body.',
		'- Sections without `dependsOn` run in parallel; declare `dependsOn` only when one section truly needs another\'s body to write its own.',
		'- Do NOT write any section bodies in this pass.',
		'- Reply with the JSON object only -- no prose, no markdown fences.',
	];

	return [
		{ role: 'system', content: `${input.system.trim()}\n${rules.join('\n')}` },
		{ role: 'user',   content: input.user },
	];
}

// ---------------------------------------------------------------------------
// Fallback outline -- last-resort when both LLM attempts fail.
// ---------------------------------------------------------------------------

/**
 * Produce a degenerate single-section outline that still drives a
 * coherent pass 2: one section whose intent IS the user's prompt
 * (truncated). The doc title is empty -- the caller-supplied prompt
 * is implicitly the title-shape; if they want one they can override
 * via the post-stitch sanitiser.
 */
function fallbackOutline(userPrompt: string): OutlineResult {
	const briefIntent = userPrompt.trim().slice(0, 200);
	return {
		title: '',
		sections: [{
			id:     'body',
			title:  'Body',
			intent: briefIntent.length > 0 ? briefIntent : 'Generate the requested content as a single section.',
		}],
	};
}

function stripFences(text: string): string {
	let out = text;
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
	}
	return out.trim();
}
