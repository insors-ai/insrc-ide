/**
 * Pass 2 of the multi-pass content generator
 * (plans/content-generator.md commit 2).
 *
 * Per-section body drafting + serial scheduler. Independent
 * sections (no `dependsOn`) used to fire in parallel via Promise.all
 * but the project rule is no-parallel-LLM-anywhere (parallel
 * cloud completions blow context windows / saturate rate limits).
 * They now run serially in outline order; dependent sections still
 * run in topological order with completed bodies threaded into each
 * section's prompt-build hook via the `prior` map.
 *
 * Failure modes (from plans/content-generator.md):
 *   - provider error  -> retry once; on second fail body='',
 *                        fallback=true, note='provider error: ...'.
 *   - max_tokens cap  -> partial body kept, fallback=true,
 *                        note='budget exceeded; truncated'.
 *   - empty body      -> accepted, fallback=true,
 *                        note='empty response'.
 *   - signal aborted  -> body='', fallback=true, note='aborted'.
 *
 * Section-level retries do NOT use schema enforcement -- pass 2 is
 * free-form markdown. The only structural check is body length.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import {
	computeSectionCacheKey,
	priorBodiesFromMap,
	type ContentCache,
} from './cache.js';
import type { OutlineResult, SectionPlan, SectionResult } from './types.js';

const log = getLogger('content-gen:section');

/**
 * Default per-CALL token budget when neither `SectionPlan
 * .budgetTokens` nor `GenerateMultiPassInput.section
 * .defaultBudgetTokens` is set. 4000 sits just under devstral's
 * post-tool-loop output ceiling and matches the legacy single-pass
 * synthesise budget. Note this caps a SINGLE provider.complete
 * call -- the section runner's continuation loop strings multiple
 * calls together when the model hits `stopReason: max_tokens`, so
 * a section's effective ceiling is `(MAX_SECTION_CONTINUATIONS + 1)
 * * DEFAULT_SECTION_BUDGET_TOKENS` (default 16 * 4000 = 64K tokens).
 */
export const DEFAULT_SECTION_BUDGET_TOKENS = 4000;

/**
 * How many continuation passes a section may chain together when
 * each call ends at `stopReason: max_tokens`. The first call is
 * always allowed; this cap counts the EXTRA passes after that.
 * 15 -> up to 16 calls per section -> ~64 K tokens per section
 * worst case (16 * 4000 token budget). Bumped from 4 (5 calls)
 * after live testing surfaced large L-tier sections like
 * `error-handling` / `module-overview` legitimately needing more
 * passes. Above the cap we ship the partial body with `fallback:
 * true, note: 'continuation cap reached; truncated'` so a runaway
 * section can't burn unbounded provider time.
 */
export const MAX_SECTION_CONTINUATIONS = 15;

/**
 * Continuation prompt fed back as a fresh user turn after each
 * `max_tokens` exit. Keep it stern -- local models like to start
 * a continuation with "Continuing..." or re-summarise everything
 * they've already written, both of which we strip in
 * `stripContinuationPreamble`.
 */
const CONTINUATION_PROMPT = [
	'Continue from exactly where you left off. Specifically:',
	'- Do NOT repeat any content you have already written.',
	'- Do NOT summarise what you wrote so far.',
	'- Do NOT start with "Continuing..." / "I will continue..." / "Here is the rest...".',
	'- Begin with the next sentence as if your previous reply had not been cut off.',
].join('\n');

/**
 * Strip the most common preambles a continuation pass emits despite
 * the prompt. Conservative -- only matches at the very start of the
 * response so we don't accidentally remove content that legitimately
 * mentions "continuing" mid-sentence.
 */
const PREAMBLE_PATTERNS: readonly RegExp[] = [
	/^\s*(continuing|continued)\s*[.\-:,]\s*/i,
	/^\s*i'?ll continue\s*[.\-:,]?\s*/i,
	/^\s*let me continue\s*[.\-:,]?\s*/i,
	/^\s*here'?s the (rest|continuation|next part)\s*[.\-:,]?\s*/i,
	/^\s*(picking up|resuming) (from|where)[^.\n]*\.\s*/i,
];

function stripContinuationPreamble(text: string): string {
	let out = text;
	for (const re of PREAMBLE_PATTERNS) {
		out = out.replace(re, '');
	}
	return out.replace(/^\s+/, '');
}

/**
 * Caller-supplied prompt builder. Receives the section under draft,
 * the full outline (for cross-section context), and the bodies of
 * sections this one depends on. Returns the system + user prompt
 * pair the section LLM call uses.
 */
export type SectionPromptBuilder = (args: {
	readonly section: SectionPlan;
	readonly outline: OutlineResult;
	readonly prior: ReadonlyMap<string, SectionResult>;
}) => { system: string; user: string };

export interface RunSectionsInput {
	readonly outline: OutlineResult;
	readonly build: SectionPromptBuilder;
	readonly defaultBudgetTokens: number;
	readonly parallel: boolean;
	readonly signal?: AbortSignal | undefined;
	readonly onSectionComplete?: ((r: SectionResult) => void) | undefined;
	/**
	 * Optional section-level cache (commit 3). When set, each
	 * section's body is keyed on outline.title + section.id +
	 * section.intent + dependsOn-bodies-hash + cacheContext. On hit
	 * the LLM call is skipped and the cached body is returned as a
	 * non-fallback SectionResult; on a successful (non-fallback)
	 * generation the body is written back. Cache misses + writes are
	 * logged but never throw.
	 */
	readonly cache?: ContentCache | undefined;
	/**
	 * Caller-supplied salt for the cache key -- typically the active
	 * repo's git HEAD SHA or analogous version stamp. Bumping this
	 * invalidates every cached entry for the run. Ignored when
	 * `cache` is unset.
	 */
	readonly cacheContext?: string | undefined;
}

/**
 * Run pass 2 over every section in the outline, honouring
 * dependency edges + parallelism. Returns results in OUTLINE order
 * (not completion order) so the caller can stitch deterministically.
 */
export async function runSections(
	input: RunSectionsInput,
	provider: LLMProvider,
): Promise<SectionResult[]> {
	const sections = input.outline.sections;
	if (sections.length === 0) {
		return [];
	}

	const independent: SectionPlan[] = [];
	const dependent:   SectionPlan[] = [];
	for (const s of sections) {
		if (s.dependsOn !== undefined && s.dependsOn.length > 0) {
			dependent.push(s);
		} else {
			independent.push(s);
		}
	}

	const completed = new Map<string, SectionResult>();

	// ----- Independent pass --------------------------------------------------
	// Always serial (per the no-parallel-LLM-anywhere rule). The
	// `input.parallel` flag is honored as a no-op for back-compat with
	// older callers; the parallel Promise.all branch was removed so a
	// burst of N section drafts can never blow a cloud context window
	// or saturate per-minute rate limits. Outline order also gives the
	// user-visible `onSectionComplete` callback a predictable order.
	void input.parallel;
	for (const s of independent) {
		const r = await runSection(s, input, completed, provider);
		completed.set(r.id, r);
	}

	// ----- Dependent pass (topological serial) -------------------------------
	const remaining = [...dependent];
	while (remaining.length > 0) {
		const before = remaining.length;
		for (let i = 0; i < remaining.length; ) {
			const s = remaining[i]!;
			const deps = s.dependsOn ?? [];
			const ready = deps.every(d => completed.has(d));
			if (!ready) {
				i++;
				continue;
			}
			remaining.splice(i, 1);
			const r = await runSection(s, input, completed, provider);
			completed.set(r.id, r);
		}
		if (remaining.length === before) {
			// Cycle / unresolvable dep among the rest. Drop their deps
			// (treat as independent) and run one more pass; warn loudly
			// so it shows up in logs but don't fail the whole doc.
			log.warn(
				{ stuck: remaining.map(s => ({ id: s.id, deps: s.dependsOn })) },
				'section dependency cycle / unresolvable; dropping deps and proceeding',
			);
			for (const s of remaining) {
				const r = await runSection(s, input, completed, provider);
				completed.set(r.id, r);
			}
			break;
		}
	}

	// Re-order to the outline's order so the caller can stitch.
	return sections.map(s => completed.get(s.id) ?? emptyFallback(s.id, 'missing from completed map'));
}

// ---------------------------------------------------------------------------
// Single section runner
// ---------------------------------------------------------------------------

async function runSection(
	section: SectionPlan,
	input: RunSectionsInput,
	prior: ReadonlyMap<string, SectionResult>,
	provider: LLMProvider,
): Promise<SectionResult> {
	if (input.signal?.aborted) {
		return finalize(emptyFallback(section.id, 'aborted'), input);
	}

	// ----- Cache lookup (commit 3) ------------------------------------------
	let cacheKey: string | undefined;
	if (input.cache !== undefined) {
		const ctxOpts: { cacheContext?: string } = {};
		if (input.cacheContext !== undefined) {
			ctxOpts.cacheContext = input.cacheContext;
		}
		cacheKey = computeSectionCacheKey({
			outlineTitle: input.outline.title,
			section,
			priorBodies: priorBodiesFromMap(section.dependsOn, prior),
			...ctxOpts,
		});
		try {
			const cached = await input.cache.get(cacheKey);
			if (cached !== undefined) {
				log.info({ id: section.id, cacheKey }, 'section: cache hit; skipping LLM call');
				return finalize(
					{ id: section.id, body: cached, fallback: false, note: 'cache hit' },
					input,
				);
			}
		} catch (err) {
			log.warn({ id: section.id, err: (err as Error).message }, 'section: cache.get threw (treating as miss)');
		}
	}

	const { system, user } = input.build({
		section,
		outline: input.outline,
		prior,
	});
	const baseMessages: LLMMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user',   content: user },
	];
	const maxTokens = section.budgetTokens ?? input.defaultBudgetTokens;

	// Continuation loop. Each iteration runs one provider.complete:
	//
	//   - attempt 0: original prompt; tokens become the first chunk.
	//   - attempt 1+: the accumulated body so far is fed back as the
	//     prior assistant turn + a CONTINUATION_PROMPT user turn.
	//
	// Exit conditions:
	//   - `stopReason: end_turn`  -> model finished; ship clean.
	//   - aborted via signal      -> ship partial body if any, else
	//                                empty fallback.
	//   - provider error          -> retry once on attempt 0 only;
	//                                later attempts return partial.
	//   - MAX_SECTION_CONTINUATIONS reached AND last call still hit
	//     max_tokens -> ship with fallback note 'continuation cap
	//     reached; truncated'.
	let body = '';
	let truncated = false;
	let attempt = 0;
	while (attempt <= MAX_SECTION_CONTINUATIONS) {
		if (input.signal?.aborted) {
			return finalize(
				body.length > 0
					? { id: section.id, body: body.trim(), fallback: true, note: 'aborted (partial body kept)' }
					: emptyFallback(section.id, 'aborted'),
				input,
			);
		}

		const callMessages = attempt === 0
			? baseMessages
			: [
					...baseMessages,
					{ role: 'assistant' as const, content: body },
					{ role: 'user'      as const, content: CONTINUATION_PROMPT },
				];

		let result = await tryComplete(callMessages, provider, maxTokens);

		// Provider-error retry: existing semantics preserved -- only
		// the FIRST call gets a free retry (later attempts are
		// continuations; a mid-loop retry is a partial-body return).
		if (result.kind === 'error' && attempt === 0) {
			log.warn({ id: section.id, reason: result.reason }, 'section: first attempt failed; retrying');
			result = await tryComplete(callMessages, provider, maxTokens);
		}

		if (result.kind === 'aborted') {
			return finalize(
				body.length > 0
					? { id: section.id, body: body.trim(), fallback: true, note: 'aborted (partial body kept)' }
					: emptyFallback(section.id, 'aborted'),
				input,
			);
		}
		if (result.kind === 'error') {
			if (body.length > 0) {
				log.warn({ id: section.id, attempt, reason: result.reason }, 'section: continuation error; keeping partial body');
				return finalize(
					{ id: section.id, body: body.trim(), fallback: true, note: `continuation error after ${attempt} pass(es): ${result.reason}` },
					input,
				);
			}
			log.warn({ id: section.id, reason: result.reason }, 'section: both attempts failed; falling back');
			return finalize(
				{ id: section.id, body: '', fallback: true, note: `provider error: ${result.reason}` },
				input,
			);
		}

		// ok
		const chunk = attempt === 0 ? result.text : stripContinuationPreamble(result.text);
		body += chunk;
		truncated = result.truncated;

		if (!result.truncated) {
			break;  // model finished naturally
		}
		if (attempt < MAX_SECTION_CONTINUATIONS) {
			log.info({ id: section.id, attempt, bodyLen: body.length }, 'section: max_tokens hit; continuing');
		}
		attempt++;
	}

	const finalBody = body.trim();
	if (finalBody.length === 0) {
		return finalize({ id: section.id, body: '', fallback: true, note: 'empty response' }, input);
	}
	if (truncated) {
		// Hit the continuation cap with the last call STILL truncated.
		// Ship what we have but flag the section as partial.
		const partial: SectionResult = {
			id: section.id,
			body: finalBody,
			fallback: true,
			note: `continuation cap reached (${MAX_SECTION_CONTINUATIONS + 1} passes); truncated`,
		};
		await maybeCachePut(input, cacheKey, partial);
		return finalize(partial, input);
	}
	const clean: SectionResult = { id: section.id, body: finalBody, fallback: false };
	await maybeCachePut(input, cacheKey, clean);
	return finalize(clean, input);
}

/**
 * Write a successful (non-fallback) section to the cache. Failures
 * (no key / no cache / fallback result / put error) are swallowed --
 * cache is opportunistic.
 */
async function maybeCachePut(
	input: RunSectionsInput,
	cacheKey: string | undefined,
	result: SectionResult,
): Promise<void> {
	if (input.cache === undefined || cacheKey === undefined) {
		return;
	}
	if (result.fallback) {
		return;
	}
	try {
		await input.cache.put(cacheKey, result.body);
	} catch (err) {
		log.warn({ id: result.id, err: (err as Error).message }, 'section: cache.put threw (continuing)');
	}
}

function finalize(result: SectionResult, input: RunSectionsInput): SectionResult {
	if (input.onSectionComplete) {
		try {
			input.onSectionComplete(result);
		} catch (err) {
			log.warn({ err, id: result.id }, 'section: onSectionComplete callback threw (continuing)');
		}
	}
	return result;
}

function emptyFallback(id: string, note: string): SectionResult {
	return { id, body: '', fallback: true, note };
}

// ---------------------------------------------------------------------------
// One LLM completion attempt
// ---------------------------------------------------------------------------

type CompleteAttempt =
	| { kind: 'ok'; text: string; truncated: boolean }
	| { kind: 'error'; reason: string }
	| { kind: 'aborted' };

async function tryComplete(
	messages: LLMMessage[],
	provider: LLMProvider,
	maxTokens: number,
): Promise<CompleteAttempt> {
	try {
		const response = await provider.complete(messages, {
			maxTokens,
			temperature: 0.2,
		});
		const truncated = response.stopReason === 'max_tokens';
		return { kind: 'ok', text: response.text, truncated };
	} catch (err) {
		const message = (err as Error).message ?? String(err);
		if (/abort/i.test(message)) {
			return { kind: 'aborted' };
		}
		return { kind: 'error', reason: message };
	}
}
