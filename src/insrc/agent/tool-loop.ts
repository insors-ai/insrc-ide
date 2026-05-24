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
	readonly onMultipleToolsPerTurn?: 'retry-with-correction' | 'terminate';
	/** Default true. Detects same-call-twice-in-a-row -> exhaust. */
	readonly stopOnDegenerateRepeat?: boolean;
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
	| { readonly kind: 'no-tools';       readonly finalText: string;     readonly turnCount: number; readonly transcript: readonly LLMMessage[] }
	| { readonly kind: 'exhausted';      readonly reason: string;        readonly turnCount: number; readonly transcript: readonly LLMMessage[]; readonly lastError?: string }
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

		// Multi-tool batch rejection (substrate is serial)
		if (toolCalls.length > 1) {
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
				return { kind: 'exhausted', reason: `dispatch-error: ${(err as Error).message}`, turnCount, transcript };
			}
			pushToolResult(transcript, call.id, true, CORRECTIVE.dispatchError(call.name, (err as Error).message));
			lastError = `dispatch-error: ${(err as Error).message}`;
			continue;
		}
		pushToolResult(transcript, call.id, result.isError === true, result.content);
		if (result.isError === true) {
			lastError = `tool-isError: ${result.content.slice(0, 120)}`;
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
		...(lastError !== undefined ? { lastError } : {}),
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
	readonly onMultipleToolsPerTurn: 'retry-with-correction' | 'terminate';
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
	// All other modes feed back via a user message and continue.
	transcript.push({ role: 'user', content: prompt });
	return 'continue';
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
