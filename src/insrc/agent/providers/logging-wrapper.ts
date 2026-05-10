/**
 * Universal LLM I/O logging wrapper.
 *
 * Wraps any `LLMProvider` so every `complete()` and `stream()` call
 * lands in the daemon log with the FULL request payload (messages
 * verbatim, opts, provider id, model) and the FULL response payload
 * (text, stopReason, usage). No truncation. Per the user's standing
 * directive ("LOG ALL LLM INTERACTION, INPUT AND OUTPUTS, EVERY CALL
 * SHOULD BE LOGGED AS IS NOT TRUNCATIONS"), this is intentionally
 * exhaustive -- the daemon log is the ground-truth audit trail for
 * what every prompt + response looked like.
 *
 * Applied at the factory boundary (buildProvider) so every caller
 * gets it for free without touching individual call sites.
 *
 * Each call gets a monotonic id so the request and response log
 * lines can be correlated even when calls overlap.
 */

import { getLogger } from '../../shared/logger.js';
import type {
	LLMProvider,
	LLMMessage,
	LLMResponse,
	CompletionOpts,
} from '../../shared/types.js';

const log = getLogger('llm-io');

let CALL_SEQ = 0;
function nextCallId(): number {
	CALL_SEQ = (CALL_SEQ + 1) | 0;
	return CALL_SEQ;
}

export interface LogProviderTags {
	readonly providerName:  string;
	readonly model?:        string | undefined;
}

export function wrapWithLogging(inner: LLMProvider, tags: LogProviderTags): LLMProvider {
	return {
		get supportsTools(): boolean {
			return inner.supportsTools;
		},

		async complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse> {
			const callId = nextCallId();
			const startedAt = Date.now();
			log.info(
				{
					llmCallId:    callId,
					phase:        'request',
					method:       'complete',
					provider:     tags.providerName,
					model:        tags.model,
					opts,
					messageCount: messages.length,
					messages,                        // FULL payload, verbatim
				},
				'LLM call (request)',
			);

			try {
				const response = await inner.complete(messages, opts);
				log.info(
					{
						llmCallId:    callId,
						phase:        'response',
						method:       'complete',
						provider:     tags.providerName,
						model:        tags.model,
						durationMs:   Date.now() - startedAt,
						stopReason:   response.stopReason,
						textLength:   response.text.length,
						text:         response.text,    // FULL response, verbatim
						toolCalls:    response.toolCalls,
						usage:        response.usage,
					},
					'LLM call (response)',
				);
				return response;
			} catch (err) {
				log.warn(
					{
						llmCallId:   callId,
						phase:       'error',
						method:      'complete',
						provider:    tags.providerName,
						model:       tags.model,
						durationMs:  Date.now() - startedAt,
						err:         (err as Error).message,
						stack:       (err as Error).stack,
					},
					'LLM call (error)',
				);
				throw err;
			}
		},

		stream(messages: LLMMessage[], opts?: CompletionOpts): AsyncIterable<string> {
			const callId = nextCallId();
			const startedAt = Date.now();
			log.info(
				{
					llmCallId:    callId,
					phase:        'request',
					method:       'stream',
					provider:     tags.providerName,
					model:        tags.model,
					opts,
					messageCount: messages.length,
					messages,
				},
				'LLM call (request, streaming)',
			);

			const innerStream = inner.stream(messages, opts);
			return wrapStream(innerStream, callId, startedAt, tags);
		},

		async embed(text: string): Promise<number[]> {
			const callId = nextCallId();
			const startedAt = Date.now();
			log.info(
				{
					llmCallId:  callId,
					phase:      'request',
					method:     'embed',
					provider:   tags.providerName,
					model:      tags.model,
					textLength: text.length,
					text,
				},
				'LLM call (embed request)',
			);
			try {
				const vec = await inner.embed(text);
				log.info(
					{
						llmCallId:    callId,
						phase:        'response',
						method:       'embed',
						provider:     tags.providerName,
						model:        tags.model,
						durationMs:   Date.now() - startedAt,
						dimensions:   vec.length,
					},
					'LLM call (embed response)',
				);
				return vec;
			} catch (err) {
				log.warn(
					{
						llmCallId:  callId,
						phase:      'error',
						method:     'embed',
						provider:   tags.providerName,
						model:      tags.model,
						durationMs: Date.now() - startedAt,
						err:        (err as Error).message,
					},
					'LLM call (embed error)',
				);
				throw err;
			}
		},
	};
}

async function* wrapStream(
	source: AsyncIterable<string>,
	callId: number,
	startedAt: number,
	tags: LogProviderTags,
): AsyncIterable<string> {
	const chunks: string[] = [];
	let chunkCount = 0;
	try {
		for await (const chunk of source) {
			chunks.push(chunk);
			chunkCount++;
			yield chunk;
		}
	} catch (err) {
		log.warn(
			{
				llmCallId:  callId,
				phase:      'error',
				method:     'stream',
				provider:   tags.providerName,
				model:      tags.model,
				durationMs: Date.now() - startedAt,
				partial:    chunks.join(''),
				chunkCount,
				err:        (err as Error).message,
			},
			'LLM call (stream error)',
		);
		throw err;
	}
	const fullText = chunks.join('');
	log.info(
		{
			llmCallId:  callId,
			phase:      'response',
			method:     'stream',
			provider:   tags.providerName,
			model:      tags.model,
			durationMs: Date.now() - startedAt,
			textLength: fullText.length,
			text:       fullText,
			chunkCount,
		},
		'LLM call (stream response)',
	);
}
