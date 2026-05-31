/**
 * L2LlmAccess -- P7.3.
 *
 * Token-accounted wrapper around the active LLM provider. Charges
 * `response.usage.{inputTokens, outputTokens}` against the budget
 * after each call; falls back to a chars/3 estimate when the provider
 * doesn't surface usage data.
 *
 * Per agentic-skills-architecture.md §"L2 runtime" item 1: budget
 * tracking covers tokens spent on LLM calls. This is where that
 * accounting happens.
 *
 * Per CLAUDE.md "no parallel LLM calls": this wrapper does NOT
 * parallelize anything itself. Callers wanting concurrent independent
 * tool / data fetches use `Promise.all` over `deps.callL1(...)` --
 * NOT `deps.llm.complete(...)`. The wrapper is single-call.
 */

import { getLogger } from '../../../shared/logger.js';

import type {
	LLMMessage,
	LLMProvider,
	LLMResponse,
	ToolDefinition,
} from '../../../shared/types.js';

import type {
	BudgetTracker,
	L2Event,
	L2LlmAccess,
	L2LlmCallOpts,
} from './types.js';

const log = getLogger('l2:llm-access');

// ---------------------------------------------------------------------------

export interface CreateL2LlmAccessOpts {
	readonly provider:   LLMProvider;
	readonly providerId: string;
	readonly budget:     BudgetTracker;
	readonly emit?:      (event: L2Event) => void;
}

export function createL2LlmAccess(opts: CreateL2LlmAccessOpts): L2LlmAccess {
	return {
		providerId: opts.providerId,

		async complete(messages: readonly LLMMessage[], callOpts: L2LlmCallOpts = {}): Promise<LLMResponse> {
			// Wallclock check before dispatch -- cheap, catches runaway loops.
			opts.budget.checkWallclock();

			const start = Date.now();
			const providerOpts: Parameters<LLMProvider['complete']>[1] = {
				...(callOpts.maxTokens      !== undefined ? { maxTokens:      callOpts.maxTokens      } : {}),
				...(callOpts.temperature    !== undefined ? { temperature:    callOpts.temperature    } : {}),
				...(callOpts.tools          !== undefined ? { tools:          callOpts.tools as ToolDefinition[] } : {}),
				...(callOpts.toolChoice     !== undefined ? { toolChoice:     callOpts.toolChoice     } : {}),
				...(callOpts.responseFormat !== undefined ? { responseFormat: callOpts.responseFormat } : {}),
			};

			const response = await opts.provider.complete(messages as LLMMessage[], providerOpts);

			// Charge tokens. Provider usage wins; otherwise estimate via
			// chars/3 over message + response text.
			const tokens = estimateTokens(messages, response);
			opts.budget.chargeTokens(tokens);

			opts.emit?.({
				kind:    'custom',
				type:    'l2:llm-call',
				payload: { providerId: opts.providerId, tokens, durationMs: Date.now() - start },
				at:      Date.now(),
			});

			log.debug(
				{ providerId: opts.providerId, tokens, stopReason: response.stopReason },
				'l2:llm complete',
			);

			return response;
		},
	};
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(messages: readonly LLMMessage[], response: LLMResponse): number {
	if (response.usage !== undefined) {
		const inputTokens  = response.usage.inputTokens  ?? 0;
		const outputTokens = response.usage.outputTokens ?? 0;
		const cacheRead    = response.usage.cacheReadTokens    ?? 0;
		const cacheCreate  = response.usage.cacheCreationTokens ?? 0;
		// Sum total tokens billed. Cache-read tokens are billed (at a
		// discount) but they still hit the upstream context window, so
		// they count against our budget. Same for cache-creation.
		return inputTokens + outputTokens + cacheRead + cacheCreate;
	}

	// Fallback: chars/3 over the message contents + response text.
	let chars = response.text.length;
	for (const m of messages) {
		if (typeof m.content === 'string') {
			chars += m.content.length;
		} else if (Array.isArray(m.content)) {
			for (const part of m.content) {
				if (typeof part === 'object' && part !== null && 'text' in part) {
					chars += String((part as { text?: unknown }).text ?? '').length;
				}
			}
		}
	}
	return Math.ceil(chars / 3);
}
