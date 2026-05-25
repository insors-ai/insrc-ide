/**
 * tool-loop substrate (Plan 2 of plans/tool-loop-substrate.md).
 *
 * Multi-turn tool-using loop that consolidates the ad-hoc retry
 * implementations scattered across the codebase (`callPerTask`,
 * scope classifier, intent classifier) into one typed substrate.
 *
 * Substrate responsibilities:
 *   - Turn-budgeting + transcript accumulation
 *   - Standard failure-mode handlers with corrective-prompt
 *     templates (empty-toolCalls, unknown-tool, dispatch-error,
 *     mixed-termination, schema-violation, multi-tools-per-turn)
 *   - SERIAL tool dispatch (one tool per turn -- rejected batches
 *     are retried with correction; never silently truncate)
 *   - Optional typed-terminal protocol via a `submit_plan`-style
 *     `terminationTool`: the model emits a tool-call with the
 *     terminal name, the substrate validates its input against
 *     `outputSchema` and returns `{ kind: 'terminated', payload }`
 *   - Degenerate-repeat detection: same tool + same args twice in
 *     a row exits as `kind: 'exhausted'`, preventing tight loops
 *     from burning the cycle budget
 *
 * NOT in scope (separate modules):
 *   - Pre-dispatch arg validation / coercion -- `tool-call-guard.ts`.
 *     Compose by wrapping the guard inside the caller's
 *     `dispatchTool` callback.
 *   - Provider-side tool-call wire-format conversion -- lives in
 *     `agent/providers/*.ts`.
 *   - Specific consumers (planner, classifiers) -- migrations come
 *     in Phases 2-3 of the substrate plan.
 */

import type {
	LLMProvider,
	LLMMessage,
	LLMResponse,
	ToolCall,
	ToolDefinition,
	ToolResult,
} from '../shared/types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('tool-loop');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TerminationTool<T> {
	readonly name:        string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	/** Validate the tool-call's input. Return T on success, an error
	 *  string on failure. The substrate feeds the error back to the
	 *  model via the schema-violation corrective template. */
	readonly validate:    (input: unknown) => T | string;
}

export interface ToolLoopPolicy<T> {
	readonly maxTurns:     number;
	/**
	 * 'auto' -- model decides; 'required' -- must call some tool;
	 * 'none' -- text only; { name } -- must call this specific tool.
	 * See shared/types.ts CompletionOpts.toolChoice for the wire-
	 * level semantics.
	 */
	readonly toolChoice:   'auto' | 'required' | 'none' | { readonly name: string };
	readonly maxTokens?:   number;
	readonly temperature?: number;
	readonly terminationTool?: TerminationTool<T>;
	/** Failure handlers (all defaulted to safe behaviors). */
	readonly onEmptyToolCalls?:       'retry-with-correction' | 'terminate';
	readonly onUnknownTool?:          'feed-error-back'       | 'terminate';
	readonly onDispatchError?:        'feed-error-back'       | 'terminate';
	readonly onMixedTermination?:     'reject'                | 'accept-termination-discard-others';
	readonly onSchemaViolation?:      'retry-with-correction' | 'terminate';
	/**
	 * What to do when the LLM emits 2+ tool_use blocks in one turn:
	 *   - `'retry-with-correction'` (default): reject the batch, push
	 *     isError tool_result blocks for every orphan tool_use + a
	 *     corrective message ("substrate dispatches one tool per turn").
	 *     Good when downstream skills must be serialised (e.g. each
	 *     dispatch carries side effects that the LLM needs to see
	 *     before choosing the next call).
	 *   - `'terminate'`: bail out with `kind: 'exhausted'`.
	 *   - `'dispatch-all'`: dispatch every tool in the batch in
	 *     parallel, push a tool_result for each, and continue. The
	 *     natural Anthropic-style fanout pattern. Use for read-only
	 *     discovery loops (planner, broad exploration) where the
	 *     calls are independent.
	 */
	readonly onMultipleToolsPerTurn?: 'retry-with-correction' | 'terminate' | 'dispatch-all';
	/** Default true. Detects same-call-twice-in-a-row -> exhaust. */
	readonly stopOnDegenerateRepeat?: boolean;
	/**
	 * Default false. When true, the loop returns immediately after the
	 * first SUCCESSFUL (isError !== true) tool dispatch with kind:
	 * 'dispatched'. Used by single-shot consumers (analyzer's
	 * callPerTask) that want "dispatch one tool, return its result, no
	 * looping". On isError dispatch, the loop still applies the
	 * retry-with-correction handler.
	 */
	readonly stopOnFirstDispatch?: boolean;
}

export interface ToolLoopInput<T> {
	readonly provider:     LLMProvider;
	readonly messages:     readonly LLMMessage[];
	readonly tools:        readonly ToolDefinition[];
	readonly dispatchTool: (call: ToolCall) => Promise<ToolResult>;
	readonly policy:       ToolLoopPolicy<T>;
	readonly label?:       string;
}

export type ToolLoopResult<T> =
	| { readonly kind: 'terminated';     readonly payload: T;            readonly turnCount: number; readonly transcript: readonly LLMMessage[] }
	| { readonly kind: 'dispatched';     readonly call: ToolCall;        readonly result: ToolResult; readonly turnCount: number; readonly transcript: readonly LLMMessage[] }
	| { readonly kind: 'no-tools';       readonly finalText: string;     readonly turnCount: number; readonly transcript: readonly LLMMessage[] }
	| { readonly kind: 'exhausted';      readonly reason: string;        readonly turnCount: number; readonly transcript: readonly LLMMessage[]; readonly lastError?: string; readonly lastDispatch?: { readonly call: ToolCall; readonly result: ToolResult } }
	| { readonly kind: 'provider-error'; readonly err: Error;            readonly turnCount: number; readonly transcript: readonly LLMMessage[] };

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runToolLoop<T = unknown>(input: ToolLoopInput<T>): Promise<ToolLoopResult<T>> {
	const policy = withDefaults(input.policy);
	const transcript: LLMMessage[] = [...input.messages];
	const knownToolNames = new Set<string>(input.tools.map(t => t.name));
	if (policy.terminationTool !== undefined) {
		knownToolNames.add(policy.terminationTool.name);
	}

	// Tools list the provider sees -- includes the termination pseudo-
	// tool when one is configured. The terminationTool is just a
	// regular tool to the model; the substrate intercepts the name
	// on the response side.
	const providerTools: ToolDefinition[] = policy.terminationTool !== undefined
		? [
			...input.tools,
			{
				name:        policy.terminationTool.name,
				description: policy.terminationTool.description,
				inputSchema: policy.terminationTool.inputSchema,
			},
		]
		: [...input.tools];

	let turnCount = 0;
	let lastError: string | undefined;
	let lastCall: { readonly name: string; readonly inputKey: string } | undefined;
	let lastDispatch: { readonly call: ToolCall; readonly result: ToolResult } | undefined;

	while (turnCount < policy.maxTurns) {
		// ----- Provider call --------------------------------------------------
		let response: LLMResponse;
		try {
			response = await input.provider.complete(transcript, {
				tools:        providerTools,
				toolChoice:   policy.toolChoice,
				...(policy.maxTokens   !== undefined ? { maxTokens:   policy.maxTokens   } : {}),
				...(policy.temperature !== undefined ? { temperature: policy.temperature } : {}),
			});
		} catch (err) {
			log.warn(
				{ label: input.label, turnCount, err: (err as Error).message },
				'tool-loop: provider error -- bubbling up',
			);
			return { kind: 'provider-error', err: err as Error, turnCount, transcript };
		}
		turnCount++;

		// Append the assistant turn (text + toolCalls) to the transcript.
		transcript.push(toAssistantMessage(response));

		// ----- Branch on response shape --------------------------------------
		const toolCalls = response.toolCalls ?? [];

		// No tool-calls path
		if (toolCalls.length === 0) {
			if (policy.toolChoice === 'auto' || policy.toolChoice === 'none') {
				log.info(
					{ label: input.label, turnCount, finalText: response.text.slice(0, 200) },
					'tool-loop: complete (no-tools)',
				);
				return { kind: 'no-tools', finalText: response.text, turnCount, transcript };
			}
			// toolChoice='required' or {name} but the model emitted no tools
			const handled = applyCorrectiveOrTerminate(
				policy.onEmptyToolCalls,
				transcript,
				'empty-tool-calls',
				CORRECTIVE.emptyToolCalls(),
			);
			if (handled === 'terminate') {
				return { kind: 'exhausted', reason: 'empty-tool-calls-terminated', turnCount, transcript };
			}
			lastError = 'empty-tool-calls';
			continue;
		}

		// Multi-tool batch handling
		if (toolCalls.length > 1) {
			if (policy.onMultipleToolsPerTurn === 'dispatch-all') {
				// Serial-dispatch every call in the batch, then pack
				// the matching tool_result blocks into ONE user
				// message. Anthropic requires all tool_results for a
				// given assistant turn's tool_use blocks to ship
				// together; splitting them into N messages would
				// orphan the later ids relative to the first reply.
				// SERIAL DISPATCH (not Promise.all): the dispatched
				// skills may internally invoke LLM providers, and the
				// project rule is no-parallel-LLM-anywhere -- parallel
				// cloud calls blow context windows and saturate per-
				// minute rate limits. The cost is sequential latency,
				// which the planner's small (2-3) typical batch sizes
				// keep tolerable.
				const dispatchResults: { call: ToolCall; result: ToolResult }[] = [];
				for (const c of toolCalls) {
					try {
						const result = await input.dispatchTool(c);
						dispatchResults.push({ call: c, result });
					} catch (err) {
						dispatchResults.push({
							call: c,
							result: {
								toolCallId: c.id,
								content:    CORRECTIVE.dispatchError(c.name, (err as Error).message),
								isError:    true,
							},
						});
					}
				}
				const trBlocks = dispatchResults.map(({ call: c, result: r }) => ({
					type:        'tool_result' as const,
					tool_use_id: c.id,
					content:     r.content,
					...(r.isError === true ? { isError: true } : {}),
				}));
				transcript.push({ role: 'user', content: trBlocks });
				// Track lastDispatch for exhaustion-result carrying;
				// pick the first non-error dispatch as a representative.
				const firstOk = dispatchResults.find(d => d.result.isError !== true);
				if (firstOk !== undefined) lastDispatch = firstOk;
				continue;
			}
			const names = toolCalls.map(c => c.name);
			const handled = applyCorrectiveOrTerminate(
				policy.onMultipleToolsPerTurn,
				transcript,
				'multiple-tools-per-turn',
				CORRECTIVE.multipleToolsPerTurn(names),
			);
			if (handled === 'terminate') {
				return { kind: 'exhausted', reason: 'multiple-tools-per-turn-terminated', turnCount, transcript };
			}
			lastError = `multiple-tools-per-turn: ${names.join(', ')}`;
			continue;
		}

		const call = toolCalls[0]!;

		// Termination-tool intercept
		if (policy.terminationTool !== undefined && call.name === policy.terminationTool.name) {
			const validated = policy.terminationTool.validate(call.input);
			if (typeof validated === 'string') {
				// Schema violation -- corrective and retry.
				const handled = applyCorrectiveOrTerminate(
					policy.onSchemaViolation,
					transcript,
					'schema-violation',
					CORRECTIVE.schemaViolation(policy.terminationTool.name, validated),
				);
				if (handled === 'terminate') {
					return { kind: 'exhausted', reason: 'schema-violation-terminated', turnCount, transcript };
				}
				lastError = `schema-violation: ${validated}`;
				continue;
			}
			// Valid termination!
			log.info(
				{ label: input.label, turnCount, terminationTool: policy.terminationTool.name },
				'tool-loop: complete (terminated)',
			);
			return { kind: 'terminated', payload: validated, turnCount, transcript };
		}

		// Unknown tool
		if (!knownToolNames.has(call.name)) {
			if (policy.onUnknownTool === 'terminate') {
				return { kind: 'exhausted', reason: `unknown-tool: ${call.name}`, turnCount, transcript };
			}
			const top = closestToolNames(call.name, Array.from(knownToolNames), 3);
			pushToolResult(transcript, call.id, true, CORRECTIVE.unknownTool(call.name, top));
			lastError = `unknown-tool: ${call.name}`;
			continue;
		}

		// Degenerate-repeat detection
		if (policy.stopOnDegenerateRepeat !== false) {
			const callKey = serializeInputKey(call.input);
			if (lastCall !== undefined && lastCall.name === call.name && lastCall.inputKey === callKey) {
				log.warn(
					{ label: input.label, turnCount, name: call.name },
					'tool-loop: degenerate-repeat -- exhausting',
				);
				return {
					kind:       'exhausted',
					reason:     `degenerate-repeat: ${call.name}`,
					turnCount,
					transcript,
					...(lastError !== undefined ? { lastError } : {}),
				};
			}
			lastCall = { name: call.name, inputKey: callKey };
		}

		// Regular dispatch
		let result: ToolResult;
		try {
			result = await input.dispatchTool(call);
		} catch (err) {
			if (policy.onDispatchError === 'terminate') {
				return {
					kind:       'exhausted',
					reason:     `dispatch-error: ${(err as Error).message}`,
					turnCount,
					transcript,
					...(lastDispatch !== undefined ? { lastDispatch } : {}),
				};
			}
			pushToolResult(transcript, call.id, true, CORRECTIVE.dispatchError(call.name, (err as Error).message));
			lastError = `dispatch-error: ${(err as Error).message}`;
			continue;
		}
		pushToolResult(transcript, call.id, result.isError === true, result.content);
		lastDispatch = { call, result };
		if (result.isError === true) {
			lastError = `tool-isError: ${result.content.slice(0, 120)}`;
		}

		// stopOnFirstDispatch: when configured AND the dispatch was a
		// success (isError !== true), return immediately. isError keeps
		// the loop going so the model can see the corrective and retry.
		if (policy.stopOnFirstDispatch === true && result.isError !== true) {
			log.info(
				{ label: input.label, turnCount, toolName: call.name },
				'tool-loop: complete (dispatched -- stopOnFirstDispatch)',
			);
			return { kind: 'dispatched', call, result, turnCount, transcript };
		}
	}

	log.info(
		{ label: input.label, turnCount, lastError },
		'tool-loop: complete (exhausted -- turn cap)',
	);
	return {
		kind:       'exhausted',
		reason:     'turn-cap',
		turnCount,
		transcript,
		...(lastError    !== undefined ? { lastError }    : {}),
		...(lastDispatch !== undefined ? { lastDispatch } : {}),
	};
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

interface FullToolLoopPolicy<T> extends ToolLoopPolicy<T> {
	readonly onEmptyToolCalls:       'retry-with-correction' | 'terminate';
	readonly onUnknownTool:          'feed-error-back'       | 'terminate';
	readonly onDispatchError:        'feed-error-back'       | 'terminate';
	readonly onMixedTermination:     'reject'                | 'accept-termination-discard-others';
	readonly onSchemaViolation:      'retry-with-correction' | 'terminate';
	readonly onMultipleToolsPerTurn: 'retry-with-correction' | 'terminate' | 'dispatch-all';
}

function withDefaults<T>(p: ToolLoopPolicy<T>): FullToolLoopPolicy<T> {
	return {
		...p,
		onEmptyToolCalls:       p.onEmptyToolCalls       ?? 'retry-with-correction',
		onUnknownTool:          p.onUnknownTool          ?? 'feed-error-back',
		onDispatchError:        p.onDispatchError        ?? 'feed-error-back',
		onMixedTermination:     p.onMixedTermination     ?? 'reject',
		onSchemaViolation:      p.onSchemaViolation      ?? 'retry-with-correction',
		onMultipleToolsPerTurn: p.onMultipleToolsPerTurn ?? 'retry-with-correction',
	};
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

function applyCorrectiveOrTerminate(
	mode:        'retry-with-correction' | 'terminate' | 'feed-error-back' | 'reject' | 'accept-termination-discard-others',
	transcript:  LLMMessage[],
	_label:      string,
	prompt:      string,
): 'terminate' | 'continue' {
	if (mode === 'terminate') return 'terminate';
	// All other modes feed back via a user message and continue. If
	// the prior assistant turn carried unsatisfied tool_use blocks
	// (multi-tool rejection, mixed-termination rejection, schema
	// violation on a termination call), Anthropic requires the next
	// user message to contain a matching tool_result for each. Without
	// this pairing the API 400s with `tool_use ids were found without
	// tool_result blocks immediately after`. The helper falls back to
	// a plain text user message when no orphans are present.
	pushUserCorrective(transcript, prompt);
	return 'continue';
}

/**
 * Push a corrective message that satisfies any orphan tool_use blocks
 * left in the previous assistant turn.
 *
 * Anthropic enforces strict tool_use <-> tool_result pairing: every
 * `tool_use` in an assistant message must be followed by a
 * `tool_result` with the same `tool_use_id` in the next user message,
 * BEFORE any other content. Violating this is a 400. OpenAI / Mistral
 * / Gemini are looser but accept the same shape, so the substrate
 * applies the rule uniformly.
 *
 * When there are no orphans (the previous assistant turn was a plain
 * text reply -- e.g. the empty-tool-calls corrective path), the helper
 * pushes a regular `{ role: 'user', content: <text> }` message
 * preserving the legacy shape.
 */
function pushUserCorrective(transcript: LLMMessage[], correctiveText: string): void {
	const orphanIds = collectOrphanToolUseIds(transcript);
	if (orphanIds.length === 0) {
		transcript.push({ role: 'user', content: correctiveText });
		return;
	}
	// Pair each orphan with an isError tool_result carrying the
	// corrective text. The LLM reads the content via the tool_result
	// channel and retries on the next turn.
	const blocks = orphanIds.map(id => ({
		type:        'tool_result' as const,
		tool_use_id: id,
		content:     correctiveText,
		isError:     true,
	}));
	transcript.push({ role: 'user', content: blocks });
}

/**
 * Collect tool_use ids from the last assistant message that have NOT
 * been satisfied by an immediately-following tool_result. The check is
 * conservative: it only inspects the most-recent assistant message
 * and walks the most-recent user message (if any) to subtract already-
 * matched ids. Sufficient for the substrate's flow where dispatch
 * always emits tool_results in the user message right after the
 * assistant's tool_use turn.
 */
function collectOrphanToolUseIds(transcript: readonly LLMMessage[]): string[] {
	let lastAssistantIdx = -1;
	for (let i = transcript.length - 1; i >= 0; i--) {
		if (transcript[i]!.role === 'assistant') { lastAssistantIdx = i; break; }
	}
	if (lastAssistantIdx < 0) return [];
	const assistant = transcript[lastAssistantIdx]!;
	if (typeof assistant.content === 'string' || !Array.isArray(assistant.content)) return [];

	const toolUseIds: string[] = [];
	for (const b of assistant.content as readonly unknown[]) {
		if (b !== null && typeof b === 'object' && (b as Record<string, unknown>)['type'] === 'tool_use') {
			const id = (b as Record<string, unknown>)['id'];
			if (typeof id === 'string') toolUseIds.push(id);
		}
	}
	if (toolUseIds.length === 0) return [];

	// Subtract any tool_result ids that already appear in user messages
	// after the assistant turn (defensive against future call sites
	// that push partial tool_results before the corrective).
	const satisfied = new Set<string>();
	for (let i = lastAssistantIdx + 1; i < transcript.length; i++) {
		const m = transcript[i]!;
		if (m.role !== 'user' || typeof m.content === 'string' || !Array.isArray(m.content)) continue;
		for (const b of m.content as readonly unknown[]) {
			if (b !== null && typeof b === 'object' && (b as Record<string, unknown>)['type'] === 'tool_result') {
				const id = (b as Record<string, unknown>)['tool_use_id'];
				if (typeof id === 'string') satisfied.add(id);
			}
		}
	}
	return toolUseIds.filter(id => !satisfied.has(id));
}

function pushToolResult(
	transcript: LLMMessage[],
	toolUseId:  string,
	isError:    boolean,
	content:    string,
): void {
	transcript.push({
		role: 'user',
		content: [
			{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { isError: true } : {}) },
		],
	});
}

function toAssistantMessage(response: LLMResponse): LLMMessage {
	// When toolCalls are present, the assistant message must carry
	// tool_use blocks. Provider adapters return both `text` and
	// `toolCalls`; we round-trip them as multimodal content.
	if (response.toolCalls && response.toolCalls.length > 0) {
		const blocks: (
			| { readonly type: 'text';     readonly text: string }
			| { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
		)[] = [];
		if (response.text.length > 0) {
			blocks.push({ type: 'text', text: response.text });
		}
		for (const tc of response.toolCalls) {
			blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
		}
		return { role: 'assistant', content: blocks };
	}
	return { role: 'assistant', content: response.text };
}

// ---------------------------------------------------------------------------
// Corrective-prompt templates (substrate owns the format; one place
// for the messaging across consumers)
// ---------------------------------------------------------------------------

const CORRECTIVE = {
	emptyToolCalls(): string {
		return (
			'Your previous response had no tool_use block. You MUST emit a tool call this turn.'
		);
	},
	multipleToolsPerTurn(names: readonly string[]): string {
		return (
			`Your previous turn emitted ${names.length} tool calls (${names.join(', ')}). ` +
			'The substrate dispatches one tool per turn -- emit exactly ONE tool_use this ' +
			'turn and you will see its result before the next turn.'
		);
	},
	unknownTool(name: string, suggestions: readonly string[]): string {
		const tail = suggestions.length > 0
			? `\nClosest tools in the catalog:\n${suggestions.map(s => `  - ${s}`).join('\n')}`
			: '';
		return `Your call to \`${name}\` failed: that tool is not in the catalog.${tail}\n\nRe-emit your call with a valid tool name.`;
	},
	dispatchError(name: string, message: string): string {
		return `Your call to \`${name}\` failed during execution: ${message}. The tool exists but rejected your arguments. Re-emit with corrected arguments.`;
	},
	schemaViolation(toolName: string, errMsg: string): string {
		return (
			`Your \`${toolName}\` payload was rejected: ${errMsg}. ` +
			'Re-emit with a payload matching the schema.'
		);
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeInputKey(input: unknown): string {
	try {
		return JSON.stringify(input);
	} catch {
		return '<unserializable>';
	}
}

function closestToolNames(name: string, catalog: readonly string[], k: number): readonly string[] {
	if (catalog.length === 0) return [];
	return catalog
		.map(c => ({ c, d: levenshtein(name, c) }))
		.sort((a, b) => a.d - b.d)
		.slice(0, k)
		.map(x => x.c);
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const prev = new Array<number>(b.length + 1);
	const curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
		}
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
	}
	return prev[b.length]!;
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _CORRECTIVE_FOR_TEST       = CORRECTIVE;
export const _toAssistantMessageForTest = toAssistantMessage;
export const _serializeInputKeyForTest  = serializeInputKey;
