/**
 * Pass 2 of the multi-pass content generator
 * (plans/content-generator.md commit 2).
 *
 * Per-section body drafting + parallel scheduler. Independent
 * sections (no `dependsOn`) fire in parallel via Promise.all;
 * dependent sections run in topological order with completed
 * bodies threaded into each section's prompt-build hook via the
 * `prior` map.
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
import type { OutlineResult, SectionPlan, SectionResult } from './types.js';

const log = getLogger('content-gen:section');

/**
 * Default per-section token budget when neither `SectionPlan
 * .budgetTokens` nor `GenerateMultiPassInput.section
 * .defaultBudgetTokens` is set. 1500 is comfortably under devstral's
 * post-tool-loop output ceiling.
 */
export const DEFAULT_SECTION_BUDGET_TOKENS = 1500;

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
	if (input.parallel && independent.length > 1) {
		const results = await Promise.all(
			independent.map(s => runSection(s, input, completed, provider)),
		);
		for (const r of results) {
			completed.set(r.id, r);
		}
	} else {
		// Serial path -- preserves outline order for the user-visible
		// `onSectionComplete` callbacks.
		for (const s of independent) {
			const r = await runSection(s, input, completed, provider);
			completed.set(r.id, r);
		}
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

	const { system, user } = input.build({
		section,
		outline: input.outline,
		prior,
	});
	const messages: LLMMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user',   content: user },
	];
	const maxTokens = section.budgetTokens ?? input.defaultBudgetTokens;

	// First attempt.
	const first = await tryComplete(messages, provider, maxTokens);
	if (first.kind === 'ok') {
		return finalize(toResult(section, first), input);
	}
	if (first.kind === 'aborted') {
		return finalize(emptyFallback(section.id, 'aborted'), input);
	}

	// Retry once -- provider error is the only retry-eligible failure
	// (truncation / empty body are accepted-with-fallback-flag and
	// don't re-fire). The retry uses the same messages -- no
	// validation feedback to attach since pass 2 is unconstrained.
	log.warn({ id: section.id, reason: first.reason }, 'section: first attempt failed; retrying');
	const second = await tryComplete(messages, provider, maxTokens);
	if (second.kind === 'ok') {
		return finalize(toResult(section, second), input);
	}
	if (second.kind === 'aborted') {
		return finalize(emptyFallback(section.id, 'aborted'), input);
	}

	const note = `provider error: ${second.reason}`;
	log.warn({ id: section.id, note }, 'section: both attempts failed; falling back');
	return finalize({ id: section.id, body: '', fallback: true, note }, input);
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

function toResult(
	section: SectionPlan,
	attempt: Extract<CompleteAttempt, { kind: 'ok' }>,
): SectionResult {
	const body = attempt.text.trim();
	if (body.length === 0) {
		return { id: section.id, body: '', fallback: true, note: 'empty response' };
	}
	if (attempt.truncated) {
		return { id: section.id, body, fallback: true, note: 'budget exceeded; truncated' };
	}
	return { id: section.id, body, fallback: false };
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
