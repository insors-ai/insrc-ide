/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-leaf shape resolver -- the 2-step executor's first stage.
 *
 * Restores the design pattern from the deleted
 * `agent/tasks/data-analyzer/execute-step.ts` (commit b8650f67d60,
 * removed in P5.b.2's section-flow cutover). The section-planner
 * picks skill ids by id+description only -- it never sees the
 * skill's input schema. This module fills the gap: for each leaf,
 * make one focused LLM call that names the EXACT skill, inlines
 * the skill's `inputs` JSON Schema, and forces a single tool_use
 * block whose args satisfy that schema.
 *
 * The prompt surface the model sees:
 *   - Leaf objective (planner's natural-language intent)
 *   - User question (root scope context)
 *   - Skill id + description
 *   - Skill input schema (the authoritative target)
 *   - Available prior outputs (id -> truncated value), for the
 *     model to pull wire data from
 *   - Optional context bag keys (for context-source bindings)
 *
 * `tool_choice: { name: 'submit_skill_args' }` forces the model
 * onto a single tool_use block. On empty toolCalls or schema
 * violation, one corrective retry fires; second failure returns
 * a typed failure that the leaf executor surfaces upstream
 * (orchestrator treats it as a leaf invalid-input).
 */

import type { LLMMessage, LLMProvider, ToolDefinition } from '../../shared/types.js';
import { getSkill } from '../../daemon/skills/index.js';
import { getLogger } from '../../shared/logger.js';
import { getPromptRegistry } from '../prompts/registry.js';
import type { ShapeResolverWriterInput } from '../prompts/writers/shape-resolver.js';

const log = getLogger('section-flow:shape-resolve');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SUBMIT_ARGS_TOOL = 'submit_skill_args';

export interface ShapeResolveInput {
	readonly skillId:      string;
	/** Free-text intent for THIS leaf (planner's `leaf.objective` field). */
	readonly objective:    string;
	/** Map of `nodeId -> stringified prior output`. The model picks what it needs. */
	readonly priorOutputs: Readonly<Record<string, string>>;
	/** The user's original question. */
	readonly userQuestion: string;
	/** Caller-supplied context bag (for `context`-source bindings). */
	readonly contextBag:   Readonly<Record<string, unknown>>;
	readonly provider:     LLMProvider;
	/** Per-call max tokens. Default 1024 -- model only needs to emit one tool_use block. */
	readonly maxTokens?:   number | undefined;
}

export type ShapeResolveResult =
	| { kind: 'ok';     args: Record<string, unknown>; retried: boolean }
	| { kind: 'failed'; reason: string;                retried: boolean };

export async function resolveSkillShape(input: ShapeResolveInput): Promise<ShapeResolveResult> {
	const skill = getSkill(input.skillId);
	if (skill === undefined) {
		return { kind: 'failed', reason: `unknown skill id: ${input.skillId}`, retried: false };
	}

	const tool: ToolDefinition = {
		name:        SUBMIT_ARGS_TOOL,
		description: `Submit the args dict for invoking skill \`${input.skillId}\`. The args MUST satisfy the skill's input schema.`,
		inputSchema: skill.inputs as Record<string, unknown>,
	};

	const baseMessages = buildMessages(input, skill.description);
	const maxTokens    = input.maxTokens ?? 1024;

	// First attempt.
	const first = await callOnce(input.provider, baseMessages, tool, maxTokens);
	if (first.kind === 'ok') {
		const missingReq = checkRequired(first.args, skill.inputs as Record<string, unknown>);
		if (missingReq.length === 0) {
			return { kind: 'ok', args: first.args, retried: false };
		}
		log.warn({ skillId: input.skillId, missing: missingReq }, 'shape-resolve: first attempt missing required args; retrying');
		const retry = await callOnce(input.provider, withCorrection(baseMessages, `Missing required args: ${missingReq.join(', ')}. Re-emit submit_skill_args populating every required key for which AVAILABLE PRIOR OUTPUTS contains a literal value. If a required arg has no literal source in prior outputs, OMIT it -- do not fabricate. The orchestrator will treat the omission as a missing-prerequisite leaf failure and re-plan.`), tool, maxTokens);
		if (retry.kind === 'ok') {
			const stillMissing = checkRequired(retry.args, skill.inputs as Record<string, unknown>);
			if (stillMissing.length === 0) {
				return { kind: 'ok', args: retry.args, retried: true };
			}
			return { kind: 'failed', reason: `retry still missing required: ${stillMissing.join(', ')}`, retried: true };
		}
		return { kind: 'failed', reason: retry.reason, retried: true };
	}

	log.warn({ skillId: input.skillId, reason: first.reason }, 'shape-resolve: first attempt failed; retrying with corrective hint');
	const retry = await callOnce(input.provider, withCorrection(baseMessages, `Previous attempt failed: ${first.reason}. Emit ONE submit_skill_args tool_use block whose input matches the schema. If you skipped the tool_use because no required arg can be grounded, you may still emit submit_skill_args with the unfillable keys OMITTED (key absent from the JSON object). Do not fabricate values to make the call succeed.`), tool, maxTokens);
	if (retry.kind === 'ok') {
		const missingReq = checkRequired(retry.args, skill.inputs as Record<string, unknown>);
		if (missingReq.length === 0) {
			return { kind: 'ok', args: retry.args, retried: true };
		}
		return { kind: 'failed', reason: `retry missing required: ${missingReq.join(', ')}`, retried: true };
	}
	return { kind: 'failed', reason: retry.reason, retried: true };
}

// ---------------------------------------------------------------------------
// Single-call helper
// ---------------------------------------------------------------------------

type CallOutcome =
	| { kind: 'ok';     args: Record<string, unknown> }
	| { kind: 'failed'; reason: string };

async function callOnce(
	provider: LLMProvider,
	messages: LLMMessage[],
	tool:     ToolDefinition,
	maxTokens: number,
): Promise<CallOutcome> {
	let response;
	try {
		response = await provider.complete(messages, {
			maxTokens,
			temperature:     0,
			tools:           [tool],
			toolChoice:      { name: tool.name },
			disableThinking: true,
		});
	} catch (err) {
		return { kind: 'failed', reason: `provider error: ${(err as Error).message}` };
	}
	const calls = response.toolCalls ?? [];
	const call  = calls.find(c => c.name === tool.name);
	if (call === undefined) {
		return { kind: 'failed', reason: `no ${tool.name} tool_use block returned (got ${calls.length} calls)` };
	}
	if (typeof call.input !== 'object' || call.input === null || Array.isArray(call.input)) {
		return { kind: 'failed', reason: `${tool.name}.input was not a JSON object` };
	}
	return { kind: 'ok', args: call.input };
}

function withCorrection(base: LLMMessage[], hint: string): LLMMessage[] {
	return [
		...base,
		{ role: 'user', content: `## RETRY CORRECTION\n${hint}` },
	];
}

// ---------------------------------------------------------------------------
// Prompt builders -- delegated to PromptWriter
// (see `agent/prompts/writers/shape-resolver.ts`).
// The legacy SYSTEM_PROMPT block + buildMessages helper lived here
// through commit e4f8ca7e41b; Phase 0 of
// `plans/section-flow-architecture-redesign.md` lifted them into the
// registered writer. The actual rendering is the writer's responsibility.
// ---------------------------------------------------------------------------

function buildMessages(input: ShapeResolveInput, skillDescription: string): LLMMessage[] {
	const writer = getPromptRegistry().get<ShapeResolverWriterInput, readonly LLMMessage[]>('shape-resolver');
	const messages = writer.build({
		skillId:          input.skillId,
		skillDescription,
		objective:        input.objective,
		userQuestion:     input.userQuestion,
		priorOutputs:     input.priorOutputs,
		contextBag:       input.contextBag,
	});
	return [...messages];
}

const PRIOR_OUTPUT_PREVIEW_CHARS = 1500;

function formatPriorOutputs(priorOutputs: Readonly<Record<string, string>>): string {
	const ids = Object.keys(priorOutputs);
	if (ids.length === 0) { return '(no prior outputs -- this is an early leaf)'; }
	const lines: string[] = [];
	for (const id of ids) {
		const raw = priorOutputs[id] ?? '';
		const preview = raw.length > PRIOR_OUTPUT_PREVIEW_CHARS
			? raw.slice(0, PRIOR_OUTPUT_PREVIEW_CHARS) + '\n  ...(truncated)'
			: raw;
		lines.push(`### \`${id}\``);
		lines.push('```');
		lines.push(preview);
		lines.push('```');
	}
	return lines.join('\n');
}

// `formatContextBag` used to render the session-context bag for the
// shape-resolver's inline user prompt. The composer at
// `agent/prompts/composers/skill-schema.ts` + the
// `agent/prompts/writers/shape-resolver.ts` writer own that rendering
// now; the inline helper here was Phase 0 cruft.

// ---------------------------------------------------------------------------
// Schema check
// ---------------------------------------------------------------------------

function checkRequired(args: Record<string, unknown>, schema: Record<string, unknown>): string[] {
	const required = schema['required'];
	if (!Array.isArray(required)) { return []; }
	const provided = new Set(Object.keys(args));
	return required.filter((r): r is string => typeof r === 'string' && !provided.has(r));
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _buildMessagesForTest      = buildMessages;
export const _checkRequiredForTest      = checkRequired;
export const _formatPriorOutputsForTest = formatPriorOutputs;
export const SUBMIT_ARGS_TOOL_NAME      = SUBMIT_ARGS_TOOL;
